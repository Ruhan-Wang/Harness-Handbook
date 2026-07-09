# Instruction, skill, plugin, memory, and review prompt contributors  `stage-12.3`

This stage is cross-cutting prompt infrastructure: it assembles the model-visible instructions that shape behavior before and during each turn. It pulls guidance from user and project configuration, runtime mode, installed extensions, and workflow state, then exposes those pieces as prompt fragments or injected response items.

At the base, codex-home/src/instructions/mod.rs loads global user instructions, while core/src/agents_md.rs discovers project files like AGENTS.md, truncates them safely, and tracks provenance. Context fragments in core/src/context add situational guidance: collaboration mode, personality, raw plugin text, image-generation rules, available skills, apps/connectors, and available plugins. tui/src/terminal_visualization_instructions.rs and tui/src/ide_context/prompt.rs contribute terminal-specific formatting advice and IDE context text.

Skills are selected, injected, and rendered through ext/skills, core-skills, and core/src/skills.rs, which bridge metadata, mention detection, prompt budgeting, and telemetry. Plugin and app instruction renderers describe capabilities and inject extra hints for explicitly mentioned plugins. prompts/src/permissions_instructions.rs explains the active sandbox and approval model. Memory and goal modules contribute persistent context and steering prompts, while prompts/src/review_request.rs and review_exit.rs generate the specialized prompts used to enter and leave review flows.

## Files in this stage

### Project and user instruction sources
These files load baseline instruction text from user and project sources and wrap optional developer-style overlays into prompt fragments.

### `codex-home/src/instructions/mod.rs`

`config` · `startup and prompt-context loading`

This module implements a concrete `UserInstructionsProvider` backed by files in a configured Codex home directory. The provider stores an `AbsolutePathBuf` root and looks for two specific filenames in priority order: `AGENTS.override.md` first, then `AGENTS.md`. That ordering is significant: the override file shadows the default file whenever it exists and contains non-whitespace content.

The main logic lives in `load_from_codex_home`, an async method that accumulates warnings while probing candidate files. For each candidate, it joins the filename onto `codex_home`, checks metadata asynchronously, and skips paths that do not exist or are not regular files. Metadata errors other than `NotFound` are converted into warning strings that include the concrete path. If the path is a file, the method reads its bytes asynchronously; again, `NotFound` is treated as a benign race and other read failures become warnings. The bytes are decoded with `String::from_utf8_lossy`, trimmed, and only non-empty content is returned as `LoadedUserInstructions { instructions: Some(UserInstructions { text, source }), warnings }`. Empty or whitespace-only files are ignored and the search continues. If no usable file is found, the method returns `instructions: None` together with any accumulated warnings. The trait implementation simply boxes this future for the extension API.

#### Function details

##### `CodexHomeUserInstructionsProvider::new`  (lines 20–22)

```
fn new(codex_home: AbsolutePathBuf) -> Self
```

**Purpose**: Constructs a provider rooted at a specific absolute Codex home directory.

**Data flow**: Takes an `AbsolutePathBuf`, stores it in the `codex_home` field, and returns `CodexHomeUserInstructionsProvider` by value.

**Call relations**: Called by application startup and prompt-building code before any instruction loading occurs.

*Call graph*: called by 7 (run_debug_prompt_input_command, provider, loads_user_instructions_without_a_primary_environment, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, build_prompt_input_includes_context_and_user_message, new, run_main).


##### `CodexHomeUserInstructionsProvider::load_from_codex_home`  (lines 24–67)

```
async fn load_from_codex_home(&self) -> LoadedUserInstructions
```

**Purpose**: Searches the Codex home directory for override/default instruction files, returning the first non-empty one plus any warnings encountered while probing.

**Data flow**: Reads `self.codex_home`, iterates over `AGENTS.override.md` then `AGENTS.md`, joins each candidate path, awaits `tokio::fs::metadata`, and skips missing or non-file entries. For metadata/read errors other than `NotFound`, it appends formatted warning strings. When file bytes are successfully read, it decodes them lossily as UTF-8, trims whitespace, and if non-empty returns `LoadedUserInstructions` containing `UserInstructions { text: trimmed.to_string(), source: path }` and the accumulated warnings. If no candidate yields non-empty content, it returns `LoadedUserInstructions { instructions: None, warnings }`.

**Call relations**: This is the actual loading implementation behind the trait method. `load_user_instructions` boxes and exposes this future to callers.

*Call graph*: calls 1 internal fn (join); called by 1 (load_user_instructions); 5 external calls (from_utf8_lossy, new, format!, metadata, read).


##### `CodexHomeUserInstructionsProvider::load_user_instructions`  (lines 71–73)

```
fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_>
```

**Purpose**: Adapts the async home-directory loader to the trait’s boxed-future interface.

**Data flow**: Borrows `self`, creates the future from `self.load_from_codex_home()`, boxes it with `Box::pin`, and returns `LoadUserInstructionsFuture<'_>`.

**Call relations**: This is the trait entrypoint invoked by extension consumers whenever user instructions need to be loaded.

*Call graph*: calls 1 internal fn (load_from_codex_home); 1 external calls (pin).


### `core/src/agents_md.rs`

`domain_logic` · `turn setup and prompt assembly`

This module implements hierarchical project-document discovery and rendering. `load_project_instructions` starts from optional host `UserInstructions`, iterates every bound turn environment, converts each environment cwd to an `AbsolutePathBuf`, and calls `read_agents_md` against that environment’s filesystem. Errors are logged per environment and do not abort loading from others. If the `ChildAgentsMd` feature is enabled, it appends one internal `InstructionEntry` containing `HIERARCHICAL_AGENTS_MESSAGE`. The result is returned only when at least one non-empty instruction source exists.

`read_agents_md` enforces the per-environment byte budget from `config.project_doc_max_bytes`, asks `agents_md_paths` for candidate files from project root to cwd, verifies each candidate is a regular file, reads bytes through `ExecutorFileSystem`, truncates later files when the remaining budget is exhausted, decodes with `String::from_utf8_lossy`, and records each non-empty document as a project `InstructionEntry` with exact source path, environment id, and cwd provenance. Discovery itself merges non-project config layers to compute `project_root_markers`, intentionally ignoring project-layer overrides so a project cannot redefine its own root markers during AGENTS lookup. It then walks ancestors until a marker is found, searches only from that root down to cwd, and prefers `AGENTS.override.md`, then `AGENTS.md`, then deduplicated configured fallback filenames.

The `LoadedAgentsMd` type stores optional host instructions plus ordered entries and can render them in two layouts: a legacy single-environment form using `AGENTS_MD_SEPARATOR`, or a multi-environment labeled form that groups entries by contributing environment. It also exposes source iteration and provenance-aware helpers such as `single_project_cwd` and `has_multiple_project_environments`.

#### Function details

##### `load_project_instructions`  (lines 48–88)

```
async fn load_project_instructions(
    config: &Config,
    user_instructions: Option<UserInstructions>,
    environments: &TurnEnvironmentSnapshot,
) -> Option<LoadedAgentsMd>
```

**Purpose**: Loads project-scoped instruction documents for all selected turn environments and merges them with optional host-provided user instructions. It also appends internal child-agent guidance when that feature is enabled.

**Data flow**: Takes `&Config`, `Option<UserInstructions>`, and `&TurnEnvironmentSnapshot`. It initializes `LoadedAgentsMd` from the user instructions, iterates `environments.turn_environments`, obtains each environment filesystem and absolute cwd, awaits `read_agents_md`, extends `loaded.entries` with any discovered entries, logs errors with `tracing::error!`, optionally pushes an internal `InstructionEntry` for `HIERARCHICAL_AGENTS_MESSAGE`, and returns `Some(loaded)` only if `loaded` is non-empty.

**Call relations**: Prompt-building code calls this during turn setup. It delegates per-environment discovery and reading to `read_agents_md` and uses `LoadedAgentsMd::from_user_instructions` to seed the result.

*Call graph*: calls 2 internal fn (from_user_instructions, read_agents_md); 1 external calls (error!).


##### `read_agents_md`  (lines 96–166)

```
async fn read_agents_md(
    config: &Config,
    fs: &dyn ExecutorFileSystem,
    environment_id: &str,
    cwd: &AbsolutePathBuf,
) -> io::Result<Option<LoadedAgentsMd>>
```

**Purpose**: Discovers and reads AGENTS-style project docs for one environment, enforcing the configured byte budget and preserving provenance for each loaded file.

**Data flow**: Reads `config.project_doc_max_bytes`, returns early on zero, awaits `agents_md_paths` to get candidate paths, then for each path checks metadata via `ExecutorFileSystem::get_metadata`, skips non-files and not-found races, reads bytes with `read_file`, truncates to the remaining budget, warns when truncation occurs, decodes lossy UTF-8, and pushes non-empty `InstructionEntry` values with `InstructionProvenance::Project { source_path, environment_id, cwd }`. It decrements the remaining budget by the retained byte count and returns `Ok(Some(LoadedAgentsMd))` or `Ok(None)`.

**Call relations**: This function is called once per environment from `load_project_instructions`. It relies on `agents_md_paths` for discovery and performs the actual filesystem I/O and truncation policy.

*Call graph*: calls 2 internal fn (agents_md_paths, from_abs_path); called by 1 (load_project_instructions); 6 external calls (from_utf8_lossy, default, get_metadata, read_file, warn!, clone).


##### `agents_md_paths`  (lines 170–256)

```
async fn agents_md_paths(
    config: &Config,
    cwd: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
) -> io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Finds the ordered list of project instruction files to load, from project root through cwd, while respecting configured root markers and filename preference rules.

**Data flow**: Takes `&Config`, `&AbsolutePathBuf cwd`, and `&dyn ExecutorFileSystem`. It merges all non-project config layers into a temporary `TomlValue::Table`, derives `project_root_markers` from that merged config or defaults, walks ancestor directories looking for any marker via filesystem metadata checks, builds the search directory list from root to cwd or just cwd if no root is found, computes candidate filenames with `candidate_filenames`, and for each directory picks the first candidate that exists as a regular file. Returns `Vec<AbsolutePathBuf>` in root-to-cwd order.

**Call relations**: Used exclusively by `read_agents_md` to separate discovery from reading. Its deliberate exclusion of project config layers prevents project-local config from changing the root-marker rules used to discover project docs.

*Call graph*: calls 2 internal fn (candidate_filenames, from_abs_path); called by 1 (read_agents_md); 11 external calls (Table, new, default_project_root_markers, merge_toml_values, project_root_markers_from_config, get_metadata, matches!, new, warn!, clone (+1 more)).


##### `candidate_filenames`  (lines 258–272)

```
fn candidate_filenames(config: &Config) -> Vec<&str>
```

**Purpose**: Builds the ordered list of filenames to probe in each directory during AGENTS discovery. It encodes the preference for local override, then standard AGENTS, then configured fallbacks without duplicates.

**Data flow**: Reads `config.project_doc_fallback_filenames`, initializes a vector with capacity for the two built-ins plus fallbacks, pushes `LOCAL_AGENTS_MD_FILENAME` and `DEFAULT_AGENTS_MD_FILENAME`, then appends each non-empty fallback string only if it is not already present. Returns `Vec<&str>`.

**Call relations**: Called by `agents_md_paths` before probing each directory so discovery can stop at the first matching preferred filename.

*Call graph*: called by 1 (agents_md_paths); 1 external calls (with_capacity).


##### `LoadedAgentsMd::new_user`  (lines 287–298)

```
fn new_user(contents: String, path: AbsolutePathBuf) -> Self
```

**Purpose**: Constructs a `LoadedAgentsMd` containing only host-provided user instructions sourced from a specific path. Empty or whitespace-only text collapses to the default empty value.

**Data flow**: Consumes a `String` and `AbsolutePathBuf`, trims the text to test emptiness, returns `LoadedAgentsMd::default()` if blank, otherwise stores `Some(UserInstructions { text: contents, source: path })` and an empty `entries` vector.

**Call relations**: This constructor is mainly used by tests and callers that want to build a user-instructions-only value without project entries.

*Call graph*: 2 external calls (default, new).


##### `LoadedAgentsMd::from_user_instructions`  (lines 300–306)

```
fn from_user_instructions(user_instructions: Option<UserInstructions>) -> Self
```

**Purpose**: Creates a `LoadedAgentsMd` seeded from optional host instructions while filtering out blank instruction text. It is the normal starting point for project-doc loading.

**Data flow**: Takes `Option<UserInstructions>`, applies `.filter(|instructions| !instructions.text.trim().is_empty())`, stores the filtered option in `user_instructions`, initializes `entries` as empty, and returns the struct.

**Call relations**: Called by `load_project_instructions` before any environment-specific AGENTS docs are appended.

*Call graph*: called by 1 (load_project_instructions); 1 external calls (new).


##### `LoadedAgentsMd::from_text_for_testing`  (lines 312–324)

```
fn from_text_for_testing(contents: impl Into<String>) -> Self
```

**Purpose**: Builds a source-less instruction bundle for tests using an internal provenance entry instead of host `UserInstructions`. Blank text again yields the default empty value.

**Data flow**: Accepts any `Into<String>`, converts it, trims to detect emptiness, returns default if blank, otherwise creates `LoadedAgentsMd { user_instructions: None, entries: vec![InstructionEntry { contents, provenance: Internal }] }`.

**Call relations**: This helper exists specifically so tests outside `#[cfg(test)]` builds can still construct instruction bundles without file-backed sources.

*Call graph*: 4 external calls (into, trim, default, vec!).


##### `LoadedAgentsMd::is_empty`  (lines 326–332)

```
fn is_empty(&self) -> bool
```

**Purpose**: Determines whether the bundle contains any meaningful instruction text at all. It treats whitespace-only entries as empty.

**Data flow**: Reads `self.user_instructions` and iterates `self.entries`, returning true only when there is no user instruction and every entry’s `contents.trim()` is empty.

**Call relations**: Used by `load_project_instructions` and `read_agents_md` to suppress empty results instead of returning structurally non-empty but textless bundles.


##### `LoadedAgentsMd::text`  (lines 335–341)

```
fn text(&self) -> String
```

**Purpose**: Returns the final concatenated instruction text in the appropriate layout for one or multiple contributing project environments.

**Data flow**: Reads `self`, calls `has_multiple_project_environments`, and dispatches to either `environment_labeled_text` or `legacy_text`. Returns the resulting `String`.

**Call relations**: This is the main text accessor used by `render`; it centralizes the layout decision instead of making callers inspect provenance themselves.

*Call graph*: calls 3 internal fn (environment_labeled_text, has_multiple_project_environments, legacy_text); called by 1 (render).


##### `LoadedAgentsMd::legacy_text`  (lines 343–369)

```
fn legacy_text(&self) -> String
```

**Purpose**: Formats instructions in the original single-environment style, inserting `AGENTS_MD_SEPARATOR` only when transitioning from user/internal instructions into project docs and plain blank lines elsewhere.

**Data flow**: Builds a `String`, optionally appends `user_instructions.text`, then iterates `entries`, checks whether each entry has project provenance, chooses either `AGENTS_MD_SEPARATOR` or `"\n\n"` based on whether this is the first project entry after non-project content, appends entry contents, and returns the assembled text.

**Call relations**: Called by `text` when there is at most one contributing project environment. It preserves backward-compatible formatting for the common case.

*Call graph*: called by 1 (text); 2 external calls (new, matches!).


##### `LoadedAgentsMd::environment_labeled_text`  (lines 371–414)

```
fn environment_labeled_text(&self) -> String
```

**Purpose**: Formats instructions for multiple contributing project environments by labeling each environment group once with its environment id and cwd. Internal entries still appear unlabeled.

**Data flow**: Starts with optional user instruction text, then iterates `entries`. For project entries it inserts blank-line separators, compares the current `(environment_id, cwd)` pair to the previous one, emits a `for `<id>` with root <cwd>` label when the environment changes, appends the entry contents, and tracks the current environment. For internal entries it inserts a blank line, appends contents, and clears the previous-environment tracker. Returns the final `String`.

**Call relations**: Called by `text` when `has_multiple_project_environments` is true so the model can distinguish instructions coming from different bound environments.

*Call graph*: called by 1 (text); 2 external calls (new, format!).


##### `LoadedAgentsMd::render`  (lines 417–431)

```
fn render(&self) -> String
```

**Purpose**: Wraps the assembled instruction text in the contextual user-instructions rendering format expected by prompt construction. It includes an outer directory label only for the single-project-environment case.

**Data flow**: Checks `has_multiple_project_environments`; if false, derives `directory` from `single_project_cwd()` converted to owned string, otherwise uses `None`. It then constructs `ContextUserInstructions { directory, text: self.text() }` and returns `.render()`.

**Call relations**: Higher-level prompt assembly calls this after loading instructions. It depends on `text`, `has_multiple_project_environments`, and `single_project_cwd` to choose the correct wrapper.

*Call graph*: calls 3 internal fn (has_multiple_project_environments, single_project_cwd, text).


##### `LoadedAgentsMd::user_instructions`  (lines 434–436)

```
fn user_instructions(&self) -> Option<&UserInstructions>
```

**Purpose**: Exposes the original host-provided `UserInstructions`, if any, without mixing in project entries.

**Data flow**: Returns `self.user_instructions.as_ref()`. It reads but does not transform state.

**Call relations**: Tests and callers use this accessor when they need to distinguish host instructions from discovered project docs.


##### `LoadedAgentsMd::sources`  (lines 439–448)

```
fn sources(&self) -> impl Iterator<Item = &AbsolutePathBuf>
```

**Purpose**: Iterates every file path that contributed visible instructions, with host instructions first and project AGENTS sources afterward. Internal guidance entries are excluded because they have no file source.

**Data flow**: Creates an iterator over `self.user_instructions.iter().map(|instructions| &instructions.source)` chained with `self.entries.iter().filter_map(|entry| entry.provenance.path())`, and returns that iterator.

**Call relations**: Callers and tests use this to inspect provenance ordering after `load_project_instructions` has assembled the bundle.


##### `LoadedAgentsMd::has_multiple_project_environments`  (lines 450–464)

```
fn has_multiple_project_environments(&self) -> bool
```

**Purpose**: Detects whether project entries come from more than one distinct environment id. This drives the choice between legacy and labeled rendering.

**Data flow**: Iterates `self.entries`, ignores non-project entries, remembers the first seen project `environment_id`, and returns true as soon as it encounters a different project environment id later in the sequence.

**Call relations**: Both `text` and `render` call this predicate to decide whether to emit environment labels and whether to include an outer cwd wrapper.

*Call graph*: called by 2 (render, text).


##### `LoadedAgentsMd::single_project_cwd`  (lines 466–473)

