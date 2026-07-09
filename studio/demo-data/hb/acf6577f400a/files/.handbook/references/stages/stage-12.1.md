# Prompt and context facade modules, fragments, and embedded instruction templates  `stage-12.1`

This stage is shared behind-the-scenes support for building what the model sees. It does not run the main work itself. Instead, it provides the shelves and labels for prompt text and context snippets, so later code can assemble them safely and in the right order.

The `codex-home` front door exposes the provider for user instructions, hiding the internal layout. `collaboration-mode-templates` bundles ready-made collaboration instructions into the program, like built-in note cards. The `prompts` front door collects prompt text, helper code for building prompts, and review-related types into one place.

The `context-fragments` files define and export the common shape of a context fragment: a small piece of information injected into the conversation. They also let the system recognize its own injected fragments later. The extension prompt contributor file gives add-ons a labeled way to contribute prompt text to specific prompt sections. Finally, the core context files re-export permission instructions and other context pieces from convenient locations, making them easy for the rest of the system to use.

## Files in this stage

### Embedded instruction sources
These crate roots expose the built-in instruction and prompt template sources that other parts of the system consume during prompt assembly.

### `codex-home/src/lib.rs`

`orchestration` · `compile-time library interface`

This is a small library entry file. Its job is to make one internal piece of the crate available to the outside world: `CodexHomeUserInstructionsProvider`. The actual code for that provider lives in the `instructions` module, which is brought into the library here with `mod instructions;`.

The second line, `pub use instructions::CodexHomeUserInstructionsProvider;`, is a public re-export. In plain terms, it is like putting a useful tool on the library’s front counter instead of making callers walk into the back room to find it. Other code can import `CodexHomeUserInstructionsProvider` directly from `codex-home`, without needing to know that it is defined inside an `instructions` module.

Without this file, or without the public re-export, the provider could still exist internally but would not be conveniently available as part of the crate’s public interface. This file does not contain the instruction-loading logic itself; it simply declares where that logic lives and chooses what part of it becomes public.


### `collaboration-mode-templates/src/lib.rs`

`data_model` · `compile time and wherever collaboration templates are selected`

This file solves a simple but important problem: the rest of the project needs reliable access to standard template text for different collaboration modes, such as planning, executing, or pair programming. Instead of asking the program to find these Markdown files on disk at runtime, this file embeds their contents into the compiled program. That means the templates travel with the application, like pages bound into a book rather than loose papers that might be misplaced.

It exposes four public constants: `PLAN`, `DEFAULT`, `EXECUTE`, and `PAIR_PROGRAMMING`. Each one is a string containing the full text of a matching Markdown template file from the `templates` directory. Other parts of the system can import these constants and use the template text immediately.

The key behavior is that `include_str!` reads the template files when the code is compiled, not when the program is running. If a template file is missing or has the wrong path, the build fails early. Without this file, callers would either need to duplicate template text in code or add runtime file-loading logic, which would be more fragile.


### `prompts/src/lib.rs`

`orchestration` · `cross-cutting`

This library is like a reception desk for all the instruction text the system gives to an AI model. The actual wording lives in separate files, grouped by topic: agent behavior, patch editing, summarization, permission guidance, real-time backend instructions, and review requests. This file does not create those prompts itself. Instead, it declares those topic files as internal modules, then re-exports the pieces other parts of the system are allowed to use.

That matters because prompts are part of the product’s behavior. If different parts of the code imported prompt text from many scattered places, it would be harder to know what is official and harder to change safely. By re-exporting selected items here, the project gets a single, stable public surface. Other code can ask this library for things like the backend prompt, patch-application instructions, summarization prompt, or review prompt without needing to know which internal file stores them.

A small but important detail is that some exports are plain constants, while others are functions or types. Constants provide fixed instruction text. Functions build prompt text that depends on the current situation, such as a changed objective or a review result. Types describe structured choices, such as permission instructions or resolved review requests.


### Fragment abstractions
This group defines the core fragment model and then exposes it as the public API for registering and rendering contextual prompt fragments.

### `context-fragments/src/fragment.rs`

`data_model` · `cross-cutting: used while building conversation context and while filtering or recognizing injected fragments`

This file is like a standard envelope format for extra context the system adds to a chat. Different parts of the program may need to insert reminders, environment details, policy updates, or other hidden-in-plain-sight context into the model conversation. Without a shared format, each kind of fragment would have to invent its own way to say what role it uses, what text it contains, and how to recognize it later.

The main trait, `ContextualUserFragment`, says every fragment must provide a role, a body of text, and optional start and end markers. Markers are small wrapper strings, like labels on a package, that make it possible to tell later, “this text was one of our injected fragments.” The default `render` method joins the start marker, body, and end marker into the exact text sent to the model. The conversion methods turn a fragment into protocol message objects used elsewhere in the system.

