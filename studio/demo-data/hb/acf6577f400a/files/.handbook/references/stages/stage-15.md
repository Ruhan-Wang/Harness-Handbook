# Multi-agent, collaboration, and background workflows  `stage-15`

This stage is the system’s “extra workers” layer. It sits behind the main conversation loop and lets one session start helpers, send them messages, wait for them, stop them, or run background work. The agent files define the shared machinery: the module front door, roles and instructions, the registry of live agents, name-to-thread lookup, completion messages, and short status notes. The control files act like a dispatch desk: they limit how many agents run, keep only some threads loaded, and create, fork, reload, resume, or connect agents.

The multi-agent tool files expose this machinery to the assistant. Version 1 and Version 2 tools cover spawning, messaging, follow-up tasks, waiting, listing, interrupting, resuming, and closing agents, with shared helpers for validation and errors. Delegation, review mode, code-mode work, and the Guardian extension use the same pattern to run supervised child agents.

Other background workflows reuse the idea at larger scale: agent jobs split CSV rows across workers and collect results; memory startup extracts and consolidates long-term notes; the skills watcher refreshes available skills when files change.

## Files in this stage

### Agent control foundation
These files define the core agent subsystem, including role application, registry bookkeeping, target resolution, lifecycle orchestration, execution limits, residency management, and session-visible lifecycle messaging.

### `core/src/agent/mod.rs`

`other` · `cross-cutting`

This file does not contain runtime logic itself. Instead, it works like a signpost and service counter for the agent subsystem. In Rust, a `mod.rs` file defines what smaller files belong to a module, and it can choose which items are visible to the rest of the crate.

Here, the agent area is split into focused parts: resolving agents, controlling them, keeping a registry, describing roles, and translating or reporting status. Some of those modules are public within the crate, meaning other core code can use them directly. The registry module stays private, but this file still exposes two specific registry helpers for thread-spawn-depth tracking. That lets the rest of the system use the safe, intended entry points without depending on all registry internals.

It also re-exports `AgentStatus` from the shared protocol package, plus `AgentControl` and `agent_status_from_event`, so callers can import common agent concepts from one place. Without this file, other parts of the program would need to know the exact internal file layout of the agent subsystem, making the code more fragile and harder to navigate.


### `core/src/agent/role.rs`

`config` · `spawn-agent configuration`

When the system creates a sub-agent, the caller may ask for a role such as `explorer` or `worker`. A role is like a job badge: it can add instructions, choose a model, or lock in other settings for that agent. This file does not decide when to create sub-agents. Instead, it answers: “Given this role name, what configuration should the new agent actually use?”

It first looks for a user-defined role, then falls back to built-in roles bundled with the program. If the role points to a role configuration file, the file is read and checked as normal TOML configuration. TOML is a plain text settings format. Relative paths inside that role file are resolved from the right folder, so path-based settings still work.

The important subtlety is precedence. The role’s settings are inserted as a high-priority configuration layer, so they can override saved user config. But the caller’s current model provider and service tier are preserved unless the role explicitly sets them. Without that, spawning a sub-agent could accidentally drop runtime choices and fall back to defaults.

The file also contains the built-in role declarations and a helper that turns all known roles into clear text for the spawn-agent tool.

#### Function details

##### `apply_role_to_config`  (lines 38–54)

```
async fn apply_role_to_config(
    config: &mut Config,
    role_name: Option<&str>,
) -> Result<(), String>
```

**Purpose**: Applies the requested role name to an existing session configuration. If no role is given, it uses the default role; if the role is unknown or cannot be loaded, it returns a user-facing error string.

**Data flow**: It receives a mutable configuration and an optional role name. It chooses the default name when needed, looks up the matching role declaration, and then asks the inner application step to rebuild the configuration. On success, the input configuration is changed in place; on failure, the caller receives a simple error message.

**Call relations**: This is the main entry point for this file’s role-application work. Spawn-agent handling and related tests call it when a new agent needs role-specific settings. It delegates lookup to `resolve_role_config` and the real reload work to `apply_role_to_config_inner`.

*Call graph*: calls 2 internal fn (apply_role_to_config_inner, resolve_role_config); called by 3 (new_default_turn_uses_config_aware_skills_for_role_overrides, handle_spawn_agent, handle_spawn_agent).


##### `apply_role_to_config_inner`  (lines 56–83)

```
async fn apply_role_to_config_inner(
    config: &mut Config,
    role_name: &str,
    role: &AgentRoleConfig,
) -> anyhow::Result<()>
```

**Purpose**: Does the actual work of applying a found role declaration to the current configuration. It loads the role’s configuration layer, decides which runtime choices should be preserved, and replaces the old configuration with the rebuilt one.

**Data flow**: It receives the current configuration, the role name, and the role declaration. If the role has no config file, nothing changes. If it has a config file, that TOML layer is loaded, inspected for keys such as `model_provider` and `service_tier`, and used to build a new configuration. The mutable configuration is then overwritten with that new version.

**Call relations**: `apply_role_to_config` calls this after it has resolved the role name. This function calls `load_role_layer_toml` to get the role settings, then hands those settings to `reload::build_next_config` so the whole configuration stack can be rebuilt cleanly.

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

**Purpose**: Loads and validates the TOML settings for a role. It supports both built-in role files embedded in the program and user-defined role files on disk.

**Data flow**: It receives the current configuration, a role config file path, a flag saying whether the role is built in, and the role name. For built-in roles, it fetches bundled text; for user roles, it reads the file from disk and parses it as an agent role file. It then validates the TOML as configuration and resolves relative paths. The result is a TOML value ready to be inserted as a configuration layer.

**Call relations**: `apply_role_to_config_inner` calls this when a role has an associated config file. It may consult `built_in::config_file_contents` for bundled role files, or use filesystem reading for user files, then relies on the shared config parsing and path-resolution helpers before handing TOML back to the reload path.

*Call graph*: calls 3 internal fn (resolve_relative_paths_in_config_toml, parse_agent_role_file_contents, deserialize_config_toml_with_base); called by 1 (apply_role_to_config_inner); 5 external calls (parent, anyhow!, config_file_contents, read_to_string, from_str).


##### `resolve_role_config`  (lines 119–127)

```
fn resolve_role_config(
    config: &'a Config,
    role_name: &str,
) -> Option<&'a AgentRoleConfig>
```

**Purpose**: Finds the declaration for a role name. User-defined roles take priority over built-in roles with the same name.

**Data flow**: It receives the current configuration and a role name. It first checks the role map stored in the user/session configuration. If nothing is found there, it checks the built-in role map. It returns the matching role declaration if one exists, or nothing if the name is unknown.

**Call relations**: `apply_role_to_config` calls this before attempting to apply a role. Its result decides whether the role application proceeds or whether the caller gets an “unknown agent_type” error.

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

**Purpose**: Rebuilds the full configuration after adding the role layer. This keeps role changes consistent with the same configuration-loading machinery used elsewhere in the application.

**Data flow**: It receives the current configuration, the role’s TOML layer, and two flags saying whether to preserve the current model provider and service tier. It builds a new layer stack, turns the combined settings into a typed config shape, prepares runtime overrides, and loads a fresh `Config`. The output is the new complete configuration.

**Call relations**: `apply_role_to_config_inner` calls this after loading the role TOML. Inside the reload flow, it coordinates `build_config_layer_stack`, `deserialize_effective_config`, and `reload_overrides`, then hands everything to the general config loader.

*Call graph*: 4 external calls (load_config_with_layer_stack, build_config_layer_stack, deserialize_effective_config, reload_overrides).


##### `reload::build_config_layer_stack`  (lines 156–167)

```
fn build_config_layer_stack(
        config: &Config,
        role_layer_toml: &TomlValue,
    ) -> anyhow::Result<ConfigLayerStack>
```

**Purpose**: Creates a new ordered stack of configuration layers with the role layer added at the right priority. A layer stack is like a pile of transparent sheets: higher-priority sheets can cover settings from lower-priority ones.

**Data flow**: It receives the current configuration and the role TOML. It copies the existing layers, creates a new role layer from the TOML, inserts that layer into the correct sorted position, and builds a new `ConfigLayerStack` while preserving existing requirements. The result is a full stack that includes the role settings.

**Call relations**: `reload::build_next_config` calls this first during reload. It relies on `existing_layers` to copy the old stack, `role_layer` to wrap the role TOML, and `insert_layer` to place that new layer correctly.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, existing_layers, insert_layer, role_layer).


##### `reload::deserialize_effective_config`  (lines 169–177)

```
fn deserialize_effective_config(
        config: &Config,
        config_layer_stack: &ConfigLayerStack,
    ) -> anyhow::Result<ConfigToml>
```

**Purpose**: Converts the combined layer stack into the typed configuration format used by the loader. This catches invalid settings after all layers have been merged.

**Data flow**: It receives the current configuration and a completed configuration layer stack. It asks the stack for its effective merged TOML, then deserializes that TOML using the project’s home directory as the base path. The output is a `ConfigToml` value ready for full config loading.

**Call relations**: `reload::build_next_config` calls this after building the updated layer stack. It bridges the generic layer system and the typed config loader.

*Call graph*: calls 2 internal fn (effective_config, deserialize_config_toml_with_base).


##### `reload::existing_layers`  (lines 179–189)

```
fn existing_layers(config: &Config) -> Vec<ConfigLayerEntry>
```

**Purpose**: Copies the current configuration layers so a role can be added without losing the settings that were already active.

**Data flow**: It receives the current configuration. It asks the existing layer stack for all layers from lowest to highest priority, including disabled ones, clones them, and returns them as a vector.

**Call relations**: `reload::build_config_layer_stack` calls this before inserting the role layer. It supplies the starting stack that the role layer is added to.


##### `reload::insert_layer`  (lines 191–195)

```
fn insert_layer(layers: &mut Vec<ConfigLayerEntry>, layer: ConfigLayerEntry)
```

**Purpose**: Places a new configuration layer into an already sorted list of layers. This keeps the layer order stable and predictable.

**Data flow**: It receives a mutable list of layers and the new layer to add. It finds the first position after layers whose names sort before or equal to the new layer’s name, then inserts the new layer there. The input list is changed in place.

**Call relations**: `reload::build_config_layer_stack` calls this when adding the role layer. Its job is small but important: the later `ConfigLayerStack` constructor expects the layers to be in the right order.


##### `reload::role_layer`  (lines 197–199)

```
fn role_layer(role_layer_toml: TomlValue) -> ConfigLayerEntry
```

**Purpose**: Wraps the role TOML as a configuration layer marked as coming from session flags. That source gives the role high precedence over persisted configuration.

**Data flow**: It receives the role’s TOML settings. It creates and returns a `ConfigLayerEntry` whose source is `SessionFlags` and whose contents are the role TOML.

**Call relations**: `reload::build_config_layer_stack` calls this before insertion. The resulting layer is then passed to `insert_layer` and eventually becomes part of the rebuilt configuration stack.

*Call graph*: calls 1 internal fn (new).


##### `reload::reload_overrides`  (lines 201–214)

```
fn reload_overrides(
        config: &Config,
        preserve_current_provider: bool,
        preserve_current_service_tier: bool,
    ) -> ConfigOverrides
```

**Purpose**: Builds the runtime override values that should survive the reload. These are settings chosen by the current session, not necessarily written into the role file.

**Data flow**: It receives the current configuration and two preserve flags. It always carries forward the current working directory and executable paths. It carries forward the current model provider and service tier only when the role did not explicitly set those top-level keys. The output is a `ConfigOverrides` value for the config loader.

**Call relations**: `reload::build_next_config` calls this just before loading the fresh configuration. Its result prevents role application from accidentally resetting important runtime choices.

*Call graph*: 1 external calls (default).


##### `spawn_tool_spec::build`  (lines 221–224)

```
fn build(user_defined_agent_roles: &BTreeMap<String, AgentRoleConfig>) -> String
```

**Purpose**: Builds the text that explains which agent roles are available to the spawn-agent tool. This text helps the main agent choose a valid role name.

**Data flow**: It receives the user-defined role map. It fetches the built-in roles, combines both sources through `build_from_configs`, and returns a formatted string describing the available roles.

**Call relations**: Code that prepares the spawn-agent tool description calls this. It gathers built-in declarations from `built_in::configs` and delegates formatting and duplicate handling to `spawn_tool_spec::build_from_configs`.

*Call graph*: 2 external calls (configs, build_from_configs).


##### `spawn_tool_spec::build_from_configs`  (lines 227–248)

```
fn build_from_configs(
        built_in_roles: &BTreeMap<String, AgentRoleConfig>,
        user_defined_roles: &BTreeMap<String, AgentRoleConfig>,
    ) -> String
```

**Purpose**: Combines user-defined and built-in role declarations into one readable role list. User-defined roles are shown first and can hide built-ins with the same name.

**Data flow**: It receives separate maps for built-in and user-defined roles. It tracks role names it has already included, formats each unique role, and joins the formatted blocks into one instruction string. The result explains the default role and lists all available role names and descriptions.

**Call relations**: `spawn_tool_spec::build` calls this after collecting the two role sources. It calls `spawn_tool_spec::format_role` for each role that should appear in the final text.

*Call graph*: 4 external calls (new, new, format_role, format!).


##### `spawn_tool_spec::format_role`  (lines 250–302)

```
fn format_role(name: &str, declaration: &AgentRoleConfig) -> String
```

**Purpose**: Turns one role declaration into the text shown in the spawn-agent tool description. If the role locks certain settings, it adds notes so the caller knows those settings cannot be changed by a spawn request.

**Data flow**: It receives a role name and its declaration. If there is no description, it returns a simple “no description” line. If there is a description, it may read the role’s config file, parse it, look for fixed `model`, `model_reasoning_effort`, and `service_tier` values, and append explanatory notes. The output is one formatted text block for that role.

**Call relations**: `spawn_tool_spec::build_from_configs` calls this while assembling the available-role list. It may consult `built_in::config_file_contents` for bundled files or read a user role file from disk, then includes any discovered locked-setting notes in the final tool text.

*Call graph*: 1 external calls (format!).


##### `built_in::configs`  (lines 309–370)

```
fn configs() -> &'static BTreeMap<String, AgentRoleConfig>
```

**Purpose**: Provides the built-in role declarations bundled with the program. These include the default role and special-purpose roles such as `explorer` and `worker`.

**Data flow**: It takes no input from the caller. The first time it is used, it constructs a sorted map of built-in role names to their descriptions and optional config files; later calls reuse the cached map. It returns a shared reference to that map.

**Call relations**: `resolve_role_config` uses this as the fallback after user-defined roles. `spawn_tool_spec::build` also uses it when generating the list of roles that can be passed to the spawn-agent tool.

*Call graph*: 1 external calls (new).


##### `built_in::config_file_contents`  (lines 373–381)

```
fn config_file_contents(path: &Path) -> Option<&'static str>
```

**Purpose**: Returns the embedded TOML text for a built-in role config file. This lets built-in roles work without needing separate files on the user’s disk.

**Data flow**: It receives a path from a role declaration. It converts that path to text and checks for known built-in filenames such as `explorer.toml` and `awaiter.toml`. If the name matches, it returns the compiled-in file contents; otherwise it returns nothing.

**Call relations**: `load_role_layer_toml` calls this when applying a built-in role with a config file. `spawn_tool_spec::format_role` also uses it when it wants to inspect a built-in role file for locked model or service-tier settings.

*Call graph*: 2 external calls (to_str, include_str!).


### `core/src/agent/registry.rs`

`domain_logic` · `active during session startup and whenever agents are spawned, queried, updated, or released`

Codex can run a main agent and spawn sub-agents, a bit like a team lead asking helpers to work on separate tasks. This file is the session’s roster and gatekeeper for that team. Without it, Codex could create too many helpers, accidentally reuse the same agent path, lose track of which thread belongs to which agent, or leave behind half-created agents after a failed spawn.

The central type is `AgentRegistry`. It stores live agent records in a mutex, which is a lock that stops two tasks from changing the same roster at the same time. It also keeps an atomic counter, meaning a number that can be safely updated by several threads without a normal lock. Before a new sub-agent is created, code asks the registry for a `SpawnReservation`. This is like putting a temporary hold on a seat: it counts against the limit immediately, and it can also reserve a nickname and path.

If spawning succeeds, the reservation is committed and becomes a real registered agent. If spawning fails or the reservation is dropped, the temporary hold is automatically undone. The file also supports looking up agents by path or thread id, listing live non-root agents, remembering the last task message, and checking spawn depth so sub-agents cannot nest too deeply.

#### Function details

##### `format_agent_nickname`  (lines 44–61)

```
fn format_agent_nickname(name: &str, nickname_reset_count: usize) -> String
```

**Purpose**: Turns a base nickname into the display name Codex should use for an agent. If the nickname pool has been reset, it adds a human-style suffix such as “the 2nd” so reused names stay distinguishable.

**Data flow**: It takes a base name and a reset count. With no resets, it returns the name unchanged. After resets, it calculates the right ordinal suffix and returns a new string like “Scout the 3rd”.

**Call relations**: This is a helper for `AgentRegistry::reserve_agent_nickname`. When the registry needs to offer an unused name, it calls this function to produce the exact nickname text before checking whether that text is already taken.

*Call graph*: called by 1 (reserve_agent_nickname); 1 external calls (format!).


##### `session_depth`  (lines 63–69)

```
fn session_depth(session_source: &SessionSource) -> i32
```

**Purpose**: Finds how deeply nested the current session is in the sub-agent tree. A normal session has depth zero; a thread-spawned sub-agent carries its own recorded depth.

**Data flow**: It receives a session source value. If that source says this session came from a thread spawn, it reads and returns the stored depth. For other session types, it returns zero.

**Call relations**: This is used by `next_thread_spawn_depth`. It provides the current depth so the next spawn can be marked as one level deeper.

*Call graph*: called by 1 (next_thread_spawn_depth).


##### `next_thread_spawn_depth`  (lines 71–73)

```
fn next_thread_spawn_depth(session_source: &SessionSource) -> i32
```

**Purpose**: Calculates the depth that should be assigned to a newly spawned sub-agent. This helps Codex track and limit nested agent spawning.

**Data flow**: It receives the current session source, asks `session_depth` for the current depth, then adds one. The addition is saturating, meaning it avoids overflowing if the number is already extremely large.

**Call relations**: Code preparing a new thread spawn can call this to label the child agent correctly. It depends on `session_depth` to understand where the parent session currently sits.

*Call graph*: calls 1 internal fn (session_depth).


##### `exceeds_thread_spawn_depth_limit`  (lines 75–77)

```
fn exceeds_thread_spawn_depth_limit(depth: i32, max_depth: i32) -> bool
```

**Purpose**: Answers the simple question: is this proposed spawn depth deeper than allowed? It is the yes-or-no check used to enforce nesting limits.

**Data flow**: It takes a proposed depth and the maximum allowed depth. It compares them and returns true if the proposed depth is greater than the limit, otherwise false.

**Call relations**: This function stands alone as a policy check. Spawn-preparation code can use it after calculating the next depth to decide whether to allow or reject another nested agent.


##### `AgentRegistry::reserve_spawn_slot`  (lines 80–97)

```
fn reserve_spawn_slot(
        self: &Arc<Self>,
        max_threads: Option<usize>,
    ) -> Result<SpawnReservation>
```

**Purpose**: Reserves capacity for a new sub-agent before the agent is actually created. This prevents races where two spawns both think there is room and together exceed the session limit.

**Data flow**: It receives an optional maximum thread count. If there is a maximum, it tries to increase the shared counter only if the limit has not been reached; if there is no maximum, it simply increments the counter. On success it returns a `SpawnReservation`; on failure it returns an error saying the agent limit was reached.

**Call relations**: This is the first step in the spawning flow. It calls `AgentRegistry::try_increment_spawned` when a maximum exists, and the returned `SpawnReservation` is later used to reserve names, reserve paths, and either commit or automatically roll back the attempted spawn.

*Call graph*: calls 1 internal fn (try_increment_spawned); 2 external calls (clone, fetch_add).


##### `AgentRegistry::release_spawned_thread`  (lines 99–119)

```
fn release_spawned_thread(&self, thread_id: ThreadId)
```

**Purpose**: Removes a finished spawned agent from the registry and frees its counted slot. This keeps the session roster and the spawn limit counter from drifting upward forever.

**Data flow**: It receives a thread id. It searches the active agent records for that thread, removes the matching record if found, and checks whether it was a non-root agent. If so, it subtracts one from the total spawned count.

**Call relations**: This is used when a spawned thread is no longer active. It updates the same registry that was populated during spawn registration, and it deliberately does not count the root agent as a spawned sub-agent.

*Call graph*: 1 external calls (fetch_sub).


##### `AgentRegistry::register_root_thread`  (lines 121–134)

```
fn register_root_thread(&self, thread_id: ThreadId)
```

**Purpose**: Records the main/root agent thread in the registry. The root agent is tracked for lookup, but it is not treated as a spawned helper for limit counting.

**Data flow**: It receives the root thread id, locks the active-agent roster, and inserts a root-path record if one is not already present. Existing root metadata is left unchanged.

**Call relations**: This runs when the main session thread needs to be known to the registry. Later lookup functions can find the root by path, while listing and counting logic can exclude it where appropriate.


##### `AgentRegistry::agent_id_for_path`  (lines 136–143)

```
fn agent_id_for_path(&self, agent_path: &AgentPath) -> Option<ThreadId>
```

**Purpose**: Looks up which thread id belongs to a given agent path. This lets other code address an agent by its stable path instead of by an internal thread number.

**Data flow**: It receives an `AgentPath`, locks the registry, and searches the agent tree entry for that path string. If the metadata has a thread id, it returns it; otherwise it returns nothing.

**Call relations**: This is a read-only lookup into the roster built by root registration, path reservation, and spawned-thread registration. It uses the path’s string form to find the matching stored record.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentRegistry::agent_metadata_for_thread`  (lines 145–153)

```
fn agent_metadata_for_thread(&self, thread_id: ThreadId) -> Option<AgentMetadata>
```

**Purpose**: Finds the stored information for an agent when the caller knows the thread id. This is useful when an event comes from a thread and Codex needs to know which agent it represents.

**Data flow**: It receives a thread id, locks the registry, scans the stored agent metadata, and returns a cloned copy of the matching metadata if one exists.

**Call relations**: This is a read-only query over the same records inserted by registration. It complements `AgentRegistry::agent_id_for_path`: one lookup starts from a path, this one starts from a thread id.


##### `AgentRegistry::live_agents`  (lines 155–167)

```
fn live_agents(&self) -> Vec<AgentMetadata>
```

**Purpose**: Returns the currently active sub-agents, excluding the root agent. This gives callers a clean list of helper agents that are still running.

**Data flow**: It locks the registry, walks through all metadata records, keeps only records with a thread id and with a path that is not the root path, clones those records, and returns them as a list.

**Call relations**: This is a snapshot-style read of the active roster. It depends on registration adding agents and release removing them, so callers see the current non-root agents at the moment of the lock.


##### `AgentRegistry::update_last_task_message`  (lines 169–181)

```
fn update_last_task_message(&self, thread_id: ThreadId, last_task_message: String)
```

**Purpose**: Stores the latest task message associated with an agent thread. This gives the registry a small memory of what each live agent was most recently asked to do.

**Data flow**: It receives a thread id and a message string. It finds the matching metadata record and replaces that record’s `last_task_message` with the new message. If no matching thread is found, nothing changes.

**Call relations**: This updates metadata already registered for a thread. Other registry readers, such as metadata lookup or live-agent listing, can then see the refreshed task message in the returned metadata.


##### `AgentRegistry::clear_last_task_message`  (lines 183–195)

```
fn clear_last_task_message(&self, thread_id: ThreadId)
```

**Purpose**: Removes the remembered latest task message for an agent thread. This is used when that task marker is no longer current or should no longer be shown.

**Data flow**: It receives a thread id, finds the matching metadata record, and sets its `last_task_message` field to empty. If the thread is not found, it leaves the registry unchanged.

**Call relations**: This is the counterpart to `AgentRegistry::update_last_task_message`. Both functions edit the metadata that lookup and listing functions later return.


##### `AgentRegistry::register_spawned_thread`  (lines 197–214)

```
fn register_spawned_thread(&self, agent_metadata: AgentMetadata)
```

**Purpose**: Turns a successfully spawned agent into a real entry in the registry. This is the point where temporary reservation information becomes official active-agent metadata.

**Data flow**: It receives an `AgentMetadata` value. If the metadata has no thread id, it does nothing. Otherwise it chooses a registry key from the agent path or, if no path exists, from the thread id; records the nickname as used if present; and stores the metadata in the agent tree.

**Call relations**: This is part of the commit path for a spawn reservation. After a spawn has succeeded, `SpawnReservation::commit` hands the final metadata here so future lookup, listing, and release operations can find the agent.


##### `AgentRegistry::reserve_agent_nickname`  (lines 216–254)

```
fn reserve_agent_nickname(&self, names: &[&str], preferred: Option<&str>) -> Option<String>
```

**Purpose**: Chooses and reserves a nickname for an agent before it is fully spawned. This helps avoid two active agents being given the same friendly name.

**Data flow**: It receives a list of possible names and an optional preferred name. If a preferred name is supplied, it uses that directly. Otherwise it formats available names, filters out names already in use, and randomly chooses one. If every name has been used, it clears the used-name set, increments a reset counter, records a metric if metrics are available, and chooses a newly suffixed name. It returns the reserved nickname or nothing if no names are available.

**Call relations**: This is called through `SpawnReservation::reserve_agent_nickname_with_preference`. It relies on `format_agent_nickname` to create names such as reused-name variants, and it updates the registry’s nickname set so later reservations know the name is taken.

*Call graph*: calls 1 internal fn (format_agent_nickname); 2 external calls (global, rng).


##### `AgentRegistry::reserve_agent_path`  (lines 256–273)

```
fn reserve_agent_path(&self, agent_path: &AgentPath) -> Result<()>
```

**Purpose**: Temporarily claims an agent path before the agent exists. This prevents another spawn from taking the same path while the first spawn is still being prepared.

**Data flow**: It receives an `AgentPath`, locks the agent tree, and checks whether that path string already exists. If it does, it returns an error. If not, it inserts placeholder metadata containing the path but no thread id, then returns success.

**Call relations**: This is called through `SpawnReservation::reserve_agent_path` during spawn preparation. If the spawn is later abandoned, the reservation can be removed; if the spawn succeeds, final metadata replaces or completes the active record.

*Call graph*: 5 external calls (default, format!, clone, to_string, UnsupportedOperation).


##### `AgentRegistry::release_reserved_agent_path`  (lines 275–287)

```
fn release_reserved_agent_path(&self, agent_path: &AgentPath)
```

**Purpose**: Removes a path reservation that never became a real running agent. This cleanup prevents failed spawns from blocking that path forever.

**Data flow**: It receives an agent path, locks the registry, and checks the matching record. It only removes the record if it exists and has no thread id, which means it is still just a placeholder reservation.

**Call relations**: This is used by `SpawnReservation::drop` when a reservation is abandoned before commit. It pairs with `AgentRegistry::reserve_agent_path` to make path reservation safe even when spawning fails midway.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentRegistry::try_increment_spawned`  (lines 289–305)

```
fn try_increment_spawned(&self, max_threads: usize) -> bool
```

**Purpose**: Safely increases the spawned-agent counter only if doing so would stay under the configured limit. This is the low-level guard that makes the maximum thread count reliable across concurrent spawns.

**Data flow**: It reads the current atomic count. If the count is already at or above the maximum, it returns false. Otherwise it tries to swap the count to one higher; if another thread changed the count first, it rereads and tries again. On a successful increment, it returns true.

**Call relations**: This is called by `AgentRegistry::reserve_spawn_slot` whenever a maximum thread limit is active. It gives that higher-level reservation function a safe yes-or-no answer about whether a new spawn may proceed.

*Call graph*: called by 1 (reserve_spawn_slot); 2 external calls (compare_exchange_weak, load).


##### `SpawnReservation::reserve_agent_nickname_with_preference`  (lines 316–329)

```
fn reserve_agent_nickname_with_preference(
        &mut self,
        names: &[&str],
        preferred: Option<&str>,
    ) -> Result<String>
```

**Purpose**: Adds a nickname hold to an existing spawn reservation. It lets spawn preparation pick a friendly agent name, optionally honoring a requested preferred name.

**Data flow**: It receives possible names and an optional preferred name. It asks the registry to reserve a nickname; if none can be reserved, it returns an error. On success, it stores the reserved nickname inside the reservation and returns the nickname to the caller.

**Call relations**: The provided call graph shows this being called by `prepare_thread_spawn`. In that flow, after a spawn slot exists, this method claims the nickname that will be used if the new agent is successfully created.

*Call graph*: called by 1 (prepare_thread_spawn).


##### `SpawnReservation::reserve_agent_path`  (lines 331–335)

```
fn reserve_agent_path(&mut self, agent_path: &AgentPath) -> Result<()>
```

**Purpose**: Adds a path hold to an existing spawn reservation. This makes sure the new agent’s address in the agent tree is unique before the spawn finishes.

**Data flow**: It receives an agent path, asks the registry to reserve that path, and if successful stores a copy of the path inside the reservation. It returns success or the registry’s error if the path was already taken.

**Call relations**: The provided call graph shows this being called by `prepare_thread_spawn`. It is the path-reservation step in the same preparation flow that may also reserve a spawn slot and nickname.

*Call graph*: called by 1 (prepare_thread_spawn); 1 external calls (clone).


##### `SpawnReservation::commit`  (lines 337–342)

```
fn commit(mut self, agent_metadata: AgentMetadata)
```

**Purpose**: Finalizes a spawn reservation after the agent has actually been created. Once committed, the reservation will no longer roll itself back when dropped.

**Data flow**: It consumes the reservation and receives the final agent metadata. It clears any temporary nickname and path markers stored on the reservation, registers the spawned thread in the registry, and marks the reservation inactive.

**Call relations**: This is the success path for a reservation. It follows earlier calls that reserved a slot, nickname, or path, and hands the completed metadata into the registry so later lookups and releases treat the agent as live.


##### `SpawnReservation::drop`  (lines 346–353)

```
fn drop(&mut self)
```

**Purpose**: Automatically cleans up an uncommitted spawn reservation. This is Rust’s safety net: if spawn preparation fails or exits early, the reserved count and path do not leak.

**Data flow**: When the reservation object is being destroyed, it checks whether it is still active. If so, it releases any reserved path that was only a placeholder and subtracts one from the total spawned count.

**Call relations**: This runs automatically when a `SpawnReservation` goes out of scope without `SpawnReservation::commit`. It is the rollback partner to the reservation methods, ensuring partial spawn attempts do not leave stale registry state behind.


### `core/src/context/inter_agent_completion_message.rs`

`data_model` · `cross-cutting`

When several agents work together, one agent may need to tell another, “I am done, and here is my final answer.” This file gives that handoff a consistent shape. It stores three pieces of information: the task name, who sent the message, and the actual final payload. Think of it like a labeled envelope: the outside says which task it belongs to and who sent it, and the inside contains the answer.

The struct, `InterAgentCompletionMessage`, is also made into a `ContextualUserFragment`. In plain terms, that means it knows how to present itself as a piece of conversation context for the model. Even though it is a message between agents, its `role` is reported as `assistant`, so it appears as assistant-produced content. It uses no special start or end markers, and its body is formatted with clear labels: message type, task name, sender, and payload.

Without this file, inter-agent completion messages would likely be assembled by hand in multiple places. That would make the format easier to break or accidentally change, which matters because the receiving side depends on a predictable message layout.

#### Function details

##### `InterAgentCompletionMessage::new`  (lines 13–19)

```
fn new(task_name: AgentPath, sender: AgentPath, payload: impl Into<String>) -> Self
```

**Purpose**: Creates a new completion message from a task name, the sending agent, and the final text payload. This is the normal way to package an agent’s completed work before it is inserted into context.

**Data flow**: It receives the task path, sender path, and payload text. The payload can be any value that can be turned into a string, and the function converts it into owned text. It returns a filled `InterAgentCompletionMessage` containing all three pieces.

**Call relations**: When `format_inter_agent_completion_message` needs to build a completion notice, it calls this constructor first. After this object exists, the context-fragment methods can turn it into the text form used downstream.

*Call graph*: called by 1 (format_inter_agent_completion_message); 1 external calls (into).


##### `InterAgentCompletionMessage::role`  (lines 23–25)

```
fn role(&self) -> &'static str
```

**Purpose**: Says which conversation role this fragment should appear under. For this completion message, it always presents the content as coming from the assistant.

**Data flow**: It reads no changing data from the message. It simply returns the fixed text `assistant`.

**Call relations**: This is part of the `ContextualUserFragment` behavior. Code that renders fragments into conversation context can ask this message for its role and use that answer when placing it into the larger prompt or transcript.


##### `InterAgentCompletionMessage::markers`  (lines 27–29)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the start and end markers that should wrap this fragment, if any. This message type uses no wrapping markers.

**Data flow**: It takes the message object, but does not need to inspect its fields. It asks `type_markers` for the marker pair and returns that pair unchanged.

**Call relations**: This is another part of the `ContextualUserFragment` contract. When a renderer wants to know whether to surround this message with special labels, it calls this method, which delegates to `type_markers` so the marker choice is defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `InterAgentCompletionMessage::type_markers`  (lines 31–33)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the marker pair for this kind of fragment. For inter-agent completion messages, both markers are empty strings, meaning no extra wrapper text is added.

**Data flow**: It receives no message-specific input. It returns two fixed empty strings: one for the opening marker and one for the closing marker.

**Call relations**: `markers` calls this function to get the marker pair. Keeping this as a separate type-level method lets the marker choice be reused without needing a particular message instance.


##### `InterAgentCompletionMessage::body`  (lines 35–40)

```
fn body(&self) -> String
```

**Purpose**: Builds the readable text body of the completion message. This is the part that spells out the message type, task name, sender, and final payload.

**Data flow**: It reads the stored task name, sender, and payload from the message. It formats them into a multi-line string with clear labels and returns that string. It does not change the message.

**Call relations**: When context-rendering code needs the actual text of this fragment, it calls `body`. This is where the structured envelope becomes the plain text that another agent or model can read.

*Call graph*: 1 external calls (format!).


### `core/src/session_prefix.rs`

`domain_logic` · `agent status updates and conversation context building`

This file is a small translator between internal agent state and the text that gets placed into the conversation. In this system, some messages are stored as if they came from the user, but they are not really user requests. They are session markers: notes that tell the model things like “this subagent finished,” “this agent failed,” or “here is the list of available subagents.” Without this file, those updates could be inconsistent, too long, or unclear to the model.

The main idea is simple: take structured information, such as an agent name and an AgentStatus, and render it into a standard text shape. For completion messages, the file decides whether there is anything worth saying yet. If an agent is still starting, running, or interrupted, it returns nothing. If the agent completed, errored, shut down, or was not found, it creates a message for the receiving agent to read.

One important safety detail is error length. Error text can be very large, so this file trims it to a token limit. A token is a small chunk of text used by language models. This keeps one failure from flooding the conversation and crowding out useful context. It also adds a suggested next action after an error, so the model knows how to proceed.

#### Function details

##### `format_subagent_notification_message`  (lines 20–25)

```
fn format_subagent_notification_message(
    agent_reference: &str,
    status: &AgentStatus,
) -> String
```

**Purpose**: This function creates a standard notification saying what state a subagent is in. It is used when the system needs to show the model a clear update about a named subagent.

**Data flow**: It receives an agent reference, such as a name or path, and an AgentStatus, which describes the agent’s current state. It copies the status, wraps the reference and status into a SubagentNotification object, then renders that object into plain text. The output is the formatted message that can be inserted into the conversation.

**Call relations**: When the completion watcher is being started, it calls this function to produce the notification text the model should see. This function delegates the exact message shape to SubagentNotification::new and its render step, so the caller does not need to know how the notification is written.

*Call graph*: calls 1 internal fn (new); called by 1 (maybe_start_completion_watcher); 1 external calls (clone).


##### `format_inter_agent_completion_message`  (lines 27–44)

```
fn format_inter_agent_completion_message(
    task_name: AgentPath,
    sender: AgentPath,
    status: &AgentStatus,
) -> Option<String>
```

**Purpose**: This function creates a message from one agent to another when a task reaches a meaningful end state. It also decides when no message should be sent yet, such as while the agent is still running.

**Data flow**: It receives the task name, the sending agent, and the sender’s status. If the status is completed, it uses the completion message if one exists, or an empty message if not. If the status is errored, it trims the error text to a safe length and adds guidance about what to do next. If the status says the agent shut down or was not found, it creates a short explanation. If the status is still pending, running, or interrupted, it returns no message. When there is a payload, it wraps the task name, sender, and payload into an InterAgentCompletionMessage and renders it as text.

**Call relations**: Several parts of the multi-agent flow call this when they need to tell another agent that a child or collaborator has finished, failed, disappeared, or shut down. The completion watcher uses it during status monitoring, and parent-child forwarding paths use it when relaying a child agent’s result back upward. It hands off final formatting to InterAgentCompletionMessage so every completion notice has the same structure.

*Call graph*: calls 1 internal fn (new); called by 4 (maybe_start_completion_watcher, multi_agent_v2_completion_queues_message_for_direct_parent, forward_child_completion_to_parent, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn); 4 external calls (new, truncate_text, format!, Tokens).


##### `format_subagent_context_line`  (lines 50–58)

```
fn format_subagent_context_line(
    agent_reference: &str,
    agent_nickname: Option<&str>,
) -> String
```

**Purpose**: This function formats one line in a simple list of subagents. It lets the context show an agent reference by itself, or with a friendly nickname when one is available.

**Data flow**: It receives an agent reference and an optional nickname. If the nickname exists and is not empty, it returns a line like “- reference: nickname.” If there is no nickname, or the nickname is blank, it returns just “- reference.” The only output is that one formatted text line.

**Call relations**: This is a helper used when building model-visible context about available subagents. It does not call into the larger agent workflow; it simply provides a consistent list format for whatever code is assembling that context.

*Call graph*: 1 external calls (format!).


### `core/src/agent/control/execution.rs`

`domain_logic` · `request handling`

This file is a safety gate for multi-agent execution. In this system, an agent can have sub-agents, and those sub-agents can start their own turns of work. Without a limit, a busy or badly behaved session could create too many simultaneous running threads, using too much memory or compute. This file keeps that under control.

The main idea is like a room with a maximum occupancy sign. Before a sub-agent starts a new turn, `AgentControl` asks whether there is still room. If the operation is not the kind that begins a turn, it is allowed through immediately. If the thread already has an active turn, it is also allowed, because it is not starting a new one. Otherwise, the code checks whether this session is the kind that should be limited: specifically, version 2 multi-agent sessions where the session is a sub-agent.

The actual counter lives in `AgentExecutionLimiter`. It stores the maximum allowed count and an atomic active count. “Atomic” means the number can be safely changed by multiple tasks at the same time without corrupting it. When execution starts, an `AgentExecutionGuard` is created and the active count goes up. When that guard is dropped, usually because the work finished, the count goes back down automatically.

#### Function details

##### `AgentExecutionGuard::drop`  (lines 24–26)

```
fn drop(&mut self)
```

**Purpose**: This automatically releases one execution slot when a guarded agent execution ends. It exists so callers do not have to remember to manually decrement the active count.

**Data flow**: It reads the limiter stored inside the guard, subtracts one from the shared active-execution counter, and returns nothing. The before state is “this execution is counted as active”; the after state is “one fewer execution is counted as active.”

**Call relations**: This is triggered by Rust automatically when an `AgentExecutionGuard` goes out of scope. The guard is created by `AgentExecutionLimiter::guard`, so these two functions work as a pair: one claims a slot, and this one gives it back.


##### `AgentControl::ensure_execution_capacity_for_op`  (lines 30–48)

```
async fn ensure_execution_capacity_for_op(
        &self,
        thread_id: ThreadId,
        op: &Op,
    ) -> CodexResult<()>
```

**Purpose**: This checks whether a specific incoming operation is allowed to start a new agent turn. It is the higher-level check that understands both the operation and the current thread state.

**Data flow**: It receives a thread id and an operation. First it asks `op_starts_turn` whether the operation would begin a turn; if not, it approves it. If it might begin a turn, it looks up the thread, checks whether that thread already has an active turn, reads the session configuration, decides which multi-agent version applies, and then passes that information to `ensure_execution_capacity`. The output is either success or an error saying the agent limit has been reached.

**Call relations**: This is the front door for capacity checking when an operation arrives. It uses `op_starts_turn` as a quick filter, then calls `AgentControl::ensure_execution_capacity` only when a new turn may actually be starting.

*Call graph*: calls 2 internal fn (ensure_execution_capacity, op_starts_turn).


##### `AgentControl::ensure_execution_capacity`  (lines 50–64)

```
fn ensure_execution_capacity(
        &self,
        multi_agent_version: MultiAgentVersion,
        session_source: &SessionSource,
    ) -> CodexResult<()>
```

**Purpose**: This enforces the active-execution limit for sessions that are supposed to be limited. If the limit does not apply, it lets the execution continue.

**Data flow**: It receives the multi-agent protocol version and the session source. It asks `is_execution_limited` whether this kind of session should count against the limit. If not, it returns success. If yes, it reads the maximum allowed thread count and checks whether the limiter still has capacity. It returns success when there is room, or a `CodexErr::AgentLimitReached` error with the configured maximum when there is not.

**Call relations**: This is called by `AgentControl::ensure_execution_capacity_for_op` after that function has determined that a new turn may be starting. It relies on `is_execution_limited` to decide whether the shared limiter should matter for this session.

*Call graph*: calls 1 internal fn (is_execution_limited); called by 1 (ensure_execution_capacity_for_op).


##### `AgentControl::execution_guard`  (lines 66–73)

```
fn execution_guard(
        &self,
        multi_agent_version: MultiAgentVersion,
        session_source: &SessionSource,
    ) -> Option<AgentExecutionGuard>
```

**Purpose**: This creates a guard object when an execution should be counted against the limit. The guard keeps the active count accurate for the lifetime of the execution.

**Data flow**: It receives the multi-agent version and session source. It checks `is_execution_limited`; if the session is not limited, it returns `None`. If the session is limited, it clones the shared limiter, increments the active count through `AgentExecutionLimiter::guard`, and returns the new guard wrapped in `Some`.

**Call relations**: This is used when execution is actually beginning, after capacity has been checked. It uses the same `is_execution_limited` rule as `ensure_execution_capacity`, so only limited sub-agent executions take a slot.

*Call graph*: calls 1 internal fn (is_execution_limited).


##### `AgentExecutionLimiter::initialize`  (lines 77–79)

```
fn initialize(&self, max_threads: usize)
```

**Purpose**: This sets the maximum number of active limited executions. It only sets the value once, so later attempts do not overwrite the original limit.

**Data flow**: It receives a maximum thread count. If the limiter does not already have a maximum, it stores that number; if one is already present, it leaves the existing value unchanged. It returns nothing.

**Call relations**: This prepares the limiter before it is used by capacity checks and guards. Later functions such as `AgentExecutionLimiter::max_threads` read the value that was stored here.

*Call graph*: 1 external calls (get_or_init).


##### `AgentExecutionLimiter::max_threads`  (lines 81–83)

```
fn max_threads(&self) -> usize
```

**Purpose**: This returns the configured maximum number of limited executions. If no maximum has been initialized, it behaves as though there is no practical limit.

**Data flow**: It reads the stored maximum thread count. If a value exists, it returns that value. If no value has been set, it returns `usize::MAX`, an extremely large number used here as “effectively unlimited.”

**Call relations**: This is used by `AgentExecutionLimiter::has_capacity` to compare the active count with the allowed maximum. It is also used indirectly when `AgentControl::ensure_execution_capacity` prepares an error that tells the caller what the maximum is.

*Call graph*: called by 1 (has_capacity); 1 external calls (get).


##### `AgentExecutionLimiter::has_capacity`  (lines 85–87)

```
fn has_capacity(&self) -> bool
```

**Purpose**: This answers the simple question: is there still room for one more limited execution?

**Data flow**: It reads the current active-execution count and the maximum from `max_threads`. If the active count is lower than the maximum, it returns `true`; otherwise it returns `false`. It does not change the count.

**Call relations**: This is used during capacity checks before a new limited execution is allowed to start. It calls `AgentExecutionLimiter::max_threads` so it always compares against the configured limit.

*Call graph*: calls 1 internal fn (max_threads); 1 external calls (load).


##### `AgentExecutionLimiter::guard`  (lines 89–92)

```
fn guard(self: Arc<Self>) -> AgentExecutionGuard
```

**Purpose**: This claims one execution slot and returns a guard that will release the slot later. It is the mechanism that keeps the active count tied to real running work.

**Data flow**: It receives a shared limiter, adds one to the active-execution counter, and returns an `AgentExecutionGuard` holding that limiter. The before state is “one slot is about to be used”; the after state is “the slot is counted as active and will be released when the guard is dropped.”

**Call relations**: This is called by `AgentControl::execution_guard` when a limited execution starts. Its counterpart is `AgentExecutionGuard::drop`, which subtracts from the same counter when the execution ends.

*Call graph*: 1 external calls (fetch_add).


##### `op_starts_turn`  (lines 95–98)

```
fn op_starts_turn(op: &Op) -> bool
```

**Purpose**: This identifies which operations can begin a new agent turn. It keeps the limit check from running for operations that cannot start execution.

**Data flow**: It receives an operation. It returns `true` for direct user input, and for inter-agent communication only when that communication explicitly says it should trigger a turn. For all other operations, it returns `false`.

**Call relations**: This is called by `AgentControl::ensure_execution_capacity_for_op` as the first filter. If it says the operation does not start a turn, the larger capacity-check path is skipped.

*Call graph*: called by 1 (ensure_execution_capacity_for_op); 1 external calls (matches!).


##### `is_execution_limited`  (lines 100–106)

```
fn is_execution_limited(
    multi_agent_version: MultiAgentVersion,
    session_source: &SessionSource,
) -> bool
```

**Purpose**: This decides whether a session should be subject to the active-execution limit. In this file, only version 2 sub-agent sessions are limited.

**Data flow**: It receives a multi-agent version and a session source. It returns `true` only when the version is `MultiAgentVersion::V2` and the session source says this is a sub-agent. Otherwise it returns `false`.

**Call relations**: This is the shared rule used by both `AgentControl::ensure_execution_capacity` and `AgentControl::execution_guard`. That keeps the “should this count against the limit?” decision consistent between checking capacity and actually claiming a slot.

*Call graph*: called by 2 (ensure_execution_capacity, execution_guard); 1 external calls (matches!).


### `core/src/agent/control/residency.rs`

`domain_logic` · `request handling and agent-thread lifecycle`

This file solves a capacity problem. The system may create many sub-agent threads, but it should not keep unlimited version-2 sub-agents loaded at once. Think of it like a small parking lot: before a new car enters, the lot checks whether there is space; if not, it asks an old parked car that is no longer in use to leave.

The main record is V2Residency. It stores two things behind a mutex, which is a lock that stops two tasks from changing the same list at the same time: a queue of resident thread IDs, and a count of slots that have been reserved but not yet filled. The queue is ordered like a “least recently used” list. Recently touched threads move to the back, while older candidates are checked first for unloading.

A caller does not directly add a thread. It first reserves a V2ResidencySlot. If there is room, the slot is held as pending. If there is no room, the code tries to unload one eligible resident thread. Only completed, errored, or interrupted sub-agent threads with no active turn and no queued mailbox work may be unloaded. When the new thread is actually ready, the slot is committed with its thread ID. If the reservation is dropped before commit, it automatically releases its pending space, which prevents leaked capacity.

#### Function details

##### `V2ResidencySlot::commit`  (lines 33–36)

```
fn commit(mut self, thread_id: ThreadId)
```

**Purpose**: This confirms that a previously reserved place is now occupied by a real thread. It records the thread as resident and stops the reservation from being automatically released later.

**Data flow**: It receives the slot object and the new thread ID. It tells the shared residency tracker to turn one pending slot into a real resident entry, then marks this slot as no longer active. After this, dropping the slot object will not free anything.

**Call relations**: This is used after AgentControl::reserve_v2_residency_slot has successfully made room for a thread. It hands the final thread ID to V2Residency::commit_slot so the residency queue reflects the loaded thread.


##### `V2ResidencySlot::drop`  (lines 40–44)

```
fn drop(&mut self)
```

**Purpose**: This is the safety cleanup for a reserved slot that was never committed. It prevents the system from permanently thinking space is reserved when the thread was not actually loaded.

**Data flow**: When the slot object is destroyed, it checks whether it is still active. If it is active, it tells the residency tracker to reduce the pending-slot count. If it was already committed, it changes nothing.

**Call relations**: This works automatically as part of Rust’s drop behavior. It backs up the reservation flow started by V2Residency::reserve_slot and calls V2Residency::release_pending_slot when the caller abandons the reservation.


##### `AgentControl::reserve_v2_residency_slot`  (lines 48–60)

```
async fn reserve_v2_residency_slot(
        &self,
        state: &Arc<ThreadManagerState>,
        config: &Config,
        protected_thread_id: Option<ThreadId>,
    ) -> CodexResult<V2ResidencySlot
```

**Purpose**: This is the entry point AgentControl uses when it wants to load a version-2 resident sub-agent. It checks the configured maximum number of such threads, then asks the residency tracker to reserve space.

**Data flow**: It receives the thread manager state, configuration, and an optional thread ID that should not be unloaded. It reads the configured V2 thread limit, using an effectively unlimited number if no limit is set. It returns either a reserved V2ResidencySlot or an error saying the limit has been reached.

**Call relations**: Higher-level agent-control code calls this before loading a V2 resident thread. It uses the shared V2Residency object and delegates the real capacity work to V2Residency::reserve_slot.

*Call graph*: 2 external calls (clone, effective_agent_max_threads).


##### `AgentControl::touch_loaded_v2_residency`  (lines 62–72)

```
async fn touch_loaded_v2_residency(
        &self,
        state: &Arc<ThreadManagerState>,
        thread_id: ThreadId,
    )
```

**Purpose**: This tells the residency tracker that a loaded thread was recently used, but only if that thread is the kind that should count as a V2 resident. This keeps active or recently relevant threads from being treated as the oldest unload candidates.

**Data flow**: It receives the thread manager state and a thread ID. It tries to look up the thread, checks whether it qualifies as a V2 resident candidate, and if so moves that thread ID to the recently used end of the residency queue. It does not return a value.

**Call relations**: AgentControl calls this when a loaded thread should be refreshed in the residency list. It relies on is_resident_candidate to avoid tracking unrelated threads, then calls into V2Residency::touch through the shared residency tracker.

*Call graph*: calls 1 internal fn (is_resident_candidate).


##### `AgentControl::forget_v2_residency`  (lines 74–76)

```
fn forget_v2_residency(&self, thread_id: ThreadId)
```

**Purpose**: This removes a thread from the V2 residency list when it should no longer be considered loaded or resident. It keeps the residency tracker from holding stale thread IDs.

**Data flow**: It receives a thread ID and asks the shared residency tracker to remove that ID from its queue. Nothing is returned; the internal list is simply cleaned up.

**Call relations**: AgentControl uses this during thread cleanup or when a thread is no longer part of residency accounting. It delegates the actual removal to V2Residency::remove.


##### `V2Residency::reserve_slot`  (lines 80–102)

```
async fn reserve_slot(
        self: Arc<Self>,
        manager: &Arc<ThreadManagerState>,
        capacity: usize,
        protected_thread_id: Option<ThreadId>,
    ) -> CodexResult<V2ResidencySlot>
```

**Purpose**: This is the main capacity gate. It either reserves space for a new resident thread, unloads an old eligible resident to make space, or reports that no space can be made.

**Data flow**: It receives the thread manager, the maximum allowed capacity, and an optional protected thread ID. It first tries to increase the pending-slot count. If that fails because the limit is full, it tries to unload one existing resident thread, avoiding the protected one. It returns a live V2ResidencySlot on success or an AgentLimitReached error if it cannot make room.

**Call relations**: AgentControl::reserve_v2_residency_slot calls this when a new V2 resident may be loaded. It loops between V2Residency::try_reserve_pending_slot and V2Residency::try_unload_one_resident until either a reservation succeeds or unloading is impossible.

*Call graph*: calls 2 internal fn (try_reserve_pending_slot, try_unload_one_resident).


##### `V2Residency::try_reserve_pending_slot`  (lines 104–114)

```
fn try_reserve_pending_slot(&self, capacity: usize) -> bool
```

**Purpose**: This checks whether there is room for one more resident or soon-to-be resident thread. If there is room, it temporarily claims that space.

**Data flow**: It reads the current resident count and pending reservation count under a mutex lock. If their total is already at capacity, it returns false. Otherwise it adds one to the pending count and returns true.

**Call relations**: V2Residency::reserve_slot calls this before trying any unloading. A true result means the caller can proceed with loading; a false result means reserve_slot must try to free space.

*Call graph*: called by 1 (reserve_slot).


##### `V2Residency::try_unload_one_resident`  (lines 116–150)

```
async fn try_unload_one_resident(
        &self,
        manager: &Arc<ThreadManagerState>,
        protected_thread_id: Option<ThreadId>,
    ) -> bool
```

**Purpose**: This tries to free one residency slot by unloading an older resident thread that is safe to remove. It is careful not to kill work that is still active or waiting to be handled.

**Data flow**: It receives the thread manager and an optional protected thread ID. It scans the current resident queue, oldest first, skipping the protected thread. For each candidate, it looks up the thread, verifies it still qualifies as a resident candidate, checks that it is unloadable, materializes rollout data, shuts the thread down, and removes it from the manager. It returns true if one thread was removed, otherwise false.

**Call relations**: V2Residency::reserve_slot calls this after a direct reservation fails. This function uses resident_count and pop_lru_candidate to pick candidates, is_unloadable to check safety, touch to re-mark candidates that cannot be removed now, and logs a warning if shutdown fails.

*Call graph*: calls 4 internal fn (pop_lru_candidate, resident_count, touch, is_unloadable); called by 1 (reserve_slot); 1 external calls (warn!).


##### `V2Residency::resident_count`  (lines 152–158)

```
fn resident_count(&self) -> usize
```

**Purpose**: This reports how many thread IDs are currently listed as V2 residents. It is used to decide how many candidates should be scanned during one unloading attempt.

**Data flow**: It locks the residency state, reads the length of the resident queue, and returns that number. It does not change the queue.

**Call relations**: V2Residency::try_unload_one_resident calls this at the start so it scans only the residents that existed when the unload attempt began, rather than looping forever as entries are moved around.

*Call graph*: called by 1 (try_unload_one_resident).


##### `V2Residency::pop_lru_candidate`  (lines 160–175)

```
fn pop_lru_candidate(&self, protected_thread_id: Option<ThreadId>) -> Option<ThreadId>
```

**Purpose**: This chooses the oldest resident candidate for possible unloading. It avoids a protected thread by putting that thread back at the recent end of the queue and continuing the search.

**Data flow**: It locks the resident queue and repeatedly takes a thread ID from the front, which represents the least recently used entry. If that ID matches the protected ID, it pushes it to the back and tries another. Otherwise it returns that ID. If no usable candidate exists, it returns nothing.

**Call relations**: V2Residency::try_unload_one_resident calls this while searching for a thread to unload. The returned ID is then checked against the thread manager and safety rules before any shutdown happens.

*Call graph*: called by 1 (try_unload_one_resident).


##### `V2Residency::touch`  (lines 177–183)

```
fn touch(&self, thread_id: ThreadId)
```

**Purpose**: This marks a resident thread as recently used. It helps the unloading policy prefer older, less recently touched threads.

**Data flow**: It receives a thread ID, locks the residency state, removes any existing copy of that ID from the queue, and appends it to the back. The result is an updated queue with that thread treated as newest.

**Call relations**: AgentControl::touch_loaded_v2_residency uses this through the shared residency tracker, and V2Residency::try_unload_one_resident uses it when a candidate cannot be unloaded right now. It delegates the queue update to touch_resident.

*Call graph*: calls 1 internal fn (touch_resident); called by 1 (try_unload_one_resident).


##### `V2Residency::remove`  (lines 185–191)

```
fn remove(&self, thread_id: ThreadId)
```

**Purpose**: This deletes a thread ID from the residency queue. It is used when a thread should no longer count as resident.

**Data flow**: It receives a thread ID, locks the residency state, and keeps only resident IDs that are not equal to the given one. It returns nothing and leaves the queue without that entry.

**Call relations**: AgentControl::forget_v2_residency calls this when outside code knows a thread has gone away or should be forgotten. It is a cleanup path separate from the unload path.


##### `V2Residency::commit_slot`  (lines 193–200)

```
fn commit_slot(&self, thread_id: ThreadId)
```

**Purpose**: This converts a pending reservation into an actual resident thread entry. It is the point where a reserved space becomes tied to a specific thread ID.

**Data flow**: It receives the thread ID for the loaded thread. Under the mutex lock, it reduces the pending-slot count by one, then moves or adds the thread ID to the recently used end of the resident queue. It does not return a value.

**Call relations**: V2ResidencySlot::commit calls this after loading succeeds. It uses touch_resident so the newly committed thread is recorded as resident and considered recently used.

*Call graph*: calls 1 internal fn (touch_resident).


##### `V2Residency::release_pending_slot`  (lines 202–208)

```
fn release_pending_slot(&self)
```

**Purpose**: This gives back a reserved slot that was not used. It keeps failed or abandoned load attempts from consuming capacity forever.

**Data flow**: It locks the residency state and reduces the pending-slot count by one, using a safe subtraction that will not go below zero. It returns nothing.

**Call relations**: V2ResidencySlot::drop calls this automatically when a reserved slot is discarded without commit. This is the cleanup counterpart to V2Residency::try_reserve_pending_slot.


##### `touch_resident`  (lines 211–214)

```
fn touch_resident(residents: &mut VecDeque<ThreadId>, thread_id: ThreadId)
```

**Purpose**: This is the small queue helper that marks a thread as most recently used. It also prevents duplicate copies of the same thread ID in the residency queue.

**Data flow**: It receives the mutable resident queue and a thread ID. It removes any existing matching ID, then appends the ID to the back of the queue. The queue now contains that ID once, in the newest position.

**Call relations**: V2Residency::touch and V2Residency::commit_slot both use this helper so they update the least-recently-used queue in exactly the same way.

*Call graph*: called by 2 (commit_slot, touch); 2 external calls (push_back, retain).


##### `is_resident_candidate`  (lines 216–219)

```
fn is_resident_candidate(thread: &CodexThread) -> bool
```

**Purpose**: This decides whether a thread belongs in this V2 residency system at all. Only version-2 threads that came from the right kind of session source are tracked.

**Data flow**: It receives a CodexThread. It reads the thread’s multi-agent version and its session source. It returns true only when the version is V2 and the session source is accepted for V2 residency.

**Call relations**: AgentControl::touch_loaded_v2_residency uses this before touching a loaded thread, and V2Residency::try_unload_one_resident uses the same idea when checking whether a candidate is still relevant. It delegates the session-source check to is_v2_resident_session_source.

*Call graph*: calls 2 internal fn (is_v2_resident_session_source, multi_agent_version); called by 1 (touch_loaded_v2_residency).


##### `is_v2_resident_session_source`  (lines 221–223)

```
fn is_v2_resident_session_source(session_source: &SessionSource) -> bool
```

**Purpose**: This identifies which session sources should count as V2 resident sessions. In this file, only sub-agent sessions qualify.

**Data flow**: It receives a session source value and checks its variant. It returns true for SubAgent sources and false for all others.

**Call relations**: is_resident_candidate calls this as one part of deciding whether a thread should be tracked by the V2 residency rules.

*Call graph*: called by 1 (is_resident_candidate); 1 external calls (matches!).


##### `is_unloadable`  (lines 225–236)

```
async fn is_unloadable(thread: &CodexThread) -> bool
```

**Purpose**: This checks whether it is safe to unload a thread. A thread must be finished or stopped, with no active turn and no pending mailbox work.

**Data flow**: It receives a CodexThread. It reads the thread’s agent status, checks whether the session currently has an active turn, and asks the input queue whether any mailbox items are waiting. It returns true only when the thread is completed, errored, or interrupted, has no active turn, and has no pending mailbox items.

**Call relations**: V2Residency::try_unload_one_resident calls this before shutting down a candidate. If it returns false, the candidate is touched again so it moves to the recent end of the queue instead of being unloaded.

*Call graph*: called by 1 (try_unload_one_resident); 1 external calls (matches!).


### `core/src/agent/control/spawn.rs`

`orchestration` · `active when agent threads are spawned, forked, resumed, or reloaded`

This file solves a practical coordination problem: agents can create other agents, resume old conversations, or fork from an existing conversation. Without this code, the system would not know how many agents are allowed to run, what history a child agent should see, what environment settings it should inherit, or how to reconnect saved agent threads after a restart.

The file first provides small helpers for choosing agent nicknames and deciding which parts of a parent conversation are safe to copy into a fork. A fork is like making a new notebook from an old one: this code copies only the useful pages, removes internal tool chatter, and may add a fresh instruction note for newer multi-agent behavior.

The main methods live on `AgentControl`. They reserve capacity before starting an agent, so the system does not create too many threads. They decide whether the new agent is a normal thread, a subagent spawned by another thread, or a fork with selected history. They also carry over inherited turn environments and execution policy, which are the settings and rules the new agent should follow.

For saved conversations, the file can reload a version-2 resident agent or resume an agent from its recorded rollout history. After a thread is created or resumed, it records parent-child links, notifies listeners, sends the first operation, and, for older multi-agent mode, starts a watcher that notices when the child finishes.

#### Function details

##### `default_agent_nickname_list`  (lines 11–17)

```
fn default_agent_nickname_list() -> Vec<&'static str>
```

**Purpose**: Builds the built-in list of possible agent nicknames. These names come from a bundled text file and are used when configuration does not provide custom names.

**Data flow**: It reads the embedded `agent_names.txt` text → splits it into lines, trims whitespace, and skips blank lines → returns a list of non-empty nickname strings.

**Call relations**: When the system needs nickname candidates and the role configuration does not supply any, `agent_nickname_candidates` calls this helper to fall back to the default name list.

*Call graph*: called by 1 (agent_nickname_candidates).


##### `agent_nickname_candidates`  (lines 19–31)

```
fn agent_nickname_candidates(config: &Config, role_name: Option<&str>) -> Vec<String>
```

**Purpose**: Finds the list of nicknames that may be used for a spawned agent. It first respects role-specific configuration, and only uses the built-in nickname list if no custom list exists.

**Data flow**: It receives the global configuration and an optional role name → looks up that role’s nickname candidates, using the default role when no role is named → returns configured nicknames if found, otherwise returns owned strings made from the default nickname list.

**Call relations**: This is used by `prepare_thread_spawn` when preparing metadata for a thread-spawned agent. It calls `default_agent_nickname_list` only as the fallback path.

*Call graph*: calls 1 internal fn (default_agent_nickname_list); called by 1 (prepare_thread_spawn).


##### `keep_forked_rollout_item`  (lines 33–65)

```
fn keep_forked_rollout_item(item: &RolloutItem, preserve_reference_context_item: bool) -> bool
```

**Purpose**: Decides whether one saved conversation item should be copied into a forked agent’s starting history. Its job is to keep meaningful context while leaving out internal details that would confuse or bloat the child agent’s prompt.

**Data flow**: It receives one rollout item and a flag saying whether reference context should be preserved → checks what kind of item it is → returns `true` for durable context such as system, developer, and user messages, final assistant answers, metadata, compaction records, and sometimes turn context; returns `false` for tool calls, reasoning traces, inter-agent messages, and other internal activity.

**Call relations**: During fork creation, the fork-building flow uses this decision to trim the parent history before creating the child thread. It acts like a filter at the doorway: only suitable history is allowed into the new fork.


##### `is_multi_agent_v2_usage_hint_message`  (lines 67–81)

```
fn is_multi_agent_v2_usage_hint_message(item: &ResponseItem, usage_hint_texts: &[String]) -> bool
```

**Purpose**: Detects a specific kind of developer message that contains a multi-agent version-2 usage hint. This matters because forked history should not accidentally carry old usage hints that may no longer fit the new child agent.

**Data flow**: It receives a response item and a list of hint texts to look for → verifies the item is a developer message with exactly one text content block → returns `true` only if that text exactly matches one of the known usage hints.

**Call relations**: The fork-building flow uses this helper while cleaning copied history. It removes old hint messages, and later may add the correct fresh hint for the new subagent.


##### `AgentControl::spawn_agent`  (lines 86–100)

```
async fn spawn_agent(
        &self,
        config: Config,
        initial_operation: Op,
        session_source: Option<SessionSource>,
    ) -> CodexResult<ThreadId>
```

**Purpose**: Starts a new agent thread and returns only its thread ID. This is a simpler wrapper used in tests, where callers only need to know which thread was created.

**Data flow**: It receives a configuration, an initial operation to send to the agent, and an optional session source that explains where the agent came from → forwards those values to `spawn_agent_internal` with default spawn options → returns the new thread ID from the created live agent.

**Call relations**: This is a thin entry point into the full spawning machinery. It relies on `spawn_agent_internal` to do the real work: capacity checks, thread creation, notifications, persistence, and sending the first input.

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

**Purpose**: Starts a new agent thread and returns richer information about it, not just the thread ID. Callers use this when they need the new agent’s metadata and current status.

**Data flow**: It receives configuration, the initial operation, an optional session source, and spawn options → passes them into `spawn_agent_internal` → returns a `LiveAgent`, which includes the thread ID, metadata, and status.

**Call relations**: This is the public internal path for callers that need detailed spawn results. Like `spawn_agent`, it delegates the actual orchestration to `spawn_agent_internal`.

*Call graph*: calls 1 internal fn (spawn_agent_internal); 1 external calls (pin).


##### `AgentControl::ensure_v2_agent_loaded`  (lines 114–192)

```
async fn ensure_v2_agent_loaded(
        &self,
        config: Config,
        thread_id: ThreadId,
    ) -> CodexResult<()>
```

**Purpose**: Makes sure a saved version-2 agent thread is loaded into memory and ready to use. If it is already loaded, it refreshes its residency; if not, it reloads it from stored history.

**Data flow**: It receives a configuration and a thread ID → checks whether the thread is already active → if not, confirms metadata exists, reads the stored thread and its history, verifies it is a version-2 multi-agent thread, reserves a residency slot, restores the session source and parent link, inherits environment and execution policy settings, and resumes the thread from history → commits the residency slot and notifies the system that the thread exists again. If the thread cannot be found or is not version 2, it returns a not-found error.

**Call relations**: This method is used when a version-2 resident agent may need to be brought back into active memory. It hands the actual thread reconstruction to the thread manager’s resume path, then notifies listeners after the reload succeeds.

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

**Purpose**: Does the full work of creating a new agent. It decides the multi-agent mode, reserves capacity, prepares metadata, creates or forks the thread, records parent-child relationships, sends the first operation, and returns the live agent information.

**Data flow**: It receives the configuration, initial operation, optional session source, and spawn options → upgrades access to shared thread-manager state, determines which multi-agent version applies, checks execution capacity, reserves the right kind of slot, inherits environment and execution policy settings, and prepares subagent metadata if this is a thread-spawned agent → creates either a normal thread, a sourced subagent thread, or a forked thread → commits reservations, emits analytics for subagent starts, notifies listeners, persists the spawn edge, sends the initial input, possibly starts a completion watcher, and returns a `LiveAgent`.

**Call relations**: Both `AgentControl::spawn_agent` and `AgentControl::spawn_agent_with_metadata` call this method. When the options request a fork, it hands the history-copying part to `AgentControl::spawn_forked_thread`; otherwise it asks the thread manager to create a fresh thread.

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

**Purpose**: Creates a new subagent thread by copying selected history from a parent thread. This is used when a child agent should start with context from its parent, rather than with a blank conversation.

**Data flow**: It receives shared thread-manager state, configuration, a session source, spawn options, inherited settings, and the multi-agent version → validates that the request really is a fork from a thread-spawned parent → flushes the parent’s saved rollout so the snapshot is current → reads the parent’s stored history → optionally truncates it to the last few turns → removes internal or inappropriate items, including old version-2 usage hints → optionally appends a fresh subagent usage hint → asks the thread manager to create a forked thread with that cleaned history and inherited settings → returns the newly created thread.

**Call relations**: `AgentControl::spawn_agent_internal` calls this when spawning with fork options. This method prepares the starting history, then hands off to the thread manager to actually make the forked thread.

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

**Purpose**: Restores an agent thread from its recorded rollout file, and in older multi-agent mode also tries to restore its open descendant subagents. A rollout is the saved conversation record used to reconstruct a thread.

**Data flow**: It receives configuration, a thread ID, and a session source → resumes that one thread through `resume_single_agent_from_rollout` → if version-2 behavior is in use, stops there → otherwise reads persisted child-spawn edges from storage, walks through open children in a queue, and resumes each missing child thread with the correct parent and depth information → returns the ID of the originally resumed thread.

**Call relations**: This method is the higher-level resume flow. It calls `resume_single_agent_from_rollout` for the root thread first, then repeatedly calls the same helper for child threads discovered in storage.

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

**Purpose**: Restores one saved agent thread from its stored history. It rebuilds enough in-memory state so the thread can continue as if it had been loaded normally.

**Data flow**: It receives configuration, a thread ID, and a session source → reads the stored thread and its history → wraps that history as resumed initial history → determines the applicable multi-agent version and reserves spawn capacity → reconstructs subagent metadata when the source says this was a thread-spawned agent, including saved nickname or role when available → inherits environment and execution policy settings → asks the thread manager to resume the thread from history → commits metadata, notifies listeners, possibly starts a completion watcher, persists the spawn edge, and returns the resumed thread ID plus its multi-agent version.

**Call relations**: `AgentControl::resume_agent_from_rollout` calls this for the initial thread and, when needed, for each descendant thread. This helper performs the one-thread resume operation, while the caller decides how many related threads should be restored.

*Call graph*: called by 1 (resume_agent_from_rollout); 5 external calls (clone, effective_agent_max_threads, clone, default, Resumed).


### `core/src/agent/control.rs`

`orchestration` · `cross-cutting during session setup, agent spawning, message sending, status watching, and cleanup`

A session can have a main thread and many sub-agents, like a team where one person can delegate tasks to others. This file defines `AgentControl`, the shared handle that lets those threads find each other, talk to each other, and stay registered under the same session instead of becoming loose global state.

The file does not do the agent’s actual thinking. Instead, it coordinates the surrounding bookkeeping. Before sending work to an agent, it checks that the thread manager still exists, asks the execution limiter whether the agent may run, forwards the operation, and records a short “last task” preview for listing agents later. If a target thread has died, it removes stale records so the rest of the system does not keep pointing at a dead agent.

It also understands parent-child relationships. When a sub-agent is spawned, this control layer reserves its name or path, records metadata, persists the spawn edge when possible, and can later list children or all descendants. For spawned sub-agents, it can start a background watcher that waits until the child finishes and then notifies the parent. In newer multi-agent mode, that notification is sent as structured inter-agent communication; otherwise it is injected as a plain user-style message. Without this file, agents could still exist as threads, but the system would lose the shared map of who they are, where they belong, and how they should communicate.

#### Function details

##### `AgentControl::new`  (lines 107–112)

```
fn new(manager: Weak<ThreadManagerState>) -> Self
```

**Purpose**: Creates a new `AgentControl` handle tied to the global thread manager. This is the starting point for giving a session the ability to create and contact agents.

**Data flow**: It receives a weak reference to the thread manager, meaning a pointer that does not keep the manager alive by itself. It builds a default control object, stores that weak reference, and leaves the rest of the shared registry and limiter state at their defaults.

**Call relations**: The broader agent-control setup calls this when a session needs its control handle. Later steps can add the session id with `AgentControl::with_session_id` and then use the handle for spawning, messaging, and listing agents.

*Call graph*: called by 1 (agent_control); 1 external calls (default).


##### `AgentControl::with_session_id`  (lines 114–118)

```
fn with_session_id(mut self, session_id: SessionId, max_threads: usize) -> Self
```

**Purpose**: Attaches the shared session id to an `AgentControl` and sets the maximum number of agent threads allowed to run. This makes the handle ready for a particular session tree.

**Data flow**: It takes an existing control object, a session id, and a thread limit. It stores the session id, initializes the execution limiter with the maximum thread count, and returns the updated control object.

**Call relations**: This is used during setup after `AgentControl::new` creates the handle. Other code later reads the stored id through `AgentControl::session_id` and relies on the limiter when sending work.

*Call graph*: called by 1 (new).


##### `AgentControl::session_id`  (lines 120–122)

```
fn session_id(&self) -> SessionId
```

**Purpose**: Returns the session id shared by the root thread and its sub-agents. Callers use this when they need to label work or events as belonging to the same session tree.

**Data flow**: It reads the stored session id from the control object and returns it unchanged. It does not contact the thread manager or change any state.

**Call relations**: This is called by setup or session-related code that needs to know which session this control handle belongs to. It is the simple read side of the value set by `AgentControl::with_session_id`.

*Call graph*: called by 1 (new).


##### `AgentControl::send_input`  (lines 125–135)

```
async fn send_input(
        &self,
        agent_id: ThreadId,
        initial_operation: Op,
    ) -> CodexResult<String>
```

**Purpose**: Sends a user-style operation to an existing agent thread. It first checks that the thread manager is still available and that running this operation would not break execution limits.

**Data flow**: It receives a target agent thread id and an operation. It upgrades the weak thread-manager pointer into a usable shared pointer, asks the execution limiter for permission, then passes the operation to `AgentControl::send_input_after_capacity_check`; the result is either a request id or an error.

**Call relations**: This is the public path for sending ordinary input through `AgentControl`. It delegates the actual send and “last task” bookkeeping to `AgentControl::send_input_after_capacity_check`, after `AgentControl::upgrade` confirms the manager still exists.

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

**Purpose**: Forwards an already-approved operation to an agent and records a readable summary of the task. This keeps agent listings useful by showing what each agent was last asked to do.

**Data flow**: It receives the target agent id, the thread manager, and the operation. It turns the operation into a short preview, sends the operation to the thread, lets `AgentControl::handle_thread_request_result` clean up if the send discovers a dead agent, and if sending succeeded it updates or clears the agent’s last-task message in the registry.

**Call relations**: `AgentControl::send_input` calls this after capacity has been checked. It uses `render_input_preview`, `last_task_message_from_communication`, and `non_empty_task_message` to prepare display text, then hands the send result through `AgentControl::handle_thread_request_result`.

*Call graph*: calls 4 internal fn (handle_thread_request_result, last_task_message_from_communication, non_empty_task_message, render_input_preview); called by 1 (send_input).


##### `AgentControl::send_inter_agent_communication`  (lines 167–188)

```
async fn send_inter_agent_communication(
        &self,
        agent_id: ThreadId,
        communication: InterAgentCommunication,
    ) -> CodexResult<String>
```

**Purpose**: Sends a structured message from one agent to another. This is used when agents talk to each other rather than receiving ordinary user input.

**Data flow**: It receives a target agent id and an inter-agent communication object. It extracts a possible last-task display message, wraps the communication into an operation, checks execution capacity, sends it through the thread manager, then updates the registry’s last-task message if the send succeeded.

**Call relations**: Completion watchers and other multi-agent flows use this when one agent needs to notify another. It follows the same safety pattern as normal input: `AgentControl::upgrade`, capacity checking, thread-manager send, and cleanup through `AgentControl::handle_thread_request_result`.

*Call graph*: calls 3 internal fn (handle_thread_request_result, upgrade, last_task_message_from_communication).


##### `AgentControl::interrupt_agent`  (lines 191–199)

```
async fn interrupt_agent(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Asks an agent thread to stop its current task. This gives the system a controlled way to cancel or interrupt work that is already in progress.

**Data flow**: It receives the target agent id, upgrades the thread-manager pointer, sends an interrupt operation to that thread, and returns the thread manager’s result after dead-agent cleanup has had a chance to run.

**Call relations**: Callers use this as the control-plane cancel path. It relies on `AgentControl::upgrade` to reach the thread manager and `AgentControl::handle_thread_request_result` to remove stale records if the interrupted agent is already gone.

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

**Purpose**: Examines the result of sending something to an agent and cleans up if the agent died internally. This prevents the registry from keeping a dead thread as if it were still usable.

**Data flow**: It receives the target agent id, the thread manager, and the result of a request. If the result says the internal agent died, it removes the thread from the manager, forgets residency bookkeeping, and releases the spawned-thread record; then it returns the original result unchanged.

**Call relations**: The send and interrupt paths all pass their thread-manager result through this function. It is the shared cleanup checkpoint for `AgentControl::send_input_after_capacity_check`, `AgentControl::send_inter_agent_communication`, and `AgentControl::interrupt_agent`.

*Call graph*: called by 3 (interrupt_agent, send_input_after_capacity_check, send_inter_agent_communication); 1 external calls (matches!).


##### `AgentControl::get_status`  (lines 216–225)

```
async fn get_status(&self, agent_id: ThreadId) -> AgentStatus
```

**Purpose**: Looks up the latest known status of an agent, such as whether it is running or finished. If the manager or thread cannot be found, it reports `NotFound` instead of failing loudly.

**Data flow**: It receives an agent id, tries to reach the thread manager, then tries to fetch the thread. If both steps succeed it asks the thread for its current agent status; otherwise it returns `NotFound`.

**Call relations**: Background watchers use this as a fallback when they cannot subscribe to live status updates. It begins with `AgentControl::upgrade`, because the status lives on the thread manager’s thread objects.

*Call graph*: calls 1 internal fn (upgrade).


##### `AgentControl::register_session_root`  (lines 227–235)

```
fn register_session_root(
        &self,
        current_thread_id: ThreadId,
        current_parent_thread_id: Option<ThreadId>,
    )
```

**Purpose**: Records the current thread as the root of an agent session when it has no parent. This anchors the tree so later lookups can include the main thread.

**Data flow**: It receives the current thread id and an optional parent thread id. If there is no parent, it stores the current thread as the root thread in the agent registry; otherwise it leaves the registry unchanged.

**Call relations**: Session setup calls this when a thread starts. The root registration is later used by listing and path-based lookup code, including the root entry shown by `AgentControl::list_agents`.


##### `AgentControl::get_agent_metadata`  (lines 237–239)

```
fn get_agent_metadata(&self, agent_id: ThreadId) -> Option<AgentMetadata>
```

**Purpose**: Returns the registry information known for an agent, such as its path, nickname, role, and last task. This is a read-only lookup for callers that already have a thread id.

**Data flow**: It receives an agent id, asks the agent registry for metadata tied to that thread, and returns either the metadata or nothing if the thread is unknown.

**Call relations**: Other control-plane code uses this when it needs human-friendly agent information without contacting the live thread. It is a direct read from the shared `AgentRegistry`.


##### `AgentControl::ensure_agent_known`  (lines 241–245)

```
fn ensure_agent_known(&self, agent_id: ThreadId) -> CodexResult<AgentMetadata>
```

**Purpose**: Checks that an agent id is known to the registry and returns its metadata. Unlike `AgentControl::get_agent_metadata`, it turns a missing entry into a clear thread-not-found error.

**Data flow**: It receives an agent id and asks the registry for metadata. If metadata exists, it returns it; if not, it returns a `ThreadNotFound` error for that id.

**Call relations**: Callers use this when the next step requires a real registered agent and should stop immediately if the id is invalid. It is the stricter version of `AgentControl::get_agent_metadata`.

*Call graph*: 1 external calls (ThreadNotFound).


##### `AgentControl::list_live_agent_subtree_thread_ids`  (lines 247–254)

```
async fn list_live_agent_subtree_thread_ids(
        &self,
        agent_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>>
```

**Purpose**: Returns the thread ids for one agent and all of its live spawned descendants. This is useful when an operation needs to apply to a whole branch of the agent tree.

**Data flow**: It starts with the requested agent id in a list, asks `AgentControl::live_thread_spawn_descendants` for all live child and grandchild thread ids, appends them, and returns the combined list.

**Call relations**: Higher-level code calls this when it needs the complete live subtree below a particular agent. It delegates the tree walk to `AgentControl::live_thread_spawn_descendants`.

*Call graph*: calls 1 internal fn (live_thread_spawn_descendants); 1 external calls (vec!).


##### `AgentControl::get_agent_config_snapshot`  (lines 256–267)

```
async fn get_agent_config_snapshot(
        &self,
        agent_id: ThreadId,
    ) -> Option<ThreadConfigSnapshot>
```

**Purpose**: Fetches a snapshot of an agent thread’s configuration. A snapshot is a point-in-time copy, useful when callers need to inspect settings without changing them.

**Data flow**: It receives an agent id, upgrades the thread-manager reference, fetches the thread, and asks that thread for its configuration snapshot. If the manager or thread is unavailable, it returns nothing.

**Call relations**: Control and inspection code use this to understand how a running agent was configured. It depends on `AgentControl::upgrade` because the configuration snapshot is stored on the live thread.

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

**Purpose**: Turns a human-style agent reference into the actual thread id for a live agent. This lets code refer to agents by paths such as relative names instead of raw thread identifiers.

**Data flow**: It reads the current session’s agent path, resolves the provided reference against that path, and asks the registry whether any live agent has the resulting path. If found, it returns the thread id; otherwise it returns an unsupported-operation error saying the path was not found.

**Call relations**: Inter-agent features use this when a message or command names another agent. It relies on path information from the current `SessionSource` and the registry’s path-to-thread mapping.

*Call graph*: 3 external calls (get_agent_path, format!, UnsupportedOperation).


##### `AgentControl::subscribe_status`  (lines 291–298)

```
async fn subscribe_status(
        &self,
        agent_id: ThreadId,
    ) -> CodexResult<watch::Receiver<AgentStatus>>
```

**Purpose**: Opens a live subscription to an agent’s status changes. A subscription lets a caller wait for updates instead of repeatedly polling.

**Data flow**: It receives an agent id, upgrades the thread-manager pointer, fetches the thread, and returns a watch receiver. That receiver first contains the current status and then receives later status changes.

**Call relations**: `AgentControl::maybe_start_completion_watcher` uses this to wait until a child agent reaches a final state. It follows the normal lookup route through `AgentControl::upgrade` and the thread manager.

*Call graph*: calls 1 internal fn (upgrade).


##### `AgentControl::format_environment_context_subagents`  (lines 300–320)

```
async fn format_environment_context_subagents(
        &self,
        parent_thread_id: ThreadId,
    ) -> String
```

**Purpose**: Builds a short text block describing the sub-agents directly available under a parent thread. This text can be placed into an environment or prompt so the parent knows who it can refer to.

**Data flow**: It receives a parent thread id, asks for that parent’s open spawned children, and formats each child as a context line using either the agent path name or the raw thread id plus any nickname. If the child lookup fails, it returns an empty string.

**Call relations**: Prompt or environment-building code calls this when it wants to show a parent thread its active sub-agents. It gets the child list through `AgentControl::open_thread_spawn_children` and formats each line with session-prefix helpers.

*Call graph*: calls 1 internal fn (open_thread_spawn_children); 1 external calls (new).


##### `AgentControl::list_agents`  (lines 322–395)

```
async fn list_agents(
        &self,
        current_session_source: &SessionSource,
        path_prefix: Option<&str>,
    ) -> CodexResult<Vec<ListedAgent>>
```

**Purpose**: Produces a user-facing list of live agents, optionally limited to one path prefix. Each entry includes the agent’s name, current status, and the last task message if available.

**Data flow**: It receives the current session source and an optional path prefix. It resolves the prefix relative to the current agent path, gathers live agent metadata from the registry, sorts it predictably, includes the root thread when it matches, fetches each live thread’s current status, and returns a list of display records.

**Call relations**: User commands or UI features call this to show what agents exist. It uses `AgentControl::upgrade` to read live thread status and `agent_matches_prefix` to decide which path entries belong in the result.

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

**Purpose**: Starts a background task that waits for a spawned sub-agent to finish and then tells its parent. This is like assigning someone to watch the mailbox and notify the manager when a delegated task is done.

**Data flow**: It receives the child thread id, optional session source, a child reference string, and an optional child agent path. If the child was not spawned from a parent thread, it does nothing. Otherwise it starts an asynchronous task that waits for the child status to become final, then sends either structured inter-agent communication or a plain injected notification to the parent.

**Call relations**: The spawn flow calls this after creating a child agent. Inside the background task it uses `AgentControl::subscribe_status` when possible, falls back to `AgentControl::get_status`, checks final states with `is_final`, and then uses either `AgentControl::send_inter_agent_communication` or direct parent-thread message injection.

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

**Purpose**: Prepares registry and session metadata before creating a new spawned agent thread. It reserves names and paths early so two children do not accidentally claim the same identity.

**Data flow**: It receives a spawn reservation, parent configuration, parent thread id, depth, optional path, optional role, and optional preferred nickname. It may register the parent as root, reserves the requested agent path, chooses and reserves a nickname, builds the child session source, and returns that source together with metadata for the future agent.

**Call relations**: The agent-spawning code calls this before the actual thread is started. It relies on nickname candidates from the spawn helper module and reservation methods that protect unique paths and nicknames.

*Call graph*: calls 3 internal fn (agent_nickname_candidates, reserve_agent_nickname_with_preference, reserve_agent_path); 1 external calls (SubAgent).


##### `AgentControl::upgrade`  (lines 524–528)

```
fn upgrade(&self) -> CodexResult<Arc<ThreadManagerState>>
```

**Purpose**: Turns the stored weak thread-manager reference into a usable shared reference. If the thread manager has already been dropped, it reports that agent operations are no longer supported.

**Data flow**: It reads the weak manager pointer from the control object. If the manager is still alive, it returns a strong shared pointer; if not, it returns an unsupported-operation error.

**Call relations**: Most functions that need live threads call this first, including sending input, interrupting agents, listing agents, getting status, subscribing to status, and reading child edges. It is the safety gate between the control handle and the global thread manager.

*Call graph*: called by 8 (get_agent_config_snapshot, get_status, interrupt_agent, list_agents, live_thread_spawn_children, send_input, send_inter_agent_communication, subscribe_status); 1 external calls (upgrade).


##### `AgentControl::inherited_environments_for_source`  (lines 530–552)

```
async fn inherited_environments_for_source(
        &self,
        state: &Arc<ThreadManagerState>,
        session_source: Option<&SessionSource>,
    ) -> Option<TurnEnvironmentSnapshot>
```

**Purpose**: Gets the parent thread’s environment selections for a child agent when the child was spawned from a thread. Environment selections describe what runtime context, such as chosen environment settings, should carry over.

**Data flow**: It receives the thread manager and an optional session source. If the source points to a spawned child, it fetches the parent thread and takes a snapshot of the parent’s turn environments; otherwise it returns nothing.

**Call relations**: Spawn setup uses this when deciding what environment context a new child should inherit. It only applies to `ThreadSpawn` sub-agents because other session sources do not have a parent thread to inherit from.


##### `AgentControl::inherited_exec_policy_for_source`  (lines 554–576)

```
async fn inherited_exec_policy_for_source(
        &self,
        state: &Arc<ThreadManagerState>,
        session_source: Option<&SessionSource>,
        child_config: &Config,
    ) -> Option<Arc<cr
```

**Purpose**: Decides whether a child agent should share its parent’s execution policy and returns that policy when appropriate. An execution policy is the rule set that controls what commands or actions are allowed.

**Data flow**: It receives the thread manager, optional session source, and the child configuration. If the child was spawned from a parent, it loads the parent thread and configuration, checks whether the child should reuse the parent policy, and if so returns a shared pointer to that policy; otherwise it returns nothing.

**Call relations**: The spawn flow uses this during child setup so policy decisions remain consistent when configuration says they should be inherited. It delegates the actual yes-or-no rule to `child_uses_parent_exec_policy`.

*Call graph*: calls 1 internal fn (child_uses_parent_exec_policy); 1 external calls (clone).


##### `AgentControl::open_thread_spawn_children`  (lines 578–586)

```
async fn open_thread_spawn_children(
        &self,
        parent_thread_id: ThreadId,
    ) -> CodexResult<Vec<(ThreadId, AgentMetadata)>>
```

**Purpose**: Returns the live direct children spawned by one parent thread. It filters the full child map down to just the requested parent.

**Data flow**: It receives a parent thread id, builds the current map of live parent-to-child relationships, removes the entry for the requested parent, and returns that list or an empty list if there are no children.

**Call relations**: `AgentControl::format_environment_context_subagents` calls this when building prompt context for a parent. It is also used by waiting code elsewhere, and it gets its data from `AgentControl::live_thread_spawn_children`.

*Call graph*: calls 1 internal fn (live_thread_spawn_children); called by 2 (format_environment_context_subagents, wait_for_live_thread_spawn_children).


##### `AgentControl::live_thread_spawn_children`  (lines 588–621)

```
async fn live_thread_spawn_children(
        &self,
    ) -> CodexResult<HashMap<ThreadId, Vec<(ThreadId, AgentMetadata)>>>
```

**Purpose**: Builds a sorted map of live spawned-child relationships. The result shows, for each parent thread, which live child threads it currently has and what metadata is known about them.

**Data flow**: It upgrades the thread manager, asks it for live spawn edges, and for each edge attaches metadata from the agent registry or a minimal default if no metadata exists. It sorts each parent’s children by agent path and then thread id, and returns the map.

**Call relations**: Tree-related functions use this as their source of truth for live parent-child links. `AgentControl::open_thread_spawn_children` narrows it to one parent, while `AgentControl::live_thread_spawn_descendants` walks through it recursively.

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

**Purpose**: Stores the parent-child relationship for a spawned thread in the persistent state database when one is available. This helps the system remember or inspect spawn relationships outside the in-memory registry.

**Data flow**: It receives the child thread object, child thread id, and optional session source. If the source has a parent thread id and the thread has a state database context, it writes an open spawn edge from parent to child; if writing fails, it logs a warning and continues.

**Call relations**: The spawn flow calls this after a child thread exists. It does not stop the session on database failure; it only warns, because the live in-memory agent flow can still continue.

*Call graph*: calls 1 internal fn (state_db); 1 external calls (warn!).


##### `AgentControl::live_thread_spawn_descendants`  (lines 648–672)

```
async fn live_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>>
```

**Purpose**: Finds every live descendant below a root thread, not just direct children. This walks the agent tree so a caller can work with an entire branch.

**Data flow**: It receives a root thread id, builds the live children map, starts with the root’s direct children, and uses a stack to visit each child and then its children. It returns the collected thread ids in traversal order.

**Call relations**: `AgentControl::list_live_agent_subtree_thread_ids` calls this and adds the root id itself. It depends on `AgentControl::live_thread_spawn_children` for the current parent-child map.

*Call graph*: calls 1 internal fn (live_thread_spawn_children); called by 1 (list_live_agent_subtree_thread_ids); 1 external calls (new).


##### `agent_matches_prefix`  (lines 675–687)

```
fn agent_matches_prefix(agent_path: Option<&AgentPath>, prefix: &AgentPath) -> bool
```

**Purpose**: Checks whether an agent path belongs under a requested path prefix. This is used to filter agent lists to a subtree.

**Data flow**: It receives an optional agent path and a required prefix. If the prefix is the root path, it accepts everything; otherwise it accepts only paths that exactly match the prefix or start with the prefix followed by a slash.

**Call relations**: `AgentControl::list_agents` uses this when a caller asks to list only agents under a certain path. It keeps `/a` from accidentally matching unrelated paths like `/abc` by requiring a slash boundary.

*Call graph*: calls 1 internal fn (is_root).


##### `render_input_preview`  (lines 689–710)

```
fn render_input_preview(initial_operation: &Op) -> String
```

**Purpose**: Turns an operation into a short human-readable preview. This preview becomes the “last task” text shown when listing agents.

**Data flow**: It receives an operation. For user input, it converts text directly, labels images and local images, formats skills and mentions, and uses a generic marker for unknown input items; for inter-agent communication it returns the message content; for other operations it returns an empty string.

**Call relations**: `AgentControl::send_input_after_capacity_check` uses this when recording what an agent was last asked to do. Other call-handling and spawn-handling code also call it to show or store readable task summaries.

*Call graph*: called by 3 (send_input_after_capacity_check, handle_call, handle_spawn_agent); 1 external calls (new).


##### `last_task_message_from_communication`  (lines 712–717)

```
fn last_task_message_from_communication(communication: &InterAgentCommunication) -> Option<String>
```

**Purpose**: Extracts a displayable last-task message from inter-agent communication. It deliberately hides encrypted content because encrypted text should not be shown as a plain preview.

**Data flow**: It receives an inter-agent communication object. If encrypted content is present, it returns nothing; otherwise it passes the visible content through `non_empty_task_message` so empty messages are not recorded.

**Call relations**: Both normal input sending and direct inter-agent sending use this before updating an agent’s last-task message. It is the privacy-aware wrapper around `non_empty_task_message`.

*Call graph*: calls 1 internal fn (non_empty_task_message); called by 2 (send_input_after_capacity_check, send_inter_agent_communication).


##### `non_empty_task_message`  (lines 719–721)

```
fn non_empty_task_message(message: String) -> Option<String>
```

**Purpose**: Keeps a task message only if it is not empty. This avoids showing blank last-task entries in agent listings.

**Data flow**: It receives a string. If the string has any content, it returns that string wrapped as a present value; if the string is empty, it returns nothing.

**Call relations**: `AgentControl::send_input_after_capacity_check` and `last_task_message_from_communication` use this small helper before writing last-task text into the registry.

*Call graph*: called by 2 (send_input_after_capacity_check, last_task_message_from_communication).


##### `thread_spawn_depth`  (lines 723–728)

```
fn thread_spawn_depth(session_source: &SessionSource) -> Option<i32>
```

**Purpose**: Reads the nesting depth from a session source when that source represents a thread-spawned sub-agent. The depth tells how far down the parent-child agent tree the thread is.

**Data flow**: It receives a session source. If it is a thread-spawned sub-agent, it returns the stored depth number; for any other source, it returns nothing.

**Call relations**: Spawn and session code can use this helper when they need to know whether a thread is part of a spawned-agent chain and how deeply nested it is. It is a simple extractor for the `SessionSource` shape used by this control layer.


### `core/src/agent/agent_resolver.rs`

`domain_logic` · `tool call handling`

When a tool wants to send work to another agent, it may not always have a raw thread ID. It might receive a friendly reference, such as a target name. This file is the small translator that turns that tool-facing target into the real thread ID used internally.

The main flow first makes sure the agent-control service knows the relationship between the current session thread and its parent thread. This is like telling a receptionist which meeting room you came from before asking them to find someone else in the building. That context can matter when resolving a short or relative agent reference.

After that, the resolver tries the simplest path: if the target string is already a valid `ThreadId`, it returns it directly. If not, it asks the session’s `agent_control` service to resolve the target using the current thread and the turn’s session source. If that service cannot do the lookup, the error is converted into a `FunctionCallError` that can be reported back to the model in plain form.

Without this file, tool calls that refer to agents by name or shorthand would not reliably reach the correct conversation thread, and error messages from failed lookups would not be shaped for model-facing tool responses.

#### Function details

##### `resolve_agent_target`  (lines 8–29)

```
async fn resolve_agent_target(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    target: &str,
) -> Result<ThreadId, FunctionCallError>
```

**Purpose**: This function takes a target string from a tool call and finds the actual `ThreadId` for the agent it points to. It supports both direct thread IDs and more human-friendly references that need to be looked up.

**Data flow**: It receives the current `Session`, the current `TurnContext`, and a target string. First it records the session-root relationship through `register_session_root`. Then it tries to read the target as a `ThreadId`; if that works, it returns that ID. If the target is not already an ID, it asks the session’s agent-control service to resolve it, then returns the found thread ID or turns any lookup failure into a model-facing `FunctionCallError`.

**Call relations**: This is the public worker in this file. During tool execution, callers use it when they need to turn an agent target into a concrete thread. It calls `register_session_root` first so the lookup service has context, then uses `ThreadId::from_string` for the fast path before handing unresolved names to the agent-control service.

*Call graph*: calls 2 internal fn (register_session_root, from_string).


##### `register_session_root`  (lines 31–36)

```
fn register_session_root(session: &Arc<Session>, turn: &Arc<TurnContext>)
```

**Purpose**: This helper records the link between the current session thread and its parent thread. That gives the agent-control service the context it may need to understand relative agent references.

**Data flow**: It receives the current `Session` and `TurnContext`. It reads the session’s thread ID and the turn’s parent thread ID, then passes both to the agent-control service. It does not return a value; its effect is updating the service’s knowledge of the session relationship.

**Call relations**: It is called only by `resolve_agent_target`, right before any target lookup happens. Its job is to prepare the ground so the later resolution step can interpret the requested agent target in the right session context.

*Call graph*: called by 1 (resolve_agent_target).


### `core/src/session/multi_agents.rs`

`domain_logic` · `session startup / initial context building`

This file is a small decision point for the multi-agent feature. In this project, a “multi-agent” session means the main assistant can work with other helper agents. New users, or even agents themselves, may need a short reminder about how that setup should be used. This file chooses that reminder text.

The logic is deliberately cautious. First, it only does anything for version 2 of the multi-agent system. If the session is using another version, it returns no hint. Next, it checks a configuration switch that can turn these hints on or off. If hints are disabled, it again returns nothing.

If hints are allowed, the file looks at where the session came from. A sub-agent that was created by a thread spawn gets the sub-agent hint text. Normal entry points, such as the command line, VS Code, an execution session, MCP, a custom source, or an unknown source, get the root-agent hint text. Internal sessions and other sub-agent sources get no hint.

An everyday analogy: this is like a receptionist handing out different instruction cards. The main visitor gets one card, a helper sent from another room gets another, and some people get no card at all.

#### Function details

##### `usage_hint_text`  (lines 6–31)

```
fn usage_hint_text(
    turn_context: &'a TurnContext,
    session_source: &SessionSource,
) -> Option<&'a str>
```

**Purpose**: Chooses the optional usage hint text for a multi-agent session. It returns a hint only when multi-agent version 2 is active, hints are enabled in configuration, and the session source is one that should receive guidance.

**Data flow**: It receives the current turn context, which includes the multi-agent version and configuration, plus the session source, which says where this session came from. It first rejects sessions that are not multi-agent version 2, then rejects sessions where hinting is turned off. If both checks pass, it picks either the sub-agent hint text or the root-agent hint text based on the session source, or returns nothing for sources that should not see a hint.

**Call relations**: This function is called by build_initial_context while the system is preparing the starting context for a session. At that moment, build_initial_context asks this function whether any usage guidance should be included, and this function hands back either the right text or no text at all.

*Call graph*: called by 1 (build_initial_context).


### Collaboration tool surfaces
This group introduces the shared multi-agent tool contracts and helpers, then walks through the classic and V2 collaboration handlers for spawning, messaging, listing, interrupting, waiting on, resuming, and closing agents.

### `core/src/tools/handlers/multi_agents_spec.rs`

`io_transport` · `startup/tool registration`

This file is like the instruction card and form template for the multi-agent feature. The runtime may know how to start and control sub-agents, but the model needs a clear menu of tools: what each tool is called, what fields it can send, which fields are required, and what kind of answer will come back. Without this file, the model would not have a reliable contract for delegating work or communicating with spawned agents.

The file builds `ToolSpec` values, which are descriptions of callable tools for the Responses API. It supports older namespace-style tools, such as `multi_agent_v1.spawn_agent`, and newer direct function tools, such as `spawn_agent` and `wait_agent`. It also builds JSON Schema objects. A JSON Schema is a machine-readable description of data, like a form that says “this field must be text” or “this result contains a list of agents.”

The spawn tools include careful guidance about when delegation is appropriate, how inherited model settings work, and how to avoid wasteful parallel work. Other tools describe how to send messages, wait for updates, list live agents, interrupt work, or close agents. Small helper functions keep repeated pieces consistent, such as the standard agent status format and timeout options.

#### Function details

##### `WaitAgentTimeoutOptions::default`  (lines 39–45)

```
fn default() -> Self
```

**Purpose**: Provides the standard timeout settings for waiting on agents. This keeps every caller using the same default, minimum, and maximum wait limits unless they explicitly choose different values.

**Data flow**: It starts with no input from the caller. It reads the shared timeout constants from the common multi-agent module, places them into a `WaitAgentTimeoutOptions` value, and returns that value.

**Call relations**: Code that creates a wait-agent tool can rely on this default when it does not need custom timeout limits. It acts as the common starting point before the tool schema is built.


##### `create_spawn_agent_tool_v1`  (lines 48–78)

```
fn create_spawn_agent_tool_v1(options: SpawnAgentToolOptions) -> ToolSpec
```

**Purpose**: Builds the older, namespace-based `spawn_agent` tool. This tool lets the model start a new sub-agent for a specific task and tells it what fields it may provide.

**Data flow**: It receives options such as available models, whether to hide model-related fields, and whether to include usage guidance. It builds the input fields, optionally removes metadata fields, writes a human-readable description, attaches an output shape for the new agent id and nickname, and returns a complete tool specification.

**Call relations**: The broader tool-spec setup calls this when it needs the version 1 spawn tool. Inside, it leans on the shared property builder and may call the metadata-hiding helper before wrapping the result in the multi-agent namespace.

*Call graph*: calls 2 internal fn (hide_spawn_agent_metadata_options, spawn_agent_common_properties_v1); called by 1 (spec); 2 external calls (Namespace, vec!).


##### `create_spawn_agent_tool_v2`  (lines 80–116)

```
fn create_spawn_agent_tool_v2(options: SpawnAgentToolOptions) -> ToolSpec
```

**Purpose**: Builds the newer direct `spawn_agent` tool. This version uses task names instead of just agent ids, requires both a task name and message, and supports the newer output format.

**Data flow**: It receives spawn-tool options, creates the common version 2 input fields, optionally removes model and agent-type fields, adds the required `task_name` field, builds the description, chooses the right output schema, and returns the tool specification.

**Call relations**: The tool-spec setup calls this when registering the newer multi-agent interface. It uses helpers for the shared version 2 fields, optional metadata hiding, the version 2 description text, and the version 2 output schema.

*Call graph*: calls 6 internal fn (hide_spawn_agent_metadata_options, spawn_agent_common_properties_v2, spawn_agent_output_schema_v2, spawn_agent_tool_description_v2, object, string); called by 1 (spec); 2 external calls (Function, vec!).


##### `create_send_input_tool_v1`  (lines 118–154)

```
fn create_send_input_tool_v1() -> ToolSpec
```

**Purpose**: Builds the older `send_input` tool, which sends a message or structured input items to an existing agent. It also lets the sender request an interrupt so the message can be handled immediately.

**Data flow**: It creates fields for the target agent, a plain text message, structured items, and an interrupt flag. It marks the target as required, adds an output shape containing a queued submission id, and returns the namespace-wrapped tool specification.

**Call relations**: The tool-spec setup calls this for the version 1 messaging flow. It uses the structured input item schema helper so messages can include more than plain text when needed.

*Call graph*: calls 3 internal fn (create_collab_input_items_schema, boolean, string); called by 1 (spec); 3 external calls (from, Namespace, vec!).


##### `create_send_message_tool`  (lines 156–186)

```
fn create_send_message_tool() -> ToolSpec
```

**Purpose**: Builds the newer `send_message` tool for sending a queued message to another live agent. It is meant for communication, not for forcing a new turn of work.

**Data flow**: It creates required fields for the target task or agent and the encrypted message text. It packages those fields into a direct function tool and returns it, without defining a special output body.

**Call relations**: The tool-spec setup calls this when exposing newer agent-to-agent messaging. It hands off only a simple target-and-message form because delivery behavior is handled elsewhere.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `create_followup_task_tool`  (lines 188–215)

```
fn create_followup_task_tool() -> ToolSpec
```

**Purpose**: Builds the `followup_task` tool, which sends a new task to an existing non-root agent. If the agent is idle, this can wake it up for another turn.

**Data flow**: It creates required fields for the target and encrypted message text. It wraps them in a direct function tool whose description explains how delivery differs for idle versus running agents, then returns that tool specification.

**Call relations**: The tool-spec setup calls this when it wants agents to be reusable for later tasks. The actual delivery and turn triggering happen outside this file; this file only defines the contract.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `create_resume_agent_tool`  (lines 217–237)

```
fn create_resume_agent_tool() -> ToolSpec
```

**Purpose**: Builds the older namespace-based `resume_agent` tool. It allows a previously closed agent to be reopened so it can receive later messages and waits.

**Data flow**: It creates a required `id` field, describes the resume action, attaches an output schema that reports the agent status, and returns the tool inside the multi-agent namespace.

**Call relations**: The tool-spec setup calls this for the version 1 resume capability. The output uses the shared status shape so resumed agents report status the same way as other multi-agent tools.

*Call graph*: calls 1 internal fn (string); called by 1 (spec); 3 external calls (from, Namespace, vec!).


##### `create_wait_agent_tool_v1`  (lines 239–253)

```
fn create_wait_agent_tool_v1(options: WaitAgentTimeoutOptions) -> ToolSpec
```

**Purpose**: Builds the older `wait_agent` tool, which waits for one of a set of target agents to reach a final state. This helps the main agent pause only when it truly needs a delegated result.

**Data flow**: It receives timeout limits, creates a namespace-wrapped tool named `wait_agent`, attaches parameters for target agents and timeout, adds an output shape for statuses and timeout information, and returns the finished tool specification.

**Call relations**: The tool-spec setup calls this when registering the version 1 waiting behavior. It is the older targeted wait flow, where the caller names specific agents to wait on.

*Call graph*: called by 1 (spec); 2 external calls (Namespace, vec!).


##### `create_wait_agent_tool_v2`  (lines 255–265)

```
fn create_wait_agent_tool_v2(options: WaitAgentTimeoutOptions) -> ToolSpec
```

**Purpose**: Builds the newer `wait_agent` tool, which waits for any live agent mailbox update rather than waiting on named targets. It returns a short summary instead of the actual final content.

**Data flow**: It receives timeout options, builds the allowed timeout parameter, attaches the version 2 wait output schema, and returns a direct function tool.

**Call relations**: The tool-spec setup calls this for the newer wait flow. It uses the version 2 parameter helper and the version 2 output helper so the direct function form stays consistent.

*Call graph*: calls 2 internal fn (wait_agent_tool_parameters_v2, wait_output_schema_v2); called by 1 (spec); 1 external calls (Function).


##### `create_list_agents_tool`  (lines 267–286)

```
fn create_list_agents_tool() -> ToolSpec
```

**Purpose**: Builds the `list_agents` tool, which reports live agents visible under the current root thread. It can optionally filter by a task-name prefix.

**Data flow**: It creates an optional `path_prefix` field, builds a direct function tool around it, attaches an output schema containing agent names, statuses, and last task messages, and returns the tool specification.

**Call relations**: The tool-spec setup calls this when the model should be able to inspect currently live agents. It relies on the list output schema helper to keep the returned agent list predictable.

*Call graph*: calls 3 internal fn (list_agents_output_schema, object, string); called by 1 (spec); 2 external calls (from, Function).


##### `create_close_agent_tool_v1`  (lines 288–308)

```
fn create_close_agent_tool_v1() -> ToolSpec
```

**Purpose**: Builds the older namespace-based `close_agent` tool. It tells the model how to request shutdown for an agent and its open descendants when they are no longer needed.

**Data flow**: It creates a required target field, writes a description that explains why closing matters for concurrency limits, attaches an output schema for the agent’s previous status, and returns the namespace-wrapped tool.

**Call relations**: The tool-spec setup calls this for the version 1 close operation. It uses the shared previous-status output pattern so callers can see what state the agent was in before shutdown was requested.

*Call graph*: calls 1 internal fn (string); called by 1 (spec); 3 external calls (from, Namespace, vec!).


##### `create_interrupt_agent_tool_v2`  (lines 310–328)

```
fn create_interrupt_agent_tool_v2() -> ToolSpec
```

**Purpose**: Builds the newer `interrupt_agent` tool. This lets the model stop an agent’s current turn without permanently closing that agent.

**Data flow**: It creates a required target field, describes the interrupt behavior, attaches an output schema for the status observed before the interrupt, and returns a direct function tool.

**Call relations**: The tool-spec setup calls this when exposing the newer interruption behavior. It hands off to the previous-status schema helper so interrupt and close-style responses share the same basic shape.

*Call graph*: calls 3 internal fn (agent_previous_status_output_schema, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `agent_status_output_schema`  (lines 330–359)

```
fn agent_status_output_schema() -> Value
```

**Purpose**: Defines the standard shape for reporting an agent’s status. It covers simple states like running, completed states with optional final text, and errored states with an error message.

**Data flow**: It takes no input. It builds a JSON value that says status may be one of several string labels or one of two small objects, then returns that schema value.

**Call relations**: This is a shared building block for many output schemas in the file. Whenever a tool needs to describe an agent’s state, this helper keeps the wording and allowed status shapes consistent.

*Call graph*: 1 external calls (json!).


##### `spawn_agent_output_schema_v1`  (lines 361–377)

```
fn spawn_agent_output_schema_v1() -> Value
```

**Purpose**: Defines what the older spawn tool returns after creating an agent. The result includes the internal agent id and a user-facing nickname when one exists.

**Data flow**: It takes no input. It builds a JSON object schema with required `agent_id` and `nickname` fields and returns that schema.

**Call relations**: The version 1 spawn tool uses this output contract so callers know how to refer to the newly created agent afterward.

*Call graph*: 1 external calls (json!).


##### `spawn_agent_output_schema_v2`  (lines 379–409)

```
fn spawn_agent_output_schema_v2(hide_agent_metadata: bool) -> Value
```

**Purpose**: Defines what the newer spawn tool returns. It always includes the canonical task name, and it may include a nickname unless agent metadata is hidden.

**Data flow**: It receives a flag saying whether metadata should be hidden. If hiding is enabled, it returns a schema with only `task_name`; otherwise, it returns a schema with both `task_name` and `nickname`.

**Call relations**: The version 2 spawn tool calls this while building its output contract. This keeps privacy or simplification choices reflected directly in the returned data shape.

*Call graph*: called by 1 (create_spawn_agent_tool_v2); 1 external calls (json!).


##### `send_input_output_schema`  (lines 411–423)

```
fn send_input_output_schema() -> Value
```

**Purpose**: Defines the result returned by the older `send_input` tool. The result is a submission id that identifies the queued input.

**Data flow**: It takes no input. It builds a JSON object schema with one required text field, `submission_id`, and returns it.

**Call relations**: The version 1 send-input tool uses this so callers can track that their input was accepted into the queue.

*Call graph*: 1 external calls (json!).


##### `list_agents_output_schema`  (lines 425–456)

```
fn list_agents_output_schema() -> Value
```

**Purpose**: Defines the result returned by `list_agents`. The result is a list of live agents with their name, last known status, and most recent task message.

**Data flow**: It takes no input. It builds a JSON object schema containing an `agents` array, and each array item has a name, a shared status shape, and an optional last task message.

**Call relations**: The list-agents tool calls this when building its output contract. It uses the shared agent status schema so listed agents describe their state the same way as other tools.

*Call graph*: called by 1 (create_list_agents_tool); 1 external calls (json!).


##### `resume_agent_output_schema`  (lines 458–467)

```
fn resume_agent_output_schema() -> Value
```

**Purpose**: Defines what the resume tool returns after trying to reopen an agent. The result is the agent’s status.

**Data flow**: It takes no input. It builds a JSON object schema with one required `status` field based on the shared agent status format, then returns it.

**Call relations**: The resume-agent tool uses this output contract so the caller immediately learns whether the resumed agent is running, completed, missing, or in another known state.

*Call graph*: 1 external calls (json!).


##### `wait_output_schema_v1`  (lines 469–486)

```
fn wait_output_schema_v1() -> Value
```

**Purpose**: Defines the older wait tool’s result. It returns final statuses keyed by agent id and a flag that says whether the wait timed out.

**Data flow**: It takes no input. It builds a JSON object schema with a `status` map and a `timed_out` boolean, then returns it.

**Call relations**: The version 1 wait tool uses this result shape for targeted waits. The shared status schema lets each completed or failed agent report its state consistently.

*Call graph*: 1 external calls (json!).


##### `wait_output_schema_v2`  (lines 488–504)

```
fn wait_output_schema_v2() -> Value
```

**Purpose**: Defines the newer wait tool’s result. It returns a brief message summary and a timeout flag, but not the agent’s final content.

**Data flow**: It takes no input. It builds a JSON object schema with required `message` and `timed_out` fields, then returns it.

**Call relations**: The version 2 wait tool calls this while building its output contract. This supports the newer mailbox-update style, where the wait call signals activity without carrying full content.

*Call graph*: called by 1 (create_wait_agent_tool_v2); 1 external calls (json!).


##### `agent_previous_status_output_schema`  (lines 506–518)

```
fn agent_previous_status_output_schema(previous_status_description: &str) -> Value
```

**Purpose**: Defines a common output shape for tools that change an agent and need to report what state it was in before the change. The caller supplies the wording for that previous-status field.

**Data flow**: It receives descriptive text for the `previous_status` field. It builds a JSON object schema that uses that text and the shared agent status shape, then returns it.

**Call relations**: The interrupt tool calls this when defining its response. The same pattern is also useful for close-like operations where the old status matters.

*Call graph*: called by 1 (create_interrupt_agent_tool_v2); 1 external calls (json!).


##### `create_collab_input_items_schema`  (lines 520–553)

```
fn create_collab_input_items_schema() -> JsonSchema
```

**Purpose**: Defines the shape for structured input items that can be sent to an agent. These items can represent text, images, local files, skills, or mentions, instead of only plain text.

**Data flow**: It takes no input. It builds the allowed fields for one structured item, wraps that item shape in an array schema, adds a description, and returns the schema.

**Call relations**: The older send-input tool and the version 1 spawn property builder use this when they allow richer input than a single text message.

*Call graph*: calls 3 internal fn (array, object, string); called by 2 (create_send_input_tool_v1, spawn_agent_common_properties_v1); 1 external calls (from).


##### `spawn_agent_common_properties_v1`  (lines 555–596)

```
fn spawn_agent_common_properties_v1(agent_type_description: &str) -> BTreeMap<String, JsonSchema>
```

**Purpose**: Builds the shared input fields for the older spawn-agent tool. These fields cover the initial task, optional structured items, agent type, context forking, and optional model settings.

**Data flow**: It receives text describing the allowed agent type. It creates a sorted map of field names to JSON schema field descriptions, including the structured items schema, and returns that map.

**Call relations**: The version 1 spawn tool calls this first, then may remove some fields if metadata should be hidden. It centralizes the older spawn form so the top-level builder stays readable.

*Call graph*: calls 3 internal fn (create_collab_input_items_schema, boolean, string); called by 1 (create_spawn_agent_tool_v1); 1 external calls (from).


##### `spawn_agent_common_properties_v2`  (lines 598–638)

```
fn spawn_agent_common_properties_v2(agent_type_description: &str) -> BTreeMap<String, JsonSchema>
```

**Purpose**: Builds the shared input fields for the newer spawn-agent tool. This version uses encrypted message text and a `fork_turns` setting that controls how much conversation context the new agent receives.

**Data flow**: It receives text describing the allowed agent type. It creates a sorted map with message, agent type, fork-turns, model, reasoning-effort, and service-tier fields, then returns that map.

**Call relations**: The version 2 spawn tool calls this before adding the required task name. It provides the common part of the newer spawn form.

*Call graph*: calls 1 internal fn (string); called by 1 (create_spawn_agent_tool_v2); 1 external calls (from).


##### `hide_spawn_agent_metadata_options`  (lines 640–645)

```
fn hide_spawn_agent_metadata_options(properties: &mut BTreeMap<String, JsonSchema>)
```

**Purpose**: Removes advanced spawn fields that expose agent type or model-selection details. This is used when the interface should be simpler or should not show those controls.

**Data flow**: It receives a mutable map of spawn-agent input fields. It removes `agent_type`, `model`, `reasoning_effort`, and `service_tier` from that map, changing the map in place and returning nothing.

**Call relations**: Both version 1 and version 2 spawn builders call this when their options request hidden metadata. It is a small cleanup step before the final tool schema is returned.

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

**Purpose**: Writes the human-readable description for the older spawn-agent tool. The description explains what spawning does, what it returns, inherited model behavior, and optional usage rules.

**Data flow**: It receives optional model guidance, optional inherited-model guidance, return-value wording, and usage-hint options. It combines those pieces into a single description string, adding either custom hint text or the built-in delegation guidance when requested.

**Call relations**: The version 1 spawn builder uses this to produce the text the model sees before calling the tool. It turns configuration choices into clear instructions.

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

**Purpose**: Writes the human-readable description for the newer spawn-agent tool. It explains task names, relative versus canonical names, inherited tools, context forking, and when delegation is appropriate.

**Data flow**: It receives optional model guidance, optional inherited-model guidance, and usage-hint options. It builds the standard version 2 description and optionally appends custom usage text, then returns the final string.

**Call relations**: The version 2 spawn builder calls this when assembling the tool specification. Its text is important because it guides the model away from unnecessary delegation.

*Call graph*: called by 1 (create_spawn_agent_tool_v2); 1 external calls (format!).


##### `spawn_agent_models_description`  (lines 747–808)

```
fn spawn_agent_models_description(models: &[ModelPreset]) -> String
```

**Purpose**: Creates a readable list of model overrides that may be used when spawning an agent. It only includes picker-visible models and limits the list so the tool description does not become too long.

**Data flow**: It receives a list of model presets. It filters to visible models, takes only the first few, formats each model’s slug, description, reasoning effort options, and service tiers, and returns the combined text. If no visible models exist, it returns a short message saying so.

**Call relations**: Spawn tool builders use this when model details are not hidden. The resulting text is folded into the spawn-agent description so the model knows which explicit overrides are available.

*Call graph*: 2 external calls (format!, iter).


##### `wait_agent_tool_parameters_v1`  (lines 810–836)

```
fn wait_agent_tool_parameters_v1(options: WaitAgentTimeoutOptions) -> JsonSchema
```

**Purpose**: Builds the input schema for the older wait-agent tool. This version requires a list of target agent ids and allows a timeout.

**Data flow**: It receives timeout settings. It creates a required `targets` array field and an optional `timeout_ms` number field whose description includes the default, minimum, and maximum values, then returns the object schema.

**Call relations**: The version 1 wait tool uses this parameter schema when registering the older targeted wait behavior. The timeout values come from the caller’s options, often the default timeout settings.

*Call graph*: calls 4 internal fn (array, number, object, string); 3 external calls (from, format!, vec!).


##### `wait_agent_tool_parameters_v2`  (lines 838–848)

```
fn wait_agent_tool_parameters_v2(options: WaitAgentTimeoutOptions) -> JsonSchema
```

**Purpose**: Builds the input schema for the newer wait-agent tool. This version only needs an optional timeout because it waits for any relevant mailbox update.

**Data flow**: It receives timeout settings. It creates an object schema with an optional `timeout_ms` number field, includes the default, minimum, and maximum values in the description, and returns the schema.

**Call relations**: The version 2 wait tool calls this while building its direct function specification. It matches the newer wait behavior, where targets are not supplied by the caller.

*Call graph*: calls 2 internal fn (number, object); called by 1 (create_wait_agent_tool_v2); 2 external calls (from, format!).


### `core/src/tools/handlers/multi_agents_common.rs`

`domain_logic` · `request handling`

Multi-agent work has many small but important rules. A child agent should start with the right model, safety permissions, working folder, instructions, and service tier. A message sent to another agent should be either plain text or structured input, but not both. Waiting for agents should return statuses in a useful order. This file collects those shared rules so each collaboration tool does not have to re-create them.

Think of it like the checklist a coordinator uses before sending a teammate into another room: give them the right briefing, make sure they have the same safety rules, confirm which tools they may use, and write down a clear way to report back. The helpers here build JSON tool responses, translate lower-level collaboration errors into messages the model can understand, create the source record that says a thread was spawned by another thread, and validate optional choices such as model, reasoning effort, and service tier.

A key detail is that child-agent configuration is not just copied from saved config. Some settings live only in the current turn, such as approval policy, sandbox settings, current directory, and selected model. This file deliberately refreshes those live values so spawned or resumed agents behave like the parent expects.

#### Function details

##### `function_arguments`  (lines 34–41)

```
fn function_arguments(payload: ToolPayload) -> Result<String, FunctionCallError>
```

**Purpose**: Extracts the raw argument string from a tool call payload. It protects collaboration handlers from receiving a payload shape they do not understand.

**Data flow**: It receives a tool payload. If the payload is a function call, it returns the argument text inside it. If it is any other kind of payload, it returns an error message meant to be sent back to the model.

**Call relations**: This is an entry helper for collaboration tool handlers when they begin reading a model-requested tool call. On the error path it creates a model-facing failure through RespondToModel, so the caller can stop cleanly instead of trying to parse the wrong data.

*Call graph*: 1 external calls (RespondToModel).


##### `tool_output_json_text`  (lines 43–50)

```
fn tool_output_json_text(value: &T, tool_name: &str) -> String
```

**Purpose**: Turns a tool result into JSON text for returning to the model. If JSON serialization fails, it still returns a JSON string that explains the failure instead of crashing.

**Data flow**: It receives any serializable value and the tool's name. It tries to convert the value into a JSON string. The output is either the normal JSON text or a JSON-encoded error message naming the tool and the serialization problem.

**Call relations**: This is the lower-level formatter used by tool_output_response_item. It relies on serde_json serialization, and it gives callers a safe text result even when the value cannot be encoded normally.

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

**Purpose**: Builds the standard response item that reports a function tool's result back to the model. It packages JSON text together with the original call information and an optional success flag.

**Data flow**: It receives the tool call id, the original payload, the result value, an optional success marker, and the tool name. It converts the result into JSON text, wraps that as a function-tool output, and returns a response item ready to send into the conversation.

**Call relations**: This sits one step above tool_output_json_text: first it asks that helper for safe JSON text, then it uses FunctionToolOutput::from_text to make the protocol object. Tool handlers use this when they need to answer a model's function call.

*Call graph*: calls 2 internal fn (from_text, tool_output_json_text).


##### `tool_output_code_mode_result`  (lines 66–73)

```
fn tool_output_code_mode_result(value: &T, tool_name: &str) -> JsonValue
```

**Purpose**: Turns a tool result into a JSON value for code-oriented return paths. It avoids panics by returning a JSON string error if conversion fails.

**Data flow**: It receives a serializable value and the tool name. It tries to convert the value into an in-memory JSON value rather than a text string. The output is that JSON value, or a JSON string describing the serialization failure.

**Call relations**: This is a sibling to tool_output_json_text for callers that need a JSON value directly. It relies on serde_json conversion and does not call other helpers in this file.

*Call graph*: 1 external calls (to_value).


##### `build_wait_agent_statuses`  (lines 75–110)

```
fn build_wait_agent_statuses(
    statuses: &HashMap<ThreadId, AgentStatus>,
    receiver_agents: &[CollabAgentRef],
) -> Vec<CollabAgentStatusEntry>
```

**Purpose**: Creates the status list returned when a caller waits on multiple agents. It keeps known receiver agents in the caller's order and still includes extra statuses that were not in that receiver list.

**Data flow**: It receives a map from thread id to agent status, plus a list of receiver agents that may include names and roles. It builds status entries with names and roles when available. Any status for an unknown thread is added afterward, sorted by thread id, and the final list is returned.

**Call relations**: Wait-style collaboration handlers can call this after they collect agent statuses. The function does not hand off to other project helpers; it mainly shapes raw status data into protocol entries that are easier for the model or user to read.

*Call graph*: 4 external calls (with_capacity, new, with_capacity, len).


##### `collab_spawn_error`  (lines 112–120)

```
fn collab_spawn_error(err: CodexErr) -> FunctionCallError
```

**Purpose**: Turns a lower-level spawn failure into a clear tool error for the model. It gives special wording for common collaboration-manager problems.

**Data flow**: It receives a CodexErr from an attempted agent spawn. It matches the kind of error and produces a FunctionCallError with a human-readable message, such as 'collab manager unavailable' or 'collab spawn failed: ...'.

**Call relations**: Spawn handlers use this when the collaboration system refuses or cannot create a new agent. It does not retry or repair the problem; it translates the failure into the standard RespondToModel path.

*Call graph*: 2 external calls (format!, RespondToModel).


##### `collab_agent_error`  (lines 122–135)

```
fn collab_agent_error(agent_id: ThreadId, err: CodexErr) -> FunctionCallError
```

**Purpose**: Turns errors involving an existing agent into clear messages for the model. It distinguishes missing agents, closed agents, unavailable collaboration support, and other failures.

**Data flow**: It receives the target agent id and a CodexErr. It checks the error type and returns a FunctionCallError with a specific message. For example, a missing thread becomes 'agent with id ... not found'.

**Call relations**: Tools that send to, wait for, or inspect another agent can use this after a collaboration operation fails. Like collab_spawn_error, it funnels errors into RespondToModel so the model gets an understandable response.

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

**Purpose**: Builds the session-source record for a newly spawned sub-agent. This record explains where the child thread came from and, when possible, where it sits in the parent agent path.

**Data flow**: It receives the parent thread id, the parent session source, the nesting depth, an optional role, and an optional task name. If there is a task name, it joins that name onto the parent's agent path. It returns a SessionSource that marks the new session as a sub-agent spawned from the parent thread, or an error if the path cannot be built.

**Call relations**: Spawn code calls this while creating the metadata for a child thread. It hands back a SubAgent session source that later parts of the system can use to show lineage, depth, role, and task path.

*Call graph*: 1 external calls (SubAgent).


##### `parse_collab_input`  (lines 163–195)

```
fn parse_collab_input(
    message: Option<String>,
    items: Option<Vec<UserInput>>,
) -> Result<Op, FunctionCallError>
```

**Purpose**: Validates and converts the input meant for another agent. It enforces the rule that callers must provide either a simple message or structured items, but not both.

**Data flow**: It receives an optional message string and an optional list of user-input items. If both are present or both are missing, it returns a model-facing error. If a message is present, it rejects blank text and wraps the message as a text input operation. If items are present, it rejects an empty list and converts the items into an operation.

**Call relations**: Collaboration tools use this before sending work to another agent. It stops ambiguous or empty input early and returns an Op object that the rest of the conversation machinery can deliver.

*Call graph*: 2 external calls (RespondToModel, vec!).


##### `build_agent_spawn_config`  (lines 204–211)

```
fn build_agent_spawn_config(
    base_instructions: &BaseInstructions,
    turn: &TurnContext,
) -> Result<Config, FunctionCallError>
```

**Purpose**: Creates the configuration snapshot for a newly spawned child agent. It starts from the parent's live settings and then adds the base instructions the new agent should follow.

**Data flow**: It receives base instructions and the current turn context. It asks build_agent_shared_config to copy and refresh the shared runtime settings, then sets the child config's base instructions from the supplied instruction text. The finished Config is returned.

**Call relations**: Spawn handlers call this when starting a new agent from scratch. It depends on build_agent_shared_config so all spawned agents inherit current model, permission, sandbox, and working-directory state before role-specific details are layered on.

*Call graph*: calls 1 internal fn (build_agent_shared_config).


##### `build_agent_resume_config`  (lines 213–218)

```
fn build_agent_resume_config(turn: &TurnContext) -> Result<Config, FunctionCallError>
```

**Purpose**: Creates the configuration snapshot used when resuming an existing agent. It refreshes live runtime settings but leaves base instructions to come from the existing session metadata.

**Data flow**: It receives the current turn context. It asks build_agent_shared_config for the refreshed shared configuration, then clears base_instructions so resume logic can use the instructions already tied to the rollout or session. The Config is returned.

**Call relations**: Resume flows call this when bringing a child agent back. Like build_agent_spawn_config, it uses build_agent_shared_config, but it deliberately avoids overwriting the resumed agent's stored base instructions.

*Call graph*: calls 1 internal fn (build_agent_shared_config).


##### `build_agent_shared_config`  (lines 220–235)

```
fn build_agent_shared_config(turn: &TurnContext) -> Result<Config, FunctionCallError>
```

**Purpose**: Builds the common configuration foundation for both spawning and resuming agents. It makes sure the child starts from the parent's effective config plus the current turn's live choices.

**Data flow**: It reads the turn context, clones the parent's config, updates model name, provider, reasoning effort, reasoning summary, developer instructions, and compact prompt, then calls apply_spawn_agent_runtime_overrides for safety and runtime-only settings. It returns the refreshed Config or an error if a runtime setting cannot be applied.

**Call relations**: This is the shared middle layer called by build_agent_spawn_config and build_agent_resume_config. It hands off to apply_spawn_agent_runtime_overrides because some important settings are not safely captured by simply cloning the saved config.

*Call graph*: calls 1 internal fn (apply_spawn_agent_runtime_overrides); called by 2 (build_agent_resume_config, build_agent_spawn_config).


##### `reject_full_fork_spawn_overrides`  (lines 237–248)

```
fn reject_full_fork_spawn_overrides(
    agent_type: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<ReasoningEffort>,
) -> Result<(), FunctionCallError>
```

**Purpose**: Prevents callers from changing model-related settings when creating a full-history fork. A full-history fork is meant to inherit the parent's agent type, model, and reasoning effort exactly.

**Data flow**: It receives optional agent type, model, and reasoning-effort requests. If any of them are present, it returns a model-facing error explaining that these overrides are not allowed for full-history forks. If none are present, it returns success with no changes.

**Call relations**: Spawn code can call this before building a forked child agent. It acts as a guardrail so later configuration code does not accidentally create a fork that no longer matches the parent history.

*Call graph*: 1 external calls (RespondToModel).


##### `apply_spawn_agent_runtime_overrides`  (lines 254–278)

```
fn apply_spawn_agent_runtime_overrides(
    config: &mut Config,
    turn: &TurnContext,
) -> Result<(), FunctionCallError>
```

**Purpose**: Copies live, turn-specific runtime settings onto a child agent configuration. These settings include approval rules, shell environment policy, sandbox executable, current working directory, and permission profile.

**Data flow**: It receives a mutable Config and the current turn context. It writes the turn's approval policy, reviewer, shell policy, sandbox path, current directory, and permission profile into the config. If approval policy or permission profile cannot be set, it returns a model-facing error; otherwise it leaves the config updated.

**Call relations**: build_agent_shared_config calls this as the final refresh step for spawn and resume configuration. It asks the turn for its permission profile and applies it so the child does not run with stale or unsafe policy.

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

**Purpose**: Applies and validates optional model and reasoning-effort choices for a spawned agent. It makes sure the requested model exists and that the requested reasoning level is supported by that model.

**Data flow**: It receives the session, current turn, mutable child config, optional requested model, and optional requested reasoning effort. If no override is requested, it does nothing. If a model is requested, it lists known models, finds the exact model name, fetches model details, updates the config, and validates or defaults the reasoning effort. If only reasoning effort is requested, it validates that against the parent's current model and then writes it into the config.

**Call relations**: Spawn handlers call this after the base child config exists. It uses find_spawn_agent_model_name to reject unknown models, validate_spawn_agent_reasoning_effort to reject unsupported reasoning levels, and the models manager configuration to fetch model details.

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

**Purpose**: Chooses a valid service tier for a child agent. A service tier is a provider-side option such as a performance or availability class, and it must be supported by the selected model.

**Data flow**: It receives the session, mutable child config, optional parent service tier, and optional requested service tier. It considers the config's existing tier, the requested tier, and the parent tier. If none exist, it clears the child tier. Otherwise it fetches model details, rejects an explicitly requested unsupported tier with a clear message, and then picks the first candidate tier that the model supports.

**Call relations**: Spawn code calls this after the child model has been resolved, because tier support depends on the model. It talks to the models manager using the child config, then either updates config.service_tier or returns a RespondToModel error.

*Call graph*: 3 external calls (to_models_manager_config, format!, RespondToModel).


##### `find_spawn_agent_model_name`  (lines 386–404)

```
fn find_spawn_agent_model_name(
    available_models: &[codex_protocol::openai_models::ModelPreset],
    requested_model: &str,
) -> Result<String, FunctionCallError>
```

**Purpose**: Finds the exact model name requested for a spawned agent. If the name is not known, it builds an error that lists the available choices.

**Data flow**: It receives the available model presets and the requested model string. It searches for a preset whose model name exactly matches the request. On success it returns that model name; on failure it returns a model-facing error that includes all available model names.

**Call relations**: apply_requested_spawn_agent_model_overrides calls this before fetching model details. It is the narrow validation step that turns a user-supplied model string into a trusted model name.

*Call graph*: called by 1 (apply_requested_spawn_agent_model_overrides); 1 external calls (iter).


##### `validate_spawn_agent_reasoning_effort`  (lines 406–426)

```
fn validate_spawn_agent_reasoning_effort(
    model: &str,
    supported_reasoning_levels: &[ReasoningEffortPreset],
    requested_reasoning_effort: &ReasoningEffort,
) -> Result<(), FunctionCallError
```

**Purpose**: Checks whether a requested reasoning effort is allowed for a particular model. Reasoning effort means how much thinking budget or depth the model is asked to use.

**Data flow**: It receives a model name, that model's supported reasoning-effort presets, and the requested reasoning effort. It scans the supported presets for a match. If found, it returns success; otherwise it returns a model-facing error listing the supported efforts.

**Call relations**: apply_requested_spawn_agent_model_overrides calls this whenever a reasoning effort is requested or paired with a requested model. It prevents the child config from being created with a reasoning setting the model cannot use.

*Call graph*: called by 1 (apply_requested_spawn_agent_model_overrides); 3 external calls (format!, iter, RespondToModel).


### `core/src/tools/handlers/multi_agents.rs`

`orchestration` · `request handling`

This file exists so the rest of the system has one clear place to reach the collaboration tools for sub-agents. A sub-agent is another assistant thread that can be spawned by the current assistant turn, like asking a helper to work on a side task while the main conversation continues. Without this file, the system would not have a tidy way to expose those actions as tools, share common parsing rules, or label them in the tool-search interface.

Most of the heavy work lives in nearby modules such as spawning, sending input, waiting, resuming, and closing. This file gathers those pieces and re-exports their handler types, so other code can import them from one place. It also imports shared event and protocol types used by those handlers to report what is happening, such as “spawn began,” “interaction ended,” or “waiting ended.”

The small helper functions here protect the boundary between model text and real system objects. Tool calls arrive with agent IDs as strings. The helpers turn those strings into `ThreadId` values, which are the system’s internal identifier for an agent thread. If the model gives an invalid or empty ID list, the code turns that into a friendly tool error that can be sent back to the model instead of crashing. Another helper builds search metadata so these tools appear under a clear “Multi-agent tools” source when the system lists available tools.

#### Function details

##### `parse_agent_id_target`  (lines 47–51)

```
fn parse_agent_id_target(target: &str) -> Result<ThreadId, FunctionCallError>
```

**Purpose**: This function checks one agent ID written as text and converts it into the system’s internal `ThreadId` form. It is used when a tool call needs to point at a specific sub-agent, and it turns bad IDs into a message the model can understand.

**Data flow**: It receives a string such as an agent ID from a tool argument. It asks `ThreadId` to parse that string. If parsing succeeds, the output is a usable `ThreadId`; if parsing fails, the output is a tool-call error saying the agent ID was invalid.

**Call relations**: When multi-agent tools need to act on an existing sub-agent, they rely on this helper before doing the real work. It hands off the text-to-ID conversion to `ThreadId::from_string`, then wraps any failure as a response meant for the model rather than as an internal crash.

*Call graph*: calls 1 internal fn (from_string).


##### `parse_agent_id_targets`  (lines 53–66)

```
fn parse_agent_id_targets(
    targets: Vec<String>,
) -> Result<Vec<ThreadId>, FunctionCallError>
```

**Purpose**: This function checks a list of agent IDs and converts every one into internal `ThreadId` values. It also rejects an empty list, because actions aimed at agents need at least one actual target.

**Data flow**: It receives a vector of ID strings. First it checks whether the list is empty; if so, it returns a tool-call error. Otherwise it walks through the strings one by one, uses `parse_agent_id_target` for each, and returns a vector of parsed `ThreadId` values if all are valid.

**Call relations**: This is the batch version of the single-ID parser. Multi-agent handlers that accept several target agents can call it once, and it will either give them a clean list of real thread IDs or stop early with a model-facing error explaining what was wrong.

*Call graph*: 1 external calls (RespondToModel).


##### `multi_agent_tool_search_info`  (lines 68–80)

```
fn multi_agent_tool_search_info(
    search_text: &str,
    spec: codex_tools::ToolSpec,
) -> Option<ToolSearchInfo>
```

**Purpose**: This function creates the information needed to show a multi-agent tool in tool search results. It labels the tool as coming from “Multi-agent tools” and adds a short description so users and models can understand what category it belongs to.

**Data flow**: It receives the search text and a tool specification, which describes a tool’s name and shape. It combines those with a source name and description, then returns optional search metadata if the tool specification can be converted into a searchable entry.

**Call relations**: When the system builds searchable tool listings, this helper packages multi-agent tools with a consistent source label. It delegates the actual construction to `ToolSearchInfo::from_spec`, while supplying the multi-agent-specific name and description.

*Call graph*: calls 1 internal fn (from_spec).


### `core/src/tools/handlers/multi_agents/spawn.rs`

`orchestration` · `request handling`

This file is the doorway for creating helper agents. In human terms, it is like a dispatcher: when the main agent decides a job should be delegated, this code checks the request, prepares the instructions, starts the helper, and reports back who was created.

The main `Handler` tells the wider tool system three things: the tool's name, what its input should look like, and how to run it. When the tool is called, `handle_spawn_agent` does the real work. It reads the requested message, optional input items, role, model, reasoning effort, service tier, and whether the new agent should receive the full conversation history. It then checks a safety limit so agents cannot keep spawning deeper and deeper forever.

Before and after spawning, it sends events so the rest of the system can show or record that an agent was started. It builds a configuration for the child agent, applies allowed overrides such as role or model, and rejects combinations that are not allowed when doing a full-history fork. Then it asks the agent control service to create the new thread.

The result is packaged as `SpawnAgentResult`, which can be logged, returned to the model, or formatted for code-mode output. Without this file, the multi-agent feature would have no concrete tool that turns a delegation request into an actual running sub-agent.

#### Function details

##### `Handler::new`  (lines 20–22)

```
fn new(options: SpawnAgentToolOptions) -> Self
```

**Purpose**: Creates a `Handler` with the chosen tool options. This is used when the system is setting up the available tools and needs a configured `spawn_agent` handler.

**Data flow**: It receives `SpawnAgentToolOptions`, stores them inside a new `Handler`, and returns that handler. Nothing else is changed.

**Call relations**: This is the setup step for the handler. After this object exists, the tool system can ask it for its name, specification, search information, and execution behavior.


##### `Handler::tool_name`  (lines 26–28)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the official tool name used to identify this tool: the multi-agent namespace plus `spawn_agent`. This keeps the tool from being confused with similarly named tools elsewhere.

**Data flow**: It reads no request data. It combines the multi-agent namespace with the local name `spawn_agent` and returns a `ToolName`.

**Call relations**: The wider tool runtime calls this when registering or matching tools. It uses `namespaced` so the name is built in the same structured way as other namespaced tools.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 30–32)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the public description of the `spawn_agent` tool, including what inputs it accepts. This is what lets the model know how to call the tool correctly.

**Data flow**: It reads the handler's stored options, clones them, and passes them into the tool-spec builder. The result is a `ToolSpec` that describes the tool interface.

**Call relations**: The tool system can call this directly when exposing tools. `Handler::search_info` also calls it so the searchable description and the actual tool specification stay in sync.

*Call graph*: calls 1 internal fn (create_spawn_agent_tool_v1); called by 1 (search_info); 1 external calls (clone).


##### `Handler::search_info`  (lines 34–39)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides searchable keywords and metadata for this tool. This helps the system find the `spawn_agent` tool when the user's need sounds like delegation, parallel work, or creating a sub-agent.

**Data flow**: It starts with a keyword string, asks `Handler::spec` for the current tool specification, and packages both into optional search information.

**Call relations**: This sits beside the tool specification. When tool discovery or ranking needs hints, it calls this method, which in turn reuses `Handler::spec` rather than rebuilding a separate description by hand.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 41–43)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the actual execution of a `spawn_agent` tool call. It wraps the asynchronous work so the generic tool system can run it like any other tool.

**Data flow**: It receives a `ToolInvocation`, passes that invocation into `handle_spawn_agent`, and wraps the future with `pin` so it can be returned through the shared tool-executor interface. The final successful result is boxed into the standard tool-output shape.

**Call relations**: This is the bridge between the generic tool runtime and the spawn-specific logic. The runtime calls `Handler::handle`; this function then hands control to `handle_spawn_agent`, where the request is parsed, checked, and executed.

*Call graph*: calls 1 internal fn (handle_spawn_agent); 1 external calls (pin).


##### `handle_spawn_agent`  (lines 46–210)

```
async fn handle_spawn_agent(
    invocation: ToolInvocation,
) -> Result<SpawnAgentResult, FunctionCallError>
```

**Purpose**: Performs the full process of creating a child agent from a tool call. It validates the request, prepares the child agent's configuration, emits start and end events, asks the agent-control service to spawn the agent, and returns the new agent ID.

**Data flow**: It receives a `ToolInvocation`, pulls out the session, turn, payload, and call ID, then parses the tool arguments. It turns the user's message and input items into child-agent input, makes a readable prompt preview, computes the next spawn depth, and stops with a model-facing error if the depth limit has been reached. It sends a “spawn began” event, builds the child configuration, applies allowed role, model, reasoning, service-tier, environment, and runtime choices, then asks `agent_control` to create the child agent. After the spawn attempt, it gathers the new thread's metadata if available, sends a “spawn ended” event, records telemetry, and returns `SpawnAgentResult` containing the new agent ID and optional nickname. If spawning fails, the error is converted into a tool-call error.

**Call relations**: This is called by `Handler::handle` whenever the model invokes the tool. Inside the flow, it uses helpers such as `render_input_preview` to make the task readable in events, `next_thread_spawn_depth` and `exceeds_thread_spawn_depth_limit` to prevent runaway nesting, `apply_role_to_config` to shape the child agent's behavior, and `now_unix_timestamp_ms` to timestamp lifecycle events. Its main handoff is to the session's `agent_control.spawn_agent_with_metadata`, which actually creates the new agent thread.

*Call graph*: calls 3 internal fn (render_input_preview, apply_role_to_config, now_unix_timestamp_ms); called by 1 (handle); 4 external calls (pin, exceeds_thread_spawn_depth_limit, next_thread_spawn_depth, RespondToModel).


##### `Handler::matches_kind`  (lines 213–215)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says which kind of tool payload this handler accepts. Here, it only accepts function-call-style payloads.

**Data flow**: It receives a `ToolPayload`, checks whether it is the `Function` variant, and returns `true` or `false`.

**Call relations**: The core tool runtime uses this before routing a payload to the handler. It acts like a simple gate, making sure this handler only runs for the payload shape it knows how to interpret.

*Call graph*: 1 external calls (matches!).


##### `SpawnAgentResult::log_preview`  (lines 237–239)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short JSON-style preview of the spawn result for logs. This lets logs show the important outcome without inventing a separate logging format.

**Data flow**: It reads the `SpawnAgentResult`, formats it using the shared tool-output JSON helper with the name `spawn_agent`, and returns the resulting text.

**Call relations**: After `handle_spawn_agent` succeeds, the generic tool-output system can call this when it needs a human-readable log preview of the returned agent ID and nickname.


##### `SpawnAgentResult::success_for_logging`  (lines 241–243)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this result as a successful tool outcome for logging. Since a `SpawnAgentResult` only exists after a successful spawn, it always returns success.

**Data flow**: It takes no meaningful input beyond the result object itself and returns `true`. It does not change anything.

**Call relations**: The logging layer calls this through the `ToolOutput` interface when deciding how to record the tool call outcome.


##### `SpawnAgentResult::to_response_item`  (lines 245–247)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the spawn result into the response format sent back through the model/tool conversation. This is how the model learns the new agent's ID and optional nickname.

**Data flow**: It receives the original call ID and payload, combines them with the `SpawnAgentResult`, and returns a `ResponseInputItem` marked as a successful `spawn_agent` output.

**Call relations**: Once `handle_spawn_agent` returns a result, the tool framework can call this to attach the result to the correct tool call in the conversation.


##### `SpawnAgentResult::code_mode_result`  (lines 249–251)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Formats the spawn result for code-mode consumers as JSON data. This gives programmatic callers a structured result instead of plain text.

**Data flow**: It reads the `SpawnAgentResult`, ignores the payload because no extra payload-specific formatting is needed, and returns a JSON value labeled for `spawn_agent`.

**Call relations**: The tool-output framework calls this when the result needs to be consumed in code mode. It uses the same result produced by `handle_spawn_agent`, just shaped for a different audience.


### `core/src/tools/handlers/multi_agents/send_input.rs`

`orchestration` · `request handling`

This file is the bridge between a tool call and the agent-control system that actually talks to another agent. In plain terms, it is like a front desk clerk: it checks the request, finds the intended recipient, makes sure that recipient is ready, records that the handoff started, passes along the message, then records how it ended.

When the tool is invoked, the handler reads the tool arguments. It expects a target agent, plus either a message or structured input items, and an optional flag saying whether to interrupt the target first. It turns those inputs into the internal format used for agent conversations and creates a short preview of what is being sent. If the target agent is known, it makes sure that agent is loaded and ready to resume work. If requested, it interrupts the target so the new input can take priority.

The handler then emits a “begin” event, sends the input through the shared agent-control service, checks the recipient’s latest status, and emits an “end” event. Finally, it returns a small result containing a submission ID, which is a receipt showing that the input was accepted. Without this file, the system could define a send-input tool, but tool calls would not actually reach other agents or produce the start/end records needed for tracking.

#### Function details

##### `Handler::tool_name`  (lines 10–12)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the official name of this tool so the runtime can recognize it as the multi-agent “send_input” command.

**Data flow**: It takes no outside data beyond the handler itself. It combines the multi-agent namespace with the tool name “send_input” and returns that full tool name.

**Call relations**: The tool runtime asks this when it needs to identify which tool this handler represents. It uses the shared namespacing helper so this tool’s name does not collide with unrelated tools.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 14–16)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of the “send_input” tool: what arguments it accepts and how it should appear to the tool system.

**Data flow**: It starts with no caller-provided values. It calls the tool-spec builder and returns the resulting specification object.

**Call relations**: Other parts of the runtime use this specification when exposing or validating the tool. The search metadata function also calls this so the searchable entry is tied to the same actual tool definition.

*Call graph*: calls 1 internal fn (create_send_input_tool_v1); called by 1 (search_info).


##### `Handler::search_info`  (lines 18–23)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Adds search keywords and metadata so this tool can be found when the system is looking for a tool related to sending a message to another agent.

**Data flow**: It builds from a keyword string and the tool specification. The output is optional search information that describes when this tool is relevant.

**Call relations**: This function calls `Handler::spec` so its search entry is based on the same definition used by the runtime. It is used when the tool catalog or search layer needs to decide whether “send_input” matches a user or agent need.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 25–27)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the actual work for a “send_input” tool call and returns it as an asynchronous task. Asynchronous means the work may wait for other services, such as agent control, without blocking everything else.

**Data flow**: It receives a tool invocation containing the session, turn, payload, and call ID. It wraps the deeper `handle_call` work in a pinned future, which is the Rust runtime’s way of keeping an async task safely in place while it runs.

**Call relations**: The tool runtime calls this when someone invokes the tool. It immediately hands the real work to `Handler::handle_call`, which performs the parsing, agent lookup, event sending, and final result creation.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 31–111)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Carries out the send-input request from start to finish. It validates the request, prepares the target agent, sends the input, records the interaction, and returns a receipt.

**Data flow**: It receives a full tool invocation. From that, it reads the session, current turn, raw payload, and call ID. It parses the arguments into a target agent, message or input items, and an interrupt flag. It converts the input into the conversation format, makes a readable preview with `render_input_preview`, loads and optionally interrupts the target agent, emits a begin event with the current time from `now_unix_timestamp_ms`, sends the input, checks the target’s status, emits an end event, and finally returns a `SendInputResult` containing the submission ID. If parsing or agent communication fails, it returns an error instead.

**Call relations**: This is the worker function called by `Handler::handle`. During the flow it calls `render_input_preview` so logs and events can show a safe summary of what was sent, and it calls `now_unix_timestamp_ms` to timestamp the begin and end events. It hands the prepared input to the agent-control service, which is the component that actually delivers the message to the other agent.

*Call graph*: calls 2 internal fn (render_input_preview, now_unix_timestamp_ms); called by 1 (handle).


##### `Handler::matches_kind`  (lines 115–117)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Tells the runtime that this handler only accepts function-style tool payloads.

**Data flow**: It receives a tool payload and checks its shape. It returns true if the payload is a function call, and false otherwise.

**Call relations**: The runtime uses this as a quick gate before asking the handler to process a payload. It relies on Rust’s pattern-matching check to keep non-function payloads away from this tool.

*Call graph*: 1 external calls (matches!).


##### `SendInputResult::log_preview`  (lines 135–137)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates the text that should appear in logs for a successful send-input result.

**Data flow**: It reads the result object, especially the submission ID, and turns it into a JSON-like text preview labeled for the “send_input” tool. It does not change the result.

**Call relations**: After `Handler::handle_call` returns a `SendInputResult`, the tool logging path can call this to record a compact, consistent summary of what happened.


##### `SendInputResult::success_for_logging`  (lines 139–141)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this result as a successful tool outcome for logging purposes.

**Data flow**: It takes the result object and always returns true. It does not inspect or modify any fields.

**Call relations**: The logging system can call this after the handler has produced a result, so the tool call is recorded as successful rather than as a failure or uncertain outcome.


##### `SendInputResult::to_response_item`  (lines 143–145)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns the send-input result into the response format expected by the surrounding tool protocol.

**Data flow**: It receives the tool call ID and original payload, combines them with the result data, and returns a response item that can be sent back through the conversation/tool interface.

**Call relations**: Once the handler has completed, the runtime uses this to package the result for the caller. It keeps the response tied to the original call ID so the caller can match the receipt to the request.


##### `SendInputResult::code_mode_result`  (lines 147–149)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Provides the send-input result in the JSON form used by code-oriented tool callers.

**Data flow**: It reads the result object and converts it into a JSON value labeled for the “send_input” tool. The payload argument is accepted for interface consistency but is not used here.

**Call relations**: When the system is operating in a code-style tool mode, it calls this after a successful send-input operation so the caller receives structured data rather than only a display-oriented response.


### `core/src/tools/handlers/multi_agents/wait.rs`

`orchestration` · `request handling`

In this system, several agents can work at the same time. This file provides the tool an agent uses when it needs to wait for another agent’s answer before continuing. Without it, an agent could start helpers but would not have a clean way to know when they were done, report waiting progress, or avoid waiting forever.

The main piece is `Handler`, the tool executor for `wait_agent`. When the tool is called, it reads the requested target agents and the timeout. It checks that the timeout is valid, then clamps it inside allowed limits so callers cannot ask for an unsafe wait. It sends a “waiting has begun” event so the rest of the system can show or record that one agent is waiting on others.

For each target agent, it subscribes to that agent’s status updates. A status is “final” when the agent is done in some terminal way, such as completed or not found. If any target is already final, the tool returns that information right away. Otherwise it waits until one subscribed agent reaches a final status, or until the timeout expires. Think of it like waiting at a service counter: if someone’s ticket is already called, you leave immediately; otherwise you wait, but only up to a fixed time.

At the end, it sends a matching “waiting has ended” event and returns a `WaitAgentResult` containing the final statuses it found and whether the wait timed out.

#### Function details

##### `Handler::new`  (lines 25–27)

```
fn new(options: WaitAgentTimeoutOptions) -> Self
```

**Purpose**: Creates a `Handler` with the timeout settings that should shape the `wait_agent` tool. This is used when the system is setting up the available tools.

**Data flow**: It receives `WaitAgentTimeoutOptions`, stores them inside a new `Handler`, and returns that ready-to-use handler. Nothing else is changed.

**Call relations**: This is the setup doorway for this tool handler. Later, the tool framework calls the handler’s methods to advertise the tool and run it when an agent invokes `wait_agent`.


##### `Handler::tool_name`  (lines 31–33)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the official name of this tool: the multi-agent namespace plus `wait_agent`. The tool framework uses this name to match a model’s tool call to this handler.

**Data flow**: It takes no outside data beyond the handler itself, builds a namespaced tool name, and returns it. It does not modify anything.

**Call relations**: When the tool registry asks what this handler represents, this method supplies the name. It relies on the shared namespacing helper so this tool is named consistently with other multi-agent tools.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 35–37)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the public description of the `wait_agent` tool, including its expected arguments and timeout rules. This description is what the model or tool system can inspect before calling it.

**Data flow**: It reads the handler’s timeout options, passes them into the tool-spec builder, and returns the resulting `ToolSpec`. It does not perform a wait or touch any agent state.

**Call relations**: This is used when the system needs the formal tool definition. `Handler::search_info` also calls it so the searchable metadata points at the same exact tool specification.

*Call graph*: calls 1 internal fn (create_wait_agent_tool_v1); called by 1 (search_info).


##### `Handler::search_info`  (lines 39–44)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides search metadata so the `wait_agent` tool can be found when someone is looking for tool capabilities related to waiting, agent status, completion, or timeouts.

**Data flow**: It gathers a short keyword string and the tool spec, then packages them into optional search information. The output is either that metadata wrapped in `Some`, or no metadata if the helper decided not to produce it.

**Call relations**: This sits beside the formal tool definition. When the tool system builds searchable indexes or help-like listings, it asks this method, which reuses `Handler::spec` to stay consistent.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 46–48)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing an actual `wait_agent` tool call. It wraps the real asynchronous work in the future type expected by the tool framework.

**Data flow**: It receives a `ToolInvocation`, passes it to `Handler::handle_call`, boxes and pins the asynchronous operation, and returns that future. The real waiting happens later when the future is run.

**Call relations**: The tool framework calls this after it has matched a model’s request to this handler. This method is the adapter between the framework’s generic executor interface and the detailed `handle_call` workflow.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 52–214)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Carries out the full `wait_agent` operation: read the request, identify target agents, wait for one or more final statuses, record begin/end events, and return the result. This is the heart of the file.

**Data flow**: It receives a tool invocation containing the session, turn, call id, and raw payload. It parses the arguments into target agent ids and a timeout, looks up display information for those agents, sends a waiting-started event, subscribes to status updates, and waits until a target is already final, becomes final, or the timeout is reached. It then builds a `WaitAgentResult`, sends a waiting-ended event, and returns the result as tool output. If arguments are invalid or a status subscription fails unexpectedly, it returns an error instead.

**Call relations**: This function is launched by `Handler::handle` whenever the model calls `wait_agent`. It uses `wait_for_final_status` for the repeated “watch this one agent until it is final” task, and it uses final-status checks and timestamp helpers so the collaboration events accurately describe the wait.

*Call graph*: calls 3 internal fn (is_final, wait_for_final_status, now_unix_timestamp_ms); called by 1 (handle); 8 external calls (from_millis, new, with_capacity, now, new, with_capacity, timeout_at, RespondToModel).


##### `Handler::matches_kind`  (lines 218–220)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says which kind of tool payload this handler can accept. Here, it only accepts function-style tool calls.

**Data flow**: It receives a tool payload, checks whether it is the function-call form, and returns `true` or `false`. It does not inspect the function arguments themselves.

**Call relations**: The tool runtime can call this before dispatching work to the handler. It acts like a simple gate, ensuring this handler is only used for the payload shape it knows how to process.

*Call graph*: 1 external calls (matches!).


##### `WaitAgentResult::log_preview`  (lines 237–239)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a log-friendly text preview of the `wait_agent` result. This lets logs show what happened without each caller inventing its own formatting.

**Data flow**: It reads the result’s status map and timeout flag, formats them as the standard JSON-like tool output text for `wait_agent`, and returns that string. It does not change the result.

**Call relations**: After `handle_call` returns a `WaitAgentResult`, logging code can ask this method for a compact preview. It connects the result data to the system’s common tool-output logging format.


##### `WaitAgentResult::success_for_logging`  (lines 241–243)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks `wait_agent` outputs as successful for logging purposes. A timeout is still a valid tool outcome, so this method does not treat it as a logging failure.

**Data flow**: It ignores the particular contents of the result and returns `true`. No state is read beyond the method receiver, and nothing is changed.

**Call relations**: When the tool framework records the outcome, it can call this to decide how to label the log entry. This keeps expected results, including timeouts, from being logged as execution errors.


##### `WaitAgentResult::to_response_item`  (lines 245–247)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns the `wait_agent` result into the response item format that can be sent back through the model/tool conversation. This is the bridge from internal Rust data to protocol output.

**Data flow**: It receives the call id and original payload, combines them with the result data, and returns a `ResponseInputItem` in the standard `wait_agent` tool-output shape. It does not modify the result.

**Call relations**: Once `handle_call` has produced a result, the broader tool system uses this method when it needs to place that result back into the conversation stream.


##### `WaitAgentResult::code_mode_result`  (lines 249–251)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Converts the `wait_agent` result into a JSON value for code-oriented consumers. This gives code mode a plain structured object instead of a display string.

**Data flow**: It reads the result’s fields, formats them under the standard `wait_agent` result wrapper, and returns a JSON value. The original result remains unchanged.

**Call relations**: This is used by the tool-output layer when the consumer expects machine-readable JSON. It provides the same information as the normal response path, but in a form that code can inspect directly.


##### `wait_for_final_status`  (lines 254–274)

```
async fn wait_for_final_status(
    session: Arc<Session>,
    thread_id: ThreadId,
    mut status_rx: Receiver<AgentStatus>,
) -> Option<(ThreadId, AgentStatus)>
```

**Purpose**: Watches one agent’s status stream until that agent reaches a final state. It is the small helper that lets the main handler wait on many agents at once.

**Data flow**: It receives the current session, a target agent thread id, and a status receiver, which is like a live subscription to status changes. It first checks the current status; if it is final, it returns it immediately. Otherwise it waits for status changes. If the subscription closes, it asks the agent-control service for the latest known status and returns it only if that status is final. The output is either the thread id plus final status, or `None` if no final status can be confirmed.

**Call relations**: During `Handler::handle_call`, one of these watchers is started for each target agent that was not already final. The main handler races those watchers against the timeout and uses any final statuses they return to build the final tool result.

*Call graph*: calls 1 internal fn (is_final); called by 1 (handle_call); 2 external calls (borrow, changed).


### `core/src/tools/handlers/multi_agents/resume_agent.rs`

`orchestration` · `request handling`

This file is the bridge between a model asking to “resume agent X” and the system services that know how to find, report on, or restart that agent. In a multi-agent run, agents can have their own thread ids, roles, nicknames, and status. Without this file, the model could not use the `resume_agent` tool to continue work with an existing or closed subagent.

The flow is like a front desk reopening a case file. First, the handler identifies itself as the `resume_agent` tool and provides the tool’s schema, which tells the model what arguments to send. When the tool is called, it reads the requested agent id, turns that text id into an internal thread id, and checks whether starting or resuming another thread would exceed the configured nesting limit. That limit prevents agents from spawning chains of agents forever.

The handler then sends a “resume begin” event so the rest of the system can show or log that the attempt started. It asks the agent-control service for the target agent’s current status. If the agent is not found, it tries to resume it from saved rollout data. Finally, it sends a “resume end” event with the resulting status, records telemetry for a successful resume request, and returns a small JSON-like result containing the agent status.

#### Function details

##### `Handler::tool_name`  (lines 11–13)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the official name of this tool: `resume_agent` inside the multi-agent tool namespace. The system uses this name to match an incoming tool call to this handler.

**Data flow**: It takes the handler object, combines the multi-agent namespace with the text name `resume_agent`, and returns a structured tool name. It does not read or change any session state.

**Call relations**: This is part of the tool registration story. It calls the shared naming helper `namespaced` so this tool is identified consistently with other multi-agent tools.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 15–17)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of the `resume_agent` tool, including what arguments it expects. This is what lets the model know how to call the tool correctly.

**Data flow**: It takes no outside input beyond the handler, asks `create_resume_agent_tool` to build the tool specification, and returns that specification. Nothing is stored or changed here.

**Call relations**: The tool system calls this when it needs the schema for the tool. `Handler::search_info` also calls it so the same specification can be used when making the tool discoverable.

*Call graph*: calls 1 internal fn (create_resume_agent_tool); called by 1 (search_info).


##### `Handler::search_info`  (lines 19–24)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Supplies search keywords and metadata that help the system find this tool when a model or planner is looking for a way to resume an agent. It connects human-like search terms such as “reopen closed agent” to the actual tool.

**Data flow**: It starts with a fixed keyword string, gets the tool specification by calling `Handler::spec`, and returns optional search information built from those pieces. It does not inspect a session or modify anything.

**Call relations**: This supports tool discovery rather than execution. Its main handoff is to `Handler::spec`, because the search entry should describe the same tool that will later be executed.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 26–28)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the actual asynchronous work when the `resume_agent` tool is invoked. It wraps the main resume logic in the future shape expected by the tool framework.

**Data flow**: It receives a `ToolInvocation`, packages an asynchronous call to `handle_resume_agent`, and maps the successful result into the standard boxed tool output format. The output is a future that will eventually produce either a tool result or an error.

**Call relations**: This is the entry point from the generic tool executor into this file’s real work. It calls `handle_resume_agent`, which performs validation, event reporting, status lookup, and possible agent resume.

*Call graph*: calls 1 internal fn (handle_resume_agent); 1 external calls (pin).


##### `handle_resume_agent`  (lines 31–138)

```
async fn handle_resume_agent(
    invocation: ToolInvocation,
) -> Result<ResumeAgentResult, FunctionCallError>
```

**Purpose**: Carries out a `resume_agent` request from start to finish. It validates the target agent id, enforces the agent-depth limit, reports progress events, tries to revive a missing closed agent, and returns the target agent’s final status.

**Data flow**: It receives a full tool invocation containing the session, current turn, raw tool payload, and call id. It extracts and parses the arguments, converts the requested id into an internal thread id, reads existing agent metadata and status, and checks whether another nested agent is allowed. It sends a begin event, asks the agent-control service for the target status, optionally calls `try_resume_closed_agent` if the agent is not currently found, sends an end event, records telemetry on success, and returns `ResumeAgentResult` with the final `AgentStatus`. If the id is invalid, the depth limit is reached, or resume fails, it returns an error meant to be shown back to the model.

**Call relations**: This is called by `Handler::handle` whenever the tool runs. During the flow it calls helpers such as `now_unix_timestamp_ms` to timestamp events, `next_thread_spawn_depth` to calculate nesting depth, `ThreadId::from_string` to understand the requested id, and `try_resume_closed_agent` when a missing agent might be recoverable.

*Call graph*: calls 3 internal fn (try_resume_closed_agent, now_unix_timestamp_ms, from_string); called by 1 (handle); 4 external calls (pin, next_thread_spawn_depth, matches!, RespondToModel).


##### `Handler::matches_kind`  (lines 141–143)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Tells the runtime that this handler only accepts function-style tool payloads. In plain terms, it rejects payload shapes that are not ordinary function calls.

**Data flow**: It receives a tool payload, checks whether it is a `Function` payload, and returns `true` or `false`. It does not parse the function arguments or change any state.

**Call relations**: The core tool runtime uses this as an early filter before dispatching work to the handler. It relies on a simple pattern check rather than calling the heavier resume logic.

*Call graph*: 1 external calls (matches!).


##### `ResumeAgentResult::log_preview`  (lines 157–159)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a compact text preview of the resume result for logs. This helps developers and operators see what the tool returned without needing to inspect the full response machinery.

**Data flow**: It reads the `ResumeAgentResult`, formats it as JSON-style text labeled with `resume_agent`, and returns that string. It does not change the result.

**Call relations**: This is used by the generic tool-output logging path after `handle_resume_agent` has produced a result. It turns the result into a readable log snippet.


##### `ResumeAgentResult::success_for_logging`  (lines 161–163)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this tool output as successful for logging purposes. The result object is only created when the resume request completed well enough to return a status.

**Data flow**: It receives the result object and always returns `true`. It reads no fields and changes nothing.

**Call relations**: The tool-output framework calls this when deciding how to label the completed tool call in logs. Errors are handled separately before a `ResumeAgentResult` is returned.


##### `ResumeAgentResult::to_response_item`  (lines 165–167)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the resume result into the response item format that can be sent back to the model. This is how the model learns the resumed agent’s final status.

**Data flow**: It receives the original call id, the original tool payload, and the result. It packages them into a `ResponseInputItem` labeled as a successful `resume_agent` output. It does not alter the session or the stored agent state.

**Call relations**: After `handle_resume_agent` returns a `ResumeAgentResult`, the tool framework uses this method to hand the result back into the conversation as the tool’s answer.


##### `ResumeAgentResult::code_mode_result`  (lines 169–171)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Builds the machine-readable version of the resume result for code-oriented tool output. This gives callers a JSON value rather than only a conversational response item.

**Data flow**: It reads the result, ignores the payload because it does not need extra context, and returns a JSON value labeled for `resume_agent`. Nothing else changes.

**Call relations**: The broader tool-output system calls this when it needs a structured result, for example in code-mode paths. It represents the same status returned by `handle_resume_agent` in a JSON-friendly form.


##### `try_resume_closed_agent`  (lines 174–195)

```
async fn try_resume_closed_agent(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    receiver_thread_id: ThreadId,
    child_depth: i32,
) -> Result<(), FunctionCallError>
```

**Purpose**: Attempts to restart or reconnect a closed agent from saved rollout information. It is used only when the requested agent is not currently found in the active agent-control service.

**Data flow**: It receives the current session, current turn context, the target agent’s thread id, and the calculated child depth. It builds a resume configuration, creates a thread-spawn source describing who is resuming whom, asks the agent-control service to resume the agent from rollout data, and returns success with no value if that works. If configuration, spawn-source creation, or the resume operation fails, it turns the failure into a `FunctionCallError` tied to the target agent id.

**Call relations**: This is called by `handle_resume_agent` after the first status check says the target agent is `NotFound`. It hands the real restart request to `session.services.agent_control.resume_agent_from_rollout`, then lets `handle_resume_agent` re-check status and report the final end event.

*Call graph*: called by 1 (handle_resume_agent); 1 external calls (pin).


### `core/src/tools/handlers/multi_agents/close_agent.rs`

`domain_logic` · `request handling`

This file is the bridge between a user-visible tool call and the internal agent-control system. In this project, an “agent” is a separate worker thread that can be created to help with a task. Without this file, the system could start or talk to helper agents but would not have this standardized tool path for closing one and reporting what happened.

The main piece is `Handler`, which tells the tool system three things: the tool’s name, its formal description, and how to run it when someone calls it. When the tool is invoked, the code reads the provided arguments, extracts the target agent ID, looks up any known nickname or role for that agent, and emits a “close is starting” event. These events are like receipts: they let the rest of the system or UI show that a close request began and later finished.

Before closing the agent, the handler tries to capture the agent’s current status. This matters because after shutdown the live status may no longer be available, but callers still need to know what state the agent was in. It then asks `agent_control` to close the agent. Whether the close succeeds or fails, it sends a matching “close ended” event with timing and identity details. On success, it returns a small result object containing the previous status, formatted in the same standard ways as other tool outputs.

#### Function details

##### `Handler::tool_name`  (lines 10–12)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Gives this tool its official name: the multi-agent `close_agent` tool. The tool system uses this name to match an incoming tool request to this handler.

**Data flow**: It starts with no outside input beyond the handler itself. It combines the shared multi-agent namespace with the specific name `close_agent`, then returns that full tool name.

**Call relations**: This is part of the tool registration story. It calls the shared name-building helper so the tool is named consistently with the rest of the multi-agent tools.

*Call graph*: calls 1 internal fn (namespaced).


##### `Handler::spec`  (lines 14–16)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of the `close_agent` tool, including what arguments it expects. This is what lets callers know how to use the tool correctly.

**Data flow**: It takes no runtime request data. It asks the multi-agent tool specification code to build the version-1 close-agent tool description, then returns that description.

**Call relations**: The handler uses this whenever the tool system needs the tool’s schema. `Handler::search_info` also calls it so the searchable tool entry and the actual callable tool stay based on the same specification.

*Call graph*: calls 1 internal fn (create_close_agent_tool_v1); called by 1 (search_info).


##### `Handler::search_info`  (lines 18–23)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Provides search keywords and metadata so this tool can be found when the system is deciding which tools may be relevant. The keywords include plain terms like close, shutdown, stop, agent, and thread.

**Data flow**: It starts with the handler and no request-specific input. It gets the tool specification from `Handler::spec`, combines it with a keyword string, and returns optional search information for discovery.

**Call relations**: This supports the tool-selection layer before an actual call happens. It calls `Handler::spec` so the search entry points back to the same close-agent tool definition used for execution.

*Call graph*: calls 1 internal fn (spec).


##### `Handler::handle`  (lines 25–27)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the actual work for a `close_agent` tool call. It wraps the close operation in an asynchronous task, meaning the system can wait for the close without blocking other work.

**Data flow**: It receives a full tool invocation, including the session, turn, payload, and call ID. It passes that invocation to `handle_close_agent`, waits for the result, and wraps the successful result into the standard boxed tool-output form.

**Call relations**: This is the handler method the tool runtime calls when the tool is invoked. It hands the real work to `handle_close_agent`, using pinning for the asynchronous future so the runtime can safely poll it.

*Call graph*: calls 1 internal fn (handle_close_agent); 1 external calls (pin).


##### `handle_close_agent`  (lines 30–112)

```
async fn handle_close_agent(
    invocation: ToolInvocation,
) -> Result<CloseAgentResult, FunctionCallError>
```

**Purpose**: Carries out the close-agent request from start to finish. It reads the target agent, records close-start and close-end events, asks the agent-control service to close the agent, and returns the agent’s previous status if the close succeeds.

**Data flow**: It receives a tool invocation. From that it pulls out the session, turn, raw payload, and call ID; parses the payload into a target agent ID; looks up metadata such as nickname and role; sends a begin event with the current timestamp; tries to read the agent’s current status; asks the agent-control service to close the target; sends an end event; and finally returns `CloseAgentResult` containing the status from before the close. If parsing fails or agent-control reports an error, the function returns a tool-call error instead of a normal result.

**Call relations**: This is called by `Handler::handle` whenever someone invokes the close tool. It calls the timestamp helper when writing begin and end events, and it uses an asynchronous pinned close request so the agent-control service can do the shutdown work. It also talks to session services and event output so the rest of the system can observe the close attempt.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (handle); 1 external calls (pin).


##### `Handler::matches_kind`  (lines 115–117)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says which kind of tool payload this handler accepts. Here, it only accepts function-style tool calls.

**Data flow**: It receives a tool payload and checks its shape. If the payload is a function call, it returns true; otherwise it returns false.

**Call relations**: The core tool runtime uses this as a gate before routing work to the handler. It relies on Rust’s pattern-matching check to make sure only the expected payload kind reaches the close-agent execution path.

*Call graph*: 1 external calls (matches!).


##### `CloseAgentResult::log_preview`  (lines 126–128)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short text version of the close-agent result for logs. This helps operators or developers see what the tool returned without needing to inspect the raw object.

**Data flow**: It receives the result object, including the previous agent status. It formats that result as the standard JSON-like log text for the `close_agent` tool and returns the text.

**Call relations**: This is used through the shared `ToolOutput` interface after `handle_close_agent` succeeds. It feeds the logging path rather than the agent-control path.


##### `CloseAgentResult::success_for_logging`  (lines 130–132)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Tells the logging system that this result represents a successful tool call. It always returns true because this method is only used on a successfully created `CloseAgentResult`.

**Data flow**: It receives the result object but does not need to inspect its contents. It simply returns true.

**Call relations**: This is part of the standard output behavior for tool results. After the close handler returns a result, the logging layer can call this to mark the log entry as successful.


##### `CloseAgentResult::to_response_item`  (lines 134–136)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns the close-agent result into the standard response item sent back to the model or caller. This is the user-facing packaging of the result.

**Data flow**: It receives the tool call ID, the original payload, and the result object. It builds a response item labeled for `close_agent`, includes the result data, marks it as successful, and returns that response item.

**Call relations**: This is called through the shared tool-output path after the close operation has completed. It converts the internal result into the common response format expected by the surrounding conversation system.


##### `CloseAgentResult::code_mode_result`  (lines 138–140)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Formats the close-agent result for code-oriented output, where the caller expects structured JSON rather than a conversational response item.

**Data flow**: It receives the result object and the original payload, though it does not need the payload here. It converts the result into a JSON value labeled for the `close_agent` tool and returns that value.

**Call relations**: This is another branch of the shared `ToolOutput` interface. When the environment wants a code-mode result instead of a normal response item or log preview, this method provides the structured version.


### `core/src/tools/handlers/multi_agents_v2.rs`

`orchestration` · `request handling`

This file exists so the rest of the codebase has one clear place to find the tools used for agent-to-agent collaboration. In this project, a “tool handler” is the code that runs when the model asks to use a named tool, such as spawning another agent, listing agents, sending a message, interrupting an agent, or waiting for one. Instead of making callers know about many separate files, this file collects those handlers and exposes them under clear names like SpawnAgentHandler and SendMessageHandler.

It also declares the submodules that contain the actual work for each tool. Think of this file like a reception desk: it does not do every job itself, but it knows which office is responsible for each collaboration action.

The one function here, communication_from_tool_message, performs a small but important translation. Tool calls work with plain fields such as author, recipient, and message text. The collaboration system expects an InterAgentCommunication object. This helper wraps the plain message into that structured form, marks it as encrypted, and says it should trigger a turn for the receiving agent. Without this conversion step, a message sent through a tool would not be in the format the agent communication system expects.

#### Function details

##### `communication_from_tool_message`  (lines 43–55)

```
fn communication_from_tool_message(
    author: AgentPath,
    recipient: AgentPath,
    message: String,
) -> InterAgentCommunication
```

**Purpose**: Turns a plain tool message into the structured message format used for communication between agents. Someone would use it when a tool has collected the sender, receiver, and text, and needs to hand that message to the collaboration system.

**Data flow**: It receives the author agent path, the recipient agent path, and the message text. It packages those into a new encrypted InterAgentCommunication object, with no extra attached items, and marks the message as one that should wake or trigger the recipient agent. The output is the ready-to-send communication object.

**Call relations**: This helper sits between tool-level input and the lower-level inter-agent communication type. Its main handoff is to InterAgentCommunication::new_encrypted, which builds the final message object in the format the protocol expects.

*Call graph*: calls 1 internal fn (new_encrypted); 1 external calls (new).


### `core/src/tools/handlers/multi_agents_v2/message_tool.rs`

`orchestration` · `request handling`

This file is a small but important piece of the multi-agent system. It is used when one agent wants to talk to another agent through a tool call. There are two closely related actions: a normal message, which is queued for the other agent, and a follow-up task, which should wake the other agent and make it start working right away. Rather than duplicate the same steps in two places, this file puts the common path in one function.

The flow is like sending a package through an internal office mailroom. First, the file checks that the package is not empty. Then it resolves the written target name into the actual receiving agent thread. It verifies that the agent is known to the system, and for follow-up tasks it blocks one special case: the root agent cannot be given a follow-up task. After that, it prepares the receiving agent so it can resume work, builds the actual inter-agent communication message, and sends it through the agent control service.

The file also records that an interaction happened by sending a sub-agent activity event with a timestamp. This matters because other parts of the system can show or track agent activity. If this file were missing or wrong, agents could send blank messages, target invalid agents, wake the wrong agent, or fail to record that a handoff happened.

#### Function details

##### `MessageDeliveryMode::apply`  (lines 19–30)

```
fn apply(self, communication: InterAgentCommunication) -> InterAgentCommunication
```

**Purpose**: This function sets whether a message should simply wait in the target agent's queue or immediately wake that agent to take a turn. It turns the chosen delivery mode into the `trigger_turn` flag on the communication object.

**Data flow**: It receives a delivery mode and an already-built inter-agent communication. If the mode is `QueueOnly`, it returns the same communication with `trigger_turn` set to false. If the mode is `TriggerTurn`, it returns the communication with `trigger_turn` set to true.

**Call relations**: The shared message-sending function calls this right before handing the communication to the agent control service. In the larger flow, it is the final switch that makes `send_message` and `followup_task` behave differently even though they share the same sending pipeline.

*Call graph*: called by 1 (handle_message_string_tool).


##### `message_content`  (lines 49–56)

```
fn message_content(message: String) -> Result<String, FunctionCallError>
```

**Purpose**: This function rejects messages that are empty or contain only whitespace. It protects the rest of the agent messaging system from receiving meaningless blank communications.

**Data flow**: It receives the raw message text from the tool input. It trims the text only for checking whether anything real is there. If the message is blank, it returns an error that can be shown back to the model. Otherwise, it returns the original message unchanged.

**Call relations**: The main shared message handler calls this as its first validation step. If this function finds a blank message, the flow stops immediately and no target lookup, agent loading, or message sending happens.

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

**Purpose**: This is the shared workhorse for the multi-agent `send_message` and `followup_task` tools. It validates the message, finds and prepares the receiving agent, sends the communication, and records an activity event.

**Data flow**: It receives the tool invocation context, the delivery mode, the target name, and the message text. It first checks that the message is not empty. Then it uses the current session and turn to resolve the target into a receiver thread, confirms the agent is known, blocks follow-up tasks to the root agent, loads the v2 agent if needed, and builds a communication from the sender to the receiver. It sends that communication with the chosen delivery behavior, emits an activity event with the current time and tool call id, and finally returns an empty successful tool output.

**Call relations**: This function is called by the higher-level tool-call handler for both message-style tools. It delegates small pieces of work to helpers: `message_content` checks the text, `MessageDeliveryMode::apply` sets whether the receiver should wake up, and the agent control service performs the actual agent lookup, loading, and message delivery. After delivery, it reports the interaction back to the session event stream so the rest of the system can observe it.

*Call graph*: calls 4 internal fn (from_text, apply, message_content, now_unix_timestamp_ms); called by 2 (handle_call, handle_call); 2 external calls (new, RespondToModel).


### `core/src/tools/handlers/multi_agents_v2/spawn.rs`

`orchestration` · `request handling`

This file is the doorway between a model asking “please start another agent” and the system actually creating that agent. Without it, the `spawn_agent` tool could be advertised, but a tool call would not know how to turn the model’s JSON arguments into a real new agent thread.

The main `Handler` gives the tool its name, its public specification, and the code to run when the tool is called. The heavy work happens in `handle_spawn_agent`. It reads the tool arguments, checks whether the caller asked to fork no history, all history, or only the last few turns, then builds a configuration for the child agent. It can apply a requested role, model, reasoning effort, service tier, and runtime settings, while rejecting combinations that are not allowed for a full-history fork.

Once the configuration is ready, it creates a “spawn source,” which is like a birth certificate for the new task: where it came from, how deep it is in the agent tree, and what its canonical task name is. It then asks the agent control service to start the child agent. If the initial message is plain text, the file wraps it as inter-agent communication so the child sees it as coming from its parent agent, not as an ordinary user message.

After the spawn succeeds, it emits an activity event, records telemetry, and returns either the task name plus nickname or only the task name, depending on configuration.

#### Function details

##### `Handler::new`  (lines 20–22)

```
fn new(options: SpawnAgentToolOptions) -> Self
```

**Purpose**: Creates a new `spawn_agent` tool handler with the options that control how the tool is described and exposed. Someone uses this when wiring the tool into the runtime.

**Data flow**: It receives `SpawnAgentToolOptions` as input, stores those options inside a new `Handler`, and returns that handler. Nothing else is changed.

**Call relations**: This is the setup step for the handler. Later, the runtime calls the same handler’s `tool_name`, `spec`, `matches_kind`, and `handle` methods when it needs to advertise or execute the tool.


##### `Handler::tool_name`  (lines 26–28)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Tells the tool system that this handler is for the tool named `spawn_agent`. This is how an incoming tool call is matched to the right code.

**Data flow**: It takes the handler as input, builds a plain tool name from the text `spawn_agent`, and returns that name. It does not read or change the handler’s options.

**Call relations**: The tool runtime calls this while registering or matching tools. It hands off to `plain` to create the standard `ToolName` value used by the rest of the tool system.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 30–32)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the public description of the `spawn_agent` tool: what arguments it accepts and how the model should call it. This is the menu entry the model sees before deciding to use the tool.

**Data flow**: It reads the handler’s stored options, clones them so the original handler keeps its copy, passes them into `create_spawn_agent_tool_v2`, and returns the resulting tool specification.

**Call relations**: The runtime calls this when it needs to publish the tool schema. The actual schema-building work is delegated to `create_spawn_agent_tool_v2`, while this handler supplies the options chosen at setup time.

*Call graph*: calls 1 internal fn (create_spawn_agent_tool_v2); 1 external calls (clone).


##### `Handler::handle`  (lines 34–36)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the asynchronous work of carrying out a `spawn_agent` tool call. It adapts the real spawning function into the future-based shape expected by the tool runtime.

**Data flow**: It receives a `ToolInvocation`, wraps an async call to `handle_spawn_agent` in a pinned future, and arranges for a successful result to be boxed as normal tool output. The returned future will later produce either a tool result or an error.

**Call relations**: The tool runtime calls this when the model invokes `spawn_agent`. This method immediately hands the real work to `handle_spawn_agent`, which performs the argument parsing, configuration, spawning, event sending, and result creation.

*Call graph*: calls 1 internal fn (handle_spawn_agent); 1 external calls (pin).


##### `handle_spawn_agent`  (lines 39–177)

```
async fn handle_spawn_agent(
    invocation: ToolInvocation,
) -> Result<SpawnAgentResult, FunctionCallError>
```

**Purpose**: Does the full job of turning a `spawn_agent` tool call into a running child agent. It validates the request, prepares the child’s settings, starts the child thread, announces that it started, and returns the information the model should see.

**Data flow**: It starts with the invocation: the current session, turn, raw tool payload, and call id. It extracts and parses the JSON arguments, decides the fork mode, builds the child agent configuration, applies requested role/model/service settings when allowed, and creates a spawn source with a canonical agent path. It then asks the agent control service to spawn the new agent, possibly converting a plain-text initial message into inter-agent communication. After the child is created, it reads a config snapshot to find a nickname, sends a started event, records telemetry, and returns either `{ task_name, nickname }` or just `{ task_name }` depending on whether metadata should be hidden.

**Call relations**: This is called by `Handler::handle` whenever the tool is executed. It calls helpers such as `next_thread_spawn_depth` to place the child in the agent tree, `apply_role_to_config` to apply a named role, and `now_unix_timestamp_ms` to timestamp the started event. It also uses the session’s agent control service as the final handoff point where the new agent is actually created.

*Call graph*: calls 2 internal fn (apply_role_to_config, now_unix_timestamp_ms); called by 1 (handle); 4 external calls (pin, from, next_thread_spawn_depth, matches!).


##### `Handler::matches_kind`  (lines 180–182)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says which kind of tool payload this handler accepts. For this handler, only function-style tool calls are valid.

**Data flow**: It receives a tool payload, checks whether it is a function payload, and returns `true` if it is and `false` otherwise. It does not change any state.

**Call relations**: The runtime can call this before dispatching a tool call. It acts as a small gatekeeper so `Handler::handle` is only used for the payload shape it understands.

*Call graph*: 1 external calls (matches!).


##### `SpawnAgentArgs::fork_mode`  (lines 199–232)

```
fn fork_mode(&self) -> Result<Option<SpawnAgentForkMode>, FunctionCallError>
```

**Purpose**: Turns the user-facing `fork_turns` argument into the internal choice for how much conversation history the new agent should inherit. It also rejects the older `fork_context` option, which is not supported in MultiAgentV2.

**Data flow**: It reads `fork_context` and `fork_turns` from the parsed arguments. If `fork_context` is present, it returns an error message for the model. If `fork_turns` is missing or empty, it treats it as `all`; `none` means no fork, `all` means full history, and a positive number means the last N turns. Invalid text or zero becomes a model-facing error.

**Call relations**: `handle_spawn_agent` uses this early, before building the child agent. The returned fork mode controls later decisions, including whether model and role overrides are allowed and which spawn options are sent to the agent control service.

*Call graph*: 2 external calls (LastNTurns, RespondToModel).


##### `SpawnAgentResult::log_preview`  (lines 248–250)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short JSON-style preview of the successful spawn result for logs. This helps operators inspect what happened without needing the full internal object.

**Data flow**: It receives the result value, formats it as tool output text labeled for `spawn_agent`, and returns that string. It does not change the result.

**Call relations**: The tool output system calls this when it wants a log-friendly preview. It is part of the `ToolOutput` implementation that makes `SpawnAgentResult` usable as a standard tool response.


##### `SpawnAgentResult::success_for_logging`  (lines 252–254)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks every `SpawnAgentResult` value as a successful tool outcome for logging purposes. If this type exists as a result, the spawn operation has already succeeded.

**Data flow**: It receives the result value and always returns `true`. No input fields are inspected and no state is changed.

**Call relations**: The logging layer calls this through the `ToolOutput` interface. It complements `log_preview` by telling logs that this response should be counted as a success.


##### `SpawnAgentResult::to_response_item`  (lines 256–258)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the spawn result into the response item format that can be sent back through the protocol. This is what lets the model receive the tool result in the expected shape.

**Data flow**: It receives the tool call id, the original payload, and the result. It packages the result as a `spawn_agent` tool output response item, marking it as successful, and returns that protocol item.

**Call relations**: The tool runtime calls this after `handle_spawn_agent` returns successfully. It hands the formatting work to the shared tool-output helper so `spawn_agent` responses look like other tool responses.


##### `SpawnAgentResult::code_mode_result`  (lines 260–262)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Converts the spawn result into a JSON value for code-mode consumers. Code mode needs machine-readable data rather than a display-oriented response item.

**Data flow**: It receives the result and the original payload, ignores the payload, formats the result as JSON labeled for `spawn_agent`, and returns that JSON value.

**Call relations**: The tool system calls this when the result is needed in code-mode form. Like the other `SpawnAgentResult` output methods, it is part of making the result fit the common `ToolOutput` interface.


### `core/src/tools/handlers/multi_agents_v2/send_message.rs`

`io_transport` · `request handling`

This file is a small bridge between the tool system and the multi-agent message system. In this project, tools are actions that an agent can ask the runtime to perform. The `send_message` tool is the action for sending a message to another agent. Without this handler, the tool could still be described in the tool list, but calls to it would not know how to turn the raw request into an actual queued message.

The central piece is `Handler`, a lightweight object that tells the runtime three things: the tool is named `send_message`, its public shape comes from the shared tool specification, and calls to it should be processed by `handle_call`. When a call arrives, the handler first extracts the function-style arguments from the tool payload. It then parses those arguments into `SendMessageArgs`, which gives the code clear fields such as the target agent and the message text.

After parsing, the handler passes the request to the shared message-sending helper, using `MessageDeliveryMode::QueueOnly`. That mode is important: it means the message is added to the recipient’s queue, like putting a letter in a mailbox, instead of trying to force the recipient to answer immediately. The file also tells the broader runtime that this handler only accepts function-call style tool payloads.

#### Function details

##### `Handler::tool_name`  (lines 11–13)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This function tells the tool runtime the public name of this tool: `send_message`. The runtime uses that name to match an incoming tool request to this handler.

**Data flow**: It takes the handler itself as input, reads no outside state, and creates a plain tool name containing `send_message`. The result is returned to the caller so the tool can be registered or looked up by name.

**Call relations**: This is part of the standard tool-executor interface. When the runtime is discovering or matching tools, it asks the handler for its name; this function builds that name using the shared plain-name helper.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 15–17)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This function provides the formal description of the `send_message` tool. That description tells the system, and likely the model using the tool, what arguments the tool expects.

**Data flow**: It takes the handler as input, reads no local state, and asks the shared multi-agent specification code to create the `send_message` tool definition. It returns that tool specification to the runtime.

**Call relations**: During tool setup or exposure, the runtime asks this handler for its specification. Rather than defining the schema here, this function delegates to the shared `create_send_message_tool` builder so the handler and the advertised tool shape stay consistent.

*Call graph*: calls 1 internal fn (create_send_message_tool).


##### `Handler::handle`  (lines 19–21)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: This function is the entry point used by the tool runtime when someone actually invokes `send_message`. It wraps the real async work so the runtime can run it later as a future, which is Rust’s way of representing work that may finish asynchronously.

**Data flow**: It receives a `ToolInvocation`, which contains the raw tool call and its payload. It turns the call into an asynchronous task by forwarding it to `handle_call`, boxes and pins that task so it has the shape the tool framework expects, and returns it.

**Call relations**: The wider tool system calls this function after it has selected this handler for a request. This function does not parse or deliver the message itself; it hands the invocation to `Handler::handle_call`, which performs the actual work.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 25–39)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: This function performs the actual `send_message` work. It reads the tool call’s arguments, turns them into a target and message, and queues the message for delivery.

**Data flow**: It starts with a raw `ToolInvocation`. It extracts the function arguments from the payload, parses them into `SendMessageArgs`, then takes the target agent and message text from those parsed arguments. It passes those values, along with the original invocation and the `QueueOnly` delivery mode, to the shared message helper. If everything succeeds, the helper’s output is boxed into the standard tool-output form; if parsing or delivery fails, an error is returned.

**Call relations**: This function is called by `Handler::handle` when the runtime is executing the tool. It relies on common argument parsing helpers before handing the real message operation to `handle_message_string_tool`, so the details of message queuing stay shared with related message tools.

*Call graph*: calls 1 internal fn (handle_message_string_tool); called by 1 (handle).


##### `Handler::matches_kind`  (lines 43–45)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: This function tells the core tool runtime which kind of payload this handler can accept. For this handler, only function-call payloads are valid.

**Data flow**: It receives a tool payload, checks whether it is the function-call variant, and returns `true` if it is or `false` otherwise. It does not change the payload or any stored state.

**Call relations**: The runtime can use this check before dispatching a tool request to the handler. It acts like a simple gatekeeper: only payloads shaped like function calls are allowed through to the rest of the `send_message` handling path.

*Call graph*: 1 external calls (matches!).


### `core/src/tools/handlers/multi_agents_v2/followup_task.rs`

`orchestration` · `tool invocation`

This file is a small adapter between the tool system and the message-sending machinery used by multi-agent features. In plain terms, it teaches the runtime what the `followup_task` tool is called, what its input should look like, when it is allowed to run, and how to turn a tool call into an actual message.

The `Handler` is the main piece. When the tool runtime asks what tool this is, the handler answers `followup_task`. When the runtime needs a formal description of the tool, the handler returns the specification created elsewhere. When the tool is actually called, the handler reads the raw function-call payload, parses it into `FollowupTaskArgs`, and extracts two important fields: the target agent and the message to send.

The key behavior is the delivery mode: this file sends the message with `MessageDeliveryMode::TriggerTurn`. That means the follow-up is not merely recorded like a note on a bulletin board; it is more like ringing someone’s doorbell so they know to act. Without this file, the runtime would not know how to recognize or execute `followup_task` calls, and follow-up work between agents would not be started through this tool.

#### Function details

##### `Handler::tool_name`  (lines 11–13)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the tool system the public name of this tool: `followup_task`. The name is how an incoming tool request is matched to this handler.

**Data flow**: It takes no outside input beyond the handler itself. It creates a plain tool name from the text `followup_task` and returns that name to the tool registry or dispatcher.

**Call relations**: When the tool system is deciding which executor belongs to a requested tool, it asks this handler for its name. This function uses `plain` to build the standard `ToolName` value that the rest of the runtime can compare.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 15–17)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This returns the formal description of the `followup_task` tool: what it is and what arguments it accepts. The runtime can use that description to expose the tool correctly to a model or caller.

**Data flow**: It receives only the handler. It calls `create_followup_task_tool`, which builds the tool specification, and returns that specification unchanged.

**Call relations**: During setup or tool listing, the runtime asks this handler for its specification. This function delegates the details to `create_followup_task_tool`, keeping this file focused on connecting the tool definition to execution.

*Call graph*: calls 1 internal fn (create_followup_task_tool).


##### `Handler::handle`  (lines 19–21)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: This is the standard entry point used when the `followup_task` tool is invoked. It starts the actual work asynchronously, meaning the runtime can wait for the result without blocking everything else.

**Data flow**: It receives a `ToolInvocation`, which contains the incoming tool call and its payload. It wraps the deeper `handle_call` operation in a pinned future, which is Rust’s way of packaging asynchronous work so the runtime can drive it to completion later.

**Call relations**: The tool runtime calls this when a matching tool invocation arrives. Rather than doing the parsing and sending itself, it hands the invocation to `Handler::handle_call`, which performs the real follow-up task behavior.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 25–39)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: This performs the actual `followup_task` action. It reads the tool arguments, finds the intended target and message, and sends that message in a way that triggers the target to take a new turn.

**Data flow**: It starts with a `ToolInvocation` containing a raw payload. It extracts the function arguments from that payload, parses them into `FollowupTaskArgs`, then passes the original invocation, the trigger-turn delivery mode, the target, and the message into `handle_message_string_tool`. The result is converted into the boxed tool-output form expected by the runtime, or an error is returned if argument extraction, parsing, or message delivery fails.

**Call relations**: This function is called by `Handler::handle` after the runtime has dispatched the tool call here. It relies on shared message-tool code, `handle_message_string_tool`, to do the actual delivery so that follow-up messages behave consistently with other message-based tools.

*Call graph*: calls 1 internal fn (handle_message_string_tool); called by 1 (handle).


##### `Handler::matches_kind`  (lines 43–45)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: This tells the core runtime which kind of tool payload this handler accepts. In this case, it only accepts function-style tool calls.

**Data flow**: It receives a `ToolPayload` and checks whether it is a `Function` payload. It returns `true` for function payloads and `false` for other payload shapes.

**Call relations**: Before or during dispatch, the core tool runtime can ask whether this handler is suitable for a given payload. This function acts like a simple gatekeeper so the `followup_task` handler is only used for the kind of invocation its parsing code expects.

*Call graph*: 1 external calls (matches!).


### `core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs`

`domain_logic` · `request handling`

This file is the control point for a tool named `interrupt_agent`. In this system, an agent can spawn other agents to work on subtasks. Sometimes a parent or coordinating agent needs to stop one of those workers early, for example because the work is no longer needed or the plan has changed. This file turns that tool request into a safe interruption.

The main flow starts when the tool runtime calls the handler with a tool invocation. The code reads the tool arguments, finds the requested target agent, and checks that the target is a real known agent. It then refuses two unsafe cases: the root agent cannot be interrupted this way, and an agent cannot interrupt itself. That is like refusing to let a worker pull the main power switch, or cut their own phone line while still expected to report back.

Before sending the interrupt, the file asks for the target agent’s current status. That status is returned later so the caller can understand what state the agent was in before the stop request. The interruption itself is sent through the shared agent control service. If the target is already gone or has died internally, the code treats that as acceptable, because the intended result is already true: the agent is no longer running normally. Finally, it emits an activity event so the rest of the session can see that the sub-agent was interrupted.

#### Function details

##### `Handler::tool_name`  (lines 10–12)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool: `interrupt_agent`. The tool runtime uses this name to match an incoming tool call to this handler.

**Data flow**: It takes no outside data beyond the handler itself. It creates a plain tool name from the text `interrupt_agent` and returns that name to the caller.

**Call relations**: When the tool system is building or looking up available tools, it asks this handler for its name. This function delegates the small job of constructing the name to the shared `plain` helper.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 14–16)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of the `interrupt_agent` tool, including what arguments it expects. This is what lets the model or tool runtime know how to call it correctly.

**Data flow**: It receives no input other than the handler. It asks `create_interrupt_agent_tool_v2` to build the tool specification and returns that specification.

**Call relations**: The runtime calls this when it needs to advertise or validate the tool. Instead of defining the schema here, it hands that work to the shared multi-agent tool specification builder.

*Call graph*: calls 1 internal fn (create_interrupt_agent_tool_v2).


##### `Handler::handle`  (lines 18–24)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the actual work when the `interrupt_agent` tool is invoked. It wraps the asynchronous interrupt operation in the future shape expected by the tool runtime.

**Data flow**: It receives a `ToolInvocation`, which contains the session, current turn, raw tool payload, and call id. It passes that invocation into `handle_interrupt_agent`, waits for the result, and converts a successful result into the generic boxed tool output format used by the rest of the system.

**Call relations**: The tool runtime calls this after matching an incoming function-style tool call to this handler. This function is a thin bridge: it pins the asynchronous work so the runtime can drive it, and the real decision-making happens in `handle_interrupt_agent`.

*Call graph*: calls 1 internal fn (handle_interrupt_agent); 1 external calls (pin).


##### `handle_interrupt_agent`  (lines 27–91)

```
async fn handle_interrupt_agent(
    invocation: ToolInvocation,
) -> Result<InterruptAgentResult, FunctionCallError>
```

**Purpose**: Carries out the interruption request safely. It parses the requested target, verifies that the target can be interrupted, asks the agent-control service to interrupt it, records an activity event, and returns the target’s earlier status.

**Data flow**: It starts with a full tool invocation. From that it reads the session, current turn, raw payload, and call id. It parses the payload into an argument object containing a target string, resolves that string into an agent id, checks that the agent is known, rejects root-agent and self-interrupt cases, reads the agent’s current status, then sends the interrupt request. After a successful or already-effectively-stopped result, it sends a session event with the time, target id, target path, and interruption kind. It returns an `InterruptAgentResult` containing the status observed before the interrupt.

**Call relations**: This is called by `Handler::handle` when the tool is used. It relies on shared helpers to parse arguments and resolve the target, uses the session’s agent-control service for status lookup and interruption, calls `now_unix_timestamp_ms` to timestamp the activity event, and uses model-facing errors when the request is invalid. Its output is later formatted by the `InterruptAgentResult` tool-output methods.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (handle); 1 external calls (RespondToModel).


##### `Handler::matches_kind`  (lines 94–96)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says which kind of tool payload this handler accepts. This handler only accepts function-style tool calls.

**Data flow**: It receives a tool payload and checks its shape. It returns `true` if the payload is a function call and `false` otherwise.

**Call relations**: The core tool runtime uses this before routing work to the handler. It acts as a simple gate so non-function payloads are not sent into the interrupt-agent logic.

*Call graph*: 1 external calls (matches!).


##### `InterruptAgentResult::log_preview`  (lines 111–113)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a compact text version of the result for logs. This helps operators or developers see what the tool returned without needing the full response machinery.

**Data flow**: It reads the `InterruptAgentResult`, especially the previous agent status inside it. It turns that data into JSON-like text labeled as output from `interrupt_agent` and returns the text.

**Call relations**: After `handle_interrupt_agent` succeeds, the tool framework can call this when writing logs. It uses the shared tool-output formatting path so logs look consistent with other tools.


##### `InterruptAgentResult::success_for_logging`  (lines 115–117)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports that this result should be treated as a successful tool call in logs. If an `InterruptAgentResult` exists, the interruption request completed acceptably.

**Data flow**: It does not need to inspect any fields. It simply returns `true`.

**Call relations**: The logging layer calls this through the `ToolOutput` interface. Errors are handled before a result is created, so this result type always represents success from the logger’s point of view.


##### `InterruptAgentResult::to_response_item`  (lines 119–121)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the result into the response format sent back through the tool-calling conversation. This is how the caller learns the target agent’s previous status.

**Data flow**: It receives the call id, the original tool payload, and the result data. It packages those into a response item marked as a successful `interrupt_agent` output and returns that response item.

**Call relations**: Once the handler has produced an `InterruptAgentResult`, the tool framework calls this to attach the result to the correct tool call. It delegates to the shared response-item formatter so this tool’s reply matches the system’s standard format.


##### `InterruptAgentResult::code_mode_result`  (lines 123–125)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Converts the result into a JSON value for code-oriented tool output. This gives programmatic consumers a structured version instead of only human-readable text.

**Data flow**: It receives the original payload and the result object. It ignores the payload, serializes the result under the `interrupt_agent` tool name, and returns the JSON value.

**Call relations**: The tool framework calls this when it needs the result in code mode. It uses the shared code-mode formatter, keeping this tool’s structured output consistent with other tool handlers.


### `core/src/tools/handlers/multi_agents_v2/list_agents.rs`

`orchestration` · `request handling`

This file is the small bridge between a user-facing tool named `list_agents` and the system that keeps track of running or known agents. Without it, the model or client could request an agent list, but there would be no handler that understands the request, checks its arguments, asks the agent registry, and returns a usable response.

The flow is like asking a front desk for a list of available staff. The handler first identifies itself as the `list_agents` tool and provides the tool’s public description, so callers know how to invoke it. When a call arrives, it pulls out the session, turn, and payload. It reads the function arguments, parses them into `ListAgentsArgs`, and optionally uses a `path_prefix` to narrow the list. Before listing agents, it registers the session’s root thread with the agent-control service, so the service understands how this session is connected to the broader conversation.

The actual lookup is delegated to `agent_control.list_agents`, which is the service that knows about agents. This handler then wraps the returned `ListedAgent` entries in `ListAgentsResult`. That result knows how to turn itself into logs, normal tool responses, and code-mode JSON output. The file is intentionally focused: it does not decide what an agent is; it just validates the request, calls the right service, and formats the answer.

#### Function details

##### `Handler::tool_name`  (lines 9–11)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool: `list_agents`. The tool framework uses this name to match incoming tool calls to this handler.

**Data flow**: It takes no outside data beyond the handler itself. It creates a plain tool name from the text `list_agents` and returns it to the tool runtime.

**Call relations**: When the tool system is discovering or dispatching tools, it asks this handler for its name. This function hands back the label that lets the wider system recognize calls meant for the list-agents feature.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 13–15)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of how the `list_agents` tool should be called. This description tells callers what arguments are allowed and what the tool is for.

**Data flow**: It takes no request data. It calls the shared tool-spec builder for `list_agents` and returns the resulting specification.

**Call relations**: The tool framework calls this when it needs to advertise or validate available tools. This function delegates the details to `create_list_agents_tool`, keeping the handler aligned with the shared multi-agent tool definition.

*Call graph*: calls 1 internal fn (create_list_agents_tool).


##### `Handler::handle`  (lines 17–19)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing one incoming `list_agents` tool call. It wraps the real async work so the tool framework can wait for it in the standard way.

**Data flow**: It receives a `ToolInvocation`, which contains the session, turn information, and raw tool payload. It passes that invocation into `handle_call`, pins the async task so it can be safely driven by the runtime, and returns that future.

**Call relations**: The tool runtime calls this after it has chosen this handler for a request. This function immediately hands the real work to `Handler::handle_call`, acting as the adapter between the runtime’s expected shape and the handler’s async logic.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 23–47)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the actual `list_agents` request: it reads the tool arguments, asks the agent-control service for matching agents, and returns the result as tool output.

**Data flow**: It receives a full tool invocation. From that, it takes the session, the current turn, and the payload. It extracts function arguments from the payload, parses them into `ListAgentsArgs`, records the relationship between the session thread and parent thread, then asks `agent_control` for agents visible from the turn’s session source, optionally filtered by `path_prefix`. If the service succeeds, it wraps the agent list in `ListAgentsResult`; if the service reports a spawn or collaboration error, it converts that into a tool-call error.

**Call relations**: This is called by `Handler::handle` whenever the `list_agents` tool is invoked. It sits between the generic tool system and the agent-control subsystem: the tool system supplies the invocation, this function translates it into an agent-control query, and the result is handed back as standardized tool output.

*Call graph*: called by 1 (handle).


##### `Handler::matches_kind`  (lines 51–53)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says whether this handler can process a particular kind of tool payload. Here, it accepts function-style payloads.

**Data flow**: It receives a `ToolPayload` and checks whether it is the `Function` form. It returns `true` for function payloads and `false` for anything else.

**Call relations**: The core tool runtime uses this as a quick compatibility check before routing a payload to the handler. It keeps this handler from being used for payload shapes it does not understand.

*Call graph*: 1 external calls (matches!).


##### `ListAgentsResult::log_preview`  (lines 68–70)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a readable log version of the agent-list result. This lets logs show what the tool returned without each caller inventing its own formatting.

**Data flow**: It reads the `ListAgentsResult`, including its list of agents. It converts the result into the standard JSON-style text used for `list_agents` log previews and returns that string.

**Call relations**: After `handle_call` produces a `ListAgentsResult`, the tool framework can call this when recording the outcome. It relies on the shared tool-output formatting helper so logs for this tool look like logs from other tools.


##### `ListAgentsResult::success_for_logging`  (lines 72–74)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports that this result represents a successful tool call for logging purposes. A successfully created `ListAgentsResult` means the agent list request completed.

**Data flow**: It does not need to inspect any fields. It simply returns `true`, marking the result as successful in logs.

**Call relations**: The logging path calls this when it needs to label the tool outcome. Errors are handled before a `ListAgentsResult` is produced, so this result type always logs as success.


##### `ListAgentsResult::to_response_item`  (lines 76–78)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns the agent-list result into the response item format sent back through the tool system. This is how the raw list becomes something the caller can receive as a tool response.

**Data flow**: It receives the tool call ID, the original payload, and the result data. It combines those with the serialized agent list, marks the response as successful, labels it as `list_agents`, and returns a `ResponseInputItem`.

**Call relations**: Once `handle_call` has returned the result, the surrounding tool machinery uses this function to build the actual response object. It passes the formatting work to the shared response helper so the output follows the same pattern as other tools.


##### `ListAgentsResult::code_mode_result`  (lines 80–82)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the JSON value used when the system is operating in code-oriented mode. This gives code-mode consumers a structured version of the same agent-list result.

**Data flow**: It reads the `ListAgentsResult` and ignores the payload because the result does not need extra context. It serializes the agent list under the standard `list_agents` tool-result shape and returns it as JSON.

**Call relations**: Code-mode output paths call this after the handler has produced a result. It uses the common code-mode formatting helper so `list_agents` behaves consistently with other tools in that mode.


### `core/src/tools/handlers/multi_agents_v2/wait.rs`

`domain_logic` · `request handling`

In a multi-agent conversation, one agent may need to stop and wait for another agent, a mailbox update, or new steering input from the user. This file provides that waiting behavior. Without it, an agent would either keep checking repeatedly like someone refreshing an inbox, or it could get stuck waiting too long with no clear result.

The main piece is `Handler`, which plugs into the tool system under the name `wait_agent`. When the model calls this tool, the handler reads the requested `timeout_ms`, checks it against configured minimum and maximum limits, and falls back to a default timeout if none is provided. It then subscribes to activity from the session input queue. That activity can mean either mailbox activity, which is a normal “something arrived” wake-up, or steering input, which means the wait was interrupted by new direction.

Before waiting, the handler sends a “waiting began” event. After waiting finishes, it sends a “waiting ended” event. This is like turning on and off a waiting-room sign so the rest of the system can see what happened. The result returned to the model is a small JSON object with a plain message and a `timed_out` flag. The low-level waiting is done by `wait_for_activity`, which first checks whether activity was already pending, then waits only until the deadline.

#### Function details

##### `Handler::new`  (lines 18–20)

```
fn new(options: WaitAgentTimeoutOptions) -> Self
```

**Purpose**: Creates a new `wait_agent` handler with the timeout options that should be shown in its tool description. This is used when the tool is being registered or set up.

**Data flow**: It receives `WaitAgentTimeoutOptions` as input, stores those options inside a new `Handler`, and returns that ready-to-use handler. It does not start any waiting by itself.

**Call relations**: This is the construction step before the tool can be used. Later, the tool system calls methods such as `Handler::tool_name`, `Handler::spec`, and `Handler::handle` on the handler it created here.


##### `Handler::tool_name`  (lines 24–26)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Tells the tool system that this handler is responsible for the tool named `wait_agent`. The name is how a model’s tool call is matched to this code.

**Data flow**: It takes no outside data except the handler itself, builds a plain tool name from the text `wait_agent`, and returns that name to the tool registry.

**Call relations**: The tool framework calls this when it needs to identify or register the handler. It uses the shared `plain` helper to turn the string into the project’s `ToolName` type.

*Call graph*: calls 1 internal fn (plain).


##### `Handler::spec`  (lines 28–30)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the public description of the `wait_agent` tool, including its accepted arguments and timeout limits. This is what tells the model how it is allowed to call the tool.

**Data flow**: It reads the timeout options stored in the handler, passes them to `create_wait_agent_tool_v2`, and returns the resulting tool specification.

**Call relations**: The tool framework calls this during tool setup or exposure to the model. It hands off to `create_wait_agent_tool_v2`, which builds the actual `ToolSpec` object.

*Call graph*: calls 1 internal fn (create_wait_agent_tool_v2).


##### `Handler::handle`  (lines 32–34)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing one actual `wait_agent` tool call. It wraps the real asynchronous work so the wider tool system can run it in the expected form.

**Data flow**: It receives a `ToolInvocation`, passes it into `handle_call`, pins the future so it can be safely awaited by the runtime, and returns that future. The result will eventually be either a tool output or an error.

**Call relations**: The tool framework calls this when the model invokes `wait_agent`. This function does not do the waiting itself; it immediately hands the job to `Handler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `Handler::handle_call`  (lines 38–111)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the full `wait_agent` operation: read the requested timeout, validate it, wait for activity or timeout, send lifecycle events, and return a clear result. This is the heart of the file.

**Data flow**: It receives a tool invocation containing the session, turn, call id, and raw payload. It extracts and parses the arguments, chooses a timeout using the turn configuration, rejects values outside the allowed range, subscribes to input-queue activity, sends a waiting-started event, waits until activity or the deadline, converts the outcome into `WaitAgentResult`, sends a waiting-ended event, and returns the result as tool output. If the timeout argument is invalid, it returns an error message meant for the model.

**Call relations**: This is called by `Handler::handle` for each tool call. It relies on `wait_for_activity` for the actual sleeping-and-waking behavior, uses `WaitAgentResult::from_outcome` to make the model-facing result, and uses timestamp helpers when sending begin and end events to the session.

*Call graph*: calls 2 internal fn (wait_for_activity, now_unix_timestamp_ms); called by 1 (handle); 7 external calls (from_millis, new, now, new, from_outcome, format!, RespondToModel).


##### `Handler::matches_kind`  (lines 115–117)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says which kind of tool payload this handler accepts. Here, it only accepts function-style tool calls.

**Data flow**: It receives a `ToolPayload`, checks whether it is a `Function` payload, and returns `true` if it is or `false` otherwise. It does not modify the payload.

**Call relations**: The core tool runtime uses this as a quick filter before routing work to the handler. It protects this handler from being asked to process payload shapes it does not understand.

*Call graph*: 1 external calls (matches!).


##### `WaitAgentResult::from_outcome`  (lines 133–143)

```
fn from_outcome(outcome: WaitOutcome) -> Self
```

**Purpose**: Turns the internal wait outcome into the small response object returned to the model. It converts system-specific events into plain messages such as “Wait completed” or “Wait timed out.”

**Data flow**: It receives a `WaitOutcome`, chooses the matching human-readable message, sets `timed_out` to `true` only for the timeout case, and returns a `WaitAgentResult` containing both values.

**Call relations**: After `Handler::handle_call` gets a result from `wait_for_activity`, it calls this function to prepare the final tool output. This keeps the low-level waiting result separate from the response format shown to the model.


##### `WaitAgentResult::log_preview`  (lines 147–149)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a compact JSON-style preview of the result for logs. This lets developers or operators see what the tool returned without changing the actual model response.

**Data flow**: It reads the `WaitAgentResult`, formats it with the tool name `wait_agent`, and returns the formatted text. It does not change the result.

**Call relations**: The tool output system calls this when it needs a log-friendly summary. It delegates the formatting to the shared `tool_output_json_text` helper.


##### `WaitAgentResult::success_for_logging`  (lines 151–153)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks every completed `wait_agent` result as successful for logging purposes. Even a timeout is considered a valid tool outcome, not a tool failure.

**Data flow**: It takes the result object and always returns `true`. It does not inspect or modify the message or timeout flag.

**Call relations**: The logging layer calls this when deciding how to classify the tool output. This matters because `timed_out: true` is useful information, but it is not treated as an execution error.


##### `WaitAgentResult::to_response_item`  (lines 155–157)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the wait result into the response-item format used to send tool output back through the conversation system. This is the model-facing packaging step.

**Data flow**: It receives the call id, original payload, and the result itself. It passes those into a shared response-building helper with the tool name `wait_agent`, and returns a `ResponseInputItem` ready to be inserted into the response flow.

**Call relations**: The tool framework calls this after the handler has produced a `WaitAgentResult`. It hands off to `tool_output_response_item` so this tool’s output is shaped the same way as other tool outputs.


##### `WaitAgentResult::code_mode_result`  (lines 159–161)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Provides the wait result as JSON for code-oriented execution modes. This gives other parts of the system a structured value instead of only display text.

**Data flow**: It reads the `WaitAgentResult`, combines it with the tool name `wait_agent`, and returns a JSON value. The payload argument is not used here.

**Call relations**: The tool output system calls this when it needs a machine-readable result. It delegates the JSON formatting to the shared `tool_output_code_mode_result` helper.


##### `wait_for_activity`  (lines 171–189)

```
async fn wait_for_activity(
    activity_rx: &mut tokio::sync::watch::Receiver<InputQueueActivity>,
    pending_activity: Option<InputQueueActivity>,
    deadline: Instant,
) -> WaitOutcome
```

**Purpose**: Waits until there is input-queue activity or until the deadline passes. It is the small, focused helper that decides whether the wait ended because of mailbox activity, steering input, or timeout.

**Data flow**: It receives a watch receiver for future activity, an optional already-pending activity item, and a deadline. If pending activity already exists, it returns the matching outcome immediately. Otherwise, it waits for the receiver to report a change before the deadline; if activity arrives, it reads whether it was mailbox activity or steering input, and if no activity arrives in time or the channel closes, it returns `TimedOut`.

**Call relations**: This is called by `Handler::handle_call` after the handler has subscribed to the session input queue and calculated the deadline. It uses Tokio’s timeout and watch-channel tools to do the actual waiting, then hands a simple `WaitOutcome` back to the handler.

*Call graph*: called by 1 (handle_call); 3 external calls (borrow_and_update, changed, timeout_at).


### Delegated and review workflows
These files cover higher-level nested-session workflows that run delegated child Codex threads, bridge code-mode execution into nested turns, and implement constrained review-mode subagents.

### `core/src/codex_delegate.rs`

`orchestration` · `active while a delegated sub-agent session is being started, run, and shut down`

This file is the bridge between a parent Codex session and a delegated child Codex session. A useful way to picture it is a manager sending an assistant to do a task: the assistant can work independently, but any request to run a risky command, edit files, ask the user, or use protected tools must come back through the manager.

The main entry points create a sub-agent with inherited settings from the parent, such as user instructions, environments, execution policy, tools, plugins, and analytics context. They then set up two pipes: one pipe carries user operations into the child, and the other carries child events back out.

Most child events are simply forwarded. Some are deliberately intercepted. Approval requests, permission requests, and user-input prompts are routed through the parent session. If a Guardian reviewer is active, Guardian can decide whether a command, patch, or tool call is safe. Otherwise the parent’s normal approval flow is used. The child then receives a clear answer and continues.

The file also pays attention to cancellation. If the parent cancels, or the receiver goes away, the child is interrupted and shut down so background tasks do not keep running or send into closed channels.

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

**Purpose**: Starts a sub-agent session that can keep receiving more work over time. It returns communication channels so the caller can send operations to the child and receive the child’s non-approval events.

**Data flow**: It receives the parent configuration, authentication, model manager, parent session, current turn context, cancellation token, sub-agent source, and optional prior history. It builds a new child Codex session using inherited parent settings, starts background tasks to forward events and operations, records analytics that a sub-agent started, and returns a Codex handle whose input and output are connected to the caller rather than directly to the child internals.

**Call relations**: This is the main setup routine for delegated work. The one-shot helper uses it when it wants a temporary child, and Guardian review sessions can use it when a review conversation needs its own child thread. After spawning the child session, it hands event traffic to forward_events and operation traffic to forward_ops.

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

**Purpose**: Starts a sub-agent for a single prompt and automatically shuts it down after that turn finishes or aborts. It is for callers that want one delegated answer, not an ongoing child conversation.

**Data flow**: It receives the same setup information as the interactive version plus the initial user input and optional final-output schema. It creates a child cancellation token, starts the interactive sub-agent, immediately sends the initial user input, watches events for turn completion or abortion, sends a shutdown request when done, and returns an event stream with a closed input channel so no more work can be submitted.

**Call relations**: This wraps run_codex_thread_interactive for one-time use. It is called by start_review_conversation, which needs a bounded delegated run rather than a long-lived interactive child.

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

**Purpose**: Reads events from the child agent and decides which ones the outside caller should see. It hides approval-related events from the caller and instead routes those decisions through the parent session.

**Data flow**: It takes the child Codex handle, an output event channel, the parent session and turn context, a cache of in-progress MCP tool calls, and a cancellation token. It repeatedly reads child events. Routine setup and token-count events are dropped, approval and permission events are answered through helper functions, MCP tool-call start and end events update the cache, and ordinary events are forwarded to the caller. If cancellation happens, it shuts the child down.

**Call relations**: run_codex_thread_interactive starts this as a background task. It is the traffic controller for child-to-parent messages: safe progress updates pass through, while decisions that require authority are diverted to approval and permission helpers.

*Call graph*: called by 1 (run_codex_thread_interactive); 3 external calls (cancelled, pin!, select!).


##### `shutdown_delegate`  (lines 403–418)

```
async fn shutdown_delegate(codex: &Codex)
```

**Purpose**: Politely stops a child agent and briefly drains its remaining events. This prevents background work from continuing after the parent no longer wants the child alive.

**Data flow**: It receives a Codex child handle. It sends an interrupt request, then a shutdown request, then waits up to a short timeout while reading events until it sees the child finish or abort its turn. It does not return a useful value; its effect is to quiet and stop the child.

**Call relations**: forward_event_or_shutdown calls this when forwarding fails. forward_events also uses the same shutdown behavior when cancellation asks the delegated agent to stop.

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

**Purpose**: Tries to send one child event to the caller, and shuts down the child if that is no longer possible. It protects the system from a child continuing to work for a listener that has disappeared.

**Data flow**: It receives the child Codex handle, the event sender, the cancellation token, and the event to deliver. If the event is sent successfully before cancellation, it returns true. If sending fails or cancellation wins, it shuts down the child and returns false.

**Call relations**: This is used by the event-forwarding loop whenever an event should be passed through. It hands failure cases to shutdown_delegate so the rest of the loop can stop cleanly.

*Call graph*: calls 1 internal fn (shutdown_delegate); 1 external calls (send).


##### `forward_ops`  (lines 436–448)

```
async fn forward_ops(
    codex: Arc<Codex>,
    rx_ops: Receiver<Submission>,
    cancel_token_ops: CancellationToken,
)
```

**Purpose**: Moves operations from the caller’s input channel into the child agent. This is what lets the parent or caller continue giving instructions to an interactive sub-agent.

**Data flow**: It receives the child Codex handle, a receiver for submitted operations, and a cancellation token. It waits for submissions, stops if the channel closes or cancellation happens, and otherwise submits each operation to the child using the original submission identity.

**Call relations**: run_codex_thread_interactive starts this as a background task. It is the opposite direction from forward_events: instead of child events coming out, caller operations go in.

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

**Purpose**: Answers a child agent’s request to run a command that needs approval. It makes sure the decision comes from the parent session or Guardian, not from the child itself.

**Data flow**: It receives the child Codex handle, the child turn id, parent session and context, the command-approval event, and a cancellation token. It extracts the command, working directory, reason, requested extra permissions, and available decisions. If Guardian review is configured, it creates a Guardian shell-review request and waits for the decision; otherwise it asks the parent session’s normal command-approval path. It then sends an ExecApproval answer back to the child.

**Call relations**: The event-forwarding loop calls this when the child asks to execute a protected command. It uses await_approval_with_cancel so cancellation becomes an abort decision, then hands the final decision back to the child agent.

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

**Purpose**: Answers a child agent’s request to apply file changes that need approval. It keeps file edits from a delegated agent under the parent’s review process.

**Data flow**: It receives the child Codex handle, parent session and context, the patch-approval event, and a cancellation token. It gathers the proposed file changes and reason. If Guardian review is active, it turns the changes into a readable patch summary and asks Guardian. If not, or if Guardian is not used, it asks the parent session for patch approval. It sends the resulting PatchApproval decision back to the child.

**Call relations**: The event-forwarding loop uses this when a child wants to modify files. Like command approval, it depends on await_approval_with_cancel so a cancelled parent run produces a safe abort-style answer.

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

**Purpose**: Answers a child agent’s request to ask the user something. It also recognizes a special legacy tool-approval prompt and may answer it automatically after Guardian review.

**Data flow**: It receives the child Codex handle, the request id, parent session and context, cached MCP tool invocations, the user-input event, and a cancellation token. First it checks whether the prompt is really an MCP tool approval that Guardian can review automatically. If so, it sends that generated answer back to the child. Otherwise it asks the parent session to request input from the user, waits with cancellation support, and sends the user-input answer back to the child.

**Call relations**: The event-forwarding loop calls this when the child raises a RequestUserInput event. It delegates special MCP approval cases to maybe_auto_review_mcp_request_user_input and ordinary questions to await_user_input_with_cancel.

*Call graph*: calls 3 internal fn (await_user_input_with_cancel, maybe_auto_review_mcp_request_user_input, submit).


##### `maybe_auto_review_mcp_request_user_input`  (lines 682–757)

```
async fn maybe_auto_review_mcp_request_user_input(
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    pending_mcp_invocations: &Arc<Mutex<HashMap<String, McpInvocation>>>,
    e
```

**Purpose**: Detects an older-style MCP tool approval prompt and, when Guardian is active, turns it into a real Guardian review instead of showing it as a normal user question. MCP means Model Context Protocol, a way external tools are exposed to the agent.

**Data flow**: It receives the parent session and context, the cache of currently running MCP tool calls, the user-input event, and a cancellation token. It looks for a question that matches the MCP approval-question pattern, finds the original tool invocation by call id, looks up tool metadata, checks whether Guardian should review this tool, and runs the Guardian review. It converts the Guardian decision into the option label expected by the old user-input prompt and returns a RequestUserInputResponse. If any required piece is missing or Guardian should not review it, it returns nothing.

**Call relations**: handle_request_user_input calls this before falling back to a normal user question. It relies on the MCP invocation cache maintained by the event-forwarding loop, because the later compatibility prompt does not contain enough tool details by itself.

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

**Purpose**: Answers a child agent’s request for extra permissions, such as access tied to an environment or working directory. It routes the request through the parent session’s permission system.

**Data flow**: It receives the child Codex handle, parent session and context, the permission-request event, and a cancellation token. It builds permission-request arguments from the event, chooses the event’s working directory or falls back to the parent context directory, asks the parent session for a permission response, waits with cancellation support, and sends a RequestPermissionsResponse back to the child.

**Call relations**: The event-forwarding loop calls this when the child asks for permissions. It uses await_request_permissions_with_cancel so cancellation still produces a well-formed empty permission response and notifies the parent.

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

**Purpose**: Waits for a user-input response, but returns an empty answer if the delegated run is cancelled. This keeps the child from waiting forever for a question that the parent no longer wants answered.

**Data flow**: It receives a future that may produce a user-input response, the parent session, the subscription id for the request, and a cancellation token. If cancellation happens first, it creates an empty response, tells the parent session about that response, and returns it. If the real response arrives first, it returns it, or an empty response if the request produced nothing.

**Call relations**: handle_request_user_input uses this for ordinary user questions from a child agent. It is the cancellation-aware waiting room between the parent’s user-input system and the child’s need for a concrete answer.

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

**Purpose**: Waits for a permission response, but returns a safe empty permission grant if the delegated run is cancelled. This avoids leaving a child permission request unresolved.

**Data flow**: It receives a future that may produce a permission response, the parent session, the permission call id, and a cancellation token. If cancellation happens first, it creates a response with no permissions, a turn-only scope, and no strict auto-review, notifies the parent session, and returns that response. If the real response arrives first, it returns it, or the same empty response if none was provided.

**Call relations**: handle_request_permissions uses this after sending the permission request through the parent session. It provides a predictable answer for both normal completion and cancellation.

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

**Purpose**: Waits for an approval decision, but turns cancellation into an explicit abort. This gives command, patch, and tool approvals a safe ending even when the parent run stops.

**Data flow**: It receives a future that will produce a review decision, the parent session, the approval id, the main cancellation token, and optionally a separate Guardian-review cancellation token. If cancellation happens first, it cancels the Guardian review if one exists, notifies the parent session that the approval was aborted, and returns Abort. If the decision arrives first, it returns that decision unchanged.

**Call relations**: Command approval, patch approval, and automatic MCP tool review all use this helper. It is the shared rule that keeps delegated approval flows from hanging or silently succeeding after cancellation.

*Call graph*: called by 3 (handle_exec_approval, handle_patch_approval, maybe_auto_review_mcp_request_user_input); 1 external calls (select!).


### `core/src/tasks/review.rs`

`orchestration` · `active during a review-mode turn, including cleanup when review mode exits or is aborted`

Review mode is like asking a second, more restricted assistant to inspect the current work and report problems. This file is the coordinator for that process. Without it, the app could not launch the reviewer cleanly, keep review-only tool limits in place, or turn the reviewer’s answer into the structured review result shown to the user.

The main type is `ReviewTask`, which fits into the normal session task system. When it runs, it pulls only the user’s actual input out of the turn data, then starts a one-shot sub-agent conversation. Before that sub-agent starts, the file tightens its configuration: web search is disabled, collaboration and spawning features are disabled, approval prompts are forbidden, and a review-specific instruction prompt is installed. This keeps review mode focused and prevents the reviewer from quietly using tools that review mode should not allow.

As the reviewer produces events, this file forwards useful ones to the main session and hides noisy assistant-message streaming details. When the reviewer finishes, it parses the final message as a `ReviewOutputEvent`, which is the structured review result. Finally, it emits an “exited review mode” event and records synthetic conversation messages so the review appears in history and rollout storage.

#### Function details

##### `ReviewTask::new`  (lines 37–39)

```
fn new() -> Self
```

**Purpose**: Creates a new `ReviewTask`. This is used when the system needs an object that represents the review-mode job.

**Data flow**: Nothing goes in. The function returns a plain `ReviewTask` value with no stored settings, because this task gets the session and turn details later when it runs.

**Call relations**: The review thread setup code calls this when it needs to spawn review mode. A test also calls it while checking abort behavior.

*Call graph*: called by 2 (spawn_review_thread, abort_review_task_emits_exited_then_aborted_and_records_history).


##### `ReviewTask::kind`  (lines 43–45)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Tells the task system that this task is the review task. This lets the rest of the session machinery label and track it correctly.

**Data flow**: It reads no outside data. It simply returns the fixed task kind `Review`.

**Call relations**: This is part of the `SessionTask` interface. The wider task framework can ask the task what kind it is before or while running it.


##### `ReviewTask::span_name`  (lines 47–49)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Gives the review task a stable name for tracing or telemetry. A span is a named section of work used to understand what the program was doing.

**Data flow**: It takes no changing input and returns the fixed text `session_task.review`.

**Call relations**: This is another piece of the `SessionTask` interface. The task framework can use this name when recording timing or diagnostic information around the review run.


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

**Purpose**: Runs review mode from start to finish. It gathers the user’s input, launches the reviewer sub-agent, waits for its result, and exits review mode unless the task was cancelled.

**Data flow**: It receives the session context, the turn context, the turn input items, and a cancellation token, which is a shared stop signal. It counts a telemetry event, extracts only user-provided content from the turn input, starts the review conversation, processes the reviewer’s events into an optional structured review output, and then records the review exit if cancellation has not already happened. It always returns `None`, because the useful result is sent and recorded through session events rather than returned as a string.

**Call relations**: The session task runner calls this when review mode is started. Inside, it hands the prepared user input to `start_review_conversation`, passes the returned event receiver to `process_review_events`, and then calls `exit_review_mode` to publish and store the final review result.

*Call graph*: calls 3 internal fn (exit_review_mode, process_review_events, start_review_conversation); 3 external calls (clone, is_cancelled, new).


##### `ReviewTask::abort`  (lines 90–92)

```
async fn abort(&self, session: Arc<SessionTaskContext>, ctx: Arc<TurnContext>)
```

**Purpose**: Cleans up review mode when it is stopped early. It makes sure the user interface and history still learn that review mode has ended.

**Data flow**: It receives the session and turn context. Since there is no completed review result, it calls the exit routine with `None`, which produces an interrupted-review message instead of normal findings.

**Call relations**: The task framework calls this when review mode is aborted. It delegates the actual user-visible cleanup to `exit_review_mode`, the same function used after a normal run.

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

**Purpose**: Starts the separate reviewer assistant with safe review-only settings. It returns the channel where reviewer events can be read, or nothing if the reviewer could not be started.

**Data flow**: It receives the session context, turn context, user input, and cancellation token. It copies the current configuration, then locks down tools and permissions: web search is disabled, certain features are disabled, approval prompts are set to never happen, and the review prompt is installed as the reviewer’s instructions. It chooses the configured review model if one exists, otherwise it uses the current model. Then it starts a one-shot Codex sub-agent and returns that sub-agent’s event receiver on success.

**Call relations**: `ReviewTask::run` calls this after collecting user input. This function hands off to `run_codex_thread_one_shot`, which actually starts the sub-agent conversation. If the configuration cannot support disabling web search, it panics because that should be impossible by construction.

*Call graph*: calls 2 internal fn (allow_only, run_codex_thread_one_shot); called by 1 (run); 1 external calls (panic!).


##### `process_review_events`  (lines 141–188)

```
async fn process_review_events(
    session: Arc<SessionTaskContext>,
    ctx: Arc<TurnContext>,
    receiver: async_channel::Receiver<Event>,
) -> Option<ReviewOutputEvent>
```

**Purpose**: Reads events from the reviewer and turns them into one final review result. It also forwards selected events so the main session stays informed without showing unwanted streaming noise.

**Data flow**: It receives the session, turn context, and an event receiver from the reviewer. It waits for events one by one. Regular assistant-message events are held back so only the right final form is shown. Assistant streaming deltas and assistant item-completed events are suppressed. Other events are forwarded to the main session. When the reviewer reports that the turn is complete, the function parses the last assistant message into an optional `ReviewOutputEvent`; if the turn is aborted or the channel closes early, it returns `None`.

**Call relations**: `ReviewTask::run` calls this after `start_review_conversation` succeeds. While reading from the receiver, it may send non-hidden events into the main session. On completion, it uses `parse_review_output_event` to interpret the reviewer’s final text.

*Call graph*: calls 1 internal fn (recv); called by 1 (run).


##### `parse_review_output_event`  (lines 195–210)

```
fn parse_review_output_event(text: &str) -> ReviewOutputEvent
```

**Purpose**: Converts the reviewer’s final text into the structured review format used by the app. It is forgiving when the model returns extra words around the JSON.

**Data flow**: It receives a text blob from the reviewer. First it tries to read the whole text as JSON shaped like a `ReviewOutputEvent`. If that fails, it looks for the first `{` and the last `}` and tries to parse that slice as JSON. If that also fails, it creates a default review output and stores the raw text as the overall explanation.

**Call relations**: This is used when review event processing reaches the reviewer’s turn-complete event. It protects the rest of the flow from imperfect model formatting by always returning a usable review output object.

*Call graph*: 1 external calls (default).


##### `exit_review_mode`  (lines 214–280)

```
async fn exit_review_mode(
    session: Arc<Session>,
    review_output: Option<ReviewOutputEvent>,
    ctx: Arc<TurnContext>,
)
```

**Purpose**: Publishes that review mode has ended and records the review result in conversation history. It handles both successful reviews and interrupted reviews.

**Data flow**: It receives the main session, an optional review output, and the turn context. If there is a review result, it combines the overall explanation and findings, renders a user-facing review-exit message, and renders an assistant message containing the review output. If there is no result, it creates an interrupted-review message. It then records a synthetic user message, emits an `ExitedReviewMode` event containing the optional review output, records and emits a synthetic assistant message, and finally ensures rollout persistence exists on disk.

**Call relations**: `ReviewTask::run` calls this after a completed review conversation, unless cancellation has already taken over. `ReviewTask::abort` also calls it with no review output. It relies on review-formatting helpers and prompt renderers to turn structured findings into readable text before storing and emitting them.

*Call graph*: calls 2 internal fn (format_review_findings_block, render_review_output_text); called by 2 (abort, run); 6 external calls (new, render_review_exit_interrupted, render_review_exit_success, format!, ExitedReviewMode, vec!).


### `core/src/tools/code_mode/delegate.rs`

`orchestration` · `active during a code-mode turn, especially while dispatching cell tool calls and notifications`

Code mode appears to let the model work through separate cells, a bit like notebook cells. This file is the traffic controller between those cells and the main Codex tool-running machinery. Without it, a cell could try to run a nested tool or send a notification before the current turn is ready, or after it has been cancelled, which could lead to lost messages, wrong ordering, or work happening after the user has moved on.

The central piece is CodeModeDispatchBroker. Other code asks the broker to invoke a nested tool or send a notification. The broker puts that request onto an internal queue. A per-turn worker, started by start_turn_worker, reads the queue and performs the request using CoreTurnHost.

The important safety feature is the “dispatch gate” for each cell. A gate starts closed. Requests for that cell wait until mark_cell_ready_for_dispatch opens it. If the cell closes or the request is cancelled, the wait ends and the gate is cleaned up. This is like a train station signal: trains can line up, but they do not enter the track until the signal turns green.

Notifications are injected back into the active session as tool output messages. Nested tool calls are handed to the normal tool runtime, so code mode reuses the same tool execution path as the rest of the system.

#### Function details

##### `CodeModeDispatchBroker::new`  (lines 31–38)

```
fn new() -> Self
```

**Purpose**: Creates a new broker that can receive code-mode dispatch requests. It sets up the internal message queue and the table of per-cell readiness gates.

**Data flow**: Nothing comes in. The function creates a sending side and receiving side for an internal queue, creates an empty shared map for cell gates, and returns a ready-to-use CodeModeDispatchBroker.

**Call relations**: This is the starting point for this dispatch system. The broader code creates the broker, then later uses it as the code-mode session delegate and starts a worker from it for each turn.

*Call graph*: called by 1 (new); 4 external calls (new, new, new, unbounded).


##### `CodeModeDispatchBroker::mark_cell_ready_for_dispatch`  (lines 40–42)

```
fn mark_cell_ready_for_dispatch(&self, cell_id: &CellId)
```

**Purpose**: Marks one code cell as ready, so queued work for that cell may proceed. This prevents tool calls or notifications from being released too early.

**Data flow**: It receives a cell id. It finds or creates that cell’s dispatch gate, then changes the gate value to true, which wakes any waiting tasks for that cell.

**Call relations**: This function uses dispatch_gate to reach the right readiness signal. The turn worker waits on that same signal before running notifications or nested tool calls.

*Call graph*: calls 1 internal fn (dispatch_gate).


##### `CodeModeDispatchBroker::close_cell`  (lines 44–46)

```
fn close_cell(&self, cell_id: &CellId)
```

**Purpose**: Removes the readiness gate for a cell that is no longer active. This keeps old cell state from hanging around after the cell is done.

**Data flow**: It receives a cell id. It removes that cell’s entry from the shared gate map. There is no returned value; the broker’s internal state changes.

**Call relations**: This is called by CodeModeDispatchBroker::cell_closed when code mode reports that a cell has closed. It delegates the actual cleanup to remove_dispatch_gate.

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

**Purpose**: Starts the background worker that actually performs queued code-mode requests for one turn. It connects the broker to the tool router, session, turn state, and diff tracker needed to run tools correctly.

**Data flow**: It receives the current execution context, a tool router, and a shared turn diff tracker. It builds a ToolCallRuntime, wraps that in a CoreTurnHost, clones the broker’s queue receiver and gate table, then spawns an asynchronous loop. That loop reads dispatch messages, waits for the relevant cell gate to open, and either sends notifications or starts nested tool calls. It returns a CodeModeDispatchWorker whose lifetime controls shutdown.

**Call relations**: This is the bridge between queued requests and real work. It calls wait_until_cell_ready_for_dispatch before handing work to CoreTurnHost::notify or CoreTurnHost::invoke_tool. If waiting is cancelled, it calls remove_dispatch_gate to clean up. The returned CodeModeDispatchWorker stops the loop when it is dropped.

*Call graph*: calls 3 internal fn (remove_dispatch_gate, wait_until_cell_ready_for_dispatch, new); 6 external calls (clone, new, clone, channel, select!, spawn).


##### `dispatch_gate`  (lines 132–144)

```
fn dispatch_gate(
    dispatch_gates: &Mutex<HashMap<CellId, watch::Sender<bool>>>,
    cell_id: &CellId,
) -> watch::Sender<bool>
```

**Purpose**: Finds the readiness gate for a cell, creating it if it does not already exist. A readiness gate is a small shared signal that says whether work for that cell may run.

**Data flow**: It receives the shared gate map and a cell id. It locks the map, recovers even if the lock was previously poisoned by a panic, then either reuses the existing signal sender or creates a new one starting at false. It returns a clone of that sender.

**Call relations**: CodeModeDispatchBroker::mark_cell_ready_for_dispatch uses this to open a cell’s gate. wait_until_cell_ready_for_dispatch uses it to subscribe to the same gate and wait until it opens.

*Call graph*: called by 2 (mark_cell_ready_for_dispatch, wait_until_cell_ready_for_dispatch); 1 external calls (clone).


##### `remove_dispatch_gate`  (lines 146–155)

```
fn remove_dispatch_gate(
    dispatch_gates: &Mutex<HashMap<CellId, watch::Sender<bool>>>,
    cell_id: &CellId,
)
```

**Purpose**: Deletes the stored readiness gate for a cell. This is cleanup for cells that close or whose pending work is cancelled before dispatch.

**Data flow**: It receives the shared gate map and a cell id. It locks the map and removes that cell’s entry. It returns nothing, but the shared map no longer keeps state for that cell.

**Call relations**: CodeModeDispatchBroker::close_cell calls this when a cell is explicitly closed. CodeModeDispatchBroker::start_turn_worker also calls it when a wait is cancelled, so abandoned cells do not leave stale gates behind.

*Call graph*: called by 2 (close_cell, start_turn_worker).


##### `wait_until_cell_ready_for_dispatch`  (lines 157–179)

```
async fn wait_until_cell_ready_for_dispatch(
    dispatch_gates: &Mutex<HashMap<CellId, watch::Sender<bool>>>,
    cell_id: &CellId,
    cancellation_token: &CancellationToken,
) -> bool
```

**Purpose**: Waits until a cell is allowed to dispatch work, unless the operation is cancelled first. This protects the ordering of cell activity.

**Data flow**: It receives the shared gate map, a cell id, and a cancellation token. If cancellation has already happened, it immediately returns false. Otherwise it subscribes to the cell’s gate and loops until the gate value becomes true. If the gate disappears or the cancellation token fires, it returns false; if the gate opens, it returns true.

**Call relations**: CodeModeDispatchBroker::start_turn_worker calls this before processing both notifications and nested tool calls. It relies on dispatch_gate to find the signal that mark_cell_ready_for_dispatch will later open.

*Call graph*: calls 1 internal fn (dispatch_gate); called by 1 (start_turn_worker); 2 external calls (is_cancelled, select!).


##### `CodeModeDispatchBroker::invoke_tool`  (lines 182–208)

```
fn invoke_tool(
        &'a self,
        invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Accepts a nested tool call from code mode and sends it to the dispatch worker. It gives the caller a future result, meaning the caller can wait asynchronously for the tool output.

**Data flow**: It receives a nested tool invocation and a cancellation token. If already cancelled, it returns an error. Otherwise it creates a one-time response channel, sends an InvokeTool message into the broker’s queue, then waits for either the worker’s response or cancellation. The result is either JSON tool output or a clear error string.

**Call relations**: This method is part of the CodeModeSessionDelegate implementation, so code-mode session code calls it through that delegate interface. It does not run the tool itself; it hands the request to the worker started by start_turn_worker, which later calls CoreTurnHost::invoke_tool.

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

**Purpose**: Accepts a text notification from code mode and sends it to the dispatch worker. This lets a cell report output back into the active session in the right order.

**Data flow**: It receives a call id, cell id, text, and cancellation token. If already cancelled, it returns an error. Otherwise it creates a one-time response channel, sends a Notify message into the broker’s queue, then waits for either the worker’s completion result or cancellation. The result is success or an error string.

**Call relations**: This method is also part of the CodeModeSessionDelegate implementation. It queues the notification, and the worker later waits for the cell gate before calling CoreTurnHost::notify to inject the message into the running session.

*Call graph*: 6 external calls (pin, clone, is_cancelled, send, channel, select!).


##### `CodeModeDispatchBroker::cell_closed`  (lines 242–244)

```
fn cell_closed(&self, cell_id: &CellId)
```

**Purpose**: Responds to code mode telling the broker that a cell has closed. It removes that cell’s dispatch state.

**Data flow**: It receives a cell id. It passes that id to close_cell, which removes the stored gate for the cell. Nothing is returned.

**Call relations**: This is the delegate-facing hook for cell cleanup. It simply forwards to CodeModeDispatchBroker::close_cell so the same cleanup path is used consistently.

*Call graph*: calls 1 internal fn (close_cell).


##### `CodeModeDispatchWorker::drop`  (lines 267–271)

```
fn drop(&mut self)
```

**Purpose**: Stops the background dispatch worker when the worker handle is no longer needed. This ties the spawned task’s lifetime to the returned CodeModeDispatchWorker value.

**Data flow**: When the CodeModeDispatchWorker is dropped, it takes its stored shutdown sender, if one is still present, and sends a shutdown signal. There is no meaningful returned value; the side effect is that the worker loop can exit.

**Call relations**: CodeModeDispatchBroker::start_turn_worker creates this worker handle and gives it to the caller. When the caller lets the handle go, this drop method signals the spawned dispatch loop to stop.


##### `CoreTurnHost::invoke_tool`  (lines 280–293)

```
async fn invoke_tool(
        &self,
        invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> Result<JsonValue, String>
```

**Purpose**: Runs a nested code-mode tool call using the normal core tool execution path. This keeps code-mode tools from needing a separate execution system.

**Data flow**: It receives a nested tool invocation and a cancellation token. It combines those with the stored execution context and tool runtime, calls call_nested_tool, waits for the result, and turns any error into a plain string. The output is JSON data from the tool or an error string.

**Call relations**: The dispatch worker calls this after a cell’s gate has opened. This function hands off to call_nested_tool, which is the lower-level path that actually performs the nested tool call.

*Call graph*: 3 external calls (clone, clone, call_nested_tool).


##### `CoreTurnHost::notify`  (lines 295–311)

```
async fn notify(&self, call_id: String, cell_id: CellId, text: String) -> Result<(), String>
```

**Purpose**: Injects non-empty code-mode notification text back into the active session as a custom tool output message. Empty or whitespace-only text is ignored.

**Data flow**: It receives a call id, cell id, and text. If the text is blank after trimming, it returns success without changing anything. Otherwise it builds a CustomToolCallOutput message using the public tool name and the text payload, then asks the active session to inject it. It returns success, or an error explaining that there was no active turn to receive the message.

**Call relations**: The dispatch worker calls this after wait_until_cell_ready_for_dispatch says the cell may dispatch. It hands the finished notification to the session through inject_if_running, so the rest of the system sees it as tool output for the current turn.

*Call graph*: 1 external calls (vec!).


### `ext/guardian/src/lib.rs`

`orchestration` · `extension install and thread startup`

The Guardian extension needs two things from the wider system: a way to start subagents, and a way to know which conversation thread those subagents should come from. This file provides that bridge. Think of it like a concierge desk: Guardian asks for a new helper agent, but the host owns the keys and actually opens the room.

`GuardianExtension` stores a host-provided agent spawner. When Guardian wants to create a subagent, it does not create one directly. It forwards the request to that spawner, along with the thread ID the new agent should be forked from.

The file also defines `GuardianThreadContext`, a small piece of per-thread state. When a thread starts, the extension looks at the thread store’s level ID and tries to turn it into a `ThreadId`. If that works, it saves the ID into the thread store so later Guardian code can find the correct parent thread. If the ID cannot be parsed, it quietly does nothing rather than stopping thread startup.

Finally, `install` registers this extension with the application’s extension registry, so the host will call it during thread lifecycle events.

#### Function details

##### `GuardianExtension::new`  (lines 20–22)

```
fn new(agent_spawner: S) -> Self
```

**Purpose**: Creates a Guardian extension around the host’s agent-spawning helper. This is used when the extension is being registered with the rest of the system.

**Data flow**: It receives an agent spawner from the host. It stores that spawner inside a new `GuardianExtension` value. The result is an extension object ready to be registered or cloned.

**Call relations**: During installation, `install` calls this function to build the Guardian extension before placing it into the extension registry.

*Call graph*: called by 1 (install).


##### `GuardianExtension::spawn_subagent`  (lines 25–35)

```
fn spawn_subagent(
        &'a self,
        forked_from_thread_id: ThreadId,
        request: R,
    ) -> AgentSpawnFuture<'a, <S as AgentSpawner<R>>::Spawned, <S as AgentSpawner<R>>::Error>
```

**Purpose**: Asks the host to start a Guardian-owned subagent. Guardian uses this instead of creating agents itself, because the host controls the real spawning process.

**Data flow**: It receives the thread ID to fork from and a spawn request. It passes both to the stored host spawner. It returns a future, meaning the actual spawn completes asynchronously later, with either the spawned agent information or an error.

**Call relations**: This function is the Guardian extension’s doorway to the host’s spawning system. When Guardian needs a subagent, it forwards the work to the underlying spawner’s own `spawn_subagent` method.

*Call graph*: 1 external calls (spawn_subagent).


##### `GuardianThreadContext::forked_from_thread_id`  (lines 46–48)

```
fn forked_from_thread_id(&self) -> ThreadId
```

**Purpose**: Returns the parent thread ID saved for this Guardian thread context. Other Guardian code can use it to know which thread future subagents should branch from by default.

**Data flow**: It reads the stored `forked_from_thread_id` from the context. It returns that ID without changing anything.

**Call relations**: This is a small accessor for the context created at thread startup. Code that later retrieves `GuardianThreadContext` from the thread store can call this to get the saved parent thread.


##### `GuardianExtension::on_thread_start`  (lines 55–68)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: Runs when the host starts a thread and records the thread ID that Guardian should use as the source for future subagents. This gives later Guardian work a reliable default parent thread.

**Data flow**: It receives thread-start information, including the thread store. It reads the store’s level ID and tries to convert it into a `ThreadId`. If conversion succeeds, it inserts a `GuardianThreadContext` containing that ID into the thread store; if conversion fails, it leaves the store unchanged. It returns an asynchronous task that completes with no value.

**Call relations**: The host calls this through the thread lifecycle system after the extension has been registered. It prepares state that later Guardian code can retrieve, while using an asynchronous wrapper because lifecycle contributors return futures.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (pin).


##### `install`  (lines 72–77)

```
fn install(registry: &mut ExtensionRegistryBuilder<Config>, agent_spawner: S)
```

**Purpose**: Registers the Guardian extension with the host’s extension registry. Without this, the Guardian code would not be called when threads start.

**Data flow**: It receives the extension registry builder and the host’s agent spawner. It creates a `GuardianExtension`, wraps it in shared ownership so the registry can keep it safely, and adds it as a thread lifecycle contributor. It changes the registry builder by adding this contributor.

**Call relations**: This is the setup entry point for the file. The wider application calls it while assembling extensions, and it wires `GuardianExtension::on_thread_start` into the host’s thread-start flow.

*Call graph*: calls 2 internal fn (thread_lifecycle_contributor, new); 1 external calls (new).


### CSV agent jobs
This group describes the persisted batch-job workflow that spawns worker agents from CSV rows, accepts worker result reports, and completes with exported job summaries.

### `core/src/tools/handlers/agent_jobs.rs`

`orchestration` · `request handling and background job execution`

This file exists so one user request can be split into many smaller pieces of work. A CSV file is like a stack of forms; this code gives each form to a separate worker agent, asks the worker to report back through a tool call, and then writes a final spreadsheet showing the original data plus job status and results. Without this file, the system could still talk to agents one at a time, but it would not have the machinery to run a large CSV-backed job safely, resume running items, stop stalled workers, or export a useful result file.

The main loop reads the job from the state database, starts worker agents up to a safe concurrency limit, watches their status, and marks each row as completed or failed. It also handles practical problems: the multi-agent runtime may be disabled, the system may hit a thread limit, a worker may finish without reporting a result, or a worker may run too long. In those cases, it records clear failure messages rather than silently losing work.

The file also includes small CSV helpers. They read input rows, check headers, choose a default output path, escape CSV values correctly, and render each job item back into a spreadsheet. Think of the file as the foreman for a work crew: it assigns tasks, watches the workers, writes down what happened, and closes the job when the work is done.

#### Function details

##### `required_state_db`  (lines 100–106)

```
fn required_state_db(
    session: &Arc<Session>,
) -> Result<Arc<codex_state::StateRuntime>, FunctionCallError>
```

**Purpose**: Gets the session’s state database, which is where agent jobs and their row-by-row progress are stored. If the session has no database, it turns that into a fatal tool error because the job cannot be tracked safely.

**Data flow**: It receives a shared session. It asks the session for its state database. If one exists, it returns it; if not, it returns an error explaining that SQLite state storage is unavailable.

**Call relations**: This is a gatekeeper helper for the agent job tool flow. The call facts do not show a direct caller inside this file, but it is meant to be used before starting or reporting job work so later code can rely on persistent job state.


##### `build_runner_options`  (lines 108–132)

```
async fn build_runner_options(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    requested_concurrency: Option<usize>,
) -> Result<JobRunnerOptions, FunctionCallError>
```

**Purpose**: Prepares the settings needed to run worker agents for a job. It checks whether multi-agent work is allowed, chooses a safe concurrency limit, and builds the configuration that each worker agent will use.

**Data flow**: It receives the current session, turn context, and an optional requested concurrency. It reads the multi-agent setting and thread limits, rejects the request if workers are not allowed, normalizes the concurrency number, gets the session’s base instructions, builds a spawn configuration, and returns those choices as `JobRunnerOptions`.

**Call relations**: This function sits before the job loop starts. It calls `normalize_concurrency` to turn user preference and system limits into one number, then calls `build_agent_spawn_config` so `run_agent_job_loop` can later spawn workers with consistent instructions and settings.

*Call graph*: calls 1 internal fn (normalize_concurrency); 2 external calls (build_agent_spawn_config, RespondToModel).


##### `normalize_concurrency`  (lines 134–142)

```
fn normalize_concurrency(requested: Option<usize>, max_threads: Option<usize>) -> usize
```

**Purpose**: Turns a requested worker count into a safe, usable number. It enforces a default, a minimum of one, this file’s maximum cap, and any session-wide thread limit.

**Data flow**: It receives an optional requested count and an optional maximum thread count. Missing input becomes the default, zero becomes one, very large values are capped, and the result is reduced further if the session has a smaller thread limit. It returns the final worker count.

**Call relations**: `build_runner_options` calls this when preparing a job. Its result controls how many items `run_agent_job_loop` may keep active at the same time.

*Call graph*: called by 1 (build_runner_options).


##### `normalize_max_runtime_seconds`  (lines 144–154)

```
fn normalize_max_runtime_seconds(requested: Option<u64>) -> Result<Option<u64>, FunctionCallError>
```

**Purpose**: Validates the optional maximum runtime for each worker item. It rejects zero because a worker cannot be expected to finish in no time.

**Data flow**: It receives an optional number of seconds. If no value was provided, it returns no limit override. If the value is zero, it returns a model-facing error. Otherwise, it returns the same number wrapped as an accepted setting.

**Call relations**: The call facts do not show a direct caller in this file, but this helper belongs to the job-creation path. Its output is later stored on the job and read by `job_runtime_timeout` during execution.

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

**Purpose**: Runs the main lifecycle of an agent job from pending rows to final export. It starts workers, watches them, records failures, respects cancellation, and marks the job complete when all work is done.

**Data flow**: It receives the session, turn context, state database, job id, and runner options. It loads the job, recovers any already-running rows, then repeatedly fills open worker slots with pending items, checks for timed-out workers, detects finished workers, and updates the database. At the end it writes an output CSV snapshot and marks the job completed unless it was cancelled or export failed.

**Call relations**: This is the central coordinator. It calls `job_runtime_timeout`, `recover_running_items`, `build_worker_prompt`, `reap_stale_active_items`, `find_finished_threads`, `wait_for_status_change`, `finalize_finished_item`, and `export_job_csv_snapshot` as the job moves through assignment, monitoring, cleanup, and export.

*Call graph*: calls 8 internal fn (build_worker_prompt, export_job_csv_snapshot, finalize_finished_item, find_finished_threads, job_runtime_timeout, reap_stale_active_items, recover_running_items, wait_for_status_change); 7 external calls (default, new, now, SubAgent, format!, Other, vec!).


##### `export_job_csv_snapshot`  (lines 330–345)

```
async fn export_job_csv_snapshot(
    db: Arc<codex_state::StateRuntime>,
    job: &codex_state::AgentJob,
) -> anyhow::Result<()>
```

**Purpose**: Writes the current job results to the configured output CSV file. This gives users a durable spreadsheet-style record of every row, status, error, and reported result.

**Data flow**: It receives the state database and job record. It loads all job items, asks `render_job_csv` to turn them into CSV text, creates the output directory if needed, writes the file to disk, and returns success or an error.

**Call relations**: `run_agent_job_loop` calls this at the end of a job. It hands the rendering work to `render_job_csv`, then uses file-system operations to save the result.

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

**Purpose**: Rebuilds the in-memory list of workers that were already running when the loop starts. This matters after a restart or handoff, so rows are not forgotten or duplicated.

**Data flow**: It receives the session, database, job id, active-items map, and timeout. It loads items marked as running. Stale items are failed and their agents are shut down. Items with missing or invalid thread ids are failed. Finished agents are finalized. Still-running agents are put back into the active-items map with their start time and status subscription.

**Call relations**: `run_agent_job_loop` calls this before entering its main loop. It uses `is_item_stale`, `started_at_from_item`, and `finalize_finished_item`, and it checks final agent states with `is_final`.

*Call graph*: calls 5 internal fn (is_final, finalize_finished_item, is_item_stale, started_at_from_item, from_string); called by 1 (run_agent_job_loop); 1 external calls (format!).


##### `find_finished_threads`  (lines 427–439)

```
async fn find_finished_threads(
    session: Arc<Session>,
    active_items: &HashMap<ThreadId, ActiveJobItem>,
) -> Vec<(ThreadId, String)>
```

**Purpose**: Finds active worker agents that have reached a final state, such as done or failed. It lets the main loop know which rows are ready for final database cleanup.

**Data flow**: It receives the session and the map of active worker items. For each worker thread, it gets the latest status through `active_item_status`; if that status is final, it records the thread id and item id. It returns the list of finished workers.

**Call relations**: `run_agent_job_loop` calls this on each pass through the loop. It delegates status lookup to `active_item_status` and uses `is_final` to decide which workers need finalization.

*Call graph*: calls 2 internal fn (is_final, active_item_status); called by 1 (run_agent_job_loop); 1 external calls (new).


##### `active_item_status`  (lines 441–452)

```
async fn active_item_status(
    session: &Session,
    thread_id: ThreadId,
    item: &ActiveJobItem,
) -> AgentStatus
```

**Purpose**: Gets the best available status for one active worker. It prefers a live subscription update when one is available, and falls back to asking the agent controller directly.

**Data flow**: It receives the session, a worker thread id, and the active item record. If the item has a status receiver with a changed value, it returns that value. Otherwise, it queries the agent control service for the thread’s current status and returns it.

**Call relations**: `find_finished_threads` calls this while scanning active workers. It keeps status checking efficient without making the rest of the loop care where the status came from.

*Call graph*: called by 1 (find_finished_threads).


##### `wait_for_status_change`  (lines 454–469)

```
async fn wait_for_status_change(active_items: &HashMap<ThreadId, ActiveJobItem>)
```

**Purpose**: Pauses the job loop briefly when nothing changed, so it does not waste CPU by spinning constantly. It wakes up early if any worker reports a status change.

**Data flow**: It receives the active-items map. It builds waiters for each item that has a status subscription. If none exist, it sleeps for a short polling interval. If subscriptions exist, it waits until one changes or the polling interval expires.

**Call relations**: `run_agent_job_loop` calls this only when no progress was made in the current loop pass. It is the loop’s polite waiting room between checks.

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

**Purpose**: Finds active workers that have run longer than allowed and marks their rows as failed. It prevents a stuck worker from blocking the whole job forever.

**Data flow**: It receives the session, database, job id, active-items map, and runtime timeout. It compares each active item’s elapsed time with the timeout, records failures for stale items, shuts down their worker agents, removes them from the active map, and returns whether anything changed.

**Call relations**: `run_agent_job_loop` calls this during each loop pass before looking for normal completions. It acts as the timeout cleanup step for currently tracked workers.

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

**Purpose**: Closes out a worker after its agent has finished. It marks the row completed only if the worker reported a result; otherwise it marks the row failed with a clear message.

**Data flow**: It receives the session, database, job id, item id, and worker thread id. It loads the item from the database. If the item is still marked running, it checks whether result JSON was recorded. A reported result becomes completed; a missing result becomes failed. Finally, it shuts down the worker agent.

**Call relations**: `run_agent_job_loop` calls this for newly finished workers, and `recover_running_items` calls it for workers that were already final when recovery checked them. It is the final cleanup door for one item.

*Call graph*: called by 2 (recover_running_items, run_agent_job_loop); 1 external calls (matches!).


##### `build_worker_prompt`  (lines 535–566)

```
fn build_worker_prompt(
    job: &codex_state::AgentJob,
    item: &codex_state::AgentJobItem,
) -> anyhow::Result<String>
```

**Purpose**: Creates the exact instruction text sent to a worker agent for one CSV row. The prompt tells the worker what row to process and requires it to call `report_agent_job_result` with the job id, item id, and JSON result.

**Data flow**: It receives the job record and one job item. It fills any row placeholders in the instruction, formats the row and expected output schema as readable JSON, and returns a full prompt string containing the task, identifiers, input data, and reporting rules.

**Call relations**: `run_agent_job_loop` calls this right before spawning a worker for a pending item. It uses `render_instruction_template` to customize the user’s instruction for the row.

*Call graph*: calls 1 internal fn (render_instruction_template); called by 1 (run_agent_job_loop); 2 external calls (format!, to_string_pretty).


##### `render_instruction_template`  (lines 568–591)

```
fn render_instruction_template(instruction: &str, row_json: &Value) -> String
```

**Purpose**: Substitutes row values into an instruction template. For example, an instruction containing `{email}` can be filled with the `email` value from the current CSV row.

**Data flow**: It receives the instruction text and the row as JSON. It temporarily protects doubled braces like `{{` and `}}` so they stay literal, replaces `{column_name}` placeholders with matching row values, restores literal braces, and returns the rendered instruction.

**Call relations**: `build_worker_prompt` calls this while preparing the prompt for a worker. It is the small template engine that makes one general instruction become row-specific.

*Call graph*: called by 1 (build_worker_prompt); 2 external calls (as_object, format!).


##### `ensure_unique_headers`  (lines 593–603)

```
fn ensure_unique_headers(headers: &[String]) -> Result<(), FunctionCallError>
```

**Purpose**: Checks that a CSV file does not contain duplicate column names. Duplicate headers would make row data ambiguous because two columns would have the same key.

**Data flow**: It receives the list of headers. It adds each header to a set of names already seen. If a name appears twice, it returns a model-facing error naming the duplicated header; otherwise it returns success.

**Call relations**: The call facts do not show a direct caller in this file, but this helper belongs to the CSV job setup path before rows are stored and assigned to agents.

*Call graph*: 3 external calls (new, format!, RespondToModel).


##### `job_runtime_timeout`  (lines 605–609)

```
fn job_runtime_timeout(job: &codex_state::AgentJob) -> Duration
```

**Purpose**: Chooses how long a worker item may run before being considered stuck. It uses the job’s custom setting when present, otherwise it falls back to the default timeout.

**Data flow**: It receives a job record. If the job has `max_runtime_seconds`, it converts that to a duration. If not, it returns the built-in default duration.

**Call relations**: `run_agent_job_loop` calls this when starting so recovery and timeout cleanup use the same limit for the whole job.

*Call graph*: called by 1 (run_agent_job_loop).


##### `started_at_from_item`  (lines 611–619)

```
fn started_at_from_item(item: &codex_state::AgentJobItem) -> Instant
```

**Purpose**: Estimates when a recovered running item started, using the item’s last database update time. This lets timeout checks continue fairly after the loop restarts.

**Data flow**: It receives a job item. It compares the item’s `updated_at` timestamp with the current time, converts that age into an `Instant` value, and returns an estimated start time. If the timestamp is in the future or cannot be converted, it returns the current instant.

**Call relations**: `recover_running_items` calls this when putting an already-running item back into the active-items map. The returned time is later used by `reap_stale_active_items`.

*Call graph*: called by 1 (recover_running_items); 2 external calls (now, now).


##### `is_item_stale`  (lines 621–628)

```
fn is_item_stale(item: &codex_state::AgentJobItem, runtime_timeout: Duration) -> bool
```

**Purpose**: Checks whether a database item has been running longer than the allowed timeout. It is used during recovery before trusting an old running record.

**Data flow**: It receives a job item and timeout duration. It compares the current time with the item’s last update time. If the age is at least the timeout, it returns true; if the time comparison is invalid, it returns false.

**Call relations**: `recover_running_items` calls this while rebuilding active workers. Stale recovered items are failed immediately instead of being treated as still healthy.

*Call graph*: called by 1 (recover_running_items); 1 external calls (now).


##### `default_output_csv_path`  (lines 630–641)

```
fn default_output_csv_path(input_csv_path: &AbsolutePathBuf, job_id: &str) -> AbsolutePathBuf
```

**Purpose**: Builds a sensible output file path when the user does not provide one. It places the output next to the input CSV and includes part of the job id so names are unlikely to collide.

**Data flow**: It receives the absolute input CSV path and job id. It takes the input file stem, appends `.agent-job-` plus the first eight characters of the job id, and returns a path in the input file’s parent directory.

**Call relations**: The call facts do not show a direct caller in this file, but this helper is part of job creation. The resulting path is later stored on the job and used by `export_job_csv_snapshot`.

*Call graph*: calls 2 internal fn (as_path, parent); 1 external calls (format!).


##### `parse_csv`  (lines 643–663)

```
fn parse_csv(content: &str) -> Result<(Vec<String>, Vec<Vec<String>>), String>
```

**Purpose**: Reads CSV text into headers and rows. It accepts slightly uneven row lengths, removes a common hidden byte-order marker from the first header, and skips fully empty rows.

**Data flow**: It receives raw CSV content as text. It uses a CSV reader to read the header row, cleans the first header if needed, then reads each data record into a vector of strings. It returns the header list and row list, or a string error if parsing fails.

**Call relations**: The call facts do not show a direct caller in this file, but this is the input-reading helper for the CSV-backed job setup path.

*Call graph*: 2 external calls (new, new).


##### `render_job_csv`  (lines 665–739)

```
fn render_job_csv(
    headers: &[String],
    items: &[codex_state::AgentJobItem],
) -> Result<String, FunctionCallError>
```

**Purpose**: Turns the job’s stored items back into CSV text for the output file. It preserves the original columns and adds job-specific columns such as status, errors, result JSON, and timestamps.

**Data flow**: It receives the original headers and a list of job items. It writes a header line with both original and extra columns. For each item, it reads values from the item’s row JSON, adds job metadata and result fields, escapes each cell safely, and appends a CSV row. It returns the completed CSV string or an error if a row is not a JSON object.

**Call relations**: `export_job_csv_snapshot` calls this before writing the file. It relies on `csv_escape` for safe CSV formatting and uses `value_to_csv_string` to turn JSON values into cell text.

*Call graph*: calls 1 internal fn (csv_escape); called by 1 (export_job_csv_snapshot); 2 external calls (new, new).


##### `value_to_csv_string`  (lines 741–749)

```
fn value_to_csv_string(value: &Value) -> String
```

**Purpose**: Converts a JSON value into a plain string suitable for a CSV cell. It keeps simple values readable and serializes arrays or objects as JSON text.

**Data flow**: It receives one JSON value. Null becomes an empty string, strings are copied as-is, booleans and numbers become their text form, and arrays or objects become compact JSON text. It returns that string.

**Call relations**: `render_job_csv` uses this when copying original row values into the output CSV. It is the translator between JSON storage and spreadsheet cells.

*Call graph*: 2 external calls (new, to_string).


##### `csv_escape`  (lines 751–758)

```
fn csv_escape(value: &str) -> String
```

**Purpose**: Formats one value so it is safe to place in a CSV file. It quotes values that contain commas, newlines, carriage returns, or quote marks, and doubles embedded quotes as CSV requires.

**Data flow**: It receives a cell value as text. If the text contains characters that would confuse a CSV reader, it replaces each quote with two quotes and wraps the whole value in quotes. Otherwise, it returns the text unchanged.

**Call relations**: `render_job_csv` calls this for every header and every cell. It is the final safety step before text is written into the output CSV.

*Call graph*: called by 1 (render_job_csv); 1 external calls (format!).


### `core/src/tools/handlers/agent_jobs/report_agent_job_result.rs`

`domain_logic` · `request handling`

This file is the bridge between a model-facing tool call and the internal agent job system. In plain terms, it is like the receiving desk where a worker drops off a completed task: the desk checks the form, records it in the ledger, and gives back a receipt.

The handler advertises a tool named `report_agent_job_result` and provides its tool specification, which tells the outside caller what shape the tool call should have. When the tool is invoked, the file first makes sure the call is a normal function-style tool payload, then extracts the raw argument text.

The main `handle` function parses those arguments into the expected job result fields. It rejects the call if the reported `result` is not a JSON object, because downstream job storage expects a structured object rather than a string, list, or number. It then finds the session’s state database and records the result for a specific job item, including the thread that reported it. If the report is accepted and the worker also asked to stop, it tries to mark the whole job as cancelled with a clear message.

Finally, it returns a small JSON response saying whether the result was accepted. Errors that the model can fix are returned as messages to the model; unexpected serialization failure is treated as fatal.

#### Function details

##### `ReportAgentJobResultHandler::tool_name`  (lines 17–19)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool: `report_agent_job_result`. The tool registry uses this name so a tool call can be routed to the right handler.

**Data flow**: It takes no outside data beyond the handler itself. It creates a plain tool name from the fixed text `report_agent_job_result` and returns that name.

**Call relations**: When the tool system is building or searching its registry, it asks this handler for its name. This function hands back the name by calling the basic `plain` constructor for tool names.

*Call graph*: calls 1 internal fn (plain).


##### `ReportAgentJobResultHandler::spec`  (lines 21–23)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of what this tool expects and produces. This lets the model or tool caller know how to call `report_agent_job_result` correctly.

**Data flow**: It receives only the handler reference. It asks `create_report_agent_job_result_tool` to build the tool specification and returns that specification unchanged.

**Call relations**: During tool setup or advertisement, the registry asks this handler for its specification. This function delegates that work to `create_report_agent_job_result_tool`, keeping the schema definition in the shared agent-jobs specification code.

*Call graph*: calls 1 internal fn (create_report_agent_job_result_tool).


##### `ReportAgentJobResultHandler::handle`  (lines 25–27)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing an incoming tool invocation. It wraps the real asynchronous work in a future so the tool runtime can run it later without blocking.

**Data flow**: It receives a `ToolInvocation`, which contains the session and the payload sent by the caller. It passes that invocation to `handle_call`, pins the future in place as required by Rust’s async runtime, and returns it to the caller.

**Call relations**: The tool runtime calls this when a `report_agent_job_result` invocation arrives. Rather than doing the work inline, it hands off to `handle_call`, which performs payload checking and then calls the top-level `handle` function.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ReportAgentJobResultHandler::handle_call`  (lines 31–49)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Checks that the incoming invocation is the kind this handler understands, then extracts its arguments and starts the real job-result recording work.

**Data flow**: It receives a full tool invocation. It pulls out the session and payload. If the payload is a function call, it extracts the argument string and passes the session plus arguments to `handle`; if the payload is some other kind, it returns a model-facing error explaining that this handler received unsupported input. On success, it boxes the tool output into the standard output type used by the tool framework.

**Call relations**: This is called by `ReportAgentJobResultHandler::handle` after the runtime dispatches a tool call here. It is the safety gate before the main `handle` function: only function-style payloads are allowed through, while unsupported payloads are turned into `RespondToModel` errors the caller can see.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle); 1 external calls (RespondToModel).


##### `ReportAgentJobResultHandler::matches_kind`  (lines 53–55)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Tells the core tool runtime whether a given payload type belongs to this handler. This prevents non-function payloads from being sent to a function-only tool.

**Data flow**: It receives a tool payload by reference. It checks whether the payload is the `Function` variant and returns `true` if so, otherwise `false`.

**Call relations**: The runtime uses this as a quick compatibility check before or during dispatch. It mirrors the stricter check in `handle_call`, so normal routing can avoid sending unsupported payloads here in the first place.

*Call graph*: 1 external calls (matches!).


##### `handle`  (lines 58–98)

```
async fn handle(
    session: Arc<Session>,
    arguments: String,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Records an agent job item result in the state database and returns a small receipt saying whether the report was accepted. It also honors a worker’s optional request to cancel the job after reporting.

**Data flow**: It receives the current session and the raw argument string from the tool call. It parses the arguments into fields such as job id, item id, result, and optional stop flag. It verifies that `result` is a JSON object, gets the session’s required state database, and writes the result under the given job item and reporting thread. If the database accepts the result and the caller requested `stop`, it asks the database to mark the job cancelled. It then serializes `{ accepted }` into JSON text and returns it as successful tool output. If validation, database recording, or serialization fails, it returns an appropriate error.

**Call relations**: This is the core worker called by `ReportAgentJobResultHandler::handle_call` after the invocation has been identified as a function-style tool call. It talks to the state database to save the result and may also ask that same database to cancel the job. At the end it uses JSON serialization and `FunctionToolOutput::from_text` to hand a clear response back through the tool framework.

*Call graph*: calls 1 internal fn (from_text); called by 1 (handle_call); 2 external calls (to_string, RespondToModel).


### `core/src/tools/handlers/agent_jobs/spawn_agents_on_csv.rs`

`orchestration` · `tool invocation / request handling`

This file is the bridge between a model-facing tool call and the agent job system. Its real job is to let someone say: “Here is a spreadsheet-like CSV file; run the same instruction once for each row, filling in that row’s values.” Without this file, the tool named `spawn_agents_on_csv` would not know how to read the CSV, create job items, run them, or report where the results were written.

The handler first identifies itself to the tool registry with a name and a tool specification, which is the schema describing how the tool should be called. When invoked, it accepts only function-style tool payloads, extracts the JSON argument string, and passes it into the main `handle` function.

The main flow is careful and defensive. It parses the arguments, checks that the instruction is not empty, requires exactly one local working directory, reads the CSV file, validates the headers, and creates one job item per row. If the caller names an ID column, that column is used to label rows; duplicate IDs are made unique by adding suffixes, like turning “abc” into “abc-2”.

Then it creates a new agent job in the state database, chooses concurrency settings, marks the job as running, and runs the job loop to completion. Finally it makes sure an output CSV exists, gathers progress and failure details, and returns a JSON text result to the model.

#### Function details

##### `SpawnAgentsOnCsvHandler::tool_name`  (lines 18–20)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the tool system the public name of this tool: `spawn_agents_on_csv`. The name is how a model or caller asks for this specific CSV-to-agent-job behavior.

**Data flow**: It takes no outside input beyond the handler itself. It creates a plain tool name from the fixed string `spawn_agents_on_csv` and returns that name to the tool registry.

**Call relations**: When the tool registry asks this handler what it should be called, this function answers by calling `plain` to build the tool name in the standard format.

*Call graph*: calls 1 internal fn (plain).


##### `SpawnAgentsOnCsvHandler::spec`  (lines 22–24)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This provides the formal description of the tool’s inputs. That description is what lets callers know which arguments are allowed, such as the CSV path, instruction template, output path, and concurrency settings.

**Data flow**: It takes the handler as input, calls `create_spawn_agents_on_csv_tool`, and returns the resulting tool specification. It does not read files or change state.

**Call relations**: The tool registry calls this when it needs to advertise or validate the tool. This function delegates the actual specification-building to `create_spawn_agents_on_csv_tool`, keeping this handler focused on execution.

*Call graph*: calls 1 internal fn (create_spawn_agents_on_csv_tool).


##### `SpawnAgentsOnCsvHandler::handle`  (lines 26–28)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: This is the entry point used by the tool runtime when the tool is actually called. It wraps the real asynchronous work in a future, which is the Rust way of saying “work that will finish later.”

**Data flow**: It receives a `ToolInvocation`, passes it into `handle_call`, and boxes/pins the resulting future so the shared tool runtime can store and run it uniformly. The output will eventually be either a tool result or an error.

**Call relations**: The runtime calls this after choosing this handler for an invocation. It immediately hands off to `handle_call`, while `pin` packages the asynchronous operation in the shape expected by the tool framework.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `SpawnAgentsOnCsvHandler::handle_call`  (lines 32–55)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: This checks that the incoming tool request is the kind this handler understands, extracts the argument string, and starts the CSV job flow. It acts like a front desk: it rejects the wrong kind of request before the expensive work begins.

**Data flow**: It receives a `ToolInvocation` containing the session, turn context, and payload. If the payload is a function call, it pulls out the arguments and sends them to `handle`; if not, it returns a model-visible error. On success, it boxes the tool output into the common output type.

**Call relations**: It is called by `SpawnAgentsOnCsvHandler::handle`. After checking the payload, it calls the file’s main `handle` function to do the real CSV reading, job creation, running, and result reporting. If the payload is unsupported, it uses `RespondToModel` so the model gets a clear explanation rather than an internal crash.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle); 1 external calls (RespondToModel).


##### `SpawnAgentsOnCsvHandler::matches_kind`  (lines 59–61)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: This tells the core runtime whether this handler can process a given payload. Here, it accepts only function-style payloads, not other tool payload shapes.

**Data flow**: It receives a `ToolPayload` reference and checks whether it matches the `Function` variant. It returns `true` for function calls and `false` for anything else.

**Call relations**: The core tool runtime uses this as a quick filter before dispatching work. It mirrors the stricter check in `handle_call`, so the system can usually choose the right handler before execution starts.

*Call graph*: 1 external calls (matches!).


##### `handle`  (lines 69–300)

```
async fn handle(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    arguments: String,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: This is the main worker for the tool. It reads the requested CSV, creates an agent job with one item per row, runs that job, exports results to CSV if needed, and returns a compact JSON summary.

**Data flow**: It receives the current session, the current turn context, and the raw argument string from the tool call. It parses the arguments, finds the local working directory, reads and parses the CSV, validates the header row, builds job items from rows, creates a job record in the state database, runs the agent job loop, checks or creates the output CSV, gathers progress and failure details, and returns a text tool output containing JSON. Along the way it changes persistent job state in the database, including creating the job, marking it running, and marking it failed if setup or running breaks.

**Call relations**: It is called by `SpawnAgentsOnCsvHandler::handle_call` after the payload has been accepted. Early in its flow it calls `single_local_environment_cwd` to make sure file access is safe and local. It also calls into helper and subsystem functions outside this file for parsing arguments, parsing CSV, building runner options, running the job loop, exporting CSV snapshots, and formatting the final response with `from_text`.

*Call graph*: calls 2 internal fn (from_text, single_local_environment_cwd); called by 1 (handle_call); 10 external calls (new, from, new_v4, Object, with_capacity, format!, to_string, read_to_string, try_exists, RespondToModel).


##### `single_local_environment_cwd`  (lines 302–323)

```
fn single_local_environment_cwd(turn: &TurnContext) -> Result<AbsolutePathBuf, FunctionCallError>
```

**Purpose**: This finds the one local working directory that the CSV file path should be resolved against. It protects the tool from accidentally trying to read files in an unsupported remote or ambiguous environment.

**Data flow**: It receives the current turn context and looks at the environments attached to that turn. If there is not exactly one environment, or if that environment is remote, it returns a model-visible error. If there is exactly one local environment, it converts its current working directory into an absolute path on the Codex host and returns it.

**Call relations**: The main `handle` function calls this before reading the CSV. If this check succeeds, `handle` can safely join the caller’s CSV path to a known local directory; if it fails, the function uses `RespondToModel` so the caller gets a clear message about why the tool cannot proceed.

*Call graph*: called by 1 (handle); 1 external calls (RespondToModel).


### Memory extraction pipeline
These files implement the asynchronous startup pipeline that prepares runtime context, runs rollout-level memory extraction, and performs global consolidation in a background workflow.

### `memories/write/src/runtime.rs`

`orchestration` · `memory startup and consolidation`

The memory-writing system needs to ask a model for help, record useful measurements, and sometimes start a separate internal agent to consolidate memories. This file is the toolbox that makes those actions safe and consistent. Without it, the memory startup code would have to rebuild model clients, authentication details, telemetry labels, thread IDs, and cleanup rules in many places, which would make failures and metrics much harder to reason about.

The main type is MemoryStartupContext. Think of it like a trip folder for one memory-startup run: it carries the thread being worked on, the thread manager that can create or remove threads, the authentication manager, the model provider, and telemetry for measuring what happened. It can build a smaller StageOneRequestContext for the first model request, including model information, reasoning settings, service tier, and counters or timers.

The file also knows how to stream a prompt to the model and collect the answer as plain text while saving token usage. For longer consolidation work, it can start a separate internal thread, send it user input, and shut it down with a timeout. The important behavior is cleanup: if submitting work to the consolidation agent fails, the code tries to shut that agent down immediately so an unused background thread is not left running.

#### Function details

##### `StageOneRequestContext::start_timer`  (lines 56–58)

```
fn start_timer(&self, name: &str) -> Option<codex_otel::Timer>
```

**Purpose**: Starts a telemetry timer for a named part of the stage-one memory request. A timer is a measurement that records how long something takes.

**Data flow**: It receives a timer name and reads the telemetry object stored in the request context. It asks telemetry to start timing that name, ignores telemetry errors by turning them into no timer, and returns either a usable timer or nothing.

**Call relations**: This is a small wrapper around the shared telemetry system. Code doing stage-one work can call it before an operation starts, then let the returned timer record the duration when it is dropped or finished by the telemetry library.

*Call graph*: calls 1 internal fn (start_timer).


##### `StageOneRequestContext::counter`  (lines 60–62)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Adds to a named telemetry counter for the stage-one request. Counters are used for events such as 'one more job succeeded' or 'one more fallback was used.'

**Data flow**: It receives a metric name, an amount to add, and small label pairs called tags. It forwards those values to the request context's telemetry object and does not return anything.

**Call relations**: The metrics-emitting code calls this when it wants to count something that happened during stage one. This function keeps the rest of the memory code from needing to know the exact telemetry object layout.

*Call graph*: calls 1 internal fn (counter); called by 1 (emit_metrics).


##### `StageOneRequestContext::histogram`  (lines 64–66)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a numeric measurement for the stage-one request, such as a size, count, or duration bucket. A histogram groups many values so operators can see typical and unusual cases.

**Data flow**: It receives a metric name, a numeric value, and tags. It passes them to the request telemetry and returns no value.

**Call relations**: The metrics-emitting code uses this after it has a value worth measuring. This function is the simple doorway from memory-stage logic into the telemetry system.

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

**Purpose**: Creates a MemoryStartupContext for normal production use. It builds the model provider from configuration and then delegates the shared setup work to the common constructor.

**Data flow**: It receives the thread manager, authentication manager, current thread ID, current thread, configuration, and session source. It creates a model provider using the configured provider and authentication, then returns a fully built MemoryStartupContext.

**Call relations**: The memory startup task calls this when it begins working with a live thread. Tests that exercise live-style behavior can also use it. Internally it hands off to MemoryStartupContext::new_with_provider so telemetry and stored fields are set up in one place.

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

**Purpose**: Creates a MemoryStartupContext for tests while letting the test supply its own model provider. This makes tests predictable because they can use a fake or controlled provider instead of the real service setup.

**Data flow**: It receives the same basic context as the production constructor, plus a provider chosen by the test. It passes everything to the shared constructor and returns the resulting MemoryStartupContext.

**Call relations**: Test helper code calls this when it needs a context with a custom provider. It reuses MemoryStartupContext::new_with_provider so tests and production get the same telemetry and field initialization.

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

**Purpose**: Performs the shared setup for a MemoryStartupContext once a model provider is already known. It gathers authentication and environment details so telemetry can describe the session correctly.

**Data flow**: It receives thread objects, authentication, configuration, session source, and a provider. It reads cached authentication, account details, model name, user agent, and authentication-environment telemetry, builds a SessionTelemetry object, and stores all of these runtime pieces in a new context.

**Call relations**: Both the production constructor and the testing constructor call this. It calls helpers that identify the request origin, collect authentication-environment metadata, create telemetry, and read the terminal user agent, then returns the context used by the rest of the memory startup flow.

*Call graph*: calls 3 internal fn (originator, collect_auth_env_telemetry, new); 1 external calls (user_agent).


##### `MemoryStartupContext::thread_id`  (lines 166–168)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the ID of the thread this memory startup context belongs to. Other parts of the memory system use this to associate work with the right conversation thread.

**Data flow**: It reads the thread_id stored in the context and returns it unchanged. It does not modify anything.

**Call relations**: Job-claiming code calls this when it needs to mark or claim startup work for the current thread. It is a simple accessor that avoids exposing the whole context internals.

*Call graph*: called by 2 (claim_startup_jobs, claim).


##### `MemoryStartupContext::state_db`  (lines 170–172)

```
fn state_db(&self) -> Option<Arc<StateRuntime>>
```

**Purpose**: Gives access to the thread's state database if one exists. The state database is the stored record used to claim jobs, mark success or failure, and prune old memory-startup records.

**Data flow**: It asks the current Codex thread for its state runtime. The result is either a shared pointer to that state store or nothing if the thread has no state database attached.

**Call relations**: Memory job code calls this while claiming work, recording failure, recording no output, recording success, and pruning. This function is the bridge from runtime context to persistent state.

*Call graph*: called by 5 (claim_startup_jobs, failed, no_output, success, prune).


##### `MemoryStartupContext::provider`  (lines 174–176)

```
fn provider(&self) -> &dyn ModelProvider
```

**Purpose**: Returns the model provider stored in the context. A model provider is the component that knows how to talk to the configured model backend.

**Data flow**: It reads the shared provider object from the context and exposes it as a provider interface. It returns a borrowed view, not a new provider.

**Call relations**: Other memory code can use this when it needs provider capabilities without caring which concrete provider implementation was configured. The function simply unwraps the shared provider into the common interface.

*Call graph*: 1 external calls (as_ref).


##### `MemoryStartupContext::counter`  (lines 178–180)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Adds to a named telemetry counter for the overall memory startup context. This records how often important events happen during memory writing.

**Data flow**: It receives a metric name, increment amount, and tags, then forwards them to the context's session telemetry. It changes telemetry state outside the context and returns nothing.

**Call relations**: Metrics and job-state code call this when memory work is claimed, fails, succeeds, or otherwise emits measurements. It gives those callers one consistent way to count events for this session.

*Call graph*: calls 1 internal fn (counter); called by 4 (emit_metrics, claim, failed, succeed).


##### `MemoryStartupContext::histogram`  (lines 182–184)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a numeric telemetry value for the memory startup context. It is useful for values such as token counts or other measured quantities.

**Data flow**: It receives a metric name, value, and tags. It forwards them to session telemetry and returns no value.

**Call relations**: Token-usage metrics code calls this after model usage information is known. This keeps token measurements tied to the same session telemetry created when the memory context started.

*Call graph*: calls 1 internal fn (histogram); called by 1 (emit_token_usage_metrics).


##### `MemoryStartupContext::start_timer`  (lines 186–188)

```
fn start_timer(&self, name: &str) -> Option<codex_otel::Timer>
```

**Purpose**: Starts a telemetry timer for work done under the memory startup context. This lets the system measure how long named steps take.

**Data flow**: It receives a timer name and asks the context's telemetry to begin timing it. If telemetry cannot start the timer, it returns nothing instead of failing the memory flow.

**Call relations**: Memory startup code can call this around slower operations. It wraps the telemetry call so timing failures do not become user-visible runtime failures.

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

**Purpose**: Builds the smaller context needed for the first model request in memory writing. It gathers model details, reasoning settings, telemetry, and service tier into one package.

**Data flow**: It receives configuration, a model name, and the requested reasoning effort. It reads the thread's current configuration snapshot, asks the models manager for information about the named model, chooses the reasoning summary from config or the model default, clones telemetry with the active model name, and returns a StageOneRequestContext.

**Call relations**: The request-building code calls this before sending the stage-one prompt. It talks to the thread manager's models manager and the thread's config snapshot so the later streaming call has the correct model metadata and service-tier information.

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

**Purpose**: Sends the stage-one prompt to the model and streams the model's answer back as a single text string. It also captures token usage when the model reports it.

**Data flow**: It receives configuration, the prompt to send, and the stage-one request context. It resolves the installation ID, reads the thread's session source, builds a model client, prepares metadata that identifies this detached memory request, starts a streaming model call, appends text chunks as they arrive, falls back to completed message text if needed, saves token usage from the completion event, and returns the final text plus optional token usage.

**Call relations**: Sampling code calls this when it needs an actual model response for memory stage one. This function creates the ModelClient, uses detached memory response metadata, disables inference tracing for this request, consumes ResponseEvent messages from the stream, and hands the caller a plain result instead of raw stream events.

*Call graph*: calls 3 internal fn (new, from, disabled); called by 1 (sample); 7 external calls (clone, new, content_items_to_text, detached_memory_responses_metadata, resolve_installation_id, format!, to_string).


##### `MemoryStartupContext::spawn_consolidation_agent`  (lines 292–340)

```
async fn spawn_consolidation_agent(
        &self,
        config: Config,
        prompt: Vec<UserInput>,
    ) -> anyhow::Result<SpawnedConsolidationAgent>
```

**Purpose**: Starts a separate internal Codex thread to run memory consolidation work and sends it the initial prompt. This is like opening a side workspace so memory cleanup can happen without taking over the main thread.

**Data flow**: It receives a configuration and a list of user-input items. It asks the thread manager for default environments, starts a new thread marked as internal memory consolidation, wraps the new thread and ID in a SpawnedConsolidationAgent, submits the prompt to that thread, and returns the agent if submission succeeds. If submission fails, it tries to shut the agent down before returning the error.

**Call relations**: Memory consolidation code uses this when it needs an internal agent. It relies on the thread manager to start the thread and on the thread's submit operation to begin work; if that handoff breaks, it calls MemoryStartupContext::shutdown_consolidation_agent and logs a warning if cleanup also fails.

*Call graph*: calls 1 internal fn (shutdown_consolidation_agent); 4 external calls (default, new, Internal, warn!).


##### `MemoryStartupContext::shutdown_consolidation_agent`  (lines 342–360)

```
async fn shutdown_consolidation_agent(
        &self,
        agent: SpawnedConsolidationAgent,
    ) -> anyhow::Result<()>
```

**Purpose**: Stops a consolidation agent and waits for it to finish, with a limit on how long it will wait. This prevents internal memory threads from lingering forever.

**Data flow**: It receives a SpawnedConsolidationAgent containing a thread ID and thread object. It asks the thread manager to remove that thread from active tracking, falls back to the supplied thread if it was not found, then waits up to ten seconds for shutdown to complete. It returns success, a shutdown error, or a timeout error.

**Call relations**: MemoryStartupContext::spawn_consolidation_agent calls this when prompt submission fails, and other consolidation cleanup code can use it after an agent is no longer needed. It combines thread-manager removal with the thread's own shutdown routine so both bookkeeping and background execution are cleaned up.

*Call graph*: called by 1 (spawn_consolidation_agent); 2 external calls (from_secs, timeout).


### `memories/write/src/start.rs`

`orchestration` · `startup`

This file protects the memory system from doing work when it should not. A memory startup pipeline can be useful, but it costs time and may use model quota later, so the code first checks whether the session is allowed to use it. It skips temporary sessions, sessions where the memory feature is turned off, and non-root agent sessions, which are helper sessions rather than the main user session.

If the session is eligible, the file builds a shared startup context. That context is like a folder of supplies for the later steps: it carries access to the thread, authentication, configuration, session source, and the state database. If there is no state database, the pipeline cannot safely record or read the needed memory state, so it logs a warning and stops.

The real work is launched as a background asynchronous task, meaning the main session does not have to wait. The task creates the memories folder on disk, seeds extension instruction files, prunes old or oversized memory data, checks rate limits, and then runs two memory phases in order. Pruning happens before the quota check because it does not consume model tokens. The rate-limit check acts like a turnstile: if the user has no available quota, the pipeline records that it skipped and exits instead of spending more resources.

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

**Purpose**: This function starts the memory startup pipeline for a session, but only when that session is allowed to use memories. It keeps the rest of the system safe by skipping background memory work for temporary sessions, disabled features, helper-agent sessions, missing databases, or exhausted rate limits.

**Data flow**: It receives shared access to the thread manager, authentication manager, current thread ID, current thread, configuration, and session source. It first reads the configuration and session source to decide whether to stop immediately. If allowed, it builds a `MemoryStartupContext`, checks that a state database exists, and then launches an asynchronous background task. Inside that task it creates the memory directory, seeds instruction files, prunes memory storage, checks rate limits, records a skip metric if quota is unavailable, and otherwise passes the context and configuration through phase 1 and phase 2. The function itself returns right away after scheduling the background work; the visible changes happen later through files, database state, metrics, and the memory phases.

**Call relations**: This is the gateway into the memory startup flow. It creates the shared startup context with `MemoryStartupContext::new`, prepares the memory root, asks `seed_extension_instructions` to place needed instruction files, calls `phase1::prune` before any quota-consuming work, uses `guard::rate_limits_ok` as the final permission check, then hands control to `phase1::run` and `phase2::run` in order. Nothing else in this file performs memory work directly; this function wires the pieces together and starts them at the right time.

*Call graph*: calls 5 internal fn (seed_extension_instructions, rate_limits_ok, prune, run, new); 9 external calls (clone, new, clone, is_non_root_agent, memory_root, run, create_dir_all, spawn, warn!).


### `memories/write/src/phase1.rs`

`orchestration` · `startup memory extraction`

This file is active during memory startup. Its job is to turn eligible saved conversations, called rollouts, into raw memory records that later phases can refine and use. Without it, the system would have no fresh raw material for long-term memories, and old unused stage-1 records could pile up in the database.

The main flow is deliberately ordered. First it builds a request context, which is the shared setup needed to talk to the extraction model. Then it claims a limited number of eligible jobs from the state database, using a lease-like ownership token so two workers do not process the same rollout at the same time. Next it runs those jobs in parallel, but only up to a fixed concurrency limit so startup work does not overwhelm the model service.

Each job loads one rollout file, filters out parts that should not become memory, redacts secrets, and sends the remaining conversation to the model with a strict JSON schema. The expected answer contains a detailed raw memory, a short summary, and an optional filename-friendly slug. The job then marks the database row as succeeded, succeeded with no useful output, or failed for retry. Finally, the file totals the outcomes and token usage, emits metrics, and logs a human-readable summary.

#### Function details

##### `run`  (lines 70–108)

```
async fn run(context: Arc<MemoryStartupContext>, config: Arc<Config>)
```

**Purpose**: Runs the whole phase-1 memory extraction pass. It claims eligible rollout jobs, processes them through the model, and records metrics about what happened.

**Data flow**: It receives a startup context and configuration. It builds the model request context, asks the database for work, sends claimed jobs into the parallel job runner, combines the job results into counts, emits metrics, and writes a summary log. If there is no database work, it exits early.

**Call relations**: This is the top-level driver for this file. It calls build_request_context before work begins, claim_startup_jobs to reserve work, run_jobs to process that work, then aggregate_stats and emit_metrics to summarize the run.

*Call graph*: calls 5 internal fn (aggregate_stats, build_request_context, claim_startup_jobs, emit_metrics, run_jobs); 1 external calls (info!).


##### `prune`  (lines 111–133)

```
async fn prune(context: &MemoryStartupContext, config: &Config)
```

**Purpose**: Deletes old, unused phase-1 raw memory rows according to the configured retention period. This keeps the memory database from growing with stale material that was never used later.

**Data flow**: It reads the state database from the startup context and the maximum unused age from the configuration. It asks the database to remove a batch of stale stage-1 outputs, logs how many were removed, and warns if the database operation fails.

**Call relations**: The startup memory task calls this as a cleanup step. It works independently from extraction jobs, but uses the same state database area where phase-1 outputs are stored.

*Call graph*: calls 1 internal fn (state_db); called by 1 (start_memories_startup_task); 2 external calls (info!, warn!).


##### `output_schema`  (lines 136–147)

```
fn output_schema() -> Value
```

**Purpose**: Builds the strict JSON shape that the model must return for phase-1 extraction. This helps prevent vague or malformed model answers.

**Data flow**: It takes no input. It returns a JSON schema requiring three fields: rollout_summary, rollout_slug, and raw_memory, while allowing rollout_slug to be either a string or null.

**Call relations**: job::sample attaches this schema to the prompt before calling the model. A test also checks that rollout_slug is required but nullable, so callers can rely on that contract.

*Call graph*: called by 2 (sample, output_schema_requires_rollout_slug_and_keeps_it_nullable); 1 external calls (json!).


##### `claim_startup_jobs`  (lines 149–187)

```
async fn claim_startup_jobs(
    context: &MemoryStartupContext,
    memories_config: &MemoriesConfig,
) -> Option<Vec<codex_state::Stage1JobClaim>>
```

**Purpose**: Reserves a batch of rollout jobs for this startup run. This prevents multiple workers from extracting memory from the same rollout at once.

**Data flow**: It reads the state database, current thread id, allowed rollout sources, and memory limits from configuration. It asks the database to claim eligible jobs using age, idle-time, count, and lease settings. It returns the claimed jobs, or no result if the database is unavailable or the claim fails.

**Call relations**: run calls this before launching any extraction jobs. The claimed job list is handed to run_jobs; if claiming fails, run stops instead of guessing what work is safe.

*Call graph*: calls 2 internal fn (state_db, thread_id); called by 1 (run); 1 external calls (warn!).


##### `build_request_context`  (lines 189–202)

```
async fn build_request_context(
    context: &MemoryStartupContext,
    config: &Config,
) -> StageOneRequestContext
```

**Purpose**: Prepares the shared information needed to ask the model for memory extraction. It chooses the extraction model and builds a context for metrics, timing, and model calls.

**Data flow**: It reads the configured extraction model if one is set. If not, it asks the provider for its preferred memory extraction model. It then returns a StageOneRequestContext built with that model and the phase-1 reasoning setting.

**Call relations**: run calls this first so later steps have a single consistent model context. job::sample later uses that context when it sends prompts to the model.

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

**Purpose**: Runs all claimed phase-1 jobs in parallel, while keeping the number of simultaneous jobs under a fixed limit. This speeds up startup without flooding the model service.

**Data flow**: It receives the shared context, configuration, claimed jobs, and request context. For each claim, it starts job::run, buffers the tasks with the configured concurrency limit, waits for all of them, and returns their JobResult values.

**Call relations**: run calls this after claiming jobs. It delegates the real per-rollout extraction to job::run and gives the completed job results back to run for counting and metrics.

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

**Purpose**: Processes one claimed rollout job from start to finish. It turns one rollout into a model-produced memory result and records the outcome in the database.

**Data flow**: It receives one database claim, including the rollout path, working directory, thread id, update time, and ownership token. It calls job::sample to extract model output. If sampling fails, it records a failed job. If the model returns empty required content, it records a no-output success. Otherwise it records the raw memory, summary, slug, and source timestamp as a successful output.

**Call relations**: run_jobs calls this for each claimed job. It hands failed cases to job::result::failed, empty cases to job::result::no_output, and useful extracted memories to job::result::success.

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

**Purpose**: Loads one rollout and asks the model to extract phase-1 memory from it. This is where saved conversation history becomes structured memory text.

**Data flow**: It receives the rollout file path, rollout working directory, configuration, and request context. It loads rollout items from disk, filters and serializes the parts safe for memory extraction, builds a prompt with base instructions and the strict output schema, sends the prompt to the model, parses the model's JSON answer, redacts secrets from the returned text, and returns the StageOneOutput plus optional token usage.

**Call relations**: job::run calls this as the core extraction step. It uses output_schema to constrain the model response and job::serialize_filtered_rollout_response_items to prepare the conversation for the prompt.

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

**Purpose**: Records that one phase-1 job failed and should be retried later. It also logs the reason so operators can investigate repeated failures.

**Data flow**: It receives the context, thread id, ownership token, and failure reason. It writes a warning log, then, if the state database is available, asks the database to mark the job failed with a retry delay. It does not return a value.

**Call relations**: job::run calls this when job::sample returns an error. It is the failure-recording branch of the per-job workflow.

*Call graph*: calls 1 internal fn (state_db); 1 external calls (warn!).


##### `job::result::no_output`  (lines 349–368)

```
async fn no_output(
            context: &MemoryStartupContext,
            thread_id: codex_protocol::ThreadId,
            ownership_token: &str,
        ) -> JobOutcome
```

**Purpose**: Records that a job completed but produced no useful memory text. This is different from an error: the rollout may simply contain nothing worth remembering.

**Data flow**: It receives the context, thread id, and ownership token. It asks the database to mark the job as succeeded with no output. It returns SucceededNoOutput if the database confirms the update, otherwise Failed.

**Call relations**: job::run calls this when the model result has an empty raw memory or empty summary. The returned outcome is later counted by aggregate_stats.

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

**Purpose**: Stores a useful phase-1 memory result in the database and marks the job complete. This is the successful end of one rollout extraction.

**Data flow**: It receives the context, thread id, ownership token, source update timestamp, raw memory, rollout summary, and optional slug. It asks the database to save those values and mark the claim as succeeded. It returns SucceededWithOutput if the database accepts the update, otherwise Failed.

**Call relations**: job::run calls this after job::sample returns non-empty memory and summary text. The outcome then flows back through run_jobs and into aggregate_stats.

*Call graph*: calls 1 internal fn (state_db).


##### `job::serialize_filtered_rollout_response_items`  (lines 404–424)

```
fn serialize_filtered_rollout_response_items(
        items: &[RolloutItem],
    ) -> codex_protocol::error::Result<String>
```

**Purpose**: Turns selected rollout items into a JSON string suitable for including in the model prompt. It removes items that should not influence memory and redacts secrets before upload.

**Data flow**: It receives a list of rollout items. It keeps memory-relevant response items, converts inter-agent messages into model input form, drops metadata and other non-conversation records, serializes the remaining items to JSON, redacts secret-looking values, and returns the safe string or an error if serialization fails.

**Call relations**: job::sample calls this before building the prompt. Several tests call it directly to confirm that unwanted context is removed, secrets are hidden, and inter-agent communications are preserved.

*Call graph*: 3 external calls (redact_secrets, iter, to_string).


##### `job::sanitize_response_item_for_memories`  (lines 426–462)

```
fn sanitize_response_item_for_memories(item: &ResponseItem) -> Option<ResponseItem>
```

**Purpose**: Decides whether a single model response item should be kept for memory extraction, and trims user messages when only part of them should be excluded.

**Data flow**: It receives one response item. Non-message items are kept only if the rollout policy says they are safe for memories. Developer messages are dropped. Non-user messages are kept unchanged. User messages have AGENTS.md instruction fragments and skill fragments removed; if nothing remains, the whole message is dropped.

**Call relations**: job::serialize_filtered_rollout_response_items uses this while walking through rollout items. It relies on job::is_memory_excluded_contextual_user_fragment to identify user-message fragments that are context setup rather than conversation content.

*Call graph*: 2 external calls (should_persist_response_item_for_memories, clone).


##### `job::is_memory_excluded_contextual_user_fragment`  (lines 464–471)

```
fn is_memory_excluded_contextual_user_fragment(content_item: &ContentItem) -> bool
```

**Purpose**: Recognizes user-message text blocks that are contextual setup and should not become memory. In practice, it excludes injected AGENTS.md instructions and skill definitions.

**Data flow**: It receives one content item. If the item is not input text, it returns false. If it is text, it checks whether the text is wrapped in known start and end markers for excluded fragments, and returns true only for those cases.

**Call relations**: job::sanitize_response_item_for_memories calls this for each content fragment in a user message. The unit test job::tests::classifies_memory_excluded_fragments checks the intended classifications.

*Call graph*: 1 external calls (matches_marked_fragment).


##### `job::matches_marked_fragment`  (lines 473–483)

```
fn matches_marked_fragment(text: &str, start_marker: &str, end_marker: &str) -> bool
```

**Purpose**: Checks whether a piece of text starts and ends with a specific marker pair, ignoring leading/trailing whitespace and letter case. It is a small helper for recognizing whole marked blocks.

**Data flow**: It receives text, a start marker, and an end marker. It trims the outside whitespace, compares the beginning and ending parts with case-insensitive matching, and returns true only if both markers match.

**Call relations**: job::is_memory_excluded_contextual_user_fragment calls this twice: once for AGENTS.md instruction blocks and once for skill blocks.


##### `job::tests::classifies_memory_excluded_fragments`  (lines 490–523)

```
fn classifies_memory_excluded_fragments()
```

**Purpose**: Tests that the fragment filter excludes only the intended contextual blocks. This protects against accidentally storing project instructions or skill definitions as memories.

**Data flow**: It builds several sample text fragments with expected true-or-false answers. For each one, it wraps the text as an input content item, runs job::is_memory_excluded_contextual_user_fragment, and checks the result.

**Call relations**: This test exercises the helper used by job::sanitize_response_item_for_memories. It gives confidence that serialization will keep environment and subagent context while dropping AGENTS.md and skill fragments.

*Call graph*: 1 external calls (assert_eq!).


##### `job::tests::output_schema_requires_rollout_slug_and_keeps_it_nullable`  (lines 526–565)

```
fn output_schema_requires_rollout_slug_and_keeps_it_nullable()
```

**Purpose**: Tests the contract of the model output schema. It ensures rollout_slug is present in the schema and may be null.

**Data flow**: It calls output_schema, inspects the properties and required fields, sorts the relevant lists, and asserts that raw_memory, rollout_summary, and rollout_slug are required while rollout_slug accepts both null and string.

**Call relations**: This test protects output_schema, which job::sample depends on when asking the model for structured JSON.

*Call graph*: calls 1 internal fn (output_schema); 2 external calls (assert!, assert_eq!).


##### `aggregate_stats`  (lines 569–597)

```
fn aggregate_stats(outcomes: Vec<JobResult>) -> Stats
```

**Purpose**: Turns a list of individual job results into totals for logging and metrics. It also adds up reported model token usage.

**Data flow**: It receives all JobResult values from a phase-1 run. It counts how many were claimed, succeeded with output, succeeded with no output, and failed. For jobs that include token usage, it adds their input, cached input, output, reasoning output, and total token counts. It returns a Stats summary.

**Call relations**: run calls this after run_jobs finishes. The tests call it directly to confirm token totals are added correctly and remain absent when no job reports usage.

*Call graph*: called by 3 (run, count_outcomes_keeps_usage_empty_when_no_job_reports_it, count_outcomes_sums_token_usage_across_all_jobs); 1 external calls (default).


##### `emit_metrics`  (lines 599–660)

```
fn emit_metrics(context: &StageOneRequestContext, counts: &Stats)
```

**Purpose**: Reports phase-1 job counts and token usage to the metrics system. These numbers let operators see how much work ran and how expensive it was.

**Data flow**: It receives the request context and aggregated Stats. It increments counters for claimed, succeeded, no-output, failed, and output-producing jobs when their counts are nonzero. If token usage exists, it records histograms for total, input, cached input, output, and reasoning-output tokens.

**Call relations**: run calls this after aggregate_stats. It uses the StageOneRequestContext as the bridge to the metrics system.

*Call graph*: calls 2 internal fn (counter, histogram); called by 1 (run).


##### `tests::serializes_memory_rollout_with_agents_removed_but_environment_kept`  (lines 670–738)

```
fn serializes_memory_rollout_with_agents_removed_but_environment_kept()
```

**Purpose**: Tests that rollout serialization removes instruction and skill blocks but keeps useful context such as environment information and subagent notifications.

**Data flow**: It builds sample rollout response items containing AGENTS.md instructions, a skill definition, environment context, and a subagent notification. It serializes them through job::serialize_filtered_rollout_response_items, parses the JSON back into response items, and compares the result to the expected kept messages.

**Call relations**: This test exercises the same serialization path that job::sample uses before prompting the model. It guards the filtering behavior used by job::sanitize_response_item_for_memories.

*Call graph*: 5 external calls (assert_eq!, serialize_filtered_rollout_response_items, ResponseItem, from_str, vec!).


##### `tests::serializes_memory_rollout_redacts_secrets_before_prompt_upload`  (lines 741–759)

```
fn serializes_memory_rollout_redacts_secrets_before_prompt_upload()
```

**Purpose**: Tests that secrets are hidden before serialized rollout data is sent to the model. This reduces the risk of leaking API keys or similar sensitive values.

**Data flow**: It creates a function-call output containing a secret-looking token. It serializes the rollout item and then asserts that the original token is gone and the redaction marker is present.

**Call relations**: This test directly checks job::serialize_filtered_rollout_response_items, which job::sample relies on before any prompt upload.

*Call graph*: 4 external calls (assert!, serialize_filtered_rollout_response_items, Text, ResponseItem).


##### `tests::serializes_inter_agent_communications_for_memory`  (lines 762–790)

```
fn serializes_inter_agent_communications_for_memory()
```

**Purpose**: Tests that messages between agents are preserved in the memory prompt input. These messages can explain what happened during a rollout and may be important for later memory extraction.

**Data flow**: It creates both plaintext and encrypted inter-agent communication records, converts the expected versions to model input items, serializes the rollout items, parses the JSON, and checks that the parsed output matches the expected model input items.

**Call relations**: This test covers the InterAgentCommunication branch inside job::serialize_filtered_rollout_response_items, the helper used by job::sample.

*Call graph*: calls 3 internal fn (root, new, new_encrypted); 6 external calls (new, assert_eq!, serialize_filtered_rollout_response_items, InterAgentCommunication, from_str, vec!).


##### `tests::count_outcomes_sums_token_usage_across_all_jobs`  (lines 793–835)

```
fn count_outcomes_sums_token_usage_across_all_jobs()
```

**Purpose**: Tests that aggregate_stats counts job outcomes and adds token usage across multiple jobs. This keeps metrics accurate when some jobs succeed, some produce no memory, and some fail.

**Data flow**: It builds three sample JobResult values with different outcomes and token usage. It passes them to aggregate_stats and checks the resulting counts and summed token fields.

**Call relations**: This test protects the summary step used by run before emit_metrics reports the numbers.

*Call graph*: calls 1 internal fn (aggregate_stats); 2 external calls (assert_eq!, vec!).


##### `tests::count_outcomes_keeps_usage_empty_when_no_job_reports_it`  (lines 838–852)

```
fn count_outcomes_keeps_usage_empty_when_no_job_reports_it()
```

**Purpose**: Tests that aggregate_stats does not invent token usage when no job reports any. This lets metrics distinguish between zero usage and unavailable usage data.

**Data flow**: It builds sample JobResult values with no token usage, calls aggregate_stats, and checks that the total_token_usage field is absent.

**Call relations**: This test protects aggregate_stats, which run uses to decide whether emit_metrics should publish token histograms.

*Call graph*: calls 1 internal fn (aggregate_stats); 2 external calls (assert_eq!, vec!).


### `memories/write/src/phase2.rs`

`orchestration` · `startup/background memory consolidation`

This file is the coordinator for memory consolidation. Phase 1 has already produced raw memory records from user activity. Phase 2 turns those raw records into a cleaner memory workspace, using a special internal agent. Without this file, raw memories could pile up, two workers could race to rewrite the same files, or a failed agent could leave the system thinking consolidation succeeded.

The flow is deliberately linear, like a checklist. First it claims a global job lease in the state database. A lease is a temporary lock: it says “this worker owns this job for now,” and it must be refreshed while the job runs. Then it prepares the memory folder as a git-backed workspace, builds a locked-down configuration for the consolidation agent, loads the raw memories that should be processed, writes those inputs into files, and checks whether the workspace actually changed.

If there is no change, the job can finish without running an agent. If there is a change, the file writes a diff for the agent to inspect, starts the agent with a consolidation prompt, and then watches it in the background. While the agent runs, the code sends heartbeats to keep the lease alive. If the agent succeeds and the lock is still owned, the workspace baseline is reset and the database is marked successful. Metrics are recorded throughout so operators can see job counts, input sizes, failures, and token use.

#### Function details

##### `run`  (lines 46–201)

```
async fn run(context: Arc<MemoryStartupContext>, config: Arc<Config>)
```

**Purpose**: Runs the whole phase-2 consolidation job from start to dispatching the agent. It follows a strict order so the memory workspace is prepared, locked, updated, checked, and handed to the agent safely.

**Data flow**: It receives a startup context and the main configuration. From those it reads the state database, memory settings, model provider, and memory root folder. It claims the global job lock, loads raw phase-1 memory outputs, writes them into the workspace, computes the new completion watermark, checks for file changes, writes a diff, starts the consolidation agent, and records metrics. If any step fails, it marks the database job as failed with a specific reason and stops early.

**Call relations**: This is called by the memory startup task, and also by a model-request test. It is the top-level story in this file: it calls the job helpers to claim or finish work, the workspace helpers to prepare and compare files, the agent helpers to configure and launch the internal agent, and the metric helpers to report what happened.

*Call graph*: calls 6 internal fn (emit_metrics, get_watermark, sync_phase2_workspace_inputs, memory_workspace_diff, prepare_memory_workspace, write_workspace_diff); called by 2 (start_memories_startup_task, run_memory_phase_two_model_request_test); 9 external calls (clone, get_config, get_prompt, handle, memory_root, claim, failed, succeed, error!).


##### `sync_phase2_workspace_inputs`  (lines 203–212)

```
async fn sync_phase2_workspace_inputs(
    root: &Path,
    raw_memories: &[Stage1Output],
) -> std::io::Result<()>
```

**Purpose**: Copies the selected raw memories into the on-disk memory workspace in the format the consolidation agent expects. It also removes old extension-related resources so the workspace stays clean.

**Data flow**: It receives the memory root folder and a list of raw memory outputs. It writes rollout summaries, rebuilds the raw memories file from the selected records, prunes stale extension resources, and returns success or an input/output error if writing fails.

**Call relations**: The main run flow calls this after choosing the phase-2 inputs and before checking the git diff. Its output is not a data object but a changed workspace on disk, which the later diff step and agent then inspect.

*Call graph*: called by 1 (run); 4 external calls (prune_old_extension_resources, rebuild_raw_memories_file_from_memories, sync_rollout_summaries_from_memories, len).


##### `job::claim`  (lines 217–251)

```
async fn claim(
        context: &MemoryStartupContext,
        db: &StateRuntime,
    ) -> Result<Claim, &'static str>
```

**Purpose**: Tries to reserve the global phase-2 job for this worker. This prevents multiple workers from consolidating the same memory workspace at once.

**Data flow**: It reads the current thread id from the context and asks the database to claim the phase-2 job lease. If the database grants ownership, it returns a Claim containing an ownership token and the previous input watermark. If the job is already running, cooling down, or unavailable for retry, it returns a short status string explaining why no work should start.

**Call relations**: The main run function calls this first, before touching workspace files. On success, later helpers use the returned token to prove they still own the job when sending heartbeats or marking the job finished.

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

**Purpose**: Records that the phase-2 job failed and schedules it for retry later. It also increments a metric with the failure reason so failures can be counted by cause.

**Data flow**: It receives the context, database, current claim, and a fixed failure reason. It reports the reason as a job metric, then asks the database to mark the job failed using the ownership token. If the normal update says the job is no longer owned, it tries a fallback update for the unowned case.

**Call relations**: The main run flow calls this whenever setup, input loading, workspace syncing, diff writing, or agent launch fails. The background agent handler also calls it if the running agent fails, the workspace baseline cannot be reset, or ownership cannot be confirmed.

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

**Purpose**: Records that the phase-2 job completed successfully. It advances the database watermark so the system knows which raw memories were covered by this consolidation run.

**Data flow**: It receives the current claim, the completion watermark, the selected raw outputs, and a success reason. It reports the success as a metric, then asks the database to mark the job succeeded for that ownership token and selected inputs. It returns true if the database accepted the success update, otherwise false.

**Call relations**: The main run flow uses this when the workspace had no actual changes after syncing inputs. The agent handler uses it after the agent completes and the workspace baseline is safely reset.

*Call graph*: calls 2 internal fn (counter, memories).


##### `agent::get_config`  (lines 301–348)

```
fn get_config(config: &Config, provider: &dyn ModelProvider) -> Option<Config>
```

**Purpose**: Builds the special configuration used for the internal consolidation agent. The goal is to let the agent edit only the memory workspace, with no network access, no approval prompts, and no recursive memory generation.

**Data flow**: It takes the normal application config and a model provider. It clones the config, changes the working directory to the memory root, disables memory reading and writing for the agent itself, disables app/plugin/delegation features, removes external server access, sets approval to never ask, sets a write-only sandbox for the memory root, and chooses the consolidation model. It returns the locked-down config, or nothing if the sandbox policy cannot be set.

**Call relations**: The main run flow calls this before loading inputs into the agent. Its result is passed to the startup context when spawning the consolidation agent, ensuring the worker runs with safer limits than a normal user-facing agent.

*Call graph*: calls 1 internal fn (allow_only); 4 external calls (new, clone, memory_root, vec!).


##### `agent::get_prompt`  (lines 350–356)

```
fn get_prompt(root: &Path) -> Vec<UserInput>
```

**Purpose**: Creates the user-style prompt that tells the consolidation agent what to do. The prompt is wrapped as text input because the agent interface expects user input messages.

**Data flow**: It receives the memory root path, builds a consolidation prompt for that folder, and returns a one-item list containing that prompt as text.

**Call relations**: The main run flow calls this immediately before spawning the agent. The prompt and the locked-down agent configuration together define what the internal agent sees and what it is allowed to change.

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

**Purpose**: Watches the consolidation agent after it has been started. It keeps the job lease alive, records token-use metrics, finalizes the database job, resets the workspace baseline, and shuts the agent down afterward.

**Data flow**: It receives the context, ownership claim, new watermark, selected raw outputs, memory root, spawned agent, and end-to-end timer. It starts a background task, waits for the agent loop to return a final status, and then branches. If the agent completed, it records token usage, confirms the lease is still owned, resets the git baseline for the workspace, and marks the job succeeded. If the agent failed or ownership is lost, it records failure. Finally it starts a cleanup task to close the agent thread.

**Call relations**: The main run function hands control to this after spawning the agent. Inside the background task it calls the agent loop to monitor status and heartbeats, calls job success or failure helpers to update the database, and calls workspace reset only after confirming ownership.

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

**Purpose**: Polls the running consolidation agent until it reaches a final result, while periodically refreshing the database lease. This stops long-running consolidation from losing its lock silently.

**Data flow**: It receives the database, ownership token, agent thread id, and agent thread. It repeatedly checks the agent status. Every heartbeat interval it asks the database to extend the job lease. It also watches for the agent session ending unexpectedly. It returns the final agent status: completed if all went well, or an error status if ownership is lost, heartbeat update fails, or the session exits before a final status is available.

**Call relations**: The agent handler calls this inside its background task. It relies on is_final_agent_status to know when polling can stop, and its returned status decides whether the handler records success or failure.

*Call graph*: calls 3 internal fn (agent_status, wait_until_terminated, is_final_agent_status); 4 external calls (from_secs, pin!, select!, interval).


##### `get_watermark`  (lines 520–530)

```
fn get_watermark(
    claimed_watermark: i64,
    latest_memories: &[codex_state::Stage1Output],
) -> i64
```

**Purpose**: Computes the completion watermark for this consolidation run. A watermark is a timestamp marker that tells future runs how far through the raw memory inputs this job got.

**Data flow**: It receives the watermark from the claimed job and the selected raw memory outputs. It looks for the newest source update timestamp among those outputs. It returns the newer of that timestamp and the claimed watermark, so the marker never moves backward. If there are no selected memories, it returns the claimed watermark.

**Call relations**: The main run flow calls this after loading the raw inputs. The resulting value is later passed to job success recording, either immediately for a no-change run or after the agent completes.

*Call graph*: called by 1 (run); 1 external calls (iter).


##### `is_final_agent_status`  (lines 532–537)

```
fn is_final_agent_status(status: &AgentStatus) -> bool
```

**Purpose**: Answers whether an agent status means the agent is done. Running-like states are treated as not final; everything else is final.

**Data flow**: It receives one agent status value. It checks whether the status is pending initialization, running, or interrupted. If so, it returns false; otherwise it returns true.

**Call relations**: The agent loop uses this every time it checks the agent. It is the small decision point that tells the monitoring loop whether to keep waiting or hand a final result back to the handler.

*Call graph*: called by 1 (loop_agent); 1 external calls (matches!).


##### `emit_metrics`  (lines 539–549)

```
fn emit_metrics(context: &MemoryStartupContext, counters: Counters)
```

**Purpose**: Records basic phase-2 dispatch metrics after the consolidation agent has been started. These metrics show how many raw memories were sent and that an agent was spawned.

**Data flow**: It receives the context and a Counters value containing the input count. If the input count is positive, it increments the phase-2 input metric by that amount. It also increments the job metric with the status "agent_spawned".

**Call relations**: The main run function calls this after handing the spawned agent to the background handler. It complements the job-claim, success, and failure metrics emitted by the job helpers.

*Call graph*: calls 1 internal fn (counter); called by 1 (run).


##### `emit_token_usage_metrics`  (lines 551–577)

```
fn emit_token_usage_metrics(context: &MemoryStartupContext, token_usage: &TokenUsage)
```

**Purpose**: Records how many model tokens the consolidation agent used. Tokens are chunks of text the model processes or produces, and tracking them helps measure cost and load.

**Data flow**: It receives the context and a TokenUsage summary. It writes histogram measurements for total tokens, input tokens, cached input tokens, output tokens, and reasoning-output tokens. Negative token counts are clamped to zero where needed.

**Call relations**: The agent handler calls this only after the consolidation agent completes and token usage information is available from the thread. These metrics connect the background agent work to operational monitoring.

*Call graph*: calls 2 internal fn (histogram, cached_input); called by 1 (handle).


### Background watchers
This final background component watches skill directories for changes and broadcasts cache-invalidating notifications to the server runtime.

### `app-server/src/skills_watcher.rs`

`orchestration` · `startup, configuration changes, background watching, shutdown`

A “skill” is project-provided or plugin-provided behavior that Codex can load and use. This file keeps that skill information fresh. It sets up a file watcher, subscribes to change events, and runs a small background loop that reacts when watched files are edited, added, or removed.

The main type is `SkillsWatcher`. Think of it like a librarian watching the shelves: when someone changes a book, it tells the catalog to forget its old listing and alerts the front desk that the catalog should be refreshed. Here, the “catalog” is the `SkillsManager` cache, and the “front desk” is the outgoing message channel to the client.

The watcher can monitor two kinds of locations. First, it can watch extra root folders that are added while the app is already running. Second, it can inspect a thread’s configuration and environment, figure out which local skill folders apply, and register those folders with the file watcher. Remote environments are skipped, because this local file watcher cannot reliably watch files on another machine.

Change events are throttled, meaning bursts of many file changes are grouped so the app does not spam refresh messages. On shutdown, a cancellation token stops the background task cleanly.

#### Function details

##### `SkillsWatcher::new`  (lines 37–58)

```
fn new(
        skills_manager: Arc<SkillsManager>,
        outgoing: Arc<OutgoingMessageSender>,
    ) -> Arc<Self>
```

**Purpose**: Creates a new skills watcher and starts its background listener. If a real file watcher cannot be created, it falls back to a no-op watcher so the server can keep running, just without live skill change detection.

**Data flow**: It receives a shared `SkillsManager`, which owns the cached skill information, and an outgoing message sender, which can notify clients. It tries to create a file watcher, subscribes to its events, creates a shutdown signal, starts the event loop, and returns a shared `SkillsWatcher` object that other parts of the server can use to register folders or stop watching.

**Call relations**: This is the construction point for the watcher during server setup. It prepares the subscription and then hands the event stream to `SkillsWatcher::spawn_event_loop`, which does the ongoing background work. If setup fails, it logs a warning and still returns a usable watcher built around a no-op file watcher.

*Call graph*: calls 3 internal fn (new, noop, default); called by 1 (new); 5 external calls (new, new, new, spawn_event_loop, warn!).


##### `SkillsWatcher::shutdown`  (lines 60–62)

```
fn shutdown(&self)
```

**Purpose**: Stops the watcher’s background task. Someone would call this when the server or owning component is shutting down and should no longer listen for skill file changes.

**Data flow**: It reads the watcher’s cancellation token and marks it as cancelled. That cancellation signal is picked up by the background event loop, which then exits instead of waiting for more file events.

**Call relations**: This is the clean stop button for the work started by `SkillsWatcher::new`. The event loop created by `SkillsWatcher::spawn_event_loop` is waiting for either file changes or this shutdown signal, so calling this tells that loop to finish.

*Call graph*: 1 external calls (cancel).


##### `SkillsWatcher::register_runtime_extra_roots`  (lines 64–78)

```
fn register_runtime_extra_roots(&self, extra_roots: &[AbsolutePathBuf])
```

**Purpose**: Adds extra skill folders to the watcher while the app is already running. This is useful when new roots are discovered or supplied after initial startup.

**Data flow**: It receives a list of absolute folder paths. For each one, it builds a watch request that includes all nested files and folders, registers those paths with the file watcher subscriber, and stores the returned registration. Storing the registration keeps those watches active and replaces any previous runtime extra-root registration.

**Call relations**: Other runtime setup code can call this when extra skill roots become known. It hands the folder list to the file watcher subscriber; later, changes inside those folders flow into the same background event loop that clears the skills cache and notifies clients.

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

**Purpose**: Figures out which skill folders apply to a particular thread configuration and registers them for watching. It avoids watching when there is no environment, when the environment is unknown, or when the environment is remote.

**Data flow**: It receives the current configuration, the thread manager, and the selected environments. It takes the first environment selection, looks up the matching environment, skips remote environments, asks the plugin system which plugin skill roots apply, builds a `SkillsLoadInput`, asks the skills manager for the final skill roots, converts those roots into recursive watch paths, and returns a watch registration that keeps those watches alive.

**Call relations**: This function connects configuration, environments, plugins, and skill loading into the watcher. It is called when a thread’s config needs file watching set up. It consults the thread manager’s environment, plugin, and skills components, then hands the resulting local folders to the file watcher subscriber.

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

**Purpose**: Starts the background task that reacts to skill file changes. Its job is to turn low-level file change events into one clear action: clear cached skills and notify the client that skills changed.

**Data flow**: It receives the raw file-watch event stream, the shared skills manager, the outgoing message sender, and a shutdown token. It wraps the event stream in a throttled receiver so rapid changes are grouped, finds the current Tokio runtime, and spawns an async loop. Each time a change arrives, it clears the skills cache and sends a `SkillsChanged` server notification. If shutdown is requested or the event stream closes, the loop stops.

**Call relations**: `SkillsWatcher::new` calls this after subscribing to file watcher events. Once running, it sits in the background between the file watcher and the rest of the app: file changes come in from the watcher, and outgoing notifications go out to clients. If there is no Tokio runtime available to run async work, it logs a warning and does not start the listener.

*Call graph*: calls 1 internal fn (new); 4 external calls (SkillsChanged, try_current, select!, warn!).

## 📊 State Registers Touched

- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-memory-store` — The saved long-term user memories and memory search results that can be loaded, updated, and inserted into future conversations.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-agent-registry-graph` — The live and persisted map of parent agents, child agents, thread names, statuses, and which helper agents are still open.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-filesystem-watch-subscriptions` — Active file and directory watch subscriptions, invalidation signals, and watcher-to-client mappings used for skills, plugin/config refreshes, and app-server file APIs.
- `reg-memory-write-safety-state` — Cached or in-flight safety decisions for whether proposed long-term memory writes should be allowed before they update the memory store.
