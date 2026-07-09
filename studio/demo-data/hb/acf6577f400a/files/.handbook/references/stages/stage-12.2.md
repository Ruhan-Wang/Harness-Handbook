# Context fragment definitions and prompt assets  `stage-12.2`

This stage supplies the raw “building blocks” that later prompt assembly uses before the model is called. It is shared behind-the-scenes support, like labeled note cards that can be slipped into a conversation. The prompt asset files expose fixed template text for hierarchical agents, apply_patch instructions, compact summaries, and realtime start, backend, and end prompts, so Rust code can use stable names instead of reading files directly. The context fragment files turn real events and settings into clearly labeled messages: extra context, loaded skills, hidden internal guidance, available skills, saved command prefixes, environment facts, guardian review reminders, hook text, model-switch instructions, network rules, token budget warnings, aborted turns, project user instructions, user shell commands, realtime opening and closing instructions, and subagent status updates. Each wrapper chooses the right speaker role, tags, and wording so the model can tell what the information means. A few files recognize old warning formats for apply_patch, model mismatch, and process limits, so older saved conversations can still be read safely. Together, these pieces make prompt content consistent and recognizable.

## Files in this stage

### Prompt asset constants
These embedded prompt templates provide the raw static instruction text later wrapped into contextual fragments.

### `prompts/src/agents.rs`

`config` · `build time and whenever agent prompts are assembled`

This is a very small bridge between a Markdown prompt template and the Rust code that needs it. The real content lives in `templates/agents/hierarchical.md`, which is likely written as normal text so people can edit and review it easily. This file uses Rust’s `include_str!` feature to bake that Markdown file into the compiled program as a string.

In everyday terms, it is like putting a printed instruction sheet inside the product box instead of asking the user to download it later. Wherever the application needs the hierarchical agent instructions, it can use `HIERARCHICAL_AGENTS_MESSAGE` and get the full prompt text immediately.

This matters because prompts are part of the system’s behavior. If this constant were missing or pointed to the wrong file, code that builds agent messages would either fail to compile or would not have the instructions it expects. There is no runtime file reading here: the template is captured when the program is built, so the compiled application carries the prompt with it.


### `prompts/src/apply_patch.rs`

`config` · `startup`

This file exists so the project can keep a long, human-readable instruction document in a Markdown file, while still letting Rust code use it directly. The instruction document explains how GPT-4.1 should use the `apply_patch` tool, which is a tool for making code changes by applying patch-style edits.

Instead of copying that whole instruction text into Rust source code, this file uses Rust's `include_str!` feature. That means: at compile time, Rust reads the Markdown file from `../templates/apply_patch_tool_instructions.md` and bakes its full text into the program as a string. You can think of it like stapling a printed instruction sheet into the final application when it is built.

The exported constant, `APPLY_PATCH_TOOL_INSTRUCTIONS`, gives other parts of the codebase one clear place to get these instructions. If the wording of the tool instructions needs to change, the template file can be edited without changing this Rust wrapper. Without this file, other code would either need to know the template path itself or duplicate the instruction text, which would make updates easier to miss and harder to keep consistent.


### `prompts/src/compact.rs`

`config` · `prompt construction`

This file is a small bridge between plain text prompt files and the Rust code that needs them. The real content lives in Markdown template files: one for the main summarization prompt, and one for the prefix used before a summary. This file pulls those files into the program at compile time, meaning the text is baked into the built application rather than loaded from disk while it is running.

That matters because prompt wording is part of how the system behaves. If another part of the project needs to ask a model to make a compact summary, it can refer to `SUMMARIZATION_PROMPT` instead of knowing where the template file is or opening it itself. Likewise, `SUMMARY_PREFIX` gives a shared bit of text that can be placed before summary content.

An everyday analogy is a cookbook page copied into a kitchen manual before the restaurant opens: cooks can use the recipe immediately during service, without searching through a filing cabinet. If this file were missing, other code would either fail to find these constants or would need duplicate logic for locating and loading the prompt templates.


### `prompts/src/realtime.rs`

`config` · `prompt setup`

This file is a small bridge between Markdown template files and the Rust code that uses them. The real content lives in separate `.md` files under `templates/realtime`, where it is easier for people to read and edit. This Rust file gives each template a clear name, like `BACKEND_PROMPT`, `START_INSTRUCTIONS`, and `END_INSTRUCTIONS`.

It uses Rust’s `include_str!` feature, which copies the contents of a text file into the program when the program is built. In everyday terms, it is like taping printed instruction sheets into the back of a machine before shipping it, instead of asking the machine to find those sheets later. That means these prompt texts are always available at runtime and do not depend on reading files from disk while the program is running.

Without this file, other parts of the project would either need to know the exact template paths or duplicate the prompt text themselves. This file keeps that knowledge in one place and gives the realtime prompt pieces stable names the rest of the code can rely on.


### Fragment foundations and adapters
These files define the shared low-level fragment shapes and adapt external skill or internal context data into the common contextual-fragment interface.

### `context-fragments/src/additional_context.rs`

`domain_logic` · `prompt construction`

This file solves a simple but important problem: when the system adds outside context, such as a file snippet or tool-provided detail, the model needs to see where that context starts, where it ends, and what kind of context it is. Without these wrappers, outside text could blend into the user’s own words or into developer instructions, making it easier to misunderstand.

There are two small fragment types here. `AdditionalContextUserFragment` formats extra context as something that belongs in the user role. It uses tags shaped like `<external_key>... </external_key>` so the context is clearly labeled as external. It can also recognize whether a piece of text already has that external-context shape.

`AdditionalContextDeveloperFragment` formats similar information for the developer role. Its body uses plain XML-like tags such as `<key>... </key>`, and its marker methods intentionally return empty strings because the whole body already includes its own tags.

Both fragment types keep the same two pieces of information: a `key`, which names the context, and a `value`, which is the actual text. Before the value is inserted, it is shortened with a token budget. A token is roughly a chunk of text used by a language model. This protects the prompt from becoming too large, like trimming a long article before taping it into a note.

#### Function details

##### `AdditionalContextUserFragment::new`  (lines 16–18)

```
fn new(key: String, value: String) -> Self
```

**Purpose**: Creates a user-role additional context fragment from a name and some text. Code uses this when it wants outside information to appear as part of the user-side context.

**Data flow**: It receives a `key` that labels the context and a `value` that contains the context text. It stores both inside a new `AdditionalContextUserFragment` and returns that fragment unchanged.

**Call relations**: This is the starting point for building a user additional-context fragment. Once created, the fragment can later be asked for its role, markers, or formatted body when the larger prompt is assembled.


##### `AdditionalContextUserFragment::role`  (lines 22–24)

```
fn role(&self) -> &'static str
```

**Purpose**: Says that this fragment belongs in the `user` role. This lets the prompt-building code place the fragment in the right part of the conversation.

**Data flow**: It reads no outside information and does not change the fragment. It simply returns the fixed text `user`.

**Call relations**: When the broader context system asks a fragment where it should go, this method answers that user additional context should be sent as user content.


##### `AdditionalContextUserFragment::markers`  (lines 26–28)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the start and end marker pieces used to identify user additional-context text. These markers are the reusable wrapper pieces for this fragment type.

**Data flow**: It takes the existing fragment, reads no stored `key` or `value`, and delegates to the type-level marker definition. The result is the pair of marker strings used by this kind of fragment.

**Call relations**: Prompt-building or fragment-matching code can ask an individual user fragment for its markers. This method hands that request to `type_markers` so all user additional-context fragments share the same marker rules.

*Call graph*: 1 external calls (type_markers).


##### `AdditionalContextUserFragment::type_markers`  (lines 30–35)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the common marker pattern for all user additional-context fragments. The start marker begins with `<external_`, and the end marker suffix is `>`.

**Data flow**: It receives no fragment data. It returns two fixed strings that describe how this fragment type starts and closes its opening tag.

**Call relations**: This is the shared marker definition used by `AdditionalContextUserFragment::markers` and by any code that needs to know the marker shape without having a particular fragment instance.


##### `AdditionalContextUserFragment::matches_text`  (lines 37–48)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Checks whether a given text looks like a complete user additional-context block. This is useful when the system needs to recognize already-wrapped external context.

**Data flow**: It takes raw text, trims whitespace from the edges, and checks for the expected `<external_...>` opening shape. It then extracts the key from the opening tag and verifies that the text ends with a matching `</external_key>` closing tag. It returns `true` only when the opening and closing labels match.

**Call relations**: This function is the recognition counterpart to `AdditionalContextUserFragment::body`. The body builder creates this kind of tagged text, and `matches_text` later verifies whether some text follows the same pattern.

*Call graph*: 1 external calls (format!).


##### `AdditionalContextUserFragment::body`  (lines 50–52)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual user-role text that will be inserted into the prompt. It wraps the stored value in external-context tags based on the stored key.

**Data flow**: It reads the fragment’s `key` and `value`, then passes them to `additional_context_body`. The returned string is the fully formatted context body, with the value shortened if needed.

**Call relations**: When prompt assembly needs the contents of this user fragment, it calls this method. This method hands the formatting work to `additional_context_body` so the wrapping and truncation rules stay in one place.

*Call graph*: calls 1 internal fn (additional_context_body).


##### `AdditionalContextDeveloperFragment::new`  (lines 62–64)

```
fn new(key: String, value: String) -> Self
```

**Purpose**: Creates a developer-role additional context fragment from a name and some text. Code uses this when the extra context should be treated as developer-side information rather than user-side content.

**Data flow**: It receives a `key` and a `value`, stores them inside a new `AdditionalContextDeveloperFragment`, and returns that new fragment.

**Call relations**: This is the creation step for developer additional context. After construction, the fragment can be queried for its role or turned into a tagged body during prompt construction.


##### `AdditionalContextDeveloperFragment::role`  (lines 68–70)

```
fn role(&self) -> &'static str
```

**Purpose**: Says that this fragment belongs in the `developer` role. That tells the larger prompt system to place it with developer instructions or developer-provided context.

**Data flow**: It does not read the stored key or value. It returns the fixed text `developer` and changes nothing.

**Call relations**: The context system calls this when deciding where the fragment should be inserted. This method separates developer context from user context.


##### `AdditionalContextDeveloperFragment::markers`  (lines 72–74)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the marker pair for developer additional-context fragments. For this type, both marker strings are empty because the body itself includes its tags.

**Data flow**: It reads no stored fragment data and delegates to the type-level marker definition. The result is a pair of empty strings.

**Call relations**: When generic fragment code asks this developer fragment for outer markers, this method supplies the type’s answer through `type_markers`. The real labeling happens later in `body`.

*Call graph*: 1 external calls (type_markers).


##### `AdditionalContextDeveloperFragment::type_markers`  (lines 76–78)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the shared marker pair for all developer additional-context fragments. It returns empty markers, meaning there is no extra wrapper outside the generated body.

**Data flow**: It takes no inputs and returns two empty strings. It does not inspect or change any fragment.

**Call relations**: This supports `AdditionalContextDeveloperFragment::markers` and any code that needs the marker convention for this fragment type without holding an instance.


##### `AdditionalContextDeveloperFragment::body`  (lines 80–82)

```
fn body(&self) -> String
```

**Purpose**: Builds the developer-role text that will be inserted into the prompt. It wraps the stored value in tags named by the stored key.

**Data flow**: It reads the fragment’s `key` and `value`, then passes them to `additional_context_developer_body`. The result is a formatted string like `<key>value</key>`, with the value shortened if it is too long.

**Call relations**: Prompt construction calls this when it needs the actual developer context text. This method delegates the formatting and length control to `additional_context_developer_body`.

*Call graph*: calls 1 internal fn (additional_context_developer_body).


##### `additional_context_body`  (lines 85–88)

```
fn additional_context_body(key: &str, value: &str) -> String
```

**Purpose**: Formats user additional context into the external-context tag shape. It also trims long values so one context item cannot consume too much of the prompt.

**Data flow**: It receives a `key` and `value`. First it shortens the value to fit the maximum token budget, keeping the middle-truncation behavior supplied by the shared string utility. Then it returns text shaped as `key>value</external_key`, which is meant to sit after the shared `<external_` prefix.

**Call relations**: This helper is called by `AdditionalContextUserFragment::body`. The fragment method supplies the stored key and value, and this helper performs the exact wrapping and truncation.

*Call graph*: called by 1 (body); 2 external calls (truncate_middle_with_token_budget, format!).


##### `additional_context_developer_body`  (lines 90–93)

```
fn additional_context_developer_body(key: &str, value: &str) -> String
```

**Purpose**: Formats developer additional context as a complete tagged block. It keeps developer context clearly labeled while limiting how much text can be inserted.

**Data flow**: It receives a `key` and `value`. It shortens the value to the allowed token budget, then returns a full tag pair around it, like `<key>value</key>`.

**Call relations**: This helper is called by `AdditionalContextDeveloperFragment::body`. The fragment method provides the stored data, and this helper applies the developer-specific tag format and length limit.

*Call graph*: called by 1 (body); 2 external calls (truncate_middle_with_token_budget, format!).


### `core-skills/src/skill_instructions.rs`

`data_model` · `prompt/context construction`

A “skill” in this project appears to be a reusable bundle of instructions. This file gives the system a standard way to present one of those bundles to the language model. Without this, different parts of the program might describe skills in different shapes, making the prompt harder to read and harder for the model to interpret reliably.

The central type is `SkillInstructions`. It stores three simple pieces of information: the skill name, where it came from, and the instruction text itself. It can be built directly from a `SkillInjection`, which is likely the earlier form used when skills are discovered or prepared for insertion.

The file also makes `SkillInstructions` implement `ContextualUserFragment`. In plain terms, that means it knows how to describe itself as a piece of context that should be shown as coming from the user. It says its outer wrapper should be `<skill> ... </skill>`, and its inner body should contain a `<name>`, a `<path>`, and then the raw skill contents.

An everyday analogy: this file is like the label maker for skill documents. It does not decide which documents to use; it makes sure each chosen document is packaged with a clear title, source path, and contents before being handed to the model.

#### Function details

##### `SkillInstructions::from`  (lines 13–19)

```
fn from(skill: &SkillInjection) -> Self
```

**Purpose**: This creates a `SkillInstructions` value from a `SkillInjection`. It is used when the system already has a prepared skill and needs to convert it into the format used for contextual instructions.

