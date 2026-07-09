# Prompt and context facade modules, fragments, and embedded instruction templates  `stage-12.1`

This stage is shared behind-the-scenes support for building the text the model sees before it answers. Think of it as the parts shelf and front desk for prompts: it stores built-in instruction text, defines the shapes of reusable context pieces, and gives the rest of the system simple entry points to fetch them.

The embedded instruction sources are `collaboration-mode-templates/src/lib.rs`, which keeps the built-in collaboration instructions as fixed strings inside the program, and `codex-home/src/lib.rs`, which exposes the main way to obtain home or user instruction content. `prompts/src/lib.rs` is the public doorway to the prompts crate, gathering prompt-related constants, types, and helpers in one place.

The context side is centered on `context-fragments/src/fragment.rs`, which defines what a “fragment” is: a small chunk of context that can be rendered into text and converted into the message format the model expects. `context-fragments/src/lib.rs` exposes that fragment system as a stable API. `ext/extension-api/src/contributors/prompt.rs` gives extensions a simple fragment type so they can add content to the right slot. Finally, `core/src/context/mod.rs` and `core/src/context/permissions_instructions.rs` re-export these shared pieces so core prompt assembly can use them consistently.

## Files in this stage

### Embedded instruction sources
These crate roots expose the built-in instruction and prompt template sources that other parts of the system consume during prompt assembly.

### `codex-home/src/lib.rs`

`orchestration` · `startup`

This crate root is a minimal facade around the `instructions` module. It keeps the implementation details of instruction lookup or assembly private and re-exports only `CodexHomeUserInstructionsProvider`, which is the type other crates are expected to depend on. The structure suggests that the crate's responsibility is narrowly scoped: supplying home-directory or user-specific instruction content through a dedicated provider object, while hiding any filesystem paths, parsing rules, or fallback behavior inside the private module. Because there is no additional logic here, the file's main value is API shaping. It establishes a stable top-level import path for the provider and prevents consumers from coupling themselves to internal helper modules that may change over time.


### `collaboration-mode-templates/src/lib.rs`

`data_model` · `startup and prompt construction`

This file is intentionally minimal: it defines four public `&'static str` constants, each populated with `include_str!` from a markdown file under `../templates/`. Because `include_str!` runs at compile time, the template contents become part of the compiled artifact rather than being loaded from disk at runtime. That design removes file I/O, avoids deployment-time path issues, and guarantees that the prompt text version always matches the crate version that was built.

The exported constants correspond to distinct collaboration modes: `PLAN`, `DEFAULT`, `EXECUTE`, and `PAIR_PROGRAMMING`. The file contains no parsing, validation, or selection logic; its role is purely to expose raw template text for higher-level prompt assembly code elsewhere. The main invariant is that the referenced template files must exist at build time and contain valid UTF-8, otherwise compilation fails. In practice, this crate acts as a stable asset bundle: downstream code can depend on these names without needing to know where the markdown lives on disk or how it is packaged.


### `prompts/src/lib.rs`

`orchestration` · `cross-cutting; used whenever prompts are imported`

This is the crate root for `prompts`, and its main job is namespace curation. It declares eight internal modules: `agents`, `apply_patch`, `compact`, `goals`, `permissions_instructions`, `realtime`, `review_exit`, and `review_request`. It then selectively re-exports their public items so downstream code can import prompt assets and prompt-related helpers directly from `prompts` instead of navigating submodules. The exported surface spans several categories: static prompt strings (`HIERARCHICAL_AGENTS_MESSAGE`, `APPLY_PATCH_TOOL_INSTRUCTIONS`, `SUMMARIZATION_PROMPT`, `SUMMARY_PREFIX`, `BACKEND_PROMPT`, `START_INSTRUCTIONS`, `END_INSTRUCTIONS`, `REVIEW_PROMPT`), goal-oriented prompt constructors (`budget_limit_prompt`, `continuation_prompt`, `objective_updated_prompt`), a configuration-like type (`PermissionsInstructions`), review-exit renderers, and review-request parsing/rendering helpers (`ResolvedReviewRequest`, `resolve_review_request`, `review_prompt`, `user_facing_hint`). There is no runtime control flow in this file, but it defines the crate's external contract: which prompt resources are considered stable and how consumers are expected to access them. In practice, this file is the central index that turns a set of template-specific modules into a coherent prompt library.


### Fragment abstractions
This group defines the core fragment model and then exposes it as the public API for registering and rendering contextual prompt fragments.

### `context-fragments/src/fragment.rs`

`domain_logic` · `cross-cutting during context rendering and fragment recognition`

