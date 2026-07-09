# Core config schemas, diagnostics, merge, and layered loading  `stage-4.1.1`

This stage is the behind-the-scenes configuration workshop. It runs during startup and whenever Codex needs to rebuild its settings. First, schema files define what valid settings look like: config_toml, profile_toml, hook_config, mcp_types, tui_keymap, environment_toml, agent_roles, and schema cover normal settings, reusable profiles, hooks, MCP servers, keyboard shortcuts, execution environments, agent roles, and tests around those shapes. Next, strict_config and diagnostics check files carefully and explain mistakes with exact line and column locations.

The loading side gathers settings from many places. loader/mod is the main coordinator. layer_io and macos read administrator-managed settings. cloud_config_bundle, cloud_config_layers, and cloud validation turn cloud-delivered policy into ordinary layers. thread_config adds per-session settings, and overrides converts command-line flags into the same TOML-like shape.

Finally, state, merge, and fingerprint stack all layers in priority order, normalize names, remember where values came from, and detect changes. config_lock can save and later compare the exact resolved configuration, making runs repeatable.

## Files in this stage

### Schema definitions
These files define the typed configuration schemas and related adapters that all later loading, validation, and merging logic operates on.

### `config/src/config_toml.rs`

`config` · `config load and startup`

This file is mostly a map between human-written TOML configuration and Codex's internal settings. TOML is a plain text configuration format, and this file says which keys are allowed, what type each value should have, and what default value to use when a key is missing. It covers a wide range of Codex behavior: model choice, sandboxing, permissions, project trust, history, logging, realtime voice settings, tools, agents, plugins, analytics, Windows options, and more.

Think of it like the official order form for Codex settings. If the form is clear, Codex can safely understand what the user meant. If the form allowed anything, typos or unsafe overrides could silently change behavior.

The file also contains a few important translation and validation steps. For example, it converts old-style sandbox settings into a modern permission profile, finds the active project by comparing paths carefully, rejects attempts to override built-in model provider IDs, and accepts older configuration shapes where compatibility matters. It also keeps some deprecated fields so older config files fail clearly or keep loading instead of breaking unexpectedly.

A small test section checks the special ChatGPT workspace ID setting, especially that users must use a proper TOML list instead of a comma-separated string.

#### Function details

##### `default_allow_login_shell`  (lines 70–72)

```
fn default_allow_login_shell() -> Option<bool>
```

**Purpose**: Provides the default setting for whether shell commands may use a login shell. Codex defaults this to allowed unless the user explicitly turns it off.

**Data flow**: No input is needed. The function simply returns `Some(true)`, meaning the setting is present and enabled by default.

**Call relations**: The configuration reader uses this when `allow_login_shell` is missing from `config.toml`, so later command-running logic has a clear default instead of guessing.


##### `default_history`  (lines 74–76)

```
fn default_history() -> Option<History>
```

**Purpose**: Provides the default history-writing configuration. This lets Codex behave consistently even when the user has not added a history section.

**Data flow**: No input is needed. It creates a default `History` value, wraps it in `Some`, and returns it as the default setting.

**Call relations**: The config loading process calls this through the deserialization default system when the `history` field is absent.

*Call graph*: 1 external calls (default).


##### `default_project_doc_max_bytes`  (lines 78–80)

```
fn default_project_doc_max_bytes() -> Option<usize>
```

**Purpose**: Sets the default size limit for project instruction files such as `AGENTS.md`. This prevents Codex from reading an unexpectedly huge project document into the prompt.

**Data flow**: No input is needed. It returns the shared default byte limit, wrapped as an optional value.

**Call relations**: The config schema uses this default when `project_doc_max_bytes` is not written in the user's TOML file.


##### `default_project_doc_fallback_filenames`  (lines 82–84)

```
fn default_project_doc_fallback_filenames() -> Option<Vec<String>>
```

**Purpose**: Provides the default list of backup project-document filenames to try when the main one is missing. By default, that list is empty.

**Data flow**: No input is needed. It creates a new empty list and returns it inside `Some`.

**Call relations**: The config reader uses this during deserialization so the rest of Codex can treat the setting as known, even when the user did not configure any fallback names.

*Call graph*: 1 external calls (new).


##### `default_hide_agent_reasoning`  (lines 86–88)

```
fn default_hide_agent_reasoning() -> Option<bool>
```

**Purpose**: Defines whether agent reasoning messages should be hidden by default. The default is not to hide them.

**Data flow**: No input is needed. It returns `Some(false)`, meaning the option is present and disabled by default.

**Call relations**: The deserializer applies this when the user leaves out `hide_agent_reasoning`, giving UI and output code a stable default.


##### `default_true`  (lines 90–92)

```
fn default_true() -> bool
```

**Purpose**: Supplies a simple default value of `true` for settings that are enabled unless explicitly disabled. In this file it supports the experimental user-input tool setting.

**Data flow**: No input is needed. It returns the boolean value `true`.

**Call relations**: Serde, the Rust library that reads structured data, calls this as a default helper while loading nested configuration.


##### `ForcedChatgptWorkspaceIds::into_vec`  (lines 103–108)

```
fn into_vec(self) -> Vec<String>
```

**Purpose**: Turns the ChatGPT workspace restriction into a plain list of workspace IDs. This hides the difference between a user writing one string and a user writing a list.

**Data flow**: It receives a `ForcedChatgptWorkspaceIds` value. If it holds one string, it makes a one-item list; if it already holds many strings, it returns that list.

**Call relations**: Code that enforces login restrictions can call this after config loading and always work with a list, instead of handling two different shapes.

*Call graph*: 1 external calls (vec!).


##### `ForcedChatgptWorkspaceIds::deserialize`  (lines 112–133)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads the ChatGPT workspace restriction from TOML while supporting both the old single-string form and the newer list form. It deliberately rejects comma-separated strings because they look like multiple values but are not valid TOML lists.

**Data flow**: It receives raw TOML data from the deserializer. It tries to read either one string or a list of strings; a single string containing a comma becomes a clear error, while valid input becomes a `Single` or `Multiple` value.

**Call relations**: This runs automatically when `ConfigToml` is loaded. It hands back a normalized enum so later code can convert it to a list with `ForcedChatgptWorkspaceIds::into_vec`.

*Call graph*: 4 external calls (deserialize, Multiple, Single, custom).


##### `ProjectConfig::is_trusted`  (lines 558–560)

```
fn is_trusted(&self) -> bool
```

**Purpose**: Answers the simple question: has this project been marked as trusted? Trust matters because Codex may choose different default permissions for trusted and untrusted projects.

**Data flow**: It reads the project's optional trust level. It returns `true` only when that level is explicitly `Trusted`; otherwise it returns `false`.

**Call relations**: Permission-related code, including logic that chooses default built-in permission profiles, calls this when deciding how much access a project should receive.

*Call graph*: called by 1 (default_builtin_permission_profile_name); 1 external calls (matches!).


##### `ProjectConfig::is_untrusted`  (lines 562–564)

```
fn is_untrusted(&self) -> bool
```

**Purpose**: Answers the simple question: has this project been marked as untrusted? This helps Codex avoid assuming a project is safe when the user has marked it otherwise.

**Data flow**: It reads the project's optional trust level. It returns `true` only when that level is explicitly `Untrusted`; otherwise it returns `false`.

**Call relations**: Permission-related code uses this alongside `ProjectConfig::is_trusted` when choosing safe defaults for a project.

*Call graph*: called by 1 (default_builtin_permission_profile_name); 1 external calls (matches!).


##### `deserialize_optional_web_search_tool_config`  (lines 648–664)

```
fn deserialize_optional_web_search_tool_config(
    deserializer: D,
) -> Result<Option<WebSearchToolConfig>, D::Error>
```

**Purpose**: Reads the nested web search tool configuration while accepting an older simple on/off format. This keeps older config files from breaking while still supporting richer settings.

**Data flow**: It receives raw TOML data for `tools.web_search`. If the field is missing, it returns `None`; if the field is just a boolean, it ignores that old-style value and returns `None`; if it is a full config object, it returns that object.

**Call relations**: This is called automatically while loading `ToolsToml`, so the rest of Codex only sees the newer optional `WebSearchToolConfig` shape.

*Call graph*: 1 external calls (deserialize).


##### `ConfigToml::derive_permission_profile`  (lines 731–804)

```
async fn derive_permission_profile(
        &self,
        sandbox_mode_override: Option<SandboxMode>,
        windows_sandbox_level: WindowsSandboxLevel,
        active_project: Option<&ProjectConfig
```

**Purpose**: Converts older sandbox settings into the permission profile Codex actually uses to decide what files, network access, and system resources a session may touch. This is a safety-critical bridge between user configuration and runtime restrictions.

**Data flow**: It reads the config's sandbox settings, any direct sandbox override, the Windows sandbox level, the active project's trust setting, and any externally required permission constraint. It chooses a sandbox mode, adjusts it for Windows when needed, builds the matching permission profile, and may fall back to read-only if the default profile is not allowed.

**Call relations**: The main config-loading flow calls this after reading and layering settings. Tests also call it through legacy sandbox policy helpers to confirm old sandbox configuration still produces the expected permission profile.

*Call graph*: calls 3 internal fn (read_only, workspace_write, workspace_write_with); called by 2 (load_config_with_layer_stack, derive_legacy_sandbox_policy_for_test); 3 external calls (cfg!, matches!, warn!).


##### `ConfigToml::get_active_project`  (lines 809–833)

```
fn get_active_project(
        &self,
        resolved_cwd: &Path,
        repo_root: Option<&Path>,
    ) -> Option<ProjectConfig>
```

**Purpose**: Finds the project-specific configuration that matches the current working directory or its repository root. This lets Codex apply trust and project settings only when the user is actually inside that project.

**Data flow**: It receives the resolved current directory and an optional repository root. It looks up normalized versions of those paths in the configured `projects` map and returns the matching `ProjectConfig`, if any.

**Call relations**: The config loading pipeline calls this when building the effective session configuration. It relies on path-normalizing helpers so small path spelling differences do not stop a project match.

*Call graph*: calls 2 internal fn (normalized_project_lookup_keys, project_config_for_lookup_key); called by 1 (load_config_with_layer_stack).


##### `normalized_project_lookup_keys`  (lines 839–852)

```
fn normalized_project_lookup_keys(path: &Path) -> Vec<String>
```

**Purpose**: Builds the path strings Codex should try when looking up a project in the config file. It accounts for both the path as written and a normalized path used for fair comparison.

**Data flow**: It receives a filesystem path. It converts the path to a string, also asks a path utility for a normalized comparison form, normalizes both for the current operating system, and returns one or two lookup keys.

**Call relations**: Project lookup uses this inside `ConfigToml::get_active_project` before checking the user's `projects` table.

*Call graph*: calls 1 internal fn (normalize_project_lookup_key); called by 1 (get_active_project); 3 external calls (to_string_lossy, normalize_for_path_comparison, vec!).


##### `normalize_project_lookup_key`  (lines 854–860)

```
fn normalize_project_lookup_key(key: String) -> String
```

**Purpose**: Normalizes a project lookup key in the small way needed for the operating system. On Windows, path matching is case-insensitive, so keys are lowercased.

**Data flow**: It receives a path key as a string. On Windows it returns a lowercase version; on other systems it returns the string unchanged.

**Call relations**: Both project lookup key generation and fallback matching use this so configured project paths and real filesystem paths are compared consistently.

*Call graph*: called by 1 (normalized_project_lookup_keys); 1 external calls (cfg!).


##### `project_config_for_lookup_key`  (lines 862–878)

```
fn project_config_for_lookup_key(
    projects: &HashMap<String, ProjectConfig>,
    lookup_key: &str,
) -> Option<ProjectConfig>
```

**Purpose**: Looks up a project configuration by a prepared path key, with a fallback for case-normalized matches. This helps find the right project even if the user's configured path capitalization differs.

**Data flow**: It receives the whole project map and one lookup key. It first tries an exact match; if that fails, it compares normalized versions of all configured keys, sorts matches for stable behavior, and returns a cloned project config if one is found.

**Call relations**: This is the final lookup step used by `ConfigToml::get_active_project` after that function has prepared possible directory and repository-root keys.

*Call graph*: called by 1 (get_active_project).


##### `validate_reserved_model_provider_ids`  (lines 880–901)

```
fn validate_reserved_model_provider_ids(
    model_providers: &HashMap<String, ModelProviderInfo>,
) -> Result<(), String>
```

**Purpose**: Prevents users from redefining built-in model provider IDs such as OpenAI or local OSS providers. This avoids confusing or unsafe situations where a custom provider pretends to be a built-in one.

**Data flow**: It receives the configured model provider map. It collects any keys that conflict with reserved built-in IDs, except for the explicitly allowed Amazon Bedrock case, and returns either success or a clear error message.

**Call relations**: The broader provider validation step calls this first, before checking the details of each provider.

*Call graph*: called by 1 (validate_model_providers); 1 external calls (format!).


##### `validate_model_providers`  (lines 903–926)

```
fn validate_model_providers(
    model_providers: &HashMap<String, ModelProviderInfo>,
) -> Result<(), String>
```

**Purpose**: Checks that all custom model provider entries are valid before Codex uses them. This catches bad names, unsupported AWS settings, and provider-specific configuration errors early.

**Data flow**: It receives the map of provider IDs to provider definitions. It first rejects reserved IDs, then inspects each provider: Bedrock is treated specially, AWS settings are blocked elsewhere, empty names are rejected, and each provider's own validation is run.

**Call relations**: This runs both when the `model_providers` TOML section is deserialized and from the full config-loading pipeline, so invalid provider settings fail during startup instead of later during a model request.

*Call graph*: calls 1 internal fn (validate_reserved_model_provider_ids); called by 2 (deserialize_model_providers, load_config_with_layer_stack); 1 external calls (format!).


##### `deserialize_model_providers`  (lines 928–937)

```
fn deserialize_model_providers(
    deserializer: D,
) -> Result<HashMap<String, ModelProviderInfo>, D::Error>
```

**Purpose**: Reads the `model_providers` table from TOML and validates it immediately. This keeps bad provider configuration from entering the loaded `ConfigToml` value.

**Data flow**: It receives raw TOML provider data from the deserializer. It turns that into a map, runs `validate_model_providers`, converts any validation failure into a config-reading error, and returns the valid map.

**Call relations**: Serde calls this automatically for the `model_providers` field on `ConfigToml`; it hands clean provider data to the rest of the configuration system.

*Call graph*: calls 1 internal fn (validate_model_providers); 1 external calls (deserialize).


##### `validate_oss_provider`  (lines 939–953)

```
fn validate_oss_provider(provider: &str) -> std::io::Result<()>
```

**Purpose**: Checks that the selected local open-source model provider is one Codex still supports. It gives a special error for an old removed Ollama provider name.

**Data flow**: It receives the provider name as text. If it is `lmstudio` or the supported `ollama` provider, it returns success; if it is the removed legacy name or anything else, it returns an invalid-input error with an explanation.

**Call relations**: The code that sets the default OSS provider calls this before accepting the value, so unsupported local provider names are rejected early.

*Call graph*: called by 1 (set_default_oss_provider); 2 external calls (new, format!).


##### `tests::forced_chatgpt_workspace_id_accepts_single_string`  (lines 964–977)

```
fn forced_chatgpt_workspace_id_accepts_single_string()
```

**Purpose**: Tests that a single ChatGPT workspace ID written as one TOML string is accepted. This protects backward compatibility for users with older-style config.

**Data flow**: The test builds a tiny TOML string with one workspace ID, parses it as `ConfigToml`, converts the loaded value into a list, and checks that the list contains exactly that one ID.

**Call relations**: This test exercises the custom workspace ID deserializer and the `into_vec` conversion together.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::forced_chatgpt_workspace_id_accepts_string_list`  (lines 980–993)

```
fn forced_chatgpt_workspace_id_accepts_string_list()
```

**Purpose**: Tests that multiple ChatGPT workspace IDs written as a real TOML list are accepted. This confirms the intended multi-workspace format works.

**Data flow**: The test builds TOML containing two workspace IDs in a list, parses it into `ConfigToml`, converts the setting into a list, and checks that both IDs are preserved in order.

**Call relations**: This test covers the list branch of `ForcedChatgptWorkspaceIds::deserialize` and then verifies the normalized output from `into_vec`.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::forced_chatgpt_workspace_id_rejects_comma_separated_string`  (lines 996–1005)

```
fn forced_chatgpt_workspace_id_rejects_comma_separated_string()
```

**Purpose**: Tests that a comma-separated workspace ID string is rejected with a helpful message. This prevents a confusing format that looks like multiple IDs but is not a proper TOML list.

**Data flow**: The test builds TOML with two IDs inside one comma-containing string, tries to parse it, expects an error, and checks that the error tells the user to use a TOML list instead.

**Call relations**: This test guards the deliberate error path in `ForcedChatgptWorkspaceIds::deserialize`, making sure future changes do not silently accept the ambiguous format.

*Call graph*: 2 external calls (assert!, format!).


### `config/src/hook_config.rs`

`config` · `config load`

Hooks are user- or project-supplied actions that run at important moments, such as before a tool is used, after compaction, or when a session starts. This file is the map that says what those settings are allowed to look like. Without it, the program would not have a shared, reliable way to turn a TOML configuration file into Rust data it can use.

The main idea is simple: hook configuration is grouped by event. For example, the `PreToolUse` section contains groups of hooks that may run before a tool call. Each group can have an optional matcher, which is like a filter saying “only use these hooks for matching situations,” and then a list of hook handlers. A handler can be a shell command, a prompt-style hook, or an agent hook. Command hooks can also include a Windows-specific command, a timeout, whether they run asynchronously, and a status message.

The file also tracks per-hook state, such as whether a hook is enabled and a trusted hash, plus a separate managed-hooks form that can name a directory for hooks controlled by the system. Platform-specific behavior is kept small and clear: when asked for the managed directory, Windows uses the Windows path, while other systems use the normal path.

#### Function details

##### `HookEventsToml::is_empty`  (lines 58–81)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether there are no hook groups configured for any event. This is useful when the program wants to know if a hook section can be ignored because it contains nothing to run.

**Data flow**: It starts with one `HookEventsToml` value containing separate lists for each hook event. It checks each list in turn. It returns `true` only if every event list is empty; otherwise it returns `false`.

**Call relations**: This is a small inspection helper for code that has loaded hook configuration and needs to decide whether that configuration is blank. In this file, `ManagedHooksRequirementsToml::is_empty` relies on the same idea through its nested hook events.


##### `HookEventsToml::handler_count`  (lines 83–112)

```
fn handler_count(&self) -> usize
```

**Purpose**: Counts the total number of individual hook handlers across all events and matcher groups. This gives the program a quick “how many hooks are configured?” number.

**Data flow**: It receives all hook event lists. It walks through every event, then every matcher group inside each event, then adds up the number of handlers in those groups. The output is one number: the total handler count.

**Call relations**: This is the core counting helper for hook events. `ManagedHooksRequirementsToml::handler_count` calls it when managed-hook requirements need the same count without duplicating the counting rules.

*Call graph*: called by 1 (handler_count).


##### `HookEventsToml::into_matcher_groups`  (lines 114–127)

```
fn into_matcher_groups(self) -> [(HookEventName, Vec<MatcherGroup>); 10]
```

**Purpose**: Turns the event fields into a fixed list of event-name-and-hook-groups pairs. This makes it easier for later code to loop over all configured events in a uniform way.

**Data flow**: It takes ownership of a `HookEventsToml` value. It moves each event’s vector of matcher groups into an array paired with the matching `HookEventName`, such as `PreToolUse` or `SessionStart`. The result is that array, ready for iteration.

**Call relations**: `append_hook_events` calls this when it needs to add configured hooks into the runtime hook setup. Instead of treating each event field separately, that later step receives a neat list of event names paired with their groups.

*Call graph*: called by 1 (append_hook_events).


##### `ManagedHooksRequirementsToml::is_empty`  (lines 168–175)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a managed-hooks requirements block has no directory settings and no hook definitions. This tells the program whether there is anything meaningful to process.

**Data flow**: It reads the optional normal managed directory, the optional Windows managed directory, and the nested hook event configuration. It returns `true` only when both directories are missing and the hook events are also empty.

**Call relations**: This helper is used when code needs to decide whether a managed-hooks requirements section can be treated as absent. It combines directory checks with the hook-event emptiness check so callers do not have to remember all the pieces.


##### `ManagedHooksRequirementsToml::handler_count`  (lines 177–179)

```
fn handler_count(&self) -> usize
```

**Purpose**: Counts how many hook handlers are listed inside managed-hooks requirements. It is a convenience wrapper around the hook-event counter.

**Data flow**: It receives a managed-hooks requirements value and looks at its nested `hooks` field. It asks that hook configuration to count all handlers, then returns the resulting number unchanged.

**Call relations**: This function hands the real counting work to `HookEventsToml::handler_count`. It exists so callers working with managed-hooks requirements can ask for the count directly, without reaching into the nested field themselves.

*Call graph*: calls 1 internal fn (handler_count).


##### `ManagedHooksRequirementsToml::managed_dir_for_current_platform`  (lines 181–191)

```
fn managed_dir_for_current_platform(&self) -> Option<&Path>
```

**Purpose**: Returns the managed-hooks directory that applies to the operating system currently running the program. This avoids using a Unix-style path on Windows or a Windows-specific path elsewhere.

**Data flow**: It reads the stored directory options. On Windows, it returns the Windows managed directory if one is set. On non-Windows systems, it returns the regular managed directory if one is set. The output is an optional borrowed path, so no path is copied or changed.

**Call relations**: `managed_hooks_source_path` calls this when it needs to find where managed hooks should come from. This function supplies the platform choice, and the caller can then build or validate the actual source path from it.

*Call graph*: called by 1 (managed_hooks_source_path).


### `config/src/mcp_types.rs`

`config` · `config load`

MCP means Model Context Protocol, a way for Codex to talk to external tool servers. This file is the rulebook for those server settings. Without it, the program would not have one clear shape for MCP configuration, and mistakes like mixing command-based settings with HTTP-only settings could slip through until startup failed in confusing ways.

The file separates the user’s raw config from the cleaned-up config the rest of the app uses. RawMcpServerConfig accepts the fields that may appear in a TOML file. McpServerConfig is the validated result. The conversion decides which transport is being used: either stdio, meaning Codex starts a local command and talks through its standard input and output, or streamable HTTP, meaning Codex connects to a URL. It rejects fields that belong to the wrong transport, fills in defaults such as the local environment id, converts timeout numbers into Duration values, and enforces an important remote rule: a command-based server running outside the local environment must have an absolute working directory.

The file also defines smaller pieces: environment variables, OAuth login settings, per-tool approval choices, allow and deny lists for tools, and a user-facing reason for disabled servers. Think of it like an airport checklist: before a server is allowed onto the runway, this file confirms it has the right documents for the kind of trip it is taking.

#### Function details

##### `McpServerDisabledReason::fmt`  (lines 43–50)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns the reason an MCP server was disabled into a short message meant for people to read. This is used for command-line or text user interface output, where “requirements (source)” is clearer than an internal enum name.

**Data flow**: It receives a disabled-reason value and a formatter, which is the destination for display text. It chooses the right wording for the reason and writes that text into the formatter. The result is either success or a formatting error from the output machinery.

**Call relations**: This is called whenever Rust’s normal display formatting is used for McpServerDisabledReason. It does not call project code; it hands the final text to the standard formatting system.

*Call graph*: 1 external calls (write!).


##### `McpServerEnvVar::name`  (lines 74–79)

```
fn name(&self) -> &str
```

**Purpose**: Returns the environment variable name, no matter which supported config style was used. Someone can use this when they only care about the variable’s name and not where it should come from.

**Data flow**: It receives an McpServerEnvVar, which may be just a plain name or a small object containing a name and optional source. It extracts the name field from either shape. It returns borrowed text, so it does not copy or change the config.

**Call relations**: This is the basic accessor for environment variable names. McpServerEnvVar::as_ref uses it so the whole value can be treated like a string when other code asks for a string reference.

*Call graph*: called by 1 (as_ref).


##### `McpServerEnvVar::source`  (lines 81–86)

```
fn source(&self) -> Option<&str>
```

**Purpose**: Returns where an environment variable should be sourced from, if the config specified that. The source can distinguish local environment values from remote-provided values.

**Data flow**: It receives an environment variable config. If the config is only a name, there is no source, so it returns nothing. If the config includes a source field, it returns that source as borrowed text.

**Call relations**: This is the shared lookup used by McpServerEnvVar::is_remote_source and McpServerEnvVar::validate_source. Those functions build higher-level decisions on top of this small read-only check.

*Call graph*: called by 2 (is_remote_source, validate_source).


##### `McpServerEnvVar::is_remote_source`  (lines 88–90)

```
fn is_remote_source(&self) -> bool
```

**Purpose**: Answers the simple question: is this environment variable supposed to come from a remote source? This lets later setup code treat remote-sourced variables differently from local ones.

**Data flow**: It reads the source value through McpServerEnvVar::source. It compares that value with the word “remote”. It returns true only for that exact source, and false for local, missing, or any other value.

**Call relations**: This function sits on top of McpServerEnvVar::source. Code that needs a yes-or-no remote check can call this instead of repeating the string comparison itself.

*Call graph*: calls 1 internal fn (source).


##### `McpServerEnvVar::validate_source`  (lines 92–99)

```
fn validate_source(&self) -> Result<(), String>
```

**Purpose**: Checks that an environment variable source uses one of the accepted words. This gives users a clear config error instead of letting an unknown source silently behave incorrectly.

**Data flow**: It reads the optional source from the environment variable. Missing source, “local”, and “remote” are accepted. Any other text is turned into a helpful error message saying what values were expected.

**Call relations**: McpServerConfig::try_from calls this while validating command-based MCP server configuration. It relies on McpServerEnvVar::source for the raw value and returns an error upward if the config is invalid.

*Call graph*: calls 1 internal fn (source); 1 external calls (format!).


##### `McpServerEnvVar::from`  (lines 109–111)

```
fn from(value: &str) -> Self
```

**Purpose**: Creates an environment-variable config from plain text. This is a convenience path for code that has only a variable name and wants the standard simple form.

**Data flow**: It receives a string-like value containing an environment variable name. It wraps that name in the simple McpServerEnvVar::Name form. The output is a full McpServerEnvVar value with no explicit source.

**Call relations**: This supports Rust’s normal conversion style, so callers can turn plain text into an McpServerEnvVar without spelling out the enum variant directly. It produces the same simple shape that McpServerEnvVar::name later reads.

*Call graph*: 1 external calls (Name).


##### `McpServerEnvVar::as_ref`  (lines 115–117)

```
fn as_ref(&self) -> &str
```

**Purpose**: Lets an McpServerEnvVar be viewed as a string containing its name. This is useful when generic code expects something that can provide a string reference.

**Data flow**: It receives the environment variable config and asks McpServerEnvVar::name for the actual name inside it. It returns that borrowed name and does not alter the config.

**Call relations**: This is an adapter around McpServerEnvVar::name. It helps the type fit into standard Rust patterns that work with string-like values.

*Call graph*: calls 1 internal fn (name).


##### `McpServerConfig::is_local_environment`  (lines 195–197)

```
fn is_local_environment(&self) -> bool
```

**Purpose**: Checks whether this MCP server is assigned to the default local environment. Other parts of the program use this to decide whether local-only assumptions are safe.

**Data flow**: It reads the server’s environment_id field. It compares that value with the built-in default, “local”. It returns true for the local environment and false for any named non-local environment.

**Call relations**: This is called by environment binding, environment resolution, and serialization code when they need to treat local and non-local MCP servers differently. It does not perform setup itself; it gives those flows a clean yes-or-no answer.

*Call graph*: called by 4 (bind_environment_env_vars, resolve_server_environment, serialize_mcp_server, serialize_mcp_server_table).


##### `McpServerConfig::oauth_client_id`  (lines 199–203)

```
fn oauth_client_id(&self) -> Option<&str>
```

**Purpose**: Returns the OAuth client id for this server if one was configured. OAuth is the web-style login flow where a client identifies itself while asking for permission.

**Data flow**: It reads the optional OAuth settings from the server config. If those settings exist and include a client_id, it returns that id as borrowed text. If either layer is missing, it returns nothing.

**Call relations**: This is a small accessor for login-related code. Instead of making callers dig through nested optional fields, it gives them the client id directly when an MCP OAuth flow needs it.


##### `McpServerConfig::try_from`  (lines 276–380)

```
fn try_from(raw: RawMcpServerConfig) -> Result<Self, Self::Error>
```

**Purpose**: Converts loose raw MCP configuration into the strict, ready-to-use server configuration. This is where the file’s main validation happens, so bad combinations are rejected early with clear messages.

**Data flow**: It receives a RawMcpServerConfig that came from deserializing user config. It pulls out every field, converts startup timeouts into Duration values, decides whether the server is stdio or streamable HTTP, rejects fields that do not belong to that transport, validates environment-variable sources, fills in defaults, and checks remote working-directory rules. It returns a completed McpServerConfig on success or a readable error string on failure.

**Call relations**: McpServerConfig::deserialize hands raw config to this function after parsing. During the conversion it calls validate_remote_stdio_cwd for the remote-directory rule and standard duration constructors for timeout conversion. The validated config it returns is the form the rest of the application can safely use.

*Call graph*: calls 1 internal fn (validate_remote_stdio_cwd); 2 external calls (from_millis, try_from_secs_f64).


##### `McpServerConfig::deserialize`  (lines 384–391)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Teaches the config parser how to read an McpServerConfig from serialized data such as TOML or JSON. It deliberately parses through the raw shape first so validation is always applied.

**Data flow**: It receives a deserializer, which is the parser’s source of field values. It first builds a RawMcpServerConfig from that input, then converts it into McpServerConfig using the validation path. The output is either a valid server config or a parser-compatible error containing the validation message.

**Call relations**: This is the bridge between serde, the serialization library, and McpServerConfig::try_from. Whenever config loading asks serde for an McpServerConfig, this function ensures the raw input is checked before it reaches the rest of the program.

*Call graph*: 1 external calls (deserialize).


##### `default_enabled`  (lines 394–396)

```
fn default_enabled() -> bool
```

**Purpose**: Provides the default value for the enabled setting: MCP servers are on unless the config says otherwise. This keeps older or minimal configs working without requiring an explicit enabled flag.

**Data flow**: It takes no input. It always returns true. It does not read or change any state.

**Call relations**: Serde uses this as the default for the enabled field during config loading, and McpServerConfig::try_from also uses it when raw config omits the enabled value. It is the single source for that default choice.


##### `validate_remote_stdio_cwd`  (lines 398–420)

```
fn validate_remote_stdio_cwd(
    transport: &McpServerTransportConfig,
    environment_id: &str,
) -> Result<(), String>
```

**Purpose**: Enforces a safety rule for command-based MCP servers running in a non-local environment: they must have an absolute working directory. An absolute path avoids ambiguity about where the command should start.