**Data flow**: It receives a `SkillInjection` containing a name, path, and contents. It copies those three fields into a new `SkillInstructions` object. The result is a clean instruction-focused wrapper around the same skill information.

**Call relations**: This is the bridge from skill injection data into the context-fragment form used later. After this conversion, the other methods on `SkillInstructions` can describe how the skill should appear in the model's context.


##### `SkillInstructions::role`  (lines 23–25)

```
fn role(&self) -> &'static str
```

**Purpose**: This says that the skill instruction block should be treated as coming from the `user` role. In chat-style model input, a role is the label that tells the model who a message is from.

**Data flow**: It reads no stored skill data. It always returns the fixed text `user`, which tells the surrounding context-building code how to label this fragment.

**Call relations**: This is called through the `ContextualUserFragment` behavior when the larger system is assembling context for the model. It supplies the role label while the other methods supply the wrapping markers and body text.


##### `SkillInstructions::markers`  (lines 27–29)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This returns the opening and closing tags that should surround a skill instruction block. It keeps the instance-level marker choice in sync with the type-wide marker definition.

**Data flow**: It takes the current `SkillInstructions` object but does not need to inspect its fields. It asks `SkillInstructions::type_markers` for the standard pair of tags, then returns those tags unchanged.

**Call relations**: When context-building code asks this fragment how it should be wrapped, this method answers by delegating to `type_markers`. That means there is one shared source of truth for the `<skill>` and `</skill>` tags.

*Call graph*: 1 external calls (type_markers).


##### `SkillInstructions::type_markers`  (lines 31–33)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This defines the standard outer tags for every skill instruction block: `<skill>` at the start and `</skill>` at the end. These tags make it clear where one skill begins and ends.

**Data flow**: It receives no outside data and reads no fields. It returns the fixed pair of marker strings used to wrap skill instructions.

**Call relations**: This is the shared marker definition used by `SkillInstructions::markers`. Other code can also call it when it needs to know the tag format without having a particular `SkillInstructions` value in hand.


##### `SkillInstructions::body`  (lines 35–40)

```
fn body(&self) -> String
```

**Purpose**: This builds the actual text that goes inside the `<skill>` wrapper. It includes the skill's name, its source path, and the full instruction contents.

**Data flow**: It reads the stored `name`, `path`, and `contents` fields from the `SkillInstructions` object. It formats them into one string with `<name>` and `<path>` tags before the raw contents. The output is the complete inner text for the skill fragment.

**Call relations**: After the system has converted a skill into `SkillInstructions`, context-building code calls this method to get the text to place between the markers supplied by `markers`. It uses Rust's formatting machinery to assemble the final string.

*Call graph*: 1 external calls (format!).


### `core/src/context/internal_model_context.rs`

`domain_logic` · `prompt construction and context/history parsing`

This file solves a careful bookkeeping problem: the system sometimes needs to send extra instructions or context to the model that came from the runtime or an extension, not directly from the user. To keep that hidden context easy to find, audit, and separate from normal text, it is wrapped in a special XML-like tag: `<codex_internal_context source="..."> ... </codex_internal_context>`.

The file has two main pieces. `InternalContextSource` is the label that says who supplied the hidden context. It is deliberately restricted to simple names like `planner` or `my_extension_1`: lowercase letters, numbers, and underscores, starting with a lowercase letter. This matters because the source name is placed directly inside the wrapper text. By limiting the characters, the code avoids needing complicated escaping and makes stored conversation history easier to inspect.

`InternalModelContextFragment` is the actual hidden fragment. It says it should appear as a user-role message, provides the start and end markers used to wrap it, and knows how to format its body. It can also detect whether a piece of text is one of these internal fragments. For compatibility, it also recognizes the older `<goal_context>...</goal_context>` format. Without this file, internal steering text could be mixed up with ordinary user text, become hard to identify later, or be formatted in unsafe or inconsistent ways.

#### Function details

##### `InternalContextSource::new`  (lines 23–30)

```
fn new(source: impl Into<String>) -> Result<Self, InvalidInternalContextSource>
```

**Purpose**: Creates a source label for hidden internal context, but only if the label is safe and simple enough to embed in the wrapper text. Someone would use this when an extension or runtime component needs to identify itself as the origin of a hidden context fragment.

**Data flow**: It receives something that can become a string. It converts that value into text, checks the text with `is_valid_source`, and then either returns a valid `InternalContextSource` or returns an `InvalidInternalContextSource` error containing the rejected text.

**Call relations**: This is the gatekeeper for source labels. `InternalContextSource::from_static` relies on it when trusted built-in labels are created, and `is_valid_source` does the actual character-by-character rule check.

*Call graph*: calls 1 internal fn (is_valid_source); 1 external calls (into).


##### `InternalContextSource::from_static`  (lines 33–36)

```
fn from_static(source: &'static str) -> Self
```

**Purpose**: Creates a source label from a hard-coded string that the developers expect to be valid. It is a convenience for trusted labels known at compile time.

**Data flow**: It receives a static string, passes it through the same validation path as normal source creation, and returns an `InternalContextSource`. If the hard-coded value is invalid, it stops with a panic, because that means the program code itself is wrong.

**Call relations**: Tests or higher-level context-building code call this when they need a known source label, such as in compatibility checks and goal-context input creation. It hands the real validation work to `InternalContextSource::new`.

*Call graph*: called by 3 (contextual_user_fragment_is_dyn_compatible, detects_internal_model_context_fragment, goal_context_input_item); 1 external calls (new).


##### `InternalContextSource::as_str`  (lines 38–40)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the source label as ordinary text. This is used when the label needs to be inserted into the hidden context wrapper.

**Data flow**: It reads the stored source string inside `InternalContextSource` and returns a borrowed view of that text. It does not change anything.

**Call relations**: `InternalModelContextFragment::body` calls this while building the formatted wrapper content, so the final hidden message includes its source label.

*Call graph*: called by 1 (body).


##### `InvalidInternalContextSource::fmt`  (lines 50–56)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns an invalid-source error into a clear human-readable message. This helps a developer or caller understand exactly what was wrong with the source label.

**Data flow**: It reads the rejected source string stored in the error and writes a message saying that the value was invalid and that the expected shape is `[a-z][a-z0-9_]*`.

**Call relations**: This is used by Rust's standard error-display flow when the invalid source needs to be shown in logs, test failures, or user-facing diagnostics.

*Call graph*: 1 external calls (write!).


##### `InternalModelContextFragment::new`  (lines 70–75)

```
fn new(source: InternalContextSource, body: impl Into<String>) -> Self
```

**Purpose**: Creates a hidden internal context fragment from a validated source label and the hidden text body. This is the normal constructor for adding runtime-owned context to model input.

**Data flow**: It receives an `InternalContextSource` and some body text. It converts the body into a string, stores both pieces together, and returns a new `InternalModelContextFragment`.

**Call relations**: Higher-level code and tests call this after they have a source label. The resulting fragment is then used through the `ContextualUserFragment` behavior to provide a role, markers, and formatted body.

*Call graph*: called by 3 (contextual_user_fragment_is_dyn_compatible, detects_internal_model_context_fragment, goal_context_input_item); 1 external calls (into).


##### `InternalModelContextFragment::role`  (lines 79–81)

```
fn role(&self) -> &'static str
```

**Purpose**: Says that this hidden fragment should be sent under the user role. In chat-model terms, the role is the speaker label attached to a message.

**Data flow**: It takes the fragment and returns the fixed text `user`. It does not read the fragment body or source, and it changes nothing.

**Call relations**: This is part of the `ContextualUserFragment` contract. Whatever code collects contextual fragments can ask this function what role to use when placing the fragment into model input.


##### `InternalModelContextFragment::markers`  (lines 83–85)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the start and end markers that identify this kind of hidden context in text. These markers act like a labeled envelope around the body.

**Data flow**: It receives the fragment, ignores its individual contents, and returns the standard marker pair for this fragment type.

**Call relations**: This is part of the `ContextualUserFragment` behavior. It delegates to `type_markers`, so the instance-level and type-level marker definitions stay consistent.

*Call graph*: 1 external calls (type_markers).


##### `InternalModelContextFragment::type_markers`  (lines 87–89)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Provides the standard marker pair for internal model context without needing a particular fragment instance. This is useful when code wants to recognize or compare this fragment type in general.

**Data flow**: It returns the fixed start marker `<codex_internal_context` and the fixed end marker `</codex_internal_context>`. No input is transformed and no state changes.

**Call relations**: `InternalModelContextFragment::markers` calls this to avoid duplicating the marker values. Other trait-based code can also use it as the shared definition of this fragment's wrapper.


##### `InternalModelContextFragment::matches_text`  (lines 91–108)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Checks whether a piece of text looks like a valid internal model-context fragment. It also recognizes an older legacy goal-context wrapper so old stored history can still be understood.

**Data flow**: It receives text, trims surrounding whitespace, and first checks whether it matches the legacy `<goal_context>...</goal_context>` shape. If not, it checks for the current start marker, a `source="..."` attribute, a valid source label, and the required closing marker. It returns `true` only when the text matches one of the accepted formats.

**Call relations**: Context-parsing code can call this when it needs to decide whether a text item is hidden internal context rather than ordinary user content. It uses `matches_legacy_goal_context` for backward compatibility and `is_valid_source` to enforce the same source-label rules used during creation.

*Call graph*: calls 2 internal fn (is_valid_source, matches_legacy_goal_context).


##### `InternalModelContextFragment::body`  (lines 110–114)

```
fn body(&self) -> String
```

**Purpose**: Builds the inner formatted text that will be placed between this fragment's markers. It includes the source attribute and the hidden body text in the expected layout.

**Data flow**: It reads the fragment's source and body. It turns the source into text with `as_str`, then formats a string like ` source="source_name">\nbody\n`. The returned string is the wrapper body portion, not a mutation of the fragment.

**Call relations**: Prompt-building code uses this through the `ContextualUserFragment` behavior when it is time to serialize the fragment into model input. It depends on `InternalContextSource::as_str` to safely retrieve the already-validated source label.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (format!).


##### `matches_legacy_goal_context`  (lines 117–120)

```
fn matches_legacy_goal_context(text: &str) -> bool
```

**Purpose**: Recognizes the old hidden-context format that used `<goal_context>` tags. This keeps older conversation records or tests from breaking after the newer internal-context wrapper was introduced.

**Data flow**: It receives already-trimmed text and checks whether it starts with the legacy start marker and ends with the legacy end marker. It returns a simple true-or-false answer.

**Call relations**: `InternalModelContextFragment::matches_text` calls this first. If the legacy check succeeds, the newer parsing rules are skipped and the text is still accepted as internal context.

*Call graph*: called by 1 (matches_text).


##### `is_valid_source`  (lines 122–129)

```
fn is_valid_source(source: &str) -> bool
```

**Purpose**: Checks whether a source label follows the file's safe naming rules. The label must start with a lowercase ASCII letter, and the remaining characters may be lowercase ASCII letters, digits, or underscores.

**Data flow**: It receives a source string, looks at the first character, rejects empty strings or labels that do not start correctly, then checks every remaining character. It returns `true` for valid labels and `false` otherwise.

**Call relations**: `InternalContextSource::new` uses this to prevent unsafe or confusing source labels from being created. `InternalModelContextFragment::matches_text` uses the same rule when reading wrapped text back in, so creation and detection agree.

*Call graph*: called by 2 (new, matches_text).


### `ext/skills/src/fragments.rs`

`data_model` · `prompt construction`

This file is about packaging skill information so it can be safely added to the model’s context. A “skill” here is extra instruction text, usually stored separately, that can teach the model how to do a particular kind of task. The system needs two related kinds of fragments: one that lists which skills are available, and one that carries the full instructions for a specific skill.

The first type, AvailableSkillsInstructions, holds short lines describing available skills. When asked for its text, it uses a shared renderer to turn those lines into a readable instructions block. It labels itself as coming from the developer, meaning it is guidance from the system builder rather than from the end user.

The second type, SkillInstructions, holds one skill’s name, file path, and contents. It labels itself as user-provided context and wraps its body in simple XML-like tags such as <name> and <path>. The tags are like labels on folders: they help later readers, including the model, understand what each piece of text means.

Both types implement ContextualUserFragment, a shared interface for “pieces of context that can be inserted into a prompt.” Without this file, the skills extension would not have a consistent way to turn skill metadata and skill files into prompt-ready text.

#### Function details

##### `AvailableSkillsInstructions::from_skill_lines`  (lines 12–14)

```
fn from_skill_lines(skill_lines: Vec<String>) -> Self
```

**Purpose**: Creates an AvailableSkillsInstructions value from a list of already-prepared skill description lines. Someone uses this when they have gathered the available skills and need to package them as a prompt fragment.

**Data flow**: It receives a list of strings, stores that list inside a new AvailableSkillsInstructions object, and returns the object. It does not change the strings or read anything else.

**Call relations**: This is the entry point for building the available-skills fragment. Later, the fragment can be asked for its role, markers, and body when the prompt-building code needs to insert it into the conversation.


##### `AvailableSkillsInstructions::role`  (lines 18–20)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the prompt system that the available-skills list should be treated as developer guidance. In plain terms, it marks this text as instructions from the application, not as a normal user message.

**Data flow**: It reads no stored data and always returns the fixed text "developer". Nothing is changed.

**Call relations**: When the surrounding fragment system prepares a prompt, it can ask this fragment what speaker role to use. This function supplies that role directly.


##### `AvailableSkillsInstructions::markers`  (lines 22–24)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing tags that should surround the available-skills instructions. These markers help identify the fragment later, like a named envelope around the text.

**Data flow**: It takes the current fragment, does not inspect its skill lines, and asks the type-level marker function for the two marker strings. It returns those two strings unchanged.

**Call relations**: The fragment system calls this when it needs to wrap or recognize this kind of context. This function delegates to AvailableSkillsInstructions::type_markers so the marker choice lives in one place.

*Call graph*: 1 external calls (type_markers).


##### `AvailableSkillsInstructions::type_markers`  (lines 26–28)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact tags used around available-skills instructions. This gives the whole system one consistent pair of markers for this fragment type.

**Data flow**: It reads two shared protocol constants and returns them as an opening-marker and closing-marker pair. It does not depend on any individual fragment’s data.

**Call relations**: AvailableSkillsInstructions::markers calls this so instance-level marker requests use the same fixed protocol tags. Other code can also use it when it needs the markers without having a fragment object.