This file provides the generic machinery behind contextual fragments injected into model conversations. `FragmentRegistration` is a small type-erased trait used by filtering code that only needs to ask whether some text matches a fragment shape. `FragmentRegistrationProxy<T>` adapts any `T: ContextualUserFragment` into that registration interface using `PhantomData`, with a `const fn new()` and `Default` implementation for easy static construction.

The main trait, `ContextualUserFragment`, defines the fragment contract: each implementation supplies a response `role`, marker pair, body text, and static marker metadata. The default `matches_text` implementation delegates to `matches_marked_text`, which performs case-insensitive start/end marker checks after trimming leading and trailing whitespace. This default intentionally refuses to match when either marker is empty, preventing unmarked fragments from claiming arbitrary text.

`render()` concatenates start marker, body, and end marker with no separators; if both markers are empty it returns only the body. The trait also includes three conversion helpers that package the rendered fragment into protocol types: `ResponseItem`, boxed `ResponseItem`, and `ResponseInputItem`, each as a message containing a single `ContentItem::InputText`. These helpers consistently set `id` and `phase` to `None`, and `metadata` to `None` where that field exists.

Overall, this file is the reusable substrate that concrete fragment modules build on for recognition and serialization.

#### Function details

##### `FragmentRegistrationProxy::new`  (lines 18–22)

```
fn new() -> Self
```

**Purpose**: Constructs a zero-sized registration proxy for a concrete fragment type.

**Data flow**: Creates and returns `FragmentRegistrationProxy<T>` with its `_marker` field set to `PhantomData` and no runtime state.

**Call relations**: Callers use it when they need a `FragmentRegistration` implementation without instantiating the underlying fragment payload type.


##### `FragmentRegistrationProxy::default`  (lines 26–28)

```
fn default() -> Self
```

**Purpose**: Provides the default constructor for a fragment registration proxy.

**Data flow**: Reads no state, calls `Self::new()`, and returns the resulting proxy.

**Call relations**: It exists so registration proxies can be created through generic default-based APIs.

*Call graph*: 1 external calls (new).


##### `FragmentRegistrationProxy::matches_text`  (lines 32–34)

```
fn matches_text(&self, text: &str) -> bool
```

**Purpose**: Delegates text matching to the concrete fragment type’s static matcher.

**Data flow**: Accepts `&self` and `text: &str`, calls `T::matches_text(text)`, and returns that boolean result.

**Call relations**: This is the bridge from type-erased `FragmentRegistration` back to the concrete `ContextualUserFragment` implementation.

*Call graph*: 1 external calls (matches_text).


##### `ContextualUserFragment::matches_text`  (lines 57–63)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Provides the default marker-based recognition logic for fragment types with fixed start and end markers.

**Data flow**: Calls `Self::type_markers()` to obtain the static marker pair, passes them with `text` into `matches_marked_text`, and returns the boolean result.

**Call relations**: Concrete fragment types inherit this behavior unless they override it, as dynamic-tag fragments do.

*Call graph*: calls 1 internal fn (matches_marked_text); 1 external calls (type_markers).


##### `ContextualUserFragment::render`  (lines 65–73)

```
fn render(&self) -> String
```

**Purpose**: Renders a fragment into the exact text inserted into a message.

**Data flow**: Reads `self.markers()` and `self.body()`. If both markers are empty it returns the body unchanged; otherwise it formats and returns `{start_marker}{body}{end_marker}`.

**Call relations**: All conversion helpers rely on this method so every protocol representation uses the same textual rendering.

*Call graph*: 1 external calls (format!).


##### `ContextualUserFragment::into`  (lines 75–88)

```
fn into(self) -> ResponseItem
```

**Purpose**: Converts a concrete fragment into a `ResponseItem::Message` containing one input-text content item.

**Data flow**: Consumes `self`, reads `self.role()` and `self.render()`, constructs `ResponseItem::Message { id: None, role, content: vec![ContentItem::InputText { text }], phase: None, metadata: None }`, and returns it.

**Call relations**: Many message-building paths call this helper when appending contextual fragments to response histories or instruction streams.

*Call graph*: called by 11 (build_environment_update_item, append_guardian_followup_reminder, record_execpolicy_amendment_message, record_network_policy_amendment_message, handle_output_item_done_records_image_save_history_message, sample_rollout, maybe_record_token_budget_remaining_context, record_image_generation_instructions, interrupted_turn_history_marker, user_shell_command_record_item (+1 more)); 1 external calls (vec!).


##### `ContextualUserFragment::into_boxed_response_item`  (lines 90–100)

```
fn into_boxed_response_item(self: Box<Self>) -> ResponseItem
```

**Purpose**: Converts a boxed trait object fragment into a `ResponseItem::Message` without requiring the concrete type.

