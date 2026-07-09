# Instruction, skill, plugin, memory, and review prompt contributors  `stage-12.3`

This stage is behind-the-scenes prompt assembly. It gathers all the extra guidance the model should see before or during the main work loop, like notes placed on a workbench before starting a task. Some files load standing instructions: global Codex instructions, project AGENTS.md files, collaboration mode, personality style, terminal formatting, IDE context, image-save notes, and permission rules. Others describe optional capabilities. Skills code selects skills named by the user, removes duplicates, bridges Codex data into the skills system, and renders available or enabled skills within a size limit. App and plugin code similarly lists connectors, plugin tools, servers, and plugin-specific guidance only when they exist or are mentioned. Code-mode support reshapes tool descriptions for a stricter runtime format. Extension examples show how prompt snippets can be added with shared state. Memory files decide when memories apply, summarize saved memories, and build prompts for writing or merging them. Goal files create reminders about objectives and budgets. Review files turn review requests and endings into clear prompts. Together, these pieces make the model’s context accurate, relevant, and not overloaded.

## Files in this stage

### Project and user instruction sources
These files load baseline instruction text from user and project sources and wrap optional developer-style overlays into prompt fragments.

### `codex-home/src/instructions/mod.rs`

`config` · `config load`

Codex can be guided by a user's own written instructions, stored in their Codex home folder. This file is the bridge between that folder on disk and the rest of the program: it knows which filenames to look for, how to read them safely, and how to report problems without crashing the whole run.

It defines `CodexHomeUserInstructionsProvider`, a small object that remembers the absolute path to the Codex home directory. When asked for instructions, it checks `AGENTS.override.md` first, then `AGENTS.md`. That ordering matters: the override file is like a sticky note placed on top of the usual handbook, so it wins if it exists and has content.

For each candidate file, it first confirms the path points to a real file. Missing files are normal and are quietly skipped. Other file access problems, such as permission errors, become warnings. If a file can be read, its bytes are turned into text using a forgiving UTF-8 conversion, trimmed of leading and trailing whitespace, and returned only if something meaningful remains. If nothing usable is found, the result simply says there are no instructions, along with any warnings gathered along the way.

#### Function details

##### `CodexHomeUserInstructionsProvider::new`  (lines 20–22)

```
fn new(codex_home: AbsolutePathBuf) -> Self
```

**Purpose**: Creates a user-instructions provider rooted at one specific Codex home directory. Other parts of the program use this when they know where the user's Codex files live and want a reusable object that can load instructions from there.

**Data flow**: It receives an absolute folder path as input. It stores that path inside a new `CodexHomeUserInstructionsProvider`. The result is a provider object ready to later look for instruction files in that folder.

**Call relations**: This is called during setup by several higher-level flows, including the main program path, debug prompt input command, prompt-building tests, and environment-loading code. Those callers create the provider first, then later rely on the provider interface to fetch the actual instructions.

*Call graph*: called by 7 (run_debug_prompt_input_command, provider, loads_user_instructions_without_a_primary_environment, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, build_prompt_input_includes_context_and_user_message, new, run_main).


##### `CodexHomeUserInstructionsProvider::load_from_codex_home`  (lines 24–67)

```
async fn load_from_codex_home(&self) -> LoadedUserInstructions
```

**Purpose**: Looks inside the Codex home directory for global instruction files and returns the first non-empty instruction text it can successfully read. It also collects warnings for file access problems that are unusual but not fatal.

**Data flow**: It starts with the provider's stored Codex home path and an empty warning list. It builds paths for `AGENTS.override.md` and `AGENTS.md`, checks whether each is a file, reads the first readable candidate, converts the file bytes into text, trims whitespace, and returns that text with its source path if it is not empty. Missing files and empty files produce no instructions; permission or read errors are saved as warnings and the search continues.

**Call relations**: This is the real worker behind the provider. `load_user_instructions` calls it when the rest of the system asks for user instructions, and it hands back a `LoadedUserInstructions` result containing either the chosen instructions or a clean 'none found' result plus any warnings.

*Call graph*: calls 1 internal fn (join); called by 1 (load_user_instructions); 5 external calls (from_utf8_lossy, new, format!, metadata, read).


##### `CodexHomeUserInstructionsProvider::load_user_instructions`  (lines 71–73)

```
fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_>
```

**Purpose**: Implements the common provider interface used by the rest of Codex to request user instructions. It wraps the file-loading work in a future, which is Rust's way of representing work that will finish later without blocking the current task.

**Data flow**: It receives the provider itself as input. It starts the asynchronous `load_from_codex_home` operation and boxes it into the expected return type for the shared interface. The output is a future that will eventually produce the loaded instructions and warnings.

**Call relations**: This is the public doorway used through the `UserInstructionsProvider` trait. Callers do not need to know about filenames or disk checks; they ask the provider to load instructions, and this method passes the request to `load_from_codex_home`.

*Call graph*: calls 1 internal fn (load_from_codex_home); 1 external calls (pin).


### `core/src/agents_md.rs`

`domain_logic` · `request handling`

This file solves a practical problem: a project may contain written guidance for the AI, and that guidance can live at several levels of the folder tree. For example, a repository may have a general `AGENTS.md` at the root and a more specific one inside a subfolder. This code finds those files from the project root down to the current working directory, reads them in that order, and turns them into model-visible instructions.

The file also respects safety and clarity limits. It stops at the detected project root, so instructions from unrelated parent folders are not pulled in by accident. It uses a byte limit from configuration, so huge documentation files cannot flood the prompt. It prefers `AGENTS.override.md`, then `AGENTS.md`, then any configured fallback names.

The main container is `LoadedAgentsMd`. Think of it like a folder of instruction slips: some slips come from the host user, some from project files, and some from internal guidance. It can join those slips into plain text, list where they came from, and render them as a contextual user fragment for the rest of the system. If more than one execution environment contributes project instructions, the output labels each environment so the model can tell which workspace each instruction belongs to.

#### Function details

##### `load_project_instructions`  (lines 48–88)

```
async fn load_project_instructions(
    config: &Config,
    user_instructions: Option<UserInstructions>,
    environments: &TurnEnvironmentSnapshot,
) -> Option<LoadedAgentsMd>
```

**Purpose**: This is the top-level loader for instruction text. It starts with any instructions supplied by the host application, then looks for project instruction files in each active turn environment.

**Data flow**: It receives the configuration, optional user instructions, and a snapshot of available environments. It filters out empty user instructions, visits each environment's current directory, asks `read_agents_md` to load project files, appends any entries it finds, and optionally adds built-in child-agent guidance. It returns a populated `LoadedAgentsMd` when there is useful text, or `None` when nothing was found.

**Call relations**: This function begins the flow for this file. It calls `LoadedAgentsMd::from_user_instructions` to create the starting bundle, then calls `read_agents_md` once per usable environment. If reading fails, it logs the error and keeps going rather than stopping the whole request.

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

**Purpose**: This function reads the actual project instruction files after their possible locations have been discovered. It applies the configured maximum size so the final instruction text cannot grow without bound.

**Data flow**: It receives the config, a filesystem interface, an environment id, and the current working directory. It asks `agents_md_paths` for candidate files, checks that each one still exists and is a regular file, reads its bytes, truncates the content if the remaining byte budget is too small, converts the bytes to text, and stores non-empty text with its source path and environment information. It returns `Ok(Some(...))` when it loaded at least one instruction, `Ok(None)` when there were no usable files, or an I/O error for unexpected filesystem failures.

**Call relations**: This function is called by `load_project_instructions` for each environment. It hands discovery to `agents_md_paths`, then uses the provided filesystem to inspect and read each returned path. Its loaded entries are appended into the larger instruction bundle.

*Call graph*: calls 2 internal fn (agents_md_paths, from_abs_path); called by 1 (load_project_instructions); 6 external calls (from_utf8_lossy, default, get_metadata, read_file, warn!, clone).


##### `agents_md_paths`  (lines 170–256)