##### `AvailableSkillsInstructions::body`  (lines 30–32)

```
fn body(&self) -> String
```

**Purpose**: Turns the stored skill lines into the actual text that will be placed inside the available-skills fragment. It relies on the shared skill renderer so the wording stays consistent with the rest of the skills system.

**Data flow**: It reads the fragment’s list of skill lines, passes them to render_available_skills_body along with an empty first list, and returns the rendered string. The fragment itself is not changed.

**Call relations**: When prompt-building code needs the content of the available-skills fragment, it calls this function. This function hands the formatting work to render_available_skills_body, which produces the final human-readable block.

*Call graph*: 1 external calls (render_available_skills_body).


##### `SkillInstructions::role`  (lines 43–45)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the prompt system that a full skill instruction block should be treated as user context. This separates the skill text from developer-level instructions.

**Data flow**: It reads no fields from the skill and always returns the fixed text "user". It changes nothing.

**Call relations**: When the fragment system inserts a selected skill into the conversation, it asks this function which speaker role to use. This function provides the fixed answer.


##### `SkillInstructions::markers`  (lines 47–49)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the tags that wrap a full skill instruction block. These tags let the surrounding system recognize where a skill starts and ends.

**Data flow**: It takes the current skill fragment, does not read the name, path, or contents, and calls SkillInstructions::type_markers to get the fixed opening and closing tags. It returns that pair.

**Call relations**: The prompt-building code uses this when wrapping or identifying a skill fragment. This function delegates to SkillInstructions::type_markers so the tag strings are defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `SkillInstructions::type_markers`  (lines 51–53)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact wrapper tags for a full skill instruction block: an opening <skill> tag and a closing </skill> tag. This gives every skill fragment the same recognizable boundary.

**Data flow**: It reads no object data and returns the two fixed marker strings. Nothing is changed.

**Call relations**: SkillInstructions::markers calls this when an existing fragment needs its markers. Code that only needs to know the marker format can also use this type-level function.


##### `SkillInstructions::body`  (lines 55–60)

```
fn body(&self) -> String
```

**Purpose**: Builds the text body for one skill, including its name, its source path, and its full instruction contents. The result is structured so a reader can tell what the skill is called, where it came from, and what it says.

**Data flow**: It reads the skill’s name, path, and contents fields, places the name inside <name> tags, the path inside <path> tags, then appends the raw contents. It returns the combined string and does not modify the skill.

**Call relations**: When the prompt system needs to include a selected skill, it calls this function for the inner text of the fragment. This function uses Rust’s formatting machinery to assemble the final block before the fragment markers are added around it.

*Call graph*: 1 external calls (format!).


### Session and environment context
These fragments inject the main runtime, instruction, and operational context that frames an ongoing conversation for the model.

### `core/src/context/approved_command_prefix_saved.rs`

`data_model` · `cross-cutting`

This file is like a prepared note card the system can insert into its working context. The note says which command prefixes have been approved and saved. A command prefix is the beginning part of a shell command, such as `git` or `cargo test`, that may be allowed by an execution policy. Saving it means the system can remember that approval instead of treating the same kind of command as new each time.

The main type, `ApprovedCommandPrefixSaved`, stores the approved prefixes as text. It implements `ContextualUserFragment`, which is a shared interface for pieces of information that can be placed into the model’s context. Through that interface, this fragment says it should appear with the role `developer`, has no special wrapping markers, and produces a body that starts with `Approved command prefix saved:` followed by the saved prefixes.

Without this file, the rest of the system could still save approvals somewhere, but it would not have this standardized little message object for telling the context-building machinery what was saved and how to phrase it.

#### Function details

##### `ApprovedCommandPrefixSaved::new`  (lines 9–13)

```
fn new(prefixes: impl Into<String>) -> Self
```

**Purpose**: Creates a new saved-prefix context item from any text-like input. It is used when another part of the system has just recorded an execution-policy change and needs a fragment that can be added to context.

**Data flow**: It receives the approved prefixes as something that can be turned into a string. It converts that input into owned text and stores it inside a new `ApprovedCommandPrefixSaved` value. The result is a ready-to-use fragment containing the saved prefixes.

**Call relations**: When `record_execpolicy_amendment_message` needs to describe a newly saved command-prefix approval, it calls this constructor. This function does only the packaging step, then the fragment’s other methods can later describe how it should appear in context.

*Call graph*: called by 1 (record_execpolicy_amendment_message); 1 external calls (into).


##### `ApprovedCommandPrefixSaved::role`  (lines 17–19)

```
fn role(&self) -> &'static str
```

**Purpose**: Says what role this context fragment should use when it is inserted into the conversation-style context. Here, it marks the message as coming from the `developer` role.

**Data flow**: It reads no outside information and does not change the stored prefixes. It simply returns the fixed role name `developer`.

**Call relations**: The context-building code can call this through the `ContextualUserFragment` interface when it needs to place this fragment into the right kind of message. This method supplies the role label, while `body` supplies the actual text.


##### `ApprovedCommandPrefixSaved::markers`  (lines 21–23)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the text markers that should wrap this fragment, if any. For this fragment, there are no markers, so the body is used as-is.

**Data flow**: It takes the fragment value but does not read the saved prefixes. It asks the type-level marker method for the marker pair and returns that pair unchanged.

**Call relations**: The context-building flow can call this when preparing the final text. It delegates to `ApprovedCommandPrefixSaved::type_markers` so the marker choice is defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `ApprovedCommandPrefixSaved::type_markers`  (lines 25–27)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the default opening and closing markers for this kind of fragment. Both are empty strings, meaning this saved-prefix note is not wrapped in any special tags.

**Data flow**: It receives no input and reads no stored data. It returns a pair of empty strings.

**Call relations**: This is used by `ApprovedCommandPrefixSaved::markers` when an actual fragment instance is being formatted. Keeping it separate lets code ask for the marker style for the type itself, not just for one value.


##### `ApprovedCommandPrefixSaved::body`  (lines 29–31)

```
fn body(&self) -> String
```

**Purpose**: Builds the human-readable text that will be inserted into context. It labels the information clearly and then includes the saved command prefixes.

**Data flow**: It reads the stored `prefixes` string. It combines a fixed heading, `Approved command prefix saved:`, with those prefixes on the next line. The result is a new string ready to be included in the context.

**Call relations**: After a fragment has been created, the context-building machinery can call this through the `ContextualUserFragment` interface to get the visible message text. It works together with `role` and `markers`: role says where the message belongs, markers say whether it is wrapped, and body provides the content.

*Call graph*: 1 external calls (format!).


### `core/src/context/environment_context.rs`

`domain_logic` · `context building for startup and each turn`

This file turns internal session state into a small XML-like text block that can be placed in the model conversation. Think of it as the “you are here” sign at the entrance to a building. It tells the model the current working directory, shell, date, timezone, network domain rules, filesystem permissions, and optional subagent information.

The file supports both old and new shapes of environment data. Older context had a single current directory and shell. Newer context can include several environments, each with its own id, directory, and shell. It also knows how to compare one environment context to another while ignoring shell differences, because the shell is not always meant to be treated as a turn-by-turn change.

A large part of the file is about rendering permissions clearly. Filesystem permission profiles are converted into readable tags, including workspace roots, restricted or unrestricted access, deny rules, glob patterns, and special paths like workspace roots or temporary directories. Text is XML-escaped so paths containing characters like < or & do not break the rendered context.

The final piece implements `ContextualUserFragment`, which gives this context a user role, opening and closing markers, and a body string. Other parts of the system can then insert it into the prompt consistently at startup or when the environment changes.

#### Function details

##### `EnvironmentContextEnvironment::legacy`  (lines 36–42)

```
fn legacy(cwd: AbsolutePathBuf, shell: String) -> Self
```

**Purpose**: Creates the older single-environment shape from a current directory and shell. It uses an empty id because legacy environment context did not name environments.

**Data flow**: It receives an absolute current directory and a shell name. It packages them into an `EnvironmentContextEnvironment` with no environment id, then returns that value.

**Call relations**: It is used when `EnvironmentContext::diff_from_turn_context_item` needs to describe a changed single current directory in the old format.

*Call graph*: called by 1 (diff_from_turn_context_item); 1 external calls (new).


##### `EnvironmentContextEnvironment::from_turn_environments`  (lines 44–61)

```
fn from_turn_environments(environments: &[TurnEnvironment], shell: &Shell) -> Vec<Self>
```

**Purpose**: Converts the session’s list of turn environments into the simpler environment entries used in the prompt. It chooses each environment’s own shell when present, otherwise it falls back to the session shell.

**Data flow**: It reads a list of `TurnEnvironment` values and a default `Shell`. For each environment, it tries to turn its working directory into an absolute local path; entries that cannot be represented this way are skipped. It returns a list of prompt-ready environment records.

**Call relations**: It is called by `EnvironmentContext::from_turn_context` while building the full environment context for the current turn.

*Call graph*: called by 1 (from_turn_context); 1 external calls (iter).


##### `EnvironmentContextEnvironments::from_vec`  (lines 72–82)

```
fn from_vec(environments: Vec<EnvironmentContextEnvironment>) -> Self
```

**Purpose**: Turns a plain list of environments into the file’s three-case form: none, one, or many. This avoids making later rendering code guess whether a list is empty or has only one item.

**Data flow**: It receives a vector of environment entries. If the vector is empty, it returns `None`; if it has one item, it returns `Single`; if it has more, it returns `Multiple` with the original entries.

**Call relations**: It is used by `EnvironmentContext::new` and `EnvironmentContext::from_turn_context_item` whenever raw environment lists are converted into an `EnvironmentContext`.

*Call graph*: called by 2 (from_turn_context_item, new); 2 external calls (Multiple, Single).


##### `EnvironmentContextEnvironments::equals_except_shell`  (lines 84–97)

```
fn equals_except_shell(&self, other: &Self) -> bool
```

**Purpose**: Compares two environment collections while deliberately ignoring shell names. This is useful because shell information may be fixed at the start and not meaningful as a later change.

**Data flow**: It receives two environment collections. It compares their shape and their current directories, and for multiple environments it also compares ids; it does not compare shell strings. It returns true only when the non-shell parts match.

**Call relations**: It is called by `EnvironmentContext::equals_except_shell`, which applies the same idea to the whole environment context.

*Call graph*: called by 1 (equals_except_shell).


##### `FileSystemContext::from_permission_profile`  (lines 123–147)