**Data flow**: Consumes `self: Box<Self>`, reads `self.role()` and `self.render()`, and returns the same `ResponseItem::Message` shape as `into`, with `id`, `phase`, and `metadata` unset.

**Call relations**: This supports dynamic dispatch scenarios where fragments are stored behind `Box<dyn ContextualUserFragment>`.

*Call graph*: 1 external calls (vec!).


##### `ContextualUserFragment::into_response_input_item`  (lines 102–113)

```
fn into_response_input_item(self) -> ResponseInputItem
```

**Purpose**: Converts a concrete fragment into the input-side protocol message type.

**Data flow**: Consumes `self`, reads `self.role()` and `self.render()`, constructs `ResponseInputItem::Message { role, content: vec![ContentItem::InputText { text }], phase: None }`, and returns it.

**Call relations**: It is used when the caller needs request/input items rather than response-history items.

*Call graph*: 1 external calls (vec!).


##### `matches_marked_text`  (lines 116–130)

```
fn matches_marked_text(start_marker: &str, end_marker: &str, text: &str) -> bool
```

**Purpose**: Checks whether text begins and ends with the given markers, ignoring ASCII case and surrounding whitespace.

**Data flow**: Accepts `start_marker`, `end_marker`, and `text`. If either marker is empty it returns false immediately. Otherwise it trims leading whitespace, checks whether the prefix of matching length equals `start_marker` case-insensitively, trims trailing whitespace, checks whether the suffix of matching length equals `end_marker` case-insensitively using `saturating_sub` for safety, and returns true only if both checks succeed.

**Call relations**: It is the shared implementation behind the trait’s default `matches_text` method.

*Call graph*: called by 1 (matches_text).


### `context-fragments/src/lib.rs`

`data_model` · `prompt/context assembly`

This crate root declares two internal modules, `additional_context` and `fragment`, then re-exports the fragment-related types that downstream code uses. The exported surface distinguishes between concrete additional-context fragment types—`AdditionalContextDeveloperFragment` and `AdditionalContextUserFragment`—and the more general registration and proxy abstractions—`ContextualUserFragment`, `FragmentRegistration`, and `FragmentRegistrationProxy`.

The file itself contains no behavior, but its organization reveals the subsystem's shape. One part of the crate defines specific fragment payloads intended for developer- or user-supplied context, while another defines the registration machinery that lets those fragments be discovered, wrapped, or passed across boundaries. By concentrating exports here, the crate can evolve its internal module layout without forcing callers to update imports. This root therefore serves as the contract for prompt-context extension points: code that assembles prompts or contextual instructions depends on these re-exported types rather than on the internal module structure.


### Contributor-facing prompt pieces
These files define prompt fragment payloads for extension contributors and then surface shared fragment types through the core context namespace.

### `ext/extension-api/src/contributors/prompt.rs`

`data_model` · `request handling`

This file is a compact prompt data model. `PromptSlot` is an enum describing where a fragment belongs in prompt assembly: `DeveloperPolicy`, `DeveloperCapabilities`, `ContextualUser`, or `SeparateDeveloper`. `PromptFragment` then pairs one of those slots with the fragment’s model-visible `String` text.

The implementation is intentionally minimal and value-oriented. `PromptFragment::new` is the canonical constructor, accepting any `Into<String>` so callers can pass `String`, `&str`, or other string-like values without manual conversion. Three convenience constructors—`developer_policy`, `developer_capability`, and `separate_developer`—hard-code the corresponding `PromptSlot` variants and delegate to `new`, reducing repetitive call sites in contributors and tests. The remaining methods are simple accessors returning the stored slot and text.

The derives (`Clone`, `Debug`, `PartialEq`, `Eq` on `PromptFragment`; plus `Copy`, `Hash` on `PromptSlot`) make these types easy to compare in tests, duplicate during prompt assembly, and use as keys or grouping markers. There is no validation or formatting logic here: the file’s responsibility is only to preserve the caller’s chosen slot and exact text. That simplicity is important because ordering, merging, and rendering semantics live elsewhere in the extension system.

#### Function details

##### `PromptFragment::new`  (lines 19–24)

```
fn new(slot: PromptSlot, text: impl Into<String>) -> Self
```

**Purpose**: Creates a prompt fragment with an explicit target slot and caller-supplied text. It is the base constructor used by the specialized helpers.

**Data flow**: It takes `slot: PromptSlot` and `text: impl Into<String>`, converts `text` with `into()`, and returns a `PromptFragment { slot, text }`. It reads no external state and writes no side effects.

**Call relations**: Callers use this when they need full control over the destination slot. The convenience constructors in the same impl delegate to it so all fragment creation follows one path.

