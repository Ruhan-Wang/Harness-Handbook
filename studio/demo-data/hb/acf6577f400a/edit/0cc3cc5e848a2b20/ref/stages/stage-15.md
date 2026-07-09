# Multi-agent, collaboration, and background workflows  `stage-15`

This stage sits above the core turn loop as the system’s collaboration and background-work layer: when a request cannot be completed by one agent in one pass, it spawns child threads, routes messages between them, waits on their progress, and runs longer-lived asynchronous pipelines.

At its center, the agent subsystem (`core/src/agent/*`) defines roles, resolves agent references, tracks live agents in a registry, enforces concurrency and residency limits, and performs actual spawn/reload/resume operations. `session_prefix.rs`, inter-agent completion messages, and `session/multi_agents.rs` shape the model-visible context around those lifecycle events. The multi-agent tool handlers then expose that control plane to the model: v1 and v2 tools cover spawning, sending input or mailbox messages, follow-up tasks, waiting, listing, interrupting, resuming, and closing agents, with shared validation and result formatting.

Around that core, `codex_delegate.rs`, review mode, code-mode delegation, and the guardian extension adapt nested or host-backed sub-sessions into the same orchestration model. `agent_jobs/*` scales this pattern across CSV rows by spawning workers and collecting results. The memories write pipeline uses internal spawning for two-phase extraction and consolidation, while `skills_watcher.rs` runs a separate background watcher that invalidates cached skill state when files change.

## Files in this stage

### Agent control foundation
These files define the core agent subsystem, including role application, registry bookkeeping, target resolution, lifecycle orchestration, execution limits, residency management, and session-visible lifecycle messaging.

### `core/src/agent/mod.rs`

`orchestration` · `agent lifecycle and event processing`

This module root declares the internal pieces of the agent subsystem: `agent_resolver`, `control`, `registry`, `role`, and `status`. It then re-exports a narrow set of items for sibling modules inside the crate: the protocol-level `AgentStatus` type, the `AgentControl` abstraction, registry helpers for thread spawn depth accounting, and `agent_status_from_event` for deriving status from events.

The selected re-exports show the subsystem's responsibilities. `control` likely encapsulates commands or lifecycle operations for an agent instance; `registry` tracks spawned agent/thread relationships and enforces depth limits through `exceeds_thread_spawn_depth_limit` and `next_thread_spawn_depth`; `status` translates lower-level events into the externally meaningful `AgentStatus`; and `role` plus `agent_resolver` support choosing or interpreting agent identities. This file itself contains no executable logic, but it is the internal API choke point for agent-related coordination inside `core`. By keeping most modules `pub(crate)` and re-exporting only a few symbols, it preserves encapsulation while making the common agent operations available where needed.


### `core/src/agent/role.rs`

`domain_logic` · `sub-agent spawn configuration and tool-spec generation`

This module is the role-resolution and role-application layer for spawned agents. `apply_role_to_config` chooses a role name, defaults missing input to `DEFAULT_ROLE_NAME`, resolves the declaration from either `config.agent_roles` or the built-in registry, and converts any internal loading/parsing failure into the user-facing string `agent type is currently not available` after logging a warning. The inner application path short-circuits when a role has no `config_file` or when the loaded TOML is an empty table. Otherwise it loads TOML from embedded built-ins or a user file, validates it with `deserialize_config_toml_with_base`, resolves relative paths against the role file’s base directory, and decides whether to preserve the current `model_provider` and `service_tier` based on whether the role layer explicitly sets those top-level keys.

The nested `reload` module rebuilds a full `Config` by cloning the existing `ConfigLayerStack`, inserting a new `ConfigLayerEntry` sourced from `ConfigLayerSource::SessionFlags` in precedence order, deserializing the effective merged config, and reloading with sticky overrides for cwd and selected runtime fields. The `spawn_tool_spec` module formats a human-readable role catalog, deduplicating user-defined names over built-ins and augmenting descriptions with notes extracted from role TOML when model, reasoning effort, or service tier are locked. The `built_in` module caches built-in role declarations in a `LazyLock` and maps embedded filenames like `explorer.toml` to `include_str!` contents.

#### Function details

##### `apply_role_to_config`  (lines 38–54)

```
async fn apply_role_to_config(
    config: &mut Config,
    role_name: Option<&str>,
) -> Result<(), String>
```

**Purpose**: Resolves the requested role name, defaults missing input to `default`, and applies that role’s config layer to the mutable session `Config`. It is the public entry point that converts internal failures into stable user-facing error strings.

**Data flow**: Takes `&mut Config` and `Option<&str>` role name, substitutes `DEFAULT_ROLE_NAME` when absent, reads role declarations from `config.agent_roles` and built-ins via `resolve_role_config`, clones the selected `AgentRoleConfig`, and either returns `Err("unknown agent_type '...' ")` or awaits `apply_role_to_config_inner`. On inner failure it logs a warning and returns `AGENT_TYPE_UNAVAILABLE_ERROR`; on success it mutates `*config` in place and returns `Ok(())`.

**Call relations**: Spawn orchestration calls this before creating a sub-agent so the child inherits role-specific settings. It delegates actual TOML loading and config rebuilding to `apply_role_to_config_inner` after `resolve_role_config` chooses the declaration source.

*Call graph*: calls 2 internal fn (apply_role_to_config_inner, resolve_role_config); called by 3 (new_default_turn_uses_config_aware_skills_for_role_overrides, handle_spawn_agent, handle_spawn_agent).


##### `apply_role_to_config_inner`  (lines 56–83)

```
async fn apply_role_to_config_inner(
    config: &mut Config,
    role_name: &str,
    role: &AgentRoleConfig,
) -> anyhow::Result<()>
```

**Purpose**: Performs the actual role-layer application once a concrete `AgentRoleConfig` has already been resolved. It decides whether any role file exists, loads and validates it, and rebuilds the config with sticky runtime overrides where appropriate.

**Data flow**: Consumes `&mut Config`, the resolved role name, and `&AgentRoleConfig`. It computes `is_built_in` by checking whether the role name is absent from `config.agent_roles`, exits early if `role.config_file` is `None`, loads TOML with `load_role_layer_toml`, exits early again if the TOML is an empty table, derives two booleans by checking whether `model_provider` and `service_tier` keys are absent, then replaces `*config` with the `Config` returned by `reload::build_next_config`.

**Call relations**: This function is only reached from `apply_role_to_config` after successful role resolution. It delegates file parsing to `load_role_layer_toml` and full config reconstruction to `reload::build_next_config`.

*Call graph*: calls 1 internal fn (load_role_layer_toml); called by 1 (apply_role_to_config); 1 external calls (build_next_config).


##### `load_role_layer_toml`  (lines 85–117)

```
async fn load_role_layer_toml(
    config: &Config,
    config_file: &Path,
    is_built_in: bool,
    role_name: &str,
) -> anyhow::Result<TomlValue>
```

**Purpose**: Loads a role config file into a `TomlValue`, handling built-in embedded files and user-provided files differently. It also validates the resulting config schema and rewrites relative paths against the role file’s base directory.

**Data flow**: Reads `&Config`, `&Path` config file, `bool is_built_in`, and `&str role_name`. For built-ins it fetches embedded text from `built_in::config_file_contents`, parses it with `toml::from_str`, and uses `config.codex_home` as the base path. For user roles it asynchronously reads the file from disk, derives the parent directory, parses through `parse_agent_role_file_contents(..., Some(role_name))`, and extracts `.config`. In both cases it validates with `deserialize_config_toml_with_base`, resolves relative paths with `resolve_relative_paths_in_config_toml`, and returns the transformed `TomlValue`.

**Call relations**: Called only by `apply_role_to_config_inner` when a role has a `config_file`. It centralizes all I/O and TOML parsing so the caller can focus on merge policy.

*Call graph*: calls 3 internal fn (resolve_relative_paths_in_config_toml, parse_agent_role_file_contents, deserialize_config_toml_with_base); called by 1 (apply_role_to_config_inner); 5 external calls (parent, anyhow!, config_file_contents, read_to_string, from_str).


##### `resolve_role_config`  (lines 119–127)

```
fn resolve_role_config(
    config: &'a Config,
    role_name: &str,
) -> Option<&'a AgentRoleConfig>
```

**Purpose**: Looks up a role declaration by name, preferring user-defined roles over built-ins. It provides the single resolution rule used by role application.

**Data flow**: Accepts `&Config` and `&str role_name`, checks `config.agent_roles.get(role_name)`, and falls back to `built_in::configs().get(role_name)`. Returns `Option<&AgentRoleConfig>` without mutating state.

**Call relations**: This is the first step in `apply_role_to_config`; if it returns `None`, the caller emits the unknown-role error instead of attempting any file loading.

*Call graph*: called by 1 (apply_role_to_config).


##### `reload::build_next_config`  (lines 132–154)

```
async fn build_next_config(
        config: &Config,
        role_layer_toml: TomlValue,
        preserve_current_provider: bool,
        preserve_current_service_tier: bool,
    ) -> anyhow::Result<C
```

**Purpose**: Reconstructs a full `Config` after inserting the role layer into the existing layer stack. It preserves selected runtime overrides that should survive the reload.

**Data flow**: Takes the current `&Config`, a role-layer `TomlValue`, and two booleans controlling sticky preservation. It builds a new `ConfigLayerStack`, deserializes the effective merged `ConfigToml`, computes `ConfigOverrides`, then awaits `Config::load_config_with_layer_stack(...)` using `LOCAL_FS`, the merged config, the overrides, cloned `codex_home`, and the new stack. Returns the newly loaded `Config`.

**Call relations**: Invoked by `apply_role_to_config_inner` after TOML loading. It delegates stack assembly, effective-config deserialization, and override construction to sibling helpers in the `reload` module.

*Call graph*: 4 external calls (load_config_with_layer_stack, build_config_layer_stack, deserialize_effective_config, reload_overrides).


##### `reload::build_config_layer_stack`  (lines 156–167)

```
fn build_config_layer_stack(
        config: &Config,
        role_layer_toml: &TomlValue,
    ) -> anyhow::Result<ConfigLayerStack>
```

**Purpose**: Creates a new `ConfigLayerStack` by cloning the current layers and inserting the role layer at the correct precedence position. It preserves the existing requirements metadata from the original stack.

**Data flow**: Reads the current `Config` and a borrowed role-layer TOML value, clones the existing layers via `existing_layers`, inserts a freshly built role layer with `insert_layer`, then constructs and returns `ConfigLayerStack::new(layers, cloned_requirements, cloned_requirements_toml)`.

**Call relations**: This helper is called from `reload::build_next_config` before deserializing the merged config. It isolates the ordering-sensitive layer-stack manipulation.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, existing_layers, insert_layer, role_layer).


##### `reload::deserialize_effective_config`  (lines 169–177)

```
fn deserialize_effective_config(
        config: &Config,
        config_layer_stack: &ConfigLayerStack,
    ) -> anyhow::Result<ConfigToml>
```

**Purpose**: Turns the effective merged TOML from a `ConfigLayerStack` back into a typed `ConfigToml` using the session’s codex-home base path. This catches schema or path-resolution issues before the full reload.

**Data flow**: Accepts `&Config` and `&ConfigLayerStack`, reads `config_layer_stack.effective_config()`, passes it with `&config.codex_home` to `deserialize_config_toml_with_base`, and returns the typed `ConfigToml`.

**Call relations**: Used by `reload::build_next_config` after the new stack is assembled and before `Config::load_config_with_layer_stack` is called.

*Call graph*: calls 2 internal fn (effective_config, deserialize_config_toml_with_base).


##### `reload::existing_layers`  (lines 179–189)

```
fn existing_layers(config: &Config) -> Vec<ConfigLayerEntry>
```

**Purpose**: Extracts the current config layers in lowest-precedence-first order, including disabled layers, into an owned vector. This gives the reload path a mutable copy it can edit.

**Data flow**: Reads `config.config_layer_stack`, calls `get_layers(ConfigLayerStackOrdering::LowestPrecedenceFirst, true)`, clones each `ConfigLayerEntry`, collects them into `Vec<ConfigLayerEntry>`, and returns that vector.

**Call relations**: This helper feeds `reload::build_config_layer_stack`, which needs an owned layer list before inserting the role layer.


##### `reload::insert_layer`  (lines 191–195)

```
fn insert_layer(layers: &mut Vec<ConfigLayerEntry>, layer: ConfigLayerEntry)
```

**Purpose**: Inserts a new config layer into an existing ordered vector while preserving ordering by layer name. It uses partitioning rather than a full sort.

**Data flow**: Takes `&mut Vec<ConfigLayerEntry>` and a new `ConfigLayerEntry`, computes an insertion index with `partition_point(|existing_layer| existing_layer.name <= layer.name)`, and inserts the layer at that index. It mutates the vector in place and returns nothing.

**Call relations**: Called by `reload::build_config_layer_stack` after cloning existing layers and creating the role layer.


##### `reload::role_layer`  (lines 197–199)

```
fn role_layer(role_layer_toml: TomlValue) -> ConfigLayerEntry
```

**Purpose**: Wraps a role TOML document in a `ConfigLayerEntry` tagged as `SessionFlags`. This gives role settings the same precedence class as session flag overrides.

**Data flow**: Consumes a `TomlValue` and returns `ConfigLayerEntry::new(ConfigLayerSource::SessionFlags, role_layer_toml)`. No external state is read or written.

**Call relations**: Used by `reload::build_config_layer_stack` immediately before insertion into the cloned layer list.

*Call graph*: calls 1 internal fn (new).


##### `reload::reload_overrides`  (lines 201–214)

```
fn reload_overrides(
        config: &Config,
        preserve_current_provider: bool,
        preserve_current_service_tier: bool,
    ) -> ConfigOverrides
```

**Purpose**: Builds the `ConfigOverrides` that should survive config reload, including cwd and selected runtime executable paths, and optionally the current provider and service tier. This prevents role application from unintentionally resetting sticky runtime choices.

**Data flow**: Reads fields from `&Config` and two booleans. It always sets `cwd`, copies `codex_linux_sandbox_exe` and `main_execve_wrapper_exe`, conditionally sets `model_provider` and `service_tier` using `then(...)`, fills the rest from `Default::default()`, and returns the assembled `ConfigOverrides`.

**Call relations**: This helper is called by `reload::build_next_config` right before the final `Config::load_config_with_layer_stack` call.

*Call graph*: 1 external calls (default).


##### `spawn_tool_spec::build`  (lines 221–224)

```
fn build(user_defined_agent_roles: &BTreeMap<String, AgentRoleConfig>) -> String
```

**Purpose**: Builds the full spawn-agent tool description string from both built-in and user-defined roles. It is the public formatter entry point for tool metadata.

**Data flow**: Accepts a `&BTreeMap<String, AgentRoleConfig>` of user-defined roles, fetches built-ins from `built_in::configs()`, passes both maps to `build_from_configs`, and returns the resulting `String`.

**Call relations**: Callers that need the tool’s role list use this wrapper rather than formatting built-ins and user roles themselves.

*Call graph*: 2 external calls (configs, build_from_configs).


##### `spawn_tool_spec::build_from_configs`  (lines 227–248)

```
fn build_from_configs(
        built_in_roles: &BTreeMap<String, AgentRoleConfig>,
        user_defined_roles: &BTreeMap<String, AgentRoleConfig>,
    ) -> String
```

**Purpose**: Formats the available-role section while deduplicating names and ensuring user-defined roles appear before built-ins. It produces the final multi-line help text shown to the model.

**Data flow**: Reads two ordered `BTreeMap`s, tracks seen names in a `BTreeSet`, pushes formatted role strings into a `Vec<String>` first from user-defined roles and then from built-ins only when unseen, joins them with newlines, and interpolates them into a header string mentioning `DEFAULT_ROLE_NAME`.

**Call relations**: This non-inlined helper is called by `spawn_tool_spec::build` and exists partly to make ordering and deduplication behavior easy to test.

*Call graph*: 4 external calls (new, new, format_role, format!).


##### `spawn_tool_spec::format_role`  (lines 250–302)

```
fn format_role(name: &str, declaration: &AgentRoleConfig) -> String
```

**Purpose**: Formats one role declaration for the spawn-tool spec, optionally augmenting its description with notes about locked model, reasoning effort, and service tier extracted from the role’s config file. Roles without descriptions are rendered as `no description`.

**Data flow**: Takes a role name and `&AgentRoleConfig`. If `description` is present, it optionally reads the role config contents from embedded built-ins or the filesystem, parses them as TOML, extracts `model`, `model_reasoning_effort`, and `service_tier` string values, synthesizes explanatory bullet notes, and returns a block like `name: { ... }`. If no description exists, it returns `"name: no description"`.

**Call relations**: Called repeatedly by `spawn_tool_spec::build_from_configs` for each visible role. It is the only formatter that inspects role TOML contents to expose immutable settings in the tool description.

*Call graph*: 1 external calls (format!).


##### `built_in::configs`  (lines 309–370)

```
fn configs() -> &'static BTreeMap<String, AgentRoleConfig>
```

**Purpose**: Returns the cached map of built-in role declarations. It defines the built-in names, descriptions, and optional embedded config files available even when the user has not configured any roles.

**Data flow**: Uses a `static LazyLock<BTreeMap<String, AgentRoleConfig>>` initialized once with entries for `default`, `explorer`, and `worker`, each containing description text, optional `config_file`, and `nickname_candidates`. Returns a shared reference to that map.

**Call relations**: This function is consulted by both role resolution and spawn-tool-spec generation whenever built-in roles need to be enumerated or looked up.

*Call graph*: 1 external calls (new).


##### `built_in::config_file_contents`  (lines 373–381)

```
fn config_file_contents(path: &Path) -> Option<&'static str>
```

**Purpose**: Maps a built-in role config path like `explorer.toml` to the embedded TOML source text compiled into the binary. Unknown paths return `None`.

**Data flow**: Accepts `&Path`, converts it to `&str` with `to_str()`, matches the string against known built-in filenames, and returns `Some(&'static str)` from `include_str!` constants or `None` if there is no embedded file.

**Call relations**: Built-in role loading uses this helper in `load_role_layer_toml`, and spawn-tool-spec formatting uses it to inspect built-in role TOML for locked-setting notes.

*Call graph*: 2 external calls (to_str, include_str!).


### `core/src/agent/registry.rs`

`data_model` · `cross-cutting`

This file defines the shared session-level registry behind `AgentControl`. `AgentRegistry` stores two kinds of state: a `Mutex<ActiveAgents>` containing the `agent_tree` map and nickname bookkeeping, and an atomic `total_count` used for thread-limit enforcement across clones. `AgentMetadata` records the thread ID, optional `AgentPath`, nickname, role, and last plaintext task message for each agent.

The registry supports both committed and provisional spawn state. `reserve_spawn_slot` increments `total_count`—either atomically bounded by `try_increment_spawned(max_threads)` or unconditionally when no limit applies—and returns a `SpawnReservation`. That reservation can reserve a nickname and/or path before the thread exists. If the reservation is dropped before `commit`, its `Drop` implementation releases any reserved path placeholder and decrements `total_count`, preventing leaked capacity. On successful spawn, `SpawnReservation::commit` clears provisional fields and calls `register_spawned_thread`.

Path handling uses `agent_tree` keys of either the concrete `AgentPath` string or a synthetic `thread:{thread_id}` key for anonymous agents. `reserve_agent_path` inserts a placeholder metadata entry with no `agent_id`, which blocks duplicate paths until commit or drop. Nickname allocation prefers a caller-specified nickname, otherwise chooses randomly from available names after formatting them with `format_agent_nickname`. When the pool is exhausted, it clears `used_agent_nicknames`, increments `nickname_reset_count`, emits an OpenTelemetry counter, and starts reusing names with ordinal suffixes like `the 2nd`.

The file also includes small helpers for spawn-depth accounting and metadata lookup/update, including clearing `last_task_message` when encrypted communication replaces plaintext task text.

#### Function details

##### `format_agent_nickname`  (lines 44–61)

```
fn format_agent_nickname(name: &str, nickname_reset_count: usize) -> String
```

**Purpose**: Formats a base nickname, optionally appending an ordinal reset suffix when the nickname pool has been recycled. It produces names like `Atlas`, `Atlas the 2nd`, or `Atlas the 11th`.

**Data flow**: Takes `name: &str` and `nickname_reset_count: usize`. If the reset count is 0 it returns `name.to_string()`. Otherwise it computes `value = reset_count + 1`, derives the ordinal suffix with special handling for 11–13, formats `"{name} the {value}{suffix}"`, and returns the new `String`.

**Call relations**: This helper is used by `AgentRegistry::reserve_agent_nickname` when generating candidate nicknames before and after pool resets.

*Call graph*: called by 1 (reserve_agent_nickname); 1 external calls (format!).


##### `session_depth`  (lines 63–69)

```
fn session_depth(session_source: &SessionSource) -> i32
```

**Purpose**: Extracts the current spawn depth from a `SessionSource`. Non-thread-spawn sources are treated as depth 0.

**Data flow**: Pattern-matches `&SessionSource`; for `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { depth, .. })` it returns that depth, for other subagent variants and non-subagent sources it returns 0.

**Call relations**: This helper is used only by `next_thread_spawn_depth`.

*Call graph*: called by 1 (next_thread_spawn_depth).


##### `next_thread_spawn_depth`  (lines 71–73)

```
fn next_thread_spawn_depth(session_source: &SessionSource) -> i32
```

**Purpose**: Computes the child spawn depth for a new thread relative to an existing session source. It saturates upward from the current depth.

**Data flow**: Accepts `&SessionSource`, calls `session_depth(session_source)`, applies `saturating_add(1)`, and returns the resulting `i32`.

**Call relations**: This helper wraps `session_depth` for callers that need the next child depth rather than the current one.

*Call graph*: calls 1 internal fn (session_depth).


##### `exceeds_thread_spawn_depth_limit`  (lines 75–77)

```
fn exceeds_thread_spawn_depth_limit(depth: i32, max_depth: i32) -> bool
```

**Purpose**: Checks whether a proposed spawn depth is beyond the configured maximum. It is a simple policy predicate.

**Data flow**: Takes `depth: i32` and `max_depth: i32`, compares `depth > max_depth`, and returns the boolean result.

**Call relations**: This standalone helper is available to spawn logic elsewhere in the subsystem.


##### `AgentRegistry::reserve_spawn_slot`  (lines 80–97)

```
fn reserve_spawn_slot(
        self: &Arc<Self>,
        max_threads: Option<usize>,
    ) -> Result<SpawnReservation>
```

**Purpose**: Claims one session-level spawn slot and returns an RAII reservation object that can later reserve nickname/path metadata and commit the final agent. It enforces the optional max-thread limit atomically across all control clones.

**Data flow**: Consumes `self: &Arc<Self>` and `Option<usize>` for `max_threads`. If a limit is present it calls `try_increment_spawned(max_threads)` and returns `Err(CodexErr::AgentLimitReached { max_threads })` on failure; otherwise it increments `total_count` unconditionally with `fetch_add`. On success it returns `SpawnReservation { state: Arc::clone(self), active: true, reserved_agent_nickname: None, reserved_agent_path: None }`.

**Call relations**: Spawn and resume paths call this before creating or restoring a thread. It delegates bounded counting to `try_increment_spawned`; later cleanup or finalization happens through `SpawnReservation::drop` or `SpawnReservation::commit`.

*Call graph*: calls 1 internal fn (try_increment_spawned); 2 external calls (clone, fetch_add).


##### `AgentRegistry::release_spawned_thread`  (lines 99–119)

```
fn release_spawned_thread(&self, thread_id: ThreadId)
```

**Purpose**: Removes a committed agent entry by thread ID and decrements the counted thread total for non-root agents. It is the teardown counterpart to spawn-slot commit.

**Data flow**: Takes a `thread_id`, locks `active_agents`, searches `agent_tree` for a metadata entry whose `agent_id == Some(thread_id)`, removes that entry if found, and determines whether it represented a counted non-root agent. If so, it decrements `total_count` with `fetch_sub(1, Ordering::AcqRel)`. It returns no value.

**Call relations**: Shutdown paths call this after removing a thread from the manager. It works directly on registry state and does not delegate to other file-local helpers.

*Call graph*: 1 external calls (fetch_sub).


##### `AgentRegistry::register_root_thread`  (lines 121–134)

```
fn register_root_thread(&self, thread_id: ThreadId)
```

**Purpose**: Registers the root agent path for a session if it is not already present. This anchors the agent tree at `/root` with the given thread ID.

**Data flow**: Locks `active_agents`, inserts an `AgentMetadata` with `agent_id: Some(thread_id)` and `agent_path: Some(AgentPath::root())` under the key `AgentPath::ROOT.to_string()` if that entry is currently absent, and returns no value.

**Call relations**: This is used when establishing the session root. It does not overwrite an existing root entry.


##### `AgentRegistry::agent_id_for_path`  (lines 136–143)

```
fn agent_id_for_path(&self, agent_path: &AgentPath) -> Option<ThreadId>
```

**Purpose**: Looks up the live thread ID currently associated with a given agent path. It returns `None` for unknown paths or placeholder path reservations without a committed thread.

**Data flow**: Locks `active_agents`, indexes `agent_tree` by `agent_path.as_str()`, extracts `metadata.agent_id`, and returns `Option<ThreadId>`.

**Call relations**: Control logic uses this to resolve path-based agent references into thread IDs.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentRegistry::agent_metadata_for_thread`  (lines 145–153)

```
fn agent_metadata_for_thread(&self, thread_id: ThreadId) -> Option<AgentMetadata>
```

**Purpose**: Finds and clones the metadata record for a given thread ID. It supports later inspection of path, nickname, role, and last task message.

**Data flow**: Locks `active_agents`, scans `agent_tree.values()` for a metadata entry whose `agent_id == Some(thread_id)`, clones that `AgentMetadata`, and returns it as an `Option`.

**Call relations**: This is used by control logic and tests when they need metadata keyed by thread ID rather than path.


##### `AgentRegistry::live_agents`  (lines 155–167)

```
fn live_agents(&self) -> Vec<AgentMetadata>
```

**Purpose**: Returns the set of currently committed non-root agents. It filters out the root entry and any placeholder reservations without a thread ID.

**Data flow**: Locks `active_agents`, iterates `agent_tree.values()`, filters to metadata with `agent_id.is_some()` and `agent_path` not equal to root, clones the remaining metadata entries, collects them into a `Vec<AgentMetadata>`, and returns it.

**Call relations**: This provides a snapshot view of active child agents for callers that need to enumerate them.


##### `AgentRegistry::update_last_task_message`  (lines 169–181)

```
fn update_last_task_message(&self, thread_id: ThreadId, last_task_message: String)
```

**Purpose**: Stores the latest plaintext task message for a committed agent thread. This metadata can later be surfaced or cleared when encrypted communication replaces it.

**Data flow**: Takes `thread_id` and `last_task_message: String`, locks `active_agents`, finds the metadata entry whose `agent_id == Some(thread_id)`, and writes `Some(last_task_message)` into `metadata.last_task_message`. It returns no value.

**Call relations**: Control logic calls this when a child receives a plaintext task. The complementary clearing path is `clear_last_task_message`.


##### `AgentRegistry::clear_last_task_message`  (lines 183–195)

```
fn clear_last_task_message(&self, thread_id: ThreadId)
```

**Purpose**: Removes any stored plaintext task message for a committed agent thread. This is used when task content should no longer be retained in metadata.

**Data flow**: Takes `thread_id`, locks `active_agents`, finds the matching metadata entry by `agent_id`, and sets `metadata.last_task_message = None`. It returns no value.

**Call relations**: Control logic uses this when encrypted inter-agent communication supersedes a previously stored plaintext task.


##### `AgentRegistry::register_spawned_thread`  (lines 197–214)

```
fn register_spawned_thread(&self, agent_metadata: AgentMetadata)
```

**Purpose**: Commits final metadata for a newly spawned or resumed thread into the registry. It also records the chosen nickname as used.

**Data flow**: Consumes an `AgentMetadata`. If `agent_metadata.agent_id` is `None`, it returns early. Otherwise it locks `active_agents`, derives the map key from `agent_path.to_string()` or `format!("thread:{thread_id}")`, inserts `agent_nickname` into `used_agent_nicknames` if present, and stores the metadata in `agent_tree` under that key.

**Call relations**: This is called by `SpawnReservation::commit` after a spawn or resume succeeds.


##### `AgentRegistry::reserve_agent_nickname`  (lines 216–254)

```
fn reserve_agent_nickname(&self, names: &[&str], preferred: Option<&str>) -> Option<String>
```

**Purpose**: Allocates a unique nickname for a pending agent, either honoring a preferred nickname or choosing randomly from the available pool. When the pool is exhausted, it resets nickname usage and starts reusing names with ordinal suffixes.

**Data flow**: Accepts a slice of base names and an optional preferred nickname, locks `active_agents`, and either returns the preferred string directly or builds `available_names` by formatting each base name with `format_agent_nickname` and filtering out names already in `used_agent_nicknames`. If any are available it chooses one randomly with `choose(&mut rand::rng())`; otherwise it clears `used_agent_nicknames`, increments `nickname_reset_count`, emits the `codex.multi_agent.nickname_pool_reset` metric if telemetry is available, chooses a random base name, formats it with the new reset count, inserts the chosen nickname into `used_agent_nicknames`, and returns `Some(nickname)`. If the input name list is empty, it returns `None`.

**Call relations**: This internal allocator is used by `SpawnReservation::reserve_agent_nickname_with_preference`. It delegates suffix formatting to `format_agent_nickname`.

*Call graph*: calls 1 internal fn (format_agent_nickname); 2 external calls (global, rng).


##### `AgentRegistry::reserve_agent_path`  (lines 256–273)

```
fn reserve_agent_path(&self, agent_path: &AgentPath) -> Result<()>
```

**Purpose**: Reserves an agent path before a thread is committed, preventing duplicate path allocation during concurrent spawns. It inserts a placeholder metadata entry with no thread ID.

**Data flow**: Takes `&AgentPath`, locks `active_agents`, and matches on `agent_tree.entry(agent_path.to_string())`. If occupied, it returns `Err(CodexErr::UnsupportedOperation(format!("agent path `{agent_path}` already exists")))`; if vacant, it inserts `AgentMetadata { agent_path: Some(agent_path.clone()), ..Default::default() }` and returns `Ok(())`.

**Call relations**: This internal method is called by `SpawnReservation::reserve_agent_path` during spawn preparation. Placeholder cleanup is handled by `release_reserved_agent_path` if the reservation is dropped.

*Call graph*: 5 external calls (default, format!, clone, to_string, UnsupportedOperation).


##### `AgentRegistry::release_reserved_agent_path`  (lines 275–287)

```
fn release_reserved_agent_path(&self, agent_path: &AgentPath)
```

**Purpose**: Removes a placeholder path reservation if it was never committed to a real thread. It leaves committed path entries intact.

**Data flow**: Takes `&AgentPath`, locks `active_agents`, checks whether `agent_tree.get(agent_path.as_str())` exists and has `agent_id.is_none()`, and if so removes that entry. It returns no value.

**Call relations**: This is called from `SpawnReservation::drop` when a reservation with a reserved path is abandoned.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentRegistry::try_increment_spawned`  (lines 289–305)

```
fn try_increment_spawned(&self, max_threads: usize) -> bool
```

**Purpose**: Atomically increments the counted thread total only if it is still below the configured maximum. It provides lock-free limit enforcement shared across all control clones.

**Data flow**: Reads `self.total_count` with `load(Ordering::Acquire)`, then loops: if `current >= max_threads` it returns `false`; otherwise it attempts `compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire)`. On success it returns `true`; on failure it retries with the updated observed count.

**Call relations**: This helper is called only by `AgentRegistry::reserve_spawn_slot` when a bounded max-thread limit is in effect.

*Call graph*: called by 1 (reserve_spawn_slot); 2 external calls (compare_exchange_weak, load).


##### `SpawnReservation::reserve_agent_nickname_with_preference`  (lines 316–329)

```
fn reserve_agent_nickname_with_preference(
        &mut self,
        names: &[&str],
        preferred: Option<&str>,
    ) -> Result<String>
```

**Purpose**: Reserves a nickname for the pending spawn and remembers it inside the reservation so the caller can include it in final metadata. It converts an empty nickname pool into a user-facing unsupported-operation error.

**Data flow**: Takes mutable `self`, a slice of candidate names, and an optional preferred nickname. It calls `self.state.reserve_agent_nickname(names, preferred)`, converts `None` into `CodexErr::UnsupportedOperation("no available agent nicknames")`, stores the chosen nickname in `self.reserved_agent_nickname`, and returns the nickname string.

**Call relations**: Spawn preparation code calls this while assembling thread-spawn metadata. It delegates actual allocation to `AgentRegistry::reserve_agent_nickname`.

*Call graph*: called by 1 (prepare_thread_spawn).


##### `SpawnReservation::reserve_agent_path`  (lines 331–335)

```
fn reserve_agent_path(&mut self, agent_path: &AgentPath) -> Result<()>
```

**Purpose**: Reserves an agent path for the pending spawn and records that reservation for later cleanup if the spawn fails. It is the reservation-layer wrapper over the registry’s path placeholder insertion.

**Data flow**: Takes mutable `self` and `&AgentPath`, calls `self.state.reserve_agent_path(agent_path)?`, stores `Some(agent_path.clone())` in `self.reserved_agent_path`, and returns `Ok(())`.

**Call relations**: This is called by spawn preparation before thread creation. If the reservation is later dropped without commit, `SpawnReservation::drop` will release the placeholder path.

*Call graph*: called by 1 (prepare_thread_spawn); 1 external calls (clone).


##### `SpawnReservation::commit`  (lines 337–342)

```
fn commit(mut self, agent_metadata: AgentMetadata)
```

**Purpose**: Finalizes a pending spawn reservation after thread creation succeeds. It clears provisional reservation fields, registers the committed metadata, and disables drop cleanup.

**Data flow**: Consumes `self` mutably and an `AgentMetadata`, sets `reserved_agent_nickname` and `reserved_agent_path` to `None`, calls `self.state.register_spawned_thread(agent_metadata)`, sets `self.active = false`, and returns no value.

**Call relations**: Spawn and resume orchestration call this after they know the final thread ID and metadata. It delegates registry insertion to `AgentRegistry::register_spawned_thread`.


##### `SpawnReservation::drop`  (lines 346–353)

```
fn drop(&mut self)
```

**Purpose**: Cleans up an abandoned spawn reservation by releasing any reserved path placeholder and decrementing the counted thread total. This prevents leaked capacity and stale path claims on failed spawns.

**Data flow**: Reads `self.active`; if true, it takes `self.reserved_agent_path` and passes it to `self.state.release_reserved_agent_path`, then decrements `self.state.total_count` with `fetch_sub(1, Ordering::AcqRel)`. It returns no value.

**Call relations**: This runs implicitly when a `SpawnReservation` is dropped without `commit`. It is the failure-path counterpart to `SpawnReservation::commit`.


### `core/src/context/inter_agent_completion_message.rs`

`domain_logic` · `multi-agent coordination`

This file defines `InterAgentCompletionMessage`, a small prompt fragment used to serialize one agent’s final answer for another agent or coordinator. The struct stores three fields: `task_name` and `sender`, both typed as `codex_protocol::AgentPath`, and a free-form `payload` string. The constructor accepts the payload as any `Into<String>`, making it easy to pass either borrowed or owned text.

As a `ContextualUserFragment`, the message is emitted with role `assistant`, not `user` or `developer`, reflecting that it represents assistant-produced content in an inter-agent exchange. Like several instruction-style fragments, it uses empty markers, so the body is inserted directly rather than wrapped in XML-like tags. The body format is fixed and line-oriented: it begins with `Message Type: FINAL_ANSWER`, then includes `Task name`, `Sender`, and a `Payload:` header followed by the raw payload text. This explicit textual schema makes the message easy for downstream prompt consumers to parse semantically without requiring a separate structured protocol object inside the transcript.

#### Function details

##### `InterAgentCompletionMessage::new`  (lines 13–19)

```
fn new(task_name: AgentPath, sender: AgentPath, payload: impl Into<String>) -> Self
```

**Purpose**: Constructs a completion message from a task path, sender path, and payload text. It stores the payload as owned text while preserving the typed agent-path fields.

**Data flow**: It takes `task_name: AgentPath`, `sender: AgentPath`, and `payload: impl Into<String>`, converts the payload with `payload.into()`, stores all three fields in `Self`, and returns the new `InterAgentCompletionMessage`.

**Call relations**: This constructor is used by higher-level formatting code that prepares final-answer messages for inter-agent communication.

*Call graph*: called by 1 (format_inter_agent_completion_message); 1 external calls (into).


##### `InterAgentCompletionMessage::role`  (lines 23–25)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that the fragment should be inserted as assistant-role content. This matches the semantics of one agent delivering a final answer.

**Data flow**: It takes `&self` and returns the static string `"assistant"`.

**Call relations**: This trait method is consumed by generic prompt assembly code when placing the message into the transcript.


##### `InterAgentCompletionMessage::markers`  (lines 27–29)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns empty wrapper markers so the completion message is emitted as plain text. No XML-like envelope surrounds the formatted body.

**Data flow**: It takes `&self`, calls `Self::type_markers()`, and returns the empty-string pair.

**Call relations**: This method fulfills the `ContextualUserFragment` trait and delegates marker definition to the type-level function.

*Call graph*: 1 external calls (type_markers).


##### `InterAgentCompletionMessage::type_markers`  (lines 31–33)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that this fragment has no opening or closing markers. The line-oriented body text is the entire serialized form.

**Data flow**: It returns `("", "")` directly.

**Call relations**: This static marker definition is used by `markers` and by any generic code that needs the fragment’s canonical wrapping behavior.


##### `InterAgentCompletionMessage::body`  (lines 35–40)

```
fn body(&self) -> String
```

**Purpose**: Formats the completion message into a fixed textual schema containing message type, task name, sender, and payload. It is the human- and model-readable serialization of the struct.

**Data flow**: It reads `self.task_name`, `self.sender`, and `self.payload`, interpolates them into a multiline `format!` string, and returns the resulting `String`.

**Call relations**: This trait method is called during prompt assembly to turn the typed completion message into transcript text for downstream agents or coordinators.

*Call graph*: 1 external calls (format!).


### `core/src/session_prefix.rs`

`util` · `cross-cutting, when synthesizing multi-agent context/history messages`

This file contains small formatting helpers for synthetic user-role messages inserted into conversation history to describe multi-agent state. The constants at the top define a strict token budget for completion messages: `COMPLETION_MESSAGE_MAX_TOKENS` is 1000, `COMPLETION_MESSAGE_ENVELOPE_TOKEN_RESERVE` reserves 100 tokens for wrapper text, and `ERROR_MAX_TOKENS` limits the embedded error body accordingly. `ERROR_NEXT_ACTION` is the fixed remediation sentence appended to errored-agent completions.

`format_subagent_notification_message` wraps an agent reference and `AgentStatus` in a `SubagentNotification` and renders it. `format_inter_agent_completion_message` is more nuanced: it maps terminal `AgentStatus` variants into payload text, returns `None` for nonterminal states (`PendingInit`, `Running`, `Interrupted`), and for `Errored` statuses truncates the raw error string with `truncate_text(..., TruncationPolicy::Tokens(ERROR_MAX_TOKENS))` before appending the next-action guidance. The final payload is wrapped in `InterAgentCompletionMessage` and rendered. `format_subagent_context_line` produces a compact bullet line for listing subagents, including an optional nickname only when it is present and non-empty. Together these helpers ensure multi-agent state markers are concise, bounded, and consistently phrased.

#### Function details

##### `format_subagent_notification_message`  (lines 20–25)

```
fn format_subagent_notification_message(
    agent_reference: &str,
    status: &AgentStatus,
) -> String
```

**Purpose**: Formats a subagent status update into the rendered notification string stored in session context. It preserves the provided agent reference and clones the status into the notification object.

**Data flow**: It takes `agent_reference: &str` and `status: &AgentStatus`, constructs `SubagentNotification::new(agent_reference, status.clone())`, renders it, and returns the resulting `String`.

**Call relations**: Called by completion-watcher logic when a subagent status change needs to be recorded as a model-visible notification.

*Call graph*: calls 1 internal fn (new); called by 1 (maybe_start_completion_watcher); 1 external calls (clone).


##### `format_inter_agent_completion_message`  (lines 27–44)

```
fn format_inter_agent_completion_message(
    task_name: AgentPath,
    sender: AgentPath,
    status: &AgentStatus,
) -> Option<String>
```

**Purpose**: Builds the rendered completion message sent from one agent to another when a child agent reaches a terminal state. It suppresses nonterminal statuses and truncates large error payloads to stay within a fixed token budget.

**Data flow**: Inputs are `task_name: AgentPath`, `sender: AgentPath`, and `&AgentStatus`. It pattern matches the status: completed statuses yield the optional completion message or an empty string, errored status yields a truncated error plus `ERROR_NEXT_ACTION`, shutdown/not-found yield fixed strings, and pending/running/interrupted return `None`. For terminal cases it wraps the payload in `InterAgentCompletionMessage::new(task_name, sender, payload)`, renders it, and returns `Some(String)`.

**Call relations**: Used by completion-forwarding and watcher code whenever a child agent's terminal status should be queued to its parent. It delegates truncation to `truncate_text` with a token-based policy.

*Call graph*: calls 1 internal fn (new); called by 4 (maybe_start_completion_watcher, multi_agent_v2_completion_queues_message_for_direct_parent, forward_child_completion_to_parent, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn); 4 external calls (new, truncate_text, format!, Tokens).


##### `format_subagent_context_line`  (lines 50–58)

```
fn format_subagent_context_line(
    agent_reference: &str,
    agent_nickname: Option<&str>,
) -> String
```

**Purpose**: Formats one bullet line describing a subagent for inclusion in context text. If a non-empty nickname is present it is appended after the agent reference.

**Data flow**: It takes `agent_reference` and optional `agent_nickname`. It filters out empty nicknames, then returns either `"- {agent_reference}: {agent_nickname}"` or `"- {agent_reference}"`.

**Call relations**: Used by callers that build human-readable subagent listings in prompts or context fragments.

*Call graph*: 1 external calls (format!).


### `core/src/agent/control/execution.rs`

`domain_logic` · `request handling`

This file adds a narrow concurrency-control layer on top of `AgentControl`. The central state is `AgentExecutionLimiter`, which stores an `active` execution count in an `AtomicUsize` and a one-time-configured `max_threads` in a `OnceLock<usize>`. The limiter is intentionally selective: only Multi-Agent V2 sessions whose `SessionSource` is `SubAgent(_)` are counted. Root sessions and V1 sessions bypass the limit entirely.

`AgentControl::ensure_execution_capacity_for_op` is the higher-level check used before submitting an operation. It first filters to operations that actually begin a turn: `Op::UserInput` and `Op::InterAgentCommunication` with `trigger_turn = true`. It then loads the thread, skips enforcement if that thread already has an `active_turn`, derives the effective `MultiAgentVersion` from the thread or config, and delegates to the synchronous capacity check. That means mailbox-style inter-agent messages that do not trigger a turn do not consume execution capacity.

When execution should be counted, `AgentControl::execution_guard` clones the shared limiter and increments `active` by constructing an `AgentExecutionGuard`. The guard’s `Drop` implementation decrements the counter, so callers do not need explicit cleanup paths. A notable design choice is that `initialize` uses `get_or_init`, so the first configured limit wins and later attempts to change it are ignored. If the limiter was never initialized, `max_threads()` falls back to `usize::MAX`, effectively disabling the cap.

#### Function details

##### `AgentExecutionGuard::drop`  (lines 24–26)

```
fn drop(&mut self)
```

**Purpose**: Releases one counted execution slot when a guard goes out of scope. This is the cleanup mechanism that keeps the active-turn count accurate even on early returns or errors.

**Data flow**: Reads `self.limiter`, then atomically decrements its `active` counter with `fetch_sub(1, Ordering::AcqRel)`. It returns no value and mutates only the shared limiter state.

**Call relations**: This runs implicitly whenever a guard produced by `AgentControl::execution_guard` or `AgentExecutionLimiter::guard` is dropped. It is the terminal step in the counted-execution lifecycle and does not delegate further.


##### `AgentControl::ensure_execution_capacity_for_op`  (lines 30–48)

```
async fn ensure_execution_capacity_for_op(
        &self,
        thread_id: ThreadId,
        op: &Op,
    ) -> CodexResult<()>
```

**Purpose**: Checks whether a specific incoming `Op` would start a new counted turn and rejects it if the V2 subagent execution cap is already full. It avoids charging capacity for operations that do not begin work or for threads already in an active turn.

**Data flow**: Consumes `&self`, a `ThreadId`, and `&Op`. It first inspects the op via `op_starts_turn`; if false, it returns `Ok(())`. Otherwise it upgrades the control to live manager state, asynchronously loads the thread, reads `thread.codex.session.active_turn`, fetches session config, derives `MultiAgentVersion` from thread metadata or config features, and passes version plus `thread.session_source` into `ensure_execution_capacity`. It returns `Ok(())` on success or a `CodexErr`, typically `AgentLimitReached`, on failure.

**Call relations**: This is the op-aware front door for execution limiting. It invokes `op_starts_turn` to decide whether enforcement applies, then delegates the actual policy decision to `AgentControl::ensure_execution_capacity` after gathering thread state and configuration.

*Call graph*: calls 2 internal fn (ensure_execution_capacity, op_starts_turn).


##### `AgentControl::ensure_execution_capacity`  (lines 50–64)

```
fn ensure_execution_capacity(
        &self,
        multi_agent_version: MultiAgentVersion,
        session_source: &SessionSource,
    ) -> CodexResult<()>
```

**Purpose**: Performs the actual synchronous capacity check for a given multi-agent version and session source. It returns an `AgentLimitReached` error only for counted V2 subagent executions when the limiter is full.

**Data flow**: Takes `MultiAgentVersion` and `&SessionSource`. It reads the policy predicate from `is_execution_limited`; if limiting does not apply, it returns `Ok(())`. Otherwise it reads the configured maximum from `self.agent_execution_limiter.max_threads()` and current occupancy via `has_capacity()`. It returns `Ok(())` if capacity remains, else `Err(CodexErr::AgentLimitReached { max_threads })`.

**Call relations**: This function is called by `AgentControl::ensure_execution_capacity_for_op` after that method determines an op would start a fresh turn. It delegates only to `is_execution_limited` for the policy gate and otherwise works directly against the limiter.

*Call graph*: calls 1 internal fn (is_execution_limited); called by 1 (ensure_execution_capacity_for_op).


##### `AgentControl::execution_guard`  (lines 66–73)

```
fn execution_guard(
        &self,
        multi_agent_version: MultiAgentVersion,
        session_source: &SessionSource,
    ) -> Option<AgentExecutionGuard>
```

**Purpose**: Creates a counting guard for executions that should consume one active V2 subagent slot. For non-limited sessions it returns `None`, so callers can skip bookkeeping entirely.

**Data flow**: Accepts `MultiAgentVersion` and `&SessionSource`. It evaluates `is_execution_limited`; when true it clones `self.agent_execution_limiter`, calls `guard()` on the cloned `Arc`, and wraps the result in `Some`. When false it returns `None`. The side effect, when present, is incrementing the limiter’s `active` count.

**Call relations**: This is the companion to `ensure_execution_capacity`: callers use it after deciding work should be counted. It relies on `is_execution_limited` to mirror the same policy boundary and delegates guard creation to `AgentExecutionLimiter::guard`.

*Call graph*: calls 1 internal fn (is_execution_limited).


##### `AgentExecutionLimiter::initialize`  (lines 77–79)

```
fn initialize(&self, max_threads: usize)
```

**Purpose**: Sets the maximum allowed counted executions exactly once. It preserves the first configured limit and ignores later attempts to overwrite it.

**Data flow**: Takes `max_threads: usize` and writes it into `self.max_threads` through `OnceLock::get_or_init`. It returns no value; if the lock was already initialized, state remains unchanged.

**Call relations**: This is setup-time configuration for the limiter, used before runtime checks begin. It delegates storage semantics to `OnceLock::get_or_init` and is validated by the execution tests that confirm reinitialization does not replace the original cap.

*Call graph*: 1 external calls (get_or_init).


##### `AgentExecutionLimiter::max_threads`  (lines 81–83)

```
fn max_threads(&self) -> usize
```

**Purpose**: Reads the configured execution cap, defaulting to no practical limit when the limiter has not been initialized. This keeps capacity checks safe before configuration is wired in.

**Data flow**: Reads `self.max_threads` via `get()`, copies the stored `usize` if present, and otherwise returns `usize::MAX`. It does not mutate state.

**Call relations**: This helper is used by `AgentExecutionLimiter::has_capacity` and by `AgentControl::ensure_execution_capacity` when constructing an `AgentLimitReached` error payload.

*Call graph*: called by 1 (has_capacity); 1 external calls (get).


##### `AgentExecutionLimiter::has_capacity`  (lines 85–87)

```
fn has_capacity(&self) -> bool
```

**Purpose**: Compares the current active execution count against the configured maximum. It is the low-level occupancy test behind the public capacity check.

**Data flow**: Reads `self.active` with `load(Ordering::Acquire)` and compares it to `self.max_threads()`. It returns `true` when `active < max_threads`, otherwise `false`, without mutating state.

**Call relations**: This is called from `AgentControl::ensure_execution_capacity` after the policy says a session should be limited. It delegates the threshold lookup to `max_threads`.

*Call graph*: calls 1 internal fn (max_threads); 1 external calls (load).


##### `AgentExecutionLimiter::guard`  (lines 89–92)

```
fn guard(self: Arc<Self>) -> AgentExecutionGuard
```

**Purpose**: Claims one active execution slot and returns an RAII guard tied to the shared limiter. The returned guard is responsible for releasing the slot on drop.

**Data flow**: Consumes `self: Arc<Self>`, atomically increments `active` with `fetch_add(1, Ordering::AcqRel)`, and returns `AgentExecutionGuard { limiter: self }`. The mutation is the incremented active count.

**Call relations**: This is invoked by `AgentControl::execution_guard` only when `is_execution_limited` says the session should be counted. Its output later triggers `AgentExecutionGuard::drop` to undo the increment.

*Call graph*: 1 external calls (fetch_add).


##### `op_starts_turn`  (lines 95–98)

```
fn op_starts_turn(op: &Op) -> bool
```

**Purpose**: Identifies which protocol operations should be treated as starting a new turn for execution-capacity purposes. It distinguishes turn-triggering work from queued or metadata-only traffic.

**Data flow**: Reads `&Op` and pattern-matches it. It returns `true` for `Op::UserInput { .. }` and for `Op::InterAgentCommunication { communication }` when `communication.trigger_turn` is true; otherwise it returns `false`.

**Call relations**: This predicate is used by `AgentControl::ensure_execution_capacity_for_op` as the first filter before any thread lookup or limiter check occurs.

*Call graph*: called by 1 (ensure_execution_capacity_for_op); 1 external calls (matches!).


##### `is_execution_limited`  (lines 100–106)

```
fn is_execution_limited(
    multi_agent_version: MultiAgentVersion,
    session_source: &SessionSource,
) -> bool
```

**Purpose**: Encodes the policy boundary for execution counting: only V2 subagent sessions are limited. It centralizes the condition so capacity checks and guard creation stay consistent.

**Data flow**: Consumes a `MultiAgentVersion` and `&SessionSource`, compares the version to `MultiAgentVersion::V2`, pattern-matches the source against `SessionSource::SubAgent(_)`, and returns a boolean. It does not mutate state.

**Call relations**: Both `AgentControl::ensure_execution_capacity` and `AgentControl::execution_guard` call this helper so they apply the same inclusion rule for counted executions.

*Call graph*: called by 2 (ensure_execution_capacity, execution_guard); 1 external calls (matches!).


### `core/src/agent/control/residency.rs`

`domain_logic` · `spawn/resume and thread reload`

This file implements the in-memory residency policy for Multi-Agent V2 subagents. `V2Residency` wraps a `Mutex<V2ResidencyState>` containing an LRU-style `VecDeque<ThreadId>` of resident threads plus a `pending_slots` counter. The pending count is important: it reserves capacity for threads that are in the middle of being spawned or resumed but do not yet have a committed thread ID in the resident deque.

`AgentControl::reserve_v2_residency_slot` computes the V2 capacity from `Config::effective_agent_max_threads(MultiAgentVersion::V2)`, defaulting to `usize::MAX`, and asks the shared residency tracker for a slot. `V2Residency::reserve_slot` loops until either `try_reserve_pending_slot` succeeds or `try_unload_one_resident` fails, in which case it returns `CodexErr::AgentLimitReached`. Eviction scans the current resident count, pops LRU candidates while skipping an optional protected thread, reloads each candidate from `ThreadManagerState`, and only unloads threads that are still valid resident candidates and satisfy `is_unloadable`: terminal `AgentStatus` (`Completed`, `Errored`, or `Interrupted`), no `active_turn`, and no pending mailbox items. Non-unloadable or failed-shutdown candidates are touched back to the MRU end.

`V2ResidencySlot` is an RAII reservation. `commit(thread_id)` converts a pending slot into a resident entry and disables drop cleanup; dropping an uncommitted slot decrements `pending_slots`. The helper predicates deliberately restrict residency to V2 `SessionSource::SubAgent(_)` threads, and `touch_loaded_v2_residency` updates recency only for already-loaded threads that still qualify.

#### Function details

##### `V2ResidencySlot::commit`  (lines 33–36)

```
fn commit(mut self, thread_id: ThreadId)
```

**Purpose**: Finalizes a pending residency reservation by associating it with a concrete thread ID and marking the slot as no longer pending. This converts provisional capacity into an actual resident entry.

**Data flow**: Consumes `self` mutably and a `thread_id`. It calls `self.residency.commit_slot(thread_id)` to decrement `pending_slots` and touch the resident deque, then sets `self.active = false`. It returns no value.

**Call relations**: This is called by spawn and reload paths after a thread has been successfully created or resumed. It prevents the slot’s `Drop` implementation from releasing the reservation as if creation had failed.


##### `V2ResidencySlot::drop`  (lines 40–44)

```
fn drop(&mut self)
```

**Purpose**: Releases an uncommitted pending residency reservation when slot ownership is dropped early. It ensures failed or abandoned spawn/resume attempts do not leak capacity.

**Data flow**: Reads `self.active`; if true, it calls `self.residency.release_pending_slot()`. It returns no value and mutates only the shared residency state.

**Call relations**: This runs implicitly when a `V2ResidencySlot` falls out of scope without `commit`. It is the cleanup counterpart to `V2ResidencySlot::commit`.


##### `AgentControl::reserve_v2_residency_slot`  (lines 48–60)

```
async fn reserve_v2_residency_slot(
        &self,
        state: &Arc<ThreadManagerState>,
        config: &Config,
        protected_thread_id: Option<ThreadId>,
    ) -> CodexResult<V2ResidencySlot
```

**Purpose**: Reserves capacity for a V2 resident thread before it is loaded or spawned. It translates configuration into a numeric capacity and delegates the actual reservation/eviction logic to `V2Residency`.

**Data flow**: Takes `&Arc<ThreadManagerState>`, `&Config`, and an optional protected thread ID. It reads `config.effective_agent_max_threads(MultiAgentVersion::V2)`, substitutes `usize::MAX` when absent, clones `self.v2_residency`, and awaits `reserve_slot(state, capacity, protected_thread_id)`. It returns a `CodexResult<V2ResidencySlot>`.

**Call relations**: This method is used by V2 spawn and reload flows before they create or restore a thread. It delegates all capacity enforcement and possible eviction to `V2Residency::reserve_slot`.

*Call graph*: 2 external calls (clone, effective_agent_max_threads).


##### `AgentControl::touch_loaded_v2_residency`  (lines 62–72)

```
async fn touch_loaded_v2_residency(
        &self,
        state: &Arc<ThreadManagerState>,
        thread_id: ThreadId,
    )
```

**Purpose**: Marks an already-loaded V2 resident thread as recently used so it is less likely to be evicted next. It ignores threads that are absent or no longer qualify as resident candidates.

**Data flow**: Accepts manager state and a `thread_id`, asynchronously loads the thread with `state.get_thread(thread_id).await`, checks `is_resident_candidate(thread.as_ref())`, and if true calls `self.v2_residency.touch(thread_id)`. It returns no value.

**Call relations**: This is used by reload logic after confirming a thread is already loaded, and by race-handling paths that discover another task loaded the thread first. It delegates candidate filtering to `is_resident_candidate`.

*Call graph*: calls 1 internal fn (is_resident_candidate).


##### `AgentControl::forget_v2_residency`  (lines 74–76)

```
fn forget_v2_residency(&self, thread_id: ThreadId)
```

**Purpose**: Removes a thread ID from the residency LRU set when the thread is being torn down or forgotten. This prevents stale resident entries from occupying eviction bookkeeping.

**Data flow**: Takes a `thread_id` and forwards it to `self.v2_residency.remove(thread_id)`. It returns no value and mutates the residency deque.

**Call relations**: This is called from shutdown paths when a thread is removed from memory. It is a thin forwarding method over `V2Residency::remove`.


##### `V2Residency::reserve_slot`  (lines 80–102)

```
async fn reserve_slot(
        self: Arc<Self>,
        manager: &Arc<ThreadManagerState>,
        capacity: usize,
        protected_thread_id: Option<ThreadId>,
    ) -> CodexResult<V2ResidencySlot>
```

**Purpose**: Obtains a pending residency slot, evicting unloadable residents if necessary until capacity becomes available. It is the core loop that enforces the V2 loaded-thread cap.

**Data flow**: Consumes `self: Arc<Self>`, a thread manager, numeric `capacity`, and an optional protected thread ID. In a loop it first calls `try_reserve_pending_slot(capacity)`; on success it returns `Ok(V2ResidencySlot { residency: self, active: true })`. If reservation fails, it awaits `try_unload_one_resident`; if no resident can be unloaded, it returns `Err(CodexErr::AgentLimitReached { max_threads: capacity })`.

**Call relations**: This is invoked by `AgentControl::reserve_v2_residency_slot`. It delegates the fast-path capacity check to `try_reserve_pending_slot` and the eviction attempt to `try_unload_one_resident`.

*Call graph*: calls 2 internal fn (try_reserve_pending_slot, try_unload_one_resident).


##### `V2Residency::try_reserve_pending_slot`  (lines 104–114)

```
fn try_reserve_pending_slot(&self, capacity: usize) -> bool
```

**Purpose**: Attempts to claim one pending slot without evicting anything. It treats both committed residents and in-flight pending slots as consuming capacity.

**Data flow**: Locks `self.state`, reads `state.residents.len()` and `state.pending_slots`, compares their saturating sum to `capacity`, and returns `false` if the limit is already reached. Otherwise it increments `state.pending_slots` and returns `true`.

**Call relations**: This is the first step inside `V2Residency::reserve_slot`. It does not delegate further and provides the cheap uncontended reservation path.

*Call graph*: called by 1 (reserve_slot).


##### `V2Residency::try_unload_one_resident`  (lines 116–150)

```
async fn try_unload_one_resident(
        &self,
        manager: &Arc<ThreadManagerState>,
        protected_thread_id: Option<ThreadId>,
    ) -> bool
```

**Purpose**: Scans resident threads in LRU order and tries to evict one unloadable candidate to free capacity. It skips protected, missing, nonresident, busy, or failed-to-shutdown threads.

**Data flow**: Reads the current resident count via `resident_count()`, then loops that many times. Each iteration pops a candidate with `pop_lru_candidate(protected_thread_id)`, reloads it from `manager.get_thread`, filters it through `is_resident_candidate`, and awaits `is_unloadable`. Non-unloadable candidates are re-touched with `touch(candidate_thread_id)`. For unloadable candidates it materializes rollout, attempts `shutdown_and_wait`, logs and re-touches on failure, and on success removes the thread from the manager and returns `true`. If no candidate can be evicted, it returns `false`.

**Call relations**: This is called by `V2Residency::reserve_slot` only after direct reservation fails. It delegates candidate selection to `pop_lru_candidate`, recency updates to `touch`, and unloadability checks to `is_unloadable`.

*Call graph*: calls 4 internal fn (pop_lru_candidate, resident_count, touch, is_unloadable); called by 1 (reserve_slot); 1 external calls (warn!).


##### `V2Residency::resident_count`  (lines 152–158)

```
fn resident_count(&self) -> usize
```

**Purpose**: Returns the number of committed resident thread IDs currently tracked. It is used to bound one eviction scan pass.

**Data flow**: Locks `self.state`, reads `residents.len()`, and returns that `usize`. It does not mutate state.

**Call relations**: This helper is used by `V2Residency::try_unload_one_resident` to avoid looping indefinitely while the deque is being rotated.

*Call graph*: called by 1 (try_unload_one_resident).


##### `V2Residency::pop_lru_candidate`  (lines 160–175)

```
fn pop_lru_candidate(&self, protected_thread_id: Option<ThreadId>) -> Option<ThreadId>
```

**Purpose**: Removes and returns the least-recently-used resident candidate, except for an optional protected thread that is rotated to the back instead of being selected. It preserves LRU ordering among the remaining entries.

**Data flow**: Locks `self.state`, computes the number of residents to scan, repeatedly pops from the front of `state.residents`, compares each ID to `protected_thread_id`, pushes protected IDs back to the rear, and returns the first unprotected ID found. If no eligible candidate exists, it returns `None`.

**Call relations**: This function is called by `V2Residency::try_unload_one_resident` during eviction scans. It does not delegate further.

*Call graph*: called by 1 (try_unload_one_resident).


##### `V2Residency::touch`  (lines 177–183)

```
fn touch(&self, thread_id: ThreadId)
```

**Purpose**: Marks a resident thread as most recently used. It removes any existing occurrence and appends the thread ID to the back of the deque.

**Data flow**: Locks `self.state` and passes `&mut state.residents` plus `thread_id` to `touch_resident`. It returns no value and mutates the resident ordering.

**Call relations**: This is used by `AgentControl::touch_loaded_v2_residency` and by eviction logic in `try_unload_one_resident` when a candidate should remain resident but move to the MRU end.

*Call graph*: calls 1 internal fn (touch_resident); called by 1 (try_unload_one_resident).


##### `V2Residency::remove`  (lines 185–191)

```
fn remove(&self, thread_id: ThreadId)
```

**Purpose**: Deletes a thread ID from the resident deque entirely. It is used when a thread is no longer loaded or should no longer participate in residency bookkeeping.

**Data flow**: Locks `self.state` and retains only resident IDs not equal to `thread_id`. It returns no value and mutates the deque in place.

**Call relations**: This is reached through `AgentControl::forget_v2_residency` from shutdown and cleanup paths.


##### `V2Residency::commit_slot`  (lines 193–200)

```
fn commit_slot(&self, thread_id: ThreadId)
```

**Purpose**: Converts one pending slot into a committed resident entry for a specific thread. It also updates recency so the committed thread becomes most recently used.

**Data flow**: Locks `self.state`, decrements `pending_slots` with `saturating_sub(1)`, then calls `touch_resident(&mut state.residents, thread_id)`. It returns no value.

**Call relations**: This is invoked by `V2ResidencySlot::commit` after successful spawn or reload. It delegates deque maintenance to `touch_resident`.

*Call graph*: calls 1 internal fn (touch_resident).


##### `V2Residency::release_pending_slot`  (lines 202–208)

```
fn release_pending_slot(&self)
```

**Purpose**: Drops one pending reservation without creating a resident entry. It is the failure/abandonment cleanup path for reserved capacity.

**Data flow**: Locks `self.state`, decrements `pending_slots` using `saturating_sub(1)`, and returns no value.

**Call relations**: This is called only from `V2ResidencySlot::drop` when a slot was never committed.


##### `touch_resident`  (lines 211–214)

```
fn touch_resident(residents: &mut VecDeque<ThreadId>, thread_id: ThreadId)
```

**Purpose**: Maintains the resident deque as an MRU list by removing duplicates and appending the touched thread ID to the back. It is the shared primitive behind both touch and commit operations.

**Data flow**: Takes `&mut VecDeque<ThreadId>` and a `thread_id`, retains only entries not equal to that ID, then pushes the ID to the back. It returns no value and mutates the deque.

**Call relations**: This helper is called by `V2Residency::touch` and `V2Residency::commit_slot` so both operations enforce the same uniqueness and ordering behavior.

*Call graph*: called by 2 (commit_slot, touch); 2 external calls (push_back, retain).


##### `is_resident_candidate`  (lines 216–219)

```
fn is_resident_candidate(thread: &CodexThread) -> bool
```

**Purpose**: Determines whether a loaded thread should participate in V2 residency tracking. Only V2 subagent threads qualify.

**Data flow**: Reads a `&CodexThread`, calls `thread.multi_agent_version()`, checks for `Some(MultiAgentVersion::V2)`, and combines that with `is_v2_resident_session_source(&thread.session_source)`. It returns a boolean.

**Call relations**: This predicate is used by `AgentControl::touch_loaded_v2_residency` and by `V2Residency::try_unload_one_resident` to ensure only eligible threads are tracked or considered for eviction.

*Call graph*: calls 2 internal fn (is_v2_resident_session_source, multi_agent_version); called by 1 (touch_loaded_v2_residency).


##### `is_v2_resident_session_source`  (lines 221–223)

```
fn is_v2_resident_session_source(session_source: &SessionSource) -> bool
```

**Purpose**: Defines which session sources are eligible for V2 residency tracking. The current rule is simply any `SessionSource::SubAgent(_)`.

**Data flow**: Pattern-matches `&SessionSource` and returns `true` for `SessionSource::SubAgent(_)`, otherwise `false`. It does not mutate state.

**Call relations**: This helper is called by `is_resident_candidate` and is also imported by spawn logic to decide whether a new V2 thread should reserve residency.

*Call graph*: called by 1 (is_resident_candidate); 1 external calls (matches!).


##### `is_unloadable`  (lines 225–236)

```
async fn is_unloadable(thread: &CodexThread) -> bool
```

**Purpose**: Checks whether a resident thread is safe to evict from memory. A thread must be terminal, have no active turn, and have no pending mailbox items.

**Data flow**: Reads a `&CodexThread`, awaits `thread.agent_status()`, matches it against `AgentStatus::Completed(_)`, `Errored(_)`, or `Interrupted`, then awaits `thread.codex.session.active_turn.lock()` and `thread.codex.session.input_queue.has_pending_mailbox_items()`. It returns `true` only if all three conditions indicate the thread is idle and terminal.

**Call relations**: This async predicate is called by `V2Residency::try_unload_one_resident` before attempting shutdown and removal of a resident candidate.

*Call graph*: called by 1 (try_unload_one_resident); 1 external calls (matches!).


### `core/src/agent/control/spawn.rs`

`orchestration` · `spawn/resume and thread reload`

This file is the core of agent lifecycle creation and restoration. It starts with nickname and fork-history helpers: `default_agent_nickname_list` loads names from `agent_names.txt`, `agent_nickname_candidates` optionally overrides them from role config, `keep_forked_rollout_item` filters which `RolloutItem`s survive into a forked child, and `is_multi_agent_v2_usage_hint_message` identifies developer hint messages that should be stripped or replaced.

`spawn_agent` and `spawn_agent_with_metadata` are thin wrappers over `spawn_agent_internal`. That internal method computes the effective `MultiAgentVersion`, enforces execution capacity for subagent sources, optionally reserves a V2 residency slot, reserves a spawn slot in the shared registry, computes inherited environments and exec policy, and normalizes `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { .. })` through `prepare_thread_spawn`. It then chooses among three creation paths: forked child via `spawn_forked_thread`, ordinary subagent via `spawn_new_thread_with_source`, or root thread via `spawn_new_thread`. After creation it commits registry and residency reservations, emits analytics for thread-spawn subagents, notifies listeners, persists spawn-edge metadata, sends the initial operation, and for non-V2 children starts a completion watcher.

`ensure_v2_agent_loaded` lazily reloads an unloaded V2 agent from stored history. It first returns early if the thread is already loaded, rejects unknown or non-V2 threads, reserves residency with the target thread protected from eviction, reconstructs `InitialHistory::Resumed`, restores inherited environments and exec policy, and resumes the thread. A race is handled explicitly: if resume fails but another task loaded the thread in the meantime, the slot is released and the thread is merely touched in residency.

`spawn_forked_thread` snapshots parent rollout history, flushing pending writes first, optionally truncates to the last N turns, strips stale parent usage hints from both top-level and compacted replacement history, preserves `TurnContext` only for full-history forks, and may append the child’s own V2 subagent usage hint. `resume_agent_from_rollout` and `resume_single_agent_from_rollout` rebuild threads from persisted rollout files, with tree resume for non-V2 descendants based on persisted open spawn edges. The tree-resume logic intentionally skips reopening V2 descendants and tolerates descendant resume failures by logging and continuing only when the parent resumed successfully.

#### Function details

##### `default_agent_nickname_list`  (lines 11–17)

```
fn default_agent_nickname_list() -> Vec<&'static str>
```

**Purpose**: Builds the default pool of agent nicknames from the embedded `agent_names.txt` file. It trims whitespace and drops blank lines.

**Data flow**: Reads the `AGENT_NAMES` string constant, splits it into lines, applies `str::trim`, filters out empty names, collects the remaining `&'static str` values into a `Vec`, and returns it.

**Call relations**: This helper is used by `agent_nickname_candidates` when no role-specific nickname list is configured.

*Call graph*: called by 1 (agent_nickname_candidates).


##### `agent_nickname_candidates`  (lines 19–31)

```
fn agent_nickname_candidates(config: &Config, role_name: Option<&str>) -> Vec<String>
```

**Purpose**: Returns the nickname candidates for a spawned agent, preferring role-specific configuration over the default embedded list. It normalizes a missing role name to `DEFAULT_ROLE_NAME`.

**Data flow**: Takes `&Config` and `Option<&str>` for the role name. It resolves the effective role name, queries `resolve_role_config(config, role_name)` for `nickname_candidates`, and if present returns that cloned `Vec<String>`. Otherwise it calls `default_agent_nickname_list()`, converts each borrowed name to an owned `String`, and returns the collected list.

**Call relations**: This function is called by `prepare_thread_spawn` elsewhere in the control subsystem to choose nickname candidates before reserving one in the registry. It delegates fallback list construction to `default_agent_nickname_list`.

*Call graph*: calls 1 internal fn (default_agent_nickname_list); called by 1 (prepare_thread_spawn).


##### `keep_forked_rollout_item`  (lines 33–65)

```
fn keep_forked_rollout_item(item: &RolloutItem, preserve_reference_context_item: bool) -> bool
```

**Purpose**: Decides which rollout items from a parent thread should be preserved when creating a forked child history. The rule keeps durable conversational context while dropping transient tool chatter and most assistant intermediates.

**Data flow**: Consumes a `&RolloutItem` and a `preserve_reference_context_item` flag. It pattern-matches the item: keeps system/developer/user messages, keeps assistant messages only when `phase == Some(MessagePhase::FinalAnswer)`, drops reasoning/tool/inter-agent items, keeps `TurnContext` only when the flag is true, and always keeps `Compacted`, `EventMsg`, and `SessionMeta`. It returns a boolean and does not mutate state.

**Call relations**: This predicate is used inside `AgentControl::spawn_forked_thread` when filtering the parent rollout before forking.


##### `is_multi_agent_v2_usage_hint_message`  (lines 67–81)

```
fn is_multi_agent_v2_usage_hint_message(item: &ResponseItem, usage_hint_texts: &[String]) -> bool
```

**Purpose**: Recognizes developer messages that exactly match one of the configured V2 usage-hint texts. It is used to strip stale parent hints from forked child history.

**Data flow**: Takes a `&ResponseItem` and a slice of candidate hint strings. It returns `false` unless the item is `ResponseItem::Message` with role `developer` and exactly one `ContentItem::InputText`. It then compares that text against the provided hint strings and returns whether any match exactly.

**Call relations**: This helper is used by `AgentControl::spawn_forked_thread` both when filtering top-level rollout items and when sanitizing `Compacted.replacement_history`.


##### `AgentControl::spawn_agent`  (lines 86–100)

```
async fn spawn_agent(
        &self,
        config: Config,
        initial_operation: Op,
        session_source: Option<SessionSource>,
    ) -> CodexResult<ThreadId>
```

**Purpose**: Test-only convenience wrapper that spawns an agent thread and returns only its `ThreadId`. It hides the richer `LiveAgent` metadata returned by the internal spawn path.

**Data flow**: Accepts a `Config`, initial `Op`, and optional `SessionSource`, then awaits `Box::pin(self.spawn_agent_internal(..., SpawnAgentOptions::default()))`. On success it extracts and returns `spawned_agent.thread_id`; on failure it propagates the `CodexErr`.

**Call relations**: This wrapper is used by tests and delegates all real work to `spawn_agent_internal` with default options.

*Call graph*: calls 1 internal fn (spawn_agent_internal); 2 external calls (pin, default).


##### `AgentControl::spawn_agent_with_metadata`  (lines 103–112)

```
async fn spawn_agent_with_metadata(
        &self,
        config: Config,
        initial_operation: Op,
        session_source: Option<SessionSource>,
        options: SpawnAgentOptions, // TODO(jif
```

**Purpose**: Public spawn entry point that creates an agent thread and returns the full `LiveAgent` record. It supports additional spawn options such as parent metadata and fork mode.

**Data flow**: Takes a `Config`, initial `Op`, optional `SessionSource`, and `SpawnAgentOptions`, then awaits `Box::pin(self.spawn_agent_internal(...))`. It returns the resulting `LiveAgent` or propagates any `CodexErr`.

**Call relations**: This is the main external spawn API and simply forwards to `spawn_agent_internal`, which performs all orchestration.

*Call graph*: calls 1 internal fn (spawn_agent_internal); 1 external calls (pin).


##### `AgentControl::ensure_v2_agent_loaded`  (lines 114–192)

```
async fn ensure_v2_agent_loaded(
        &self,
        config: Config,
        thread_id: ThreadId,
    ) -> CodexResult<()>
```

**Purpose**: Ensures a known V2 agent thread is present in memory, reloading it from stored history if necessary. It also reserves residency before reload so the loaded-thread cap is enforced consistently.

**Data flow**: Takes a `Config` and `thread_id`, upgrades to manager state, and first checks `state.get_thread(thread_id).await`; if already loaded, it touches residency and returns `Ok(())`. If registry metadata is absent, it returns `CodexErr::ThreadNotFound(thread_id)`. Otherwise it reads the stored thread with archived history included, reconstructs `InitialHistory::Resumed`, rejects non-V2 histories with `ThreadNotFound`, reserves a protected residency slot, derives resumed `session_source` and `parent_thread_id`, computes inherited environments and exec policy, and calls `state.resume_thread_with_history_with_source(...)`. On success it commits the residency slot, notifies thread creation, and returns `Ok(())`. On error it checks whether another task loaded the thread concurrently; if so it drops the slot, touches residency, and still returns `Ok(())`, otherwise it returns the original error.

**Call relations**: This method is used when callers need a V2 subagent loaded on demand. It relies on residency helpers from `residency.rs` and on thread-manager resume APIs, but does not call other file-local functions.

*Call graph*: 2 external calls (ThreadNotFound, Resumed).


##### `AgentControl::spawn_agent_internal`  (lines 194–377)

```
async fn spawn_agent_internal(
        &self,
        config: Config,
        initial_operation: Op,
        session_source: Option<SessionSource>,
        options: SpawnAgentOptions,
    ) -> CodexRe
```

**Purpose**: Performs the full spawn workflow for root threads, ordinary subagents, and forked subagents. It coordinates version selection, capacity checks, registry reservations, residency reservations, inheritance, analytics, persistence, and initial input submission.

**Data flow**: Consumes `Config`, initial `Op`, optional `SessionSource`, and `SpawnAgentOptions`. It upgrades to manager state, computes `multi_agent_version` from spawn context, optionally enforces execution capacity for subagent sources, reads `agent_max_threads`, decides whether V2 residency applies, optionally reserves a `V2ResidencySlot`, reserves a registry spawn slot, computes inherited environments and exec policy, and normalizes thread-spawn session sources through `prepare_thread_spawn`. It then creates the thread via `spawn_forked_thread`, `state.spawn_new_thread_with_source`, or `state.spawn_new_thread`. After creation it fills `agent_metadata.agent_id`, commits the registry reservation, commits residency if present, optionally emits subagent analytics, notifies thread creation, persists the spawn edge, sends the initial operation through `send_input_after_capacity_check`, optionally starts a completion watcher for non-V2 children, and returns `LiveAgent { thread_id, metadata, status }`.

**Call relations**: This is the central implementation behind both `spawn_agent` and `spawn_agent_with_metadata`. It delegates fork-specific history construction to `spawn_forked_thread` and uses many external manager/control helpers to complete the spawn pipeline.

*Call graph*: calls 1 internal fn (spawn_forked_thread); called by 2 (spawn_agent, spawn_agent_with_metadata); 5 external calls (pin, clone, effective_agent_max_threads, default, warn!).


##### `AgentControl::spawn_forked_thread`  (lines 379–521)

```
async fn spawn_forked_thread(
        &self,
        state: &Arc<ThreadManagerState>,
        config: Config,
        session_source: SessionSource,
        options: &SpawnAgentOptions,
        inheri
```

**Purpose**: Creates a child thread by forking sanitized history from a parent thread. It validates fork prerequisites, flushes parent rollout, filters and truncates history, strips stale usage hints, and then asks the manager to fork the thread.

**Data flow**: Takes manager state, `Config`, a `SessionSource`, `SpawnAgentOptions`, inherited environments/exec policy, and `MultiAgentVersion`. It first validates that `fork_parent_spawn_call_id`, `fork_mode`, and a thread-spawn `SessionSource` are present, returning `CodexErr::Fatal` otherwise. It loads the parent thread if live, materializes and flushes rollout, reads stored parent history, optionally truncates it with `truncate_rollout_to_last_n_fork_turns`, computes the set of V2 usage-hint texts to remove, filters `forked_rollout_items` with `keep_forked_rollout_item` and `is_multi_agent_v2_usage_hint_message`, sanitizes any compacted replacement history similarly, optionally appends the child subagent usage hint for full-history V2 forks, and finally awaits `state.fork_thread_with_source(...)` with `InitialHistory::Forked(forked_rollout_items)`.

**Call relations**: This function is called only from `spawn_agent_internal` when a subagent spawn requests fork mode. It delegates item filtering to `keep_forked_rollout_item` and hint detection to `is_multi_agent_v2_usage_hint_message`.

*Call graph*: calls 1 internal fn (build_developer_update_item); called by 1 (spawn_agent_internal); 7 external calls (new, clone, matches!, Fatal, Forked, ResponseItem, vec!).


##### `AgentControl::resume_agent_from_rollout`  (lines 524–600)

```
async fn resume_agent_from_rollout(
        &self,
        config: Config,
        thread_id: ThreadId,
        session_source: SessionSource,
    ) -> CodexResult<ThreadId>
```

**Purpose**: Resumes a thread from persisted rollout and, for non-V2 trees, recursively reopens persisted open descendants. It is the high-level resume entry point used for both single-thread and subtree restoration.

**Data flow**: Accepts `Config`, `thread_id`, and `SessionSource`. It computes the root depth from `thread_spawn_depth(&session_source).unwrap_or(0)`, awaits `resume_single_agent_from_rollout`, and receives `(resumed_thread_id, resumed_multi_agent_version)`. If either config features or the resumed thread indicate V2, it returns immediately without reopening descendants. Otherwise it upgrades to manager state, loads the resumed thread and its state DB if available, then breadth-first traverses persisted open spawn edges starting from `(thread_id, root_depth)`. For each child ID it either notes the child is already loaded or constructs a synthetic `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })` and calls `resume_single_agent_from_rollout` for that child. Successful child resumes are enqueued for further traversal; failures are logged and skipped. It finally returns the root resumed thread ID.

**Call relations**: This is the public resume API and delegates the actual single-thread reconstruction to `resume_single_agent_from_rollout`. It only performs descendant traversal when the resumed tree is not V2.

*Call graph*: calls 1 internal fn (resume_single_agent_from_rollout); 6 external calls (pin, from, clone, multi_agent_version_from_features, SubAgent, warn!).


##### `AgentControl::resume_single_agent_from_rollout`  (lines 602–713)

```
async fn resume_single_agent_from_rollout(
        &self,
        config: Config,
        thread_id: ThreadId,
        session_source: SessionSource,
    ) -> CodexResult<(ThreadId, MultiAgentVersion)
```

**Purpose**: Reconstructs one thread from stored rollout history and re-registers it in memory. It also restores thread-spawn metadata such as nickname and role when resuming subagents.

**Data flow**: Takes `Config`, `thread_id`, and `SessionSource`, upgrades to manager state, reads the stored thread with archived history included, builds `InitialHistory::Resumed`, computes `multi_agent_version` from the resumed history and source, reserves a registry spawn slot using `config.effective_agent_max_threads(multi_agent_version)`, and if the source is `SubAgent::ThreadSpawn` optionally loads persisted nickname/role from the state DB before calling `prepare_thread_spawn`. It computes inherited environments and exec policy, resumes the thread with `state.resume_thread_with_history_with_source(...)`, fills `agent_metadata.agent_id`, commits the reservation, notifies thread creation, optionally starts a completion watcher for non-V2 children, persists the spawn edge, and returns `(resumed_thread.thread_id, multi_agent_version)`.

**Call relations**: This function is called by `resume_agent_from_rollout` for the root thread and for each descendant that should be reopened. It is the single-thread resume primitive that the tree-resume loop builds upon.

*Call graph*: called by 1 (resume_agent_from_rollout); 5 external calls (clone, effective_agent_max_threads, clone, default, Resumed).


### `core/src/agent/control.rs`

`orchestration` · `multi-agent request handling and subagent lifecycle management`

This file defines `AgentControl`, the shared handle every session uses to interact with the multi-agent subsystem. Its state combines a root-scoped `SessionId`, a weak pointer to `ThreadManagerState`, an `AgentRegistry` for metadata and path/name reservations, V2 residency tracking, and an execution limiter. Around that state it provides the operational API for sending work to agents, interrupting them, querying status/config, resolving path-like agent references, listing live agents, and formatting subagent context.

Request-sending methods (`send_input`, `send_inter_agent_communication`, `interrupt_agent`) all upgrade the weak manager handle, enforce execution-capacity policy where applicable, dispatch an `Op` to the target thread, and normalize cleanup through `handle_thread_request_result`. Successful sends update the registry's `last_task_message`, derived either from inter-agent communication content or from `render_input_preview` over user input items. If a thread died internally, the control plane removes it from the manager, clears residency, and releases the registry slot.

The file also owns root/session bookkeeping (`register_session_root`), path-based resolution (`resolve_agent_reference`), subtree traversal over persisted live thread-spawn edges, and detached completion watching for spawned subagents. `maybe_start_completion_watcher` subscribes to child status changes and, once final, either sends a V2 inter-agent completion message back to the parent or injects a user-visible notification into the parent thread. Additional helpers prepare spawn metadata, inherit environments and exec policy from parent threads, persist spawn edges to the state DB, and implement path-prefix matching for agent listings. Overall, this is orchestration-heavy code that keeps registry metadata, thread-manager state, and user-visible multi-agent behavior in sync.

#### Function details

##### `AgentControl::new`  (lines 107–112)

```
fn new(manager: Weak<ThreadManagerState>) -> Self
```

**Purpose**: Constructs a new `AgentControl` bound to a weak thread-manager handle, leaving other fields at their defaults.

**Data flow**: It takes `Weak<ThreadManagerState>`, creates `Self { manager, ..Default::default() }`, and returns the initialized control object.

**Call relations**: Higher-level session/service construction calls this to create the root control-plane handle before session id and limits are configured.

*Call graph*: called by 1 (agent_control); 1 external calls (default).


##### `AgentControl::with_session_id`  (lines 114–118)

```
fn with_session_id(mut self, session_id: SessionId, max_threads: usize) -> Self
```

**Purpose**: Attaches the shared multi-agent `SessionId` and initializes the execution limiter with the maximum thread count.

**Data flow**: It takes ownership of `self`, a `SessionId`, and `max_threads`, writes `self.session_id`, calls `self.agent_execution_limiter.initialize(max_threads)`, and returns the updated `Self`.

**Call relations**: This is part of control-plane setup immediately after construction.

*Call graph*: called by 1 (new).


##### `AgentControl::session_id`  (lines 120–122)

```
fn session_id(&self) -> SessionId
```

**Purpose**: Returns the session-wide id shared by the root thread and all of its subagents.

**Data flow**: It reads `self.session_id` and returns it by value.

**Call relations**: Setup and callers needing to tag operations with the shared multi-agent session use this accessor.

*Call graph*: called by 1 (new).


##### `AgentControl::send_input`  (lines 125–135)

```
async fn send_input(
        &self,
        agent_id: ThreadId,
        initial_operation: Op,
    ) -> CodexResult<String>
```

**Purpose**: Sends an arbitrary initial `Op` to an existing agent thread after ensuring the manager is available and execution capacity permits the operation.

**Data flow**: It takes a target `ThreadId` and an `Op`, upgrades the weak manager to `Arc<ThreadManagerState>`, awaits `ensure_execution_capacity_for_op`, then delegates to `send_input_after_capacity_check`. It returns `CodexResult<String>` from the underlying thread operation.

**Call relations**: This is the general request-dispatch entrypoint for existing agents; it funnels successful capacity-checked sends into `send_input_after_capacity_check`.

*Call graph*: calls 2 internal fn (send_input_after_capacity_check, upgrade).


##### `AgentControl::send_input_after_capacity_check`  (lines 137–165)

```
async fn send_input_after_capacity_check(
        &self,
        agent_id: ThreadId,
        state: &Arc<ThreadManagerState>,
        initial_operation: Op,
    ) -> CodexResult<String>
```

**Purpose**: Dispatches an already-capacity-approved operation to a thread and updates the registry's last-task message on success.

**Data flow**: It takes the target thread id, upgraded manager state, and `Op`. It derives `last_task_message` from inter-agent communication content or from `render_input_preview`, sends the op through `state.send_op`, normalizes the result via `handle_thread_request_result`, and if successful either updates or clears `self.state`'s last-task message for that thread. It returns the final `CodexResult<String>`.

**Call relations**: Only `send_input` calls this, after capacity checks. It delegates failure cleanup to `handle_thread_request_result` and message extraction to local helpers.

*Call graph*: calls 4 internal fn (handle_thread_request_result, last_task_message_from_communication, non_empty_task_message, render_input_preview); called by 1 (send_input).


##### `AgentControl::send_inter_agent_communication`  (lines 167–188)

```
async fn send_inter_agent_communication(
        &self,
        agent_id: ThreadId,
        communication: InterAgentCommunication,
    ) -> CodexResult<String>
```

**Purpose**: Sends an `InterAgentCommunication` payload to an existing agent thread and updates the registry's last-task message when appropriate.

**Data flow**: It takes a target thread id and a communication struct, derives a visible last-task message unless the content is encrypted, upgrades the manager, wraps the communication in `Op::InterAgentCommunication`, enforces execution capacity, sends the op, normalizes the result, and updates or clears the registry's last-task message on success. It returns `CodexResult<String>`.

**Call relations**: This is the specialized messaging path used by inter-agent workflows and by completion watchers sending notifications back to parents.

*Call graph*: calls 3 internal fn (handle_thread_request_result, upgrade, last_task_message_from_communication).


##### `AgentControl::interrupt_agent`  (lines 191–199)

```
async fn interrupt_agent(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Sends an interrupt operation to an existing agent thread.

**Data flow**: It upgrades the manager, sends `Op::Interrupt` through `state.send_op`, passes the result through `handle_thread_request_result`, and returns the resulting `CodexResult<String>`.

**Call relations**: This is the control-plane interruption path for live agents and shares the same dead-thread cleanup logic as other request methods.

*Call graph*: calls 2 internal fn (handle_thread_request_result, upgrade).


##### `AgentControl::handle_thread_request_result`  (lines 201–213)

```
async fn handle_thread_request_result(
        &self,
        agent_id: ThreadId,
        state: &Arc<ThreadManagerState>,
        result: CodexResult<String>,
    ) -> CodexResult<String>
```

**Purpose**: Normalizes thread-operation results by cleaning up registry and manager state when a target agent died internally.

**Data flow**: It takes the target thread id, manager state, and a `CodexResult<String>`. If the result is `Err(CodexErr::InternalAgentDied)`, it asynchronously removes the thread from the manager, forgets V2 residency, and releases the spawned-thread slot in the registry. It then returns the original result unchanged.

**Call relations**: All request-dispatch methods route their results through this helper so dead-agent cleanup is centralized.

*Call graph*: called by 3 (interrupt_agent, send_input_after_capacity_check, send_inter_agent_communication); 1 external calls (matches!).


##### `AgentControl::get_status`  (lines 216–225)

```
async fn get_status(&self, agent_id: ThreadId) -> AgentStatus
```

**Purpose**: Fetches the current status of an agent thread, returning `AgentStatus::NotFound` if the manager or thread is unavailable.

**Data flow**: It upgrades the manager, looks up the thread by id, and awaits `thread.agent_status()`. Any failure to upgrade or fetch the thread yields `AgentStatus::NotFound`.

**Call relations**: Status polling and completion-watcher fallback logic use this method when a subscription is unavailable or broken.

*Call graph*: calls 1 internal fn (upgrade).


##### `AgentControl::register_session_root`  (lines 227–235)

```
fn register_session_root(
        &self,
        current_thread_id: ThreadId,
        current_parent_thread_id: Option<ThreadId>,
    )
```

**Purpose**: Registers the current thread as a root thread in the registry when it has no parent thread.

**Data flow**: It takes the current thread id and optional parent thread id. If the parent is `None`, it writes the current thread id into `self.state` as a root thread; otherwise it does nothing.

**Call relations**: This is called from agent-resolution and spawn-preparation flows to keep root-thread bookkeeping accurate.


##### `AgentControl::get_agent_metadata`  (lines 237–239)

```
fn get_agent_metadata(&self, agent_id: ThreadId) -> Option<AgentMetadata>
```

**Purpose**: Returns the registry metadata for a known agent thread if present.

**Data flow**: It takes a thread id, queries `self.state.agent_metadata_for_thread`, and returns `Option<AgentMetadata>`.

**Call relations**: Callers use this as a lightweight metadata lookup without touching the thread manager.


##### `AgentControl::ensure_agent_known`  (lines 241–245)

```
fn ensure_agent_known(&self, agent_id: ThreadId) -> CodexResult<AgentMetadata>
```

**Purpose**: Looks up agent metadata and converts absence into a `ThreadNotFound` protocol error.

**Data flow**: It queries `self.state.agent_metadata_for_thread(agent_id)` and returns the metadata on success or `Err(CodexErr::ThreadNotFound(agent_id))` when missing.

**Call relations**: This helper is used by callers that need a protocol-level error rather than an `Option` when validating agent existence.

*Call graph*: 1 external calls (ThreadNotFound).


##### `AgentControl::list_live_agent_subtree_thread_ids`  (lines 247–254)

```
async fn list_live_agent_subtree_thread_ids(
        &self,
        agent_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>>
```

**Purpose**: Returns the given agent thread id plus all currently live descendants reachable through thread-spawn edges.

**Data flow**: It starts a vector with `agent_id`, extends it with the result of `live_thread_spawn_descendants(agent_id).await?`, and returns the combined `Vec<ThreadId>`.

**Call relations**: This is a convenience wrapper over descendant traversal for callers that need the whole live subtree rooted at one agent.

*Call graph*: calls 1 internal fn (live_thread_spawn_descendants); 1 external calls (vec!).


##### `AgentControl::get_agent_config_snapshot`  (lines 256–267)

```
async fn get_agent_config_snapshot(
        &self,
        agent_id: ThreadId,
    ) -> Option<ThreadConfigSnapshot>
```

**Purpose**: Fetches a thread's current configuration snapshot if the manager and thread are still available.

**Data flow**: It upgrades the manager, gets the thread by id, awaits `thread.config_snapshot()`, and returns `Some(ThreadConfigSnapshot)` or `None` on any lookup failure.

**Call relations**: Callers use this when they need to inspect a live agent's effective configuration.

*Call graph*: calls 1 internal fn (upgrade).


##### `AgentControl::resolve_agent_reference`  (lines 269–288)

```
async fn resolve_agent_reference(
        &self,
        _current_thread_id: ThreadId,
        current_session_source: &SessionSource,
        agent_reference: &str,
    ) -> CodexResult<ThreadId>
```

**Purpose**: Resolves a relative or absolute live-agent path reference against the current session source into a concrete thread id.

**Data flow**: It reads the current agent path from `current_session_source`, defaulting to `AgentPath::root()`, resolves the provided `agent_reference` string against that path, looks up the resulting path in the registry, and returns the corresponding `ThreadId` or `CodexErr::UnsupportedOperation` with a descriptive message if no live agent matches.

**Call relations**: This is the path-resolution backend used by tool-facing agent-target resolution after direct thread-id parsing fails.

*Call graph*: 3 external calls (get_agent_path, format!, UnsupportedOperation).


##### `AgentControl::subscribe_status`  (lines 291–298)

```
async fn subscribe_status(
        &self,
        agent_id: ThreadId,
    ) -> CodexResult<watch::Receiver<AgentStatus>>
```

**Purpose**: Subscribes to status updates for a live agent thread.

**Data flow**: It upgrades the manager, fetches the thread by id, calls `thread.subscribe_status()`, and returns the resulting `watch::Receiver<AgentStatus>` inside `CodexResult`.

**Call relations**: Completion watchers use this to observe child-agent lifecycle transitions without polling.

*Call graph*: calls 1 internal fn (upgrade).


##### `AgentControl::format_environment_context_subagents`  (lines 300–320)

```
async fn format_environment_context_subagents(
        &self,
        parent_thread_id: ThreadId,
    ) -> String
```

**Purpose**: Formats a newline-separated summary of direct spawned subagents for inclusion in environment context.

**Data flow**: It fetches direct children with `open_thread_spawn_children(parent_thread_id).await`, returns an empty string on error, otherwise maps each `(thread_id, metadata)` to a display reference using the agent path name when available or the thread id otherwise, formats each line with `format_subagent_context_line`, joins them with newlines, and returns the resulting string.

**Call relations**: This is a presentation helper for parent-thread context assembly and depends on the live child-edge view.

*Call graph*: calls 1 internal fn (open_thread_spawn_children); 1 external calls (new).


##### `AgentControl::list_agents`  (lines 322–395)

```
async fn list_agents(
        &self,
        current_session_source: &SessionSource,
        path_prefix: Option<&str>,
    ) -> CodexResult<Vec<ListedAgent>>
```

**Purpose**: Lists live agents visible from the current session source, optionally filtered by an agent-path prefix, including status and last-task summaries.

**Data flow**: It upgrades the manager, resolves the optional prefix relative to the current session source, fetches and sorts live registry metadata by path/id, conditionally inserts the root agent entry when it matches the prefix and is live, then iterates metadata entries, skipping unresolved threads and non-matching prefixes, fetching each thread's status and packaging `ListedAgent { agent_name, agent_status, last_task_message }`. It returns `CodexResult<Vec<ListedAgent>>`.

**Call relations**: This is the main listing API for multi-agent UIs/tools. It relies on `agent_matches_prefix` semantics and combines registry metadata with live thread-manager status.

*Call graph*: calls 2 internal fn (upgrade, root); 1 external calls (with_capacity).


##### `AgentControl::maybe_start_completion_watcher`  (lines 401–482)

```
fn maybe_start_completion_watcher(
        &self,
        child_thread_id: ThreadId,
        session_source: Option<SessionSource>,
        child_reference: String,
        child_agent_path: Option<Ag
```

**Purpose**: Starts a detached task that waits for a spawned child agent to reach a final status and then notifies the parent thread in the appropriate protocol style.

**Data flow**: It takes child identifiers plus optional session-source/path metadata. If the session source is not `SubAgentSource::ThreadSpawn`, it returns immediately. Otherwise it clones `self` into a spawned async task, subscribes to child status changes or falls back to `get_status`, waits until a final status is observed, upgrades the manager, inspects whether the child uses multi-agent V2, and either sends an `InterAgentCommunication` completion message to the parent or injects a user notification message into the parent thread. It performs asynchronous messaging side effects but returns nothing to the caller.

**Call relations**: Spawn flows call this after creating a child thread so parent threads receive completion notifications automatically. It delegates message formatting to session-prefix helpers and uses `send_inter_agent_communication` for V2-aware paths.

*Call graph*: calls 4 internal fn (is_final, format_inter_agent_completion_message, format_subagent_notification_message, new); 2 external calls (new, spawn).


##### `AgentControl::prepare_thread_spawn`  (lines 485–522)

```
fn prepare_thread_spawn(
        &self,
        reservation: &mut crate::agent::registry::SpawnReservation,
        config: &Config,
        parent_thread_id: ThreadId,
        depth: i32,
        age
```

**Purpose**: Reserves agent-path and nickname metadata for a new spawned thread and constructs the corresponding `SessionSource` and initial `AgentMetadata`.

**Data flow**: It takes a mutable spawn reservation, config, parent thread id, depth, optional agent path/role, and optional preferred nickname. If `depth == 1` it registers the parent as a root thread. It reserves the agent path when present, computes nickname candidates from config and role, reserves a nickname with optional preference, builds `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })`, constructs `AgentMetadata` with `agent_id: None` and no last-task message, and returns both values in `CodexResult`.

**Call relations**: Thread-spawn orchestration uses this helper before actually creating the child thread so naming/path collisions are prevented up front.

*Call graph*: calls 3 internal fn (agent_nickname_candidates, reserve_agent_nickname_with_preference, reserve_agent_path); 1 external calls (SubAgent).


##### `AgentControl::upgrade`  (lines 524–528)

```
fn upgrade(&self) -> CodexResult<Arc<ThreadManagerState>>
```

**Purpose**: Upgrades the weak thread-manager handle into a strong `Arc`, returning a protocol error if the manager has already been dropped.

**Data flow**: It calls `self.manager.upgrade()`, returning the `Arc<ThreadManagerState>` on success or `CodexErr::UnsupportedOperation("thread manager dropped")` on failure.

**Call relations**: Nearly every operation that touches live threads begins here, making this the common gateway from control-plane state into the thread manager.

*Call graph*: called by 8 (get_agent_config_snapshot, get_status, interrupt_agent, list_agents, live_thread_spawn_children, send_input, send_inter_agent_communication, subscribe_status); 1 external calls (upgrade).


##### `AgentControl::inherited_environments_for_source`  (lines 530–552)

```
async fn inherited_environments_for_source(
        &self,
        state: &Arc<ThreadManagerState>,
        session_source: Option<&SessionSource>,
    ) -> Option<TurnEnvironmentSnapshot>
```

**Purpose**: Fetches the parent thread's environment snapshot for a spawned child session source, if one exists.

**Data flow**: It takes upgraded manager state and an optional session source. If the source is `SubAgentSource::ThreadSpawn`, it fetches the parent thread, awaits `turn_environments.snapshot()` from the parent's session services, and returns `Some(TurnEnvironmentSnapshot)`; otherwise it returns `None`.

**Call relations**: Spawn logic uses this helper when deciding what environment selections a child thread should inherit from its parent.


##### `AgentControl::inherited_exec_policy_for_source`  (lines 554–576)

```
async fn inherited_exec_policy_for_source(
        &self,
        state: &Arc<ThreadManagerState>,
        session_source: Option<&SessionSource>,
        child_config: &Config,
    ) -> Option<Arc<cr
```

**Purpose**: Determines whether a spawned child should inherit its parent's execution-policy manager and returns it when policy inheritance is allowed.

**Data flow**: It takes upgraded manager state, an optional session source, and the child config. For thread-spawn sources it fetches the parent thread and parent config, checks `child_uses_parent_exec_policy(&parent_config, child_config)`, and if true clones and returns the parent's `exec_policy` manager; otherwise it returns `None`.

**Call relations**: Spawn orchestration calls this when wiring child session services so execution-policy inheritance follows configuration rules.

*Call graph*: calls 1 internal fn (child_uses_parent_exec_policy); 1 external calls (clone).


##### `AgentControl::open_thread_spawn_children`  (lines 578–586)

```
async fn open_thread_spawn_children(
        &self,
        parent_thread_id: ThreadId,
    ) -> CodexResult<Vec<(ThreadId, AgentMetadata)>>
```

**Purpose**: Returns the currently live direct spawned children of a parent thread.

**Data flow**: It fetches the full parent-to-children map from `live_thread_spawn_children().await?`, removes the entry for `parent_thread_id`, and returns that vector or an empty default vector.

**Call relations**: This is the direct-children view used by environment-context formatting and other callers that only care about one parent.

*Call graph*: calls 1 internal fn (live_thread_spawn_children); called by 2 (format_environment_context_subagents, wait_for_live_thread_spawn_children).


##### `AgentControl::live_thread_spawn_children`  (lines 588–621)

```
async fn live_thread_spawn_children(
        &self,
    ) -> CodexResult<HashMap<ThreadId, Vec<(ThreadId, AgentMetadata)>>>
```

**Purpose**: Builds a map from each live parent thread to its live spawned child threads and associated metadata.

**Data flow**: It upgrades the manager, initializes an empty `HashMap<ThreadId, Vec<(ThreadId, AgentMetadata)>>`, iterates `state.list_live_thread_spawn_edges().await`, pushes each child into the appropriate parent bucket using registry metadata when available or a default metadata stub otherwise, then sorts each child list by agent path and thread id. It returns the completed map.

**Call relations**: This is the shared traversal primitive behind direct-child and descendant queries.

*Call graph*: calls 1 internal fn (upgrade); called by 2 (live_thread_spawn_descendants, open_thread_spawn_children); 2 external calls (default, new).


##### `AgentControl::persist_thread_spawn_edge_for_source`  (lines 623–646)

```
async fn persist_thread_spawn_edge_for_source(
        &self,
        thread: &crate::CodexThread,
        child_thread_id: ThreadId,
        session_source: Option<&SessionSource>,
    )
```

**Purpose**: Persists an open thread-spawn edge to the state database when the child session source has a parent thread and the thread has DB state available.

**Data flow**: It takes the newly created thread, child thread id, and optional session source. It extracts `parent_thread_id` from the source, obtains the thread's state DB context, and asynchronously calls `upsert_thread_spawn_edge(..., DirectionalThreadSpawnEdgeStatus::Open)`. On failure it emits a warning log and otherwise returns nothing.

**Call relations**: Spawn flows call this after child creation so thread-spawn relationships survive beyond in-memory registry state.

*Call graph*: calls 1 internal fn (state_db); 1 external calls (warn!).


##### `AgentControl::live_thread_spawn_descendants`  (lines 648–672)

```
async fn live_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>>
```

**Purpose**: Traverses the live thread-spawn graph depth-first to collect all descendants of a root thread in stable child-order.

**Data flow**: It fetches the parent-to-children map from `live_thread_spawn_children().await?`, seeds a stack with the root's direct children in reverse order, then repeatedly pops a thread id, appends it to `descendants`, and pushes that thread's children in reverse order so original sorted order is preserved. It returns `Vec<ThreadId>`.

**Call relations**: This is the descendant traversal backend used by `list_live_agent_subtree_thread_ids`.

*Call graph*: calls 1 internal fn (live_thread_spawn_children); called by 1 (list_live_agent_subtree_thread_ids); 1 external calls (new).


##### `agent_matches_prefix`  (lines 675–687)

```
fn agent_matches_prefix(agent_path: Option<&AgentPath>, prefix: &AgentPath) -> bool
```

**Purpose**: Checks whether an optional agent path is equal to or nested under a requested prefix path.

**Data flow**: It takes `Option<&AgentPath>` and `&AgentPath prefix`. If the prefix is root it returns `true`; otherwise it returns `true` only when the agent path exists and is either exactly equal to the prefix or has the prefix followed by a `/` boundary. It has no side effects.

**Call relations**: Agent listing uses this helper to implement prefix filtering without accidental partial-segment matches.

*Call graph*: calls 1 internal fn (is_root).


##### `render_input_preview`  (lines 689–710)

```
fn render_input_preview(initial_operation: &Op) -> String
```

**Purpose**: Builds a human-readable preview string for an `Op`, primarily for storing as an agent's last-task message.

**Data flow**: It matches on `initial_operation`. For `Op::UserInput` it maps each `UserInput` item to a preview string (`text`, `[image]`, `[local_image:path]`, `[skill:$name](path)`, `[mention:$name](path)`, or `[input]`) and joins them with newlines; for `Op::InterAgentCommunication` it returns the communication content; for other ops it returns an empty string.

**Call relations**: This helper is used when sending input to derive the registry's `last_task_message`, and other call-handling code also uses it for previews.

*Call graph*: called by 3 (send_input_after_capacity_check, handle_call, handle_spawn_agent); 1 external calls (new).


##### `last_task_message_from_communication`  (lines 712–717)

```
fn last_task_message_from_communication(communication: &InterAgentCommunication) -> Option<String>
```

**Purpose**: Extracts a visible last-task message from inter-agent communication unless the content is encrypted.

**Data flow**: It reads `communication.encrypted_content`; if present it returns `None`, otherwise it clones `communication.content`, passes it to `non_empty_task_message`, and returns the resulting `Option<String>`.

**Call relations**: Both generic input sending and explicit inter-agent communication sending use this helper when deciding whether to update `last_task_message`.

*Call graph*: calls 1 internal fn (non_empty_task_message); called by 2 (send_input_after_capacity_check, send_inter_agent_communication).


##### `non_empty_task_message`  (lines 719–721)

```
fn non_empty_task_message(message: String) -> Option<String>
```

**Purpose**: Converts an empty message string into `None` and preserves non-empty messages as `Some`.

**Data flow**: It takes an owned `String`, checks `is_empty()`, and returns `Option<String>` using `then_some(message)`.

**Call relations**: This tiny helper centralizes the rule that blank previews should clear rather than populate the last-task field.

*Call graph*: called by 2 (send_input_after_capacity_check, last_task_message_from_communication).


##### `thread_spawn_depth`  (lines 723–728)

```
fn thread_spawn_depth(session_source: &SessionSource) -> Option<i32>
```

**Purpose**: Extracts the spawn depth from a `SessionSource` when the source represents a thread-spawned subagent.

**Data flow**: It matches the `SessionSource`; for `SubAgent(SubAgentSource::ThreadSpawn { depth, .. })` it returns `Some(*depth)`, otherwise `None`.

**Call relations**: This helper provides a compact way for callers to inspect spawn ancestry depth from session metadata.


### `core/src/agent/agent_resolver.rs`

`orchestration` · `tool call handling for agent references`

This file contains the narrow adapter used by tool-facing code that needs to turn a user/model-provided agent target into an internal thread identifier. The main function, `resolve_agent_target`, first calls `register_session_root` so the current thread is recorded as a root when appropriate. It then tries the fast path: parse the `target` string directly as a `ThreadId` via `ThreadId::from_string`. If parsing succeeds, that id is returned immediately.

If the target is not a literal thread id, the function delegates to `session.services.agent_control.resolve_agent_reference`, passing the current session's root thread id, the turn's `session_source`, and the unresolved target string. Any resulting `CodexErr` is mapped into `FunctionCallError::RespondToModel`, preserving user-facing error text. `UnsupportedOperation` gets its message extracted directly; all other errors are stringified.

The helper `register_session_root` is intentionally tiny but important: it forwards the current thread id and the turn's optional parent thread id into `AgentControl::register_session_root`. This means resolution is not just lookup; it also maintains root-thread bookkeeping needed by the multi-agent control plane.

#### Function details

##### `resolve_agent_target`  (lines 8–29)

```
async fn resolve_agent_target(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    target: &str,
) -> Result<ThreadId, FunctionCallError>
```

**Purpose**: Resolves a target string to a `ThreadId` by first treating it as a literal thread id and otherwise resolving it as a live agent reference relative to the current session source.

**Data flow**: It takes shared `Session` and `TurnContext` handles plus the raw `target` string. It first registers the session root, then attempts `ThreadId::from_string(target)`; on success it returns that id. On failure it asynchronously calls `agent_control.resolve_agent_reference(...)`, transforms any `CodexErr` into `FunctionCallError::RespondToModel`, and returns the resolved `ThreadId` or mapped error.

**Call relations**: Tool-facing code calls this when it needs to address another agent. The function delegates root registration to `register_session_root` and path-style resolution to `AgentControl` only when direct thread-id parsing fails.

*Call graph*: calls 2 internal fn (register_session_root, from_string).


##### `register_session_root`  (lines 31–36)

```
fn register_session_root(session: &Arc<Session>, turn: &Arc<TurnContext>)
```

**Purpose**: Forwards the current thread and optional parent thread information to the agent-control layer so root-thread bookkeeping is established before agent resolution.

**Data flow**: It takes shared `Session` and `TurnContext` handles, reads `session.thread_id` and `turn.parent_thread_id`, and passes them to `session.services.agent_control.register_session_root`. It returns nothing and mutates agent-control state indirectly.

**Call relations**: This helper is called at the start of `resolve_agent_target` so even pure-resolution flows keep the agent-control registry aware of the current root context.

*Call graph*: called by 1 (resolve_agent_target).


### `core/src/session/multi_agents.rs`

`domain_logic` · `request handling`

This file contains a single helper that converts session metadata into a borrowed usage-hint string for prompt/context construction. Its logic is intentionally narrow: it only emits text when the current turn is running under multi-agent protocol version V2 and when the `multi_agent_v2.usage_hint_enabled` flag in the turn configuration is set. Once those two gates pass, it inspects the concrete `SessionSource` to choose between two separately configured hint fields on `turn_context.config.multi_agent_v2`: `subagent_usage_hint_text` for subagents created via `SubAgentSource::ThreadSpawn`, and `root_agent_usage_hint_text` for top-level entry sources such as CLI, VSCode, Exec, MCP, custom integrations, or unknown origins. Other subagent/internal sources are explicitly denied hints by returning `None`, which prevents accidental propagation of root-agent guidance into internal orchestration paths. The function returns `Option<&str>` by borrowing from configuration with `as_deref`, so it performs no allocation and preserves the lifetime of the underlying config strings. In practice, this file acts as a small policy boundary between session provenance and prompt assembly.

#### Function details

##### `usage_hint_text`  (lines 6–31)

```
fn usage_hint_text(
    turn_context: &'a TurnContext,
    session_source: &SessionSource,
) -> Option<&'a str>
```

**Purpose**: Determines whether the current session should receive a usage hint and, if so, selects the appropriate configured text for either a root agent or a thread-spawned subagent. It enforces both protocol-version and feature-flag gating before looking at session origin.

**Data flow**: It takes a borrowed `TurnContext` and a borrowed `SessionSource`. It reads `turn_context.multi_agent_version` and `turn_context.config.multi_agent_v2`, checks `usage_hint_enabled`, then matches on `session_source` to choose either `subagent_usage_hint_text.as_deref()`, `root_agent_usage_hint_text.as_deref()`, or `None`. It returns an `Option<&str>` borrowed from configuration and does not mutate any state.

**Call relations**: This helper is invoked by `build_initial_context` while assembling the initial turn/session context, specifically when prompt metadata is being derived from session state. Within that flow it serves as a leaf policy function: it does not delegate further, but encapsulates the source-based branching so callers do not need to duplicate the version/flag/source checks.

*Call graph*: called by 1 (build_initial_context).


### Collaboration tool surfaces
This group introduces the shared multi-agent tool contracts and helpers, then walks through the classic and V2 collaboration handlers for spawning, messaging, listing, interrupting, waiting on, resuming, and closing agents.

### `core/src/tools/handlers/multi_agents_spec.rs`

`config` · `tool registration and schema/search generation`

This file is the schema-definition layer for multi-agent tools. It declares the shared namespace constants, descriptive text fragments, and two option structs: `SpawnAgentToolOptions`, which controls how spawn schemas expose model/role guidance, and `WaitAgentTimeoutOptions`, which carries default/min/max timeout values and defaults to the constants from `multi_agents_common`.

The public `create_*` functions build `ToolSpec` values for both namespaced v1 tools and newer direct-function v2 tools. These specs define parameter schemas, output schemas, and extensive natural-language descriptions that shape model behavior. The spawn tool builders are especially rich: they can hide metadata override fields, inject available-model guidance, include optional usage hints, and switch between v1's `message/items/fork_context` shape and v2's `task_name/fork_turns` shape. Other builders cover `send_input`, `send_message`, `followup_task`, `resume_agent`, `wait_agent`, `list_agents`, `close_agent`, and `interrupt_agent`.

Private helpers construct reusable schema fragments: `agent_status_output_schema` models the `AgentStatus` union; output-schema builders define the exact JSON returned by each tool; `create_collab_input_items_schema` describes structured `UserInput` arrays; property builders assemble spawn parameter maps; and description builders generate long-form guidance text, including explicit anti-patterns for overusing delegation. `spawn_agent_models_description` summarizes up to five picker-visible models, truncating long reasoning-effort labels and listing supported service tiers. Together, these functions ensure the model sees a precise, constrained, and behaviorally guided API surface.

#### Function details

##### `WaitAgentTimeoutOptions::default`  (lines 39–45)

```
fn default() -> Self
```

**Purpose**: Provides the default timeout configuration for wait-agent schemas from the shared multi-agent timeout constants.

**Data flow**: Constructs and returns `WaitAgentTimeoutOptions { default_timeout_ms, min_timeout_ms, max_timeout_ms }` using values imported from `multi_agents_common`.

**Call relations**: Used when callers do not supply explicit timeout bounds while constructing wait-agent handlers or specs.


##### `create_spawn_agent_tool_v1`  (lines 48–78)

```
fn create_spawn_agent_tool_v1(options: SpawnAgentToolOptions) -> ToolSpec
```

**Purpose**: Builds the namespaced v1 `spawn_agent` tool spec, including parameter schema, output schema, and descriptive guidance tailored by `SpawnAgentToolOptions`.

**Data flow**: Consumes `options: SpawnAgentToolOptions` → optionally derives available-model and inherited-model guidance strings, builds a mutable property map with `spawn_agent_common_properties_v1`, optionally removes metadata override fields with `hide_spawn_agent_metadata_options`, then returns `ToolSpec::Namespace` containing one `ResponsesApiTool` named `spawn_agent` with generated description, object parameters, and `spawn_agent_output_schema_v1()`.

**Call relations**: Called by the v1 spawn handler's `spec` method to expose the tool contract used at runtime.

*Call graph*: calls 2 internal fn (hide_spawn_agent_metadata_options, spawn_agent_common_properties_v1); called by 1 (spec); 2 external calls (Namespace, vec!).


##### `create_spawn_agent_tool_v2`  (lines 80–116)

```
fn create_spawn_agent_tool_v2(options: SpawnAgentToolOptions) -> ToolSpec
```

**Purpose**: Builds the direct-function v2 `spawn_agent` tool spec with canonical task naming and fork-turn controls.

**Data flow**: Consumes `options` → derives optional model guidance, builds properties with `spawn_agent_common_properties_v2`, optionally hides metadata fields, inserts a required `task_name` string property, and returns `ToolSpec::Function` with generated description, required `task_name` and `message`, and `spawn_agent_output_schema_v2(...)`.

**Call relations**: Used by newer spawn-tool registration paths; it delegates description and output-shape details to dedicated helpers.

*Call graph*: calls 6 internal fn (hide_spawn_agent_metadata_options, spawn_agent_common_properties_v2, spawn_agent_output_schema_v2, spawn_agent_tool_description_v2, object, string); called by 1 (spec); 2 external calls (Function, vec!).


##### `create_send_input_tool_v1`  (lines 118–154)

```
fn create_send_input_tool_v1() -> ToolSpec
```

**Purpose**: Builds the namespaced v1 `send_input` tool spec for messaging an existing agent with either plain text or structured items.

**Data flow**: Creates a `BTreeMap` of properties for `target`, `message`, `items`, and `interrupt`, using `create_collab_input_items_schema` for structured items, then wraps them in a namespaced `ToolSpec` with required `target` and `send_input_output_schema()`.

**Call relations**: Called by the send-input handler's `spec` method.

*Call graph*: calls 3 internal fn (create_collab_input_items_schema, boolean, string); called by 1 (spec); 3 external calls (from, Namespace, vec!).


##### `create_send_message_tool`  (lines 156–186)

```
fn create_send_message_tool() -> ToolSpec
```

**Purpose**: Builds a direct-function `send_message` tool spec for queueing a plain-text message to an existing agent by id or task name.

**Data flow**: Creates properties for encrypted `message` and `target`, marks both required in a `JsonSchema::object`, and returns `ToolSpec::Function` with no output schema.

**Call relations**: Used by other registration paths outside the v1 namespaced handler set.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `create_followup_task_tool`  (lines 188–215)

```
fn create_followup_task_tool() -> ToolSpec
```

**Purpose**: Builds a direct-function `followup_task` tool spec for sending a follow-up task to an existing non-root agent.

**Data flow**: Creates required `target` and encrypted `message` properties, wraps them in a `ToolSpec::Function`, and leaves `output_schema` as `None`.

**Call relations**: Used by newer collaboration surfaces that distinguish follow-up tasks from generic input submission.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `create_resume_agent_tool`  (lines 217–237)

```
fn create_resume_agent_tool() -> ToolSpec
```

**Purpose**: Builds the namespaced v1 `resume_agent` tool spec.

**Data flow**: Creates a single required `id` string property and returns a namespaced `ToolSpec` whose output schema is `resume_agent_output_schema()`.

**Call relations**: Called by the resume handler's `spec` method.

*Call graph*: calls 1 internal fn (string); called by 1 (spec); 3 external calls (from, Namespace, vec!).


##### `create_wait_agent_tool_v1`  (lines 239–253)

```
fn create_wait_agent_tool_v1(options: WaitAgentTimeoutOptions) -> ToolSpec
```

**Purpose**: Builds the namespaced v1 `wait_agent` tool spec for waiting on final statuses of specific target agents.

**Data flow**: Consumes `options: WaitAgentTimeoutOptions` and returns a namespaced `ToolSpec` containing one `wait_agent` function with parameters from `wait_agent_tool_parameters_v1(options)` and output schema `wait_output_schema_v1()`.

**Call relations**: Called by the v1 wait handler's `spec` method.

*Call graph*: called by 1 (spec); 2 external calls (Namespace, vec!).


##### `create_wait_agent_tool_v2`  (lines 255–265)

```
fn create_wait_agent_tool_v2(options: WaitAgentTimeoutOptions) -> ToolSpec
```

**Purpose**: Builds the direct-function v2 `wait_agent` tool spec for mailbox-update waiting rather than explicit target-final-status waiting.

**Data flow**: Consumes timeout options and returns `ToolSpec::Function` with parameters from `wait_agent_tool_parameters_v2(options)` and output schema `wait_output_schema_v2()`.

**Call relations**: Used by newer wait-tool registration paths and delegates parameter/output details to dedicated helpers.

*Call graph*: calls 2 internal fn (wait_agent_tool_parameters_v2, wait_output_schema_v2); called by 1 (spec); 1 external calls (Function).


##### `create_list_agents_tool`  (lines 267–286)

```
fn create_list_agents_tool() -> ToolSpec
```

**Purpose**: Builds the direct-function `list_agents` tool spec for enumerating live agents, optionally filtered by task-path prefix.

**Data flow**: Creates an optional `path_prefix` string property, wraps it in a function `ToolSpec`, and attaches `list_agents_output_schema()`.

**Call relations**: Used by registration code for agent-listing capabilities.

*Call graph*: calls 3 internal fn (list_agents_output_schema, object, string); called by 1 (spec); 2 external calls (from, Function).


##### `create_close_agent_tool_v1`  (lines 288–308)

```
fn create_close_agent_tool_v1() -> ToolSpec
```

**Purpose**: Builds the namespaced v1 `close_agent` tool spec.

**Data flow**: Creates a required `target` string property and returns a namespaced `ToolSpec` whose output schema is `agent_previous_status_output_schema(...)` with close-specific wording.

**Call relations**: Called by the close-agent handler's `spec` method.

*Call graph*: calls 1 internal fn (string); called by 1 (spec); 3 external calls (from, Namespace, vec!).


##### `create_interrupt_agent_tool_v2`  (lines 310–328)

```
fn create_interrupt_agent_tool_v2() -> ToolSpec
```

**Purpose**: Builds the direct-function `interrupt_agent` tool spec for interrupting an agent without closing it.

**Data flow**: Creates a required `target` string property, wraps it in a function `ToolSpec`, and attaches `agent_previous_status_output_schema(...)` with interrupt-specific wording.

**Call relations**: Used by newer collaboration surfaces that expose interruption separately from closure.

*Call graph*: calls 3 internal fn (agent_previous_status_output_schema, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `agent_status_output_schema`  (lines 330–359)

```
fn agent_status_output_schema() -> Value
```

**Purpose**: Defines the reusable JSON schema fragment representing the `AgentStatus` union.

**Data flow**: Returns a `serde_json::Value` built with `json!` describing a `oneOf` union of string statuses (`pending_init`, `running`, `interrupted`, `shutdown`, `not_found`), a `{ completed: string|null }` object, or an `{ errored: string }` object.

**Call relations**: Referenced by multiple output-schema builders so all tools describe agent status consistently.

*Call graph*: 1 external calls (json!).


##### `spawn_agent_output_schema_v1`  (lines 361–377)

```
fn spawn_agent_output_schema_v1() -> Value
```

**Purpose**: Defines the v1 spawn-agent result schema containing the new thread id and optional nickname.

**Data flow**: Returns a JSON object schema with required `agent_id: string` and `nickname: string|null` fields.

**Call relations**: Used by `create_spawn_agent_tool_v1`.

*Call graph*: 1 external calls (json!).


##### `spawn_agent_output_schema_v2`  (lines 379–409)

```
fn spawn_agent_output_schema_v2(hide_agent_metadata: bool) -> Value
```

**Purpose**: Defines the v2 spawn-agent result schema, optionally hiding nickname metadata.

**Data flow**: Accepts `hide_agent_metadata: bool` → if true, returns an object schema with only required `task_name`; otherwise returns an object schema with required `task_name` and `nickname`.

**Call relations**: Called by `create_spawn_agent_tool_v2` to align the output shape with whether metadata fields were hidden from the input schema.

*Call graph*: called by 1 (create_spawn_agent_tool_v2); 1 external calls (json!).


##### `send_input_output_schema`  (lines 411–423)

```
fn send_input_output_schema() -> Value
```

**Purpose**: Defines the send-input result schema containing the queued submission id.

**Data flow**: Returns a JSON object schema with required `submission_id: string`.

**Call relations**: Used by `create_send_input_tool_v1`.

*Call graph*: 1 external calls (json!).


##### `list_agents_output_schema`  (lines 425–456)

```
fn list_agents_output_schema() -> Value
```

**Purpose**: Defines the list-agents result schema containing an array of live-agent summaries.

**Data flow**: Returns a JSON object schema with required `agents`, where each array item contains `agent_name`, `agent_status` constrained by `agent_status_output_schema()`, and `last_task_message`.

**Call relations**: Used by `create_list_agents_tool`.

*Call graph*: called by 1 (create_list_agents_tool); 1 external calls (json!).


##### `resume_agent_output_schema`  (lines 458–467)

```
fn resume_agent_output_schema() -> Value
```

**Purpose**: Defines the resume-agent result schema containing the resulting agent status.

**Data flow**: Returns a JSON object schema with required `status` using `agent_status_output_schema()`.

**Call relations**: Used by `create_resume_agent_tool`.

*Call graph*: 1 external calls (json!).


##### `wait_output_schema_v1`  (lines 469–486)

```
fn wait_output_schema_v1() -> Value
```

**Purpose**: Defines the v1 wait-agent result schema containing final statuses keyed by agent id and a timeout flag.

**Data flow**: Returns a JSON object schema with required `status` as an object whose additional properties follow `agent_status_output_schema()`, plus required `timed_out: boolean`.

**Call relations**: Used by `create_wait_agent_tool_v1`.

*Call graph*: 1 external calls (json!).


##### `wait_output_schema_v2`  (lines 488–504)

```
fn wait_output_schema_v2() -> Value
```

**Purpose**: Defines the v2 wait-agent result schema containing only a summary message and timeout flag.

**Data flow**: Returns a JSON object schema with required `message: string` and `timed_out: boolean`.

**Call relations**: Used by `create_wait_agent_tool_v2`.

*Call graph*: called by 1 (create_wait_agent_tool_v2); 1 external calls (json!).


##### `agent_previous_status_output_schema`  (lines 506–518)

```
fn agent_previous_status_output_schema(previous_status_description: &str) -> Value
```

**Purpose**: Defines a reusable output schema for tools that return the target agent's previous status before an interrupt or close action.

**Data flow**: Accepts `previous_status_description: &str` and returns a JSON object schema with required `previous_status`, described by the supplied text and constrained by `agent_status_output_schema()`.

**Call relations**: Used by `create_close_agent_tool_v1` and `create_interrupt_agent_tool_v2`.

*Call graph*: called by 1 (create_interrupt_agent_tool_v2); 1 external calls (json!).


##### `create_collab_input_items_schema`  (lines 520–553)

```
fn create_collab_input_items_schema() -> JsonSchema
```

**Purpose**: Defines the schema for structured collaboration input items such as text, images, skills, and mentions.

**Data flow**: Builds a property map for `type`, `text`, `image_url`, `path`, and `name`, wraps it in an object schema allowing additional properties to be false, then wraps that object in an array schema with a description explaining structured mentions and connector paths.

**Call relations**: Used by `create_send_input_tool_v1` and `spawn_agent_common_properties_v1` wherever structured `items` input is allowed.

*Call graph*: calls 3 internal fn (array, object, string); called by 2 (create_send_input_tool_v1, spawn_agent_common_properties_v1); 1 external calls (from).


##### `spawn_agent_common_properties_v1`  (lines 555–596)

```
fn spawn_agent_common_properties_v1(agent_type_description: &str) -> BTreeMap<String, JsonSchema>
```

**Purpose**: Builds the shared v1 spawn-agent parameter property map before optional field hiding.

**Data flow**: Accepts `agent_type_description: &str` and returns a `BTreeMap<String, JsonSchema>` containing `message`, `items`, `agent_type`, `fork_context`, `model`, `reasoning_effort`, and `service_tier` properties.

**Call relations**: Called by `create_spawn_agent_tool_v1`, which may then pass the map through `hide_spawn_agent_metadata_options`.

*Call graph*: calls 3 internal fn (create_collab_input_items_schema, boolean, string); called by 1 (create_spawn_agent_tool_v1); 1 external calls (from).


##### `spawn_agent_common_properties_v2`  (lines 598–638)

```
fn spawn_agent_common_properties_v2(agent_type_description: &str) -> BTreeMap<String, JsonSchema>
```

**Purpose**: Builds the shared v2 spawn-agent parameter property map before optional field hiding and task-name insertion.

**Data flow**: Accepts `agent_type_description` and returns a `BTreeMap` containing encrypted `message`, `agent_type`, `fork_turns`, `model`, `reasoning_effort`, and `service_tier` properties.

**Call relations**: Called by `create_spawn_agent_tool_v2`, which may hide metadata fields and then add `task_name`.

*Call graph*: calls 1 internal fn (string); called by 1 (create_spawn_agent_tool_v2); 1 external calls (from).


##### `hide_spawn_agent_metadata_options`  (lines 640–645)

```
fn hide_spawn_agent_metadata_options(properties: &mut BTreeMap<String, JsonSchema>)
```

**Purpose**: Removes role/model/reasoning/service-tier override fields from a spawn-agent property map.

**Data flow**: Mutably edits `properties: &mut BTreeMap<String, JsonSchema>` by removing `agent_type`, `model`, `reasoning_effort`, and `service_tier` keys.

**Call relations**: Called by both spawn-tool builders when `SpawnAgentToolOptions.hide_agent_type_model_reasoning` is enabled.

*Call graph*: called by 2 (create_spawn_agent_tool_v1, create_spawn_agent_tool_v2).


##### `spawn_agent_tool_description`  (lines 647–709)

```
fn spawn_agent_tool_description(
    available_models_description: Option<&str>,
    inherited_model_guidance: Option<&str>,
    return_value_description: &str,
    include_usage_hint: bool,
    usage
```

**Purpose**: Generates the long-form natural-language description for the v1 spawn-agent tool, optionally including model guidance and extensive usage rules.

**Data flow**: Accepts optional available-model text, optional inherited-model guidance, a return-value description, and usage-hint controls → builds a base description string with `format!`; if usage hints are disabled it returns that base text, if custom hint text is provided it appends it, otherwise it appends a built-in multi-section guidance block covering when to delegate, how to design subtasks, and how to behave after delegation.

**Call relations**: Used by `create_spawn_agent_tool_v1` to shape model behavior beyond the raw schema.

*Call graph*: 1 external calls (format!).


##### `spawn_agent_tool_description_v2`  (lines 711–745)

```
fn spawn_agent_tool_description_v2(
    available_models_description: Option<&str>,
    inherited_model_guidance: Option<&str>,
    include_usage_hint: bool,
    usage_hint_text: Option<String>,
) ->
```

**Purpose**: Generates the long-form description for the v2 spawn-agent tool, emphasizing canonical task names, communication semantics, and fork-turn behavior.

**Data flow**: Accepts optional model guidance, optional inherited-model guidance, and usage-hint controls → builds a base description string with `format!` describing task-name resolution, inherited tools, parallelism expectations, and `fork_turns` semantics; if usage hints are enabled and custom text is provided, appends that text, otherwise returns the base description unchanged.

**Call relations**: Called by `create_spawn_agent_tool_v2`.

*Call graph*: called by 1 (create_spawn_agent_tool_v2); 1 external calls (format!).


##### `spawn_agent_models_description`  (lines 747–808)

```
fn spawn_agent_models_description(models: &[ModelPreset]) -> String
```

**Purpose**: Summarizes a limited set of picker-visible model overrides, including descriptions, supported reasoning efforts, and service tiers.

**Data flow**: Accepts `models: &[ModelPreset]` → filters to `show_in_picker`, takes at most `MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT_DESCRIPTION`, and if none remain returns a fallback string. Otherwise it formats one bullet per visible model, truncating long reasoning-effort labels to `MAX_REASONING_EFFORT_CHARS_IN_SPAWN_AGENT_DESCRIPTION`, marking the default effort, appending service-tier lists when present, joins the bullets with newlines, and prefixes them with an explanatory heading.

**Call relations**: Used by both spawn-tool builders when metadata override guidance is visible.

*Call graph*: 2 external calls (format!, iter).


##### `wait_agent_tool_parameters_v1`  (lines 810–836)

```
fn wait_agent_tool_parameters_v1(options: WaitAgentTimeoutOptions) -> JsonSchema
```

**Purpose**: Builds the v1 wait-agent parameter schema requiring explicit target ids and allowing a bounded timeout override.

**Data flow**: Accepts `options: WaitAgentTimeoutOptions` → creates properties for `targets` as an array of strings and `timeout_ms` as a number whose description embeds the default/min/max values via `format!` → returns an object schema requiring `targets` and forbidding additional properties.

**Call relations**: Used by `create_wait_agent_tool_v1`.

*Call graph*: calls 4 internal fn (array, number, object, string); 3 external calls (from, format!, vec!).


##### `wait_agent_tool_parameters_v2`  (lines 838–848)

```
fn wait_agent_tool_parameters_v2(options: WaitAgentTimeoutOptions) -> JsonSchema
```

**Purpose**: Builds the v2 wait-agent parameter schema containing only an optional timeout override.

**Data flow**: Accepts timeout options, creates a single `timeout_ms` number property whose description embeds the configured bounds, and returns an object schema with no required fields and no additional properties.

**Call relations**: Called by `create_wait_agent_tool_v2`.

*Call graph*: calls 2 internal fn (number, object); called by 1 (create_wait_agent_tool_v2); 2 external calls (from, format!).


### `core/src/tools/handlers/multi_agents_common.rs`

`util` · `cross-cutting across all multi-agent tool calls`

This file is the utility backbone for the multi-agent handlers. It defines timeout constants, payload extraction helpers, output serialization helpers, protocol status formatting, normalized collaboration error mapping, input parsing, and the config-building logic that ensures child agents inherit the live turn's runtime state rather than stale persisted config.

At the tool boundary, `function_arguments` enforces that these handlers only accept `ToolPayload::Function`, while `tool_output_json_text`, `tool_output_response_item`, and `tool_output_code_mode_result` standardize how typed results become log strings, `ResponseInputItem`s, and JSON values. `build_wait_agent_statuses` merges raw `HashMap<ThreadId, AgentStatus>` data with optional `CollabAgentRef` metadata, preserving caller order for known agents and appending sorted metadata-less extras.

For error handling, `collab_spawn_error` and `collab_agent_error` translate `CodexErr` variants into model-facing `FunctionCallError::RespondToModel` messages, with special cases for unavailable thread managers, missing threads, and closed agents. `thread_spawn_source` reconstructs a `SessionSource::SubAgent(SubAgentSource::ThreadSpawn)` lineage record, optionally extending the parent `AgentPath` with a task name.

The config helpers are especially important. `build_agent_spawn_config` and `build_agent_resume_config` both derive from `build_agent_shared_config`, which clones `turn.config` but refreshes runtime-owned fields such as model slug, provider info, reasoning settings, developer instructions, compact prompt, approval policy, permission profile, sandbox executable, shell environment policy, and cwd. Additional helpers validate spawn-time constraints: `reject_full_fork_spawn_overrides` forbids incompatible overrides on full-history forks; `apply_requested_spawn_agent_model_overrides` resolves requested models through the models manager and validates reasoning effort support; `apply_spawn_agent_service_tier` chooses the first supported service tier from config/request/parent candidates; `find_spawn_agent_model_name` and `validate_spawn_agent_reasoning_effort` produce explicit model-facing errors when overrides are invalid.

#### Function details

##### `function_arguments`  (lines 34–41)

```
fn function_arguments(payload: ToolPayload) -> Result<String, FunctionCallError>
```

**Purpose**: Extracts the raw JSON argument string from a function-style tool payload and rejects any other payload kind.

**Data flow**: Consumes `payload: ToolPayload` → if it is `ToolPayload::Function { arguments }`, returns the owned `arguments` string; otherwise returns `FunctionCallError::RespondToModel("collab handler received unsupported payload")`.

**Call relations**: Called near the start of every concrete multi-agent handler to normalize payload handling before argument deserialization.

*Call graph*: 1 external calls (RespondToModel).


##### `tool_output_json_text`  (lines 43–50)

```
fn tool_output_json_text(value: &T, tool_name: &str) -> String
```

**Purpose**: Serializes a tool result value into JSON text for logs and text-based tool outputs, with a fallback error string if serialization fails.

**Data flow**: Takes `value: &T` and `tool_name: &str` where `T: Serialize` → attempts `serde_json::to_string(value)` → returns the JSON string on success or a JSON string containing `failed to serialize <tool_name> result: ...` on failure.

**Call relations**: Used directly by result types' `log_preview` methods and indirectly by `tool_output_response_item`.

*Call graph*: called by 1 (tool_output_response_item); 1 external calls (to_string).


##### `tool_output_response_item`  (lines 52–64)

```
fn tool_output_response_item(
    call_id: &str,
    payload: &ToolPayload,
    value: &T,
    success: Option<bool>,
    tool_name: &str,
) -> ResponseInputItem
```

**Purpose**: Builds a `ResponseInputItem` from a serializable tool result using the standard function-tool output wrapper.

**Data flow**: Accepts `call_id`, original `payload`, serializable `value`, optional `success`, and `tool_name` → serializes the value with `tool_output_json_text` → wraps it in `FunctionToolOutput::from_text(..., success)` → converts that wrapper into a `ResponseInputItem` with `.to_response_item(call_id, payload)`.

**Call relations**: Called by each concrete result type's `to_response_item` implementation so all multi-agent tools emit response items consistently.

*Call graph*: calls 2 internal fn (from_text, tool_output_json_text).


##### `tool_output_code_mode_result`  (lines 66–73)

```
fn tool_output_code_mode_result(value: &T, tool_name: &str) -> JsonValue
```

**Purpose**: Serializes a tool result into a structured `JsonValue` for code-mode consumers, with a fallback string on serialization failure.

**Data flow**: Takes `value: &T` and `tool_name: &str` → attempts `serde_json::to_value(value)` → returns the JSON value on success or a `JsonValue::String` describing the serialization failure.

**Call relations**: Used by each concrete result type's `code_mode_result` implementation.

*Call graph*: 1 external calls (to_value).


##### `build_wait_agent_statuses`  (lines 75–110)

```
fn build_wait_agent_statuses(
    statuses: &HashMap<ThreadId, AgentStatus>,
    receiver_agents: &[CollabAgentRef],
) -> Vec<CollabAgentStatusEntry>
```

**Purpose**: Combines raw status data and optional agent metadata into ordered `CollabAgentStatusEntry` records for waiting end events.

**Data flow**: Accepts `statuses: &HashMap<ThreadId, AgentStatus>` and `receiver_agents: &[CollabAgentRef]` → returns an empty vector if no statuses exist. Otherwise it preallocates output storage, records seen thread ids from `receiver_agents`, pushes entries for any receiver agent that has a status while preserving the receiver list order, then builds extra entries for statuses whose ids were not in `receiver_agents` with `agent_nickname`/`agent_role` set to `None`, sorts those extras by thread-id string, appends them, and returns the combined vector.

**Call relations**: Used by wait-related handlers when emitting `CollabWaitingEndEvent`, ensuring protocol events include metadata when known and deterministic ordering when not.

*Call graph*: 4 external calls (with_capacity, new, with_capacity, len).


##### `collab_spawn_error`  (lines 112–120)

```
fn collab_spawn_error(err: CodexErr) -> FunctionCallError
```

**Purpose**: Normalizes spawn-related `CodexErr` values into model-facing `FunctionCallError`s with collaboration-specific wording.

**Data flow**: Consumes `err: CodexErr` → maps `UnsupportedOperation("thread manager dropped")` to `RespondToModel("collab manager unavailable")`, other `UnsupportedOperation(message)` to `RespondToModel(message)`, and all remaining errors to `RespondToModel(format!("collab spawn failed: {err}"))`.

**Call relations**: Used by spawn handlers after `agent_control.spawn_*` calls so infrastructure failures become readable model errors.

*Call graph*: 2 external calls (format!, RespondToModel).


##### `collab_agent_error`  (lines 122–135)

```
fn collab_agent_error(agent_id: ThreadId, err: CodexErr) -> FunctionCallError
```

**Purpose**: Normalizes non-spawn agent-control errors into model-facing collaboration errors with special handling for missing or closed agents.

**Data flow**: Consumes `agent_id: ThreadId` and `err: CodexErr` → maps `ThreadNotFound(id)` to `agent with id {id} not found`, `InternalAgentDied` to `agent with id {agent_id} is closed`, any `UnsupportedOperation(_)` to `collab manager unavailable`, and all other errors to `collab tool failed: {err}` wrapped in `FunctionCallError::RespondToModel`.

**Call relations**: Used by close, resume, send-input, and wait flows whenever an `agent_control` operation fails.

*Call graph*: 2 external calls (format!, RespondToModel).


##### `thread_spawn_source`  (lines 137–161)

```
fn thread_spawn_source(
    parent_thread_id: ThreadId,
    parent_session_source: &SessionSource,
    depth: i32,
    agent_role: Option<&str>,
    task_name: Option<String>,
) -> Result<SessionSourc
```

**Purpose**: Constructs the `SessionSource` lineage record for a spawned or resumed child agent, optionally extending the parent task path with a task name.

**Data flow**: Accepts `parent_thread_id`, `parent_session_source`, `depth`, optional `agent_role`, and optional `task_name` → if `task_name` is present, obtains the parent's `AgentPath` or root, joins the task name onto it, and maps any path error into `FunctionCallError::RespondToModel`; then returns `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, depth, agent_path, agent_nickname: None, agent_role: agent_role.map(str::to_string) })`.

**Call relations**: Called by spawn and resume helpers when invoking `agent_control`, so child agents carry correct ancestry and optional task-path metadata.

*Call graph*: 1 external calls (SubAgent).


##### `parse_collab_input`  (lines 163–195)

```
fn parse_collab_input(
    message: Option<String>,
    items: Option<Vec<UserInput>>,
) -> Result<Op, FunctionCallError>
```

**Purpose**: Validates the mutually exclusive `message`/`items` input forms and converts them into the unified `Op` representation expected by agent-control APIs.

**Data flow**: Accepts `message: Option<String>` and `items: Option<Vec<UserInput>>` → rejects both-present and both-absent cases with model-facing errors; for `Some(message)` it trims and rejects empty text, otherwise wraps the text in a single `UserInput::Text { text, text_elements: Vec::new() }` and converts that vector into `Op`; for `Some(items)` it rejects an empty vector and otherwise converts the items directly into `Op`.

**Call relations**: Used by spawn and send-input handlers to normalize model arguments before rendering previews or sending work to agents.

*Call graph*: 2 external calls (RespondToModel, vec!).


##### `build_agent_spawn_config`  (lines 204–211)

```
fn build_agent_spawn_config(
    base_instructions: &BaseInstructions,
    turn: &TurnContext,
) -> Result<Config, FunctionCallError>
```

**Purpose**: Builds the base config snapshot for a newly spawned child agent from the current turn plus explicit base instructions.

**Data flow**: Accepts `base_instructions: &BaseInstructions` and `turn: &TurnContext` → calls `build_agent_shared_config(turn)` to clone and refresh the parent's effective config → sets `config.base_instructions = Some(base_instructions.text.clone())` → returns the resulting `Config`.

**Call relations**: Called by spawn handlers before applying role/model/service-tier overrides, ensuring new agents start from the live turn's effective configuration.

*Call graph*: calls 1 internal fn (build_agent_shared_config).


##### `build_agent_resume_config`  (lines 213–218)

```
fn build_agent_resume_config(turn: &TurnContext) -> Result<Config, FunctionCallError>
```

**Purpose**: Builds the runtime-correct config used when reloading a previously closed agent, while intentionally leaving base instructions to rollout/session metadata.

**Data flow**: Accepts `turn: &TurnContext` → calls `build_agent_shared_config(turn)` → sets `config.base_instructions = None` → returns the resulting `Config`.

**Call relations**: Used by resume flows and by send-input preloading logic when an existing agent may need to be loaded into memory.

*Call graph*: calls 1 internal fn (build_agent_shared_config).


##### `build_agent_shared_config`  (lines 220–235)

```
fn build_agent_shared_config(turn: &TurnContext) -> Result<Config, FunctionCallError>
```

**Purpose**: Clones the turn's persisted config and refreshes all runtime-owned fields that must match the live parent turn.

**Data flow**: Accepts `turn: &TurnContext` → clones `turn.config` into a mutable `Config` → overwrites `model`, `model_provider`, `model_reasoning_effort`, `model_reasoning_summary`, `developer_instructions`, and `compact_prompt` from live turn state → calls `apply_spawn_agent_runtime_overrides(&mut config, turn)` to copy approval, permission, sandbox, and cwd state → returns the updated config.

**Call relations**: This private helper underpins both `build_agent_spawn_config` and `build_agent_resume_config`, centralizing the invariant that child agents must inherit live runtime state rather than stale snapshots.

*Call graph*: calls 1 internal fn (apply_spawn_agent_runtime_overrides); called by 2 (build_agent_resume_config, build_agent_spawn_config).


##### `reject_full_fork_spawn_overrides`  (lines 237–248)

```
fn reject_full_fork_spawn_overrides(
    agent_type: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<ReasoningEffort>,
) -> Result<(), FunctionCallError>
```

**Purpose**: Enforces that full-history forked agents cannot override inherited role, model, or reasoning settings.

**Data flow**: Accepts optional `agent_type`, `model`, and `reasoning_effort` → if any are present, returns `FunctionCallError::RespondToModel` with a detailed explanation that full-history forks inherit those fields; otherwise returns `Ok(())`.

**Call relations**: Called by spawn logic only when `fork_context` is enabled, guarding a design invariant about identity-preserving forks.

*Call graph*: 1 external calls (RespondToModel).


##### `apply_spawn_agent_runtime_overrides`  (lines 254–278)

```
fn apply_spawn_agent_runtime_overrides(
    config: &mut Config,
    turn: &TurnContext,
) -> Result<(), FunctionCallError>
```

**Purpose**: Copies runtime-only turn state such as approval policy, permission profile, sandbox executable, shell environment policy, reviewer, and cwd onto a child config.

**Data flow**: Mutably updates `config: &mut Config` from `turn: &TurnContext` → sets `config.permissions.approval_policy` from `turn.approval_policy.value()`, `config.approvals_reviewer`, `config.permissions.shell_environment_policy`, `config.codex_linux_sandbox_exe`, and deprecated `config.cwd` from the turn → sets the permission profile from `turn.permission_profile()` → maps any invalid approval-policy or permission-profile errors into `FunctionCallError::RespondToModel`.

**Call relations**: Called from `build_agent_shared_config`, so every spawn/resume config inherits the live runtime policy envelope.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (build_agent_shared_config).


##### `apply_requested_spawn_agent_model_overrides`  (lines 280–329)

```
async fn apply_requested_spawn_agent_model_overrides(
    session: &Session,
    turn: &TurnContext,
    config: &mut Config,
    requested_model: Option<&str>,
    requested_reasoning_effort: Option<
```

**Purpose**: Applies optional model and reasoning-effort overrides to a child config, validating them against the models manager and supported reasoning levels.

**Data flow**: Accepts `session`, `turn`, mutable `config`, optional `requested_model`, and optional `requested_reasoning_effort`. If neither override is present, it returns immediately. If a model is requested, it awaits `models_manager.list_models(RefreshStrategy::Offline)`, resolves the exact model name with `find_spawn_agent_model_name`, awaits `get_model_info` for that model using `config.to_models_manager_config()`, writes `config.model`, and either validates and sets the requested reasoning effort or falls back to the selected model's default reasoning level. If only reasoning effort is requested, it validates against `turn.model_info.supported_reasoning_levels` and writes `config.model_reasoning_effort`. Errors become `FunctionCallError`.

**Call relations**: Called by spawn logic for non-forked agents before role application, so explicit model/reasoning overrides are validated against actual model capabilities.

*Call graph*: calls 2 internal fn (find_spawn_agent_model_name, validate_spawn_agent_reasoning_effort); 1 external calls (to_models_manager_config).


##### `apply_spawn_agent_service_tier`  (lines 331–384)

```
async fn apply_spawn_agent_service_tier(
    session: &Session,
    config: &mut Config,
    parent_service_tier: Option<&str>,
    requested_service_tier: Option<&str>,
) -> Result<(), FunctionCallEr
```

**Purpose**: Chooses and validates the child agent's service tier from config, explicit request, and parent fallback candidates against the selected model's supported tiers.

**Data flow**: Accepts `session`, mutable `config`, optional `parent_service_tier`, and optional `requested_service_tier` → builds an ordered candidate list `[config.service_tier, requested, parent]`. If all are `None`, it clears `config.service_tier` and returns. Otherwise it requires `config.model` to be present, fetches `model_info` from the models manager using `config.to_models_manager_config()`, explicitly rejects an unsupported requested tier with an error listing supported tiers, then sets `config.service_tier` to the first candidate tier supported by the model.

**Call relations**: Called by spawn logic after model resolution so service-tier selection is validated against the actual child model.

*Call graph*: 3 external calls (to_models_manager_config, format!, RespondToModel).


##### `find_spawn_agent_model_name`  (lines 386–404)

```
fn find_spawn_agent_model_name(
    available_models: &[codex_protocol::openai_models::ModelPreset],
    requested_model: &str,
) -> Result<String, FunctionCallError>
```

**Purpose**: Resolves a requested model slug against the currently available model presets and produces a detailed error if it is unknown.

**Data flow**: Accepts `available_models: &[ModelPreset]` and `requested_model: &str` → searches for a preset whose `model` field exactly matches the requested string → returns the matching model name clone on success or `RespondToModel` listing all available model slugs on failure.

**Call relations**: Used only by `apply_requested_spawn_agent_model_overrides` as the first validation step for explicit model overrides.

*Call graph*: called by 1 (apply_requested_spawn_agent_model_overrides); 1 external calls (iter).


##### `validate_spawn_agent_reasoning_effort`  (lines 406–426)

```
fn validate_spawn_agent_reasoning_effort(
    model: &str,
    supported_reasoning_levels: &[ReasoningEffortPreset],
    requested_reasoning_effort: &ReasoningEffort,
) -> Result<(), FunctionCallError
```

**Purpose**: Checks that a requested reasoning effort is supported by a given model and reports the supported values when it is not.

**Data flow**: Accepts `model`, `supported_reasoning_levels`, and `requested_reasoning_effort` → scans the presets for a matching effort and returns `Ok(())` if found; otherwise joins the supported effort strings and returns `RespondToModel` describing the unsupported request and the allowed values.

**Call relations**: Called by `apply_requested_spawn_agent_model_overrides` for both explicit-model and inherited-model reasoning validation paths.

*Call graph*: called by 1 (apply_requested_spawn_agent_model_overrides); 3 external calls (format!, iter, RespondToModel).


### `core/src/tools/handlers/multi_agents.rs`

`orchestration` · `tool registration and every multi-agent tool invocation`

This module is the top-level hub for the multi-agent tool family. It re-exports the common helper module and the concrete handler types from the `close_agent`, `resume_agent`, `send_input`, `spawn`, and `wait` submodules so the tool registry can wire them in as a coherent namespace under `MULTI_AGENT_V1_NAMESPACE`. The file itself contains the small but important glue functions that normalize agent identifiers and annotate tool specs for search.

`parse_agent_id_target` converts a model-supplied string into a concrete `ThreadId`, translating parse failures into `FunctionCallError::RespondToModel` so the model gets a user-facing validation error instead of an internal failure. `parse_agent_id_targets` applies that conversion across a list while enforcing the invariant that wait-style operations must receive at least one target. `multi_agent_tool_search_info` wraps a `ToolSpec` with a fixed source label and description (`Multi-agent tools` / `Spawn and manage sub-agents.`), which lets these tools appear in search with consistent provenance.

The imports show the broader contract this module participates in: handlers operate on `ToolInvocation`, emit `ToolOutput`, interact with `Session` and `TurnContext`, and ultimately drive `agent_control` operations while producing collaboration protocol events. The file itself does not execute those workflows, but it defines the shared entry points and naming conventions the submodules rely on.

#### Function details

##### `parse_agent_id_target`  (lines 47–51)

```
fn parse_agent_id_target(target: &str) -> Result<ThreadId, FunctionCallError>
```

**Purpose**: Parses one model-provided agent identifier string into a `ThreadId` and converts parse failures into a model-facing validation error.

**Data flow**: Takes `target: &str` → calls `ThreadId::from_string` → on success returns the parsed `ThreadId`; on failure returns `FunctionCallError::RespondToModel` containing the original target text and debug-formatted parse error.

**Call relations**: This helper is used by concrete handlers when they need a single agent target, so they all enforce the same identifier syntax and error wording before calling `agent_control` APIs.

*Call graph*: calls 1 internal fn (from_string).


##### `parse_agent_id_targets`  (lines 53–66)

```
fn parse_agent_id_targets(
    targets: Vec<String>,
) -> Result<Vec<ThreadId>, FunctionCallError>
```

**Purpose**: Validates and parses a non-empty list of agent id strings into `Vec<ThreadId>` for multi-target operations.

**Data flow**: Consumes `targets: Vec<String>` → rejects an empty vector with `RespondToModel("agent ids must be non-empty")` → otherwise maps each string through `parse_agent_id_target` and collects the parsed `ThreadId` values into a vector.

**Call relations**: This is the batch form of single-id parsing and is used by handlers such as waiting logic that operate on multiple agents at once; it delegates per-element validation to `parse_agent_id_target` after enforcing the list-level non-empty invariant.

*Call graph*: 1 external calls (RespondToModel).


##### `multi_agent_tool_search_info`  (lines 68–80)

```
fn multi_agent_tool_search_info(
    search_text: &str,
    spec: codex_tools::ToolSpec,
) -> Option<ToolSearchInfo>
```

**Purpose**: Builds `ToolSearchInfo` for a multi-agent tool spec with a fixed source name and description so search results are grouped consistently.

**Data flow**: Accepts `search_text: &str` and a `codex_tools::ToolSpec` → clones the search text into an owned `String` and passes the spec plus a `ToolSearchSourceInfo` carrying the multi-agent source metadata into `ToolSearchInfo::from_spec` → returns the resulting optional search descriptor.

**Call relations**: Concrete handler `search_info` methods call this helper after obtaining their own spec, so all multi-agent tools advertise themselves through the same search source branding.

*Call graph*: calls 1 internal fn (from_spec).


### `core/src/tools/handlers/multi_agents/spawn.rs`

`domain_logic` · `request handling for creating new sub-agents`

This module contains the most involved multi-agent handler because it translates a model tool call into a fully configured child agent. `Handler` stores `SpawnAgentToolOptions`, exposes a constructor, and uses those options when generating the tool schema with `create_spawn_agent_tool_v1`. Search metadata emphasizes delegation, parallel work, and model/reasoning choices.

`handle_spawn_agent` begins by parsing `SpawnAgentArgs`, trimming `agent_type` into an optional role name, converting `message` or `items` into an `Op`, and rendering a prompt preview. It computes the child depth from the current `session_source` and rejects the request if `exceeds_thread_spawn_depth_limit` says the configured maximum would be exceeded.

After emitting `CollabAgentSpawnBeginEvent`, it builds a child config from the live turn using `build_agent_spawn_config`, then layers optional service-tier, model, reasoning, and role overrides. Full-history forks are intentionally constrained: `reject_full_fork_spawn_overrides` forbids changing role/model/reasoning when `fork_context` is true, because those agents must inherit the parent's execution identity. Non-forked spawns instead validate requested model and reasoning through the models manager and apply role-specific config via `apply_role_to_config`. Runtime-only state such as approval policy, sandbox, cwd, and environment selections is preserved through shared helpers.

The actual spawn happens through `agent_control.spawn_agent_with_metadata`, passing a reconstructed `thread_spawn_source` and `SpawnAgentOptions` that include fork metadata, parent thread id, and environment selections. The handler then fetches a config snapshot when possible to derive the effective nickname, role, model, and reasoning effort for the end event. It emits `CollabAgentSpawnEndEvent`, increments `codex.multi_agent.spawn` telemetry tagged with role and version, and returns `SpawnAgentResult { agent_id, nickname }`.

#### Function details

##### `Handler::new`  (lines 20–22)

```
fn new(options: SpawnAgentToolOptions) -> Self
```

**Purpose**: Constructs a spawn-agent handler with the supplied schema-generation options.

**Data flow**: Consumes `options: SpawnAgentToolOptions` and stores it in `Self { options }`, returning the new handler.

**Call relations**: Called by setup code when registering the spawn tool so the handler can later generate a spec tailored to available models and UI guidance.


##### `Handler::tool_name`  (lines 26–28)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the namespaced identifier `multi_agent_v1.spawn_agent`.

**Data flow**: Builds and returns a `ToolName` from the namespace constant and literal tool name.

**Call relations**: Used by the registry to expose and dispatch this handler.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 30–32)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the spawn-agent tool schema using the handler's configured options.

**Data flow**: Clones `self.options` and passes them to `create_spawn_agent_tool_v1`, returning the resulting `ToolSpec`.

**Call relations**: Used directly by registration and indirectly by `Handler::search_info`; cloning ensures schema generation does not consume the stored options.

*Call graph*: calls 1 internal fn (create_spawn_agent_tool_v1); called by 1 (search_info); 1 external calls (clone).


##### `Handler::search_info`  (lines 34–39)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides search metadata for delegation- and spawning-related queries.

**Data flow**: Calls `self.spec()` and combines it with a fixed keyword string through `multi_agent_tool_search_info`, returning an optional search descriptor.

**Call relations**: Used by discovery flows and depends on `Handler::spec` for the underlying tool definition.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 41–43)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Wraps the async spawn workflow in the boxed future expected by the executor trait.

**Data flow**: Consumes a `ToolInvocation`, pins an async block, awaits `handle_spawn_agent(invocation)`, and boxes the successful typed result with `boxed_tool_output`.

**Call relations**: This is the runtime entrypoint and delegates all substantive work to `handle_spawn_agent`.

*Call graph*: calls 1 internal fn (handle_spawn_agent); 1 external calls (pin).


##### `handle_spawn_agent`  (lines 46–210)

```
async fn handle_spawn_agent(
    invocation: ToolInvocation,
) -> Result<SpawnAgentResult, FunctionCallError>
```

**Purpose**: Parses spawn arguments, validates depth and override rules, builds the child config from live turn state, requests agent creation through `agent_control`, emits spawn events, and returns the new agent id and nickname.

**Data flow**: Consumes invocation fields `session`, `turn`, `payload`, and `call_id` → extracts arguments and deserializes `SpawnAgentArgs` → normalizes `agent_type` into `role_name`, converts `message`/`items` into `input_items`, and renders a prompt preview. It reads `turn.session_source`, computes `child_depth` with `next_thread_spawn_depth`, compares against `turn.config.agent_max_depth`, and may return `RespondToModel` on limit breach. It writes `CollabAgentSpawnBeginEvent`, builds `config` from `build_agent_spawn_config(&session.get_base_instructions().await, turn.as_ref())`, optionally sets `config.service_tier`, then either rejects forbidden overrides for full-history forks or applies requested model/reasoning overrides and role config. It applies service-tier validation and runtime overrides, then awaits `spawn_agent_with_metadata(config, input_items, Some(thread_spawn_source(...)?), SpawnAgentOptions { ... })`. From the result it derives `new_thread_id`, metadata, status, optional config snapshot, effective model/reasoning, and nickname; it writes `CollabAgentSpawnEndEvent`, increments `turn.session_telemetry.counter("codex.multi_agent.spawn", 1, &[("role", role_tag), ("version", "v1")])`, and returns `SpawnAgentResult { agent_id: new_thread_id.to_string(), nickname }` or a mapped spawn error.

**Call relations**: Invoked only from `Handler::handle`. It is the central orchestration point for all shared config helpers in `multi_agents_common`, role application, event emission, and the final `agent_control` spawn call.

*Call graph*: calls 3 internal fn (render_input_preview, apply_role_to_config, now_unix_timestamp_ms); called by 1 (handle); 4 external calls (pin, exceeds_thread_spawn_depth_limit, next_thread_spawn_depth, RespondToModel).


##### `Handler::matches_kind`  (lines 213–215)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this handler to function payloads.

**Data flow**: Pattern-matches `payload` and returns whether it is `ToolPayload::Function { .. }`.

**Call relations**: Used by runtime dispatch before `handle` is entered.

*Call graph*: 1 external calls (matches!).


##### `SpawnAgentResult::log_preview`  (lines 237–239)

```
fn log_preview(&self) -> String
```

**Purpose**: Formats the spawn result as JSON text for logs.

**Data flow**: Serializes `self` through `tool_output_json_text` with the label `spawn_agent` and returns the string.

**Call relations**: Used by generic logging after a successful spawn.


##### `SpawnAgentResult::success_for_logging`  (lines 241–243)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks spawn results as successful for logging.

**Data flow**: Returns `true` unconditionally.

**Call relations**: Consumed by shared logging/output infrastructure.


##### `SpawnAgentResult::to_response_item`  (lines 245–247)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the typed spawn result into a model-facing response item.

**Data flow**: Takes `call_id`, `payload`, and `self`, then calls `tool_output_response_item` with success `Some(true)` and tool label `spawn_agent`.

**Call relations**: Used by generic tool-output plumbing after `handle_spawn_agent` succeeds.


##### `SpawnAgentResult::code_mode_result`  (lines 249–251)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the structured JSON form of the spawn result.

**Data flow**: Serializes `self` via `tool_output_code_mode_result` and returns the resulting `JsonValue`.

**Call relations**: Used by code-mode or structured-output consumers.


### `core/src/tools/handlers/multi_agents/send_input.rs`

`domain_logic` · `request handling for follow-up messages to existing agents`

This module defines the `multi_agent_v1.send_input` tool. `Handler` exposes the namespaced tool name, schema from `create_send_input_tool_v1`, and search metadata focused on messaging, follow-up work, and interruption. The result type `SendInputResult` contains the `submission_id` returned by the agent-control layer and implements the standard output conversions.

The main logic is in `Handler::handle_call`. It extracts function arguments from the invocation payload, parses `SendInputArgs` (`target`, optional `message`, optional structured `items`, and `interrupt`), converts the target string into a `ThreadId`, and normalizes the input payload through `parse_collab_input`. It then renders a human-readable prompt preview from the resulting `Op` using `render_input_preview`; that preview is included in collaboration events.

If metadata exists for the target agent, the handler first builds a resume config from the current turn and calls `ensure_v2_agent_loaded`, which ensures a resumable agent is loaded before messaging. If `interrupt` is true, it explicitly interrupts the target before sending input. The handler emits `CollabAgentInteractionBeginEvent`, calls `agent_control.send_input`, fetches the target's latest status, and emits `CollabAgentInteractionEndEvent` with nickname, role, prompt preview, and status. Errors from loading, interrupting, or sending are normalized with `collab_agent_error`; the end event is still emitted after the send attempt because status is fetched regardless of send success.

#### Function details

##### `Handler::tool_name`  (lines 10–12)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the namespaced identifier `multi_agent_v1.send_input`.

**Data flow**: Constructs a `ToolName` from the fixed namespace and literal tool name and returns it.

**Call relations**: Used by registration and dispatch code to identify this tool.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 14–16)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the schema definition for the send-input tool.

**Data flow**: Returns the `ToolSpec` produced by `create_send_input_tool_v1()`.

**Call relations**: Consumed by the registry and by `Handler::search_info`.

*Call graph*: calls 1 internal fn (create_send_input_tool_v1); called by 1 (search_info).


##### `Handler::search_info`  (lines 18–23)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides search metadata for queries about sending messages or redirecting work to an agent.

**Data flow**: Calls `self.spec()` and combines it with a fixed keyword string via `multi_agent_tool_search_info`, returning an optional `ToolSearchInfo`.

**Call relations**: Used by tool discovery; it depends on `Handler::spec` for the underlying schema.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 25–27)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Boxes the async send-input workflow into the executor trait's future type.

**Data flow**: Consumes a `ToolInvocation` and returns `Box::pin(self.handle_call(invocation))`.

**Call relations**: This trait method is the runtime entrypoint and delegates directly to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 31–111)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates the target and input payload, optionally loads or interrupts the target agent, sends the input through `agent_control`, emits interaction events, and returns the queued submission id.

**Data flow**: Consumes `ToolInvocation { session, turn, payload, call_id, .. }` → extracts raw arguments with `function_arguments`, parses `SendInputArgs`, parses `args.target` into `receiver_thread_id`, and converts `message`/`items` into an `Op` with `parse_collab_input`. It derives a preview string with `render_input_preview`, reads optional metadata with `get_agent_metadata`, and if metadata exists builds a resume config via `build_agent_resume_config` and awaits `ensure_v2_agent_loaded`. If `args.interrupt` is true it awaits `interrupt_agent(receiver_thread_id)`. It writes `CollabAgentInteractionBeginEvent`, awaits `send_input(receiver_thread_id, input_items)`, reads the latest status with `get_status`, writes `CollabAgentInteractionEndEvent`, and on success returns boxed `SendInputResult { submission_id }`; any `CodexErr` from agent-control calls is mapped through `collab_agent_error`.

**Call relations**: Called only from `Handler::handle`. It sits between model-facing tool arguments and lower-level agent-control messaging, adding validation, optional preloading, optional interruption, and protocol event emission.

*Call graph*: calls 2 internal fn (render_input_preview, now_unix_timestamp_ms); called by 1 (handle).


##### `Handler::matches_kind`  (lines 115–117)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Accepts only function payloads for this tool runtime.

**Data flow**: Checks `payload` with `matches!` and returns whether it is `ToolPayload::Function { .. }`.

**Call relations**: Used by runtime dispatch before invoking `handle`.

*Call graph*: 1 external calls (matches!).


##### `SendInputResult::log_preview`  (lines 135–137)

```
fn log_preview(&self) -> String
```

**Purpose**: Serializes the submission result into JSON text for logs.

**Data flow**: Passes `self` and the label `send_input` to `tool_output_json_text` and returns the resulting string.

**Call relations**: Used by shared logging after successful input submission.


##### `SendInputResult::success_for_logging`  (lines 139–141)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks send-input results as successful in logs.

**Data flow**: Returns `true` unconditionally.

**Call relations**: Consumed by generic logging/output infrastructure.


##### `SendInputResult::to_response_item`  (lines 143–145)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the result into a `ResponseInputItem` for the model conversation.

**Data flow**: Takes `call_id`, `payload`, and `self`, then calls `tool_output_response_item` with success `Some(true)` and tool label `send_input`.

**Call relations**: Used by generic tool-output plumbing after `handle_call` returns.


##### `SendInputResult::code_mode_result`  (lines 147–149)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the JSON-value form of the send-input result.

**Data flow**: Serializes `self` through `tool_output_code_mode_result` and returns the `JsonValue`.

**Call relations**: Used by code-mode or structured-output consumers.


### `core/src/tools/handlers/multi_agents/wait.rs`

`domain_logic` · `request handling while blocked on sub-agent completion`

This module provides the `multi_agent_v1.wait_agent` tool. `Handler` stores timeout option values used when generating the schema, exposes a constructor, and advertises search terms around waiting for completion. `WaitAgentResult` returns a map from target identifier to final `AgentStatus` plus a `timed_out` flag.

`Handler::handle_call` starts by parsing `WaitArgs`, converting the `targets` strings into `ThreadId`s, and collecting metadata for each target into both `receiver_agents` (for protocol events) and `target_by_thread_id` (for the final response map). It validates `timeout_ms`, rejecting non-positive values and clamping accepted values into the configured min/max range.

After emitting `CollabWaitingBeginEvent`, the handler subscribes to each target's status watch channel. If a target is already in a final state, that status is recorded immediately; if the thread is missing, it is treated as `AgentStatus::NotFound`; if subscription fails for another reason, the handler emits an end event with best-effort status and returns an error. When no target is already final, it launches one `wait_for_final_status` future per target in a `FuturesUnordered` and waits until the first final status arrives or the timeout expires. Once one result arrives, it opportunistically drains any other already-ready completions without blocking further.

The handler then builds both protocol-facing `agent_statuses` and model-facing `status` maps, marks `timed_out` when no final statuses were observed, emits `CollabWaitingEndEvent`, and returns the boxed result. `wait_for_final_status` itself loops on a `watch::Receiver<AgentStatus>`, falling back to `get_status` if the channel closes unexpectedly.

#### Function details

##### `Handler::new`  (lines 25–27)

```
fn new(options: WaitAgentTimeoutOptions) -> Self
```

**Purpose**: Constructs a wait-agent handler with the supplied timeout option values.

**Data flow**: Consumes `options: WaitAgentTimeoutOptions`, stores it in `Self { options }`, and returns the handler.

**Call relations**: Called during tool registration so the schema and runtime share the same timeout defaults and bounds.


##### `Handler::tool_name`  (lines 31–33)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the namespaced identifier `multi_agent_v1.wait_agent`.

**Data flow**: Constructs and returns a `ToolName` from the namespace constant and literal tool name.

**Call relations**: Used by the registry to expose and dispatch this handler.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 35–37)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the wait-agent tool schema using the handler's timeout options.

**Data flow**: Passes `self.options` into `create_wait_agent_tool_v1` and returns the resulting `ToolSpec`.

**Call relations**: Used directly by registration and indirectly by `Handler::search_info`.

*Call graph*: calls 1 internal fn (create_wait_agent_tool_v1); called by 1 (search_info).


##### `Handler::search_info`  (lines 39–44)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides search metadata for completion-waiting queries.

**Data flow**: Calls `self.spec()` and combines it with a fixed keyword string via `multi_agent_tool_search_info`, returning an optional search descriptor.

**Call relations**: Used by discovery flows and depends on `Handler::spec`.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 46–48)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Boxes the async wait workflow into the executor trait's future type.

**Data flow**: Consumes a `ToolInvocation` and returns `Box::pin(self.handle_call(invocation))`.

**Call relations**: This is the runtime entrypoint and delegates directly to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 52–214)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Parses target ids and timeout, subscribes to target status streams, waits until at least one final status arrives or the deadline expires, emits begin/end waiting events, and returns the observed final statuses.

**Data flow**: Consumes `ToolInvocation { session, turn, payload, call_id, .. }` → extracts arguments and deserializes `WaitArgs` → parses `targets` into `receiver_thread_ids` and builds `receiver_agents` plus `target_by_thread_id` from `get_agent_metadata`. It validates `timeout_ms`, rejecting values `<= 0` and clamping others between `MIN_WAIT_TIMEOUT_MS` and `MAX_WAIT_TIMEOUT_MS`. It writes `CollabWaitingBeginEvent`, then for each target awaits `subscribe_status`: successful subscriptions contribute `(id, Receiver<AgentStatus>)` and may also populate `initial_final_statuses`; missing threads contribute `(id, AgentStatus::NotFound)`; other errors trigger an immediate `CollabWaitingEndEvent` with best-effort statuses and return `collab_agent_error`. If any initial final statuses exist, those become the result set. Otherwise it creates a `FuturesUnordered` of `wait_for_final_status(session.clone(), id, rx)` futures, computes a deadline with `Instant::now() + Duration::from_millis(timeout_ms as u64)`, and loops on `timeout_at(deadline, futures.next())` until one final result arrives or time runs out. After the first result it drains any immediately ready additional results with `now_or_never`. It then computes `timed_out`, converts statuses into both `HashMap<ThreadId, AgentStatus>` and response `HashMap<String, AgentStatus>`, builds protocol `agent_statuses` with `build_wait_agent_statuses`, emits `CollabWaitingEndEvent`, and returns boxed `WaitAgentResult`.

**Call relations**: Called only from `Handler::handle`. It delegates per-target blocking behavior to `wait_for_final_status` and uses shared helpers for target parsing, status-entry formatting, and error normalization.

*Call graph*: calls 3 internal fn (is_final, wait_for_final_status, now_unix_timestamp_ms); called by 1 (handle); 8 external calls (from_millis, new, with_capacity, now, new, with_capacity, timeout_at, RespondToModel).


##### `Handler::matches_kind`  (lines 218–220)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this runtime handler to function payloads.

**Data flow**: Checks `payload` with `matches!` and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: Used by runtime dispatch before invoking `handle`.

*Call graph*: 1 external calls (matches!).


##### `WaitAgentResult::log_preview`  (lines 237–239)

```
fn log_preview(&self) -> String
```

**Purpose**: Serializes the wait result into JSON text for logs.

**Data flow**: Passes `self` and the label `wait_agent` to `tool_output_json_text` and returns the resulting string.

**Call relations**: Used by shared logging after a wait call completes.


##### `WaitAgentResult::success_for_logging`  (lines 241–243)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks wait-agent results as successful for logging.

**Data flow**: Returns `true` unconditionally.

**Call relations**: Consumed by generic logging/output infrastructure.


##### `WaitAgentResult::to_response_item`  (lines 245–247)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the wait result into a response item for the model conversation.

**Data flow**: Takes `call_id`, `payload`, and `self`, then calls `tool_output_response_item` with success `None` and tool label `wait_agent`, returning the `ResponseInputItem`.

**Call relations**: Used by generic tool-output plumbing; unlike most other tools it leaves success unspecified because timeout is represented in-band by the result payload.


##### `WaitAgentResult::code_mode_result`  (lines 249–251)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the structured JSON form of the wait result.

**Data flow**: Serializes `self` through `tool_output_code_mode_result` and returns the `JsonValue`.

**Call relations**: Used by code-mode or structured-output consumers.


##### `wait_for_final_status`  (lines 254–274)

```
async fn wait_for_final_status(
    session: Arc<Session>,
    thread_id: ThreadId,
    mut status_rx: Receiver<AgentStatus>,
) -> Option<(ThreadId, AgentStatus)>
```

**Purpose**: Waits on a single agent's watch channel until it reaches a final status, with a fallback status lookup if the channel closes.

**Data flow**: Accepts `session: Arc<Session>`, `thread_id: ThreadId`, and `mut status_rx: Receiver<AgentStatus>` → reads the current status with `borrow`; if already final, returns `Some((thread_id, status))`. Otherwise it loops awaiting `status_rx.changed()`. If the channel closes, it fetches the latest status from `session.services.agent_control.get_status(thread_id)` and returns it only if final. After each successful change notification it re-borrows the status and returns `Some((thread_id, status))` once `is_final` becomes true; otherwise it keeps waiting.

**Call relations**: Spawned by `Handler::handle_call` inside a `FuturesUnordered` for each subscribed target when no target is already final. It isolates the per-agent watch-loop logic from the multi-target timeout orchestration.

*Call graph*: calls 1 internal fn (is_final); called by 1 (handle_call); 2 external calls (borrow, changed).


### `core/src/tools/handlers/multi_agents/resume_agent.rs`

`domain_logic` · `request handling for reopening previously closed agents`

This module provides the `multi_agent_v1.resume_agent` tool. `Handler` supplies the namespaced tool name, schema from `create_resume_agent_tool`, and search metadata keyed to reopening closed agents. The result type, `ResumeAgentResult`, simply wraps the agent's resulting `AgentStatus` and implements the standard `ToolOutput` conversions.

`handle_resume_agent` performs the actual workflow. It parses `ResumeAgentArgs { id }`, converts the id string into a `ThreadId`, and fetches any existing metadata for event decoration. Before attempting a resume, it computes the child depth from `turn.session_source` using `next_thread_spawn_depth` and compares it against `turn.config.agent_max_depth`; if the resumed agent would exceed the nesting limit, it rejects the request with a model-facing error.

The handler emits `CollabResumeBeginEvent`, then reads the current status. If the agent is not `NotFound`, no resume is needed and the current status is returned. If it is `NotFound`, the handler calls `try_resume_closed_agent`, which rebuilds a runtime-correct config via `build_agent_resume_config` and reconstructs the spawn lineage with `thread_spawn_source` before delegating to `agent_control.resume_agent_from_rollout`. Afterward it refreshes status and metadata, emits `CollabResumeEndEvent`, increments the `codex.multi_agent.resume` telemetry counter on success, and returns the final status. Errors are delayed until after the end event so observers always see a completed resume attempt.

#### Function details

##### `Handler::tool_name`  (lines 11–13)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the namespaced tool identifier `multi_agent_v1.resume_agent`.

**Data flow**: Constructs and returns a `ToolName` from the fixed namespace and literal tool name.

**Call relations**: Used by the tool registry to expose and dispatch this handler.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 15–17)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the tool specification for the resume-agent API.

**Data flow**: Returns the `ToolSpec` created by `create_resume_agent_tool()`.

**Call relations**: Referenced directly by registration code and indirectly by `Handler::search_info`.

*Call graph*: calls 1 internal fn (create_resume_agent_tool); called by 1 (search_info).


##### `Handler::search_info`  (lines 19–24)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Supplies search metadata for queries about reopening or resuming agents.

**Data flow**: Combines a fixed search phrase with `self.spec()` and passes both into `multi_agent_tool_search_info`, returning the optional search descriptor.

**Call relations**: Called by discovery flows; depends on `Handler::spec` to stay synchronized with the actual tool definition.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 26–28)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Wraps the async resume workflow in the boxed future expected by the executor trait.

**Data flow**: Consumes a `ToolInvocation`, pins an async block, awaits `handle_resume_agent(invocation)`, and boxes the successful result with `boxed_tool_output`.

**Call relations**: This is the runtime entrypoint and delegates all substantive behavior to `handle_resume_agent`.

*Call graph*: calls 1 internal fn (handle_resume_agent); 1 external calls (pin).


##### `handle_resume_agent`  (lines 31–138)

```
async fn handle_resume_agent(
    invocation: ToolInvocation,
) -> Result<ResumeAgentResult, FunctionCallError>
```

**Purpose**: Parses the requested agent id, enforces depth limits, emits begin/end resume events, optionally restores a closed agent from rollout state, and returns the resulting status.

**Data flow**: Consumes the invocation fields `session`, `turn`, `payload`, and `call_id` → extracts function arguments and deserializes `ResumeAgentArgs` → parses `args.id` with `ThreadId::from_string`, mapping parse failures to `RespondToModel`. It reads metadata from `agent_control`, computes `child_depth` from `turn.session_source`, and compares it to `turn.config.agent_max_depth`. It writes `CollabResumeBeginEvent`, reads current status via `get_status`, and if that status is `AgentStatus::NotFound` it awaits `try_resume_closed_agent(&session, &turn, receiver_thread_id, child_depth)`. After the attempt it refreshes status and metadata, emits `CollabResumeEndEvent`, increments `turn.session_telemetry.counter("codex.multi_agent.resume", 1, &[])` on success, and returns `ResumeAgentResult { status }` or the deferred `FunctionCallError`.

**Call relations**: Invoked only from `Handler::handle`. It delegates the actual restoration path to `try_resume_closed_agent` only when the target is currently absent; otherwise it acts as a status-reporting no-op with event emission.

*Call graph*: calls 3 internal fn (try_resume_closed_agent, now_unix_timestamp_ms, from_string); called by 1 (handle); 4 external calls (pin, next_thread_spawn_depth, matches!, RespondToModel).


##### `Handler::matches_kind`  (lines 141–143)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this handler only accepts function payloads.

**Data flow**: Pattern-matches `payload` and returns `true` for `ToolPayload::Function { .. }`, `false` otherwise.

**Call relations**: Used by runtime dispatch before `handle` is called.

*Call graph*: 1 external calls (matches!).


##### `ResumeAgentResult::log_preview`  (lines 157–159)

```
fn log_preview(&self) -> String
```

**Purpose**: Formats the resume result as JSON text for logs.

**Data flow**: Serializes `self` through `tool_output_json_text` with the label `resume_agent` and returns the string.

**Call relations**: Consumed by generic logging after a successful resume call.


##### `ResumeAgentResult::success_for_logging`  (lines 161–163)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks resume results as successful for logging purposes.

**Data flow**: Returns the constant `true`.

**Call relations**: Used by shared logging/output infrastructure.


##### `ResumeAgentResult::to_response_item`  (lines 165–167)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the typed resume result into a model-facing response item.

**Data flow**: Takes `call_id`, `payload`, and `self`, then calls `tool_output_response_item` with success `Some(true)` and tool label `resume_agent`, returning the resulting `ResponseInputItem`.

**Call relations**: Called by generic tool-output plumbing after `handle_resume_agent` succeeds.


##### `ResumeAgentResult::code_mode_result`  (lines 169–171)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces a structured JSON representation of the resume result for code-mode output.

**Data flow**: Serializes `self` via `tool_output_code_mode_result` and returns the `JsonValue`.

**Call relations**: Used by alternate output consumers that want raw JSON.


##### `try_resume_closed_agent`  (lines 174–195)

```
async fn try_resume_closed_agent(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    receiver_thread_id: ThreadId,
    child_depth: i32,
) -> Result<(), FunctionCallError>
```

**Purpose**: Reconstructs the runtime config and lineage needed to restore a closed agent from rollout state through `agent_control`.

**Data flow**: Accepts shared references to `Session` and `TurnContext`, plus `receiver_thread_id` and `child_depth` → builds a resume config with `build_agent_resume_config(turn.as_ref())` → constructs a `SessionSource` via `thread_spawn_source(session.thread_id(), &turn.session_source, child_depth, None, None)` → calls `session.services.agent_control.resume_agent_from_rollout(...)` and maps success to `()` and any `CodexErr` to `FunctionCallError` with `collab_agent_error`.

**Call relations**: This helper is called only from `handle_resume_agent` when the target status is `NotFound`, isolating the restoration-specific setup from the broader event and telemetry flow.

*Call graph*: called by 1 (handle_resume_agent); 1 external calls (pin).


### `core/src/tools/handlers/multi_agents/close_agent.rs`

`domain_logic` · `request handling for explicit agent shutdown`

This file defines the `close_agent` tool executor and the serializable result type returned to the model. `Handler` exposes the tool under the namespaced name `multi_agent_v1.close_agent`, supplies its schema from `create_close_agent_tool_v1`, and advertises search text oriented around shutdown and stopping agents.

The core workflow lives in `handle_close_agent`. It destructures the `ToolInvocation`, extracts function arguments, deserializes `CloseAgentArgs { target }`, and parses the target into a `ThreadId`. Before issuing the close, it fetches optional metadata so end events can include nickname and role even if the agent disappears later. It then emits `CollabCloseBeginEvent` with timestamps and sender/receiver thread ids.

Status acquisition is careful: it first tries `subscribe_status` to capture the current status from a watch channel; if the thread is already gone but metadata existed, it falls back to `get_status`; for other subscription errors it still emits `CollabCloseEndEvent` with the best-effort status and returns a normalized collaboration error. The actual shutdown is performed through `agent_control.close_agent`. Regardless of success, the handler emits `CollabCloseEndEvent` carrying the pre-close status snapshot. On success it returns `CloseAgentResult { previous_status }`, preserving the status observed before shutdown was requested rather than the post-close state.

#### Function details

##### `Handler::tool_name`  (lines 10–12)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the fully qualified tool name for this executor as `multi_agent_v1.close_agent`.

**Data flow**: Reads no mutable state; constructs a `ToolName` from the namespace constant and literal tool name via `ToolName::namespaced` and returns it.

**Call relations**: The tool registry calls this when registering or dispatching the handler so invocations route to the close-agent implementation.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 14–16)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the JSON-schema-backed tool specification for `close_agent`.

**Data flow**: Takes no arguments beyond `&self` and returns the `ToolSpec` produced by `create_close_agent_tool_v1()`.

**Call relations**: This is consumed directly by the registry and indirectly by `Handler::search_info`, which uses the same spec to derive searchable metadata.

*Call graph*: calls 1 internal fn (create_close_agent_tool_v1); called by 1 (search_info).


##### `Handler::search_info`  (lines 18–23)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides search metadata so the tool can be discovered from shutdown-related queries.

**Data flow**: Uses a fixed keyword string and the current tool spec from `self.spec()` to build an optional `ToolSearchInfo` through `multi_agent_tool_search_info`.

**Call relations**: Called by tool discovery paths; it depends on `Handler::spec` so the search entry stays aligned with the actual tool schema.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 25–27)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async close-agent workflow into the boxed future shape expected by the tool executor trait.

**Data flow**: Consumes a `ToolInvocation` → creates a pinned async block that awaits `handle_close_agent(invocation)` → maps the typed result into boxed `ToolOutput` with `boxed_tool_output`.

**Call relations**: This is the trait entrypoint invoked by the runtime for a tool call; it delegates all substantive work to `handle_close_agent`.

*Call graph*: calls 1 internal fn (handle_close_agent); 1 external calls (pin).


##### `handle_close_agent`  (lines 30–112)

```
async fn handle_close_agent(
    invocation: ToolInvocation,
) -> Result<CloseAgentResult, FunctionCallError>
```

**Purpose**: Validates the target, emits collaboration lifecycle events, captures the target's current status, requests shutdown through `agent_control`, and returns the pre-close status snapshot.

**Data flow**: Consumes `ToolInvocation { session, turn, payload, call_id, .. }` → extracts raw function arguments with `function_arguments`, parses `CloseAgentArgs`, converts `target` to `ThreadId`, and reads metadata from `session.services.agent_control.get_agent_metadata`. It writes a `CollabCloseBeginEvent` to the session event stream, then reads status either from `subscribe_status().borrow_and_update()`, from `get_status` on a known-but-missing thread, or from `get_status` during error handling. It invokes `close_agent(agent_id)` and maps any `CodexErr` through `collab_agent_error`. It always emits `CollabCloseEndEvent` with timestamps, sender/receiver ids, metadata, and the captured status. On success it returns `CloseAgentResult { previous_status: status }`; on failure it returns a `FunctionCallError`.

**Call relations**: Reached only from `Handler::handle`. It orchestrates parsing helpers from the shared module, session event emission, and `agent_control` operations so the close request is externally visible and failures still produce a terminal collaboration event.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (handle); 1 external calls (pin).


##### `Handler::matches_kind`  (lines 115–117)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this runtime handler to function-style tool payloads.

**Data flow**: Inspects `payload: &ToolPayload` with `matches!` and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: The core tool runtime uses this guard before dispatching to `handle`, preventing unsupported payload variants from reaching the close-agent logic.

*Call graph*: 1 external calls (matches!).


##### `CloseAgentResult::log_preview`  (lines 126–128)

```
fn log_preview(&self) -> String
```

**Purpose**: Serializes the close result into a compact JSON string for logs.

**Data flow**: Reads `self.previous_status` and passes `self` plus the tool name label to `tool_output_json_text`, returning the resulting string.

**Call relations**: Used by generic tool-output logging paths after `handle_close_agent` succeeds.


##### `CloseAgentResult::success_for_logging`  (lines 130–132)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks successful close-agent results as loggable successes.

**Data flow**: Reads no external state and returns the constant `true`.

**Call relations**: Consumed by logging infrastructure alongside `log_preview` to classify the tool result.


##### `CloseAgentResult::to_response_item`  (lines 134–136)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the typed close result into a `ResponseInputItem` suitable for feeding back into the model conversation.

**Data flow**: Takes `call_id`, the original `payload`, and `self` → serializes through `tool_output_response_item` with explicit success `Some(true)` and tool label `close_agent` → returns the response item.

**Call relations**: Called by generic tool-output plumbing after the handler returns a typed result.


##### `CloseAgentResult::code_mode_result`  (lines 138–140)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the JSON value form of the close result for code-mode consumers.

**Data flow**: Ignores the payload contents, serializes `self` through `tool_output_code_mode_result`, and returns the resulting `JsonValue`.

**Call relations**: Used by alternate output paths that want structured JSON rather than a response item.


### `core/src/tools/handlers/multi_agents_v2.rs`

`orchestration` · `request handling for MultiAgentV2 tools`

This module is the umbrella entry point for the MultiAgentV2 handler family. It gathers the common imports needed by submodules—agent resolution, tool invocation/output types, argument parsing, event types, `AgentPath`, `UserInput`, and shared helper functions from `multi_agents_common`—then re-exports the concrete handler types from `followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn`, and `wait`. The file itself contains almost no control flow; its main role is to define the module tree and provide a single shared helper used by the messaging tools.

That helper, `communication_from_tool_message`, standardizes how v2 tool-originated messages are encoded: it always creates an `InterAgentCommunication` with encrypted content, no secondary recipients, and `trigger_turn` initially set to `true`. Downstream code in `message_tool.rs` can then selectively flip `trigger_turn` off for queue-only delivery. This design centralizes the invariant that tool-supplied inter-agent messages should travel through the encrypted communication path, while allowing the delivery mode to vary between `send_message` and `followup_task`.

#### Function details

##### `communication_from_tool_message`  (lines 43–55)

```
fn communication_from_tool_message(
    author: AgentPath,
    recipient: AgentPath,
    message: String,
) -> InterAgentCommunication
```

**Purpose**: Builds the canonical encrypted `InterAgentCommunication` object used by MultiAgentV2 messaging tools.

**Data flow**: Takes an author `AgentPath`, recipient `AgentPath`, and plaintext message string; passes them to `InterAgentCommunication::new_encrypted` with an empty `other_recipients` vector and `trigger_turn = true`; returns the resulting communication value without mutating external state.

**Call relations**: Called by the shared v2 message-dispatch helper before delivery mode is applied, so both `send_message` and `followup_task` start from the same encrypted communication shape.

*Call graph*: calls 1 internal fn (new_encrypted); 1 external calls (new).


### `core/src/tools/handlers/multi_agents_v2/message_tool.rs`

`domain_logic` · `request handling for v2 inter-agent messaging`

This module factors out the common behavior of the two v2 messaging tools. `MessageDeliveryMode` is a small enum with `QueueOnly` and `TriggerTurn` variants; its `apply` method rewrites the `trigger_turn` field on an `InterAgentCommunication` while preserving all other fields. Two strict argument structs, `SendMessageArgs` and `FollowupTaskArgs`, both contain `target` and `message` and deny unknown fields, which is why legacy `items` or `interrupt` parameters fail parsing in v2.

The helper `message_content` enforces a simple but important invariant: after trimming whitespace, the message must not be empty. The main function, `handle_message_string_tool`, performs the full shared flow. It validates the message, destructures the invocation, resolves the target agent via `resolve_agent_target`, and loads metadata with `ensure_agent_known`. If the mode is `TriggerTurn`, it rejects root targets specifically for follow-up tasks. It also requires the target to have an `agent_path`, because path-based metadata is used for delivery and event reporting.

Before sending, it builds a resume config from the current `TurnContext` and calls `ensure_v2_agent_loaded`, allowing messages to reach unloaded-but-known agents. The author path comes from `turn.session_source.get_agent_path()` or defaults to `/root`. It then creates encrypted communication through `communication_from_tool_message`, applies the chosen delivery mode, sends it through `agent_control.send_inter_agent_communication`, and emits a `SubAgentActivityEvent` of kind `Interacted` with the original `call_id` and current timestamp. Success returns an empty-text `FunctionToolOutput` with `Some(true)`.

#### Function details

##### `MessageDeliveryMode::apply`  (lines 19–30)

```
fn apply(self, communication: InterAgentCommunication) -> InterAgentCommunication
```

**Purpose**: Adjusts whether an `InterAgentCommunication` should trigger the recipient's turn immediately or remain queued.

**Data flow**: Takes `self` and an existing `InterAgentCommunication`; returns a new struct using struct-update syntax that preserves all fields except `trigger_turn`, which is set to `false` for `QueueOnly` and `true` for `TriggerTurn`.

**Call relations**: Called inside `handle_message_string_tool` after the encrypted communication is constructed, so `send_message` and `followup_task` can share all other logic.

*Call graph*: called by 1 (handle_message_string_tool).


##### `message_content`  (lines 49–56)

```
fn message_content(message: String) -> Result<String, FunctionCallError>
```

**Purpose**: Validates that a message string contains non-whitespace content.

**Data flow**: Consumes a `String`, trims it for emptiness checking, returns `Err(FunctionCallError::RespondToModel(...))` if blank, otherwise returns the original string unchanged.

**Call relations**: Used at the start of `handle_message_string_tool` to reject empty messages before any target resolution or agent-control side effects occur.

*Call graph*: called by 1 (handle_message_string_tool); 1 external calls (RespondToModel).


##### `handle_message_string_tool`  (lines 59–126)

```
async fn handle_message_string_tool(
    invocation: ToolInvocation,
    mode: MessageDeliveryMode,
    target: String,
    message: String,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Implements the shared MultiAgentV2 message-delivery flow: validate message, resolve target, ensure the target agent is loaded, send encrypted communication with the requested delivery mode, emit an interaction event, and return an empty success output.

**Data flow**: Consumes a `ToolInvocation`, `MessageDeliveryMode`, target string, and message string; validates the message via `message_content`; reads `session`, `turn`, and `call_id` from the invocation; resolves the target to a thread ID; reads agent metadata with `ensure_agent_known`; conditionally rejects root targets when `mode == TriggerTurn`; extracts the target `agent_path`; builds a resume config from `turn`; writes by calling `ensure_v2_agent_loaded(resume_config, receiver_thread_id)`; derives the author path from `turn.session_source` or `/root`; creates encrypted communication with `communication_from_tool_message`; rewrites `trigger_turn` via `mode.apply`; sends it through `send_inter_agent_communication`; emits `SubAgentActivityEvent { kind: Interacted, event_id: call_id, occurred_at_ms, agent_thread_id, agent_path }`; returns `FunctionToolOutput::from_text(String::new(), Some(true))`.

**Call relations**: Called by both `send_message::Handler::handle_call` and `followup_task::Handler::handle_call`; it centralizes all shared behavior so those handlers differ only in argument type and delivery mode.

*Call graph*: calls 4 internal fn (from_text, apply, message_content, now_unix_timestamp_ms); called by 2 (handle_call, handle_call); 2 external calls (new, RespondToModel).


### `core/src/tools/handlers/multi_agents_v2/spawn.rs`

`domain_logic` · `tool invocation during multi-agent request handling`

This file defines the concrete executor for the `spawn_agent` function tool and the argument/result types that sit at the tool boundary. `Handler` stores `SpawnAgentToolOptions`, exposes the fixed tool name, builds the JSON schema via `create_spawn_agent_tool_v2`, and routes function payloads into the async `handle_spawn_agent` workflow. The main routine unpacks `ToolInvocation`, parses `SpawnAgentArgs`, derives a `SpawnAgentForkMode` from `fork_turns`, and normalizes `agent_type` into an optional role name. It converts the user-supplied message into an initial collaboration `Op`, computes child nesting depth from the current `session_source`, and builds a spawn config from base instructions plus turn context. 

The control flow splits on fork mode: full-history forks reject role/model/reasoning overrides entirely, while non-full forks apply requested model overrides and then asynchronously apply the selected role to the config. Service tier and runtime overrides are layered afterward. The code then constructs a spawn source with canonical agent path metadata, fails if no canonical task name can be derived, and calls `agent_control.spawn_agent_with_metadata`. A notable branch rewrites plain-text `Op::UserInput` into `Op::InterAgentCommunication`, preserving author and recipient agent paths for agent-to-agent messaging. After spawn, it fetches a config snapshot to recover nickname metadata, emits a `SubAgentActivityKind::Started` event with a timestamp, increments telemetry tagged by role and version, and returns either full metadata or only `task_name` depending on `hide_spawn_agent_metadata`. `SpawnAgentArgs::fork_mode` enforces the MultiAgentV2 contract that `fork_context` is unsupported and that `fork_turns` must be `none`, `all`, or a positive integer string.

#### Function details

##### `Handler::new`  (lines 20–22)

```
fn new(options: SpawnAgentToolOptions) -> Self
```

**Purpose**: Constructs a spawn-agent handler with a specific set of tool-spec options. It is the only stateful initializer in the file, storing the options used later when advertising the tool schema.

**Data flow**: Takes a `SpawnAgentToolOptions` value by ownership and places it into the `Handler { options }` field. Returns the initialized `Handler` without side effects.

**Call relations**: Used when the tool registry wires up MultiAgentV2 handlers so later `spec` calls can render the correct schema and defaults.


##### `Handler::tool_name`  (lines 26–28)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the externally visible function-tool name as `spawn_agent`. This is the identifier the runtime uses to match model tool calls to this executor.

**Data flow**: Reads no mutable state; converts the static string into a `ToolName` via `ToolName::plain` and returns it.

**Call relations**: Called by tool registration/runtime dispatch paths before execution so the handler can be indexed under the canonical tool name.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 30–32)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the `ToolSpec` for the spawn tool using the handler's configured options. This determines the schema and descriptive metadata exposed to the model.

**Data flow**: Clones `self.options`, passes the clone into `create_spawn_agent_tool_v2`, and returns the resulting `ToolSpec`.

**Call relations**: Invoked by the tool registry or discovery layer when publishing available tools; it delegates schema construction to the shared MultiAgentV2 spec helper.

*Call graph*: calls 1 internal fn (create_spawn_agent_tool_v2); 1 external calls (clone).


##### `Handler::handle`  (lines 34–36)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Wraps the spawn workflow in the executor trait's boxed future shape. It converts the typed `SpawnAgentResult` into the generic boxed tool-output object expected by the runtime.

**Data flow**: Consumes a `ToolInvocation`, starts an async block, awaits `handle_spawn_agent(invocation)`, maps the successful result through `boxed_tool_output`, and returns the boxed future.

**Call relations**: This is the trait entrypoint called by the tool runtime after dispatch; it delegates all substantive work to `handle_spawn_agent`.

*Call graph*: calls 1 internal fn (handle_spawn_agent); 1 external calls (pin).


##### `handle_spawn_agent`  (lines 39–177)

```
async fn handle_spawn_agent(
    invocation: ToolInvocation,
) -> Result<SpawnAgentResult, FunctionCallError>
```

**Purpose**: Performs the full spawn-agent operation: parse arguments, validate fork semantics, assemble child config, spawn the agent, emit events/telemetry, and return the visible result payload. It contains the file's main business logic.

**Data flow**: Reads `session`, `turn`, `payload`, and `call_id` from `ToolInvocation`; parses function arguments into `SpawnAgentArgs`; derives `fork_mode`, `role_name`, `message`, and an initial `Op`; reads base instructions, session source, thread depth, turn config, environments, and service tier; mutates a local spawn config with requested overrides and role/runtime/service-tier adjustments; builds a spawn source and extracts a canonical `AgentPath`; invokes `session.services.agent_control.spawn_agent_with_metadata` with config, transformed initial operation, spawn metadata, and `SpawnAgentOptions`; then reads the spawned thread id and optional config snapshot to derive nickname, sends a `SubAgentActivityEvent`, records telemetry, and returns either `SpawnAgentResult::HiddenMetadata { task_name }` or `SpawnAgentResult::WithNickname { task_name, nickname }`.

**Call relations**: Reached only from `Handler::handle`. Inside, it conditionally delegates to role/model/service-tier/runtime helpers depending on whether the request is a full-history fork, and it calls into agent-control services to actually create the child thread. Its event emission and telemetry recording happen only after a successful spawn.

*Call graph*: calls 2 internal fn (apply_role_to_config, now_unix_timestamp_ms); called by 1 (handle); 4 external calls (pin, from, next_thread_spawn_depth, matches!).


##### `Handler::matches_kind`  (lines 180–182)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this runtime to function-style tool payloads. It prevents non-function payload variants from being considered compatible with the handler.

**Data flow**: Examines `payload` by pattern match and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: Used by the core tool runtime during dispatch/filtering before `handle` is invoked.

*Call graph*: 1 external calls (matches!).


##### `SpawnAgentArgs::fork_mode`  (lines 199–232)

```
fn fork_mode(&self) -> Result<Option<SpawnAgentForkMode>, FunctionCallError>
```

**Purpose**: Interprets the user-facing fork controls into an internal `Option<SpawnAgentForkMode>`. It also enforces the MultiAgentV2-specific prohibition on `fork_context`.

**Data flow**: Reads `self.fork_context` and `self.fork_turns`; if `fork_context` is present, returns `FunctionCallError::RespondToModel`; otherwise trims `fork_turns`, defaults missing/empty values to `"all"`, maps `"none"` to `Ok(None)`, `"all"` to `Ok(Some(FullHistory))`, and parses any other string as a positive `usize` to produce `Ok(Some(LastNTurns(n)))`; parse failures or zero become model-facing errors.

**Call relations**: Called from `handle_spawn_agent` early in request validation so later config-building and spawn-option assembly can branch on the chosen fork behavior.

*Call graph*: 2 external calls (LastNTurns, RespondToModel).


##### `SpawnAgentResult::log_preview`  (lines 248–250)

```
fn log_preview(&self) -> String
```

**Purpose**: Formats the spawn result for logs as JSON text under the `spawn_agent` tool label. This keeps logging consistent with other tool outputs.

**Data flow**: Reads `self`, serializes it through the shared tool-output JSON helper, and returns the preview string.

**Call relations**: Used by generic tool-output logging after `handle_spawn_agent` succeeds.


##### `SpawnAgentResult::success_for_logging`  (lines 252–254)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks every successful spawn result as loggable success. The result variants do not encode failure states, so this always returns `true`.

**Data flow**: Reads no external state and returns the constant boolean `true`.

**Call relations**: Consumed by the logging/reporting layer when recording tool execution outcomes.


##### `SpawnAgentResult::to_response_item`  (lines 256–258)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the typed spawn result into a protocol `ResponseInputItem` for the model-facing response stream. It preserves the original call id and tags the output as successful.

**Data flow**: Takes `&self`, `call_id`, and the original `payload`; passes them to the shared response-item helper with `Some(true)` and the tool name `spawn_agent`; returns the constructed `ResponseInputItem`.

**Call relations**: Called by the generic tool framework when serializing tool output back into the conversation protocol.


##### `SpawnAgentResult::code_mode_result`  (lines 260–262)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the code-mode JSON representation of the spawn result. It uses the same shared serialization path as other tool outputs.

**Data flow**: Reads `self`, ignores the payload contents, and returns a `JsonValue` generated by the shared code-mode helper for `spawn_agent`.

**Call relations**: Used when the runtime needs a structured code-mode result instead of a normal response item.


### `core/src/tools/handlers/multi_agents_v2/send_message.rs`

`domain_logic` · `request handling for queued v2 agent messages`

This file mirrors `followup_task.rs` but selects the non-waking delivery mode. The zero-sized `Handler` implements `ToolExecutor<ToolInvocation>` by returning the plain tool name `send_message`, exposing the schema from `create_send_message_tool`, and boxing an async call to `handle_call`. `CoreToolRuntime::matches_kind` limits dispatch to function payloads.

`Handler::handle_call` is intentionally thin. It clones the invocation payload to extract raw function arguments, deserializes them into `SendMessageArgs` with unknown fields denied, and then delegates to `handle_message_string_tool` with `MessageDeliveryMode::QueueOnly`. That shared helper performs all substantive work: empty-message validation, target resolution by path or ID, loading unloaded v2 agents if necessary, constructing encrypted `InterAgentCommunication`, setting `trigger_turn` to false for queue-only delivery, sending the communication through agent-control, and emitting a `SubAgentActivityEvent` of kind `Interacted`.

The result is boxed tool output containing an empty text body and `success = Some(true)`. Because parsing is strict and the helper is shared, this tool inherits the v2 guarantees tested elsewhere: no legacy `items` or `interrupt` fields, encrypted transport, and no implicit wake-up of the target agent.

#### Function details

##### `Handler::tool_name`  (lines 11–13)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registry name `send_message`.

**Data flow**: Constructs and returns a plain `ToolName` from the fixed string.

**Call relations**: Used by the registry and dispatch layer to identify this handler.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 15–17)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the tool specification for the v2 send-message function.

**Data flow**: Calls `create_send_message_tool` and returns the resulting `ToolSpec`.

**Call relations**: Invoked when exposing the tool schema to the model/client.

*Call graph*: calls 1 internal fn (create_send_message_tool).


##### `Handler::handle`  (lines 19–21)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Boxes the async send-message implementation into the trait-required future type.

**Data flow**: Consumes a `ToolInvocation`, creates the future from `self.handle_call(invocation)`, pins and boxes it, and returns that future.

**Call relations**: This is the runtime entrypoint and delegates all behavior to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 25–39)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Parses `target` and `message` arguments and dispatches them as a queue-only encrypted inter-agent message.

**Data flow**: Reads `invocation.payload`, extracts function arguments, deserializes them into `SendMessageArgs`, then passes the full invocation plus parsed `target` and `message` into `handle_message_string_tool` with `MessageDeliveryMode::QueueOnly`; on success it wraps the returned `FunctionToolOutput` with `boxed_tool_output`.

**Call relations**: Called only from `Handler::handle`; it delegates validation, target resolution, delivery, and event emission to the shared message helper because `send_message` differs from `followup_task` only in delivery mode.

*Call graph*: calls 1 internal fn (handle_message_string_tool); called by 1 (handle).


##### `Handler::matches_kind`  (lines 43–45)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this handler only accepts function-call payloads.

**Data flow**: Pattern-matches the `ToolPayload` and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: Used by the core runtime to filter incompatible payload kinds before dispatch.

*Call graph*: 1 external calls (matches!).


### `core/src/tools/handlers/multi_agents_v2/followup_task.rs`

`domain_logic` · `request handling for follow-up task submissions`

This file defines a zero-sized `Handler` for the `followup_task` tool and wires it into the generic tool runtime traits. The `ToolExecutor` implementation supplies the plain tool name `followup_task`, returns the spec built by `create_followup_task_tool`, and boxes the async execution future. Actual behavior lives in `Handler::handle_call`: it first extracts raw function arguments from the invocation payload, deserializes them into `FollowupTaskArgs` with `deny_unknown_fields`, and then delegates to `handle_message_string_tool` with `MessageDeliveryMode::TriggerTurn`.

That choice of delivery mode is the key semantic difference from `send_message`: the resulting `InterAgentCommunication` should wake the target immediately if idle, and the shared helper also enforces the extra rule that follow-up tasks cannot target the root agent. The handler itself does not manipulate agent-control state directly; instead it relies on the shared message tool to resolve the target, ensure the v2 agent is loaded, send the encrypted communication, emit a `SubAgentActivityEvent`, and wrap the empty-success response as boxed tool output. `CoreToolRuntime::matches_kind` restricts this handler to function-style payloads only.

#### Function details

##### `Handler::tool_name`  (lines 11–13)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registry name for this tool as `followup_task`.

**Data flow**: Reads no external state, constructs a plain `ToolName` from the fixed string, and returns it.

**Call relations**: Used by the tool registry when exposing or dispatching this handler.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 15–17)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the JSON/tooling specification for the `followup_task` function.

**Data flow**: Calls `create_followup_task_tool` and returns the resulting `ToolSpec` unchanged.

**Call relations**: Invoked by registry/spec-generation code so callers see the correct v2 schema and description.

*Call graph*: calls 1 internal fn (create_followup_task_tool).


##### `Handler::handle`  (lines 19–21)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation into the boxed future type required by `ToolExecutor`.

**Data flow**: Consumes a `ToolInvocation`, creates the future from `self.handle_call(invocation)`, boxes and pins it, and returns that future.

**Call relations**: This is the trait entrypoint called by the runtime; it delegates all real work to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 25–39)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Parses `target` and `message` arguments for `followup_task` and dispatches them as a trigger-turn inter-agent message.

**Data flow**: Reads `invocation.payload`, extracts function arguments, deserializes them into `FollowupTaskArgs`, then passes the full invocation plus parsed `target` and `message` into `handle_message_string_tool` with `MessageDeliveryMode::TriggerTurn`; on success it wraps the returned `FunctionToolOutput` with `boxed_tool_output` and returns it.

**Call relations**: Called only from `Handler::handle`; it delegates validation, target resolution, delivery, and event emission to the shared message helper because `followup_task` differs from `send_message` only by delivery mode.

*Call graph*: calls 1 internal fn (handle_message_string_tool); called by 1 (handle).


##### `Handler::matches_kind`  (lines 43–45)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this runtime only accepts function-call payloads.

**Data flow**: Examines the `ToolPayload` by pattern match and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: Used by the core tool runtime to filter incompatible payload kinds before dispatch.

*Call graph*: 1 external calls (matches!).


### `core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs`

`domain_logic` · `request handling for agent interruption`

This file defines the v2 interrupt handler and its result type. The `Handler` itself is minimal: it advertises the tool name `interrupt_agent`, returns the spec from `create_interrupt_agent_tool_v2`, and boxes an async call to `handle_interrupt_agent`. The core logic destructures `ToolInvocation`, parses strict `InterruptAgentArgs { target }`, and resolves the target through `resolve_agent_target`, which allows either task-path or thread-ID addressing.

Once resolved, the handler asks agent-control to `ensure_agent_known`, then enforces two important invariants before sending any side effects: the target must not be the root agent (`agent_path.is_root()`), and the caller must not target its own `session.thread_id`. It also requires the target metadata to contain an `agent_path`, because that path is emitted in the activity event. The handler snapshots the current `AgentStatus`, then calls `interrupt_agent`. `ThreadNotFound` and `InternalAgentDied` are treated as acceptable terminal outcomes rather than hard failures, so callers still receive a successful response with the prior status. After a successful interrupt attempt, it emits a `SubAgentActivityEvent` of kind `Interrupted` with the original `call_id` and current timestamp.

`InterruptAgentResult` is a small serializable wrapper around `previous_status`; its `ToolOutput` implementation consistently renders JSON text, marks logging success as true, and returns a successful response item and code-mode JSON payload.

#### Function details

##### `Handler::tool_name`  (lines 10–12)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registry name `interrupt_agent` for this handler.

**Data flow**: Constructs and returns a plain `ToolName` from a fixed string, without reading mutable state.

**Call relations**: Used by the tool registry and dispatch layer to identify this handler.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 14–16)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Supplies the v2 interrupt-agent tool specification.

**Data flow**: Calls `create_interrupt_agent_tool_v2` and returns the resulting `ToolSpec`.

**Call relations**: Invoked when the runtime needs to expose the tool schema to the model or client.

*Call graph*: calls 1 internal fn (create_interrupt_agent_tool_v2).


##### `Handler::handle`  (lines 18–24)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Wraps the interrupt implementation in the boxed future expected by the tool runtime and converts the typed result into boxed output.

**Data flow**: Consumes a `ToolInvocation`, creates an async block that awaits `handle_interrupt_agent(invocation)`, maps the successful `InterruptAgentResult` through `boxed_tool_output`, and returns the pinned boxed future.

**Call relations**: This is the runtime entrypoint; it delegates all interrupt semantics to `handle_interrupt_agent`.

*Call graph*: calls 1 internal fn (handle_interrupt_agent); 1 external calls (pin).


##### `handle_interrupt_agent`  (lines 27–91)

```
async fn handle_interrupt_agent(
    invocation: ToolInvocation,
) -> Result<InterruptAgentResult, FunctionCallError>
```

**Purpose**: Parses the target, validates it against root/self restrictions, interrupts the resolved agent, emits an interruption activity event, and returns the target's previous status.

**Data flow**: Reads `session`, `turn`, `payload`, and `call_id` from `ToolInvocation`; extracts function arguments and deserializes `InterruptAgentArgs`; resolves the target to a thread ID; loads agent metadata via `ensure_agent_known`; rejects root or self targets and missing `agent_path`; reads current status with `get_status`; calls `interrupt_agent`; treats `ThreadNotFound` and `InternalAgentDied` as non-fatal; emits `SubAgentActivityEvent { kind: Interrupted, event_id: call_id, occurred_at_ms, agent_thread_id, agent_path }` through `session.send_event`; returns `InterruptAgentResult { previous_status }`.

**Call relations**: Called only from `Handler::handle`; it depends on shared resolution/error helpers and delegates the actual interrupt side effect to `session.services.agent_control`.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (handle); 1 external calls (RespondToModel).


##### `Handler::matches_kind`  (lines 94–96)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this handler to function-call payloads.

**Data flow**: Pattern-matches the provided `ToolPayload` and returns `true` only when it is `ToolPayload::Function { .. }`.

**Call relations**: Used by the core runtime before dispatching to this handler.

*Call graph*: 1 external calls (matches!).


##### `InterruptAgentResult::log_preview`  (lines 111–113)

```
fn log_preview(&self) -> String
```

**Purpose**: Formats the interrupt result as JSON text for logs.

**Data flow**: Reads `self.previous_status`, passes `self` and the tool name to the shared JSON preview helper, and returns the resulting string.

**Call relations**: Called by logging/reporting paths after a successful interrupt.


##### `InterruptAgentResult::success_for_logging`  (lines 115–117)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks interrupt results as successful for logging purposes.

**Data flow**: Reads no inputs beyond `self` and returns the constant `true`.

**Call relations**: Used by generic tool-output logging to classify this result.


##### `InterruptAgentResult::to_response_item`  (lines 119–121)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Serializes the interrupt result into a successful `ResponseInputItem` for the model-facing response stream.

**Data flow**: Takes `call_id` and original `payload`, passes `self`, `Some(true)`, and the tool name to `tool_output_response_item`, and returns the produced `ResponseInputItem`.

**Call relations**: Invoked by the tool runtime when converting this typed result into protocol output.


##### `InterruptAgentResult::code_mode_result`  (lines 123–125)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the code-mode JSON representation of the interrupt result.

**Data flow**: Ignores the payload contents, passes `self` and the tool name to `tool_output_code_mode_result`, and returns the resulting `JsonValue`.

**Call relations**: Used when the runtime needs a structured code-mode result instead of a response item.


### `core/src/tools/handlers/multi_agents_v2/list_agents.rs`

`domain_logic` · `request handling for agent enumeration`

This file provides the v2 list-agents handler and a thin result type. The `Handler` advertises the tool name `list_agents`, returns the schema from `create_list_agents_tool`, and boxes an async call into `handle_call`. The actual implementation destructures the `ToolInvocation`, extracts function arguments, and parses them into `ListAgentsArgs { path_prefix: Option<String> }` with unknown fields denied.

Before listing, it calls `session.services.agent_control.register_session_root(session.thread_id, turn.parent_thread_id)`. That registration step is easy to miss but important: it tells agent-control how to interpret the current session's root context before path-based listing occurs. It then delegates to `agent_control.list_agents(&turn.session_source, args.path_prefix.as_deref())`, which returns a `Vec<ListedAgent>` already shaped for serialization. Errors from listing are translated through `collab_spawn_error`, and successful results are wrapped in `ListAgentsResult` and boxed.

`ListAgentsResult` itself contains only `agents: Vec<ListedAgent>` and implements `ToolOutput` using the shared JSON helpers. Like other successful management tools, it always logs as successful and emits a response item with `success = Some(true)`. The file therefore acts as a narrow adapter between strict argument parsing, session-root registration, and the lower-level agent-control listing API.

#### Function details

##### `Handler::tool_name`  (lines 9–11)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registry name `list_agents`.

**Data flow**: Constructs a plain `ToolName` from the fixed string and returns it.

**Call relations**: Used by the registry and dispatch layer to identify this tool.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 13–15)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the tool specification for the list-agents function.

**Data flow**: Calls `create_list_agents_tool` and returns the resulting `ToolSpec`.

**Call relations**: Invoked when exposing the tool schema to callers.

*Call graph*: calls 1 internal fn (create_list_agents_tool).


##### `Handler::handle`  (lines 17–19)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Boxes the async list-agents implementation into the trait-required future type.

**Data flow**: Consumes a `ToolInvocation`, creates the future from `self.handle_call(invocation)`, pins and boxes it, and returns that future.

**Call relations**: This is the trait entrypoint and delegates all behavior to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 23–47)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Parses the optional path-prefix filter, registers the session root, queries agent-control for visible agents, and returns them as boxed tool output.

**Data flow**: Reads `session`, `turn`, and `payload` from the invocation; extracts function arguments; deserializes `ListAgentsArgs`; writes session-root metadata via `register_session_root(session.thread_id, turn.parent_thread_id)`; awaits `list_agents(&turn.session_source, args.path_prefix.as_deref())`; maps any error through `collab_spawn_error`; wraps the resulting `Vec<ListedAgent>` in `ListAgentsResult` and `boxed_tool_output`.

**Call relations**: Called only from `Handler::handle`; it delegates the actual enumeration/filtering logic to `agent_control.list_agents` after establishing root context.

*Call graph*: called by 1 (handle).


##### `Handler::matches_kind`  (lines 51–53)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this handler only accepts function payloads.

**Data flow**: Pattern-matches the `ToolPayload` and returns `true` for `ToolPayload::Function { .. }` only.

**Call relations**: Used by the core runtime to gate dispatch.

*Call graph*: 1 external calls (matches!).


##### `ListAgentsResult::log_preview`  (lines 68–70)

```
fn log_preview(&self) -> String
```

**Purpose**: Formats the list-agents result as JSON text for logs.

**Data flow**: Reads `self.agents`, passes `self` and the tool name to the shared preview helper, and returns the generated string.

**Call relations**: Used by generic logging after successful list-agents execution.


##### `ListAgentsResult::success_for_logging`  (lines 72–74)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks list-agents results as successful in logs.

**Data flow**: Returns the constant `true` without consulting mutable state.

**Call relations**: Consumed by generic tool-output logging infrastructure.


##### `ListAgentsResult::to_response_item`  (lines 76–78)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Serializes the list-agents result into a successful response item.

**Data flow**: Takes `call_id` and original `payload`, passes `self`, `Some(true)`, and the tool name to `tool_output_response_item`, and returns the resulting `ResponseInputItem`.

**Call relations**: Called by the runtime when emitting the tool result back to the model/client.


##### `ListAgentsResult::code_mode_result`  (lines 80–82)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the structured code-mode JSON form of the list-agents result.

**Data flow**: Ignores payload contents, passes `self` and the tool name to `tool_output_code_mode_result`, and returns the resulting `JsonValue`.

**Call relations**: Used by code-mode consumers that want structured JSON instead of a response item.


### `core/src/tools/handlers/multi_agents_v2/wait.rs`

`domain_logic` · `tool invocation during multi-agent coordination/wait states`

This file provides the waiting side of MultiAgentV2 coordination. `Handler` stores timeout-related spec options, exposes the `wait_agent` tool name and schema, and routes execution into `handle_call`. The handler parses `WaitArgs`, then clamps the requested `timeout_ms` against per-turn configuration: values below `min_wait_timeout_ms` or above `max_wait_timeout_ms` are rejected with model-facing errors, while omitted values fall back to `default_wait_timeout_ms`. 

Before sleeping, the code queries the session input queue for the current sub-turn state and subscribes to activity updates. That subscription returns both a watch receiver and an optional already-pending `InputQueueActivity`; this is important because the implementation avoids missing activity that arrived just before subscription. It emits a `CollabWaitingBeginEvent` with the current thread id, empty receiver lists, and a timestamp, computes a Tokio `Instant` deadline from the validated timeout, and delegates the actual blocking logic to `wait_for_activity`. The resulting `WaitOutcome` is converted into a user-visible `WaitAgentResult` whose `message` distinguishes mailbox activity, steering interruption, and timeout, while `timed_out` is only true for the timeout case. Finally, it emits `CollabWaitingEndEvent` and boxes the result. The helper `wait_for_activity` first consumes pending activity immediately, otherwise waits on `activity_rx.changed()` under `timeout_at`; both channel closure and elapsed timeout are treated as `TimedOut`, which keeps the tool behavior simple and deterministic.

#### Function details

##### `Handler::new`  (lines 18–20)

```
fn new(options: WaitAgentTimeoutOptions) -> Self
```

**Purpose**: Constructs a wait-agent handler with the configured timeout-spec options. Those options are later used only when publishing the tool schema.

**Data flow**: Takes `WaitAgentTimeoutOptions` by value, stores it in `Handler { options }`, and returns the new handler.

**Call relations**: Used during tool registration so the runtime can instantiate a handler whose `spec` reflects deployment-specific timeout settings.


##### `Handler::tool_name`  (lines 24–26)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name `wait_agent`. This is the dispatch key for model-issued function calls.

**Data flow**: Creates and returns a `ToolName` from the static string via `ToolName::plain`.

**Call relations**: Queried by the tool registry/runtime before execution.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 28–30)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the advertised schema for the wait tool. The schema is parameterized by the handler's timeout options.

**Data flow**: Reads `self.options`, passes it to `create_wait_agent_tool_v2`, and returns the resulting `ToolSpec`.

**Call relations**: Called when the system enumerates available tools for the model.

*Call graph*: calls 1 internal fn (create_wait_agent_tool_v2).


##### `Handler::handle`  (lines 32–34)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async wait implementation to the executor trait's boxed-future interface. It does not perform validation itself.

**Data flow**: Takes a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes the future with `Box::pin`, and returns it.

**Call relations**: This is the runtime entrypoint; all substantive work is delegated to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 38–111)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Executes a `wait_agent` request end to end: parse timeout, subscribe to queue activity, emit waiting events, block until activity or timeout, and return a structured result. It is the main control-flow function in the file.

**Data flow**: Reads `session`, `turn`, `payload`, and `call_id` from the invocation; parses `WaitArgs`; reads min/max/default timeout settings from `turn.config.multi_agent_v2`; validates or defaults `timeout_ms`; queries `session.input_queue` for turn state and subscribes to activity, receiving a watch receiver plus optional pending activity; sends a `CollabWaitingBeginEvent` timestamped with `now_unix_timestamp_ms`; computes a deadline from `Instant::now()` plus `Duration::from_millis`; awaits `wait_for_activity`; converts the returned `WaitOutcome` with `WaitAgentResult::from_outcome`; sends a matching `CollabWaitingEndEvent`; and returns the boxed result.

**Call relations**: Called only from `Handler::handle`. It delegates the blocking/wakeup logic to `wait_for_activity` and the user-facing message mapping to `WaitAgentResult::from_outcome`.

*Call graph*: calls 2 internal fn (wait_for_activity, now_unix_timestamp_ms); called by 1 (handle); 7 external calls (from_millis, new, now, new, from_outcome, format!, RespondToModel).


##### `Handler::matches_kind`  (lines 115–117)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this handler only accepts function payloads. This keeps dispatch aligned with the tool's schema-driven invocation style.

**Data flow**: Pattern-matches `payload` and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: Used by the core runtime before invoking `handle`.

*Call graph*: 1 external calls (matches!).


##### `WaitAgentResult::from_outcome`  (lines 133–143)

```
fn from_outcome(outcome: WaitOutcome) -> Self
```

**Purpose**: Maps an internal `WaitOutcome` enum into the externally returned message and timeout flag. It centralizes the wording for all wait completions.

**Data flow**: Consumes a `WaitOutcome`, selects one of three fixed strings (`Wait completed.`, `Wait interrupted by new input.`, `Wait timed out.`), computes `timed_out` by equality check against `WaitOutcome::TimedOut`, and returns a populated `WaitAgentResult`.

**Call relations**: Called from `Handler::handle_call` immediately after the wait finishes so the internal wakeup reason can be exposed as tool output.


##### `WaitAgentResult::log_preview`  (lines 147–149)

```
fn log_preview(&self) -> String
```

**Purpose**: Serializes the wait result into a JSON log preview labeled as `wait_agent`. This gives logs the same shape as the response payload.

**Data flow**: Reads `self`, passes it to the shared JSON-text helper, and returns the resulting string.

**Call relations**: Used by generic tool-output logging after successful execution.


##### `WaitAgentResult::success_for_logging`  (lines 151–153)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks all returned wait results as successful from the logging perspective. Even a timeout is represented as a normal tool outcome rather than an execution failure.

**Data flow**: Returns the constant boolean `true`.

**Call relations**: Consumed by the framework's logging layer.


##### `WaitAgentResult::to_response_item`  (lines 155–157)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the typed wait result into a protocol response item. Unlike some tools, it leaves the explicit success flag unset.

**Data flow**: Takes `&self`, `call_id`, and `payload`; forwards them to the shared response-item helper with `None` for success and the tool label `wait_agent`; returns the resulting `ResponseInputItem`.

**Call relations**: Called by the tool framework when emitting the tool result back into the conversation stream.


##### `WaitAgentResult::code_mode_result`  (lines 159–161)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the structured JSON result used in code mode. It mirrors the normal serialized result.

**Data flow**: Reads `self`, ignores the payload, and returns a `JsonValue` from the shared code-mode helper for `wait_agent`.

**Call relations**: Used by code-mode response generation paths.


##### `wait_for_activity`  (lines 171–189)

```
async fn wait_for_activity(
    activity_rx: &mut tokio::sync::watch::Receiver<InputQueueActivity>,
    pending_activity: Option<InputQueueActivity>,
    deadline: Instant,
) -> WaitOutcome
```

**Purpose**: Waits for either already-pending input-queue activity, a future watch-channel change before the deadline, or timeout/channel closure. It reduces queue activity into the internal `WaitOutcome` enum.

**Data flow**: Takes a mutable watch `Receiver<InputQueueActivity>`, an optional `pending_activity`, and a Tokio `Instant` deadline. If `pending_activity` is present, it immediately maps `Mailbox` to `MailboxActivity` and `Steer` to `Steered`. Otherwise it awaits `timeout_at(deadline, activity_rx.changed())`; on a successful change it reads the latest activity via `borrow_and_update()` and maps it to `MailboxActivity` or `Steered`; on timeout or receiver error it returns `TimedOut`.

**Call relations**: Called from `Handler::handle_call` after subscription setup. It encapsulates the race-sensitive waiting logic so the handler can focus on validation and event emission.

*Call graph*: called by 1 (handle_call); 3 external calls (borrow_and_update, changed, timeout_at).


### Delegated and review workflows
These files cover higher-level nested-session workflows that run delegated child Codex threads, bridge code-mode execution into nested turns, and implement constrained review-mode subagents.

### `core/src/codex_delegate.rs`

`orchestration` · `subagent thread execution / delegated request handling`

This file is the delegation/orchestration layer for spawning and supervising sub-agent Codex sessions. `run_codex_thread_interactive` creates bounded submission/event channels, derives inherited context from the parent session and turn context, spawns a child `Codex` with `SessionSource::SubAgent(...)`, emits analytics for the new subagent session, and launches two background tasks: one to forward child events outward while intercepting approval-style events, and one to forward caller submissions into the child. `run_codex_thread_one_shot` wraps that interactive mode, immediately submits a `UserInput` op, then bridges events until `TurnComplete` or `TurnAborted`, at which point it sends `Op::Shutdown` and cancels the child token; it also returns a deliberately closed submission channel so callers cannot send more ops.

The event-forwarding path is selective. `forward_events` suppresses token-count and session-configured noise, routes exec/apply-patch approvals, request-permissions, and request-user-input events back through the parent session, and caches `McpInvocation`s between `McpToolCallBegin` and `McpToolCallEnd` so legacy MCP approval prompts can be reconstructed for guardian review. Cancellation triggers `shutdown_delegate`, which sends `Interrupt` then `Shutdown` and drains events briefly to avoid background send failures.

The helper functions implement the concrete round trips: approval requests may go through guardian review or ordinary parent-session prompts; request-user-input can be auto-answered for delegated MCP approvals; permission and user-input waits synthesize empty responses on cancellation and notify the parent session accordingly. The key invariant is that child approval events are never surfaced directly to the consumer—they are resolved through the parent and answered back into the child session.

#### Function details

##### `run_codex_thread_interactive`  (lines 69–174)

```
async fn run_codex_thread_interactive(
    config: Config,
    auth_manager: Arc<AuthManager>,
    models_manager: SharedModelsManager,
    parent_session: Arc<Session>,
    parent_ctx: Arc<TurnContex
```

**Purpose**: Spawns an interactive delegated Codex thread and returns channels for submitting ops and receiving non-approval events. It wires the child session to inherited parent context and starts background forwarding tasks.

**Data flow**: Inputs: `Config`, `Arc<AuthManager>`, shared models manager, parent `Session`, parent `TurnContext`, cancellation token, `SubAgentSource`, and optional `InitialHistory`. It creates bounded submission/op channels, resolves conversation history and fork lineage, loads parent user instructions, spawns `Codex::spawn` with inherited environment/exec-policy/services/thread-store/attestation and subagent session metadata, emits analytics via `emit_subagent_session_started`, wraps the child in `Arc`, creates child cancellation tokens, allocates a shared `pending_mcp_invocations` map, spawns `forward_events` and `forward_ops`, and returns a `Codex` facade exposing the caller-facing op sender and event receiver.

**Call relations**: This is the main delegated-thread constructor. `run_codex_thread_one_shot` builds on it, and tests verify that pre-cancelled spawn exits promptly rather than hanging.

*Call graph*: calls 5 internal fn (forward_events, forward_ops, spawn, emit_subagent_session_started, disabled); called by 2 (run_codex_thread_one_shot, spawn_guardian_review_session); 12 external calls (clone, new, pin, child_token, new, new, new, SubAgent, bounded, default (+2 more)).


##### `run_codex_thread_one_shot`  (lines 180–259)

```
async fn run_codex_thread_one_shot(
    config: Config,
    auth_manager: Arc<AuthManager>,
    models_manager: SharedModelsManager,
    input: Vec<UserInput>,
    parent_session: Arc<Session>,
    pa
```

**Purpose**: Runs a delegated Codex thread for a single initial prompt and then automatically shuts it down after the turn finishes or aborts. It hides the interactive submission channel from callers after the initial request.

**Data flow**: Inputs mirror the interactive variant plus initial `Vec<UserInput>` and optional final-output JSON schema. It creates a child cancellation token, awaits `run_codex_thread_interactive`, submits an initial `Op::UserInput` carrying the provided items/schema, creates a bridge channel, clones the child op sender/session/status handles, spawns a task that forwards events from the interactive child into the bridge and on `TurnComplete`/`TurnAborted` sends `Op::Shutdown` then cancels the child token, creates a fresh bounded channel and drops its receiver to produce a permanently closed sender, and returns a `Codex` facade with the bridged event receiver and closed submission sender.

**Call relations**: Called by higher-level one-shot review/start flows. It delegates setup to `run_codex_thread_interactive` and adds automatic completion detection plus shutdown.

*Call graph*: calls 1 internal fn (run_codex_thread_interactive); called by 1 (start_review_conversation); 7 external calls (clone, pin, child_token, default, bounded, matches!, spawn).


##### `forward_events`  (lines 261–400)

```
async fn forward_events(
    codex: Arc<Codex>,
    tx_sub: Sender<Event>,
    parent_session: Arc<Session>,
    parent_ctx: Arc<TurnContext>,
    pending_mcp_invocations: Arc<Mutex<HashMap<String, Mc
```

**Purpose**: Consumes events from the child Codex session, forwarding ordinary events to the caller while intercepting approvals and request-style events for parent-mediated handling. It also tracks MCP invocation context needed for later guardian auto-review.

**Data flow**: Inputs: child `Arc<Codex>`, outbound `Sender<Event>`, parent session/context, shared `pending_mcp_invocations` map, and cancellation token. It pins `cancel_token.cancelled()` and loops with `tokio::select!`: on cancellation it calls `shutdown_delegate` and exits; on each child event it ignores `TokenCount` and `SessionConfigured`, routes `ExecApprovalRequest`, `ApplyPatchApprovalRequest`, `RequestPermissions`, and `RequestUserInput` into their dedicated handlers, caches/removes `McpInvocation`s on `McpToolCallBegin`/`McpToolCallEnd`, and forwards all other events through `forward_event_or_shutdown`, breaking if forwarding fails.

**Call relations**: Spawned by `run_codex_thread_interactive`. It is the central dispatcher that decides which child events are surfaced and which are resolved through the parent session.

*Call graph*: called by 1 (run_codex_thread_interactive); 3 external calls (cancelled, pin!, select!).


##### `shutdown_delegate`  (lines 403–418)

```
async fn shutdown_delegate(codex: &Codex)
```

**Purpose**: Attempts a graceful stop of the delegated child session and drains events briefly so background senders do not race a closed channel. It is the cleanup path used after cancellation or forwarding failure.

**Data flow**: Sends `Op::Interrupt` and `Op::Shutdown` to the child `Codex`, then waits up to 500 ms while repeatedly reading `codex.next_event()` until a `TurnAborted` or `TurnComplete` event appears or the timeout expires.

**Call relations**: Called by `forward_event_or_shutdown` when forwarding to the consumer fails, and by `forward_events` when the delegate cancellation token fires.

*Call graph*: calls 2 internal fn (next_event, submit); called by 1 (forward_event_or_shutdown); 3 external calls (from_millis, matches!, timeout).


##### `forward_event_or_shutdown`  (lines 420–433)

```
async fn forward_event_or_shutdown(
    codex: &Codex,
    tx_sub: &Sender<Event>,
    cancel_token: &CancellationToken,
    event: Event,
) -> bool
```

**Purpose**: Attempts to forward one child event to the consumer and shuts down the delegate if the send fails or is cancelled. It converts channel/backpressure failure into orderly child termination.

**Data flow**: Inputs: child `Codex`, outbound sender, cancellation token, and event. It awaits `tx_sub.send(event).or_cancel(cancel_token)`; on `Ok(Ok(()))` it returns `true`, otherwise it calls `shutdown_delegate(codex).await` and returns `false`.

**Call relations**: Used by `forward_events` for all events that should be surfaced to the caller. It encapsulates the policy that a blocked or closed consumer means the child should be stopped.

*Call graph*: calls 1 internal fn (shutdown_delegate); 1 external calls (send).


##### `forward_ops`  (lines 436–448)

```
async fn forward_ops(
    codex: Arc<Codex>,
    rx_ops: Receiver<Submission>,
    cancel_token_ops: CancellationToken,
)
```

**Purpose**: Forwards caller submissions into the delegated child session until the op channel closes or cancellation occurs. It is the inbound half of the interactive bridge.

**Data flow**: Loops receiving `Submission` values from `rx_ops.recv().or_cancel(&cancel_token_ops)` → on each successful submission calls `codex.submit_with_id(submission).await` and ignores the result → exits on channel close or cancellation.

**Call relations**: Spawned by `run_codex_thread_interactive`. Tests verify that it preserves submission trace context when forwarding.

*Call graph*: calls 1 internal fn (recv); called by 1 (run_codex_thread_interactive).


##### `handle_exec_approval`  (lines 451–531)

```
async fn handle_exec_approval(
    codex: &Codex,
    turn_id: String,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    event: ExecApprovalRequestEvent,
    cancel_token: &Can
```

**Purpose**: Resolves a delegated shell-execution approval request through the parent session or guardian review and sends the resulting decision back into the child Codex session. It carefully distinguishes the tool-call id from the approval callback id.

**Data flow**: Inputs: child codex, child turn id, parent session/context, `ExecApprovalRequestEvent`, and cancellation token. It computes `approval_id_for_op = event.effective_approval_id()`, destructures the event, and either: (a) if guardian routing is enabled, spawns a guardian review request describing the shell command/cwd/permissions and awaits it with cancellation support; or (b) asks `parent_session.request_command_approval(...)` and awaits that result with cancellation support. It then submits `Op::ExecApproval { id: approval_id_for_op, turn_id: Some(turn_id), decision }` back to the child.

**Call relations**: Called by `forward_events` when the child emits `EventMsg::ExecApprovalRequest`. Tests verify that guardian review targets the call id while the reply uses the approval id.

*Call graph*: calls 3 internal fn (await_approval_with_cancel, submit, effective_approval_id); 5 external calls (clone, child_token, new_guardian_review_id, routes_approval_to_guardian, spawn_approval_request_review).


##### `handle_patch_approval`  (lines 534–635)

```
async fn handle_patch_approval(
    codex: &Codex,
    _id: String,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    event: ApplyPatchApprovalRequestEvent,
    cancel_token: &
```

**Purpose**: Resolves a delegated apply-patch approval request through guardian review or the parent session and replies to the child with the chosen decision. It reconstructs a human-readable patch summary for guardian review.

**Data flow**: Inputs: child codex, parent session/context, `ApplyPatchApprovalRequestEvent`, and cancellation token. It derives `approval_id` from `call_id`, and if guardian routing is enabled it computes affected file paths and a textual patch by formatting each `FileChange` variant (`Add`, `Delete`, `Update` with optional move), spawns guardian review, and awaits the decision with cancellation support. If guardian is not used, or after guardian returns `None`, it requests patch approval from the parent session and awaits that result. Finally it submits `Op::PatchApproval { id: approval_id, decision }` to the child.

**Call relations**: Called by `forward_events` for `EventMsg::ApplyPatchApprovalRequest`. It parallels `handle_exec_approval` but with patch-specific review payload construction.

*Call graph*: calls 2 internal fn (await_approval_with_cancel, submit); 5 external calls (clone, child_token, new_guardian_review_id, routes_approval_to_guardian, spawn_approval_request_review).


##### `handle_request_user_input`  (lines 637–673)

```
async fn handle_request_user_input(
    codex: &Codex,
    id: String,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    pending_mcp_invocations: &Arc<Mutex<HashMap<String, Mcp
```

**Purpose**: Handles delegated `RequestUserInput` events by either auto-answering legacy MCP approval prompts through guardian review or forwarding the questions to the parent session. It always sends a `UserInputAnswer` back to the child.

**Data flow**: Inputs: child codex, request id, parent session/context, shared pending-MCP map, `RequestUserInputEvent`, and cancellation token. It first calls `maybe_auto_review_mcp_request_user_input(...)`; if that returns a response, it immediately submits `Op::UserInputAnswer { id, response }`. Otherwise it builds `RequestUserInputArgs` from the event questions/timeout, asks `parent_session.request_user_input(...)`, awaits the result via `await_user_input_with_cancel`, and submits the resulting answer op back to the child.

**Call relations**: Called by `forward_events` for `EventMsg::RequestUserInput`. It is the entrypoint for the MCP auto-review compatibility path implemented by `maybe_auto_review_mcp_request_user_input`.

*Call graph*: calls 3 internal fn (await_user_input_with_cancel, maybe_auto_review_mcp_request_user_input, submit).


##### `maybe_auto_review_mcp_request_user_input`  (lines 682–757)

```
async fn maybe_auto_review_mcp_request_user_input(
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    pending_mcp_invocations: &Arc<Mutex<HashMap<String, McpInvocation>>>,
    e
```

**Purpose**: Detects legacy MCP approval prompts delivered through `RequestUserInput`, reconstructs the original MCP invocation from cached begin events, and—when guardian review is configured—returns a synthetic answer without surfacing the prompt to the user. It bridges an older compatibility path into the newer guardian approval flow.

**Data flow**: Inputs: parent session/context, shared pending-MCP invocation map, `RequestUserInputEvent`, and cancellation token. It finds the first question whose id matches the MCP approval prefix; if none, returns `None`. It looks up the cached `McpInvocation` by `event.call_id`; if missing, returns `None`. It fetches MCP tool metadata, computes the approvals reviewer, and if guardian routing is not enabled for that reviewer returns `None`. Otherwise it spawns guardian review using `build_guardian_mcp_tool_review_request`, awaits the decision with cancellation support, maps the resulting `ReviewDecision` into a selected answer label (`accept`, `accept for session`, or synthetic decline), and returns `Some(RequestUserInputResponse { answers: ... })` keyed by the original question id.

**Call relations**: Called only by `handle_request_user_input`. Tests cover both the cancelled-guardian path producing a synthetic decline answer and the no-metadata path returning `None`.

*Call graph*: calls 4 internal fn (await_approval_with_cancel, build_guardian_mcp_tool_review_request, lookup_mcp_tool_metadata, mcp_approvals_reviewer); called by 1 (handle_request_user_input); 7 external calls (clone, child_token, from, new_guardian_review_id, routes_approval_to_guardian_with_reviewer, spawn_approval_request_review, vec!).


##### `handle_request_permissions`  (lines 759–792)

```
async fn handle_request_permissions(
    codex: &Codex,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    event: RequestPermissionsEvent,
    cancel_token: &CancellationToken,
```

**Purpose**: Forwards a delegated permission request to the parent session, waits for the response or cancellation, and sends the resulting permission grant back into the child session. It preserves the child tool-call id for round-trip correlation.

**Data flow**: Inputs: child codex, parent session/context, `RequestPermissionsEvent`, and cancellation token. It extracts `call_id`, builds `RequestPermissionsArgs` from environment/reason/permissions, chooses `cwd` from the event or falls back to the parent context cwd, calls `parent_session.request_permissions_for_cwd(...)`, awaits the result via `await_request_permissions_with_cancel`, and submits `Op::RequestPermissionsResponse { id: call_id, response }` to the child.

**Call relations**: Called by `forward_events` for `EventMsg::RequestPermissions`. Tests verify that the original tool-call id is used both in the parent-facing request and the child-facing response op.

*Call graph*: calls 2 internal fn (await_request_permissions_with_cancel, submit); 1 external calls (clone).


##### `await_user_input_with_cancel`  (lines 794–818)

```
async fn await_user_input_with_cancel(
    fut: F,
    parent_session: &Session,
    sub_id: &str,
    cancel_token: &CancellationToken,
) -> RequestUserInputResponse
```

**Purpose**: Waits for a parent-session user-input response but synthesizes and notifies an empty response if delegation is cancelled first. It ensures the parent session sees a terminal answer even on cancellation.

**Data flow**: Inputs: a future yielding `Option<RequestUserInputResponse>`, parent session, sub-id, and cancellation token. In a biased `tokio::select!`, if cancellation fires first it constructs `RequestUserInputResponse { answers: HashMap::new() }`, calls `parent_session.notify_user_input_response(sub_id, empty.clone()).await`, and returns the empty response. Otherwise it awaits the future and returns its value or the same empty default if the future yields `None`.

**Call relations**: Used by `handle_request_user_input` for the non-auto-reviewed path. It encapsulates cancellation semantics for delegated user-input prompts.

*Call graph*: called by 1 (handle_request_user_input); 1 external calls (select!).


##### `await_request_permissions_with_cancel`  (lines 820–848)

```
async fn await_request_permissions_with_cancel(
    fut: F,
    parent_session: &Session,
    call_id: &str,
    cancel_token: &CancellationToken,
) -> RequestPermissionsResponse
```

**Purpose**: Waits for a parent-session permission response but synthesizes and notifies an empty turn-scoped response if delegation is cancelled first. It mirrors the user-input cancellation helper for permission requests.

**Data flow**: Inputs: a future yielding `Option<RequestPermissionsResponse>`, parent session, call id, and cancellation token. In a biased `tokio::select!`, cancellation constructs `RequestPermissionsResponse { permissions: Default::default(), scope: PermissionGrantScope::Turn, strict_auto_review: false }`, notifies the parent session with that response, and returns it. Otherwise it awaits the future and returns its value or the same default if `None`.

**Call relations**: Used by `handle_request_permissions`. It guarantees a concrete response object even when the delegated flow is interrupted.

*Call graph*: called by 1 (handle_request_permissions); 1 external calls (select!).


##### `await_approval_with_cancel`  (lines 851–876)

```
async fn await_approval_with_cancel(
    fut: F,
    parent_session: &Session,
    approval_id: &str,
    cancel_token: &CancellationToken,
    review_cancel_token: Option<&CancellationToken>,
) -> co
```

**Purpose**: Waits for an approval decision but aborts the review and notifies the parent session if delegation is cancelled first. It is the shared cancellation wrapper for exec, patch, and MCP guardian approvals.

**Data flow**: Inputs: a future yielding `ReviewDecision`, parent session, approval id, cancellation token, and optional review-cancel token. In a biased `tokio::select!`, cancellation first cancels the review token if present, then calls `parent_session.notify_approval(approval_id, ReviewDecision::Abort).await`, and returns `ReviewDecision::Abort`. Otherwise it awaits and returns the future’s decision.

**Call relations**: Used by `handle_exec_approval`, `handle_patch_approval`, and `maybe_auto_review_mcp_request_user_input` to unify cancellation behavior across all delegated approval flows.

*Call graph*: called by 3 (handle_exec_approval, handle_patch_approval, maybe_auto_review_mcp_request_user_input); 1 external calls (select!).


### `core/src/tasks/review.rs`

`domain_logic` · `review-mode turn execution and teardown`

This module defines `ReviewTask`, a lightweight `SessionTask` whose real work is delegated to a one-shot sub-Codex thread. `run` first increments a `codex.task.review` telemetry counter, then extracts only `UserInput` content from the incoming `Vec<TurnInput>`, ignoring response items and inter-agent messages. It starts a review conversation with `start_review_conversation`, which clones the current config and then deliberately tightens it: web search is forced to `Disabled`, several features (`SpawnCsv`, `Collab`, `MultiAgentV2`) are disabled, base instructions are replaced with `crate::REVIEW_PROMPT`, approval policy is forced to `AskForApproval::Never`, and the model is set to `config.review_model` or the current turn model slug. That constrained config is passed into `run_codex_thread_one_shot`, yielding an event receiver.

`process_review_events` consumes that receiver and selectively forwards events to the parent session. It buffers the most recent `AgentMessage` instead of forwarding it immediately, suppresses assistant `ItemCompleted` and content-delta events to avoid legacy message duplication, forwards all other events unchanged, and on `TurnComplete` parses the final `last_agent_message` into a `ReviewOutputEvent`. Parsing is resilient: it first tries full JSON deserialization, then the first `{...}` substring, and finally falls back to a default event carrying the raw text in `overall_explanation`.

Whether the review succeeds or is interrupted, `exit_review_mode` emits an `ExitedReviewMode` event and records rollout items. On success it formats findings into a user-visible exit message and a structured assistant summary; on interruption it records canned interrupted text. It writes a synthetic user message first, emits the protocol event, then records/emits the assistant message, and finally forces rollout materialization because review turns may occur before any regular user turn has created persistence artifacts.

#### Function details

##### `ReviewTask::new`  (lines 37–39)

```
fn new() -> Self
```

**Purpose**: Constructs the stateless review task value.

**Data flow**: Takes no arguments and returns `ReviewTask` by value.

**Call relations**: Review-thread startup code and tests instantiate this before spawning a review task.

*Call graph*: called by 2 (spawn_review_thread, abort_review_task_emits_exited_then_aborted_and_records_history).


##### `ReviewTask::kind`  (lines 43–45)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Identifies this task as review work.

**Data flow**: Reads `self` and returns `TaskKind::Review`.

**Call relations**: The session task framework uses this to classify the running task.


##### `ReviewTask::span_name`  (lines 47–49)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Supplies the tracing span name for spawned review tasks.

**Data flow**: Reads `self` and returns `"session_task.review"`.

**Call relations**: Task startup uses this when creating the outer tracing span.


##### `ReviewTask::run`  (lines 51–88)

```
async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> O
```

**Purpose**: Runs review mode by extracting user input, launching a constrained sub-agent review conversation, processing its events, and exiting review mode unless cancellation already fired.

**Data flow**: Consumes the task `Arc`, task context, turn context, input vector, and cancellation token. It increments a telemetry counter, filters `TurnInput` down to a flat `Vec<UserInput>`, starts the review sub-conversation, optionally processes returned events into `Option<ReviewOutputEvent>`, and if the cancellation token is still not cancelled calls `exit_review_mode` with that output. It always returns `None` because review completion is surfaced through explicit events and rollout items rather than a final agent message string.

**Call relations**: The generic task runner invokes this for review turns. It delegates setup to `start_review_conversation`, event handling to `process_review_events`, and finalization to `exit_review_mode`.

*Call graph*: calls 3 internal fn (exit_review_mode, process_review_events, start_review_conversation); 3 external calls (clone, is_cancelled, new).


##### `ReviewTask::abort`  (lines 90–92)

```
async fn abort(&self, session: Arc<SessionTaskContext>, ctx: Arc<TurnContext>)
```

**Purpose**: Performs review-specific abort cleanup by explicitly exiting review mode without output.

**Data flow**: Consumes task/session context and turn context, clones the session from `SessionTaskContext`, calls `exit_review_mode(..., None, ctx)`, and returns `()`.

**Call relations**: Abort orchestration calls this after cancelling a running review task so the parent session still receives review-exit signaling and persisted interrupted messages.

*Call graph*: calls 1 internal fn (exit_review_mode).


##### `start_review_conversation`  (lines 95–139)

```
async fn start_review_conversation(
    session: Arc<SessionTaskContext>,
    ctx: Arc<TurnContext>,
    input: Vec<UserInput>,
    cancellation_token: CancellationToken,
) -> Option<async_channel::Re
```

**Purpose**: Builds a constrained sub-agent configuration for review mode and launches a one-shot delegated Codex thread, returning its event receiver on success.

**Data flow**: Consumes task context, turn context, flattened `Vec<UserInput>`, and a cancellation token. It clones `ctx.config`, mutates the clone to disable review-forbidden capabilities, sets review prompt instructions and `AskForApproval::Never`, chooses the review model or current model slug, then calls `run_codex_thread_one_shot` with auth/models/session/turn context and `SubAgentSource::Review`. It converts the result into `Option<async_channel::Receiver<Event>>` by discarding errors and extracting `io.rx_event` on success.

**Call relations**: Only `ReviewTask::run` calls this as the setup phase before event processing. It delegates actual sub-thread execution to the codex delegate layer.

*Call graph*: calls 2 internal fn (allow_only, run_codex_thread_one_shot); called by 1 (run); 1 external calls (panic!).


##### `process_review_events`  (lines 141–188)

```
async fn process_review_events(
    session: Arc<SessionTaskContext>,
    ctx: Arc<TurnContext>,
    receiver: async_channel::Receiver<Event>,
) -> Option<ReviewOutputEvent>
```

**Purpose**: Consumes events from the delegated review thread, forwarding only the desired subset to the parent session and extracting structured review output from completion.

**Data flow**: Consumes task context, turn context, and an async-channel receiver. It loops on `receiver.recv().await`, cloning each event's message for matching. `AgentMessage` events are buffered so only the previous one is forwarded when a newer one arrives; assistant `ItemCompleted` and `AgentMessageContentDelta` are suppressed; `TurnComplete` parses `last_agent_message` with `parse_review_output_event` and returns `Option<ReviewOutputEvent>`; `TurnAborted` returns `None`; all other events are forwarded to the parent session via `send_event`. If the channel closes unexpectedly, it returns `None`.

**Call relations**: This is the middle phase of `ReviewTask::run` after sub-thread startup. It delegates parsing to `parse_review_output_event` and event forwarding to the parent session.

*Call graph*: calls 1 internal fn (recv); called by 1 (run).


##### `parse_review_output_event`  (lines 195–210)

```
fn parse_review_output_event(text: &str) -> ReviewOutputEvent
```

**Purpose**: Attempts to recover a `ReviewOutputEvent` from model text, tolerating wrappers or malformed non-JSON output.

**Data flow**: Consumes `text: &str`. It first tries `serde_json::from_str::<ReviewOutputEvent>(text)`, then searches for the first `{` and last `}` and retries deserialization on that substring, and if both fail returns `ReviewOutputEvent { overall_explanation: text.to_string(), ..Default::default() }`.

**Call relations**: Only `process_review_events` calls this when the delegated review thread completes. It isolates the review-output parsing heuristics from the event loop.

*Call graph*: 1 external calls (default).


##### `exit_review_mode`  (lines 214–280)

```
async fn exit_review_mode(
    session: Arc<Session>,
    review_output: Option<ReviewOutputEvent>,
    ctx: Arc<TurnContext>,
)
```

**Purpose**: Finalizes review mode by emitting `ExitedReviewMode`, recording synthetic rollout messages that summarize success or interruption, and ensuring rollout persistence exists.

**Data flow**: Consumes the parent `Arc<Session>`, optional `ReviewOutputEvent`, and `Arc<TurnContext>`. It chooses fixed rollout message ids, then either formats successful findings using `format_review_findings_block`, `render_review_exit_success`, and `render_review_output_text`, or uses interrupted fallback strings from `render_review_exit_interrupted`. It records a synthetic user `ResponseItem::Message`, sends `EventMsg::ExitedReviewMode` carrying the optional structured output, records and emits an assistant `ResponseItem::Message`, and finally awaits `ensure_rollout_materialized()`. It returns `()`.

**Call relations**: Both normal review completion and review abort paths call this so clients and rollout history see a consistent review-exit sequence. It delegates formatting to review/prompt helpers and persistence/event emission to session methods.

*Call graph*: calls 2 internal fn (format_review_findings_block, render_review_output_text); called by 2 (abort, run); 6 external calls (new, render_review_exit_interrupted, render_review_exit_success, format!, ExitedReviewMode, vec!).


### `core/src/tools/code_mode/delegate.rs`

`orchestration` · `per-turn code-mode execution`

This file provides the dispatch side of code mode. `CodeModeDispatchBroker` owns an unbounded async channel carrying `DispatchMessage`s and a mutex-protected `HashMap<CellId, watch::Sender<bool>>` used as per-cell readiness gates. A cell starts with a `false` gate; `mark_cell_ready_for_dispatch` flips it to `true`, and `close_cell` removes the gate entirely. `start_turn_worker` creates a `ToolCallRuntime` bound to the current session and turn, wraps it in `CoreTurnHost`, clones the receiver and gate map, and spawns a background loop that processes dispatch messages until a oneshot shutdown signal arrives or the channel closes.

The worker treats notifications and nested tool invocations differently. For `Notify`, it waits until the target cell is ready or cancelled, then calls `CoreTurnHost::notify`; on cancellation it removes the gate and returns an error through a oneshot response channel. For `InvokeTool`, it also waits for readiness, but once ready it spawns a separate task so long-running nested tool calls do not block the main dispatch loop. Cancellation is checked both before queueing and while awaiting the response. `dispatch_gate` and `wait_until_cell_ready_for_dispatch` are careful about poisoned mutexes and watch-channel closure.

`CodeModeDispatchBroker` implements `CodeModeSessionDelegate`, so the external code-mode service can ask core to invoke nested tools or inject notifications. `CoreTurnHost::invoke_tool` delegates to `call_nested_tool`, while `notify` injects a `ResponseItem::CustomToolCallOutput` named with the public code-mode tool into the running session, rejecting empty text and reporting an error if there is no active turn. `CodeModeDispatchWorker` is just a shutdown handle whose `Drop` sends the stop signal.

#### Function details

##### `CodeModeDispatchBroker::new`  (lines 31–38)

```
fn new() -> Self
```

**Purpose**: Creates a fresh dispatch broker with an unbounded message queue and no per-cell gates.

**Data flow**: Allocates an async-channel sender/receiver pair, initializes an empty `HashMap<CellId, watch::Sender<bool>>` inside `Arc<Mutex<_>>`, and returns `CodeModeDispatchBroker`.

**Call relations**: Constructed by `CodeModeService::new` as the delegate backing code-mode nested dispatch.

*Call graph*: called by 1 (new); 4 external calls (new, new, new, unbounded).


##### `CodeModeDispatchBroker::mark_cell_ready_for_dispatch`  (lines 40–42)

```
fn mark_cell_ready_for_dispatch(&self, cell_id: &CellId)
```

**Purpose**: Marks a cell as ready so queued notifications and nested tool calls may proceed.

**Data flow**: Looks up or creates the cell’s watch sender via `dispatch_gate` and calls `send_replace(true)` on it; returns unit.

**Call relations**: Called by the code-mode execute path once the runtime has started and dispatch into the cell is safe.

*Call graph*: calls 1 internal fn (dispatch_gate).


##### `CodeModeDispatchBroker::close_cell`  (lines 44–46)

```
fn close_cell(&self, cell_id: &CellId)
```

**Purpose**: Removes the readiness gate for a cell, preventing further dispatch waits from succeeding.

**Data flow**: Calls `remove_dispatch_gate` with the shared gate map and target `cell_id`.

**Call relations**: Used directly by `cell_closed` and by the service when a cell’s dispatch lifecycle is finished.

*Call graph*: calls 1 internal fn (remove_dispatch_gate); called by 1 (cell_closed).


##### `CodeModeDispatchBroker::start_turn_worker`  (lines 48–129)

```
fn start_turn_worker(
        &self,
        exec: ExecContext,
        router: Arc<ToolRouter>,
        tracker: SharedTurnDiffTracker,
    ) -> CodeModeDispatchWorker
```

**Purpose**: Starts the background worker that services code-mode notifications and nested tool invocations for a specific turn.

**Data flow**: Builds a `ToolCallRuntime` from the provided router, session, turn, and diff tracker; wraps it in `CoreTurnHost`; clones the dispatch receiver and gate map; creates a oneshot shutdown channel; and spawns an async loop. The loop selects between shutdown and incoming `DispatchMessage`s, waits for per-cell readiness with cancellation support, dispatches notifications inline, dispatches tool invocations in detached tasks, removes gates on cancellation, and sends results back through per-request oneshot channels. It returns `CodeModeDispatchWorker` holding the shutdown sender.

**Call relations**: Called by `CodeModeService::start_turn_worker` when a turn is in code mode and nested dispatch should be enabled.

*Call graph*: calls 3 internal fn (remove_dispatch_gate, wait_until_cell_ready_for_dispatch, new); 6 external calls (clone, new, clone, channel, select!, spawn).


##### `dispatch_gate`  (lines 132–144)

```
fn dispatch_gate(
    dispatch_gates: &Mutex<HashMap<CellId, watch::Sender<bool>>>,
    cell_id: &CellId,
) -> watch::Sender<bool>
```

**Purpose**: Fetches or lazily creates the watch sender that represents readiness for a given cell.

**Data flow**: Locks the `dispatch_gates` mutex, recovering from poisoning by taking the inner map, inserts `watch::channel(false).0` if the cell id is absent, clones the sender, and returns it.

**Call relations**: Used by readiness marking and by waiters that need to subscribe to a cell’s readiness state.

*Call graph*: called by 2 (mark_cell_ready_for_dispatch, wait_until_cell_ready_for_dispatch); 1 external calls (clone).


##### `remove_dispatch_gate`  (lines 146–155)

```
fn remove_dispatch_gate(
    dispatch_gates: &Mutex<HashMap<CellId, watch::Sender<bool>>>,
    cell_id: &CellId,
)
```

**Purpose**: Deletes a cell’s readiness gate from the shared gate map.

**Data flow**: Locks the mutex, recovering from poisoning if necessary, removes the entry for `cell_id`, and returns unit.

**Call relations**: Called when cells close or when a queued dispatch is cancelled before readiness.

*Call graph*: called by 2 (close_cell, start_turn_worker).


##### `wait_until_cell_ready_for_dispatch`  (lines 157–179)

```
async fn wait_until_cell_ready_for_dispatch(
    dispatch_gates: &Mutex<HashMap<CellId, watch::Sender<bool>>>,
    cell_id: &CellId,
    cancellation_token: &CancellationToken,
) -> bool
```

**Purpose**: Waits until a cell’s readiness gate becomes true or the operation is cancelled/closed.

**Data flow**: Immediately returns `false` if `cancellation_token` is already cancelled. Otherwise it subscribes to the cell’s watch sender via `dispatch_gate(...).subscribe()`, loops checking `borrow_and_update()`, and uses `tokio::select!` to await either `ready_rx.changed()` or `cancellation_token.cancelled()`. It returns `true` on readiness and `false` on cancellation or watch closure.

**Call relations**: Used by the worker before delivering notifications or nested tool calls to ensure dispatch does not race ahead of runtime startup.

*Call graph*: calls 1 internal fn (dispatch_gate); called by 1 (start_turn_worker); 2 external calls (is_cancelled, select!).


##### `CodeModeDispatchBroker::invoke_tool`  (lines 182–208)

```
fn invoke_tool(
        &'a self,
        invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Implements the delegate API for nested tool invocation by queueing a dispatch request and awaiting its JSON result.

**Data flow**: Returns a boxed future that first checks cancellation, creates a oneshot response channel, sends `DispatchMessage::InvokeTool { invocation, cancellation_token: clone, response_tx }` on `dispatch_tx`, maps send failure to an unavailable-dispatcher error, then `select!`s between the oneshot response and cancellation. It returns `Result<JsonValue, String>`.

**Call relations**: Called by the external code-mode runtime through the `CodeModeSessionDelegate` trait when script code invokes another tool.

*Call graph*: 6 external calls (pin, clone, is_cancelled, send, channel, select!).


##### `CodeModeDispatchBroker::notify`  (lines 210–240)

```
fn notify(
        &'a self,
        call_id: String,
        cell_id: CellId,
        text: String,
        cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a>
```

**Purpose**: Implements the delegate API for runtime notifications by queueing a notify dispatch and awaiting completion.

**Data flow**: Returns a boxed future that checks cancellation, creates a oneshot response channel, sends `DispatchMessage::Notify { call_id, cell_id, text, cancellation_token: clone, response_tx }`, maps send failure to an unavailable-dispatcher error, then waits for either the response or cancellation and returns `Result<(), String>`.

**Call relations**: Called by the external code-mode runtime when script execution wants to emit incremental output into the active turn.

*Call graph*: 6 external calls (pin, clone, is_cancelled, send, channel, select!).


##### `CodeModeDispatchBroker::cell_closed`  (lines 242–244)

```
fn cell_closed(&self, cell_id: &CellId)
```

**Purpose**: Implements the delegate callback that signals a cell has closed.

**Data flow**: Forwards the provided `cell_id` to `close_cell` and returns unit.

**Call relations**: Invoked by the code-mode runtime through the delegate trait when a cell’s lifecycle ends.

*Call graph*: calls 1 internal fn (close_cell).


##### `CodeModeDispatchWorker::drop`  (lines 267–271)

```
fn drop(&mut self)
```

**Purpose**: Stops the background dispatch loop when the worker handle is dropped.

**Data flow**: Takes `shutdown_tx` out of the option and sends `()` on it if present, ignoring send errors.

**Call relations**: Runs automatically when the per-turn worker goes out of scope, ensuring the spawned loop exits.


##### `CoreTurnHost::invoke_tool`  (lines 280–293)

```
async fn invoke_tool(
        &self,
        invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> Result<JsonValue, String>
```

**Purpose**: Executes a nested tool call inside the current turn and converts any tool error into a string.

**Data flow**: Clones `exec` and `tool_runtime`, passes them with `invocation` and `cancellation_token` to `call_nested_tool`, awaits the result, and maps `FunctionCallError` to `String` via `to_string()`.

**Call relations**: Called by the dispatch worker when it processes an `InvokeTool` message.

*Call graph*: 3 external calls (clone, clone, call_nested_tool).


##### `CoreTurnHost::notify`  (lines 295–311)

```
async fn notify(&self, call_id: String, cell_id: CellId, text: String) -> Result<(), String>
```

**Purpose**: Injects a code-mode notification into the running session as a custom tool-call output item.

**Data flow**: If `text.trim().is_empty()`, returns `Ok(())` immediately. Otherwise it builds a single `ResponseItem::CustomToolCallOutput` with the provided `call_id`, `PUBLIC_TOOL_NAME`, and `FunctionCallOutputPayload::from_text(text)`, then calls `session.inject_if_running(...)`. Failure to inject is mapped to an error string mentioning the `cell_id` and lack of an active turn.

**Call relations**: Called by the dispatch worker when it processes a `Notify` message after the target cell becomes ready.

*Call graph*: 1 external calls (vec!).


### `ext/guardian/src/lib.rs`

`orchestration` · `thread startup / guardian subagent spawning`

This file defines two small types and installs one thread lifecycle contributor. `GuardianExtension<S>` stores an arbitrary host-provided spawner implementation and exposes `spawn_subagent`, which simply forwards a guardian-owned spawn request together with the thread to fork from. `GuardianThreadContext` is the thread-local state inserted into extension data at thread start; it stores the current thread's `ThreadId` as the default `forked_from_thread_id` for future guardian subagents. The lifecycle implementation is intentionally conservative: on thread start it attempts to parse the thread store's level id into a `ThreadId`, and if parsing fails it silently returns without inserting context. That means malformed or non-thread-scoped stores do not crash startup, but guardian-dependent code must tolerate missing context. The `install` function wires the extension into the registry only as a thread lifecycle contributor; there are no tools or config hooks here. Overall, the file is mostly glue code, but the important invariant is that guardian subagent spawning should default to the thread that was actually started, as captured in thread-local extension data.

#### Function details

##### `GuardianExtension::new`  (lines 20–22)

```
fn new(agent_spawner: S) -> Self
```

**Purpose**: Constructs a guardian extension around a host-provided agent spawner. It is the only stateful initializer in the file.

**Data flow**: It takes an `agent_spawner` of generic type `S`, stores it in `GuardianExtension`, and returns the new extension value.

**Call relations**: It is called by `install` when registering the extension. The resulting instance later services thread-start callbacks and spawn forwarding.

*Call graph*: called by 1 (install).


##### `GuardianExtension::spawn_subagent`  (lines 25–35)

```
fn spawn_subagent(
        &'a self,
        forked_from_thread_id: ThreadId,
        request: R,
    ) -> AgentSpawnFuture<'a, <S as AgentSpawner<R>>::Spawned, <S as AgentSpawner<R>>::Error>
```

**Purpose**: Forwards one guardian subagent spawn request to the wrapped host spawner. It does not add policy or transformation beyond delegation.

**Data flow**: It takes `&self`, a `forked_from_thread_id`, and a generic request `R`, calls `self.agent_spawner.spawn_subagent(forked_from_thread_id, request)`, and returns the host spawner's future.

**Call relations**: It is intended to be called by guardian logic elsewhere once a thread context has identified the correct fork source. Its only downstream dependency is the external `AgentSpawner` implementation.

*Call graph*: 1 external calls (spawn_subagent).


##### `GuardianThreadContext::forked_from_thread_id`  (lines 46–48)

```
fn forked_from_thread_id(&self) -> ThreadId
```

**Purpose**: Returns the stored default fork source thread id for guardian subagents. It is the read accessor for thread-local guardian context.

**Data flow**: It reads the `forked_from_thread_id` field from `self` and returns that `ThreadId` by value.

**Call relations**: It is used by code that retrieves `GuardianThreadContext` from thread-scoped extension data after `on_thread_start` has inserted it.


##### `GuardianExtension::on_thread_start`  (lines 55–68)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: Captures the current thread id into thread-scoped guardian context when a thread starts. It seeds the default fork ancestry used by later guardian operations.

**Data flow**: It reads `input.thread_store.level_id()`, attempts to parse it with `ThreadId::from_string`, returns early on parse failure, and on success inserts `GuardianThreadContext { forked_from_thread_id }` into the thread store inside a boxed async future.

**Call relations**: The extension framework invokes it during thread startup because `GuardianExtension` implements `ThreadLifecycleContributor<Config>`. It prepares the thread-local state later consumed by guardian code.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (pin).


##### `install`  (lines 72–77)

```
fn install(registry: &mut ExtensionRegistryBuilder<Config>, agent_spawner: S)
```

**Purpose**: Registers the guardian extension with the extension registry. It is the file's public integration entry point.

**Data flow**: It takes a mutable `ExtensionRegistryBuilder<Config>` and an `agent_spawner`, constructs a `GuardianExtension` wrapped in `Arc`, and registers it as a thread lifecycle contributor.

**Call relations**: Hosts call this during extension setup. It delegates construction to `GuardianExtension::new` and registry wiring to `thread_lifecycle_contributor`.

*Call graph*: calls 2 internal fn (thread_lifecycle_contributor, new); 1 external calls (new).


### CSV agent jobs
This group describes the persisted batch-job workflow that spawns worker agents from CSV rows, accepts worker result reports, and completes with exported job summaries.

### `core/src/tools/handlers/agent_jobs.rs`

`domain_logic` · `background job execution`

This file provides the common machinery behind agent-job tools such as spawning workers from CSV rows and reporting results. It defines argument/result structs, job-runner configuration (`JobRunnerOptions`), and in-memory tracking for active worker threads (`ActiveJobItem`). The state DB is mandatory for this subsystem; `required_state_db` fails fast with a fatal error if the session lacks SQLite-backed state.

`build_runner_options` enforces multi-agent availability and thread limits from `TurnContext`, clamps requested concurrency through `normalize_concurrency`, fetches base instructions from the session, and derives a worker spawn `Config` via `build_agent_spawn_config`. Runtime limits are normalized separately by `normalize_max_runtime_seconds`.

The heart of the file is `run_agent_job_loop`. It loads the persisted job, computes a per-item timeout, recovers any already-running items from the DB, and then loops until all work is done or cancellation drains active workers. Within each iteration it may spawn new workers for pending items up to `max_concurrency`, mark spawn failures in the DB, reap stale active items, detect finished threads, and finalize completed items. Worker prompts are generated by `build_worker_prompt`, which renders row-specific placeholders into the job instruction and instructs the worker to call `report_agent_job_result` exactly once.

The file also contains CSV utilities: `parse_csv` reads flexible-header CSV while stripping a BOM from the first header and skipping fully empty rows; `ensure_unique_headers` rejects duplicate columns; `render_job_csv` writes original row columns plus job metadata/result columns, escaping values with `csv_escape`. Time-based helpers reconstruct `Instant` values from persisted timestamps and detect stale items based on `updated_at`.

#### Function details

##### `required_state_db`  (lines 100–106)

```
fn required_state_db(
    session: &Arc<Session>,
) -> Result<Arc<codex_state::StateRuntime>, FunctionCallError>
```

**Purpose**: Fetches the session's state runtime and fails with a fatal tool error if no SQLite-backed state DB is available. Agent jobs cannot operate without persistent state.

**Data flow**: Takes `session: &Arc<Session>` → calls `session.state_db()` → returns `Ok(Arc<StateRuntime>)` if present, otherwise `Err(FunctionCallError::Fatal("sqlite state db is unavailable for this session"))`.

**Call relations**: Agent-job handlers call this before performing any DB-backed operation. It has no delegates beyond the session accessor and acts as a prerequisite gate for the subsystem.


##### `build_runner_options`  (lines 108–132)

```
async fn build_runner_options(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    requested_concurrency: Option<usize>,
) -> Result<JobRunnerOptions, FunctionCallError>
```

**Purpose**: Validates that multi-agent execution is enabled and capacity exists, then computes the effective concurrency and worker spawn configuration for a job run. It packages those decisions into `JobRunnerOptions`.

**Data flow**: Takes `session`, `turn`, and optional requested concurrency → reads `turn.multi_agent_version` and rejects `Disabled` with `RespondToModel` → reads `turn.config.effective_agent_max_threads(...)` and rejects `Some(0)` similarly → computes `max_concurrency = normalize_concurrency(requested_concurrency, agent_max_threads)` → awaits `session.get_base_instructions()` → calls `build_agent_spawn_config(&base_instructions, turn.as_ref())` → returns `JobRunnerOptions { max_concurrency, spawn_config }`.

**Call relations**: This helper is used by higher-level agent-job handlers before launching `run_agent_job_loop`. It delegates concurrency clamping to `normalize_concurrency` and spawn-config construction to `build_agent_spawn_config`.

*Call graph*: calls 1 internal fn (normalize_concurrency); 2 external calls (build_agent_spawn_config, RespondToModel).


##### `normalize_concurrency`  (lines 134–142)

```
fn normalize_concurrency(requested: Option<usize>, max_threads: Option<usize>) -> usize
```

**Purpose**: Clamps requested job concurrency to a valid, bounded value and optionally to the session's remaining agent-thread limit. It prevents zero, excessive, or over-capacity worker counts.

**Data flow**: Takes `requested: Option<usize>` and `max_threads: Option<usize>` → defaults missing requests to `DEFAULT_AGENT_JOB_CONCURRENCY`, enforces minimum 1, caps at `MAX_AGENT_JOB_CONCURRENCY`, and if `max_threads` is present further caps to `max_threads.max(1)` → returns the effective `usize`.

**Call relations**: Called by `build_runner_options` to derive the final worker concurrency. It is a pure helper with no side effects.

*Call graph*: called by 1 (build_runner_options).


##### `normalize_max_runtime_seconds`  (lines 144–154)

```
fn normalize_max_runtime_seconds(requested: Option<u64>) -> Result<Option<u64>, FunctionCallError>
```

**Purpose**: Validates the optional per-item runtime limit supplied by the caller. Zero is rejected because a timeout must be at least one second.

**Data flow**: Takes `requested: Option<u64>` → returns `Ok(None)` if absent → if present and zero, returns `Err(FunctionCallError::RespondToModel("max_runtime_seconds must be >= 1"))` → otherwise returns `Ok(Some(requested))`.

**Call relations**: Higher-level agent-job handlers use this when parsing tool arguments. It is a pure validation helper.

*Call graph*: 1 external calls (RespondToModel).


##### `run_agent_job_loop`  (lines 156–328)

```
async fn run_agent_job_loop(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    db: Arc<codex_state::StateRuntime>,
    job_id: String,
    options: JobRunnerOptions,
) -> anyhow::Result<()>
```

**Purpose**: Runs the full lifecycle of an agent job: recovering persisted running items, spawning workers for pending rows, monitoring active threads, timing out stale work, finalizing completed items, exporting the final CSV snapshot, and marking the job complete unless cancelled. It is the main scheduler loop for the subsystem.

**Data flow**: Takes owned `session`, `turn`, `db`, `job_id`, and `options` → loads the job from DB, computes `runtime_timeout = job_runtime_timeout(&job)`, initializes `active_items`, and calls `recover_running_items(...)`. It then loops: refreshes cancellation state from DB; if not cancelled and capacity remains, fetches pending items up to available slots, builds each worker prompt with `build_worker_prompt`, wraps it as `UserInput::Text`, and calls `session.services.agent_control.spawn_agent_with_metadata(...)` using `options.spawn_config`, parent thread id, and environment selections. Spawn limit errors requeue the item as pending and stop filling slots; other spawn errors mark the item failed. Successfully spawned items are marked running with thread id in DB; if assignment loses a race, the live agent is shut down. Active items store `item_id`, `Instant::now()`, and an optional status subscription receiver. Each loop iteration also calls `reap_stale_active_items(...)`, `find_finished_threads(...)`, and for each finished thread `finalize_finished_item(...)` then removes it from `active_items`. If nothing finished, it checks DB progress to decide whether to break or await `wait_for_status_change(...)`. After the loop, it attempts `export_job_csv_snapshot(...)`; export failure marks the whole job failed. If the job is not cancelled, it marks the job completed in DB.

**Call relations**: This function is invoked by the higher-level spawn-agent job handler after job creation. It delegates prompt generation, stale-item cleanup, finished-thread detection, item finalization, waiting, timeout calculation, and CSV export to dedicated helpers, while directly orchestrating DB state transitions and agent-control service calls.

*Call graph*: calls 8 internal fn (build_worker_prompt, export_job_csv_snapshot, finalize_finished_item, find_finished_threads, job_runtime_timeout, reap_stale_active_items, recover_running_items, wait_for_status_change); 7 external calls (default, new, now, SubAgent, format!, Other, vec!).


##### `export_job_csv_snapshot`  (lines 330–345)

```
async fn export_job_csv_snapshot(
    db: Arc<codex_state::StateRuntime>,
    job: &codex_state::AgentJob,
) -> anyhow::Result<()>
```

**Purpose**: Writes the current job state to the configured output CSV path. It is used both as the final export step and as a failure point that can mark the job failed if snapshot generation breaks.

**Data flow**: Takes `db` and `job` → loads all job items with `list_agent_job_items(job.id, None, None)` → renders CSV text with `render_job_csv(job.input_headers.as_slice(), items.as_slice())`, wrapping render errors in `anyhow!` → builds `PathBuf` from `job.output_csv_path`, creates parent directories if needed with `tokio::fs::create_dir_all`, writes the CSV with `tokio::fs::write`, and returns `anyhow::Result<()>`.

**Call relations**: Called at the end of `run_agent_job_loop`. It delegates CSV string generation to `render_job_csv` and filesystem operations to Tokio FS helpers.

*Call graph*: calls 1 internal fn (render_job_csv); called by 1 (run_agent_job_loop); 3 external calls (from, create_dir_all, write).


##### `recover_running_items`  (lines 347–425)

```
async fn recover_running_items(
    session: Arc<Session>,
    db: Arc<codex_state::StateRuntime>,
    job_id: &str,
    active_items: &mut HashMap<ThreadId, ActiveJobItem>,
    runtime_timeout: Durat
```

**Purpose**: Reconstructs in-memory tracking for job items already marked running in the DB, while cleaning up stale or malformed entries and immediately finalizing workers that have already reached a final status. This lets job execution resume after restarts or interruptions.

**Data flow**: Takes `session`, `db`, `job_id`, mutable `active_items`, and `runtime_timeout` → queries running items from DB → for each item: if `is_item_stale(item, runtime_timeout)`, marks it failed with a timeout message and shuts down its assigned thread if parseable; if `assigned_thread_id` is missing, marks failed; if thread id parsing via `ThreadId::from_string` fails, marks failed; otherwise checks current agent status with `session.services.agent_control.get_status(thread_id).await`. If status is final, calls `finalize_finished_item(...)`; else inserts `ActiveJobItem { item_id, started_at: started_at_from_item(&item), status_rx: subscribe_status(thread_id).await.ok() }` into `active_items`.

**Call relations**: This helper is called once near the start of `run_agent_job_loop`. It delegates stale detection to `is_item_stale`, start-time reconstruction to `started_at_from_item`, and completion handling to `finalize_finished_item`.

*Call graph*: calls 5 internal fn (is_final, finalize_finished_item, is_item_stale, started_at_from_item, from_string); called by 1 (run_agent_job_loop); 1 external calls (format!).


##### `find_finished_threads`  (lines 427–439)

```
async fn find_finished_threads(
    session: Arc<Session>,
    active_items: &HashMap<ThreadId, ActiveJobItem>,
) -> Vec<(ThreadId, String)>
```

**Purpose**: Scans the currently active worker threads and returns those whose agent status is final. It converts the active-item map into a list of thread/item pairs ready for finalization.

**Data flow**: Takes `session` and `active_items: &HashMap<ThreadId, ActiveJobItem>` → iterates each `(thread_id, item)` → awaits `active_item_status(session.as_ref(), *thread_id, item)` → if `is_final(&status)`, pushes `(*thread_id, item.item_id.clone())` into a result vector → returns that vector.

**Call relations**: Called on each scheduler iteration by `run_agent_job_loop`. It delegates status retrieval to `active_item_status` and finality checks to `is_final`.

*Call graph*: calls 2 internal fn (is_final, active_item_status); called by 1 (run_agent_job_loop); 1 external calls (new).


##### `active_item_status`  (lines 441–452)

```
async fn active_item_status(
    session: &Session,
    thread_id: ThreadId,
    item: &ActiveJobItem,
) -> AgentStatus
```

**Purpose**: Retrieves the latest known status for an active worker, preferring a changed watch receiver value when available and falling back to a direct status query. This reduces polling overhead while still handling stale subscriptions.

**Data flow**: Takes `session: &Session`, `thread_id`, and `item: &ActiveJobItem` → if `item.status_rx` exists and `has_changed().is_ok()`, returns `status_rx.borrow().clone()` → otherwise awaits `session.services.agent_control.get_status(thread_id)` and returns that `AgentStatus`.

**Call relations**: Used by `find_finished_threads` during each loop iteration. It encapsulates the choice between watch-based updates and direct polling.

*Call graph*: called by 1 (find_finished_threads).


##### `wait_for_status_change`  (lines 454–469)

```
async fn wait_for_status_change(active_items: &HashMap<ThreadId, ActiveJobItem>)
```

**Purpose**: Sleeps until either one active worker status receiver changes or a short poll interval elapses. It prevents the scheduler loop from busy-spinning when no immediate progress is available.

**Data flow**: Takes `active_items` → builds a `FuturesUnordered` of `status_rx.changed().await` futures for all items that have a receiver → if no waiters exist, sleeps for `STATUS_POLL_INTERVAL` and returns → otherwise awaits `timeout(STATUS_POLL_INTERVAL, waiters.next())` and ignores the result.

**Call relations**: Called by `run_agent_job_loop` only when no threads finished and no other progress occurred. It delegates timing to Tokio `sleep`/`timeout` and uses watch receivers cloned from `ActiveJobItem`.

*Call graph*: called by 1 (run_agent_job_loop); 3 external calls (new, sleep, timeout).


##### `reap_stale_active_items`  (lines 471–499)

```
async fn reap_stale_active_items(
    session: Arc<Session>,
    db: Arc<codex_state::StateRuntime>,
    job_id: &str,
    active_items: &mut HashMap<ThreadId, ActiveJobItem>,
    runtime_timeout: Dur
```

**Purpose**: Detects active workers whose in-memory runtime has exceeded the allowed timeout, marks their job items failed, shuts down the live agents, and removes them from the active set. It handles timeout enforcement during normal loop execution.

**Data flow**: Takes `session`, `db`, `job_id`, mutable `active_items`, and `runtime_timeout` → scans `active_items` for entries where `item.started_at.elapsed() >= runtime_timeout`, collecting stale `(thread_id, item_id)` pairs → if none, returns `Ok(false)` → otherwise for each stale item marks the DB row failed with a timeout message, calls `shutdown_live_agent(thread_id)`, removes it from `active_items`, and finally returns `Ok(true)`.

**Call relations**: Called on each iteration by `run_agent_job_loop` after potential spawning. It complements `recover_running_items`, which handles stale persisted items at startup.

*Call graph*: called by 1 (run_agent_job_loop); 2 external calls (new, format!).


##### `finalize_finished_item`  (lines 501–533)

```
async fn finalize_finished_item(
    session: Arc<Session>,
    db: Arc<codex_state::StateRuntime>,
    job_id: &str,
    item_id: &str,
    thread_id: ThreadId,
) -> anyhow::Result<()>
```

**Purpose**: Transitions a finished worker's DB item out of running state based on whether it reported a result, then shuts down the live agent thread. It enforces the invariant that workers must call `report_agent_job_result` before finishing.

**Data flow**: Takes `session`, `db`, `job_id`, `item_id`, and `thread_id` → loads the item from DB and errors if missing → if `item.status` is still `Running`, checks `item.result_json`: if present, marks the item completed; otherwise marks it failed with `worker finished without calling report_agent_job_result` → regardless, calls `shutdown_live_agent(thread_id)` and returns `Ok(())`.

**Call relations**: Called by both `recover_running_items` and `run_agent_job_loop` when a worker is already or newly final. It encapsulates the DB completion/failure rule for finished workers.

*Call graph*: called by 2 (recover_running_items, run_agent_job_loop); 1 external calls (matches!).


##### `build_worker_prompt`  (lines 535–566)

```
fn build_worker_prompt(
    job: &codex_state::AgentJob,
    item: &codex_state::AgentJobItem,
) -> anyhow::Result<String>
```

**Purpose**: Constructs the exact prompt sent to each spawned worker agent for one CSV row. It embeds job/item identifiers, the rendered instruction, the row JSON, the expected output schema, and explicit instructions to call `report_agent_job_result` exactly once.

**Data flow**: Takes `job` and `item` → extracts `job_id` and `item_id` → computes `instruction = render_instruction_template(job.instruction.as_str(), &item.row_json)` → pretty-serializes `job.output_schema_json` or uses `{}` → pretty-serializes `item.row_json` → interpolates all of that into a fixed multi-line prompt string and returns it.

**Call relations**: Called by `run_agent_job_loop` before spawning each worker. It delegates placeholder substitution to `render_instruction_template` and JSON formatting to `serde_json::to_string_pretty`.

*Call graph*: calls 1 internal fn (render_instruction_template); called by 1 (run_agent_job_loop); 2 external calls (format!, to_string_pretty).


##### `render_instruction_template`  (lines 568–591)

```
fn render_instruction_template(instruction: &str, row_json: &Value) -> String
```

**Purpose**: Performs simple placeholder substitution in a job instruction using fields from a row JSON object, while preserving escaped literal braces written as `{{` and `}}`. It lets CSV columns parameterize worker instructions.

**Data flow**: Takes `instruction: &str` and `row_json: &Value` → first replaces `{{`/`}}` with sentinel strings → if `row_json.as_object()` is `None`, restores sentinels back to braces and returns → otherwise for each `(key, value)` in the object, builds placeholder `{key}`, converts the value to either its string contents or JSON string form, and replaces all occurrences in the rendered instruction → finally restores sentinels to literal braces and returns the result.

**Call relations**: Called by `build_worker_prompt`. It is a pure string-templating helper with no external side effects.

*Call graph*: called by 1 (build_worker_prompt); 2 external calls (as_object, format!).


##### `ensure_unique_headers`  (lines 593–603)

```
fn ensure_unique_headers(headers: &[String]) -> Result<(), FunctionCallError>
```

**Purpose**: Rejects CSV inputs with duplicate header names. This prevents ambiguous row-object construction and later output rendering errors.

**Data flow**: Takes `headers: &[String]` → inserts each header into a `HashSet` → if insertion fails for any header, returns `Err(FunctionCallError::RespondToModel(format!("csv header {header} is duplicated")))` → otherwise returns `Ok(())`.

**Call relations**: Higher-level CSV ingestion code calls this after parsing headers. It is a pure validation helper.

*Call graph*: 3 external calls (new, format!, RespondToModel).


##### `job_runtime_timeout`  (lines 605–609)

```
fn job_runtime_timeout(job: &codex_state::AgentJob) -> Duration
```

**Purpose**: Computes the effective per-item runtime timeout for a job. Jobs without an explicit limit use the subsystem default.

**Data flow**: Takes `job: &codex_state::AgentJob` → reads `job.max_runtime_seconds` → returns `Duration::from_secs(value)` when present or `DEFAULT_AGENT_JOB_ITEM_TIMEOUT` otherwise.

**Call relations**: Called by `run_agent_job_loop` to set the timeout used by recovery and stale-item reaping.

*Call graph*: called by 1 (run_agent_job_loop).


##### `started_at_from_item`  (lines 611–619)

```
fn started_at_from_item(item: &codex_state::AgentJobItem) -> Instant
```

**Purpose**: Reconstructs an approximate `Instant` start time for a persisted running item based on its `updated_at` timestamp. This allows timeout checks to continue after process restarts.

**Data flow**: Takes `item: &codex_state::AgentJobItem` → computes `age = chrono::Utc::now().signed_duration_since(item.updated_at)` → if `age.to_std()` succeeds, returns `Instant::now().checked_sub(age).unwrap_or_else(Instant::now)`; otherwise returns `Instant::now()`.

**Call relations**: Used by `recover_running_items` when rebuilding `ActiveJobItem.started_at`. It bridges persisted wall-clock timestamps into Tokio `Instant` space.

*Call graph*: called by 1 (recover_running_items); 2 external calls (now, now).


##### `is_item_stale`  (lines 621–628)

```
fn is_item_stale(item: &codex_state::AgentJobItem, runtime_timeout: Duration) -> bool
```

**Purpose**: Determines whether a persisted running item has exceeded the allowed runtime based on its last update timestamp. It is the startup-time stale check for recovered items.

**Data flow**: Takes `item` and `runtime_timeout` → computes age from `chrono::Utc::now().signed_duration_since(item.updated_at)` → if conversion to `std::time::Duration` succeeds, returns `age >= runtime_timeout`; otherwise returns `false`.

**Call relations**: Called by `recover_running_items` before deciding whether to resume tracking a running item.

*Call graph*: called by 1 (recover_running_items); 1 external calls (now).


##### `default_output_csv_path`  (lines 630–641)

```
fn default_output_csv_path(input_csv_path: &AbsolutePathBuf, job_id: &str) -> AbsolutePathBuf
```

**Purpose**: Derives a default output CSV path from the input CSV path and job id. It places the output next to the input file and appends a short job-id suffix.

**Data flow**: Takes `input_csv_path: &AbsolutePathBuf` and `job_id: &str` → extracts the file stem or falls back to `agent_job_output`, takes the first 8 chars of `job_id`, chooses the parent directory or the input path itself, and returns `output_dir.join(format!("{stem}.agent-job-{job_suffix}.csv"))`.

**Call relations**: Higher-level spawn-job setup code uses this when the caller does not provide an explicit output path. It is a pure path-construction helper.

*Call graph*: calls 2 internal fn (as_path, parent); 1 external calls (format!).


##### `parse_csv`  (lines 643–663)

```
fn parse_csv(content: &str) -> Result<(Vec<String>, Vec<Vec<String>>), String>
```

**Purpose**: Parses CSV text into headers and rows with flexible record lengths, strips a UTF-8 BOM from the first header, and skips fully empty rows. It is the ingestion helper for CSV-backed jobs.

**Data flow**: Takes `content: &str` → builds a `csv::ReaderBuilder` with `has_headers(true)` and `flexible(true)` over `content.as_bytes()` → reads headers into `Vec<String>`, trimming a BOM from the first header if present → iterates records, converting each to `Vec<String>`, skipping rows where every field is empty, and collecting the rest → returns `Ok((headers, rows))` or `Err(err.to_string())` on CSV parse failure.

**Call relations**: Called by higher-level CSV job creation code before header validation and row-to-JSON conversion. It is a pure parser helper.

*Call graph*: 2 external calls (new, new).


##### `render_job_csv`  (lines 665–739)

```
fn render_job_csv(
    headers: &[String],
    items: &[codex_state::AgentJobItem],
) -> Result<String, FunctionCallError>
```

**Purpose**: Renders the current job items back into a CSV snapshot containing original input columns plus job metadata, status, errors, result JSON, and timestamps. It is the export formatter used for final job snapshots.

**Data flow**: Takes original `headers` and `items` → clones headers into `output_headers` and appends metadata columns (`job_id`, `item_id`, `row_index`, `source_id`, `status`, `attempt_count`, `last_error`, `result_json`, `reported_at`, `completed_at`) → writes the escaped header row → for each item, requires `item.row_json` to be an object or returns `RespondToModel` error, then for each original header pulls the corresponding value from the row object and converts it with `value_to_csv_string`, escapes all fields with `csv_escape`, appends metadata fields similarly, joins with commas, and appends a newline → returns the full CSV string.

**Call relations**: Called by `export_job_csv_snapshot`. It delegates scalar conversion to `value_to_csv_string` and CSV quoting to `csv_escape`.

*Call graph*: calls 1 internal fn (csv_escape); called by 1 (export_job_csv_snapshot); 2 external calls (new, new).


##### `value_to_csv_string`  (lines 741–749)

```
fn value_to_csv_string(value: &Value) -> String
```

**Purpose**: Converts a JSON value into the scalar string representation used in exported CSV cells. Complex arrays/objects are serialized as compact JSON.

**Data flow**: Takes `value: &Value` → matches `Null` to `""`, `String` to clone, `Bool`/`Number` to `to_string()`, and `Array`/`Object` to `value.to_string()` → returns the resulting string.

**Call relations**: Used by `render_job_csv` when exporting original row values from `row_json`.

*Call graph*: 2 external calls (new, to_string).


##### `csv_escape`  (lines 751–758)

```
fn csv_escape(value: &str) -> String
```

**Purpose**: Escapes a string for CSV output by quoting fields that contain commas, newlines, carriage returns, or quotes, and doubling embedded quotes. It ensures exported snapshots remain valid CSV.

**Data flow**: Takes `value: &str` → if it contains `,`, `\n`, `\r`, or `"`, replaces `"` with `""`, wraps the result in surrounding quotes via `format!("\"{escaped}\"")`, and returns it; otherwise returns `value.to_string()` unchanged.

**Call relations**: Called repeatedly by `render_job_csv` for both headers and row fields. It is the low-level CSV quoting helper.

*Call graph*: called by 1 (render_job_csv); 1 external calls (format!).


### `core/src/tools/handlers/agent_jobs/report_agent_job_result.rs`

`domain_logic` · `worker tool call handling`

This file defines `ReportAgentJobResultHandler`, the tool executor for the worker-facing `report_agent_job_result` function. The handler is intentionally narrow: it only accepts `ToolPayload::Function`, advertises its schema via `create_report_agent_job_result_tool`, and delegates the actual business logic to the free async `handle` function.

`handle_call` extracts the session and payload from `ToolInvocation`, rejects unsupported payload kinds with a model-facing error, and then forwards the raw argument string to `handle`, boxing the resulting `FunctionToolOutput`. The `CoreToolRuntime` implementation further narrows applicability by returning `true` from `matches_kind` only for function payloads.

The free `handle` function performs the real work. It parses JSON arguments into `ReportAgentJobResultArgs`, requires `result` to be a JSON object, and obtains the persistent state runtime through `required_state_db`. It uses the current session's `thread_id` as the reporting worker identity and calls `db.report_agent_job_item_result(job_id, item_id, reporting_thread_id, &result)`. Database errors are rewritten into `FunctionCallError::RespondToModel` with both job and item ids included. If the DB accepted the result and the worker set `stop: true`, the function best-effort marks the whole job cancelled with the message `cancelled by worker request`. Finally it serializes `ReportAgentJobResultToolResult { accepted }` to JSON text and returns it as a successful `FunctionToolOutput`.

A key invariant here is that only object-shaped `result` payloads are accepted; scalar or array results are rejected before touching the DB.

#### Function details

##### `ReportAgentJobResultHandler::tool_name`  (lines 17–19)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the plain tool name handled by this executor. It binds the handler to `report_agent_job_result` in the tool registry.

**Data flow**: Takes `&self` → returns `ToolName::plain("report_agent_job_result")`.

**Call relations**: The tool registry calls this during registration and dispatch. It delegates name construction to `ToolName::plain`.

*Call graph*: calls 1 internal fn (plain).


##### `ReportAgentJobResultHandler::spec`  (lines 21–23)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the tool specification for `report_agent_job_result`. This exposes the worker-facing schema to the runtime/model.

**Data flow**: Takes `&self` → calls `create_report_agent_job_result_tool()` → returns the resulting `ToolSpec`.

**Call relations**: The registry invokes this when enumerating tool metadata. It delegates schema construction to the sibling spec module.

*Call graph*: calls 1 internal fn (create_report_agent_job_result_tool).


##### `ReportAgentJobResultHandler::handle`  (lines 25–27)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async handler implementation to the boxed future type required by the tool executor trait. It is the trait-facing execution entry point.

**Data flow**: Takes `&self` and `invocation: ToolInvocation` → creates `self.handle_call(invocation)` → boxes and pins the future → returns `ToolExecutorFuture<'_>`.

**Call relations**: Tool dispatch calls this when the worker invokes `report_agent_job_result`. It delegates all substantive logic to `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ReportAgentJobResultHandler::handle_call`  (lines 31–49)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Extracts the function arguments from the invocation, rejects unsupported payload kinds, and forwards the request to the shared `handle` function. It also boxes the resulting output for trait-object return.

**Data flow**: Consumes `ToolInvocation`, extracting `session` and `payload` → if payload is `ToolPayload::Function { arguments }`, calls `handle(session, arguments).await` and maps the `FunctionToolOutput` through `boxed_tool_output`; otherwise returns `Err(FunctionCallError::RespondToModel("report_agent_job_result handler received unsupported payload"))`.

**Call relations**: This function is invoked only by `ReportAgentJobResultHandler::handle`. It delegates business logic to the free `handle` function and output boxing to `boxed_tool_output`.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle); 1 external calls (RespondToModel).


##### `ReportAgentJobResultHandler::matches_kind`  (lines 53–55)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this runtime to function-style payloads. It prevents the handler from being considered for custom or search payload kinds.

**Data flow**: Takes `&self` and `payload: &ToolPayload` → returns `matches!(payload, ToolPayload::Function { .. })`.

**Call relations**: The core tool runtime uses this during dispatch filtering. It complements `handle_call`'s runtime check with an earlier applicability signal.

*Call graph*: 1 external calls (matches!).


##### `handle`  (lines 58–98)

```
async fn handle(
    session: Arc<Session>,
    arguments: String,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Parses and validates a worker's reported job result, records it in the state DB under the current worker thread id, optionally cancels the job, and returns a JSON acknowledgment indicating whether the report was accepted. It is the file's main business-logic function.

**Data flow**: Takes `session: Arc<Session>` and raw `arguments: String` → parses `ReportAgentJobResultArgs` with `parse_arguments(arguments.as_str())` → rejects non-object `args.result` with `RespondToModel` → obtains `db = required_state_db(&session)?` → computes `reporting_thread_id = session.thread_id.to_string()` → awaits `db.report_agent_job_item_result(args.job_id, args.item_id, reporting_thread_id, &args.result)`, mapping DB errors to `RespondToModel` with job/item context → if `accepted` and `args.stop.unwrap_or(false)`, best-effort awaits `db.mark_agent_job_cancelled(args.job_id, "cancelled by worker request")` and ignores failure → serializes `ReportAgentJobResultToolResult { accepted }` to JSON text, mapping serialization failure to `FunctionCallError::Fatal` → returns `FunctionToolOutput::from_text(content, Some(true))`.

**Call relations**: This function is called by `ReportAgentJobResultHandler::handle_call`. It depends on shared helpers from the parent module (`parse_arguments`, `required_state_db`) and returns a `FunctionToolOutput` that the handler boxes for the generic tool pipeline.

*Call graph*: calls 1 internal fn (from_text); called by 1 (handle_call); 2 external calls (to_string, RespondToModel).


### `core/src/tools/handlers/agent_jobs/spawn_agents_on_csv.rs`

`domain_logic` · `tool invocation; synchronous job creation and completion wait`

This file is the execution side of the CSV-backed agent-jobs feature. `SpawnAgentsOnCsvHandler` exposes the tool name/spec and accepts only function-style payloads; its async path unwraps the invocation and forwards the raw JSON argument string into the top-level `handle` function. The main `handle` routine performs the full workflow: parse `SpawnAgentsOnCsvArgs`, reject blank `instruction`, require exactly one non-remote turn environment, derive the local cwd, and fetch the session state database. It reads the input CSV from disk with Tokio, parses headers and rows, rejects missing headers, duplicate header names, and row/header length mismatches, then converts each row into a `codex_state::AgentJobItemCreateParams` containing a stable `item_id`, optional `source_id`, zero-based `row_index`, and a `row_json` object mapping header names to string values.

It generates a UUID job id, computes the output CSV path and job name, normalizes worker runtime limits, and persists the job plus all items with `auto_export` enabled. Before execution it derives runner options from session/turn state; if that setup fails it proactively marks the job failed. Otherwise it transitions the job to running, invokes the agent-job loop, and on runner failure records a job-level failure in the database. After execution it reloads the job, ensures an output CSV exists by exporting a snapshot if needed, loads progress counters, and assembles a compact result payload including status, output path, totals, optional job error, and up to five failed-item error summaries. A notable invariant is that duplicate or blank source ids never collide: the code synthesizes `row-N` ids and appends numeric suffixes until unique.

#### Function details

##### `SpawnAgentsOnCsvHandler::tool_name`  (lines 18–20)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registered tool identifier for this handler as the plain name `spawn_agents_on_csv`.

**Data flow**: It reads no invocation state and constructs a `ToolName` constant from the literal string. It returns that `ToolName` without side effects.

**Call relations**: The tool registry queries this when wiring executors so requests can be matched to this handler; it delegates only to the `ToolName::plain` constructor.

*Call graph*: calls 1 internal fn (plain).


##### `SpawnAgentsOnCsvHandler::spec`  (lines 22–24)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Supplies the function-call schema advertised to models for the CSV spawning tool.

**Data flow**: It takes no inputs beyond `self`, reads no mutable state, and returns the `ToolSpec` built by the shared spec factory.

**Call relations**: Called during tool registration/introspection; it forwards spec construction to `create_spawn_agents_on_csv_tool` so the runtime and schema stay aligned.

*Call graph*: calls 1 internal fn (create_spawn_agents_on_csv_tool).


##### `SpawnAgentsOnCsvHandler::handle`  (lines 26–28)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Bridges the synchronous executor trait to the async implementation by boxing the future returned from `handle_call`.

**Data flow**: It consumes a `ToolInvocation`, wraps the async call in a pinned boxed future, and returns that future to the tool framework. It does not inspect payload contents itself.

**Call relations**: The tool framework invokes this entry on each matching tool call; it immediately delegates all real work to `SpawnAgentsOnCsvHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `SpawnAgentsOnCsvHandler::handle_call`  (lines 32–55)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates that the invocation carries function arguments, extracts session/turn context, and dispatches to the CSV job runner.

**Data flow**: From `ToolInvocation` it reads `session`, `turn`, and `payload`. If the payload is `ToolPayload::Function`, it extracts the raw `arguments` string and passes it to `handle`; otherwise it returns a `FunctionCallError::RespondToModel`. On success it wraps the returned `FunctionToolOutput` into the boxed trait object expected by the executor interface.

**Call relations**: This is called only by `SpawnAgentsOnCsvHandler::handle`. It is the narrow adapter layer between generic tool invocation plumbing and the file's top-level `handle` business logic.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle); 1 external calls (RespondToModel).


##### `SpawnAgentsOnCsvHandler::matches_kind`  (lines 59–61)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this runtime only accepts function-style tool payloads.

**Data flow**: It inspects the provided `ToolPayload` by pattern match and returns a boolean. It does not mutate any state.

**Call relations**: The core runtime uses this predicate before dispatching invocations; it prevents custom/freeform payloads from reaching `handle_call`.

*Call graph*: 1 external calls (matches!).


##### `handle`  (lines 69–300)

```
async fn handle(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    arguments: String,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Creates, executes, and summarizes an agent job whose items come from CSV rows and whose worker prompts are templated from row data.

**Data flow**: Inputs are `Arc<Session>`, `Arc<TurnContext>`, and the raw JSON argument string. It parses arguments, reads turn environment state and the session DB, reads the CSV file from disk, transforms headers/rows into persisted job metadata and `AgentJobItemCreateParams`, writes the new job and items to the DB, computes runner options, updates job status to running/failed as needed, runs the job loop, optionally exports a CSV snapshot, reloads job/progress/item failure data from the DB, serializes a `SpawnAgentsOnCsvResult` JSON string, and returns it as `FunctionToolOutput`. It writes durable state through `create_agent_job`, `mark_agent_job_running`, `mark_agent_job_failed`, and possibly CSV export side effects on disk.

**Call relations**: Invoked by `SpawnAgentsOnCsvHandler::handle_call` after payload extraction. Internally it relies on helper/parsing utilities from the surrounding module for argument parsing, CSV parsing, header validation, runtime normalization, runner option construction, job execution, and export; its control flow explicitly marks the job failed when runner setup or execution breaks so later inspection sees terminal state.

*Call graph*: calls 2 internal fn (from_text, single_local_environment_cwd); called by 1 (handle_call); 10 external calls (new, from, new_v4, Object, with_capacity, format!, to_string, read_to_string, try_exists, RespondToModel).


##### `single_local_environment_cwd`  (lines 302–323)

```
fn single_local_environment_cwd(turn: &TurnContext) -> Result<AbsolutePathBuf, FunctionCallError>
```

**Purpose**: Extracts the sole local environment working directory for this tool and rejects unsupported environment layouts.

**Data flow**: It reads `turn.environments.turn_environments`, requires the slice to contain exactly one entry, checks that the environment is not remote, converts that environment's cwd into an `AbsolutePathBuf`, and returns it. Any mismatch or host-incompatible path becomes a `RespondToModel` error with a user-facing explanation.

**Call relations**: Called early by `handle` before any filesystem access. It enforces the file's design constraint that CSV input/output currently operate only against one host-native local environment.

*Call graph*: called by 1 (handle); 1 external calls (RespondToModel).


### Memory extraction pipeline
These files implement the asynchronous startup pipeline that prepares runtime context, runs rollout-level memory extraction, and performs global consolidation in a background workflow.

### `memories/write/src/runtime.rs`

`orchestration` · `startup and request execution`

This file defines two key runtime types. `StageOneRequestContext` is a lightweight, cloneable bundle of `ModelInfo`, `SessionTelemetry`, reasoning settings, and optional service tier used for phase-1 extraction requests. `MemoryStartupContext` is the heavier startup-scoped handle that owns the current thread ID, thread, thread manager, auth manager, shared model provider, and base telemetry.

Construction starts with `MemoryStartupContext::new`, which creates a provider from config and auth, then delegates to `new_with_provider`. That helper snapshots cached auth details, derives telemetry metadata such as auth mode, account identity, originator, user agent, and auth-environment telemetry, and builds a `SessionTelemetry` tagged to the startup thread and session source.

For phase 1, `stage_one_request_context` resolves live model info through the models manager and captures the current thread config snapshot so service-tier overrides from the running thread are honored. `stream_stage_one_prompt` then performs a detached model request: it resolves installation metadata, creates a `ModelClient`, builds detached memory response metadata, streams response events, concatenates text deltas or fallback message text, and returns the final string plus optional `TokenUsage`.

For phase 2, `spawn_consolidation_agent` starts a new internal thread with `SessionSource::Internal(MemoryConsolidation)` and `ThreadSource::MemoryConsolidation`, submits the prompt as user input, and cleans up on submit failure. `shutdown_consolidation_agent` removes the thread from the manager if possible and waits up to 10 seconds for shutdown.

#### Function details

##### `StageOneRequestContext::start_timer`  (lines 56–58)

```
fn start_timer(&self, name: &str) -> Option<codex_otel::Timer>
```

**Purpose**: Starts a telemetry timer scoped to the stage-one request context. It hides the underlying telemetry error handling by returning `None` on failure.

**Data flow**: Takes a metric name string, forwards it to `session_telemetry.start_timer(name, &[])`, converts the result to `Option<codex_otel::Timer>` with `.ok()`, and returns it. It does not mutate other state.

**Call relations**: Used by phase-1 `run` to measure end-to-end extraction time with the stage-one-specific telemetry context.

*Call graph*: calls 1 internal fn (start_timer).


##### `StageOneRequestContext::counter`  (lines 60–62)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a counter metric on the stage-one telemetry context. It is a thin convenience wrapper around `SessionTelemetry`.

**Data flow**: Accepts a metric name, increment value, and tag slice, then forwards them directly to `session_telemetry.counter`. It returns no value.

**Call relations**: Called by phase-1 `emit_metrics` so all phase-1 counters are attributed to the stage-one request context rather than the broader startup context.

*Call graph*: calls 1 internal fn (counter); called by 1 (emit_metrics).


##### `StageOneRequestContext::histogram`  (lines 64–66)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a histogram metric on the stage-one telemetry context. It mirrors the counter wrapper for histogram values.

**Data flow**: Accepts a metric name, numeric value, and tag slice, then forwards them to `session_telemetry.histogram`. It returns nothing.

**Call relations**: Used by phase-1 `emit_metrics` for token-usage histograms.

*Call graph*: calls 1 internal fn (histogram); called by 1 (emit_metrics).


##### `MemoryStartupContext::new`  (lines 79–100)

```
fn new(
        thread_manager: Arc<ThreadManager>,
        auth_manager: Arc<AuthManager>,
        thread_id: ThreadId,
        thread: Arc<CodexThread>,
        config: &Config,
        source: Sess
```

**Purpose**: Constructs a startup context using a provider created from the configured model-provider settings and auth manager. It is the normal production constructor.

**Data flow**: Inputs are the thread manager, auth manager, startup thread ID, startup thread handle, config, and session source. It creates a shared model provider with `create_model_provider(config.model_provider.clone(), Some(auth_manager.clone()))`, then delegates all remaining initialization to `new_with_provider` and returns the resulting `MemoryStartupContext`.

**Call relations**: Called by `start_memories_startup_task` in production and by a startup test that verifies live service-tier behavior.

*Call graph*: called by 2 (start_memories_startup_task, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata); 3 external calls (clone, new_with_provider, create_model_provider).


##### `MemoryStartupContext::new_for_testing`  (lines 103–121)

```
fn new_for_testing(
        thread_manager: Arc<ThreadManager>,
        auth_manager: Arc<AuthManager>,
        thread_id: ThreadId,
        thread: Arc<CodexThread>,
        config: &Config,
```

**Purpose**: Constructs a startup context with an explicitly supplied provider, allowing tests to override provider defaults. It otherwise shares the same initialization path as production.

**Data flow**: Receives the same inputs as `new` plus a `SharedModelProvider`. It forwards everything to `new_with_provider` and returns the context.

**Call relations**: Used by test helpers to inject `MockMemoryModelProvider` when verifying provider-selected phase-1 and phase-2 models.

*Call graph*: called by 1 (memory_startup_context_with_provider); 1 external calls (new_with_provider).


##### `MemoryStartupContext::new_with_provider`  (lines 123–164)

```
fn new_with_provider(
        thread_manager: Arc<ThreadManager>,
        auth_manager: Arc<AuthManager>,
        thread_id: ThreadId,
        thread: Arc<CodexThread>,
        config: &Config,
```

**Purpose**: Performs the actual initialization of `MemoryStartupContext`, including telemetry enrichment from auth and environment metadata. It centralizes all constructor logic shared by production and tests.

**Data flow**: Consumes thread manager, auth manager, thread ID, thread, config, session source, and provider. It reads cached auth from the auth manager, derives auth mode/account ID/account email, chooses a model label from `config.model` or `unknown`, collects auth-environment telemetry, constructs `SessionTelemetry::new(...)` with originator and user agent, attaches auth-env metadata, and stores all fields in a new `MemoryStartupContext`.

**Call relations**: Internal constructor used by both `new` and `new_for_testing`. The resulting context is then passed throughout phase 1 and phase 2.

*Call graph*: calls 3 internal fn (originator, collect_auth_env_telemetry, new); 1 external calls (user_agent).


##### `MemoryStartupContext::thread_id`  (lines 166–168)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the startup thread ID associated with this memory pipeline context. It is a simple accessor used for DB leasing and telemetry correlation.

**Data flow**: Reads the stored `thread_id` field and returns it by value. No state changes occur.

**Call relations**: Called by phase-1 and phase-2 claim helpers when acquiring DB leases tied to the current startup thread.

*Call graph*: called by 2 (claim_startup_jobs, claim).


##### `MemoryStartupContext::state_db`  (lines 170–172)

```
fn state_db(&self) -> Option<Arc<StateRuntime>>
```

**Purpose**: Exposes the optional state database attached to the underlying startup thread. The memories pipeline uses this to decide whether startup work can proceed.

**Data flow**: Calls `self.thread.state_db()` and returns `Option<Arc<StateRuntime>>`. It does not cache or mutate the result.

**Call relations**: Used across phase 1 and phase 2 for job claiming, success/failure marking, and pruning; many callers treat `None` as a skip or hard failure.

*Call graph*: called by 5 (claim_startup_jobs, failed, no_output, success, prune).


##### `MemoryStartupContext::provider`  (lines 174–176)

```
fn provider(&self) -> &dyn ModelProvider
```

**Purpose**: Returns the model-provider trait object associated with the startup context. This lets memory phases query provider-specific preferred models.

**Data flow**: Borrows the stored shared provider and returns `&dyn ModelProvider` via `as_ref()`. No state is modified.

**Call relations**: Used by phase-1 `build_request_context` and phase-2 `agent::get_config` to choose default extraction and consolidation models.

*Call graph*: 1 external calls (as_ref).


##### `MemoryStartupContext::counter`  (lines 178–180)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a counter metric on the startup-scoped telemetry context. It is the phase-2 and startup-level counterpart to the stage-one telemetry wrapper.

**Data flow**: Accepts a metric name, increment, and tags, then forwards them to `session_telemetry.counter`. It returns no value.

**Call relations**: Called by phase-2 metric emitters and job-state helpers, and by the startup task when rate limits cause a skip.

*Call graph*: calls 1 internal fn (counter); called by 4 (emit_metrics, claim, failed, succeed).


##### `MemoryStartupContext::histogram`  (lines 182–184)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a histogram metric on the startup-scoped telemetry context. It is used for phase-2 token-usage reporting.

**Data flow**: Accepts a metric name, value, and tags, then forwards them to `session_telemetry.histogram`. It returns nothing.

**Call relations**: Used by `emit_token_usage_metrics` in phase 2.

*Call graph*: calls 1 internal fn (histogram); called by 1 (emit_token_usage_metrics).


##### `MemoryStartupContext::start_timer`  (lines 186–188)

```
fn start_timer(&self, name: &str) -> Option<codex_otel::Timer>
```

**Purpose**: Starts a startup-scoped telemetry timer and suppresses telemetry errors by returning `None`. It mirrors the stage-one timer helper.

**Data flow**: Forwards the metric name to `session_telemetry.start_timer(name, &[])`, converts the result to `Option<Timer>` with `.ok()`, and returns it.

**Call relations**: Used by phase-2 `run` to measure end-to-end consolidation setup and completion.

*Call graph*: calls 1 internal fn (start_timer).


##### `MemoryStartupContext::stage_one_request_context`  (lines 190–216)

```
async fn stage_one_request_context(
        &self,
        config: &Config,
        model_name: &str,
        reasoning_effort: ReasoningEffort,
    ) -> StageOneRequestContext
```

**Purpose**: Builds the per-request context for phase-1 extraction, including live model info, reasoning settings, telemetry rebinding to the chosen model, and the current thread service tier. It intentionally reads the thread’s latest config snapshot rather than trusting the startup config alone.

**Data flow**: Inputs are the config, chosen model name, and reasoning effort. It awaits `thread.config_snapshot()`, fetches `ModelInfo` from the thread manager’s models manager using `config.to_models_manager_config()`, derives `reasoning_summary` from config or the model default, clones and retags session telemetry with the chosen model, and returns a `StageOneRequestContext` containing model info, telemetry, reasoning effort, reasoning summary, and `service_tier` from the live config snapshot.

**Call relations**: Called by phase-1 `build_request_context`. A startup test verifies that this path picks up live thread service-tier overrides.

*Call graph*: called by 1 (build_request_context); 2 external calls (to_models_manager_config, clone).


##### `MemoryStartupContext::stream_stage_one_prompt`  (lines 218–290)

```
async fn stream_stage_one_prompt(
        &self,
        config: &Config,
        prompt: &Prompt,
        context: &StageOneRequestContext,
    ) -> anyhow::Result<(String, Option<TokenUsage>)>
```

**Purpose**: Executes a detached phase-1 model request and collects the final textual output plus token usage from the response stream. It is specialized for memory extraction requests rather than normal interactive turns.

**Data flow**: Takes config, a `Prompt`, and a `StageOneRequestContext`. It resolves the installation ID, reads the live thread config snapshot for session source, derives a `SessionId` from the thread ID, constructs a `ModelClient` with auth and feature flags, creates detached memory response metadata via `detached_memory_responses_metadata`, and starts a streaming request with model info, telemetry, reasoning settings, service tier, and disabled inference tracing. It iterates stream events, appending `OutputTextDelta` text, falling back to `OutputItemDone` message text if no deltas were seen, captures `Completed.token_usage`, and returns `(result_string, Option<TokenUsage>)`.

**Call relations**: Called by `job::sample` in phase 1. A startup test inspects the outgoing request metadata produced by this detached-request path.

*Call graph*: calls 3 internal fn (new, from, disabled); called by 1 (sample); 7 external calls (clone, new, content_items_to_text, detached_memory_responses_metadata, resolve_installation_id, format!, to_string).


##### `MemoryStartupContext::spawn_consolidation_agent`  (lines 292–340)

```
async fn spawn_consolidation_agent(
        &self,
        config: Config,
        prompt: Vec<UserInput>,
    ) -> anyhow::Result<SpawnedConsolidationAgent>
```

**Purpose**: Starts a new internal Codex thread configured for memory consolidation and submits the consolidation prompt as user input. It cleans up the thread if prompt submission fails.

**Data flow**: Consumes an owned `Config` and prompt `Vec<UserInput>`. It computes default environment selections for the config cwd, starts a new thread with `InitialHistory::New`, internal memory-consolidation session/thread sources, no dynamic tools, and default extension init, then wraps the returned thread ID and thread in `SpawnedConsolidationAgent`. It submits `Op::UserInput` containing the prompt; on submit error it attempts `shutdown_consolidation_agent` and returns the error, otherwise it returns the spawned agent.

**Call relations**: Called by phase-2 `run` after prompt generation. Its returned `SpawnedConsolidationAgent` is then handed to `agent::handle` for asynchronous monitoring.

*Call graph*: calls 1 internal fn (shutdown_consolidation_agent); 4 external calls (default, new, Internal, warn!).


##### `MemoryStartupContext::shutdown_consolidation_agent`  (lines 342–360)

```
async fn shutdown_consolidation_agent(
        &self,
        agent: SpawnedConsolidationAgent,
    ) -> anyhow::Result<()>
```

**Purpose**: Removes a spawned consolidation thread from the thread manager if present and waits for it to shut down, with a hard timeout. It is the cleanup path for both normal completion and submit failures.

**Data flow**: Takes ownership of `SpawnedConsolidationAgent`, extracts `thread_id` and `thread`, asks the thread manager to remove the thread and falls back to the passed thread if removal returns `None`, then awaits `thread.shutdown_and_wait()` under a 10-second timeout. It returns `Ok(())` on clean shutdown or an `anyhow` error on timeout or shutdown failure.

**Call relations**: Called by `spawn_consolidation_agent` when prompt submission fails, and by phase-2 `agent::handle` in a background cleanup task after the agent reaches a terminal state.

*Call graph*: called by 1 (spawn_consolidation_agent); 2 external calls (from_secs, timeout).


### `memories/write/src/start.rs`

`entrypoint` · `startup`

This file contains the single entrypoint that wires the memories startup subsystem into a live Codex session. `start_memories_startup_task` first applies coarse eligibility checks: it returns immediately for ephemeral sessions, when the `MemoryTool` feature is disabled, or when the session source indicates a non-root agent. For eligible sessions it constructs a `MemoryStartupContext` from the thread manager, auth manager, current thread, config, and session source.

Before spawning background work, it verifies that the underlying thread exposes a state DB; if not, it logs a warning and skips the pipeline entirely. The actual startup work runs in a detached Tokio task. That task ensures the memories root directory exists under `codex_home`, seeds extension instruction files, and then performs a DB-only prune of stale phase-1 outputs. Because pruning does not consume model quota, it happens before the rate-limit guard.

If `guard::rate_limits_ok` fails, the task emits a `MEMORY_STARTUP` counter tagged `skipped_rate_limit` and exits. Otherwise it runs the two phases in strict order: phase 1 extraction first, then phase 2 consolidation. The function itself does not await completion; it only schedules the background pipeline.

#### Function details

##### `start_memories_startup_task`  (lines 22–79)

```
fn start_memories_startup_task(
    thread_manager: Arc<ThreadManager>,
    auth_manager: Arc<AuthManager>,
    thread_id: ThreadId,
    thread: Arc<CodexThread>,
    config: Arc<Config>,
    source:
```

**Purpose**: Checks whether memories startup should run for the current session and, if so, launches the full asynchronous startup pipeline. It is the top-level integration point for memory generation and consolidation at session startup.

**Data flow**: Inputs are the thread manager, auth manager, current thread ID, current thread handle, shared config, and session source. It reads `config.ephemeral`, the `MemoryTool` feature flag, and `source.is_non_root_agent()` to decide whether to return early. For eligible sessions it constructs `MemoryStartupContext`, checks `state_db()`, and if present spawns a Tokio task that creates the memories root directory, seeds extension instructions, calls `phase1::prune`, checks `guard::rate_limits_ok`, emits a skipped-rate-limit metric if needed, then awaits `phase1::run` followed by `phase2::run`. It returns immediately after scheduling the task.

**Call relations**: This is the startup entrypoint invoked by the wider system when a session begins. Inside the spawned task it orchestrates the entire memories pipeline by calling the phase-specific modules in order.

*Call graph*: calls 5 internal fn (seed_extension_instructions, rate_limits_ok, prune, run, new); 9 external calls (clone, new, clone, is_non_root_agent, memory_root, run, create_dir_all, spawn, warn!).


### `memories/write/src/phase1.rs`

`domain_logic` · `startup`

This file is the phase-1 extraction driver for the memories startup pipeline. Its top-level `run` function builds a `StageOneRequestContext` once, starts an end-to-end timer, claims startup jobs from the state DB, and exits early on missing DB access or zero candidates. Claimed jobs are processed concurrently with `buffer_unordered`, each producing a `JobResult` that combines a `JobOutcome` enum (`SucceededWithOutput`, `SucceededNoOutput`, `Failed`) with optional `TokenUsage`. After all jobs finish, `aggregate_stats` folds counts and summed token usage into `Stats`, and `emit_metrics` publishes counters and histograms.

The extraction payload is constrained by `StageOneOutput`, a strict JSON-deserializable schema with `raw_memory`, `rollout_summary`, and nullable `rollout_slug`; `output_schema` mirrors that contract for the model request. Inside `job::sample`, the code loads rollout items from disk, filters them down to memory-safe `ResponseItem`s, serializes them to JSON, redacts secrets, and renders a stage-one prompt using rollout path/cwd metadata plus truncated rollout contents. The model response is streamed, parsed as JSON, and redacted again before persistence.

Filtering is intentionally opinionated: developer messages are dropped entirely, user messages have AGENTS.md instruction blocks and `<skill>...</skill>` fragments removed, but environment context and inter-agent communications are preserved. Persistence paths distinguish hard failures, successful jobs with empty output, and successful jobs with stored memory rows, all guarded by ownership tokens from the DB lease system.

#### Function details

##### `run`  (lines 70–108)

```
async fn run(context: Arc<MemoryStartupContext>, config: Arc<Config>)
```

**Purpose**: Executes the full phase-1 startup pass from request-context creation through job claiming, parallel extraction, and final metrics/logging. It short-circuits when the state DB is unavailable or when no rollout candidates are claimable.

**Data flow**: Takes an `Arc<MemoryStartupContext>` and `Arc<Config>`. It derives a `StageOneRequestContext`, starts an E2E timer on that telemetry context, asks the DB for startup claims using memory-related config limits, then feeds the claimed `Stage1JobClaim` list into parallel job execution. The collected `Vec<JobResult>` is reduced into `Stats`, which are emitted as counters/histograms and summarized in an info log; no value is returned.

**Call relations**: This is the phase-1 entry used by the startup task after rate-limit checks. It first delegates model/telemetry setup to `build_request_context`, then DB leasing to `claim_startup_jobs`, then per-rollout work to `run_jobs`; once those complete it delegates summarization to `aggregate_stats` and telemetry emission to `emit_metrics`.

*Call graph*: calls 5 internal fn (aggregate_stats, build_request_context, claim_startup_jobs, emit_metrics, run_jobs); 1 external calls (info!).


##### `prune`  (lines 111–133)

```
async fn prune(context: &MemoryStartupContext, config: &Config)
```

**Purpose**: Deletes stale, unused stage-1 output rows from the memories database according to retention settings. It is a best-effort cleanup step that logs but does not fail startup.

**Data flow**: Reads the optional state DB from `MemoryStartupContext` and `max_unused_days` from `Config.memories`. If a DB exists, it invokes the memories retention prune with a fixed batch size and logs either the number of rows removed or a warning on error. It returns no value and does not mutate in-memory state.

**Call relations**: This function is invoked by `start_memories_startup_task` before quota checks because it consumes no model tokens. It does not call deeper crate logic beyond the DB accessor and relies on logging to surface failures.

*Call graph*: calls 1 internal fn (state_db); called by 1 (start_memories_startup_task); 2 external calls (info!, warn!).


##### `output_schema`  (lines 136–147)

```
fn output_schema() -> Value
```

**Purpose**: Builds the JSON Schema that constrains phase-1 model output to the exact `StageOneOutput` shape. The schema requires all three keys and forbids extra properties.

**Data flow**: Produces a `serde_json::Value` object literal describing an object with string `rollout_summary`, nullable/string `rollout_slug`, and string `raw_memory`, all listed in `required` with `additionalProperties: false`. It reads no external state.

**Call relations**: Used by `job::sample` to request strict structured output from the model, and by a unit test that verifies `rollout_slug` remains required yet nullable.

*Call graph*: called by 2 (sample, output_schema_requires_rollout_slug_and_keeps_it_nullable); 1 external calls (json!).


##### `claim_startup_jobs`  (lines 149–187)

```
async fn claim_startup_jobs(
    context: &MemoryStartupContext,
    memories_config: &MemoriesConfig,
) -> Option<Vec<codex_state::Stage1JobClaim>>
```

**Purpose**: Claims a bounded set of eligible rollout threads for phase-1 processing during startup. It applies source, age, idle-time, scan-limit, and lease constraints from configuration and constants.

**Data flow**: Consumes a `MemoryStartupContext` and `MemoriesConfig`. It reads the state DB and current startup thread ID, constructs `allowed_sources` from `INTERACTIVE_SESSION_SOURCES`, then submits `Stage1StartupClaimParams` containing scan limit, max claimed jobs, max age, minimum idle hours, allowed sources, and lease duration. It returns `Some(Vec<Stage1JobClaim>)` on success, `None` if the DB is missing or the claim query errors.

**Call relations**: Called only by `run` before any model work begins. Its output determines whether phase 1 proceeds at all; failures are converted into warnings and a skipped phase rather than propagated.

*Call graph*: calls 2 internal fn (state_db, thread_id); called by 1 (run); 1 external calls (warn!).


##### `build_request_context`  (lines 189–202)

```
async fn build_request_context(
    context: &MemoryStartupContext,
    config: &Config,
) -> StageOneRequestContext
```

**Purpose**: Chooses the model name for phase-1 extraction and asks the runtime to build a telemetry/model-info snapshot for requests. It prefers an explicit config override and otherwise falls back to the provider’s memory-extraction default.

**Data flow**: Reads `config.memories.extract_model`; if absent, it queries `context.provider().memory_extraction_preferred_model()`. It then passes the chosen model name plus the fixed stage-one reasoning effort into `MemoryStartupContext::stage_one_request_context` and returns the resulting `StageOneRequestContext`.

**Call relations**: This is the first helper used by `run`, ensuring all later jobs share the same model metadata and telemetry wrapper. It delegates the actual model-info lookup and service-tier capture to the runtime layer.

*Call graph*: calls 1 internal fn (stage_one_request_context); called by 1 (run).


##### `run_jobs`  (lines 204–222)

```
async fn run_jobs(
    context: Arc<MemoryStartupContext>,
    config: Arc<Config>,
    claimed_candidates: Vec<codex_state::Stage1JobClaim>,
    stage_one_context: StageOneRequestContext,
) -> Vec<Jo
```

**Purpose**: Runs all claimed phase-1 jobs concurrently up to the configured concurrency limit. It preserves no ordering and simply collects each job’s terminal result.

**Data flow**: Takes shared startup context/config, a vector of `Stage1JobClaim`s, and a `StageOneRequestContext`. It turns the claims into a futures stream, clones the shared inputs per claim, invokes `job::run` for each, buffers them unordered with the stage-one concurrency constant, and collects the resulting `JobResult`s into a `Vec`.

**Call relations**: Called by `run` after claims are acquired. It is the bridge from orchestration into per-rollout extraction logic, delegating every individual claim to `job::run`.

*Call graph*: called by 1 (run); 1 external calls (iter).


##### `job::run`  (lines 227–280)

```
async fn run(
        context: &MemoryStartupContext,
        config: &Config,
        claim: codex_state::Stage1JobClaim,
        stage_one_context: &StageOneRequestContext,
    ) -> JobResult
```

**Purpose**: Processes one claimed rollout thread end-to-end: sample the model, classify empty output versus usable output, and mark the DB row accordingly. It converts all failures into DB failure marks tied to the claim ownership token.

**Data flow**: Accepts the startup context, config, one `Stage1JobClaim`, and the shared request context. It extracts the claimed thread metadata, calls `sample` with rollout path/cwd, and on error records failure via `result::failed` and returns `JobResult { Failed, None }`. On success it inspects `StageOneOutput`; empty `raw_memory` or `rollout_summary` triggers `result::no_output`, otherwise it calls `result::success` with thread ID, ownership token, source timestamp, raw memory, summary, and optional slug. It returns the resulting `JobOutcome` plus any token usage from sampling.

**Call relations**: Invoked from `run_jobs` for each claimed candidate. It delegates model interaction to `sample` and all DB state transitions to the nested `result` helpers so the orchestration path stays focused on classification.

*Call graph*: 4 external calls (sample, failed, no_output, success).


##### `job::sample`  (lines 283–324)

```
async fn sample(
        context: &MemoryStartupContext,
        config: &Config,
        rollout_path: &Path,
        rollout_cwd: &Path,
        stage_one_context: &StageOneRequestContext,
    ) ->
```

**Purpose**: Loads a rollout from disk, filters and serializes memory-safe items, constructs the stage-one prompt, streams the model response, and parses/redacts the structured output. This is the actual extraction step that turns rollout history into `StageOneOutput`.

**Data flow**: Inputs are the startup context, config, rollout file path, rollout cwd, and request context. It reads rollout items via `RolloutRecorder::load_rollout_items`, converts them to a redacted JSON string with `serialize_filtered_rollout_response_items`, builds a `Prompt` containing one user `ResponseItem::Message` whose text comes from `build_stage_one_input_message`, sets base instructions and strict `output_schema`, then calls `stream_stage_one_prompt`. The returned text is deserialized into `StageOneOutput`, whose fields are individually passed through `redact_secrets`; it returns `(StageOneOutput, Option<TokenUsage>)` or an error.

**Call relations**: Called only by `job::run`. It depends on `output_schema` for structured output enforcement and on the runtime’s streaming API for model execution.

*Call graph*: calls 4 internal fn (default, output_schema, stream_stage_one_prompt, load_rollout_items); 4 external calls (redact_secrets, serialize_filtered_rollout_response_items, from_str, vec!).


##### `job::result::failed`  (lines 329–347)

```
async fn failed(
            context: &MemoryStartupContext,
            thread_id: codex_protocol::ThreadId,
            ownership_token: &str,
            reason: &str,
        )
```

**Purpose**: Marks a claimed phase-1 job as failed in the DB and schedules it for retry after a fixed delay. It also emits a warning with the thread ID and failure reason.

**Data flow**: Takes the startup context, thread ID, ownership token, and textual reason. It logs the failure, reads the optional state DB, and if present calls `mark_stage1_job_failed` with the retry delay constant. It returns no value and ignores DB write errors.

**Call relations**: Used by `job::run` whenever sampling or prompt execution fails. It is intentionally fire-and-forget so one failed persistence update does not panic the startup pipeline.

*Call graph*: calls 1 internal fn (state_db); 1 external calls (warn!).


##### `job::result::no_output`  (lines 349–368)

```
async fn no_output(
            context: &MemoryStartupContext,
            thread_id: codex_protocol::ThreadId,
            ownership_token: &str,
        ) -> JobOutcome
```

**Purpose**: Marks a claimed phase-1 job as successfully processed but producing no usable memory output. It treats missing DB access or a rejected ownership update as a failure outcome.

**Data flow**: Consumes the startup context, thread ID, and ownership token. It fetches the state DB; if absent it immediately returns `JobOutcome::Failed`. Otherwise it calls `mark_stage1_job_succeeded_no_output` and maps a successful `true` result to `SucceededNoOutput`, with all other cases becoming `Failed`.

**Call relations**: Called by `job::run` when the model returns an empty `raw_memory` or empty `rollout_summary`. It isolates the DB-specific success/no-output transition from the extraction logic.

*Call graph*: calls 1 internal fn (state_db).


##### `job::result::success`  (lines 370–400)

```
async fn success(
            context: &MemoryStartupContext,
            thread_id: codex_protocol::ThreadId,
            ownership_token: &str,
            source_updated_at: i64,
            raw_me
```

**Purpose**: Persists a non-empty phase-1 extraction result and marks the claimed job as succeeded with output. It writes both the raw memory body and the compact rollout summary, plus optional slug metadata.

**Data flow**: Inputs are the startup context, thread ID, ownership token, source update timestamp, `raw_memory`, `rollout_summary`, and optional `rollout_slug`. It reads the state DB; if absent it returns `Failed`. Otherwise it calls `mark_stage1_job_succeeded` and maps a successful `true` response to `SucceededWithOutput`, with all other outcomes mapped to `Failed`.

**Call relations**: Called by `job::run` only after `sample` returns non-empty fields. It is the persistence endpoint that also triggers downstream phase-2 eligibility in the DB layer.

*Call graph*: calls 1 internal fn (state_db).


##### `job::serialize_filtered_rollout_response_items`  (lines 404–424)

```
fn serialize_filtered_rollout_response_items(
        items: &[RolloutItem],
    ) -> codex_protocol::error::Result<String>
```

**Purpose**: Converts rollout trace items into the subset of `ResponseItem`s that are safe and useful for memory extraction prompts. It drops unsupported rollout item kinds, preserves inter-agent communications, serializes the result to JSON, and redacts secrets before upload.

**Data flow**: Takes a slice of `RolloutItem`. It iterates through items, mapping `RolloutItem::ResponseItem` through `sanitize_response_item_for_memories`, converting `InterAgentCommunication` to model input items, and discarding session metadata, compacted items, turn context, and event messages. The filtered vector is serialized with `serde_json::to_string`; serialization errors become `CodexErr::InvalidRequest`. The final JSON string is passed through `redact_secrets` and returned.

**Call relations**: Used by `job::sample` before prompt rendering, and exercised by multiple tests that verify contextual filtering, secret redaction, and inter-agent communication preservation.

*Call graph*: 3 external calls (redact_secrets, iter, to_string).


##### `job::sanitize_response_item_for_memories`  (lines 426–462)

```
fn sanitize_response_item_for_memories(item: &ResponseItem) -> Option<ResponseItem>
```

**Purpose**: Applies per-`ResponseItem` filtering rules tailored for memory extraction. It removes developer messages entirely, strips certain contextual fragments from user messages, and otherwise preserves items that the rollout policy allows.

**Data flow**: Accepts a `&ResponseItem`. Non-message items are returned only if `should_persist_response_item_for_memories` says they should be kept, in which case the item is cloned. For `ResponseItem::Message`, developer-role messages return `None`; non-user roles are cloned unchanged; user-role messages have `content` filtered to remove fragments identified by `is_memory_excluded_contextual_user_fragment`. If all content is removed, it returns `None`; otherwise it reconstructs and returns a cloned message with filtered content.

**Call relations**: Called from `serialize_filtered_rollout_response_items` for every response item in a rollout. It is the core policy gate that decides what conversational material reaches the phase-1 model.

*Call graph*: 2 external calls (should_persist_response_item_for_memories, clone).


##### `job::is_memory_excluded_contextual_user_fragment`  (lines 464–471)

```
fn is_memory_excluded_contextual_user_fragment(content_item: &ContentItem) -> bool
```

**Purpose**: Recognizes user text fragments that are contextual scaffolding rather than conversation content and should be omitted from memory extraction. The current exclusions are AGENTS.md instruction wrappers and `<skill>` blocks.

**Data flow**: Takes a `&ContentItem`. If the item is not `ContentItem::InputText`, it returns `false`. For text items, it checks the text against two start/end marker pairs via `matches_marked_fragment` and returns `true` if either pair matches.

**Call relations**: Used by `sanitize_response_item_for_memories` while filtering user message content. Its behavior is pinned by a dedicated unit test covering positive and negative examples.

*Call graph*: 1 external calls (matches_marked_fragment).


##### `job::matches_marked_fragment`  (lines 473–483)

```
fn matches_marked_fragment(text: &str, start_marker: &str, end_marker: &str) -> bool
```

**Purpose**: Performs a case-insensitive boundary check for a text block wrapped by a specific start marker and end marker. It ignores leading and trailing whitespace around the markers.

**Data flow**: Receives the full text plus `start_marker` and `end_marker`. It trims leading whitespace and checks whether the beginning equals the start marker ignoring ASCII case, then trims trailing whitespace and checks whether the end equals the end marker ignoring ASCII case. It returns `true` only if both conditions hold.

**Call relations**: This helper is only used by `is_memory_excluded_contextual_user_fragment` to implement marker-based exclusion without parsing the inner body.


##### `job::tests::classifies_memory_excluded_fragments`  (lines 490–523)

```
fn classifies_memory_excluded_fragments()
```

**Purpose**: Verifies that AGENTS.md instruction wrappers and `<skill>` blocks are excluded, while environment context and subagent notifications are retained. It codifies the intended filtering boundary for user content fragments.

**Data flow**: Builds several sample text cases, wraps each in `ContentItem::InputText`, passes them to `is_memory_excluded_contextual_user_fragment`, and asserts the returned boolean matches the expected classification. It writes no external state.

**Call relations**: This unit test directly exercises the fragment classifier used by `sanitize_response_item_for_memories`.

*Call graph*: 1 external calls (assert_eq!).


##### `job::tests::output_schema_requires_rollout_slug_and_keeps_it_nullable`  (lines 526–565)

```
fn output_schema_requires_rollout_slug_and_keeps_it_nullable()
```

**Purpose**: Checks that the phase-1 output schema explicitly declares `rollout_slug`, requires it, and allows either string or null values. This prevents schema drift between prompt constraints and `StageOneOutput` deserialization.

**Data flow**: Calls `output_schema`, navigates the resulting JSON to inspect `properties` and `required`, sorts the required keys and rollout-slug type entries, and asserts the expected contents. It returns nothing.

**Call relations**: This test guards the contract consumed by `job::sample`, ensuring the model is asked for the same shape the code expects to parse.

*Call graph*: calls 1 internal fn (output_schema); 2 external calls (assert!, assert_eq!).


##### `aggregate_stats`  (lines 569–597)

```
fn aggregate_stats(outcomes: Vec<JobResult>) -> Stats
```

**Purpose**: Reduces per-job outcomes into aggregate counts and summed token usage for the whole phase-1 run. It preserves `None` token usage when no job reported usage at all.

**Data flow**: Consumes a `Vec<JobResult>`. It counts total claimed jobs from vector length, increments success/no-output/failure counters based on each `JobOutcome`, and accumulates any present `TokenUsage` into a default-initialized total while tracking whether at least one usage was seen. It returns a `Stats` struct whose `total_token_usage` is `Some(total)` only if any job supplied usage.

**Call relations**: Called by `run` after all jobs complete, and by tests that verify token-usage summation and the empty-usage case.

*Call graph*: called by 3 (run, count_outcomes_keeps_usage_empty_when_no_job_reports_it, count_outcomes_sums_token_usage_across_all_jobs); 1 external calls (default).


##### `emit_metrics`  (lines 599–660)

```
fn emit_metrics(context: &StageOneRequestContext, counts: &Stats)
```

**Purpose**: Publishes phase-1 counters and token-usage histograms from aggregated stats. It emits only non-zero count metrics and breaks token usage into total, input, cached input, output, and reasoning output buckets.

**Data flow**: Reads a `StageOneRequestContext` and `Stats`. For each non-zero count field it increments `MEMORY_PHASE_ONE_JOBS` with an appropriate status tag, increments `MEMORY_PHASE_ONE_OUTPUT` for successful outputs, and if token usage exists records multiple histograms derived from the `TokenUsage` fields using `max(0)` or `cached_input()`. It returns no value.

**Call relations**: Invoked by `run` after `aggregate_stats`. It uses the telemetry wrapper methods on `StageOneRequestContext`, which in turn forward to session telemetry.

*Call graph*: calls 2 internal fn (counter, histogram); called by 1 (run).


##### `tests::serializes_memory_rollout_with_agents_removed_but_environment_kept`  (lines 670–738)

```
fn serializes_memory_rollout_with_agents_removed_but_environment_kept()
```

**Purpose**: Confirms rollout serialization removes AGENTS.md and skill fragments from user messages while preserving environment context and subagent notifications. It validates the exact filtered JSON shape fed into phase-1 prompts.

**Data flow**: Constructs mixed `ResponseItem::Message` values, wraps them as `RolloutItem::ResponseItem`, serializes them with `job::serialize_filtered_rollout_response_items`, parses the JSON back into `Vec<ResponseItem>`, and asserts the resulting vector contains only the expected retained content. No external state is touched.

**Call relations**: This test exercises the combined behavior of `serialize_filtered_rollout_response_items`, `sanitize_response_item_for_memories`, and the fragment classifier.

*Call graph*: 5 external calls (assert_eq!, serialize_filtered_rollout_response_items, ResponseItem, from_str, vec!).


##### `tests::serializes_memory_rollout_redacts_secrets_before_prompt_upload`  (lines 741–759)

```
fn serializes_memory_rollout_redacts_secrets_before_prompt_upload()
```

**Purpose**: Verifies that serialized rollout content is secret-redacted before being embedded in a model prompt. It specifically checks a function-call output containing an API-token-like string.

**Data flow**: Builds a rollout containing one `ResponseItem::FunctionCallOutput` with a secret-looking token in text, serializes it through `job::serialize_filtered_rollout_response_items`, and asserts the raw secret is absent while `[REDACTED_SECRET]` is present. It returns nothing.

**Call relations**: This test targets the final redaction step inside `serialize_filtered_rollout_response_items`, which is used by `job::sample`.

*Call graph*: 4 external calls (assert!, serialize_filtered_rollout_response_items, Text, ResponseItem).


##### `tests::serializes_inter_agent_communications_for_memory`  (lines 762–790)

```
fn serializes_inter_agent_communications_for_memory()
```

**Purpose**: Checks that plaintext and encrypted inter-agent communications are converted into model-input response items and preserved in serialized rollout memory input. This ensures multi-agent coordination artifacts remain available to phase 1.

**Data flow**: Creates plaintext and encrypted `InterAgentCommunication` values, computes the expected `ResponseItem` forms via `to_model_input_item`, serializes them as `RolloutItem::InterAgentCommunication`, parses the JSON back into `Vec<ResponseItem>`, and asserts equality with the expected vector.

**Call relations**: This test covers the non-response-item branch in `serialize_filtered_rollout_response_items` that maps inter-agent communication into prompt-visible items.

*Call graph*: calls 3 internal fn (root, new, new_encrypted); 6 external calls (new, assert_eq!, serialize_filtered_rollout_response_items, InterAgentCommunication, from_str, vec!).


##### `tests::count_outcomes_sums_token_usage_across_all_jobs`  (lines 793–835)

```
fn count_outcomes_sums_token_usage_across_all_jobs()
```

**Purpose**: Verifies that aggregate stats count each outcome category correctly and sum token usage across multiple jobs. It covers mixed success, no-output, and failure cases.

**Data flow**: Builds a vector of `JobResult` values with explicit `TokenUsage` on two jobs and none on one failed job, passes it to `aggregate_stats`, and asserts the resulting counts and summed usage fields match the expected totals. It returns nothing.

**Call relations**: This test directly validates `aggregate_stats`, which is used by the top-level phase-1 `run` function.

*Call graph*: calls 1 internal fn (aggregate_stats); 2 external calls (assert_eq!, vec!).


##### `tests::count_outcomes_keeps_usage_empty_when_no_job_reports_it`  (lines 838–852)

```
fn count_outcomes_keeps_usage_empty_when_no_job_reports_it()
```

**Purpose**: Ensures aggregate stats leave `total_token_usage` as `None` when every job lacks usage information. This distinguishes 'no usage reported' from 'reported zero tokens'.

**Data flow**: Constructs two `JobResult`s with `token_usage: None`, calls `aggregate_stats`, and asserts the claimed count and `None` usage result. It has no side effects.

**Call relations**: This is the companion test for `aggregate_stats`, covering the branch where the accumulator never sees any token-usage payload.

*Call graph*: calls 1 internal fn (aggregate_stats); 2 external calls (assert_eq!, vec!).


### `memories/write/src/phase2.rs`

`domain_logic` · `startup`

This file drives the second half of memory startup: consolidating DB-backed stage-1 outputs into the on-disk memories workspace. `run` starts an E2E timer, requires a state DB, computes the memory root, and acquires a global phase-2 lease through `job::claim`. It then prepares the workspace baseline repository, builds a restricted agent config, loads current phase-2 inputs from the DB, computes a completion watermark from the newest selected memory, and syncs those inputs into files under the memory root.

The sync step writes rollout summaries, rebuilds `raw_memories.md`, and prunes old extension resources. After syncing, the code asks git for a workspace diff; if nothing changed, it marks the global job successful without spawning an agent. Otherwise it writes the diff to disk, builds a consolidation prompt, and starts an internal consolidation thread.

The nested `agent` module is responsible for hardening the spawned thread: it forces `ephemeral = true`, disables memory generation/use and multiple features, constrains MCP servers to none, sets approval to `Never`, and applies a workspace-write/no-network sandbox rooted only at the memories directory. `agent::handle` then runs asynchronously: it heartbeats the global lease while polling agent status, emits token-usage metrics on completion, confirms ownership again before resetting the git baseline, and marks the global job succeeded or failed depending on agent status, ownership, and baseline reset outcome.

#### Function details

##### `run`  (lines 46–201)

```
async fn run(context: Arc<MemoryStartupContext>, config: Arc<Config>)
```

**Purpose**: Executes the full phase-2 consolidation flow from global lock acquisition through workspace sync, diff detection, optional agent spawn, and dispatch metrics. It exits early on any failure, marking the global job with a specific failure reason where applicable.

**Data flow**: Takes shared startup context and config. It starts an E2E timer, reads the state DB, computes the memory root and memory-selection limits, claims the global phase-2 job, prepares the workspace, derives a restricted agent config, loads selected `Stage1Output` rows from the DB, computes `new_watermark`, syncs those rows into workspace files, computes a git diff, and either marks success immediately when there are no changes or writes the diff, spawns a consolidation agent, and hands off asynchronous completion handling. It finally emits input-count and agent-spawned metrics; it returns no value.

**Call relations**: Called by `start_memories_startup_task` after phase 1 and by a dedicated model-request test. It delegates lock transitions to `job::claim`/`job::failed`/`job::succeed`, file sync to `sync_phase2_workspace_inputs`, workspace inspection to git helpers, agent setup to `agent::get_config` and `agent::get_prompt`, and long-running completion logic to `agent::handle`.

*Call graph*: calls 6 internal fn (emit_metrics, get_watermark, sync_phase2_workspace_inputs, memory_workspace_diff, prepare_memory_workspace, write_workspace_diff); called by 2 (start_memories_startup_task, run_memory_phase_two_model_request_test); 9 external calls (clone, get_config, get_prompt, handle, memory_root, claim, failed, succeed, error!).


##### `sync_phase2_workspace_inputs`  (lines 203–212)

```
async fn sync_phase2_workspace_inputs(
    root: &Path,
    raw_memories: &[Stage1Output],
) -> std::io::Result<()>
```

**Purpose**: Materializes the selected phase-2 inputs into the memory workspace and prunes stale extension resources. It is the file-system synchronization step before git diffing.

**Data flow**: Receives the memory root path and a slice of `Stage1Output`. It computes the count once, then calls `sync_rollout_summaries_from_memories`, `rebuild_raw_memories_file_from_memories`, and `prune_old_extension_resources` in sequence. It returns `std::io::Result<()>`, propagating any error from the first two operations while ignoring the prune helper’s lack of result.

**Call relations**: Used only by `run` after DB input selection succeeds. Its output determines what `memory_workspace_diff` sees as changed.

*Call graph*: called by 1 (run); 4 external calls (prune_old_extension_resources, rebuild_raw_memories_file_from_memories, sync_rollout_summaries_from_memories, len).


##### `job::claim`  (lines 217–251)

```
async fn claim(
        context: &MemoryStartupContext,
        db: &StateRuntime,
    ) -> Result<Claim, &'static str>
```

**Purpose**: Attempts to acquire the singleton global phase-2 lease and translates DB claim outcomes into either a usable `Claim` or a stable status string. It also emits the 'claimed' metric when ownership is obtained.

**Data flow**: Inputs are the startup context and `StateRuntime`. It calls `try_claim_global_phase2_job` with the current thread ID and lease duration. DB errors become `Err("failed_claim")`; a claimed outcome yields a `Claim { token, watermark }` and increments `MEMORY_PHASE_TWO_JOBS` with status `claimed`; skipped retry/cooldown/running outcomes become corresponding `Err(&'static str)` values.

**Call relations**: Called at the start of `run` before any workspace mutation. Its returned status string is used directly by `run` to emit a skip/failure metric and abort phase 2.

*Call graph*: calls 3 internal fn (counter, thread_id, memories).


##### `job::failed`  (lines 253–279)

```
async fn failed(
        context: &MemoryStartupContext,
        db: &StateRuntime,
        claim: &Claim,
        reason: &'static str,
    )
```

**Purpose**: Marks the global phase-2 job as failed and schedules a retry delay, with a fallback path for the case where the caller no longer owns the lease. It always emits a failure-status counter first.

**Data flow**: Takes the startup context, DB handle, `Claim`, and static reason string. It increments `MEMORY_PHASE_TWO_JOBS` with that reason, then calls `mark_global_phase2_job_failed`. If that returns `Ok(false)`, it attempts `mark_global_phase2_job_failed_if_unowned` with the same token and retry delay. It returns no value.

**Call relations**: Used throughout `run` for synchronous setup failures and inside `agent::handle` for asynchronous ownership, baseline-reset, or agent-status failures. The fallback unowned path matters when the lease was lost between work and finalization.

*Call graph*: calls 2 internal fn (counter, memories); 1 external calls (matches!).


##### `job::succeed`  (lines 281–294)

```
async fn succeed(
        context: &MemoryStartupContext,
        db: &StateRuntime,
        claim: &Claim,
        completion_watermark: i64,
        selected_outputs: &[codex_state::Stage1Output],
```

**Purpose**: Marks the global phase-2 job as successfully completed with a completion watermark and the exact selected stage-1 outputs that were consolidated. It also emits a success-status counter.

**Data flow**: Consumes the startup context, DB handle, `Claim`, completion watermark, selected outputs slice, and static reason string. It increments `MEMORY_PHASE_TWO_JOBS` with that reason, calls `mark_global_phase2_job_succeeded`, and returns the DB boolean result, defaulting to `false` on error.

**Call relations**: Called by `run` when the synced workspace has no changes and by `agent::handle` after a successful agent run and baseline reset. The boolean return lets callers detect a failed final state transition.

*Call graph*: calls 2 internal fn (counter, memories).


##### `agent::get_config`  (lines 301–348)

```
fn get_config(config: &Config, provider: &dyn ModelProvider) -> Option<Config>
```

**Purpose**: Builds the hardened configuration used for the internal consolidation agent. It rewrites the caller’s config so the agent can only edit the memories workspace locally and cannot recursively trigger other subsystems.

**Data flow**: Takes the parent `Config` and a `ModelProvider`. It clones the config, sets `cwd` to the memory root, forces `ephemeral`, disables memory generation/use and app instructions, constrains MCP servers to an empty allowlist, sets approval policy to `AskForApproval::Never`, disables several features (`SpawnCsv`, `Collab`, `MemoryTool`, `Apps`, `Plugins`, `SkillMcpDependencyInstall`), applies a `SandboxPolicy::WorkspaceWrite` with no network and only the memory root writable, and chooses the model from `memories.consolidation_model` or the provider default. It sets reasoning effort and returns `Some(config)` or `None` if sandbox policy application fails.

**Call relations**: Called by `run` before any agent is spawned. If it returns `None`, `run` records `failed_sandbox_policy` and aborts phase 2.

*Call graph*: calls 1 internal fn (allow_only); 4 external calls (new, clone, memory_root, vec!).


##### `agent::get_prompt`  (lines 350–356)

```
fn get_prompt(root: &Path) -> Vec<UserInput>
```

**Purpose**: Wraps the rendered consolidation prompt text into the `UserInput` vector expected by thread submission. It produces a single text input item.

**Data flow**: Accepts the memory root path, calls `build_consolidation_prompt`, and returns `vec![UserInput::Text { text, text_elements: vec![] }]`. It reads no mutable state.

**Call relations**: Used by `run` immediately before `spawn_consolidation_agent`, separating prompt rendering from thread creation.

*Call graph*: 2 external calls (build_consolidation_prompt, vec!).


##### `agent::handle`  (lines 360–450)

```
fn handle(
        context: Arc<MemoryStartupContext>,
        claim: Claim,
        new_watermark: i64,
        selected_outputs: Vec<codex_state::Stage1Output>,
        memory_root: codex_utils_abso
```

**Purpose**: Owns the asynchronous lifecycle after the consolidation agent is spawned: wait for completion, heartbeat the global lease, emit token metrics, reset the workspace baseline, mark success/failure, and schedule agent shutdown. It decouples long-running completion logic from the synchronous startup path.

**Data flow**: Takes the startup context, `Claim`, new watermark, selected outputs, memory-root path, spawned agent, and optional E2E timer. It reads the state DB and, if present, spawns a Tokio task that waits for `loop_agent` to return a final `AgentStatus`. On `Completed`, it optionally reads token usage from the thread and emits metrics, heartbeats once more to confirm ownership, resets the workspace baseline, and calls `job::succeed`; on any failure branch it calls `job::failed`. It then spawns a second cleanup task that invokes `shutdown_consolidation_agent` and warns if shutdown fails.

**Call relations**: Called by `run` after successful agent spawn. It delegates status/heartbeat polling to `loop_agent`, final DB transitions to `job::failed`/`job::succeed`, baseline cleanup to `reset_memory_workspace_baseline`, and telemetry to `emit_token_usage_metrics`.

*Call graph*: calls 2 internal fn (emit_token_usage_metrics, reset_memory_workspace_baseline); 8 external calls (clone, failed, succeed, matches!, loop_agent, spawn, error!, warn!).


##### `agent::loop_agent`  (lines 452–517)

```
async fn loop_agent(
        db: Arc<StateRuntime>,
        token: String,
        thread_id: ThreadId,
        thread: &codex_core::CodexThread,
    ) -> AgentStatus
```

**Purpose**: Polls the consolidation thread until it reaches a final status while periodically heartbeating the global phase-2 lease. It converts premature thread termination or heartbeat loss into `AgentStatus::Errored`.

**Data flow**: Inputs are the shared DB handle, ownership token, spawned thread ID, and `CodexThread`. It creates heartbeat and status-poll intervals, pins `wait_until_terminated`, and loops: fetch current `agent_status`, break if final, otherwise `select!` between session termination, a one-second poll tick, and a heartbeat tick. Heartbeat success continues; heartbeat false or error breaks with an errored status string. It returns the final or synthesized `AgentStatus`.

**Call relations**: Used only by `agent::handle` inside the spawned task. It relies on `is_final_agent_status` to decide when polling can stop.

*Call graph*: calls 3 internal fn (agent_status, wait_until_terminated, is_final_agent_status); 4 external calls (from_secs, pin!, select!, interval).


##### `get_watermark`  (lines 520–530)

```
fn get_watermark(
    claimed_watermark: i64,
    latest_memories: &[codex_state::Stage1Output],
) -> i64
```

**Purpose**: Computes the completion watermark for phase 2 as the maximum of the claimed watermark and the newest selected stage-1 source timestamp. This prevents the watermark from moving backward when no newer inputs are present.

**Data flow**: Takes the claimed watermark and a slice of `Stage1Output`. It maps each memory to `source_updated_at.timestamp()`, takes the maximum if any, falls back to the claimed watermark when the slice is empty, and finally returns the max of that value and the claimed watermark.

**Call relations**: Called by `run` after loading phase-2 inputs and before final success marking. Its result is passed into either immediate success or asynchronous completion handling.

*Call graph*: called by 1 (run); 1 external calls (iter).


##### `is_final_agent_status`  (lines 532–537)

```
fn is_final_agent_status(status: &AgentStatus) -> bool
```

**Purpose**: Classifies whether an `AgentStatus` is terminal for consolidation handling. Pending, running, and interrupted are treated as non-final; everything else is final.

**Data flow**: Reads an `&AgentStatus` and returns a boolean based on a `matches!` negation. It has no side effects.

**Call relations**: Used by `agent::loop_agent` both before and after waiting for thread termination to decide whether polling should stop.

*Call graph*: called by 1 (loop_agent); 1 external calls (matches!).


##### `emit_metrics`  (lines 539–549)

```
fn emit_metrics(context: &MemoryStartupContext, counters: Counters)
```

**Purpose**: Emits phase-2 dispatch metrics after the agent has been launched or the run has reached the dispatch point. It records the number of selected raw memories and an `agent_spawned` job event.

**Data flow**: Consumes the startup context and a `Counters` struct. If `input > 0`, it increments `MEMORY_PHASE_TWO_INPUT`; it always increments `MEMORY_PHASE_TWO_JOBS` with status `agent_spawned`. It returns no value.

**Call relations**: Called by `run` at the end of the synchronous setup path after handing off to `agent::handle`.

*Call graph*: calls 1 internal fn (counter); called by 1 (run).


##### `emit_token_usage_metrics`  (lines 551–577)

```
fn emit_token_usage_metrics(context: &MemoryStartupContext, token_usage: &TokenUsage)
```

**Purpose**: Publishes phase-2 token-usage histograms from the consolidation agent’s final usage totals. It mirrors the phase-1 token breakdown categories.

**Data flow**: Reads the startup context and a `TokenUsage` reference. It records histograms for total, input, cached input, output, and reasoning output tokens, clamping signed fields with `max(0)` where needed. It returns nothing.

**Call relations**: Called by `agent::handle` only when the consolidation agent completed successfully and exposed token-usage info.

*Call graph*: calls 2 internal fn (histogram, cached_input); called by 1 (handle).


### Background watchers
This final background component watches skill directories for changes and broadcasts cache-invalidating notifications to the server runtime.

### `app-server/src/skills_watcher.rs`

`orchestration` · `startup and background file-change monitoring`

This file wraps `codex_file_watcher` behind a higher-level `SkillsWatcher` that is tailored to the app-server’s skill-loading model. The struct stores a `FileWatcherSubscriber`, a mutex-protected `WatchRegistration` for mutable runtime extra roots, and a `CancellationToken` plus `DropGuard` to stop the background listener cleanly.

`SkillsWatcher::new` attempts to create a real `FileWatcher`; if initialization fails it logs a warning and falls back to `FileWatcher::noop()`, preserving the rest of the server startup path. It subscribes to watcher events, creates shutdown tokens, and starts a Tokio task via `spawn_event_loop`. That loop wraps the raw receiver in `ThrottledWatchReceiver` using a long production debounce interval (10s, shortened in tests), then waits for either shutdown or a file event. Any event causes `skills_manager.clear_cache()` and an async `ServerNotification::SkillsChanged(SkillsChangedNotification {})` broadcast.

The registration methods separate two watch scopes. `register_runtime_extra_roots` replaces the current extra-root registration under a poisoned-mutex-tolerant lock, ensuring old registrations are dropped when new roots arrive. `register_thread_config` is async because it resolves environment, plugin-derived skill roots, and filesystem-aware skill roots through `ThreadManager`, `Config`, and `SkillsLoadInput`. It deliberately returns an empty registration when there is no selected environment, the environment is unknown, or it is remote, so only local filesystems are watched.

#### Function details

##### `SkillsWatcher::new`  (lines 37–58)

```
fn new(
        skills_manager: Arc<SkillsManager>,
        outgoing: Arc<OutgoingMessageSender>,
    ) -> Arc<Self>
```

**Purpose**: Builds a watcher instance, initializes the underlying file watcher if possible, and launches the background event loop that reacts to file changes. It also prepares shutdown state and storage for mutable runtime watch registrations.

**Data flow**: Consumes `Arc<SkillsManager>` and `Arc<OutgoingMessageSender>`. It attempts `FileWatcher::new()`, falls back to `FileWatcher::noop()` on error, obtains a `(FileWatcherSubscriber, Receiver)` pair, creates a root `CancellationToken` and `DropGuard`, spawns the event loop with a child token, and returns `Arc<SkillsWatcher>` containing the subscriber, a default `WatchRegistration` inside `Mutex`, and shutdown fields.

**Call relations**: Called by higher-level server construction to enable skills invalidation. It delegates watcher creation to `codex_file_watcher`, logs initialization failures, and immediately hands the receiver to `SkillsWatcher::spawn_event_loop` so change processing begins as soon as the object exists.

*Call graph*: calls 3 internal fn (new, noop, default); called by 1 (new); 5 external calls (new, new, new, spawn_event_loop, warn!).


##### `SkillsWatcher::shutdown`  (lines 60–62)

```
fn shutdown(&self)
```

**Purpose**: Stops the background watcher loop by cancelling its shutdown token. This is the explicit teardown hook for the watcher.

**Data flow**: Takes `&self`, reads `self.shutdown_token`, and calls `cancel()` on it. It returns `()` and does not otherwise mutate local fields.

**Call relations**: Used during server shutdown or watcher teardown to terminate the spawned listener task. The actual loop exit happens inside `spawn_event_loop`, which is selecting on this token’s cancellation.

*Call graph*: 1 external calls (cancel).


##### `SkillsWatcher::register_runtime_extra_roots`  (lines 64–78)

```
fn register_runtime_extra_roots(&self, extra_roots: &[AbsolutePathBuf])
```

**Purpose**: Replaces the set of extra filesystem roots that should be watched recursively at runtime. It is intended for roots discovered outside static thread configuration.

**Data flow**: Accepts `&[AbsolutePathBuf]`, maps each path into a recursive `WatchPath`, registers them through `self.subscriber.register_paths`, then locks `runtime_extra_roots_registration` and overwrites the stored `WatchRegistration` with the new one. Replacing the registration implicitly drops the previous registration and its watches.

**Call relations**: Called when runtime-discovered roots change. It delegates actual watch installation to the subscriber and uses the stored registration slot so only the latest extra-root set remains active.

*Call graph*: calls 1 internal fn (register_paths); 1 external calls (iter).


##### `SkillsWatcher::register_thread_config`  (lines 80–123)

```
async fn register_thread_config(
        &self,
        config: &Config,
        thread_manager: &ThreadManager,
        environments: &[TurnEnvironmentSelection],
    ) -> WatchRegistration
```

**Purpose**: Computes and registers the skill roots implied by a thread’s config, plugin setup, and selected environment. It returns the resulting `WatchRegistration` so the caller can tie those watches to the thread listener lifecycle.

**Data flow**: Takes `&self`, `&Config`, `&ThreadManager`, and a slice of `TurnEnvironmentSelection`. It reads the first environment selection, resolves the environment from `thread_manager.environment_manager()`, bails out with `WatchRegistration::default()` if none exists, the environment is unknown, or it is remote, then derives plugin roots from `config.plugins_config_input()` and `plugins_manager.plugins_for_config(...).await`. It builds `SkillsLoadInput` from cwd, effective plugin skill roots, config layer stack, and bundled-skills flag; asks `skills_manager.skill_roots_for_config(...).await` for concrete roots using the environment filesystem; converts them into recursive `WatchPath`s; and returns `self.subscriber.register_paths(roots)`.

**Call relations**: Invoked when attaching or configuring a thread listener so the server watches the exact local skill directories relevant to that thread. It orchestrates environment lookup, plugin resolution, and skill-root computation before delegating final registration to the file watcher subscriber.

*Call graph*: calls 6 internal fn (new, environment_manager, plugins_manager, skills_manager, register_paths, default); 4 external calls (bundled_skills_enabled, plugins_config_input, first, warn!).


##### `SkillsWatcher::spawn_event_loop`  (lines 125–153)

```
fn spawn_event_loop(
        rx: Receiver,
        skills_manager: Arc<SkillsManager>,
        outgoing: Arc<OutgoingMessageSender>,
        shutdown_token: CancellationToken,
    )
```

**Purpose**: Starts the asynchronous loop that consumes throttled file-watch events, invalidates the skills cache, and notifies clients that skills changed. It encapsulates the watcher’s long-lived background behavior.

**Data flow**: Consumes a raw `Receiver`, `Arc<SkillsManager>`, `Arc<OutgoingMessageSender>`, and a `CancellationToken`. It wraps the receiver in `ThrottledWatchReceiver` with `WATCHER_THROTTLE_INTERVAL`, tries to obtain the current Tokio runtime handle, and if successful spawns an async loop. Each iteration waits on either `shutdown_token.cancelled()` or `rx.recv()`. On any received event (`Some(_)`), it calls `skills_manager.clear_cache()` and awaits `outgoing.send_server_notification(ServerNotification::SkillsChanged(SkillsChangedNotification {}))`; on cancellation or closed receiver (`None`) it breaks.

**Call relations**: Only `SkillsWatcher::new` starts this loop. It depends on a Tokio runtime being present; otherwise it logs a warning and skips listener startup entirely. Within the loop it delegates cache invalidation to `SkillsManager` and client fan-out to `OutgoingMessageSender`.

*Call graph*: calls 1 internal fn (new); 4 external calls (SkillsChanged, try_current, select!, warn!).

## 📊 State Registers Touched

- `reg-core-skills-catalog` — The loaded and invalidatable skill catalog and associated enablement state used for prompt injection and runtime selection.
- `reg-live-thread-registry` — The in-memory registry of active conversation threads reconstructed from persistence and kept stable across resume, fork, and switching.
- `reg-input-queues` — The pending input and mailbox queues that buffer user steering and inter-agent messages for turn scheduling.
- `reg-prompt-assets-and-fragments` — The shared prompt-asset and context-fragment inventory used to assemble model-visible instructions, history decorations, and injected runtime facts.
- `reg-extension-state` — The typed host-seeded and extension-owned attachment store that extensions use to persist runtime data across lifecycle callbacks.
- `reg-agent-registry` — The in-memory registry of active agents and spawn reservations, including concurrency limits, nicknames, residency, and per-thread agent metadata.
- `reg-background-jobs` — The durable and live background-work coordination state for memory jobs, agent-job batches, backfill leases, and other asynchronous pipelines.
- `reg-goals-and-memory-state` — The persisted and live thread-scoped goals, memory mode, and memory artifact state that feed prompt assembly, background memory processing, and user-visible thread settings.
- `reg-skills-watcher-state` — The long-lived file-watch and invalidation state that monitors skill sources and triggers cached skill catalog refreshes across startup and background runtime.
- `reg-memories-startup-guard` — The startup-readiness guard that blocks or gates memory-related functionality until required memory initialization checks have completed.
- `reg-subagent-mailboxes` — The live inter-agent mailbox and completion-routing state that carries messages, wait conditions, and status updates between parent and child agents.