```
fn from_permission_profile(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Builds the filesystem part of the prompt from the project’s permission settings and workspace roots. This tells the model what files are in scope and how restricted file access is.

**Data flow**: It receives a permission profile and absolute workspace roots. It first replaces project-root placeholders in the profile with the real workspace roots, stores the roots as strings, then turns the permission profile into a prompt-friendly filesystem context. It returns that context.

**Call relations**: It is called when building filesystem context from a live turn, from a saved turn context item, and by tests that serialize full filesystem profiles.

*Call graph*: calls 1 internal fn (from); called by 3 (filesystem_from_turn_context_item, from_turn_context, serialize_environment_context_with_full_filesystem_profile); 3 external calls (Managed, clone, iter).


##### `FileSystemContext::render`  (lines 149–161)

```
fn render(&self) -> String
```

**Purpose**: Turns the filesystem context into XML-like text for the model. It includes workspace roots first, then the permission profile.

**Data flow**: It reads the stored workspace root strings and permission profile. It appends tags into a string, escaping root text as needed, and returns the completed `<filesystem>` block.

**Call relations**: It calls `push_text_element` for safe root text and asks `FileSystemPermissionProfileContext::render` to write the permission details.

*Call graph*: calls 2 internal fn (render, push_text_element).


##### `ManagedFileSystemContext::from`  (lines 165–179)

```
fn from(file_system: ManagedFileSystemPermissions) -> Self
```

**Purpose**: Converts managed filesystem permission data from the protocol layer into this file’s renderable form. It also removes duplicate permission entries so the prompt is not cluttered.

**Data flow**: It receives managed filesystem permissions. For restricted permissions, it deduplicates the entries and converts the optional scan depth into a normal number; for unrestricted permissions, it records that directly. It returns a `ManagedFileSystemContext`.

**Call relations**: It is called by `FileSystemContext::from_permission_profile` when the permission profile is managed by Codex.

*Call graph*: calls 1 internal fn (dedupe_file_system_entries); called by 1 (from_permission_profile).


##### `FileSystemPermissionProfileContext::render`  (lines 183–201)

```
fn render(&self, rendered: &mut String)
```

**Purpose**: Writes the permission-profile wrapper around filesystem access details. It makes clear whether permissions are managed by Codex, disabled, or controlled externally.

**Data flow**: It receives a mutable output string. Depending on the stored profile type, it appends the right tags and, for managed profiles, asks the managed filesystem context to render its details.

**Call relations**: It is called by `FileSystemContext::render` as the second half of the filesystem block.

*Call graph*: called by 1 (render).


##### `ManagedFileSystemContext::render`  (lines 205–230)

```
fn render(&self, rendered: &mut String)
```

**Purpose**: Writes the detailed managed filesystem rules into the prompt. It distinguishes restricted access, unrestricted access, optional glob scan depth, and individual allow or deny entries.

**Data flow**: It receives a mutable output string. For unrestricted access, it writes a short self-contained tag. For restricted access, it writes either a short empty restricted tag or a full tag containing scan depth and rendered entries. It changes only the output string.

**Call relations**: It is called from `FileSystemPermissionProfileContext::render`; for each restricted entry it hands off to `render_file_system_entry`.

*Call graph*: calls 1 internal fn (render_file_system_entry); 1 external calls (format!).


##### `render_file_system_entry`  (lines 233–254)

```
fn render_file_system_entry(rendered: &mut String, entry: &FileSystemSandboxEntry)
```

**Purpose**: Renders one filesystem permission rule, such as an allowed path, denied glob, or special location. It also marks deny rules as not escalatable.

**Data flow**: It receives the output string and one sandbox entry. It writes the entry’s access mode, then writes the path, glob pattern, or special path inside the entry tag. The output string gains one complete `<entry>` block.

**Call relations**: It is called by `ManagedFileSystemContext::render` for each restricted filesystem rule, and it uses `render_special_path` when the rule points to a named special location.

*Call graph*: calls 2 internal fn (push_text_element, render_special_path); called by 1 (render).


##### `render_special_path`  (lines 256–269)

```
fn render_special_path(value: &FileSystemSpecialPath) -> String
```

**Purpose**: Converts a special filesystem location into a short text label the prompt can include. Examples include root, workspace roots, and temporary directories.

**Data flow**: It receives a special path enum. It maps known special values to labels like `:root` or `:tmpdir`, and includes a subpath when one exists. It returns the label string.

**Call relations**: It is used by `render_file_system_entry` when an entry is not a normal path or glob, and it delegates subpath formatting to `render_special_path_with_subpath`.

*Call graph*: calls 1 internal fn (render_special_path_with_subpath); called by 1 (render_file_system_entry).


##### `render_special_path_with_subpath`  (lines 271–276)

```
fn render_special_path_with_subpath(base: &str, subpath: &Option<PathBuf>) -> String
```

**Purpose**: Adds an optional subpath to a special-path label. This is how a broad label like workspace roots can become something more specific.

**Data flow**: It receives a base label and an optional path below that base. If a subpath exists, it returns `base/subpath`; otherwise it returns just the base label.

**Call relations**: It is called by `render_special_path` for special path variants that may carry a subpath.

*Call graph*: called by 1 (render_special_path); 1 external calls (format!).


##### `dedupe_file_system_entries`  (lines 278–281)

```
fn dedupe_file_system_entries(entries: &mut Vec<FileSystemSandboxEntry>)
```

**Purpose**: Removes repeated filesystem permission entries. This keeps the rendered permission list shorter and easier for the model to read.

**Data flow**: It receives a mutable list of sandbox entries. It remembers entries it has already seen and keeps only the first copy of each one. The same list is modified in place.

**Call relations**: It is called by `ManagedFileSystemContext::from` before restricted permissions are stored.

*Call graph*: called by 1 (from); 1 external calls (new).


##### `push_text_element`  (lines 283–287)

```
fn push_text_element(rendered: &mut String, name: &str, value: &str)
```

**Purpose**: Appends a simple XML-like text element to an output string. It is used for values such as paths and glob patterns where the text must be escaped safely.

**Data flow**: It receives an output string, a tag name, and a text value. It writes the opening tag, escaped text, and closing tag into the output string.

**Call relations**: It is used by `FileSystemContext::render` and `render_file_system_entry`, and it relies on `push_xml_escaped_text` to make the text safe.

*Call graph*: calls 1 internal fn (push_xml_escaped_text); called by 2 (render, render_file_system_entry); 1 external calls (format!).


##### `push_xml_escaped_text`  (lines 289–300)

```
fn push_xml_escaped_text(rendered: &mut String, value: &str)
```

**Purpose**: Writes text while replacing characters that would confuse XML-like markup. For example, `&` becomes `&amp;` and `<` becomes `&lt;`.

**Data flow**: It receives an output string and raw text. It walks through the text character by character, appending either the safe replacement or the original character. It changes only the output string.

**Call relations**: It is called by `push_text_element` whenever user- or path-derived text is inserted inside tags.

*Call graph*: called by 1 (push_text_element).


##### `NetworkContext::new`  (lines 309–314)

```
fn new(allowed_domains: Vec<String>, denied_domains: Vec<String>) -> Self
```

**Purpose**: Creates a network context from lists of allowed and denied domains. This gives the prompt a concise summary of network rules.

**Data flow**: It receives two lists of domain names. It stores them unchanged in a `NetworkContext` and returns it.

**Call relations**: It is called when network rules are read from live turn configuration, from a saved turn context item, and by tests that serialize network context.

*Call graph*: called by 3 (network_from_turn_context, network_from_turn_context_item, serialize_environment_context_with_network).


##### `NetworkContext::render`  (lines 316–322)

```
fn render(&self) -> String
```

**Purpose**: Turns network permissions into an XML-like `<network>` block. It only includes allowed or denied sections when those lists are not empty.

**Data flow**: It reads the stored allowed and denied domain lists. It builds a string starting with network enabled, adds domain sections as needed, and returns the finished block.

**Call relations**: It calls `NetworkContext::push_rendered_domain_element` for the allowed list and again for the denied list, and `EnvironmentContext::body` includes the result in the prompt.

*Call graph*: 1 external calls (push_rendered_domain_element).


##### `NetworkContext::push_rendered_domain_element`  (lines 324–332)

```
fn push_rendered_domain_element(rendered_network: &mut String, name: &str, domains: &[String])
```

**Purpose**: Adds one domain-list element, such as `<allowed>` or `<denied>`, to the network text. Empty lists are skipped to avoid noisy output.

**Data flow**: It receives the output string, an element name, and a list of domains. If the list has domains, it joins them with commas and appends a complete element to the output string.

**Call relations**: It is used inside `NetworkContext::render` for both allowed and denied domain lists.

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

**Purpose**: Creates a new environment context from raw pieces such as environments, date, timezone, network rules, and subagent text. It starts without filesystem information, which can be added later.

**Data flow**: It receives a vector of environment entries plus optional date, timezone, network, and subagent data. It converts the environment vector into none/single/multiple form and returns the assembled context.

**Call relations**: It is used by `EnvironmentContext::from_turn_context` and many tests as the normal constructor for environment context.

*Call graph*: calls 1 internal fn (from_vec); called by 10 (equals_except_shell_compares_cwd, equals_except_shell_compares_cwd_differences, equals_except_shell_ignores_shell, serialize_environment_context_prefers_environment_shell_when_present, serialize_environment_context_with_full_filesystem_profile, serialize_environment_context_with_multiple_selected_environments, serialize_environment_context_with_network, serialize_environment_context_with_subagents, serialize_read_only_environment_context, serialize_workspace_write_environment_context).


##### `EnvironmentContext::new_with_environments`  (lines 353–369)

```
fn new_with_environments(
        environments: EnvironmentContextEnvironments,
        current_date: Option<String>,
        timezone: Option<String>,
        network: Option<NetworkContext>,
```

**Purpose**: Creates an environment context when the caller has already chosen the none/single/multiple environment form. It is a lower-level constructor used when rebuilding or diffing context.

**Data flow**: It receives the pre-shaped environments plus optional date, timezone, network, filesystem, and subagents. It stores them directly and returns the context.

**Call relations**: It is called by `EnvironmentContext::diff_from_turn_context_item` and by `EnvironmentContext::from_turn_context_item` when those functions need precise control over the environment shape.

*Call graph*: called by 1 (diff_from_turn_context_item).


##### `EnvironmentContext::equals_except_shell`  (lines 374–381)

```
fn equals_except_shell(&self, other: &EnvironmentContext) -> bool
```

**Purpose**: Compares two full environment contexts while ignoring shell differences. This helps decide whether meaningful environment information changed between turns.

**Data flow**: It receives another environment context. It compares environments without shell, then compares date, timezone, network, filesystem, and subagents normally. It returns true if all meaningful fields match.

**Call relations**: It delegates the environment-specific part to `EnvironmentContextEnvironments::equals_except_shell`.

*Call graph*: calls 1 internal fn (equals_except_shell).


##### `EnvironmentContext::diff_from_turn_context_item`  (lines 383–423)

```
fn diff_from_turn_context_item(
        before: &TurnContextItem,
        after: &EnvironmentContext,
    ) -> Self
```

**Purpose**: Builds an environment update by comparing a previous saved turn context with a newer environment context. The result contains only the parts that should be carried forward or updated.

**Data flow**: It reads the old context item’s network and filesystem state, then compares them with the new context. For a single environment, it includes the current directory only if it changed; for multiple environments, it includes them all. It returns a new environment context representing that update.

**Call relations**: It is called by `build_environment_update_item`. It uses `network_from_turn_context_item`, `filesystem_from_turn_context_item`, `EnvironmentContextEnvironment::legacy`, and `new_with_environments` to assemble the result.

*Call graph*: calls 2 internal fn (new_with_environments, legacy); called by 1 (build_environment_update_item); 4 external calls (filesystem_from_turn_context_item, network_from_turn_context_item, Multiple, Single).


##### `EnvironmentContext::from_turn_context`  (lines 425–441)

```
fn from_turn_context(turn_context: &TurnContext, shell: &Shell) -> Self
```

**Purpose**: Builds the full environment context from the live turn state. This is the main path for telling the model what the current session environment looks like.

**Data flow**: It receives a `TurnContext` and default `Shell`. It converts turn environments, copies date and timezone, extracts network rules, then adds filesystem context from the permission profile and workspace roots. It returns a complete `EnvironmentContext`.

**Call relations**: It is called when building the initial context and when preparing environment updates; it uses `from_turn_environments`, `network_from_turn_context`, `EnvironmentContext::new`, and `FileSystemContext::from_permission_profile`.

*Call graph*: calls 2 internal fn (from_turn_environments, from_permission_profile); called by 3 (build_environment_update_item, build_initial_context, environment_context_uses_session_shell_when_environment_shell_is_absent); 2 external calls (network_from_turn_context, new).


##### `EnvironmentContext::from_turn_context_item`  (lines 443–461)

```
fn from_turn_context_item(
        turn_context_item: &TurnContextItem,
        shell: String,
    ) -> Self
```

**Purpose**: Reconstructs an environment context from a saved protocol item. This supports older or persisted context data coming back into the system.

**Data flow**: It receives a `TurnContextItem` and a shell string. It tries to interpret the saved current directory as an absolute path, falling back to resolving it against `/` if needed. It then adds saved date, timezone, network, and filesystem data and returns the reconstructed context.

**Call relations**: It is called by `build_environment_update_item` and related tests. It uses `from_vec`, `network_from_turn_context_item`, `filesystem_from_turn_context_item`, and `new_with_environments`.

*Call graph*: calls 3 internal fn (from_vec, resolve_path_against_base, try_from); called by 2 (turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd, build_environment_update_item); 4 external calls (filesystem_from_turn_context_item, network_from_turn_context_item, new_with_environments, vec!).


##### `EnvironmentContext::with_subagents`  (lines 463–468)

```
fn with_subagents(mut self, subagents: String) -> Self
```

**Purpose**: Adds subagent information to an existing environment context, but only when the text is not empty. This prevents empty subagent sections from appearing in the prompt.

**Data flow**: It receives an environment context and a subagent string. If the string has content, it stores it; otherwise it leaves the context unchanged. It returns the updated context.

**Call relations**: It is a small builder-style helper used after an environment context has already been created.


##### `EnvironmentContext::network_from_turn_context`  (lines 470–490)

```
fn network_from_turn_context(turn_context: &TurnContext) -> Option<NetworkContext>
```

**Purpose**: Extracts network domain rules from the live turn configuration. If the configuration has no network requirements, it returns no network context.

**Data flow**: It reads the turn context’s configuration layer stack and looks for network requirements. When present, it pulls allowed and denied domain lists, defaulting to empty lists when absent, and returns a `NetworkContext`.

**Call relations**: It is used by `EnvironmentContext::from_turn_context`, and it creates the result through `NetworkContext::new`.

*Call graph*: calls 1 internal fn (new).


##### `EnvironmentContext::network_from_turn_context_item`  (lines 492–503)

```
fn network_from_turn_context_item(
        turn_context_item: &TurnContextItem,
    ) -> Option<NetworkContext>
```

**Purpose**: Extracts network domain rules from a saved turn context item. This lets reconstructed context preserve the same allowed and denied domains.

**Data flow**: It reads the item’s optional network section. If the section exists, it clones the allowed and denied domain lists into a new `NetworkContext`; if not, it returns none.

**Call relations**: It is used by `EnvironmentContext::diff_from_turn_context_item` and `EnvironmentContext::from_turn_context_item`, and it builds its result with `NetworkContext::new`.

*Call graph*: calls 1 internal fn (new).


##### `EnvironmentContext::filesystem_from_turn_context_item`  (lines 505–512)

```
fn filesystem_from_turn_context_item(
        turn_context_item: &TurnContextItem,
    ) -> Option<FileSystemContext>
```

**Purpose**: Rebuilds filesystem context from a saved turn context item. It uses the item’s permission profile and workspace roots, including a fallback for older saved data.

**Data flow**: It receives a saved turn context item. It gets the permission profile, computes the workspace roots with `workspace_roots_from_turn_context_item`, and returns a `FileSystemContext` wrapped in `Some`.

**Call relations**: It is used by `EnvironmentContext::diff_from_turn_context_item` and `EnvironmentContext::from_turn_context_item`; it hands the final conversion to `FileSystemContext::from_permission_profile`.

*Call graph*: calls 3 internal fn (from_permission_profile, workspace_roots_from_turn_context_item, permission_profile).


##### `workspace_roots_from_turn_context_item`  (lines 515–528)

```
fn workspace_roots_from_turn_context_item(
    turn_context_item: &TurnContextItem,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds the workspace roots stored in a saved turn context item. For older saved items that did not store roots, it falls back to the old current-directory binding when possible.

**Data flow**: It receives a saved turn context item. If explicit workspace roots exist, it returns them. Otherwise it tries to convert the saved current directory into an absolute path and returns that as the only root, or returns an empty list if that fails.

**Call relations**: It is called by `EnvironmentContext::filesystem_from_turn_context_item` before filesystem permissions are materialized.

*Call graph*: calls 1 internal fn (try_from); called by 1 (filesystem_from_turn_context_item); 2 external calls (new, vec!).


##### `EnvironmentContext::role`  (lines 531–533)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the contextual-fragment system that this environment context should appear as a user message. This affects how it is placed into the conversation sent to the model.

**Data flow**: It takes the environment context and returns the fixed string `user`. It does not read or change any stored environment data.

**Call relations**: It is part of the `ContextualUserFragment` implementation, so the broader prompt-building system can ask this fragment what role to use.


##### `EnvironmentContext::markers`  (lines 535–537)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing marker strings that wrap this environment context. Markers help later code and the model recognize where the environment section begins and ends.

**Data flow**: It receives the environment context and returns the marker pair defined by `type_markers`. It does not change the context.

**Call relations**: It is part of the `ContextualUserFragment` implementation and delegates the actual constants to `EnvironmentContext::type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `EnvironmentContext::type_markers`  (lines 539–544)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Provides the fixed open and close tags used for environment context fragments. This keeps the marker choice in one place.

**Data flow**: It takes no context-specific data. It returns the protocol constants for the environment context opening and closing tags.

**Call relations**: It is called through `EnvironmentContext::markers` by the contextual-fragment machinery.


##### `EnvironmentContext::body`  (lines 546–595)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual text body that is inserted between the environment context markers. This is where all stored environment facts become readable prompt text.

**Data flow**: It reads environments, date, timezone, network, filesystem, and subagents from the context. It formats them as indented XML-like lines, rendering network and filesystem subsections through their own render methods, then returns the complete body string with surrounding newlines.

**Call relations**: It is the final rendering step used by the `ContextualUserFragment` implementation. It calls `NetworkContext::render` and `FileSystemContext::render` indirectly through their stored values when those sections are present.

*Call graph*: 2 external calls (new, format!).


### `core/src/context/guardian_followup_review_reminder.rs`

`domain_logic` · `request handling`

This file is like a sticky note added to a larger set of instructions. It does not make decisions by itself. Instead, it supplies a short piece of text that reminds the reviewing system how to think about follow-up requests.

The main idea is simple: an earlier review should be useful background, but it should not automatically decide the new answer. The reminder says to follow the Workspace Policy, which is the active rulebook for the current situation. It also explains an important exception: if a user clearly approves an action that was previously rejected, and they have been told the concrete risks, the system should usually allow it. The only time it should not is when the policy says the user is not allowed to override that kind of rejection.

The file implements a shared interface called `ContextualUserFragment`, meaning this reminder can be plugged into the broader context-building system alongside other prompt fragments. It identifies itself as written from the `developer` role, provides no special surrounding markers, and returns the actual reminder text as its body.

#### Function details

##### `GuardianFollowupReviewReminder::role`  (lines 7–9)

```
fn role(&self) -> &'static str
```

**Purpose**: This function says that the reminder should appear as a `developer` instruction. In prompt terms, that means it is treated as guidance from the application or system designer, not as ordinary user text.

**Data flow**: It takes the reminder object as input, reads no stored data from it, and returns the fixed text value `developer`. Nothing else is changed.

**Call relations**: When the broader context-building code works with this object through the `ContextualUserFragment` interface, it asks for the role so it knows where to place this reminder in the assembled prompt.


##### `GuardianFollowupReviewReminder::markers`  (lines 11–13)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This function provides the opening and closing marker strings that should wrap this reminder, if any are needed. For this reminder, it delegates to the shared type-level marker choice.

**Data flow**: It takes the reminder object, calls `type_markers` to get the marker pair, and returns that pair. Since the marker pair is empty strings, the reminder is not wrapped in any special labels.

**Call relations**: The context-building flow calls this when formatting the fragment. Rather than deciding separately, it hands the work to `GuardianFollowupReviewReminder::type_markers` so the instance-level and type-level marker behavior stay the same.

*Call graph*: 1 external calls (type_markers).


##### `GuardianFollowupReviewReminder::type_markers`  (lines 15–17)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This function states the default marker pair for this kind of reminder. Here, it intentionally says there are no markers.

**Data flow**: It receives no object-specific information, reads no external data, and returns two empty strings as the start and end markers. It does not change anything.

**Call relations**: It is used by `GuardianFollowupReviewReminder::markers` when the formatter asks how this fragment should be wrapped in the larger prompt.


##### `GuardianFollowupReviewReminder::body`  (lines 19–28)

```
fn body(&self) -> String
```

**Purpose**: This function returns the actual reminder text that will be inserted into the prompt. The text explains how to weigh earlier reviews, current policy, user approval, and explicit policy limits.

**Data flow**: It takes the reminder object, combines several fixed string pieces into one sentence block, converts that fixed text into an owned `String`, and returns it. It reads no outside state and changes nothing.

**Call relations**: When the context-building system needs the content of this fragment, it calls this function. The function uses Rust’s `concat!` macro, which joins fixed text at compile time, so the final reminder can be handed back as one ready-to-insert string.

*Call graph*: 1 external calls (concat!).


### `core/src/context/hook_additional_context.rs`

`data_model` · `context assembly`

This file is about taking plain text from a hook and turning it into a standard context fragment. A hook is usually a small extension point: outside code can add information at the right moment. Here, that added information is stored as `HookAdditionalContext`.

The project appears to build context out of multiple pieces, all following the `ContextualUserFragment` shape. This file makes hook-provided text fit that shape. Think of it like putting a loose note into a standard envelope so the rest of the system knows how to file it.

The struct itself only stores one thing: the text. Its constructor accepts anything that can become a string, which makes it convenient to use with both string slices and owned strings. When the rest of the system asks what role this fragment has, it answers `developer`. When asked for surrounding markers, it returns empty strings, meaning the text is inserted as-is, without labels or boundary text. When asked for the body, it returns a cloned copy of the stored text.

Without this file, hook-added context would not have this simple adapter, and other parts of the context-building code would need special-case logic for hook text.

#### Function details

##### `HookAdditionalContext::new`  (lines 9–11)

```
fn new(text: impl Into<String>) -> Self
```

**Purpose**: Creates a new hook-added context fragment from some text. Someone would use this when a hook has produced extra information that should be included with the rest of the context.

**Data flow**: It receives a value that can be turned into a `String`. It converts that value into an owned string and stores it inside a new `HookAdditionalContext`. The result is a ready-to-use context fragment containing that text.

**Call relations**: This is the entry point for making this type. It relies on the standard `into` conversion so callers can pass convenient text-like values, and the resulting object is later read through the `ContextualUserFragment` methods.

*Call graph*: 1 external calls (into).


##### `HookAdditionalContext::role`  (lines 15–17)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the context system that this fragment should be treated as a `developer` message. This matters because role labels can affect how the combined context is interpreted downstream.

**Data flow**: It takes the existing fragment but does not need to inspect its stored text. It simply returns the fixed role string `developer`.

**Call relations**: This is called when code is treating `HookAdditionalContext` as a `ContextualUserFragment` and needs to know what role to attach to the text. It does not hand off to any other project function.


##### `HookAdditionalContext::markers`  (lines 19–21)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the marker strings that should be placed around this fragment’s body. For this kind of hook-added text, there are no extra markers.

**Data flow**: It receives the fragment, ignores the stored text, and asks the type-level marker function for the marker pair. The output is a pair of strings: one for before the body and one for after it.

**Call relations**: This is called through the `ContextualUserFragment` interface when the context builder wants to know how to wrap the text. It delegates to `HookAdditionalContext::type_markers` so the instance-level and type-level answers stay the same.

*Call graph*: 1 external calls (type_markers).


##### `HookAdditionalContext::type_markers`  (lines 23–25)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the marker pair for all hook-added context fragments. It says that this fragment type uses no opening or closing marker.

**Data flow**: It takes no fragment data. It returns two empty string slices, meaning there is nothing to add before or after the text.

**Call relations**: This is used by `HookAdditionalContext::markers` when an actual fragment is being formatted. Keeping the rule here makes it clear that marker behavior belongs to the type as a whole, not to any one stored text value.


##### `HookAdditionalContext::body`  (lines 27–29)

```
fn body(&self) -> String
```

**Purpose**: Returns the actual hook-provided text that should be inserted into the context. It gives callers their own copy so the stored fragment remains unchanged.

**Data flow**: It reads the fragment’s stored `text`, clones it into a new `String`, and returns that copy. The original `HookAdditionalContext` is not modified.

**Call relations**: This is called through the `ContextualUserFragment` interface when the context builder needs the content of the fragment. It supplies the text that will be paired with the role and marker information from the other methods.


### `core/src/context/model_switch_instructions.rs`

`domain_logic` · `request handling during model switching`

When a conversation moves from one model to another, the new model may need extra guidance. For example, the previous model might have had different abilities or instructions, and the system wants the new model to pick up smoothly rather than act as if nothing changed. This file packages those handoff instructions into a standard context fragment.

The main type, `ModelSwitchInstructions`, stores the instruction text. It then presents that text through the `ContextualUserFragment` trait, which is a shared interface for pieces of context that can be inserted into the conversation. Think of it like putting a labeled note into a folder before handing the folder to someone else: the note has a sender role, clear start and end labels, and a body that explains what to do.

Here, the fragment uses the role `developer`, meaning it is treated as system-provided guidance rather than ordinary user text. It wraps the content with `<model_switch>` markers so other parts of the system can recognize where this special note begins and ends. Its body contains a short explanation plus the stored model-switch instructions.

#### Function details

##### `ModelSwitchInstructions::new`  (lines 9–13)

```
fn new(model_instructions: impl Into<String>) -> Self
```

**Purpose**: Creates a new model-switch instruction fragment from some instruction text. This is used when the system has decided it needs to tell the next model how to continue after a switch.

**Data flow**: It receives instruction text in a flexible form, converts it into a normal string, and stores it inside a new `ModelSwitchInstructions` value. The result is a ready-to-use context fragment.

**Call relations**: It is called by `build_model_instructions_update_item` when that larger flow is preparing the context update for a model change. This constructor does the simple packaging step before the fragment is later asked for its role, markers, and body.

*Call graph*: called by 1 (build_model_instructions_update_item); 1 external calls (into).


##### `ModelSwitchInstructions::role`  (lines 17–19)

```
fn role(&self) -> &'static str
```

**Purpose**: Says what conversation role this fragment should appear under. It returns `developer`, so the model receives these instructions as guidance from the system/developer side rather than as normal user speech.

**Data flow**: It reads no stored instruction text. It simply returns the fixed role name `developer`.

**Call relations**: This is part of the `ContextualUserFragment` interface. When the surrounding context-building code renders this fragment into the conversation, it can call this method to know where the note belongs.


##### `ModelSwitchInstructions::markers`  (lines 21–23)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the start and end labels used around this fragment. These labels make the model-switch note easy to identify as a distinct block of context.

**Data flow**: It reads no instance-specific data. It asks `type_markers` for the fixed marker pair and returns those two strings.

**Call relations**: This is called through the `ContextualUserFragment` interface when the context system needs to wrap the fragment. It delegates to `type_markers` so the marker strings are defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `ModelSwitchInstructions::type_markers`  (lines 25–27)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact tags that mark a model-switch instruction block: `<model_switch>` and `</model_switch>`. This gives the system a consistent label for this kind of inserted context.

**Data flow**: It takes no input and reads no stored state. It returns the fixed opening and closing marker strings.

**Call relations**: The `markers` method uses this as the source of truth for the fragment’s labels. Other code can also use it when it needs the marker pair for this fragment type.


##### `ModelSwitchInstructions::body`  (lines 29–34)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual text that will be shown to the model. It explains that the user was previously using a different model, then includes the stored instructions for how to continue.

**Data flow**: It reads the saved `model_instructions` string, places it after a short explanatory sentence, and returns the combined text as a new string. It does not change the stored value.

**Call relations**: This is called through the `ContextualUserFragment` interface when the context system is assembling the final conversation input. It uses formatting to turn the stored handoff instructions into a clear note for the next model.

*Call graph*: 1 external calls (format!).


### `core/src/context/network_rule_saved.rs`

`domain_logic` · `approval flow and context building`

When the system learns a new network policy rule, it needs a compact way to remember and explain that fact later. This file defines `NetworkRuleSaved`, a small record for one saved rule: the action, meaning allow or deny, and the host name the rule applies to.

It also teaches this record how to behave as a `ContextualUserFragment`. A contextual user fragment is a small piece of conversation context that the system can insert as if it came from a particular role. Here, the role is `developer`, which signals that this is system-provided development context rather than a normal user request.

The main visible output is a sentence such as: “Allowed network rule saved in execpolicy (allowlist): example.com”. If the rule is a denial, it says “Denied” and refers to the denylist instead. This matters because network approvals can affect later tool execution. Without this file, the system might save the policy internally but fail to explain that saved decision back into the surrounding context, making future behavior harder to understand.

#### Function details

##### `NetworkRuleSaved::new`  (lines 12–17)

```
fn new(amendment: &NetworkPolicyAmendment) -> Self
```

**Purpose**: Creates a `NetworkRuleSaved` record from a network policy amendment. Someone uses this when a newly approved or denied network rule needs to be remembered as context.

**Data flow**: It receives a `NetworkPolicyAmendment`, which contains an action and a host. It copies the action and clones the host text into a new `NetworkRuleSaved` value. The result is a self-contained record that can later produce a context message.

**Call relations**: When `record_network_policy_amendment_message` records that a network policy was changed, it calls this constructor to turn the amendment into the fragment type used by the context system.

*Call graph*: called by 1 (record_network_policy_amendment_message).


##### `NetworkRuleSaved::role`  (lines 21–23)

```
fn role(&self) -> &'static str
```

**Purpose**: Says which conversation role this fragment should appear under. It marks the saved network rule message as coming from the `developer` role.

**Data flow**: It reads no outside data and does not change the record. It simply returns the fixed text `developer`, which the context system can attach to this fragment.

**Call relations**: This is part of the `ContextualUserFragment` behavior. When the broader context-building code asks this fragment how it should be presented, this function provides the role label.


##### `NetworkRuleSaved::markers`  (lines 25–27)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides optional start and end marker strings for this kind of context fragment. In this file, there are no visible markers.

**Data flow**: It reads no stored fields from the record. It delegates to `type_markers`, receives the marker pair, and returns it unchanged.

**Call relations**: The context system can call this through the `ContextualUserFragment` interface when wrapping or separating fragments. This implementation hands off to `type_markers` so the marker choice is defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `NetworkRuleSaved::type_markers`  (lines 29–31)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the marker pair used for all `NetworkRuleSaved` fragments. Both markers are empty strings, meaning the message is not wrapped with special text.

**Data flow**: It takes no input and reads no stored data. It returns a pair of empty strings as the start and end markers.

**Call relations**: `NetworkRuleSaved::markers` calls this function when the context system asks for markers. Keeping it separate lets the type expose the same marker information without needing an existing instance.


##### `NetworkRuleSaved::body`  (lines 33–42)

```
fn body(&self) -> String
```

**Purpose**: Builds the human-readable sentence that explains the saved network rule. It turns the internal allow-or-deny action and host name into a clear message.

**Data flow**: It reads the saved action and host from the `NetworkRuleSaved` record. If the action is allow, it chooses `Allowed` and `allowlist`; if deny, it chooses `Denied` and `denylist`. It then formats those pieces with the host into one output string.

**Call relations**: The context system calls this through the `ContextualUserFragment` interface when it needs the actual text to include. This function uses formatting to produce the final sentence that other parts of the system can display or pass along.

*Call graph*: 1 external calls (format!).


### `core/src/context/token_budget_context.rs`

`data_model` · `context construction`

This file defines two related context fragments: one with detailed budget information, and one with only the remaining-token count. A context fragment is a small message added to the conversation to guide the model. Here, the message is marked as coming from the developer, which means it is an instruction-like note rather than something the end user typed.

The first type, TokenBudgetContext, records three facts: which thread the conversation is in, which context window is currently being used, and how many tokens are still available. Think of this like a fuel gauge in a car: it tells the driver not only how much fuel remains, but also which trip and tank reading it belongs to.

The second type, TokenBudgetRemainingContext, is simpler. It only says how many tokens are left, or says that the amount is unknown. Both types wrap their text in the same <token_budget> markers, so the rest of the system and the model can recognize this note as token-budget information. Without this file, the system would lose a clear, standardized way to tell the model about its shrinking context space.

#### Function details

##### `TokenBudgetContext::new`  (lines 12–18)

```
fn new(thread_id: ThreadId, window_id: u64, tokens_left: i64) -> Self
```

**Purpose**: Creates a full token-budget context fragment with a thread id, a context-window id, and the number of tokens left. It is used when the system has all the details needed to identify the budget precisely.

**Data flow**: It receives a thread identifier, a window number, and a token count. It stores those three values inside a new TokenBudgetContext object. The result is a ready-to-use fragment that can later be turned into text for the model.

**Call relations**: During initial context building, build_initial_context calls this function when it wants to include detailed token-budget information. After creation, the fragment can be asked for its role, markers, and body text through the ContextualUserFragment behavior.

*Call graph*: called by 1 (build_initial_context).


##### `TokenBudgetContext::role`  (lines 22–24)

```
fn role(&self) -> &'static str
```

**Purpose**: Says what role this context fragment should use when it is inserted into the conversation. It returns developer so the note is treated as a system-provided guidance message rather than ordinary user text.

**Data flow**: It reads no changing data from the object. It simply returns the fixed role name developer. Nothing else is changed.

**Call relations**: This is part of the ContextualUserFragment interface. When the broader context-building code prepares this fragment for the model, it can call this method to label the message correctly.


##### `TokenBudgetContext::markers`  (lines 26–28)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing text tags that wrap this fragment. These tags make the token-budget note easy to recognize as a distinct block.

**Data flow**: It takes the existing fragment, reads no per-instance values, and asks the type for its standard marker pair. It returns those two marker strings unchanged.

**Call relations**: This method is used through the ContextualUserFragment interface when the system wraps the fragment body. It delegates to the shared marker definition so the instance method and type-level method stay consistent.

*Call graph*: 1 external calls (type_markers).


##### `TokenBudgetContext::type_markers`  (lines 30–32)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the standard wrapper tags for a full token-budget context block. The opening tag is <token_budget> and the closing tag is </token_budget>.

**Data flow**: It receives no input and reads no object state. It returns the fixed pair of marker strings. Nothing is modified.

**Call relations**: TokenBudgetContext::markers uses this so every TokenBudgetContext instance reports the same wrapper format. Other code can also use it when it needs the marker pair without having an instance.


##### `TokenBudgetContext::body`  (lines 34–41)

```
fn body(&self) -> String
```

**Purpose**: Turns the stored budget details into plain text for the model. The message states the thread id, the current context window, and the number of tokens left.

**Data flow**: It reads the thread id, window id, and token count from the object. It places those values into a human-readable sentence block. The output is a String containing the body text; the object itself is not changed.

**Call relations**: When the context system is assembling the final conversation fragment, it calls this method to get the actual message that will sit between the token-budget markers. Internally it uses Rust's formatting machinery to build the final text.

*Call graph*: 1 external calls (format!).


##### `TokenBudgetRemainingContext::new`  (lines 50–54)

```
fn new(tokens_left: i64) -> Self
```

**Purpose**: Creates a simpler token-budget fragment when the system knows only how many tokens are left. This is useful when thread and window details are not needed or not available.

**Data flow**: It receives a token count and stores it as a known value inside TokenBudgetRemainingContext. The result is a fragment that can later say, in text, exactly how many tokens remain.

**Call relations**: maybe_record_token_budget_remaining_context calls this when it records a known remaining-token count. The fragment-building path also calls it when it needs to create a known-budget fragment for insertion into context.

*Call graph*: called by 2 (maybe_record_token_budget_remaining_context, fragment).


##### `TokenBudgetRemainingContext::unknown`  (lines 56–58)

```
fn unknown() -> Self
```

**Purpose**: Creates a token-budget fragment for the case where the system does not know the remaining token count. This still lets the model know that the budget exists, even though the exact number is unavailable.

**Data flow**: It receives no token number. It stores an empty value to mean unknown. Later, that empty value becomes a sentence saying the remaining token count is unknown.

**Call relations**: The fragment-building path calls this when it needs a token-budget note but does not have a reliable count. It provides a safe fallback instead of inventing a number.

*Call graph*: called by 1 (fragment).


##### `TokenBudgetRemainingContext::role`  (lines 62–64)

```
fn role(&self) -> &'static str
```

**Purpose**: Says that this simpler token-budget fragment should be treated as a developer message. That gives the note instruction-like weight in the conversation.

**Data flow**: It does not inspect the token count. It always returns the fixed role name developer. It changes nothing.

**Call relations**: This is part of the ContextualUserFragment behavior. The context assembly code can call it when packaging the remaining-budget fragment for the model.


##### `TokenBudgetRemainingContext::markers`  (lines 66–68)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the wrapper tags for the simpler remaining-budget fragment. It uses the same <token_budget> block style as the full token-budget fragment.

**Data flow**: It reads no instance-specific data. It asks the type for its standard marker pair and returns those two strings. No state changes.

**Call relations**: This method is used when the fragment is being wrapped for insertion into the conversation. It delegates to TokenBudgetRemainingContext::type_markers so the marker format is defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `TokenBudgetRemainingContext::type_markers`  (lines 70–72)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the fixed opening and closing tags for a remaining-token-budget block. These tags identify the text as token-budget information.

**Data flow**: It takes no input and does not read object state. It returns the constant opening and closing marker strings. Nothing is changed.

**Call relations**: TokenBudgetRemainingContext::markers calls this to provide markers for a particular instance. Shared marker text keeps this fragment compatible with the full TokenBudgetContext format.


##### `TokenBudgetRemainingContext::body`  (lines 74–81)

```
fn body(&self) -> String
```

**Purpose**: Turns the remaining-token information into a sentence for the model. If the number is known, it states the count; if not, it clearly says the count is unknown.

**Data flow**: It checks whether the object contains a token count. With a known count, it formats that number into a sentence. With no count, it returns a fixed sentence saying the token amount is unknown. The output is a String, and the object is not modified.

**Call relations**: The context assembly code calls this through the ContextualUserFragment behavior when it needs the text inside the token-budget markers. It uses formatting only in the known-count case, because that is where a number must be inserted.

*Call graph*: 1 external calls (format!).


### `core/src/context/turn_aborted.rs`

`data_model` · `conversation context building after an interrupted turn`

When a user interrupts a turn, the next model response needs important context: the interruption was deliberate, and any command that was running might not have stopped cleanly. This file packages that warning into a reusable context fragment called `TurnAborted`.

Think of it like a sticky note placed into the conversation history: “The last step was cut short on purpose; be careful, because some background work may still be happening.” Without this note, the model might wrongly assume the previous turn finished normally, or might ignore the risk that a tool or command only partly completed.

The `TurnAborted` struct stores one piece of text, called `guidance`, which is the warning shown to the model. The file also provides two standard warning messages: one phrased for normal user-facing context and one phrased for developer-facing context.

By implementing `ContextualUserFragment`, this type knows how to present itself inside the larger prompt context. It says its role is `user`, wraps its content in `<turn_aborted>` tags, and formats the body with surrounding line breaks so it is easy to separate from nearby context.

#### Function details

##### `TurnAborted::new`  (lines 12–16)

```
fn new(guidance: impl Into<String>) -> Self
```

**Purpose**: Creates a new `TurnAborted` note from any text that can be turned into a string. Code uses this when it needs to record guidance about an interrupted previous turn.

**Data flow**: A guidance value comes in, such as one of the built-in warning messages. The function converts it into an owned string and stores it inside a new `TurnAborted` value. The result is a ready-to-insert context fragment.

**Call relations**: The interrupted-turn history code calls this when it needs to add an interruption marker to the conversation context. It relies on the standard string conversion step so callers can pass convenient text forms without doing the conversion themselves.

*Call graph*: called by 1 (interrupted_turn_history_marker); 1 external calls (into).


##### `TurnAborted::role`  (lines 20–22)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the context system that this fragment should be presented as coming from the `user` role. This matters because role labels affect how the model interprets a piece of conversation context.

**Data flow**: It reads no changing data from the `TurnAborted` value. It simply returns the fixed role name `user`.

**Call relations**: This is part of the `ContextualUserFragment` interface. When the broader context-building code asks a fragment how it should appear in the conversation, this method supplies the role label.


##### `TurnAborted::markers`  (lines 24–26)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing tags used to wrap this interruption warning. These tags make the fragment easy for the model and surrounding code to recognize as a special interruption notice.

**Data flow**: It does not use any per-instance data. It asks the type-level marker function for the fixed pair of tags and returns them.

**Call relations**: This method is used through the `ContextualUserFragment` interface when the context system needs to wrap the fragment body. It delegates to `TurnAborted::type_markers` so the tag definitions live in one place.

*Call graph*: 1 external calls (type_markers).


##### `TurnAborted::type_markers`  (lines 28–30)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact tags for this kind of context fragment: `<turn_aborted>` and `</turn_aborted>`. Keeping them here gives the rest of the code a single source of truth for the marker text.

**Data flow**: No input is needed. The function returns the fixed opening and closing marker strings.

**Call relations**: The instance-level `markers` method calls this when asked how to wrap a `TurnAborted` fragment. Other code can also use it when it needs the marker pair without having a specific fragment value.


##### `TurnAborted::body`  (lines 32–34)

```
fn body(&self) -> String
```

**Purpose**: Builds the text that appears inside the interruption tags. It contains the stored guidance message, padded with line breaks for readable separation in the final context.

**Data flow**: It reads the fragment’s `guidance` string. It formats that guidance with a newline before and after it, then returns the resulting string.

**Call relations**: This is another part of the `ContextualUserFragment` interface. After the broader context-building code has the role and markers, it asks for the body so it can assemble the complete tagged warning.

*Call graph*: 1 external calls (format!).


### `core/src/context/user_instructions.rs`

`data_model` · `context construction`

This file is a small but important bridge between raw instruction text and the larger conversation context sent to the model. A project may contain extra guidance, often tied to a directory, that tells the assistant how to behave for that part of the codebase. Without this file, those instructions would just be loose text, with no consistent label, boundaries, or formatting.

The main type is `UserInstructions`. It stores two pieces of information: the instruction text itself, and optionally the directory those instructions apply to. It then implements `ContextualUserFragment`, which is a shared interface for pieces of context that can be inserted into a conversation. In plain terms, this lets the rest of the system ask: “Who is speaking?”, “What markers identify this block?”, and “What should the final text look like?”

The markers are like a labeled folder tab: `# AGENTS.md instructions` says what kind of block this is, and `</INSTRUCTIONS>` marks where it ends. The body adds a short directory note when available, then wraps the actual instruction text inside an `<INSTRUCTIONS>` block. This makes the final prompt easier for both the system and the model to interpret.

#### Function details

##### `UserInstructions::role`  (lines 10–12)

```
fn role(&self) -> &'static str
```

**Purpose**: This function says that this instruction fragment should be treated as user-provided content. That matters because conversation systems often separate messages by role, such as user, assistant, or system.

**Data flow**: It reads no outside data and ignores the stored instruction text. It simply returns the fixed label `user`, which becomes the role attached to this context fragment.

**Call relations**: When the larger context-building code treats `UserInstructions` as a `ContextualUserFragment`, it calls this function to decide how to label the fragment in the conversation. This function does not hand work off to anything else.


##### `UserInstructions::markers`  (lines 14–16)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This function provides the start and end markers used to identify a block of AGENTS.md instructions. These markers help the surrounding prompt-building code keep this instruction block distinct from other context.

**Data flow**: It takes the current `UserInstructions` value, but does not need to inspect its fields. It asks the type-level marker function for the standard marker pair, then returns those two marker strings.

**Call relations**: The context-building flow calls this when it needs the boundaries for this fragment. Rather than duplicating the marker text, it delegates to `UserInstructions::type_markers`, so all instances use the same labels.

*Call graph*: 1 external calls (type_markers).


##### `UserInstructions::type_markers`  (lines 18–20)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This function defines the standard marker pair for all `UserInstructions` fragments. The opening marker names the block as AGENTS.md instructions, and the closing marker marks the end of the instruction section.

**Data flow**: It takes no instance data and reads no external state. It returns two fixed strings: one used as the identifying header and one used as the closing boundary.

**Call relations**: This is the shared source of truth for instruction markers. `UserInstructions::markers` calls it when an actual fragment needs to report its markers.


##### `UserInstructions::body`  (lines 22–29)

```
fn body(&self) -> String
```

**Purpose**: This function builds the actual text that will be inserted into the prompt for these user instructions. It includes the directory when one is known, then places the instruction text inside an `<INSTRUCTIONS>` block.

**Data flow**: It reads the optional `directory` and the required instruction `text` from the `UserInstructions` value. If a directory exists, it creates a phrase like ` for path/to/dir`; if not, it uses an empty prefix. It then formats a final string containing that directory note, a blank line, the opening `<INSTRUCTIONS>` tag, and the instruction text.

**Call relations**: The broader context-building code calls this when it is ready to turn the stored instruction data into prompt text. Inside, it uses Rust’s formatting machinery to assemble the final string, and it returns that string to be included in the conversation context.

*Call graph*: 1 external calls (format!).


### `core/src/context/user_shell_command.rs`

`data_model` · `cross-cutting context building`

This file is a small building block for recording “the user ran this command, and here is what happened.” That matters because command output can be useful context for later decisions, explanations, or model prompts. Without this file, different parts of the system might describe shell results in inconsistent ways, or forget important details like whether the command failed.

The main type is `UserShellCommand`. It keeps four pieces of information: the command text, the exit code, how long the command took, and the command’s output. The exit code is the number a program returns when it finishes; by convention, zero usually means success and non-zero usually means some kind of failure.

The file also makes `UserShellCommand` fit into the project’s `ContextualUserFragment` pattern. A fragment is a packaged piece of context. Here, the fragment says its role is `user`, wraps itself with special start and end markers, and produces a body containing clear sections for the command and the result. Think of it like putting a receipt in a labeled envelope: the system can later tell exactly what kind of information it is and where it begins and ends.

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

**Purpose**: Creates a new record of a shell command that was run. It collects the command text, exit code, elapsed time, and output into one reusable value.

**Data flow**: It receives a command, an exit code, a time duration, and output text. It converts the command and output into stored strings, converts the duration into seconds as a decimal number, and returns a filled-in `UserShellCommand`.

**Call relations**: This is called by `user_shell_command_fragment` when the system needs to turn a completed shell command into a context fragment. It relies on standard conversion helpers to store flexible text inputs as strings and to express the duration in seconds.

*Call graph*: called by 1 (user_shell_command_fragment); 2 external calls (as_secs_f64, into).


##### `UserShellCommand::role`  (lines 30–32)

```
fn role(&self) -> &'static str
```

**Purpose**: Identifies this fragment as coming from the user side of the conversation or context. This helps the surrounding context system label it correctly.

**Data flow**: It reads no changing data from the command record. It simply returns the fixed text `user`.

**Call relations**: The context system calls this through the `ContextualUserFragment` interface when it needs to know what role label to attach to this fragment.


##### `UserShellCommand::markers`  (lines 34–36)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing labels that surround this kind of context block. These markers make it clear where a shell-command fragment starts and ends.

**Data flow**: It takes the current command record only to satisfy the shared fragment interface. It then delegates to the type-level marker function and returns that pair of marker strings.

**Call relations**: The context system calls this when wrapping a specific `UserShellCommand` instance. Rather than duplicating the marker text, it hands off to `UserShellCommand::type_markers` so the marker definition stays in one place.

*Call graph*: 1 external calls (type_markers).


##### `UserShellCommand::type_markers`  (lines 38–40)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Provides the standard start and end tags for all user shell command fragments. These tags are `<user_shell_command>` and `</user_shell_command>`.

**Data flow**: It takes no instance data. It returns the two fixed marker strings used for this fragment type.

**Call relations**: This supports `UserShellCommand::markers`, and may also be used anywhere the system needs to know the shell-command markers without having an actual command record in hand.


##### `UserShellCommand::body`  (lines 42–47)

```
fn body(&self) -> String
```

**Purpose**: Builds the readable text that goes inside the shell-command fragment. It includes the command, exit code, run time, and output in a structured layout.

**Data flow**: It reads the stored command, exit code, duration in seconds, and output. It formats them into one string with separate `<command>` and `<result>` sections, then returns that string without changing the original record.

**Call relations**: The context system calls this through the `ContextualUserFragment` interface when it is assembling the final context text. It uses standard string formatting to produce the body that will be placed between the fragment markers.

*Call graph*: 1 external calls (format!).


### Realtime lifecycle fragments
These files define the standardized prompt fragments that open, customize, and close realtime interaction mode.

### `core/src/context/realtime_start_instructions.rs`

`domain_logic` · `startup / realtime conversation setup`

This file is one small part of the system that builds the text given to the model at the start of a realtime session. Think of it like a cover sheet added to a packet: it tells the model what kind of information follows, where that information begins and ends, and who it should treat the message as coming from.

The file defines `RealtimeStartInstructions`, a tiny marker type with no stored data of its own. Its job is to implement `ContextualUserFragment`, which is the shared interface for pieces of context that can be inserted into a conversation. Through that interface, this fragment says three things: its role is `developer`, its text should be wrapped in the realtime conversation open and close tags, and its body is the shared `START_INSTRUCTIONS` prompt text.

The trimming and newline wrapping in `body` are important because prompt formatting matters. Extra leading or trailing whitespace from the shared instruction constant is removed, then the text is placed on its own lines so it sits cleanly inside the conversation markers. Without this file, realtime conversations would lose a standardized instruction block that helps the model start with the right behavior and boundaries.

#### Function details

##### `RealtimeStartInstructions::role`  (lines 10–12)

```
fn role(&self) -> &'static str
```

**Purpose**: This tells the conversation builder that these start instructions should be treated as coming from the `developer` role. In plain terms, it labels the instructions as guidance from the application, not as ordinary user speech.

**Data flow**: Nothing meaningful comes in besides the fragment itself. The function returns the fixed text `developer`, which downstream prompt-building code can use when placing this fragment into the conversation.

**Call relations**: When the context system asks this fragment how it should be labeled, this method supplies the role. It does not call out to other project code; it simply provides the role needed before the fragment is added to the larger prompt.


##### `RealtimeStartInstructions::markers`  (lines 14–16)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This returns the opening and closing marker strings that should surround the realtime start instructions. These markers act like clear bookends, helping the rest of the system and the model recognize where this special conversation section begins and ends.

**Data flow**: The function receives the fragment object, then asks the type itself for its standard marker pair. It returns those two marker strings unchanged.

**Call relations**: When prompt assembly needs the markers for this specific fragment instance, it calls this method. This method delegates to `RealtimeStartInstructions::type_markers` so the marker choice is defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `RealtimeStartInstructions::type_markers`  (lines 18–23)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This provides the standard marker pair for all `RealtimeStartInstructions` fragments. It names the exact tags used to wrap a realtime conversation instruction block.

**Data flow**: No outside data is needed. The function returns a pair made from the protocol’s realtime conversation open tag and close tag constants.

**Call relations**: `RealtimeStartInstructions::markers` relies on this method when an actual fragment is being inserted into context. Keeping the marker pair here also lets callers ask for the markers at the type level, without needing a stored instance.


##### `RealtimeStartInstructions::body`  (lines 25–27)

```
fn body(&self) -> String
```

**Purpose**: This builds the actual instruction text that will be placed inside the realtime conversation markers. It uses the shared `START_INSTRUCTIONS` prompt and formats it neatly on its own lines.

**Data flow**: The function reads the shared `START_INSTRUCTIONS` text, removes extra whitespace from its ends, then wraps it with a leading and trailing newline. The result is a clean `String` ready to be inserted into the prompt.

**Call relations**: During prompt construction, the context system calls this method to get the content of the fragment. Internally it uses Rust’s formatting machinery to produce the final string, while the surrounding context code combines that body with the role and markers from the other methods.

*Call graph*: 1 external calls (format!).


### `core/src/context/realtime_start_with_instructions.rs`

`data_model` · `realtime conversation startup`

This file is like a labeled envelope for instructions that must be sent at the start of a realtime conversation. The system needs more than just the instruction text: it also needs to know who the text is from, where the realtime conversation section begins and ends, and how the text should be formatted when inserted into the larger conversation context.

The main type, `RealtimeStartWithInstructions`, stores one piece of text: the instructions. It implements `ContextualUserFragment`, which is a shared interface for pieces of context that can be added to a user-facing prompt or conversation. Through that interface, this fragment says its role is `developer`, meaning the instructions are treated as developer-level guidance rather than normal user chat.

It also provides opening and closing markers from the protocol constants. These markers act like clear signposts around the realtime conversation content, so later code can recognize the section reliably. Finally, it returns the instruction text as the body, padded with newlines so it sits cleanly inside the marked block.

Without this file, realtime startup instructions could still exist as plain text, but they would not be consistently labeled, wrapped, and formatted. That could make the receiving side misunderstand where the realtime conversation instructions begin or what authority level they should have.

#### Function details

##### `RealtimeStartWithInstructions::new`  (lines 11–15)

```
fn new(instructions: impl Into<String>) -> Self
```

**Purpose**: Creates a new realtime-start instruction fragment from any text-like input. Someone uses this when they have developer instructions that need to be packaged for the beginning of a realtime conversation.

**Data flow**: It receives instruction text, converts it into an owned `String`, and stores it inside a new `RealtimeStartWithInstructions` value. The result is a ready-to-use fragment that can later report its role, markers, and body text.

**Call relations**: This is called by `build_realtime_update_item` when that larger flow is preparing an update item for realtime use. After construction, the returned fragment can be treated as a `ContextualUserFragment` and asked for its formatted pieces.

*Call graph*: called by 1 (build_realtime_update_item); 1 external calls (into).


##### `RealtimeStartWithInstructions::role`  (lines 19–21)

```
fn role(&self) -> &'static str
```

**Purpose**: Identifies these instructions as coming from the `developer` role. This matters because developer instructions carry a different meaning from ordinary user messages.

**Data flow**: It reads no outside data and does not change the stored instructions. It simply returns the fixed role string `developer`.

**Call relations**: No direct caller is listed in the call graph, but this method is part of the `ContextualUserFragment` interface. When the context-building code treats this value as a fragment, this method tells that code how to label the fragment.


##### `RealtimeStartWithInstructions::markers`  (lines 23–25)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing marker strings that should wrap this fragment in the conversation context. These markers help the protocol recognize the realtime conversation block.

**Data flow**: It reads no instance-specific data. It asks `type_markers` for the marker pair and returns that pair unchanged.

**Call relations**: This method is the instance-level way to get the markers required by `ContextualUserFragment`. It delegates to `type_markers` so the marker definition lives in one place.

*Call graph*: 1 external calls (type_markers).


##### `RealtimeStartWithInstructions::type_markers`  (lines 27–32)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact marker pair used for this kind of fragment. The opening marker marks the start of realtime conversation content, and the closing marker marks its end.

**Data flow**: It reads the protocol constants for the realtime conversation open and close tags and returns them as a pair. It does not depend on any particular instruction text.

**Call relations**: This is called by `RealtimeStartWithInstructions::markers` to supply the marker pair. Keeping it as a type-level function lets the marker choice be reused without needing a constructed fragment.


##### `RealtimeStartWithInstructions::body`  (lines 34–36)

```
fn body(&self) -> String
```

**Purpose**: Produces the actual instruction text in the form that should be placed between the realtime markers. It adds surrounding newlines so the text is separated cleanly from the marker lines.

**Data flow**: It reads the stored instruction string, formats it with a newline before and after, and returns the resulting string. It does not modify the stored instructions.

**Call relations**: No direct caller is listed in the call graph, but this method is part of the `ContextualUserFragment` interface. When the larger context is assembled, this method provides the text that goes inside the marker pair.

*Call graph*: 1 external calls (format!).


### `core/src/context/realtime_end_instructions.rs`

`domain_logic` · `realtime conversation shutdown`

When a realtime conversation needs to be closed, the system cannot simply stop talking. It needs to give the model a clear final instruction, such as what closing behavior is expected and why the conversation is ending. This file provides that packaged instruction.

The main piece is `RealtimeEndInstructions`, which stores one bit of information: the reason the realtime session is ending. It then implements `ContextualUserFragment`, meaning it can be inserted into the conversation context as a specially marked block of text. Think of it like adding a labeled note to a shared folder: the label tells everyone what kind of note it is, and the body contains the actual message.

The fragment identifies itself as coming from the `developer` role, uses the realtime conversation open and close tags from the protocol, and builds a body from a shared `END_INSTRUCTIONS` prompt plus the specific reason. Without this file, realtime shutdown messages would either be missing, inconsistently formatted, or harder for the model and protocol layer to recognize reliably.

#### Function details

##### `RealtimeEndInstructions::new`  (lines 12–16)

```
fn new(reason: impl Into<String>) -> Self
```

**Purpose**: Creates a new realtime ending-instructions fragment with the given reason. This is used when another part of the system has decided a realtime conversation should be closed and wants to explain why.

**Data flow**: It receives a reason in any form that can become a `String` → converts that reason into owned text → returns a `RealtimeEndInstructions` value containing it. It does not change anything outside itself.

**Call relations**: When `build_realtime_update_item` needs to add closing guidance to a realtime update, it calls this constructor. The constructor prepares the stored reason so the later trait methods can turn it into a complete context fragment.

*Call graph*: called by 1 (build_realtime_update_item); 1 external calls (into).


##### `RealtimeEndInstructions::role`  (lines 20–22)

```
fn role(&self) -> &'static str
```

**Purpose**: Says which conversation role this fragment should appear under. It returns `developer`, meaning the instruction is treated as system-side guidance rather than as ordinary user text.

**Data flow**: It reads no changing data from the struct → chooses the fixed role label `developer` → returns that label as plain text.

**Call relations**: The context-building code calls this through the `ContextualUserFragment` interface when it needs to place the fragment into the conversation with the right role. This role works together with the markers and body to make the instruction understandable to the model.


##### `RealtimeEndInstructions::markers`  (lines 24–26)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the opening and closing markers that should wrap this fragment in the conversation context. These markers make the realtime closing block easy for the protocol and prompt machinery to recognize.

**Data flow**: It receives the fragment object but does not need to inspect its reason → asks the type-level marker function for the standard marker pair → returns the opening and closing tags.

**Call relations**: This is called through the `ContextualUserFragment` interface when the context is being assembled. It delegates to `RealtimeEndInstructions::type_markers` so both instance-level and type-level code use the same marker definitions.

*Call graph*: 1 external calls (type_markers).


##### `RealtimeEndInstructions::type_markers`  (lines 28–33)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Returns the standard protocol tags for realtime conversation blocks. This lets code know what tags belong to this fragment type even when it does not have a specific fragment instance.

**Data flow**: It takes no input → selects the realtime conversation open tag and close tag from the protocol constants → returns them as a pair.

**Call relations**: The `markers` method calls this to get the actual tags. Keeping the tag choice here gives the rest of the fragment formatting a single, consistent source for its boundaries.


##### `RealtimeEndInstructions::body`  (lines 35–37)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual text that will be inserted into the conversation. It combines the shared end-of-conversation instructions with the specific reason this realtime session is ending.

**Data flow**: It reads the stored reason from the fragment and the shared `END_INSTRUCTIONS` text → trims extra whitespace from the shared instructions and formats both pieces together → returns the finished prompt text. It does not modify the fragment.

**Call relations**: The context-building flow calls this through the `ContextualUserFragment` interface after the role and markers are known. Its output is the message placed between the realtime open and close tags so the model receives clear closing guidance.

*Call graph*: 1 external calls (format!).


### Notifications and legacy compatibility
These fragments cover live subagent status signaling and recognizers for older warning messages preserved for stored-session compatibility.

### `core/src/context/subagent_notification.rs`

`data_model` · `when building conversation context for subagent status updates`

When a system uses subagents, the main agent needs a reliable way to hear about them: which subagent is being talked about, and what its current status is. This file provides that wrapper. Think of it like a labeled note slipped into a larger stack of messages: the label says “this is a subagent notification,” and the note body says which agent it refers to and what happened.

The main type is `SubagentNotification`. It stores two pieces of information: an `agent_reference`, which is the path or name identifying the subagent, and an `AgentStatus`, which describes that subagent’s current state. The type also implements `ContextualUserFragment`, a shared interface for things that can be added to the model’s context as if they came from the user side of the conversation.

The implementation gives this fragment a fixed role of `user`, wraps it in special start and end markers, and writes its contents as JSON. Those markers matter because they help later readers, including the model, recognize that this is not ordinary user text. It is structured system context about a subagent.

#### Function details

##### `SubagentNotification::new`  (lines 12–17)

```
fn new(agent_reference: impl Into<String>, status: AgentStatus) -> Self
```

**Purpose**: Creates a new subagent notification from an agent reference and a status. It is the convenient entry point used when code needs to package a subagent status update for the conversation context.

**Data flow**: It receives something that can become a text string, plus an `AgentStatus`. It converts the agent reference into an owned string, stores it together with the status, and returns a ready-to-use `SubagentNotification` value.

**Call relations**: When `format_subagent_notification_message` needs to build a notification message, it calls this constructor first. This function does only the packaging step, so the later formatting code can work with one clear object instead of loose pieces of data.

*Call graph*: called by 1 (format_subagent_notification_message); 1 external calls (into).


##### `SubagentNotification::role`  (lines 21–23)

```
fn role(&self) -> &'static str
```

**Purpose**: Says what conversation role this fragment should use. Here it always reports `user`, meaning the notification is inserted into the context on the user side of the conversation.

**Data flow**: It reads no changing data from the notification. It simply returns the fixed text value `user`.

**Call relations**: This is called through the `ContextualUserFragment` interface when the broader context-building code needs to know how to label the fragment in the conversation.


##### `SubagentNotification::markers`  (lines 25–27)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the start and end tags that should wrap this notification in the context. These tags make the fragment easy to recognize as a subagent notification rather than normal conversation text.

**Data flow**: It takes the notification object, but does not need to inspect its fields. It asks `type_markers` for the shared marker pair and returns those two marker strings.

**Call relations**: This is used through the `ContextualUserFragment` interface when the context builder needs to surround the fragment body with the correct labels. It delegates to `type_markers` so instance-based and type-level code use the same marker text.

*Call graph*: 1 external calls (type_markers).


##### `SubagentNotification::type_markers`  (lines 29–31)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact text tags used to mark a subagent notification: an opening tag and a closing tag. This keeps the marker wording in one place.

**Data flow**: It takes no input and reads no object state. It returns the fixed pair `<subagent_notification>` and `</subagent_notification>`.

**Call relations**: The `markers` method calls this when an actual notification is being formatted. Other code can also use it when it needs the marker pair without having a notification object in hand.


##### `SubagentNotification::body`  (lines 33–41)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual content of the notification. It writes the subagent reference and status as JSON so the message is structured and less ambiguous than plain prose.

**Data flow**: It reads `agent_reference` and `status` from the notification. It places them into a JSON object using the keys `agent_path` and `status`, formats that object as text, adds surrounding newlines, and returns the resulting string.

**Call relations**: This is called through the `ContextualUserFragment` interface when the full context message is being assembled. The returned body is meant to sit between the marker strings supplied by `markers`.

*Call graph*: 1 external calls (format!).


### `core/src/context/legacy_apply_patch_exec_command_warning.rs`

`domain_logic` · `session history loading and context filtering`

This file is a compatibility shim for old session history. In earlier versions, the system could add a user-facing warning when someone tried to use `apply_patch` through an `exec_command` route. That warning is no longer produced, but old conversations may still have it saved. Without this file, the context system might treat that stale warning as ordinary user text instead of recognizing it as a known historical fragment.

The struct `LegacyApplyPatchExecCommandWarning` represents that old warning as a contextual user fragment. A contextual fragment is a piece of conversation context with a role, optional markers, matching rules, and a body. Here, the role is still `user`, but the body is empty because the system does not need to recreate the warning. The important part is `matches_text`: it trims the text and checks whether it has the old warning’s exact beginning and ending.

One slightly surprising detail is that this fragment has empty markers. That means it is not recognized by wrapper tags or delimiters, but by the actual warning text itself. Think of it like recognizing an old receipt by its printed wording rather than by a barcode.

#### Function details

##### `LegacyApplyPatchExecCommandWarning::role`  (lines 8–10)

```
fn role(&self) -> &'static str
```

**Purpose**: States that this legacy warning belongs to the `user` side of the conversation. This helps the context system classify the old message in the same role where it originally appeared.

**Data flow**: It takes the fragment object as input, reads no stored data from it, and returns the fixed text `user`. Nothing else is changed.

**Call relations**: When the context system treats this struct as a `ContextualUserFragment`, it asks for the role so the fragment can be placed in the right part of the conversation. This function simply answers that classification question.


##### `LegacyApplyPatchExecCommandWarning::markers`  (lines 12–14)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the marker pair used for this fragment type. In this legacy case, the markers are empty because the old warning is detected by its wording instead of by surrounding tags.

**Data flow**: It receives the fragment object, does not inspect any fields, and delegates to `type_markers` to get the marker pair. The result is passed back unchanged.

**Call relations**: This is the instance-level way for the context system to ask, “What markers identify this kind of fragment?” It hands that question to `LegacyApplyPatchExecCommandWarning::type_markers`, keeping the marker definition in one place.

*Call graph*: 1 external calls (type_markers).


##### `LegacyApplyPatchExecCommandWarning::type_markers`  (lines 16–18)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the marker pair for this legacy warning type. Both markers are empty, meaning there is no special start or end wrapper for this fragment.

**Data flow**: It takes no fragment data and returns a fixed pair of empty strings. It does not change anything.

**Call relations**: This is called by `LegacyApplyPatchExecCommandWarning::markers` when marker information is needed. It provides the shared marker definition for the type.


##### `LegacyApplyPatchExecCommandWarning::matches_text`  (lines 20–24)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Checks whether a piece of text is the old apply-patch warning. This is the key compatibility test that lets the system recognize and filter messages from older sessions.

**Data flow**: It receives some text, trims whitespace from the beginning and end, then checks two things: whether the text starts with the old warning prefix and whether it ends with the old instruction to use the apply_patch tool instead of exec_command. It returns `true` if both checks pass, otherwise `false`.

**Call relations**: When the context system scans stored conversation text and tries to identify known fragment types, this function is the test for this particular legacy warning. It does not call other project code; it performs the text check directly.


##### `LegacyApplyPatchExecCommandWarning::body`  (lines 26–28)

```
fn body(&self) -> String
```

**Purpose**: Returns the body text for this fragment when it is rendered or reconstructed. For this obsolete warning, the body is intentionally empty because the system no longer wants to produce the warning.

**Data flow**: It receives the fragment object, reads no stored data, creates a new empty string, and returns it. It does not modify anything.

**Call relations**: If the context system asks this fragment for displayable body text, this function supplies an empty result. It uses the standard string creation helper, but does not hand off to any project-specific logic.

*Call graph*: 1 external calls (new).


### `core/src/context/legacy_model_mismatch_warning.rs`

`domain_logic` · `session/context loading and filtering`

This file defines a tiny “marker” fragment for a warning that used to appear in user-facing context. The project no longer produces this warning, but old saved sessions may still contain it. Without this file, those old warning messages could be treated like normal user text when a conversation is reloaded, which could confuse later processing.

The struct `LegacyModelMismatchWarning` has no stored fields because it does not need to remember any details. Its main job is to answer questions required by the `ContextualUserFragment` trait. A trait is like a shared contract: anything that implements it promises to provide the same set of methods.

Most of the methods here say, in effect, “this fragment is empty now.” It reports the role as `user`, gives empty start and end markers, and returns an empty body. The one meaningful check is `matches_text`, which looks at a piece of text and decides whether it begins with the old high-risk cyber activity warning. That makes the file like a customs stamp reader for old paperwork: it does not create new stamps, but it can still recognize old ones so they do not get mistaken for current content.

#### Function details

##### `LegacyModelMismatchWarning::role`  (lines 8–10)

```
fn role(&self) -> &'static str
```

**Purpose**: This says that the legacy warning belongs to the `user` role in the context system. That matters because the surrounding context code groups fragments by who they appear to come from.

**Data flow**: It receives the warning fragment itself, reads no stored data, and returns the fixed text `user`. Nothing else is changed.

**Call relations**: When the context system treats this struct as a `ContextualUserFragment`, it can ask for the role and gets a stable answer that matches how this old warning appeared in saved conversations.


##### `LegacyModelMismatchWarning::markers`  (lines 12–14)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This returns the text markers used to identify this fragment type. For this legacy warning, there are no special marker strings, so it delegates to the shared marker definition.

**Data flow**: It receives the fragment, reads no stored data, calls `type_markers`, and returns the pair of marker strings from there. In this case, both strings are empty.

**Call relations**: This is the instance-level version of the marker lookup. It hands the work to `LegacyModelMismatchWarning::type_markers`, so callers that have an actual fragment value and callers that only need the type-level markers get the same answer.

*Call graph*: 1 external calls (type_markers).


##### `LegacyModelMismatchWarning::type_markers`  (lines 16–18)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This gives the marker strings for this fragment type without needing an actual fragment value. Here it returns empty strings because the old warning is recognized by its wording, not by wrapper markers.

**Data flow**: It takes no input from a fragment instance, performs no lookup, and returns a pair of empty strings. Nothing is stored or changed.

**Call relations**: The `markers` method calls this so both marker-related methods stay consistent. The broader context code can also use it when it needs to know how this kind of fragment is marked.


##### `LegacyModelMismatchWarning::matches_text`  (lines 20–24)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: This checks whether a piece of text is the old warning message. It is the key compatibility check that lets the system recognize and filter legacy session content.

**Data flow**: It receives a text string, trims whitespace from the beginning and end, and checks whether the remaining text starts with the old warning sentence about potentially high-risk cyber activity. It returns `true` for a match and `false` otherwise.

**Call relations**: When older conversation text is inspected as a possible contextual fragment, this method provides the yes-or-no test for this specific legacy warning. Unlike the empty marker methods, this is where the actual recognition happens.


##### `LegacyModelMismatchWarning::body`  (lines 26–28)

```
fn body(&self) -> String
```

**Purpose**: This returns the body text for the fragment. Because this warning is no longer produced, the body is deliberately empty.

**Data flow**: It receives the fragment, reads no stored data, creates a new empty `String`, and returns it. It does not change anything.

**Call relations**: If the context system asks this fragment to render its content, it gets an empty string. That supports the file’s purpose: recognize the old warning without reintroducing it into current context.

*Call graph*: 1 external calls (new).


### `core/src/context/legacy_unified_exec_process_limit_warning.rs`

`domain_logic` · `context filtering for old sessions`

This file is like a label maker kept around for old boxes in storage. The application does not produce this warning anymore, but older sessions may still contain it. If the program did not know how to recognize it, that outdated warning could be treated like fresh user content and accidentally sent along or shown in the wrong place.

The file defines `LegacyUnifiedExecProcessLimitWarning`, a tiny type that implements `ContextualUserFragment`. A contextual user fragment is a piece of text that the context system understands as belonging to the user side of a conversation. Here, the fragment has no real body and no visible start or end markers. Its main job is recognition: it checks whether some text begins with the old warning sentence, after trimming whitespace from the front and back.

The important behavior is that this is a compatibility shim. It exists for cleanup and filtering, not for producing new messages. When asked to provide its body, it returns an empty string, because new warning content should not be generated from it.

#### Function details

##### `LegacyUnifiedExecProcessLimitWarning::role`  (lines 8–10)

```
fn role(&self) -> &'static str
```

**Purpose**: This tells the context system that this old warning should be treated as a user-side fragment. That matters because context is usually grouped by speaker or role before it is filtered or sent onward.

**Data flow**: No outside data goes in. The function simply returns the fixed text `user`, which tells the rest of the system what role to assign to this fragment.

**Call relations**: When the context machinery works with this fragment through the shared `ContextualUserFragment` interface, it can ask for the role and receive the same user label every time.


##### `LegacyUnifiedExecProcessLimitWarning::markers`  (lines 12–14)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This returns the start and end marker strings used for this kind of fragment. For this legacy warning, both markers are empty because the old message is recognized by its text instead of by wrapper tags.

**Data flow**: No outside data goes in. The function asks the type-level marker function for the marker pair, then returns that pair unchanged.

**Call relations**: This is the instance-level way for the wider context system to ask, “How is this fragment marked?” It delegates to `LegacyUnifiedExecProcessLimitWarning::type_markers` so the marker definition lives in one place.

*Call graph*: 1 external calls (type_markers).


##### `LegacyUnifiedExecProcessLimitWarning::type_markers`  (lines 16–18)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This gives the marker pair for this legacy warning type. The empty strings mean there is no special prefix or suffix that wraps this fragment.

**Data flow**: No outside data goes in. The function returns a fixed pair of empty strings as the before-and-after markers.

**Call relations**: `LegacyUnifiedExecProcessLimitWarning::markers` calls this so callers using an actual fragment instance get the same marker information as callers using the type directly.


##### `LegacyUnifiedExecProcessLimitWarning::matches_text`  (lines 20–24)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: This checks whether a piece of text looks like the old unified exec process limit warning. It is the key filter that lets the system recognize stale warning messages from previous sessions.

**Data flow**: A text string goes in. The function trims whitespace from its edges, then checks whether the remaining text starts with the known old warning sentence. It returns `true` if it matches and `false` otherwise, without changing the text.

**Call relations**: The context filtering code can use this when scanning stored conversation text. If the text matches, the system knows it is dealing with this legacy warning fragment rather than ordinary user content.


##### `LegacyUnifiedExecProcessLimitWarning::body`  (lines 26–28)

```
fn body(&self) -> String
```

**Purpose**: This returns the content that should be emitted for this fragment. Since this warning is no longer produced, it deliberately returns an empty string.

**Data flow**: No outside data goes in. The function creates and returns a new empty string, so nothing is added to the conversation from this legacy fragment.

**Call relations**: When the context system asks this fragment for its body, it gets blank content. That fits the file’s purpose: recognize old warnings so they can be filtered, not recreate them.

*Call graph*: 1 external calls (new).