*Call graph*: 1 external calls (into).


##### `PromptFragment::developer_policy`  (lines 27–29)

```
fn developer_policy(text: impl Into<String>) -> Self
```

**Purpose**: Builds a fragment targeted at the `DeveloperPolicy` slot. It is a shorthand for the most common policy-style prompt contribution.

**Data flow**: It accepts `text: impl Into<String>`, passes `PromptSlot::DeveloperPolicy` and the text into `PromptFragment::new`, and returns the resulting fragment. No state is read or mutated.

**Call relations**: Prompt contributors and tests call this helper instead of spelling out the slot manually. It delegates directly to `new` to centralize fragment construction.

*Call graph*: 1 external calls (new).


##### `PromptFragment::developer_capability`  (lines 32–34)

```
fn developer_capability(text: impl Into<String>) -> Self
```

**Purpose**: Builds a fragment targeted at the `DeveloperCapabilities` slot. It is a convenience wrapper for capability-description prompt text.

**Data flow**: It takes `text: impl Into<String>`, forwards it with `PromptSlot::DeveloperCapabilities` to `PromptFragment::new`, and returns the constructed fragment. It has no side effects.

**Call relations**: Used by contributors that want to advertise capabilities in a dedicated prompt section. Like the other helpers, it delegates all actual construction to `new`.

*Call graph*: 1 external calls (new).


##### `PromptFragment::separate_developer`  (lines 37–39)

```
fn separate_developer(text: impl Into<String>) -> Self
```

**Purpose**: Builds a fragment targeted at the `SeparateDeveloper` slot. It supports prompt assembly strategies that emit a distinct top-level developer message.

**Data flow**: It accepts `text: impl Into<String>`, calls `PromptFragment::new(PromptSlot::SeparateDeveloper, text)`, and returns the resulting value. No external state is touched.

**Call relations**: This helper is used when contributors need a separate developer prompt rather than an inlined policy/capabilities fragment. It delegates directly to `new`.

*Call graph*: 1 external calls (new).


##### `PromptFragment::slot`  (lines 42–44)

```
fn slot(&self) -> PromptSlot
```

**Purpose**: Returns the fragment’s target prompt slot. It is the read accessor prompt assembly code uses to group or route fragments.

**Data flow**: It takes `&self` and returns the stored `PromptSlot` by value. Because `PromptSlot` is `Copy`, no borrowing complications or allocation are involved.

**Call relations**: Prompt assembly and tests call this accessor when inspecting fragments after contribution. It is a leaf accessor with no delegated work.


##### `PromptFragment::text`  (lines 47–49)

```
fn text(&self) -> &str
```

**Purpose**: Returns the fragment’s model-visible text as a string slice. It exposes the exact stored content without copying.

**Data flow**: It takes `&self` and returns `&str` referencing `self.text`. No transformation or mutation occurs.

**Call relations**: Rendering and test code use this accessor to inspect fragment contents after creation or collection. It is a simple leaf method.


### `core/src/context/permissions_instructions.rs`

`orchestration` · `request handling`

This file consists solely of `pub use codex_prompts::PermissionsInstructions;`, making the `PermissionsInstructions` type from the prompt library available under the core context module tree. The absence of wrappers means the type's semantics, constructors, formatting behavior, and any trait implementations all remain owned by `codex_prompts`; this module only establishes a stable location from which the rest of codex-core can import permission-related instructions alongside other context fragments. That keeps prompt-fragment discovery centralized in `core/src/context/mod.rs` even when the actual implementation lives in another crate. The design avoids duplication and preserves a clean separation between prompt text/templates and the orchestration code that decides when to inject them.


### `core/src/context/mod.rs`

`orchestration` · `request handling`

This module is the namespace root for the system that builds model-visible context. It declares a large set of sibling modules, each representing one concrete fragment or instruction source: saved approvals and network rules, app/plugin/skill availability instructions, collaboration and realtime markers, environment and token-budget context, user instructions, shell-command echoes, legacy compatibility warnings, internal model context, and several hook- or agent-related messages. The file itself contains no executable logic; instead, it defines the composition boundary for the prompt-building subsystem by selectively re-exporting types from those local modules and from external crates such as `codex_context_fragments`, `codex_core_skills`, and `codex_prompts`. The visibility choices are meaningful: some exports are `pub` because downstream crates or broader APIs consume them directly, while many are `pub(crate)` to keep fragment construction internal to codex-core. It also exposes helper functions from `contextual_user_message` for recognizing and parsing contextual user fragments, which suggests that some incoming messages are dynamically interpreted into fragment objects. Overall, this file is the registry-like leaf that tells readers which context fragment implementations exist and which names form the supported interface for prompt assembly.