**Data flow**: It receives the chosen transport and the server’s environment id. If the environment is local, it accepts the config. If the transport is not stdio, it also accepts it. For remote stdio servers, it requires a cwd value and checks that the path is absolute; otherwise it returns a clear error message.

**Call relations**: McpServerConfig::try_from calls this after it has chosen the transport and filled in the environment id. This function is the focused checker for one important rule, and it sends any failure back to the main conversion step.

*Call graph*: called by 1 (try_from); 1 external calls (format!).


##### `option_duration_secs::serialize`  (lines 460–468)

```
fn serialize(value: &Option<Duration>, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Writes an optional Duration as seconds when saving or exporting config. This keeps human-facing config values as simple numbers instead of Rust’s internal time type.

**Data flow**: It receives an optional Duration and a serializer, which is the output writer. If there is a duration, it converts it to a floating-point number of seconds and serializes that. If there is no duration, it writes a missing/null value according to the serializer’s rules.

**Call relations**: Serde calls this for fields marked to use option_duration_secs. It hands the final value to the serializer’s standard serialize_some or serialize_none behavior.

*Call graph*: 2 external calls (serialize_none, serialize_some).


##### `option_duration_secs::deserialize`  (lines 470–477)

```
fn deserialize(deserializer: D) -> Result<Option<Duration>, D::Error>
```

**Purpose**: Reads an optional number of seconds from config and turns it into a Duration. This lets users write timeouts as simple values like 2.5 while the program uses a proper time object internally.

**Data flow**: It receives a deserializer and asks it for an optional floating-point number. If no number is present, it returns no duration. If a number is present, it tries to convert that many seconds into a Duration and returns an error if the number is invalid.

**Call relations**: Serde calls this for timeout fields that use seconds-based config. Its output feeds into raw or final MCP server config loading, so later code can work with Duration values instead of raw numbers.

*Call graph*: 1 external calls (deserialize).


### `config/src/profile_toml.rs`

`data_model` · `config load`

This file is a shape definition for profile-based configuration. In plain terms, it tells the program, “Here are the fields a user is allowed to put inside a named profile in the config file, and here is the kind of value each field must have.” Without this file, the project would not have a clear contract for profile settings, so loading, checking, saving, or documenting profile configuration would be much more error-prone.

The main type is `ConfigProfile`. It is mostly a collection of optional settings. Optional means a profile can override only the pieces it cares about, while the rest can come from defaults or broader configuration. For example, one profile might choose a faster model and stricter approval rules, while another might enable web search and a different sandbox mode.

The file also defines `ProfileTui`, a smaller group of terminal user interface settings that apply only inside a profile. Right now it contains the preferred view mode for picking resumed or forked sessions.

The derived traits make these structures usable by the configuration system: they can be read from TOML through Serde, written back out, compared, cloned, and turned into JSON Schema. JSON Schema is a machine-readable description of allowed config fields, useful for validation and editor help. Some fields are marked deprecated and skipped from the schema, meaning old configs may still deserialize them, but users should not see them advertised.


### `config/src/tui_keymap.rs`

`config` · `config load`

This file is the rulebook for the `[tui.keymap]` section of the user’s `~/.codex/config.toml` file. Without it, users could write shortcuts in many different ways, misspell action names without noticing, or create key strings that the terminal UI cannot reliably understand.

The file first defines the shape of the keymap config. It groups shortcuts by where they apply: global actions, chat actions, composer actions, text editor actions, Vim-style editing actions, pager scrolling, list selection, and approval prompts. Each action can be missing, bound to one key, or bound to several keys. An explicitly empty list is meaningful too: it says “unbind this action here” rather than “use the default.”

The second important job is key normalization. A user might write `Control-A`, `ctrl-a`, or use aliases like `escape` instead of `esc`. The normalizer trims spaces, lowercases text, accepts a small set of friendly aliases, orders modifiers as `ctrl-alt-shift-key`, and rejects unclear input early with readable error messages. This is like checking and rewriting mailing addresses before delivery, so later code does not have to guess whether two spellings mean the same place.

The file deliberately does not decide which shortcut wins at runtime or whether two actions conflict. It only defines and validates the saved configuration format.

#### Function details

##### `KeybindingSpec::as_str`  (lines 43–45)

```
fn as_str(&self) -> &str
```

**Purpose**: This returns the saved, normalized keybinding text, such as `ctrl-a`, as a plain string slice. Other code uses it when it needs to read the key without taking ownership of the stored value.

**Data flow**: It starts with a `KeybindingSpec`, which wraps one canonical key string. It borrows that inner string and returns it as `&str`, without changing anything.

**Call relations**: This is a small access point for code that consumes keybinding specs after configuration has already been parsed and normalized. It does not call other helpers; it simply exposes the already-clean value.


##### `KeybindingSpec::deserialize`  (lines 49–56)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: This teaches the config loader how to read one keybinding from the config file. It accepts a raw string from TOML, normalizes it, and turns bad input into a user-facing parse error.

**Data flow**: A deserializer supplies the raw text value from the config file. The function reads it as a string, sends it through `normalize_keybinding_spec`, and, if that succeeds, wraps the normalized result in `KeybindingSpec`. If normalization fails, the error message becomes the config parsing error.

**Call relations**: This is called automatically by Serde, the Rust serialization/deserialization library, whenever a `KeybindingSpec` appears in the keymap config. It hands the actual cleanup and validation work to `normalize_keybinding_spec`, so the rest of the system receives only canonical key names.

*Call graph*: calls 1 internal fn (normalize_keybinding_spec); 1 external calls (deserialize).


##### `KeybindingsSpec::specs`  (lines 81–86)

```
fn specs(&self) -> Vec<&KeybindingSpec>
```

**Purpose**: This gives callers a uniform list of keybindings for one action, whether the user configured one key or many keys. It lets later code avoid caring about the two config spellings.

**Data flow**: It receives a `KeybindingsSpec`, which is either `One` key or `Many` keys. It returns a vector of borrowed `KeybindingSpec` references in the same order the user declared them.

**Call relations**: Runtime keymap-building code, including `parse_bindings`, calls this when turning config data into actual key lookup tables. The order matters because the first key can be shown as the main shortcut hint in the user interface.

*Call graph*: called by 1 (parse_bindings); 1 external calls (vec!).


##### `normalize_keybinding_spec`  (lines 436–511)

```
fn normalize_keybinding_spec(raw: &str) -> Result<String, String>
```

**Purpose**: This is the main cleanup and validation function for one user-written keybinding. It turns accepted variants into one standard spelling and rejects empty, malformed, duplicated, or ambiguous shortcuts.

**Data flow**: It takes raw text such as `Control-Shift-Enter`. It trims whitespace, lowercases it, splits it into dash-separated parts, recognizes modifiers like `ctrl`, `alt`, and `shift`, checks that modifiers come before the key, and sends the final key name to `normalize_key_name`. It returns a canonical string such as `ctrl-shift-enter`, or a clear error explaining what is wrong.

**Call relations**: The custom deserializer for `KeybindingSpec` calls this during config loading. It delegates key-name-specific rules to `normalize_key_name`, then assembles the final keybinding in a fixed modifier order so comparisons, UI hints, and duplicate checks later in the program do not have to deal with multiple spellings.

*Call graph*: calls 1 internal fn (normalize_key_name); called by 1 (deserialize); 3 external calls (from, new, format!).


##### `normalize_key_name`  (lines 517–569)

```
fn normalize_key_name(key: &str, original: &str) -> Result<String, String>
```

**Purpose**: This checks and standardizes the actual key part of a shortcut, after any modifiers have been separated. It accepts ordinary printable characters, known special keys, and function keys up to `f24`.

**Data flow**: It receives a key name like `escape`, `pageup`, `a`, or `f12`, plus the original full keybinding for error messages. It maps supported aliases to canonical names, verifies the result is in the allowed key vocabulary, and returns the accepted key name. If the key is unknown or unsupported, it returns a helpful error listing valid choices.

**Call relations**: `normalize_keybinding_spec` calls this once it has separated modifier keys from the main key. This function is the narrow gate that keeps runtime key parsing predictable across different terminals and platforms.

*Call graph*: called by 1 (normalize_keybinding_spec); 2 external calls (format!, matches!).


##### `tests::misplaced_action_at_keymap_root_is_rejected`  (lines 577–589)

```
fn misplaced_action_at_keymap_root_is_rejected()
```

**Purpose**: This test confirms that an action placed directly under `[tui.keymap]` is rejected. Users must put actions inside a context such as `[tui.keymap.global]`, so mistakes should not be silently ignored.

**Data flow**: It builds a small TOML snippet with `open_transcript` at the wrong level. It tries to parse that snippet as a `TuiKeymap` and checks that parsing fails.

**Call relations**: This protects the unknown-field rejection rules on the root keymap structure. If a future change accidentally allowed misplaced actions, this test would fail and point out that bad config is no longer being caught.

*Call graph*: 1 external calls (assert!).


##### `tests::misspelled_action_under_context_is_rejected`  (lines 592–603)

```
fn misspelled_action_under_context_is_rejected()
```

**Purpose**: This test makes sure a misspelled action name inside a valid context is treated as an error. That prevents users from thinking they changed a shortcut when the program actually ignored it.

**Data flow**: It creates TOML with `[global]` and a misspelled `open_transcrip` field. It parses the config, expects an error, and checks that the error text mentions the misspelled name.

**Call relations**: This verifies the `deny_unknown_fields` behavior for context structs such as the global keymap. It supports the file’s larger promise that bad keymap configuration fails early and visibly.

*Call graph*: 1 external calls (assert!).


##### `tests::misspelled_vim_text_object_action_is_rejected`  (lines 606–617)

```
fn misspelled_vim_text_object_action_is_rejected()
```

**Purpose**: This test checks that misspelled Vim text-object actions are rejected too. It covers a more specialized keymap section where names like quote-related text objects can be easy to mistype.

**Data flow**: It creates TOML with `[vim_text_object]` and the invalid field `double_quotes`. It attempts to parse it as a `TuiKeymap`, expects failure, and checks that the error includes the bad field name.

**Call relations**: This guards the Vim text-object config schema in the same way other tests guard global and context schemas. It helps ensure all keymap sections reject unknown action names consistently.

*Call graph*: 1 external calls (assert!).


##### `tests::removed_backtrack_actions_are_rejected`  (lines 620–643)

```
fn removed_backtrack_actions_are_rejected()
```

**Purpose**: This test confirms that old, removed action names are no longer accepted in any of the listed contexts. That matters because silently accepting obsolete settings would mislead users and could hide configuration drift.

**Data flow**: It loops through several context-and-action pairs that used to exist or should not be valid. For each pair, it builds TOML, tries to parse it, expects an error, and checks that the error names the rejected action.

**Call relations**: This test relies on the schema’s unknown-field rejection. It acts as a safety net against accidentally reintroducing or silently tolerating removed backtracking-related keymap actions.

*Call graph*: 2 external calls (assert!, format!).


##### `tests::action_under_global_context_is_accepted`  (lines 646–653)

```
fn action_under_global_context_is_accepted()
```

**Purpose**: This test proves that a correctly placed global action is accepted. It is the positive counterpart to tests that reject misplaced or misspelled fields.

**Data flow**: It builds TOML with `[global]` and a valid `open_transcript = "ctrl-s"` binding. It parses the config and checks that the resulting `global.open_transcript` field is present.

**Call relations**: This confirms that strict validation is not too strict: valid user configuration still loads. It exercises the normal deserialization path for a simple global keybinding.

*Call graph*: 2 external calls (assert!, from_str).


##### `tests::minus_bindings_under_global_context_are_accepted`  (lines 656–679)

```
fn minus_bindings_under_global_context_are_accepted()
```

**Purpose**: This test ensures the key named `minus` is a valid shortcut, both by itself and with a modifier like `alt-minus`. This is important because a literal dash is also used as the separator inside keybinding strings.

**Data flow**: It tries two TOML snippets, one binding `minus` and one binding `alt-minus`. Each snippet is parsed into a `TuiKeymap`, and the result is compared with the exact expected normalized structure.

**Call relations**: This test protects the distinction between the separator character `-` and the key name `minus`. It indirectly exercises deserialization, `normalize_keybinding_spec`, and `normalize_key_name` through normal config parsing.

*Call graph*: 5 external calls (assert_eq!, One, default, format!, from_str).


##### `tests::function_keys_through_f24_are_accepted`  (lines 682–686)

```
fn function_keys_through_f24_are_accepted()
```

**Purpose**: This test checks the supported range for function keys. The configuration accepts portable function keys from `f1` through `f24` and rejects higher ones.

**Data flow**: It calls `normalize_keybinding_spec` directly with `F13`, `f24`, and `f25`. It checks that the first two normalize successfully and that `f25` returns an error.

**Call relations**: This test focuses on the function-key rule enforced by `normalize_key_name` and the `MAX_FUNCTION_KEY` limit. It helps keep the documented supported range and the actual parser behavior aligned.

*Call graph*: 2 external calls (assert!, assert_eq!).


### `core/src/config/schema.rs`

`config` · `config validation and test builds`

This is a very small bridge file. The real work of building and writing the configuration schema is not implemented here; it is imported from `codex_config::schema`. A configuration schema is a machine-readable description of what settings are allowed, much like a form that says which fields exist and what kind of values they accept.

The file brings three schema helpers into scope: one to make schema output consistent, one to produce the schema as JSON, and one to write that schema somewhere. It also attaches a test module, but only when the code is being compiled for tests. That means normal application builds do not include the test code.

Without this file, the core crate would not have this local place to exercise or validate the shared configuration-schema behavior. Think of it as a small signpost: it points core configuration tests toward the shared schema machinery, instead of duplicating that machinery here.


### `exec-server/src/environment_toml.rs`

`config` · `config load and environment snapshot creation`

The project can run work in different “environments”: the local machine, a remote exec server reached over a WebSocket connection, or a command started through standard input/output, such as `ssh`. This file is the bridge between a human-written config file and the internal objects the rest of the system uses.

It looks for `environments.toml` inside the Codex home directory. If the file is missing, it uses the normal default provider, so existing behavior keeps working. If the file exists, it reads and parses it, rejects unknown or unsafe fields, checks that each environment has a clean unique name, and makes sure each entry describes exactly one way to connect: either a WebSocket URL or a program command.

It also decides whether the built-in local environment should be available and what the default environment should be. The special default value `none` means “do not choose one automatically.” Relative working directories for command-based environments are resolved from the config directory, much like a map giving directions relative to the place where the map itself is stored.

The tests in this file document the important edge cases: duplicate names, malformed URLs, invalid defaults, timeout parsing, and missing config files.

#### Function details

##### `TomlEnvironmentProvider::new`  (lines 60–62)

```
fn new(config: EnvironmentsToml) -> Result<Self, ExecServerError>
```

**Purpose**: Creates a TOML-backed environment provider from an already parsed config, mainly for tests. It is the simple version that does not know where the config file lived on disk.

**Data flow**: It receives an `EnvironmentsToml` value. It passes that config onward with no config directory, so relative working directories are not allowed. It returns either a ready provider or a clear configuration error.

**Call relations**: The test suite calls this helper when it wants to build providers directly from in-memory config. It immediately hands the real work to `TomlEnvironmentProvider::new_with_config_dir`.

*Call graph*: called by 13 (toml_provider_can_disable_local_environment, toml_provider_default_none_disables_default, toml_provider_default_omitted_selects_local, toml_provider_includes_local_and_adds_configured_environments, toml_provider_parses_configured_transport_timeouts, toml_provider_rejects_duplicate_ids, toml_provider_rejects_invalid_environments, toml_provider_rejects_local_default_when_local_is_disabled, toml_provider_rejects_malformed_websocket_url, toml_provider_rejects_overlong_id (+3 more)); 1 external calls (new_with_config_dir).


##### `TomlEnvironmentProvider::new_with_config_dir`  (lines 64–94)

```
fn new_with_config_dir(
        config: EnvironmentsToml,
        config_dir: Option<&Path>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds the actual provider from parsed TOML and, when available, the directory that contained the config file. It checks for duplicate names, parses each environment, and chooses the default.

**Data flow**: It receives the parsed config and an optional config directory. It records whether local execution is included, parses each configured environment into transport settings, rejects duplicate IDs, then normalizes the default choice. It returns a `TomlEnvironmentProvider` ready to produce snapshots.

**Call relations**: `environment_provider_from_codex_home` uses this after reading `environments.toml`; one test also uses it directly to check relative directory handling. Inside, it calls `parse_environment_toml` for each environment and `normalize_default_environment_id` after all valid IDs are known.

*Call graph*: calls 2 internal fn (normalize_default_environment_id, parse_environment_toml); called by 2 (environment_provider_from_codex_home, toml_provider_resolves_relative_stdio_cwd_from_config_dir); 4 external calls (new, with_capacity, Protocol, format!).


##### `TomlEnvironmentProvider::snapshot`  (lines 117–119)

```
fn snapshot(&self) -> EnvironmentProviderFuture<'_>
```

**Purpose**: Produces the current list of configured environments in the standard provider format. A snapshot is a point-in-time view that other code can use without knowing the config file format.

**Data flow**: It reads the provider’s stored environment IDs, transport settings, default choice, and local-inclusion flag. For each remote entry, it builds an `Environment` using the saved transport details. It returns an `EnvironmentProviderSnapshot` containing those environments and policy choices.

**Call relations**: Code using the `EnvironmentProvider` trait calls this when it needs to know what environments are available. The trait-facing method boxes the asynchronous work, and the snapshot creation hands each transport description to `Environment::remote_with_transport`.

*Call graph*: calls 1 internal fn (remote_with_transport); 3 external calls (pin, with_capacity, clone).


##### `parse_environment_toml`  (lines 122–187)

```
fn parse_environment_toml(
    item: EnvironmentToml,
    config_dir: Option<&Path>,
) -> Result<(String, ExecServerTransportParams), ExecServerError>
```

**Purpose**: Turns one `[[environments]]` entry from the TOML file into connection settings the exec server can use. It enforces the rule that an environment is either a WebSocket target or a command to run, not both.

**Data flow**: It receives one parsed environment item and an optional config directory. It validates the ID, checks field combinations, applies default timeouts, validates WebSocket URLs, trims command names, and resolves command working directories. It returns the environment ID paired with transport parameters, or an error explaining what is wrong.

**Call relations**: `TomlEnvironmentProvider::new_with_config_dir` calls this once per configured environment. It delegates name checks to `validate_environment_id`, URL checks to `validate_websocket_url`, and command working-directory rules to `normalize_stdio_cwd`.

*Call graph*: calls 3 internal fn (normalize_stdio_cwd, validate_environment_id, validate_websocket_url); called by 1 (new_with_config_dir); 2 external calls (Protocol, format!).


##### `normalize_stdio_cwd`  (lines 189–206)

```
fn normalize_stdio_cwd(
    id: &str,
    cwd: Option<PathBuf>,
    config_dir: Option<&Path>,
) -> Result<Option<PathBuf>, ExecServerError>
```

**Purpose**: Makes the working directory for a command-based environment unambiguous. Relative paths are accepted only when they can be interpreted relative to the config file directory.

**Data flow**: It receives an environment ID, an optional working directory, and an optional config directory. If there is no working directory, it returns none. If the path is absolute, it returns it unchanged. If it is relative and a config directory is known, it joins them; otherwise it returns an error.

**Call relations**: `parse_environment_toml` calls this only for environments that start a program over standard input/output. It gives back the final directory that will be stored inside the `StdioExecServerCommand`.

*Call graph*: called by 1 (parse_environment_toml); 2 external calls (Protocol, format!).


##### `environment_provider_from_codex_home`  (lines 208–226)

```
fn environment_provider_from_codex_home(
    codex_home: &Path,
) -> Result<Box<dyn EnvironmentProvider>, ExecServerError>
```

**Purpose**: Chooses the right environment provider for a given Codex home directory. It uses `environments.toml` when present and falls back to environment-variable defaults when absent.

**Data flow**: It receives the Codex home path. It checks for `environments.toml`; if the file is missing, it returns `DefaultEnvironmentProvider::from_env()`. If present, it loads the file and builds a `TomlEnvironmentProvider` using the Codex home as the config directory.

**Call relations**: Higher-level setup code, including `from_codex_home`, calls this during provider selection. It calls `load_environments_toml` to read the file and `TomlEnvironmentProvider::new_with_config_dir` to validate and build the TOML-backed provider.

*Call graph*: calls 3 internal fn (from_env, new_with_config_dir, load_environments_toml); called by 3 (from_codex_home, environment_provider_from_codex_home_falls_back_when_file_is_missing, environment_provider_from_codex_home_uses_present_environments_file); 2 external calls (new, join).


##### `normalize_default_environment_id`  (lines 228–257)

```
fn normalize_default_environment_id(
    default: Option<&str>,
    include_local: bool,
    ids: &HashSet<String>,
) -> Result<EnvironmentDefault, ExecServerError>
```

**Purpose**: Decides what the default environment should be after all available IDs are known. It turns missing values, explicit names, and the special word `none` into a clear internal choice.

**Data flow**: It receives an optional default string, whether local execution is included, and the set of configured IDs. If no default is set, it chooses local when local is included, otherwise disables the default. If a default is set, it trims it, rejects empty or unknown names, treats `none` as disabled, and otherwise returns that environment ID.

**Call relations**: `TomlEnvironmentProvider::new_with_config_dir` calls this after collecting all valid environment names. That timing matters because it can reject a default that points to an environment that was never configured.

*Call graph*: called by 1 (new_with_config_dir); 3 external calls (Protocol, EnvironmentId, format!).


##### `validate_environment_id`  (lines 259–290)

```
fn validate_environment_id(id: &str) -> Result<(), ExecServerError>
```

**Purpose**: Checks that an environment name is safe, readable, and not reserved. This prevents confusing names such as blank strings, names with hidden spaces, or names that collide with built-in meanings.

**Data flow**: It receives a string ID. It checks for emptiness, surrounding whitespace, reserved words like `local` and `none`, excessive length, and characters outside ASCII letters, numbers, hyphen, and underscore. It returns success or a specific configuration error.

**Call relations**: `parse_environment_toml` calls this before accepting any environment entry. If it fails, provider construction stops before the bad ID can be stored or used as a default.

*Call graph*: called by 1 (parse_environment_toml); 2 external calls (Protocol, format!).


##### `validate_websocket_url`  (lines 292–308)

```
fn validate_websocket_url(url: String) -> Result<String, ExecServerError>
```

**Purpose**: Checks that a configured remote URL is a usable WebSocket address. A WebSocket is a persistent network connection used here to talk to a remote exec server.

**Data flow**: It receives the URL string, trims surrounding whitespace, rejects empty values, requires `ws://` or secure `wss://`, and asks the WebSocket library to parse it as a client request. It returns the cleaned URL string or an error.

**Call relations**: `parse_environment_toml` calls this for entries that use `url` instead of `program`. The validated URL becomes part of `ExecServerTransportParams::WebSocketUrl`.

*Call graph*: called by 1 (parse_environment_toml); 2 external calls (Protocol, format!).


##### `load_environments_toml`  (lines 310–324)

```
fn load_environments_toml(path: &Path) -> Result<EnvironmentsToml, ExecServerError>
```

**Purpose**: Reads an `environments.toml` file from disk and parses it into Rust data structures. It is the file I/O doorway for this configuration format.

**Data flow**: It receives a file path. It reads the whole file as text, then parses that text as TOML into `EnvironmentsToml`. It returns the parsed config or an error that includes the file path and the read or parse problem.

**Call relations**: `environment_provider_from_codex_home` calls this when the config file exists. Tests also call it directly to verify successful parsing and rejection of unknown fields.

*Call graph*: called by 3 (environment_provider_from_codex_home, load_environments_toml_reads_root_environment_list, load_environments_toml_rejects_unknown_fields); 2 external calls (read_to_string, from_str).


##### `option_duration_secs::deserialize`  (lines 332–339)

```
fn deserialize(deserializer: D) -> Result<Option<Duration>, D::Error>
```

**Purpose**: Teaches the TOML parser how to read optional timeout values written as seconds. It supports fractional seconds while storing them as a `Duration`, Rust’s standard time-span type.

**Data flow**: It receives a Serde deserializer, reads an optional floating-point number, and converts that number of seconds into a `Duration`. It returns `None` if the field was missing, a duration if valid, or a parse error if the number cannot represent a duration.

**Call relations**: Serde, the serialization library, calls this automatically for `connect_timeout_sec` and `initialize_timeout_sec`. The parsed durations are later consumed by `parse_environment_toml` when it builds transport parameters.

*Call graph*: 1 external calls (deserialize).


##### `tests::toml_provider_includes_local_and_adds_configured_environments`  (lines 350–402)

```
async fn toml_provider_includes_local_and_adds_configured_environments()
```

**Purpose**: Checks the happy path where local execution is included by default and two remote environments are configured. It confirms both WebSocket and command-based entries are accepted.

**Data flow**: The test builds an in-memory config with a WebSocket environment and an SSH-style command environment. It creates a provider, asks for a snapshot, and compares the IDs, default choice, local flag, and connection details against expected values.

**Call relations**: This test calls `TomlEnvironmentProvider::new`, which flows into the normal parsing path. It then uses the provider snapshot to prove that valid TOML-style settings become usable environment objects.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::toml_provider_default_omitted_selects_local`  (lines 405–414)

```
async fn toml_provider_default_omitted_selects_local()
```

**Purpose**: Verifies that when no default is named and local execution is allowed, the provider chooses local as the default. This preserves the simplest out-of-the-box behavior.

**Data flow**: The test creates an empty config, builds a provider, and asks for a snapshot. It checks that local inclusion is true and that the default points to the local environment ID.

**Call relations**: It calls `TomlEnvironmentProvider::new`, exercising the missing-default branch inside `normalize_default_environment_id`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, default).


##### `tests::toml_provider_default_none_disables_default`  (lines 417–428)

```
async fn toml_provider_default_none_disables_default()
```

**Purpose**: Checks that the special default value `none` means no automatic environment should be selected. This lets users require an explicit choice.

**Data flow**: The test creates a config with `default` set to `none`, builds the provider, and reads the snapshot. It expects local execution to still be available but the default to be disabled.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which eventually calls `normalize_default_environment_id` and proves that `none` is treated specially.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::toml_provider_can_disable_local_environment`  (lines 431–449)

```
async fn toml_provider_can_disable_local_environment()
```

**Purpose**: Verifies that users can remove the built-in local environment and use a configured remote environment as the default. This matters for setups that must run only remotely.

**Data flow**: The test builds a config with `include_local = false`, one command-based environment, and that environment as default. After creating a provider and snapshot, it checks that local is disabled and the named remote default is used.

**Call relations**: It calls `TomlEnvironmentProvider::new`, exercising both local exclusion and default-name validation in the provider construction path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::toml_provider_without_local_and_default_omitted_disables_default`  (lines 452–462)

```
async fn toml_provider_without_local_and_default_omitted_disables_default()
```

**Purpose**: Checks the case where local execution is disabled and no default is provided. The expected result is no default, because there is no safe automatic local fallback.

**Data flow**: The test creates a config that only sets `include_local` to false. It builds a provider, gets a snapshot, and verifies that local is not included and the default is disabled.

**Call relations**: It calls `TomlEnvironmentProvider::new`, covering the missing-default branch of `normalize_default_environment_id` when local is unavailable.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert!, assert_eq!).


##### `tests::toml_provider_rejects_local_default_when_local_is_disabled`  (lines 465–477)

```
fn toml_provider_rejects_local_default_when_local_is_disabled()
```

**Purpose**: Confirms that `local` cannot be selected as the default after local execution has been disabled. This catches a contradictory config early.

**Data flow**: The test creates a config with `include_local = false` but `default = local`. Provider creation is expected to fail, and the test compares the error text to the intended message.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which reaches `normalize_default_environment_id` and rejects a default that is not in the allowed ID set.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `tests::toml_provider_rejects_invalid_environments`  (lines 480–563)

```
fn toml_provider_rejects_invalid_environments()
```

**Purpose**: Covers several invalid single-environment configs to make sure users get clear errors. It checks reserved IDs, bad spacing, invalid characters, wrong URL schemes, mixed connection types, empty programs, and misplaced fields.

**Data flow**: The test loops through a table of bad `EnvironmentToml` values and expected messages. For each one, it tries to build a provider and confirms the resulting error matches the expected reason.

**Call relations**: It repeatedly calls `TomlEnvironmentProvider::new`, which drives each bad entry through `parse_environment_toml`, `validate_environment_id`, `validate_websocket_url`, and related checks.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, from_secs, new, assert_eq!, vec!).


##### `tests::toml_provider_resolves_relative_stdio_cwd_from_config_dir`  (lines 566–603)

```
fn toml_provider_resolves_relative_stdio_cwd_from_config_dir()
```

**Purpose**: Verifies that a relative working directory for a command-based environment is resolved from the config directory. This makes relative paths useful and predictable when they come from a real file location.

**Data flow**: The test creates a temporary directory, builds a config with `cwd = workspace`, and calls the constructor that knows the config directory. It then inspects the stored command and checks that the working directory became `<config_dir>/workspace`.

**Call relations**: It calls `TomlEnvironmentProvider::new_with_config_dir`, which calls `parse_environment_toml` and then `normalize_stdio_cwd` for the relative path.

*Call graph*: calls 1 internal fn (new_with_config_dir); 4 external calls (assert_eq!, panic!, tempdir, vec!).


##### `tests::toml_provider_parses_configured_transport_timeouts`  (lines 606–657)

```
fn toml_provider_parses_configured_transport_timeouts()
```

**Purpose**: Checks that custom connection and initialization timeouts are carried into transport settings. Timeouts control how long the system waits before deciding a remote setup is not responding.

**Data flow**: The test builds one WebSocket environment with both timeout values and one command environment with an initialization timeout. It creates the provider and inspects the stored transport parameters to make sure the durations match.

**Call relations**: It calls `TomlEnvironmentProvider::new`, exercising `parse_environment_toml` for both WebSocket and standard-input/output command transports.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::toml_provider_rejects_relative_stdio_cwd_without_config_dir`  (lines 660–677)

```
fn toml_provider_rejects_relative_stdio_cwd_without_config_dir()
```

**Purpose**: Confirms that relative working directories are rejected when there is no config directory to resolve them against. This avoids silently interpreting a path from the wrong place.

**Data flow**: The test builds an in-memory command environment with a relative `cwd` and uses the constructor without a config directory. It expects provider creation to fail with a message saying the path must be absolute.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which passes no config directory into `parse_environment_toml`; `normalize_stdio_cwd` then rejects the relative path.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::toml_provider_rejects_duplicate_ids`  (lines 680–703)

```
fn toml_provider_rejects_duplicate_ids()
```

**Purpose**: Verifies that two configured environments cannot share the same ID. Unique names are needed so defaults and user selections are unambiguous.

**Data flow**: The test creates two environments both named `devbox`, one URL-based and one command-based. Provider creation is expected to fail with a duplicate-ID error.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which reaches the duplicate tracking inside `TomlEnvironmentProvider::new_with_config_dir` after each entry is parsed.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::toml_provider_rejects_overlong_id`  (lines 706–725)

```
fn toml_provider_rejects_overlong_id()
```

**Purpose**: Checks that environment IDs longer than the allowed limit are rejected. This keeps names compact and avoids awkward or abusive identifiers.

**Data flow**: The test creates an ID one character longer than the maximum and uses it in a WebSocket environment. It tries to build a provider and checks that the error reports the length rule.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which sends the ID through `validate_environment_id` from inside `parse_environment_toml`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::toml_provider_rejects_unknown_default`  (lines 728–740)

```
fn toml_provider_rejects_unknown_default()
```

**Purpose**: Confirms that the default must name an environment that actually exists, unless it is the special value `none`. This prevents a config from pointing at nowhere.

**Data flow**: The test creates a config with `default = missing` and no environments. Provider creation is expected to fail with an unknown-default error.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which calls `normalize_default_environment_id` after collecting the available ID set.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `tests::load_environments_toml_reads_root_environment_list`  (lines 743–801)

```
fn load_environments_toml_reads_root_environment_list()
```

**Purpose**: Tests that a realistic `environments.toml` file is read and parsed correctly. It covers top-level defaults, local inclusion, multiple environments, timeouts, command arguments, environment variables, and working directory.

**Data flow**: The test writes TOML text to a temporary file, calls `load_environments_toml`, and compares the parsed structure against expected Rust values. Successful parsing proves the on-disk format matches what users are expected to write.

**Call relations**: It calls `load_environments_toml` directly, focusing on file reading and TOML parsing before provider validation happens.

*Call graph*: calls 1 internal fn (load_environments_toml); 3 external calls (assert_eq!, write, tempdir).


##### `tests::load_environments_toml_rejects_unknown_fields`  (lines 804–830)

```
fn load_environments_toml_rejects_unknown_fields()
```

**Purpose**: Verifies that misspelled or unsupported fields in the TOML file are rejected. This helps users notice mistakes instead of thinking a setting worked when it was ignored.

**Data flow**: The test writes small TOML files containing unknown fields at the top level and inside an environment entry. For each file, it calls the loader and checks that the error mentions the unknown field.

**Call relations**: It calls `load_environments_toml`, relying on the `deny_unknown_fields` parsing rule declared on the config structs.

*Call graph*: calls 1 internal fn (load_environments_toml); 4 external calls (assert!, format!, write, tempdir).


##### `tests::toml_provider_rejects_malformed_websocket_url`  (lines 833–850)

```
fn toml_provider_rejects_malformed_websocket_url()
```

**Purpose**: Checks that a URL with the right prefix but invalid structure is still rejected. This catches cases like `ws://`, which names no usable server.

**Data flow**: The test builds a config with a malformed WebSocket URL, tries to create a provider, and checks that the error says the URL is invalid.

**Call relations**: It calls `TomlEnvironmentProvider::new`, which calls `parse_environment_toml` and then `validate_websocket_url`; the WebSocket parser supplies the malformed-URL failure.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `tests::environment_provider_from_codex_home_uses_present_environments_file`  (lines 853–877)

```
async fn environment_provider_from_codex_home_uses_present_environments_file()
```

**Purpose**: Verifies that when `environments.toml` exists in the Codex home directory, it is actually used. This proves the file-based configuration path is wired into provider selection.

**Data flow**: The test creates a temporary Codex home, writes an `environments.toml` that disables local and default selection, then asks for a provider from that directory. Its snapshot should reflect the file’s settings.

**Call relations**: It calls `environment_provider_from_codex_home`, which checks for the file, calls `load_environments_toml`, and builds a `TomlEnvironmentProvider`.

*Call graph*: calls 1 internal fn (environment_provider_from_codex_home); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `tests::environment_provider_from_codex_home_falls_back_when_file_is_missing`  (lines 880–899)

```
async fn environment_provider_from_codex_home_falls_back_when_file_is_missing()
```

**Purpose**: Checks that missing `environments.toml` does not break startup. The system should use the default environment provider when the optional config file is absent.

**Data flow**: The test creates an empty temporary Codex home and asks for an environment provider. The resulting snapshot should include local execution and choose local as the default.

**Call relations**: It calls `environment_provider_from_codex_home`, exercising the branch that skips TOML loading and returns `DefaultEnvironmentProvider::from_env`.

*Call graph*: calls 1 internal fn (environment_provider_from_codex_home); 3 external calls (assert!, assert_eq!, tempdir).


### Layer state and transforms
These files establish the in-memory layered config model and the core utilities that normalize, merge, fingerprint, and inject override layers into that model.

### `config/src/state.rs`

`config` · `config load and later config reads/edits`

Codex configuration does not come from just one file. It can come from managed company settings, a system file, a user file, a selected user profile, project `.codex` folders, and command-line or session flags. This file is the place where those pieces are represented as a stack, like transparent sheets laid on top of each other: lower sheets provide defaults, and higher sheets can cover them.

The main building block is `ConfigLayerEntry`, which stores one layer's source, parsed TOML configuration, version fingerprint, and optional disabled reason. Some layers also keep the original raw TOML text so it can later be shown or edited with its original context.

`ConfigLayerStack` stores all layers in the required priority order. It can return only enabled layers, merge them into one effective configuration, find which layer supplied each setting, and expose the active user layer for edits. It also stores separate configuration requirements, which are constraints that must be enforced but are not merged like ordinary settings.

A key safety check in this file is `verify_layer_ordering`. Without it, a project or user setting might accidentally override something it should not, or project folders might be applied in the wrong order. That would make configuration confusing and potentially unsafe.

#### Function details

##### `ConfigLoadOptions::from`  (lines 29–35)

```
fn from(loader_overrides: LoaderOverrides) -> Self
```

**Purpose**: Builds normal config-loading options from a set of loader overrides. This is a convenience path for callers that only want to change where configuration is loaded from, while leaving stricter checks and cloud bundle loading at their defaults.

**Data flow**: It receives `LoaderOverrides` as input. It places those overrides into a new `ConfigLoadOptions`, sets strict config checking to false, and creates the default cloud config bundle loader. The result is a complete options object ready for the config loader.

**Call relations**: This is used when loader overrides are enough to describe the desired loading behavior. It hands off default setup to `CloudConfigBundleLoader::default` so callers do not need to fill in every option by hand.

*Call graph*: calls 1 internal fn (default).


##### `LoaderOverrides::without_managed_config_for_tests`  (lines 59–74)

```
fn without_managed_config_for_tests() -> Self
```

**Purpose**: Creates test-only overrides that avoid using real host-managed configuration. This keeps tests isolated from whatever company or machine settings may exist on the developer's computer.

**Data flow**: It reads the operating system temporary directory, builds fake paths under a `codex-config-tests` folder, and fills the override fields with those paths. The returned `LoaderOverrides` points tests at controlled fixture locations instead of live managed config sources.

**Call relations**: Many tests call this before loading configuration so their results are repeatable. It is also used by `LoaderOverrides::with_managed_config_path_for_tests` as the base setup before adding one explicit managed config fixture.

*Call graph*: called by 49 (without_managed_config_for_tests, write_value_rejects_feature_requirement_conflict, refresh_test_state, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread, cold_thread_resume_reuses_non_local_history_probe, start_in_process_server, thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path (+15 more)); 2 external calls (new, temp_dir).


##### `LoaderOverrides::with_managed_config_path_for_tests`  (lines 81–90)

```
fn with_managed_config_path_for_tests(managed_config_path: PathBuf) -> Self
```

**Purpose**: Creates test-only overrides that load managed configuration from a specific fixture file. It is useful when a test wants to check how managed settings interact with user or session settings.

**Data flow**: It receives a path to a managed config fixture. It derives a sibling `requirements.toml` path, starts from the no-real-managed-config test defaults, and then replaces the managed config and requirements paths. The result is an override set aimed at the supplied fixture files.

**Call relations**: Tests that need a controlled managed config call this helper. It relies on `without_managed_config_for_tests` for the rest of the isolation behavior, then narrows the setup to the fixture being tested.

*Call graph*: called by 21 (invalid_user_value_rejected_even_if_overridden_by_managed, load_default_config_preserves_selected_user_config_path_after_load_error, read_includes_origins_and_layers, read_reports_managed_overrides_user_and_session_flags, write_value_defaults_to_selected_user_config_path, write_value_reports_managed_override, write_value_reports_override, write_value_succeeds_when_managed_preferences_expand_home_directory_paths, experimental_feature_list_returns_feature_metadata_with_stage, explicit_remote_control_startup_fails_when_disabled_by_requirements (+11 more)); 2 external calls (with_file_name, without_managed_config_for_tests).


##### `LoaderOverrides::user_config_path`  (lines 92–100)

```
fn user_config_path(&self, codex_home: &Path) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Returns the user config file path that should be used for this load. It either honors an explicit override or falls back to the normal `config.toml` under the Codex home directory.

**Data flow**: It receives the Codex home folder. If `user_config_path` was already set, it returns that absolute path. Otherwise it resolves the standard config filename against the Codex home folder and returns the resulting absolute path or an input/output error.

**Call relations**: The main config loading flow calls this when it needs to know which user config file to read. It delegates path construction to `AbsolutePathBuf::resolve_path_against_base` so relative path handling stays consistent.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 2 (load_default_config, user_config_path).


##### `ConfigLayerEntry::new`  (lines 120–130)

```
fn new(name: ConfigLayerSource, config: TomlValue) -> Self
```

**Purpose**: Creates a normal enabled configuration layer from a source name and parsed TOML value. Use it when the layer is active and there is no need to preserve the original text.

**Data flow**: It receives a layer source and parsed TOML configuration. It computes a version fingerprint from the TOML, stores the config, and leaves disabled status and raw TOML fields empty. The output is a ready-to-stack `ConfigLayerEntry`.

**Call relations**: Config loading code and tests use this to create ordinary layers. It calls `version_for_toml` so every layer can later be identified by a stable version value.

*Call graph*: calls 1 internal fn (version_for_toml); called by 33 (create_empty_user_layer, enterprise_layers_precede_user_and_override_system, load_config_layers_state, load_user_config_layer, project_layer_entry, with_user_config_profile, active_user_layer_is_highest_precedence_user_layer, origins_use_canonical_key_aliases, with_user_config_updates_matching_user_layer_without_replacing_active_profile, thread_config_source_to_layer (+15 more)).


##### `ConfigLayerEntry::new_with_raw_toml`  (lines 132–150)

```
fn new_with_raw_toml(
        name: ConfigLayerSource,
        config: TomlValue,
        raw_toml: String,
        raw_toml_base_dir: AbsolutePathBuf,
    ) -> Self
```

**Purpose**: Creates an enabled configuration layer while also keeping the original TOML text and the folder it came from. This matters when later code needs to display or rewrite non-file or cloud-provided layer content with context.

**Data flow**: It receives a source name, parsed TOML, raw TOML text, and a base directory for that text. It computes the version fingerprint, stores both the parsed and raw forms, and returns a complete layer entry.

**Call relations**: Config loading paths use this for layers where preserving the original text is important, including cloud config fragments. Like `new`, it calls `version_for_toml` so the layer has a version.

*Call graph*: calls 1 internal fn (version_for_toml); called by 2 (cloud_config_layers_from_fragments_impl, load_config_layers_state).


##### `ConfigLayerEntry::new_disabled`  (lines 152–166)

```
fn new_disabled(
        name: ConfigLayerSource,
        config: TomlValue,
        disabled_reason: impl Into<String>,
    ) -> Self
```

**Purpose**: Creates a configuration layer that is present but intentionally not applied. This lets the system remember a layer and explain why it was skipped, instead of silently dropping it.

**Data flow**: It receives a source name, parsed TOML, and a disabled reason. It computes the layer version, stores the reason as text, and returns a layer marked disabled. The config is kept for visibility, but normal merging will skip it.

**Call relations**: Project layer setup can use this when a project config exists but should not affect the final config. Later stack methods check `is_disabled` to decide whether to include it.

*Call graph*: calls 1 internal fn (version_for_toml); called by 1 (project_layer_entry); 1 external calls (into).


##### `ConfigLayerEntry::is_disabled`  (lines 168–170)

```
fn is_disabled(&self) -> bool
```

**Purpose**: Answers whether this layer should be ignored during normal config merging. It is a simple check based on whether the layer has a disabled reason.

**Data flow**: It reads the layer's optional disabled reason. If a reason exists, it returns true; otherwise it returns false. It does not change the layer.

**Call relations**: Layer filtering in `ConfigLayerStack::get_layers` uses this so disabled layers can be hidden from normal effective configuration while still being available when callers explicitly request them.


##### `ConfigLayerEntry::raw_toml`  (lines 172–176)

```
fn raw_toml(&self) -> Option<&str>
```

**Purpose**: Returns the original TOML text for this layer, if it was saved. This is useful for showing or processing layer content without reconstructing it from the parsed form.

**Data flow**: It reads the optional raw TOML record inside the layer. If present, it returns the raw text as a borrowed string slice; if absent, it returns nothing. The layer is unchanged.

**Call relations**: Rendering code for non-file layer values calls this when it needs the original text. Layers created with `new_with_raw_toml` can provide this; ordinary layers cannot.

*Call graph*: called by 1 (render_non_file_layer_value).


##### `ConfigLayerEntry::raw_toml_base_dir`  (lines 178–180)

```
fn raw_toml_base_dir(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: Returns the folder that should be treated as the base location for this layer's saved raw TOML, if such raw TOML exists. This helps resolve relative paths in preserved config text.

**Data flow**: It reads the optional raw TOML record. If one exists, it returns a reference to its base directory; otherwise it returns nothing. It does not modify anything.

**Call relations**: This pairs with `raw_toml`. Code that needs to interpret preserved raw TOML can ask for both the text and the folder it should be understood relative to.


##### `ConfigLayerEntry::with_hooks_config_folder_override`  (lines 182–188)

```
fn with_hooks_config_folder_override(
        mut self,
        hooks_config_folder_override: Option<AbsolutePathBuf>,
    ) -> Self
```

**Purpose**: Returns a copy of this layer with a special folder to use for hook declarations. Hooks are project-related actions, and linked worktrees sometimes need hook lookup to point somewhere different from the config file itself.

**Data flow**: It receives an optional absolute folder path. It updates the layer's hook folder override field and returns the modified layer. Other layer data stays the same.

**Call relations**: Project setup code can call this while building a layer. Later, `hooks_config_folder` uses the override first and falls back to the normal config folder if no override was set.


##### `ConfigLayerEntry::metadata`  (lines 190–195)

```
fn metadata(&self) -> ConfigLayerMetadata
```

**Purpose**: Produces a small public summary of the layer: where it came from and what version it has. This is used when the system needs to explain the origin of a setting without exposing the full config.

**Data flow**: It reads the layer's source name and version, clones them into a `ConfigLayerMetadata` value, and returns that value. The full TOML content is not included.

**Call relations**: `ConfigLayerStack::origins` calls this while recording which layer supplied each final setting. It provides the compact label that origin maps can store.

*Call graph*: 1 external calls (clone).


##### `ConfigLayerEntry::as_layer`  (lines 197–204)

```
fn as_layer(&self) -> ConfigLayer
```

**Purpose**: Converts an internal layer entry into the protocol shape used by the app/server API. This makes layer information easy to send outside the config module.

**Data flow**: It reads the source name, version, TOML config, and disabled reason. It converts the TOML config into JSON, using JSON null if conversion fails, and returns a `ConfigLayer` value.

**Call relations**: API-facing code can use this when reporting configuration layers to clients. It bridges the internal TOML-based representation to the JSON-based protocol representation.

*Call graph*: 2 external calls (clone, to_value).


##### `ConfigLayerEntry::config_folder`  (lines 207–218)

```
fn config_folder(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the `.codex` or config folder naturally associated with this layer, when one exists. Some sources, such as MDM or session flags, do not have a local folder.

**Data flow**: It looks at the layer source. For system and user file layers, it returns the parent folder of the file. For project layers, it returns the project `.codex` folder. For managed, MDM, session, and legacy managed sources, it returns nothing.

**Call relations**: This is the default folder lookup used by `hooks_config_folder`. It gives later project-related code a way to locate files that live beside a config layer.


##### `ConfigLayerEntry::hooks_config_folder`  (lines 226–230)

```
fn hooks_config_folder(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the folder that should be searched for hook declarations for this layer. It honors a special override first, then falls back to the layer's normal config folder.

**Data flow**: It checks whether a hook folder override was set. If so, it returns that folder. If not, it calls `config_folder` and returns the regular associated config folder, or nothing if the layer has none.

**Call relations**: Code that needs a source path for hook-related config calls this. It combines the worktree override behavior from `with_hooks_config_folder_override` with the standard folder lookup from `config_folder`.

*Call graph*: called by 1 (config_toml_source_path).


##### `ConfigLayerStack::new`  (lines 273–287)

```
fn new(
        layers: Vec<ConfigLayerEntry>,
        requirements: ConfigRequirements,
        requirements_toml: ConfigRequirementsToml,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds a complete configuration layer stack and checks that the layers are in a safe priority order. This is the main constructor for the in-memory config state.

**Data flow**: It receives a list of layers plus requirement data. It calls `verify_layer_ordering` to validate the order and find the active user layer. If validation succeeds, it returns a stack with default flags and no startup warnings; if not, it returns an input/output error.

**Call relations**: The config loader and many tests create stacks through this function. Its call to `verify_layer_ordering` is the gate that prevents incorrectly ordered layers from entering normal use.

*Call graph*: calls 1 internal fn (verify_layer_ordering); called by 83 (enterprise_layers_precede_user_and_override_system, load_config_layers_state, active_user_layer_is_highest_precedence_user_layer, origins_use_canonical_key_aliases, with_user_config_updates_matching_user_layer_without_replacing_active_profile, policy_from_config_parts, configured_plugins_from_stack_merges_user_layers, hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities, load_plugins_ignores_project_config_files, loads_skills_from_home_agents_dir_for_user_scope (+15 more)).


##### `ConfigLayerStack::with_user_and_project_exec_policy_rules_ignored`  (lines 289–295)

```
fn with_user_and_project_exec_policy_rules_ignored(
        mut self,
        ignore_user_and_project_exec_policy_rules: bool,
    ) -> Self
```

**Purpose**: Returns a stack copy that records whether execution policy should ignore rules found in user and project config folders. Execution policy is the part of the system that decides what commands or actions are allowed.

**Data flow**: It receives a boolean flag. It stores that flag in the stack and returns the updated stack, leaving layers and requirements unchanged.

**Call relations**: This is used during stack setup when loader options say user and project policy rule files should be skipped. Later, `ignore_user_and_project_exec_policy_rules` exposes that choice to execution policy loading.


##### `ConfigLayerStack::ignore_user_and_project_exec_policy_rules`  (lines 297–299)

```
fn ignore_user_and_project_exec_policy_rules(&self) -> bool
```

**Purpose**: Reports whether execution policy should skip user and project `.rules` files. It is a small read-only accessor for a safety-related loading choice.

**Data flow**: It reads the stored boolean flag from the stack and returns it. Nothing is changed.

**Call relations**: Execution policy loading calls this when deciding whether to read rule files from user and project config folders. The value is set earlier by `with_user_and_project_exec_policy_rules_ignored`.

*Call graph*: called by 1 (load_exec_policy).


##### `ConfigLayerStack::with_startup_warnings`  (lines 301–304)

```
fn with_startup_warnings(mut self, startup_warnings: Vec<String>) -> Self
```

**Purpose**: Attaches startup warning messages to a stack. These are notices found while building the config state, such as non-fatal problems the user should know about.

**Data flow**: It receives a list of warning strings. It stores them as checked startup warnings and returns the updated stack. The layer list and requirements are unchanged.

**Call relations**: The config loading flow can call this after detecting warnings. Later, `startup_warnings` lets higher-level loading code surface those messages.


##### `ConfigLayerStack::startup_warnings`  (lines 306–308)

```
fn startup_warnings(&self) -> Option<&[String]>
```

**Purpose**: Returns the startup warnings stored on the stack, if the loader checked for them. It distinguishes between “not checked” and “checked but found none.”

**Data flow**: It reads the optional warning list. If warnings were recorded, it returns them as a borrowed slice; if the loader did not record warning status, it returns nothing.

**Call relations**: The higher-level config loading function calls this to decide what warnings to include with the loaded configuration. Warnings are attached earlier through `with_startup_warnings`.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `ConfigLayerStack::get_active_user_layer`  (lines 316–319)

```
fn get_active_user_layer(&self) -> Option<&ConfigLayerEntry>
```

**Purpose**: Returns the user layer that should be treated as the active editable user config. When a profile is active, this is the profile layer rather than the base user file.

**Data flow**: It reads the saved user layer index. If the index exists and still points to a layer, it returns that layer; otherwise it returns nothing. It does not merge or validate any config.

**Call relations**: Code that computes override metadata, finds the user config file, or builds trusted config state calls this to locate the right user-owned layer. The index is established by `ConfigLayerStack::new` or update methods.

*Call graph*: called by 3 (compute_override_metadata, get_user_config_file, trusted_config_layer_stack).


##### `ConfigLayerStack::get_user_config_file`  (lines 321–327)

```
fn get_user_config_file(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: Returns the file path for the active user config layer, if there is one. This tells editing code which user file should be written.

**Data flow**: It first calls `get_active_user_layer`. If that layer is a user layer, it extracts and returns its file path. If there is no active user layer or the stored layer is not a user source, it returns nothing.

**Call relations**: This builds directly on `get_active_user_layer`. It is used when callers need the path, not the whole layer.

*Call graph*: calls 1 internal fn (get_active_user_layer).


##### `ConfigLayerStack::get_user_layers`  (lines 334–343)

```
fn get_user_layers(
        &self,
        ordering: ConfigLayerStackOrdering,
        include_disabled: bool,
    ) -> Vec<&ConfigLayerEntry>
```

**Purpose**: Returns only the user-related layers, in either low-to-high or high-to-low priority order. This matters because profile configuration can create more than one user layer.

**Data flow**: It receives an ordering choice and a flag saying whether disabled layers should be included. It asks `get_layers` for the filtered stack, then keeps only layers whose source is user config. The result is a list of borrowed layer references.

**Call relations**: `effective_user_config` calls this to merge just the user layers. It relies on `get_layers` for the general ordering and disabled-layer filtering rules.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (effective_user_config).


##### `ConfigLayerStack::effective_user_config`  (lines 349–363)

```
fn effective_user_config(&self) -> Option<TomlValue>
```

**Purpose**: Builds the merged configuration from enabled user layers only. This gives callers the user's own effective settings without system, managed, project, or session layers mixed in.

**Data flow**: It asks for enabled user layers from lowest to highest priority. If there are none, it returns nothing. Otherwise it starts with an empty TOML table, merges each user layer into it in order, and returns the merged TOML value.

**Call relations**: Plugin and marketplace configuration code calls this when it needs user-level settings. It uses `get_user_layers` to select the right layers and `merge_toml_values` so later user layers, such as a profile, override earlier ones.

*Call graph*: calls 2 internal fn (merge_toml_values, get_user_layers); called by 4 (installed_marketplace_roots_from_layer_stack, configured_plugins_from_stack, configured_plugins_from_stack, configured_git_marketplaces); 2 external calls (Table, new).


##### `ConfigLayerStack::requirements`  (lines 365–367)

```
fn requirements(&self) -> &ConfigRequirements
```

**Purpose**: Returns the composed configuration requirements attached to this stack. Requirements are rules or limits that must be enforced separately from ordinary settings.

**Data flow**: It returns a borrowed reference to the stack's `ConfigRequirements`. No data is copied or changed.

**Call relations**: Several policy, proxy, plugin, and debug paths read this when they need to enforce or display managed requirements. The requirements are supplied when the stack is created.

*Call graph*: called by 6 (apply_plugin_mcp_server_requirements, load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile, load_exec_policy, append_managed_requirement_handlers, render_debug_config_lines).


##### `ConfigLayerStack::requirements_toml`  (lines 369–371)

```
fn requirements_toml(&self) -> &ConfigRequirementsToml
```

**Purpose**: Returns the raw requirements data as it was loaded from TOML, MDM, or legacy sources. This preserves original allow-lists and source-shaped data for APIs and diagnostics.

**Data flow**: It returns a borrowed reference to the stack's `ConfigRequirementsToml`. The stack is unchanged.

**Call relations**: Config loading, feature protection, managed-network checks, and debug rendering call this when they need the original requirements view instead of only the composed enforcement form.

*Call graph*: called by 5 (protected_feature_keys, new, load_config_with_layer_stack, managed_network_requirements_enabled, render_debug_config_lines).


##### `ConfigLayerStack::with_user_config`  (lines 379–387)

```
fn with_user_config(&self, config_toml: &AbsolutePathBuf, user_config: TomlValue) -> Self
```

**Purpose**: Returns a new stack where one user config layer has been replaced or inserted. It automatically preserves the matching profile information if the target file already belongs to a profile layer.

**Data flow**: It receives a user config file path and parsed TOML. It searches existing layers for a user layer with that same file to recover its profile name, if any. Then it passes the file, profile, and config to `with_user_config_profile` and returns that new stack.

**Call relations**: Trusted config editing code calls this when it needs to update the user layer inside an existing stack. The actual replacement and ordering work is delegated to `with_user_config_profile`.

*Call graph*: calls 1 internal fn (with_user_config_profile); called by 1 (trusted_config_layer_stack).


##### `ConfigLayerStack::with_user_config_profile`  (lines 389–435)

```
fn with_user_config_profile(
        &self,
        config_toml: &AbsolutePathBuf,
        profile: Option<&ProfileV2Name>,
        user_config: TomlValue,
    ) -> Self
```

**Purpose**: Returns a new stack with a specific user config layer replaced or inserted, including optional profile identity. It keeps the stack's priority ordering intact.

**Data flow**: It receives a config file path, optional profile name, and parsed TOML. It creates a new user layer, removes any existing user layer for the same file, inserts the new layer before the first higher-precedence layer or at the end, recalculates the active user layer index, and returns a new stack with the same requirements, flags, and warnings.

**Call relations**: `with_user_config` calls this after deciding which profile applies. It uses `ConfigLayerEntry::new` to create the replacement layer and mirrors the ordering rules used by normal stack construction.

*Call graph*: calls 1 internal fn (new); called by 1 (with_user_config); 3 external calls (clone, clone, clone).


##### `ConfigLayerStack::with_user_layer_from`  (lines 439–477)

```
fn with_user_layer_from(&self, other: &Self) -> Self
```

**Purpose**: Returns a new stack that keeps this stack's non-user layers but copies all user layers from another stack. This is useful when refreshing or transferring user configuration without disturbing managed, system, or project layers.

**Data flow**: It receives another stack. It collects that stack's user layers, removes user layers from the current stack's layer list, reinserts the copied user layers according to precedence, recalculates the active user layer index, and returns a new stack with the current stack's requirements, flags, and warnings.

**Call relations**: This method is available for flows that need to combine user settings from one stack with the surrounding context of another. Its insertion logic matches the rest of the stack update behavior.

*Call graph*: 2 external calls (clone, clone).


##### `ConfigLayerStack::effective_config`  (lines 483–492)

```
fn effective_config(&self) -> TomlValue
```

**Purpose**: Builds the full merged configuration from all enabled ordinary config layers. This is the main “what settings are in effect?” view of the stack.

**Data flow**: It starts with an empty TOML table. It gets enabled layers from lowest to highest priority, merges each layer into the table, and returns the final TOML value. Requirements are not included because they are tracked separately.

**Call relations**: Many downstream config readers call this before deserializing or extracting feature settings. It relies on `get_layers` for the correct layer order and on `merge_toml_values` for override behavior.

*Call graph*: calls 2 internal fn (merge_toml_values, get_layers); called by 6 (protected_feature_keys, apps_config_from_layer_stack, bundled_skills_enabled_from_stack, deserialize_effective_config, network_proxy_spec_for_active_permission_profile, resolve_tool_suggest_config_from_layer_stack); 2 external calls (Table, new).


##### `ConfigLayerStack::origins`  (lines 497–510)

```
fn origins(&self) -> HashMap<String, ConfigLayerMetadata>
```

**Purpose**: Builds a map showing which config layer supplied each final setting. This helps explain why a setting has its current value.

**Data flow**: It starts with an empty origin map and path tracker. For each enabled layer in low-to-high priority order, it normalizes key aliases, records that layer's metadata for each setting path, and lets higher-priority layers overwrite earlier origins. It returns the completed map.

**Call relations**: Diagnostic and API code can use this to answer “where did this value come from?” It calls `normalized_with_key_aliases` so old and new key names are treated consistently, and `record_origins` to fill the map.

*Call graph*: calls 3 internal fn (record_origins, normalized_with_key_aliases, get_layers); 2 external calls (new, new).


##### `ConfigLayerStack::layers_high_to_low`  (lines 515–520)

```
fn layers_high_to_low(&self) -> Vec<&ConfigLayerEntry>
```

**Purpose**: Returns enabled layers from highest priority to lowest priority. This is useful when searching for the first layer that wins for a setting.

**Data flow**: It asks `get_layers` for enabled layers in highest-precedence-first order and returns that list. The stack itself is unchanged.

**Call relations**: Layer lookup code calls this when it needs to find the effective layer quickly from the top down. It is a small convenience wrapper around `get_layers`.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (find_effective_layer).


##### `ConfigLayerStack::get_layers`  (lines 525–539)

```
fn get_layers(
        &self,
        ordering: ConfigLayerStackOrdering,
        include_disabled: bool,
    ) -> Vec<&ConfigLayerEntry>
```

**Purpose**: Returns the stack's layers in the requested priority order, optionally including disabled layers. This is the common filter-and-order helper used by most stack views.

**Data flow**: It reads the internal layer list, filters out disabled layers unless requested, and collects borrowed references. If the caller asked for highest-priority first, it reverses the list. The result is a view of the layers, not a copy of their contents.

**Call relations**: `effective_config`, `effective_user_config`, `origins`, `layers_high_to_low`, and other feature-specific readers call this so they all follow the same ordering and disabled-layer rules.

*Call graph*: called by 17 (first_layer_config_error, effective_config, get_user_layers, layers_high_to_low, origins, skill_config_rules_from_stack, project_root_markers_from_stack, skill_roots_from_layer_stack_inner, rebuild_preserving_session_layers, load_agent_roles (+7 more)).


##### `verify_layer_ordering`  (lines 544–591)

```
fn verify_layer_ordering(layers: &[ConfigLayerEntry]) -> std::io::Result<Option<usize>>
```

**Purpose**: Checks that configuration layers are arranged in the required priority order and finds the active user layer. This protects the system from applying settings in a surprising or unsafe order.

**Data flow**: It receives a slice of layer entries. First it checks that layer sources are sorted by their precedence. Then it walks the layers, remembering the latest user layer index and ensuring project layers move from the repository root toward the current working directory. It returns the active user layer index on success, or an input/output error if the order is invalid.

**Call relations**: `ConfigLayerStack::new` calls this before accepting a layer list. If this check fails, the stack is not created, which prevents later merging and origin tracking from relying on a broken order.

*Call graph*: called by 1 (new); 3 external calls (new, iter, matches!).


### `config/src/fingerprint.rs`

`config` · `config load`

Configuration often comes from several layers, such as defaults, files, command-line overrides, or other sources. This file supports two practical needs that come from that: tracing a setting back to its source, and giving a whole configuration a reliable version label.

The first part walks through a TOML value, which is the structured format used for config files. When it reaches an actual setting value, it records the setting’s path, such as `server.port` or `tools.0.name`, along with metadata saying which configuration layer supplied it. This is like putting a small label on every item in a packed box so someone can later ask, “Where did this come from?”

The second part turns a TOML configuration into a stable `sha256:...` string. SHA-256 is a standard one-way hash: a compact checksum-like summary of some data. To make sure the same logical config always gets the same hash, the file first converts the TOML into JSON and sorts object keys into a consistent order. Without that sorting step, two equivalent configs with keys written in different orders could appear different. The result is useful anywhere the program needs a quick, dependable way to compare configurations.

#### Function details

##### `record_origins`  (lines 8–35)

```
fn record_origins(
    value: &TomlValue,
    meta: &ConfigLayerMetadata,
    path: &mut Vec<String>,
    origins: &mut HashMap<String, ConfigLayerMetadata>,
)
```

**Purpose**: This function walks through a TOML configuration tree and records which configuration layer supplied each final setting. It is used so later code can explain the source of a specific value, rather than only knowing the final merged result.

**Data flow**: It receives a TOML value, metadata for the current configuration layer, a temporary path being built as it walks, and a map where results are stored. For tables, it adds each key to the path and looks deeper; for arrays, it adds each item number and looks deeper. When it reaches a non-container value, it joins the path into a dotted name and stores a copy of the layer metadata in the origins map.

**Call relations**: This function is called by `origins` when the configuration system is building the source map for settings. During that walk it copies the metadata for each leaf value so the caller ends up with a complete lookup table from setting path to source layer.

*Call graph*: called by 1 (origins); 1 external calls (clone).


##### `version_for_toml`  (lines 37–49)

```
fn version_for_toml(value: &TomlValue) -> String
```

**Purpose**: This function creates a stable version string for a TOML configuration. Someone would use it to cheaply tell whether the configuration content has changed.

**Data flow**: It takes a TOML value, converts it into JSON, normalizes that JSON so object keys are in a consistent order, serializes the normalized value into bytes, and feeds those bytes into a SHA-256 hasher. It returns a string starting with `sha256:` followed by the hash written in hexadecimal characters.

**Call relations**: This function is called when new configuration objects are created, including normal, disabled, and raw-TOML construction paths. It relies on `canonical_json` before hashing so those callers get a dependable fingerprint that is not affected by incidental key ordering.

*Call graph*: calls 1 internal fn (canonical_json); called by 3 (new, new_disabled, new_with_raw_toml); 4 external calls (new, format!, to_value, to_vec).


##### `canonical_json`  (lines 51–67)

```
fn canonical_json(value: &JsonValue) -> JsonValue
```

**Purpose**: This helper rewrites a JSON value into a predictable order. Its main job is to make objects with the same contents look identical before they are hashed.

**Data flow**: It receives a JSON value. If the value is an object, it sorts the object’s keys and recursively normalizes each child value; if it is an array, it recursively normalizes each item while keeping the array order; for simple values like strings, numbers, booleans, or null, it returns a copy unchanged.

**Call relations**: This function is used by `version_for_toml` just before serialization and hashing. It prepares the data so the hash represents the actual configuration content, not the arbitrary order in which object keys happened to appear.

*Call graph*: called by 1 (version_for_toml); 3 external calls (Array, Object, new).


### `config/src/merge.rs`

`config` · `config load`

Configuration often comes from several places: built-in defaults, user files, command-line choices, or permission profiles. This file is the “stacking” tool that folds those layers together. The rule is simple: when the same setting appears in both places, the overlay wins. If both sides are tables, it goes inside the table and merges key by key instead of replacing the whole section.

While doing that, it also normalizes names. Some configuration keys may have aliases, meaning two different spellings are accepted for the same setting. Before comparing or inserting keys, this file rewrites those aliases into the project’s standard names. That prevents a setting from being accidentally duplicated just because it used an older or alternate name.

There is one special case for permission network domain rules. Domain names are normalized too, using shared host-normalization logic. This matters because domains like differently cased host names, or host names written in slightly different accepted forms, should refer to the same rule. Without this file, layered configuration could behave unpredictably: aliases might not override each other, domain permission rules might split into duplicates, and user overrides might fail to replace defaults.

#### Function details

##### `merge_toml_values`  (lines 7–9)

```
fn merge_toml_values(base: &mut TomlValue, overlay: &TomlValue)
```

**Purpose**: This is the public entry point for merging one TOML configuration value into another. It gives the overlay value priority, so callers can apply user or profile settings on top of a base configuration.

**Data flow**: It receives a mutable base TOML value and a read-only overlay TOML value. It starts the merge at the top of the configuration with an empty path, then updates the base in place. Nothing separate is returned; the changed base is the result.

**Call relations**: Higher-level configuration code calls this when building layered config states, permission profiles, and effective user or runtime configuration. It immediately hands the real work to merge_toml_values_at_path, which needs to know where it is inside the configuration tree.

*Call graph*: calls 1 internal fn (merge_toml_values_at_path); called by 5 (load_config_layers_state, merge_permission_profiles, compose, effective_config, effective_user_config); 1 external calls (new).


##### `merge_toml_values_at_path`  (lines 11–35)

```
fn merge_toml_values_at_path(base: &mut TomlValue, overlay: &TomlValue, path: &mut Vec<String>)
```

**Purpose**: This function does the actual recursive merge. It walks through nested TOML tables, applies alias normalization, gives overlay values priority, and keeps track of the current location so path-specific rules can be applied.

**Data flow**: It receives the current base value, the overlay value, and a path showing where it is in the configuration. If both values are tables, it first normalizes accepted key aliases on both sides. If the path is the special permissions network domains section, it also normalizes domain-name keys. Then it goes through each overlay entry: matching keys are merged deeper, and new keys are inserted after normalization. If the two values are not both tables, the overlay replaces the base at that spot.

**Call relations**: merge_toml_values calls this once at the root. As it descends, it calls itself for nested matching tables. Along the way it asks normalize_key_aliases and normalized_with_key_aliases to standardize key names, asks is_permission_network_domains_path whether special domain treatment is needed, and calls normalize_network_domain_keys when that special case applies.

*Call graph*: calls 4 internal fn (normalize_key_aliases, normalized_with_key_aliases, is_permission_network_domains_path, normalize_network_domain_keys); called by 1 (merge_toml_values).


##### `is_permission_network_domains_path`  (lines 37–43)

```
fn is_permission_network_domains_path(path: &[String]) -> bool
```

**Purpose**: This small helper recognizes the one configuration location where table keys are network domain patterns. That lets the merge code apply domain-name cleanup only where it makes sense.

**Data flow**: It receives the current path as a list of strings. It checks whether the path has the expected shape for permissions, then a profile name, then network, then domains. It returns true for that exact location and false everywhere else.

**Call relations**: merge_toml_values_at_path calls this before merging a table. When it returns true, the merge process knows to normalize domain keys before comparing or inserting them.

*Call graph*: called by 1 (merge_toml_values_at_path); 1 external calls (matches!).


##### `normalize_network_domain_keys`  (lines 45–50)

```
fn normalize_network_domain_keys(table: &mut toml::map::Map<String, TomlValue>)
```

**Purpose**: This function rewrites all keys in a network-domain table into a standard host form. It makes sure equivalent domain names are treated as the same configuration entry.

**Data flow**: It receives a mutable TOML table whose keys are domain or host patterns. It temporarily takes out all entries, normalizes each key with the shared host-normalization routine, and inserts the value back under the normalized key. The table is changed in place.

**Call relations**: merge_toml_values_at_path calls this only inside permission network domain sections. It relies on normalize_host from the network proxy code so configuration merging uses the same idea of a normalized host as the networking-related parts of the system.

*Call graph*: called by 1 (merge_toml_values_at_path); 3 external calls (insert, normalize_host, take).


### `config/src/overrides.rs`

`config` · `config load`

This file solves a small but important configuration problem: command-line settings often arrive as flat text paths, while the rest of the system expects structured TOML data. TOML is a common configuration format made of tables, keys, and values. A dotted path such as `database.pool.size` means “put `size` inside `pool`, inside `database`.”

The file starts with an empty TOML table, like an empty filing cabinet. Then it walks through each command-line override and files the value into the right nested drawer. If the needed tables do not exist yet, it creates them along the way. If it reaches a place that is not already a table, it replaces that spot with a table so the override can still be applied.

The result is one TOML value that represents all command-line overrides as a proper configuration layer. Another part of the config system can then combine this layer with other layers, such as defaults or files. Without this file, command-line overrides would remain as loose path/value pairs, and the configuration loader would not have a clean way to merge them with normal TOML configuration.

#### Function details

##### `default_empty_table`  (lines 3–5)

```
fn default_empty_table() -> TomlValue
```

**Purpose**: This creates a blank TOML table. It is the starting container where command-line override values can be placed.

**Data flow**: Nothing is passed in. The function creates an empty TOML table value and returns it, ready to have keys and nested tables added.

**Call relations**: When the override layer is being built, `build_cli_overrides_layer` calls this first to get a clean root table before adding any command-line settings.

*Call graph*: called by 1 (build_cli_overrides_layer); 2 external calls (default, Table).


##### `build_cli_overrides_layer`  (lines 7–13)

```
fn build_cli_overrides_layer(cli_overrides: &[(String, TomlValue)]) -> TomlValue
```

**Purpose**: This turns a list of command-line overrides into one structured TOML value. It is used when the configuration loader needs command-line values to look like a normal config layer.

**Data flow**: It receives a list of pairs: each pair has a dotted path, such as `logging.level`, and a TOML value to store there. It starts with an empty table, applies each override into that table, and returns the finished TOML structure.

**Call relations**: The broader configuration loading flow calls this from `load_config_layers_state` when it is assembling all sources of configuration. This function prepares the command-line layer by calling `default_empty_table` for the starting point and `apply_toml_override` once for each supplied override.

*Call graph*: calls 2 internal fn (apply_toml_override, default_empty_table); called by 1 (load_config_layers_state).


##### `apply_toml_override`  (lines 16–55)

```
fn apply_toml_override(root: &mut TomlValue, path: &str, value: TomlValue)
```

**Purpose**: This places one value into a TOML structure at a dotted path. It creates any missing nested tables needed to reach the final key.

**Data flow**: It receives a mutable root TOML value, a dotted path, and the value to insert. It splits the path into pieces, walks down through the TOML tables piece by piece, creates tables where needed, and finally inserts the value at the last path segment. The root value is changed in place; nothing is returned.

**Call relations**: `build_cli_overrides_layer` calls this repeatedly while building the command-line override layer. This helper does the actual path-walking and insertion work so the higher-level builder can simply loop over all overrides.

*Call graph*: called by 1 (build_cli_overrides_layer); 2 external calls (new, Table).


### `config/src/thread_config.rs`

`config` · `config load for a new thread or session`

A running thread may need settings that are not in the usual config files. For example, the service that starts a session might choose a model provider, add model provider details, or turn a feature on or off. This file is the bridge between those thread-specific settings and the project’s ordinary configuration stack.

The main idea is simple: a ThreadConfigLoader fetches typed pieces of config, called ThreadConfigSource values. Each source says who owns the information: the session service or the authenticated user. The loader does not decide final precedence. Instead, load_config_layers converts those typed sources into ConfigLayerEntry values, which are the same kind of layered config entries used elsewhere. This keeps thread settings from becoming a separate, special path.

There are two basic loader implementations here. StaticThreadConfigLoader is useful when the config is already known in memory, especially in tests or simple setup. NoopThreadConfigLoader returns nothing when no external thread config exists. The file also defines ThreadConfigLoadError so callers can tell whether loading failed because of authentication, timeout, parsing, request failure, or an internal problem.

One important detail: user thread config currently has no TOML-backed fields, so it produces no config layer yet. Session config becomes a TOML table only if it contains real values.

#### Function details

##### `ThreadConfigLoadError::new`  (lines 63–73)

```
fn new(
        code: ThreadConfigLoadErrorCode,
        status_code: Option<u16>,
        message: impl Into<String>,
    ) -> Self
```

**Purpose**: Creates a structured error for thread config loading. It records both a broad error category and a human-readable message, with an optional HTTP-style status code when the failure came from a remote request.

**Data flow**: It receives an error code, an optional status number, and any message-like value. It turns the message into a stored string and returns a ThreadConfigLoadError containing all three pieces.

**Call relations**: Other loading paths use this when something goes wrong, such as parsing config, receiving a remote status failure, or failing during load. It gives those callers one consistent error shape to return upward.

*Call graph*: called by 3 (load, parse_error, remote_status_to_error); 1 external calls (into).


##### `ThreadConfigLoadError::code`  (lines 75–77)

```
fn code(&self) -> ThreadConfigLoadErrorCode
```

**Purpose**: Returns the stable category for a thread config loading error. A caller can use this to react differently to authentication failures, timeouts, parse problems, and other broad causes.

**Data flow**: It reads the error’s stored code and returns it unchanged. It does not modify the error.

**Call relations**: This is a small accessor used after an error has already been created. It lets higher-level code inspect the kind of failure without parsing the message text.


##### `ThreadConfigLoadError::status_code`  (lines 79–81)

```
fn status_code(&self) -> Option<u16>
```

**Purpose**: Returns the optional status code attached to a loading error. This is useful when the config was fetched over a service call and the service replied with a numeric failure status.

**Data flow**: It reads the stored status_code field and returns either the number or nothing if there was no status code. It leaves the error unchanged.

**Call relations**: This supports callers that need more detail after receiving a ThreadConfigLoadError. It complements the broader code value by exposing remote-response information when available.


##### `ThreadConfigLoader::load_config_layers`  (lines 102–114)

```
fn load_config_layers(
        &self,
        context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ConfigLayerEntry>>
```

**Purpose**: Loads thread-specific config and converts it into the normal layered config format used by the rest of the application. This is the preferred path for callers that want final config processing to continue through the usual stack.

**Data flow**: It receives a ThreadConfigContext, passes it to the loader’s load method, waits for the typed sources, converts each source into zero or one ConfigLayerEntry, drops empty results, and returns the resulting list. If loading or conversion fails, it returns the error instead.

**Call relations**: This method sits above each loader’s raw load function. A concrete loader fetches source-specific data, then load_config_layers hands each source to thread_config_source_to_layer so the rest of the config system can treat thread settings like ordinary layers.

*Call graph*: 1 external calls (pin).


##### `StaticThreadConfigLoader::new`  (lines 127–129)

```
fn new(sources: Vec<ThreadConfigSource>) -> Self
```

**Purpose**: Builds a loader from a fixed list of thread config sources already held in memory. This is useful when tests or setup code want predictable config without calling an external service.

**Data flow**: It receives a vector of ThreadConfigSource values and stores it inside a StaticThreadConfigLoader. The returned loader will later clone and return that same set of sources.

**Call relations**: Tests and setup-style callers create this loader when they need known session or user config. Its stored data is later returned by StaticThreadConfigLoader::load and may then flow into load_config_layers.

*Call graph*: called by 4 (derive_config_from_params_uses_session_thread_config_model_provider, loader_returns_session_and_user_sources, loader_translates_sources_to_config_layers, includes_thread_config_layers_in_stack).


##### `StaticThreadConfigLoader::load`  (lines 133–138)

```
fn load(
        &self,
        _context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Returns the static config sources stored in this loader. It ignores the thread context because its answer is already fixed.

**Data flow**: It receives a context but does not read it. It clones the loader’s stored source list and returns it successfully inside an asynchronous result.

**Call relations**: This is the concrete load implementation used by StaticThreadConfigLoader. When callers use load_config_layers on this loader, this function supplies the typed sources that are then converted into config layers.

*Call graph*: 1 external calls (pin).


##### `NoopThreadConfigLoader::load`  (lines 146–151)

```
fn load(
        &self,
        _context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Returns no thread-specific config. It is used when the application has no external or special per-thread config source configured.

**Data flow**: It receives a context but ignores it. It returns an empty list inside an asynchronous success result.

**Call relations**: This is the safe default loader. Code can still call the normal ThreadConfigLoader methods, but this implementation contributes no sources and therefore no config layers.

*Call graph*: 2 external calls (pin, new).


##### `thread_config_source_to_layer`  (lines 154–174)

```
fn thread_config_source_to_layer(
    source: ThreadConfigSource,
) -> Result<Option<ConfigLayerEntry>, ThreadConfigLoadError>
```

**Purpose**: Turns one typed thread config source into the normal config-layer form, or returns nothing if that source has no usable settings. This is where thread-specific data enters the shared config system.

**Data flow**: It receives a ThreadConfigSource. For session config, it converts the data into a TOML value, checks whether the table is empty, and returns a SessionFlags config layer only when there is content. For user config, it currently returns nothing because there are no TOML-backed user fields yet.

**Call relations**: ThreadConfigLoader::load_config_layers calls this for each source returned by a loader. It relies on session_thread_config_to_toml for session data and is_empty_table to avoid adding empty layers.

*Call graph*: calls 3 internal fn (new, is_empty_table, session_thread_config_to_toml).


##### `is_empty_table`  (lines 176–178)

```
fn is_empty_table(config: &TomlValue) -> bool
```

**Purpose**: Checks whether a TOML value is an empty table. This prevents the system from adding a meaningless config layer with no settings in it.

**Data flow**: It receives a TOML value, looks to see whether it is a table, and if so checks whether that table has no entries. It returns true only for an empty table.

**Call relations**: thread_config_source_to_layer uses this after converting session config to TOML. If the converted table is empty, the source is skipped instead of becoming a config layer.

*Call graph*: called by 1 (thread_config_source_to_layer); 1 external calls (as_table).


##### `session_thread_config_to_toml`  (lines 180–213)

```
fn session_thread_config_to_toml(
    config: SessionThreadConfig,
) -> Result<TomlValue, ThreadConfigLoadError>
```

**Purpose**: Converts session-owned thread settings into a TOML table, which is the format expected by the normal config-layer machinery. TOML is a common human-readable config format made of keys, values, and nested tables.

**Data flow**: It receives a SessionThreadConfig. It creates a new TOML table, adds model_provider if present, converts model_providers into TOML if any exist, and adds feature flags as boolean values if any exist. It returns the completed TOML table, or a parse-style ThreadConfigLoadError if provider conversion fails.

**Call relations**: thread_config_source_to_layer calls this when it receives a session source. If conversion succeeds and the table is not empty, the result becomes the content of a ConfigLayerEntry.

*Call graph*: called by 1 (thread_config_source_to_layer); 4 external calls (String, Table, try_from, new).


##### `tests::loader_returns_session_and_user_sources`  (lines 224–253)

```
async fn loader_returns_session_and_user_sources()
```

**Purpose**: Checks that StaticThreadConfigLoader gives back exactly the session and user sources it was built with. This protects the simple in-memory loader from accidentally filtering or changing its data.

**Data flow**: The test creates a static loader with one session config and one user config, then asks it to load using a sample thread id. It compares the returned sources with the original expected list.

**Call relations**: This test exercises StaticThreadConfigLoader::new and StaticThreadConfigLoader::load directly. It verifies the raw typed-source path before any conversion into config layers happens.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert_eq!, vec!).


##### `tests::loader_translates_sources_to_config_layers`  (lines 256–298)

```
async fn loader_translates_sources_to_config_layers()
```

**Purpose**: Checks that loaded thread config sources are translated into the expected normal config layer. It also confirms that empty user config is ignored for now.

**Data flow**: The test creates a static loader with user config and session config, then calls load_config_layers with a sample current working directory. It expects one SessionFlags layer containing the model provider, provider details, and feature flag as TOML.

**Call relations**: This test follows the higher-level path: StaticThreadConfigLoader::new supplies data, load_config_layers asks the loader for sources, and thread_config_source_to_layer plus session_thread_config_to_toml convert the session source into a ConfigLayerEntry.

*Call graph*: calls 2 internal fn (new, from_absolute_path_checked); 4 external calls (default, assert_eq!, temp_dir, vec!).


##### `tests::test_provider`  (lines 300–320)

```
fn test_provider(name: &str) -> ModelProviderInfo
```

**Purpose**: Builds a sample model provider record for the tests. It keeps the test cases readable by hiding the many provider fields behind one helper.

**Data flow**: It receives a provider name, fills out a ModelProviderInfo value with that name and fixed test settings such as base URL, wire API, authentication behavior, and websocket support, then returns it.

**Call relations**: The test functions call this helper when they need a realistic provider entry inside SessionThreadConfig. Its returned value is later compared directly or converted into TOML as part of config-layer translation.


### Cloud and managed inputs
These files define cloud bundle ingestion and managed-layer parsing, including validation and platform-specific acquisition of externally supplied configuration.

### `cloud-config/src/validation.rs`

`config` · `config load`

A cloud configuration bundle is a package of settings supplied from outside the local program, such as enterprise-managed configuration and requirements. Because that bundle may come from a remote service or a local cache, the program needs a gatekeeper that says: “Can we safely understand and apply this?” This file is that gatekeeper.

The validation is deliberately small and focused. First, it tries to turn the raw bundle into structured layers using the provided base directory. The base directory matters because some bundle contents may refer to files or paths that need to be interpreted relative to a known location. If the bundle cannot be split into valid layers, the function reports that the whole bundle is invalid.

Next, it looks at the enterprise-managed requirements from those layers and tries to compose them into one consistent set of requirements. “Compose” here means combining separate requirement pieces into a final form the program can actually use. If those pieces conflict or are malformed, validation fails.

Nothing is saved or applied here. Like a ticket checker at a station gate, this file only decides whether the bundle is allowed to proceed. The actual loading and caching happen elsewhere.

#### Function details

##### `validate_bundle`  (lines 8–34)

```
fn validate_bundle(
    bundle: &CloudConfigBundle,
    base_dir: &AbsolutePathBuf,
) -> Result<(), CloudConfigBundleLoadError>
```

**Purpose**: Checks that a cloud configuration bundle can be interpreted and that its enterprise requirements can be combined into a valid final set. Callers use it before accepting a cached or remote bundle.

**Data flow**: It receives a bundle and a base directory. It copies the bundle so it can build structured configuration layers from it, using the base directory to resolve any path-sensitive content. From those layers, it takes the enterprise-managed requirements and tries to combine them. If either step fails, it returns a cloud configuration load error marked as an invalid bundle; if both steps succeed, it returns success and changes nothing.

**Call relations**: When cached or remote bundle-loading code wants to decide whether a bundle is safe to keep using, it calls `validate_bundle`. This function delegates the first check to the layer-building code, then delegates the second check to the requirements-composing code. It wraps any failure from those lower-level steps in a consistent load error so the callers can treat bad cached and bad remote bundles the same way.

*Call graph*: calls 1 internal fn (from_bundle); called by 2 (load_valid_cached_bundle, validate_and_cache_remote_bundle); 2 external calls (compose_requirements, clone).


### `config/src/cloud_config_bundle.rs`

`domain_logic` · `config load`

Cloud configuration arrives as a bundle of text fragments, grouped by where they came from. This file gives that bundle a clear in-memory shape, then explains how to convert it into the app’s normal layer system. A “layer” is one source of settings that can be stacked with others, like transparent sheets laid on top of each other; higher-priority sheets can cover lower-priority ones.

The main bundle currently has two enterprise-managed buckets: one for normal config TOML and one for requirements TOML. TOML is a human-readable settings file format. `CloudConfigBundleLayers` converts those buckets into `ConfigLayerEntry` and `RequirementsLayerEntry` values. One important detail is ordering: config fragments are kept in the order expected by the config stack, while requirements fragments are reversed because they arrive highest-priority first but must be merged lowest-priority first.

The file also defines structured load errors, with a simple category such as authentication failure, timeout, or invalid bundle. Finally, `CloudConfigBundleLoader` wraps an asynchronous future in a shared form, so if several callers ask for the bundle, they all receive the same result instead of starting duplicate work.

#### Function details

##### `CloudConfigBundle::is_empty`  (lines 31–44)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a cloud bundle contains no enterprise-managed config fragments and no enterprise-managed requirements fragments. This is useful when later code wants to treat an absent or empty cloud bundle as “nothing to apply.”

**Data flow**: It reads the bundle’s two top-level sections: config TOML and requirements TOML. It looks inside each section’s enterprise-managed list. It returns `true` only when both lists are empty, and it does not change the bundle.

**Call relations**: This is used by `optional_bundle` when deciding whether a bundle has meaningful cloud-provided content. It is a quick gate before any heavier conversion into layers is needed.

*Call graph*: called by 1 (optional_bundle).


##### `CloudConfigBundleLayers::from_bundle`  (lines 77–82)

```
fn from_bundle(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
    ) -> Result<Self, CloudConfigLayerError>
```

**Purpose**: Converts a raw cloud bundle into layer entries using the normal, non-strict config parsing path. Callers use this when they want to apply cloud config while allowing the usual tolerant parsing behavior.

**Data flow**: It receives a `CloudConfigBundle` and a base directory path. It passes both to the shared conversion routine with strict config checking turned off. The result is either a set of config and requirements layers or a cloud config layer error if conversion fails.

**Call relations**: This is the ordinary entry point used by bundle validation and config loading flows. It delegates the real work to `CloudConfigBundleLayers::from_bundle_impl`, which keeps the ordering and parsing rules in one place.

*Call graph*: called by 3 (validate_bundle, bundle_layers_preserve_enterprise_managed_bucket_order, load_config_layers_state); 1 external calls (from_bundle_impl).


##### `CloudConfigBundleLayers::from_bundle_strict_config`  (lines 84–89)

```
fn from_bundle_strict_config(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
    ) -> Result<Self, CloudConfigLayerError>
```

**Purpose**: Converts a raw cloud bundle into layer entries while requiring stricter validation for config fragments. This is used when the caller wants malformed managed config to be caught more aggressively.

**Data flow**: It receives the same inputs as the normal converter: a bundle and a base directory. It forwards them to the shared conversion routine with strict config checking turned on. It returns converted layers on success or a detailed layer error on failure.

**Call relations**: This is called by validation and config loading paths that need strict checking. Like the non-strict wrapper, it relies on `CloudConfigBundleLayers::from_bundle_impl` so both paths share the same bucket handling and ordering behavior.

*Call graph*: called by 2 (bundle_layers_can_strict_validate_enterprise_managed_config, load_config_layers_state); 1 external calls (from_bundle_impl).


##### `CloudConfigBundleLayers::from_bundle_impl`  (lines 91–136)

```
fn from_bundle_impl(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
        strict_config: bool,
    ) -> Result<Self, CloudConfigLayerError>
```

**Purpose**: Does the actual work of turning cloud bundle buckets into semantic layer entries. It exists so the strict and non-strict public converters can share the same conversion rules.

**Data flow**: It takes ownership of the bundle, reads out the enterprise-managed config fragments and requirements fragments, and uses the provided base directory to anchor any relative paths inside those fragments. For config fragments, it chooses either strict or normal conversion. For requirements fragments, it wraps each text fragment with its enterprise-managed source information, attaches the base directory, then reverses the list so merge priority is correct. It returns a finished `CloudConfigBundleLayers` value or stops with an error if config parsing fails.

**Call relations**: The two public constructors, `from_bundle` and `from_bundle_strict_config`, feed into this routine. Inside, it hands config fragments to the cloud config layer conversion helpers, then builds requirements layer entries directly because requirements fragments have their own source metadata and ordering rule.

*Call graph*: calls 1 internal fn (cloud_config_layers_from_fragments_strict); 1 external calls (cloud_config_layers_from_fragments).


##### `CloudConfigBundleLoadError::new`  (lines 157–167)

```
fn new(
        code: CloudConfigBundleLoadErrorCode,
        status_code: Option<u16>,
        message: impl Into<String>,
    ) -> Self
```

**Purpose**: Creates a structured error for a failed cloud bundle load. The error keeps both a human-readable message and machine-readable details, such as whether the problem was authentication, a timeout, or an invalid bundle.

**Data flow**: It receives an error code, an optional HTTP status code, and a message-like value. It converts the message into a string and stores all three pieces in a new `CloudConfigBundleLoadError`. Nothing else is changed.

**Call relations**: This constructor is used by remote fetching, unauthorized-response handling, and tests that check how config loading reacts to cloud bundle failures. Later code can inspect the error through `code` and `status_code` instead of trying to guess from the message text.

*Call graph*: called by 6 (config_load_error_marks_cloud_config_bundle_failures_for_relogin, config_load_error_marks_invalid_cloud_config_bundle_failures_without_relogin, config_load_error_marks_non_auth_cloud_config_bundle_failures_without_relogin, fetch_remote_bundle_and_update_cache_with_retries, handle_unauthorized, load_config_layers_fails_when_cloud_config_bundle_loader_fails); 1 external calls (into).


##### `CloudConfigBundleLoadError::code`  (lines 169–171)

```
fn code(&self) -> CloudConfigBundleLoadErrorCode
```

**Purpose**: Returns the broad category of a cloud bundle load failure. This lets callers make decisions, such as whether an authentication failure should prompt the user to sign in again.

**Data flow**: It reads the stored error code from the error value and returns it by copy. The error object is not modified.

**Call relations**: This accessor is used after a load attempt fails, when higher-level config code needs to react differently to different kinds of cloud failures.


##### `CloudConfigBundleLoadError::status_code`  (lines 173–175)

```
fn status_code(&self) -> Option<u16>
```

**Purpose**: Returns the optional HTTP status code attached to a cloud bundle load error. This preserves useful server-response detail without forcing every error to have a network status.

**Data flow**: It reads the stored optional status code and returns it. If there was no HTTP status involved, the result is `None`. The error object is not modified.

**Call relations**: This supports higher-level error reporting and decision-making after a failed cloud bundle request. It complements `code`, which gives the broader failure category.


##### `CloudConfigBundleLoader::new`  (lines 184–193)

```
fn new(fut: F) -> Self
```

**Purpose**: Builds a shared asynchronous loader around a future that will eventually produce an optional cloud config bundle. This prevents duplicate work when multiple callers need the same cloud bundle result.

**Data flow**: It receives a future, meaning a piece of work that will complete later. It boxes the future into a uniform heap-stored form, then makes it shared so cloned loaders wait on the same underlying work. It returns a `CloudConfigBundleLoader` holding that shared future.

**Call relations**: This is used when production code or tests provide the actual bundle-loading work. Later, callers use `CloudConfigBundleLoader::get` to await the result; the sharing means the original future is run once and its result is reused.

*Call graph*: called by 4 (cloud_config_bundle_loader, shared_future_runs_once, into_loader, load_config_layers_fails_when_cloud_config_bundle_loader_fails); 1 external calls (boxed).


##### `CloudConfigBundleLoader::get`  (lines 195–197)

```
async fn get(&self) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>
```

**Purpose**: Waits for the shared cloud bundle load to finish and returns its result. Callers use this when config loading reaches the point where it needs the cloud-provided bundle, if any.

**Data flow**: It clones the shared future handle, awaits it, and returns either an optional bundle or a load error. Cloning the handle does not restart the load; it just gives this caller a ticket to the same pending or completed result.

**Call relations**: This is the read side of `CloudConfigBundleLoader`. Any part of config loading that has a loader can call `get`, while `new` decides what work the loader represents.

*Call graph*: 1 external calls (clone).


##### `CloudConfigBundleLoader::fmt`  (lines 201–203)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a short debug representation for the loader. It deliberately prints only the loader’s type name, not the internals of the asynchronous work.

**Data flow**: It receives a formatter used by Rust’s debug-printing system. It writes a simple `CloudConfigBundleLoader` debug struct shape into that formatter and returns the formatting result.

**Call relations**: This is called automatically when code formats the loader with Rust’s debug output. It keeps logs and test failure messages readable without exposing or depending on the future’s internal details.

*Call graph*: 1 external calls (debug_struct).


##### `CloudConfigBundleLoader::default`  (lines 207–209)

```
fn default() -> Self
```

**Purpose**: Creates a loader that succeeds immediately with no cloud bundle. This gives tests and normal startup paths a safe fallback when cloud-managed config is not configured.

**Data flow**: It creates a tiny asynchronous task that returns `Ok(None)`, meaning “loading worked, but there is no bundle.” It passes that task to `CloudConfigBundleLoader::new` and returns the resulting loader.

**Call relations**: This is used widely by startup and tests that do not want remote cloud config involved. It still goes through `new`, so default loaders behave like any other shared loader.

*Call graph*: called by 34 (runtime_start_args_forward_environment_manager, runtime_start_args_use_remote_thread_config_loader_when_configured, start_test_client_with_capacity, without_managed_config_for_tests, invalid_user_value_rejected_even_if_overridden_by_managed, load_default_config_preserves_selected_user_config_path_after_load_error, read_includes_origins_and_layers, read_reports_managed_overrides_user_and_session_flags, write_value_defaults_to_selected_user_config_path, write_value_reports_managed_override (+15 more)); 1 external calls (new).


### `config/src/cloud_config_layers.rs`

`config` · `config load`

Cloud configuration arrives as a bundle of small text fragments. Each fragment has an id, a human name, and TOML contents, which is a common configuration text format. The rest of the application does not want loose text fragments; it wants a stack of configuration layers that can be combined in a predictable order, like stacking transparent sheets where higher sheets override lower ones.

This file is the adapter between those two worlds. For each cloud fragment, it parses the TOML text into structured data. If strict checking is requested, it also rejects unknown or ignored fields so mistakes in cloud-delivered configuration are caught early instead of being silently skipped. Then it resolves relative paths against the cloud configuration base directory, so a path like "logs/output" means the same thing no matter where the program was started from.

Finally, it wraps the parsed configuration into `ConfigLayerEntry` objects marked as enterprise-managed cloud configuration. One important detail is ordering: the backend sends fragments from highest priority to lowest priority, but the local config stack expects lowest priority first. So this file reverses the list before returning it. Without that reversal, weaker settings could accidentally override stronger enterprise settings.

#### Function details

##### `CloudConfigFragment::source_ref`  (lines 34–39)

```
fn source_ref(&self) -> CloudConfigFragmentSource
```

**Purpose**: Creates a small reference object that identifies a cloud config fragment by its id and name. This is used when reporting errors, so messages can say which cloud fragment caused the problem.

**Data flow**: It starts with a full `CloudConfigFragment`, which includes id, name, and contents. It copies only the id and name into a `CloudConfigFragmentSource`. The returned value is a lightweight label; the TOML contents are not included.

**Call relations**: The conversion flow uses this before parsing each fragment. If parsing or validation fails later, that source reference is carried into the error so the caller can understand which cloud-provided fragment needs attention.


##### `CloudConfigFragmentSource::fmt`  (lines 49–51)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a fragment source as readable text, combining the friendly name and the id. This makes error messages easier for humans to understand.

**Data flow**: It receives a `CloudConfigFragmentSource` and a formatter, then writes text in the form `name (id)`. Nothing else is changed; the result is the formatted text sent to the formatter.

**Call relations**: Strict validation turns the source reference into a string when building validation messages. This formatter is what decides how that source appears in those messages.

*Call graph*: 1 external calls (write!).


##### `cloud_config_layers_from_fragments`  (lines 68–73)

```
fn cloud_config_layers_from_fragments(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError>
```

**Purpose**: Converts cloud config fragments into config layers using normal, non-strict parsing. This is the convenient public path when unknown fields do not need to be rejected.

**Data flow**: It receives an iterable group of cloud fragments and the absolute base directory for cloud config files. It passes them onward with strict checking turned off. It returns either a list of config layer entries or an error describing the fragment that could not be parsed or converted.

**Call relations**: This is a simple front door into the shared conversion routine. It calls `cloud_config_layers_from_fragments_impl` so the main parsing and layer-building logic lives in one place.

*Call graph*: calls 1 internal fn (cloud_config_layers_from_fragments_impl).


##### `cloud_config_layers_from_fragments_strict`  (lines 75–80)

```
fn cloud_config_layers_from_fragments_strict(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError>
```

**Purpose**: Converts cloud config fragments into config layers while also rejecting unknown or ignored settings. This is useful when cloud bundles should be checked carefully before being accepted.

**Data flow**: It receives cloud fragments and a base directory, then calls the shared conversion routine with strict checking turned on. The output is either validated config layers or a cloud config layer error.

**Call relations**: This function is used by `from_bundle_impl` when a cloud config bundle needs stricter validation. It delegates the real work to `cloud_config_layers_from_fragments_impl`, changing only the strictness flag.

*Call graph*: calls 1 internal fn (cloud_config_layers_from_fragments_impl); called by 1 (from_bundle_impl).


##### `cloud_config_layers_from_fragments_impl`  (lines 82–121)

```
fn cloud_config_layers_from_fragments_impl(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
    strict_config: bool,
) -> Result<Vec<ConfigLayerEntry>, Cl
```

**Purpose**: Does the main work of turning cloud TOML fragments into ordered config layers. It parses text, optionally validates it strictly, resolves relative paths, wraps each result as an enterprise-managed config layer, and fixes the priority order.

**Data flow**: It takes cloud fragments, a base directory, and a true-or-false strictness setting. For each fragment, it saves a source label, parses the TOML text, optionally validates that no ignored fields are present, resolves relative paths against the base directory, and creates a `ConfigLayerEntry` with both the processed data and original raw TOML. After all fragments are processed, it reverses the list and returns it. If any step fails, it returns an error tied to the specific fragment.

**Call relations**: Both public conversion functions feed into this shared routine. During its work it calls `validate_fragment_strictly` only when strict mode is enabled, calls `resolve_relative_paths_in_config_toml` so paths become stable absolute-or-base-relative meanings, and calls `ConfigLayerEntry::new_with_raw_toml` to hand the finished layer to the wider configuration stack.

*Call graph*: calls 4 internal fn (validate_fragment_strictly, resolve_relative_paths_in_config_toml, new_with_raw_toml, as_path); called by 2 (cloud_config_layers_from_fragments, cloud_config_layers_from_fragments_strict); 3 external calls (new, from_str, clone).


##### `validate_fragment_strictly`  (lines 123–141)

```
fn validate_fragment_strictly(
    source_ref: &CloudConfigFragmentSource,
    raw_toml: &str,
    value: &TomlValue,
    base_dir: &AbsolutePathBuf,
) -> Result<(), CloudConfigLayerError>
```

**Purpose**: Checks one cloud fragment for configuration fields that would otherwise be ignored. This helps catch typos or unsupported settings instead of letting cloud policy appear to apply when it does not.

**Data flow**: It receives the fragment label, the raw TOML text, the already-parsed TOML value, and the base directory. It temporarily establishes the base directory as the path context, asks the strict config checker whether any fields would be ignored, and returns success if none are found. If a problem is found, it returns an invalid-fragment error with a human-readable message.

**Call relations**: The main conversion routine calls this only in strict mode. It relies on `config_error_from_ignored_toml_value_fields_for_source_name` to compare the parsed TOML against the expected `ConfigToml` shape, then sends any validation failure back up so layer creation stops.

*Call graph*: calls 2 internal fn (as_path, new); called by 1 (cloud_config_layers_from_fragments_impl); 3 external calls (clone, clone, to_string).


##### `Error::from`  (lines 144–146)

```
fn from(error: CloudConfigLayerError) -> Self
```

**Purpose**: Converts a cloud config layer error into a standard input/output error. This lets code that already works with `io::Error` report cloud config parse or validation failures without needing a separate error type.

**Data flow**: It receives a `CloudConfigLayerError`. It wraps that error inside a new `io::Error` marked as `InvalidData`, then returns the standard error value.

**Call relations**: This is a bridge to Rust's common I/O error flow. When another part of the config-loading path expects an `io::Error`, this conversion preserves the original cloud config error inside a familiar wrapper.

*Call graph*: 1 external calls (new).


### `config/src/loader/layer_io.rs`

`config` · `config load`

This file is part of the configuration loading path. Its job is to look for administrator-controlled configuration, read it safely, parse it as TOML, and report clear errors if the file is broken. TOML is a human-readable settings format, similar in spirit to an INI file.

The main flow starts with `load_config_layers_internal`. It chooses where the managed config should come from. If the caller supplied an override path, it uses that. Otherwise it falls back to a default path: on Unix systems, `/etc/codex/managed_config.toml`; on other systems, a file under the Codex home directory. It then asks `read_config_from_path` to read and parse that file.

On macOS, there is a second possible source: managed preferences from mobile device management, often called MDM. That is a way for an organization to push settings onto a Mac. This file calls the macOS-specific loader and reshapes its result into the same kind of managed config layer.

A key detail is strict mode. When strict config is enabled, the file does not merely check whether the TOML syntax is valid. It also rejects fields that the real Codex config type would ignore. This helps catch typos like `modle = "x"` instead of `model = "x"`, which might otherwise silently do nothing.

#### Function details

##### `load_config_layers_internal`  (lines 42–93)

```
async fn load_config_layers_internal(
    fs: &dyn ExecutorFileSystem,
    codex_home: &Path,
    overrides: LoaderOverrides,
    strict_config: bool,
) -> io::Result<LoadedConfigLayers>
```

**Purpose**: Loads administrator-controlled configuration layers from the places Codex supports. It checks the managed config file path, reads that file if present, and on macOS also reads managed preferences supplied by device management.

**Data flow**: It receives a file-system interface, the Codex home directory, optional loader overrides, and a strict-mode flag. It chooses the managed config path, makes sure that path is absolute, reads and parses the file, optionally loads macOS managed preferences, and returns a `LoadedConfigLayers` value containing whichever layers were found. If a path is invalid, a file cannot be read, or the TOML is invalid, it returns an input/output style error instead.

**Call relations**: This is called by `load_config_layers_state` when the wider config loader is gathering its inputs. It delegates file reading to `read_config_from_path`, uses `from_absolute_path` to enforce an absolute path, and on macOS hands off to `load_managed_admin_config_layer` for MDM-managed preferences.

*Call graph*: calls 3 internal fn (read_config_from_path, load_managed_admin_config_layer, from_absolute_path); called by 1 (load_config_layers_state).


##### `map_managed_admin_layer`  (lines 96–102)

```
fn map_managed_admin_layer(layer: ManagedAdminConfigLayer) -> ManagedConfigFromMdm
```

**Purpose**: Converts the macOS-specific managed preferences result into this file’s generic managed-config shape. This keeps the rest of the loader from needing to know the exact macOS helper type.

**Data flow**: It receives a `ManagedAdminConfigLayer`, pulls out the parsed config and the original raw TOML text, and returns a `ManagedConfigFromMdm` containing the same two pieces of information under the names used by this loader.

**Call relations**: On macOS, `load_config_layers_internal` uses this after `load_managed_admin_config_layer` returns data. It acts as a small adapter between the macOS-specific loader and the cross-platform `LoadedConfigLayers` result.


##### `read_config_from_path`  (lines 104–142)

```
async fn read_config_from_path(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    log_missing_as_info: bool,
    strict_config: bool,
) -> io::Result<Option<TomlValue>>
```

**Purpose**: Reads one TOML config file from disk and turns it into parsed TOML data. It treats a missing file as normal, but treats unreadable files or malformed TOML as real errors.

**Data flow**: It receives a file-system interface, an absolute path, a flag controlling how loudly to log missing files, and a strict-mode flag. It converts the path into the URI form used by the file-system layer, reads the text, parses the text as TOML, and optionally validates it strictly. If the file exists and is valid, it returns `Some(parsed_value)`. If the file is missing, it logs that fact and returns `None`. If reading or parsing fails, it logs the problem and returns an error with config-specific detail where possible.

**Call relations**: `load_config_layers_internal` calls this when it wants the managed config file. This function hands off raw file access to `read_file_text`, converts TOML parse failures with `config_error_from_toml` and `io_error_from_config_error`, and calls `validate_config_toml_strictly` when strict checking is requested.

*Call graph*: calls 6 internal fn (config_error_from_toml, io_error_from_config_error, validate_config_toml_strictly, read_file_text, as_path, from_abs_path); called by 1 (load_config_layers_internal); 3 external calls (debug!, error!, info!).


##### `validate_config_toml_strictly`  (lines 144–169)

```
fn validate_config_toml_strictly(
    path: &AbsolutePathBuf,
    contents: &str,
    value: &TomlValue,
) -> io::Result<()>
```

**Purpose**: Checks that a parsed TOML config does not contain fields Codex would ignore. This is a safety net for administrator settings, where a misspelled option should be reported instead of silently skipped.

**Data flow**: It receives the config file path, the original file contents, and the already-parsed TOML value. It first finds the file’s parent directory, because some validation needs a known base directory for paths. It then asks the strict-config checker whether any TOML fields would be ignored by `ConfigToml`. If none are found, it returns success. If the file has no parent directory or ignored fields are found, it returns an invalid-data error.

**Call relations**: `read_config_from_path` calls this only after the TOML syntax has parsed successfully and strict mode is enabled. This function relies on `config_error_from_ignored_toml_value_fields` to find suspicious fields and uses `io_error_from_config_error` to turn that finding into the same kind of error the loader already understands.

*Call graph*: calls 3 internal fn (io_error_from_config_error, as_path, new); called by 1 (read_config_from_path); 3 external calls (clone, new, format!).


##### `managed_config_default_path`  (lines 172–183)

```
fn managed_config_default_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Chooses the default location for the managed configuration file when the caller did not provide one. This gives Codex a predictable place to look for administrator settings.

**Data flow**: It receives the Codex home directory. On Unix systems, it ignores that directory and returns `/etc/codex/managed_config.toml`, a system-wide location. On non-Unix systems, it returns `managed_config.toml` inside the Codex home directory.

**Call relations**: `load_config_layers_internal` calls this while deciding which managed config path to read. The returned path is then converted to an absolute path and passed into `read_config_from_path`.

*Call graph*: 2 external calls (join, from).


### `config/src/loader/macos.rs`

`config` · `config load`

This file is the macOS-specific bridge between Apple device management and Codex configuration. In many companies, administrators push settings to Macs through MDM, or Mobile Device Management. macOS exposes those pushed settings through “Managed Preferences.” This file looks in the Codex preference domain, reads two known keys, decodes their values, and prepares them for the rest of the config system.

The values are expected to be base64 text. Base64 is a safe way to store arbitrary text inside systems that prefer simple strings. After decoding, one value is parsed as TOML configuration, and the other is kept as TOML requirements text. TOML is a human-readable configuration format.

The file also supports test or command-line overrides: if an override string is supplied, it uses that instead of asking macOS. Empty override strings mean “no managed layer.” Because reading CoreFoundation preferences is blocking system work, the async public loaders run the macOS calls inside a blocking task so they do not stall the async runtime.

A key safety feature is strict validation. When strict config is enabled, the managed config is checked for unknown or ignored fields, so an administrator does not accidentally deploy a misspelled setting that silently does nothing. Without this file, managed Macs could not receive Codex policy through standard Apple administration tools.

#### Function details

##### `managed_preferences_requirements_source`  (lines 30–35)

```
fn managed_preferences_requirements_source() -> RequirementSource
```

**Purpose**: This function creates a small label describing where managed requirements came from. The rest of the system can use that label in diagnostics so a person knows the policy came from macOS Managed Preferences, not from a local file.

**Data flow**: It reads the built-in application domain and requirements key constants, puts them into a RequirementSource value, and returns that value. It does not read the preference itself or change anything.

**Call relations**: When requirements text is successfully loaded, load_managed_admin_requirements_layer uses this function to tag the resulting RequirementsLayerEntry with its origin. That source tag travels with the requirements so later errors or reports can point back to the managed preference key.


##### `load_managed_admin_config_layer`  (lines 37–63)

```
async fn load_managed_admin_config_layer(
    override_base64: Option<&str>,
    strict_config: bool,
    base_dir: &Path,
) -> io::Result<Option<ManagedAdminConfigLayer>>
```

**Purpose**: This is the async entry point for loading administrator-managed config on macOS. It either uses a supplied override value or asks macOS for the managed preference, then returns a parsed config layer if one exists.

**Data flow**: It receives an optional base64 string, a strict-validation flag, and a base directory used during validation. If the override is present, it trims it: an empty string becomes no config, and a non-empty string is decoded and parsed. If there is no override, it copies the base directory and runs the macOS preference read in a blocking task. The result is either no layer, a ManagedAdminConfigLayer, or an input/output error explaining what failed.

**Call relations**: The wider config loader calls this during config assembly. This function keeps the async config-loading flow responsive by handing the blocking macOS work to load_managed_admin_config through spawn_blocking. When raw text must be interpreted, it hands off to parse_managed_config_base64. If the background task itself fails or is cancelled, it logs the problem and returns a general load failure.

*Call graph*: calls 1 internal fn (parse_managed_config_base64); called by 1 (load_config_layers_internal); 4 external calls (to_path_buf, other, spawn_blocking, error!).


##### `load_managed_admin_config`  (lines 65–74)

```
fn load_managed_admin_config(
    strict_config: bool,
    base_dir: &Path,
) -> io::Result<Option<ManagedAdminConfigLayer>>
```

**Purpose**: This synchronous helper reads the managed config preference directly from macOS and parses it if present. It is separated from the async wrapper because CoreFoundation preference access is blocking system work.

**Data flow**: It takes the strict-validation flag and base directory. It asks macOS for the configured managed config key. If no value is found, it returns no config. If a value is found, it trims surrounding whitespace and sends the base64 text through the config parser, returning either a parsed layer or an error.

**Call relations**: load_managed_admin_config_layer runs this helper inside a blocking task when there is no override. This helper depends on load_managed_preference for the actual macOS lookup and then relies on the same parsing path used for overrides, so managed values and override values are treated consistently.

*Call graph*: calls 1 internal fn (load_managed_preference).


##### `load_managed_admin_requirements_layer`  (lines 76–106)

```
async fn load_managed_admin_requirements_layer(
    override_base64: Option<&str>,
) -> io::Result<Option<RequirementsLayerEntry>>
```

**Purpose**: This is the async entry point for loading administrator-managed requirements on macOS. Requirements are policy-like TOML text that the rest of the configuration system can apply as a layer.

**Data flow**: It receives an optional base64 override. If the override is present, it trims it and treats an empty value as no requirements. A non-empty value is decoded into text and wrapped in a RequirementsLayerEntry with a source label. If there is no override, it runs the macOS preference read in a blocking task, then wraps any returned text the same way. The output is either no layer, a requirements layer, or an input/output error.

**Call relations**: The config layer state builder calls this when collecting all configuration-related inputs. This function calls parse_managed_requirements_base64 for the text conversion and uses managed_preferences_requirements_source to identify where the requirements came from. If it must read from macOS, it delegates to load_managed_admin_requirements in a blocking task and logs task failures.

*Call graph*: calls 1 internal fn (parse_managed_requirements_base64); called by 1 (load_config_layers_state); 3 external calls (other, spawn_blocking, error!).


##### `load_managed_admin_requirements`  (lines 108–114)

```
fn load_managed_admin_requirements() -> io::Result<Option<String>>
```

**Purpose**: This synchronous helper reads the managed requirements preference from macOS and decodes it if it exists. It is the blocking counterpart to the async requirements loader.

**Data flow**: It asks macOS for the requirements key. If macOS has no value for that key, it returns no requirements. If a value exists, it trims whitespace, decodes the base64 content into a UTF-8 string, and returns that string or an error if decoding fails.

**Call relations**: load_managed_admin_requirements_layer runs this helper inside a blocking task when no override is supplied. The helper uses load_managed_preference for the platform-specific preference lookup and parse_managed_requirements_base64 for the shared decoding step.

*Call graph*: calls 1 internal fn (load_managed_preference).


##### `load_managed_preference`  (lines 116–138)

```
fn load_managed_preference(key_name: &str) -> io::Result<Option<String>>
```

**Purpose**: This function is the direct macOS preference reader. Given a preference key, it asks Apple’s CoreFoundation APIs for the value stored under Codex’s managed preference domain.

**Data flow**: It receives a key name such as the managed config key or requirements key. It builds CoreFoundation strings for the key and the Codex application domain, calls CFPreferencesCopyAppValue, and checks whether macOS returned a value. If nothing is found, it logs a debug message and returns None. If a value exists, it wraps the native CoreFoundation string safely enough to convert it into a Rust String, then returns it.

**Call relations**: The two synchronous loaders, load_managed_admin_config and load_managed_admin_requirements, call this whenever they need the raw managed preference. This is the only place in the file that talks directly to CoreFoundation, so the rest of the code can work with ordinary Rust strings instead of macOS native pointers.

*Call graph*: called by 2 (load_managed_admin_config, load_managed_admin_requirements); 3 external calls (new, wrap_under_create_rule, debug!).


##### `parse_managed_config_base64`  (lines 140–182)

```
fn parse_managed_config_base64(
    encoded: &str,
    strict_config: bool,
    base_dir: &Path,
) -> io::Result<ManagedAdminConfigLayer>
```

**Purpose**: This function turns the administrator’s base64-encoded managed config into a usable config layer. It also checks that the decoded text is valid TOML and, when requested, that it does not contain ignored or unknown settings.

**Data flow**: It receives base64 text, a strict-validation flag, and a base directory. First it decodes the base64 into raw TOML text. Then it parses that text into a TOML value. If parsing fails, it logs the error and returns either a rich strict-config diagnostic or a simpler invalid-data error. If parsing succeeds, it optionally runs strict validation. Finally, it requires the TOML root to be a table, because config needs key-value structure at the top level. On success it returns a ManagedAdminConfigLayer containing both the parsed table and the original raw TOML text.

**Call relations**: load_managed_admin_config_layer reaches this function for both override-based config and macOS-read config. It delegates byte and text decoding to decode_managed_preferences_base64, then delegates strict unknown-field checking to validate_managed_config_toml_strictly_if_requested. Its output is the managed config layer that the broader config loader can merge with other config sources.

*Call graph*: calls 2 internal fn (decode_managed_preferences_base64, validate_managed_config_toml_strictly_if_requested); called by 1 (load_managed_admin_config_layer); 4 external calls (Table, new, format!, error!).


##### `validate_managed_config_toml_strictly_if_requested`  (lines 184–208)

```
fn validate_managed_config_toml_strictly_if_requested(
    strict_config: bool,
    source_name: &str,
    raw_toml: &str,
    parsed: &TomlValue,
    base_dir: &Path,
) -> io::Result<()>
```

**Purpose**: This function performs the extra “be picky” validation for managed config when strict mode is enabled. Its main job is to catch settings that would otherwise be ignored, such as misspelled field names.

**Data flow**: It receives the strict flag, a human-readable source name, the raw TOML text, the parsed TOML value, and a base directory. If strict mode is off, it immediately returns success. If strict mode is on, it temporarily sets up the base directory context and asks the strict config checker whether the parsed TOML contains ignored fields for the ConfigToml shape. If the checker finds a problem, it converts that config diagnostic into an input/output error; otherwise it returns success.

**Call relations**: parse_managed_config_base64 calls this after TOML parsing and before accepting the managed config. This keeps validation close to the point where managed policy enters the system, so bad administrator-provided settings are rejected early with useful diagnostics.

*Call graph*: calls 2 internal fn (io_error_from_config_error, new); called by 1 (parse_managed_config_base64); 1 external calls (clone).


##### `parse_managed_requirements_base64`  (lines 210–212)

```
fn parse_managed_requirements_base64(encoded: &str) -> io::Result<String>
```

**Purpose**: This function decodes the administrator’s managed requirements value from base64 into plain text. It is small because requirements are not parsed here; they are passed on as TOML text for the requirements layer system.

**Data flow**: It receives a base64 string, passes it to the shared decoder, and returns the decoded UTF-8 string or an invalid-data error. It does not change the text or inspect the TOML structure.

**Call relations**: load_managed_admin_requirements_layer uses this for override values, and load_managed_admin_requirements uses it for values read from macOS. By sharing the same decoder, both paths accept and reject requirements data in the same way.

*Call graph*: calls 1 internal fn (decode_managed_preferences_base64); called by 1 (load_managed_admin_requirements_layer).


##### `decode_managed_preferences_base64`  (lines 214–223)

```
fn decode_managed_preferences_base64(encoded: &str) -> io::Result<String>
```

**Purpose**: This function performs the common low-level decoding step for managed preference values. It turns base64 into a normal UTF-8 string and reports clear errors when the stored value is not usable text.

**Data flow**: It receives a base64-encoded string. It decodes the base64 bytes; if that fails, it logs the decoding problem and returns an invalid-data error. Then it tries to interpret the decoded bytes as UTF-8 text; if that fails, it logs that the contents were not valid text and returns another invalid-data error. On success, it returns the decoded string.

**Call relations**: Both parse_managed_config_base64 and parse_managed_requirements_base64 call this before doing anything more specific. It is the shared gatekeeper that ensures managed preference values are real text before the config and requirements loaders try to use them.

*Call graph*: called by 2 (parse_managed_config_base64, parse_managed_requirements_base64); 1 external calls (from_utf8).


### Diagnostics and strict validation
These files turn parse and schema problems into precise user-facing errors and enforce strict unknown-field validation across loaded layers.

### `config/src/diagnostics.rs`

`domain_logic` · `config load and validation`

Configuration errors are frustrating when they only say “invalid value” or “failed to parse.” This file solves that by connecting low-level TOML parsing and validation failures back to something a person can act on: a filename, a line, a column, and a short message. Think of it like adding a street address to a complaint, instead of just saying something went wrong somewhere in town.

The file defines small location types for text positions and ranges, plus `ConfigError`, which is the project’s plain record of “what went wrong and where.” It can wrap that error as an ordinary input/output error so the rest of the program can return it through normal error paths.

It also knows how to inspect TOML source text. TOML is the config file format used here. When deserializing TOML into a typed Rust config structure fails, this file uses the error path, such as `features.some_option`, to find the matching TOML item and highlight it. If the exact span is unavailable, it falls back to line 1, column 1 rather than crashing.

A larger helper walks through config layers, such as system, user, and project config, looking for the first concrete file or raw TOML layer that explains a merged-config validation failure. That makes the final message point at the real source file instead of an abstract combined config.

#### Function details

##### `ConfigError::new`  (lines 44–50)

```
fn new(path: PathBuf, range: TextRange, message: impl Into<String>) -> Self
```

**Purpose**: Creates a single clear config error record with a file path, a text range, and a human-readable message. Other parts of the config system use this as the standard shape for reporting mistakes.

**Data flow**: It receives a path, a start-to-end text range, and any message-like value. It converts the message into a string and returns a `ConfigError` containing all three pieces.

**Call relations**: This is the common final step after several diagnostic helpers have worked out where an error belongs. TOML parsing helpers, typed-validation helpers, ignored-field checks, and unknown-field checks all call it once they have a location and message.

*Call graph*: called by 4 (config_error_from_toml_for_source, config_error_from_typed_toml_for_source, config_error_from_ignored_toml_value_fields_for_source, unknown_field_error_from_paths); 1 external calls (into).


##### `ConfigLoadError::new`  (lines 60–62)

```
fn new(error: ConfigError, source: Option<toml::de::Error>) -> Self
```

**Purpose**: Wraps a `ConfigError` together with an optional original TOML parsing error. This preserves both the friendly message and the lower-level cause for error-reporting tools.

**Data flow**: It receives the project’s friendly `ConfigError` and, optionally, the TOML library’s own error. It stores both and returns a `ConfigLoadError`.

**Call relations**: It is used by `io_error_from_config_error` when config loading needs to turn a config-specific problem into a regular input/output error that callers already know how to pass around.

*Call graph*: called by 1 (io_error_from_config_error).


##### `ConfigLoadError::config_error`  (lines 64–66)

```
fn config_error(&self) -> &ConfigError
```

**Purpose**: Gives callers access to the friendly `ConfigError` inside a `ConfigLoadError`. This is useful when code catches the broader load error but wants the file, range, and message directly.

**Data flow**: It reads the stored error from `self` and returns a borrowed reference to it. Nothing is changed.

**Call relations**: This is an accessor used after a config load failure has already been created, so other code can inspect the structured diagnostic instead of only seeing formatted text.


##### `ConfigLoadError::fmt`  (lines 70–79)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a config load error appears as plain text. It prints the path, line, column, and message in a compact form.

**Data flow**: It reads the stored `ConfigError`, writes `path:line:column: message` into the formatter, and returns whether formatting succeeded.

**Call relations**: Rust calls this automatically when a `ConfigLoadError` is displayed, logged, or included in another error message. It is the short one-line version of the diagnostic.

*Call graph*: 1 external calls (write!).


##### `ConfigLoadError::source`  (lines 83–87)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the lower-level TOML parsing error, if one exists, as the cause of this error. This helps error chains show both the friendly project message and the original parser failure.

**Data flow**: It checks whether a source TOML error was stored. If so, it returns it as a generic error reference; otherwise it returns nothing.

**Call relations**: Rust’s standard error machinery calls this when building an error chain. It connects `ConfigLoadError` back to the parser error that caused it.


##### `ConfigDiagnosticSource::to_path_buf`  (lines 97–102)

```
fn to_path_buf(self) -> PathBuf
```

**Purpose**: Turns a diagnostic source into a path-like value for display and storage. The source may be a real file path or just a display name for a non-file config layer.

**Data flow**: It receives either `Path(...)` or `DisplayName(...)`. For a real path, it copies that path; for a display name, it creates a path buffer from the name text.

**Call relations**: The TOML diagnostic builders call this when creating `ConfigError` values. It lets the same error type work for both real files and in-memory or managed config layers.

*Call graph*: called by 4 (config_error_from_toml_for_source, config_error_from_typed_toml_for_source, config_error_from_ignored_toml_value_fields_for_source, unknown_field_error_from_paths); 1 external calls (from).


##### `io_error_from_config_error`  (lines 105–111)

```
fn io_error_from_config_error(
    kind: io::ErrorKind,
    error: ConfigError,
    source: Option<toml::de::Error>,
) -> io::Error
```

**Purpose**: Converts a config diagnostic into a normal `io::Error`, which is Rust’s common error type for file and input/output work. This lets config validation failures travel through APIs that already return I/O errors.

**Data flow**: It receives an I/O error kind, a friendly `ConfigError`, and an optional TOML source error. It wraps them in `ConfigLoadError`, then wraps that in `io::Error` and returns it.

**Call relations**: Config reading and validation paths call this when they need to fail with a precise config message while still matching the expected I/O-style error return type.

*Call graph*: calls 1 internal fn (new); called by 5 (read_config_from_path, validate_config_toml_strictly, load_config_layers_state, validate_managed_config_toml_strictly_if_requested, validate_config_toml_strictly); 1 external calls (new).


##### `config_error_from_toml`  (lines 113–119)

```
fn config_error_from_toml(
    path: impl AsRef<Path>,
    contents: &str,
    err: toml::de::Error,
) -> ConfigError
```

**Purpose**: Builds a friendly `ConfigError` from a TOML parser error for a real file path. Use it when raw TOML could not be parsed correctly.

**Data flow**: It receives a path, the file contents, and the TOML parser’s error. It turns the path into a diagnostic source and delegates to the more general source-aware helper, which finds the text range and builds the result.

**Call relations**: Config file reading code calls this after the TOML library reports a parse problem. It hands the work to `config_error_from_toml_for_source` so file paths and display-only layer names can share the same logic.

*Call graph*: calls 1 internal fn (config_error_from_toml_for_source); called by 1 (read_config_from_path); 2 external calls (as_ref, Path).


##### `config_error_from_toml_for_source`  (lines 121–131)

```
fn config_error_from_toml_for_source(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    err: toml::de::Error,
) -> ConfigError
```

**Purpose**: Converts a TOML parser error into the project’s standard `ConfigError`, using either a real path or a display name as the source. It tries to point at the exact span reported by the parser.

**Data flow**: It receives a diagnostic source, the TOML text, and the parser error. If the parser supplies a byte span, it converts that span into line and column positions; otherwise it uses the default position. It returns a new `ConfigError` with the parser’s message.

**Call relations**: This is the shared TOML parse-error converter. It is called by the path-specific wrapper, by typed TOML validation when parsing fails before validation can start, and by other config diagnostics that need the same source-to-location behavior.

*Call graph*: calls 2 internal fn (to_path_buf, new); called by 3 (config_error_from_toml, config_error_from_typed_toml_for_source, config_error_from_ignored_toml_fields); 2 external calls (message, span).


##### `config_error_from_typed_toml`  (lines 133–141)

```
fn config_error_from_typed_toml(
    path: impl AsRef<Path>,
    contents: &str,
) -> Option<ConfigError>
```

**Purpose**: Checks whether TOML text can be read into a specific expected config type, and returns a friendly error if not. This is for validation failures where the TOML syntax may be fine but the shape or values do not match the config schema.

**Data flow**: It receives a file path and TOML contents. It wraps the path as the diagnostic source and asks the source-aware typed helper to parse and validate the text. It returns `None` if the typed config is valid, or a `ConfigError` if not.

**Call relations**: This is the public file-path entry point for typed config diagnostics. The deeper helper does the actual parse, validation, and range selection.

*Call graph*: 2 external calls (as_ref, Path).


##### `config_error_from_typed_toml_for_source`  (lines 143–169)

```
fn config_error_from_typed_toml_for_source(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
) -> Option<ConfigError>
```

**Purpose**: Validates TOML text against an expected Rust config type and tries to locate the exact TOML item that caused the failure. This gives users a useful pointer for errors like wrong value type or invalid nested field.

**Data flow**: It first asks the TOML library to parse the text. If parsing fails, it returns a parse-style `ConfigError`. If parsing succeeds, it tries to deserialize into the requested type while tracking the failing field path. On failure, it uses that path to find a TOML span, falls back to the parser span if needed, then returns a `ConfigError`; on success it returns `None`.

**Call relations**: Layer-diagnostic code and the public typed-TOML wrapper rely on this as the main typed validation checker. It hands path lookup to `span_for_config_path` and final error construction to `ConfigError::new`.

*Call graph*: calls 4 internal fn (to_path_buf, new, config_error_from_toml_for_source, span_for_config_path); 2 external calls (deserialize, parse).


##### `first_layer_config_error`  (lines 171–186)

```
async fn first_layer_config_error(
    layers: &ConfigLayerStack,
    config_toml_file: &str,
) -> Option<ConfigError>
```

**Purpose**: Finds the first concrete config layer that explains a merged-config validation error. This helps the user see the real file or layer to fix instead of an unhelpful error about the merged result.

**Data flow**: It receives a config layer stack and the config TOML filename. It asks the stack for layers from lowest to highest precedence, excluding disabled layers, then searches them for the first typed TOML validation error. It returns that error or `None` if none is found.

**Call relations**: This is the main layer-stack entry point. It gets ordered layers from `ConfigLayerStack` and then uses the shared per-entry search logic to inspect each layer.

*Call graph*: calls 1 internal fn (get_layers).


##### `first_layer_config_error_from_entries`  (lines 188–193)

```
async fn first_layer_config_error_from_entries(
    layers: &[ConfigLayerEntry],
    config_toml_file: &str,
) -> Option<ConfigError>
```

**Purpose**: Runs the same “find the first layer error” search on a plain slice of layer entries. This is useful when the caller already has selected entries instead of a full layer stack.

**Data flow**: It receives a list of config layer entries and the config TOML filename. It iterates over those entries and returns the first `ConfigError` found by the shared search logic, or `None` if all entries validate or cannot be inspected.

**Call relations**: This is a convenience wrapper around the shared layer-search routine. It starts from an existing entries slice rather than asking a stack to produce ordered layers.

*Call graph*: 1 external calls (iter).


##### `first_layer_config_error_for_entries`  (lines 195–247)

```
async fn first_layer_config_error_for_entries(
    layers: I,
    config_toml_file: &str,
) -> Option<ConfigError>
```

**Purpose**: Walks through config layers one by one and validates each layer’s raw TOML or file contents until it finds the first specific error. This is the workhorse behind the layer-level diagnostics.

**Data flow**: It receives an iterable set of layer entries and a config filename. For raw TOML layers, it builds a display name, sets the right base directory for resolving relative paths, and validates the text. For file-backed layers, it finds the file path, reads the file if it exists, sets the file’s parent as the base directory, and validates the contents. It returns the first `ConfigError` it finds, or `None` after all layers pass or are skipped.

**Call relations**: The public layer helpers call into this when a merged config has failed validation. It uses `config_path_for_layer` to locate file-backed layers and uses the typed TOML diagnostic helpers to turn validation failures into source locations.

*Call graph*: calls 2 internal fn (config_path_for_layer, new); 4 external calls (DisplayName, format_config_layer_source, read_to_string, debug!).


##### `config_path_for_layer`  (lines 249–262)

```
fn config_path_for_layer(layer: &ConfigLayerEntry, config_toml_file: &str) -> Option<PathBuf>
```

**Purpose**: Works out which on-disk config file, if any, belongs to a config layer. Some layers come from real files, while others come from managed systems or command-line/session settings and have no file to read.

**Data flow**: It receives a layer entry and the expected config TOML filename. It matches the layer’s source type: system, user, project, and legacy file layers produce paths; managed or session-based layers produce `None`.

**Call relations**: The layer-search routine calls this before trying to read a config file from disk. If it returns no path, that layer is skipped for file-based diagnostics.

*Call graph*: called by 1 (first_layer_config_error_for_entries).


##### `text_range_from_span`  (lines 264–273)

```
fn text_range_from_span(contents: &str, span: std::ops::Range<usize>) -> TextRange
```

**Purpose**: Converts a raw byte span from a parser into human-friendly line and column coordinates. This is what turns “bytes 42 through 48” into “line 3, columns 5 through 11.”

**Data flow**: It receives the full text and a byte range. It converts the start byte and the last byte of the span into `TextPosition` values, then returns a `TextRange` containing both.

**Call relations**: TOML parse and validation diagnostic builders use this whenever a library reports a byte span. It delegates the byte-to-line-column calculation to `position_for_offset`.

*Call graph*: calls 1 internal fn (position_for_offset).


##### `format_config_error`  (lines 275–309)

```
fn format_config_error(error: &ConfigError, contents: &str) -> String
```

**Purpose**: Formats a config error as a readable message with the bad source line and caret marks under the problem area. This is the friendly version a person can copy from a terminal.

**Data flow**: It receives a `ConfigError` and the file contents. It writes a header with path, line, column, and message, then looks up the relevant source line. If the line exists, it prints a gutter, the line itself, and one or more `^` carets under the highlighted columns. It returns the finished string.

**Call relations**: The source-reading formatter calls this after it has loaded file contents. Other code can also call it directly when it already has the contents available.

*Call graph*: called by 1 (format_config_error_with_source); 2 external calls (new, writeln!).


##### `format_config_error_with_source`  (lines 311–316)

```
fn format_config_error_with_source(error: &ConfigError) -> String
```

**Purpose**: Formats a config error and tries to include the source line by reading the file from disk. It is a convenience function for turning a stored diagnostic into a full display message.

**Data flow**: It receives a `ConfigError`. It tries to read the file named in the error; if that succeeds, it formats the error with the contents. If reading fails, it still formats the header without a source line.

**Call relations**: This wraps `format_config_error` for callers that do not already have the config text. It keeps diagnostics useful even when the file cannot be read later.

*Call graph*: calls 1 internal fn (format_config_error); 1 external calls (read_to_string).


##### `position_for_offset`  (lines 318–347)

```
fn position_for_offset(contents: &str, index: usize) -> TextPosition
```

**Purpose**: Finds the 1-based line and column for a byte offset in a text string. It accounts for multi-byte UTF-8 characters so columns match what a person sees, not just raw bytes.

**Data flow**: It receives the full text and a byte index. It clamps the index to a safe in-bounds value, finds the start of the current line, counts earlier newlines, and counts visible characters from the line start to the index. It returns a `TextPosition`.

**Call relations**: Only `text_range_from_span` calls this. It is the low-level measuring tool that makes parser byte spans usable in human-facing diagnostics.

*Call graph*: called by 1 (text_range_from_span); 1 external calls (from_utf8).


##### `default_range`  (lines 349–355)

```
fn default_range() -> TextRange
```

**Purpose**: Provides a safe fallback location when no exact position is available. It points to line 1, column 1.

**Data flow**: It creates one `TextPosition` at line 1, column 1 and uses it as both the start and end of a `TextRange`. It returns that range.

**Call relations**: Diagnostic builders use this when neither a parser span nor a path-derived span can be found. It prevents missing location data from breaking error reporting.


##### `span_for_path`  (lines 363–371)

```
fn span_for_path(contents: &str, path: &SerdePath) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the byte span in TOML text that matches a deserialization error path. An error path is a breadcrumb trail like “top-level table, then key, then array item.”

**Data flow**: It parses the TOML text into an editable document tree. It follows the supplied path through that tree with `node_for_path`, then returns the span for the matching item, table, or value if found.

**Call relations**: `span_for_config_path` calls this for the normal case. It relies on `node_for_path` to navigate the TOML document before extracting the final source span.

*Call graph*: calls 1 internal fn (node_for_path); called by 1 (span_for_config_path).


##### `span_for_config_path`  (lines 373–383)

```
fn span_for_config_path(
    contents: &str,
    path: &SerdePath,
) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the best TOML byte span for a config validation path, with a special case for the `features` table. This improves the highlighted location for feature settings that have invalid values.

**Data flow**: It receives TOML contents and a deserialization path. If the path points exactly to the `features` table, it first tries to find the first non-boolean feature value. Otherwise, or if that special lookup fails, it uses the general path-based span lookup.

**Call relations**: Typed TOML diagnostics call this when deserialization reports where validation failed. It chooses between the special `features` behavior and the general `span_for_path` traversal.

*Call graph*: calls 3 internal fn (is_features_table_path, span_for_features_value, span_for_path); called by 2 (config_error_from_typed_toml_for_source, config_error_from_ignored_toml_value_fields_for_source).


##### `span_for_toml_key_path`  (lines 385–425)

```
fn span_for_toml_key_path(
    contents: &str,
    path: &[String],
) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the span of a TOML key itself, not just its value. This is useful for messages about unknown or unsupported fields, where the key name is the thing to highlight.

**Data flow**: It receives TOML contents and a list of path segments as strings. It parses the TOML document, walks through tables, inline tables, and arrays, and when it reaches the final segment it tries to return the key’s own span. If that is not available, it returns the span of the final node.

**Call relations**: Unknown-field diagnostics call this to point directly at the unwanted key. It uses `map_child` and `seq_child` to move through nested TOML structures.

*Call graph*: calls 2 internal fn (map_child, seq_child); called by 1 (unknown_field_error_from_paths); 1 external calls (Item).


##### `is_features_table_path`  (lines 427–431)

```
fn is_features_table_path(path: &SerdePath) -> bool
```

**Purpose**: Checks whether a deserialization path refers exactly to the top-level `features` table. This identifies when the special feature-value highlighting rule should apply.

**Data flow**: It receives a serde error path, reads its segments, and returns true only if the first segment is the map key `features` and there are no more segments.

**Call relations**: `span_for_config_path` calls this before deciding whether to use `span_for_features_value`. It is a small gatekeeper for the special `features` case.

*Call graph*: called by 1 (span_for_config_path); 2 external calls (iter, matches!).


##### `span_for_features_value`  (lines 433–448)

```
fn span_for_features_value(contents: &str) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the first invalid-looking value inside the `features` table. In this config, feature entries are expected to be booleans, so a non-boolean value is a better thing to highlight than the whole table.

**Data flow**: It parses the TOML text, finds the top-level `features` table, then scans its entries. Boolean values are skipped. The first non-boolean value, nested table, or array-of-tables produces a span; if nothing suspicious is found, it returns `None`.

**Call relations**: `span_for_config_path` calls this only when the error path is exactly the `features` table. It gives that common validation failure a sharper location.

*Call graph*: called by 1 (span_for_config_path).


##### `node_for_path`  (lines 450–477)

```
fn node_for_path(item: &'a Item, path: &SerdePath) -> Option<TomlNode<'a>>
```

**Purpose**: Navigates a parsed TOML document according to a serde error path and returns the matching TOML node. It is the bridge between a validation error’s breadcrumb path and the source document tree.

**Data flow**: It receives the root TOML item and a path. It starts at the root and follows map keys, enum variants, and sequence indexes. If a key is not found but more path remains, it may skip ahead to keep searching; if navigation becomes impossible, it returns `None`. Otherwise it returns the final node.

**Call relations**: `span_for_path` calls this before asking the resulting node for its byte span. `node_for_path` uses `map_child` for table-like lookup and `seq_child` for array lookup.

*Call graph*: calls 2 internal fn (map_child, seq_child); called by 1 (span_for_path); 2 external calls (iter, Item).


##### `map_child`  (lines 479–489)

```
fn map_child(node: &TomlNode<'a>, key: &str) -> Option<TomlNode<'a>>
```

**Purpose**: Looks up a named child inside a TOML table-like node. This covers normal tables and inline tables.

**Data flow**: It receives the current TOML node and a key string. If the node can contain named entries, it returns the child item or value for that key; otherwise it returns `None`.

**Call relations**: Both `node_for_path` and `span_for_toml_key_path` use this while walking through nested TOML structures by key name.

*Call graph*: called by 2 (node_for_path, span_for_toml_key_path).


##### `seq_child`  (lines 491–498)

```
fn seq_child(node: &TomlNode<'a>, index: usize) -> Option<TomlNode<'a>>
```

**Purpose**: Looks up an indexed child inside a TOML array or array-of-tables. This lets diagnostics follow paths that point into lists.

**Data flow**: It receives the current TOML node and an index. If the node is an array-like value, it returns the item at that index as a TOML node; otherwise it returns `None`.

**Call relations**: Both `node_for_path` and `span_for_toml_key_path` use this when a diagnostic path includes an array position.

*Call graph*: called by 2 (node_for_path, span_for_toml_key_path).


### `config/src/strict_config.rs`

`config` · `config load and validation`

Configuration files are easy to get slightly wrong: a user might type a field name incorrectly, or enable a feature flag that the program does not recognize. If the program simply ignores that mistake, the user may think a setting is active when it is not. This file prevents that by comparing the TOML text against the Rust configuration type that is supposed to receive it.

The main flow is: parse the TOML, try to deserialize it into the expected config type, and watch for any fields that serde, the Rust serialization/deserialization library, leaves unused. Those unused fields are likely unknown settings. The file also performs a special check for feature keys, because feature maps can otherwise accept arbitrary-looking names unless they are checked against the known feature list.

When it finds a problem, it builds a `ConfigError` with a source name or file path, a text range pointing to the offending key when possible, and a human-readable message. Think of it like a proofreader for config files: it does not just say “something is wrong,” it tries to underline the exact word that caused trouble.

#### Function details

##### `config_error_from_ignored_toml_fields`  (lines 15–26)

```
fn config_error_from_ignored_toml_fields(
    path: impl AsRef<Path>,
    contents: &str,
) -> Option<ConfigError>
```

**Purpose**: This is the main public check for a TOML config file given as text. It reports either invalid TOML syntax or fields that the expected config type would ignore.

**Data flow**: It receives a file path and the raw TOML contents. First it tries to parse the text into a general TOML value; if parsing fails, it turns the TOML parser’s complaint into a `ConfigError`. If parsing succeeds, it passes the parsed value onward for strict unknown-field checking. The result is either a config error or `None` if no problem was found.

**Call relations**: This function is the file’s front door for callers that have TOML text and a path. It creates a diagnostic source from the path, uses the standard TOML parser, and then hands the successful parsed value to `config_error_from_ignored_toml_value_fields_for_source` so the deeper strict validation logic can run.

*Call graph*: calls 1 internal fn (config_error_from_toml_for_source); 2 external calls (as_ref, Path).


##### `config_error_from_ignored_toml_value_fields`  (lines 28–38)

```
fn config_error_from_ignored_toml_value_fields(
    path: impl AsRef<Path>,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError>
```

**Purpose**: This checks an already-parsed TOML value for fields that would be ignored by the expected config type. It is useful when another part of the program has already parsed the TOML but still wants strict validation with a file path in the error.

**Data flow**: It receives a path, the original text contents, and a parsed TOML value. It wraps the path as the error source and sends everything to the shared strict-validation routine. It returns a `ConfigError` if an unknown field or deserialization problem is found, otherwise `None`.

**Call relations**: This is a convenience wrapper around `config_error_from_ignored_toml_value_fields_for_source`. It does not do the validation itself; it prepares the source information and delegates to the common worker.

*Call graph*: 2 external calls (as_ref, Path).


##### `config_error_from_ignored_toml_value_fields_for_source_name`  (lines 40–50)

```
fn config_error_from_ignored_toml_value_fields_for_source_name(
    source_name: &str,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError>
```

**Purpose**: This checks an already-parsed TOML value, but labels errors with a display name instead of a real file path. That is useful for config text that came from a named source rather than a normal file.

**Data flow**: It receives a source name, the original TOML text, and a parsed TOML value. It builds a display-name diagnostic source and passes the value into the shared strict-validation routine. It returns an optional `ConfigError` describing the first problem found.

**Call relations**: Like the path-based wrapper, this function funnels work into `config_error_from_ignored_toml_value_fields_for_source`. Its role is to choose how the source should appear in any error message.

*Call graph*: 1 external calls (DisplayName).


##### `config_error_from_ignored_toml_value_fields_for_source`  (lines 52–85)

```
fn config_error_from_ignored_toml_value_fields_for_source(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError>
```

**Purpose**: This is the core strict-validation routine. It tries to deserialize the TOML into the expected config type while collecting any TOML keys that the type did not use, and it also checks for unknown feature names.

**Data flow**: It receives a diagnostic source, the original TOML text, and a parsed TOML value. Before deserializing, it scans for unknown feature keys. Then it deserializes the TOML through a wrapper that records ignored paths. If deserialization succeeds, it reports the first ignored normal field, or if none exists, the first unknown feature field. If deserialization fails, it locates the best text range for the failure and returns a `ConfigError` with the parser’s message.

**Call relations**: The public and crate-local wrapper functions all lead here. During the check it calls `unknown_feature_toml_value_path` to find bad feature keys, uses `ignored_path_segments` through the ignored-field callback to turn serde’s path objects into readable pieces, and calls `unknown_field_error_from_paths` to build a user-facing error for ignored keys.

*Call graph*: calls 5 internal fn (to_path_buf, new, span_for_config_path, unknown_feature_toml_value_path, unknown_field_error_from_paths); 3 external calls (new, new, deserialize).


##### `ignored_toml_value_field`  (lines 87–103)

```
fn ignored_toml_value_field(value: TomlValue) -> Option<String>
```

**Purpose**: This helper returns the name of the first field that would be ignored when a TOML value is deserialized into a given config type. It is a lightweight way to ask, “what unknown setting is present here?”

**Data flow**: It receives a parsed TOML value. It tries to deserialize that value while collecting ignored paths. If deserialization itself fails, it gives up and returns `None`, because the data is not valid enough to trust the ignored-field result. If deserialization succeeds and any ignored path was collected, it joins that path with dots and returns it as a string.

**Call relations**: This function uses the same ignored-field tracking idea as the main validator, but it only returns a field name rather than building a full `ConfigError`. It relies on `ignored_path_segments` to convert serde’s internal path format into plain path pieces.

*Call graph*: 2 external calls (new, deserialize).


##### `unknown_feature_toml_value_field`  (lines 105–110)

```
fn unknown_feature_toml_value_field(value: &TomlValue) -> Option<String>
```

**Purpose**: This helper returns the first unknown feature key found in a TOML value. It gives callers a simple string like `features.some_name` instead of a full diagnostic object.

**Data flow**: It receives a parsed TOML value by reference. It asks `unknown_feature_toml_value_path` for all unknown feature paths, takes the first one if present, joins its path parts with dots, and returns that string. If all feature keys are known, it returns `None`.

**Call relations**: This is called by `validate_cli_overrides_strictly`, which likely needs a compact answer while checking command-line-provided configuration overrides. Internally it delegates the real scanning work to `unknown_feature_toml_value_path`.

*Call graph*: calls 1 internal fn (unknown_feature_toml_value_path); called by 1 (validate_cli_overrides_strictly).


##### `unknown_field_error_from_paths`  (lines 112–127)

```
fn unknown_field_error_from_paths(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    ignored_paths: Vec<Vec<String>>,
) -> Option<ConfigError>
```

**Purpose**: This turns a collected unknown-field path into a clear `ConfigError`. It is the step that changes raw path pieces into a message a user can act on.

**Data flow**: It receives a diagnostic source, the original TOML text, and a list of unknown paths. If the list is empty, it returns `None`. Otherwise it takes the first path, tries to find that key’s exact position in the TOML text, falls back to a default range if needed, and returns an error saying the configuration field is unknown.

**Call relations**: The core validator calls this after successful deserialization finds ignored fields or unknown feature keys. This function depends on the diagnostic helpers to locate the key in the original text and on `ConfigError::new` to package the final error.

*Call graph*: calls 3 internal fn (to_path_buf, new, span_for_toml_key_path); called by 1 (config_error_from_ignored_toml_value_fields_for_source); 1 external calls (format!).


##### `unknown_feature_toml_value_path`  (lines 129–148)

```
fn unknown_feature_toml_value_path(value: &TomlValue) -> Vec<Vec<String>>
```

**Purpose**: This scans a parsed TOML config for feature names that are not recognized by the program. It looks both at top-level features and features inside named profiles.

**Data flow**: It receives a parsed TOML value. If the value is not a table, it returns an empty list. Otherwise it checks the top-level `features` table, then each `profiles.<name>.features` table, collecting full paths for any feature key that is not known. It returns all those paths as lists of strings.

**Call relations**: The main strict validator calls this before deserialization so unknown feature names are not missed. `unknown_feature_toml_value_field` also calls it when another part of the program only needs the first bad feature name. It delegates each individual features table to `push_unknown_feature_paths`.

*Call graph*: calls 1 internal fn (push_unknown_feature_paths); called by 2 (config_error_from_ignored_toml_value_fields_for_source, unknown_feature_toml_value_field); 2 external calls (as_table, new).


##### `push_unknown_feature_paths`  (lines 150–171)

```
fn push_unknown_feature_paths(
    paths: &mut Vec<Vec<String>>,
    prefix: &[&str],
    features: Option<&TomlValue>,
)
```

**Purpose**: This adds unknown feature keys from one specific `features` table into a shared list of paths. It is the small worker used for both top-level and profile-specific feature tables.

**Data flow**: It receives a mutable list of paths, a prefix such as `features` or `profiles.<profile>.features`, and an optional TOML value that should be a feature table. If there is no table, it does nothing. If there is a table, it checks each key against the known feature list and appends a full path for every unknown key.

**Call relations**: `unknown_feature_toml_value_path` calls this once for the top-level features and again for each profile’s features. This keeps the repeated “look through a feature table and record bad keys” logic in one place.

*Call graph*: called by 1 (unknown_feature_toml_value_path).


##### `ignored_path_segments`  (lines 173–177)

```
fn ignored_path_segments(path: &serde_ignored::Path<'_>) -> Vec<String>
```

**Purpose**: This converts serde’s ignored-field path object into ordinary string pieces. That makes an internal path such as a nested map or list location usable in user-facing messages.

**Data flow**: It receives a `serde_ignored::Path`, which is serde’s structured description of where an ignored value was found. It creates an empty list, fills it by walking the path, and returns the resulting string segments. For example, nested map keys become separate path parts.

**Call relations**: The ignored-field callbacks in the validation helpers call this whenever serde reports an unused field. It delegates the recursive walking to `push_ignored_path_segments`.

*Call graph*: calls 1 internal fn (push_ignored_path_segments); 1 external calls (new).


##### `push_ignored_path_segments`  (lines 179–196)

```
fn push_ignored_path_segments(path: &serde_ignored::Path<'_>, segments: &mut Vec<String>)
```

**Purpose**: This recursively walks an ignored-field path and appends its meaningful pieces to a list. It understands map keys, sequence indexes, and wrapper nodes that should not appear in the final user-facing path.

**Data flow**: It receives a path node and a mutable list of string segments. For the root, it adds nothing. For a sequence item, it first records the parent path and then adds the numeric index. For a map entry, it records the parent path and then adds the key. For wrapper nodes, it skips the wrapper itself and continues with the parent. The list is changed in place.

**Call relations**: `ignored_path_segments` calls this to do the actual path traversal. Its output later feeds ignored-field reporting, where the segments are joined into dot-separated names or used to locate a key in the original TOML.

*Call graph*: called by 1 (ignored_path_segments).


### Effective config assembly
These files assemble the full precedence stack and derive higher-level effective artifacts such as agent roles and lockfiles from the layered configuration state.

### `config/src/loader/mod.rs`

`config` · `config load`

Codex can get settings from many places: system files, company-managed policy, cloud bundles, a user's config, selected profiles, the current project, thread-specific settings, and one-off command-line flags. This file turns all of those into one ordered stack, much like layering transparent sheets where later sheets can cover earlier ones. It also decides which layers are safe to use. Project-local config is treated carefully because it comes from repository files; a project cannot be allowed to secretly redirect credentials or change dangerous execution settings. The loader therefore checks whether a project is trusted before enabling project-local config, hooks, and execution policies. It also removes project-local keys that are not allowed there and reports warnings. Another important job is admin requirements: older managed config files are translated into newer “requirements” rules so administrators can restrict approval policies, reviewers, and sandbox modes. Paths inside config files are resolved relative to the file they came from, so merging settings from different folders still produces clear absolute paths. Without this file, Codex would not know which settings win, which settings are safe, or how to explain config errors to users.

#### Function details

##### `first_layer_config_error_from_entries`  (lines 76–78)

```
async fn first_layer_config_error_from_entries(layers: &[ConfigLayerEntry]) -> Option<ConfigError>
```

**Purpose**: This helper asks the diagnostics system for the first meaningful config error among already loaded config layers. It is used so Codex can report the real bad config field instead of a vague later failure.

**Data flow**: It receives a list of config layer entries. It checks those entries as `ConfigToml` data for the normal `config.toml` file name, then returns either the first structured config error it finds or nothing.

**Call relations**: During the main load, `load_config_layers_state` calls this when project root marker parsing or trust parsing fails. If an earlier layer already contains the true problem, this helper lets the loader surface that clearer error.

*Call graph*: called by 1 (load_config_layers_state).


##### `load_config_layers_state`  (lines 116–421)

```
async fn load_config_layers_state(
    fs: &dyn ExecutorFileSystem,
    codex_home: &Path,
    cwd: Option<AbsolutePathBuf>,
    cli_overrides: &[(String, TomlValue)],
    options: impl Into<ConfigLoa
```

**Purpose**: This is the central routine that assembles the full configuration stack. It reads administrator requirements, system config, cloud config, user config, profile config, project config, thread config, and runtime overrides, then returns one ordered `ConfigLayerStack`.

**Data flow**: It starts with a file system, Codex home folder, optional current working directory, command-line overrides, load options, and a thread config loader. It reads and validates files, resolves relative paths, checks project trust, composes administrator requirements, inserts layers by precedence, and finally returns a stack that other parts of Codex can query.

**Call relations**: Higher-level loaders such as the normal config loader, plugin config loader, and app startup code call this when they need usable configuration. Inside, it delegates to smaller helpers for reading files, validating strict config, finding project roots, loading project layers, converting legacy managed config, and placing thread layers in the right order.

*Call graph*: calls 25 internal fn (from_bundle, from_bundle_strict_config, io_error_from_config_error, first_layer_config_error_from_entries, insert_layer_by_precedence, load_config_layers_internal, load_config_toml_for_required_layer, load_project_layers, load_requirements_toml, load_user_config_layer (+15 more)); called by 41 (load_config_layers, load_plugins_config, build_inner, cli_overrides_with_relative_paths_do_not_break_trust_check, codex_home_is_not_loaded_as_project_layer_from_home_dir, codex_home_within_project_tree_is_not_double_loaded, hooks_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy, ignore_rules_marks_config_stack_for_exec_policy_rule_skip, ignore_user_config_keeps_empty_user_layer, includes_thread_config_layers_in_stack (+15 more)); 9 external calls (into, Table, new, new, new, load_config_layers, compose_requirements, format!, new).


##### `load_user_config_layer`  (lines 423–451)

```
async fn load_user_config_layer(
    fs: &dyn ExecutorFileSystem,
    user_file: &AbsolutePathBuf,
    profile: Option<&ProfileV2Name>,
    ignore_user_config: bool,
    strict_config: bool,
) -> io::
```

**Purpose**: This loads a user's config file as a layer, or creates an empty user layer when user config is intentionally ignored. It also records whether the layer belongs to a selected profile.

**Data flow**: It receives a file system, a user config path, an optional profile name, and flags for ignoring or strictly checking the file. If ignoring is enabled, it returns an empty layer; otherwise it reads the TOML file, validates it if needed, resolves paths, and returns a user-sourced layer.

**Call relations**: `load_config_layers_state` uses this for both the base user config and, when selected, the profile-specific config. The actual file reading work is handed off to `load_config_toml_for_required_layer`.

*Call graph*: calls 2 internal fn (load_config_toml_for_required_layer, new); called by 1 (load_config_layers_state); 3 external calls (Table, new, clone).


##### `insert_layer_by_precedence`  (lines 453–461)

```
fn insert_layer_by_precedence(layers: &mut Vec<ConfigLayerEntry>, layer: ConfigLayerEntry)
```

**Purpose**: This places a config layer into an existing list at the point where its priority belongs. It keeps the stack ordered so later merging behaves predictably.

**Data flow**: It takes the current mutable list of layers and one new layer. It compares the new layer's precedence with existing layer precedences, inserts it before the first higher-precedence layer, or appends it if none is higher.

**Call relations**: `load_config_layers_state` uses this when thread-specific config layers arrive after the main stack is mostly built. This lets thread layers slot into the correct priority instead of simply being tacked onto the end.

*Call graph*: called by 1 (load_config_layers_state).


##### `load_config_toml_for_required_layer`  (lines 470–519)

```
async fn load_config_toml_for_required_layer(
    fs: &dyn ExecutorFileSystem,
    toml_file: &AbsolutePathBuf,
    strict_config: bool,
    create_entry: impl FnOnce(TomlValue) -> ConfigLayerEntry,
)
```

**Purpose**: This reads a `config.toml` file for layers that should always have an entry, even when the file is missing. Missing files become empty config layers; unreadable or invalid files become errors.

**Data flow**: It receives a file path, strictness flag, and a function that wraps parsed TOML into a layer entry. It reads the file through the project file system, parses TOML text, optionally checks for unknown fields, resolves relative paths against the file's folder, and returns the layer entry.

**Call relations**: `load_config_layers_state` uses this for system config, and `load_user_config_layer` uses it for user config. It calls `validate_config_toml_strictly` when strict mode is enabled and `resolve_relative_paths_in_config_toml` after parsing.

*Call graph*: calls 5 internal fn (resolve_relative_paths_in_config_toml, validate_config_toml_strictly, read_file_text, as_path, from_abs_path); called by 2 (load_config_layers_state, load_user_config_layer); 5 external calls (Table, new, format!, from_str, new).


##### `validate_config_toml_strictly`  (lines 521–541)

```
fn validate_config_toml_strictly(
    toml_file: &Path,
    contents: &str,
    value: &TomlValue,
    base_dir: &Path,
) -> io::Result<()>
```

**Purpose**: This checks a parsed config file for fields Codex does not understand. Strict mode helps catch typos or obsolete settings early instead of silently ignoring them.

**Data flow**: It receives the config file path, original text, parsed TOML value, and the folder used for resolving paths. It temporarily sets that folder as the base for absolute path parsing, asks strict-config diagnostics to find ignored fields, and returns success or a detailed invalid-data error.

**Call relations**: File-loading helpers call this for normal config files when strict config is requested. `load_project_layers` also uses it for trusted project config, because untrusted project config is disabled rather than strictly enforced.

*Call graph*: calls 2 internal fn (io_error_from_config_error, new); called by 2 (load_config_toml_for_required_layer, load_project_layers); 1 external calls (clone).


##### `validate_cli_overrides_strictly`  (lines 543–564)

```
fn validate_cli_overrides_strictly(
    cli_overrides_layer: &TomlValue,
    base_dir: &Path,
) -> io::Result<()>
```

**Purpose**: This checks command-line `--config` overrides for unknown fields. It prevents a user from thinking an override took effect when Codex will actually ignore it.

**Data flow**: It receives the TOML value built from command-line overrides and a base folder for path interpretation. It looks for ignored normal fields and unknown feature fields; if any are found, it returns a clear invalid-data error naming the bad override.

**Call relations**: `load_config_layers_state` calls this before adding command-line overrides when strict config mode is on. If validation succeeds, the same override layer is then path-resolved and added near the top of the stack.

*Call graph*: calls 2 internal fn (unknown_feature_toml_value_field, new); called by 1 (load_config_layers_state); 3 external calls (clone, new, format!).


##### `load_requirements_toml`  (lines 568–612)

```
async fn load_requirements_toml(
    fs: &dyn ExecutorFileSystem,
    requirements_toml_file: &AbsolutePathBuf,
) -> io::Result<Option<RequirementsLayerEntry>>
```

**Purpose**: This loads a system-level `requirements.toml` file if one exists. Requirements are administrator-style constraints, such as which sandbox modes or approval policies are allowed.

**Data flow**: It receives a file system and an absolute requirements file path. If the file exists, it reads the text, records the file's folder as the base directory, and returns a requirements layer; if the file is missing, it returns no layer; if reading fails, it returns an error.

**Call relations**: `load_config_layers_state` calls this while collecting admin-enforced requirements. Tests and cloud-requirements scenarios also use it to verify that system requirements combine correctly with other requirement sources.

*Call graph*: calls 5 internal fn (from_toml, read_file_text, from_absolute_path, parent, from_abs_path); called by 4 (load_config_layers_state, cloud_config_bundle_are_not_overwritten_by_system_requirements, load_single_requirements_toml, system_remote_sandbox_config_keeps_cloud_sandbox_modes); 3 external calls (new, format!, clone).


##### `system_requirements_toml_file`  (lines 620–622)

```
fn system_requirements_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: This returns the default operating-system location for the system `requirements.toml` file. It hides the Unix-versus-Windows path difference from the rest of the loader.

**Data flow**: It takes no input. On Unix it returns `/etc/codex/requirements.toml`; on Windows it delegates to the Windows-specific path builder; the output is an absolute path or an error if the path cannot be represented safely.

**Call relations**: `system_requirements_toml_file_with_overrides` calls this when no custom requirements path was supplied through loader overrides.

*Call graph*: calls 2 internal fn (windows_system_requirements_toml_file, from_absolute_path); called by 1 (system_requirements_toml_file_with_overrides); 1 external calls (new).


##### `system_requirements_toml_file_with_overrides`  (lines 624–631)

```
fn system_requirements_toml_file_with_overrides(
    overrides: &LoaderOverrides,
) -> io::Result<AbsolutePathBuf>
```

**Purpose**: This chooses the requirements file path to use, preferring an explicit override and otherwise using the platform default. It lets tests or special launches point Codex at a different admin requirements file.

**Data flow**: It receives loader overrides. If an override path is present, it converts that to an absolute path; otherwise it returns `system_requirements_toml_file`.

**Call relations**: `load_config_layers_state` calls this before trying to load system requirements. It is the small decision point between administrator defaults and caller-provided paths.

*Call graph*: calls 2 internal fn (system_requirements_toml_file, from_absolute_path); called by 1 (load_config_layers_state).


##### `system_config_toml_file`  (lines 639–641)

```
fn system_config_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: This returns the default operating-system location for the system `config.toml` file. It gives the rest of the loader one simple way to find machine-wide config.

**Data flow**: It takes no input. On Unix it returns `/etc/codex/config.toml`; on Windows it delegates to the Windows-specific path builder; the output is an absolute path or an error.

**Call relations**: `system_config_toml_file_with_overrides` calls this when no custom system config path was supplied.

*Call graph*: calls 2 internal fn (windows_system_config_toml_file, from_absolute_path); called by 1 (system_config_toml_file_with_overrides); 1 external calls (new).


##### `system_config_toml_file_with_overrides`  (lines 643–650)

```
fn system_config_toml_file_with_overrides(
    overrides: &LoaderOverrides,
) -> io::Result<AbsolutePathBuf>
```

**Purpose**: This chooses the system config file path, using an override if one exists and the platform default otherwise. It supports test setups and special deployments without changing the normal path logic.

**Data flow**: It reads the loader overrides. A supplied system config path is converted into an absolute path; if none is supplied, it returns the default from `system_config_toml_file`.

**Call relations**: `load_config_layers_state` calls this immediately before loading the system config layer.

*Call graph*: calls 2 internal fn (system_config_toml_file, from_absolute_path); called by 1 (load_config_layers_state).


##### `windows_codex_system_dir`  (lines 653–662)

```
fn windows_codex_system_dir() -> PathBuf
```

**Purpose**: This builds the Windows folder where Codex stores machine-wide config files. The folder is under ProgramData, the Windows location meant for shared application data.

**Data flow**: It asks Windows for the ProgramData folder. If that lookup fails, it logs a warning and falls back to `C:\ProgramData`, then appends `OpenAI\Codex`.

**Call relations**: The Windows config and requirements path helpers call this so they both use the same system directory.

*Call graph*: calls 1 internal fn (windows_program_data_dir_from_known_folder); called by 2 (windows_system_config_toml_file, windows_system_requirements_toml_file).


##### `windows_system_requirements_toml_file`  (lines 665–668)

```
fn windows_system_requirements_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: This builds the Windows path to the system `requirements.toml` file. It is the Windows counterpart to the Unix `/etc/codex/requirements.toml` path.

**Data flow**: It gets the Codex system directory, appends `requirements.toml`, and converts the result into an absolute path type.

**Call relations**: On Windows, `system_requirements_toml_file` delegates here. Unit tests also check that the path ends in the expected `OpenAI\Codex\requirements.toml` suffix.

*Call graph*: calls 2 internal fn (windows_codex_system_dir, try_from); called by 1 (system_requirements_toml_file).


##### `windows_system_config_toml_file`  (lines 671–674)

```
fn windows_system_config_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: This builds the Windows path to the system `config.toml` file. It keeps Windows system config in the same Codex system directory as requirements.

**Data flow**: It gets the Codex system directory, appends `config.toml`, and converts the result into an absolute path type.

**Call relations**: On Windows, `system_config_toml_file` delegates here. Unit tests verify that it uses the expected `OpenAI\Codex\config.toml` suffix.

*Call graph*: calls 2 internal fn (windows_codex_system_dir, try_from); called by 1 (system_config_toml_file).


##### `windows_program_data_dir_from_known_folder`  (lines 677–723)

```
fn windows_program_data_dir_from_known_folder() -> io::Result<PathBuf>
```

**Purpose**: This asks Windows for the official ProgramData directory. It uses the Windows shell API so Codex respects systems where ProgramData is not in the default location.

**Data flow**: It calls the Windows known-folder function, checks for failure or a null pointer, converts the returned UTF-16 string into a Rust path, frees the Windows-allocated memory, and returns the path.

**Call relations**: `windows_codex_system_dir` uses this first and falls back only if it fails. Windows-only tests call it to build the expected system config and requirements paths.

*Call graph*: called by 3 (windows_system_config_toml_file_uses_expected_suffix, windows_system_requirements_toml_file_uses_expected_suffix, windows_codex_system_dir); 6 external calls (from_wide, from, other, format!, from_raw_parts, try_from).


##### `requirements_layers_from_legacy_scheme`  (lines 725–769)

```
fn requirements_layers_from_legacy_scheme(
    loaded_config_layers: LoadedConfigLayers,
) -> io::Result<Vec<RequirementsLayerEntry>>
```

**Purpose**: This converts old-style `managed_config.toml` data into new-style requirements layers. It preserves backwards compatibility for administrators who still use the older file format.

**Data flow**: It receives already loaded legacy managed config layers, from file and possibly from mobile-device-management settings. For each one, it parses the legacy fields and converts them into a TOML requirements value, then returns those requirement layers in the correct precedence order.

**Call relations**: `load_config_layers_state` calls this after loading legacy managed config. It relies on `legacy_requirements_to_toml_value` to translate the actual fields.

*Call graph*: calls 2 internal fn (legacy_requirements_to_toml_value, from_toml_value); called by 1 (load_config_layers_state); 2 external calls (with_capacity, from).


##### `legacy_requirements_to_toml_value`  (lines 771–808)

```
fn legacy_requirements_to_toml_value(legacy: LegacyManagedConfigToml) -> io::Result<TomlValue>
```

**Purpose**: This translates legacy managed settings into modern allowed-value lists. For example, a single required sandbox mode becomes a list of allowed sandbox modes.

**Data flow**: It receives a legacy managed config struct. It creates a TOML table containing only the fields that were present: allowed approval policies, allowed approval reviewers, and allowed sandbox modes, with special compatibility additions where needed.

**Call relations**: `requirements_layers_from_legacy_scheme` calls this for each old managed config source. It uses `toml_value_from_serializable` to turn Rust enum values into TOML values.

*Call graph*: calls 1 internal fn (toml_value_from_serializable); called by 1 (requirements_layers_from_legacy_scheme); 3 external calls (Table, new, vec!).


##### `toml_value_from_serializable`  (lines 810–812)

```
fn toml_value_from_serializable(value: T) -> io::Result<TomlValue>
```

**Purpose**: This small helper converts ordinary serializable Rust data into a TOML value. It gives legacy requirement conversion one consistent error style.

**Data flow**: It receives any value that can be serialized. It asks the TOML library to convert it and returns either the TOML value or an invalid-data error.

**Call relations**: `legacy_requirements_to_toml_value` calls this when writing allowed policies, reviewers, and sandbox modes into a TOML table.

*Call graph*: called by 1 (legacy_requirements_to_toml_value); 1 external calls (try_from).


##### `ProjectTrustDecision::is_trusted`  (lines 837–839)

```
fn is_trusted(&self) -> bool
```

**Purpose**: This answers the simple question: did the trust decision mark this project as trusted? It keeps trust checks easy to read in the rest of the loader.

**Data flow**: It reads the decision's optional trust level. It returns `true` only when that level is explicitly `Trusted`; missing or untrusted both return `false`.

**Call relations**: Project layer loading uses this indirectly through `disabled_reason_for_decision` and directly when deciding whether to treat project config parse errors as fatal.

*Call graph*: called by 1 (disabled_reason_for_decision); 1 external calls (matches!).


##### `ProjectTrustContext::decision_for_dir`  (lines 843–886)

```
fn decision_for_dir(&self, dir: &AbsolutePathBuf) -> ProjectTrustDecision
```

**Purpose**: This finds the trust setting that applies to a particular directory. It checks the directory itself, the detected project root, and the Git repository root so user trust entries work across common project layouts.

**Data flow**: It receives a directory. It generates normalized lookup keys for that directory, then tries those keys against the user's project trust map; if no match is found, it tries the project root keys and then repository root keys. It returns the matching trust level and key, or a default key to suggest to the user.

**Call relations**: `load_project_layers` calls this for every `.codex` folder candidate. It depends on `normalized_project_trust_keys` and `project_trust_for_lookup_key` to handle path spelling and case differences.

*Call graph*: calls 3 internal fn (normalized_project_trust_keys, project_trust_for_lookup_key, as_path); called by 1 (load_project_layers).


##### `ProjectTrustContext::disabled_reason_for_decision`  (lines 888–904)

```
fn disabled_reason_for_decision(&self, decision: &ProjectTrustDecision) -> Option<String>
```

**Purpose**: This creates the human-readable reason shown when project-local features are disabled. It explains whether the project was explicitly untrusted or simply not yet trusted.

**Data flow**: It receives a trust decision. If the project is trusted, it returns no reason; otherwise it builds a message naming the trust key, the user's config file, and the gated features that will not load.

**Call relations**: `load_project_layers` calls this after each trust decision. The returned text is stored on disabled project layers so later diagnostics can explain why local config, hooks, and execution policies were skipped.

*Call graph*: calls 2 internal fn (is_trusted, as_path); called by 1 (load_project_layers); 1 external calls (format!).


##### `ProjectTrustContext::root_checkout_hooks_folder_for_dir`  (lines 906–916)

```
fn root_checkout_hooks_folder_for_dir(&self, dir: &AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: This finds the matching hooks folder in the root Git checkout when the current worktree is a linked worktree. It lets hooks come from the main checkout while other project config stays local to the worktree.

**Data flow**: It reads the recorded checkout root and repository root. If they are different, it maps the directory's relative path from the checkout root into the repository root and returns that directory's `.codex` folder; otherwise it returns nothing.

**Call relations**: `load_project_layers` calls this while preparing each project layer. If it returns a folder, `merge_root_checkout_project_hooks` later uses that folder to replace only the hooks section.

*Call graph*: calls 1 internal fn (as_path); called by 1 (load_project_layers).


##### `project_layer_entry`  (lines 919–935)

```
fn project_layer_entry(
    dot_codex_folder: &AbsolutePathBuf,
    config: TomlValue,
    disabled_reason: Option<String>,
    hooks_config_folder_override: Option<AbsolutePathBuf>,
) -> ConfigLayerE
```

**Purpose**: This creates a config layer entry for a project `.codex` folder. It also marks the layer disabled when trust rules say project-local settings should not be active.

**Data flow**: It receives the `.codex` folder, config TOML, optional disabled reason, and optional hooks-folder override. It builds a project-sourced layer, disabled or enabled as appropriate, attaches the hooks override, and returns it.

**Call relations**: `load_project_layers` calls this whenever it has found a project folder, whether the config file was present, missing, invalid but untrusted, or successfully parsed.

*Call graph*: calls 2 internal fn (new, new_disabled); called by 1 (load_project_layers); 1 external calls (clone).


##### `sanitize_project_config`  (lines 937–950)

```
fn sanitize_project_config(config: &mut TomlValue) -> Vec<String>
```

**Purpose**: This removes config keys that are not allowed in project-local config. It prevents a repository from changing sensitive settings such as service URLs, model providers, profiles, notifications, or telemetry.

**Data flow**: It receives a mutable TOML value. If the value is a table, it removes every denylisted top-level key that appears and returns the list of removed key names; non-table values produce no changes and no warnings.

**Call relations**: `load_project_layers` calls this after parsing project config and before resolving paths. If trusted project config had forbidden keys, `project_ignored_config_keys_warning` turns the returned list into a startup warning.

*Call graph*: called by 1 (load_project_layers); 2 external calls (as_table_mut, new).


##### `project_ignored_config_keys_warning`  (lines 952–967)

```
fn project_ignored_config_keys_warning(
    dot_codex_folder: &AbsolutePathBuf,
    ignored_keys: &[String],
) -> String
```

**Purpose**: This writes the warning shown when project-local config contains unsupported keys. It tells the user exactly which keys were ignored and where to put them instead.

**Data flow**: It receives the `.codex` folder and a list of ignored key names. It builds the config file path, joins the key names into readable text, and returns one warning string.

**Call relations**: `load_project_layers` calls this after `sanitize_project_config` reports removed keys. The resulting message is attached to the final config stack as a startup warning.

*Call graph*: calls 1 internal fn (join); called by 1 (load_project_layers); 1 external calls (format!).


##### `project_trust_context`  (lines 969–1018)

```
async fn project_trust_context(
    fs: &dyn ExecutorFileSystem,
    merged_config: &TomlValue,
    cwd: &AbsolutePathBuf,
    project_root_markers: &[String],
    config_base_dir: &Path,
    user_con
```

**Purpose**: This gathers all information needed to decide whether project-local config should be trusted. It combines user trust settings, project root detection, and Git root detection into one context object.

**Data flow**: It receives the file system, merged config so far, current directory, project-root marker names, config base folder, and user config file path. It parses the user's `[projects]` trust settings, finds the project root and Git roots, normalizes lookup keys, and returns a context used for per-folder trust decisions.

**Call relations**: `load_config_layers_state` calls this before loading project layers. It delegates directory discovery to `find_project_root`, `find_git_checkout_root`, and the external Git trust resolver.

*Call graph*: calls 4 internal fn (find_git_checkout_root, find_project_root, normalized_project_trust_keys, new); called by 1 (load_config_layers_state); 3 external calls (clone, resolve_root_git_project_for_trust, clone).


##### `project_trust_key`  (lines 1023–1028)

```
fn project_trust_key(path: &Path) -> String
```

**Purpose**: This produces the stable string key used to store or look up a project's trust setting. It helps different parts of the app agree on how a path should be written in user config.

**Data flow**: It receives a path. It tries to produce normalized project trust keys and returns the first one; if normalization yields nothing, it falls back to a normalized string form of the original path.

**Call relations**: Trust-editing and thread-start flows call this when they need to record or compare trusted projects. Internally it uses `normalized_project_trust_keys` so it matches the loader's lookup behavior.

*Call graph*: calls 1 internal fn (normalized_project_trust_keys); called by 5 (thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config, thread_start_with_nested_git_cwd_trusts_repo_root, test_set_project_trusted_migrates_top_level_inline_projects_preserving_entries, set_project_trust_level_inner, trusted_project_edit).


##### `normalized_project_trust_keys`  (lines 1030–1043)

```
fn normalized_project_trust_keys(path: &Path) -> Vec<String>
```

**Purpose**: This creates one or two comparable trust keys for a path. It accounts for the difference between how a user wrote a path and how the operating system canonicalizes it.

**Data flow**: It receives a path, turns both the original path and the canonicalized path into strings, normalizes them for lookup, and returns either one key if they match or both keys if they differ.

**Call relations**: Project trust setup and lookup use this in `project_trust_context`, `ProjectTrustContext::decision_for_dir`, and `project_trust_key`.

*Call graph*: calls 1 internal fn (normalize_project_trust_lookup_key); called by 3 (decision_for_dir, project_trust_context, project_trust_key); 3 external calls (to_string_lossy, canonicalize, vec!).


##### `normalize_project_trust_lookup_key`  (lines 1045–1051)

```
fn normalize_project_trust_lookup_key(key: String) -> String
```

**Purpose**: This normalizes a trust lookup key for the current operating system. On Windows, paths are compared case-insensitively, so the key is lowercased.

**Data flow**: It receives a string key. On Windows it returns a lowercase version; on other systems it returns the string unchanged.

**Call relations**: `normalized_project_trust_keys` uses this while building lookup keys, and `project_trust_for_lookup_key` uses the same rule when comparing existing user entries.

*Call graph*: called by 1 (normalized_project_trust_keys); 1 external calls (cfg!).


##### `project_trust_for_lookup_key`  (lines 1052–1068)

```
fn project_trust_for_lookup_key(
    projects_trust: &std::collections::HashMap<String, TrustLevel>,
    lookup_key: &str,
) -> Option<(String, TrustLevel)>
```

**Purpose**: This searches the user's project trust map for a matching key. It first looks for an exact key and then tries normalized comparison so path spelling differences do not break trust lookup.

**Data flow**: It receives the trust map and one lookup key. It returns the matching stored key plus its trust level, preferring exact matches and otherwise choosing the first normalized match in sorted order.

**Call relations**: `ProjectTrustContext::decision_for_dir` calls this repeatedly while checking directory, project-root, and repository-root keys.

*Call graph*: called by 1 (decision_for_dir).


##### `resolve_relative_paths_in_config_toml`  (lines 1076–1099)

```
fn resolve_relative_paths_in_config_toml(
    value_from_config_toml: TomlValue,
    base_dir: &Path,
) -> io::Result<TomlValue>
```

**Purpose**: This turns relative paths inside config into absolute paths based on the folder the config came from. That way, settings from different files can be merged without losing where each path was meant to point.

**Data flow**: It receives a TOML value and a base directory. It temporarily uses that directory while converting the TOML into the typed `ConfigToml` structure, serializes it back to TOML with paths resolved, then preserves the original shape and unknown fields where possible.

**Call relations**: Config loading, project loading, cloud config fragments, role layer loading, and tests call this whenever raw TOML needs path fields normalized. It relies on `copy_shape_from_original` to avoid accidentally dropping fields during the round trip.

*Call graph*: calls 2 internal fn (copy_shape_from_original, new); called by 7 (cloud_config_layers_from_fragments_impl, load_config_layers_state, load_config_toml_for_required_layer, load_project_layers, merge_root_checkout_project_hooks, ensure_resolve_relative_paths_in_config_toml_preserves_all_fields, load_role_layer_toml); 2 external calls (clone, try_from).


##### `copy_shape_from_original`  (lines 1105–1128)

```
fn copy_shape_from_original(original: &TomlValue, resolved: &TomlValue) -> TomlValue
```

**Purpose**: This preserves the original TOML layout while taking resolved values where available. It is a safety net for fields that may be lost during typed parsing and serialization.

**Data flow**: It receives the original TOML value and a resolved TOML value. For tables and arrays, it walks both structures recursively and keeps every original key or element, using the resolved value when there is a corresponding one; for simple values, it returns the resolved value.

**Call relations**: `resolve_relative_paths_in_config_toml` calls this after converting through `ConfigToml`. The helper keeps unknown or extra fields from disappearing just because path resolution understood only known config fields.

*Call graph*: called by 1 (resolve_relative_paths_in_config_toml); 4 external calls (Array, Table, new, new).


##### `find_project_root`  (lines 1130–1153)

```
async fn find_project_root(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
    project_root_markers: &[String],
) -> io::Result<AbsolutePathBuf>
```

**Purpose**: This finds the nearest project root by walking upward from the current directory looking for configured marker files or folders. Markers are things like repository or project files that say, “this is the top.”

**Data flow**: It receives the file system, current directory, and marker names. If no markers are configured it returns the current directory; otherwise it checks each ancestor for each marker and returns the first ancestor where a marker exists, falling back to the current directory.

**Call relations**: `project_trust_context` calls this before project layers are loaded. The resulting root determines how far upward `load_project_layers` will search for `.codex` folders.

*Call graph*: calls 2 internal fn (ancestors, from_abs_path); called by 1 (project_trust_context); 2 external calls (get_metadata, clone).


##### `find_git_checkout_root`  (lines 1155–1177)

```
async fn find_git_checkout_root(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
) -> Option<AbsolutePathBuf>
```

**Purpose**: This finds the nearest Git checkout root by walking upward until it sees a `.git` entry. It is used mainly to handle linked worktrees correctly.

**Data flow**: It receives the file system and current path. If the current path is a directory it starts there, otherwise it starts at the parent; then it checks ancestors for `.git` and returns the first matching directory, or nothing if no checkout root is found.

**Call relations**: `project_trust_context` calls this while preparing trust information. Its result helps `root_checkout_hooks_folder_for_dir` decide whether hooks need to be read from a different root checkout.

*Call graph*: calls 2 internal fn (parent, from_abs_path); called by 1 (project_trust_context); 2 external calls (get_metadata, clone).


##### `load_project_layers`  (lines 1190–1329)

```
async fn load_project_layers(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
    project_root: &AbsolutePathBuf,
    trust_context: &ProjectTrustContext,
    codex_home: &Path,
    strict
```

**Purpose**: This loads `.codex/config.toml` files between the project root and current directory. It orders them from broadest to most specific and disables them when the project is not trusted.

**Data flow**: It receives the file system, current directory, project root, trust context, Codex home, and strictness flag. It walks relevant directories, finds `.codex` folders, skips Codex home itself, decides trust, reads and parses config if present, removes forbidden project-local keys, resolves paths, merges special root-checkout hooks when needed, and returns project layers plus startup warnings.

**Call relations**: `load_config_layers_state` calls this after it has enough user/system config to know project root markers and trust settings. It coordinates many helpers: trust decisions, disabled reasons, sanitizing, warning creation, path resolution, hook merging, and layer entry construction.

*Call graph*: calls 13 internal fn (decision_for_dir, disabled_reason_for_decision, root_checkout_hooks_folder_for_dir, merge_root_checkout_project_hooks, project_ignored_config_keys_warning, project_layer_entry, resolve_relative_paths_in_config_toml, sanitize_project_config, validate_config_toml_strictly, read_file_text (+3 more)); called by 1 (load_config_layers_state); 8 external calls (Table, new, new, canonicalize, get_metadata, format!, from_str, new).


##### `merge_root_checkout_project_hooks`  (lines 1333–1388)

```
async fn merge_root_checkout_project_hooks(
    fs: &dyn ExecutorFileSystem,
    mut config: TomlValue,
    hooks_config_folder_override: Option<&AbsolutePathBuf>,
    is_trusted: bool,
) -> io::Resul
```

**Purpose**: This handles a linked Git worktree special case: keep the worktree's project config, but take hook declarations from the root checkout's matching `.codex/config.toml`. Hooks are commands or checks that may be tied to the main checkout layout.

**Data flow**: It receives the current project config, an optional override hooks folder, and whether the project is trusted. If there is no override, it returns the config unchanged. Otherwise it reads the root hooks config, parses and path-resolves it, removes the current `hooks` section, and inserts the root `hooks` section if one exists.

**Call relations**: `load_project_layers` calls this for each project layer after normal project config parsing or after creating an empty layer for a missing config file. It calls `resolve_relative_paths_in_config_toml` so hook paths are interpreted relative to the root hooks folder.

*Call graph*: calls 3 internal fn (resolve_relative_paths_in_config_toml, read_file_text, from_abs_path); called by 1 (load_project_layers); 6 external calls (Table, as_table_mut, new, format!, from_str, new).


##### `unit_tests::ensure_resolve_relative_paths_in_config_toml_preserves_all_fields`  (lines 1414–1448)

```
fn ensure_resolve_relative_paths_in_config_toml_preserves_all_fields() -> anyhow::Result<()>
```

**Purpose**: This test proves that path resolution does not delete unrelated config fields. It protects against a bug where converting through typed config could accidentally drop unknown TOML keys.

**Data flow**: It creates a temporary base folder and TOML containing a path field, a known non-path field, and an unknown field. It runs `resolve_relative_paths_in_config_toml` and checks that the path became absolute while the other fields stayed present.

**Call relations**: This test exercises the public path-resolution helper and indirectly verifies `copy_shape_from_original`, which is responsible for preserving the original TOML shape.

*Call graph*: calls 2 internal fn (resolve_relative_paths_in_config_toml, resolve_path_against_base); 5 external calls (String, assert_eq!, tempdir, from_str, new).


##### `unit_tests::legacy_managed_config_backfill_includes_read_only_sandbox_mode`  (lines 1451–1469)

```
fn legacy_managed_config_backfill_includes_read_only_sandbox_mode() -> io::Result<()>
```

**Purpose**: This test checks an important compatibility rule for old managed sandbox settings. When a legacy config requires workspace-write mode, the translated requirements must still allow read-only mode because Codex needs it to function safely.

**Data flow**: It builds a legacy managed config with `WorkspaceWrite` sandbox mode, converts it to requirements TOML, and compares the result with the expected `allowed_sandbox_modes` array containing both `read-only` and `workspace-write`.

**Call relations**: The test protects `legacy_requirements_to_toml_value`, which is used when `requirements_layers_from_legacy_scheme` backfills old administrator config into modern requirements.

*Call graph*: 1 external calls (assert_eq!).


##### `unit_tests::legacy_managed_config_backfill_allows_user_when_guardian_is_required`  (lines 1472–1490)

```
fn legacy_managed_config_backfill_allows_user_when_guardian_is_required() -> io::Result<()>
```

**Purpose**: This test verifies that legacy auto-review requirements still allow the user reviewer as an opt-out. It preserves behavior promised by the old managed config path.

**Data flow**: It creates a legacy config with `AutoReview` as the approvals reviewer, converts it to requirements TOML, and checks that both `auto_review` and `user` are allowed reviewers.

**Call relations**: The test focuses on `legacy_requirements_to_toml_value`, guarding the special-case reviewer expansion used during legacy requirements conversion.

*Call graph*: 1 external calls (assert_eq!).


##### `unit_tests::legacy_managed_config_backfill_preserves_user_only_approvals_reviewer`  (lines 1493–1508)

```
fn legacy_managed_config_backfill_preserves_user_only_approvals_reviewer() -> io::Result<()>
```

**Purpose**: This test confirms that a legacy config requiring the user reviewer stays user-only after conversion. It makes sure the compatibility expansion only applies to auto-review.

**Data flow**: It creates a legacy config with `User` as the approvals reviewer, converts it to requirements TOML, and checks that the allowed reviewers array contains only `user`.

**Call relations**: Like the other legacy tests, this protects `legacy_requirements_to_toml_value`, which feeds legacy managed config into the requirements system.

*Call graph*: 1 external calls (assert_eq!).


##### `unit_tests::windows_system_requirements_toml_file_uses_expected_suffix`  (lines 1512–1530)

```
fn windows_system_requirements_toml_file_uses_expected_suffix()
```

**Purpose**: This Windows-only test checks that the system requirements path is built under the expected `OpenAI\Codex` folder. It catches accidental changes to the Windows system path layout.

**Data flow**: It asks Windows for ProgramData when possible, falls back to the default ProgramData path if needed, appends the expected suffix, and compares that with `windows_system_requirements_toml_file`.

**Call relations**: The test calls `windows_program_data_dir_from_known_folder` to mirror the production path logic and verifies the helper used by `system_requirements_toml_file` on Windows.

*Call graph*: calls 1 internal fn (windows_program_data_dir_from_known_folder); 2 external calls (assert!, assert_eq!).


##### `unit_tests::windows_system_config_toml_file_uses_expected_suffix`  (lines 1534–1552)

```
fn windows_system_config_toml_file_uses_expected_suffix()
```

**Purpose**: This Windows-only test checks that the system config path is built under the expected `OpenAI\Codex` folder. It protects the location where machine-wide Windows config is read.

**Data flow**: It builds the expected ProgramData-based path ending in `OpenAI\Codex\config.toml` and compares it with `windows_system_config_toml_file`, also checking the suffix directly.

**Call relations**: The test mirrors the Windows path-building flow and verifies the helper used by `system_config_toml_file` on Windows.

*Call graph*: calls 1 internal fn (windows_program_data_dir_from_known_folder); 2 external calls (assert!, assert_eq!).


### `core/src/config/agent_roles.rs`

`config` · `config load / startup`

This file is part of configuration loading. Its job is to turn scattered role settings into one clean map of role name to AgentRoleConfig. Without it, the system could start with missing descriptions, broken file paths, duplicate role names, or role files that look valid but cannot actually be used.

It supports two ways of defining roles. A role can be declared directly inside the main TOML configuration under an agents section, or it can live in its own .toml file, often inside an agents folder. Think of it like a librarian building a catalog: first it reads the official list, then it scans the shelves for extra books, skips duplicates, and writes down warnings for damaged entries instead of stopping the whole library from opening.

When configuration layers are present, the file reads them from lowest priority to highest priority. Higher-priority layers can override lower ones, but missing fields can be filled in from the older role. Each role must end up with a non-blank description. Role files are parsed carefully: name, description, and nickname_candidates are treated as role metadata, while the remaining TOML content is kept as the role's actual config. Nicknames are trimmed, checked for duplicates, and limited to simple ASCII letters, digits, spaces, hyphens, and underscores.

#### Function details

##### `load_agent_roles`  (lines 19–116)

```
async fn load_agent_roles(
    fs: &dyn ExecutorFileSystem,
    cfg: &ConfigToml,
    config_layer_stack: &ConfigLayerStack,
    startup_warnings: &mut Vec<String>,
) -> std::io::Result<BTreeMap<Strin
```

**Purpose**: Loads all agent role definitions for the current configuration, including layered configuration if layers are in use. It produces the final set of usable roles and records non-fatal problems as startup warnings.

**Data flow**: It receives a file-system interface, the already-read main config, the stack of config layers, and a warning list. It reads role declarations from each layer, discovers extra role files in agents folders, validates and merges them, and returns a sorted map from role name to AgentRoleConfig. Bad role entries in layered configs are skipped with a warning rather than crashing the whole load.

**Call relations**: This is called during full config loading by load_config_with_layer_stack. It delegates the details to helpers: it extracts agents settings with agents_toml_from_layer, reads declared roles with read_declared_role, scans folders with discover_agent_roles_in_dir, fills missing overridden fields with merge_missing_role_fields, and checks required descriptions before accepting a role.

*Call graph*: calls 8 internal fn (get_layers, agents_toml_from_layer, discover_agent_roles_in_dir, load_agent_roles_without_layers, merge_missing_role_fields, push_agent_role_warning, read_declared_role, validate_required_agent_role_description); called by 1 (load_config_with_layer_stack); 4 external calls (new, new, new, format!).


##### `push_agent_role_warning`  (lines 118–122)

```
fn push_agent_role_warning(startup_warnings: &mut Vec<String>, err: std::io::Error)
```

**Purpose**: Turns an agent-role loading error into a user-visible startup warning. It is used when a malformed role should be ignored but the application can still continue.

**Data flow**: It receives the shared warning list and an input/output error. It formats the error into a clear message, writes it to the tracing log, and appends the same message to the startup warnings list.

**Call relations**: Both load_agent_roles and discover_agent_roles_in_dir call this when they find a broken or duplicate role definition that should not stop startup. It is the small common doorway through which role-loading problems become warnings.

*Call graph*: called by 2 (discover_agent_roles_in_dir, load_agent_roles); 2 external calls (format!, warn!).


##### `load_agent_roles_without_layers`  (lines 124–144)

```
async fn load_agent_roles_without_layers(
    fs: &dyn ExecutorFileSystem,
    cfg: &ConfigToml,
) -> std::io::Result<BTreeMap<String, AgentRoleConfig>>
```

**Purpose**: Loads agent roles for the simpler case where there is only one config file and no config layer stack. In this mode, malformed or duplicate roles are treated as real errors.

**Data flow**: It reads the agents section from the given ConfigToml, converts each declared role with read_declared_role, verifies that each has a description, and inserts it into a map. If a duplicate role name appears, or a role is invalid, it returns an error instead of a partial result.

**Call relations**: load_agent_roles calls this only when the layer stack has no active layers. It shares the same role-reading and description-validation helpers as the layered path, but it does not use the warning-based skip behavior.

*Call graph*: calls 2 internal fn (read_declared_role, validate_required_agent_role_description); called by 1 (load_agent_roles); 3 external calls (new, new, format!).


##### `read_declared_role`  (lines 146–163)

```
async fn read_declared_role(
    fs: &dyn ExecutorFileSystem,
    declared_role_name: &str,
    role_toml: &AgentRoleToml,
) -> std::io::Result<(String, AgentRoleConfig)>
```

**Purpose**: Reads one role that was explicitly declared in an agents section. If the declaration points to a separate role file, this function also reads that file and lets it supply or override selected metadata.

**Data flow**: It receives the declared role name and its TOML settings. First it converts the inline settings into an AgentRoleConfig. If a config_file is present, it reads and parses that file, may replace the role name with the file's name, and fills in description and nickname candidates from the file when available. It returns the final role name together with its config.

**Call relations**: Both load_agent_roles and load_agent_roles_without_layers use this for roles named in config. It calls agent_role_config_from_toml for the inline declaration, and read_resolved_agent_role_file when the declaration points to a standalone role file.

*Call graph*: calls 3 internal fn (agent_role_config_from_toml, read_resolved_agent_role_file, from_absolute_path); called by 2 (load_agent_roles, load_agent_roles_without_layers).


##### `merge_missing_role_fields`  (lines 165–172)

```
fn merge_missing_role_fields(role: &mut AgentRoleConfig, fallback: &AgentRoleConfig)
```

**Purpose**: Fills in blanks in one role from an older version of the same role. This lets a higher-priority config layer override only the fields it cares about.

**Data flow**: It receives a role being built and a fallback role. For description, config_file, and nickname_candidates, it keeps the current value if present; otherwise it copies the fallback value. It changes the first role in place and returns nothing.

**Call relations**: load_agent_roles uses this while combining config layers. When a higher layer defines a role that already existed in a lower layer, this helper preserves useful lower-layer values that the higher layer did not mention.

*Call graph*: called by 1 (load_agent_roles).


##### `agents_toml_from_layer`  (lines 174–189)

```
fn agents_toml_from_layer(
    layer_toml: &TomlValue,
    config_base_dir: Option<&Path>,
) -> std::io::Result<Option<AgentsToml>>
```

**Purpose**: Extracts and decodes the agents section from a raw TOML config layer. It also makes relative paths inside that section resolve relative to the layer's config folder.

**Data flow**: It receives a raw TOML value and an optional base directory. If there is no agents section, it returns None. If there is one, it temporarily installs the base directory for path resolution, converts the TOML into an AgentsToml structure, and returns it or an invalid-data error.

**Call relations**: load_agent_roles calls this once per config layer before reading that layer's declared roles. It is the bridge between raw TOML data and the strongly shaped agents configuration used by the rest of this file.

*Call graph*: called by 1 (load_agent_roles); 1 external calls (get).


##### `agent_role_config_from_toml`  (lines 191–216)

```
async fn agent_role_config_from_toml(
    fs: &dyn ExecutorFileSystem,
    role_name: &str,
    role: &AgentRoleToml,
) -> std::io::Result<AgentRoleConfig>
```

**Purpose**: Converts one inline agent role declaration from TOML into the internal AgentRoleConfig form. It also checks that the values are safe and meaningful.

**Data flow**: It receives the file-system interface, the role name, and the parsed TOML role data. It resolves and validates the optional config_file path, trims and checks the optional description, normalizes optional nickname candidates, and returns an AgentRoleConfig.

**Call relations**: read_declared_role calls this before doing anything with a separate role file. This function relies on validate_agent_role_config_file for file existence, normalize_agent_role_description for description cleanup, and normalize_agent_role_nickname_candidates for nickname rules.

*Call graph*: calls 3 internal fn (normalize_agent_role_description, normalize_agent_role_nickname_candidates, validate_agent_role_config_file); called by 1 (read_declared_role); 1 external calls (format!).


##### `parse_agent_role_file_contents`  (lines 236–316)

```
fn parse_agent_role_file_contents(
    contents: &str,
    role_file_label: &Path,
    config_base_dir: &Path,
    role_name_hint: Option<&str>,
) -> std::io::Result<ResolvedAgentRoleFile>
```

**Purpose**: Parses the text of a standalone agent role file and separates role metadata from the remaining role configuration. It is the central checker for role-file contents.

**Data flow**: It receives raw TOML text, a label for error messages, the directory to resolve relative paths from, and an optional role-name hint. It parses the TOML, validates description, developer_instructions, name, and nickname candidates, removes metadata fields from the config table, and returns a ResolvedAgentRoleFile containing the final role name, metadata, and remaining config.

**Call relations**: read_resolved_agent_role_file calls this after reading a role file from disk. load_role_layer_toml also uses it when role files are treated as config layers. It hands off validation of individual fields to normalize_agent_role_description, validate_agent_role_file_developer_instructions, and normalize_agent_role_nickname_candidates.

*Call graph*: calls 4 internal fn (normalize_agent_role_description, normalize_agent_role_nickname_candidates, validate_agent_role_file_developer_instructions, new); called by 2 (load_role_layer_toml, read_resolved_agent_role_file); 3 external calls (new, format!, from_str).


##### `read_resolved_agent_role_file`  (lines 318–332)

```
async fn read_resolved_agent_role_file(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    role_name_hint: Option<&str>,
) -> std::io::Result<ResolvedAgentRoleFile>
```

**Purpose**: Reads a standalone agent role TOML file from the configured file system and parses it into a resolved role-file object.

**Data flow**: It receives the file-system interface, an absolute file path, and an optional role-name hint. It converts the path into the URI form used by the file-system layer, reads the file as text, chooses the file's parent directory as the base for relative paths, and returns the parsed result from parse_agent_role_file_contents.

**Call relations**: read_declared_role uses this when a declared role points to a config_file. discover_agent_roles_in_dir uses it for .toml files found while scanning agents folders. It is the disk-reading wrapper around the pure parsing function.

*Call graph*: calls 5 internal fn (parse_agent_role_file_contents, read_file_text, as_path, parent, from_abs_path); called by 2 (discover_agent_roles_in_dir, read_declared_role).


##### `normalize_agent_role_description`  (lines 334–346)

```
fn normalize_agent_role_description(
    field_label: &str,
    description: Option<&str>,
) -> std::io::Result<Option<String>>
```

**Purpose**: Cleans up an optional role description and rejects descriptions that are only whitespace. A role description may be absent at this stage, but if present it must say something.

**Data flow**: It receives a field label for error messages and an optional description string. It trims surrounding whitespace; blank text becomes an error, real text becomes a trimmed String, and missing text stays missing.

**Call relations**: agent_role_config_from_toml uses this for inline role descriptions, and parse_agent_role_file_contents uses it for standalone role files. Later, validate_required_agent_role_description decides whether a missing description is allowed in the final role.

*Call graph*: called by 2 (agent_role_config_from_toml, parse_agent_role_file_contents); 2 external calls (new, format!).


##### `validate_required_agent_role_description`  (lines 348–360)

```
fn validate_required_agent_role_description(
    role_name: &str,
    description: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Checks that a finished agent role has a description. This enforces that every usable role can be explained to people or other parts of the system.

**Data flow**: It receives a role name and an optional description. If a description exists, it succeeds. If not, it returns an invalid-input error naming the role that is incomplete.

**Call relations**: load_agent_roles calls this after layered merging, because a missing description might be filled from a lower layer. load_agent_roles_without_layers calls it after reading each role directly.

*Call graph*: called by 2 (load_agent_roles, load_agent_roles_without_layers); 2 external calls (new, format!).


##### `validate_agent_role_file_developer_instructions`  (lines 362–385)

```
fn validate_agent_role_file_developer_instructions(
    role_file_label: &Path,
    developer_instructions: Option<&str>,
    require_present: bool,
) -> std::io::Result<()>
```

**Purpose**: Checks the developer_instructions field inside a standalone role file. These instructions cannot be blank, and in some cases they are required.

**Data flow**: It receives the file label, the optional developer_instructions text, and a flag saying whether the field must be present. It trims the text, rejects blank values, rejects missing values when required, and otherwise succeeds.

**Call relations**: parse_agent_role_file_contents calls this while validating role-file contents. The requirement is stricter for discovered role files that have no external role declaration to provide context.

*Call graph*: called by 1 (parse_agent_role_file_contents); 2 external calls (new, format!).


##### `validate_agent_role_config_file`  (lines 387–420)

```
async fn validate_agent_role_config_file(
    fs: &dyn ExecutorFileSystem,
    role_name: &str,
    config_file: Option<&AbsolutePathBuf>,
) -> std::io::Result<()>
```

**Purpose**: Makes sure an inline role's config_file path, if provided, points to an existing file. This prevents later code from following a broken path or accidentally accepting a directory.

**Data flow**: It receives the file-system interface, the role name, and an optional absolute path. With no path, it succeeds immediately. With a path, it asks the file system for metadata and returns success only if the target exists and is a file; otherwise it returns a clear invalid-input error.

**Call relations**: agent_role_config_from_toml calls this before accepting the config_file field from an inline role declaration. It uses the shared file-system abstraction, so the same check can work in the executor's environment rather than only on the local disk.

*Call graph*: calls 1 internal fn (from_abs_path); called by 1 (agent_role_config_from_toml); 3 external calls (new, get_metadata, format!).


##### `normalize_agent_role_nickname_candidates`  (lines 422–472)

```
fn normalize_agent_role_nickname_candidates(
    field_label: &str,
    nickname_candidates: Option<&[String]>,
) -> std::io::Result<Option<Vec<String>>>
```

**Purpose**: Cleans and validates the optional list of nicknames for an agent role. Nicknames must be useful, unique, and made from a limited set of simple characters.

**Data flow**: It receives a field label and an optional list of strings. If the list is missing, it returns None. If present, it rejects an empty list, trims each nickname, rejects blanks and duplicates, checks every character, and returns the cleaned list.

**Call relations**: agent_role_config_from_toml uses this for nicknames declared inline, and parse_agent_role_file_contents uses it for nicknames in standalone role files. It keeps nickname rules consistent no matter where the role was defined.

*Call graph*: called by 2 (agent_role_config_from_toml, parse_agent_role_file_contents); 4 external calls (new, with_capacity, new, format!).


##### `discover_agent_roles_in_dir`  (lines 474–519)

```
async fn discover_agent_roles_in_dir(
    fs: &dyn ExecutorFileSystem,
    agents_dir: &AbsolutePathBuf,
    declared_role_files: &BTreeSet<PathBuf>,
    startup_warnings: &mut Vec<String>,
) -> std::
```

**Purpose**: Finds standalone agent role files under an agents directory and turns them into role configs. It skips files that were already named explicitly in the config.

**Data flow**: It receives the file-system interface, the agents directory, a set of already-declared role-file paths, and the shared warning list. It gathers .toml files, ignores declared ones, reads each remaining file, warns and skips broken files, rejects duplicate discovered role names with warnings, and returns a map of discovered roles.

**Call relations**: load_agent_roles calls this for each config layer that has a config folder. It depends on collect_agent_role_files to find candidate files, read_resolved_agent_role_file to parse them, and push_agent_role_warning when a discovered file cannot be used.

*Call graph*: calls 3 internal fn (collect_agent_role_files, push_agent_role_warning, read_resolved_agent_role_file); called by 1 (load_agent_roles); 4 external calls (new, contains, new, format!).


##### `collect_agent_role_files`  (lines 521–554)

```
async fn collect_agent_role_files(
    fs: &dyn ExecutorFileSystem,
    dir: &AbsolutePathBuf,
) -> std::io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Walks through an agents directory tree and collects every TOML file that could define an agent role. Missing directories are treated as empty, which makes optional agents folders safe.

**Data flow**: It receives the file-system interface and an absolute directory path. It repeatedly reads directories, follows subdirectories, keeps files ending in .toml, ignores a missing root or missing subdirectory, sorts the final list, and returns the absolute paths.

**Call relations**: discover_agent_roles_in_dir calls this before trying to parse discovered role files. It is only responsible for finding candidate files; validation and warning behavior happen in the caller.

*Call graph*: calls 2 internal fn (join, from_abs_path); called by 1 (discover_agent_roles_in_dir); 3 external calls (new, read_directory, vec!).


### `core/src/config_lock.rs`

`config` · `config load and config replay validation`

A config lock file is like a receipt for a configuration run. It records the effective settings, the lock file format version, and the Codex version that produced it. Later, Codex can replay configuration and compare the result with that receipt. If something changed, this file builds a clear error, including a compact text diff showing what is different.

The file also protects against false differences. Some debug settings only control the lock-file process itself, so they are removed before a locked config is reused or compared. It also ignores removed compatibility entries in feature settings when comparing, so old cleanup details do not make a valid replay fail. By default, a lock made by one Codex version must be replayed by the same version, but there is an option to allow a version mismatch.

Most functions here turn config data into TOML, the human-readable configuration format used by the project, or back again. They wrap failures as ordinary input/output errors so the wider config-loading flow can report them consistently. Without this file, Codex could read settings, but it would not have a reliable way to prove that a later run used the same effective configuration.

#### Function details

##### `read_config_lock_from_path`  (lines 19–36)

```
async fn read_config_lock_from_path(
    path: &AbsolutePathBuf,
) -> io::Result<ConfigLockfileToml>
```

**Purpose**: Reads a config lock file from disk, parses it as TOML, and checks that its lock-file metadata is a supported shape. This is used when Codex needs to load a previously saved configuration snapshot.

**Data flow**: It starts with an absolute file path. It reads the file text, turns that text into a ConfigLockfileToml structure, checks the lock version, and returns the parsed lock file. If reading, parsing, or validation fails, it returns an input/output error with a message that includes the path or the problem.

**Call relations**: During the larger config-building flow, build_inner calls this when it needs an existing lock file. This function delegates the version check to validate_config_lock_metadata_shape and relies on the TOML parser and asynchronous file reading to get the data from disk.

*Call graph*: calls 1 internal fn (validate_config_lock_metadata_shape); called by 1 (build_inner); 2 external calls (read_to_string, from_str).


##### `config_lockfile`  (lines 38–44)

```
fn config_lockfile(config: ConfigToml) -> ConfigLockfileToml
```

**Purpose**: Builds a new config lock object from a resolved ConfigToml. It stamps the saved config with the current lock format version and the current Codex package version.

**Data flow**: It receives a configuration value. It wraps that config together with CONFIG_LOCK_VERSION and the compile-time Codex version, then returns a ConfigLockfileToml ready to be written or compared.

**Call relations**: to_config_lockfile_toml calls this when turning a resolved configuration into the lock-file form. It uses the Rust build-time env! value for the current package version so the lock records which Codex version produced it.

*Call graph*: called by 1 (to_config_lockfile_toml); 1 external calls (env!).


##### `validate_config_lock_replay`  (lines 46–74)

```
fn validate_config_lock_replay(
    expected_lock: &ConfigLockfileToml,
    actual_lock: &ConfigLockfileToml,
    options: ConfigLockReplayOptions,
) -> io::Result<()>
```

**Purpose**: Checks whether a freshly resolved config matches a saved config lock. This is the main guard that says, “Did replay produce the same configuration we expected?”

**Data flow**: It receives the expected lock, the actual lock, and replay options. It first checks both lock versions, then optionally rejects a Codex version mismatch. After that it normalizes both locks for fair comparison, compares them, and returns success if they match. If they differ, it returns an error containing a compact diff that shows the expected and actual TOML.

**Call relations**: validate_config_lock_if_configured calls this during real config validation, and several tests call it to confirm mismatch and ignore rules. It uses validate_config_lock_metadata_shape for version checks, config_lock_for_comparison to remove irrelevant differences, compact_diff to explain real differences, and config_lock_error to package failures.

*Call graph*: calls 4 internal fn (compact_diff, config_lock_error, config_lock_for_comparison, validate_config_lock_metadata_shape); called by 5 (lock_validation_can_ignore_codex_version_mismatch, lock_validation_ignores_removed_apps_mcp_path_override, lock_validation_rejects_codex_version_mismatch_by_default, lock_validation_reports_config_diff, validate_config_lock_if_configured); 1 external calls (format!).


##### `lock_layer_from_config`  (lines 76–91)

```
fn lock_layer_from_config(
    lock_path: &AbsolutePathBuf,
    lockfile: &ConfigLockfileToml,
) -> io::Result<ConfigLayerEntry>
```

**Purpose**: Turns a config lock into a normal configuration layer that can be fed back into the config system. This lets the locked settings act like they came from a user config file.

**Data flow**: It receives the path to the lock file and the parsed lock file. It removes lock-control debug settings from the saved config, converts the cleaned config into a TOML value, and returns a ConfigLayerEntry marked as coming from that user file path. If the conversion cannot be represented as TOML, it returns an error.

**Call relations**: build_inner calls this when it needs to apply the lock file as an input layer. The function uses config_without_lock_controls to remove settings that should not affect replay, toml_value to convert the config, and ConfigLayerEntry::new to hand the result to the broader config-layer machinery.

*Call graph*: calls 3 internal fn (new, config_without_lock_controls, toml_value); called by 1 (build_inner); 1 external calls (clone).


##### `config_without_lock_controls`  (lines 93–97)

```
fn config_without_lock_controls(config: &ConfigToml) -> ConfigToml
```

**Purpose**: Returns a copy of a config with the lock-file control knobs removed. This keeps settings about producing or checking the lock from becoming part of the locked configuration itself.

**Data flow**: It receives a ConfigToml by reference. It clones the config, clears the lock-related debug controls from the clone, and returns the cleaned copy, leaving the original unchanged.

**Call relations**: build_inner uses this when it needs a cleaned config, and lock_layer_from_config uses it before turning locked config into a config layer. It relies on clear_config_lock_debug_controls for the actual cleanup.

*Call graph*: calls 1 internal fn (clear_config_lock_debug_controls); called by 2 (build_inner, lock_layer_from_config); 1 external calls (clone).


##### `clear_config_lock_debug_controls`  (lines 99–110)

```
fn clear_config_lock_debug_controls(config: &mut ConfigToml)
```

**Purpose**: Removes the specific debug setting that controls config lock behavior. If the debug section becomes empty because of that, it removes the whole debug section too.

**Data flow**: It receives a mutable ConfigToml, meaning it is allowed to change the value in place. It looks for the debug section, clears debug.config_lockfile, and then deletes the debug section if that was the only remaining content. It does not return a separate value; the input config is changed directly.

**Call relations**: config_without_lock_controls calls this when making a cleaned copy, config_lock_for_comparison calls it before comparing lock files, and drop_lockfile_inputs calls it when removing lock-related inputs elsewhere. It is the shared small cleanup step used anywhere lock controls must be excluded.

*Call graph*: called by 3 (config_lock_for_comparison, config_without_lock_controls, drop_lockfile_inputs).


##### `validate_config_lock_metadata_shape`  (lines 112–120)

```
fn validate_config_lock_metadata_shape(lock: &ConfigLockfileToml) -> io::Result<()>
```

**Purpose**: Checks that a lock file uses the supported lock-file format version. This prevents Codex from silently trusting a lock file it may not understand.

**Data flow**: It receives a parsed ConfigLockfileToml. It compares its version field with CONFIG_LOCK_VERSION. If the version matches, it returns success; otherwise it returns an error explaining the unsupported version and the expected one.

**Call relations**: read_config_lock_from_path calls this right after parsing a lock file, and validate_config_lock_replay calls it for both expected and actual locks before comparing them. It uses config_lock_error to make a consistent error value.

*Call graph*: calls 1 internal fn (config_lock_error); called by 2 (read_config_lock_from_path, validate_config_lock_replay); 1 external calls (format!).


##### `config_lock_for_comparison`  (lines 122–135)

```
fn config_lock_for_comparison(
    lockfile: &ConfigLockfileToml,
    options: ConfigLockReplayOptions,
) -> ConfigLockfileToml
```

**Purpose**: Makes a cleaned copy of a lock file so two locks can be compared fairly. It removes fields that should not count as meaningful config differences.

**Data flow**: It receives a lock file and replay options. It clones the lock, clears lock-control debug settings, removes obsolete compatibility feature entries, and, if allowed by options, blanks out the Codex version so version differences are ignored. It returns the normalized copy.

**Call relations**: validate_config_lock_replay calls this for both the expected and actual lock before doing equality comparison. It uses clear_config_lock_debug_controls as part of the normalization step.

*Call graph*: calls 1 internal fn (clear_config_lock_debug_controls); called by 1 (validate_config_lock_replay); 1 external calls (clone).


##### `config_lock_error`  (lines 137–139)

```
fn config_lock_error(message: impl Into<String>) -> io::Error
```

**Purpose**: Creates a standard error value for config-lock failures. This keeps all failures in this file reported as ordinary input/output errors with readable messages.

**Data flow**: It receives anything that can become a string. It converts that input into text, wraps it in an io::Error, and returns the error.

**Call relations**: validate_config_lock_metadata_shape, validate_config_lock_replay, toml_round_trip, and other helper paths use this when they need to turn a specific failure into the file’s common error type.

*Call graph*: called by 3 (toml_round_trip, validate_config_lock_metadata_shape, validate_config_lock_replay); 2 external calls (into, other).


##### `compact_diff`  (lines 141–157)

```
fn compact_diff(root: &str, expected: &T, actual: &T) -> io::Result<String>
```

**Purpose**: Builds a short, readable diff between an expected value and an actual value. This is used to show exactly how a replayed config differs from the lock.

**Data flow**: It receives a label for the root value plus expected and actual serializable values. It converts both values into pretty TOML text, compares the texts line by line, and returns a unified diff with a small amount of surrounding context. If either value cannot be serialized, it returns an error.

**Call relations**: validate_config_lock_replay calls this only when the normalized expected and actual lock files do not match. The resulting text is placed into the validation error so the user can see the mismatch instead of just being told that something changed.

*Call graph*: called by 1 (validate_config_lock_replay); 2 external calls (from_lines, to_string_pretty).


##### `toml_value`  (lines 159–162)

```
fn toml_value(value: &T, label: &str) -> io::Result<toml::Value>
```

**Purpose**: Converts a Rust value into a generic TOML value. This is a helper for checking and reusing configuration data in TOML form.

**Data flow**: It receives a serializable value and a human-readable label for error messages. It tries to turn the value into toml::Value and returns that value on success. If conversion fails, it returns an error that names the labeled thing it could not serialize.

**Call relations**: lock_layer_from_config uses this to turn cleaned locked config into a config layer value. toml_round_trip uses it as part of a stricter check that a resolved value can be represented cleanly as TOML.

*Call graph*: called by 2 (lock_layer_from_config, toml_round_trip); 1 external calls (try_from).


##### `toml_round_trip`  (lines 164–179)

```
fn toml_round_trip(value: &impl Serialize, label: &'static str) -> io::Result<T>
```

**Purpose**: Checks that a value can be fully represented as TOML and then read back into the target type. This protects against producing a resolved config shape that TOML cannot faithfully express.

**Data flow**: It receives a serializable value and a label. It first converts the value to a generic TOML value, then converts that TOML shape into the requested target type, then serializes the target type back to TOML form. If the before and after TOML values differ, it returns an error saying the value cannot be fully represented as TOML. Otherwise it returns the converted target value.

**Call relations**: resolved_config_to_toml calls this when it needs a safe TOML-shaped resolved configuration. The function uses toml_value for conversion and config_lock_error for clear failure messages.

*Call graph*: calls 2 internal fn (config_lock_error, toml_value); called by 1 (resolved_config_to_toml); 2 external calls (clone, format!).