The second trait, `FragmentRegistration`, is a lighter, type-erased way to ask, “does this text look like this kind of fragment?” `FragmentRegistrationProxy<T>` connects that generic question to a real fragment type. The helper `matches_marked_text` performs the actual marker check, ignoring leading/trailing whitespace and letter case for the markers. If markers are missing, it deliberately refuses to match, so ordinary text is not accidentally treated as injected context.

#### Function details

##### `FragmentRegistrationProxy::new`  (lines 18–22)

```
fn new() -> Self
```

**Purpose**: Creates a registration proxy for a particular fragment type. The proxy carries no real data; it exists so code can ask whether some text matches that fragment type without constructing an actual fragment.

**Data flow**: Nothing meaningful goes in. The function returns a tiny marker object that remembers the fragment type at compile time, but stores no runtime payload.

**Call relations**: This is the basic constructor for the proxy. When code needs a default proxy, `FragmentRegistrationProxy::default` simply delegates to this function instead of building the object another way.


##### `FragmentRegistrationProxy::default`  (lines 26–28)

```
fn default() -> Self
```

**Purpose**: Provides the standard default value for a fragment registration proxy. This lets other code create the proxy using Rust’s normal default-value pattern.

**Data flow**: Nothing goes in. It calls the proxy constructor and returns the same empty, type-tagged registration object.

**Call relations**: This is a convenience wrapper around `FragmentRegistrationProxy::new`. It matters when generic setup code expects a type to know how to make its own default instance.

*Call graph*: 1 external calls (new).


##### `FragmentRegistrationProxy::matches_text`  (lines 32–34)

```
fn matches_text(&self, text: &str) -> bool
```

**Purpose**: Checks whether a piece of text looks like the fragment type represented by this proxy. It lets context filtering code identify injected fragments without building the full fragment object.

**Data flow**: It receives a text string. It passes that text to the fragment type’s own matching rule, then returns true or false depending on whether the text has that fragment’s markers.

**Call relations**: This is the bridge from the type-erased `FragmentRegistration` interface back to a concrete `ContextualUserFragment` type. Filtering code can hold registrations uniformly, and this method forwards the real decision to the fragment type.

*Call graph*: 1 external calls (matches_text).


##### `ContextualUserFragment::matches_text`  (lines 57–63)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Provides the default way for a fragment type to recognize text that it previously injected. It uses the type’s start and end markers as the identifying label.

**Data flow**: It receives text to inspect. It asks the fragment type for its markers, then sends those markers and the text to `matches_marked_text`. The result is a true-or-false answer.

**Call relations**: This is the default matching rule used by `FragmentRegistrationProxy::matches_text`. It hands off the low-level string checking to `matches_marked_text`, so each fragment type only needs to define its markers.

*Call graph*: calls 1 internal fn (matches_marked_text); 1 external calls (type_markers).


##### `ContextualUserFragment::render`  (lines 65–73)

```
fn render(&self) -> String
```

**Purpose**: Builds the exact text that will be placed into the conversation for this fragment. It wraps the body with markers when markers are present.

**Data flow**: It reads the fragment’s markers and body. If both markers are empty, it returns just the body. Otherwise, it returns one combined string: start marker, body, then end marker, with no extra spaces added.

**Call relations**: The conversion methods call this when they package a fragment into protocol message objects. Fragment implementations must include any needed whitespace in their body because this method intentionally does not insert separators.

*Call graph*: 1 external calls (format!).


##### `ContextualUserFragment::into`  (lines 75–88)

```
fn into(self) -> ResponseItem
```

**Purpose**: Turns a fragment into a full `ResponseItem` message, which is one of the protocol objects used to represent conversation history or model-facing messages. This is the common path for recording injected context as a message item.

**Data flow**: It takes ownership of the fragment. It reads the fragment’s role, renders its text, wraps that text as input text content, and returns a `ResponseItem::Message` with empty optional fields such as id, phase, and metadata.

**Call relations**: Many higher-level flows use this when they need to add a concrete context fragment to the conversation, such as environment updates, policy amendment records, image-related history messages, token budget reminders, and rollout sampling. This function is the packaging step that turns domain-specific context into the shared protocol shape.

*Call graph*: called by 11 (build_environment_update_item, append_guardian_followup_reminder, record_execpolicy_amendment_message, record_network_policy_amendment_message, handle_output_item_done_records_image_save_history_message, sample_rollout, maybe_record_token_budget_remaining_context, record_image_generation_instructions, interrupted_turn_history_marker, user_shell_command_record_item (+1 more)); 1 external calls (vec!).


##### `ContextualUserFragment::into_boxed_response_item`  (lines 90–100)

```
fn into_boxed_response_item(self: Box<Self>) -> ResponseItem
```