```
fn single_project_cwd(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: Returns the cwd associated with the first project entry, if any. It is used only when rendering the single-project-environment wrapper.

**Data flow**: Scans `self.entries` and returns the first `cwd` from an `InstructionProvenance::Project` entry, skipping internal entries. Returns `Option<&AbsolutePathBuf>`.

**Call relations**: Called by `render` only when multiple project environments are not present.

*Call graph*: called by 1 (render).


##### `InstructionProvenance::path`  (lines 501–506)

```
fn path(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: Extracts the source file path from project provenance and returns `None` for internal entries. It is the provenance-to-path adapter used by source iteration.

**Data flow**: Matches `self`; for `Project { source_path, .. }` it returns `Some(source_path)`, and for `Internal` it returns `None`.

**Call relations**: Used by `LoadedAgentsMd::sources` to filter out internal guidance while preserving project file paths.


### `core/src/context/collaboration_mode_instructions.rs`

`domain_logic` · `prompt assembly`

This file contains `CollaborationModeInstructions`, a small wrapper around a single `instructions: String` field. Its constructor-like method, `from_collaboration_mode`, extracts `developer_instructions` from `codex_protocol::config_types::CollaborationMode.settings`, rejects missing or empty strings, and clones the remaining text into the fragment. That means prompt assembly can treat collaboration-mode instructions as optional structured context rather than repeatedly checking nested config fields.

The `ContextualUserFragment` implementation is straightforward. The fragment always renders with developer role, uses `COLLABORATION_MODE_OPEN_TAG` and `COLLABORATION_MODE_CLOSE_TAG` as delimiters, and returns the stored instruction text unchanged from `body()`. Unlike other instruction fragments in this directory, there is no local formatting or markdown scaffolding here; the collaboration mode configuration is assumed to already contain the exact developer-facing text that should be injected. The key design choice is preserving that text verbatim while still wrapping it in protocol markers so downstream prompt composition can isolate or replace the section cleanly.

#### Function details

##### `CollaborationModeInstructions::from_collaboration_mode`  (lines 12–21)

```
fn from_collaboration_mode(collaboration_mode: &CollaborationMode) -> Option<Self>
```

**Purpose**: Extracts non-empty developer instructions from a `CollaborationMode` and wraps them in a contextual fragment. It returns `None` when the collaboration mode has no usable instruction text.

**Data flow**: Takes `&CollaborationMode`, reads `collaboration_mode.settings.developer_instructions`, converts the `Option<String>` to `Option<&String>`, filters out empty strings, clones the surviving string into the `instructions` field, and returns `Option<CollaborationModeInstructions>`.

**Call relations**: It is called by `build_collaboration_mode_update_item` and `build_initial_context` so both initial prompt assembly and later collaboration-mode updates can include this section only when configured.

*Call graph*: called by 2 (build_collaboration_mode_update_item, build_initial_context).


##### `CollaborationModeInstructions::role`  (lines 25–27)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that collaboration-mode instructions are developer-role prompt content. The role is fixed.

**Data flow**: Returns the static string `"developer"` with no field access.

**Call relations**: It is used through the `ContextualUserFragment` trait by generic prompt-rendering code.


##### `CollaborationModeInstructions::markers`  (lines 29–31)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the protocol markers delimiting the collaboration-mode section. It delegates to the type-level marker definition.

**Data flow**: Calls `Self::type_markers()` and returns the resulting open/close tag pair.

**Call relations**: It participates in trait-based rendering and centralizes marker lookup.

*Call graph*: 1 external calls (type_markers).


##### `CollaborationModeInstructions::type_markers`  (lines 33–35)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the open and close protocol tags for collaboration-mode instructions. These tags identify the section in rendered context.

**Data flow**: Returns `(COLLABORATION_MODE_OPEN_TAG, COLLABORATION_MODE_CLOSE_TAG)`.

**Call relations**: It is used by `markers` and indirectly by any renderer that wraps fragment bodies.


##### `CollaborationModeInstructions::body`  (lines 37–39)

```
fn body(&self) -> String
```

**Purpose**: Returns the stored collaboration-mode instruction text exactly as configured. No additional formatting is applied.

**Data flow**: Clones `self.instructions` and returns the cloned `String`.

**Call relations**: It is called through the `ContextualUserFragment` trait when the collaboration-mode section is rendered into the prompt.


### `core/src/context/personality_spec_instructions.rs`

`domain_logic` · `initial context build and personality updates`

This file packages a personality specification string into a dedicated `ContextualUserFragment` so the model can be instructed to adopt a new communication style. `PersonalitySpecInstructions` stores one owned field, `spec`, containing the requested personality description. The constructor accepts any string-like input and normalizes it into a `String`, making the fragment easy to build from configuration, user preferences, or rollout logic.

Within the trait implementation, the fragment is explicitly marked as `developer` role, reflecting that it is system-authored guidance derived from user intent rather than direct user prose. It uses `<personality_spec>` and `</personality_spec>` markers, giving the serialized context a stable envelope that can be recognized later. `body()` formats a fixed explanatory sentence telling the model that the user has requested a new communication style, then appends the stored specification on the next line. The wording is intentionally future-oriented (`Future messages should adhere...`), making the fragment an instruction that affects subsequent responses rather than a summary of past behavior. This file is a thin but important adapter between higher-level personality-selection logic and the generic contextual-fragment pipeline.

#### Function details

##### `PersonalitySpecInstructions::new`  (lines 9–11)

```
fn new(spec: impl Into<String>) -> Self
```

**Purpose**: Constructs a personality-spec fragment from arbitrary string-like input. It stores the requested communication-style specification as owned text.

**Data flow**: Accepts `spec: impl Into<String>`, converts it into a `String`, and returns `PersonalitySpecInstructions { spec }`.

**Call relations**: It is called during initial context construction and sample rollout paths that decide a personality specification should be injected. The constructor only captures data; rendering happens in `body`.

*Call graph*: called by 2 (build_initial_context, sample_rollout); 1 external calls (into).


##### `PersonalitySpecInstructions::role`  (lines 15–17)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that personality instructions are emitted as a `developer` fragment.

**Data flow**: Returns `"developer"` with no state access.

**Call relations**: Generic fragment orchestration uses this role when assembling the message list.


##### `PersonalitySpecInstructions::markers`  (lines 19–21)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the wrapper markers for serialized personality-spec instructions.

**Data flow**: Calls `Self::type_markers()` and returns the resulting tuple.

**Call relations**: It is the instance-level trait method that forwards to the canonical type-level marker definition.

*Call graph*: 1 external calls (type_markers).


##### `PersonalitySpecInstructions::type_markers`  (lines 23–25)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the `<personality_spec>` wrapper used to delimit this instruction fragment.

**Data flow**: Returns `("<personality_spec>", "</personality_spec>")`.

**Call relations**: This marker pair underpins `markers` and any structural identification of the fragment type.


##### `PersonalitySpecInstructions::body`  (lines 27–32)

```
fn body(&self) -> String
```

**Purpose**: Formats the instruction text telling the model to adopt the supplied personality for future responses.

**Data flow**: Reads `self.spec` and interpolates it into a fixed sentence: `The user has requested a new communication style...`, returning the resulting formatted `String`.

**Call relations**: Serialization code calls this after the fragment has been created by higher-level context-building logic.

*Call graph*: 1 external calls (format!).


### `core/src/context/plugin_instructions.rs`

`domain_logic` · `plugin-driven context injection`

This file provides the thinnest possible `ContextualUserFragment` wrapper around plugin-supplied instruction text. `PluginInstructions` stores a single owned `String`, `text`, with no additional parsing, validation, or formatting. Its purpose is to let plugin-originated guidance participate in the same fragment pipeline as other contextual instructions while preserving the plugin's text verbatim.

The constructor accepts any `Into<String>` input and stores it directly. In the trait implementation, the role is fixed to `developer`, indicating that the content is system-side instruction rather than user-authored conversation. Both markers are empty strings, so the fragment is serialized as plain text without a dedicated wrapper tag. `body()` simply clones and returns the stored text. That design choice is notable: unlike other instruction fragments in this module, this one does not prepend explanatory prose or delimit the content structurally, so whatever creates it is responsible for supplying appropriately scoped and readable instruction text. The file therefore acts as a minimal adapter between plugin infrastructure and the generic contextual-fragment interface.

#### Function details

##### `PluginInstructions::new`  (lines 9–11)

```
fn new(text: impl Into<String>) -> Self
```

**Purpose**: Constructs a plugin-instruction fragment from arbitrary string-like text. It preserves the plugin-provided content as owned data.

**Data flow**: Accepts `text: impl Into<String>`, converts it into a `String`, and returns `PluginInstructions { text }`.

**Call relations**: This constructor is used by plugin-related code that wants to inject instructions into the shared fragment pipeline. It performs no transformation beyond ownership conversion.

*Call graph*: 1 external calls (into).


##### `PluginInstructions::role`  (lines 15–17)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks plugin instructions as a `developer` fragment.

**Data flow**: Returns the static string `"developer"`.

**Call relations**: Generic context assembly reads this role when placing plugin instructions into the message stream.


##### `PluginInstructions::markers`  (lines 19–21)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the fragment markers, which are empty because plugin instructions are emitted as raw text.

**Data flow**: Calls `Self::type_markers()` and returns its tuple.

**Call relations**: It delegates to `type_markers` so trait consumers and type-level logic share the same delimiter definition.

*Call graph*: 1 external calls (type_markers).


##### `PluginInstructions::type_markers`  (lines 23–25)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that plugin instructions have no explicit wrapper tags.

**Data flow**: Returns `("", "")`.

**Call relations**: This definition is surfaced through `markers` to generic fragment code.


##### `PluginInstructions::body`  (lines 27–29)

```
fn body(&self) -> String
```

**Purpose**: Returns the plugin-provided instruction text unchanged apart from cloning it out of the struct.

**Data flow**: Reads `self.text`, clones the `String`, and returns the clone. It does not mutate the fragment.

**Call relations**: Serialization code calls this to obtain the exact text that should be inserted into context for plugin guidance.


### `core/src/context/image_generation_instructions.rs`

`domain_logic` · `context assembly`

This file encapsulates a single piece of image-generation guidance in two forms. At the top level, `extension_image_generation_output_hint` produces an optional model-facing hint string describing the default image output directory and path. It uses a hard byte-length cap (`MAX_IMAGE_GENERATION_OUTPUT_HINT_BYTES = 1024`) to suppress the hint entirely when interpolated paths would make the message too large. The actual wording is centralized in the private `image_generation_hint` formatter so both direct and fragment-based callers get identical text.

The `ImageGenerationInstructions` struct stores the output directory and output path as owned strings and implements `ContextualUserFragment`. Like several other instruction-only fragments, it uses role `developer` and empty markers, meaning the body is inserted as plain developer guidance rather than tagged content. Its constructor accepts any `Display` values and eagerly stringifies them, which lets callers pass path-like types without committing to a specific path representation in the struct. `body()` simply regenerates the canonical hint text from the stored strings. The key design choice is consistency: whether the hint is emitted ad hoc for an extension or as part of the prompt context stack, the wording and path interpolation logic remain identical, with only the top-level helper enforcing the size limit.

#### Function details

##### `extension_image_generation_output_hint`  (lines 8–14)

```
fn extension_image_generation_output_hint(
    image_output_dir: impl Display,
    image_output_path: impl Display,
) -> Option<String>
```

**Purpose**: Builds the extension-facing image-output hint and drops it if the resulting string exceeds the configured maximum size. This prevents oversized path hints from bloating model context.

**Data flow**: It takes two `impl Display` arguments for the output directory and output path, calls `image_generation_hint(image_output_dir, image_output_path)` to build the full message, checks `hint.len() <= MAX_IMAGE_GENERATION_OUTPUT_HINT_BYTES`, and returns `Some(hint)` when within the limit or `None` otherwise.

**Call relations**: This top-level helper is used by extension-facing code that wants the canonical hint text without constructing a fragment object. It delegates all wording to `image_generation_hint` and adds only the size gate.

*Call graph*: calls 1 internal fn (image_generation_hint).


##### `image_generation_hint`  (lines 16–23)

```
fn image_generation_hint(
    image_output_dir: impl Display,
    image_output_path: impl Display,
) -> String
```

**Purpose**: Formats the canonical image-generation guidance string from a directory and path. It is the single source of truth for the wording shared by both APIs in this file.

**Data flow**: It takes two `impl Display` arguments, interpolates them into a fixed two-sentence message with `format!`, and returns the resulting `String`.

**Call relations**: This helper is called by both `extension_image_generation_output_hint` and `ImageGenerationInstructions::body`, ensuring direct hints and contextual fragments stay textually identical.

*Call graph*: called by 2 (body, extension_image_generation_output_hint); 1 external calls (format!).


##### `ImageGenerationInstructions::new`  (lines 32–37)

```
fn new(image_output_dir: impl Display, image_output_path: impl Display) -> Self
```

**Purpose**: Constructs a fragment carrying image output directory and path information. It eagerly stores both values as owned strings for later rendering.

**Data flow**: It takes `image_output_dir: impl Display` and `image_output_path: impl Display`, converts each with `.to_string()`, stores them in the struct fields, and returns `ImageGenerationInstructions`.

**Call relations**: This constructor is used by higher-level code that records image-generation instructions in prompt context or output history. Rendering later delegates back to `image_generation_hint`.

*Call graph*: called by 2 (handle_output_item_done_records_image_save_history_message, record_image_generation_instructions); 1 external calls (to_string).


##### `ImageGenerationInstructions::role`  (lines 41–43)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks the fragment as developer-role guidance. The instructions are intended for the model, not as user-authored content.

**Data flow**: It takes `&self` and returns `"developer"`.

**Call relations**: This trait method is consumed by generic contextual-fragment insertion logic.


##### `ImageGenerationInstructions::markers`  (lines 45–47)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns empty wrapper markers for this instruction fragment. The body is inserted directly as plain text.

**Data flow**: It takes `&self`, calls `Self::type_markers()`, and returns the empty-string pair.

**Call relations**: This method fulfills the `ContextualUserFragment` trait and forwards marker definition to the type-level function.

*Call graph*: 1 external calls (type_markers).


##### `ImageGenerationInstructions::type_markers`  (lines 49–51)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that image-generation instructions have no surrounding tags. Only the body text is emitted.

**Data flow**: It returns `("", "")` directly.

**Call relations**: This static marker definition is used by `markers` and any generic code that needs the fragment’s canonical wrapping behavior.


##### `ImageGenerationInstructions::body`  (lines 53–55)

```
fn body(&self) -> String
```

**Purpose**: Renders the stored directory and path into the canonical image-generation guidance text. It does not apply the top-level size limit.

**Data flow**: It reads `self.image_output_dir` and `self.image_output_path`, passes references to `image_generation_hint`, and returns the resulting `String`.

**Call relations**: This trait method is called during prompt assembly for the fragment form of the instructions, reusing the same formatter as the extension helper.

*Call graph*: calls 1 internal fn (image_generation_hint).


### `tui/src/terminal_visualization_instructions.rs`

`config` · `prompt assembly`

This file is a tiny feature-gated instruction composer for prompt construction. Its main artifact is the `TERMINAL_VISUALIZATION_INSTRUCTIONS` constant, a multiline string that explicitly tells the model it is rendering into a terminal and should use ASCII-only diagrams, trees, timelines, and tables when formatting rules call for a visual. The only function, `with_terminal_visualization_instructions`, decides whether that block should be appended at all.

The control flow is intentionally simple and preserves existing instruction sources. It first checks `config.features.enabled(Feature::TerminalVisualizationInstructions)`; if the feature is off, it returns the incoming `control_instructions` unchanged, avoiding any prompt mutation. If the feature is on, it chooses a base instruction string from either the explicit `control_instructions` argument or, if absent, `config.developer_instructions.clone()`. It then appends the terminal visualization block only when the chosen base string exists and is non-blank after trimming; otherwise it returns the visualization block by itself. This means blank strings are treated the same as missing instructions, and developer instructions act as a fallback source only when no explicit control instructions were supplied.

#### Function details

##### `with_terminal_visualization_instructions`  (lines 10–29)

```
fn with_terminal_visualization_instructions(
    config: &Config,
    control_instructions: Option<String>,
) -> Option<String>
```

**Purpose**: Builds the final developer/control instruction string with terminal-visualization guidance appended when the feature flag is enabled. It preserves caller-supplied instructions when present, otherwise falls back to configured developer instructions.

**Data flow**: Reads `config.features` to test `Feature::TerminalVisualizationInstructions`, and reads `config.developer_instructions` as a fallback source. It takes `control_instructions: Option<String>`, selects either that value or the config fallback, then returns `None`/`Some` according to the feature gate and whether there is existing non-empty text; when appending, it produces a new formatted string containing the original instructions, two newlines, and `TERMINAL_VISUALIZATION_INSTRUCTIONS`.

**Call relations**: This function is invoked while constructing thread start/resume/fork parameters, where prompt control text is being assembled. Those callers use it as the last-mile decorator for instruction text; internally it does not delegate beyond string formatting.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 1 external calls (format!).


### `tui/src/ide_context/prompt.rs`

`domain_logic` · `request handling`

This module turns the structured `IdeContext` model into the exact prompt prefix consumed by Codex. `render_prompt_context` builds a markdown-like section beginning with `# Context from my IDE setup:` and conditionally appends active-file path, selection ranges, active selection content, and open-tab listings. It preserves the desktop app’s delimiter semantics with the constant `PROMPT_REQUEST_BEGIN`, so replayed threads can strip context consistently across surfaces. Selection ranges are rendered as 1-based line/column coordinates; if multiple non-empty selections exist or the IDE did not provide selected text, the prompt includes range summaries instead of content. Large active selections are truncated at `MAX_ACTIVE_SELECTION_CHARS` with an explicit truncation notice, and open tabs are capped by both count and total rendered characters, with an omission summary when limits are exceeded. `apply_ide_context_to_user_input` prefixes the first `UserInput::Text` item in place so image/text ordering is preserved; if no text item exists, it inserts a new text item at the front. When text elements are present, `prefixed_text_input` shifts each `ByteRange` forward by the prefix length so placeholders still point at the same user-authored substring. `extract_prompt_request_with_offset` reverses the process for transcript display by returning the text after the last delimiter plus its byte offset in the original message.

#### Function details

##### `apply_ide_context_to_user_input`  (lines 18–59)

```
fn apply_ide_context_to_user_input(
    context: &IdeContext,
    items: &mut Vec<UserInput>,
) -> bool
```

**Purpose**: Prefixes rendered IDE context onto the first text item in a `Vec<UserInput>`, or inserts a new text item if none exists.

**Data flow**: Borrows an `IdeContext` and mutably borrows `items`; calls `render_prompt_context`; if it returns `None`, returns `false` without mutation. Otherwise it builds `prefix = "{context_text}\n## My request for Codex:\n"`, finds the first `UserInput::Text`, replaces it temporarily, rebuilds it with `prefixed_text_input` so `TextElement` byte ranges shift by the prefix length, or inserts a new text item at index 0 if no text item exists; then returns `true`.

**Call relations**: Called when the TUI injects IDE context into outgoing user turns. It delegates prompt formatting to `render_prompt_context` and byte-range adjustment to `prefixed_text_input`.

*Call graph*: calls 2 internal fn (prefixed_text_input, render_prompt_context); 5 external calls (new, new, format!, replace, unreachable!).


##### `has_prompt_context`  (lines 61–63)

```
fn has_prompt_context(context: &IdeContext) -> bool
```

**Purpose**: Reports whether an `IdeContext` would produce any prompt prefix at all.

**Data flow**: Borrows an `IdeContext`, calls `render_prompt_context`, and returns whether the result is `Some`.

**Call relations**: Used by callers that need a cheap yes/no check before attempting prompt injection or showing IDE-context UI.

*Call graph*: calls 1 internal fn (render_prompt_context).


##### `extract_prompt_request_with_offset`  (lines 65–74)

```
fn extract_prompt_request_with_offset(message: &str) -> (&str, usize)
```

**Purpose**: Recovers the user-authored request text from a message that may contain one or more IDE-context prefixes.

**Data flow**: Borrows the full message string, splits on the last occurrence of `PROMPT_REQUEST_BEGIN` using `rsplit_once`, and if absent returns `(message, 0)`. If present, it computes the byte offset immediately after the delimiter plus any leading whitespace trimmed from the request section, returns the trimmed request slice, and the corresponding offset.

**Call relations**: Used when transcript rendering or editing needs to strip IDE context back to the actual request. It intentionally uses the last delimiter so nested/replayed prefixes collapse correctly.


##### `prefixed_text_input`  (lines 76–94)

```
fn prefixed_text_input(prefix: String, text: String, text_elements: Vec<TextElement>) -> UserInput
```

**Purpose**: Builds a new `UserInput::Text` whose text is prefixed and whose `TextElement` byte ranges are shifted accordingly.

**Data flow**: Consumes a prefix string, original text string, and vector of `TextElement`; computes `prefix_len`; returns `UserInput::Text { text: format!("{prefix}{text}"), text_elements: ... }` where each element’s `ByteRange.start` and `.end` are incremented by `prefix_len` and placeholders are preserved.

**Call relations**: Called only by `apply_ide_context_to_user_input` when an existing text item must be rewritten in place.

*Call graph*: called by 1 (apply_ide_context_to_user_input); 1 external calls (format!).


##### `render_prompt_context`  (lines 96–185)

```
fn render_prompt_context(context: &IdeContext) -> Option<String>
```

**Purpose**: Serializes structured IDE context into the exact markdown-like prompt prefix shared with the desktop app and extension.

**Data flow**: Borrows an `IdeContext`, incrementally appends sections to a `String`: active file path, active selection ranges when needed, active selection content truncated at `MAX_ACTIVE_SELECTION_CHARS`, and open tabs capped by `MAX_OPEN_TABS` and `MAX_OPEN_TABS_CHARS` with an omission notice. If nothing was added it returns `None`; otherwise it wraps the accumulated section under `# Context from my IDE setup:` and returns `Some(String)`.

**Call relations**: This is the core formatter used by both `apply_ide_context_to_user_input` and `has_prompt_context`, and directly by tests covering truncation and omission behavior.

*Call graph*: called by 4 (apply_ide_context_to_user_input, has_prompt_context, render_prompt_context_omits_excess_open_tabs, render_prompt_context_truncates_large_selection); 3 external calls (new, format!, from_ref).


##### `tests::descriptor`  (lines 198–203)

```
fn descriptor(label: &str, path: &str) -> FileDescriptor
```

**Purpose**: Creates a minimal `FileDescriptor` fixture for prompt-rendering tests.

**Data flow**: Accepts `label` and `path` strings, clones them into owned `String`s, and returns `FileDescriptor`.

**Call relations**: Shared by the prompt tests to keep fixture construction concise.


##### `tests::render_prompt_context_matches_app_format`  (lines 206–236)

```
fn render_prompt_context_matches_app_format()
```

**Purpose**: Verifies that prompt rendering matches the desktop app’s exact formatting for active file, selected text, and open tabs.

**Data flow**: Builds an `IdeContext` with one active file and two open tabs, calls `render_prompt_context`, and asserts the exact expected multiline string.

**Call relations**: Regression coverage for cross-surface prompt-format compatibility.

*Call graph*: 4 external calls (new, assert_eq!, descriptor, vec!).


##### `tests::render_prompt_context_omits_empty_context`  (lines 239–246)

```
fn render_prompt_context_omits_empty_context()
```

**Purpose**: Checks that an empty `IdeContext` produces no prompt prefix.

**Data flow**: Builds an `IdeContext` with no active file and no open tabs, calls `render_prompt_context`, and asserts it returns `None`.

**Call relations**: Covers the empty-context branch used by `has_prompt_context` and `apply_ide_context_to_user_input`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::apply_ide_context_uses_desktop_prompt_request_delimiter`  (lines 249–306)

```
fn apply_ide_context_uses_desktop_prompt_request_delimiter()
```

**Purpose**: Verifies that IDE context is inserted before the exact shared request delimiter and that `TextElement` byte ranges are shifted correctly.

**Data flow**: Builds an `IdeContext`, a `Vec<UserInput>` containing a local image and one text item with a `TextElement`, calls `apply_ide_context_to_user_input`, computes the expected prefix length, and asserts the resulting items preserve image/text order, prepend the expected prefix, and offset the byte range by `prefix_len`.

**Call relations**: Exercises both prompt rendering and `prefixed_text_input` through the public injection API.

*Call graph*: 6 external calls (new, new, assert!, assert_eq!, descriptor, vec!).


##### `tests::extract_prompt_request_returns_text_after_last_delimiter`  (lines 309–317)

```
fn extract_prompt_request_returns_text_after_last_delimiter()
```

**Purpose**: Checks that request extraction uses the last delimiter occurrence, not the first.

**Data flow**: Builds a message containing two `## My request for Codex:` markers, calls `extract_prompt_request_with_offset`, and asserts it returns `Second` plus the byte offset where `Second` begins.

**Call relations**: Guards replay/transcript behavior when messages already contain embedded context markers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::render_prompt_context_includes_selection_ranges_without_content`  (lines 320–358)

```
fn render_prompt_context_includes_selection_ranges_without_content()
```

**Purpose**: Verifies that when selected text content is absent but non-empty selections exist, the prompt includes 1-based range summaries.

**Data flow**: Builds an `IdeContext` with two non-empty `Range`s and empty `active_selection_content`, calls `render_prompt_context`, and asserts the exact multiline output listing both ranges.

**Call relations**: Covers the branch where ranges are rendered instead of selection text.

*Call graph*: 5 external calls (new, new, assert_eq!, descriptor, vec!).


##### `tests::render_prompt_context_truncates_large_selection`  (lines 361–386)

```
fn render_prompt_context_truncates_large_selection()
```

**Purpose**: Checks that oversized selected text is truncated and annotated with a truncation notice.

**Data flow**: Builds an `IdeContext` whose `active_selection_content` exceeds `MAX_ACTIVE_SELECTION_CHARS`, calls `render_prompt_context`, and asserts the truncation notice is present while the tail text is absent.

**Call relations**: Exercises the active-selection truncation path in `render_prompt_context`.

*Call graph*: calls 1 internal fn (render_prompt_context); 4 external calls (new, assert!, format!, descriptor).


##### `tests::render_prompt_context_omits_excess_open_tabs`  (lines 389–402)

```
fn render_prompt_context_omits_excess_open_tabs()
```

**Purpose**: Verifies that open-tab rendering stops at configured limits and reports how many tabs were omitted.

**Data flow**: Builds more than `MAX_OPEN_TABS` descriptors, calls `render_prompt_context`, and asserts the last included tab is present, the next one is absent, and the omission summary appears.

**Call relations**: Covers count/size limiting for the open-tabs section.

*Call graph*: calls 1 internal fn (render_prompt_context); 1 external calls (assert!).


### `prompts/src/permissions_instructions.rs`

`domain_logic` · `context assembly`

This module assembles a `PermissionsInstructions` value, a thin wrapper around a rendered `String`, from protocol-level permission settings. It embeds markdown templates for approval-policy variants (`never`, `unless_trusted`, `on_failure`, `on_request`) and sandbox modes (`danger-full-access`, `workspace-write`, `read-only`), parsing the sandbox templates once via `LazyLock<Template>`. `PermissionsInstructions::from_permission_profile` is the main entry: it derives a `SandboxMode` plus optional `WritableRoot` list from `FileSystemSandboxPolicy`, maps `NetworkSandboxPolicy` to `NetworkAccess`, computes a denied-read section from unreadable roots and globs, and forwards everything into the internal constructor. That constructor concatenates sections in order—sandbox text, approval text, writable roots, denied reads—using `append_section`, and guarantees the final body ends with a newline. Approval rendering is the most conditional part: `approval_text` selects static policy text or `granular_instructions`, optionally appends request-permissions tool guidance, approved command prefixes from `Policy::get_allowed_prefixes`, and an auto-review suffix when approvals are reviewed automatically and prompts are still possible. `granular_instructions` separately lists categories that may prompt versus categories auto-rejected, and only includes shell permission request guidance or the `request_permissions` tool section when both globally enabled and allowed by the granular config. The type also implements `ContextualUserFragment`, fixing its role to `developer` and wrapping content in `<permissions instructions>` markers.

#### Function details

##### `PermissionsInstructions::from_permission_profile`  (lines 65–91)

```
fn from_permission_profile(
        permission_profile: &PermissionProfile,
        approval_policy: AskForApproval,
        approvals_reviewer: ApprovalsReviewer,
        exec_policy: &Policy,
```

**Purpose**: Constructs a full permissions instruction block from a `PermissionProfile`, current working directory, approval settings, and execution-policy flags.

**Data flow**: Reads the profile’s filesystem and network sandbox policies, derives `(SandboxMode, Option<Vec<WritableRoot>>)` via `sandbox_prompt_from_policy`, converts network policy to `NetworkAccess` via `network_access_from_policy`, computes optional denied-read markdown via `denied_reads_text`, packages approval-related inputs into `PermissionsPromptConfig`, and passes all of that into the internal string-building constructor. It returns a new `PermissionsInstructions` containing the assembled text.

**Call relations**: This is the public entry used when higher-level context builders need to inject permissions guidance, including initial context creation and permissions update items. It delegates all formatting decisions to helper functions so callers only provide runtime policy objects and feature flags.

*Call graph*: calls 5 internal fn (denied_reads_text, network_access_from_policy, sandbox_prompt_from_policy, file_system_sandbox_policy, network_sandbox_policy); called by 5 (build_permissions_update_item, build_initial_context, permissions_message_includes_writable_roots, builds_permissions_from_profile, builds_permissions_from_profile_with_denied_reads); 1 external calls (from_permissions_with_network_and_denied_reads).


##### `PermissionsInstructions::from_permissions_with_network`  (lines 98–111)

```
fn from_permissions_with_network(
        sandbox_mode: SandboxMode,
        network_access: NetworkAccess,
        config: PermissionsPromptConfig<'_>,
        writable_roots: Option<Vec<WritableRoot
```

**Purpose**: Test-only convenience constructor that bypasses `PermissionProfile` derivation and directly accepts sandbox mode, network access, and writable roots.

**Data flow**: Takes explicit `SandboxMode`, `NetworkAccess`, `PermissionsPromptConfig`, and optional writable roots, then forwards them to `from_permissions_with_network_and_denied_reads` with `denied_reads` forced to `None`. It returns the resulting `PermissionsInstructions`.

**Call relations**: Used only by tests that want to isolate approval and sandbox rendering without constructing full permission profiles. It exists as a narrower wrapper around the internal constructor.

*Call graph*: called by 7 (builds_permissions_with_network_access_override, includes_request_permission_rule_instructions_for_on_request_when_enabled, includes_request_permissions_tool_instructions_for_on_failure_when_enabled, includes_request_permissions_tool_instructions_for_on_request_when_tool_is_enabled, includes_request_permissions_tool_instructions_for_unless_trusted_when_enabled, includes_request_rule_instructions_for_on_request, on_request_includes_tool_guidance_alongside_inline_permission_guidance_when_both_exist); 1 external calls (from_permissions_with_network_and_denied_reads).


##### `PermissionsInstructions::from_permissions_with_network_and_denied_reads`  (lines 113–142)

```
fn from_permissions_with_network_and_denied_reads(
        sandbox_mode: SandboxMode,
        network_access: NetworkAccess,
        config: PermissionsPromptConfig<'_>,
        writable_roots: Option
```

**Purpose**: Assembles the final permissions text from already-resolved sandbox, network, approval, writable-root, and denied-read inputs.

**Data flow**: Starts with an empty `String`, appends rendered sandbox text, appends rendered approval text, conditionally appends writable-root text if `writable_roots_text` returns `Some`, conditionally appends denied-read text, ensures the final string ends with `\n`, and wraps it in `PermissionsInstructions { text }`.

**Call relations**: This is the central formatter behind both public constructors. It orchestrates helper calls for each section and defines the final section ordering and newline invariant.

*Call graph*: calls 4 internal fn (append_section, approval_text, sandbox_text, writable_roots_text); 1 external calls (new).


##### `PermissionsInstructions::role`  (lines 146–148)

```
fn role(&self) -> &'static str
```

**Purpose**: Reports the contextual fragment role for this prompt block as `developer`.

**Data flow**: Reads no mutable state and returns the static string literal `"developer"`.

**Call relations**: Called through the `ContextualUserFragment` trait when the surrounding prompt assembly needs the fragment’s role metadata.


##### `PermissionsInstructions::markers`  (lines 150–152)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing markers used to delimit this fragment in prompt context.

**Data flow**: Delegates to `Self::type_markers()` and returns its pair of static string slices.

**Call relations**: Used by trait consumers that need both markers for wrapping the fragment body; it is a thin adapter to the associated marker definition.

*Call graph*: 1 external calls (type_markers).


##### `PermissionsInstructions::type_markers`  (lines 154–156)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the literal XML-like markers surrounding permissions instructions in context.

**Data flow**: Returns the tuple `("<permissions instructions>", "</permissions instructions>")` with no side effects.

**Call relations**: Referenced by `markers` and available as the canonical marker definition for this fragment type.


##### `PermissionsInstructions::body`  (lines 158–160)

```
fn body(&self) -> String
```

**Purpose**: Exposes the rendered permissions text as an owned `String`.

**Data flow**: Clones `self.text` and returns the clone, leaving internal state unchanged.

**Call relations**: Used both directly and through the `ContextualUserFragment` trait implementation when prompt assembly needs the fragment payload.


##### `sandbox_prompt_from_policy`  (lines 163–177)

```
fn sandbox_prompt_from_policy(
    file_system_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> (SandboxMode, Option<Vec<WritableRoot>>)
```

**Purpose**: Maps a filesystem sandbox policy plus current directory into a coarse `SandboxMode` and optional writable-root list for prompt rendering.

**Data flow**: Reads `file_system_policy.has_full_disk_write_access()` first; if true, returns `DangerFullAccess` with no writable roots. Otherwise it computes writable roots relative to `cwd` via `get_writable_roots_with_cwd`; an empty list yields `ReadOnly`, while a non-empty list yields `WorkspaceWrite` plus those roots.

**Call relations**: Called by `from_permission_profile` as the filesystem-policy reduction step before text rendering. It encapsulates the precedence rule that full disk write access overrides any root listing.

*Call graph*: calls 2 internal fn (get_writable_roots_with_cwd, has_full_disk_write_access); called by 1 (from_permission_profile).


##### `network_access_from_policy`  (lines 179–185)

```
fn network_access_from_policy(network_policy: NetworkSandboxPolicy) -> NetworkAccess
```

**Purpose**: Converts a low-level network sandbox policy into the prompt-facing `NetworkAccess` enum.

**Data flow**: Checks `network_policy.is_enabled()` and returns `NetworkAccess::Enabled` when true, otherwise `NetworkAccess::Restricted`.

**Call relations**: Used by `from_permission_profile` to normalize protocol/network policy into the simpler value consumed by sandbox template rendering.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (from_permission_profile).


##### `append_section`  (lines 187–192)

```
fn append_section(text: &mut String, section: &str)
```

**Purpose**: Appends a rendered section to the accumulating permissions text while preserving section separation by newline.

**Data flow**: Mutably inspects the destination `String`; if it does not already end with `\n`, pushes one newline, then appends the provided section text verbatim.

**Call relations**: Called repeatedly by `from_permissions_with_network_and_denied_reads` to concatenate sandbox, approval, writable-root, and denied-read sections without accidental run-together formatting.

*Call graph*: called by 1 (from_permissions_with_network_and_denied_reads).


##### `approval_text`  (lines 194–247)

```
fn approval_text(
    approval_policy: AskForApproval,
    approvals_reviewer: ApprovalsReviewer,
    exec_policy: &Policy,
    exec_permission_approvals_enabled: bool,
    request_permissions_tool_en
```

**Purpose**: Builds the approval-policy section, including optional request-permissions guidance, approved command prefixes, granular-category breakdowns, and auto-review suffix text.

**Data flow**: Consumes `approval_policy`, `approvals_reviewer`, execution policy, and two feature flags. It selects a base text by matching on `AskForApproval`: static markdown for `Never`, `UnlessTrusted`, and `OnFailure`; a composed on-request section that may swap in the request-permission rule template and append approved prefixes; or `granular_instructions` for granular mode. After base selection, if reviewer is `AutoReview` and policy is not `Never`, it appends `AUTO_REVIEW_APPROVAL_SUFFIX`; otherwise it returns the base text unchanged.

**Call relations**: Invoked by the internal constructor whenever permissions instructions are rendered. It is the policy-specific branch point and delegates granular-mode formatting to `granular_instructions`.

*Call graph*: calls 1 internal fn (granular_instructions); called by 1 (from_permissions_with_network_and_denied_reads); 1 external calls (format!).


##### `sandbox_text`  (lines 249–259)

```
fn sandbox_text(mode: SandboxMode, network_access: NetworkAccess) -> String
```

**Purpose**: Renders the sandbox-mode markdown template with the current network-access string substituted into it.

**Data flow**: Matches `SandboxMode` to one of three lazily parsed `Template` instances, converts `NetworkAccess` to a string, renders the template with a single `network_access` variable, and returns the rendered text. Rendering failures panic because templates are treated as static invariants.

**Call relations**: Called by `from_permissions_with_network_and_denied_reads` to produce the first section of the permissions fragment. It isolates template selection from the rest of assembly.

*Call graph*: called by 1 (from_permissions_with_network_and_denied_reads); 2 external calls (as_str, to_string).


##### `writable_roots_text`  (lines 261–277)

```
fn writable_roots_text(writable_roots: Option<Vec<WritableRoot>>) -> Option<String>
```

**Purpose**: Formats an optional list of writable roots into a short English sentence, sorted for deterministic output.

**Data flow**: If the outer option is `None`, returns `None`; otherwise takes ownership of the vector, returns `None` again if it is empty, sorts roots lexicographically by path, maps each root to a backticked path string, and returns either `The writable root is ...` for one entry or `The writable roots are ...` for multiple entries.

**Call relations**: Used by the internal constructor to optionally append a writable-roots section after sandbox and approval text. Its sorting ensures stable prompt text and stable tests.

*Call graph*: called by 1 (from_permissions_with_network_and_denied_reads); 1 external calls (format!).


##### `denied_reads_text`  (lines 279–299)

```
fn denied_reads_text(file_system_policy: &FileSystemSandboxPolicy, cwd: &Path) -> Option<String>
```

**Purpose**: Builds a markdown section listing unreadable filesystem roots and glob patterns that are denied by policy and must not be escalated.

**Data flow**: Queries unreadable roots and unreadable globs relative to `cwd`, formats each as a bullet (`- path ...` or `- glob ...`), concatenates them into a vector, returns `None` if no entries exist, otherwise wraps the joined bullets in a `## Denied filesystem reads` section with explicit instruction not to request escalation or extra permissions.

**Call relations**: Called by `from_permission_profile` before final assembly. It captures a subtle policy distinction: these denials are hard restrictions, not approval-eligible gaps.

*Call graph*: calls 2 internal fn (get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd); called by 1 (from_permission_profile); 1 external calls (format!).


##### `approved_command_prefixes_text`  (lines 301–304)

```
fn approved_command_prefixes_text(exec_policy: &Policy) -> Option<String>
```

**Purpose**: Extracts and formats already-approved command prefix rules from the execution policy, suppressing empty output.

**Data flow**: Reads allowed prefixes from `exec_policy.get_allowed_prefixes()`, passes them through `format_allow_prefixes`, and returns the resulting string only if it is non-empty.

**Call relations**: Used by `granular_instructions` and by the on-request branch inside `approval_text` to append a section describing command prefixes that no longer need approval.

*Call graph*: calls 1 internal fn (format_allow_prefixes); called by 1 (granular_instructions); 1 external calls (get_allowed_prefixes).


##### `granular_prompt_intro_text`  (lines 306–308)

```
fn granular_prompt_intro_text() -> &'static str
```

**Purpose**: Provides the fixed introductory paragraph for granular approval-policy instructions.

**Data flow**: Returns a static markdown string explaining that `granular` mode auto-rejects categories set to `false` instead of prompting.

**Call relations**: Used as the first section in `granular_instructions`.


##### `request_permissions_tool_prompt_section`  (lines 310–312)

```
fn request_permissions_tool_prompt_section() -> &'static str
```

**Purpose**: Provides the fixed markdown section describing how and when to use the built-in `request_permissions` tool.

**Data flow**: Returns a static string that explains the tool’s availability and instructs the model to request only the specific network or filesystem permissions needed.

**Call relations**: Referenced by `granular_instructions` and indirectly by `approval_text` when policy/feature combinations should expose tool guidance.

*Call graph*: called by 1 (granular_instructions).


##### `granular_instructions`  (lines 314–384)

```
fn granular_instructions(
    granular_config: GranularApprovalConfig,
    exec_policy: &Policy,
    exec_permission_approvals_enabled: bool,
    request_permissions_tool_enabled: bool,
) -> String
```

**Purpose**: Formats the approval section for `AskForApproval::Granular`, separating promptable versus auto-rejected categories and conditionally adding shell-permission and tool guidance.

**Data flow**: Reads booleans from `GranularApprovalConfig` to determine whether sandbox approval, rules, skill approval, request-permissions, and MCP elicitations are allowed. It computes whether inline shell permission requests are available (`exec_permission_approvals_enabled` plus sandbox approval allowed) and whether the `request_permissions` tool section may appear (tool globally enabled plus category allowed). It then builds category lists, starts with the granular intro, appends prompted and rejected category sections when non-empty, optionally appends the on-request rule template for shell permission requests, optionally appends the tool section, and finally appends approved command prefixes if present. It returns the joined markdown string.

**Call relations**: Called only from `approval_text` when the approval policy is granular. It centralizes the nuanced interaction between global feature flags and per-category granular permissions.

*Call graph*: calls 7 internal fn (approved_command_prefixes_text, request_permissions_tool_prompt_section, allows_mcp_elicitations, allows_request_permissions, allows_rules_approval, allows_sandbox_approval, allows_skill_approval); called by 1 (approval_text); 2 external calls (format!, vec!).


### Skill discovery and injection
This group selects referenced skills, injects explicit skill content, and renders the available-skills catalog into prompt-visible context.

### `ext/skills/src/selection.rs`

`domain_logic` · `request handling`

This file implements the explicit-skill-selection pass that turns user input into a concrete `Vec<SkillCatalogEntry>`. It processes `UserInput` in two stages. First, it scans structured inputs such as `UserInput::Skill` and `UserInput::Mention` with skill-like paths, recording the mentioned names in a `blocked_plain_names` set and selecting matching catalog entries by path. This prevents a later plain-text mention of the same name from adding an unintended duplicate or conflicting match.

Second, it revisits only `UserInput::Text` values and runs `extract_tool_mentions` over the text. Path mentions beginning with `skill://` or ending in `SKILL.md` are normalized and matched against enabled catalog entries by `main_prompt`, package id (`entry.id.0`), or normalized `display_path`. Plain-name mentions are resolved only if their name was not blocked by an explicit structured mention, and only against enabled entries whose `entry.name` matches exactly.

Deduplication is based on `SkillCatalogEntryKey`, which contains the entry’s `SkillAuthority` and `SkillPackageId`; this means multiple path aliases for the same package collapse to one selected entry. The code deliberately ignores disabled entries and non-skill mentions, and it tolerates unrelated `UserInput` variants by skipping them.

#### Function details

##### `collect_explicit_skill_mentions`  (lines 13–68)

```
fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    catalog: &SkillCatalog,
) -> Vec<SkillCatalogEntry>
```

**Purpose**: Scans the full user-input list and returns the enabled catalog entries explicitly referenced by structured skill inputs or text mentions.

**Data flow**: Consumes a slice of `UserInput` plus a `SkillCatalog`. It builds three mutable collections: `selected` for output entries, `seen` for deduplication keys, and `blocked_plain_names` for names already claimed by structured mentions. In the first pass it inspects each input, selecting by path for `UserInput::Skill` and skill-like `UserInput::Mention` values while recording their names as blocked; in the second pass it parses text inputs with `extract_tool_mentions`, resolves skill paths through `normalize_skill_path` and `select_by_path`, resolves plain names against enabled catalog entries unless blocked, and returns the accumulated `Vec<SkillCatalogEntry>`.

**Call relations**: This function is called by `contribute` during turn preparation to determine which skills the user explicitly invoked. It delegates path classification to `path_is_skill`, path cleanup to `normalize_skill_path`, path-based catalog lookup to `select_by_path`, and deduplicated insertion to `push_selected`.

*Call graph*: calls 5 internal fn (extract_tool_mentions, normalize_skill_path, path_is_skill, push_selected, select_by_path); called by 1 (contribute); 2 external calls (new, new).


##### `select_by_path`  (lines 70–82)

```
fn select_by_path(
    catalog: &SkillCatalog,
    path: &str,
    seen: &mut HashSet<SkillCatalogEntryKey>,
    selected: &mut Vec<SkillCatalogEntry>,
)
```

**Purpose**: Finds all enabled catalog entries whose identifiers or display paths match a given skill path and appends them once to the selection.

**Data flow**: Takes the catalog, an input path string, and mutable references to the deduplication set and selected-entry vector. It normalizes the path by stripping the `skill://` prefix when present, iterates enabled catalog entries, checks each with `entry_matches_path`, and forwards matches to `push_selected`.

**Call relations**: It is used from `collect_explicit_skill_mentions` for both structured path inputs and path mentions extracted from free text. Its role is to centralize path matching so all path-based selection follows the same normalization and enabled-entry filtering rules.

*Call graph*: calls 3 internal fn (entry_matches_path, normalize_skill_path, push_selected); called by 1 (collect_explicit_skill_mentions).


##### `push_selected`  (lines 84–93)

```
fn push_selected(
    entry: &SkillCatalogEntry,
    seen: &mut HashSet<SkillCatalogEntryKey>,
    selected: &mut Vec<SkillCatalogEntry>,
)
```

**Purpose**: Adds a catalog entry to the output only if that authority/package pair has not already been selected.

**Data flow**: Receives an entry reference plus mutable `seen` and `selected` collections. It derives a `SkillCatalogEntryKey` from the entry, inserts that key into the `HashSet`, and if insertion succeeds clones the entry into the output vector; otherwise it leaves state unchanged.

**Call relations**: This helper is called from both `collect_explicit_skill_mentions` and `select_by_path` whenever a candidate match is found. It relies on `SkillCatalogEntryKey::from` to define deduplication identity and prevents duplicate output when the same skill is referenced multiple ways.

*Call graph*: calls 1 internal fn (from); called by 2 (collect_explicit_skill_mentions, select_by_path); 1 external calls (clone).


##### `entry_matches_path`  (lines 95–102)

```
fn entry_matches_path(entry: &SkillCatalogEntry, path: &str) -> bool
```

**Purpose**: Tests whether a catalog entry corresponds to a normalized skill path or handle.

**Data flow**: Reads `entry.main_prompt`, `entry.id.0`, and optional `entry.display_path`; if `display_path` exists it normalizes that path before comparison. It returns `true` when any of those identifiers equals the supplied `path` string.

**Call relations**: It is called by `select_by_path` for each enabled entry under consideration. The function encapsulates the accepted path aliases so callers do not need to know whether a path refers to the main prompt resource, package id, or display path.

*Call graph*: called by 1 (select_by_path).


##### `path_is_skill`  (lines 104–110)

```
fn path_is_skill(path: &str) -> bool
```

**Purpose**: Recognizes whether an arbitrary path string should be treated as a skill locator.

**Data flow**: Accepts a path string and returns `true` if it starts with the `skill://` prefix or if its final path segment, split on `/` or `\`, equals `SKILL.md` case-insensitively. It performs no normalization beyond that check.

**Call relations**: This predicate is used by `collect_explicit_skill_mentions` to distinguish skill mentions from other mention paths. It gates whether a structured mention or extracted path should be routed into skill selection logic.

*Call graph*: called by 1 (collect_explicit_skill_mentions).


##### `normalize_skill_path`  (lines 112–114)

```
fn normalize_skill_path(path: &str) -> &str
```

**Purpose**: Removes the synthetic `skill://` prefix from a path when present so matching can compare canonical identifiers.

**Data flow**: Takes a borrowed path string and returns a borrowed subslice: either the original path or the suffix after `SKILL_PATH_PREFIX`. It allocates nothing and does not modify external state.

**Call relations**: It is called from `collect_explicit_skill_mentions` and `select_by_path` before path comparisons. By centralizing prefix stripping, it ensures all path-based matching treats `skill://foo` and `foo` as equivalent.

*Call graph*: called by 2 (collect_explicit_skill_mentions, select_by_path).


##### `SkillCatalogEntryKey::from`  (lines 123–128)

```
fn from(entry: &SkillCatalogEntry) -> Self
```

**Purpose**: Builds the deduplication key used to identify a selected skill independently of how it was mentioned.

**Data flow**: Reads a `SkillCatalogEntry` reference, clones its `authority` and `id` (`SkillPackageId`), and returns a new `SkillCatalogEntryKey` containing those two fields.

**Call relations**: It is invoked by `push_selected` whenever a candidate entry is about to be inserted into the selection set. The resulting key defines the uniqueness boundary for explicit selection across multiple mentions and aliases.

*Call graph*: called by 1 (push_selected).


### `core-skills/src/injection.rs`

`domain_logic` · `request handling`

This file has two closely related responsibilities: selecting which skills were explicitly referenced by the user, and loading the corresponding `SKILL.md` bodies into `SkillInjection` records. `SkillInjections` is the aggregate result type, carrying both successful injections and warning strings for failed reads. `InjectedHostSkillPrompts` is a compatibility shim used to remember host-provided skill prompt paths already injected elsewhere; it stores both raw and normalized path forms so legacy and extension paths compare equal even across `skill://` prefixes and Windows separators.

Mention collection starts in `collect_explicit_skill_mentions`. It first computes duplicate-name counts with disabled skills excluded, then processes structured `UserInput::Skill` entries before free-text `UserInput::Text`. Structured selections are path-resolved and also block later plain-name fallback for the same name, even if the structured path is invalid or disabled. Text scanning uses `extract_tool_mentions`, which recognizes plain `$name` mentions and markdown-style linked mentions like `[$name](path)`. Parsing deliberately ignores common environment variables such as `$PATH`, preserves plugin-style namespaces containing `:`, and records linked resource paths separately from plain names.

Selection is order-preserving with respect to the `skills` slice, not mention order. Exact path mentions win first; only then do unambiguous plain-name matches get added, and only when there is exactly one enabled skill with that name and no connector slug collision. `build_skill_injections` then reads each selected skill’s markdown from either the per-skill filesystem in `SkillLoadOutcome` or `LOCAL_FS`, emits telemetry counters, accumulates `SkillInvocation` analytics events for successful reads, and returns warnings instead of failing the whole batch when individual files cannot be loaded.

#### Function details

##### `InjectedHostSkillPrompts::insert_path`  (lines 43–47)

```
fn insert_path(&mut self, path: impl Into<String>)
```

**Purpose**: Adds a host skill prompt path to the deduplication set in both original and normalized forms. This lets later checks treat `skill://...` and plain filesystem-style references as the same host prompt.

**Data flow**: Takes any `Into<String>` path, converts it to `String`, computes a normalized host-skill form via `normalize_host_skill_path`, and inserts both strings into the internal `HashSet<String>`.

**Call relations**: Called by code that records host prompts already injected for the current turn. It delegates normalization so later `contains_path` checks can match paths regardless of prefix or slash style.

*Call graph*: calls 1 internal fn (normalize_host_skill_path); 1 external calls (into).


##### `InjectedHostSkillPrompts::is_empty`  (lines 49–51)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether any host skill prompt paths have been recorded yet.

**Data flow**: Reads the internal `paths` set and returns `true` when it contains no entries.

**Call relations**: Used by callers deciding whether any extension-side host prompt injection has already happened.


##### `InjectedHostSkillPrompts::contains_path`  (lines 53–55)

```
fn contains_path(&self, path: &str) -> bool
```

**Purpose**: Checks whether a given host skill path has already been recorded, accounting for normalized aliases.

**Data flow**: Reads the provided `&str` and the internal `HashSet<String>`, tests membership against both the raw path and `normalize_host_skill_path(path)`, and returns a boolean.

**Call relations**: Used during duplicate suppression on the legacy injection path. It relies on the same normalization logic used at insertion time.

*Call graph*: calls 1 internal fn (normalize_host_skill_path).


##### `build_skill_injections`  (lines 58–111)

```
async fn build_skill_injections(
    mentioned_skills: &[SkillMetadata],
    loaded_skills: Option<&SkillLoadOutcome>,
    otel: Option<&SessionTelemetry>,
    analytics_client: &AnalyticsEventsClient
```

**Purpose**: Loads the markdown bodies for explicitly mentioned skills and packages them into prompt-ready `SkillInjection` items while collecting warnings and analytics.

**Data flow**: Consumes a slice of `SkillMetadata`, optional `SkillLoadOutcome`, optional `SessionTelemetry`, an `AnalyticsEventsClient`, and tracking context. For each skill it chooses a filesystem from `loaded_skills.file_system_for_skill(skill)` or `LOCAL_FS`, converts the absolute markdown path to `PathUri`, asynchronously reads file text, and on success appends a `SkillInjection` plus a `SkillInvocation`; on failure it appends a formatted warning string. It emits telemetry status counters per skill and finally sends the accumulated invocation list to analytics before returning `SkillInjections`.

**Call relations**: Invoked after mention resolution has already chosen explicit skills. Within its loop it delegates metric emission to `emit_skill_injected_metric`; analytics submission happens once after all reads so successful injections are batched.

*Call graph*: calls 3 internal fn (track_skill_invocations, emit_skill_injected_metric, from_abs_path); 6 external calls (new, with_capacity, is_empty, len, default, format!).


##### `normalize_host_skill_path`  (lines 113–115)

```
fn normalize_host_skill_path(path: &str) -> String
```

**Purpose**: Normalizes a host skill path for deduplication by stripping the skill URI prefix and forcing forward slashes.

**Data flow**: Takes a path string, passes it through `normalize_skill_path`, replaces `\` with `/`, and returns the normalized `String`.

**Call relations**: Used only by `InjectedHostSkillPrompts` methods so host prompt dedupe works across URI and platform path variants.

*Call graph*: calls 1 internal fn (normalize_skill_path); called by 2 (contains_path, insert_path).


##### `emit_skill_injected_metric`  (lines 117–131)

```
fn emit_skill_injected_metric(
    otel: Option<&SessionTelemetry>,
    skill: &SkillMetadata,
    status: &str,
)
```

**Purpose**: Emits the `codex.skill.injected` counter for one skill read attempt when telemetry is available.

**Data flow**: Reads optional `SessionTelemetry`, a `SkillMetadata`, and a status string. If telemetry is present, it increments a counter by 1 with `status` and `skill` attributes; otherwise it returns immediately without side effects.

**Call relations**: Called from `build_skill_injections` on both success and error paths to record per-skill injection outcomes.

*Call graph*: called by 1 (build_skill_injections).


##### `collect_explicit_skill_mentions`  (lines 144–201)

```
fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<AbsolutePathBuf>,
    connector_slug_counts: &HashMap<String, usize>,
) -> Vec<
```

**Purpose**: Resolves explicit skill selections from both structured `UserInput::Skill` entries and textual `$skill` mentions into an ordered, deduplicated `Vec<SkillMetadata>`.

**Data flow**: Consumes user inputs, all available skills, disabled skill paths, and connector slug counts. It first builds enabled-name counts, constructs a `SkillSelectionContext`, then scans structured skill inputs: each valid absolute path blocks plain-name fallback for that name, and matching enabled skills are selected by exact path while updating `seen_names` and `seen_paths`. It then scans text inputs, extracts `ToolMentions` from each text, and passes them plus the evolving seen/block sets into `select_skills_from_mentions`. It returns the accumulated selected skills.

**Call relations**: This is the main entry for explicit mention resolution. It delegates parsing to `extract_tool_mentions` and the actual order-preserving matching rules to `select_skills_from_mentions`.

*Call graph*: calls 3 internal fn (extract_tool_mentions, select_skills_from_mentions, relative_to_current_dir); 3 external calls (new, new, build_skill_name_counts).


##### `ToolMentions::is_empty`  (lines 217–219)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether a parsed mention set contains no names and no linked paths.

**Data flow**: Reads the three internal `HashSet<&str>` collections and returns `true` only if `names`, `paths`, and `plain_names` are all empty in aggregate.

**Call relations**: Used by `select_skills_from_mentions` as a fast exit before building path-match sets or scanning skills.

*Call graph*: called by 1 (select_skills_from_mentions).


##### `ToolMentions::plain_names`  (lines 221–223)

```
fn plain_names(&self) -> impl Iterator<Item = &'a str> + '_
```

**Purpose**: Exposes the subset of mentions that came from plain `$name` syntax rather than linked resource mentions.

**Data flow**: Reads `self.plain_names` and returns an iterator of copied `&str` entries.

**Call relations**: Supports callers that need fallback-by-name behavior distinct from exact linked-path matching.


##### `ToolMentions::paths`  (lines 225–227)

```
fn paths(&self) -> impl Iterator<Item = &'a str> + '_
```

**Purpose**: Exposes the resource paths captured from linked mentions like `[$name](path)`.

**Data flow**: Reads `self.paths` and returns an iterator of copied `&str` entries.

**Call relations**: Consumed by `select_skills_from_mentions` to perform exact path-based skill selection before any plain-name fallback.

*Call graph*: called by 1 (select_skills_from_mentions).


##### `tool_kind_for_path`  (lines 245–257)

```
fn tool_kind_for_path(path: &str) -> ToolMentionKind
```

**Purpose**: Classifies a linked mention path as app, MCP, plugin, skill, or other based on URI prefixes and `SKILL.md` filenames.

**Data flow**: Reads a path string, checks known prefixes in priority order, falls back to `is_skill_filename` for bare file paths, and returns a `ToolMentionKind` enum.

**Call relations**: Used during mention extraction and selection to exclude app/MCP/plugin links from skill-name fallback while still preserving their paths.

*Call graph*: calls 1 internal fn (is_skill_filename).


##### `is_skill_filename`  (lines 259–262)

```
fn is_skill_filename(path: &str) -> bool
```

**Purpose**: Detects whether a path’s last component is `SKILL.md`, case-insensitively.

**Data flow**: Splits the input path on `/` and `\`, takes the final segment, compares it to `SKILL.md` with ASCII case folding, and returns a boolean.

**Call relations**: Serves `tool_kind_for_path` so plain filesystem links to skill docs are treated as skill mentions even without a `skill://` prefix.

*Call graph*: called by 1 (tool_kind_for_path).


##### `app_id_from_path`  (lines 264–267)

```
fn app_id_from_path(path: &str) -> Option<&str>
```

**Purpose**: Extracts the app identifier from an `app://...` mention path.

**Data flow**: Strips the `app://` prefix and returns `Some(&str)` only when the remaining identifier is non-empty.

**Call relations**: A small parser helper for other mention-processing code paths outside this file.


##### `plugin_config_name_from_path`  (lines 269–272)

```
fn plugin_config_name_from_path(path: &str) -> Option<&str>
```

**Purpose**: Extracts the plugin config name from a `plugin://...` mention path.

**Data flow**: Strips the `plugin://` prefix and returns `Some(&str)` only when the remainder is non-empty.

**Call relations**: Another URI helper used by higher-level mention handling outside the explicit skill selector.


##### `normalize_skill_path`  (lines 274–276)

```
fn normalize_skill_path(path: &str) -> &str
```

**Purpose**: Removes the `skill://` prefix from a skill resource path when present.

**Data flow**: Reads a path string and returns either the suffix after `skill://` or the original string unchanged.

**Call relations**: Used by host-path normalization and linked skill path matching so URI-style and raw paths compare consistently.

*Call graph*: called by 1 (normalize_host_skill_path).


##### `extract_tool_mentions`  (lines 283–285)

```
fn extract_tool_mentions(text: &str) -> ToolMentions<'_>
```

**Purpose**: Parses tool mentions from text using the system-wide configured mention sigil.

**Data flow**: Takes a text string, forwards it with `TOOL_MENTION_SIGIL` to `extract_tool_mentions_with_sigil`, and returns the resulting `ToolMentions`.

**Call relations**: This is the normal parser entry used by explicit skill mention collection and related mention-scanning code.

*Call graph*: calls 1 internal fn (extract_tool_mentions_with_sigil); called by 2 (collect_explicit_skill_mentions, collect_explicit_skill_mentions).


##### `extract_tool_mentions_with_sigil`  (lines 287–348)

```
fn extract_tool_mentions_with_sigil(text: &str, sigil: char) -> ToolMentions<'_>
```

**Purpose**: Scans a text buffer for plain and linked tool mentions, collecting names, linked paths, and plain-name-only mentions while filtering out environment-variable false positives.

**Data flow**: Consumes `&str` text and a sigil character. It iterates byte-by-byte through the text, first attempting linked mention parsing when it sees `[`, via `parse_linked_tool_mention`; valid linked mentions add the path and usually the name unless the path is classified as app/MCP/plugin, and common env-var names are skipped entirely. Otherwise when it sees the sigil, it validates mention-name characters with `is_mention_name_char`, extends to the maximal token, and inserts the name into both `names` and `plain_names` unless `is_common_env_var` says to ignore it. It returns a `ToolMentions` struct containing three `HashSet<&str>` collections.

**Call relations**: Called by `extract_tool_mentions` and by other mention collectors that need a custom sigil. It delegates syntax details to `parse_linked_tool_mention`, character validation to `is_mention_name_char`, and env-var suppression to `is_common_env_var`.

*Call graph*: calls 3 internal fn (is_common_env_var, is_mention_name_char, parse_linked_tool_mention); called by 2 (extract_tool_mentions, collect_tool_mentions_from_messages_with_sigil); 2 external calls (new, matches!).


##### `select_skills_from_mentions`  (lines 351–426)

```
fn select_skills_from_mentions(
    selection_context: &SkillSelectionContext<'_>,
    blocked_plain_names: &HashSet<String>,
    mentions: &ToolMentions<'_>,
    seen_names: &mut HashSet<String>,
```

**Purpose**: Adds skills referenced by one parsed mention set into the output list, preserving the original skill ordering and preferring exact linked paths over plain-name fallback.

**Data flow**: Reads a `SkillSelectionContext`, blocked plain names, parsed mentions, and mutable `seen_names`, `seen_paths`, and `selected` accumulators. It first exits if mentions are empty. It then builds a normalized set of linked mention paths excluding app/MCP/plugin resources, scans all skills in order to add exact path matches that are enabled and unseen, and scans all skills again for plain-name matches that are enabled, unseen, not blocked by structured inputs, present in `mentions.plain_names`, unique among enabled skills, and not colliding with connector slugs. Matching skills are cloned into `selected` and recorded in the seen sets.

**Call relations**: Called from `collect_explicit_skill_mentions` once per text input. Its two-pass structure encodes the file’s main selection policy: exact resource links first, then only safe unambiguous plain names.

*Call graph*: calls 2 internal fn (is_empty, paths); called by 1 (collect_explicit_skill_mentions).


##### `parse_linked_tool_mention`  (lines 428–483)

```
fn parse_linked_tool_mention(
    text: &'a str,
    text_bytes: &[u8],
    start: usize,
    sigil: char,
) -> Option<(&'a str, &'a str, usize)>
```

**Purpose**: Parses one markdown-style linked mention beginning at a `[` byte and returns the mention name, linked path, and scan end index when the syntax is valid.

**Data flow**: Consumes the original text, its byte slice, a start index, and the sigil. It verifies the pattern `[$name] (path)` with optional whitespace before `(`, validates mention-name characters, scans until `]` and `)`, trims the path, rejects empty names or paths, and returns `Some((name, path, next_index))` or `None`.

**Call relations**: Used internally by `extract_tool_mentions_with_sigil` to recognize linked mentions before plain sigil scanning, allowing exact path capture and index skipping.

*Call graph*: calls 1 internal fn (is_mention_name_char); called by 1 (extract_tool_mentions_with_sigil).


##### `is_common_env_var`  (lines 485–501)

```
fn is_common_env_var(name: &str) -> bool
```

**Purpose**: Filters out mention-like tokens that are likely shell environment variables rather than tool references.

**Data flow**: Uppercases the input name and matches it against a fixed allowlist of common variables such as `PATH`, `HOME`, `USER`, `TMPDIR`, and `XDG_CONFIG_HOME`, returning `true` for those names.

**Call relations**: Called during mention extraction for both plain and linked mentions so `$PATH`-style text does not accidentally trigger skill selection.

*Call graph*: called by 1 (extract_tool_mentions_with_sigil); 1 external calls (matches!).


##### `text_mentions_skill`  (lines 504–533)

```
fn text_mentions_skill(text: &str, skill_name: &str) -> bool
```

**Purpose**: Test-only helper that checks whether a text contains an exact `$skill_name` mention boundary without parsing the full mention structure.

**Data flow**: Reads the text and target skill name as bytes, scans for `$`, checks whether the following bytes start with the skill name, and returns `true` only if the next byte is absent or not a valid mention-name character.

**Call relations**: Used only by unit tests to validate mention boundary behavior independently of the richer parser.


##### `is_mention_name_char`  (lines 535–537)

```
fn is_mention_name_char(byte: u8) -> bool
```

**Purpose**: Defines the allowed byte set for mention names: ASCII letters, digits, underscore, hyphen, and colon.

**Data flow**: Matches one `u8` against the permitted ranges and punctuation and returns a boolean.

**Call relations**: Shared by plain mention scanning, linked mention parsing, and the test-only boundary checker so all mention syntax uses the same token rules.

*Call graph*: called by 2 (extract_tool_mentions_with_sigil, parse_linked_tool_mention); 1 external calls (matches!).


### `core/src/skills.rs`

`orchestration` · `skill loading and per-command analytics emission`

Most of this file is a façade over `codex_core_skills`, re-exporting the subsystem's public types and helper modules so the rest of the core crate can import them from one place. The local logic is concentrated in two functions. `skills_load_input_from_config` converts the runtime `Config` plus resolved plugin skill roots into a `SkillsLoadInput`, preserving the current working directory, config layer stack, and whether bundled skills are enabled. That keeps the skills loader decoupled from the larger config object.

`maybe_emit_implicit_skill_invocation` is the analytics hook for command-triggered implicit skills. It asks the skills subsystem whether the current command and workdir imply a skill invocation based on the turn's loaded skill outcome. If no candidate is found, it exits immediately. Otherwise it constructs a concrete `SkillInvocation` with `InvocationType::Implicit`, derives a stable deduplication key from scope, path, and skill name, and inserts that key into `turn_context.turn_skills.implicit_invocation_seen_skills` under an async mutex. Only the first insertion per turn proceeds; duplicates are suppressed. For first-time implicit invocations, the function increments the `codex.skill.injected` telemetry counter with tags for status, skill, and invoke type, then sends the invocation to the analytics events client using a tracking context built from model slug, thread id, and sub-id.

#### Function details

##### `skills_load_input_from_config`  (lines 36–46)

```
fn skills_load_input_from_config(
    config: &Config,
    effective_skill_roots: Vec<PluginSkillRoot>,
) -> SkillsLoadInput
```

**Purpose**: Builds the compact `SkillsLoadInput` structure that the skills loader needs from the broader runtime configuration.

**Data flow**: Reads `config.cwd`, `config.config_layer_stack`, and `config.bundled_skills_enabled()`, combines them with `effective_skill_roots: Vec<PluginSkillRoot>`, and returns `SkillsLoadInput::new(...)`.

**Call relations**: Used by higher-level skill-loading orchestration to translate core config state into the shared skills subsystem's input type.

*Call graph*: calls 1 internal fn (new); 1 external calls (bundled_skills_enabled).


##### `maybe_emit_implicit_skill_invocation`  (lines 48–108)

```
async fn maybe_emit_implicit_skill_invocation(
    sess: &Session,
    turn_context: &TurnContext,
    command: &str,
    workdir: &AbsolutePathBuf,
)
```

**Purpose**: Detects whether a command implicitly invoked a skill in the current turn and, if so, emits telemetry and analytics exactly once for that skill/path/scope combination.

**Data flow**: Consumes `sess`, `turn_context`, `command`, and `workdir`; calls `detect_implicit_skill_invocation_for_command` on the turn's skill outcome; if a candidate exists, builds a `SkillInvocation`, maps `SkillScope` to a string, formats a dedupe key from scope/path/name, inserts it into the async-locked `implicit_invocation_seen_skills` set, and if insertion succeeds increments a telemetry counter and calls `analytics_events_client.track_skill_invocations(...)` with a context from `build_track_events_context`.

**Call relations**: Called from command-processing flow after a command is known. It sits between skill detection and analytics transport, suppressing duplicate emissions within a turn.

*Call graph*: 4 external calls (build_track_events_context, detect_implicit_skill_invocation_for_command, format!, vec!).


### `core-skills/src/render.rs`

`domain_logic` · `prompt assembly before a turn starts`

This file contains the full prompt-rendering policy for skills. It defines the static instructional text shown to the model, the `SkillMetadataBudget` abstraction for token- or character-based limits, the `AvailableSkills` output bundle, and `SkillRenderReport` metrics describing how many skills were included, omitted, or had descriptions truncated.

The main entrypoint, `build_available_skills`, starts from `SkillLoadOutcome::allowed_skills_for_implicit_invocation()`. It first renders absolute paths, then—only if the absolute rendering had omissions or truncation—tries an alias-based plan that introduces a `### Skill roots` table and shorter `rN/...` paths. It chooses the better rendering by comparing included count, truncation amount, and total cost. Rendering itself is budget-aware in three tiers: include full lines if everything fits; otherwise include all skills with descriptions truncated fairly across skills one character at a time; otherwise drop all descriptions and include only as many minimum lines as fit, preserving prompt priority order by `SkillScope` (`System`, `Admin`, `Repo`, `User`) and then name/path.

Alias planning is specialized for plugin cache layouts: it can alias either exact skill roots or a broader plugin marketplace root depending on whether multiple skills share a plugin-version base. Path shortening is only used when the alias table overhead is worth it. The file also records telemetry histograms at thread start and logs when metadata had to be truncated. Extensive tests lock down subtle invariants such as complete-read instructions, fair truncation, omission behavior after oversized entries, and plugin-root alias selection.

#### Function details

##### `render_available_skills_body`  (lines 62–84)

```
fn render_available_skills_body(skill_root_lines: &[String], skill_lines: &[String]) -> String
```

**Purpose**: Builds the final markdown body for the skills prompt section, including intro text, optional skill-root aliases, the available-skill list, and the usage instructions block.

**Data flow**: It takes pre-rendered `skill_root_lines` and `skill_lines`, pushes fixed headings and one of two intro/how-to-use constant strings into a `Vec<String>`, conditionally inserts the `### Skill roots` section when aliases exist, joins everything with newlines, and returns the resulting `String` wrapped with leading and trailing newlines.

**Call relations**: This is a formatting helper used when computing alias-table overhead, so the renderer can compare the cost of aliased versus absolute metadata layouts.

*Call graph*: called by 1 (aliased_metadata_overhead_cost); 2 external calls (new, format!).


##### `SkillMetadataBudget::limit`  (lines 93–97)

```
fn limit(self) -> usize
```

**Purpose**: Returns the numeric budget limit regardless of whether the budget is token-based or character-based.

**Data flow**: It matches `self` and extracts the contained `usize` from either `Tokens` or `Characters`. It returns that value and has no side effects.

**Call relations**: Budget-sensitive rendering code calls this repeatedly when deciding whether full lines, truncated lines, or minimum lines fit.

*Call graph*: called by 3 (build_aliased_available_skills, render_minimum_skill_lines_until_budget, render_skill_lines_from_lines).


##### `SkillMetadataBudget::cost`  (lines 99–104)

```
fn cost(self, text: &str) -> usize
```

**Purpose**: Measures the cost of a text string under the current budget mode.

**Data flow**: It takes `self` and `&str`; for `Tokens` it calls `approx_token_count(text)`, and for `Characters` it counts Unicode scalar values with `text.chars().count()`. It returns the computed `usize` cost.

**Call relations**: This is the primitive cost function used by line-cost and alias-overhead calculations.

*Call graph*: called by 2 (aliased_metadata_overhead_cost, line_cost); 1 external calls (approx_token_count).


##### `SkillMetadataBudget::cost_from_counts`  (lines 106–111)

```
fn cost_from_counts(self, chars: usize, bytes: usize) -> usize
```

**Purpose**: Computes cost from precomputed character and byte counts, avoiding repeated string construction during incremental description budgeting.

**Data flow**: It takes `chars` and `bytes` counts. In character mode it returns `chars`; in token mode it estimates tokens from bytes via `approx_token_count_from_bytes`. It returns a `usize` and does not mutate state.

**Call relations**: This supports `DescriptionBudgetLine::new`, which precomputes the incremental cost of adding each description character.

*Call graph*: calls 1 internal fn (approx_token_count_from_bytes); called by 1 (new).


##### `approx_token_count_from_bytes`  (lines 114–116)

```
fn approx_token_count_from_bytes(bytes: usize) -> usize
```

**Purpose**: Approximates token count from byte length using a fixed bytes-per-token heuristic with saturation.

**Data flow**: It takes a byte count, adds `APPROX_BYTES_PER_TOKEN - 1` with saturation, divides by `APPROX_BYTES_PER_TOKEN`, and returns the rounded-up estimate.

**Call relations**: This is the token-mode backend for `SkillMetadataBudget::cost_from_counts`.

*Call graph*: called by 1 (cost_from_counts).


##### `default_skill_metadata_budget`  (lines 143–158)

```
fn default_skill_metadata_budget(context_window: Option<i64>) -> SkillMetadataBudget
```

**Purpose**: Chooses the default skills metadata budget from an optional model context-window size, using 2% of the window in token mode or a fixed character fallback.

**Data flow**: It takes `Option<i64>`, attempts a positive `usize` conversion, computes `window * 2 / 100` with saturation and a minimum of 1 token when successful, otherwise falls back to `SkillMetadataBudget::Characters(DEFAULT_SKILL_METADATA_CHAR_BUDGET)`. It returns the selected `SkillMetadataBudget`.

**Call relations**: Callers use this to derive a rendering budget before invoking the main available-skills renderer.

*Call graph*: 1 external calls (Characters).


##### `build_available_skills`  (lines 160–200)

```
fn build_available_skills(
    outcome: &SkillLoadOutcome,
    budget: SkillMetadataBudget,
    side_effects: SkillRenderSideEffects<'_>,
) -> Option<AvailableSkills>
```

**Purpose**: Produces the best model-visible rendering of implicitly invocable skills under a budget, optionally recording telemetry side effects.

**Data flow**: It reads the `SkillLoadOutcome`, obtains `allowed_skills_for_implicit_invocation`, returns `None` after recording zero-valued side effects if no skills remain, otherwise renders an absolute-path version, optionally renders an aliased-path version when the absolute one had pressure, compares them with `aliased_render_is_better`, records telemetry/logging for the selected result, and returns `Some(AvailableSkills)`.

**Call relations**: This is the top-level rendering orchestrator. It delegates line rendering, alias planning, comparison, and side-effect emission to specialized helpers.

*Call graph*: calls 7 internal fn (allowed_skills_for_implicit_invocation, aliased_render_is_better, build_aliased_available_skills, build_available_skills_from_lines, ordered_absolute_skill_lines, record_available_skills_side_effects, record_skill_render_side_effects); called by 2 (outcome_rendering_omits_aliases_when_absolute_plan_has_no_budget_pressure, outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit); 1 external calls (default).


##### `build_available_skills_from_lines`  (lines 202–251)

```
fn build_available_skills_from_lines(
    skill_lines: Vec<SkillLine<'_>>,
    total_count: usize,
    budget: SkillMetadataBudget,
    path_aliases: SkillPathAliases,
) -> Option<AvailableSkills>
```

**Purpose**: Turns already-ordered `SkillLine` values into an `AvailableSkills` bundle with rendered lines, a report, and any warning message.

**Data flow**: It takes owned `skill_lines`, `total_count`, a budget, and `SkillPathAliases`. If `total_count` is zero it returns `None`; otherwise it calls `render_skill_lines_from_lines`, inspects the resulting `SkillRenderReport`, constructs either an omission warning or a truncation warning when thresholds are exceeded, and returns `Some(AvailableSkills)` containing the alias table, rendered lines, report, and optional warning.

**Call relations**: Both absolute-path and alias-path rendering paths funnel through this helper after they have decided what path strings to use.

*Call graph*: calls 1 internal fn (render_skill_lines_from_lines); called by 3 (build_aliased_available_skills, build_available_skills, build_available_skills_from_metadata); 1 external calls (format!).


##### `record_available_skills_side_effects`  (lines 253–277)

```
fn record_available_skills_side_effects(
    available: &AvailableSkills,
    budget: SkillMetadataBudget,
    side_effects: SkillRenderSideEffects<'_>,
)
```

**Purpose**: Emits telemetry for a completed render and logs an informational truncation event when metadata had to be shortened or omitted.

**Data flow**: It reads the `AvailableSkills.report`, forwards the counts to `record_skill_render_side_effects`, and if omissions or truncation occurred it writes a structured `tracing::info!` log containing budget limit and truncation statistics. It returns nothing.

**Call relations**: This is called only by `build_available_skills` after the final absolute-vs-aliased selection has been made.

*Call graph*: calls 1 internal fn (record_skill_render_side_effects); called by 1 (build_available_skills); 1 external calls (info!).


##### `budget_warning_prefix`  (lines 279–288)

```
fn budget_warning_prefix(budget: SkillMetadataBudget, prefix: &str) -> String
```

**Purpose**: Adjusts the omission-warning prefix text to mention the 2% budget when the renderer is operating in token mode.

**Data flow**: It takes a `SkillMetadataBudget` and a prefix string. In token mode it replaces the first occurrence of `Exceeded skills context budget.` with `Exceeded skills context budget of 2%.`; in character mode it returns the prefix unchanged as an owned `String`.

**Call relations**: This helper is used when constructing omission warnings in `build_available_skills_from_lines`.


##### `record_skill_render_side_effects`  (lines 290–322)

```
fn record_skill_render_side_effects(
    side_effects: SkillRenderSideEffects<'_>,
    total_count: usize,
    included_count: usize,
    omitted_count: usize,
    truncated_description_chars: usize,
```

**Purpose**: Records histogram metrics about skill rendering when side effects are enabled, or does nothing when rendering is side-effect-free.

**Data flow**: It takes the side-effect mode plus total, included, omitted, and truncated-character counts. In `None` mode it returns immediately; in `ThreadStart` mode it writes four histograms to `SessionTelemetry`, converting counts to `i64` with saturation fallback to `i64::MAX`.

**Call relations**: This is the low-level telemetry sink used directly for the empty-skills case and indirectly for normal renders via `record_available_skills_side_effects`.

*Call graph*: called by 2 (build_available_skills, record_available_skills_side_effects); 1 external calls (try_from).


##### `render_skill_lines_from_lines`  (lines 324–379)

```
fn render_skill_lines_from_lines(
    skill_lines: Vec<SkillLine<'_>>,
    total_count: usize,
    budget: SkillMetadataBudget,
) -> (Vec<String>, SkillRenderReport)
```

**Purpose**: Chooses among full, truncated, or minimum-only rendering strategies for a set of skill lines under the given budget.

**Data flow**: It takes owned `SkillLine` values, computes the total full-line cost, and if that fits returns all `render_full()` strings with a zero-truncation report. Otherwise it computes the total minimum-line cost; if that fits, it allocates the remaining budget across descriptions with `render_lines_with_description_budget`, sums truncation stats, and returns all lines with partial descriptions. If even minimum lines do not fit, it delegates to `render_minimum_skill_lines_until_budget`.

**Call relations**: This is the core budget decision point used by `build_available_skills_from_lines`.

*Call graph*: calls 5 internal fn (limit, render_lines_with_description_budget, render_minimum_skill_lines_until_budget, skill_render_report, sum_description_truncation); called by 1 (build_available_skills_from_lines).


##### `render_minimum_skill_lines_until_budget`  (lines 381–417)

```
fn render_minimum_skill_lines_until_budget(
    budget: SkillMetadataBudget,
    skill_lines: Vec<SkillLine<'_>>,
    total_count: usize,
) -> (Vec<String>, SkillRenderReport)
```

**Purpose**: Renders only minimum-form skill lines and includes as many as fit, counting all omitted descriptions as fully truncated.

**Data flow**: It takes a budget, owned `SkillLine` values, and `total_count`. It iterates in order, accumulates `used` cost, pushes `render_minimum()` for lines that still fit, increments `omitted_count` for those that do not, and separately accumulates each line's full description character count into truncation totals. It returns the included lines and a `SkillRenderReport`.

**Call relations**: This is the fallback path from `render_skill_lines_from_lines` when even description-free lines exceed the budget.

*Call graph*: calls 2 internal fn (limit, skill_render_report); called by 1 (render_skill_lines_from_lines); 1 external calls (new).


##### `skill_render_report`  (lines 419–433)

```
fn skill_render_report(
    total_count: usize,
    included_count: usize,
    omitted_count: usize,
    truncated_description_chars: usize,
    truncated_description_count: usize,
) -> SkillRenderRep
```

**Purpose**: Constructs a `SkillRenderReport` from explicit count values.

**Data flow**: It takes the five report fields as arguments and returns a `SkillRenderReport` struct literal. It reads and writes no external state.

**Call relations**: This small constructor is used by both rendering branches that need to package counts consistently.

*Call graph*: called by 2 (render_minimum_skill_lines_until_budget, render_skill_lines_from_lines).


##### `SkillRenderReport::average_truncated_description_chars`  (lines 436–444)

```
fn average_truncated_description_chars(&self) -> usize
```

**Purpose**: Computes the average number of truncated description characters per total skill, rounded up by integer arithmetic.

**Data flow**: It reads `self.total_count` and `self.truncated_description_chars`. If either is zero it returns 0; otherwise it computes `(truncated + total_count - 1) / total_count` with saturation. It has no side effects.

**Call relations**: This value is used to decide whether truncation is severe enough to warrant a warning and is also logged in truncation events.


##### `sum_description_truncation`  (lines 464–477)

```
fn sum_description_truncation(rendered: &[RenderedSkillLine]) -> (usize, usize)
```

**Purpose**: Aggregates total truncated characters and the number of lines that were actually truncated from a rendered-line list.

**Data flow**: It iterates over `RenderedSkillLine` items, summing `truncated_chars` and counting only entries where that value is nonzero. It returns a `(usize, usize)` pair of total chars and truncated-line count.

**Call relations**: This helper is used after partial-description rendering to populate the final report.

*Call graph*: called by 1 (render_skill_lines_from_lines); 1 external calls (iter).


##### `SkillLine::new`  (lines 480–485)

```
fn new(skill: &'a SkillMetadata) -> Self
```

**Purpose**: Builds a renderable skill line using the skill's absolute `SKILL.md` path normalized to forward slashes.

**Data flow**: It takes `&SkillMetadata`, converts `path_to_skills_md` to a lossy string with backslashes replaced by `/`, and forwards the skill plus that path string to `SkillLine::with_path`. It returns the new `SkillLine`.

**Call relations**: Absolute-path rendering and many tests use this constructor as the standard line representation.

*Call graph*: called by 6 (budgeted_rendering_does_not_warn_when_average_description_truncation_is_within_threshold, budgeted_rendering_redistributes_unused_description_budget, budgeted_rendering_token_budget_truncation_warning_mentions_two_percent, budgeted_rendering_truncates_descriptions_equally_before_omitting_skills, budgeted_rendering_warns_when_average_description_truncation_exceeds_threshold, expected_skill_line); 1 external calls (with_path).


##### `SkillLine::with_path`  (lines 487–493)

```
fn with_path(skill: &'a SkillMetadata, path: String) -> Self
```

**Purpose**: Builds a renderable skill line from borrowed skill metadata and an explicit path string.

**Data flow**: It takes `&SkillMetadata` and an owned `String` path, borrows `name` and `description` from the skill, stores them with the path, and returns `SkillLine<'a>`.

**Call relations**: This is used both by absolute rendering and by alias rendering after a shortened path has been computed.


##### `SkillLine::full_cost`  (lines 495–497)

```
fn full_cost(&self, budget: SkillMetadataBudget) -> usize
```

**Purpose**: Computes the budget cost of rendering this skill line with its full description.

**Data flow**: It renders the full line string with `render_full()`, passes that to `line_cost`, and returns the resulting `usize` cost.

**Call relations**: This feeds the first-fit check in `render_skill_lines_from_lines`.

*Call graph*: calls 2 internal fn (render_full, line_cost).


##### `SkillLine::minimum_cost`  (lines 499–501)

```
fn minimum_cost(&self, budget: SkillMetadataBudget) -> usize
```

**Purpose**: Computes the budget cost of rendering this skill line with an empty description.

**Data flow**: It renders the minimum line string with `render_minimum()`, passes that to `line_cost`, and returns the resulting `usize` cost.

**Call relations**: This feeds both the all-minimum-fit check and the omission fallback path.

*Call graph*: calls 2 internal fn (render_minimum, line_cost).


##### `SkillLine::description_char_count`  (lines 503–505)

```
fn description_char_count(&self) -> usize
```

**Purpose**: Returns the number of Unicode scalar values in the skill description.

**Data flow**: It reads `self.description`, counts `chars()`, and returns the `usize` count.

**Call relations**: This is used when precomputing incremental description costs and when accounting for truncation.

*Call graph*: called by 1 (new).


##### `SkillLine::render_full`  (lines 507–509)

```
fn render_full(&self) -> String
```

**Purpose**: Renders the line with the complete description included.

**Data flow**: It passes `self.description` to `render_with_description` and returns the resulting formatted string.

**Call relations**: This is used for full-cost calculation and for the no-truncation rendering path.

*Call graph*: calls 1 internal fn (render_with_description); called by 1 (full_cost).


##### `SkillLine::render_minimum`  (lines 511–513)

```
fn render_minimum(&self) -> String
```

**Purpose**: Renders the line with no description text, leaving only the name and file path.

**Data flow**: It calls `render_with_description("")` and returns the formatted string.

**Call relations**: This is used for minimum-cost calculation, omission fallback rendering, and incremental budget precomputation.

*Call graph*: calls 1 internal fn (render_with_description); called by 2 (new, minimum_cost).


##### `SkillLine::rendered_description_prefix_len`  (lines 515–520)

```
fn rendered_description_prefix_len(&self, description_chars: usize) -> usize
```

**Purpose**: Translates a character-count prefix of the description into the corresponding byte index for safe string slicing.

**Data flow**: It walks `self.description.char_indices()`, finds the byte index of the `description_chars`th character, and returns either that index or the full byte length if the requested prefix reaches the end.

**Call relations**: This helper is used by `render_with_description_chars` so truncation can slice UTF-8 strings at character boundaries.

*Call graph*: called by 1 (render_with_description_chars).


##### `SkillLine::render_with_description_chars`  (lines 522–530)

```
fn render_with_description_chars(&self, description_chars: usize) -> String
```

**Purpose**: Renders the line with only the first `description_chars` characters of the description.

**Data flow**: It takes a character count, returns the minimum form when the count is zero, otherwise computes the byte end index with `rendered_description_prefix_len`, slices the description safely, formats the line, and returns the resulting `String`.

**Call relations**: This is the final rendering primitive used by the fair description-budget allocator.

*Call graph*: calls 1 internal fn (rendered_description_prefix_len); 1 external calls (format!).


##### `SkillLine::render_with_description`  (lines 532–538)

```
fn render_with_description(&self, description: &str) -> String
```

**Purpose**: Formats a skill line from the name, an arbitrary description string, and the stored path.

**Data flow**: It takes `&str description`; if empty it formats `- name: (file: path)`, otherwise `- name: description (file: path)`. It returns the formatted `String`.

**Call relations**: Both full and minimum rendering delegate here to keep line formatting consistent.

*Call graph*: called by 2 (render_full, render_minimum); 1 external calls (format!).


##### `DescriptionBudgetLine::new`  (lines 542–570)

```
fn new(line: &'a SkillLine<'a>, budget: SkillMetadataBudget) -> Self
```

**Purpose**: Precomputes the incremental budget cost of adding each successive description character to a minimum-form skill line.

**Data flow**: It takes a borrowed `SkillLine` and a budget, renders the minimum line, computes its character and byte counts including a trailing newline, derives the minimum cost, counts the full description length, then iterates each description character accumulating prefix chars/bytes and storing the extra cost beyond the minimum in `extra_costs`. It returns a `DescriptionBudgetLine` containing the original line reference, total description length, and the per-prefix cost table.

**Call relations**: This precomputation is used by `render_lines_with_description_budget` so it can allocate description characters fairly without repeatedly rebuilding strings.

*Call graph*: calls 3 internal fn (description_char_count, render_minimum, cost_from_counts); 1 external calls (with_capacity).


##### `line_cost`  (lines 573–575)

```
fn line_cost(budget: SkillMetadataBudget, line: &str) -> usize
```

**Purpose**: Computes the budget cost of one rendered line including its trailing newline.

**Data flow**: It takes a budget and a line string, appends `\n` via formatting, passes the result to `SkillMetadataBudget::cost`, and returns the `usize` cost.

**Call relations**: This helper underlies both full and minimum line cost calculations and total line-cost aggregation.

*Call graph*: calls 1 internal fn (cost); called by 2 (full_cost, minimum_cost); 1 external calls (format!).


##### `lines_cost`  (lines 577–581)

```
fn lines_cost(budget: SkillMetadataBudget, lines: &[String]) -> usize
```

**Purpose**: Computes the total budget cost of a slice of rendered lines.

**Data flow**: It iterates over `&[String]`, sums `line_cost` for each line with saturation, and returns the total `usize`.

**Call relations**: This is used when comparing aliased and absolute renderings by total metadata cost.

*Call graph*: called by 1 (available_skills_cost).


##### `render_lines_with_description_budget`  (lines 583–636)

```
fn render_lines_with_description_budget(
    budget: SkillMetadataBudget,
    skill_lines: &[SkillLine<'_>],
    limit: usize,
) -> Vec<RenderedSkillLine>
```

**Purpose**: Allocates a shared description budget across all skills one character at a time, producing partially truncated lines that use leftover capacity efficiently.

**Data flow**: It takes a budget, borrowed `SkillLine` slice, and an extra-cost limit beyond minimum lines. It converts each line into a `DescriptionBudgetLine`, initializes per-line character allocations and current costs to zero, then loops round-robin over lines, granting one more description character whenever that character's incremental cost fits in `remaining`. When no line can accept another character, it renders each line with its allocated prefix and records how many characters were truncated. It returns `Vec<RenderedSkillLine>`.

**Call relations**: This is the middle rendering strategy selected by `render_skill_lines_from_lines` when all skills fit only if descriptions are shortened.

*Call graph*: called by 1 (render_skill_lines_from_lines); 2 external calls (iter, vec!).


##### `build_aliased_available_skills`  (lines 638–659)

```
fn build_aliased_available_skills(
    outcome: &SkillLoadOutcome,
    skills: &[SkillMetadata],
    budget: SkillMetadataBudget,
) -> Option<AvailableSkills>
```

**Purpose**: Attempts to render available skills using a skill-root alias table and shortened `rN/...` paths so more metadata can fit within the same budget.

**Data flow**: It takes the `SkillLoadOutcome`, the filtered skill slice, and a budget. It builds an alias plan, rejects aliasing if the alias table alone consumes the whole budget, subtracts the table cost to form an adjusted budget of the same mode, orders skills, renders each path through `render_skill_path_with_aliases`, and delegates to `build_available_skills_from_lines` with the alias table metadata.

**Call relations**: This is the alternative rendering path tried by `build_available_skills` only when the absolute-path render showed budget pressure.

*Call graph*: calls 4 internal fn (limit, build_alias_plan, build_available_skills_from_lines, ordered_skills_for_budget); called by 2 (build_available_skills, outcome_rendering_counts_plugin_version_skills_before_budget_omission); 3 external calls (len, Characters, Tokens).


##### `build_alias_plan`  (lines 673–736)

```
fn build_alias_plan(
    outcome: &SkillLoadOutcome,
    skills: &[SkillMetadata],
    budget: SkillMetadataBudget,
) -> Option<AliasPlan>
```

**Purpose**: Constructs the alias table and path-mapping plan for a specific outcome/skill subset, including the overhead cost of introducing aliases.

**Data flow**: It collects the selected skill paths into a `HashSet`, filters `outcome.skill_root_by_path` down to those paths, derives the ordered list of used roots from `outcome.skill_roots`, returns `None` if no roots are used, counts how many selected skills belong to each plugin-version base, chooses an alias root for each skill root, deduplicates alias roots in order, assigns aliases `r0`, `r1`, ... , builds the reverse path-to-alias-root map, renders the `skill_root_lines`, computes alias-table overhead cost, and returns an `AliasPlan` containing all of that state.

**Call relations**: Alias rendering depends on this plan; tests also call it directly to verify plugin-root selection and budget accounting.

*Call graph*: calls 4 internal fn (aliased_metadata_overhead_cost, build_skill_root_lines, ordered_alias_roots, plugin_version_skill_counts_for_skill_roots); called by 8 (build_aliased_available_skills, outcome_rendering_counts_plugin_version_skills_before_budget_omission, outcome_rendering_extracts_plugin_marketplace_root_for_multiple_plugins, outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit, outcome_rendering_uses_each_skill_root_for_multiple_roots_in_one_plugin_version, outcome_rendering_uses_marketplace_root_for_single_skill_plugin_versions, outcome_rendering_uses_one_marketplace_root_for_multiple_plugin_versions, outcome_rendering_uses_skill_root_for_multiple_skills_in_one_plugin_version); 1 external calls (iter).


##### `ordered_alias_roots`  (lines 738–751)

```
fn ordered_alias_roots(
    used_roots: &[AbsolutePathBuf],
    alias_root_by_skill_root: &HashMap<AbsolutePathBuf, AbsolutePathBuf>,
) -> Option<Vec<AbsolutePathBuf>>
```

**Purpose**: Deduplicates alias roots while preserving the order of the original used roots.

**Data flow**: It takes the ordered `used_roots` slice and a map from skill root to alias root, walks the roots in order, looks up each alias root, inserts unseen ones into a `HashSet`, pushes first occurrences into a `Vec`, and returns `Some(Vec<AbsolutePathBuf>)` or `None` if any lookup is missing.

**Call relations**: This helper is part of alias-plan construction, ensuring stable alias numbering based on root discovery order.

*Call graph*: called by 1 (build_alias_plan); 2 external calls (new, new).


##### `alias_root_for_skill_root`  (lines 753–769)

```
fn alias_root_for_skill_root(
    root: &AbsolutePathBuf,
    plugin_version_skill_counts: &HashMap<AbsolutePathBuf, usize>,
) -> AbsolutePathBuf
```

**Purpose**: Chooses whether a skill root should alias to itself or to a broader plugin marketplace base, depending on how many selected skills share the same plugin-version base.

**Data flow**: It takes a skill root and the precomputed `plugin_version_skill_counts`. If the root is not under a recognized plugin-version layout it returns the root unchanged. Otherwise it looks up how many selected skills share that plugin-version base; when more than one skill is present it keeps the root itself, and when only one is present it prefers the broader marketplace base if available, falling back to the root.

**Call relations**: This decision function is used during alias-plan construction to trade off shorter path suffixes against alias-table breadth.

*Call graph*: calls 3 internal fn (plugin_marketplace_base, plugin_version_base, as_path); 1 external calls (clone).


##### `plugin_version_skill_counts_for_skill_roots`  (lines 771–782)

```
fn plugin_version_skill_counts_for_skill_roots(
    skill_roots: impl Iterator<Item = &'a AbsolutePathBuf>,
) -> HashMap<AbsolutePathBuf, usize>
```

**Purpose**: Counts how many selected skill roots fall under each plugin-version base path.

**Data flow**: It iterates the provided skill-root iterator, derives `plugin_version_base` for each root when possible, increments a `HashMap<AbsolutePathBuf, usize>` counter for that base, and returns the completed map.

**Call relations**: These counts inform `alias_root_for_skill_root` so aliasing can distinguish single-skill and multi-skill plugin versions.

*Call graph*: calls 1 internal fn (plugin_version_base); called by 1 (build_alias_plan); 1 external calls (new).


##### `aliased_metadata_overhead_cost`  (lines 784–794)

```
fn aliased_metadata_overhead_cost(
    budget: SkillMetadataBudget,
    skill_root_lines: &[String],
) -> usize
```

**Purpose**: Measures the extra budget consumed by introducing the alias-table framing compared with an absolute-path rendering that has no alias section.

**Data flow**: It renders an empty-body absolute skills section and an empty-body aliased skills section using `render_available_skills_body`, computes each body's cost under the given budget mode, subtracts the absolute cost from the aliased cost with saturation, and returns the overhead `usize`.

**Call relations**: This cost is used both when building alias plans and when comparing the total cost of aliased versus absolute renderings.

*Call graph*: calls 2 internal fn (cost, render_available_skills_body); called by 2 (available_skills_cost, build_alias_plan).


##### `build_skill_root_lines`  (lines 796–805)

```
fn build_skill_root_lines(roots: &[AbsolutePathBuf]) -> Vec<String>
```

**Purpose**: Formats the alias table lines that map `rN` aliases to absolute root paths.

**Data flow**: It takes an ordered slice of roots, enumerates them, normalizes each path to forward slashes, formats lines like ``- `r0` = `/abs/root````, and returns the resulting `Vec<String>`.

**Call relations**: Alias-plan construction uses this to produce the `### Skill roots` section shown in aliased renderings.

*Call graph*: called by 1 (build_alias_plan); 1 external calls (iter).


##### `plugin_marketplace_base`  (lines 807–818)

```
fn plugin_marketplace_base(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the plugin marketplace base directory for a path inside a `plugins/cache/...` tree.

**Data flow**: It walks upward from the provided `&Path`, checking each parent chain for a directory whose parent is named `plugins` and whose own name is `cache`. When found, it converts the current candidate path into an `AbsolutePathBuf` and returns it; otherwise it returns `None`.

**Call relations**: This path-analysis helper is used directly when choosing alias roots and indirectly by `plugin_version_base`.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (alias_root_for_skill_root, plugin_version_base).


##### `plugin_version_base`  (lines 820–835)

```
fn plugin_version_base(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Extracts the `<marketplace>/<plugin>/<version>` base path from a skill root inside the plugin cache layout.

**Data flow**: It first finds the marketplace base with `plugin_marketplace_base`, strips that prefix from the input path, reads the first two normal path components as plugin and version, joins them back onto the marketplace base, converts the result to `AbsolutePathBuf`, and returns it or `None` if the layout does not match.

**Call relations**: This helper supports both plugin-version counting and alias-root selection.

*Call graph*: calls 2 internal fn (plugin_marketplace_base, from_absolute_path); called by 2 (alias_root_for_skill_root, plugin_version_skill_counts_for_skill_roots); 1 external calls (strip_prefix).


##### `render_skill_path_with_aliases`  (lines 837–840)

```
fn render_skill_path_with_aliases(skill: &SkillMetadata, plan: &AliasPlan) -> String
```

**Purpose**: Renders a skill path using aliases when possible, otherwise falling back to the normalized absolute path.

**Data flow**: It takes a `SkillMetadata` and an `AliasPlan`, tries `outcome_relative_skill_path`, and if that returns `None` converts `path_to_skills_md` to a forward-slash absolute string. It returns the chosen path string.

**Call relations**: Alias rendering uses this for each skill after the alias plan has been built.

*Call graph*: calls 1 internal fn (outcome_relative_skill_path).


##### `outcome_relative_skill_path`  (lines 842–852)

```
fn outcome_relative_skill_path(skill: &SkillMetadata, plan: &AliasPlan) -> Option<String>
```

**Purpose**: Computes the `rN/...` relative path for a skill under a given alias plan.

**Data flow**: It looks up the alias root for `skill.path_to_skills_md`, then the alias label for that root, strips the alias root prefix from the absolute skill path, normalizes the remainder to forward slashes, formats `{alias}/{relative_path}`, and returns it as `Some(String)`. Any missing mapping or failed prefix strip yields `None`.

**Call relations**: This is the internal path-conversion helper used by `render_skill_path_with_aliases`.

*Call graph*: called by 1 (render_skill_path_with_aliases); 1 external calls (format!).


##### `aliased_render_is_better`  (lines 854–867)

```
fn aliased_render_is_better(
    aliased: &AvailableSkills,
    absolute: &AvailableSkills,
    budget: SkillMetadataBudget,
) -> bool
```

**Purpose**: Compares aliased and absolute renderings to decide which one is preferable under the current budget.

**Data flow**: It reads both `AvailableSkills.report` values and first prefers the render with more included skills, then the one with fewer truncated description characters, and finally the one with lower total cost as computed by `available_skills_cost`. It returns a boolean indicating whether the aliased render wins.

**Call relations**: This comparison is used by `build_available_skills` after both candidate renderings have been produced.

*Call graph*: calls 1 internal fn (available_skills_cost); called by 1 (build_available_skills).


##### `available_skills_cost`  (lines 869–876)

```
fn available_skills_cost(budget: SkillMetadataBudget, available: &AvailableSkills) -> usize
```

**Purpose**: Computes the total budget cost of an `AvailableSkills` rendering, including alias-table overhead when present.

**Data flow**: It takes a budget and an `AvailableSkills`, computes alias metadata overhead if `skill_root_lines` is non-empty, adds the cost of all rendered skill lines via `lines_cost`, and returns the total `usize`.

**Call relations**: This helper is used only for tie-breaking in `aliased_render_is_better`.

*Call graph*: calls 2 internal fn (aliased_metadata_overhead_cost, lines_cost); called by 1 (aliased_render_is_better).


##### `ordered_absolute_skill_lines`  (lines 878–883)

```
fn ordered_absolute_skill_lines(skills: &[SkillMetadata]) -> Vec<SkillLine<'_>>
```

**Purpose**: Orders skills by prompt priority and converts them into absolute-path `SkillLine` values.

**Data flow**: It takes a skill slice, obtains ordered references from `ordered_skills_for_budget`, maps each to `SkillLine::new`, and returns the resulting vector.

**Call relations**: Absolute rendering paths use this as their starting point.

*Call graph*: calls 1 internal fn (ordered_skills_for_budget); called by 2 (build_available_skills, build_available_skills_from_metadata).


##### `ordered_skills_for_budget`  (lines 885–894)

```
fn ordered_skills_for_budget(skills: &[SkillMetadata]) -> Vec<&SkillMetadata>
```

**Purpose**: Sorts skills into the order used for budget decisions and omission priority.

**Data flow**: It collects borrowed skills into a vector and sorts them by `prompt_scope_rank(scope)`, then by `name`, then by `path_to_skills_md`. It returns `Vec<&SkillMetadata>`.

**Call relations**: Both absolute and aliased rendering rely on this ordering so truncation and omission preserve prompt-priority semantics.

*Call graph*: called by 2 (build_aliased_available_skills, ordered_absolute_skill_lines); 1 external calls (iter).


##### `prompt_scope_rank`  (lines 896–903)

```
fn prompt_scope_rank(scope: SkillScope) -> u8
```

**Purpose**: Assigns a numeric priority rank to `SkillScope` values for rendering order.

**Data flow**: It matches the `SkillScope` argument and returns `0` for `System`, `1` for `Admin`, `2` for `Repo`, and `3` for `User`.

**Call relations**: This ranking function is used by `ordered_skills_for_budget` to ensure higher-priority scopes survive tighter budgets first.


##### `tests::make_skill`  (lines 915–927)

```
fn make_skill(name: &str, scope: SkillScope) -> SkillMetadata
```

**Purpose**: Creates a minimal `SkillMetadata` test fixture with a predictable `/tmp/<name>/SKILL.md` path and default optional fields.

**Data flow**: It takes a name and scope, constructs strings and a test absolute path, fills a `SkillMetadata` struct with `description = "desc"` and `None` for optional metadata, and returns it.

**Call relations**: Many rendering tests use this fixture builder as their base skill constructor.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::make_skill_with_description`  (lines 929–937)

```
fn make_skill_with_description(
        name: &str,
        scope: SkillScope,
        description: &str,
    ) -> SkillMetadata
```

**Purpose**: Creates a test skill fixture like `make_skill` but with a caller-specified description.

**Data flow**: It calls `make_skill`, mutates the returned struct's `description`, and returns the modified `SkillMetadata`.

**Call relations**: Description-budget tests use this helper to craft truncation scenarios.

*Call graph*: 1 external calls (make_skill).


##### `tests::expected_skill_line`  (lines 939–941)

```
fn expected_skill_line(skill: &SkillMetadata, description: &str) -> String
```

**Purpose**: Builds the exact rendered line string expected for a test skill and description prefix.

**Data flow**: It constructs a `SkillLine` from the skill and calls `render_with_description` with the supplied description, returning the resulting string.

**Call relations**: Assertion-heavy tests use this helper to avoid duplicating line-formatting logic inline.

*Call graph*: calls 1 internal fn (new).


##### `tests::normalized_path`  (lines 943–945)

```
fn normalized_path(path: &AbsolutePathBuf) -> String
```

**Purpose**: Normalizes an absolute path to a forward-slash string for stable test assertions across platforms.

**Data flow**: It takes `&AbsolutePathBuf`, converts it to a lossy string, replaces backslashes with `/`, and returns the normalized `String`.

**Call relations**: Alias-path tests use this helper when asserting rendered root-table contents.

*Call graph*: calls 1 internal fn (to_string_lossy).


##### `tests::outcome_with_roots`  (lines 947–971)

```
fn outcome_with_roots(
        skills: Vec<SkillMetadata>,
        roots: Vec<AbsolutePathBuf>,
    ) -> SkillLoadOutcome
```

**Purpose**: Builds a `SkillLoadOutcome` test fixture whose `skill_root_by_path` map is inferred from a provided root list.

**Data flow**: It takes owned skills and roots, scans each skill for the first root that prefixes its `path_to_skills_md`, collects those mappings into a `HashMap`, and returns a `SkillLoadOutcome` populated with `skills`, `skill_roots`, and an `Arc` around the derived map, leaving other fields at default values.

**Call relations**: Tests that exercise alias planning and outcome-based rendering use this helper to create realistic root metadata.

*Call graph*: 2 external calls (new, default).


##### `tests::build_available_skills_from_metadata`  (lines 973–983)

```
fn build_available_skills_from_metadata(
        skills: &[SkillMetadata],
        budget: SkillMetadataBudget,
    ) -> Option<AvailableSkills>
```

**Purpose**: Convenience wrapper for tests that renders a plain skill slice with absolute paths and no alias metadata.

**Data flow**: It orders the skills with `ordered_absolute_skill_lines`, passes them plus `skills.len()` and default aliases into `build_available_skills_from_lines`, and returns the resulting `Option<AvailableSkills>`.

**Call relations**: Most budget-behavior tests call this helper instead of assembling `SkillLine` vectors manually.

*Call graph*: calls 2 internal fn (build_available_skills_from_lines, ordered_absolute_skill_lines); 2 external calls (len, default).


##### `tests::skill_usage_instructions_require_complete_main_agent_reads`  (lines 986–1007)

```
fn skill_usage_instructions_require_complete_main_agent_reads()
```

**Purpose**: Verifies that both instruction-text variants explicitly require complete main-agent reads and forbid delegating interpretation of skill instructions.

**Data flow**: It iterates over the two static instruction strings and asserts the presence or absence of specific phrases. It returns nothing and only affects test outcomes.

**Call relations**: This test guards the prompt contract encoded in the file-level constants.

*Call graph*: 1 external calls (assert!).


##### `tests::default_budget_uses_two_percent_of_full_context_window`  (lines 1010–1019)

```
fn default_budget_uses_two_percent_of_full_context_window()
```

**Purpose**: Checks that positive context-window sizes produce a token budget equal to 2% of the window, with a minimum of 1 token.

**Data flow**: It calls `default_skill_metadata_budget` with representative values and asserts the returned enum variants and limits.

**Call relations**: This test validates the default-budget policy implemented by `default_skill_metadata_budget`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::default_budget_falls_back_to_characters_without_context_window`  (lines 1022–1031)

```
fn default_budget_falls_back_to_characters_without_context_window()
```

**Purpose**: Checks that missing or invalid context-window values fall back to the fixed character budget.

**Data flow**: It calls `default_skill_metadata_budget` with `None` and a negative value and asserts that both return `Characters(DEFAULT_SKILL_METADATA_CHAR_BUDGET)`.

**Call relations**: This test covers the fallback branch of the default-budget calculation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::budgeted_rendering_truncates_descriptions_equally_before_omitting_skills`  (lines 1034–1056)

```
fn budgeted_rendering_truncates_descriptions_equally_before_omitting_skills()
```

**Purpose**: Verifies that when all minimum lines fit but full descriptions do not, the renderer truncates descriptions across skills rather than omitting any skill.

**Data flow**: It creates two repo-scoped skills with equal-length descriptions, computes a budget that allows only part of both descriptions, renders them, and asserts included counts, truncation totals, warning absence, and the exact truncated line strings.

**Call relations**: This test exercises the fair-allocation path in `render_lines_with_description_budget` via the higher-level rendering helpers.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_does_not_warn_when_average_description_truncation_is_within_threshold`  (lines 1059–1075)

```
fn budgeted_rendering_does_not_warn_when_average_description_truncation_is_within_threshold()
```

**Purpose**: Checks that moderate truncation below the warning threshold does not produce a warning message.

**Data flow**: It builds two skills, computes a budget that truncates both descriptions somewhat, renders them, and asserts report counts and `warning_message == None`.

**Call relations**: This test validates the threshold logic based on `SkillRenderReport::average_truncated_description_chars`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_warns_when_average_description_truncation_exceeds_threshold`  (lines 1078–1104)

```
fn budgeted_rendering_warns_when_average_description_truncation_exceeds_threshold()
```

**Purpose**: Checks that severe truncation triggers the character-budget warning message.

**Data flow**: It creates one very long-description skill and one empty-description skill, renders under a tight character budget, and asserts the report plus the exact warning string.

**Call relations**: This test covers the truncation-warning branch in `build_available_skills_from_lines`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_token_budget_truncation_warning_mentions_two_percent`  (lines 1107–1122)

```
fn budgeted_rendering_token_budget_truncation_warning_mentions_two_percent()
```

**Purpose**: Checks that the truncation warning uses the token-budget wording mentioning the 2% skills context budget.

**Data flow**: It renders a long-description skill under a tiny token budget and asserts that the warning equals `SKILL_DESCRIPTION_TRUNCATED_WARNING_WITH_PERCENT`.

**Call relations**: This test validates token-mode warning selection.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Tokens, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_redistributes_unused_description_budget`  (lines 1125–1146)

```
fn budgeted_rendering_redistributes_unused_description_budget()
```

**Purpose**: Verifies that unused description budget from short descriptions is redistributed to longer descriptions instead of being stranded.

**Data flow**: It creates one one-character description and one longer description, renders under a budget that cannot fit both fully, and asserts that the short description stays complete while the long one receives most of the remaining budget.

**Call relations**: This test specifically exercises the round-robin incremental allocator in `render_lines_with_description_budget`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_preserves_prompt_priority_when_minimum_lines_exceed_budget`  (lines 1149–1178)

```
fn budgeted_rendering_preserves_prompt_priority_when_minimum_lines_exceed_budget()
```

**Purpose**: Checks that when even minimum lines do not all fit, higher-priority scopes are kept first and omitted skills disappear entirely.

**Data flow**: It creates skills across all four scopes, computes a budget that fits only two minimum lines, renders them, and asserts that only `System` and `Admin` remain, descriptions are removed, and the omission warning is emitted.

**Call relations**: This test validates the ordering from `ordered_skills_for_budget` and the omission behavior of `render_minimum_skill_lines_until_budget`.

*Call graph*: 6 external calls (assert!, assert_eq!, Characters, build_available_skills_from_metadata, make_skill, format!).


##### `tests::budgeted_rendering_keeps_scanning_after_oversized_entry`  (lines 1181–1204)

```
fn budgeted_rendering_keeps_scanning_after_oversized_entry()
```

**Purpose**: Verifies that an oversized early skill does not prevent later smaller skills from being included when rendering minimum lines under a tight budget.

**Data flow**: It creates one huge system skill and one small repo skill, renders under a budget that fits only the repo skill, and asserts that the oversized skill is omitted while the later one is still included.

**Call relations**: This test covers the control flow in `render_minimum_skill_lines_until_budget`, which continues scanning after a non-fitting entry.

*Call graph*: 6 external calls (assert!, assert_eq!, Characters, build_available_skills_from_metadata, make_skill, format!).


##### `tests::outcome_rendering_omits_aliases_when_absolute_plan_has_no_budget_pressure`  (lines 1207–1228)

```
fn outcome_rendering_omits_aliases_when_absolute_plan_has_no_budget_pressure()
```

**Purpose**: Checks that alias tables are not introduced when the absolute-path rendering already fits comfortably.

**Data flow**: It builds an outcome with two rooted skills, renders with an effectively unlimited character budget, and asserts that `skill_root_lines` is empty and both skills are included.

**Call relations**: This test validates the selection logic in `build_available_skills`, which only considers aliasing when the absolute render had pressure.

*Call graph*: calls 1 internal fn (build_available_skills); 6 external calls (assert!, assert_eq!, test_path_buf, Characters, outcome_with_roots, vec!).


##### `tests::outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit`  (lines 1231–1289)

```
fn outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit()
```

**Purpose**: Checks that alias rendering is selected when it reduces path cost enough to fit more skills than absolute paths would.

**Data flow**: It constructs many skills under a long shared root, computes absolute and aliased minimum costs, renders with a budget equal to the aliased minimum, and asserts that all skills fit with a root alias table and aliased paths.

**Call relations**: This test exercises the full alias-plan, aliased-render, and comparison pipeline in `build_available_skills`.

*Call graph*: calls 2 internal fn (build_alias_plan, build_available_skills); 6 external calls (assert!, assert_eq!, test_path_buf, Characters, outcome_with_roots, vec!).


##### `tests::outcome_rendering_uses_marketplace_root_for_single_skill_plugin_versions`  (lines 1292–1317)

```
fn outcome_rendering_uses_marketplace_root_for_single_skill_plugin_versions()
```

**Purpose**: Verifies that a single selected skill from one plugin version aliases from the broader marketplace root rather than the narrower skill root.

**Data flow**: It builds an outcome with one plugin-cache skill, constructs an alias plan, and asserts the root-table line and rendered aliased path.

**Call relations**: This test targets `alias_root_for_skill_root` and plugin-layout path analysis.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_uses_skill_root_for_multiple_skills_in_one_plugin_version`  (lines 1320–1355)

```
fn outcome_rendering_uses_skill_root_for_multiple_skills_in_one_plugin_version()
```

**Purpose**: Verifies that when multiple selected skills share one plugin version, aliasing uses the skill root itself rather than the broader marketplace root.

**Data flow**: It creates two skills under the same plugin-version root, builds an alias plan, and asserts the chosen root alias and shortened relative paths.

**Call relations**: This test covers the multi-skill branch of `alias_root_for_skill_root`.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_counts_plugin_version_skills_before_budget_omission`  (lines 1358–1393)

```
fn outcome_rendering_counts_plugin_version_skills_before_budget_omission()
```

**Purpose**: Checks that alias-root selection is based on the full selected skill set before later budget omission removes some rendered entries.

**Data flow**: It builds two skills under one plugin-version root, constructs an alias plan, computes a budget that only fits one aliased minimum line plus the alias table, renders aliased skills, and asserts that the root alias still reflects the two-skill plugin-version decision.

**Call relations**: This test ensures alias planning happens before omission and uses the selected skill set, not only the finally rendered subset.

*Call graph*: calls 2 internal fn (build_alias_plan, build_aliased_available_skills); 7 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, format!, vec!).


##### `tests::outcome_rendering_uses_each_skill_root_for_multiple_roots_in_one_plugin_version`  (lines 1396–1438)

```
fn outcome_rendering_uses_each_skill_root_for_multiple_roots_in_one_plugin_version()
```

**Purpose**: Verifies that distinct roots within the same plugin version each receive their own alias when multiple selected roots are involved.

**Data flow**: It creates skills under `skills` and `extra-skills` roots for one plugin version, builds an alias plan, and asserts two root-table entries and the corresponding `r0/...` and `r1/...` paths.

**Call relations**: This test covers alias-root deduplication and ordering when one plugin version contributes multiple roots.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_extracts_plugin_marketplace_root_for_multiple_plugins`  (lines 1441–1486)

```
fn outcome_rendering_extracts_plugin_marketplace_root_for_multiple_plugins()
```

**Purpose**: Checks that skills from different plugins can share one marketplace-root alias when that is the chosen alias root.

**Data flow**: It creates one skill under each of two plugin roots, builds an alias plan, and asserts a single marketplace root alias plus plugin-qualified relative paths for both skills.

**Call relations**: This test validates marketplace-root extraction across multiple plugins.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_uses_one_marketplace_root_for_multiple_plugin_versions`  (lines 1489–1529)

```
fn outcome_rendering_uses_one_marketplace_root_for_multiple_plugin_versions()
```

**Purpose**: Checks that multiple versions of the same plugin can share one marketplace-root alias when each selected version contributes only one skill.

**Data flow**: It creates skills under two different versioned roots, builds an alias plan, and asserts a single marketplace root alias and version-qualified relative paths.

**Call relations**: This test exercises the single-skill-per-version branch of alias-root selection across multiple versions.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::skill_with_path`  (lines 1531–1535)

```
fn skill_with_path(name: &str, path: &AbsolutePathBuf) -> SkillMetadata
```

**Purpose**: Creates a test skill fixture with a caller-specified absolute path.

**Data flow**: It calls `make_skill` with `SkillScope::User`, overwrites `path_to_skills_md` with a clone of the provided path, and returns the modified `SkillMetadata`.

**Call relations**: Alias and root-layout tests use this helper to place skills precisely within synthetic directory trees.

*Call graph*: 2 external calls (make_skill, clone).


### `core/src/context/available_skills_instructions.rs`

`domain_logic` · `prompt assembly`

This file defines `AvailableSkillsInstructions`, the prompt-fragment type for the skills catalog. The struct stores two pre-rendered line collections: `skill_root_lines`, which describe skill roots or grouping headers, and `skill_lines`, which describe individual skills. There are two construction paths. `from_skill_lines` is a convenience constructor for callers that already have only flat skill lines and want an empty root section, while the `From<AvailableSkills>` implementation consumes the richer `codex_core_skills::AvailableSkills` value and transfers both vectors directly.

As a `ContextualUserFragment`, the type always renders with developer role and uses `SKILLS_INSTRUCTIONS_OPEN_TAG` / `SKILLS_INSTRUCTIONS_CLOSE_TAG` as delimiters. Unlike the plugin and app instruction fragments, the body is not assembled locally; it delegates to `codex_core_skills::render_available_skills_body`, passing both stored vectors. That keeps formatting policy for the skills catalog centralized in the skills crate while this file focuses on prompt-fragment integration. The main invariant is that the fragment contains already prepared textual lines rather than raw skill objects, so rendering here is deterministic and side-effect free.

#### Function details

##### `AvailableSkillsInstructions::from_skill_lines`  (lines 17–22)

```
fn from_skill_lines(skill_lines: Vec<String>) -> Self
```

**Purpose**: Constructs a skills fragment from a flat list of pre-rendered skill lines when no root/group lines are needed. It initializes `skill_root_lines` as empty.

**Data flow**: Takes `Vec<String> skill_lines`, creates a new `AvailableSkillsInstructions` with `skill_root_lines = Vec::new()` and the provided `skill_lines`, and returns it.

**Call relations**: It is called by `available_skills_fragment` in code paths that already have rendered skill lines rather than a full `AvailableSkills` object.

*Call graph*: called by 1 (available_skills_fragment); 1 external calls (new).


##### `AvailableSkillsInstructions::from`  (lines 26–31)

```
fn from(available_skills: AvailableSkills) -> Self
```

**Purpose**: Converts a full `AvailableSkills` value into the prompt-fragment form by moving over its rendered line vectors. This is the richer construction path used during normal context building.

**Data flow**: Consumes `AvailableSkills`, takes ownership of its `skill_root_lines` and `skill_lines` fields, and returns a new `AvailableSkillsInstructions` containing them.

**Call relations**: It is called by `build_initial_context` when the system has already computed the available skills catalog.

*Call graph*: called by 1 (build_initial_context).


##### `AvailableSkillsInstructions::role`  (lines 35–37)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks the skills fragment as developer-role content. The role is constant.

**Data flow**: Returns `"developer"` without reading any fields.

**Call relations**: It is used through the `ContextualUserFragment` trait during prompt rendering.


##### `AvailableSkillsInstructions::markers`  (lines 39–41)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the protocol tags that delimit the skills section. It delegates to the type-level marker definition.

**Data flow**: Calls `Self::type_markers()` and returns the resulting tuple.

**Call relations**: It is part of the generic fragment-rendering path and keeps marker lookup consistent.

*Call graph*: 1 external calls (type_markers).


##### `AvailableSkillsInstructions::type_markers`  (lines 43–45)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the open and close tags for the skills instructions section. These constants come from the shared protocol layer.

**Data flow**: Returns `(SKILLS_INSTRUCTIONS_OPEN_TAG, SKILLS_INSTRUCTIONS_CLOSE_TAG)`.

**Call relations**: It is used by `markers` and by any renderer that needs the fragment delimiters.


##### `AvailableSkillsInstructions::body`  (lines 47–49)

```
fn body(&self) -> String
```

**Purpose**: Renders the final skills section body from the stored root and skill lines using the shared skills renderer. This keeps formatting logic outside the context module.

**Data flow**: Reads `self.skill_root_lines` and `self.skill_lines`, passes references to `render_available_skills_body`, and returns the resulting `String`.

**Call relations**: It is invoked through the `ContextualUserFragment` trait when the skills section is emitted into the prompt.

*Call graph*: 1 external calls (render_available_skills_body).


### `ext/skills/src/render.rs`

`domain_logic` · `prompt assembly`

This file contains the formatting and prompt-budget logic used when exposing skills to the model. Its central routine walks a `SkillCatalog`, keeping only entries that are both `enabled` and `prompt_visible`, and renders each as a single bullet line containing the skill name, a description, and a source/path locator. The source label is derived from `SkillSourceKind`, so host-backed skills appear as `file`, executor-backed skills as `environment resource`, orchestrator-backed skills as `orchestrator resource`, and custom sources as `custom resource`.

A hard byte budget is enforced for the available-skills fragment (`MAX_AVAILABLE_SKILLS_BYTES = 8_000`). The code accumulates rendered line lengths, skips any line that would overflow the budget, and appends a final omission notice if one or more skills were excluded. If no visible enabled skills fit, it returns `None` instead of an empty fragment. Separately, main prompt contents are bounded by another 8 KB limit. Truncation is delegated to `codex_utils_string::take_bytes_at_char_boundary`, which preserves valid UTF-8 by cutting only on character boundaries. The truncation helpers return both the resulting string and a boolean indicating whether any bytes were dropped, allowing callers to distinguish exact fits from clipped content.

#### Function details

##### `available_skills_fragment`  (lines 13–50)

```
fn available_skills_fragment(
    catalog: &SkillCatalog,
) -> Option<AvailableSkillsInstructions>
```

**Purpose**: Constructs an `AvailableSkillsInstructions` fragment from visible, enabled catalog entries while respecting the bounded prompt budget for the skills list.

**Data flow**: Reads `catalog.entries`, filters to entries with `enabled` and `prompt_visible`, chooses `short_description` when present or falls back to `description`, and converts each entry into a bullet line via `render_skill_line`. It accumulates total rendered byte length, skips lines that would exceed `MAX_AVAILABLE_SKILLS_BYTES`, tracks how many were omitted, and returns `None` if no lines remain; otherwise it builds an `AvailableSkillsInstructions` from the collected lines, optionally appending an omission summary line.

**Call relations**: This function is invoked by `contribute` when assembling prompt fragments for a turn. It delegates per-entry formatting to `render_skill_line` and final fragment construction to `AvailableSkillsInstructions::from_skill_lines`, acting as the budget-aware bridge between the raw catalog and the prompt text injected upstream.

*Call graph*: calls 2 internal fn (from_skill_lines, render_skill_line); called by 1 (contribute); 2 external calls (new, format!).


##### `render_skill_line`  (lines 52–66)

```
fn render_skill_line(entry: &SkillCatalogEntry, description: &str) -> String
```

**Purpose**: Formats one `SkillCatalogEntry` into the exact bullet-line text shown in the available-skills prompt fragment.

**Data flow**: Consumes a catalog entry reference plus the chosen description string, inspects `entry.authority.kind` to derive a human-readable locator label, reads `entry.name` and `entry.rendered_path()`, and returns a formatted `String`. If the description is empty, it omits the description segment and emits only the name and locator.

**Call relations**: It is called only from `available_skills_fragment` for each candidate entry. Its job is intentionally narrow: normalize source-kind wording and produce stable line text so the caller can count bytes and decide whether to include or omit the line.

*Call graph*: calls 1 internal fn (rendered_path); called by 1 (available_skills_fragment); 1 external calls (format!).


##### `truncate_main_prompt_contents`  (lines 68–70)

```
fn truncate_main_prompt_contents(contents: &str) -> (String, bool)
```

**Purpose**: Applies the main-prompt byte limit to arbitrary prompt contents using the file’s shared UTF-8-safe truncation helper.

**Data flow**: Takes an input `&str`, passes it with `MAX_MAIN_PROMPT_BYTES` to `truncate_utf8_to_bytes`, and returns the resulting `(String, bool)` pair where the boolean reports whether truncation occurred.

**Call relations**: This helper is called by `contribute` when preparing main prompt material for injection. It exists as a named wrapper around `truncate_utf8_to_bytes` so callers use the correct prompt-specific limit without repeating constants.

*Call graph*: calls 1 internal fn (truncate_utf8_to_bytes); called by 1 (contribute).


##### `truncate_utf8_to_bytes`  (lines 72–75)

```
fn truncate_utf8_to_bytes(contents: &str, max_bytes: usize) -> (String, bool)
```

**Purpose**: Cuts a string to a maximum byte length without splitting a UTF-8 code point and reports whether the original text was shortened.

**Data flow**: Accepts `contents` and an arbitrary `max_bytes`, calls `take_bytes_at_char_boundary(contents, max_bytes)`, converts the borrowed truncated slice into an owned `String`, and compares lengths to produce a `bool` indicating truncation. It does not mutate external state.

**Call relations**: It is used directly by `contribute` and indirectly through `truncate_main_prompt_contents`. The function encapsulates the low-level UTF-8 boundary logic so prompt rendering and tool output code can enforce byte budgets safely.

*Call graph*: called by 2 (contribute, truncate_main_prompt_contents); 1 external calls (take_bytes_at_char_boundary).


### Plugin and app capability prompts
These files define and render prompt guidance for plugins, tools, and app connectors, including explicit plugin mention injection.

### `core/src/apps/render.rs`

`domain_logic` · `prompt/context assembly`

This file is a narrow adapter between raw connector metadata (`codex_app_server_protocol::AppInfo`) and the textual apps section inserted into protocol instructions. Its only production function passes the full connector slice into `AppsInstructions::from_connectors`; if that constructor decides there are no connectors worth exposing—specifically the tests show cases where apps are inaccessible or disabled—it returns `None`, and this file propagates that omission unchanged. When instructions are produced, the function immediately renders them to a `String`, so this module owns no intermediate state and performs no formatting itself.

The tests make the intended contract concrete. A local `connector` helper constructs minimal `AppInfo` values with all optional branding, metadata, labels, and install fields absent, leaving only identity and accessibility/enabled flags relevant. One test verifies the section is omitted for an empty list and for connectors that fail either accessibility or enabled checks. The other verifies that a valid connector yields a rendered block wrapped in `APPS_INSTRUCTIONS_OPEN_TAG` / `APPS_INSTRUCTIONS_CLOSE_TAG` and containing the expected heading text. That means callers can treat `None` as “do not include any apps section at all,” not as an empty tagged block.

#### Function details

##### `render_apps_section`  (lines 7–9)

```
fn render_apps_section(connectors: &[AppInfo]) -> Option<String>
```

**Purpose**: Converts a slice of `AppInfo` connectors into a rendered apps-instructions section, or omits the section entirely when no eligible connectors exist. It is a thin wrapper around `AppsInstructions` construction and rendering.

**Data flow**: Takes `connectors: &[AppInfo]` → passes them to `AppsInstructions::from_connectors` for eligibility filtering and instruction construction → if that returns `Some`, calls `render()` on the resulting instructions object → returns `Option<String>` with the final tagged section text or `None`.

**Call relations**: This is the production entry in the file. The test `tests::renders_apps_section_with_an_accessible_and_enabled_app` invokes it for the positive path, while the omission behavior is validated indirectly by the other test cases. Internally it delegates all decision-making to `from_connectors` rather than duplicating connector filtering logic.

*Call graph*: calls 1 internal fn (from_connectors); called by 1 (renders_apps_section_with_an_accessible_and_enabled_app).


##### `tests::connector`  (lines 15–31)

```
fn connector(id: &str, is_accessible: bool, is_enabled: bool) -> AppInfo
```

**Purpose**: Builds a minimal `AppInfo` fixture with caller-controlled `id`, `is_accessible`, and `is_enabled` values. All unrelated optional fields are left unset so tests isolate the accessibility/enabled contract.

**Data flow**: Accepts `id: &str`, `is_accessible: bool`, and `is_enabled: bool` → constructs an `AppInfo` with `id` and `name` copied from the string, empty `plugin_display_names`, and every optional metadata/branding/install field set to `None` → returns the fixture value.

**Call relations**: This helper is used by both tests to avoid repeating verbose `AppInfo` construction. It supports the negative and positive render assertions by producing connectors that differ only in the flags under test.

*Call graph*: 1 external calls (new).


##### `tests::omits_apps_section_without_accessible_and_enabled_apps`  (lines 34–48)

```
fn omits_apps_section_without_accessible_and_enabled_apps()
```

**Purpose**: Verifies that no apps section is rendered when there are no connectors or when connectors fail either the accessibility or enabled requirement. It codifies omission as `None`, not an empty string.

**Data flow**: Builds several connector scenarios, including an empty slice and single-item slices with one failing flag → calls `render_apps_section` implicitly through `assert_eq!` comparisons → checks each result equals `None`.

**Call relations**: This test exercises the negative branch of `render_apps_section`'s delegated `AppsInstructions::from_connectors` logic. It complements the positive rendering test by proving the section is suppressed unless both eligibility conditions hold.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::renders_apps_section_with_an_accessible_and_enabled_app`  (lines 51–60)

```
fn renders_apps_section_with_an_accessible_and_enabled_app()
```

**Purpose**: Checks that a valid connector produces a fully wrapped apps section with the expected heading. It verifies both presence and basic structural markers of the rendered output.

**Data flow**: Creates one connector fixture with both `is_accessible` and `is_enabled` true → calls `render_apps_section` and unwraps the `Some(String)` result → asserts the string starts with `APPS_INSTRUCTIONS_OPEN_TAG`, contains `## Apps (Connectors)`, and ends with `APPS_INSTRUCTIONS_CLOSE_TAG`.

**Call relations**: This test is the direct positive caller of `render_apps_section`. It validates the success path after `AppsInstructions::from_connectors` returns instructions and `render()` formats them.

*Call graph*: calls 1 internal fn (render_apps_section); 2 external calls (assert!, connector).


### `core/src/context/apps_instructions.rs`

`domain_logic` · `prompt assembly`

This file introduces `AppsInstructions`, a zero-sized contextual fragment used to inject fixed developer guidance about app connectors into the prompt. The gating logic lives in `from_connectors`: it scans a slice of `codex_app_server_protocol::AppInfo` and returns `Some(AppsInstructions)` only if any connector has both `is_accessible` and `is_enabled` set. That prevents the prompt from advertising app behavior when no usable connectors are available.

As a `ContextualUserFragment`, the type renders with developer role and protocol markers defined by `APPS_INSTRUCTIONS_OPEN_TAG` and `APPS_INSTRUCTIONS_CLOSE_TAG`. The body is a static explanatory block that spells out several operational rules: users can explicitly trigger apps with markdown links of the form `[$app-name](app://{connector_id})`; apps are equivalent to MCP tools under the `CODEX_APPS_MCP_SERVER_NAME` server; installed app tools may already be present or may need lazy loading through `tool_search`; and the model should not call `list_mcp_resources` or `list_mcp_resource_templates` for apps. Because the body is fixed text, the only dynamic behavior in this file is whether the fragment exists at all.

#### Function details

##### `AppsInstructions::from_connectors`  (lines 12–17)

```
fn from_connectors(connectors: &[AppInfo]) -> Option<Self>
```

**Purpose**: Decides whether app instructions should be included in the prompt based on the current connector list. It emits instructions only when at least one connector is both accessible and enabled.

**Data flow**: Takes `&[AppInfo]`, iterates through the slice, checks `connector.is_accessible && connector.is_enabled`, and returns `Some(Self)` if any connector satisfies that predicate; otherwise it returns `None`.

**Call relations**: It is called by `render_apps_section` and `build_initial_context` during prompt construction so those flows only include app guidance when apps are actually usable.

*Call graph*: called by 2 (render_apps_section, build_initial_context); 1 external calls (iter).


##### `AppsInstructions::role`  (lines 21–23)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks the fragment as developer-role prompt content. The role is constant for all instances.

**Data flow**: Returns the static string `"developer"` without reading instance state.

**Call relations**: It is used through the `ContextualUserFragment` trait by generic prompt-rendering code.


##### `AppsInstructions::markers`  (lines 25–27)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the protocol markers that wrap the apps-instructions section. It delegates to the type-level marker definition.

**Data flow**: Calls `Self::type_markers()` and returns the resulting open/close tag pair.

**Call relations**: It is part of the trait-based rendering path and keeps marker lookup consistent with the static type definition.

*Call graph*: 1 external calls (type_markers).


##### `AppsInstructions::type_markers`  (lines 29–31)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the protocol tags used to delimit the apps-instructions fragment in rendered context. These tags come from the shared protocol constants.

**Data flow**: Returns `(APPS_INSTRUCTIONS_OPEN_TAG, APPS_INSTRUCTIONS_CLOSE_TAG)`.

**Call relations**: It is used by `markers` and indirectly by any renderer that needs the fragment's delimiters.


##### `AppsInstructions::body`  (lines 33–37)

```
fn body(&self) -> String
```

**Purpose**: Produces the fixed instructional text explaining how apps/connectors map to MCP tools and how the model should use them. The text embeds the Codex Apps MCP server name constant.

**Data flow**: Builds and returns a formatted `String` containing the multi-line apps guidance, interpolating `CODEX_APPS_MCP_SERVER_NAME` into the explanation.

**Call relations**: It is invoked through the `ContextualUserFragment` trait when the apps section is rendered into the prompt.

*Call graph*: 1 external calls (format!).


### `core/src/plugins/render.rs`

`domain_logic` · `request handling`

This file is a small rendering helper focused on converting plugin capability metadata into user-facing instruction strings. Its central input type is `PluginCapabilitySummary`, and the output is always `Option<String>` so callers can omit the section entirely when there is nothing meaningful to say. The runtime path is `render_explicit_plugin_instructions`, which builds a `Vec<String>` starting with a heading naming the plugin via `plugin.display_name`, then conditionally appends bullets for three capability categories: skill prefixing when `plugin.has_skills` is true, MCP servers when `available_mcp_servers` is non-empty, and apps when `available_apps` is non-empty. Server and app names are individually wrapped in backticks and joined with commas to produce inline lists. A key invariant is that the initial heading alone is not considered useful output: if no conditional bullets were added, the function returns `None` instead of a one-line section. When at least one capability bullet exists, it appends a final guidance sentence telling the model to use those plugin-associated capabilities, then joins all lines with newlines.

The test-only helper `render_plugins_section` delegates to `AvailablePluginsInstructions::from_plugins`, then renders that richer intermediate representation if construction succeeds. The file therefore separates low-level string assembly for explicit plugin instructions from broader aggregate rendering used in tests.

#### Function details

##### `render_plugins_section`  (lines 8–10)

```
fn render_plugins_section(plugins: &[PluginCapabilitySummary]) -> Option<String>
```

**Purpose**: Builds a complete rendered plugin section from a slice of plugin summaries, but only in test builds. It relies on the higher-level `AvailablePluginsInstructions` abstraction to decide whether any section should exist and how it should be formatted.

**Data flow**: It takes `plugins: &[PluginCapabilitySummary]`, passes that slice into `AvailablePluginsInstructions::from_plugins`, and maps the resulting instruction object through its `render()` method. The function returns `None` when `from_plugins` yields no instruction set, otherwise returns the rendered `String`; it does not mutate external state.

**Call relations**: This helper exists behind `#[cfg(test)]`, so it participates only in test call flows. When tests need aggregate plugin instructions, they invoke this function, which immediately delegates construction logic to `from_plugins` rather than formatting the slice itself.

*Call graph*: calls 1 internal fn (from_plugins).


##### `render_explicit_plugin_instructions`  (lines 12–58)

```
fn render_explicit_plugin_instructions(
    plugin: &PluginCapabilitySummary,
    available_mcp_servers: &[String],
    available_apps: &[String],
) -> Option<String>
```

**Purpose**: Creates a concise instruction block for one plugin, describing exactly which plugin-scoped capabilities are available in the current session. It suppresses output when the plugin contributes no skills, MCP servers, or apps worth mentioning.

**Data flow**: It reads `plugin.display_name` and `plugin.has_skills`, plus the `available_mcp_servers` and `available_apps` slices. It initializes a `Vec<String>` with a heading, conditionally pushes bullet lines for skills, MCP servers, and apps, formats server/app names with backticks and comma joins, and checks whether only the heading is present. If no capability bullets were added it returns `None`; otherwise it appends a final advisory sentence and returns `Some(lines.join("\n"))`.

**Call relations**: This is the file's main runtime formatter, used when some higher-level orchestration has already selected a specific plugin and computed the session-visible MCP server and app names. It does all formatting inline with `format!` and collection assembly, and does not delegate to other project functions.

*Call graph*: 2 external calls (format!, vec!).


### `core/src/context/available_plugins_instructions.rs`

`domain_logic` · `prompt assembly`

This file provides `AvailablePluginsInstructions`, a contextual fragment that carries a `Vec<PluginCapabilitySummary>` and renders a fixed developer-facing explanation of plugin semantics. The constructor-like `from_plugins` method is intentionally presence-based: it returns `None` for an empty plugin slice and otherwise clones the slice into owned storage. The stored plugin summaries are not interpolated into the body here; their presence simply controls whether the explanatory section should exist.

The `ContextualUserFragment` implementation uses developer role and wraps the section with `PLUGINS_INSTRUCTIONS_OPEN_TAG` and `PLUGINS_INSTRUCTIONS_CLOSE_TAG`. The body is assembled from a vector of lines and then joined into a single block surrounded by leading and trailing newlines. Its content explains that a plugin is a local bundle of skills, MCP servers, and apps, then gives concrete usage rules: plugin-contributed skills are prefixed with `plugin_name:`, plugin MCP tools keep standard `mcp__server__tool` identifiers, explicit user mention should bias capability choice toward that plugin, plugins are not invoked directly, relevance should be inferred from associated skills/tools/apps, and missing or blocked plugin requests should be acknowledged briefly before falling back. The file therefore acts as a prompt-policy adapter for plugin availability rather than a renderer of plugin inventories themselves.

#### Function details

##### `AvailablePluginsInstructions::from_plugins`  (lines 13–21)

```
fn from_plugins(plugins: &[PluginCapabilitySummary]) -> Option<Self>
```

**Purpose**: Creates the plugins-instructions fragment only when there are plugin summaries to justify showing plugin guidance. It clones the provided summaries into owned storage.

**Data flow**: Takes `&[PluginCapabilitySummary]`, returns `None` if the slice is empty, otherwise copies it with `to_vec()` into the `plugins` field and returns `Some(Self { ... })`.

**Call relations**: It is called by `render_plugins_section` and `build_initial_context` so prompt assembly can omit plugin instructions when no plugins are available.

*Call graph*: called by 2 (render_plugins_section, build_initial_context); 2 external calls (is_empty, to_vec).


##### `AvailablePluginsInstructions::role`  (lines 25–27)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that this fragment belongs in developer-role prompt context. The value is fixed.

**Data flow**: Returns the static string `"developer"` and reads no fields.

**Call relations**: It is used through the `ContextualUserFragment` trait by generic context rendering.


##### `AvailablePluginsInstructions::markers`  (lines 29–31)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the protocol markers delimiting the plugins-instructions section. It delegates to the type-level marker definition.

**Data flow**: Calls `Self::type_markers()` and returns the resulting pair of static strings.

**Call relations**: It participates in trait-based rendering and keeps marker lookup centralized.

*Call graph*: 1 external calls (type_markers).


##### `AvailablePluginsInstructions::type_markers`  (lines 33–38)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the open and close protocol tags for the plugins-instructions fragment. These constants identify the section in rendered prompt text.

**Data flow**: Returns `(PLUGINS_INSTRUCTIONS_OPEN_TAG, PLUGINS_INSTRUCTIONS_CLOSE_TAG)`.

**Call relations**: It is used by `markers` and indirectly by prompt renderers.


##### `AvailablePluginsInstructions::body`  (lines 40–58)

```
fn body(&self) -> String
```

**Purpose**: Builds the fixed explanatory text describing plugin concepts and usage rules. The output is a newline-delimited markdown section with a heading and bullet list.

**Data flow**: Creates a mutable `Vec<String>` of lines, pushes the section heading and explanatory bullets, joins them with newline separators, wraps the result with leading and trailing newlines via `format!`, and returns the final `String`.

**Call relations**: It is called through the `ContextualUserFragment` trait when the plugins instructions section is rendered.

*Call graph*: 2 external calls (format!, vec!).


### `core/src/plugins/injection.rs`

`domain_logic` · `request handling`

This file contains a single transformation function used after plugin mentions have already been identified. `build_plugin_injections` takes a list of `PluginCapabilitySummary` values representing explicitly mentioned plugins, the currently available MCP `ToolInfo` list, and available connector metadata. If no plugins were mentioned it returns an empty vector immediately.

For each mentioned plugin, it derives two sorted, deduplicated inventories. First it scans `mcp_tools` for tools whose `plugin_display_names` include the plugin's `display_name`, excluding the special `CODEX_APPS_MCP_SERVER_NAME` pseudo-server so app-backed tools do not masquerade as plugin MCP servers. Matching server names are collected through a `BTreeSet<String>` to guarantee uniqueness and stable ordering. Second it scans `available_connectors` for enabled connectors whose `plugin_display_names` include the same display name, converts each to a user-facing label with `connector_display_label`, and again deduplicates/sorts via `BTreeSet`.

Those two inventories are passed to `render_explicit_plugin_instructions`, which may or may not produce instruction text. When it does, the text is wrapped in `PluginInstructions`, converted into `ContextualUserFragment`, then into a `codex_protocol::models::ResponseItem`. Plugins that render no instructions are omitted entirely via `filter_map`.

#### Function details

##### `build_plugin_injections`  (lines 14–59)

```
fn build_plugin_injections(
    mentioned_plugins: &[PluginCapabilitySummary],
    mcp_tools: &[ToolInfo],
    available_connectors: &[connectors::AppInfo],
) -> Vec<ResponseItem>
```

**Purpose**: Transforms explicitly mentioned plugins into contextual instruction `ResponseItem`s that tell the model which plugin-related MCP servers and enabled apps are actually available. It skips work entirely when there are no mentioned plugins.

**Data flow**: Inputs are slices of `PluginCapabilitySummary`, `ToolInfo`, and `connectors::AppInfo`. It first checks `mentioned_plugins.is_empty()` and returns `Vec::new()` if true. Otherwise it iterates each plugin, filters `mcp_tools` by matching `plugin_display_names` and excluding `CODEX_APPS_MCP_SERVER_NAME`, collects unique server names into a sorted `Vec<String>`, filters enabled connectors by matching `plugin_display_names`, maps them through `connector_display_label`, collects unique labels into another sorted `Vec<String>`, then passes the plugin plus both vectors to `render_explicit_plugin_instructions`. Any produced instruction text is wrapped with `PluginInstructions::new`, converted into `ContextualUserFragment`, then into `ResponseItem`, and all successful items are collected into the returned vector.

**Call relations**: Higher-level prompt/injection assembly code calls this after mention extraction has identified relevant plugins. The function delegates text generation to `render_explicit_plugin_instructions` and uses conversion wrappers to fit that text into the response-item pipeline.

*Call graph*: 3 external calls (new, is_empty, iter).


### `tools/src/code_mode.rs`

`orchestration` · `tool registration and prompt/tool-definition assembly before request handling`

This file is the adapter layer between the crate’s internal `ToolSpec` model and `codex_code_mode::ToolDefinition`. Its core job is to inspect supported tool variants—plain function tools, freeform tools, and namespace-contained function tools—and turn them into `CodeModeToolDefinition` values with the right `name`, `tool_name`, `kind`, schemas, and description text. The code explicitly excludes unsupported variants such as `ImageGeneration`, `ToolSearch`, and `WebSearch` by returning no definitions for them.

A key design detail is that namespace tools are flattened into individual nested tool definitions. Their runtime-visible code-mode name is derived from `ToolName` by `code_mode_name_for_tool_name`, which uses `namespace__name` by default but preserves underscore-joined names when the namespace already ends with `_` or the tool name begins with `_`. This avoids awkward doubled separators and preserves intended naming conventions.

There are two collection paths: one for full code-mode tool definitions, which prepends namespace descriptions and then augments each definition with code-mode-specific samples, and one for exec-prompt definitions, which keeps the raw descriptions. Both sort by `name` and deduplicate by `name`, so repeated specs collapse deterministically. For single-tool augmentation, the file clones the original tool payload, computes an augmented description if the variant is supported, and writes that description back while preserving the original spec shape.

#### Function details

##### `augment_tool_spec_for_code_mode`  (lines 8–51)

```
fn augment_tool_spec_for_code_mode(spec: ToolSpec) -> ToolSpec
```

**Purpose**: Takes a `ToolSpec` and returns the same logical tool spec with its description rewritten to include code-mode-specific execution examples when the variant is supported. For namespace specs, it updates each nested function tool in place rather than replacing the namespace structure.

**Data flow**: Consumes a `ToolSpec` by value. For `ToolSpec::Function` and `ToolSpec::Freeform`, it clones the inner tool to build a temporary spec, asks `augmented_description_for_spec` for an enriched description, and if one exists assigns it back to `tool.description`; otherwise it returns the original variant unchanged. For `ToolSpec::Namespace`, it iterates mutable references to `namespace.tools`, constructs a `ToolName::namespaced(...)` and a `CodeModeToolDefinition` for each nested function, serializes parameters with `serde_json::to_value(...).ok()`, augments the definition through `codex_code_mode::augment_tool_definition`, and writes the resulting description back into each nested tool. Unsupported variants pass through untouched.

**Call relations**: This is the top-level mutation path for callers that want to preserve `ToolSpec` shape while making descriptions code-mode-aware. It delegates single-tool description generation to `augmented_description_for_spec`; for namespace members it performs the conversion inline because each nested tool needs a namespaced `ToolName` and code-mode name from `code_mode_name_for_tool_name` before calling the external augmenter.

*Call graph*: calls 3 internal fn (namespaced, augmented_description_for_spec, code_mode_name_for_tool_name); 5 external calls (augment_tool_definition, to_value, Freeform, Function, Namespace).


##### `tool_spec_to_code_mode_tool_definition`  (lines 55–59)

```
fn tool_spec_to_code_mode_tool_definition(spec: &ToolSpec) -> Option<CodeModeToolDefinition>
```

**Purpose**: Converts one supported `ToolSpec` into a single augmented `CodeModeToolDefinition`, but only if the resulting tool name qualifies as a code-mode nested tool. It is effectively a filtered single-item conversion helper.

**Data flow**: Reads a borrowed `&ToolSpec`, obtains the first available definition via `code_mode_tool_definition_for_spec`, then checks the generated definition name with `codex_code_mode::is_code_mode_nested_tool(&definition.name)`. If the predicate is true it returns `Some(codex_code_mode::augment_tool_definition(definition))`; otherwise it returns `None`.

**Call relations**: This function is used when a caller wants one code-mode definition rather than a list. It depends on `code_mode_tool_definition_for_spec` for the actual shape conversion, then applies the external nested-tool gate before augmentation so unsupported or non-nested names are dropped.

*Call graph*: calls 1 internal fn (code_mode_tool_definition_for_spec); 1 external calls (is_code_mode_nested_tool).


##### `collect_code_mode_tool_definitions`  (lines 61–85)

```
fn collect_code_mode_tool_definitions(
    specs: impl IntoIterator<Item = &'a ToolSpec>,
) -> Vec<CodeModeToolDefinition>
```

**Purpose**: Builds the full set of code-mode tool definitions from an iterable of specs, including namespace-description prefixing, code-mode augmentation, sorting, and duplicate removal. This is the richer collection path intended for presenting complete tool definitions to code mode.

**Data flow**: Consumes any iterable of `&ToolSpec`. For each spec it expands to zero or more definitions via `code_mode_tool_definitions_for_spec`; if the spec is a namespace and `namespace.description.trim()` is non-empty, it prepends that namespace description plus a blank line to each child definition’s description. It then filters definitions to those whose names satisfy `is_code_mode_nested_tool`, maps each through `augment_tool_definition`, collects into a `Vec<CodeModeToolDefinition>`, sorts by `name`, and deduplicates adjacent equal names with `dedup_by`.

**Call relations**: This is the bulk assembly path for callers preparing a complete code-mode tool catalog. It orchestrates expansion, namespace-context injection, filtering, augmentation, and normalization; unlike the exec-prompt variant, it intentionally rewrites descriptions before returning the final list.

*Call graph*: 1 external calls (into_iter).


##### `collect_code_mode_exec_prompt_tool_definitions`  (lines 87–98)

```
fn collect_code_mode_exec_prompt_tool_definitions(
    specs: impl IntoIterator<Item = &'a ToolSpec>,
) -> Vec<CodeModeToolDefinition>
```

**Purpose**: Collects code-mode tool definitions for exec-prompt use without adding code-mode description samples or namespace-description prefixes. It returns a normalized, deduplicated list of raw converted definitions.

**Data flow**: Consumes an iterable of `&ToolSpec`, expands each spec through `code_mode_tool_definitions_for_spec`, filters to definitions whose names pass `is_code_mode_nested_tool`, collects them into a vector, sorts by `name`, and removes duplicates by equal `name`. It returns the resulting `Vec<CodeModeToolDefinition>` unchanged by augmentation.

**Call relations**: This function parallels `collect_code_mode_tool_definitions` but intentionally stops short of description augmentation. It serves callers that need the executable prompt-facing definitions in their base converted form rather than the fully enriched handbook-style descriptions.

*Call graph*: 1 external calls (into_iter).


##### `augmented_description_for_spec`  (lines 100–104)

```
fn augmented_description_for_spec(spec: &ToolSpec) -> Option<String>
```

**Purpose**: Computes just the augmented description string for a single supported tool spec. It is a narrow helper used when the caller wants to rewrite descriptions but keep the original `ToolSpec` container.

**Data flow**: Reads a borrowed `&ToolSpec`, converts it to an optional single `CodeModeToolDefinition` via `code_mode_tool_definition_for_spec`, maps that definition through `codex_code_mode::augment_tool_definition`, and extracts `definition.description` as `Option<String>`.

**Call relations**: This helper is called by `augment_tool_spec_for_code_mode` for plain function and freeform tools. It centralizes the convert-then-augment-then-extract-description sequence so the outer function only needs to decide whether to overwrite the original description.

*Call graph*: calls 1 internal fn (code_mode_tool_definition_for_spec); called by 1 (augment_tool_spec_for_code_mode).


##### `code_mode_tool_definition_for_spec`  (lines 106–108)

```
fn code_mode_tool_definition_for_spec(spec: &ToolSpec) -> Option<CodeModeToolDefinition>
```

**Purpose**: Returns the first code-mode tool definition derivable from a `ToolSpec`. It is a convenience wrapper for callers that only care about one definition even though some specs, notably namespaces, can expand to many.

**Data flow**: Reads a borrowed `&ToolSpec`, calls `code_mode_tool_definitions_for_spec(spec)` to get a `Vec<CodeModeToolDefinition>`, consumes that vector with `into_iter()`, and returns the first element as `Option<CodeModeToolDefinition>`.

**Call relations**: This function is the single-definition bridge used by both `augmented_description_for_spec` and `tool_spec_to_code_mode_tool_definition`. It delegates all variant-specific conversion logic to `code_mode_tool_definitions_for_spec` and simply truncates the result to one item.

*Call graph*: calls 1 internal fn (code_mode_tool_definitions_for_spec); called by 2 (augmented_description_for_spec, tool_spec_to_code_mode_tool_definition).


##### `code_mode_tool_definitions_for_spec`  (lines 110–155)

```
fn code_mode_tool_definitions_for_spec(spec: &ToolSpec) -> Vec<CodeModeToolDefinition>
```

**Purpose**: Performs the actual variant-by-variant conversion from internal `ToolSpec` values into one or more `CodeModeToolDefinition` records. It is the central translation routine in the file.

**Data flow**: Reads a borrowed `&ToolSpec` and matches on its variant. For `ToolSpec::Function`, it clones the tool name, builds a plain `ToolName`, copies the description, marks `kind` as `CodeModeToolKind::Function`, serializes `tool.parameters` to JSON with `serde_json::to_value(...).ok()` for `input_schema`, and copies `output_schema`. For `ToolSpec::Freeform`, it similarly emits one definition with `CodeModeToolKind::Freeform` and both schemas set to `None`. For `ToolSpec::Namespace`, it iterates `namespace.tools`, converts each `ResponsesApiNamespaceTool::Function` into a namespaced `ToolName`, derives the code-mode-visible `name` with `code_mode_name_for_tool_name`, serializes parameters, and collects all child definitions into a vector. For `ImageGeneration`, `ToolSearch`, and `WebSearch`, it returns an empty vector.

**Call relations**: This is the foundational converter used by `code_mode_tool_definition_for_spec`, and indirectly by every higher-level collection or augmentation path in the file. Other functions rely on it to flatten namespaces, preserve schemas, and omit unsupported tool categories before applying filtering or description rewriting.

*Call graph*: called by 1 (code_mode_tool_definition_for_spec); 2 external calls (new, vec!).


##### `code_mode_name_for_tool_name`  (lines 157–165)

```
fn code_mode_name_for_tool_name(tool_name: &ToolName) -> String
```

**Purpose**: Formats a `ToolName` into the string name expected by code mode, especially for namespaced nested tools. It encodes the separator policy that keeps underscore-based names readable and stable.

**Data flow**: Reads a borrowed `&ToolName` and inspects `tool_name.namespace.as_deref()` plus `tool_name.name`. If there is a namespace ending in `_` or a tool name starting with `_`, it concatenates them directly; if there is a namespace without those underscore edge cases, it returns `format!("{namespace}__{}", tool_name.name)`; if there is no namespace, it returns a clone of the plain tool name.

**Call relations**: This helper is called where namespace tools are converted into code-mode definitions, including the namespace branch of `augment_tool_spec_for_code_mode`. It isolates naming policy so all namespace-derived definitions use the same canonical code-mode identifier.

*Call graph*: called by 1 (augment_tool_spec_for_code_mode); 1 external calls (format!).


### `ext/extension-api/examples/enabled_extensions/shared_state_extension.rs`

`domain_logic` · `prompt contribution`

This module defines two `ContextContributor` implementations, `StyleContributor` and `UsageContributor`, plus the shared counter state they mutate. `install` registers both contributors into an `ExtensionRegistryBuilder<()>` as prompt contributors. Each contributor’s `contribute` method returns a boxed async future that immediately updates counters in both the session-scoped and thread-scoped `ExtensionData` stores, then yields one `PromptFragment`: `StyleContributor` emits a developer policy fragment about concise answers, while `UsageContributor` emits a developer capability fragment about contributing multiple fragments.

Shared state is represented by `ContributionCounts`, a private struct containing two `AtomicU64` fields, `style` and `usage`. The helper `contribution_counts` retrieves an `Arc<ContributionCounts>` from an `ExtensionData` store, initializing it with `Default::default` on first access. Because the same `ExtensionData` can be reused across calls, repeated contributions accumulate in the same atomics. The public accessors `recorded_style_contributions` and `recorded_usage_contributions` read those counters if present and otherwise return zero, which makes it easy for the example binary to print counts for stores that may or may not have been touched. All atomic operations use `Ordering::Relaxed`, appropriate here because the example only needs monotonic counters, not cross-thread synchronization semantics beyond atomicity.

#### Function details

##### `install`  (lines 11–14)

```
fn install(registry: &mut ExtensionRegistryBuilder<()>)
```

**Purpose**: Registers the example contributors with the host’s extension registry builder. It is the module’s public setup hook.

**Data flow**: It takes a mutable `ExtensionRegistryBuilder<()>`, wraps `StyleContributor` and `UsageContributor` in `Arc`, and passes each to `registry.prompt_contributor`. It mutates the builder and returns nothing.

**Call relations**: Called by the example `main` before the registry is built so both contributors participate in later prompt contribution.

*Call graph*: calls 1 internal fn (prompt_contributor); called by 1 (main); 1 external calls (new).


##### `StyleContributor::contribute`  (lines 20–33)

```
fn contribute(
        &'a self,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> + S
```

**Purpose**: Records one style contribution in both the session and thread stores, then returns a single developer-policy prompt fragment. It demonstrates shared mutable extension state scoped by host-chosen stores.

**Data flow**: It receives references to `session_store` and `thread_store`, creates a boxed async future, calls `contribution_counts(...).record_style()` on both stores inside that future, and returns a one-element `Vec<PromptFragment>` containing `PromptFragment::developer_policy(...)`.

**Call relations**: Invoked indirectly by the host loop in `contribute_prompt` after `install` has registered the contributor.

*Call graph*: calls 1 internal fn (contribution_counts); 2 external calls (pin, vec!).


##### `UsageContributor::contribute`  (lines 40–53)

```
fn contribute(
        &'a self,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> + S
```

**Purpose**: Records one usage contribution in both the session and thread stores, then returns a single developer-capability prompt fragment. It complements `StyleContributor` with a separate counter and fragment type.

**Data flow**: It receives the same two `ExtensionData` references, creates a boxed async future, calls `contribution_counts(...).record_usage()` for both stores, and returns a one-element `Vec<PromptFragment>` containing `PromptFragment::developer_capability(...)`.

**Call relations**: Also invoked indirectly by the host loop in `contribute_prompt` once registered by `install`.

*Call graph*: calls 1 internal fn (contribution_counts); 2 external calls (pin, vec!).


##### `recorded_style_contributions`  (lines 57–62)

```
fn recorded_style_contributions(store: &ExtensionData) -> u64
```

**Purpose**: Reads the current style-contribution count from an `ExtensionData` store. Untouched stores report zero rather than requiring prior initialization.

**Data flow**: It takes a store reference, calls `store.get::<ContributionCounts>()`, maps the stored counts to `counts.style()`, and falls back to `0` with `unwrap_or_default()` if no counts object exists.

**Call relations**: Called by the example `main` when printing per-store style counters after running contributors.


##### `recorded_usage_contributions`  (lines 65–70)

```
fn recorded_usage_contributions(store: &ExtensionData) -> u64
```

**Purpose**: Reads the current usage-contribution count from an `ExtensionData` store. Like the style accessor, it treats missing state as zero.

**Data flow**: It takes a store reference, calls `store.get::<ContributionCounts>()`, maps the result to `counts.usage()`, and returns zero if the store has not been initialized with counters.

**Call relations**: Called by the example `main` when printing per-store usage counters.


##### `ContributionCounts::record_style`  (lines 79–81)

```
fn record_style(&self)
```

**Purpose**: Atomically increments the style counter. It is the write-side primitive used by `StyleContributor`.

**Data flow**: It borrows `self`, performs `self.style.fetch_add(1, Ordering::Relaxed)`, and returns nothing.

**Call relations**: Reached through `contribution_counts(session_store)` and `contribution_counts(thread_store)` inside `StyleContributor::contribute`.

*Call graph*: 1 external calls (fetch_add).


##### `ContributionCounts::record_usage`  (lines 83–85)

```
fn record_usage(&self)
```

**Purpose**: Atomically increments the usage counter. It is the write-side primitive used by `UsageContributor`.

**Data flow**: It borrows `self`, performs `self.usage.fetch_add(1, Ordering::Relaxed)`, and returns nothing.

**Call relations**: Reached through `contribution_counts(...)` inside `UsageContributor::contribute`.

*Call graph*: 1 external calls (fetch_add).


##### `ContributionCounts::style`  (lines 87–89)

```
fn style(&self) -> u64
```

**Purpose**: Reads the current style counter value. It is the internal accessor behind the public style-count helper.

**Data flow**: It borrows `self`, loads `self.style` with `Ordering::Relaxed`, and returns the `u64` count.

**Call relations**: Called by `recorded_style_contributions` after retrieving the shared counts object from a store.

*Call graph*: 1 external calls (load).


##### `ContributionCounts::usage`  (lines 91–93)

```
fn usage(&self) -> u64
```

**Purpose**: Reads the current usage counter value. It is the internal accessor behind the public usage-count helper.

**Data flow**: It borrows `self`, loads `self.usage` with `Ordering::Relaxed`, and returns the `u64` count.

**Call relations**: Called by `recorded_usage_contributions` after retrieving the shared counts object from a store.

*Call graph*: 1 external calls (load).


##### `contribution_counts`  (lines 96–98)

```
fn contribution_counts(store: &ExtensionData) -> Arc<ContributionCounts>
```

**Purpose**: Fetches or lazily initializes the shared `ContributionCounts` object stored in an `ExtensionData`. It centralizes the store key/type lookup used by both contributors.

**Data flow**: It takes a store reference and calls `store.get_or_init::<ContributionCounts>(Default::default)`, returning an `Arc<ContributionCounts>` that may be newly created or previously stored.

**Call relations**: Used by both contributor implementations so they mutate the same per-store counter object across repeated calls.

*Call graph*: called by 2 (contribute, contribute).


### Memories and goal steering
This group wires memory-backed prompt contributions into the extension system and adds goal-oriented steering and memory-writing prompt templates.

### `ext/memories/src/extension.rs`

`orchestration` · `startup and thread/config setup`

This module packages memories support as a Codex extension. `MemoriesExtension` is a lightweight contributor object carrying an optional `MetricsClient`; `MemoriesExtensionConfig` is the per-thread snapshot of the subset of `Config` that matters to this feature: whether the memory tool is enabled, whether dedicated tools should be exposed, and the `codex_home` path used to locate the memory store.

The extension participates in three extension lifecycles. On thread start and on config changes, it computes and stores a fresh `MemoriesExtensionConfig` in the thread-local `ExtensionData`, ensuring later contributors read a consistent, already-filtered view of configuration. As a `ContextContributor`, it checks that config exists and is enabled, then asynchronously builds developer instructions from the memory store location and wraps the resulting text as a developer-policy `PromptFragment`. As a `ToolContributor`, it only exposes tools when both `enabled` and `dedicated_tools` are true; in that case it constructs a `LocalMemoriesBackend` rooted under `<codex_home>/memories` and passes it, along with metrics, into `tools::memory_tools`.

The top-level `install` function registers the same shared `Arc<MemoriesExtension>` instance for thread lifecycle, config, prompt, and tool contribution. That design keeps all memories-related extension behavior centralized and ensures each contributor sees the same metrics configuration.

#### Function details

##### `MemoriesExtension::new`  (lines 28–30)

```
fn new(metrics_client: Option<MetricsClient>) -> Self
```

**Purpose**: Creates a `MemoriesExtension` carrying the optional metrics client. It is the single constructor used when installing the extension into the registry.

**Data flow**: Accepts `metrics_client: Option<MetricsClient>` and returns `MemoriesExtension { metrics_client }`. It only initializes struct state and performs no I/O.

**Call relations**: Called by `install` before the extension is wrapped in `Arc` and registered as multiple contributor types. It does not delegate further.

*Call graph*: called by 1 (install).


##### `MemoriesExtensionConfig::from_config`  (lines 41–47)

```
fn from_config(config: &Config) -> Self
```

**Purpose**: Extracts the memories-specific runtime settings from the broader application `Config`. It folds feature gating and memories settings into one compact thread-store value.

**Data flow**: Reads `config.features.enabled(Feature::MemoryTool)`, `config.memories.use_memories`, `config.memories.dedicated_tools`, and `config.codex_home.clone()`, then returns a new `MemoriesExtensionConfig`. The `enabled` field is computed as the conjunction of the feature flag and `use_memories`.

**Call relations**: Used whenever thread-local extension state must be initialized or refreshed: `on_thread_start` inserts the initial snapshot, and `on_config_changed` replaces it after config updates. It is a pure transformation with no downstream calls beyond field access.

*Call graph*: called by 2 (on_config_changed, on_thread_start).


##### `MemoriesExtension::contribute`  (lines 51–70)

```
fn contribute(
        &'a self,
        _session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> +
```

**Purpose**: Produces developer prompt fragments that explain memory-tool behavior, but only when the current thread has memories enabled. If configuration is absent or disabled, it contributes nothing.

**Data flow**: Reads `MemoriesExtensionConfig` from `thread_store`; if missing or `enabled == false`, returns an empty `Vec<PromptFragment>`. Otherwise it awaits `build_memory_tool_developer_instructions(&config.codex_home)`, maps any resulting instruction text into `PromptFragment::developer_policy`, and collects the optional fragment into a vector.

**Call relations**: Invoked by the extension framework during prompt assembly. It delegates the actual instruction generation to `build_memory_tool_developer_instructions`, then adapts that output into the prompt system’s fragment type.

*Call graph*: calls 1 internal fn (build_memory_tool_developer_instructions); 2 external calls (pin, new).


##### `MemoriesExtension::on_thread_start`  (lines 74–83)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: Seeds the thread-local extension store with the memories configuration snapshot at thread creation time. This ensures later prompt and tool contributors can read config without touching the global `Config` directly.

**Data flow**: Receives `ThreadStartInput<'_, Config>`, reads `input.config`, computes `MemoriesExtensionConfig::from_config(input.config)`, and inserts the result into `input.thread_store`. It returns an async future that resolves to `()`.

**Call relations**: Called by the extension runtime when a new thread/session context starts. It delegates config extraction to `MemoriesExtensionConfig::from_config` and writes the result into extension data for subsequent contributors.

*Call graph*: calls 1 internal fn (from_config); 1 external calls (pin).


##### `MemoriesExtension::on_config_changed`  (lines 87–95)

```
fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    )
```

**Purpose**: Refreshes the thread-local memories configuration whenever the application config changes. It keeps prompt and tool behavior aligned with the latest feature flags and paths.

**Data flow**: Ignores the session store and previous config, reads `new_config`, computes `MemoriesExtensionConfig::from_config(new_config)`, and inserts that value into `thread_store`. It returns no value.

**Call relations**: Triggered by the extension framework on config updates. It mirrors `on_thread_start`’s initialization path, reusing `from_config` so all config-derived behavior stays consistent.

*Call graph*: calls 2 internal fn (insert, from_config).


##### `MemoriesExtension::tools`  (lines 99–115)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>>
```

**Purpose**: Builds the dedicated memories tool executors when the feature is enabled and configured to expose standalone tools. Otherwise it returns no tools at all.

**Data flow**: Reads `MemoriesExtensionConfig` from `thread_store`; if absent, disabled, or `dedicated_tools == false`, returns an empty vector. Otherwise it constructs a `LocalMemoriesBackend` from `config.codex_home`, clones the optional metrics client from `self`, and returns the vector produced by `tools::memory_tools(...)`.

**Call relations**: Invoked during tool registration/discovery for a thread. It delegates backend construction to `LocalMemoriesBackend::from_codex_home` and tool object creation to `tools::memory_tools`, acting as the gatekeeper based on config flags.

*Call graph*: calls 2 internal fn (from_codex_home, memory_tools); 1 external calls (new).


##### `install`  (lines 119–128)

```
fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    metrics_client: Option<MetricsClient>,
)
```

**Purpose**: Registers the memories extension with all relevant extension hooks in the registry. It is the single entry used by the host application to enable this extension.

**Data flow**: Accepts a mutable `ExtensionRegistryBuilder<Config>` and optional `MetricsClient`, constructs a `MemoriesExtension`, wraps it in `Arc`, then passes clones of that shared instance into `thread_lifecycle_contributor`, `config_contributor`, `prompt_contributor`, and `tool_contributor`. It mutates the registry by adding contributors.

**Call relations**: Called from higher-level extension setup code during startup. It creates the extension via `MemoriesExtension::new` and wires the same object into all four registry roles so lifecycle, prompt, and tool behavior stay coordinated.

*Call graph*: calls 5 internal fn (config_contributor, prompt_contributor, thread_lifecycle_contributor, tool_contributor, new); 1 external calls (new).


### `ext/memories/src/prompts.rs`

`domain_logic` · `prompt contribution when assembling developer instructions`

This file is the prompt-construction side of the memories extension. It embeds the `memories/read_path.md` template at compile time, parses it once into a `LazyLock<Template>`, and exposes a single async builder that fills in runtime values from the configured Codex home directory. The helper `parse_embedded_template` treats template validity as a build-time invariant in practice: if the embedded source cannot be parsed, it panics immediately with the template name, because shipping with a broken embedded prompt is considered unrecoverable.

`build_memory_tool_developer_instructions` computes `<codex_home>/memories/memory_summary.md`, reads it asynchronously, and short-circuits to `None` if the file is missing or unreadable. It trims surrounding whitespace before truncation so empty-or-whitespace summaries do not produce a prompt fragment. Truncation uses `truncate_text` with `TruncationPolicy::Tokens(MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT)`, ensuring the injected summary stays within a bounded token budget while preserving the rest of the template. If truncation yields an empty string, the function again returns `None`. Otherwise it renders the cached template with two variables: the display form of the memories base path and the truncated summary text. Rendering failures are downgraded to `None` rather than panicking, making prompt contribution optional at runtime even though template parsing itself is strict.

#### Function details

##### `parse_embedded_template`  (lines 16–21)

```
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template
```

**Purpose**: Parses an embedded template string into a reusable `Template`, failing fast if the checked-in template source is invalid.

**Data flow**: It takes the static template source and a human-readable template name, calls `Template::parse`, and returns the parsed `Template` on success. On parse failure it panics with a message that includes the template name and parser error.

**Call relations**: This helper is used during initialization of the `LazyLock` template singleton, so it runs only when the embedded prompt template is first needed. It delegates parsing to the template library and intentionally does not attempt recovery.

*Call graph*: calls 1 internal fn (parse); 1 external calls (panic!).


##### `build_memory_tool_developer_instructions`  (lines 27–51)

```
async fn build_memory_tool_developer_instructions(
    codex_home: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Reads `memory_summary.md`, token-truncates it, and renders the embedded read-path template into the developer-instructions fragment contributed by the extension.

**Data flow**: It receives `&AbsolutePathBuf` for `codex_home`, joins `memories` and `memory_summary.md`, asynchronously reads the file, trims and clones the contents into an owned `String`, truncates that text with a token-based policy, and returns `None` if reading fails or the resulting summary is empty. Otherwise it converts the memories base path to a display string, renders the cached template with `base_path` and `memory_summary`, and returns `Some(rendered_text)` if rendering succeeds.

**Call relations**: The extension's `contribute` flow calls this only when memory prompt contribution is enabled. It delegates filesystem access to `tokio::fs::read_to_string`, truncation to `truncate_text`, and final formatting to the lazily parsed template.

*Call graph*: calls 1 internal fn (join); called by 1 (contribute); 3 external calls (truncate_text, read_to_string, Tokens).


### `memories/write/src/prompts.rs`

`domain_logic` · `request construction`

This file centralizes prompt construction for both memory phases. It stores four `LazyLock<Template>` statics: the main consolidation prompt, the stage-one input wrapper, and two optional blocks describing memory extensions. `parse_embedded_template` validates each embedded template at process initialization time and panics immediately if any bundled prompt is malformed, making template correctness a startup invariant rather than a runtime surprise.

`build_consolidation_prompt` renders the phase-2 subagent prompt for a specific memory root. It computes the extensions directory path, checks whether that directory exists, and conditionally renders extension-specific sections only when present. It also injects the workspace diff filename so the agent is explicitly directed to inspect the generated diff file first. If rendering fails, it logs a warning and falls back to a minimal plain-text prompt that still points at the memory root and diff file.

`build_stage_one_input_message` renders the user message sent to the phase-1 extraction model. Before rendering, it derives a token budget from `ModelInfo::resolved_context_window`, the model’s `effective_context_window_percent`, and a crate-level `CONTEXT_WINDOW_PERCENT`, with a default fallback when model limits are unavailable. It then truncates rollout contents with a token-based head-and-tail policy and injects rollout path, cwd, and truncated contents into the stage-one template.

#### Function details

##### `parse_embedded_template`  (lines 35–40)

```
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template
```

**Purpose**: Parses an embedded template string into a reusable `Template` and fails fast if the bundled template source is invalid. It turns prompt syntax errors into immediate panics with the template name included.

**Data flow**: Takes a static template source string and a human-readable template name. It calls `Template::parse`; on success it returns the parsed `Template`, and on error it panics with a formatted message. It reads no external state.

**Call relations**: Used during initialization of the `LazyLock<Template>` statics in this file so prompt parsing happens once and all later render calls can assume valid templates.

*Call graph*: calls 1 internal fn (parse); 1 external calls (panic!).


##### `build_consolidation_prompt`  (lines 43–87)

```
fn build_consolidation_prompt(memory_root: &Path) -> String
```

**Purpose**: Renders the full phase-2 consolidation prompt for a given memories root, optionally including extension-specific guidance blocks when an extensions directory exists. It also embeds the workspace diff filename the agent should inspect.

**Data flow**: Accepts `memory_root: &Path`. It derives `memory_extensions_root`, checks `is_dir()`, converts paths to display strings, computes the diff filename from `workspace_diff::FILENAME`, conditionally renders the folder-structure and primary-inputs blocks via `render_memory_extensions_block`, and renders `CONSOLIDATION_PROMPT_TEMPLATE` with those values. If rendering fails, it logs a warning and returns a fallback string mentioning the memory root and diff file.

**Call relations**: Called by `agent::get_prompt` in phase 2 and by a prompt-focused test. It delegates optional block rendering to `render_memory_extensions_block`.

*Call graph*: calls 1 internal fn (render_memory_extensions_block); 4 external calls (as_str, display, new, memory_extensions_root).


##### `render_memory_extensions_block`  (lines 89–96)

```
fn render_memory_extensions_block(template: &Template, memory_extensions_root: &str) -> String
```

**Purpose**: Renders one extension-related prompt fragment with the extensions root path substituted. On render failure it degrades to an empty block instead of aborting prompt construction.

**Data flow**: Takes a parsed `Template` and the extensions-root string, renders with a single `memory_extensions_root` variable, and returns the rendered string. If rendering fails, it logs a warning and returns `String::new()`.

**Call relations**: Used only by `build_consolidation_prompt` for the two optional extension sections.

*Call graph*: calls 1 internal fn (render); called by 1 (build_consolidation_prompt).


##### `build_stage_one_input_message`  (lines 102–127)

```
fn build_stage_one_input_message(
    model_info: &ModelInfo,
    rollout_path: &Path,
    rollout_cwd: &Path,
    rollout_contents: &str,
) -> anyhow::Result<String>
```

**Purpose**: Builds the phase-1 user message containing rollout metadata and rollout contents truncated to a model-aware token budget. It preserves both beginning and end context through the truncation helper.

**Data flow**: Inputs are `&ModelInfo`, rollout path, rollout cwd, and the raw rollout contents string. It computes `rollout_token_limit` from `resolved_context_window()`, filters out non-positive limits, scales by `effective_context_window_percent` and the crate’s `CONTEXT_WINDOW_PERCENT`, converts to `usize`, and falls back to `DEFAULT_ROLLOUT_TOKEN_LIMIT` if any step fails. It truncates `rollout_contents` with `truncate_text(TruncationPolicy::Tokens(limit))`, converts the paths to strings, renders `STAGE_ONE_INPUT_TEMPLATE` with `rollout_path`, `rollout_cwd`, and `rollout_contents`, and returns `anyhow::Result<String>`.

**Call relations**: Called by phase-1 sampling when constructing the extraction prompt, and covered by tests that verify both model-derived and default truncation limits.

*Call graph*: calls 1 internal fn (resolved_context_window); 4 external calls (as_str, display, truncate_text, Tokens).


### `ext/goal/src/steering.rs`

`domain_logic` · `request handling / model steering injection`

This file turns persisted `ThreadGoal` state into `ResponseItem` context fragments using embedded Markdown templates. Three `LazyLock<Template>` statics parse template files once at first use; invalid embedded templates are treated as programmer errors and cause an immediate panic during parsing or rendering. The public crate-visible entry points each correspond to a specific runtime situation: continuing work on an active goal, informing the model that a budget limit was hit, or informing it that the objective changed externally. All three route through `goal_context_input_item`, which wraps the rendered prompt string in an `InternalModelContextFragment` sourced from the static label `goal`, then converts that fragment into a `ContextualUserFragment`/`ResponseItem`. Prompt rendering extracts concrete fields from `ThreadGoal`, computes display values such as `remaining_tokens`, and normalizes absent budgets to strings like `none`, `unbounded`, or `unknown` depending on the scenario. Objective text is XML-escaped before interpolation so embedded templates can safely include it inside XML-like markup without accidental tag injection. Remaining-token calculations clamp at zero, preventing negative values when usage has exceeded budget.

#### Function details

##### `parse_embedded_template`  (lines 30–35)

```
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template
```

**Purpose**: Parses one embedded template string into a reusable `Template` and crashes fast if the checked-in template is invalid. It centralizes the invariant that bundled prompt templates must always parse successfully.

**Data flow**: It takes the template source and a human-readable template name, calls `Template::parse`, returns the parsed `Template` on success, and panics with the template name and parse error on failure.

**Call relations**: It is used only by the three `LazyLock` initializers at static initialization time on first access. It delegates parsing to the template library so later prompt functions can assume a valid compiled template exists.

*Call graph*: calls 1 internal fn (parse); 1 external calls (panic!).


##### `budget_limit_steering_item`  (lines 37–39)

```
fn budget_limit_steering_item(goal: &ThreadGoal) -> ResponseItem
```

**Purpose**: Builds the internal response item shown when a goal has reached its budget limit. It combines budget-limit-specific prompt rendering with the standard goal context wrapper.

**Data flow**: It reads a `&ThreadGoal`, renders a prompt string via `budget_limit_prompt`, wraps that string through `goal_context_input_item`, and returns the resulting `ResponseItem`.

**Call relations**: It is invoked from the runtime's tool-finish path when budget-limit steering must be injected. It delegates all formatting to `budget_limit_prompt` and all context-item construction to `goal_context_input_item`.

*Call graph*: calls 2 internal fn (budget_limit_prompt, goal_context_input_item); called by 1 (on_tool_finish).


##### `objective_updated_steering_item`  (lines 41–43)

```
fn objective_updated_steering_item(goal: &ThreadGoal) -> ResponseItem
```

**Purpose**: Builds the internal response item that tells the model the goal objective was externally changed or resumed with a new objective context. It ensures the update is delivered as model-visible internal context rather than ordinary user text.

**Data flow**: It takes a `&ThreadGoal`, renders the objective-updated prompt, wraps it as a goal-sourced internal context fragment, and returns the `ResponseItem`.

**Call relations**: It is called by the external-goal-set application flow after a goal mutation. It delegates prompt text generation to `objective_updated_prompt` and packaging to `goal_context_input_item`.

*Call graph*: calls 2 internal fn (goal_context_input_item, objective_updated_prompt); called by 1 (apply_external_goal_set).


##### `continuation_steering_item`  (lines 45–47)

```
fn continuation_steering_item(goal: &ThreadGoal) -> ResponseItem
```

**Purpose**: Builds the internal response item used to continue work on an active goal. It presents the current objective and usage/budget state back to the model in a templated continuation prompt.

**Data flow**: It accepts a `&ThreadGoal`, computes the continuation prompt string through `continuation_prompt`, wraps it into an internal goal context item, and returns that `ResponseItem`.

**Call relations**: It is triggered by the idle-continuation path when the system decides to continue an active goal automatically. It delegates rendering and wrapping to the two helper functions beneath it.

*Call graph*: calls 2 internal fn (continuation_prompt, goal_context_input_item); called by 1 (continue_if_idle).


##### `goal_context_input_item`  (lines 49–54)

```
fn goal_context_input_item(prompt: String) -> ResponseItem
```

**Purpose**: Converts a rendered goal prompt string into the concrete internal context item type consumed by the protocol layer. It standardizes the source label and fragment shape for all goal steering messages.

**Data flow**: It takes an owned `String` prompt, creates an `InternalModelContextFragment` with `InternalContextSource::from_static("goal")`, converts that fragment into a `ContextualUserFragment`, and returns the resulting `ResponseItem`.

**Call relations**: It is the shared sink for all three steering-item constructors. Those callers use it so every goal prompt enters the model context with the same internal source metadata.

*Call graph*: calls 3 internal fn (into, from_static, new); called by 3 (budget_limit_steering_item, continuation_steering_item, objective_updated_steering_item).


##### `continuation_prompt`  (lines 56–78)

```
fn continuation_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Renders the continuation template with the current objective, tokens used, token budget, and remaining tokens. It prepares user-safe string values and enforces non-negative remaining-budget display.

**Data flow**: It reads fields from `ThreadGoal`, XML-escapes `goal.objective`, stringifies `tokens_used`, derives `token_budget` as either the numeric budget or `none`, derives `remaining_tokens` as clamped `budget - tokens_used` or `unbounded`, renders `CONTINUATION_PROMPT_TEMPLATE`, and returns the final prompt string or panics if rendering fails.

**Call relations**: It is called only by `continuation_steering_item`. It depends on `escape_xml_text` for safe interpolation and on the lazily parsed continuation template for final formatting.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (continuation_steering_item).


##### `budget_limit_prompt`  (lines 80–99)

```
fn budget_limit_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Renders the budget-limit template with the objective and final usage figures at the point the budget cap was reached. It is tailored to explain a stop caused by budget exhaustion rather than ordinary continuation.

**Data flow**: It reads `objective`, `time_used_seconds`, `tokens_used`, and optional `token_budget` from `ThreadGoal`, escapes and stringifies them, renders `BUDGET_LIMIT_PROMPT_TEMPLATE`, and returns the prompt string or panics on render failure.

**Call relations**: It is used exclusively by `budget_limit_steering_item`. It delegates objective sanitization to `escape_xml_text` and relies on the embedded budget-limit template to shape the final message.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (budget_limit_steering_item).


##### `objective_updated_prompt`  (lines 101–122)

```
fn objective_updated_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Renders the objective-updated template after an external goal mutation. It includes the new objective and current usage state, with a distinct representation for missing budgets.

**Data flow**: It reads the goal objective and token counters, escapes the objective, computes `(token_budget, remaining_tokens)` as numeric strings when a budget exists or `("none", "unknown")` when absent, renders `OBJECTIVE_UPDATED_PROMPT_TEMPLATE`, and returns the resulting string or panics if rendering fails.

**Call relations**: It is called only by `objective_updated_steering_item`. It uses `escape_xml_text` to protect template markup and the dedicated objective-updated template to produce the final steering text.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (objective_updated_steering_item).


##### `escape_xml_text`  (lines 124–129)

```
fn escape_xml_text(input: &str) -> String
```

**Purpose**: Escapes the three XML-sensitive characters used in goal objectives before template interpolation. This prevents raw objective text from breaking XML-like prompt structure.

**Data flow**: It takes an input `&str`, performs chained replacements of `&`, `<`, and `>` with `&amp;`, `&lt;`, and `&gt;`, and returns the escaped `String`.

**Call relations**: It is a local helper used by all prompt-rendering functions before they pass objective text into templates. Those callers rely on it to preserve prompt structure regardless of user-provided objective content.

*Call graph*: called by 3 (budget_limit_prompt, continuation_prompt, objective_updated_prompt).


### `prompts/src/goals.rs`

`domain_logic` · `prompt construction during request handling`

This file is a small prompt-construction module centered on three lazily parsed embedded templates. Each `LazyLock<Template>` loads a Markdown file from `templates/goals/*.md` at first use and panics immediately if the embedded template is invalid, treating template correctness as a build-time/runtime invariant rather than a recoverable condition.

The three public functions all accept a `&ThreadGoal` and derive a small set of string substitutions from its fields. `continuation_prompt` and `objective_updated_prompt` compute `token_budget`, `remaining_tokens`, `tokens_used`, and an XML-escaped `objective`; when no budget exists they use the sentinel strings `none` and `unbounded`. Remaining tokens are clamped with `.max(0)` so over-budget goals never render a negative count. `budget_limit_prompt` instead renders `token_budget`, `tokens_used`, `time_used_seconds`, and the escaped objective, matching the information needed when asking the model to wrap up.

All three functions call `Template::render` with fixed key/value pairs and panic if rendering fails, again assuming embedded templates and code stay in sync. The private `escape_xml_text` helper performs minimal escaping of `&`, `<`, and `>` so arbitrary objective text can be safely interpolated into XML-like sections inside the templates without breaking markup structure.

#### Function details

##### `continuation_prompt`  (lines 32–53)

```
fn continuation_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Renders the hidden prompt used to continue work on an active goal after a prior turn completes. It includes current objective text and token-usage accounting, including remaining budget when applicable.

**Data flow**: It reads `goal.token_budget`, `goal.tokens_used`, and `goal.objective`; converts the optional budget into either a numeric string or `"none"`; computes remaining tokens as `(budget - goal.tokens_used).max(0)` or `"unbounded"`; converts `tokens_used` to string; escapes the objective with `escape_xml_text`; then renders `CONTINUATION_PROMPT_TEMPLATE` with those four bindings. It returns the rendered `String` or panics if template rendering fails.

**Call relations**: Goal-management code calls this when a thread should keep pursuing the same objective. It delegates only the objective sanitization to `escape_xml_text`, relying on the pre-parsed embedded template for final formatting.

*Call graph*: calls 1 internal fn (escape_xml_text); 1 external calls (panic!).


##### `budget_limit_prompt`  (lines 57–75)

```
fn budget_limit_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Renders the hidden prompt used when a goal has exhausted its budget and the model should wrap up. It emphasizes consumed budget and elapsed time rather than remaining tokens.

**Data flow**: It reads `goal.token_budget`, `goal.tokens_used`, `goal.time_used_seconds`, and `goal.objective`; converts the optional budget to a numeric string or `"none"`; stringifies tokens used and time used; escapes the objective via `escape_xml_text`; then renders `BUDGET_LIMIT_PROMPT_TEMPLATE` with those bindings. It returns the rendered prompt string or panics on render failure.

**Call relations**: This function is used in the budget-exhaustion branch of goal handling. It shares the same sanitization and panic-on-template-mismatch strategy as the other prompt builders.

*Call graph*: calls 1 internal fn (escape_xml_text); 1 external calls (panic!).


##### `objective_updated_prompt`  (lines 78–99)

```
fn objective_updated_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Renders the hidden prompt used after a user edits an active goal’s objective. It restates the updated objective together with current token accounting so the model can continue under the revised target.

**Data flow**: It reads `goal.token_budget`, `goal.tokens_used`, and `goal.objective`; computes `token_budget`, `remaining_tokens`, and `tokens_used` strings exactly as in `continuation_prompt`; escapes the objective with `escape_xml_text`; then renders `OBJECTIVE_UPDATED_PROMPT_TEMPLATE` with those values. It returns the rendered `String` or panics if rendering fails.

**Call relations**: Goal-update handling calls this after an objective edit. Its control flow mirrors `continuation_prompt`, differing only in which embedded template it renders.

*Call graph*: calls 1 internal fn (escape_xml_text); 1 external calls (panic!).


##### `escape_xml_text`  (lines 101–106)

```
fn escape_xml_text(input: &str) -> String
```

**Purpose**: Escapes the minimal set of XML-sensitive characters needed for safe interpolation of free-form objective text into XML-like prompt templates. It prevents user text from being interpreted as markup.

**Data flow**: It takes `&str input`, performs chained string replacements for `&` to `&amp;`, `<` to `&lt;`, and `>` to `&gt;`, and returns the escaped `String`.

**Call relations**: All three prompt-rendering functions call this before passing the objective into template rendering, making it the shared sanitization step for goal prompt generation.

*Call graph*: called by 3 (budget_limit_prompt, continuation_prompt, objective_updated_prompt).


### Review flow prompts
These files resolve review requests into concrete prompts and render the exit snippets used when review flows complete or stop.

### `prompts/src/review_request.rs`

`domain_logic` · `review request handling`

This module turns `codex_protocol::protocol::ReviewRequest` and `ReviewTarget` values into prompt text suitable for a review thread. It defines `ResolvedReviewRequest`, which preserves the chosen `ReviewTarget` while adding the computed `prompt` and `user_facing_hint`. Prompt generation is split by target type in `review_prompt`: uncommitted changes use a fixed sentence; base-branch reviews first call `merge_base_with_head(cwd, branch)` and, if a merge base SHA is available, render a precise prompt instructing the reviewer to diff against that SHA, otherwise falling back to a backup prompt that explains how to compute the merge base manually against the branch’s upstream; commit reviews choose between title-bearing and title-less templates; custom reviews trim user instructions and reject empty-or-whitespace-only prompts with `anyhow::bail!`. `resolve_review_request` orchestrates this by consuming the incoming request, computing the prompt, and filling in `user_facing_hint` from the request if already supplied or from `user_facing_hint(&target)` otherwise. The hint generator mirrors target semantics, shortening commit SHAs to seven characters and preserving custom instructions after trimming. A `From<ResolvedReviewRequest> for ReviewRequest` implementation converts back to the wire type while retaining the resolved hint.

#### Function details

##### `resolve_review_request`  (lines 42–57)

```
fn resolve_review_request(
    request: ReviewRequest,
    cwd: &AbsolutePathBuf,
) -> anyhow::Result<ResolvedReviewRequest>
```

**Purpose**: Consumes a `ReviewRequest`, computes its concrete prompt, and ensures a user-facing hint is present in the resolved result.

**Data flow**: Takes ownership of `request`, extracts its `target`, calls `review_prompt(&target, cwd)` to compute the prompt, then either uses `request.user_facing_hint` if provided or computes one with `user_facing_hint(&target)`. It returns `Ok(ResolvedReviewRequest { target, prompt, user_facing_hint })` or propagates any prompt-generation error.

**Call relations**: This is the main entry for higher-level review orchestration. It delegates target-specific prompt generation to `review_prompt` and only fills in the missing hint when the caller did not already provide one.

*Call graph*: calls 1 internal fn (review_prompt).


##### `review_prompt`  (lines 59–99)

```
fn review_prompt(target: &ReviewTarget, cwd: &AbsolutePathBuf) -> anyhow::Result<String>
```

**Purpose**: Generates the actual review instructions string for a specific `ReviewTarget`, including git-aware base-branch handling and validation of custom prompts.

**Data flow**: Matches on `target`: returns a fixed string for `UncommittedChanges`; for `BaseBranch`, calls `merge_base_with_head(cwd, branch)` and renders either the merge-base-aware template or the backup template depending on whether a SHA is returned; for `Commit`, renders either the title-bearing or plain commit template; for `Custom`, trims `instructions`, errors if empty, otherwise returns the trimmed text. It yields `anyhow::Result<String>`.

**Call relations**: Called by `resolve_review_request` whenever a review request is resolved. It delegates all template substitution to `render_review_prompt` and is the only place that touches git state via `merge_base_with_head`.

*Call graph*: calls 1 internal fn (render_review_prompt); called by 1 (resolve_review_request); 2 external calls (bail!, merge_base_with_head).


##### `render_review_prompt`  (lines 101–108)

```
fn render_review_prompt(
    template: &Template,
    variables: [(&'a str, &'a str); N],
) -> String
```

**Purpose**: Renders one of the review prompt templates with a fixed-size array of string variables.

**Data flow**: Accepts a parsed `Template` reference and an array of key/value pairs, calls `template.render(variables)`, and returns the rendered `String`, panicking if rendering fails.

**Call relations**: Used internally by `review_prompt` for base-branch and commit prompt variants. It centralizes the panic-on-static-template-failure behavior.

*Call graph*: calls 1 internal fn (render); called by 1 (review_prompt).


##### `user_facing_hint`  (lines 110–124)

```
fn user_facing_hint(target: &ReviewTarget) -> String
```

**Purpose**: Produces a short human-readable summary of what is being reviewed, suitable for UI display or thread metadata.

**Data flow**: Matches on `ReviewTarget`: returns `current changes` for uncommitted changes, formats `changes against '<branch>'` for base-branch reviews, shortens commit SHAs to seven characters and optionally appends the title for commit reviews, and trims custom instructions for custom reviews. It returns the resulting `String`.

**Call relations**: Used by `resolve_review_request` only when the incoming request omitted `user_facing_hint`. It mirrors the same target branching as `review_prompt` but produces concise labels instead of full instructions.

*Call graph*: 1 external calls (format!).


##### `ReviewRequest::from`  (lines 127–132)

```
fn from(resolved: ResolvedReviewRequest) -> Self
```

**Purpose**: Converts a resolved review request back into the protocol wire type while preserving the resolved hint.

**Data flow**: Consumes `ResolvedReviewRequest`, moves out its `target`, wraps `user_facing_hint` in `Some(...)`, and constructs a new `ReviewRequest` with those fields.

**Call relations**: This conversion is used when downstream code needs to serialize or pass along the resolved request in protocol form after prompt resolution has already happened.


### `prompts/src/review_exit.rs`

`domain_logic` · `review completion`

This module is a small rendering layer around two embedded review-exit templates: `exit_success.xml` and `exit_interrupted.xml`. The success template is parsed once into a `LazyLock<Template>` after first passing through `normalize_review_template_line_endings`, which rewrites CRLF or bare CR into LF and returns either a borrowed or owned `Cow<str>` depending on whether rewriting was needed. `render_review_exit_success` then renders that parsed template with a single `results` variable, panicking if the static template fails to render because such failures are treated as build-time invariants. The interrupted variant is simpler: `render_review_exit_interrupted` does not use the templating engine because it has no placeholders, and instead just returns the normalized template text as an owned `String`. The normalization helper is important because these templates are included from disk and may carry platform-specific line endings; by canonicalizing them before parsing or returning them, the module ensures deterministic prompt text and stable tests regardless of checkout environment.

#### Function details

##### `render_review_exit_success`  (lines 16–20)

```
fn render_review_exit_success(results: &str) -> String
```

**Purpose**: Renders the successful-review exit XML by substituting the supplied review results into the pre-parsed success template.

**Data flow**: Accepts a `&str` containing review findings, feeds it as the `results` variable into `REVIEW_EXIT_SUCCESS_TEMPLATE.render`, and returns the rendered `String`. Rendering errors trigger a panic because the template is expected to be statically valid.

**Call relations**: Called when the system needs to package completed review output into the user-action XML envelope. It relies on the lazily initialized template prepared at module load time.


##### `render_review_exit_interrupted`  (lines 22–24)

```
fn render_review_exit_interrupted() -> String
```

**Purpose**: Returns the interrupted-review exit XML with normalized line endings and no variable substitution.

**Data flow**: Reads the embedded interrupted template text, passes it through `normalize_review_template_line_endings`, converts the resulting `Cow<str>` into an owned `String`, and returns it.

**Call relations**: Used for the interruption path of review exit handling. It delegates only to the line-ending normalizer because this template has no placeholders to render.

*Call graph*: calls 1 internal fn (normalize_review_template_line_endings).


##### `normalize_review_template_line_endings`  (lines 26–32)

```
fn normalize_review_template_line_endings(template: &str) -> Cow<'_, str>
```

**Purpose**: Canonicalizes template text to LF line endings while avoiding allocation when the input already contains no carriage returns.

**Data flow**: Inspects the input `template` string for `\r`; if present, creates an owned string by replacing `\r\n` with `\n` and then any remaining `\r` with `\n`, returning `Cow::Owned`. If no carriage returns are found, it returns `Cow::Borrowed(template)` unchanged.

**Call relations**: Called during lazy initialization of the success template and directly by `render_review_exit_interrupted`. It provides the cross-platform normalization invariant for this module.

*Call graph*: called by 1 (render_review_exit_interrupted); 2 external calls (Borrowed, Owned).