```
async fn agents_md_paths(
    config: &Config,
    cwd: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
) -> io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: This function decides which instruction file paths should be read. It finds the project root, builds the list of folders from that root down to the current folder, and picks the first matching instruction filename in each folder.

**Data flow**: It receives configuration, the current directory, and a filesystem interface. It builds an effective view of configuration while ignoring project-level config layers for project-root marker detection, then determines which marker names identify a project root. It walks upward looking for one of those markers, builds the downward search path, checks each directory for preferred instruction filenames, and returns the matching file paths in reading order.

**Call relations**: This function is called by `read_agents_md` before any file content is read. It calls `candidate_filenames` to know which names to try, and it relies on filesystem metadata checks to avoid guessing blindly.

*Call graph*: calls 2 internal fn (candidate_filenames, from_abs_path); called by 1 (read_agents_md); 11 external calls (Table, new, default_project_root_markers, merge_toml_values, project_root_markers_from_config, get_metadata, matches!, new, warn!, clone (+1 more)).


##### `candidate_filenames`  (lines 258–272)

```
fn candidate_filenames(config: &Config) -> Vec<&str>
```

**Purpose**: This function builds the ordered list of instruction filenames to look for in each directory. It encodes the priority: local override first, normal `AGENTS.md` second, configured fallbacks after that.

**Data flow**: It reads fallback filename settings from the config. It starts with `AGENTS.override.md` and `AGENTS.md`, skips empty fallback names, avoids duplicates, and returns the final ordered list of names.

**Call relations**: This helper is called by `agents_md_paths` during path discovery. Its ordering controls which file wins when a directory contains more than one possible project instruction file.

*Call graph*: called by 1 (agents_md_paths); 1 external calls (with_capacity).


##### `LoadedAgentsMd::new_user`  (lines 287–298)

```
fn new_user(contents: String, path: AbsolutePathBuf) -> Self
```

**Purpose**: This creates a `LoadedAgentsMd` value that contains only user-provided instructions with a known source file. It is useful when user-level instruction text has already been read elsewhere.

**Data flow**: It receives instruction text and a path. If the text is blank after trimming whitespace, it returns an empty instruction bundle. Otherwise, it stores the text and source path as host-provided user instructions, with no project entries.

**Call relations**: This constructor is part of the public API for building instruction bundles. Other rendering and source-listing methods can later use the value it creates.

*Call graph*: 2 external calls (default, new).


##### `LoadedAgentsMd::from_user_instructions`  (lines 300–306)

```
fn from_user_instructions(user_instructions: Option<UserInstructions>) -> Self
```

**Purpose**: This creates the initial instruction bundle from optional host-provided user instructions. It quietly drops the value if the text is empty.

**Data flow**: It receives an optional `UserInstructions` object. If there is no object, or if its text is only whitespace, it stores no user instructions. Otherwise, it keeps the user instruction object and starts with an empty list of project/internal entries.

**Call relations**: This is called by `load_project_instructions` at the beginning of instruction loading. Project entries found later are added to the bundle it creates.

*Call graph*: called by 1 (load_project_instructions); 1 external calls (new).


##### `LoadedAgentsMd::from_text_for_testing`  (lines 312–324)

```
fn from_text_for_testing(contents: impl Into<String>) -> Self
```

**Purpose**: This builds an instruction bundle from plain text for tests. It avoids needing a real source path when a test only cares about the rendered instruction behavior.

**Data flow**: It receives any value that can become a string. If the resulting text is blank, it returns an empty bundle. Otherwise, it stores the text as an internal instruction entry and leaves user instructions empty.

**Call relations**: This helper is intended for tests and test-like callers. The resulting value can be passed through the same `text`, `render`, and source-reporting behavior as normally loaded instructions.

*Call graph*: 4 external calls (into, trim, default, vec!).


##### `LoadedAgentsMd::is_empty`  (lines 326–332)

```
fn is_empty(&self) -> bool
```

**Purpose**: This checks whether the instruction bundle contains any meaningful text. It treats whitespace-only entries as empty.

**Data flow**: It looks at the optional user instructions and every stored entry. If there are no user instructions and all entries are blank after trimming whitespace, it returns true; otherwise it returns false.

**Call relations**: This is used by `load_project_instructions` and `read_agents_md` to decide whether to return a real `LoadedAgentsMd` or no instructions at all.


##### `LoadedAgentsMd::text`  (lines 335–341)

```
fn text(&self) -> String
```

**Purpose**: This turns the stored instruction entries into the plain text that the model should see. It chooses a simple format for one project environment and a labeled format for multiple environments.

**Data flow**: It reads the stored user instructions and entries. If project entries come from more than one environment, it calls `environment_labeled_text`; otherwise it calls `legacy_text`. The result is one combined string.

**Call relations**: This is called by `LoadedAgentsMd::render` when building the final contextual user fragment. It relies on `has_multiple_project_environments` to choose the right formatting path.

*Call graph*: calls 3 internal fn (environment_labeled_text, has_multiple_project_environments, legacy_text); called by 1 (render).


##### `LoadedAgentsMd::legacy_text`  (lines 343–369)

```
fn legacy_text(&self) -> String
```

**Purpose**: This combines instructions using the older simple format used when there is only one project environment. It inserts a clear separator before the first project document when needed.

**Data flow**: It starts with an empty output string, appends user instructions if present, then appends each stored entry in order. When the output moves from user or internal instructions into project instructions, it inserts the project-document separator; otherwise it separates entries with blank lines. It returns the combined text.

**Call relations**: This is called by `LoadedAgentsMd::text` when labels for multiple environments are not needed. It is the straightforward single-workspace path.

*Call graph*: called by 1 (text); 2 external calls (new, matches!).


##### `LoadedAgentsMd::environment_labeled_text`  (lines 371–414)

```
fn environment_labeled_text(&self) -> String
```

**Purpose**: This combines instructions in a format that names each contributing environment. It prevents instructions from different workspaces from blurring together.

**Data flow**: It starts with user instructions if present, then walks through each entry. For project entries, it writes a label such as the environment id and root/current directory before that environment's group of files, but it does not repeat the label for every file from the same environment. Internal entries are appended without an environment label. It returns the combined labeled text.

**Call relations**: This is called by `LoadedAgentsMd::text` when project entries come from more than one environment. It is the multi-workspace formatting path that keeps context understandable for the model.

*Call graph*: called by 1 (text); 2 external calls (new, format!).


##### `LoadedAgentsMd::render`  (lines 417–431)

```
fn render(&self) -> String
```

**Purpose**: This wraps the combined instruction text in the contextual user-instruction format expected by the rest of the system. It also decides whether to include a single directory wrapper.

**Data flow**: It checks whether there are multiple project environments. If there is only one, it tries to include that project current directory as the surrounding directory context; if there are multiple, it leaves the outer directory empty because the text labels each environment internally. It then renders a `ContextUserInstructions` value into the final string.

**Call relations**: This is the final presentation step for loaded instructions. It calls `has_multiple_project_environments`, `single_project_cwd`, and `text` to assemble the form consumed by the wider prompt-building flow.

*Call graph*: calls 3 internal fn (has_multiple_project_environments, single_project_cwd, text).


##### `LoadedAgentsMd::user_instructions`  (lines 434–436)

```
fn user_instructions(&self) -> Option<&UserInstructions>
```

**Purpose**: This returns the original host-provided user instructions, if any were stored. Callers use it when they need the structured user instruction object rather than only the combined text.

**Data flow**: It reads the stored optional user instruction field and returns a borrowed reference when present. It does not change the instruction bundle.

**Call relations**: This accessor lets other parts of the system inspect the host-provided portion separately from project and internal entries.


##### `LoadedAgentsMd::sources`  (lines 439–448)

```
fn sources(&self) -> impl Iterator<Item = &AbsolutePathBuf>
```

**Purpose**: This lists the file paths that contributed instructions. It includes the user instruction source path, if present, and the project `AGENTS.md` paths.

**Data flow**: It reads the stored user instruction source and then walks all entries, asking each entry's provenance for a path. Internal entries have no path and are skipped. It returns an iterator over the source paths.

**Call relations**: This method depends on `InstructionProvenance::path` to extract project file paths. It is useful for reporting, debugging, or showing users which instruction files influenced the model.


##### `LoadedAgentsMd::has_multiple_project_environments`  (lines 450–464)

```
fn has_multiple_project_environments(&self) -> bool
```

**Purpose**: This checks whether project instructions came from more than one environment. That matters because multi-environment output needs labels to stay clear.

**Data flow**: It scans the stored entries and ignores internal instructions. For project entries, it remembers the first environment id it sees and returns true if it later finds a different one. If all project entries share one environment, or there are none, it returns false.

**Call relations**: This method is called by `LoadedAgentsMd::text` to choose between simple and labeled formatting, and by `LoadedAgentsMd::render` to decide whether an outer directory wrapper is appropriate.

*Call graph*: called by 2 (render, text).


##### `LoadedAgentsMd::single_project_cwd`  (lines 466–473)

```
fn single_project_cwd(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: This finds the current working directory associated with the first project instruction entry. It is used when there is only one project environment and the rendered output can safely name one directory.

**Data flow**: It scans entries in order. When it finds a project entry, it returns a borrowed reference to that entry's stored current working directory. If it only finds internal entries, or no entries, it returns nothing.

**Call relations**: This is called by `LoadedAgentsMd::render` after the render path has determined that there are not multiple project environments.

*Call graph*: called by 1 (render).


##### `InstructionProvenance::path`  (lines 501–506)

```
fn path(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: This extracts the source file path from an instruction's provenance when one exists. Project instructions have a path; internal instructions do not.

**Data flow**: It receives an instruction provenance value. If it is a project provenance, it returns the stored `source_path`; if it is internal provenance, it returns `None`.

**Call relations**: This helper is used by `LoadedAgentsMd::sources` to build the list of files that contributed instruction text.


### `core/src/context/collaboration_mode_instructions.rs`

`domain_logic` · `context building`

A collaboration mode can come with extra developer instructions: guidance about how the assistant should behave while working in that mode. This file wraps those instructions in a simple object, `CollaborationModeInstructions`, so they can be inserted into the larger context in a consistent way.

Think of it like putting a note inside a labeled envelope. The note is the instruction text. The envelope says who the note is from, where it starts, and where it ends. That labeling matters because the rest of the system needs to know that these words are developer guidance, not user text or ordinary conversation.

The file first provides a safe constructor, `from_collaboration_mode`, which only creates the wrapper when the collaboration mode actually has non-empty developer instructions. If there is no useful text, it returns nothing, so the context is not cluttered with empty sections.

It then implements `ContextualUserFragment`, a shared interface for pieces of context. Through that interface, this fragment says its role is `developer`, gives the special opening and closing tags used for collaboration-mode content, and returns the stored instruction text as its body.

#### Function details

##### `CollaborationModeInstructions::from_collaboration_mode`  (lines 12–21)

```
fn from_collaboration_mode(collaboration_mode: &CollaborationMode) -> Option<Self>
```

**Purpose**: Creates a `CollaborationModeInstructions` fragment from a collaboration mode, but only if that mode contains non-empty developer instructions. This avoids adding blank or meaningless instruction blocks to the context.

**Data flow**: It receives a `CollaborationMode`, reads its nested `developer_instructions` setting, and checks whether that text exists and is not empty. If useful text is present, it copies the text into a new `CollaborationModeInstructions`; otherwise it returns `None`, meaning there is no fragment to add.

**Call relations**: This is called while building context, specifically by `build_collaboration_mode_update_item` and `build_initial_context`. Those callers ask this function, in effect, “does this collaboration mode have extra guidance we should include?” and then use the returned fragment if one exists.

*Call graph*: called by 2 (build_collaboration_mode_update_item, build_initial_context).


##### `CollaborationModeInstructions::role`  (lines 25–27)

```
fn role(&self) -> &'static str
```

**Purpose**: Identifies this fragment as developer guidance. That role tells the rest of the context system how to treat the text when it is placed into the conversation context.

**Data flow**: It takes the existing fragment and does not read or change the stored instruction text. It simply returns the fixed string `developer`.

**Call relations**: This function is part of the `ContextualUserFragment` interface. When something renders or packages this fragment for the model, it can call `role` to label the instructions as developer-level guidance rather than user text.


##### `CollaborationModeInstructions::markers`  (lines 29–31)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the opening and closing labels that surround this fragment’s text. These markers make the collaboration-mode instructions clearly recognizable inside the larger context.

**Data flow**: It receives the fragment but does not need to inspect its stored instructions. It asks `type_markers` for the shared marker pair and returns those two tag strings.

**Call relations**: This function is the instance-level way to get the markers required by the `ContextualUserFragment` interface. Internally it hands the work to `type_markers`, so both instance-based and type-based code use the same tag values.

*Call graph*: 1 external calls (type_markers).


##### `CollaborationModeInstructions::type_markers`  (lines 33–35)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Returns the standard opening and closing tags used for collaboration-mode instruction blocks. This keeps the tag choice in one place so all such fragments are wrapped the same way.

**Data flow**: It takes no fragment data and reads no instruction text. It returns the two protocol constants: the collaboration-mode open tag and the collaboration-mode close tag.

**Call relations**: The `markers` method calls this function when it needs the tags for a specific fragment. Other code can also use it when it needs to know the marker pair for this fragment type without having an actual fragment value.


##### `CollaborationModeInstructions::body`  (lines 37–39)

```
fn body(&self) -> String
```

**Purpose**: Returns the actual developer instruction text stored in the fragment. This is the content that will be placed between the collaboration-mode markers.

**Data flow**: It reads the fragment’s stored `instructions` string, clones it, and returns that copy. The original fragment is left unchanged.

**Call relations**: This function completes the `ContextualUserFragment` interface: after the surrounding code knows the role and markers, it can call `body` to get the text that should go inside the marked section.


### `core/src/context/personality_spec_instructions.rs`

`domain_logic` · `context assembly`

This file exists so a user's preferred “personality” or communication style can be carried into the assistant’s context in a consistent shape. Think of it like putting a labeled note into a briefing folder: the label says what kind of note it is, and the note itself explains how the assistant should speak from now on.

The main type, `PersonalitySpecInstructions`, stores one piece of text: the requested style description. It implements `ContextualUserFragment`, which means it can be added to the larger context-building system as one fragment among others. The fragment identifies itself as coming from the `developer` role, not directly as a normal user message. That matters because developer instructions usually guide behavior more strongly than casual conversation text.

The file also defines special start and end markers, `<personality_spec>` and `</personality_spec>`, so the surrounding system can wrap or recognize this fragment reliably. Finally, it formats the stored style into a sentence telling the assistant that future messages should follow the requested personality. Without this file, the system might still receive a style request, but it would lack this standardized way to package it, label it, and inject it into the assistant’s working instructions.

#### Function details

##### `PersonalitySpecInstructions::new`  (lines 9–11)

```
fn new(spec: impl Into<String>) -> Self
```

**Purpose**: Creates a new personality-instruction fragment from some text describing the desired communication style. Someone uses this when they want to add a style preference into the assistant’s context.

**Data flow**: It receives a value that can be turned into a string, such as a string slice or an owned string. It converts that value into the stored `spec` text, then returns a new `PersonalitySpecInstructions` object containing it.

**Call relations**: When the initial context is being built, or when a sample rollout is prepared, this constructor is used to package the requested personality text into the standard fragment type. After that, the context system can ask the object for its role, markers, and body.

*Call graph*: called by 2 (build_initial_context, sample_rollout); 1 external calls (into).


##### `PersonalitySpecInstructions::role`  (lines 15–17)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the context system what message role this fragment should use. Here, it always says the fragment belongs in the `developer` role, meaning it is treated as an instruction about how the assistant should behave.

**Data flow**: It takes the existing fragment as input, but does not need to read the stored personality text. It simply returns the fixed role name `developer`.

**Call relations**: The larger context-building code calls this through the `ContextualUserFragment` interface when it needs to place the fragment into the right category of instruction. This role choice helps the personality request act like guidance for future responses.


##### `PersonalitySpecInstructions::markers`  (lines 19–21)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the pair of text markers that should surround this kind of fragment. These markers make the personality section easy to identify inside the assembled context.

**Data flow**: It receives the fragment object, then asks the type for its standard marker pair. It returns the opening and closing marker strings without changing the fragment.

**Call relations**: The context system can call this when wrapping the fragment body. Rather than duplicating the marker text here, it delegates to the shared marker definition so the opening and closing labels stay consistent.

*Call graph*: 1 external calls (type_markers).


##### `PersonalitySpecInstructions::type_markers`  (lines 23–25)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the standard opening and closing labels for personality-specification text. This gives the rest of the system one clear way to recognize this fragment type.

**Data flow**: It takes no stored object data. It returns the fixed pair `<personality_spec>` and `</personality_spec>`.

**Call relations**: The `markers` method uses this as the single source of truth for the wrapper labels. Other context code can also rely on these exact markers when it needs to identify or format personality instructions.


##### `PersonalitySpecInstructions::body`  (lines 27–32)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual instruction text that will be inserted into the assistant’s context. It explains that the user requested a new communication style and includes the stored personality description.

**Data flow**: It reads the fragment’s stored `spec` string. It places that text into a fixed explanatory sentence, then returns the completed body as a new string.

**Call relations**: After a `PersonalitySpecInstructions` object has been created, the context-building system calls this through the fragment interface to get the text that should appear between the personality markers. This is the handoff point where the raw style description becomes an instruction the assistant can follow.

*Call graph*: 1 external calls (format!).


### `core/src/context/plugin_instructions.rs`

`data_model` · `context building`

This file is like a labeled envelope for plugin-provided instructions. A plugin may need to add guidance that should shape how the system responds, but that guidance needs to fit into the same context-building pipeline as other pieces of user-facing information. `PluginInstructions` stores the instruction text and implements `ContextualUserFragment`, a shared interface for things that can be added to the conversation context.

The important choice here is the role: plugin instructions are reported as coming from the `developer` role. In plain terms, that means they are treated as guidance from the application or tool builder, not as ordinary user text. The file also says these instructions have no opening or closing markers, so the raw text is inserted as-is. That matters because some context fragments may be wrapped in labels or delimiters, but plugin instructions are meant to be direct.

Without this file, plugin instructions would either need special-case code elsewhere or might be inserted with the wrong role or formatting. This small type keeps that behavior clear and reusable.

#### Function details

##### `PluginInstructions::new`  (lines 9–11)

```
fn new(text: impl Into<String>) -> Self
```

**Purpose**: Creates a new `PluginInstructions` value from some text. This is the normal way to package plugin-provided guidance so it can later be added to the context.

**Data flow**: Text comes in, in any form that can be turned into a Rust `String`. The function converts it into an owned string and stores it inside a new `PluginInstructions` object. The result is that the instruction text is ready to travel through the context system.

**Call relations**: This is the entry point for making this wrapper. It relies on Rust’s standard `into` conversion to accept flexible text inputs, then hands back a complete `PluginInstructions` value for later use by the context-fragment interface.

*Call graph*: 1 external calls (into).


##### `PluginInstructions::role`  (lines 15–17)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the context system that these plugin instructions should be treated as `developer` guidance. This affects how the instructions are understood relative to ordinary user text.

**Data flow**: It reads no outside information and does not change the stored text. It simply returns the fixed role name `developer`.

**Call relations**: When the wider context-building code asks a `ContextualUserFragment` what role it should use, this function supplies the answer for plugin instructions.


##### `PluginInstructions::markers`  (lines 19–21)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the text markers that should surround this fragment when it is inserted into context. For plugin instructions, it returns no markers.

**Data flow**: It receives the existing `PluginInstructions` value but does not inspect or change its text. It asks the type-level marker function for the marker pair and returns that pair.

**Call relations**: This instance-level method connects the shared `ContextualUserFragment` interface to the marker rule defined by `PluginInstructions::type_markers`. When context-building code asks this particular fragment for its markers, this method delegates to the shared marker definition.

*Call graph*: 1 external calls (type_markers).


##### `PluginInstructions::type_markers`  (lines 23–25)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the marker rule for all plugin instruction fragments. In this case, both the starting and ending markers are empty strings, meaning the text is not wrapped.

**Data flow**: No input is needed. The function returns a pair of empty strings, which means there is nothing to add before or after the instruction text.

**Call relations**: This is the common marker definition used by `PluginInstructions::markers`. It keeps the formatting choice in one place so every plugin instruction fragment behaves the same way.


##### `PluginInstructions::body`  (lines 27–29)

```
fn body(&self) -> String
```

**Purpose**: Returns the actual plugin instruction text that should be inserted into the context. It gives callers a fresh copy so the stored value remains unchanged.

**Data flow**: It reads the text stored inside the `PluginInstructions` object, clones that string, and returns the clone. The original instruction object is left untouched.

**Call relations**: When the broader context-building flow needs the content of this fragment, this method supplies it through the `ContextualUserFragment` interface. It works alongside `role` and `markers`: together they answer what the text is, who it should be attributed to, and how it should be wrapped.


### `core/src/context/image_generation_instructions.rs`

`domain_logic` · `request handling`

When the system can generate images, the model needs a simple rule: where the generated image file will appear, and what to do if it wants to use that image somewhere else. This file builds that rule as plain text. Without it, the model might not know the default save location, or it might move/delete an original image when it should leave it in place.

There are two closely related uses here. One function makes a model-facing hint for the extension, but only returns it if it stays under a fixed size limit. That limit protects the prompt from being bloated by an unusually long path. Another piece, `ImageGenerationInstructions`, stores the output folder and default output path so the same message can be included later as a contextual user fragment. A contextual user fragment is a small piece of text added to the conversation to give the model extra background.

The actual instruction is intentionally direct: generated images are saved in a given directory under a given path by default, and if another path is needed, the image should be copied while leaving the original alone unless the user explicitly says to delete it. This is like putting a label on a newly printed photo: it tells everyone where the original is and warns them not to throw it away by accident.

#### Function details

##### `extension_image_generation_output_hint`  (lines 8–14)

```
fn extension_image_generation_output_hint(
    image_output_dir: impl Display,
    image_output_path: impl Display,
) -> Option<String>
```

**Purpose**: This builds the image-save instruction for the extension to show or give to the model, but only if the message is not too large. It exists to avoid sending an oversized path hint into the model context.

**Data flow**: It receives an image output directory and an image output path, both as displayable values. It turns them into the standard instruction text, checks the text length against the maximum allowed size, and returns the text wrapped in `Some` if it fits. If the hint is too long, it returns `None`, meaning the hint should be omitted.

**Call relations**: When another part of the system needs the extension-facing hint, this function is the safe front door. It delegates the actual wording to `image_generation_hint`, then adds the size check before handing the result back.

*Call graph*: calls 1 internal fn (image_generation_hint).


##### `image_generation_hint`  (lines 16–23)

```
fn image_generation_hint(
    image_output_dir: impl Display,
    image_output_path: impl Display,
) -> String
```

**Purpose**: This creates the exact instruction sentence that explains where generated images are saved and how to treat the original file. It is the shared wording used by both the extension hint and the contextual instruction object.

**Data flow**: It receives the output directory and output path. It inserts those values into a fixed message and returns the finished string. It does not store anything or make decisions; it only formats the message.

**Call relations**: This is the common text factory. `extension_image_generation_output_hint` calls it when making a size-limited hint, and `ImageGenerationInstructions::body` calls it when producing the text that will be added to the conversation context.

*Call graph*: called by 2 (body, extension_image_generation_output_hint); 1 external calls (format!).


##### `ImageGenerationInstructions::new`  (lines 32–37)

```
fn new(image_output_dir: impl Display, image_output_path: impl Display) -> Self
```

**Purpose**: This creates an `ImageGenerationInstructions` value from an output directory and output path. Someone uses it when the system has just learned where generated images should be saved and wants to remember that for later context.

**Data flow**: It receives two displayable values: the directory and the path. It converts both into owned strings and stores them inside a new `ImageGenerationInstructions` object. The result is that later code can ask this object for the instruction text.

**Call relations**: This constructor is used by higher-level image-generation flows when recording image save information or image generation instructions. After it creates the object, the context system can call the trait methods on that object to insert the right message into the model conversation.

*Call graph*: called by 2 (handle_output_item_done_records_image_save_history_message, record_image_generation_instructions); 1 external calls (to_string).


##### `ImageGenerationInstructions::role`  (lines 41–43)

```
fn role(&self) -> &'static str
```

**Purpose**: This tells the context system that these instructions should be presented with the `developer` role. In model conversations, a role labels who a message is from, and here the instruction is treated as guidance from the developer/system side rather than from the end user.

**Data flow**: It reads no stored fields. It simply returns the fixed role name `developer`.

**Call relations**: The context-building code calls this through the `ContextualUserFragment` interface when it needs to package this fragment for the model. It supplies the role label that goes alongside the body text.


##### `ImageGenerationInstructions::markers`  (lines 45–47)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This returns the start and end marker strings for this context fragment. In this file, both markers are empty, meaning the image instruction text is not wrapped with special visible delimiters.

**Data flow**: It reads no stored fields. It asks the type-level marker function for the marker pair and returns that pair unchanged.

**Call relations**: The context system calls this when assembling the fragment. It hands off to `ImageGenerationInstructions::type_markers` so the marker choice is defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `ImageGenerationInstructions::type_markers`  (lines 49–51)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This defines the marker pair used for all `ImageGenerationInstructions` fragments. Here it deliberately returns empty strings, so the generated instruction appears without extra labels around it.

**Data flow**: It takes no input and reads no object state. It returns a pair of empty marker strings.

**Call relations**: `ImageGenerationInstructions::markers` uses this as the shared source of truth for marker text. That keeps instance-level marker requests consistent with the type’s marker definition.


##### `ImageGenerationInstructions::body`  (lines 53–55)

```
fn body(&self) -> String
```

**Purpose**: This turns the stored image directory and path into the actual instruction text that will be inserted into the conversation. It is the part that makes the saved values useful to the model.

**Data flow**: It reads the stored `image_output_dir` and `image_output_path` strings from the object. It passes them to `image_generation_hint`, gets back the formatted instruction, and returns that string.

**Call relations**: The context system calls this through the `ContextualUserFragment` interface when it is ready to assemble the model-facing message. It relies on `image_generation_hint` so the wording matches the extension hint exactly.

*Call graph*: calls 1 internal fn (image_generation_hint).


### `tui/src/terminal_visualization_instructions.rs`

`config` · `conversation setup`

The terminal cannot show rich graphics the way a browser or document editor can. This file solves that by defining a short block of instructions that tells the model how to create useful visuals using plain text only. For example, it asks for ASCII tables when comparing exact values, trees for hierarchy, and timelines for ordered events.

The main function checks the user or developer configuration before adding these instructions. If the TerminalVisualizationInstructions feature is turned off, it leaves the existing instructions unchanged. If the feature is turned on, it looks for instructions that are already being sent. Those may come directly from the caller, or, if none were provided, from the developer instructions stored in the config.

If there are already non-empty instructions, this file appends the terminal-visualization guidance after a blank line, like adding a note at the bottom of a checklist. If there are no existing instructions, it uses the visualization guidance by itself. This keeps the behavior safe and predictable: terminal-specific advice is added only when requested, and it does not erase other guidance.

#### Function details

##### `with_terminal_visualization_instructions`  (lines 10–29)

```
fn with_terminal_visualization_instructions(
    config: &Config,
    control_instructions: Option<String>,
) -> Option<String>
```

**Purpose**: This function decides whether to add terminal-friendly visualization instructions to the model’s control instructions. It is used when preparing a new, resumed, or forked conversation thread so the model knows how to format visuals for a plain terminal.

**Data flow**: It receives the current Config and an optional existing instruction string. First it reads the feature settings in the config. If the terminal-visualization feature is not enabled, it returns the original optional instruction string unchanged. If the feature is enabled, it uses the provided instructions if present, otherwise it falls back to developer instructions from the config. It then returns a new instruction string: either the existing text plus the terminal guidance, or just the terminal guidance if there was nothing useful already there.

**Call relations**: This function is called while building parameters for starting, resuming, or forking a conversation thread. In that setup flow, the caller brings the configuration and any current control instructions here, and this function hands back the final instruction text that should be sent onward. Its only outside work is formatting the combined text when existing instructions need the extra guidance appended.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 1 external calls (format!).


### `tui/src/ide_context/prompt.rs`

`domain_logic` · `request handling`

When a user asks Codex a question from the terminal UI, the question can be more useful if Codex also knows what the user is looking at in their editor. This file builds that editor context into a plain text block and places it before the user's real request. Think of it like attaching a sticky note to a letter: the sticky note gives background, but the letter itself is still the main message.

The file uses the same divider text as the desktop app and IDE extension: "## My request for Codex:". That matters because conversations may move between different Codex surfaces. If all surfaces use the same divider, they can agree on where the hidden context ends and the user’s actual request begins.

The context can include the active file path, selected text or selection ranges, and a list of open tabs. It deliberately limits very large selections and very long tab lists, so the prompt does not become too huge. If there is no IDE context, it adds nothing.

One important detail is that user input may contain special text elements, such as placeholders with byte ranges. When this file prefixes the prompt, it shifts those byte ranges forward so they still point at the correct text after the added context.

#### Function details

##### `apply_ide_context_to_user_input`  (lines 18–59)

```
fn apply_ide_context_to_user_input(
    context: &IdeContext,
    items: &mut Vec<UserInput>,
) -> bool
```

**Purpose**: Adds rendered IDE context to a user's submitted input, if there is any context worth adding. It keeps the user's original mix of text and images in the same order as much as possible.

**Data flow**: It receives an IDE context and a mutable list of user input items. First it asks for a rendered context block. If none exists, it leaves the list unchanged and returns false. If context exists, it builds a prefix ending with the shared request divider, then either adds that prefix to the first text item or inserts a new text item at the front. If it prefixes existing text, it also preserves and adjusts the text element positions. It returns true when it changed the input list.

**Call relations**: This is the main entry point in this file for adding IDE context to a user turn. It asks render_prompt_context to create the context text, then uses prefixed_text_input when an existing text item needs its special text ranges shifted after the prefix.

*Call graph*: calls 2 internal fn (prefixed_text_input, render_prompt_context); 5 external calls (new, new, format!, replace, unreachable!).


##### `has_prompt_context`  (lines 61–63)

```
fn has_prompt_context(context: &IdeContext) -> bool
```

**Purpose**: Answers the simple question: would this IDE context produce any prompt text? It is useful when other code only needs to know whether context exists, without changing user input.

**Data flow**: It receives an IDE context, asks render_prompt_context to try building text from it, and returns true if that produced something or false if it did not.

**Call relations**: This is a lightweight checker around render_prompt_context. It fits into flows that need a yes-or-no answer before deciding whether to show or use IDE context.

*Call graph*: calls 1 internal fn (render_prompt_context).


##### `extract_prompt_request_with_offset`  (lines 65–74)

```
fn extract_prompt_request_with_offset(message: &str) -> (&str, usize)
```

**Purpose**: Finds the user's real request inside a message that may have IDE context prepended. It also reports where that real request starts in the original message.

**Data flow**: It receives a full message string. If the shared request divider is not present, it returns the whole message and offset 0. If the divider is present, it uses the last occurrence, trims surrounding whitespace from the request part, and returns both the cleaned request text and the byte offset where that cleaned request begins.

**Call relations**: This is the counterpart to adding IDE context. After apply_ide_context_to_user_input has placed context before the divider, this function lets transcript or replay code recover just the user's request.


##### `prefixed_text_input`  (lines 76–94)

```
fn prefixed_text_input(prefix: String, text: String, text_elements: Vec<TextElement>) -> UserInput
```

**Purpose**: Builds a new text input item by putting a prefix before existing text while keeping embedded text markers accurate. This prevents placeholders or other annotated spans from pointing at the wrong characters after text is shifted.

**Data flow**: It receives a prefix, the original text, and the original text elements. It joins the prefix and text into one string. For each text element, it adds the prefix length to the element's byte range, so the range still covers the same original content in its new location. It returns a new text input item with the combined text and adjusted elements.

**Call relations**: apply_ide_context_to_user_input calls this when it finds an existing text item to prefix. This helper isolates the careful range-shifting work so the higher-level function can focus on where to insert the context.

*Call graph*: called by 1 (apply_ide_context_to_user_input); 1 external calls (format!).


##### `render_prompt_context`  (lines 96–185)

```
fn render_prompt_context(context: &IdeContext) -> Option<String>
```

**Purpose**: Turns the current IDE state into the readable context block that Codex will see before the user's request. It returns nothing when the IDE state contains no useful context.

**Data flow**: It receives an IDE context. It adds the active file path if present. It adds selection ranges when there is selected code but no selected content text, or when there are multiple selections. It adds selected text when available, cutting it off at a safe maximum length and writing a note when truncation happens. It adds open tabs up to fixed count and character limits, then notes how many tabs were omitted. If nothing was added, it returns None; otherwise it wraps the content in a standard heading and returns it as a string.

**Call relations**: This is the formatting engine used by apply_ide_context_to_user_input and has_prompt_context. The tests also exercise it directly for large selections and long tab lists, because those limits are important guardrails.

*Call graph*: called by 4 (apply_ide_context_to_user_input, has_prompt_context, render_prompt_context_omits_excess_open_tabs, render_prompt_context_truncates_large_selection); 3 external calls (new, format!, from_ref).


##### `tests::descriptor`  (lines 198–203)

```
fn descriptor(label: &str, path: &str) -> FileDescriptor
```

**Purpose**: Creates a small file descriptor for tests, using a label and path. It keeps test setup short and easy to read.

**Data flow**: It receives a label string and path string, copies them into owned strings, and returns a FileDescriptor test value.

**Call relations**: The test functions call this helper when they need active files or open tabs. It is only part of the test code and does not run in normal prompt creation.


##### `tests::render_prompt_context_matches_app_format`  (lines 206–236)

```
fn render_prompt_context_matches_app_format()
```

**Purpose**: Checks that rendered IDE context matches the format expected by the desktop app and IDE extension. This protects cross-surface compatibility.

**Data flow**: It builds an IDE context with an active file, selected content, and two open tabs. It renders the prompt context and compares the result to the exact expected text.

**Call relations**: The test runner calls this during automated tests. It exercises the same rendering behavior used by apply_ide_context_to_user_input, with focus on the final text shape.

*Call graph*: 4 external calls (new, assert_eq!, descriptor, vec!).


##### `tests::render_prompt_context_omits_empty_context`  (lines 239–246)

```
fn render_prompt_context_omits_empty_context()
```

**Purpose**: Checks that no prompt context is produced when there is no active file and no open tabs. This prevents empty boilerplate from being added to user requests.

**Data flow**: It creates an empty IDE context, renders it, and expects the result to be None.

**Call relations**: The test runner calls this to verify the no-context path. That path is important because apply_ide_context_to_user_input relies on it to decide when to leave input unchanged.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::apply_ide_context_uses_desktop_prompt_request_delimiter`  (lines 249–306)

```
fn apply_ide_context_uses_desktop_prompt_request_delimiter()
```

**Purpose**: Checks that IDE context is inserted with the exact shared request divider and that text element positions are shifted correctly. This protects both prompt compatibility and placeholder accuracy.

**Data flow**: It builds a context with an active file and user input containing an image followed by text with a marked byte range. It applies IDE context, then compares the whole input list to the expected result: the image stays first, the text receives the context prefix, and the marked byte range moves forward by the prefix length.

**Call relations**: The test runner calls this to cover the main public behavior of apply_ide_context_to_user_input. It indirectly relies on prefixed_text_input for the byte-range adjustment.

*Call graph*: 6 external calls (new, new, assert!, assert_eq!, descriptor, vec!).


##### `tests::extract_prompt_request_returns_text_after_last_delimiter`  (lines 309–317)

```
fn extract_prompt_request_returns_text_after_last_delimiter()
```

**Purpose**: Checks that request extraction uses the last divider, not the first one. This matters if earlier context or text also contains the divider phrase.

**Data flow**: It gives the extractor a message containing two request dividers. It expects to receive only the text after the second divider, trimmed of extra whitespace, plus the offset where that text begins.

**Call relations**: The test runner calls this to verify the stripping behavior that complements prompt prefixing. It protects replay and transcript display from showing the prepended IDE context as if it were the user's request.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::render_prompt_context_includes_selection_ranges_without_content`  (lines 320–358)

```
fn render_prompt_context_includes_selection_ranges_without_content()
```

**Purpose**: Checks that selection ranges are included when selected text content is not available. This still gives Codex useful location information even without the actual selected text.

**Data flow**: It builds an active file with two selected ranges and no selected content. It renders the context and compares it to text that lists both ranges using human-friendly one-based line and column numbers.

**Call relations**: The test runner calls this to protect the fallback path in render_prompt_context. That fallback is useful when the IDE can report where the user selected text but not the selected text itself.

*Call graph*: 5 external calls (new, new, assert_eq!, descriptor, vec!).


##### `tests::render_prompt_context_truncates_large_selection`  (lines 361–386)

```
fn render_prompt_context_truncates_large_selection()
```

**Purpose**: Checks that very large selected text is cut off and marked as truncated. This prevents a huge editor selection from making the prompt too large.

**Data flow**: It creates selected content longer than the maximum allowed size, renders the context, and checks that the truncation notice is present while the extra tail text is absent.

**Call relations**: The test runner calls this and directly uses render_prompt_context. It verifies one of the safety limits built into the formatter.

*Call graph*: calls 1 internal fn (render_prompt_context); 4 external calls (new, assert!, format!, descriptor).


##### `tests::render_prompt_context_omits_excess_open_tabs`  (lines 389–402)

```
fn render_prompt_context_omits_excess_open_tabs()
```

**Purpose**: Checks that the open-tab list stops at the configured limit and reports omitted tabs. This keeps the prompt compact when a user has many files open.

**Data flow**: It creates more open tabs than the maximum allowed, renders the context, and checks that the last allowed tab appears, the first disallowed tab does not, and the omitted-tabs note is present.

**Call relations**: The test runner calls this and directly uses render_prompt_context. It verifies the tab-list limit that keeps IDE context from overwhelming the user's request.

*Call graph*: calls 1 internal fn (render_prompt_context); 1 external calls (assert!).


### `prompts/src/permissions_instructions.rs`

`domain_logic` · `startup, context build, and permission updates`

This file builds the “permissions instructions” block that is included in the model’s context. Without it, the model could misunderstand the safety rules for the session: for example, whether it can write files, use the network, or ask the user before doing something risky. Think of it like a safety notice posted at the entrance to a workshop: before using tools, the worker needs to know which rooms are locked, which machines need supervision, and which requests are never allowed. The file starts from low-level permission policies, such as the file-system sandbox policy and network sandbox policy. A sandbox is a restricted environment that limits what a program can touch. It then chooses human-readable template text for the current sandbox mode, adds approval rules, optionally lists writable folders, and optionally lists places that must not be read. It also supports more detailed “granular” approval settings, where some categories of requests may prompt the user while others are automatically rejected. The final result is a marked developer-context fragment with stable opening and closing tags, so other parts of the system can insert it into the conversation safely and consistently.

#### Function details

##### `PermissionsInstructions::from_permission_profile`  (lines 65–91)

```
fn from_permission_profile(
        permission_profile: &PermissionProfile,
        approval_policy: AskForApproval,
        approvals_reviewer: ApprovalsReviewer,
        exec_policy: &Policy,
```

**Purpose**: Builds a complete permissions instruction block from the effective permission profile. This is the main entry point when the system already has the real file, network, approval, and execution policies for the session.

**Data flow**: It receives the permission profile, approval settings, execution policy, current working folder, and feature flags. It reads the file-system and network policies, turns them into simple prompt concepts like sandbox mode and network access, gathers writable and denied-read locations, and produces a PermissionsInstructions value containing the final text.

**Call relations**: This is used when building the initial context, when sending permission updates, and by tests that check profile-based output. It delegates the file-system choice to sandbox_prompt_from_policy, the network choice to network_access_from_policy, the denied-read list to denied_reads_text, and then hands everything to from_permissions_with_network_and_denied_reads to assemble the final message.

*Call graph*: calls 5 internal fn (denied_reads_text, network_access_from_policy, sandbox_prompt_from_policy, file_system_sandbox_policy, network_sandbox_policy); called by 5 (build_permissions_update_item, build_initial_context, permissions_message_includes_writable_roots, builds_permissions_from_profile, builds_permissions_from_profile_with_denied_reads); 1 external calls (from_permissions_with_network_and_denied_reads).


##### `PermissionsInstructions::from_permissions_with_network`  (lines 98–111)

```
fn from_permissions_with_network(
        sandbox_mode: SandboxMode,
        network_access: NetworkAccess,
        config: PermissionsPromptConfig<'_>,
        writable_roots: Option<Vec<WritableRoot
```

**Purpose**: Builds permissions instructions from already-simplified sandbox and network settings. It is mainly a test-facing shortcut for cases where denied-read rules are not part of the scenario.

**Data flow**: It receives a sandbox mode, network access setting, approval configuration, and optional writable roots. It passes those values along with no denied-read text, then returns the completed PermissionsInstructions.

**Call relations**: The listed callers are tests that exercise different approval and network combinations. It exists so tests can focus on prompt wording without first constructing a full permission profile.

*Call graph*: called by 7 (builds_permissions_with_network_access_override, includes_request_permission_rule_instructions_for_on_request_when_enabled, includes_request_permissions_tool_instructions_for_on_failure_when_enabled, includes_request_permissions_tool_instructions_for_on_request_when_tool_is_enabled, includes_request_permissions_tool_instructions_for_unless_trusted_when_enabled, includes_request_rule_instructions_for_on_request, on_request_includes_tool_guidance_alongside_inline_permission_guidance_when_both_exist); 1 external calls (from_permissions_with_network_and_denied_reads).


##### `PermissionsInstructions::from_permissions_with_network_and_denied_reads`  (lines 113–142)

```
fn from_permissions_with_network_and_denied_reads(
        sandbox_mode: SandboxMode,
        network_access: NetworkAccess,
        config: PermissionsPromptConfig<'_>,
        writable_roots: Option
```

**Purpose**: Assembles the final permissions text from its sections. It is the central builder that joins sandbox rules, approval rules, writable roots, and denied-read warnings into one clean block.

**Data flow**: It starts with an empty string. It adds the sandbox section, then the approval section, then optional writable-root and denied-read sections, making sure the final text ends with a newline. It returns a PermissionsInstructions object holding that text.

**Call relations**: from_permission_profile uses this for real session data, and from_permissions_with_network uses it for tests. Inside, it asks sandbox_text, approval_text, writable_roots_text, and append_section to each do one small part of the assembly.

*Call graph*: calls 4 internal fn (append_section, approval_text, sandbox_text, writable_roots_text); 1 external calls (new).


##### `PermissionsInstructions::role`  (lines 146–148)

```
fn role(&self) -> &'static str
```

**Purpose**: Labels these instructions as developer guidance. In this context, “developer” means system-supplied operational guidance rather than a normal user message.

**Data flow**: It takes the PermissionsInstructions object but does not need to inspect its text. It returns the fixed role string "developer".

**Call relations**: This is part of the ContextualUserFragment interface, so when the context-building system includes this fragment, it can place the permissions text under the correct role.


##### `PermissionsInstructions::markers`  (lines 150–152)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the opening and closing tags that wrap this permissions block. These tags make the block easy to recognize in the combined context.

**Data flow**: It takes the PermissionsInstructions object and returns the fixed pair of marker strings. It gets those marker strings from type_markers.

**Call relations**: This is used through the ContextualUserFragment interface. It relies on type_markers so the instance method and type-level method always agree on the exact tags.

*Call graph*: 1 external calls (type_markers).


##### `PermissionsInstructions::type_markers`  (lines 154–156)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact tags used around permissions instructions. This keeps the marker text in one place.

**Data flow**: It takes no session data. It returns the pair "<permissions instructions>" and "</permissions instructions>".

**Call relations**: markers calls this when an actual PermissionsInstructions object is being rendered as a context fragment. Other code can also use it when it needs the marker pair without having an instance.


##### `PermissionsInstructions::body`  (lines 158–160)

```
fn body(&self) -> String
```

**Purpose**: Returns the text that should appear inside the permissions-instructions markers. This is the content that the model will read.

**Data flow**: It reads the stored text from the PermissionsInstructions object and returns it as a new string. The object itself is not changed.

**Call relations**: This is the ContextualUserFragment body method. When the larger context renderer asks the fragment for its content, this method hands back the assembled permissions message.


##### `sandbox_prompt_from_policy`  (lines 163–177)

```
fn sandbox_prompt_from_policy(
    file_system_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> (SandboxMode, Option<Vec<WritableRoot>>)
```

**Purpose**: Turns the detailed file-system sandbox policy into a simpler sandbox mode for the prompt. It also finds which roots, if any, should be described as writable.

**Data flow**: It receives the file-system policy and the current working folder. If the policy allows full disk writes, it returns danger-full-access with no root list. Otherwise it asks the policy for writable roots relative to the current folder; no writable roots means read-only, while one or more writable roots means workspace-write plus that list.

**Call relations**: from_permission_profile calls this before building the final instructions. Its result feeds into the sandbox wording and, if applicable, the writable-root section.

*Call graph*: calls 2 internal fn (get_writable_roots_with_cwd, has_full_disk_write_access); called by 1 (from_permission_profile).


##### `network_access_from_policy`  (lines 179–185)

```
fn network_access_from_policy(network_policy: NetworkSandboxPolicy) -> NetworkAccess
```

**Purpose**: Converts the network sandbox policy into the simple network wording used in the prompt. It answers whether network access is enabled or restricted.

**Data flow**: It receives the network policy. If that policy says network access is enabled, it returns Enabled; otherwise it returns Restricted.

**Call relations**: from_permission_profile calls this while translating the full permission profile into prompt-friendly pieces. The result is passed into sandbox_text so the sandbox template can mention the network status.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (from_permission_profile).


##### `append_section`  (lines 187–192)

```
fn append_section(text: &mut String, section: &str)
```

**Purpose**: Adds one text section to the growing permissions message while keeping section boundaries clean. It prevents two sections from running together on the same line.

**Data flow**: It receives the mutable output string and the next section to add. If the output does not already end with a newline, it inserts one, then appends the section text. It changes the output string in place and returns nothing.

**Call relations**: from_permissions_with_network_and_denied_reads calls this for each section it includes. This keeps the main builder focused on which sections to include, while this helper takes care of spacing.

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

**Purpose**: Creates the approval-policy section of the permissions instructions. This tells the model when it may proceed, when it must ask, and when requests will not be allowed.

**Data flow**: It receives the approval policy, reviewer mode, execution policy, and feature flags for permission requests. It selects the right template or builds granular instructions, optionally adds guidance for the request_permissions tool, optionally mentions already-approved command prefixes, and optionally adds the auto-review warning. It returns the completed approval text.

**Call relations**: from_permissions_with_network_and_denied_reads calls this while assembling the full permissions block. If the policy is granular, approval_text hands off to granular_instructions; otherwise it chooses among the standard approval-policy templates.

*Call graph*: calls 1 internal fn (granular_instructions); called by 1 (from_permissions_with_network_and_denied_reads); 1 external calls (format!).


##### `sandbox_text`  (lines 249–259)

```
fn sandbox_text(mode: SandboxMode, network_access: NetworkAccess) -> String
```

**Purpose**: Creates the sandbox section of the instructions. It explains the current file-system access level and includes the current network-access status.

**Data flow**: It receives the sandbox mode and network access value. It chooses the matching preloaded template, converts the network access value to text, fills that value into the template, and returns the rendered section.

**Call relations**: from_permissions_with_network_and_denied_reads calls this first when building the permissions block. It is the bridge between simple sandbox settings and the readable template text shown to the model.

*Call graph*: called by 1 (from_permissions_with_network_and_denied_reads); 2 external calls (as_str, to_string).


##### `writable_roots_text`  (lines 261–277)

```
fn writable_roots_text(writable_roots: Option<Vec<WritableRoot>>) -> Option<String>
```

**Purpose**: Builds a short sentence listing the folders that may be written to. This makes workspace-write mode more concrete for the model.

**Data flow**: It receives an optional list of writable roots. If there is no list or the list is empty, it returns nothing. Otherwise it sorts the roots for stable output, formats each path in backticks, and returns a sentence using singular or plural wording as needed.

**Call relations**: from_permissions_with_network_and_denied_reads calls this after the sandbox and approval sections. If it returns text, that text is appended as its own section.

*Call graph*: called by 1 (from_permissions_with_network_and_denied_reads); 1 external calls (format!).


##### `denied_reads_text`  (lines 279–299)

```
fn denied_reads_text(file_system_policy: &FileSystemSandboxPolicy, cwd: &Path) -> Option<String>
```

**Purpose**: Builds a warning section for paths or filename patterns that the model must not read. These are hard policy restrictions, not situations where the model should ask for more permission.

**Data flow**: It receives the file-system policy and current working folder. It collects unreadable roots and unreadable glob patterns, formats each as a bullet, and returns a denied-reads section if there is anything to list. If nothing is denied, it returns nothing.

**Call relations**: from_permission_profile calls this while translating the permission profile. The resulting optional text is later appended by from_permissions_with_network_and_denied_reads.

*Call graph*: calls 2 internal fn (get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd); called by 1 (from_permission_profile); 1 external calls (format!).


##### `approved_command_prefixes_text`  (lines 301–304)

```
fn approved_command_prefixes_text(exec_policy: &Policy) -> Option<String>
```

**Purpose**: Creates readable text for command prefixes that have already been approved. A command prefix is the beginning of a shell-like command that the policy recognizes as allowed.

**Data flow**: It receives the execution policy, asks it for allowed prefixes, formats them for display, and returns the formatted string only if it is not empty.

**Call relations**: granular_instructions calls this when it wants to mention already-approved command rules. approval_text also reaches this behavior indirectly through granular_instructions or its on-request approval branch.

*Call graph*: calls 1 internal fn (format_allow_prefixes); called by 1 (granular_instructions); 1 external calls (get_allowed_prefixes).


##### `granular_prompt_intro_text`  (lines 306–308)

```
fn granular_prompt_intro_text() -> &'static str
```

**Purpose**: Provides the fixed introduction for granular approval mode. It explains that some approval categories can still prompt the user while disabled ones are automatically rejected.

**Data flow**: It takes no input and returns a fixed text block. Nothing is read from the session and nothing is changed.

**Call relations**: granular_instructions uses this as the first section of the granular approval message, so every granular prompt starts with the same plain explanation.


##### `request_permissions_tool_prompt_section`  (lines 310–312)

```
fn request_permissions_tool_prompt_section() -> &'static str
```

**Purpose**: Provides the fixed instructions for the built-in request_permissions tool. This tells the model to request only the specific extra network or file-system permissions it needs.

**Data flow**: It takes no input and returns a fixed text block describing when and how to use the tool. It has no side effects.

**Call relations**: granular_instructions calls this when granular settings allow request-permissions prompts. approval_text also uses this same guidance in non-granular policies when the tool is enabled.

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

**Purpose**: Builds the approval instructions for granular approval mode. Granular mode splits approval into categories, so the model needs to know which categories can ask the user and which are automatically rejected.

**Data flow**: It receives the granular approval configuration, execution policy, and feature flags. It checks each approval category, builds lists of categories that may prompt and categories that will be rejected, adds extra guidance for shell permission requests or the request_permissions tool when allowed, includes approved command prefixes if any exist, and returns all sections joined together.

**Call relations**: approval_text calls this when the approval policy is granular. It uses granular_prompt_intro_text for the opening, request_permissions_tool_prompt_section for tool guidance, and approved_command_prefixes_text for already-approved command rules.

*Call graph*: calls 7 internal fn (approved_command_prefixes_text, request_permissions_tool_prompt_section, allows_mcp_elicitations, allows_request_permissions, allows_rules_approval, allows_sandbox_approval, allows_skill_approval); called by 1 (approval_text); 2 external calls (format!, vec!).


### Skill discovery and injection
This group selects referenced skills, injects explicit skill content, and renders the available-skills catalog into prompt-visible context.

### `ext/skills/src/selection.rs`

`domain_logic` · `request handling`

This file is the skill picker. A “skill” is an optional package of instructions or behavior, and the catalog is the list of skills the system knows about. When a user mentions a skill directly, either through a structured input item, a mention, or text such as a tool-style reference, this code decides which enabled catalog entries match that request.

The main job is to avoid guessing too broadly. If the user gave a path like `skill://...` or pointed at a `SKILL.md` file, the code treats it as a skill path and matches it against several path-like fields in the catalog. If the user typed a plain skill name, the code only accepts it when it matches an enabled catalog entry by name. It also keeps a small “already seen” set so the same skill is not selected twice, much like checking names off a guest list instead of adding duplicate guests.

One important detail is that paths may have a `skill://` prefix for display or linking purposes. Before comparing paths, the code removes that prefix so different spellings of the same skill location can still match. Another detail is that explicit structured skill mentions block later plain-name matches with the same name, which helps prevent a path-based mention from accidentally also selecting a different skill with the same visible name.

#### Function details

##### `collect_explicit_skill_mentions`  (lines 13–68)

```
fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    catalog: &SkillCatalog,
) -> Vec<SkillCatalogEntry>
```

**Purpose**: This is the main selection function. Given the user’s inputs and the skill catalog, it returns the enabled catalog entries that the user explicitly mentioned.

**Data flow**: It receives a list of user input items and the catalog of known skills. First it looks for structured skill inputs and skill-looking mentions, selects matching skills by path, and remembers plain names that should not be reused later. Then it scans text messages for tool-style mentions, selects skill paths, and selects plain skill names when they match an enabled catalog entry and are not blocked. It returns a list of selected skill catalog entries, with duplicates removed.

**Call relations**: This function is called by `contribute` when the system is preparing skill contributions for a user request. It relies on `path_is_skill` to decide whether a path points to a skill, `normalize_skill_path` to compare paths consistently, `select_by_path` for path-based lookup, `push_selected` to add entries only once, and `extract_tool_mentions` to read skill-like references from free-form text.

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

**Purpose**: This helper selects all enabled skills whose catalog information matches a given skill path. It is used when the user points to a skill by location rather than by plain name.

**Data flow**: It receives the catalog, a path string, the set of already-seen skill keys, and the growing selected list. It removes any `skill://` prefix from the path, checks each enabled catalog entry to see whether it matches, and adds matching entries through the duplicate-safe selection helper. It changes the selected list and seen set, but does not return a separate value.

**Call relations**: It is called by `collect_explicit_skill_mentions` whenever a structured input, mention, or text reference contains a skill path. It delegates the actual comparison to `entry_matches_path` and delegates duplicate-safe insertion to `push_selected`.

*Call graph*: calls 3 internal fn (entry_matches_path, normalize_skill_path, push_selected); called by 1 (collect_explicit_skill_mentions).


##### `push_selected`  (lines 84–93)

```
fn push_selected(
    entry: &SkillCatalogEntry,
    seen: &mut HashSet<SkillCatalogEntryKey>,
    selected: &mut Vec<SkillCatalogEntry>,
)
```

**Purpose**: This helper adds a skill to the selected list only if that exact catalog entry has not already been added. It prevents duplicate skill selections when the same skill is mentioned in more than one way.

**Data flow**: It receives one catalog entry, the set of seen entry keys, and the selected list. It turns the entry into a compact identity key, checks whether that key is new, and if so clones the entry into the selected list. The result is an updated seen set and possibly a longer selected list.

**Call relations**: It is used both by `collect_explicit_skill_mentions` for plain-name matches and by `select_by_path` for path matches. It calls `SkillCatalogEntryKey::from` to decide what counts as the same skill: the entry’s authority and package id.

*Call graph*: calls 1 internal fn (from); called by 2 (collect_explicit_skill_mentions, select_by_path); 1 external calls (clone).


##### `entry_matches_path`  (lines 95–102)

```
fn entry_matches_path(entry: &SkillCatalogEntry, path: &str) -> bool
```

**Purpose**: This helper answers the question, “Does this catalog entry correspond to this path?” It lets one user-provided path match several possible catalog fields.

**Data flow**: It receives a catalog entry and a normalized path. It compares that path with the entry’s main prompt path, its package id, and its optional display path after normalizing that display path too. It returns true if any of those match, otherwise false.

**Call relations**: It is called by `select_by_path` while scanning enabled catalog entries. Its answer decides whether `select_by_path` passes the entry on to `push_selected`.

*Call graph*: called by 1 (select_by_path).


##### `path_is_skill`  (lines 104–110)

```
fn path_is_skill(path: &str) -> bool
```

**Purpose**: This helper decides whether a path should be treated as a skill reference. It recognizes both special `skill://` links and ordinary file paths ending in `SKILL.md`.

**Data flow**: It receives a path string. It checks whether the string starts with the skill URL-like prefix, or whether the final file name is `SKILL.md`, ignoring letter case and accepting both Unix-style `/` and Windows-style `\` separators. It returns true for skill-looking paths and false otherwise.

**Call relations**: It is called by `collect_explicit_skill_mentions` before trying to select by path. This prevents ordinary file mentions from being mistaken for skill requests.

*Call graph*: called by 1 (collect_explicit_skill_mentions).


##### `normalize_skill_path`  (lines 112–114)

```
fn normalize_skill_path(path: &str) -> &str
```

**Purpose**: This helper puts skill paths into a common form for comparison. Specifically, it removes the `skill://` prefix when it is present.

**Data flow**: It receives a path string. If the path starts with `skill://`, it returns the rest of the string; otherwise it returns the original string unchanged. It does not allocate a new string; it returns a view into the original text.

**Call relations**: It is used by `collect_explicit_skill_mentions` and `select_by_path` before comparing paths, so that prefixed and unprefixed forms can refer to the same catalog entry.

*Call graph*: called by 2 (collect_explicit_skill_mentions, select_by_path).


##### `SkillCatalogEntryKey::from`  (lines 123–128)

```
fn from(entry: &SkillCatalogEntry) -> Self
```

**Purpose**: This conversion builds the small identity key used to recognize duplicate skill selections. It treats a skill as the same when it has the same authority and package id.

**Data flow**: It receives a full catalog entry. It copies out the entry’s authority and package id into a smaller `SkillCatalogEntryKey`, which can be stored in a hash set for quick duplicate checks. The result is that compact key.

**Call relations**: It is called by `push_selected` just before adding a skill to the selected list. By supplying the key, it lets `push_selected` know whether this catalog entry has already been selected earlier in the same pass.

*Call graph*: called by 1 (push_selected).


### `core-skills/src/injection.rs`

`domain_logic` · `request handling`

A “skill” here is a reusable instruction file, usually a `SKILL.md`, that can be injected into the model’s context when the user asks for it. This file is the bridge between “the user mentioned a skill” and “the system has loaded the right skill text and recorded that it happened.” Without it, explicit skill mentions could be missed, duplicated, loaded from the wrong place, or silently fail without warning.

The file does three main jobs. First, it keeps track of host skill prompts that were already injected elsewhere, so the older injection path does not send the same `SKILL.md` twice. Second, it collects explicit skill requests from user input. Some requests are structured selections with a path; others are plain text mentions such as `$debugger` or Markdown-style links such as `[$debugger](skill://...)`. Path-based mentions win because they are exact. Plain names are only accepted when they are safe and unambiguous. Third, it loads the chosen skill files from the right file system, returns their contents, reports warnings for failures, and sends telemetry and analytics so the project can see which skills were used.

A useful analogy is a librarian: this file reads the request slip, checks that the title is not ambiguous, fetches the right book, notes any missing books, and records the checkout.

#### Function details

##### `InjectedHostSkillPrompts::insert_path`  (lines 43–47)

```
fn insert_path(&mut self, path: impl Into<String>)
```

**Purpose**: Records that a host-provided skill prompt has already been injected for this turn. It stores both the original path and a normalized version, so later checks can match even if the path spelling differs slightly.

**Data flow**: A path comes in as text-like input → the function converts it to a string, creates a normalized host-skill form, and adds both forms to an internal set → the object now remembers that this skill prompt should not be injected again.

**Call relations**: This method uses `normalize_host_skill_path` before saving the path. Later, `InjectedHostSkillPrompts::contains_path` checks against the same stored forms to prevent duplicate host skill prompt injection.

*Call graph*: calls 1 internal fn (normalize_host_skill_path); 1 external calls (into).


##### `InjectedHostSkillPrompts::is_empty`  (lines 49–51)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether any already-injected host skill paths have been recorded. This is useful for quickly knowing whether duplicate-prevention state exists at all.

**Data flow**: It reads the internal set of stored paths → checks whether that set has no entries → returns true if nothing has been recorded, otherwise false.

**Call relations**: Other code can call this before doing extra duplicate checks. It does not call into any helper and does not change the stored paths.


##### `InjectedHostSkillPrompts::contains_path`  (lines 53–55)

```
fn contains_path(&self, path: &str) -> bool
```

**Purpose**: Checks whether a given host skill path has already been injected. It compares both the path as written and the normalized form, so equivalent paths are treated as the same.

**Data flow**: A path string comes in → the function looks for that exact string in the stored set and also looks for the normalized version → it returns whether either form is present.

**Call relations**: This is the counterpart to `InjectedHostSkillPrompts::insert_path`. Both use `normalize_host_skill_path`, which keeps recording and checking consistent.

*Call graph*: calls 1 internal fn (normalize_host_skill_path).


##### `build_skill_injections`  (lines 58–111)

```
async fn build_skill_injections(
    mentioned_skills: &[SkillMetadata],
    loaded_skills: Option<&SkillLoadOutcome>,
    otel: Option<&SessionTelemetry>,
    analytics_client: &AnalyticsEventsClient
```

**Purpose**: Loads the actual text for skills that the user explicitly mentioned. It returns the skill contents to inject into the conversation, plus warnings for any skill file that could not be read.

**Data flow**: It receives a list of mentioned skills, optional information about where loaded skills live, telemetry, analytics, and tracking context → for each skill it chooses the right file system, reads the `SKILL.md` text, records success or failure metrics, and builds either an injection item or a warning → it returns a `SkillInjections` value containing loaded skill bodies and warning messages, and it also sends analytics about successful explicit invocations.

**Call relations**: This is the main loading step after skill mentions have been selected, commonly after `collect_explicit_skill_mentions` has identified them. It calls `emit_skill_injected_metric` for telemetry and hands successful invocation records to `track_skill_invocations` so analytics can record what was used.

*Call graph*: calls 3 internal fn (track_skill_invocations, emit_skill_injected_metric, from_abs_path); 6 external calls (new, with_capacity, is_empty, len, default, format!).


##### `normalize_host_skill_path`  (lines 113–115)

```
fn normalize_host_skill_path(path: &str) -> String
```

**Purpose**: Creates a consistent comparison form for host skill paths. It removes a skill URI prefix when present and changes Windows-style backslashes to forward slashes.

**Data flow**: A path string comes in → the function first applies `normalize_skill_path`, then replaces `\` with `/` → it returns a new normalized string.

**Call relations**: This helper is used by `InjectedHostSkillPrompts::insert_path` and `InjectedHostSkillPrompts::contains_path` so they agree on what counts as the same host skill path.

*Call graph*: calls 1 internal fn (normalize_skill_path); called by 2 (contains_path, insert_path).


##### `emit_skill_injected_metric`  (lines 117–131)

```
fn emit_skill_injected_metric(
    otel: Option<&SessionTelemetry>,
    skill: &SkillMetadata,
    status: &str,
)
```

**Purpose**: Records a small telemetry counter whenever a skill injection succeeds or fails. Telemetry means runtime measurement data used to understand system behavior.

**Data flow**: It receives optional telemetry, a skill, and a status such as `ok` or `error` → if telemetry is available, it increments a counter tagged with the status and skill name → it returns nothing and only affects the telemetry stream.

**Call relations**: `build_skill_injections` calls this after each attempted skill file read. It keeps the loading logic simple while centralizing the exact metric name and labels.

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

**Purpose**: Finds the skills the user explicitly asked for in a batch of user inputs. It combines structured skill selections with text mentions like `$name`, while avoiding disabled, duplicate, or ambiguous skills.

**Data flow**: It receives user inputs, the available skills, disabled skill paths, and counts of connector names that could conflict → it first resolves structured skill selections by exact path, then scans text inputs for tool mentions, and finally selects matching skills in the original skill order → it returns a list of skill metadata entries that are safe to inject.

**Call relations**: This function prepares the list that `build_skill_injections` can later load. It calls `extract_tool_mentions` to read text mentions and `select_skills_from_mentions` to apply the project’s matching rules.

*Call graph*: calls 3 internal fn (extract_tool_mentions, select_skills_from_mentions, relative_to_current_dir); 3 external calls (new, new, build_skill_name_counts).


##### `ToolMentions::is_empty`  (lines 217–219)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a parsed text input contained any usable tool names or linked paths. It is a quick way to skip selection work when there is nothing to match.

**Data flow**: It reads the stored name and path sets inside a `ToolMentions` value → checks whether both are empty → returns true only when no mention data was found.

**Call relations**: `select_skills_from_mentions` calls this at the start. If there are no mentions, selection stops immediately.

*Call graph*: called by 1 (select_skills_from_mentions).


##### `ToolMentions::plain_names`  (lines 221–223)

```
fn plain_names(&self) -> impl Iterator<Item = &'a str> + '_
```

**Purpose**: Provides an iterator over plain, unlinked mention names such as `debugger` from `$debugger`. These names are useful when code wants only simple text mentions, not resource-link paths.

**Data flow**: It reads the internal set of plain names → exposes them one by one as borrowed string slices → it does not change the stored mentions.

**Call relations**: This is a public accessor for callers that need to inspect plain mentions. In this file, `select_skills_from_mentions` reads the same stored plain-name data directly because it is in the same module.


##### `ToolMentions::paths`  (lines 225–227)

```
fn paths(&self) -> impl Iterator<Item = &'a str> + '_
```

**Purpose**: Provides an iterator over resource paths found in linked mentions. These paths allow exact matching, which is safer than matching by name alone.

**Data flow**: It reads the internal set of linked paths → exposes each path as a borrowed string slice → it leaves the mention data unchanged.

**Call relations**: `select_skills_from_mentions` calls this when it wants to resolve linked skill mentions by path before trying plain-name matching.

*Call graph*: called by 1 (select_skills_from_mentions).


##### `tool_kind_for_path`  (lines 245–257)

```
fn tool_kind_for_path(path: &str) -> ToolMentionKind
```

**Purpose**: Classifies a linked mention path as an app, MCP tool, plugin, skill, or something else. MCP refers to Model Context Protocol, a way for external tools to be exposed to the system.

**Data flow**: A path string comes in → the function checks known prefixes like `app://`, `mcp://`, `plugin://`, and `skill://`, and also checks whether the final filename is `SKILL.md` → it returns a `ToolMentionKind` category.

**Call relations**: Mention parsing and selection use this classification to avoid treating app, MCP, or plugin links as skill names. It calls `is_skill_filename` for the filename-based skill check.

*Call graph*: calls 1 internal fn (is_skill_filename).


##### `is_skill_filename`  (lines 259–262)

```
fn is_skill_filename(path: &str) -> bool
```

**Purpose**: Checks whether a path points to a file named `SKILL.md`, ignoring letter case. This catches skill links even when they do not use the `skill://` prefix.

**Data flow**: A path string comes in → the function takes the last path segment after `/` or `\` → it compares that filename to `SKILL.md` without caring about uppercase or lowercase → it returns true or false.

**Call relations**: `tool_kind_for_path` calls this as part of deciding whether a linked path should be treated as a skill.

*Call graph*: called by 1 (tool_kind_for_path).


##### `app_id_from_path`  (lines 264–267)

```
fn app_id_from_path(path: &str) -> Option<&str>
```

**Purpose**: Extracts the app identifier from an `app://...` path. It returns nothing for paths without that prefix or with an empty identifier.

**Data flow**: A path string comes in → the function removes the `app://` prefix if present and checks that something remains → it returns the remaining text as the app ID, or no value.

**Call relations**: This helper supports code that needs to interpret app links after `tool_kind_for_path` or similar logic has identified the path type.


##### `plugin_config_name_from_path`  (lines 269–272)

```
fn plugin_config_name_from_path(path: &str) -> Option<&str>
```

**Purpose**: Extracts the plugin configuration name from a `plugin://...` path. It refuses empty names so callers do not accidentally treat a blank path as a valid plugin.

**Data flow**: A path string comes in → the function removes the `plugin://` prefix if present and checks that the rest is not empty → it returns the plugin config name, or no value.

**Call relations**: This helper supports code that needs the concrete plugin name from a plugin-style linked mention.


##### `normalize_skill_path`  (lines 274–276)

```
fn normalize_skill_path(path: &str) -> &str
```

**Purpose**: Removes the `skill://` prefix from a skill path when it is present. This lets URI-style paths and plain file paths be compared more easily.

**Data flow**: A path string comes in → if it starts with `skill://`, that prefix is stripped; otherwise the original string is used → it returns the comparison-ready path slice.

**Call relations**: `normalize_host_skill_path` calls this before applying host-specific slash normalization. `select_skills_from_mentions` also uses it when matching linked skill paths.

*Call graph*: called by 1 (normalize_host_skill_path).


##### `extract_tool_mentions`  (lines 283–285)

```
fn extract_tool_mentions(text: &str) -> ToolMentions<'_>
```

**Purpose**: Finds tool mentions in a text input using the project’s normal mention marker, such as `$`. It is the standard entry point for parsing mentions from user text.

**Data flow**: A text string comes in → the function passes it to `extract_tool_mentions_with_sigil` with the default mention character → it returns a `ToolMentions` object containing names, linked paths, and plain names found in the text.

**Call relations**: `collect_explicit_skill_mentions` calls this while scanning text user inputs. It delegates the actual parsing to `extract_tool_mentions_with_sigil`.

*Call graph*: calls 1 internal fn (extract_tool_mentions_with_sigil); called by 2 (collect_explicit_skill_mentions, collect_explicit_skill_mentions).


##### `extract_tool_mentions_with_sigil`  (lines 287–348)

```
fn extract_tool_mentions_with_sigil(text: &str, sigil: char) -> ToolMentions<'_>
```

**Purpose**: Parses tool mentions from text using a caller-provided marker character. This makes the parser reusable in places that may use a different mention marker than `$`.

**Data flow**: It receives text and a sigil character → it scans the text byte by byte, recognizes plain mentions like `$name` and linked mentions like `[$name](path)`, ignores common environment variables such as `$PATH`, and separates plain names from linked paths → it returns a `ToolMentions` value with the parsed results.

**Call relations**: `extract_tool_mentions` calls this with the normal project sigil, and another caller can use it through `collect_tool_mentions_from_messages_with_sigil`. It calls `parse_linked_tool_mention` for Markdown-style links, `is_mention_name_char` to know where names start and end, and `is_common_env_var` to avoid false positives.

*Call graph*: calls 3 internal fn (is_common_env_var, is_mention_name_char, parse_linked_tool_mention); called by 2 (extract_tool_mentions, collect_tool_mentions_from_messages_with_sigil); 2 external calls (new, matches!).


##### `select_skills_from_mentions`  (lines 351–426)

```
fn select_skills_from_mentions(
    selection_context: &SkillSelectionContext<'_>,
    blocked_plain_names: &HashSet<String>,
    mentions: &ToolMentions<'_>,
    seen_names: &mut HashSet<String>,
```

**Purpose**: Turns parsed mention text into actual skill selections. It prefers exact path matches, then allows plain-name matches only when the name is unique and does not conflict with connector names.

**Data flow**: It receives the skill selection context, names that should not be matched as plain text, parsed mentions, tracking sets for already-seen names and paths, and the output list → it first selects skills whose paths exactly match linked mentions, then selects unique safe plain-name matches → it updates the seen sets and appends chosen skills to the selected list.

**Call relations**: `collect_explicit_skill_mentions` calls this after extracting mentions from each text input. It uses `ToolMentions::is_empty` to skip empty inputs and `ToolMentions::paths` to process linked paths before falling back to plain names.

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

**Purpose**: Recognizes one Markdown-style linked tool mention starting at a specific `[` character. For example, it can parse `[$tool](skill://path/to/SKILL.md)` into a name and path.

**Data flow**: It receives the full text, its bytes, a starting index, and the expected sigil → it checks for the exact linked-mention shape, validates the mention name, trims the path, and rejects empty or incomplete links → it returns the mention name, path, and the index after the link, or no value if the text does not match.

**Call relations**: `extract_tool_mentions_with_sigil` calls this whenever it sees `[` while scanning text. This keeps the main scanner from being crowded with the detailed link-parsing rules.

*Call graph*: calls 1 internal fn (is_mention_name_char); called by 1 (extract_tool_mentions_with_sigil).


##### `is_common_env_var`  (lines 485–501)

```
fn is_common_env_var(name: &str) -> bool
```

**Purpose**: Prevents ordinary environment variable references from being mistaken for tool mentions. For example, `$PATH` usually means a shell variable, not a skill named `PATH`.

**Data flow**: A possible mention name comes in → the function uppercases it and compares it with a small list of common environment variable names → it returns true if the name should be ignored as an environment variable.

**Call relations**: `extract_tool_mentions_with_sigil` calls this before accepting both plain and linked mention names. This reduces false positives in command-line or shell-related text.

*Call graph*: called by 1 (extract_tool_mentions_with_sigil); 1 external calls (matches!).


##### `text_mentions_skill`  (lines 504–533)

```
fn text_mentions_skill(text: &str, skill_name: &str) -> bool
```

**Purpose**: Provides a test-only helper that checks whether text contains a `$skill` mention for a specific skill name. It is compiled only for tests.

**Data flow**: It receives text and a skill name → if the skill name is empty it returns false; otherwise it scans for `$`, checks whether the following bytes match the skill name, and verifies the name is not just the prefix of a longer mention → it returns whether that exact skill mention appears.

**Call relations**: This helper exists for the test module connected at the bottom of the file. It uses `is_mention_name_char` to decide where a mention boundary ends.


##### `is_mention_name_char`  (lines 535–537)

```
fn is_mention_name_char(byte: u8) -> bool
```

**Purpose**: Defines which characters are allowed inside a mention name. Allowed characters are letters, numbers, underscore, hyphen, and colon.

**Data flow**: A single byte comes in → the function checks it against the allowed character ranges and symbols → it returns true if the byte can be part of a mention name.

**Call relations**: `extract_tool_mentions_with_sigil` and `parse_linked_tool_mention` rely on this to parse names consistently. The test-only `text_mentions_skill` helper also uses it to detect exact mention boundaries.

*Call graph*: called by 2 (extract_tool_mentions_with_sigil, parse_linked_tool_mention); 1 external calls (matches!).


### `core/src/skills.rs`

`orchestration` · `config load and per-turn command handling`

A “skill” is an extra capability Codex can load from the user, a repository, the system, or an administrator. Most of the real skill logic lives in the separate `codex_core_skills` crate. This file acts like a front desk for that crate: other parts of core can import skill types and helpers from one familiar place, without knowing where every piece is implemented.

It also contains two pieces of project-specific glue. First, it builds a `SkillsLoadInput` from the current `Config`, including the working folder, available plugin skill roots, configuration layers, and whether bundled skills are enabled. That gives the skills loader everything it needs in one package.

Second, it records analytics when Codex appears to use a skill implicitly. “Implicitly” means the user did not directly name the skill, but their command matches something a skill is designed for. The file asks the skills library whether a command looks like such a match. If it does, it creates a telemetry record, makes sure the same skill is not counted twice in the same turn, increments a local counter, and sends an analytics event. The duplicate check is protected by an async lock, which is like a small waiting room ticket system that prevents two tasks from marking the same skill at the same time.

#### Function details

##### `skills_load_input_from_config`  (lines 36–46)

```
fn skills_load_input_from_config(
    config: &Config,
    effective_skill_roots: Vec<PluginSkillRoot>,
) -> SkillsLoadInput
```

**Purpose**: Builds the input package needed to load skills, using the current Codex configuration and the skill roots discovered from plugins. This keeps the skill-loading code from needing to know the details of the main `Config` object.

**Data flow**: It receives a `Config` and a list of effective plugin skill roots. It copies out the current working directory, the plugin roots, the configuration layer stack, and the setting that says whether bundled skills are enabled. It returns a new `SkillsLoadInput` containing those pieces in the format the skills library expects.

**Call relations**: When some later part of the program is ready to load available skills, this helper prepares the ingredients. It asks the config whether bundled skills are enabled, then hands all gathered values to `SkillsLoadInput::new`, which creates the final load request.

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

**Purpose**: Checks whether a user command appears to have triggered a skill without the user explicitly naming it, and if so records that fact for telemetry and analytics. It avoids reporting the same implicit skill invocation more than once during the same turn.

**Data flow**: It receives the current session, turn context, command text, and working directory. It asks the skills detection logic whether the command matches an available skill. If there is no match, it exits. If there is a match, it builds a `SkillInvocation` record, creates a unique key from the skill’s scope, path, and name, and stores that key in the turn’s seen-skill set. If the key was already present, it exits. If it is new, it increments a telemetry counter and sends an analytics event describing the skill invocation.

**Call relations**: During command handling, this function sits after skill information has already been loaded into the turn context. It relies on `detect_implicit_skill_invocation_for_command` to decide whether the command looks skill-related. For a new match, it uses `build_track_events_context` to add model, thread, and subscription context, then hands the completed event to the session’s analytics client.

*Call graph*: 4 external calls (build_track_events_context, detect_implicit_skill_invocation_for_command, format!, vec!).


### `core-skills/src/render.rs`

`domain_logic` · `startup and prompt construction`

Skills are extra instruction files, usually named `SKILL.md`, that Codex can choose to read and follow. This file builds the “available skills” section that appears in the model’s context: a list of skill names, descriptions, and where to find each skill. Without it, Codex might not know which skills exist, or the skill list could grow so large that it crowds out the user’s task and other important context.

The main flow starts with loaded skill metadata. The renderer sorts skills by priority, formats each one as a simple bullet, and measures the result against a budget. The budget can be in characters or in approximate tokens, where a token is a small chunk of text used by the model. If everything fits, full descriptions are shown. If not, it first trims descriptions fairly across skills, like sharing a small table among several guests. If even the shortest lines do not fit, it keeps only as many minimum lines as possible and reports the rest as omitted.

The file also has a second space-saving trick: path aliases. Long filesystem paths can be replaced with short labels such as `r0/...`, plus a small table explaining what `r0` means. The renderer compares the normal and aliased versions and keeps whichever preserves more useful skill information. During thread startup it can also record telemetry, which is anonymous measurement data about how many skills were available, kept, or shortened.

#### Function details

##### `render_available_skills_body`  (lines 62–84)

```
fn render_available_skills_body(skill_root_lines: &[String], skill_lines: &[String]) -> String
```

**Purpose**: Builds the full text block that explains what skills are available and how Codex should use them. It chooses between absolute paths and short path aliases depending on whether a skill-root table is present.

**Data flow**: It receives already-rendered skill-root lines and skill lines. It adds headings, introductory text, the available skill list, and usage instructions, then returns one formatted string with surrounding newlines.

**Call relations**: This is used when calculating the extra cost of showing path aliases. The alias-cost code renders an empty absolute version and an empty aliased version so it can compare their sizes.

*Call graph*: called by 1 (aliased_metadata_overhead_cost); 2 external calls (new, format!).


##### `SkillMetadataBudget::limit`  (lines 93–97)

```
fn limit(self) -> usize
```

**Purpose**: Returns the numeric size limit stored inside a skill metadata budget, no matter whether that budget is measured in tokens or characters.

**Data flow**: It receives a budget value. It extracts the contained number and returns it unchanged.

**Call relations**: Rendering code calls this whenever it needs to decide whether skill text still fits. The aliased renderer also uses it to subtract the cost of the alias table.

*Call graph*: called by 3 (build_aliased_available_skills, render_minimum_skill_lines_until_budget, render_skill_lines_from_lines).


##### `SkillMetadataBudget::cost`  (lines 99–104)

```
fn cost(self, text: &str) -> usize
```

**Purpose**: Measures how expensive a piece of text is under this budget. For token budgets it estimates token count; for character budgets it counts characters.

**Data flow**: It receives a text string and the budget kind. It either estimates tokens or counts visible characters, then returns that cost.

**Call relations**: Line-cost helpers and alias-overhead calculations rely on this so every part of rendering uses the same measuring rule.

*Call graph*: called by 2 (aliased_metadata_overhead_cost, line_cost); 1 external calls (approx_token_count).


##### `SkillMetadataBudget::cost_from_counts`  (lines 106–111)

```
fn cost_from_counts(self, chars: usize, bytes: usize) -> usize
```

**Purpose**: Measures cost when the caller already knows the character and byte counts. This avoids rebuilding strings while testing many possible description lengths.

**Data flow**: It receives character and byte counts. It returns either the character count or an approximate token count based on bytes.

**Call relations**: DescriptionBudgetLine::new uses this while precomputing the cost of adding each extra description character.

*Call graph*: calls 1 internal fn (approx_token_count_from_bytes); called by 1 (new).


##### `approx_token_count_from_bytes`  (lines 114–116)

```
fn approx_token_count_from_bytes(bytes: usize) -> usize
```

**Purpose**: Gives a simple token estimate from byte length, using about four bytes per token. This is a fast approximation rather than an exact model tokenizer.

**Data flow**: It receives a byte count. It rounds up by groups of four bytes and returns that estimated token count.

**Call relations**: Token-budget calculations call this through SkillMetadataBudget::cost_from_counts when they already have byte counts.

*Call graph*: called by 1 (cost_from_counts).


##### `default_skill_metadata_budget`  (lines 143–158)

```
fn default_skill_metadata_budget(context_window: Option<i64>) -> SkillMetadataBudget
```

**Purpose**: Chooses the default amount of prompt space reserved for skill metadata. If a model context window is known, it reserves 2 percent of it; otherwise it falls back to 8,000 characters.

**Data flow**: It receives an optional context-window size. A positive value becomes a token budget equal to 2 percent, with at least one token; missing or invalid values become the default character budget.

**Call relations**: Callers use this before rendering skills when they need the standard budget. Tests check both the 2 percent behavior and the fallback path.

*Call graph*: 1 external calls (Characters).


##### `build_available_skills`  (lines 160–200)

```
fn build_available_skills(
    outcome: &SkillLoadOutcome,
    budget: SkillMetadataBudget,
    side_effects: SkillRenderSideEffects<'_>,
) -> Option<AvailableSkills>
```

**Purpose**: This is the main entry point for turning loaded skills into an `AvailableSkills` result. It decides whether to use normal paths or shorter aliases, and records telemetry if requested.

**Data flow**: It reads the load outcome, filters to skills allowed for implicit use, renders an absolute-path version, optionally renders an aliased version, compares them, records side effects, and returns the selected skill list or `None` if there are no skills.

**Call relations**: Higher-level prompt-building code would call this when preparing a session. It calls the sorting, rendering, aliasing, comparison, and telemetry helpers that make up the rest of this file.

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

**Purpose**: Builds an `AvailableSkills` object from already-prepared skill lines. It also decides whether the user-facing warning message should say descriptions were shortened or skills were omitted.

**Data flow**: It receives skill lines, the total skill count, a budget, and any path-alias lines. It renders as much as fits, builds a report, creates a warning if needed, and returns the packaged result.

**Call relations**: Both the absolute-path and aliased flows use this after they have chosen how paths should look. Tests also use it directly through a small helper.

*Call graph*: calls 1 internal fn (render_skill_lines_from_lines); called by 3 (build_aliased_available_skills, build_available_skills, build_available_skills_from_metadata); 1 external calls (format!).


##### `record_available_skills_side_effects`  (lines 253–277)

```
fn record_available_skills_side_effects(
    available: &AvailableSkills,
    budget: SkillMetadataBudget,
    side_effects: SkillRenderSideEffects<'_>,
)
```

**Purpose**: Records measurements and log messages after a skill list has been rendered. This makes truncation visible to operators without changing the rendered text.

**Data flow**: It receives the final available-skills result, the budget, and a side-effect mode. It writes telemetry counts, and if anything was shortened or omitted it emits an informational log.

**Call relations**: build_available_skills calls this once it has chosen the final rendering. It delegates the metric recording to record_skill_render_side_effects.

*Call graph*: calls 1 internal fn (record_skill_render_side_effects); called by 1 (build_available_skills); 1 external calls (info!).


##### `budget_warning_prefix`  (lines 279–288)

```
fn budget_warning_prefix(budget: SkillMetadataBudget, prefix: &str) -> String
```

**Purpose**: Adjusts warning text so token-budget warnings mention the 2 percent skills budget. Character-budget warnings keep the generic wording.

**Data flow**: It receives a budget kind and a warning prefix. For token budgets it replaces the first sentence with a 2 percent version; otherwise it returns the prefix unchanged.

**Call relations**: The warning-building logic uses this when some skills must be omitted. It is a small text helper for user-facing clarity.


##### `record_skill_render_side_effects`  (lines 290–322)

```
fn record_skill_render_side_effects(
    side_effects: SkillRenderSideEffects<'_>,
    total_count: usize,
    included_count: usize,
    omitted_count: usize,
    truncated_description_chars: usize,
```

**Purpose**: Writes skill-rendering metrics when side effects are enabled. Metrics are numeric observations used to understand behavior across sessions.

**Data flow**: It receives counts for total, included, omitted, and shortened description characters. If side effects are disabled it does nothing; on thread start it sends those numbers to session telemetry, converting oversized values safely.

**Call relations**: build_available_skills calls it for the empty-skills case, and record_available_skills_side_effects calls it for normal rendered results.

*Call graph*: called by 2 (build_available_skills, record_available_skills_side_effects); 1 external calls (try_from).


##### `render_skill_lines_from_lines`  (lines 324–379)

```
fn render_skill_lines_from_lines(
    skill_lines: Vec<SkillLine<'_>>,
    total_count: usize,
    budget: SkillMetadataBudget,
) -> (Vec<String>, SkillRenderReport)
```

**Purpose**: Chooses how much detail to show for each skill under the budget. It prefers full descriptions, then shortened descriptions, and only omits skills as a last resort.

**Data flow**: It receives skill lines, the total count, and a budget. It measures full lines; if they fit it returns them. If only minimum lines plus some description text fit, it distributes description space. If even minimum lines exceed the budget, it keeps minimum lines until the budget is full.

**Call relations**: build_available_skills_from_lines calls this as the core rendering step. It hands off to description-budget and minimum-line helpers depending on how tight the budget is.

*Call graph*: calls 5 internal fn (limit, render_lines_with_description_budget, render_minimum_skill_lines_until_budget, skill_render_report, sum_description_truncation); called by 1 (build_available_skills_from_lines).


##### `render_minimum_skill_lines_until_budget`  (lines 381–417)

```
fn render_minimum_skill_lines_until_budget(
    budget: SkillMetadataBudget,
    skill_lines: Vec<SkillLine<'_>>,
    total_count: usize,
) -> (Vec<String>, SkillRenderReport)
```

**Purpose**: Keeps as many skill entries as possible when there is not enough room for descriptions. Each kept entry contains the skill name and path only.

**Data flow**: It receives ordered skill lines, a total count, and a budget. It scans the lines, adds each minimum line if it fits, counts skipped lines as omitted, and counts all descriptions as removed.

**Call relations**: render_skill_lines_from_lines uses this as the fallback when even description-free lines cannot all fit. The ordering chosen earlier determines which skills get the first chance.

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

**Purpose**: Creates the report object that summarizes what happened during rendering. The report records counts for total, included, omitted, and shortened descriptions.

**Data flow**: It receives the individual count values and stores them in a `SkillRenderReport` struct.

**Call relations**: Both full/truncated rendering and minimum-line rendering use this helper so their reports have the same shape.

*Call graph*: called by 2 (render_minimum_skill_lines_until_budget, render_skill_lines_from_lines).


##### `SkillRenderReport::average_truncated_description_chars`  (lines 436–444)

```
fn average_truncated_description_chars(&self) -> usize
```

**Purpose**: Computes the average number of removed description characters per skill, rounded up. This is used to decide whether truncation is large enough to warn about.

**Data flow**: It reads the report’s total skill count and total truncated characters. If either is zero it returns zero; otherwise it divides, rounding up.

**Call relations**: Warning and logging code use this summary number instead of looking at every skill line.


##### `sum_description_truncation`  (lines 464–477)

```
fn sum_description_truncation(rendered: &[RenderedSkillLine]) -> (usize, usize)
```

**Purpose**: Adds up how much description text was removed from rendered skill lines. It also counts how many skills had any description removed.

**Data flow**: It receives rendered lines with per-line truncation counts. It walks through them and returns the total removed characters plus the number of affected lines.

**Call relations**: render_skill_lines_from_lines calls this after distributing a limited description budget.

*Call graph*: called by 1 (render_skill_lines_from_lines); 1 external calls (iter).


##### `SkillLine::new`  (lines 480–485)

```
fn new(skill: &'a SkillMetadata) -> Self
```

**Purpose**: Creates a renderable skill line from full skill metadata using the skill’s real `SKILL.md` path. It normalizes Windows backslashes into forward slashes for prompt readability.

**Data flow**: It reads the skill name, description, and path from `SkillMetadata`, turns the path into text, and returns a `SkillLine`.

**Call relations**: The absolute-path rendering path uses this through ordered_absolute_skill_lines. Tests also use it to calculate expected costs and lines.

*Call graph*: called by 6 (budgeted_rendering_does_not_warn_when_average_description_truncation_is_within_threshold, budgeted_rendering_redistributes_unused_description_budget, budgeted_rendering_token_budget_truncation_warning_mentions_two_percent, budgeted_rendering_truncates_descriptions_equally_before_omitting_skills, budgeted_rendering_warns_when_average_description_truncation_exceeds_threshold, expected_skill_line); 1 external calls (with_path).


##### `SkillLine::with_path`  (lines 487–493)

```
fn with_path(skill: &'a SkillMetadata, path: String) -> Self
```

**Purpose**: Creates a renderable skill line with a caller-provided path string. This is used when the path has already been shortened with an alias.

**Data flow**: It receives skill metadata and a path string. It stores references to the skill name and description, plus the supplied path, in a `SkillLine`.

**Call relations**: SkillLine::new delegates to this for normal paths, and the aliased renderer uses it after building alias-based paths.


##### `SkillLine::full_cost`  (lines 495–497)

```
fn full_cost(&self, budget: SkillMetadataBudget) -> usize
```

**Purpose**: Measures the budget cost of showing this skill with its full description.

**Data flow**: It renders the full line, adds the newline cost through `line_cost`, and returns the resulting cost.

**Call relations**: render_skill_lines_from_lines uses this while checking whether the complete skill list fits.

*Call graph*: calls 2 internal fn (render_full, line_cost).


##### `SkillLine::minimum_cost`  (lines 499–501)

```
fn minimum_cost(&self, budget: SkillMetadataBudget) -> usize
```

**Purpose**: Measures the budget cost of showing this skill without its description. This is the smallest useful entry: name plus path.

**Data flow**: It renders the minimum line, measures it with `line_cost`, and returns the cost.

**Call relations**: The renderer uses this to decide whether all skill names and paths can fit, and the omission fallback uses it one line at a time.

*Call graph*: calls 2 internal fn (render_minimum, line_cost).


##### `SkillLine::description_char_count`  (lines 503–505)

```
fn description_char_count(&self) -> usize
```

**Purpose**: Counts how many characters are in this skill’s description. It counts user-visible characters rather than raw bytes.

**Data flow**: It reads the description string and returns its character count.

**Call relations**: Description-budget planning uses this to know how many characters could be allocated or removed.

*Call graph*: called by 1 (new).


##### `SkillLine::render_full`  (lines 507–509)

```
fn render_full(&self) -> String
```

**Purpose**: Formats this skill as a bullet line with its complete description.

**Data flow**: It takes the stored name, description, and path, then returns a string like a markdown list item.

**Call relations**: Cost measurement calls this before measuring full skill lines.

*Call graph*: calls 1 internal fn (render_with_description); called by 1 (full_cost).


##### `SkillLine::render_minimum`  (lines 511–513)

```
fn render_minimum(&self) -> String
```

**Purpose**: Formats this skill as a bullet line without a description. This keeps the skill discoverable when space is very tight.

**Data flow**: It uses the stored name and path with an empty description and returns the formatted line.

**Call relations**: Minimum-cost calculations and description-budget setup call this to establish the baseline line.

*Call graph*: calls 1 internal fn (render_with_description); called by 2 (new, minimum_cost).


##### `SkillLine::rendered_description_prefix_len`  (lines 515–520)

```
fn rendered_description_prefix_len(&self, description_chars: usize) -> usize
```

**Purpose**: Finds the byte position for the first N description characters. This lets the code cut text at character boundaries safely, even for non-English text or emoji.

**Data flow**: It receives the desired number of description characters. It walks character positions and returns the matching byte index, or the full string length if N covers the whole description.

**Call relations**: render_with_description_chars uses this before slicing the description string.

*Call graph*: called by 1 (render_with_description_chars).


##### `SkillLine::render_with_description_chars`  (lines 522–530)

```
fn render_with_description_chars(&self, description_chars: usize) -> String
```

**Purpose**: Formats a skill line using only the first chosen number of description characters.

**Data flow**: It receives a character count. If the count is zero it renders the minimum line; otherwise it safely slices that many characters from the description and returns the formatted line.

**Call relations**: render_lines_with_description_budget uses this after deciding how many description characters each skill gets.

*Call graph*: calls 1 internal fn (rendered_description_prefix_len); 1 external calls (format!).


##### `SkillLine::render_with_description`  (lines 532–538)

```
fn render_with_description(&self, description: &str) -> String
```

**Purpose**: Formats the final markdown bullet for a skill, either with a description or without one.

**Data flow**: It receives description text. If it is empty, the result contains only the name and file path; otherwise it includes the description before the file path.

**Call relations**: render_full and render_minimum both use this common formatter.

*Call graph*: called by 2 (render_full, render_minimum); 1 external calls (format!).


##### `DescriptionBudgetLine::new`  (lines 542–570)

```
fn new(line: &'a SkillLine<'a>, budget: SkillMetadataBudget) -> Self
```

**Purpose**: Precomputes how much budget each extra description character would cost for one skill line. This makes fair description trimming easier and faster.

**Data flow**: It receives a skill line and a budget type. It measures the minimum line, then walks through the description character by character, storing the added cost for every possible prefix length.

**Call relations**: render_lines_with_description_budget creates one of these for each skill before distributing the remaining description budget.

*Call graph*: calls 3 internal fn (description_char_count, render_minimum, cost_from_counts); 1 external calls (with_capacity).


##### `line_cost`  (lines 573–575)

```
fn line_cost(budget: SkillMetadataBudget, line: &str) -> usize
```

**Purpose**: Measures the budget cost of one rendered skill line, including its trailing newline.

**Data flow**: It receives a budget and a line string. It appends a newline for measurement and returns the budget cost.

**Call relations**: SkillLine::full_cost and SkillLine::minimum_cost use this so line measurements match how the list will actually be joined.

*Call graph*: calls 1 internal fn (cost); called by 2 (full_cost, minimum_cost); 1 external calls (format!).


##### `lines_cost`  (lines 577–581)

```
fn lines_cost(budget: SkillMetadataBudget, lines: &[String]) -> usize
```

**Purpose**: Measures the combined cost of several rendered skill lines.

**Data flow**: It receives a budget and a slice of strings. It sums the individual line costs using saturating arithmetic, which avoids overflow.

**Call relations**: available_skills_cost uses this when comparing the total size of absolute and aliased renderings.

*Call graph*: called by 1 (available_skills_cost).


##### `render_lines_with_description_budget`  (lines 583–636)

```
fn render_lines_with_description_budget(
    budget: SkillMetadataBudget,
    skill_lines: &[SkillLine<'_>],
    limit: usize,
) -> Vec<RenderedSkillLine>
```

**Purpose**: Shares limited description space across all skills. It gives each skill one character at a time in order, so short descriptions finish naturally and unused room can go to longer ones.

**Data flow**: It receives a budget, skill lines, and the extra space available for descriptions after minimum lines are paid for. It allocates characters while space remains, then returns rendered lines with truncation counts.

**Call relations**: render_skill_lines_from_lines calls this when all skills can fit, but their full descriptions cannot.

*Call graph*: called by 1 (render_skill_lines_from_lines); 2 external calls (iter, vec!).


##### `build_aliased_available_skills`  (lines 638–659)

```
fn build_aliased_available_skills(
    outcome: &SkillLoadOutcome,
    skills: &[SkillMetadata],
    budget: SkillMetadataBudget,
) -> Option<AvailableSkills>
```

**Purpose**: Tries to render the skill list using short root aliases instead of long absolute paths. This can save enough room to keep more skills or more description text.

**Data flow**: It receives the load outcome, selected skills, and the original budget. It builds an alias plan, subtracts the alias-table cost from the budget, renders paths with aliases, and returns an `AvailableSkills` result if possible.

**Call relations**: build_available_skills calls this only when the absolute-path rendering had budget pressure. Tests also call it to check alias behavior around omitted skills.

*Call graph*: calls 4 internal fn (limit, build_alias_plan, build_available_skills_from_lines, ordered_skills_for_budget); called by 2 (build_available_skills, outcome_rendering_counts_plugin_version_skills_before_budget_omission); 3 external calls (len, Characters, Tokens).


##### `build_alias_plan`  (lines 673–736)

```
fn build_alias_plan(
    outcome: &SkillLoadOutcome,
    skills: &[SkillMetadata],
    budget: SkillMetadataBudget,
) -> Option<AliasPlan>
```

**Purpose**: Builds the table that maps short aliases like `r0` to real skill roots. It also records which alias root applies to each skill path.

**Data flow**: It receives the load outcome, the skills being rendered, and the budget. It finds roots actually used by those skills, chooses compact alias roots, assigns alias names, builds table lines, measures their cost, and returns the plan.

**Call relations**: The aliased rendering path depends on this plan. Many tests call it directly to confirm the chosen roots for plugin and marketplace layouts.

*Call graph*: calls 4 internal fn (aliased_metadata_overhead_cost, build_skill_root_lines, ordered_alias_roots, plugin_version_skill_counts_for_skill_roots); called by 8 (build_aliased_available_skills, outcome_rendering_counts_plugin_version_skills_before_budget_omission, outcome_rendering_extracts_plugin_marketplace_root_for_multiple_plugins, outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit, outcome_rendering_uses_each_skill_root_for_multiple_roots_in_one_plugin_version, outcome_rendering_uses_marketplace_root_for_single_skill_plugin_versions, outcome_rendering_uses_one_marketplace_root_for_multiple_plugin_versions, outcome_rendering_uses_skill_root_for_multiple_skills_in_one_plugin_version); 1 external calls (iter).


##### `ordered_alias_roots`  (lines 738–751)

```
fn ordered_alias_roots(
    used_roots: &[AbsolutePathBuf],
    alias_root_by_skill_root: &HashMap<AbsolutePathBuf, AbsolutePathBuf>,
) -> Option<Vec<AbsolutePathBuf>>
```

**Purpose**: Produces alias roots in the same order as the used skill roots, while removing duplicates. Stable ordering keeps prompt output predictable.

**Data flow**: It receives used roots and a map from skill roots to alias roots. It walks the roots, looks up each alias root, keeps the first occurrence, and returns the ordered list or `None` if a lookup is missing.

**Call relations**: build_alias_plan uses this before assigning `r0`, `r1`, and so on.

*Call graph*: called by 1 (build_alias_plan); 2 external calls (new, new).


##### `alias_root_for_skill_root`  (lines 753–769)

```
fn alias_root_for_skill_root(
    root: &AbsolutePathBuf,
    plugin_version_skill_counts: &HashMap<AbsolutePathBuf, usize>,
) -> AbsolutePathBuf
```

**Purpose**: Chooses how broad an alias root should be for a plugin skill root. It may use the exact skill root or a broader marketplace root, depending on what saves space without hiding important structure.

**Data flow**: It receives a skill root and counts of skills per plugin version. If the root is not in the plugin cache layout, it returns the root itself. If a plugin version has multiple skill roots, it keeps the exact root; otherwise it may use the marketplace base.

**Call relations**: build_alias_plan uses this when turning real skill roots into alias roots. It calls helpers that recognize the plugin-cache path layout.

*Call graph*: calls 3 internal fn (plugin_marketplace_base, plugin_version_base, as_path); 1 external calls (clone).


##### `plugin_version_skill_counts_for_skill_roots`  (lines 771–782)

```
fn plugin_version_skill_counts_for_skill_roots(
    skill_roots: impl Iterator<Item = &'a AbsolutePathBuf>,
) -> HashMap<AbsolutePathBuf, usize>
```

**Purpose**: Counts how many skill roots belong to each plugin version. This helps decide whether an alias can safely point at a broader marketplace directory.

**Data flow**: It receives an iterator of skill roots. For each root that matches the plugin-cache layout, it finds the plugin-version base and increments that base’s count.

**Call relations**: build_alias_plan calls this before choosing alias roots.

*Call graph*: calls 1 internal fn (plugin_version_base); called by 1 (build_alias_plan); 1 external calls (new).


##### `aliased_metadata_overhead_cost`  (lines 784–794)

```
fn aliased_metadata_overhead_cost(
    budget: SkillMetadataBudget,
    skill_root_lines: &[String],
) -> usize
```

**Purpose**: Calculates the extra budget cost of adding the skill-root alias table and alias-specific instructions. Aliases save path space, but the table itself costs space.

**Data flow**: It renders an empty skills body without aliases and another with the alias root lines. It measures both and returns the difference.

**Call relations**: build_alias_plan uses this to see whether an alias table fits. available_skills_cost also uses it when comparing absolute and aliased renderings.

*Call graph*: calls 2 internal fn (cost, render_available_skills_body); called by 2 (available_skills_cost, build_alias_plan).


##### `build_skill_root_lines`  (lines 796–805)

```
fn build_skill_root_lines(roots: &[AbsolutePathBuf]) -> Vec<String>
```

**Purpose**: Formats the alias table shown to Codex, such as `r0 = /some/root`. This tells the model how to expand short paths.

**Data flow**: It receives ordered absolute roots. It assigns each one an index, normalizes path separators, and returns formatted markdown bullet lines.

**Call relations**: build_alias_plan calls this after choosing alias roots.

*Call graph*: called by 1 (build_alias_plan); 1 external calls (iter).


##### `plugin_marketplace_base`  (lines 807–818)

```
fn plugin_marketplace_base(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Recognizes the base directory of a plugin marketplace cache path. This lets several plugin paths share one short alias when appropriate.

**Data flow**: It receives a filesystem path. It walks upward until it finds a parent shaped like `plugins/cache`, then returns the directory below that point as an absolute path, or `None` if the layout does not match.

**Call relations**: alias_root_for_skill_root and plugin_version_base call this to understand plugin-cache paths.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (alias_root_for_skill_root, plugin_version_base).


##### `plugin_version_base`  (lines 820–835)

```
fn plugin_version_base(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the directory that represents one plugin and one version inside the marketplace cache. For example, it identifies the `plugin/version` level.

**Data flow**: It receives a path, first finds the marketplace base, then reads the next two path components as plugin name and version. If that succeeds, it returns the combined absolute path.

**Call relations**: alias_root_for_skill_root uses this to decide alias breadth, and plugin_version_skill_counts_for_skill_roots uses it for counting.

*Call graph*: calls 2 internal fn (plugin_marketplace_base, from_absolute_path); called by 2 (alias_root_for_skill_root, plugin_version_skill_counts_for_skill_roots); 1 external calls (strip_prefix).


##### `render_skill_path_with_aliases`  (lines 837–840)

```
fn render_skill_path_with_aliases(skill: &SkillMetadata, plan: &AliasPlan) -> String
```

**Purpose**: Returns the path text that should be shown for a skill when aliases are available. It falls back to the full normalized path if the skill cannot be expressed with an alias.

**Data flow**: It receives skill metadata and an alias plan. It asks for a relative aliased path; if that fails, it converts the absolute path to prompt-friendly text.

**Call relations**: build_aliased_available_skills uses this while creating aliased `SkillLine` values.

*Call graph*: calls 1 internal fn (outcome_relative_skill_path).


##### `outcome_relative_skill_path`  (lines 842–852)

```
fn outcome_relative_skill_path(skill: &SkillMetadata, plan: &AliasPlan) -> Option<String>
```

**Purpose**: Builds a short path like `r0/foo/SKILL.md` for a skill. It does this by finding the alias root for the skill and making the skill path relative to that root.

**Data flow**: It receives a skill and alias plan. It looks up the skill’s alias root, finds the alias name, strips the root prefix from the full path, normalizes separators, and returns the combined alias path.

**Call relations**: render_skill_path_with_aliases calls this and handles the fallback if it cannot create an aliased path.

*Call graph*: called by 1 (render_skill_path_with_aliases); 1 external calls (format!).


##### `aliased_render_is_better`  (lines 854–867)

```
fn aliased_render_is_better(
    aliased: &AvailableSkills,
    absolute: &AvailableSkills,
    budget: SkillMetadataBudget,
) -> bool
```

**Purpose**: Decides whether the aliased rendering is worth using instead of the absolute-path rendering.

**Data flow**: It compares included skill count first, then amount of description truncation, then total rendered cost. It returns true only if the aliased version is better by those rules.

**Call relations**: build_available_skills uses this after it has both absolute and aliased candidates.

*Call graph*: calls 1 internal fn (available_skills_cost); called by 1 (build_available_skills).


##### `available_skills_cost`  (lines 869–876)

```
fn available_skills_cost(budget: SkillMetadataBudget, available: &AvailableSkills) -> usize
```

**Purpose**: Measures the total budget cost of an `AvailableSkills` result. It includes both skill lines and, when present, the alias-table overhead.

**Data flow**: It receives a budget and rendered available-skills data. It measures alias metadata if needed, adds the cost of skill lines, and returns the total.

**Call relations**: aliased_render_is_better uses this as the final tie-breaker between two renderings.

*Call graph*: calls 2 internal fn (aliased_metadata_overhead_cost, lines_cost); called by 1 (aliased_render_is_better).


##### `ordered_absolute_skill_lines`  (lines 878–883)

```
fn ordered_absolute_skill_lines(skills: &[SkillMetadata]) -> Vec<SkillLine<'_>>
```

**Purpose**: Creates renderable skill lines with absolute paths in the correct priority order.

**Data flow**: It receives skill metadata, sorts the skills for budget priority, converts each one into a `SkillLine`, and returns the list.

**Call relations**: build_available_skills uses this for the first rendering attempt. Test helpers also use it to render expected absolute-path results.

*Call graph*: calls 1 internal fn (ordered_skills_for_budget); called by 2 (build_available_skills, build_available_skills_from_metadata).


##### `ordered_skills_for_budget`  (lines 885–894)

```
fn ordered_skills_for_budget(skills: &[SkillMetadata]) -> Vec<&SkillMetadata>
```

**Purpose**: Sorts skills so the most important scopes are considered first when space is limited. Within a scope it sorts by name and path for stable output.

**Data flow**: It receives skill metadata. It copies references into a vector, sorts by scope rank, then name, then path, and returns the ordered references.

**Call relations**: Both absolute and aliased rendering use this before measuring against a budget.

*Call graph*: called by 2 (build_aliased_available_skills, ordered_absolute_skill_lines); 1 external calls (iter).


##### `prompt_scope_rank`  (lines 896–903)

```
fn prompt_scope_rank(scope: SkillScope) -> u8
```

**Purpose**: Assigns a numeric priority to each skill scope. Lower numbers mean higher priority in the prompt.

**Data flow**: It receives a `SkillScope` and returns 0 for system, 1 for admin, 2 for repository, or 3 for user.

**Call relations**: ordered_skills_for_budget calls this while sorting skills.


##### `tests::make_skill`  (lines 915–927)

```
fn make_skill(name: &str, scope: SkillScope) -> SkillMetadata
```

**Purpose**: Creates a simple test skill with a predictable name, description, path, and scope. This keeps the tests focused on rendering behavior instead of setup details.

**Data flow**: It receives a name and scope. It builds a `SkillMetadata` value with default-like fields and a `/tmp/.../SKILL.md` path.

**Call relations**: Many tests use this directly or through other test helpers to create input skills.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::make_skill_with_description`  (lines 929–937)

```
fn make_skill_with_description(
        name: &str,
        scope: SkillScope,
        description: &str,
    ) -> SkillMetadata
```

**Purpose**: Creates a test skill and replaces its description with caller-provided text.

**Data flow**: It receives a name, scope, and description. It calls `make_skill`, changes the description, and returns the modified metadata.

**Call relations**: Description-budget tests use this to create short, long, and empty descriptions.

*Call graph*: 1 external calls (make_skill).


##### `tests::expected_skill_line`  (lines 939–941)

```
fn expected_skill_line(skill: &SkillMetadata, description: &str) -> String
```

**Purpose**: Builds the exact rendered line expected for a test skill and description. This avoids duplicating formatting details in test assertions.

**Data flow**: It receives a skill and description, turns the skill into a `SkillLine`, renders it with that description, and returns the string.

**Call relations**: Several tests compare renderer output against strings produced by this helper.

*Call graph*: calls 1 internal fn (new).


##### `tests::normalized_path`  (lines 943–945)

```
fn normalized_path(path: &AbsolutePathBuf) -> String
```

**Purpose**: Converts an absolute test path into the normalized path text expected in rendered prompts.

**Data flow**: It receives an absolute path, converts it to text, replaces backslashes with forward slashes, and returns the string.

**Call relations**: Alias tests use this when constructing expected skill-root table lines.

*Call graph*: calls 1 internal fn (to_string_lossy).


##### `tests::outcome_with_roots`  (lines 947–971)

```
fn outcome_with_roots(
        skills: Vec<SkillMetadata>,
        roots: Vec<AbsolutePathBuf>,
    ) -> SkillLoadOutcome
```

**Purpose**: Builds a fake skill-load outcome with skills and their roots. This mimics the data the renderer receives in real use.

**Data flow**: It receives skills and root paths. It maps each skill path to the first root that contains it, stores the skills and roots, and fills the rest with defaults.

**Call relations**: Outcome and alias tests use this before calling build_available_skills or build_alias_plan.

*Call graph*: 2 external calls (new, default).


##### `tests::build_available_skills_from_metadata`  (lines 973–983)

```
fn build_available_skills_from_metadata(
        skills: &[SkillMetadata],
        budget: SkillMetadataBudget,
    ) -> Option<AvailableSkills>
```

**Purpose**: Test helper that renders a list of skill metadata using absolute paths. It bypasses the full load outcome so tests can focus on budget behavior.

**Data flow**: It receives skills and a budget. It orders them, converts them to absolute-path lines, and calls build_available_skills_from_lines.

**Call relations**: Most budget-focused tests use this helper instead of the top-level outcome-based function.

*Call graph*: calls 2 internal fn (build_available_skills_from_lines, ordered_absolute_skill_lines); 2 external calls (len, default).


##### `tests::skill_usage_instructions_require_complete_main_agent_reads`  (lines 986–1007)

```
fn skill_usage_instructions_require_complete_main_agent_reads()
```

**Purpose**: Checks that the prompt instructions require Codex to read selected skill files completely. This protects an important safety and correctness rule.

**Data flow**: It inspects both instruction text variants and asserts that required phrases are present and an unwanted partial-reading phrase is absent.

**Call relations**: This test guards the constant strings used by render_available_skills_body.

*Call graph*: 1 external calls (assert!).


##### `tests::default_budget_uses_two_percent_of_full_context_window`  (lines 1010–1019)

```
fn default_budget_uses_two_percent_of_full_context_window()
```

**Purpose**: Verifies that a known model context window produces a token budget equal to 2 percent of that window.

**Data flow**: It calls the default-budget function with example window sizes and checks the returned token budgets.

**Call relations**: This protects the startup budget rule used before skill rendering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::default_budget_falls_back_to_characters_without_context_window`  (lines 1022–1031)

```
fn default_budget_falls_back_to_characters_without_context_window()
```

**Purpose**: Verifies that missing or invalid context-window values use the fixed character budget.

**Data flow**: It calls the default-budget function with `None` and a negative value, then checks for the 8,000-character fallback.

**Call relations**: This protects behavior for models or situations where no context size is available.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::budgeted_rendering_truncates_descriptions_equally_before_omitting_skills`  (lines 1034–1056)

```
fn budgeted_rendering_truncates_descriptions_equally_before_omitting_skills()
```

**Purpose**: Checks that, when all skills can fit but full descriptions cannot, the renderer shortens descriptions rather than omitting skills.

**Data flow**: It creates two skills with equal-length descriptions, sets a budget that leaves room for only a few description characters, renders them, and checks the shortened output and report counts.

**Call relations**: This exercises SkillLine costing, build_available_skills_from_metadata, and the description-budget distribution path.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_does_not_warn_when_average_description_truncation_is_within_threshold`  (lines 1059–1075)

```
fn budgeted_rendering_does_not_warn_when_average_description_truncation_is_within_threshold()
```

**Purpose**: Checks that small average description trimming does not produce a warning. This prevents noisy warnings for minor shortening.

**Data flow**: It creates two skills, forces modest truncation, renders them, and asserts that the warning is absent while report counts are correct.

**Call relations**: This verifies the warning threshold used inside build_available_skills_from_lines.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_warns_when_average_description_truncation_exceeds_threshold`  (lines 1078–1104)

```
fn budgeted_rendering_warns_when_average_description_truncation_exceeds_threshold()
```

**Purpose**: Checks that large description trimming produces the standard warning message.

**Data flow**: It creates one very long-description skill and one empty-description skill, sets a tight budget, renders them, and checks truncation counts and warning text.

**Call relations**: This protects the warning logic based on average truncated description characters.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_token_budget_truncation_warning_mentions_two_percent`  (lines 1107–1122)

```
fn budgeted_rendering_token_budget_truncation_warning_mentions_two_percent()
```

**Purpose**: Checks that token-budget truncation warnings mention the 2 percent skills context budget.

**Data flow**: It creates a long skill, uses a tight token budget, renders it, and asserts the warning is the token-specific version.

**Call relations**: This verifies the token branch of warning selection in build_available_skills_from_lines.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Tokens, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_redistributes_unused_description_budget`  (lines 1125–1146)

```
fn budgeted_rendering_redistributes_unused_description_budget()
```

**Purpose**: Checks that unused description space from a short skill can be used by a longer skill. This confirms the budget is shared flexibly rather than divided into rigid quotas.

**Data flow**: It creates one short and one long description, gives enough budget for all of the short description and most of the long one, renders, and checks the exact output.

**Call relations**: This exercises render_lines_with_description_budget’s one-character-at-a-time allocation.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, Characters, build_available_skills_from_metadata, make_skill_with_description).


##### `tests::budgeted_rendering_preserves_prompt_priority_when_minimum_lines_exceed_budget`  (lines 1149–1178)

```
fn budgeted_rendering_preserves_prompt_priority_when_minimum_lines_exceed_budget()
```

**Purpose**: Checks that, when not all minimum lines fit, higher-priority scopes are kept first.

**Data flow**: It creates system, admin, repository, and user skills, sets a budget for only the first two minimum lines, renders, and verifies system/admin remain while repo/user are omitted.

**Call relations**: This tests ordered_skills_for_budget, prompt_scope_rank, and the minimum-line fallback path.

*Call graph*: 6 external calls (assert!, assert_eq!, Characters, build_available_skills_from_metadata, make_skill, format!).


##### `tests::budgeted_rendering_keeps_scanning_after_oversized_entry`  (lines 1181–1204)

```
fn budgeted_rendering_keeps_scanning_after_oversized_entry()
```

**Purpose**: Checks that one oversized earlier skill does not stop later smaller skills from being included. The renderer skips what cannot fit and keeps looking.

**Data flow**: It creates an oversized system skill and a smaller repo skill, sets a budget that fits only the repo skill, renders, and verifies the repo skill appears.

**Call relations**: This protects the loop inside render_minimum_skill_lines_until_budget.

*Call graph*: 6 external calls (assert!, assert_eq!, Characters, build_available_skills_from_metadata, make_skill, format!).


##### `tests::outcome_rendering_omits_aliases_when_absolute_plan_has_no_budget_pressure`  (lines 1207–1228)

```
fn outcome_rendering_omits_aliases_when_absolute_plan_has_no_budget_pressure()
```

**Purpose**: Checks that aliases are not used when absolute paths already fit comfortably. This avoids adding an unnecessary alias table.

**Data flow**: It creates two skills under one root with an unlimited character budget, renders through the top-level function, and verifies no skill-root lines are shown.

**Call relations**: This exercises build_available_skills’ decision to keep the absolute rendering when nothing is truncated or omitted.

*Call graph*: calls 1 internal fn (build_available_skills); 6 external calls (assert!, assert_eq!, test_path_buf, Characters, outcome_with_roots, vec!).


##### `tests::outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit`  (lines 1231–1289)

```
fn outcome_rendering_uses_aliases_when_they_allow_more_skills_to_fit()
```

**Purpose**: Checks that aliases are chosen when they let the renderer include more useful skill information.

**Data flow**: It creates many skills under a long shared root, proves the aliased form is cheaper, renders with a budget sized for the alias form, and checks that all skills and the alias table appear.

**Call relations**: This tests build_alias_plan, build_available_skills, and aliased_render_is_better working together.

*Call graph*: calls 2 internal fn (build_alias_plan, build_available_skills); 6 external calls (assert!, assert_eq!, test_path_buf, Characters, outcome_with_roots, vec!).


##### `tests::outcome_rendering_uses_marketplace_root_for_single_skill_plugin_versions`  (lines 1292–1317)

```
fn outcome_rendering_uses_marketplace_root_for_single_skill_plugin_versions()
```

**Purpose**: Checks alias-root selection for a plugin version with only one skill root. In that case, the broader marketplace root can be used.

**Data flow**: It creates a plugin-cache-style skill path, builds an alias plan, and checks that the alias table points to the marketplace root and the skill path includes plugin/version pieces.

**Call relations**: This directly tests build_alias_plan and alias_root_for_skill_root behavior.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_uses_skill_root_for_multiple_skills_in_one_plugin_version`  (lines 1320–1355)

```
fn outcome_rendering_uses_skill_root_for_multiple_skills_in_one_plugin_version()
```

**Purpose**: Checks alias-root selection when multiple skills share one plugin-version skill root. The exact skill root is used so paths stay short.

**Data flow**: It creates two skills under the same plugin-version skills directory, builds an alias plan, and checks the alias table and resulting short paths.

**Call relations**: This protects the branch that keeps the skill root when a plugin version has multiple skills under it.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_counts_plugin_version_skills_before_budget_omission`  (lines 1358–1393)

```
fn outcome_rendering_counts_plugin_version_skills_before_budget_omission()
```

**Purpose**: Checks that alias planning counts all skills before the budget later omits any. This keeps alias-root decisions consistent even under tight budgets.

**Data flow**: It creates two skills, builds an alias plan, sets a budget that fits only one aliased minimum line, renders through the aliased path, and checks that the alias table still reflects the shared root.

**Call relations**: This test calls both build_alias_plan and build_aliased_available_skills.

*Call graph*: calls 2 internal fn (build_alias_plan, build_aliased_available_skills); 7 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, format!, vec!).


##### `tests::outcome_rendering_uses_each_skill_root_for_multiple_roots_in_one_plugin_version`  (lines 1396–1438)

```
fn outcome_rendering_uses_each_skill_root_for_multiple_roots_in_one_plugin_version()
```

**Purpose**: Checks that separate skill roots in the same plugin version get separate aliases when needed.

**Data flow**: It creates two skills under different roots within one plugin version, builds an alias plan, and checks that `r0` and `r1` point to the two roots.

**Call relations**: This verifies alias_root_for_skill_root and ordered_alias_roots for multi-root plugin versions.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_extracts_plugin_marketplace_root_for_multiple_plugins`  (lines 1441–1486)

```
fn outcome_rendering_extracts_plugin_marketplace_root_for_multiple_plugins()
```

**Purpose**: Checks that multiple plugins in the same marketplace cache can share one marketplace alias root.

**Data flow**: It creates skills from two plugins under the same marketplace base, builds an alias plan, and checks both aliased paths use the shared `r0` root.

**Call relations**: This exercises plugin_marketplace_base and plugin_version_base through build_alias_plan.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::outcome_rendering_uses_one_marketplace_root_for_multiple_plugin_versions`  (lines 1489–1529)

```
fn outcome_rendering_uses_one_marketplace_root_for_multiple_plugin_versions()
```

**Purpose**: Checks that different versions of a plugin can also share one marketplace alias root when that is the best common base.

**Data flow**: It creates skills in two plugin-version directories, builds an alias plan, and verifies one alias table entry covers both paths.

**Call relations**: This protects the marketplace-root alias behavior for multi-version layouts.

*Call graph*: calls 1 internal fn (build_alias_plan); 6 external calls (assert_eq!, test_path_buf, Characters, outcome_with_roots, skill_with_path, vec!).


##### `tests::skill_with_path`  (lines 1531–1535)

```
fn skill_with_path(name: &str, path: &AbsolutePathBuf) -> SkillMetadata
```

**Purpose**: Creates a test skill and assigns it a caller-provided absolute path. This is useful for alias tests that need realistic directory layouts.

**Data flow**: It receives a name and path, creates a user-scope skill, replaces its `SKILL.md` path, and returns it.

**Call relations**: Plugin and alias tests use this helper to build skills under specific roots.

*Call graph*: 2 external calls (make_skill, clone).


### `core/src/context/available_skills_instructions.rs`

`data_model` · `context building`

Codex can be given “skills”: reusable instructions or capabilities that the model should know about before answering. This file packages those skills into a context fragment, which is a piece of text sent to the model alongside the user’s request. Without this, the available skills might exist inside the program but never be clearly explained to the model.

The main type, `AvailableSkillsInstructions`, stores two groups of text lines. One group describes where skills come from, and the other describes the skills themselves. Think of it like preparing a labeled insert for a binder: the content is the skill list, and the labels tell the rest of the system where the insert begins and ends.

The file also says this fragment should be presented with the `developer` role, meaning it is guidance from the system/developer side rather than ordinary user text. It provides opening and closing marker tags so the context-building code can wrap the skill instructions in recognizable boundaries. Finally, when asked for its body text, it delegates the actual formatting to shared skill-rendering code, keeping this file focused on turning skill data into a context fragment.

#### Function details

##### `AvailableSkillsInstructions::from_skill_lines`  (lines 17–22)

```
fn from_skill_lines(skill_lines: Vec<String>) -> Self
```

**Purpose**: Creates an `AvailableSkillsInstructions` fragment when the caller already has the skill description lines prepared. This is useful when only the catalog of skills needs to be inserted and there are no separate skill-root lines.

**Data flow**: It receives a list of skill text lines. It creates an empty list for skill-root lines, keeps the provided skill lines, and returns a new fragment ready to be rendered into model context.

**Call relations**: The `available_skills_fragment` flow calls this when it has pre-rendered skill lines and needs to wrap them in the standard context-fragment shape. Internally it creates an empty vector so the later body-rendering step sees “no root lines” rather than missing data.

*Call graph*: called by 1 (available_skills_fragment); 1 external calls (new).


##### `AvailableSkillsInstructions::from`  (lines 26–31)

```
fn from(available_skills: AvailableSkills) -> Self
```

**Purpose**: Converts a full `AvailableSkills` value into an `AvailableSkillsInstructions` context fragment. This is the path used when the program already has both the skill locations and the skill descriptions together.

**Data flow**: It receives an `AvailableSkills` object, takes its `skill_root_lines` and `skill_lines`, and stores them inside the fragment. The result is the same information, but in the form expected by the context system.

**Call relations**: The initial context-building flow calls this while preparing the starting instructions for the model. It acts as the handoff point between the skills subsystem, which discovers or prepares skills, and the context subsystem, which sends instructions to the model.

*Call graph*: called by 1 (build_initial_context).


##### `AvailableSkillsInstructions::role`  (lines 35–37)

```
fn role(&self) -> &'static str
```

**Purpose**: Tells the context system that this fragment should be sent under the `developer` role. In plain terms, the skill list is treated as guidance from Codex’s setup, not as something the end user typed.

**Data flow**: It reads no outside data and always returns the fixed text `developer`. Nothing inside the fragment is changed.

**Call relations**: This is used through the `ContextualUserFragment` interface when the context system asks each fragment how it should be labeled before being sent to the model.


##### `AvailableSkillsInstructions::markers`  (lines 39–41)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the opening and closing tags that should wrap this fragment in the model context. These tags make the skill-instruction block easy to identify and separate from nearby text.

**Data flow**: It takes the fragment as input only in the sense that it is a method, but it does not inspect its stored skill lines. It returns the standard marker pair for this fragment type.

**Call relations**: When the context system needs markers for a specific fragment value, this method forwards to the type-level marker function so the marker choice stays defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `AvailableSkillsInstructions::type_markers`  (lines 43–45)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Returns the standard open and close tags for all available-skills instruction fragments. This lets code ask for the markers without needing a particular fragment instance.

**Data flow**: It reads the shared protocol constants for the skills-instructions opening and closing tags, then returns them as a pair. It does not modify anything.

**Call relations**: The instance-level `markers` method calls this to get the canonical tags. Other context code can also rely on this as the single source of truth for how this fragment is marked.


##### `AvailableSkillsInstructions::body`  (lines 47–49)

```
fn body(&self) -> String
```

**Purpose**: Builds the actual text that will appear inside the skills-instructions markers. This is the human-readable list of available skills that the model will see.

**Data flow**: It reads the stored skill-root lines and skill lines from the fragment, passes them to the shared skill-body renderer, and returns the formatted string. The fragment itself is not changed.

**Call relations**: When the context system is assembling the message for the model, it calls this through the `ContextualUserFragment` interface. The method hands formatting off to `render_available_skills_body`, so this file does not duplicate the rules for how skill lists should look.

*Call graph*: 1 external calls (render_available_skills_body).


### `ext/skills/src/render.rs`

`domain_logic` · `prompt construction`

This file is about making skill information useful without letting it take over the whole prompt. A skill is something the system can tell the model is available, such as a file-based tool or a resource provided by another part of the system. The prompt has limited room, so this code acts like a careful editor: it lists only enabled, visible skills, formats each one in a consistent human-readable line, and stops once the list reaches a byte limit.

The main flow starts with a catalog of skills. For each skill that should be shown, the file chooses a short description when one exists, otherwise it falls back to the full description. It then writes a line with the skill name, description, where the skill comes from, and its path or locator. If adding another line would exceed the allowed size, that skill is skipped and counted. At the end, the output includes a note saying how many extra skills were left out, so the reader knows the list was intentionally shortened.

The file also trims main skill prompt contents to a fixed byte limit. It does this safely for UTF-8 text, meaning it will not cut a multi-byte character in half and leave broken text behind. Without this file, prompts could become too large, inconsistently formatted, or even contain invalid clipped text.

#### Function details

##### `available_skills_fragment`  (lines 13–50)

```
fn available_skills_fragment(
    catalog: &SkillCatalog,
) -> Option<AvailableSkillsInstructions>
```

**Purpose**: Builds the prompt section that tells the model which skills are available. It keeps the section within a fixed size limit and returns nothing if there are no visible enabled skills to show.

**Data flow**: It receives a skill catalog. It reads each catalog entry, keeps only skills that are enabled and marked as visible in the prompt, chooses the best description, and asks `render_skill_line` to turn each skill into one bullet line. It adds lines until the byte limit would be exceeded, counts the skipped skills, and finally returns an `AvailableSkillsInstructions` fragment containing the lines, or `None` if no lines were produced.

**Call relations**: This function is called by `contribute` when the skills system is adding its part to the larger prompt. During that work it calls `render_skill_line` for the per-skill wording, uses formatting to add an omission note when needed, and hands the finished list to `from_skill_lines` so it becomes the prompt fragment expected by the rest of the system.

*Call graph*: calls 2 internal fn (from_skill_lines, render_skill_line); called by 1 (contribute); 2 external calls (new, format!).


##### `render_skill_line`  (lines 52–66)

```
fn render_skill_line(entry: &SkillCatalogEntry, description: &str) -> String
```

**Purpose**: Turns one skill catalog entry into a single readable bullet line for the prompt. The line includes the skill name, optional description, the kind of place it came from, and its rendered path.

**Data flow**: It receives one skill entry and the description text to show. It looks at the skill source kind and translates it into plain wording such as `file` or `environment resource`, asks the entry for its display path, and combines those pieces into one string. If the description is empty, it leaves that part out instead of producing awkward blank text.

**Call relations**: This helper is used by `available_skills_fragment` while building the visible skill list. It calls `rendered_path` on the catalog entry to get the path text, then returns the completed line so the caller can decide whether it still fits inside the overall size limit.

*Call graph*: calls 1 internal fn (rendered_path); called by 1 (available_skills_fragment); 1 external calls (format!).


##### `truncate_main_prompt_contents`  (lines 68–70)

```
fn truncate_main_prompt_contents(contents: &str) -> (String, bool)
```

**Purpose**: Trims main skill prompt text to the standard maximum size allowed for this file's prompt content. It exists so callers do not need to remember the exact byte limit.

**Data flow**: It receives prompt text as a string slice. It passes that text and the fixed main-prompt byte limit to `truncate_utf8_to_bytes`. It returns the possibly shortened string plus a true-or-false flag saying whether anything was cut off.

**Call relations**: This function is called by `contribute` when skill prompt contents are being prepared for inclusion. It delegates the actual safe trimming to `truncate_utf8_to_bytes`, acting as the named, policy-specific wrapper for the main prompt size limit.

*Call graph*: calls 1 internal fn (truncate_utf8_to_bytes); called by 1 (contribute).


##### `truncate_utf8_to_bytes`  (lines 72–75)

```
fn truncate_utf8_to_bytes(contents: &str, max_bytes: usize) -> (String, bool)
```

**Purpose**: Safely shortens text to a chosen byte limit without breaking UTF-8 characters. This matters because some characters use more than one byte, and cutting through the middle of one would create invalid text.

**Data flow**: It receives text and a maximum number of bytes. It calls `take_bytes_at_char_boundary`, which finds a safe cut point at or before the limit. It returns the resulting string and a boolean that is true when the returned text is shorter than the original.

**Call relations**: This function is used directly by `contribute` when a caller needs a custom byte limit, and by `truncate_main_prompt_contents` when the standard main-prompt limit should be applied. It relies on the shared string utility `take_bytes_at_char_boundary` for the careful character-boundary cutting.

*Call graph*: called by 2 (contribute, truncate_main_prompt_contents); 1 external calls (take_bytes_at_char_boundary).


### Plugin and app capability prompts
These files define and render prompt guidance for plugins, tools, and app connectors, including explicit plugin mention injection.

### `core/src/apps/render.rs`

`domain_logic` · `prompt/context construction`

This file is a small bridge between raw app information and the text the system may show to the assistant as context. Think of it like a receptionist preparing a short note: if there are useful apps available, it writes the note; if not, it leaves the note out entirely.

The main function, `render_apps_section`, receives a list of `AppInfo` records. Each record describes one app connector, including whether the app is accessible to the user and whether it is enabled. The function asks `AppsInstructions::from_connectors` to turn that list into an `AppsInstructions` value. If no suitable apps exist, that step returns nothing, and this file also returns nothing. If suitable apps do exist, it renders the instructions into a string.

The tests define simple fake app records and check the important boundary: inaccessible or disabled apps should not create an apps section, while an app that is both accessible and enabled should create one. The rendered text is expected to be wrapped in special open and close tags, which help the surrounding system recognize this section reliably.

#### Function details

##### `render_apps_section`  (lines 7–9)

```
fn render_apps_section(connectors: &[AppInfo]) -> Option<String>
```

**Purpose**: Builds the optional “Apps” instruction text from a list of app connector descriptions. It is used when the system is preparing context and needs to tell the assistant which connected apps are available.

**Data flow**: It receives a slice of `AppInfo` values, each describing one app. It passes that list to `AppsInstructions::from_connectors`, which filters and shapes the information into an instruction object when there is something useful to say. If that object exists, it is rendered into a string; otherwise the function returns `None`, meaning no apps section should be included.

**Call relations**: This function delegates the real selection and instruction-building work to `from_connectors`. In the provided call graph, it is exercised by the test `tests::renders_apps_section_with_an_accessible_and_enabled_app`, which checks that a valid connector produces a properly wrapped section.

*Call graph*: calls 1 internal fn (from_connectors); called by 1 (renders_apps_section_with_an_accessible_and_enabled_app).


##### `tests::connector`  (lines 15–31)

```
fn connector(id: &str, is_accessible: bool, is_enabled: bool) -> AppInfo
```

**Purpose**: Creates a simple fake `AppInfo` record for tests. It lets the tests focus on whether an app is accessible and enabled without filling in every optional detail by hand each time.

**Data flow**: It takes an app id plus two yes-or-no values: whether the app is accessible and whether it is enabled. It builds an `AppInfo` with the id copied into the `id` and `name` fields, leaves optional descriptive fields empty, and returns the completed test record.

**Call relations**: The tests call this helper when they need sample connectors. It keeps the test setup short so the actual behavior being checked is easier to see.

*Call graph*: 1 external calls (new).


##### `tests::omits_apps_section_without_accessible_and_enabled_apps`  (lines 34–48)

```
fn omits_apps_section_without_accessible_and_enabled_apps()
```

**Purpose**: Checks that no apps section is produced when there are no usable apps. This protects against showing misleading instructions for apps the user cannot actually use.

**Data flow**: It tries three inputs: an empty list, a connector that is accessible but not enabled, and a connector that is enabled but not accessible. For each case, it expects the rendering result to be `None`, meaning no section is emitted.

**Call relations**: This test uses equality assertions to confirm the omission behavior. It supports the same rule that `render_apps_section` relies on through `AppsInstructions::from_connectors`: an app must be both accessible and enabled to matter.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::renders_apps_section_with_an_accessible_and_enabled_app`  (lines 51–60)

```
fn renders_apps_section_with_an_accessible_and_enabled_app()
```

**Purpose**: Checks that a usable app causes an apps section to be rendered. It also verifies that the section has the expected wrapper tags and heading.

**Data flow**: It creates one fake connector marked as both accessible and enabled, passes it into `render_apps_section`, and unwraps the returned text. It then checks that the text starts with the apps-instructions open tag, contains the “Apps (Connectors)” heading, and ends with the close tag.

**Call relations**: This test is the direct caller of `render_apps_section` in the provided graph. It also uses the test connector helper to create the input record, then uses assertions to confirm the rendered output has the shape the wider system expects.

*Call graph*: calls 1 internal fn (render_apps_section); 2 external calls (assert!, connector).


### `core/src/context/apps_instructions.rs`

`domain_logic` · `context building`

This file is part of the system that builds the context shown to the model. Its job is very focused: if the user has at least one usable app connector, it creates a small instruction block explaining how apps work.

An app connector is an installed app that exposes tools through MCP, which means “Model Context Protocol,” a standard way for the model to call external tools. The instruction text tells the model that apps may be named directly in user messages, like a special link, or may be used when the conversation suggests they are relevant. It also explains that app tools live under the Codex apps MCP server, and that some tools may already be loaded while others can be found through `tool_search`.

The file wraps this text in a `ContextualUserFragment`. In plain terms, that means it is a reusable piece of context with a role, start and end markers, and a body. The markers are like labels around a note, so later code can identify or replace this exact section safely.

Without this file, the model might not know when app connectors exist, how to invoke them, or which discovery calls to avoid.

#### Function details

##### `AppsInstructions::from_connectors`  (lines 12–17)

```
fn from_connectors(connectors: &[AppInfo]) -> Option<Self>
```

**Purpose**: This decides whether the apps instruction block should be included at all. It returns an `AppsInstructions` value only when at least one connector is both accessible and enabled.

**Data flow**: It receives a list of app connector records. It scans the list and checks each connector’s `is_accessible` and `is_enabled` flags. If it finds a connector that passes both checks, it returns `Some(AppsInstructions)`; otherwise it returns `None`, meaning there is no app guidance to add.

**Call relations**: When the system is preparing context, `render_apps_section` and `build_initial_context` call this function to decide whether apps are relevant. This function does the simple gatekeeping step before any app instruction text is rendered.

*Call graph*: called by 2 (render_apps_section, build_initial_context); 1 external calls (iter).


##### `AppsInstructions::role`  (lines 21–23)

```
fn role(&self) -> &'static str
```

**Purpose**: This says that the instruction block should appear as a developer message. A developer message is guidance from the system builder to the model, stronger than ordinary user text but not the top-level system instruction.

**Data flow**: It takes the `AppsInstructions` value and returns the fixed string `developer`. It does not read connector data or change anything.

**Call relations**: This is part of the `ContextualUserFragment` contract. When the context-rendering code treats this value as a fragment, it asks for the role so it knows where the instruction belongs in the conversation context.


##### `AppsInstructions::markers`  (lines 25–27)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: This provides the opening and closing marker strings used to wrap the apps instruction block. The markers make the section easy to identify later.

**Data flow**: It receives the fragment value, then delegates to `type_markers` to get the shared marker pair. It returns those two strings unchanged.

**Call relations**: This is the instance-level marker method required by the fragment interface. It hands off to `type_markers` so the marker values are defined in one place rather than repeated.

*Call graph*: 1 external calls (type_markers).


##### `AppsInstructions::type_markers`  (lines 29–31)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: This returns the exact start and end tags for the apps instruction section. These tags act like clear borders around the generated guidance.

**Data flow**: It takes no runtime data and returns two constant strings: the apps-instructions open tag and close tag. It does not modify anything.

**Call relations**: The `markers` method calls this when a specific fragment instance needs its tags. Other code can also use this static form when it needs to know the marker pair without first creating an `AppsInstructions` value.


##### `AppsInstructions::body`  (lines 33–37)

```
fn body(&self) -> String
```

**Purpose**: This creates the actual text shown to the model about app connectors. It explains how apps can be triggered, where their tools come from, how lazy tool discovery works, and which MCP listing calls should not be used for apps.

**Data flow**: It starts with no external input beyond the known MCP server name constant. It formats a multi-line instruction string that includes that server name, then returns the finished text. It does not change connector state or load tools itself.

**Call relations**: After earlier context-building code has decided that app instructions are needed, the fragment-rendering flow calls this method to get the text to insert. It uses formatting only to place the Codex apps MCP server name into the otherwise fixed guidance.

*Call graph*: 1 external calls (format!).


### `core/src/plugins/render.rs`

`domain_logic` · `prompt/context construction`

Plugins can add extra abilities to the system, but those abilities are only useful if the assistant is told about them clearly. This file builds that human-readable guidance. Think of it like a small sign-maker: it looks at what a plugin offers, then prints a concise notice saying what is available and how to refer to it.

The main function, `render_explicit_plugin_instructions`, starts with the plugin's display name. It then adds lines only for capabilities that actually exist. If the plugin has skills, it explains that those skills use the plugin name as a prefix, such as `plugin_name:...`. If the current session has MCP servers available from the plugin, it lists them. MCP means “Model Context Protocol,” a way for external tools or services to be made available to the assistant. If there are plugin apps available, it lists those too.

If the plugin has no skills, no available MCP servers, and no available apps, the function returns nothing. This avoids cluttering the assistant’s context with empty or useless instructions. In tests, `render_plugins_section` also helps turn a list of plugin summaries into a rendered instruction section.

#### Function details

##### `render_plugins_section`  (lines 8–10)

```
fn render_plugins_section(plugins: &[PluginCapabilitySummary]) -> Option<String>
```

**Purpose**: This test-only helper turns a list of plugin capability summaries into a rendered block of plugin instructions. It exists so tests can check what the final plugin section would look like.

**Data flow**: It receives a list of plugin summaries. It asks `AvailablePluginsInstructions::from_plugins` to build an instruction object from that list; if one is produced, it renders that object into text. The result is either a finished instruction string or nothing if there is nothing useful to say.

**Call relations**: During tests, this function provides a simple path from raw plugin summaries to the final text that would be shown. It hands the summaries to `from_plugins`, then calls the returned instruction object’s render step so the tests can inspect the final wording.

*Call graph*: calls 1 internal fn (from_plugins).


##### `render_explicit_plugin_instructions`  (lines 12–58)

```
fn render_explicit_plugin_instructions(
    plugin: &PluginCapabilitySummary,
    available_mcp_servers: &[String],
    available_apps: &[String],
) -> Option<String>
```

**Purpose**: This function writes a short instruction block for one specific plugin, but only if that plugin has useful capabilities in the current session. It tells the assistant what plugin-linked skills, MCP servers, or apps it can use.

**Data flow**: It receives one plugin summary, plus lists of MCP server names and app names available now. It builds text line by line: first the plugin name, then optional lines for skills, MCP servers, and apps. If no optional capability lines were added, it returns nothing; otherwise it adds a final reminder to use these capabilities and returns the full text joined with newlines.

**Call relations**: This is the file’s main rendering helper for explicit per-plugin instructions. Higher-level prompt-building code can call it when preparing the assistant’s context, and it produces the exact text that explains what this plugin contributes for the current task.

*Call graph*: 2 external calls (format!, vec!).


### `core/src/context/available_plugins_instructions.rs`

`domain_logic` · `context construction before a model turn`

This file is part of the context-building system: the code that prepares background instructions before the model answers a user. Its job is to add a clear “Plugins” section when plugins are available.

A plugin here means a local bundle that can contribute skills, MCP servers, or apps. MCP, or Model Context Protocol, is a standard way for tools to be exposed to the model. The important point is that the model does not “call a plugin” directly. Instead, it uses the concrete abilities the plugin contributes, such as a named skill or a tool.

The main type, AvailablePluginsInstructions, stores the available plugin summaries, but this file uses their presence mainly as a yes-or-no signal. If there are no plugins, it creates nothing. If there is at least one, it produces a developer-role context fragment wrapped in special plugin-instruction markers. Those markers let the surrounding context system recognize and replace or separate this section reliably, like putting a labeled divider around a page in a binder.

The generated text explains naming rules, when to prefer plugin-related capabilities, and what to do if a requested plugin has no useful callable tools. Without this file, the model could see plugin-related tools but lack the project’s guidance about how to interpret and prioritize them.

#### Function details

##### `AvailablePluginsInstructions::from_plugins`  (lines 13–21)

```
fn from_plugins(plugins: &[PluginCapabilitySummary]) -> Option<Self>
```

**Purpose**: Builds an AvailablePluginsInstructions fragment only when there is at least one plugin. This prevents the system from adding a plugins instruction section when plugins are not relevant.

**Data flow**: It receives a slice of plugin capability summaries. If that list is empty, it returns nothing. If the list has entries, it copies those summaries into a new AvailablePluginsInstructions value and returns it wrapped as present.

**Call relations**: During context setup, render_plugins_section and build_initial_context call this function when they know what plugins are available. This function decides whether the plugin instruction fragment should join the context at all.

*Call graph*: called by 2 (render_plugins_section, build_initial_context); 2 external calls (is_empty, to_vec).


##### `AvailablePluginsInstructions::role`  (lines 25–27)

```
fn role(&self) -> &'static str
```

**Purpose**: Says that this fragment should be presented as a developer instruction. That means it is guidance about how the assistant should behave, not a normal user request.

**Data flow**: It reads no outside data and always returns the fixed text value "developer". Nothing else is changed.

**Call relations**: After an AvailablePluginsInstructions fragment exists, the context-rendering system can ask it what role to use. This answer lets the surrounding message builder place the plugin guidance in the correct kind of message.


##### `AvailablePluginsInstructions::markers`  (lines 29–31)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the opening and closing marker strings used to wrap this plugin instruction block. These markers make the block easy for the larger context system to identify.

**Data flow**: It takes the fragment itself, does not inspect the stored plugins, and asks the type-level marker function for the marker pair. It returns the opening marker and closing marker unchanged.

**Call relations**: When the context system is rendering this fragment, it can call this method through the ContextualUserFragment behavior. This method hands off to AvailablePluginsInstructions::type_markers so there is one shared source for the marker strings.

*Call graph*: 1 external calls (type_markers).


##### `AvailablePluginsInstructions::type_markers`  (lines 33–38)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Returns the fixed tags that mark the start and end of the plugins instruction section. This is useful even when code needs the markers without having a fragment instance in hand.

**Data flow**: It reads two protocol constants: the plugin-instructions open tag and close tag. It returns them as a pair and changes nothing.

**Call relations**: AvailablePluginsInstructions::markers calls this function to get the actual marker strings. The constants come from the protocol layer, so this fragment uses the same tags as the rest of the system.


##### `AvailablePluginsInstructions::body`  (lines 40–58)

```
fn body(&self) -> String
```

**Purpose**: Creates the human-readable plugin guidance that will be shown to the model. It explains how plugin-related skills and tools should be recognized, preferred, and used.

**Data flow**: It starts with a small list of lines: a heading, a plain explanation of what a plugin is, a usage heading, and a multi-line rules section. It joins those lines with newlines, adds a blank line before and after, and returns the final string. It does not change the stored plugin list.

**Call relations**: Once the context system has accepted this fragment, it calls this method to get the actual text to insert into the model context. The text then works together with the role and markers methods: role says how to present it, markers identify its boundaries, and body supplies the content inside.

*Call graph*: 2 external calls (format!, vec!).


### `core/src/plugins/injection.rs`

`domain_logic` · `request handling / prompt construction`

When a user names a plugin, the system needs to give the model a small, private note about what that plugin can do in this particular session. This file builds those notes. Without it, the model might know that a plugin was mentioned but not know which tool servers or app connections are visible and enabled for that plugin.

The main idea is like preparing a briefing card before a meeting. For each mentioned plugin, the code looks through the available tool list and finds tool servers connected to that plugin. It deliberately skips the general Codex apps server, because this step is about plugin-specific tool servers. It also looks through available app connectors, but only keeps apps that are enabled and tied to the same plugin.

Both lists are sorted and deduplicated before being used. That means the final instructions are stable and clean, even if the same server or app appears more than once. Then another plugin helper writes the actual instruction text. If there is useful instruction text, it is wrapped as a contextual user fragment and returned as a response item that can be injected into the conversation context.

#### Function details

##### `build_plugin_injections`  (lines 14–59)

```
fn build_plugin_injections(
    mentioned_plugins: &[PluginCapabilitySummary],
    mcp_tools: &[ToolInfo],
    available_connectors: &[connectors::AppInfo],
) -> Vec<ResponseItem>
```

**Purpose**: Builds hidden context messages for plugins the user has explicitly mentioned. Each message tells the model which matching tool servers and enabled app connectors are available for that plugin.

**Data flow**: It receives three lists: mentioned plugins, available MCP tools, and available app connectors. If no plugins were mentioned, it returns an empty list immediately. Otherwise, for each plugin it scans the tools and connectors, keeps only the ones tied to that plugin, sorts and removes duplicates, asks another helper to turn that information into instruction text, wraps that text into a context fragment, and returns all resulting response items.

**Call relations**: This function is used when the system is assembling extra context for the model after seeing explicit plugin mentions. It first checks whether there is any work to do, then iterates through the mentioned plugins, and for each useful instruction it creates a plugin-instruction wrapper before handing the finished response items back to the prompt-building flow.

*Call graph*: 3 external calls (new, is_empty, iter).


### `tools/src/code_mode.rs`

`domain_logic` · `tool registration and prompt/tool setup`

Code mode appears to be a mode where tools are exposed in a more structured, programming-friendly way. This file takes the project’s existing tool definitions and turns them into code-mode tool definitions. Think of it like preparing a menu for a different dining room: the dishes are mostly the same, but the names, descriptions, and formatting need to match that room’s rules.

The file works with several kinds of tools. A plain function tool has a name, a description, input rules, and sometimes output rules. A freeform tool has a name and description but no formal input shape. A namespace is a group of tools under a shared name, so this file gives each nested tool a combined code-mode name, such as joining a namespace and tool name with a separator.

It also asks the `codex_code_mode` library to improve descriptions with code-mode-specific examples. That matters because the model or runtime using these tools needs descriptions that explain how to call them correctly in code mode, not just in the normal tool system.

Unsupported tool kinds, such as image generation or web search, are deliberately ignored here. The file also sorts and removes duplicate code-mode tool definitions so the final list is stable and unambiguous.

#### Function details

##### `augment_tool_spec_for_code_mode`  (lines 8–51)

```
fn augment_tool_spec_for_code_mode(spec: ToolSpec) -> ToolSpec
```

**Purpose**: Adds code-mode-specific guidance to a tool’s description when the tool can be represented in code mode. Someone would use this when they already have a normal tool definition but want its description to include examples or wording that make sense for code-mode execution.

**Data flow**: A `ToolSpec` goes in. If it is a function or freeform tool, the function tries to build a code-mode version of it and replace the original description with the augmented one. If it is a namespace, it walks through each nested function tool, builds a namespaced code-mode definition for it, and replaces that nested tool’s description. Unsupported tool kinds pass through unchanged. The result is a `ToolSpec` with the same basic shape as before, but with descriptions rewritten where possible.

**Call relations**: This is a public entry point for callers that want to keep using `ToolSpec` values while making them friendlier for code mode. For simple tools it relies on `augmented_description_for_spec`, which in turn builds a code-mode definition. For namespaced tools it constructs the namespaced tool name directly, using `code_mode_name_for_tool_name`, then hands the definition to the external code-mode augmenter.

*Call graph*: calls 3 internal fn (namespaced, augmented_description_for_spec, code_mode_name_for_tool_name); 5 external calls (augment_tool_definition, to_value, Freeform, Function, Namespace).


##### `tool_spec_to_code_mode_tool_definition`  (lines 55–59)

```
fn tool_spec_to_code_mode_tool_definition(spec: &ToolSpec) -> Option<CodeModeToolDefinition>
```

**Purpose**: Converts one supported tool specification into one code-mode tool definition, but only if that tool is valid as a nested code-mode tool. This is useful when a caller needs the runtime form of a single tool rather than an edited original `ToolSpec`.

**Data flow**: A borrowed `ToolSpec` goes in. The function first tries to turn it into a `CodeModeToolDefinition`. If no definition can be made, or if the code-mode library says the name is not allowed for nested code-mode use, it returns nothing. Otherwise it returns the definition after the code-mode library has augmented its description.

**Call relations**: This function calls on `code_mode_tool_definition_for_spec` to do the basic conversion work. It then asks the external `is_code_mode_nested_tool` check whether the converted tool belongs in code mode, and only then hands it off to the external description augmenter.

*Call graph*: calls 1 internal fn (code_mode_tool_definition_for_spec); 1 external calls (is_code_mode_nested_tool).


##### `collect_code_mode_tool_definitions`  (lines 61–85)

```
fn collect_code_mode_tool_definitions(
    specs: impl IntoIterator<Item = &'a ToolSpec>,
) -> Vec<CodeModeToolDefinition>
```

**Purpose**: Builds the final list of code-mode tool definitions from many tool specs, including code-mode-enhanced descriptions. It is for the setup step where the system needs a clean, sorted, duplicate-free list of tools to expose in code mode.

**Data flow**: An iterable collection of tool specs goes in. Each spec is expanded into zero or more code-mode definitions. If a namespace has its own description, that text is prepended to each tool inside it so the nested tool carries the group context. The function keeps only definitions accepted by code mode, augments their descriptions, sorts them by name, removes duplicate names, and returns the resulting vector.

**Call relations**: This function is a collector used when preparing the code-mode tool list. It repeatedly relies on the lower-level conversion path for each spec, then uses the external code-mode checks and augmentation rules before returning a stable list for later use.

*Call graph*: 1 external calls (into_iter).


##### `collect_code_mode_exec_prompt_tool_definitions`  (lines 87–98)

```
fn collect_code_mode_exec_prompt_tool_definitions(
    specs: impl IntoIterator<Item = &'a ToolSpec>,
) -> Vec<CodeModeToolDefinition>
```

**Purpose**: Builds a sorted, duplicate-free list of code-mode tool definitions for an execution prompt, without adding the extra augmented descriptions. This gives the prompt-building side a cleaner or more raw version of the code-mode tool list.

**Data flow**: An iterable collection of tool specs goes in. Each spec is converted into zero or more code-mode definitions. The function keeps only definitions whose names are accepted for nested code-mode use, sorts them, removes duplicate names, and returns the list. Unlike `collect_code_mode_tool_definitions`, it does not add the code-mode sample text to descriptions.

**Call relations**: This sits beside `collect_code_mode_tool_definitions` as a second collection path. It uses the same basic conversion idea, but stops before the external augmentation step because execution-prompt use appears to need the unaugmented definitions.

*Call graph*: 1 external calls (into_iter).


##### `augmented_description_for_spec`  (lines 100–104)

```
fn augmented_description_for_spec(spec: &ToolSpec) -> Option<String>
```

**Purpose**: Extracts just the code-mode-augmented description for a single tool spec. It is a small helper for cases where the caller wants to keep the original tool object but replace its description.

**Data flow**: A borrowed `ToolSpec` goes in. The function tries to convert it into a code-mode definition. If that succeeds, it asks the code-mode library to augment the definition, then pulls out and returns the new description text. If conversion fails, it returns nothing.

**Call relations**: This helper is called by `augment_tool_spec_for_code_mode` for plain function and freeform tools. It delegates the actual conversion to `code_mode_tool_definition_for_spec`, then relies on the external code-mode augmenter to produce the final description.

*Call graph*: calls 1 internal fn (code_mode_tool_definition_for_spec); called by 1 (augment_tool_spec_for_code_mode).


##### `code_mode_tool_definition_for_spec`  (lines 106–108)

```
fn code_mode_tool_definition_for_spec(spec: &ToolSpec) -> Option<CodeModeToolDefinition>
```

**Purpose**: Returns the first code-mode definition that can be made from a tool spec. It is a convenience helper for places that expect a single tool rather than a group.

**Data flow**: A borrowed `ToolSpec` goes in. The function expands it into a list of code-mode definitions, then takes the first one if any exist. A single definition or nothing comes out.

**Call relations**: This helper is used by `augmented_description_for_spec` and `tool_spec_to_code_mode_tool_definition`. It relies on `code_mode_tool_definitions_for_spec`, which does the real work of understanding each kind of `ToolSpec`.

*Call graph*: calls 1 internal fn (code_mode_tool_definitions_for_spec); called by 2 (augmented_description_for_spec, tool_spec_to_code_mode_tool_definition).


##### `code_mode_tool_definitions_for_spec`  (lines 110–155)

```
fn code_mode_tool_definitions_for_spec(spec: &ToolSpec) -> Vec<CodeModeToolDefinition>
```

**Purpose**: Turns one general tool specification into the code-mode definition or definitions that correspond to it. This is the main translator in the file.

**Data flow**: A borrowed `ToolSpec` goes in. For a function tool, it creates one code-mode function definition with the tool’s name, description, input schema, and output schema. For a freeform tool, it creates one freeform definition without formal schemas. For a namespace, it creates one definition per nested function tool and gives each one a combined namespace-plus-tool name. For unsupported tool kinds, it returns an empty list. The result is a vector of code-mode definitions.

**Call relations**: Most other functions in this file depend on this conversion step, either directly or through `code_mode_tool_definition_for_spec`. It is the shared place where normal project tool shapes become the code-mode runtime shape.

*Call graph*: called by 1 (code_mode_tool_definition_for_spec); 2 external calls (new, vec!).


##### `code_mode_name_for_tool_name`  (lines 157–165)

```
fn code_mode_name_for_tool_name(tool_name: &ToolName) -> String
```

**Purpose**: Creates the string name that code mode should use for a possibly namespaced tool. It keeps tool names predictable and avoids confusing joins between a namespace and the tool name.

**Data flow**: A `ToolName` goes in, containing a plain tool name and possibly a namespace. If there is no namespace, the plain name comes out unchanged. If there is a namespace, the function usually joins the namespace and name with a double underscore. But if the namespace already ends with an underscore, or the tool name starts with one, it joins them directly to avoid adding an extra separator.

**Call relations**: This helper is used by `augment_tool_spec_for_code_mode` when rewriting descriptions for tools inside a namespace. The same naming rule is also used by the conversion logic for namespaced tools, so code-mode names stay consistent.

*Call graph*: called by 1 (augment_tool_spec_for_code_mode); 1 external calls (format!).


### `ext/extension-api/examples/enabled_extensions/shared_state_extension.rs`

`domain_logic` · `startup registration and prompt-building time`

This file is a small teaching example for the extension API. Its job is to show that prompt contributors do not have to be stateless. They can remember information in an ExtensionData store, which is like a labeled storage drawer provided by the host.

The install function registers two contributors with the extension registry. Later, when the host is building the prompt, it asks each contributor for extra prompt fragments. StyleContributor adds a developer instruction about giving short answers. UsageContributor adds a developer capability note saying the extension can contribute more than one fragment.

Before returning their prompt fragments, both contributors update counters in two places: the session store and the thread store. The session store records totals for the broader session. The thread store records totals for the current conversation thread. This is useful when an extension needs memory at different scopes.

The counts are stored in ContributionCounts. Its numbers are AtomicU64 values, meaning they can be safely increased or read even if more than one task touches them at the same time. The file also provides small public helper functions to read the recorded style and usage counts, returning zero if the store has never seen any counts yet.

#### Function details

##### `install`  (lines 11–14)

```
fn install(registry: &mut ExtensionRegistryBuilder<()>)
```

**Purpose**: Registers this example extension's two prompt contributors with the host. Someone uses this during setup so the host knows which pieces of extension logic to ask for prompt additions later.

**Data flow**: It receives a mutable extension registry builder. It wraps the style and usage contributor objects in shared pointers, then adds them to the registry. Nothing is returned; the registry is changed so it now includes these contributors.

**Call relations**: The example host calls this during startup from main. After install has added the contributors, the registry can later call the contributors when it is assembling prompt context.

*Call graph*: calls 1 internal fn (prompt_contributor); called by 1 (main); 1 external calls (new).


##### `StyleContributor::contribute`  (lines 20–33)

```
fn contribute(
        &'a self,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> + S
```

**Purpose**: Adds a style instruction to the prompt and records that this style contribution happened. The instruction tells the model to prefer short answers unless the user asks for detail.

**Data flow**: It receives access to a session-wide store and a thread-specific store. It gets or creates the shared ContributionCounts object in each store, increments the style count in both, then returns a list containing one prompt fragment.

**Call relations**: The host calls this through the ContextContributor interface when it is gathering prompt context. This function relies on contribution_counts to find the right counter storage, then hands back a PromptFragment for the host to include in the prompt.

*Call graph*: calls 1 internal fn (contribution_counts); 2 external calls (pin, vec!).


##### `UsageContributor::contribute`  (lines 40–53)

```
fn contribute(
        &'a self,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> + S
```

**Purpose**: Adds a capability note to the prompt and records that this usage contribution happened. It demonstrates that one extension can provide more than one kind of prompt fragment.

**Data flow**: It receives the session store and thread store. It gets or creates ContributionCounts in both places, increments the usage count in both, then returns a list containing one developer capability prompt fragment.

**Call relations**: The host calls this through the ContextContributor interface while building prompt context. Like the style contributor, it uses contribution_counts to share its counter object with later reads.

*Call graph*: calls 1 internal fn (contribution_counts); 2 external calls (pin, vec!).


##### `recorded_style_contributions`  (lines 57–62)

```
fn recorded_style_contributions(store: &ExtensionData) -> u64
```

**Purpose**: Reads how many style contributions have been recorded in a given extension data store. It is useful for checking or displaying the count for either a session store or a thread store.

**Data flow**: It receives an ExtensionData store. It looks for an existing ContributionCounts value inside that store. If it finds one, it reads the style counter; if not, it returns zero.

**Call relations**: This is a public read helper for code outside this file, such as the example host or tests. It reads the same stored counter object that StyleContributor::contribute updates.


##### `recorded_usage_contributions`  (lines 65–70)

```
fn recorded_usage_contributions(store: &ExtensionData) -> u64
```

**Purpose**: Reads how many usage contributions have been recorded in a given extension data store. It gives callers a safe zero value when no count has been created yet.

**Data flow**: It receives an ExtensionData store. It checks whether ContributionCounts exists in that store, reads the usage counter if present, and otherwise returns zero.

**Call relations**: This is a public read helper for code outside this file. It observes the counter that UsageContributor::contribute updates when prompt context is built.


##### `ContributionCounts::record_style`  (lines 79–81)

```
fn record_style(&self)
```

**Purpose**: Increases the stored style contribution count by one. It is the small, focused operation used whenever the style contributor runs.

**Data flow**: It receives a ContributionCounts object by reference. It atomically adds one to the style counter, changing the stored count and returning no value.

**Call relations**: StyleContributor::contribute calls this after retrieving the counter storage. The atomic add makes the increment safe even if multiple prompt-building tasks touch the same count.

*Call graph*: 1 external calls (fetch_add).


##### `ContributionCounts::record_usage`  (lines 83–85)

```
fn record_usage(&self)
```

**Purpose**: Increases the stored usage contribution count by one. It is used whenever the usage contributor adds its prompt fragment.

**Data flow**: It receives a ContributionCounts object by reference. It atomically adds one to the usage counter, changing the stored count and returning no value.

**Call relations**: UsageContributor::contribute calls this after getting the shared counter storage. It is the write side of the usage-count tracking that recorded_usage_contributions later reads.

*Call graph*: 1 external calls (fetch_add).


##### `ContributionCounts::style`  (lines 87–89)

```
fn style(&self) -> u64
```

**Purpose**: Returns the current number of style contributions. It gives callers a simple number instead of exposing the atomic counter directly.

**Data flow**: It receives a ContributionCounts object by reference. It atomically reads the style counter and returns that number.

**Call relations**: recorded_style_contributions uses this when it finds a ContributionCounts object in a store. This function is the read side paired with record_style.

*Call graph*: 1 external calls (load).


##### `ContributionCounts::usage`  (lines 91–93)

```
fn usage(&self) -> u64
```

**Purpose**: Returns the current number of usage contributions. It hides the low-level counter details behind a plain numeric result.

**Data flow**: It receives a ContributionCounts object by reference. It atomically reads the usage counter and returns that number.

**Call relations**: recorded_usage_contributions uses this when it finds a ContributionCounts object in a store. This function is the read side paired with record_usage.

*Call graph*: 1 external calls (load).


##### `contribution_counts`  (lines 96–98)

```
fn contribution_counts(store: &ExtensionData) -> Arc<ContributionCounts>
```

**Purpose**: Finds the shared ContributionCounts object in an extension data store, creating it if this is the first time it is needed. It is the common doorway to the counters.

**Data flow**: It receives an ExtensionData store. It asks the store for a ContributionCounts value; if none exists yet, it creates a default one with both counters at zero. It returns a shared pointer to that counter object.

**Call relations**: Both StyleContributor::contribute and UsageContributor::contribute call this before recording their counts. By using one helper, both contributors store their counts in the same expected place and do not duplicate setup logic.

*Call graph*: called by 2 (contribute, contribute).


### Memories and goal steering
This group wires memory-backed prompt contributions into the extension system and adds goal-oriented steering and memory-writing prompt templates.

### `ext/memories/src/extension.rs`

`orchestration` · `startup, thread start, config changes, prompt building, tool discovery`

The memories feature lets Codex read saved user or project memory when it is useful. This file is the connector between that feature and the wider extension system. Think of it like a receptionist: when a new conversation thread starts, it writes down whether memories are allowed; when the configuration changes, it updates that note; when Codex asks for prompt text or tools, it checks the note before offering anything.

The file defines `MemoriesExtension`, the extension object registered with Codex, and `MemoriesExtensionConfig`, the small per-thread snapshot of memory settings. The important safety behavior is that memory support is opt-in through configuration and feature flags. If the memory feature is disabled, or the user has turned off memories, this extension returns nothing.

When enabled, the extension can add developer instructions to the prompt. These instructions tell the model how to use memory safely and correctly. If “dedicated tools” are also enabled, it exposes memory-specific tools backed by local files under the Codex home directory. It can also pass along a metrics client, which is used elsewhere to record tool activity.

#### Function details

##### `MemoriesExtension::new`  (lines 28–30)

```
fn new(metrics_client: Option<MetricsClient>) -> Self
```

**Purpose**: Creates a memories extension object and stores an optional metrics client inside it. The metrics client is later passed to memory tools so their activity can be recorded.

**Data flow**: It receives an optional `MetricsClient`. It puts that value into a new `MemoriesExtension`. The result is an extension ready to be registered with Codex.

**Call relations**: The `install` function calls this when setting up the extension. After that, the same extension object is shared with the registry as a thread lifecycle contributor, configuration contributor, prompt contributor, and tool contributor.

*Call graph*: called by 1 (install).


##### `MemoriesExtensionConfig::from_config`  (lines 41–47)

```
fn from_config(config: &Config) -> Self
```

**Purpose**: Turns the full Codex configuration into the small set of memory settings this extension needs. This keeps later checks simple and tied to the current thread.

**Data flow**: It reads the full `Config`. It checks whether the memory tool feature flag is enabled, whether memories are turned on, whether dedicated memory tools are requested, and where the Codex home directory is. It returns a `MemoriesExtensionConfig` containing those values.

**Call relations**: This is called when a thread starts and when configuration changes. Those callers store the resulting snapshot in the thread’s extension data, where prompt and tool contribution code can read it later.

*Call graph*: called by 2 (on_config_changed, on_thread_start).


##### `MemoriesExtension::contribute`  (lines 51–70)

```
fn contribute(
        &'a self,
        _session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> +
```

**Purpose**: Adds memory-related developer instructions to the prompt, but only when memories are enabled for this thread. These instructions guide the model on how it should use the memory feature.

**Data flow**: It receives session data and thread data, then reads `MemoriesExtensionConfig` from the thread data. If no config is present, or memories are disabled, it returns an empty list. If enabled, it builds memory-tool developer instructions using the Codex home path, wraps the text as a developer-policy prompt fragment, and returns it.

**Call relations**: The extension registry calls this during prompt construction. It relies on `on_thread_start` or `on_config_changed` having already stored the memory configuration. It hands off to `build_memory_tool_developer_instructions` to create the actual text that will be inserted into the prompt.

*Call graph*: calls 1 internal fn (build_memory_tool_developer_instructions); 2 external calls (pin, new).


##### `MemoriesExtension::on_thread_start`  (lines 74–83)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: Initializes memory settings for a newly started conversation thread. Without this, later prompt and tool checks would not know whether memories are enabled.

**Data flow**: It receives thread-start input, including the current `Config` and the thread’s extension data store. It converts the full config into `MemoriesExtensionConfig` and inserts that snapshot into the thread store. It does not return a meaningful value.

**Call relations**: The extension registry calls this when a new thread begins. It calls `MemoriesExtensionConfig::from_config` to make the snapshot that `contribute` and `tools` will read later.

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

**Purpose**: Refreshes the stored memory settings when the Codex configuration changes. This lets the memory extension react if a user turns memories or dedicated tools on or off.

**Data flow**: It receives the previous and new configuration, plus the extension data stores. It ignores the previous config, reads the new one, creates a fresh `MemoriesExtensionConfig`, and stores it in the thread data. The thread store is changed in place.

**Call relations**: The extension registry calls this after a configuration update. Like thread startup, it uses `MemoriesExtensionConfig::from_config`, so later calls to `contribute` and `tools` see the latest memory settings.

*Call graph*: calls 2 internal fn (insert, from_config).


##### `MemoriesExtension::tools`  (lines 99–115)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>>
```

**Purpose**: Offers memory-specific tools to Codex when both memories and dedicated memory tools are enabled. If either setting is off, it deliberately offers no tools.

**Data flow**: It reads `MemoriesExtensionConfig` from the thread store. If there is no config, or if memories are disabled, or if dedicated tools are disabled, it returns an empty list. Otherwise it creates a local memories backend rooted at the Codex home directory, combines it with the optional metrics client, and returns the memory tool executors.

**Call relations**: The extension registry calls this when collecting available tools. It depends on configuration saved by `on_thread_start` or `on_config_changed`. It hands the real tool creation to `tools::memory_tools`, using `LocalMemoriesBackend::from_codex_home` to point those tools at the local memory storage.

*Call graph*: calls 2 internal fn (from_codex_home, memory_tools); 1 external calls (new).


##### `install`  (lines 119–128)

```
fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    metrics_client: Option<MetricsClient>,
)
```

**Purpose**: Registers the memories extension with the Codex extension registry. This is what makes the extension participate in thread startup, configuration updates, prompt building, and tool discovery.

**Data flow**: It receives a mutable extension registry and an optional metrics client. It creates one shared `MemoriesExtension`, then registers clones of it for the extension roles it supports. The registry is updated so Codex will call this extension at the right times.

**Call relations**: This is the setup entry for this file. It calls `MemoriesExtension::new`, then hands the extension to the registry through `thread_lifecycle_contributor`, `config_contributor`, `prompt_contributor`, and `tool_contributor`.

*Call graph*: calls 5 internal fn (config_contributor, prompt_contributor, thread_lifecycle_contributor, tool_contributor, new); 1 external calls (new).


### `ext/memories/src/prompts.rs`

`domain_logic` · `instruction building`

This file is the bridge between stored memories and the instructions given to the assistant. The memories feature keeps a summary file under the user’s Codex home directory. When that file exists and has useful content, this code turns it into a developer instruction prompt, so the assistant can take those memories into account.

The file uses an embedded Markdown template, which is like a form letter with blank spaces. At startup, the template is parsed once and kept in a LazyLock, meaning it is only prepared the first time it is needed. If the built-in template is broken, the program stops immediately, because that would be a packaging or developer error rather than something a user can fix.

The main async function looks for `memories/memory_summary.md` inside the Codex home folder. If the file is missing or cannot be read, it quietly returns nothing. If the file is present, it trims extra whitespace, shortens very large summaries to a token limit, and skips empty summaries. Finally, it fills the template with the memories folder path and the summary text. Without this file, saved memories would remain on disk but would not be turned into instructions the assistant can actually use.

#### Function details

##### `parse_embedded_template`  (lines 16–21)

```
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template
```

**Purpose**: This function turns a built-in template string into a reusable Template object. It exists so invalid packaged templates fail loudly and clearly instead of causing confusing behavior later.

**Data flow**: It receives the template text and a human-readable template name. It asks the template library to parse the text. If parsing succeeds, it returns the parsed template; if parsing fails, it stops the program with an error message naming the bad embedded template.

**Call relations**: This is used when the static memory prompt template is first created. It hands the raw Markdown template text to `Template::parse`; if that parsing reports an error, it calls `panic!` because an embedded template should have been validated by the project before release.

*Call graph*: calls 1 internal fn (parse); 1 external calls (panic!).


##### `build_memory_tool_developer_instructions`  (lines 27–51)

```
async fn build_memory_tool_developer_instructions(
    codex_home: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: This function creates the developer-instruction text that introduces stored memories to the assistant. Someone would use it when preparing the full instruction set for a run, so the assistant can see a concise memory summary if one exists.

**Data flow**: It receives the absolute path to the Codex home directory. From there, it builds the path to `memories/memory_summary.md`, reads that file as text, trims it, and shortens it to the configured token limit if it is too large. If the file cannot be read or the resulting summary is empty, it returns no text. Otherwise, it fills the embedded template with the memories directory path and the summary, then returns the finished prompt.

**Call relations**: This function is called by `contribute` when memory-related instructions are being added to the larger developer instruction set. During that work it builds paths with `join`, reads the summary file with Tokio’s async `read_to_string`, applies `truncate_text` using a token-based limit, and finally renders the prepared template so the caller receives ready-to-include instruction text.

*Call graph*: calls 1 internal fn (join); called by 1 (contribute); 3 external calls (truncate_text, read_to_string, Tokens).


### `memories/write/src/prompts.rs`

`domain_logic` · `memory prompt preparation`

This file is like the prompt-preparation desk for the memory-writing system. The rest of the system has raw ingredients: a memory folder, a rollout file, the current working directory, optional extension files, and the model’s input size limit. This file combines those ingredients into clear instructions for the model.

It keeps several prompt templates loaded lazily, meaning each template is parsed only the first time it is needed. If an embedded template is broken, the program stops early, because a bad built-in prompt would make the memory workflow unreliable.

For the consolidation phase, it builds a prompt that tells a subagent how to merge or update memories under a specific memory root. If a memory extensions folder exists, it adds extra prompt blocks describing that folder and its primary inputs. If rendering fails, it logs a warning and falls back to a short but usable prompt instead of returning nothing.

For stage one, it builds a user message containing rollout metadata and rollout content. Since rollouts can be very large, it trims the content to fit a safe part of the model’s available input window. It keeps both the beginning and end context, which helps preserve the setup and the latest outcome.

#### Function details

##### `parse_embedded_template`  (lines 35–40)

```
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template
```

**Purpose**: This function turns built-in template text into a reusable Template object. It exists so invalid bundled prompt files are caught immediately and loudly instead of causing confusing model behavior later.

**Data flow**: It receives the template text and a human-readable template name. It asks the template library to parse the text. If parsing works, it returns the parsed template; if parsing fails, it stops the program with an error message naming the broken embedded template.

**Call relations**: The file’s lazily loaded prompt templates rely on this helper when they are first used. It hands valid Template objects to later prompt-building functions, so those functions can focus on filling in values rather than checking whether the built-in prompt format is sound.

*Call graph*: calls 1 internal fn (parse); 1 external calls (panic!).


##### `build_consolidation_prompt`  (lines 43–87)

```
fn build_consolidation_prompt(memory_root: &Path) -> String
```

**Purpose**: This function builds the full prompt for the memory consolidation phase. Someone uses it when they need to tell a model where the memories live, what workspace diff file to read, and whether extra memory-extension instructions should be included.

**Data flow**: It receives a path to the memory root. From that, it finds the related memory extensions folder and checks whether that folder exists. It converts the relevant paths into readable strings, prepares optional extension sections when needed, and renders the main consolidation template. The output is a complete prompt string; if rendering fails, it logs a warning and returns a simpler fallback prompt.

**Call relations**: This is the main consolidation prompt builder in the file. When extension instructions are available, it calls render_memory_extensions_block to fill in those smaller template sections, then inserts their text into the larger consolidation template.

*Call graph*: calls 1 internal fn (render_memory_extensions_block); 4 external calls (as_str, display, new, memory_extensions_root).


##### `render_memory_extensions_block`  (lines 89–96)

```
fn render_memory_extensions_block(template: &Template, memory_extensions_root: &str) -> String
```

**Purpose**: This function fills in one optional memory-extension prompt block. It is used to add extra instructions about the memory extensions folder without duplicating the same rendering and fallback logic in the main prompt builder.

**Data flow**: It receives a Template and the memory extensions root path as text. It renders the template with that path. If rendering succeeds, it returns the filled-in block; if rendering fails, it logs a warning and returns an empty string so the overall prompt can still be built.

**Call relations**: build_consolidation_prompt calls this helper when it detects that memory extensions exist. The helper produces the optional pieces that are then folded into the final consolidation prompt.

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

**Purpose**: This function builds the stage-one user message that contains rollout information and content. It protects the model from being given too much text by trimming the rollout to a safe size based on the active model’s context window, which is the amount of text the model can read at once.

**Data flow**: It receives model information, the rollout file path, the rollout working directory, and the rollout text. It calculates a token limit from the model’s available context window, using a default if the model does not provide a usable limit. It truncates the rollout content to that budget, converts the paths to readable strings, and renders the stage-one input template. The result is either the complete message string or an error if template rendering fails.

**Call relations**: This function is used when preparing the first memory-writing input for the model. It calls the model information object to learn the available context window, uses the truncation utility to shrink large rollout content, and then fills the stage-one template with the final values.

*Call graph*: calls 1 internal fn (resolved_context_window); 4 external calls (as_str, display, truncate_text, Tokens).


### `ext/goal/src/steering.rs`

`domain_logic` · `goal updates and model continuation`

This file is like a small prompt-writing workshop for goal tracking. The rest of the system keeps a ThreadGoal, which includes the objective, how many tokens have been used, and sometimes a token budget. This file takes that raw goal information and turns it into carefully formatted text that the model can read as extra context.

There are three main situations it supports. If the model should continue working after being idle, it builds a continuation prompt. If the token budget has been reached or is close enough to matter, it builds a budget-limit prompt. If someone updates the objective, it builds a prompt explaining the new objective and remaining budget.

The actual wording lives in embedded Markdown template files. This file loads and parses those templates once, then fills in values such as the objective, tokens used, token budget, and remaining tokens. Before putting the objective into a template, it escapes XML-sensitive characters like <, >, and &, so user text cannot accidentally break the surrounding prompt format.

Finally, the finished prompt is wrapped as a ResponseItem with an internal context source named "goal". That label tells the model-facing machinery that this message is system-provided goal context, not a normal user message.

#### Function details

##### `parse_embedded_template`  (lines 30–35)

```
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template
```

**Purpose**: This function checks that one of the built-in prompt templates is valid before the program uses it. It exists so a broken template is caught immediately, instead of producing confusing model instructions later.

**Data flow**: It receives the template text and a human-readable template name. It asks the template library to parse the text. If parsing succeeds, it returns the ready-to-use Template; if parsing fails, it stops the program with a clear error saying which embedded template is invalid.

**Call relations**: The file's lazily loaded template constants call this function when each embedded Markdown template is first needed. It hands back parsed templates to the prompt-building functions, so they can fill in goal values without reparsing the raw text each time.

*Call graph*: calls 1 internal fn (parse); 1 external calls (panic!).


##### `budget_limit_steering_item`  (lines 37–39)

```
fn budget_limit_steering_item(goal: &ThreadGoal) -> ResponseItem
```

**Purpose**: This function creates a model-readable steering message for the moment when a goal has hit, or is constrained by, its token budget. It is used to remind the model what the goal was and how much budget has been spent.

**Data flow**: It receives a ThreadGoal. It turns that goal into budget-limit prompt text, then wraps the text as an internal goal context item. The output is a ResponseItem that can be inserted into the model conversation.

**Call relations**: It is called by on_tool_finish, which means this reminder can be added after a tool run when the system checks progress and budget. It delegates the wording to budget_limit_prompt and delegates the wrapping step to goal_context_input_item.

*Call graph*: calls 2 internal fn (budget_limit_prompt, goal_context_input_item); called by 1 (on_tool_finish).


##### `objective_updated_steering_item`  (lines 41–43)

```
fn objective_updated_steering_item(goal: &ThreadGoal) -> ResponseItem
```

**Purpose**: This function creates a steering message that tells the model the goal objective has changed. It helps keep the model aligned with the newest instructions instead of continuing with an older target.

**Data flow**: It receives the updated ThreadGoal. It builds text describing the new objective and budget state, then wraps that text as an internal goal context ResponseItem. The result is ready to be added to the model's context.

**Call relations**: It is called by apply_external_goal_set, which is the flow that applies a newly supplied goal. It uses objective_updated_prompt to write the message and goal_context_input_item to package it for the model-facing protocol.

*Call graph*: calls 2 internal fn (goal_context_input_item, objective_updated_prompt); called by 1 (apply_external_goal_set).


##### `continuation_steering_item`  (lines 45–47)

```
fn continuation_steering_item(goal: &ThreadGoal) -> ResponseItem
```

**Purpose**: This function creates a steering message for continuing work on an existing goal. It gives the model a fresh reminder of the objective and remaining budget before more work is requested.

**Data flow**: It receives the current ThreadGoal. It builds continuation prompt text from that goal, then wraps the text as an internal goal context ResponseItem. The returned item can be placed into the next model input.

**Call relations**: It is called by continue_if_idle, so it is part of the path that nudges the model to keep going when there is still work to do. It relies on continuation_prompt for the actual words and goal_context_input_item for the protocol wrapper.

*Call graph*: calls 2 internal fn (continuation_prompt, goal_context_input_item); called by 1 (continue_if_idle).


##### `goal_context_input_item`  (lines 49–54)

```
fn goal_context_input_item(prompt: String) -> ResponseItem
```

**Purpose**: This function packages plain prompt text into the response item format used by the rest of the system. It marks the text as internal goal context, so it is treated differently from a normal user message.

**Data flow**: It receives a completed prompt string. It creates an InternalModelContextFragment with the source label "goal", then converts that fragment into a ResponseItem. The content stays the same, but it is now wrapped in the structure the model pipeline expects.

**Call relations**: All three public steering-item builders call this function after they have generated their prompt text. It is the shared final step that turns goal reminders into the common ResponseItem type used downstream.

*Call graph*: calls 3 internal fn (into, from_static, new); called by 3 (budget_limit_steering_item, continuation_steering_item, objective_updated_steering_item).


##### `continuation_prompt`  (lines 56–78)

```
fn continuation_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: This function writes the actual continuation reminder text for a goal. It includes the objective, tokens already used, the total budget if one exists, and how many tokens remain.

**Data flow**: It receives a ThreadGoal. It first escapes the objective so special XML-like characters cannot disrupt the template. It converts numeric budget fields into strings, using friendly fallback words such as "none" or "unbounded" when there is no token budget. It then fills the continuation template and returns the rendered prompt text.

**Call relations**: continuation_steering_item calls this when the system wants to continue work after idleness. This function prepares only the text; the caller then passes that text to goal_context_input_item so it can enter the model context.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (continuation_steering_item).


##### `budget_limit_prompt`  (lines 80–99)

```
fn budget_limit_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: This function writes the prompt used when budget limits matter. It gives the model the objective plus usage facts such as elapsed time, tokens used, and the token budget.

**Data flow**: It receives a ThreadGoal. It escapes the objective, converts time and token counts into strings, and uses "none" if there is no token budget. It fills the budget-limit template with those values and returns the finished prompt text.

**Call relations**: budget_limit_steering_item calls this when on_tool_finish needs a budget-related steering item. This function focuses on building the message body, while its caller wraps the result into a ResponseItem.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (budget_limit_steering_item).


##### `objective_updated_prompt`  (lines 101–122)

```
fn objective_updated_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: This function writes the text that tells the model about an updated objective. It also reports token usage and remaining budget when that information is available.

**Data flow**: It receives a ThreadGoal. It escapes the objective, converts token usage into strings, and calculates remaining tokens if a budget exists. If there is no budget, it uses "none" for the budget and "unknown" for remaining tokens. It renders the objective-updated template and returns the final prompt text.

**Call relations**: objective_updated_steering_item calls this after an external goal update is applied. The produced text is then wrapped as internal goal context so the next model turn sees the new target.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (objective_updated_steering_item).


##### `escape_xml_text`  (lines 124–129)

```
fn escape_xml_text(input: &str) -> String
```

**Purpose**: This function makes goal text safe to place inside XML-like prompt markup. It prevents characters in the user's objective from being mistaken for markup instructions.

**Data flow**: It receives a text string. It replaces ampersands, less-than signs, and greater-than signs with their safe written-out forms. It returns the cleaned string without changing the original input.

**Call relations**: The three prompt-building functions call this before inserting the objective into templates. It is a small safety step that protects the prompt format no matter which kind of goal steering message is being built.

*Call graph*: called by 3 (budget_limit_prompt, continuation_prompt, objective_updated_prompt).


### `prompts/src/goals.rs`

`domain_logic` · `goal continuation and update handling`

This file is like a small letter-writing desk for long-running goals. When the system is working on a user’s goal over more than one turn, it needs to remind the model what the goal is, how much work has already been spent, and whether there is still room to continue. This file creates those reminders as hidden prompts, meaning text sent to the model for guidance but not written by the user directly.

It uses three built-in template files: one for continuing an active goal, one for wrapping up when the budget is exhausted, and one for when the user changes the goal. A template is a reusable text shape with blanks to fill in, like a form letter. The templates are parsed lazily, which means they are loaded and checked only when first needed, then reused afterward.

Each public function receives a ThreadGoal, which contains the goal text, tokens already used, optional token budget, and sometimes time used. It converts numbers into readable strings, calculates remaining tokens when there is a budget, and protects the objective text with simple XML escaping. That escaping matters because the prompt templates likely place the objective inside XML-like tags; without escaping, a user’s text containing characters like '<' could accidentally look like prompt structure. If an embedded template is invalid or cannot be filled, the code deliberately panics, because that would be a programmer or build-time mistake rather than a normal user error.

#### Function details

##### `continuation_prompt`  (lines 32–53)

```
fn continuation_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Builds the hidden prompt that tells the model to keep working on an existing goal after a previous turn has finished. It includes the current objective, how many tokens have been used, the budget if one exists, and how many tokens remain.

**Data flow**: It takes a ThreadGoal as input. From that goal, it reads the objective, tokens already used, and optional token budget; it calculates remaining tokens when possible, turns all numbers into text, escapes the objective so special characters cannot be mistaken for markup, and fills the continuation template. The output is one completed prompt string; it does not change the goal.

**Call relations**: This is called when the larger goal-running flow wants the model to continue rather than stop or restart. Before filling the template, it hands the objective to escape_xml_text so the user’s wording is safe to place inside the prompt structure. If the built-in template cannot be rendered, it panics because the program’s packaged prompt template is broken.

*Call graph*: calls 1 internal fn (escape_xml_text); 1 external calls (panic!).


##### `budget_limit_prompt`  (lines 57–75)

```
fn budget_limit_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Builds the hidden prompt that asks the model to wrap up after a goal has used up its allowed budget. It gives the model enough context to summarize or finish responsibly instead of continuing indefinitely.

**Data flow**: It receives a ThreadGoal. It reads the objective, tokens used, time used in seconds, and optional token budget; it converts those values into strings, escapes the objective text, and places everything into the budget-limit template. It returns the finished prompt string and leaves the input goal unchanged.

**Call relations**: This fits into the flow that watches resource use for a goal. When the budget has been exhausted, the surrounding system can call this function to create the instruction that nudges the model toward closure. It relies on escape_xml_text for safe objective text, and it panics only if the embedded template fails to render.

*Call graph*: calls 1 internal fn (escape_xml_text); 1 external calls (panic!).


##### `objective_updated_prompt`  (lines 78–99)

```
fn objective_updated_prompt(goal: &ThreadGoal) -> String
```

**Purpose**: Builds the hidden prompt used after a user edits the objective of an active goal. It tells the model about the updated target while preserving information about how much budget has already been spent.

**Data flow**: It takes a ThreadGoal containing the new objective and current usage numbers. It reads the token budget, tokens used, and objective; calculates remaining tokens if there is a budget; escapes the objective; then fills the objective-updated template. The result is a completed prompt string, with no changes made to the goal itself.

**Call relations**: This is used when the broader conversation flow detects that the goal has changed while work is already underway. It prepares the model to adjust course without losing track of spending so far. Like the other prompt builders, it delegates text safety to escape_xml_text and treats template rendering failure as a fatal packaged-template error.

*Call graph*: calls 1 internal fn (escape_xml_text); 1 external calls (panic!).


##### `escape_xml_text`  (lines 101–106)

```
fn escape_xml_text(input: &str) -> String
```

**Purpose**: Makes ordinary user text safe to place inside XML-like prompt markup. It replaces characters that have special meaning in markup, so the objective remains just text instead of accidentally changing the prompt’s structure.

**Data flow**: It receives a text string. It scans the string and replaces '&' with '&amp;', '<' with '&lt;', and '>' with '&gt;'. It returns the escaped string and does not modify the original input.

**Call relations**: This is the small safety helper used by all three prompt-building functions before they insert the goal objective into a template. It sits underneath continuation_prompt, budget_limit_prompt, and objective_updated_prompt, giving each one a clean objective string to pass into template rendering.

*Call graph*: called by 3 (budget_limit_prompt, continuation_prompt, objective_updated_prompt).


### Review flow prompts
These files resolve review requests into concrete prompts and render the exit snippets used when review flows complete or stop.

### `prompts/src/review_request.rs`

`domain_logic` · `request handling`

This file is the translator between a broad review request and a concrete set of instructions for the assistant. A user might ask to review uncommitted work, compare the current branch to a base branch, review one commit, or provide custom instructions. Each of those needs a different prompt so the assistant knows where to look and what kind of comparison to make.

The central idea is the `ResolvedReviewRequest`: it keeps the original review target, the full prompt text to send to the assistant, and a shorter hint that can be shown back to the user. For example, if the target is a base branch, the file tries to find the Git merge base, which is the common ancestor commit where the current branch split from the base branch. That lets it produce a precise instruction like “run git diff from this commit.” If that lookup fails to find a commit, it falls back to a more general prompt that tells the assistant how to find the comparison itself.

The file also uses small templates with placeholders, like filling in a branch name or commit SHA on a form. Custom review instructions are allowed, but empty custom prompts are rejected so the system does not start a review with no direction.

#### Function details

##### `resolve_review_request`  (lines 42–57)

```
fn resolve_review_request(
    request: ReviewRequest,
    cwd: &AbsolutePathBuf,
) -> anyhow::Result<ResolvedReviewRequest>
```

**Purpose**: This function takes a raw review request and turns it into a complete, ready-to-use review request. It makes sure there is both a detailed assistant prompt and a short user-facing description.

**Data flow**: It receives a `ReviewRequest` and the current working directory path. It reads the request target, asks `review_prompt` to build the full prompt for that target, then either keeps the user-provided hint or creates a default one. It returns a `ResolvedReviewRequest` containing the target, the generated prompt, and the hint.

**Call relations**: This is the main entry point in this file for preparing review instructions. When a review request arrives, this function calls `review_prompt` to turn the selected target into usable assistant instructions, then packages everything together for the rest of the review flow.

*Call graph*: calls 1 internal fn (review_prompt).


##### `review_prompt`  (lines 59–99)

```
fn review_prompt(target: &ReviewTarget, cwd: &AbsolutePathBuf) -> anyhow::Result<String>
```

**Purpose**: This function builds the actual text prompt that tells the assistant what code to review. It chooses different wording depending on whether the review is for uncommitted changes, a base branch comparison, a specific commit, or custom user instructions.

**Data flow**: It receives a review target and the current working directory. For uncommitted changes, it returns a fixed prompt. For a base branch, it tries to find the Git merge base with `merge_base_with_head`; if found, it inserts the branch and commit into a template, and if not found, it uses a backup template. For a commit, it inserts the commit SHA and optionally the title. For custom instructions, it trims whitespace and returns the text, unless it is empty, in which case it returns an error.

**Call relations**: This function is called by `resolve_review_request` when a raw request needs to become a concrete review prompt. It hands template filling to `render_review_prompt`, asks the Git helper `merge_base_with_head` for branch comparison information, and uses `bail!` to stop invalid empty custom prompts.

*Call graph*: calls 1 internal fn (render_review_prompt); called by 1 (resolve_review_request); 2 external calls (bail!, merge_base_with_head).


##### `render_review_prompt`  (lines 101–108)

```
fn render_review_prompt(
    template: &Template,
    variables: [(&'a str, &'a str); N],
) -> String
```

**Purpose**: This helper fills in a review prompt template with specific values, such as a branch name, merge base commit, commit SHA, or title. It keeps the template-rendering details out of the main prompt-selection logic.

**Data flow**: It receives a parsed template and a fixed-size list of placeholder names paired with their replacement text. It asks the template to render itself with those values and returns the finished string. If rendering fails, it panics because these built-in templates are expected to be valid.

**Call relations**: This function is used by `review_prompt` whenever a prompt contains placeholders. `review_prompt` decides which template is needed, then this helper performs the final fill-in step by calling the template's `render` operation.

*Call graph*: calls 1 internal fn (render); called by 1 (review_prompt).


##### `user_facing_hint`  (lines 110–124)

```
fn user_facing_hint(target: &ReviewTarget) -> String
```

**Purpose**: This function creates a short label describing the review target in words a user can quickly understand. It is meant for display, not for instructing the assistant in detail.

**Data flow**: It receives a review target. For uncommitted changes it returns “current changes”; for a base branch it names the branch; for a commit it shortens the SHA to seven characters and includes the title if available; for custom instructions it returns the trimmed instruction text. The output is a single display string.

**Call relations**: This function complements the longer prompt-building path. When the system needs a brief description of the review target, it formats that description directly, using `format!` for cases that include branch names, commit IDs, or titles.

*Call graph*: 1 external calls (format!).


##### `ReviewRequest::from`  (lines 127–132)

```
fn from(resolved: ResolvedReviewRequest) -> Self
```

**Purpose**: This conversion turns a resolved review request back into the simpler protocol-level `ReviewRequest` form. It preserves the target and stores the resolved user-facing hint.

**Data flow**: It receives a `ResolvedReviewRequest`, takes out its target and hint, and builds a new `ReviewRequest`. The detailed prompt is not included in the resulting request, because the protocol request only carries the target and optional hint.

**Call relations**: This function is used when code needs to pass a resolved request back through places that expect the original `ReviewRequest` type. It acts like repacking a prepared review into the smaller standard container used by the protocol layer.


### `prompts/src/review_exit.rs`

`domain_logic` · `review exit`

This file is a small prompt-building helper for the review workflow. When a review ends, the system needs a well-formed piece of text that says what happened. Rather than building that text by hand each time, this file loads reusable template files and turns them into final strings.

For a successful review exit, it reads an XML template bundled with the program and parses it once, the first time it is needed. This lazy setup is like keeping a form in a drawer and only preparing it when someone first asks for it. Later calls reuse the prepared form. The caller supplies the actual review results, and the template engine fills them into the right place.

For an interrupted review exit, there is no changing data to insert. The file simply returns the bundled interruption template as plain text.

One important detail is line ending cleanup. Text files can use different newline styles on different operating systems. This file normalizes carriage-return based line endings into ordinary newline characters, so the rendered prompt is stable and predictable no matter where the source template came from.

#### Function details

##### `render_review_exit_success`  (lines 16–20)

```
fn render_review_exit_success(results: &str) -> String
```

**Purpose**: Builds the final review-exit message for a successful review. It takes the review results and places them into the success template so the rest of the system can use one finished string.

**Data flow**: The input is a text value containing the review results. The function uses the already-prepared success template, fills its `results` placeholder with that input, and returns the completed prompt text. If the bundled template is broken or cannot be filled, the program stops with a clear error because this is considered a developer mistake, not a normal runtime problem.

**Call relations**: This is the function other review code would call when the review finishes normally. It relies on the file-level cached template, which is prepared from the bundled success XML template the first time it is needed.


##### `render_review_exit_interrupted`  (lines 22–24)

```
fn render_review_exit_interrupted() -> String
```

**Purpose**: Returns the final review-exit message for a review that was stopped before completion. There are no results to insert, so it just returns the interruption template text in a clean, consistent form.

**Data flow**: The function reads the bundled interrupted-exit template text, sends it through the newline normalizer, and returns an owned string that callers can pass along or display. It does not take any input and does not change any shared state.

**Call relations**: This is used when the review flow ends early rather than successfully. Before handing the text back, it calls `normalize_review_template_line_endings` so the returned prompt has predictable newlines.

*Call graph*: calls 1 internal fn (normalize_review_template_line_endings).


##### `normalize_review_template_line_endings`  (lines 26–32)

```
fn normalize_review_template_line_endings(template: &str) -> Cow<'_, str>
```

**Purpose**: Makes template text use consistent newline characters. This prevents small operating-system differences in text files from changing the final prompt.

**Data flow**: The input is template text. If it contains carriage-return characters, the function creates a cleaned copy where Windows-style and old-style line endings are converted to normal newline characters. If the text is already clean, it returns a borrowed view of the original text instead of copying it.

**Call relations**: This helper is called by `render_review_exit_interrupted` before returning the interrupted-exit template. The success template setup also uses the same idea when preparing the cached template, so both exit paths produce consistent text.

*Call graph*: called by 1 (render_review_exit_interrupted); 2 external calls (Borrowed, Owned).