**Purpose**: Turns a boxed fragment into a full `ResponseItem` message. A boxed fragment is one stored behind a pointer-like wrapper, often used when code wants to work with different fragment types through the same interface.

**Data flow**: It takes ownership of the boxed fragment. It reads the role, renders the text, wraps the rendered text as input text content, and returns a `ResponseItem::Message` with the standard empty optional fields.

**Call relations**: This mirrors `ContextualUserFragment::into`, but works when the fragment is held as a boxed trait object rather than as a known concrete type. It lets more flexible orchestration code still produce the same protocol message format.

*Call graph*: 1 external calls (vec!).


##### `ContextualUserFragment::into_response_input_item`  (lines 102–113)

```
fn into_response_input_item(self) -> ResponseInputItem
```

**Purpose**: Turns a fragment into a `ResponseInputItem`, another protocol message shape used when preparing input for a response. It is for sending the fragment forward as input rather than storing it as a response-history item.

**Data flow**: It takes ownership of the fragment. It reads the role, renders the fragment text, wraps that text as input text content, and returns a `ResponseInputItem::Message` with no phase set.

**Call relations**: This is the sibling of the `ResponseItem` conversion methods. When a caller needs the input-message version of a contextual fragment, this method performs the same rendering and wrapping in the protocol type expected by that path.

*Call graph*: 1 external calls (vec!).


##### `matches_marked_text`  (lines 116–130)

```
fn matches_marked_text(start_marker: &str, end_marker: &str, text: &str) -> bool
```

**Purpose**: Checks whether a text string is wrapped in a given start marker and end marker. This is the shared safety check that prevents ordinary text from being mistaken for injected context.

**Data flow**: It receives a start marker, an end marker, and the text to inspect. If either marker is empty, it immediately returns false. Otherwise, it ignores extra whitespace at the outside, checks whether the text begins with the start marker and ends with the end marker, compares marker letters without caring about case, and returns true only if both checks pass.

**Call relations**: This is called by `ContextualUserFragment::matches_text`, which supplies the markers for a particular fragment type. Keeping the marker logic here means all fragment types follow the same recognition rules.

*Call graph*: called by 1 (matches_text).


### `context-fragments/src/lib.rs`

`other` · `cross-cutting`

This file does not contain the working logic itself. Instead, it acts like the index page of a small library. The real code lives in two internal modules: one for “additional context” fragments and one for more general user context fragments. This file declares those modules so they are part of the library, then re-exports the main types so outside code can use them without knowing the library’s internal file layout.

That matters because other parts of the project should not have to care whether `AdditionalContextUserFragment` comes from `additional_context.rs` or whether `FragmentRegistrationProxy` comes from `fragment.rs`. They can simply import these names from the crate itself. In everyday terms, this file is like a shop counter: the stock is stored in the back rooms, but customers interact with the clearly labeled items at the front.

Without this file, the crate would either expose nothing useful or force callers to reach into private module paths. That would make the code harder to read and more fragile if the internal layout changed later.


### Contributor-facing prompt pieces
These files define prompt fragment payloads for extension contributors and then surface shared fragment types through the core context namespace.

### `ext/extension-api/src/contributors/prompt.rs`

`data_model` · `prompt construction`

This file is a simple data model for prompt contributions. A prompt is not always one single lump of text; different pieces may need to go into different places, such as developer instructions, capability descriptions, or separate developer messages. The PromptSlot enum names those possible destinations, like labeled trays on a desk. The PromptFragment struct then pairs one of those labels with the actual text that should be shown to the model.

The main idea is safety and clarity. Instead of passing around plain strings and hoping everyone remembers where they should go, code can pass a PromptFragment that says both “here is the text” and “put it in this slot.” That matters because prompt placement can affect how a model interprets instructions.

The file also provides convenience constructors for common slots. For example, developer_policy creates a fragment already marked as developer policy, so callers do not have to mention the slot directly. The slot and text methods let later prompt-building code inspect the fragment without changing it. A comment notes that this is likely temporary and should eventually be replaced by an existing fragment implementation.

#### Function details

##### `PromptFragment::new`  (lines 19–24)

```
fn new(slot: PromptSlot, text: impl Into<String>) -> Self
```

**Purpose**: Creates a new prompt fragment from a destination slot and some text. This is the basic constructor used when the caller already knows exactly where the text should be placed.

**Data flow**: It takes a PromptSlot and text that can be turned into a String. It converts the text into owned stored text, pairs it with the slot, and returns a new PromptFragment. Nothing outside the new object is changed.

**Call relations**: This is the central builder for the type. The more specific helper functions, such as PromptFragment::developer_policy, PromptFragment::developer_capability, and PromptFragment::separate_developer, call it so they all create fragments in the same consistent way.

*Call graph*: 1 external calls (into).


##### `PromptFragment::developer_policy`  (lines 27–29)

```
fn developer_policy(text: impl Into<String>) -> Self
```

**Purpose**: Creates a prompt fragment meant for developer policy text. This gives callers a clear, readable way to mark text as policy-level developer guidance.

**Data flow**: It takes text from the caller, chooses the DeveloperPolicy slot for it, and passes both pieces to PromptFragment::new. The result is a PromptFragment whose text is stored and whose slot says it belongs in the developer policy area.

**Call relations**: This is a convenience wrapper around PromptFragment::new. Code that wants to contribute developer policy text can call this instead of manually selecting the PromptSlot::DeveloperPolicy value.

*Call graph*: 1 external calls (new).


##### `PromptFragment::developer_capability`  (lines 32–34)

```
fn developer_capability(text: impl Into<String>) -> Self
```

**Purpose**: Creates a prompt fragment that describes developer capabilities. This is useful when an extension needs to tell the model what tools, behaviors, or abilities are available in the developer context.

**Data flow**: It receives text, attaches the DeveloperCapabilities slot to it, and delegates the actual object creation to PromptFragment::new. It returns the completed PromptFragment.

**Call relations**: This function sits above PromptFragment::new as a named shortcut. It helps calling code express intent directly: the text is not just any prompt text, it belongs in the developer capabilities section.

*Call graph*: 1 external calls (new).


##### `PromptFragment::separate_developer`  (lines 37–39)

```
fn separate_developer(text: impl Into<String>) -> Self
```

**Purpose**: Creates a prompt fragment meant to become a separate top-level developer prompt. This is for developer text that should stay separate rather than being merged into another developer section.

**Data flow**: It takes caller-provided text, assigns it the SeparateDeveloper slot, and sends both to PromptFragment::new. The returned fragment carries both the chosen slot and the stored text.

**Call relations**: Like the other named constructors, it relies on PromptFragment::new for the actual creation work. It gives prompt-building callers a clear way to request a separate developer message.

*Call graph*: 1 external calls (new).


##### `PromptFragment::slot`  (lines 42–44)

```
fn slot(&self) -> PromptSlot
```

**Purpose**: Returns the slot label for this prompt fragment. Code uses this to find out where the fragment should be placed when building the final prompt.

**Data flow**: It reads the fragment's stored PromptSlot and returns a copy of it. The fragment itself is not changed.

**Call relations**: Later prompt assembly code can call this after receiving a PromptFragment to decide which part of the final prompt should receive the fragment's text.


##### `PromptFragment::text`  (lines 47–49)

```
fn text(&self) -> &str
```

**Purpose**: Returns the text stored inside this prompt fragment. This lets prompt assembly code read the model-visible content without taking ownership of it or modifying it.

**Data flow**: It reads the fragment's stored String and returns it as a string slice, which is a borrowed view of the text. The original PromptFragment keeps owning the text.

**Call relations**: After code has used PromptFragment::slot to decide where the fragment belongs, it can call PromptFragment::text to copy or insert the actual text into the final prompt.


### `core/src/context/permissions_instructions.rs`

`data_model` · `cross-cutting`

This file does not define new behavior of its own. Instead, it re-exports `PermissionsInstructions` from the `codex_prompts` package, meaning it takes a type defined elsewhere and makes it visible through this module too. In everyday terms, it is like putting a commonly needed form at the front desk instead of making everyone walk to the back office to find it.

`PermissionsInstructions` likely represents text or structured guidance about what actions are allowed, restricted, or need approval. By re-exporting it here, the core context code can treat permission instructions as part of its own public surface without copying or redefining the type. That matters because it keeps the project consistent: there is one real definition, but several parts of the code can refer to it through paths that make sense in their own area.

Without this file, callers that expect to find permission instructions under `core::context` would fail to compile, or they would need to know about the lower-level `codex_prompts` crate directly. This file keeps that dependency detail tucked away.


### `core/src/context/mod.rs`

`other` · `cross-cutting: used whenever model input context is assembled`

When this system talks to a model, it does not send only the user’s latest message. It may also need to include extra guidance: user instructions, permission rules, environment details, plugin information, token budget warnings, realtime session markers, and other reminders. Each of those pieces lives in its own file so it can stay focused and easy to change.

This file acts like the table of contents and service desk for that collection. It declares the submodules that make up the context system, then exposes selected types and helper functions from them. Some exports are public to the wider crate or outside users, while others are kept crate-private, meaning only this Rust package can use them. That boundary matters because context sent to a model can affect behavior, safety, permissions, and user experience.

Without this file, the rest of the project would need to know the exact location of every context fragment. Instead, other code can import these pieces from one central place. The file contains no business logic itself; its job is to keep the context system organized and present a clean, intentional surface to the rest of the codebase.
