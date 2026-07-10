# Core config schemas, diagnostics, merge, and layered loading  `stage-4.1.1`

This stage is the system’s configuration workshop. It sits behind the scenes and prepares the final settings the rest of the app will use at startup and during normal work. Think of it like gathering rules from many places, checking them, then stacking them in the right order so the last agreed version wins.

Several files define what valid config can look like: config_toml.rs for the main config file, hook_config.rs for event-triggered commands, mcp_types.rs for MCP server settings, profile_toml.rs for named presets, tui_keymap.rs for keyboard shortcuts, environment_toml.rs for environment bundles, and agent_roles.rs for role definitions. schema.rs exposes schema generation for tools.

Other files build and manage the stack itself. state.rs stores layered config and where each value came from. merge.rs and overrides.rs combine file values and command-line overrides. fingerprint.rs tracks origins and stable hashes. thread_config.rs, cloud_config_bundle.rs, cloud_config_layers.rs, layer_io.rs, macos.rs, and loader/mod.rs load settings from user, project, managed, cloud, thread, and platform sources.

Finally, strict_config.rs, diagnostics.rs, and cloud-config validation.rs catch mistakes early and turn them into clear, file-based error messages. config_lock.rs saves a normalized snapshot of the final result.

## Files in this stage

### Schema definitions
These files define the typed configuration schemas and related adapters that all later loading, validation, and merging logic operates on.

### `config/src/config_toml.rs`

`config` · `config load`

This file is the schema-heavy definition of Codex's primary configuration file. `ConfigToml` is a large serde/schemars struct covering model selection, approvals, sandboxing, permissions, MCP servers, profiles, history, TUI/debug settings, realtime options, projects, tools, hooks, plugins, analytics, Windows settings, and many experimental toggles. Most fields are plain `Option<T>` values, but a few use custom defaults or custom deserializers to preserve compatibility: `forced_chatgpt_workspace_id` accepts either a single string or a list, `tools.web_search` accepts either a boolean or a structured config but only preserves the structured form, and `model_providers` is validated during deserialization.

Beyond schema definitions, the file contains the logic that derives a legacy `PermissionProfile` from sandbox settings. `ConfigToml::derive_permission_profile` resolves the effective sandbox mode from an override, explicit config, or project trust defaults; applies a Windows downgrade from `WorkspaceWrite` to `ReadOnly` when the Windows sandbox is disabled; constructs the corresponding `PermissionProfile`; and, for implicit defaults only, falls back to `read_only()` if managed requirements disallow the derived profile. `ConfigToml::get_active_project` resolves project trust by checking normalized current-directory and repo-root keys against the configured `projects` map, including case-insensitive matching on Windows. The remaining helpers validate reserved model-provider IDs, provider definitions, and the allowed OSS provider names.

#### Function details

##### `default_allow_login_shell`  (lines 70–72)

```
fn default_allow_login_shell() -> Option<bool>
```

**Purpose**: Provides the serde default for `allow_login_shell`, making the field default to `Some(true)` rather than `None`.

**Data flow**: Returns `Some(true)` with no inputs or side effects.

**Call relations**: Used by serde when `ConfigToml.allow_login_shell` is omitted so downstream logic can distinguish the default-enabled behavior from an explicit false.


##### `default_history`  (lines 74–76)

```
fn default_history() -> Option<History>
```

**Purpose**: Provides the serde default for the `history` section using `History::default()` wrapped in `Some`.

**Data flow**: Constructs `History::default()` and returns it as `Some(history)`.

**Call relations**: Invoked during `ConfigToml` deserialization when the `history` field is absent.

*Call graph*: 1 external calls (default).


##### `default_project_doc_max_bytes`  (lines 78–80)

```
fn default_project_doc_max_bytes() -> Option<usize>
```

**Purpose**: Supplies the default maximum AGENTS.md/project-doc byte budget.

**Data flow**: Returns `Some(DEFAULT_PROJECT_DOC_MAX_BYTES)`.

**Call relations**: Used by serde for `project_doc_max_bytes` when the field is omitted.


##### `default_project_doc_fallback_filenames`  (lines 82–84)

```
fn default_project_doc_fallback_filenames() -> Option<Vec<String>>
```

**Purpose**: Supplies the default fallback filename list for project docs as an explicitly present empty vector.

**Data flow**: Returns `Some(Vec::new())`.

**Call relations**: Used by serde so callers can distinguish the default empty fallback list from an absent field.

*Call graph*: 1 external calls (new).


##### `default_hide_agent_reasoning`  (lines 86–88)

```
fn default_hide_agent_reasoning() -> Option<bool>
```

**Purpose**: Provides the default value for `hide_agent_reasoning`.

**Data flow**: Returns `Some(false)`.

**Call relations**: Used during config deserialization when the field is omitted.


##### `default_true`  (lines 90–92)

```
fn default_true() -> bool
```

**Purpose**: Provides a plain boolean default of `true` for nested config fields that are not optional.

**Data flow**: Returns `true`.

**Call relations**: Used by serde for `ExperimentalRequestUserInput.enabled`.


##### `ForcedChatgptWorkspaceIds::into_vec`  (lines 103–108)

```
fn into_vec(self) -> Vec<String>
```

**Purpose**: Normalizes the backward-compatible single-or-multiple workspace ID shape into a plain vector.

**Data flow**: Consumes `self`; `Single(value)` becomes `vec![value]`, while `Multiple(values)` returns the existing vector unchanged.

**Call relations**: Called by consumers after deserialization so they can treat workspace restrictions uniformly.

*Call graph*: 1 external calls (vec!).


##### `ForcedChatgptWorkspaceIds::deserialize`  (lines 112–133)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Custom-deserializes `forced_chatgpt_workspace_id`, accepting either a single string or a list of strings while explicitly rejecting comma-separated pseudo-lists.

**Data flow**: Deserializes into an internal untagged `Repr`. A single string containing `,` produces a serde custom error with migration guidance; otherwise it returns `ForcedChatgptWorkspaceIds::Single` or `::Multiple`.

**Call relations**: Invoked by serde when parsing `ConfigToml`; tests cover accepted single/list forms and the explicit rejection path.

*Call graph*: 4 external calls (deserialize, Multiple, Single, custom).


##### `ProjectConfig::is_trusted`  (lines 558–560)

```
fn is_trusted(&self) -> bool
```

**Purpose**: Reports whether a project config explicitly marks the project as trusted.

**Data flow**: Reads `self.trust_level` and returns true only for `Some(TrustLevel::Trusted)`.

**Call relations**: Used by higher-level config resolution when deriving default sandbox/permission behavior from project trust.

*Call graph*: called by 1 (default_builtin_permission_profile_name); 1 external calls (matches!).


##### `ProjectConfig::is_untrusted`  (lines 562–564)

```
fn is_untrusted(&self) -> bool
```

**Purpose**: Reports whether a project config explicitly marks the project as untrusted.

**Data flow**: Reads `self.trust_level` and returns true only for `Some(TrustLevel::Untrusted)`.

**Call relations**: Used alongside `is_trusted` when deriving trust-sensitive defaults.

*Call graph*: called by 1 (default_builtin_permission_profile_name); 1 external calls (matches!).


##### `deserialize_optional_web_search_tool_config`  (lines 648–664)

```
fn deserialize_optional_web_search_tool_config(
    deserializer: D,
) -> Result<Option<WebSearchToolConfig>, D::Error>
```

**Purpose**: Deserializes the nested `tools.web_search` field in a backward-compatible way, accepting either a boolean toggle or a structured `WebSearchToolConfig` but only preserving the structured form.

**Data flow**: Deserializes `Option<WebSearchToolConfigInput>`. `None` stays `None`; `Enabled(bool)` is intentionally discarded to `None`; `Config(config)` returns `Some(config)`.

**Call relations**: Used by serde for `ToolsToml.web_search`, allowing old boolean syntax to parse without carrying obsolete semantics into runtime config.

*Call graph*: 1 external calls (deserialize).


##### `ConfigToml::derive_permission_profile`  (lines 731–804)

```
async fn derive_permission_profile(
        &self,
        sandbox_mode_override: Option<SandboxMode>,
        windows_sandbox_level: WindowsSandboxLevel,
        active_project: Option<&ProjectConfig
```

**Purpose**: Derives the effective legacy `PermissionProfile` from sandbox-related config when no named `default_permissions` profile is being used. It folds together explicit sandbox settings, project trust defaults, Windows-specific downgrades, workspace-write options, and optional managed constraints.

**Data flow**: Reads `sandbox_mode_override`, `self.sandbox_mode`, `self.sandbox_workspace_write`, `windows_sandbox_level`, `active_project`, and an optional `Constrained<PermissionProfile>`. It resolves a sandbox mode by preferring the override, then config, then a trust-based default (`WorkspaceWrite` except on unsandboxed Windows, where it becomes `ReadOnly`), then applies a Windows downgrade from `WorkspaceWrite` to `ReadOnly` when the Windows sandbox level is disabled. It converts the final mode into a `PermissionProfile`: `read_only()`, `workspace_write()`, `workspace_write_with(...)`, or `Disabled`. If the sandbox mode was implicit and a provided constraint rejects the derived profile, it logs a warning and returns `PermissionProfile::read_only()` instead.

**Call relations**: Called during config loading when legacy sandbox settings must be turned into an active permission profile. It does not compile named permission profiles itself; callers are expected to bypass it when `default_permissions` is set.

*Call graph*: calls 3 internal fn (read_only, workspace_write, workspace_write_with); called by 2 (load_config_with_layer_stack, derive_legacy_sandbox_policy_for_test); 3 external calls (cfg!, matches!, warn!).


##### `ConfigToml::get_active_project`  (lines 809–833)

```
fn get_active_project(
        &self,
        resolved_cwd: &Path,
        repo_root: Option<&Path>,
    ) -> Option<ProjectConfig>
```

**Purpose**: Finds the `ProjectConfig` that applies to the current working directory or its resolved repository root.

**Data flow**: Reads `self.projects`, then generates normalized lookup keys for `resolved_cwd` and, if needed, `repo_root`. It queries the projects map via `project_config_for_lookup_key` and returns the first matching cloned `ProjectConfig`, or `None` if no match exists.

**Call relations**: Called during config loading before trust-sensitive defaults are derived, so later logic can know whether the current project is trusted or untrusted.

*Call graph*: calls 2 internal fn (normalized_project_lookup_keys, project_config_for_lookup_key); called by 1 (load_config_with_layer_stack).


##### `normalized_project_lookup_keys`  (lines 839–852)

```
fn normalized_project_lookup_keys(path: &Path) -> Vec<String>
```

**Purpose**: Produces one or two normalized string keys for project lookup, covering both the raw path string and a canonicalized path-comparison form.

**Data flow**: Converts the input `&Path` to a lossy string, normalizes it with `normalize_project_lookup_key`, then tries `normalize_for_path_comparison(path)` and normalizes that too. If both normalized strings are equal it returns a one-element vector; otherwise it returns `[canonicalized, raw-normalized]` in that order.

**Call relations**: Used by `ConfigToml::get_active_project` so project matching can succeed across path spelling differences, especially on Windows.

*Call graph*: calls 1 internal fn (normalize_project_lookup_key); called by 1 (get_active_project); 3 external calls (to_string_lossy, normalize_for_path_comparison, vec!).


##### `normalize_project_lookup_key`  (lines 854–860)

```
fn normalize_project_lookup_key(key: String) -> String
```

**Purpose**: Normalizes a project-map key for comparison, lowercasing on Windows and leaving Unix keys unchanged.

**Data flow**: Consumes a `String` and returns either its ASCII-lowercased form on Windows or the original string elsewhere.

**Call relations**: Used by both lookup-key generation and fallback matching against configured project keys.

*Call graph*: called by 1 (normalized_project_lookup_keys); 1 external calls (cfg!).


##### `project_config_for_lookup_key`  (lines 862–878)

```
fn project_config_for_lookup_key(
    projects: &HashMap<String, ProjectConfig>,
    lookup_key: &str,
) -> Option<ProjectConfig>
```

**Purpose**: Looks up a project config by normalized key, first by exact map key and then by normalized comparison across all configured keys.

**Data flow**: Reads the `projects` map and `lookup_key`. It first tries `projects.get(lookup_key)` and clones the value if found. Otherwise it filters all entries whose normalized key equals `lookup_key`, sorts matches by original key for deterministic behavior, and returns the first cloned config if any.

**Call relations**: Called by `ConfigToml::get_active_project` for each candidate cwd/repo-root key.

*Call graph*: called by 1 (get_active_project).


##### `validate_reserved_model_provider_ids`  (lines 880–901)

```
fn validate_reserved_model_provider_ids(
    model_providers: &HashMap<String, ModelProviderInfo>,
) -> Result<(), String>
```

**Purpose**: Rejects user-defined `model_providers` entries that try to override reserved built-in provider IDs, except for the special Bedrock ID which is allowed to appear.

**Data flow**: Scans the provider map keys, collects conflicting reserved IDs into a sorted vector of backticked names, and returns `Ok(())` if none exist or an explanatory `Err(String)` if conflicts were found.

**Call relations**: Called by `validate_model_providers` before deeper per-provider validation.

*Call graph*: called by 1 (validate_model_providers); 1 external calls (format!).


##### `validate_model_providers`  (lines 903–926)

```
fn validate_model_providers(
    model_providers: &HashMap<String, ModelProviderInfo>,
) -> Result<(), String>
```

**Purpose**: Performs semantic validation of custom model-provider definitions beyond basic deserialization.

**Data flow**: Reads the provider map, first calling `validate_reserved_model_provider_ids`. It then iterates each `(key, provider)`: skips Bedrock-specific restrictions for the Bedrock ID, rejects `provider.aws` on non-Bedrock providers, rejects blank provider names, and delegates to `provider.validate()`, prefixing any returned message with `model_providers.<key>:`.

**Call relations**: Used both during deserialization and by higher-level config loading to ensure provider definitions are valid before runtime use.

*Call graph*: calls 1 internal fn (validate_reserved_model_provider_ids); called by 2 (deserialize_model_providers, load_config_with_layer_stack); 1 external calls (format!).


##### `deserialize_model_providers`  (lines 928–937)

```
fn deserialize_model_providers(
    deserializer: D,
) -> Result<HashMap<String, ModelProviderInfo>, D::Error>
```

**Purpose**: Serde hook that deserializes the `model_providers` map and immediately validates it.

**Data flow**: Deserializes `HashMap<String, ModelProviderInfo>`, passes it to `validate_model_providers`, converts any validation failure into a serde custom error, and returns the validated map.

**Call relations**: Attached to `ConfigToml.model_providers`, so invalid provider definitions fail at parse time.

*Call graph*: calls 1 internal fn (validate_model_providers); 1 external calls (deserialize).


##### `validate_oss_provider`  (lines 939–953)

```
fn validate_oss_provider(provider: &str) -> std::io::Result<()>
```

**Purpose**: Validates the configured preferred OSS provider name and returns an `io::Error` for unsupported or removed values.

**Data flow**: Matches the input string: accepts `lmstudio` and `ollama` OSS IDs, returns a specific invalid-input error for the removed legacy Ollama chat provider, and otherwise returns an invalid-input error listing the accepted IDs.

**Call relations**: Called by higher-level config logic when setting or defaulting the OSS provider.

*Call graph*: called by 1 (set_default_oss_provider); 2 external calls (new, format!).


##### `tests::forced_chatgpt_workspace_id_accepts_single_string`  (lines 964–977)

```
fn forced_chatgpt_workspace_id_accepts_single_string()
```

**Purpose**: Verifies that a single workspace ID string deserializes and normalizes into a one-element vector.

**Data flow**: Builds TOML with one workspace ID, parses `ConfigToml`, extracts `forced_chatgpt_workspace_id`, converts it with `into_vec`, and asserts the resulting vector.

**Call relations**: Covers the single-string branch of `ForcedChatgptWorkspaceIds::deserialize`.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::forced_chatgpt_workspace_id_accepts_string_list`  (lines 980–993)

```
fn forced_chatgpt_workspace_id_accepts_string_list()
```

**Purpose**: Verifies that a TOML list of workspace IDs deserializes and preserves both IDs.

**Data flow**: Builds TOML with a two-element list, parses `ConfigToml`, converts the field with `into_vec`, and asserts the resulting vector.

**Call relations**: Covers the list branch of `ForcedChatgptWorkspaceIds::deserialize`.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::forced_chatgpt_workspace_id_rejects_comma_separated_string`  (lines 996–1005)

```
fn forced_chatgpt_workspace_id_rejects_comma_separated_string()
```

**Purpose**: Ensures a comma-separated string is rejected with a migration-oriented error message instead of being silently split.

**Data flow**: Attempts to parse invalid TOML, captures the error string, and asserts it mentions TOML lists and the unsupported comma-separated form.

**Call relations**: Covers the explicit rejection path in `ForcedChatgptWorkspaceIds::deserialize`.

*Call graph*: 2 external calls (assert!, format!).


### `config/src/hook_config.rs`

`data_model` · `config load`

This file is primarily schema definitions for hook configuration. `HooksFile` preserves the legacy JSON shape where all events live under a top-level `hooks` object. `HooksToml` is the richer user config shape: it flattens `HookEventsToml` directly into the table and adds a `state` map keyed by hook identity strings for enablement and trusted-hash tracking. `HookEventsToml` enumerates ten event buckets (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`), each storing a list of `MatcherGroup`s. A matcher group optionally filters by regex-like matcher text and contains one or more `HookHandlerConfig` entries.

`HookHandlerConfig` is a tagged enum with `command`, `prompt`, and `agent` variants. The command variant supports a primary command string, an optional Windows override accepted under either `commandWindows` or `command_windows`, an optional timeout, async execution, and an optional status message. `ManagedHooksRequirementsToml` reuses the same flattened event structure but adds `managed_dir` and `windows_managed_dir`, representing enterprise-controlled hook roots.

The behavior in this file is intentionally light: `HookEventsToml::is_empty` checks whether all event vectors are empty, `handler_count` sums the number of handlers across all matcher groups, `into_matcher_groups` converts the struct into a fixed array keyed by `HookEventName`, and `ManagedHooksRequirementsToml` forwards emptiness/counting plus selects the platform-appropriate managed directory.

#### Function details

##### `HookEventsToml::is_empty`  (lines 58–81)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether every hook event bucket is empty.

**Data flow**: Destructures `self` and returns true only if all ten event vectors have length zero.

**Call relations**: Used by higher-level config and requirements emptiness checks so blank hook sections do not count as configured.


##### `HookEventsToml::handler_count`  (lines 83–112)

```
fn handler_count(&self) -> usize
```

**Purpose**: Counts the total number of hook handlers across all events and matcher groups.

**Data flow**: Destructures `self`, builds an array of references to the ten event vectors, flattens all matcher groups, maps each group to `group.hooks.len()`, and sums the counts into a `usize`.

**Call relations**: Used directly and via `ManagedHooksRequirementsToml::handler_count` when callers need to know whether any managed hooks are actually defined.

*Call graph*: called by 1 (handler_count).


##### `HookEventsToml::into_matcher_groups`  (lines 114–127)

```
fn into_matcher_groups(self) -> [(HookEventName, Vec<MatcherGroup>); 10]
```

**Purpose**: Converts the event-structured hook config into a fixed array pairing each `HookEventName` with its matcher groups.

**Data flow**: Consumes `self` and returns a ten-element array of `(HookEventName, Vec<MatcherGroup>)` tuples in a fixed event order.

**Call relations**: Called by hook-assembly code that wants to iterate events generically rather than field-by-field.

*Call graph*: called by 1 (append_hook_events).


##### `ManagedHooksRequirementsToml::is_empty`  (lines 168–175)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether a managed hooks requirements block contains neither managed directories nor any hook handlers.

**Data flow**: Destructures `self` and returns true when both directory fields are `None` and `hooks.is_empty()` is true.

**Call relations**: Used by requirements emptiness checks and by requirement compilation to drop empty managed-hooks sections.


##### `ManagedHooksRequirementsToml::handler_count`  (lines 177–179)

```
fn handler_count(&self) -> usize
```

**Purpose**: Returns the total number of managed hook handlers defined in the flattened hook events.

**Data flow**: Delegates directly to `self.hooks.handler_count()`.

**Call relations**: Used by requirement compilation to decide whether managed hooks should become an exact-match constraint.

*Call graph*: calls 1 internal fn (handler_count).


##### `ManagedHooksRequirementsToml::managed_dir_for_current_platform`  (lines 181–191)

```
fn managed_dir_for_current_platform(&self) -> Option<&Path>
```

**Purpose**: Selects the managed hook directory appropriate for the current target platform.

**Data flow**: On Windows it returns `self.windows_managed_dir.as_deref()`. On non-Windows it returns `self.managed_dir.as_deref()`.

**Call relations**: Called by code that needs the effective managed hook root path without duplicating platform conditionals.

*Call graph*: called by 1 (managed_hooks_source_path).


### `config/src/mcp_types.rs`

`config` · `config load`

This file is the core schema and validation layer for MCP server configuration. It defines small enums and structs used directly in config files—`AppToolApproval`, `McpServerToolConfig`, `McpServerEnvVar`, `McpServerOAuthConfig`, `McpServerTransportConfig`, and the fully validated `McpServerConfig`. The raw TOML-facing shape is represented separately by `RawMcpServerConfig`, which accepts both stdio and streamable HTTP fields in one struct so deserialization can produce targeted validation errors before constructing the final transport enum.

The main control flow is `Deserialize for McpServerConfig` delegating to `RawMcpServerConfig`, then `TryFrom<RawMcpServerConfig>` selecting exactly one transport: `command` yields `McpServerTransportConfig::Stdio`, `url` yields `StreamableHttp`, and any incompatible fields for that transport are rejected with explicit messages. Startup timeout supports both legacy seconds and millisecond forms, while tool timeout uses a custom serde adapter that serializes `Option<Duration>` as floating-point seconds. Environment IDs default to `local`, and remote stdio servers have an extra invariant: they must specify an absolute `cwd`. `disabled_reason` is intentionally runtime-only and skipped from serde. The file also preserves backward compatibility in a few places, such as accepting legacy env-var string entries and a legacy `name` field while keeping schema generation focused on supported fields.

#### Function details

##### `McpServerDisabledReason::fmt`  (lines 43–50)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a disabled-reason enum into the stable user-facing text shown in CLI/TUI status output. It deliberately emits plain phrases rather than Rust enum syntax.

**Data flow**: Reads `self` and the formatter `f`; maps `Unknown` to the literal `unknown` and `Requirements { source }` to `requirements (<source>)`; writes formatted text into the formatter and returns `fmt::Result`.

**Call relations**: This is invoked implicitly anywhere the disabled reason is rendered through `Display`, especially status/reporting paths that need a human-readable explanation instead of `Debug` output.

*Call graph*: 1 external calls (write!).


##### `McpServerEnvVar::name`  (lines 74–79)

```
fn name(&self) -> &str
```

**Purpose**: Returns the environment variable name regardless of whether the config used the legacy string form or the structured `{ name, source }` form.

**Data flow**: Consumes `&self`; pattern-matches `Name(String)` and `Config { name, .. }`; returns a borrowed `&str` pointing at the stored name without allocation.

**Call relations**: It is the common accessor used by `AsRef<str>` so callers can treat `McpServerEnvVar` uniformly when only the variable name matters.

*Call graph*: called by 1 (as_ref).


##### `McpServerEnvVar::source`  (lines 81–86)

```
fn source(&self) -> Option<&str>
```

**Purpose**: Extracts the optional source tag attached to an env-var declaration.

**Data flow**: Reads `self`; returns `None` for the plain `Name` variant and `source.as_deref()` for the structured variant, yielding `Option<&str>`.

**Call relations**: This is the shared primitive for source-sensitive helpers: `is_remote_source` checks for the `remote` tag, and `validate_source` enforces the allowed vocabulary.

*Call graph*: called by 2 (is_remote_source, validate_source).


##### `McpServerEnvVar::is_remote_source`  (lines 88–90)

```
fn is_remote_source(&self) -> bool
```

**Purpose**: Tests whether an env-var entry explicitly declares `source = "remote"`.

**Data flow**: Reads `self`, calls `source()`, compares the result to `Some("remote")`, and returns a boolean.

**Call relations**: This helper is used by higher-level environment binding logic outside this file when deciding where a variable should be sourced from.

*Call graph*: calls 1 internal fn (source).


##### `McpServerEnvVar::validate_source`  (lines 92–99)

```
fn validate_source(&self) -> Result<(), String>
```

**Purpose**: Rejects unsupported `env_vars` source values early during config parsing.

**Data flow**: Reads `self`, obtains the optional source via `source()`, accepts `None`, `local`, and `remote`, and otherwise returns an `Err(String)` containing the invalid source and the accepted values.

**Call relations**: It is called from `McpServerConfig::try_from` while building stdio transport configs so malformed env-var source declarations fail deserialization with a targeted message.

*Call graph*: calls 1 internal fn (source); 1 external calls (format!).


##### `McpServerEnvVar::from`  (lines 109–111)

```
fn from(value: &str) -> Self
```

**Purpose**: Converts an owned string into the legacy `Name` variant for ergonomic construction and tests.

**Data flow**: Takes a `String`, wraps it as `McpServerEnvVar::Name`, and returns the enum value.

**Call relations**: This conversion supports generic `.into()` usage in tests and any code constructing env-var lists from plain names.

*Call graph*: 1 external calls (Name).


##### `McpServerEnvVar::as_ref`  (lines 115–117)

```
fn as_ref(&self) -> &str
```

**Purpose**: Exposes the env-var name through the standard `AsRef<str>` trait.

**Data flow**: Reads `self`, delegates to `name()`, and returns the borrowed string slice.

**Call relations**: This lets generic APIs accept `&McpServerEnvVar` anywhere an `AsRef<str>` is sufficient, with `name()` providing the actual extraction.

*Call graph*: calls 1 internal fn (name).


##### `McpServerConfig::is_local_environment`  (lines 195–197)

```
fn is_local_environment(&self) -> bool
```

**Purpose**: Checks whether the server targets the default local execution environment.

**Data flow**: Reads `self.environment_id`, compares it to `DEFAULT_MCP_SERVER_ENVIRONMENT_ID`, and returns `true` only for the default `local` environment.

**Call relations**: Other config serialization and environment-resolution code calls this to branch between local-only behavior and remote-environment handling.

*Call graph*: called by 4 (bind_environment_env_vars, resolve_server_environment, serialize_mcp_server, serialize_mcp_server_table).


##### `McpServerConfig::oauth_client_id`  (lines 199–203)

```
fn oauth_client_id(&self) -> Option<&str>
```

**Purpose**: Returns the configured OAuth client ID if the server has an OAuth block and that block specifies one.

**Data flow**: Reads `self.oauth`, traverses the nested `Option<McpServerOAuthConfig>`, then the nested `Option<String>` inside `client_id`, and returns `Option<&str>`.

**Call relations**: This is a convenience accessor for login/authentication code that needs the effective client identifier without manually unpacking nested options.


##### `McpServerConfig::try_from`  (lines 276–380)

```
fn try_from(raw: RawMcpServerConfig) -> Result<Self, Self::Error>
```

**Purpose**: Transforms the permissive raw TOML shape into a validated `McpServerConfig`, selecting the transport, normalizing defaults, converting durations, and rejecting incompatible field combinations.

**Data flow**: Consumes `RawMcpServerConfig`; destructures every field exhaustively; computes `startup_timeout_sec` from either floating-point seconds or legacy milliseconds; chooses stdio when `command` is present or streamable HTTP when `url` is present; for the chosen transport, rejects fields that belong to the other transport, validates stdio `env_vars` sources, and constructs the corresponding `McpServerTransportConfig`; fills `environment_id` with the default `local` when omitted; calls `validate_remote_stdio_cwd` to enforce absolute `cwd` for remote stdio; then returns a fully populated `McpServerConfig` with booleans defaulted, `disabled_reason` cleared to `None`, and missing tool maps replaced with empty `HashMap`s.

**Call relations**: This is the central validation step reached from `McpServerConfig::deserialize`. It delegates duration conversion to `Duration::try_from_secs_f64`/`from_millis` and remote-stdio path validation to `validate_remote_stdio_cwd` so deserialization errors are precise and transport-specific.

*Call graph*: calls 1 internal fn (validate_remote_stdio_cwd); 2 external calls (from_millis, try_from_secs_f64).


##### `McpServerConfig::deserialize`  (lines 384–391)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Implements custom serde deserialization so MCP configs are parsed through the raw compatibility layer and validated before becoming `McpServerConfig`.

**Data flow**: Receives a serde `Deserializer`, deserializes `RawMcpServerConfig`, converts it with `try_into()`, maps any string validation error into a serde custom error, and returns the validated config.

**Call relations**: Serde invokes this whenever a `McpServerConfig` is read from TOML/JSON. It exists specifically to route parsing through `McpServerConfig::try_from`.

*Call graph*: 1 external calls (deserialize).


##### `default_enabled`  (lines 394–396)

```
fn default_enabled() -> bool
```

**Purpose**: Provides the serde default for the `enabled` flag on MCP servers.

**Data flow**: Takes no input and returns the constant boolean `true`.

**Call relations**: Serde uses this as the default value provider for `McpServerConfig.enabled`, and `McpServerConfig::try_from` also uses it when the raw field is absent.


##### `validate_remote_stdio_cwd`  (lines 398–420)

```
fn validate_remote_stdio_cwd(
    transport: &McpServerTransportConfig,
    environment_id: &str,
) -> Result<(), String>
```

**Purpose**: Enforces that non-local stdio MCP servers declare an absolute working directory.

**Data flow**: Reads a `McpServerTransportConfig` and `environment_id`; returns `Ok(())` immediately for the default local environment or for non-stdio transports; for remote stdio, checks whether `cwd` exists and is absolute; returns descriptive `Err(String)` messages for missing or relative paths, including the offending environment ID and relative path text.

**Call relations**: It is called only from `McpServerConfig::try_from` after transport selection, adding an environment-specific invariant that cannot be expressed by serde attributes alone.

*Call graph*: called by 1 (try_from); 1 external calls (format!).


##### `option_duration_secs::serialize`  (lines 460–468)

```
fn serialize(value: &Option<Duration>, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes `Option<Duration>` as an optional floating-point seconds value.

**Data flow**: Reads `&Option<Duration>` and a serde serializer; converts `Some(duration)` to `duration.as_secs_f64()` and emits it with `serialize_some`, or emits `None` with `serialize_none`; returns the serializer result.

**Call relations**: Serde uses this helper for `startup_timeout_sec` and `tool_timeout_sec` fields so config files store durations in seconds rather than Rust-specific structures.

*Call graph*: 2 external calls (serialize_none, serialize_some).


##### `option_duration_secs::deserialize`  (lines 470–477)

```
fn deserialize(deserializer: D) -> Result<Option<Duration>, D::Error>
```

**Purpose**: Deserializes an optional floating-point seconds value into `Option<Duration>`.

**Data flow**: Reads from a serde deserializer as `Option<f64>`; for `Some(secs)`, converts with `Duration::try_from_secs_f64`, mapping conversion failures into serde errors; preserves `None`; returns `Result<Option<Duration>, D::Error>`.

**Call relations**: Serde uses this helper on duration fields to accept numeric seconds while still validating that the resulting `Duration` is representable.

*Call graph*: 1 external calls (deserialize).


### `config/src/profile_toml.rs`

`data_model` · `config parsing, validation, schema generation`

This file contributes two data structures to the configuration model: `ConfigProfile` and `ProfileTui`. `ConfigProfile` is a broad, mostly-optional aggregate of settings that can be grouped under a profile in `config.toml`. Its fields span model selection (`model`, `model_provider`, `service_tier`), approval and sandbox behavior (`approval_policy`, `approvals_reviewer`, `sandbox_mode`), reasoning controls (`model_reasoning_effort`, `plan_mode_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`), prompt/context toggles, tool configuration, analytics, web search, Windows-specific settings, feature flags, and provider-specific paths such as `model_catalog_json` and `model_instructions_file`.

The derives are important to how the type is used: `Serialize`/`Deserialize` support TOML round-tripping, `JsonSchema` feeds schema generation, and `Default` plus pervasive `Option<T>` make partial profile definitions merge-friendly. Unknown fields are rejected via `deny_unknown_fields`, which keeps profile definitions strict and catches typos early. Two deprecated JavaScript REPL fields remain present for backward compatibility but are explicitly skipped in schema generation and documented as ignored. `ProfileTui` currently contains only `session_picker_view`, but is nested under `tui` to reserve a profile-local namespace for terminal UI preferences. The `features` field uses a custom schema hook so only known feature keys appear and unknown ones are forbidden.


### `config/src/tui_keymap.rs`

`config` · `config load`

This file is both schema and validator for TUI keybinding configuration. It declares a large family of serde/schemars structs representing context-specific keymaps (`TuiGlobalKeymap`, `TuiChatKeymap`, `TuiComposerKeymap`, editor/vim/pager/list/approval contexts) and wraps individual bindings in `KeybindingSpec` and `KeybindingsSpec`. The schema is intentionally strict: most structs use `deny_unknown_fields`, and `KeybindingsSpec` distinguishes a single binding from an explicit list so an empty list can mean “unbind this action” rather than “inherit defaults.”

The behavioral core is the normalization pipeline. `KeybindingSpec` custom deserialization reads a raw string and passes it through `normalize_keybinding_spec`, which trims whitespace, lowercases input, splits on `-`, canonicalizes modifier aliases (`control`→`ctrl`, `option`→`alt`), enforces that modifiers appear only before the key, rejects duplicates, and emits modifiers in fixed `ctrl-alt-shift` order. The remaining key portion is validated by `normalize_key_name`, which accepts a constrained vocabulary: printable single ASCII characters except `-`, named keys like `enter`, arrows, `page-up`, `minus`, and function keys `f1` through `f24`. It also rewrites aliases such as `escape`→`esc`, `return`→`enter`, and `pgdn`→`page-down`.

The tests focus on config ergonomics: misplaced actions at the root are rejected, misspelled fields surface in parse errors, removed legacy actions stay invalid, minus/function-key bindings are accepted, and canonicalization behaves as expected.

#### Function details

##### `KeybindingSpec::as_str`  (lines 43–45)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the canonical normalized keybinding string stored inside the wrapper. It exposes the inner string without re-parsing or allocating.

**Data flow**: Reads `self.0` and returns `&str` via `self.0.as_str()`.

**Call relations**: Used by downstream runtime keymap code after config deserialization has already normalized the binding.


##### `KeybindingSpec::deserialize`  (lines 49–56)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Custom serde deserializer that turns a raw config string into a validated, canonical `KeybindingSpec`. Invalid user input becomes a serde error with the normalization message.

**Data flow**: Receives a generic serde `deserializer` → deserializes a `String` from it → passes the raw string to `normalize_keybinding_spec` → on success wraps the normalized string in `KeybindingSpec`; on failure converts the message with `SerdeError::custom` and returns the deserialization error.

**Call relations**: Automatically invoked by serde whenever a `KeybindingSpec` appears in config. It delegates all syntax and canonicalization rules to `normalize_keybinding_spec`.

*Call graph*: calls 1 internal fn (normalize_keybinding_spec); 1 external calls (deserialize).


##### `KeybindingsSpec::specs`  (lines 81–86)

```
fn specs(&self) -> Vec<&KeybindingSpec>
```

**Purpose**: Returns all configured bindings for one action in declaration order, regardless of whether the config used a single string or a list.

**Data flow**: Matches `self` → for `One(spec)` returns `vec![spec]`; for `Many(specs)` iterates and collects `&KeybindingSpec` references into a `Vec`.

**Call relations**: Called by runtime parsing code that wants a uniform list of bindings per action while preserving user-declared ordering.

*Call graph*: called by 1 (parse_bindings); 1 external calls (vec!).


##### `normalize_keybinding_spec`  (lines 436–511)

```
fn normalize_keybinding_spec(raw: &str) -> Result<String, String>
```

**Purpose**: Canonicalizes one user-entered keybinding string and rejects malformed combinations before runtime. It is the main parser for modifier ordering, alias handling, and empty/duplicate checks.

**Data flow**: Takes `raw: &str` → trims and lowercases it → rejects empty input → splits on `-`, dropping empty segments → initializes ordered modifier flags in a `BTreeMap` for `ctrl`, `alt`, `shift` and scans segments left-to-right, treating leading modifier aliases specially until the first non-modifier key segment appears → rejects duplicate modifiers, missing key segments, and modifier tokens appearing after the key → joins remaining key segments back with `-`, validates/canonicalizes them via `normalize_key_name`, then emits a normalized string with modifiers in fixed `ctrl-alt-shift` order followed by the canonical key name.

**Call relations**: Called exclusively from `KeybindingSpec::deserialize`. It delegates key-name validation to `normalize_key_name` after handling the higher-level modifier grammar.

*Call graph*: calls 1 internal fn (normalize_key_name); called by 1 (deserialize); 3 external calls (from, new, format!).


##### `normalize_key_name`  (lines 517–569)

```
fn normalize_key_name(key: &str, original: &str) -> Result<String, String>
```

**Purpose**: Validates and canonicalizes the key portion of a binding after modifiers have been separated. It constrains accepted keys to a portable vocabulary used by the runtime matcher.

**Data flow**: Consumes `key` and the original raw binding string for diagnostics → rewrites aliases like `escape`/`return`/`spacebar`/`pgup`/`pagedown`/`del` to canonical names → accepts single printable non-control ASCII characters except `-`, accepts a fixed set of named keys (`enter`, `tab`, arrows, `page-up`, `minus`, etc.), or accepts `fN` where `N` parses as `u8` in `1..=MAX_FUNCTION_KEY` → otherwise returns a formatted error mentioning the original binding and supported key classes.

**Call relations**: Used only by `normalize_keybinding_spec` once modifier parsing is complete.

*Call graph*: called by 1 (normalize_keybinding_spec); 2 external calls (format!, matches!).


##### `tests::misplaced_action_at_keymap_root_is_rejected`  (lines 577–589)

```
fn misplaced_action_at_keymap_root_is_rejected()
```

**Purpose**: Ensures actions placed directly under `[tui.keymap]` instead of inside a context table fail deserialization rather than being ignored.

**Data flow**: Builds a TOML snippet with `open_transcript` at the root → attempts `toml::from_str::<TuiKeymap>` → asserts the result is an error.

**Call relations**: Regression test for schema strictness at the top level of the keymap config.

*Call graph*: 1 external calls (assert!).


##### `tests::misspelled_action_under_context_is_rejected`  (lines 592–603)

```
fn misspelled_action_under_context_is_rejected()
```

**Purpose**: Verifies that unknown action names inside a valid context table are rejected and surfaced in the parse error text.

**Data flow**: Parses TOML containing `[global] open_transcrip = "ctrl-x"` → expects deserialization to fail → asserts the error string contains the misspelled field name.

**Call relations**: Checks the effect of `deny_unknown_fields` on context structs.

*Call graph*: 1 external calls (assert!).


##### `tests::misspelled_vim_text_object_action_is_rejected`  (lines 606–617)

```
fn misspelled_vim_text_object_action_is_rejected()
```

**Purpose**: Confirms that invalid field names in the vim text-object context are rejected with a useful error mentioning the bad key.

**Data flow**: Parses TOML with `[vim_text_object] double_quotes = "shift-quote"` → expects an error → asserts the error text contains `double_quotes`.

**Call relations**: Another unknown-field regression test, focused on a nested vim-specific context.

*Call graph*: 1 external calls (assert!).


##### `tests::removed_backtrack_actions_are_rejected`  (lines 620–643)

```
fn removed_backtrack_actions_are_rejected()
```

**Purpose**: Locks in that several removed legacy action names remain invalid across multiple contexts. This prevents accidental backward-compatible aliases from silently reappearing.

**Data flow**: Iterates over a list of `(context, action)` pairs → formats a TOML snippet for each → parses as `TuiKeymap`, expecting failure → asserts each error string mentions the removed action name.

**Call relations**: Broad regression test covering multiple contexts and deprecated action identifiers.

*Call graph*: 2 external calls (assert!, format!).


##### `tests::action_under_global_context_is_accepted`  (lines 646–653)

```
fn action_under_global_context_is_accepted()
```

**Purpose**: Checks the positive case that a correctly placed global action deserializes successfully.

**Data flow**: Parses TOML with `[global] open_transcript = "ctrl-s"` into `TuiKeymap` → asserts `keymap.global.open_transcript.is_some()`.

**Call relations**: Complements the rejection tests by proving the intended schema shape works.

*Call graph*: 2 external calls (assert!, from_str).


##### `tests::minus_bindings_under_global_context_are_accepted`  (lines 656–679)

```
fn minus_bindings_under_global_context_are_accepted()
```

**Purpose**: Verifies that `minus` and `alt-minus` are accepted as valid canonical key specs and deserialize into the expected normalized representation.

**Data flow**: Iterates over two `(spec, expected)` cases → formats TOML under `[global]` → parses into `TuiKeymap` → builds an expected default keymap with `global.open_transcript` set to the expected `KeybindingsSpec` → asserts equality.

**Call relations**: Exercises both schema deserialization and key-name normalization for the special `minus` key.

*Call graph*: 5 external calls (assert_eq!, One, default, format!, from_str).


##### `tests::function_keys_through_f24_are_accepted`  (lines 682–686)

```
fn function_keys_through_f24_are_accepted()
```

**Purpose**: Pins the supported function-key range and rejects values above the configured maximum.

**Data flow**: Calls `normalize_keybinding_spec("F13")` and `normalize_keybinding_spec("f24")`, asserting canonical lowercase success, then asserts `normalize_keybinding_spec("f25")` returns an error.

**Call relations**: Direct unit test of the normalization helpers rather than full TOML deserialization.

*Call graph*: 2 external calls (assert!, assert_eq!).


### `core/src/config/schema.rs`

`config` · `config load`

This file contains no original logic; its role is to make configuration-schema functionality available from the core crate by importing three concrete items from `codex_config::schema`: `canonicalize`, `config_schema_json`, and `write_config_schema`. Those names indicate the three supported schema-facing operations: normalizing schema/config representations into a canonical form, producing the schema as JSON, and writing the schema out through an output path or sink defined in the upstream crate. Because the file only imports these items and does not wrap or rename them, callers effectively consume the upstream behavior unchanged while keeping schema-related access points grouped under the core configuration area. The only additional structure is a `#[cfg(test)]` inclusion of `schema_tests.rs`, which keeps tests adjacent to this module without affecting production builds. A subtle design choice here is that schema generation remains centralized in `codex_config`, avoiding duplicate schema definitions inside `codex-core`; this file serves as a stable leaf in the public/internal module tree rather than a second implementation.


### `exec-server/src/environment_toml.rs`

`config` · `config load`

This file implements the richer configuration path for environments stored in `CODEX_HOME/environments.toml`. The top-level `EnvironmentsToml` schema supports an optional default environment id, an optional `include_local` flag, and an ordered list of `EnvironmentToml` entries. Each entry can describe either a WebSocket remote (`url`) or a stdio-launched remote (`program`, optional `args`, `env`, `cwd`), plus optional connect and initialize timeouts. Serde uses `deny_unknown_fields`, and `option_duration_secs` decodes floating-point seconds into `Duration`.

`TomlEnvironmentProvider::new_with_config_dir` is the main validator. It defaults `include_local` to true, reserves `local` when local inclusion is enabled, parses each entry with `parse_environment_toml`, rejects duplicate ids, and resolves the default through `normalize_default_environment_id`. Parsing is strict: ids must be trimmed ASCII alphanumeric plus `-`/`_`, not reserved, and at most 64 characters; exactly one of `url` or `program` must be set; `args`/`env`/`cwd` require `program`; `connect_timeout_sec` requires `url`; WebSocket URLs must use `ws://` or `wss://` and pass tungstenite request validation; relative stdio `cwd` values are resolved against the config directory when available, otherwise rejected.

The provider snapshot phase is intentionally simple: it converts stored `ExecServerTransportParams` into remote `Environment` objects with `Environment::remote_with_transport`, leaving local synthesis to `EnvironmentManager`. `environment_provider_from_codex_home` chooses between this TOML provider and `DefaultEnvironmentProvider::from_env()` based on whether the config file exists, and wraps filesystem read/parse failures in `ExecServerError::Protocol` with the path included. Tests cover both happy-path parsing and many validation edge cases, especially duplicate ids, malformed URLs, relative cwd handling, and default-selection semantics when local is disabled.

#### Function details

##### `TomlEnvironmentProvider::new`  (lines 60–62)

```
fn new(config: EnvironmentsToml) -> Result<Self, ExecServerError>
```

**Purpose**: Test-oriented constructor that parses TOML-derived config without a base directory for resolving relative stdio working directories.

**Data flow**: Takes `EnvironmentsToml`, forwards it to `new_with_config_dir(config, None)`, and returns the validated provider or an `ExecServerError`.

**Call relations**: Used heavily by unit tests to exercise parsing and validation logic in isolation.

*Call graph*: called by 13 (toml_provider_can_disable_local_environment, toml_provider_default_none_disables_default, toml_provider_default_omitted_selects_local, toml_provider_includes_local_and_adds_configured_environments, toml_provider_parses_configured_transport_timeouts, toml_provider_rejects_duplicate_ids, toml_provider_rejects_invalid_environments, toml_provider_rejects_local_default_when_local_is_disabled, toml_provider_rejects_malformed_websocket_url, toml_provider_rejects_overlong_id (+3 more)); 1 external calls (new_with_config_dir).


##### `TomlEnvironmentProvider::new_with_config_dir`  (lines 64–94)

```
fn new_with_config_dir(
        config: EnvironmentsToml,
        config_dir: Option<&Path>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Validates parsed TOML configuration, converts each environment entry into transport parameters, rejects duplicates, and computes the provider’s default-selection policy.

**Data flow**: Consumes `EnvironmentsToml` and optional config directory → defaults `include_local` to true, seeds a `HashSet` of reserved ids with `local` when applicable, parses each `EnvironmentToml` via `parse_environment_toml`, rejects duplicate ids, stores ordered `(id, ExecServerTransportParams)` pairs, resolves `default` with `normalize_default_environment_id`, and returns `TomlEnvironmentProvider`.

**Call relations**: Called from config-file loading and tests; it delegates per-entry validation to `parse_environment_toml` and default validation to `normalize_default_environment_id`.

*Call graph*: calls 2 internal fn (normalize_default_environment_id, parse_environment_toml); called by 2 (environment_provider_from_codex_home, toml_provider_resolves_relative_stdio_cwd_from_config_dir); 4 external calls (new, with_capacity, Protocol, format!).


##### `TomlEnvironmentProvider::snapshot`  (lines 117–119)

```
fn snapshot(&self) -> EnvironmentProviderFuture<'_>
```

**Purpose**: Builds an `EnvironmentProviderSnapshot` by materializing remote `Environment` objects from the provider’s stored transport parameters.

**Data flow**: Iterates `self.environments`, cloning each id and transport params, converts each transport into `Environment::remote_with_transport(..., None)`, collects them into a vector, and returns `EnvironmentProviderSnapshot { environments, default: self.default.clone(), include_local: self.include_local }`.

**Call relations**: Used through the `EnvironmentProvider` trait after TOML parsing has already validated all entries.

*Call graph*: calls 1 internal fn (remote_with_transport); 3 external calls (pin, with_capacity, clone).


##### `parse_environment_toml`  (lines 122–187)

```
fn parse_environment_toml(
    item: EnvironmentToml,
    config_dir: Option<&Path>,
) -> Result<(String, ExecServerTransportParams), ExecServerError>
```

**Purpose**: Validates one TOML environment entry and converts it into a concrete transport description.

**Data flow**: Destructures `EnvironmentToml`, validates `id`, enforces that `args`/`env`/`cwd` require `program`, enforces that `connect_timeout_sec` requires `url`, fills in default connect/initialize timeouts, then matches `(url, program)`: URL-only entries become `ExecServerTransportParams::WebSocketUrl` after `validate_websocket_url`; program-only entries become `ExecServerTransportParams::StdioCommand` after trimming `program`, validating non-empty, resolving `cwd` with `normalize_stdio_cwd`, and defaulting missing args/env to empty collections; all other combinations are rejected.

**Call relations**: Called from `TomlEnvironmentProvider::new_with_config_dir` for each configured environment.

*Call graph*: calls 3 internal fn (normalize_stdio_cwd, validate_environment_id, validate_websocket_url); called by 1 (new_with_config_dir); 2 external calls (Protocol, format!).


##### `normalize_stdio_cwd`  (lines 189–206)

```
fn normalize_stdio_cwd(
    id: &str,
    cwd: Option<PathBuf>,
    config_dir: Option<&Path>,
) -> Result<Option<PathBuf>, ExecServerError>
```

**Purpose**: Normalizes a configured stdio command working directory, resolving relative paths against the config directory when possible.

**Data flow**: Takes an environment id, optional `PathBuf`, and optional config directory → returns `Ok(None)` when no cwd is configured, returns the path unchanged when already absolute, joins relative paths against `config_dir` when provided, or returns a protocol error mentioning the environment id when a relative path cannot be resolved.

**Call relations**: Used only by `parse_environment_toml` for stdio-command environments.

*Call graph*: called by 1 (parse_environment_toml); 2 external calls (Protocol, format!).


##### `environment_provider_from_codex_home`  (lines 208–226)

```
fn environment_provider_from_codex_home(
    codex_home: &Path,
) -> Result<Box<dyn EnvironmentProvider>, ExecServerError>
```

**Purpose**: Chooses the environment provider source for a given `CODEX_HOME`, preferring `environments.toml` when present and falling back to the legacy environment-variable provider otherwise.

**Data flow**: Joins `codex_home` with `environments.toml`, checks `try_exists()` and wraps inspection errors as protocol errors, returns `DefaultEnvironmentProvider::from_env()` when the file is absent, otherwise loads and parses the file with `load_environments_toml`, constructs `TomlEnvironmentProvider::new_with_config_dir(..., Some(codex_home))`, boxes the provider trait object, and returns it.

**Call relations**: Called by `EnvironmentManager::from_codex_home`; it is the bridge between filesystem config discovery and provider abstraction.

*Call graph*: calls 3 internal fn (from_env, new_with_config_dir, load_environments_toml); called by 3 (from_codex_home, environment_provider_from_codex_home_falls_back_when_file_is_missing, environment_provider_from_codex_home_uses_present_environments_file); 2 external calls (new, join).


##### `normalize_default_environment_id`  (lines 228–257)

```
fn normalize_default_environment_id(
    default: Option<&str>,
    include_local: bool,
    ids: &HashSet<String>,
) -> Result<EnvironmentDefault, ExecServerError>
```

**Purpose**: Resolves the TOML `default` field into `EnvironmentDefault`, applying local-default fallback rules and validating that explicit defaults refer to configured ids.

**Data flow**: Takes optional default string, `include_local`, and the set of known ids → if omitted, returns `EnvironmentId("local")` when local is included or `Disabled` otherwise; trims explicit values, rejects empty strings, accepts case-insensitive `none` as `Disabled`, rejects unknown ids, and otherwise returns `EnvironmentId(default.to_string())`.

**Call relations**: Used by `TomlEnvironmentProvider::new_with_config_dir` after all ids have been collected.

*Call graph*: called by 1 (new_with_config_dir); 3 external calls (Protocol, EnvironmentId, format!).


##### `validate_environment_id`  (lines 259–290)

```
fn validate_environment_id(id: &str) -> Result<(), ExecServerError>
```

**Purpose**: Enforces the TOML environment-id syntax and reservation rules.

**Data flow**: Takes `&str` id → trims and compares to reject empty or surrounding whitespace, rejects reserved `local` and case-insensitive `none`, rejects ids longer than `MAX_ENVIRONMENT_ID_LEN`, rejects any character outside ASCII alphanumeric / `-` / `_`, and otherwise returns `Ok(())`.

**Call relations**: Called by `parse_environment_toml` before any transport-specific validation.

*Call graph*: called by 1 (parse_environment_toml); 2 external calls (Protocol, format!).


##### `validate_websocket_url`  (lines 292–308)

```
fn validate_websocket_url(url: String) -> Result<String, ExecServerError>
```

**Purpose**: Validates and normalizes a configured WebSocket URL string.

**Data flow**: Trims the input string, rejects empty values, rejects schemes other than `ws://` or `wss://`, validates the URL by converting it into a tungstenite client request, and returns the trimmed URL string on success.

**Call relations**: Used by `parse_environment_toml` for URL-backed environments.

*Call graph*: called by 1 (parse_environment_toml); 2 external calls (Protocol, format!).


##### `load_environments_toml`  (lines 310–324)

```
fn load_environments_toml(path: &Path) -> Result<EnvironmentsToml, ExecServerError>
```

**Purpose**: Reads and deserializes `environments.toml` from disk with path-rich protocol errors.

**Data flow**: Reads the file contents with `std::fs::read_to_string`, mapping I/O failures into `ExecServerError::Protocol` that includes `path.display()`, then parses TOML with `toml::from_str`, again wrapping parse failures with the path in the message.

**Call relations**: Called by `environment_provider_from_codex_home` and directly by tests that validate file parsing behavior.

*Call graph*: called by 3 (environment_provider_from_codex_home, load_environments_toml_reads_root_environment_list, load_environments_toml_rejects_unknown_fields); 2 external calls (read_to_string, from_str).


##### `option_duration_secs::deserialize`  (lines 332–339)

```
fn deserialize(deserializer: D) -> Result<Option<Duration>, D::Error>
```

**Purpose**: Serde helper that decodes optional floating-point seconds into optional `Duration` values.

**Data flow**: Deserializes `Option<f64>` from the input, maps present values through `Duration::try_from_secs_f64`, converts conversion failures into serde errors, and returns `Result<Option<Duration>, D::Error>`.

**Call relations**: Used by the TOML schema on `connect_timeout_sec` and `initialize_timeout_sec` fields.

*Call graph*: 1 external calls (deserialize).


##### `tests::toml_provider_includes_local_and_adds_configured_environments`  (lines 350–402)

```
async fn toml_provider_includes_local_and_adds_configured_environments()
```

**Purpose**: Verifies that TOML parsing preserves environment order, includes local by default, trims URLs/programs, and supports both WebSocket and stdio transports.

**Data flow**: Builds a provider from two configured environments, awaits its snapshot, extracts ids and environment map, and asserts ordered ids, `include_local = true`, trimmed remote URL, stdio-backed remote behavior, and explicit default selection.

**Call relations**: Exercises the main happy path through `TomlEnvironmentProvider::new` and `snapshot`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::toml_provider_default_omitted_selects_local`  (lines 405–414)

```
async fn toml_provider_default_omitted_selects_local()
```

**Purpose**: Checks that omitting `default` while leaving local enabled selects `local` as the default.

**Data flow**: Builds a provider from `EnvironmentsToml::default()`, awaits the snapshot, and asserts `include_local` plus default `EnvironmentId("local")`.

**Call relations**: Covers the omitted-default branch in `normalize_default_environment_id`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, default).


##### `tests::toml_provider_default_none_disables_default`  (lines 417–428)

```
async fn toml_provider_default_none_disables_default()
```

**Purpose**: Verifies that `default = "none"` disables the default environment even when local remains included.

**Data flow**: Builds a provider with `default: Some("none")`, awaits the snapshot, and asserts `include_local` is still true while `default` is `Disabled`.

**Call relations**: Exercises the explicit-disabled branch of default normalization.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::toml_provider_can_disable_local_environment`  (lines 431–449)

```
async fn toml_provider_can_disable_local_environment()
```

**Purpose**: Checks that TOML can disable local inclusion while still selecting a configured remote environment as default.

**Data flow**: Builds a provider with `include_local = false` and one stdio environment, awaits the snapshot, and asserts local is excluded and default points at that remote id.

**Call relations**: Covers interaction between `include_local` and explicit remote defaults.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::toml_provider_without_local_and_default_omitted_disables_default`  (lines 452–462)

```
async fn toml_provider_without_local_and_default_omitted_disables_default()
```

**Purpose**: Verifies that when local is disabled and no default is specified, the provider disables the default rather than inventing one.

**Data flow**: Builds a provider with `include_local = false` and otherwise default config, awaits the snapshot, and asserts `include_local` is false and `default` is `Disabled`.

**Call relations**: Exercises the omitted-default/no-local branch in `normalize_default_environment_id`.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert!, assert_eq!).


##### `tests::toml_provider_rejects_local_default_when_local_is_disabled`  (lines 465–477)

```
fn toml_provider_rejects_local_default_when_local_is_disabled()
```

**Purpose**: Ensures `default = "local"` is rejected if `include_local = false`.

**Data flow**: Attempts to build a provider with local disabled and default set to `local`, captures the error, and asserts the protocol-error message.

**Call relations**: Covers validation that defaults must refer to configured ids.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `tests::toml_provider_rejects_invalid_environments`  (lines 480–563)

```
fn toml_provider_rejects_invalid_environments()
```

**Purpose**: Runs a table of malformed environment entries through the parser and checks each expected validation error.

**Data flow**: Iterates several invalid `EnvironmentToml` cases—reserved ids, whitespace, invalid characters, wrong URL scheme, both/neither transport selectors, empty program, args without program, connect timeout without URL—builds a provider for each, captures the error, and compares the message.

**Call relations**: Collectively exercises most failure branches in `validate_environment_id`, `validate_websocket_url`, and `parse_environment_toml`.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, from_secs, new, assert_eq!, vec!).


##### `tests::toml_provider_resolves_relative_stdio_cwd_from_config_dir`  (lines 566–603)

```
fn toml_provider_resolves_relative_stdio_cwd_from_config_dir()
```

**Purpose**: Verifies that relative stdio command working directories are resolved against the config directory.

**Data flow**: Creates a temp config dir, builds a provider with a stdio environment whose `cwd` is `workspace`, inspects the stored `ExecServerTransportParams::StdioCommand`, and asserts the command cwd is `config_dir/workspace` and the initialize timeout default is applied.

**Call relations**: Exercises `new_with_config_dir` and `normalize_stdio_cwd` on the relative-path success path.

*Call graph*: calls 1 internal fn (new_with_config_dir); 4 external calls (assert_eq!, panic!, tempdir, vec!).


##### `tests::toml_provider_parses_configured_transport_timeouts`  (lines 606–657)

```
fn toml_provider_parses_configured_transport_timeouts()
```

**Purpose**: Checks that configured connect and initialize timeout values are preserved for both WebSocket and stdio transports.

**Data flow**: Builds a provider with one URL environment and one stdio environment, inspects the stored transport params, and asserts the parsed timeout `Duration`s and command fields match the TOML input.

**Call relations**: Exercises timeout parsing via `option_duration_secs::deserialize` and transport construction in `parse_environment_toml`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::toml_provider_rejects_relative_stdio_cwd_without_config_dir`  (lines 660–677)

```
fn toml_provider_rejects_relative_stdio_cwd_without_config_dir()
```

**Purpose**: Ensures relative stdio working directories are rejected when there is no config directory to resolve them against.

**Data flow**: Builds a provider with a relative `cwd` using `TomlEnvironmentProvider::new`, captures the error, and asserts the protocol-error message.

**Call relations**: Covers the error branch in `normalize_stdio_cwd`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::toml_provider_rejects_duplicate_ids`  (lines 680–703)

```
fn toml_provider_rejects_duplicate_ids()
```

**Purpose**: Verifies that duplicate environment ids in TOML are rejected.

**Data flow**: Builds a provider with two entries sharing `devbox`, captures the error, and asserts the duplicate-id message.

**Call relations**: Exercises duplicate detection in `new_with_config_dir`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::toml_provider_rejects_overlong_id`  (lines 706–725)

```
fn toml_provider_rejects_overlong_id()
```

**Purpose**: Ensures ids longer than the configured maximum are rejected.

**Data flow**: Constructs an id of length `MAX_ENVIRONMENT_ID_LEN + 1`, attempts provider creation, captures the error, and asserts the message includes the maximum length.

**Call relations**: Covers the length check in `validate_environment_id`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::toml_provider_rejects_unknown_default`  (lines 728–740)

```
fn toml_provider_rejects_unknown_default()
```

**Purpose**: Checks that an explicit default id must exist among configured environments or local inclusion.

**Data flow**: Builds a provider with `default = "missing"` and no environments, captures the error, and asserts the message.

**Call relations**: Exercises the unknown-default branch in `normalize_default_environment_id`.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `tests::load_environments_toml_reads_root_environment_list`  (lines 743–801)

```
fn load_environments_toml_reads_root_environment_list()
```

**Purpose**: Verifies end-to-end file loading and TOML deserialization for a representative multi-environment config file.

**Data flow**: Writes a sample `environments.toml` into a temp directory, loads it with `load_environments_toml`, and asserts the parsed top-level fields and both `EnvironmentToml` entries match expected values including durations, args, env, and cwd.

**Call relations**: Exercises the disk-read and serde-deserialization path.

*Call graph*: calls 1 internal fn (load_environments_toml); 3 external calls (assert_eq!, write, tempdir).


##### `tests::load_environments_toml_rejects_unknown_fields`  (lines 804–830)

```
fn load_environments_toml_rejects_unknown_fields()
```

**Purpose**: Ensures unknown TOML fields are rejected because the schema uses `deny_unknown_fields`.

**Data flow**: Writes several malformed TOML files containing unknown keys, calls `load_environments_toml`, captures each error, and asserts the message contains the serde unknown-field text.

**Call relations**: Validates strict schema enforcement in file parsing.

*Call graph*: calls 1 internal fn (load_environments_toml); 4 external calls (assert!, format!, write, tempdir).


##### `tests::toml_provider_rejects_malformed_websocket_url`  (lines 833–850)

```
fn toml_provider_rejects_malformed_websocket_url()
```

**Purpose**: Checks that syntactically malformed WebSocket URLs are rejected even if they use the correct scheme prefix.

**Data flow**: Builds a provider with `url = "ws://"`, captures the error, and asserts the message mentions invalid URL parsing.

**Call relations**: Exercises the tungstenite request-validation branch in `validate_websocket_url`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `tests::environment_provider_from_codex_home_uses_present_environments_file`  (lines 853–877)

```
async fn environment_provider_from_codex_home_uses_present_environments_file()
```

**Purpose**: Verifies that a present `environments.toml` takes precedence over the legacy environment-variable provider.

**Data flow**: Writes a minimal config file into a temp `codex_home`, calls `environment_provider_from_codex_home`, awaits the snapshot, and asserts local is excluded, no local id appears in provider-owned environments, and default is `Disabled` as configured.

**Call relations**: Exercises the config-file-present branch of provider selection.

*Call graph*: calls 1 internal fn (environment_provider_from_codex_home); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `tests::environment_provider_from_codex_home_falls_back_when_file_is_missing`  (lines 880–899)

```
async fn environment_provider_from_codex_home_falls_back_when_file_is_missing()
```

**Purpose**: Verifies that missing `environments.toml` causes fallback to the legacy default provider.

**Data flow**: Creates an empty temp `codex_home`, calls `environment_provider_from_codex_home`, awaits the snapshot, and asserts local inclusion and default `EnvironmentId("local")` with no provider-owned local entry.

**Call relations**: Exercises the file-missing fallback branch.

*Call graph*: calls 1 internal fn (environment_provider_from_codex_home); 3 external calls (assert!, assert_eq!, tempdir).


### Layer state and transforms
These files establish the in-memory layered config model and the core utilities that normalize, merge, fingerprint, and inject override layers into that model.

### `config/src/state.rs`

`domain_logic` · `config load`

This file is the central configuration-layer state model. `ConfigLoadOptions` and `LoaderOverrides` describe out-of-band loading behavior such as alternate file paths, profile selection, managed-config suppression, and test fixtures. `ConfigLayerEntry` represents one loaded layer: its `ConfigLayerSource`, parsed `TomlValue`, computed version fingerprint, optional disabled reason, optional raw TOML text/base directory, and an optional override for where hook declarations should be resolved. Constructors consistently compute `version` with `version_for_toml`, so every layer carries a stable fingerprint.

`ConfigLayerStack` stores layers in a strict invariant: lowest precedence first, highest precedence last. It also caches the active writable user layer index, keeps `ConfigRequirements` and raw `ConfigRequirementsToml` separate from ordinary config merging, tracks whether exec-policy `.rules` files from user/project folders should be ignored, and optionally stores startup warnings. The stack exposes multiple views: merged user-only config, merged effective config across enabled layers, origin metadata keyed by canonicalized config paths, and filtered layer lists in either precedence order. Update helpers preserve precedence by removing/reinserting user layers according to `ConfigLayerSource::precedence()` and recomputing the active user layer as the highest-precedence user entry.

A key validation step is `verify_layer_ordering`, which rejects unsorted precedence and also enforces that project layers progress from repository root toward the current working directory. Disabled layers remain in the stack for diagnostics/API visibility but are excluded from effective merges unless explicitly requested.

#### Function details

##### `ConfigLoadOptions::from`  (lines 29–35)

```
fn from(loader_overrides: LoaderOverrides) -> Self
```

**Purpose**: Builds `ConfigLoadOptions` from a `LoaderOverrides` value, filling in the non-document loading knobs with defaults. It is the convenience conversion used when callers only want override injection.

**Data flow**: Consumes a `LoaderOverrides`, stores it in `loader_overrides`, sets `strict_config` to `false`, and initializes `cloud_config_bundle` with its default loader. It returns a fully populated `ConfigLoadOptions`.

**Call relations**: Invoked through `From<LoaderOverrides>` conversions by config-loading entry points. It delegates only to `CloudConfigBundleLoader::default` so callers get a usable bundle loader without specifying one.

*Call graph*: calls 1 internal fn (default).


##### `LoaderOverrides::without_managed_config_for_tests`  (lines 59–74)

```
fn without_managed_config_for_tests() -> Self
```

**Purpose**: Creates a test-oriented override set that redirects managed/system config paths to temp-dir fixtures instead of host-managed sources. This isolates tests from machine-specific MDM or system configuration.

**Data flow**: Reads `std::env::temp_dir()`, appends `codex-config-tests`, and constructs a `LoaderOverrides` with synthetic `managed_config_path`, `system_config_path`, and `system_requirements_path`; user paths remain unset and ignore flags remain false. On macOS it also injects empty managed-preferences base64 strings.

**Call relations**: Widely used by tests that need deterministic config loading without host interference. It is also the base constructor reused by `LoaderOverrides::with_managed_config_path_for_tests`.

*Call graph*: called by 49 (without_managed_config_for_tests, write_value_rejects_feature_requirement_conflict, refresh_test_state, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread, cold_thread_resume_reuses_non_local_history_probe, start_in_process_server, thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path (+15 more)); 2 external calls (new, temp_dir).


##### `LoaderOverrides::with_managed_config_path_for_tests`  (lines 81–90)

```
fn with_managed_config_path_for_tests(managed_config_path: PathBuf) -> Self
```

**Purpose**: Creates test overrides that load managed config from a specific fixture path while still disabling host MDM inputs. It pairs that managed config with a sibling `requirements.toml` fixture.

**Data flow**: Takes a `PathBuf` for the managed config fixture, derives `system_requirements_path` by replacing the filename with `requirements.toml`, and returns a `LoaderOverrides` that sets those fields while inheriting the rest from `without_managed_config_for_tests()`. No external state is mutated.

**Call relations**: Called by tests that provide explicit managed-config fixtures. It layers a caller-supplied managed config path on top of the generic test-safe override set.

*Call graph*: called by 21 (invalid_user_value_rejected_even_if_overridden_by_managed, load_default_config_preserves_selected_user_config_path_after_load_error, read_includes_origins_and_layers, read_reports_managed_overrides_user_and_session_flags, write_value_defaults_to_selected_user_config_path, write_value_reports_managed_override, write_value_reports_override, write_value_succeeds_when_managed_preferences_expand_home_directory_paths, experimental_feature_list_returns_feature_metadata_with_stage, explicit_remote_control_startup_fails_when_disabled_by_requirements (+11 more)); 2 external calls (with_file_name, without_managed_config_for_tests).


##### `LoaderOverrides::user_config_path`  (lines 92–100)

```
fn user_config_path(&self, codex_home: &Path) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Resolves the effective user config file path, honoring an explicit override when present and otherwise deriving `$CODEX_HOME/config.toml`. It centralizes the path-selection rule used by loaders.

**Data flow**: Reads `self.user_config_path`; if set, clones and returns it. Otherwise it calls `AbsolutePathBuf::resolve_path_against_base` with `crate::CONFIG_TOML_FILE` and the provided `codex_home`, returning an `io::Result<AbsolutePathBuf>`.

**Call relations**: Used by config-loading code whenever it needs the user config location. Its branch structure ensures tests and callers can override the path without changing the rest of the loader.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 2 (load_default_config, user_config_path).


##### `ConfigLayerEntry::new`  (lines 120–130)

```
fn new(name: ConfigLayerSource, config: TomlValue) -> Self
```

**Purpose**: Constructs a normal enabled config layer from a source tag and parsed TOML value. It is the standard constructor for layers that do not need raw-text retention or disabled metadata.

**Data flow**: Consumes a `ConfigLayerSource` and `TomlValue`, computes `version` via `version_for_toml(&config)`, and returns a `ConfigLayerEntry` with `disabled_reason`, `raw_toml`, and hook-folder override unset.

**Call relations**: This is the primary layer constructor used throughout stack assembly and tests. It delegates version fingerprinting to `version_for_toml` so all layers expose consistent metadata.

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

**Purpose**: Constructs an enabled layer while preserving the original TOML text and the base directory it came from. This supports later rendering or path-relative interpretation for non-file-backed fragments.

**Data flow**: Takes source, parsed `TomlValue`, raw TOML `String`, and an `AbsolutePathBuf` base directory; computes the version; stores the raw text/base dir inside `RawTomlLayer`; and returns the populated `ConfigLayerEntry`.

**Call relations**: Used when loaders ingest cloud or fragment-based config and still need access to the original text. It follows the same versioning path as `ConfigLayerEntry::new` but additionally captures raw provenance.

*Call graph*: calls 1 internal fn (version_for_toml); called by 2 (cloud_config_layers_from_fragments_impl, load_config_layers_state).


##### `ConfigLayerEntry::new_disabled`  (lines 152–166)

```
fn new_disabled(
        name: ConfigLayerSource,
        config: TomlValue,
        disabled_reason: impl Into<String>,
    ) -> Self
```

**Purpose**: Constructs a layer that remains present for diagnostics but is marked inactive with a human-readable disabled reason. This lets the stack preserve provenance without letting the layer affect effective config.

**Data flow**: Consumes source, config, and a reason convertible into `String`; computes the version; stores `disabled_reason: Some(...)`; and leaves raw TOML and hook-folder override unset. It returns the disabled entry by value.

**Call relations**: Called by loaders that discover a layer but intentionally suppress it, such as certain project-layer cases. Downstream filtering relies on `is_disabled()` to exclude these entries from merges unless explicitly included.

*Call graph*: calls 1 internal fn (version_for_toml); called by 1 (project_layer_entry); 1 external calls (into).


##### `ConfigLayerEntry::is_disabled`  (lines 168–170)

```
fn is_disabled(&self) -> bool
```

**Purpose**: Reports whether this layer has been marked disabled. It is the predicate used when filtering layers for effective merges or API views.

**Data flow**: Reads `self.disabled_reason` and returns `true` if it is `Some`, otherwise `false`. It does not allocate or mutate state.

**Call relations**: Used indirectly by `ConfigLayerStack::get_layers` to decide whether a layer participates in returned views when `include_disabled` is false.


##### `ConfigLayerEntry::raw_toml`  (lines 172–176)

```
fn raw_toml(&self) -> Option<&str>
```

**Purpose**: Exposes the preserved raw TOML text for layers created with `new_with_raw_toml`. It returns only the string slice, not the owning wrapper.

**Data flow**: Reads `self.raw_toml`; if present, maps it to `&str` via `contents.as_str()`, otherwise returns `None`. No state changes occur.

**Call relations**: Used by rendering/debug code that needs to show the original text for non-file-backed layers. It depends on whether the layer was constructed with raw TOML retention.

*Call graph*: called by 1 (render_non_file_layer_value).


##### `ConfigLayerEntry::raw_toml_base_dir`  (lines 178–180)

```
fn raw_toml_base_dir(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: Returns the base directory associated with preserved raw TOML content. This is the anchor for resolving relative paths in fragment-backed layers.

**Data flow**: Reads `self.raw_toml` and returns `Some(&AbsolutePathBuf)` for the stored `base_dir` when available, else `None`.

**Call relations**: Consumed by code that needs path context for raw TOML layers; it complements `raw_toml()` by exposing the directory side of the preserved provenance.


##### `ConfigLayerEntry::with_hooks_config_folder_override`  (lines 182–188)

```
fn with_hooks_config_folder_override(
        mut self,
        hooks_config_folder_override: Option<AbsolutePathBuf>,
    ) -> Self
```

**Purpose**: Attaches an alternate `.codex` folder to use for hook discovery on this layer. It supports cases where hook lookup should come from a different checkout than the config itself.

**Data flow**: Takes ownership of `self` and an `Option<AbsolutePathBuf>`, writes that option into `hooks_config_folder_override`, and returns the modified entry.

**Call relations**: Used during layer construction when linked-worktree behavior needs hook discovery redirected. `hooks_config_folder()` later consults this override before falling back to the layer's natural config folder.


##### `ConfigLayerEntry::metadata`  (lines 190–195)

```
fn metadata(&self) -> ConfigLayerMetadata
```

**Purpose**: Builds the lightweight metadata view for this layer. It extracts only the source identity and version fingerprint.

**Data flow**: Clones `self.name` and `self.version` into a new `ConfigLayerMetadata` and returns it. No other fields are read or modified.

**Call relations**: Called by origin-recording and API/reporting code that needs stable layer identifiers without the full config payload.

*Call graph*: 1 external calls (clone).


##### `ConfigLayerEntry::as_layer`  (lines 197–204)

```
fn as_layer(&self) -> ConfigLayer
```

**Purpose**: Converts the internal layer entry into the protocol-facing `ConfigLayer` representation. It packages the source, version, JSON-serialized config, and disabled reason for external consumers.

**Data flow**: Clones `name`, `version`, and `disabled_reason`; serializes `self.config` to `serde_json::Value` with `serde_json::to_value`, falling back to `JsonValue::Null` on serialization failure; and returns a `ConfigLayer`.

**Call relations**: Used when exposing layer information over the app-server protocol. It bridges internal TOML storage to JSON transport format.

*Call graph*: 2 external calls (clone, to_value).


##### `ConfigLayerEntry::config_folder`  (lines 207–218)

```
fn config_folder(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Determines the `.codex` folder naturally associated with this layer's source. It encodes source-specific rules for whether a layer has a filesystem-backed config directory at all.

**Data flow**: Matches on `self.name`: returns `None` for MDM, enterprise-managed, session-flags, and legacy managed sources; returns `file.parent()` for system and user file-backed layers; and clones the stored `dot_codex_folder` for project layers.

**Call relations**: This is the default folder-resolution logic used by `hooks_config_folder()`. Its source-specific branching is important because not every layer corresponds to a local directory.


##### `ConfigLayerEntry::hooks_config_folder`  (lines 226–230)

```
fn hooks_config_folder(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the folder that should be searched for hook declarations for this layer. It prefers an explicit override and otherwise falls back to the layer's normal config folder.

**Data flow**: Reads `hooks_config_folder_override`; if present, clones and returns it. Otherwise it calls `config_folder()` and returns that result.

**Call relations**: Called by hook-resolution code such as `config_toml_source_path`. It exists specifically to decouple hook discovery from ordinary config provenance in linked-worktree scenarios.

*Call graph*: called by 1 (config_toml_source_path).


##### `ConfigLayerStack::new`  (lines 273–287)

```
fn new(
        layers: Vec<ConfigLayerEntry>,
        requirements: ConfigRequirements,
        requirements_toml: ConfigRequirementsToml,
    ) -> std::io::Result<Self>
```

**Purpose**: Constructs a validated stack of config layers plus associated requirements state. It enforces ordering invariants before the stack can be used.

**Data flow**: Consumes `layers`, `requirements`, and `requirements_toml`; calls `verify_layer_ordering(&layers)` to compute the active user-layer index; and returns either an `io::Error` or a `ConfigLayerStack` initialized with default flags and no startup warnings.

**Call relations**: This is the canonical constructor used by loaders and tests. Its only delegated validation is `verify_layer_ordering`, which guards all later precedence-sensitive operations.

*Call graph*: calls 1 internal fn (verify_layer_ordering); called by 83 (enterprise_layers_precede_user_and_override_system, load_config_layers_state, active_user_layer_is_highest_precedence_user_layer, origins_use_canonical_key_aliases, with_user_config_updates_matching_user_layer_without_replacing_active_profile, policy_from_config_parts, configured_plugins_from_stack_merges_user_layers, hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities, load_plugins_ignores_project_config_files, loads_skills_from_home_agents_dir_for_user_scope (+15 more)).


##### `ConfigLayerStack::with_user_and_project_exec_policy_rules_ignored`  (lines 289–295)

```
fn with_user_and_project_exec_policy_rules_ignored(
        mut self,
        ignore_user_and_project_exec_policy_rules: bool,
    ) -> Self
```

**Purpose**: Returns a copy of the stack with the exec-policy rule-file suppression flag updated. It is a builder-style modifier for downstream policy loading.

**Data flow**: Takes ownership of `self`, writes the provided boolean into `ignore_user_and_project_exec_policy_rules`, and returns the modified stack.

**Call relations**: Used by orchestration code that wants the same layer stack but different exec-policy behavior. The corresponding getter is consulted later by policy loaders.


##### `ConfigLayerStack::ignore_user_and_project_exec_policy_rules`  (lines 297–299)

```
fn ignore_user_and_project_exec_policy_rules(&self) -> bool
```

**Purpose**: Exposes whether user/project `.rules` files should be skipped when loading exec policy. It is a simple read accessor over stack state.

**Data flow**: Reads the `ignore_user_and_project_exec_policy_rules` field and returns the stored boolean.

**Call relations**: Called by `load_exec_policy` to decide whether filesystem rule files from user and project config folders should participate.

*Call graph*: called by 1 (load_exec_policy).


##### `ConfigLayerStack::with_startup_warnings`  (lines 301–304)

```
fn with_startup_warnings(mut self, startup_warnings: Vec<String>) -> Self
```

**Purpose**: Attaches a concrete startup-warning list to the stack. It distinguishes 'warnings checked and found' from 'warnings not evaluated'.

**Data flow**: Takes ownership of `self`, stores `Some(startup_warnings)` in the field, and returns the updated stack.

**Call relations**: Used by stack-building code after warning analysis. Consumers later inspect the field through `startup_warnings()`.


##### `ConfigLayerStack::startup_warnings`  (lines 306–308)

```
fn startup_warnings(&self) -> Option<&[String]>
```

**Purpose**: Returns the optional startup-warning slice associated with this stack. It preserves the tri-state meaning of unchecked vs checked-empty vs checked-nonempty.

**Data flow**: Reads `self.startup_warnings` and converts `Option<Vec<String>>` to `Option<&[String]>` with `as_deref()`. No mutation occurs.

**Call relations**: Called by `load_config_with_layer_stack` when surfacing startup diagnostics alongside loaded configuration.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `ConfigLayerStack::get_active_user_layer`  (lines 316–319)

```
fn get_active_user_layer(&self) -> Option<&ConfigLayerEntry>
```

**Purpose**: Returns the highest-precedence user layer, which is also the writable target for profile-aware edits. It abstracts away whether there is one user layer or a base-plus-profile pair.

**Data flow**: Reads `self.user_layer_index` and, if present, indexes into `self.layers` to return `Option<&ConfigLayerEntry>`. It does not merge or transform config.

**Call relations**: Used by metadata and trusted-config code that needs the active user layer specifically, not all user layers.

*Call graph*: called by 3 (compute_override_metadata, get_user_config_file, trusted_config_layer_stack).


##### `ConfigLayerStack::get_user_config_file`  (lines 321–327)

```
fn get_user_config_file(&self) -> Option<&AbsolutePathBuf>
```

**Purpose**: Extracts the file path of the active user config layer. It returns `None` if there is no active user layer or if the active layer is unexpectedly not a `User` source.

**Data flow**: Calls `get_active_user_layer()`, pattern-matches the layer's `ConfigLayerSource`, and returns `Some(&AbsolutePathBuf)` for `User { file, .. }` or `None` otherwise.

**Call relations**: This is a convenience wrapper over `get_active_user_layer()`, used by callers that only need the writable user config file path.

*Call graph*: calls 1 internal fn (get_active_user_layer).


##### `ConfigLayerStack::get_user_layers`  (lines 334–343)

```
fn get_user_layers(
        &self,
        ordering: ConfigLayerStackOrdering,
        include_disabled: bool,
    ) -> Vec<&ConfigLayerEntry>
```

**Purpose**: Returns all user layers in caller-selected precedence order, optionally including disabled ones. It is the filtered view used for user-only merges and edits.

**Data flow**: Calls `get_layers(ordering, include_disabled)`, filters the resulting references to entries whose source matches `ConfigLayerSource::User`, and collects them into a `Vec<&ConfigLayerEntry>`.

**Call relations**: Used by `effective_user_config()` and any code that needs the full set of user layers rather than just the active one.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (effective_user_config).


##### `ConfigLayerStack::effective_user_config`  (lines 349–363)

```
fn effective_user_config(&self) -> Option<TomlValue>
```

**Purpose**: Merges only enabled user layers into a single TOML value. With profile-v2 enabled, it overlays the profile layer on top of the base user config.

**Data flow**: Fetches enabled user layers in low-to-high precedence order via `get_user_layers(...)`; if none exist, returns `None`. Otherwise it starts from an empty TOML table and repeatedly applies `merge_toml_values(&mut merged, &layer.config)`, then returns `Some(merged)`.

**Call relations**: Called by plugin and marketplace resolution code that wants the user-only effective view. Its merge order depends on the stack invariant established by `ConfigLayerStack::new`.

*Call graph*: calls 2 internal fn (merge_toml_values, get_user_layers); called by 4 (installed_marketplace_roots_from_layer_stack, configured_plugins_from_stack, configured_plugins_from_stack, configured_git_marketplaces); 2 external calls (Table, new).


##### `ConfigLayerStack::requirements`  (lines 365–367)

```
fn requirements(&self) -> &ConfigRequirements
```

**Purpose**: Returns the composed requirements object associated with the stack. Requirements are intentionally tracked separately from ordinary config layers.

**Data flow**: Reads and returns `&self.requirements` without transformation.

**Call relations**: Used by multiple downstream subsystems when enforcing managed constraints, feature restrictions, network policy, or rendering debug output.

*Call graph*: called by 6 (apply_plugin_mcp_server_requirements, load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile, load_exec_policy, append_managed_requirement_handlers, render_debug_config_lines).


##### `ConfigLayerStack::requirements_toml`  (lines 369–371)

```
fn requirements_toml(&self) -> &ConfigRequirementsToml
```

**Purpose**: Returns the raw requirements TOML model preserved alongside the stack. This keeps original allow-lists and source data available for APIs and diagnostics.

**Data flow**: Reads and returns `&self.requirements_toml` directly.

**Call relations**: Called by code that needs the original requirements representation rather than the composed enforcement object.

*Call graph*: called by 5 (protected_feature_keys, new, load_config_with_layer_stack, managed_network_requirements_enabled, render_debug_config_lines).


##### `ConfigLayerStack::with_user_config`  (lines 379–387)

```
fn with_user_config(&self, config_toml: &AbsolutePathBuf, user_config: TomlValue) -> Self
```

**Purpose**: Replaces or inserts a user layer identified by its config file path while preserving all other layers. It automatically preserves the matching profile identity if the target file already exists in the stack.

**Data flow**: Scans `self.layers` for a `User` layer whose `file` equals `config_toml`, parses any stored profile string into `ProfileV2Name`, and forwards `config_toml`, the optional profile reference, and `user_config` to `with_user_config_profile()`.

**Call relations**: Used by trusted-config editing flows. It is a convenience wrapper over `with_user_config_profile()` that infers the profile from the existing stack.

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

**Purpose**: Creates a new stack with one specific user layer replaced or inserted at the correct precedence position. It is the core mutation path for profile-aware user config updates.

**Data flow**: Builds a fresh `ConfigLayerEntry::new` for `ConfigLayerSource::User { file, profile }`; clones the existing layer vector; removes any existing user layer with the same file; reinserts the new layer before the first layer with higher precedence or appends it; recomputes `user_layer_index` as the last user layer; and returns a new `ConfigLayerStack` carrying cloned requirements and warning state.

**Call relations**: Called by `with_user_config()` after profile inference. Its precedence insertion logic preserves the stack ordering invariant without rerunning full validation.

*Call graph*: calls 1 internal fn (new); called by 1 (with_user_config); 3 external calls (clone, clone, clone).


##### `ConfigLayerStack::with_user_layer_from`  (lines 439–477)

```
fn with_user_layer_from(&self, other: &Self) -> Self
```

**Purpose**: Copies all user layers from another stack into this one while preserving this stack's non-user layers. It is a selective merge operation for user-owned configuration state.

**Data flow**: Clones user layers from `other`, clones non-user layers from `self`, inserts each imported user layer into precedence order, recomputes the highest user-layer index, and returns a new stack with this stack's requirements, flags, and warnings preserved.

**Call relations**: Used when one stack should inherit user config from another without replacing system/project/managed layers. Its insertion logic mirrors `with_user_config_profile()`.

*Call graph*: 2 external calls (clone, clone).


##### `ConfigLayerStack::effective_config`  (lines 483–492)

```
fn effective_config(&self) -> TomlValue
```

**Purpose**: Merges all enabled ordinary config layers into the effective TOML view. It excludes requirements because those are composed separately.

**Data flow**: Starts from an empty TOML table, iterates enabled layers in low-to-high precedence order from `get_layers(...)`, applies `merge_toml_values` for each layer's config, and returns the merged `TomlValue`.

**Call relations**: Called by many downstream config consumers that need the final effective document. It is the stack's main precedence-resolution operation.

*Call graph*: calls 2 internal fn (merge_toml_values, get_layers); called by 6 (protected_feature_keys, apps_config_from_layer_stack, bundled_skills_enabled_from_stack, deserialize_effective_config, network_proxy_spec_for_active_permission_profile, resolve_tool_suggest_config_from_layer_stack); 2 external calls (Table, new).


##### `ConfigLayerStack::origins`  (lines 497–510)

```
fn origins(&self) -> HashMap<String, ConfigLayerMetadata>
```

**Purpose**: Builds a map from canonical config key paths to the metadata of the layer that last set them. It records provenance for the merged config view after key-alias normalization.

**Data flow**: Initializes an empty `HashMap<String, ConfigLayerMetadata>` and mutable path buffer, iterates enabled layers low-to-high, normalizes each layer config with `normalized_with_key_aliases(&layer.config, &[])`, then calls `record_origins` to populate or overwrite origin entries. It returns the completed map.

**Call relations**: Used by diagnostics and APIs that need field-level provenance. The normalization step ensures legacy aliases are recorded under canonical keys before origin tracking.

*Call graph*: calls 3 internal fn (record_origins, normalized_with_key_aliases, get_layers); 2 external calls (new, new).


##### `ConfigLayerStack::layers_high_to_low`  (lines 515–520)

```
fn layers_high_to_low(&self) -> Vec<&ConfigLayerEntry>
```

**Purpose**: Returns enabled layers from highest precedence to lowest. It is a convenience view for callers that want to search from the effective override downward.

**Data flow**: Delegates to `get_layers(ConfigLayerStackOrdering::HighestPrecedenceFirst, false)` and returns the resulting vector of references.

**Call relations**: Called by `find_effective_layer` and similar logic that wants first-match semantics from the top of the stack.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (find_effective_layer).


##### `ConfigLayerStack::get_layers`  (lines 525–539)

```
fn get_layers(
        &self,
        ordering: ConfigLayerStackOrdering,
        include_disabled: bool,
    ) -> Vec<&ConfigLayerEntry>
```

**Purpose**: Returns layer references in the requested precedence order, optionally retaining disabled layers. It is the common filtering and ordering primitive for all stack views.

**Data flow**: Iterates `self.layers`, filters out disabled entries unless `include_disabled` is true, collects references into a vector, and reverses that vector when `ordering` requests highest-precedence-first. It returns `Vec<&ConfigLayerEntry>`.

**Call relations**: This is the shared helper behind user-layer queries, effective merges, origin tracking, and various stack inspections.

*Call graph*: called by 17 (first_layer_config_error, effective_config, get_user_layers, layers_high_to_low, origins, skill_config_rules_from_stack, project_root_markers_from_stack, skill_roots_from_layer_stack_inner, rebuild_preserving_session_layers, load_agent_roles (+7 more)).


##### `verify_layer_ordering`  (lines 544–591)

```
fn verify_layer_ordering(layers: &[ConfigLayerEntry]) -> std::io::Result<Option<usize>>
```

**Purpose**: Validates that a proposed layer list obeys precedence ordering and project-layer nesting rules, and identifies the active user layer index. It prevents malformed stacks from being constructed.

**Data flow**: Reads the slice of `ConfigLayerEntry`; first checks that `layer.name` values are globally sorted by precedence, returning an `InvalidData` error if not. It then scans in order, updating `user_layer_index` whenever it sees a user layer and verifying that each project layer's `.codex` folder is strictly deeper than the previous project's parent chain; on success it returns `Ok(user_layer_index)`.

**Call relations**: Called only by `ConfigLayerStack::new`. Its validation underpins all later assumptions about merge order, active user-layer selection, and project-layer traversal.

*Call graph*: called by 1 (new); 3 external calls (new, iter, matches!).


### `config/src/fingerprint.rs`

`util` · `config load`

This file contains two small but important pieces of config metadata logic. `record_origins` walks a `toml::Value` tree recursively and records the `ConfigLayerMetadata` for every non-container leaf under a dotted path such as `permissions.filesystem.deny_read.0`. Tables contribute key segments, arrays contribute numeric index segments, and only scalar leaves are inserted into the `origins` map. Because the metadata is cloned at each leaf, callers can later answer provenance questions for individual merged config fields.

`version_for_toml` computes a deterministic content hash for an arbitrary TOML value. It first converts the TOML tree into `serde_json::Value`, falling back to `JsonValue::Null` if conversion fails. It then canonicalizes object key ordering recursively with `canonical_json`, serializes the canonical JSON to bytes, hashes those bytes with SHA-256, and returns a string of the form `sha256:<hex>`. Arrays preserve order; objects are sorted lexicographically by key before hashing. This means semantically identical TOML objects with different key orderings produce the same version string, which is useful for lockfiles, cache keys, and layer-version tracking.

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

**Purpose**: Recursively records which config layer metadata produced each scalar leaf in a TOML value tree.

**Data flow**: Reads a `TomlValue`, current `ConfigLayerMetadata`, mutable path segment vector, and mutable `HashMap<String, ConfigLayerMetadata>`. For tables it pushes each key, recurses, then pops; for arrays it pushes each numeric index string, recurses, then pops; for non-container leaves it joins the current path with `.` and inserts a cloned metadata value when the path is non-empty.

**Call relations**: Called by higher-level origin-tracking code after a layer is parsed so merged config can later report provenance per dotted field path.

*Call graph*: called by 1 (origins); 1 external calls (clone).


##### `version_for_toml`  (lines 37–49)

```
fn version_for_toml(value: &TomlValue) -> String
```

**Purpose**: Computes a stable SHA-256 version string for a TOML value independent of object key ordering.

**Data flow**: Converts the input `TomlValue` to `serde_json::Value`, canonicalizes it with `canonical_json`, serializes the canonical JSON to bytes, hashes the bytes with `Sha256`, hex-encodes the digest, and returns `sha256:<hex>`.

**Call relations**: Used when constructing config-layer metadata objects so each layer or merged value can carry a deterministic content fingerprint.

*Call graph*: calls 1 internal fn (canonical_json); called by 3 (new, new_disabled, new_with_raw_toml); 4 external calls (new, format!, to_value, to_vec).


##### `canonical_json`  (lines 51–67)

```
fn canonical_json(value: &JsonValue) -> JsonValue
```

**Purpose**: Recursively canonicalizes JSON object key ordering while preserving array order and scalar values.

**Data flow**: Matches the input `JsonValue`: objects are rebuilt into a new `serde_json::Map` after sorting keys and recursively canonicalizing values; arrays are mapped recursively element-by-element; scalars are cloned unchanged.

**Call relations**: Used only by `version_for_toml` to ensure hashing is stable across equivalent object key orderings.

*Call graph*: called by 1 (version_for_toml); 3 external calls (Array, Object, new).


### `config/src/merge.rs`

`util` · `config merge`

This file implements the low-level merge algorithm used to combine layered configuration sources. The public entrypoint, `merge_toml_values`, recursively overlays one `toml::Value` onto another, always giving the overlay precedence. The recursion is path-aware: as it descends through nested tables, it tracks the current key path in a mutable `Vec<String>` so it can normalize legacy key aliases in the correct scope and apply special-case behavior only at specific locations.

The main worker, `merge_toml_values_at_path`, merges table-to-table structurally and replaces non-table values wholesale. Before merging a table level, it normalizes aliases in both the base and overlay tables using `normalize_key_aliases`; when the current path matches `permissions.*.network.domains`, it additionally canonicalizes domain-pattern keys with `normalize_host` so differently cased hostnames collide and overlay correctly. Existing keys recurse, while new keys are inserted after being normalized with `normalized_with_key_aliases` for their destination path. This means alias cleanup happens both for whole-table merges and for leaf insertions. The design preserves TOML structure while ensuring semantically equivalent keys from different config layers do not coexist under different spellings or host casing.

#### Function details

##### `merge_toml_values`  (lines 7–9)

```
fn merge_toml_values(base: &mut TomlValue, overlay: &TomlValue)
```

**Purpose**: Starts a recursive overlay merge of one TOML value into another with overlay precedence.

**Data flow**: Takes mutable `base` and immutable `overlay`; creates an empty path vector; delegates the actual merge to `merge_toml_values_at_path`; mutates `base` in place and returns nothing.

**Call relations**: This is the public merge helper used by config-layer composition and permission-profile merging. It exists as the stable entrypoint while `merge_toml_values_at_path` performs the recursive work.

*Call graph*: calls 1 internal fn (merge_toml_values_at_path); called by 5 (load_config_layers_state, merge_permission_profiles, compose, effective_config, effective_user_config); 1 external calls (new).


##### `merge_toml_values_at_path`  (lines 11–35)

```
fn merge_toml_values_at_path(base: &mut TomlValue, overlay: &TomlValue, path: &mut Vec<String>)
```

**Purpose**: Recursively merges TOML values while normalizing aliases and special-case keys according to the current nested path.

**Data flow**: Receives mutable `base`, immutable `overlay`, and the current path stack. If both values are tables, it normalizes aliases in both tables, optionally normalizes network-domain keys when the path matches `permissions.*.network.domains`, then iterates overlay entries: for existing keys it pushes the key onto `path` and recurses into the existing value; for new keys it inserts a normalized copy of the overlay value. If either side is not a table, it replaces `base` with a normalized copy of `overlay`.

**Call relations**: Called only by `merge_toml_values`, it delegates path classification to `is_permission_network_domains_path`, domain-key canonicalization to `normalize_network_domain_keys`, and alias-aware value normalization to `normalized_with_key_aliases`.

*Call graph*: calls 4 internal fn (normalize_key_aliases, normalized_with_key_aliases, is_permission_network_domains_path, normalize_network_domain_keys); called by 1 (merge_toml_values).


##### `is_permission_network_domains_path`  (lines 37–43)

```
fn is_permission_network_domains_path(path: &[String]) -> bool
```

**Purpose**: Recognizes the specific nested path where network-domain keys should be host-normalized before merging.

**Data flow**: Reads a slice of path segments and pattern-matches it against `permissions`, any profile name, `network`, `domains`; returns a boolean.

**Call relations**: It is consulted by `merge_toml_values_at_path` to decide whether to invoke domain-key normalization on the current table level.

*Call graph*: called by 1 (merge_toml_values_at_path); 1 external calls (matches!).


##### `normalize_network_domain_keys`  (lines 45–50)

```
fn normalize_network_domain_keys(table: &mut toml::map::Map<String, TomlValue>)
```

**Purpose**: Canonicalizes all keys in a TOML table as normalized host/domain patterns.

**Data flow**: Takes a mutable TOML table, drains it with `std::mem::take`, runs each original key through `normalize_host`, and reinserts the original values under normalized keys.

**Call relations**: This helper is called from `merge_toml_values_at_path` only for permission network-domain tables so hostnames differing only by case or equivalent formatting merge into one entry.

*Call graph*: called by 1 (merge_toml_values_at_path); 3 external calls (insert, normalize_host, take).


### `config/src/overrides.rs`

`util` · `config override application`

This file converts command-line override pairs into a synthetic `toml::Value` tree that can be merged with other config layers. The public helper `build_cli_overrides_layer` starts from an empty TOML table and applies each `(path, value)` pair in sequence, where `path` is a dotted key like `network.proxy_url` or `plugins.demo.enabled`.

The core logic lives in `apply_toml_override`. It walks the dotted path segment by segment using a peekable iterator so it can distinguish intermediate segments from the final leaf. For intermediate segments, it ensures the current node is a table; if the current node is some other TOML type, it is replaced with a fresh table so traversal can continue. For the final segment, it inserts the provided value into the current table, again replacing a non-table current node with a new table if necessary. This means later overrides can carve nested structure through previously scalar nodes instead of failing. The implementation is intentionally minimal: it does not parse values, validate schema, or merge arrays; it only constructs the TOML shape needed for the broader config-layer merge pipeline.

#### Function details

##### `default_empty_table`  (lines 3–5)

```
fn default_empty_table() -> TomlValue
```

**Purpose**: Creates an empty TOML table value to serve as the root of an overrides layer.

**Data flow**: Takes no input, constructs `TomlValue::Table(Default::default())`, and returns it.

**Call relations**: This is used by `build_cli_overrides_layer` as the initial mutable root before individual dotted-path overrides are applied.

*Call graph*: called by 1 (build_cli_overrides_layer); 2 external calls (default, Table).


##### `build_cli_overrides_layer`  (lines 7–13)

```
fn build_cli_overrides_layer(cli_overrides: &[(String, TomlValue)]) -> TomlValue
```

**Purpose**: Converts a list of CLI override assignments into one TOML tree.

**Data flow**: Takes a slice of `(String, TomlValue)` pairs, initializes an empty root table with `default_empty_table`, iterates through the overrides, clones each value, applies it at its dotted path with `apply_toml_override`, and returns the resulting root `TomlValue`.

**Call relations**: Config loading calls this to turn parsed CLI overrides into a mergeable config layer; it delegates all path traversal and mutation details to `apply_toml_override`.

*Call graph*: calls 2 internal fn (apply_toml_override, default_empty_table); called by 1 (load_config_layers_state).


##### `apply_toml_override`  (lines 16–55)

```
fn apply_toml_override(root: &mut TomlValue, path: &str, value: TomlValue)
```

**Purpose**: Applies one dotted-path assignment into a mutable TOML tree, creating intermediate tables as needed.

**Data flow**: Receives mutable `root`, a dotted `path`, and a `TomlValue` to assign. It splits the path on `.` and walks each segment. For non-final segments, it ensures the current node is a table and descends into an existing or newly inserted child table. For the final segment, it inserts the provided value into the current table; if the current node is not a table, it replaces it with a new table first. It mutates `root` in place and returns nothing.

**Call relations**: This is the worker used by `build_cli_overrides_layer` for each override pair, encapsulating the tree-construction behavior for nested CLI settings.

*Call graph*: called by 1 (build_cli_overrides_layer); 2 external calls (new, Table).


### `config/src/thread_config.rs`

`domain_logic` · `request handling`

This module introduces a separate config source for thread-scoped settings. `ThreadConfigContext` carries lookup context such as `thread_id` and `cwd`. The typed payloads are split by authority: `SessionThreadConfig` contains service-owned values like `model_provider`, a `HashMap<String, ModelProviderInfo>` of provider definitions, and feature flags in a `BTreeMap<String, bool>`; `UserThreadConfig` is currently empty but reserved for future user-owned thread settings. `ThreadConfigSource` tags either payload, and `ThreadConfigLoadError` plus `ThreadConfigLoadErrorCode` provide stable failure categories with optional HTTP status codes.

The `ThreadConfigLoader` trait asks implementations to fetch typed sources via `load`; its default `load_config_layers` method then converts those sources into `ConfigLayerEntry` values so thread config can participate in the normal layer stack. Conversion is intentionally conservative: session config is serialized into a TOML table and emitted as a `ConfigLayerSource::SessionFlags` layer only if the table is non-empty, while user thread config currently produces no layer at all. `session_thread_config_to_toml` performs the typed-to-TOML mapping, preserving scalar `model_provider`, serializing `model_providers` via `TomlValue::try_from`, and building a `[features]` table from the ordered feature map. `StaticThreadConfigLoader` returns a fixed source list for tests or embedding, and `NoopThreadConfigLoader` returns an empty list when no external thread config source is configured.

#### Function details

##### `ThreadConfigLoadError::new`  (lines 63–73)

```
fn new(
        code: ThreadConfigLoadErrorCode,
        status_code: Option<u16>,
        message: impl Into<String>,
    ) -> Self
```

**Purpose**: Constructs a typed thread-config loading error with a stable category, optional status code, and message. It standardizes error creation across loader implementations.

**Data flow**: Takes a `ThreadConfigLoadErrorCode`, `Option<u16>` status code, and message convertible into `String`; stores them in a new `ThreadConfigLoadError`; and returns it by value.

**Call relations**: Used by remote loader code and TOML-conversion failures to produce consistent error values that callers can inspect via `code()` and `status_code()`.

*Call graph*: called by 3 (load, parse_error, remote_status_to_error); 1 external calls (into).


##### `ThreadConfigLoadError::code`  (lines 75–77)

```
fn code(&self) -> ThreadConfigLoadErrorCode
```

**Purpose**: Returns the stable error category for a thread-config load failure. It lets callers branch on auth, timeout, parse, request, or internal failures.

**Data flow**: Reads `self.code` and returns the `ThreadConfigLoadErrorCode` copy.

**Call relations**: Called by error-handling code that needs machine-readable classification rather than parsing the message string.


##### `ThreadConfigLoadError::status_code`  (lines 79–81)

```
fn status_code(&self) -> Option<u16>
```

**Purpose**: Returns the optional transport/status code associated with the failure. It preserves HTTP-like status information when available.

**Data flow**: Reads `self.status_code` and returns the `Option<u16>` copy.

**Call relations**: Used by callers that want to surface or log the underlying remote status alongside the stable error category.


##### `ThreadConfigLoader::load_config_layers`  (lines 102–114)

```
fn load_config_layers(
        &self,
        context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ConfigLayerEntry>>
```

**Purpose**: Loads typed thread config sources and converts them into ordinary config layers. It is the trait's default bridge from source-specific payloads to stack-ready `ConfigLayerEntry` values.

**Data flow**: Takes a `ThreadConfigContext`, awaits `self.load(context)`, maps each returned `ThreadConfigSource` through `thread_config_source_to_layer`, collects `Result<Vec<Option<ConfigLayerEntry>>, _>`, flattens out `None` entries, and returns `Result<Vec<ConfigLayerEntry>, ThreadConfigLoadError>` inside a boxed future.

**Call relations**: Most callers are expected to use this method instead of `load` directly so thread config participates in the normal config-layer precedence flow. It delegates source translation to `thread_config_source_to_layer`.

*Call graph*: 1 external calls (pin).


##### `StaticThreadConfigLoader::new`  (lines 127–129)

```
fn new(sources: Vec<ThreadConfigSource>) -> Self
```

**Purpose**: Creates a loader backed by a fixed vector of typed thread config sources. It is primarily useful for tests and deterministic embedding.

**Data flow**: Consumes a `Vec<ThreadConfigSource>`, stores it in the `sources` field, and returns `StaticThreadConfigLoader`.

**Call relations**: Used by tests and code paths that want a simple in-memory implementation of the `ThreadConfigLoader` trait.

*Call graph*: called by 4 (derive_config_from_params_uses_session_thread_config_model_provider, loader_returns_session_and_user_sources, loader_translates_sources_to_config_layers, includes_thread_config_layers_in_stack).


##### `StaticThreadConfigLoader::load`  (lines 133–138)

```
fn load(
        &self,
        _context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Returns the loader's preconfigured thread config sources without consulting the context. It is the trivial `ThreadConfigLoader` implementation for static data.

**Data flow**: Ignores the provided `ThreadConfigContext`, clones `self.sources`, and returns `Ok(cloned_sources)` inside a boxed async future.

**Call relations**: Invoked through the `ThreadConfigLoader` trait, often indirectly by `load_config_layers()`. It performs no delegation beyond cloning the stored vector.

*Call graph*: 1 external calls (pin).


##### `NoopThreadConfigLoader::load`  (lines 146–151)

```
fn load(
        &self,
        _context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Implements a thread-config loader that always yields no sources. It is the default when no external thread config mechanism is configured.

**Data flow**: Ignores the provided `ThreadConfigContext` and returns `Ok(Vec::new())` inside a boxed async future.

**Call relations**: Used wherever the system wants a do-nothing loader that still satisfies the `ThreadConfigLoader` trait.

*Call graph*: 2 external calls (pin, new).


##### `thread_config_source_to_layer`  (lines 154–174)

```
fn thread_config_source_to_layer(
    source: ThreadConfigSource,
) -> Result<Option<ConfigLayerEntry>, ThreadConfigLoadError>
```

**Purpose**: Converts one typed thread config source into an optional config layer. Session sources become `SessionFlags` layers when non-empty; user sources currently produce nothing.

**Data flow**: Consumes a `ThreadConfigSource`. For `Session`, it calls `session_thread_config_to_toml`, checks the result with `is_empty_table`, and returns `Ok(None)` for empty config or `Ok(Some(ConfigLayerEntry::new(ConfigLayerSource::SessionFlags, config)))` otherwise. For `User`, it returns `Ok(None)`.

**Call relations**: Called by `ThreadConfigLoader::load_config_layers` for each loaded source. It encapsulates the current policy that only session-owned thread config maps to TOML-backed layers.

*Call graph*: calls 3 internal fn (new, is_empty_table, session_thread_config_to_toml).


##### `is_empty_table`  (lines 176–178)

```
fn is_empty_table(config: &TomlValue) -> bool
```

**Purpose**: Checks whether a TOML value is specifically an empty table. It is used to suppress emission of meaningless empty session layers.

**Data flow**: Borrows a `TomlValue`, calls `as_table()`, and returns true only when the value is a table and that table is empty.

**Call relations**: Used only by `thread_config_source_to_layer` after converting session config to TOML.

*Call graph*: called by 1 (thread_config_source_to_layer); 1 external calls (as_table).


##### `session_thread_config_to_toml`  (lines 180–213)

```
fn session_thread_config_to_toml(
    config: SessionThreadConfig,
) -> Result<TomlValue, ThreadConfigLoadError>
```

**Purpose**: Serializes `SessionThreadConfig` into the TOML shape expected by the ordinary config stack. It maps typed session-owned fields into top-level config keys and a `[features]` table.

**Data flow**: Consumes `SessionThreadConfig`, starts an empty TOML map, inserts `model_provider` as a string when present, converts non-empty `model_providers` with `TomlValue::try_from` and maps conversion failures into `ThreadConfigLoadError::new(Parse, None, ...)`, converts non-empty `features` into a TOML table of booleans, and returns `TomlValue::Table(table)`.

**Call relations**: Called by `thread_config_source_to_layer` for session sources. Its parse-error mapping is the only place in this file where TOML conversion can fail.

*Call graph*: called by 1 (thread_config_source_to_layer); 4 external calls (String, Table, try_from, new).


##### `tests::loader_returns_session_and_user_sources`  (lines 224–253)

```
async fn loader_returns_session_and_user_sources()
```

**Purpose**: Verifies that `StaticThreadConfigLoader` returns its configured typed sources unchanged. It checks both session and user source preservation.

**Data flow**: Builds a static loader with one `Session` and one `User` source, calls `load(...)` with a context containing `thread_id`, awaits the result, and asserts equality with the original source vector.

**Call relations**: This async test exercises the raw `load` trait method rather than layer conversion.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert_eq!, vec!).


##### `tests::loader_translates_sources_to_config_layers`  (lines 256–298)

```
async fn loader_translates_sources_to_config_layers()
```

**Purpose**: Verifies that typed thread config sources are translated into the expected `SessionFlags` config layer. It checks TOML shape, omission of empty user config, and preservation of provider/feature data.

**Data flow**: Builds a static loader with a `User` source and a populated `Session` source, calls `load_config_layers(...)` with a context containing an absolute cwd, awaits the result, and asserts that the returned vector contains exactly one `ConfigLayerEntry::new(ConfigLayerSource::SessionFlags, expected_toml)`.

**Call relations**: This async test drives the full `load_config_layers` path, including `thread_config_source_to_layer`, `session_thread_config_to_toml`, and empty-layer suppression.

*Call graph*: calls 2 internal fn (new, from_absolute_path_checked); 4 external calls (default, assert_eq!, temp_dir, vec!).


##### `tests::test_provider`  (lines 300–320)

```
fn test_provider(name: &str) -> ModelProviderInfo
```

**Purpose**: Constructs a representative `ModelProviderInfo` fixture used by the thread-config tests. It supplies stable provider metadata for equality assertions.

**Data flow**: Takes a provider name string and returns a fully populated `ModelProviderInfo` with fixed base URL, `WireApi::Responses`, and explicit boolean capability flags, leaving optional auth/header/retry fields as `None`.

**Call relations**: Used by both async tests in this module to avoid duplicating verbose provider construction.


### Cloud and managed inputs
These files define cloud bundle ingestion and managed-layer parsing, including validation and platform-specific acquisition of externally supplied configuration.

### `cloud-config/src/validation.rs`

`domain_logic` · `validation step during cache acceptance and remote fetch success handling`

This file contains the semantic validation gate used before any bundle is accepted from cache or backend. Validation is intentionally two-stage. First, it clones the incoming `CloudConfigBundle` and passes it with the resolved base directory into `CloudConfigBundleLayers::from_bundle`. That step parses the bundle into layered config/requirements structures and catches malformed TOML or invalid layer construction. Any error is immediately mapped into `CloudConfigBundleLoadError::new(CloudConfigBundleLoadErrorCode::InvalidBundle, None, format!("invalid cloud config bundle: {err}"))`.

If layer construction succeeds, the function destructures the resulting `CloudConfigBundleLayers`, explicitly ignoring `enterprise_managed_config` and retaining `enterprise_managed_requirements`. It then calls `compose_requirements` on those requirements layers. This second step ensures the requirements fragments are not only syntactically valid but also semantically composable as a combined requirements policy. Composition failures are mapped into the same `InvalidBundle` error shape and message prefix.

The function returns `Ok(())` only if both parsing/layer construction and requirements composition succeed. By centralizing this logic, the service applies identical validation rules to cached bundles and freshly fetched remote bundles, guaranteeing fail-closed behavior before caching or runtime use.

#### Function details

##### `validate_bundle`  (lines 8–34)

```
fn validate_bundle(
    bundle: &CloudConfigBundle,
    base_dir: &AbsolutePathBuf,
) -> Result<(), CloudConfigBundleLoadError>
```

**Purpose**: Parses a bundle into layered config/requirements structures and verifies that the requirements layers compose without error.

**Data flow**: Borrows a `CloudConfigBundle` and `AbsolutePathBuf` base directory. It clones the bundle and passes it to `CloudConfigBundleLayers::from_bundle`; any error is transformed into `CloudConfigBundleLoadError` with code `InvalidBundle` and a prefixed message. On success it destructures the layers, keeps `enterprise_managed_requirements`, and passes them to `compose_requirements`; composition errors are mapped into the same load-error shape. If both steps succeed it returns `Ok(())`.

**Call relations**: Called by the service both when evaluating cached bundles and when processing successful remote fetches, ensuring the same semantic checks gate both sources before use or cache write.

*Call graph*: calls 1 internal fn (from_bundle); called by 2 (load_valid_cached_bundle, validate_and_cache_remote_bundle); 2 external calls (compose_requirements, clone).


### `config/src/cloud_config_bundle.rs`

`domain_logic` · `managed-config fetch and config layer assembly`

This file models the backend payload that delivers managed configuration in grouped buckets. `CloudConfigBundle` contains two top-level sections: `config_toml` and `requirements_toml`, each currently with an `enterprise_managed` vector. The exhaustive destructuring in both `is_empty` and `from_bundle_impl` is deliberate: adding a new bucket forces this file to decide how that bucket participates in layer construction.

`CloudConfigBundleLayers` is the semantic conversion target. `from_bundle` and `from_bundle_strict_config` differ only in whether config fragments are validated strictly for unknown fields. Internally, `from_bundle_impl` converts config fragments through the cloud-config-layer helpers, then maps each `CloudRequirementsFragment` into a `RequirementsLayerEntry` sourced as `RequirementSource::EnterpriseManaged { id, name }`, attaches the provided base directory, and reverses the resulting vector because bundle order is highest-priority-first while requirements merging expects lowest-to-highest.

The file also defines `CloudConfigBundleLoadError`, which carries a coarse error code, optional HTTP status code, and display message for remote bundle fetch failures. Finally, `CloudConfigBundleLoader` wraps a future in `Shared<BoxFuture<...>>`, allowing multiple callers to await the same in-flight load and receive the same `Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>` without re-running the fetch logic. Its `Default` implementation yields a loader that always resolves to `Ok(None)`.

#### Function details

##### `CloudConfigBundle::is_empty`  (lines 31–44)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the bundle contains no enterprise-managed config fragments and no enterprise-managed requirements fragments.

**Data flow**: Reads `self.config_toml.enterprise_managed` and `self.requirements_toml.enterprise_managed` via exhaustive destructuring and returns `true` only when both vectors are empty.

**Call relations**: Used by higher-level optional-bundle logic to distinguish an absent/effectively empty managed bundle from one that contributes actual layers.

*Call graph*: called by 1 (optional_bundle).


##### `CloudConfigBundleLayers::from_bundle`  (lines 77–82)

```
fn from_bundle(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
    ) -> Result<Self, CloudConfigLayerError>
```

**Purpose**: Converts a cloud bundle into config and requirements layer vectors using non-strict config parsing.

**Data flow**: Consumes a `CloudConfigBundle`, borrows `base_dir`, forwards both plus `strict_config = false` to `from_bundle_impl`, and returns the resulting `CloudConfigBundleLayers` or `CloudConfigLayerError`.

**Call relations**: Called by bundle validation and config-loading flows when unknown config keys should not be rejected. It is a thin convenience wrapper over `from_bundle_impl`.

*Call graph*: called by 3 (validate_bundle, bundle_layers_preserve_enterprise_managed_bucket_order, load_config_layers_state); 1 external calls (from_bundle_impl).


##### `CloudConfigBundleLayers::from_bundle_strict_config`  (lines 84–89)

```
fn from_bundle_strict_config(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
    ) -> Result<Self, CloudConfigLayerError>
```

**Purpose**: Converts a cloud bundle into layer vectors while strictly rejecting unknown config fields in cloud config fragments.

**Data flow**: Consumes a `CloudConfigBundle`, borrows `base_dir`, forwards both plus `strict_config = true` to `from_bundle_impl`, and returns the result.

**Call relations**: Used by strict validation tests and config-loading paths that want stronger validation guarantees. Like `from_bundle`, it delegates all real work to `from_bundle_impl`.

*Call graph*: called by 2 (bundle_layers_can_strict_validate_enterprise_managed_config, load_config_layers_state); 1 external calls (from_bundle_impl).


##### `CloudConfigBundleLayers::from_bundle_impl`  (lines 91–136)

```
fn from_bundle_impl(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
        strict_config: bool,
    ) -> Result<Self, CloudConfigLayerError>
```

**Purpose**: Performs the actual bucket-to-layer conversion for both config and requirements fragments, preserving intended precedence semantics.

**Data flow**: Consumes the bundle and destructures it into `config_enterprise_managed` and `requirements_enterprise_managed`. Depending on `strict_config`, it converts config fragments with either `cloud_config_layers_from_fragments_strict` or `cloud_config_layers_from_fragments`. It then maps each requirements fragment into `RequirementsLayerEntry::from_toml(RequirementSource::EnterpriseManaged { id, name }, contents).with_base_dir(base_dir.clone())`, collects them into a vector, reverses that vector to convert highest-first bundle order into lowest-first merge order, and returns `CloudConfigBundleLayers { enterprise_managed_config, enterprise_managed_requirements }`.

**Call relations**: This is the central conversion routine behind both public constructors. It delegates config parsing/validation to the cloud-config-layer module and performs requirements conversion inline because requirements fragments already arrive as TOML strings suitable for `RequirementsLayerEntry`.

*Call graph*: calls 1 internal fn (cloud_config_layers_from_fragments_strict); 1 external calls (cloud_config_layers_from_fragments).


##### `CloudConfigBundleLoadError::new`  (lines 157–167)

```
fn new(
        code: CloudConfigBundleLoadErrorCode,
        status_code: Option<u16>,
        message: impl Into<String>,
    ) -> Self
```

**Purpose**: Constructs a structured bundle-load error with a stable code, optional HTTP status, and human-readable message.

**Data flow**: Takes a `CloudConfigBundleLoadErrorCode`, `Option<u16>` status code, and any `Into<String>` message, converts the message into `String`, stores all three fields, and returns the new error value.

**Call relations**: Used by remote-fetch and error-mapping code to classify failures such as auth, timeout, invalid bundle, or internal errors before surfacing them to config-loading logic.

*Call graph*: called by 6 (config_load_error_marks_cloud_config_bundle_failures_for_relogin, config_load_error_marks_invalid_cloud_config_bundle_failures_without_relogin, config_load_error_marks_non_auth_cloud_config_bundle_failures_without_relogin, fetch_remote_bundle_and_update_cache_with_retries, handle_unauthorized, load_config_layers_fails_when_cloud_config_bundle_loader_fails); 1 external calls (into).


##### `CloudConfigBundleLoadError::code`  (lines 169–171)

```
fn code(&self) -> CloudConfigBundleLoadErrorCode
```

**Purpose**: Returns the coarse classification code associated with a bundle-load failure.

**Data flow**: Reads `self.code` and returns the enum by value.

**Call relations**: Called by higher-level error handling that needs to branch on auth vs timeout vs invalid-bundle semantics.


##### `CloudConfigBundleLoadError::status_code`  (lines 173–175)

```
fn status_code(&self) -> Option<u16>
```

**Purpose**: Returns the optional HTTP status code captured for a bundle-load failure.

**Data flow**: Reads `self.status_code` and returns the `Option<u16>`.

**Call relations**: Used by callers that want transport-level diagnostics or relogin decisions informed by the original HTTP response.


##### `CloudConfigBundleLoader::new`  (lines 184–193)

```
fn new(fut: F) -> Self
```

**Purpose**: Wraps an arbitrary async bundle-loading future so its result can be shared across multiple awaiters and executed only once.

**Data flow**: Accepts any `Send + 'static` future producing `Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>`, boxes it into a `BoxFuture`, converts it to a `Shared` future, stores that in `self.fut`, and returns the loader.

**Call relations**: Used by production and test setup to turn fetch logic into a reusable loader object. The shared future behavior is verified by tests that call `get()` concurrently.

*Call graph*: called by 4 (cloud_config_bundle_loader, shared_future_runs_once, into_loader, load_config_layers_fails_when_cloud_config_bundle_loader_fails); 1 external calls (boxed).


##### `CloudConfigBundleLoader::get`  (lines 195–197)

```
async fn get(&self) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>
```

**Purpose**: Awaits the shared bundle-loading future and returns the cached/shared result to the caller.

**Data flow**: Clones `self.fut` and awaits it, yielding `Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>`. No external state is mutated beyond the shared future’s internal completion state.

**Call relations**: Called by config-loading code and tests. Because the underlying future is `Shared`, multiple invocations participate in the same in-flight computation rather than triggering duplicate loads.

*Call graph*: 1 external calls (clone).


##### `CloudConfigBundleLoader::fmt`  (lines 201–203)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements a minimal `Debug` representation for the loader without exposing the opaque future internals.

**Data flow**: Writes a debug struct named `CloudConfigBundleLoader` to the provided formatter and returns the formatting result.

**Call relations**: Used implicitly whenever the loader is logged or included in debug output.

*Call graph*: 1 external calls (debug_struct).


##### `CloudConfigBundleLoader::default`  (lines 207–209)

```
fn default() -> Self
```

**Purpose**: Creates a no-op loader whose shared future immediately resolves to `Ok(None)`.

**Data flow**: Calls `CloudConfigBundleLoader::new` with an async block returning `Ok(None)` and returns the resulting loader.

**Call relations**: Widely used as the default managed-config loader in runtime and tests when no remote bundle source is configured.

*Call graph*: called by 34 (runtime_start_args_forward_environment_manager, runtime_start_args_use_remote_thread_config_loader_when_configured, start_test_client_with_capacity, without_managed_config_for_tests, invalid_user_value_rejected_even_if_overridden_by_managed, load_default_config_preserves_selected_user_config_path_after_load_error, read_includes_origins_and_layers, read_reports_managed_overrides_user_and_session_flags, write_value_defaults_to_selected_user_config_path, write_value_reports_managed_override (+15 more)); 1 external calls (new).


### `config/src/cloud_config_layers.rs`

`domain_logic` · `cloud config parsing during config load`

This module converts raw backend config fragments into the same layer abstraction used by the rest of the config stack. `CloudConfigFragment` carries the backend-provided `id`, `name`, and TOML `contents`; `source_ref()` extracts just the identifying fields into `CloudConfigFragmentSource`, which also implements `Display` as `"<name> (<id>)"` for diagnostics.

The public entrypoints `cloud_config_layers_from_fragments` and `cloud_config_layers_from_fragments_strict` differ only by a strictness flag. Both delegate to `cloud_config_layers_from_fragments_impl`, which iterates fragments in backend order, parses each fragment’s TOML into `TomlValue`, optionally validates ignored/unknown fields against `ConfigToml`, resolves relative path fields using `resolve_relative_paths_in_config_toml(base_dir)`, and wraps the result in `ConfigLayerEntry::new_with_raw_toml` with `ConfigLayerSource::EnterpriseManaged { id, name }`. Parse failures become `CloudConfigLayerError::Parse`; path-resolution or strict-validation failures become `Invalid`.

A key invariant is precedence conversion: backend fragments arrive highest-priority first, but `ConfigLayerStack` folds lowest-to-highest, so the collected layer vector is reversed before returning. Strict validation temporarily installs an `AbsolutePathBufGuard` around the base directory before calling `config_error_from_ignored_toml_value_fields_for_source_name`, ensuring path-sensitive config decoding behaves consistently with normal loading. The file also provides `From<CloudConfigLayerError> for io::Error`, mapping these domain errors to `InvalidData` for generic I/O-oriented callers.

#### Function details

##### `CloudConfigFragment::source_ref`  (lines 34–39)

```
fn source_ref(&self) -> CloudConfigFragmentSource
```

**Purpose**: Builds a lightweight diagnostic source object from a fragment’s identifying fields.

**Data flow**: Reads `self.id` and `self.name`, clones both strings, and returns a new `CloudConfigFragmentSource`.

**Call relations**: Used internally by fragment conversion to preserve stable source metadata across parse and validation errors.


##### `CloudConfigFragmentSource::fmt`  (lines 49–51)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a fragment source as `name (id)` for human-readable diagnostics.

**Data flow**: Reads `self.name` and `self.id`, writes them into the formatter with `write!`, and returns the formatting result.

**Call relations**: Used implicitly when strict validation constructs source-name strings for error reporting.

*Call graph*: 1 external calls (write!).


##### `cloud_config_layers_from_fragments`  (lines 68–73)

```
fn cloud_config_layers_from_fragments(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError>
```

**Purpose**: Converts cloud config fragments into config layers using permissive parsing that does not reject unknown fields.

**Data flow**: Accepts an iterator of `CloudConfigFragment` and a borrowed `AbsolutePathBuf`, forwards them with `strict_config = false` to `cloud_config_layers_from_fragments_impl`, and returns the resulting layer vector or error.

**Call relations**: This is the normal conversion entrypoint used by bundle conversion and tests when strict schema enforcement is not desired.

*Call graph*: calls 1 internal fn (cloud_config_layers_from_fragments_impl).


##### `cloud_config_layers_from_fragments_strict`  (lines 75–80)

```
fn cloud_config_layers_from_fragments_strict(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError>
```

**Purpose**: Converts cloud config fragments into config layers while rejecting unknown/ignored config fields.

**Data flow**: Accepts fragments and `base_dir`, forwards them with `strict_config = true` to `cloud_config_layers_from_fragments_impl`, and returns the result.

**Call relations**: Called by strict bundle conversion. It exists as a dedicated entrypoint so callers can opt into stricter validation without duplicating conversion logic.

*Call graph*: calls 1 internal fn (cloud_config_layers_from_fragments_impl); called by 1 (from_bundle_impl).


##### `cloud_config_layers_from_fragments_impl`  (lines 82–121)

```
fn cloud_config_layers_from_fragments_impl(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
    strict_config: bool,
) -> Result<Vec<ConfigLayerEntry>, Cl
```

**Purpose**: Implements fragment parsing, optional strict validation, path resolution, layer construction, and precedence reversal for cloud config fragments.

**Data flow**: Consumes the fragment iterator and borrows `base_dir`. For each fragment, it derives `source_ref`, moves out `fragment.contents` as `raw_toml`, parses it with `toml::from_str` into `TomlValue`, optionally calls `validate_fragment_strictly`, resolves relative paths against `base_dir.as_path()` via `resolve_relative_paths_in_config_toml`, and pushes a `ConfigLayerEntry::new_with_raw_toml` using `ConfigLayerSource::EnterpriseManaged { id, name }`, the resolved config, original raw TOML, and a cloned base dir. After processing all fragments, it reverses the vector and returns it. Parse errors are wrapped as `CloudConfigLayerError::Parse`; validation and path-resolution failures become `Invalid`.

**Call relations**: This is the core worker behind both public conversion functions. It delegates strict checking to `validate_fragment_strictly` and path normalization to `resolve_relative_paths_in_config_toml`.

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

**Purpose**: Checks a parsed cloud config fragment for unknown or ignored fields using the strict `ConfigToml` schema and reports any violation as an invalid-fragment error.

**Data flow**: Borrows the fragment source, raw TOML text, parsed `TomlValue`, and base dir. It creates an `AbsolutePathBufGuard` from `base_dir.as_path()`, calls `config_error_from_ignored_toml_value_fields_for_source_name::<ConfigToml>(&source_ref.to_string(), raw_toml, value.clone())`, and if that returns an error converts it into `CloudConfigLayerError::Invalid { fragment: source_ref.clone(), message }`; otherwise it returns `Ok(())`.

**Call relations**: Invoked only from `cloud_config_layers_from_fragments_impl` when strict mode is enabled. The guard ensures validation runs under the same absolute-path assumptions as normal config decoding.

*Call graph*: calls 2 internal fn (as_path, new); called by 1 (cloud_config_layers_from_fragments_impl); 3 external calls (clone, clone, to_string).


##### `Error::from`  (lines 144–146)

```
fn from(error: CloudConfigLayerError) -> Self
```

**Purpose**: Converts a domain-specific cloud config layer error into a generic `io::Error` with `InvalidData` kind.

**Data flow**: Consumes a `CloudConfigLayerError`, wraps it with `io::Error::new(io::ErrorKind::InvalidData, error)`, and returns the resulting `io::Error`.

**Call relations**: Provides interoperability for callers or APIs that traffic in `io::Result` rather than the module’s custom error type.

*Call graph*: 1 external calls (new).


### `config/src/loader/layer_io.rs`

`io_transport` · `config load`

This module is the I/O-facing portion of config loading for managed/admin layers. It defines three transport structs: `MangedConfigFromFile` for a parsed managed TOML plus its absolute file path, `ManagedConfigFromMdm` for macOS-managed preferences plus the original raw TOML string, and `LoadedConfigLayers` as the combined result.

`load_config_layers_internal` resolves the managed config path from `LoaderOverrides` or `managed_config_default_path`, validates that it is absolute via `AbsolutePathBuf::from_absolute_path`, then reads it with `read_config_from_path`. On macOS it also asks `load_managed_admin_config_layer` for an MDM-backed layer and converts the platform-specific struct with `map_managed_admin_layer`; on other platforms that field is always `None`.

`read_config_from_path` is the main file parser. It converts the absolute path to `PathUri`, reads text through `ExecutorFileSystem`, parses TOML into `TomlValue`, optionally runs strict schema validation, and translates parse/validation failures into richer `io::Error`s using diagnostic helpers. Missing files are not errors: they return `Ok(None)` and are logged at info or debug depending on the caller's preference.

Strict validation is path-sensitive because relative-path fields in `ConfigToml` are interpreted relative to the config file's parent directory. `validate_config_toml_strictly` enforces that invariant by requiring a parent directory and installing an `AbsolutePathBufGuard` before checking for ignored fields. The default managed config path is `/etc/codex/managed_config.toml` on Unix and `${codex_home}/managed_config.toml` elsewhere.

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

**Purpose**: Builds the managed-config portion of the loader state by reading the legacy managed config file and, on macOS, managed preferences. It returns both sources in a single `LoadedConfigLayers` bundle.

**Data flow**: Inputs are an `ExecutorFileSystem`, `codex_home`, `LoaderOverrides`, and `strict_config`. It extracts override paths, computes an absolute managed config path, calls `read_config_from_path`, wraps any parsed file value into `MangedConfigFromFile`, optionally loads macOS managed preferences and maps them into `ManagedConfigFromMdm`, then returns `LoadedConfigLayers { managed_config, managed_config_from_mdm }`.

**Call relations**: This function is called by `load_config_layers_state` as the low-level managed-layer fetch step. It delegates file parsing to `read_config_from_path`, absolute-path validation to `from_absolute_path`, and macOS preference loading to `load_managed_admin_config_layer` when that platform code is compiled in.

*Call graph*: calls 3 internal fn (read_config_from_path, load_managed_admin_config_layer, from_absolute_path); called by 1 (load_config_layers_state).


##### `map_managed_admin_layer`  (lines 96–102)

```
fn map_managed_admin_layer(layer: ManagedAdminConfigLayer) -> ManagedConfigFromMdm
```

**Purpose**: Converts the macOS-specific `ManagedAdminConfigLayer` shape into the loader module's generic `ManagedConfigFromMdm` representation. It is a simple field rename/unpack helper.

**Data flow**: It takes ownership of `ManagedAdminConfigLayer { config, raw_toml }`, moves `config` into `managed_config`, preserves `raw_toml`, and returns a new `ManagedConfigFromMdm`.

**Call relations**: This helper is used only inside `load_config_layers_internal` on macOS after managed preferences have been loaded. It exists to keep the platform-specific type from leaking into the rest of the loader pipeline.


##### `read_config_from_path`  (lines 104–142)

```
async fn read_config_from_path(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    log_missing_as_info: bool,
    strict_config: bool,
) -> io::Result<Option<TomlValue>>
```

**Purpose**: Reads a TOML config file from an absolute path, parses it, optionally validates it strictly, and distinguishes missing files from malformed ones. It is the reusable file-backed config reader for managed layers.

**Data flow**: Inputs are the filesystem, an `AbsolutePathBuf`, a `log_missing_as_info` flag, and `strict_config`. It converts the path to `PathUri`, reads text, parses `toml::Value`, optionally calls `validate_config_toml_strictly`, and returns `Ok(Some(value))` on success. `NotFound` becomes `Ok(None)` with info/debug logging; parse failures are wrapped with `config_error_from_toml` and `io_error_from_config_error`; other read failures are logged and returned unchanged.

**Call relations**: This function is called by `load_config_layers_internal` whenever a managed config file path must be read. It delegates strict schema checking to `validate_config_toml_strictly` and diagnostic construction to the diagnostics helpers so callers receive enriched `io::Error`s.

*Call graph*: calls 6 internal fn (config_error_from_toml, io_error_from_config_error, validate_config_toml_strictly, read_file_text, as_path, from_abs_path); called by 1 (load_config_layers_internal); 3 external calls (debug!, error!, info!).


##### `validate_config_toml_strictly`  (lines 144–169)

```
fn validate_config_toml_strictly(
    path: &AbsolutePathBuf,
    contents: &str,
    value: &TomlValue,
) -> io::Result<()>
```

**Purpose**: Checks a parsed TOML document against `ConfigToml` and rejects ignored or unknown fields under strict mode. It also establishes the correct base directory for path-valued fields during validation.

**Data flow**: Inputs are the absolute config path, raw file contents, and parsed `TomlValue`. It derives the parent directory from `path.as_path().parent()`, errors if none exists, installs `AbsolutePathBufGuard::new(base_dir)`, clones the TOML value into `config_error_from_ignored_toml_value_fields::<ConfigToml>`, and returns `Ok(())` or an `InvalidData` `io::Error` built from the resulting config diagnostic.

**Call relations**: This function is only reached from `read_config_from_path` when `strict_config` is true. It does not recurse or read files itself; its role is to convert schema-validation failures into the same diagnostic error format used elsewhere in config loading.

*Call graph*: calls 3 internal fn (io_error_from_config_error, as_path, new); called by 1 (read_config_from_path); 3 external calls (clone, new, format!).


##### `managed_config_default_path`  (lines 172–183)

```
fn managed_config_default_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the platform default location for the legacy managed config file. The path is system-wide on Unix and under the Codex home directory on non-Unix targets.

**Data flow**: It takes `codex_home: &Path` and returns a `PathBuf`. On Unix it ignores `codex_home` and returns `/etc/codex/managed_config.toml`; otherwise it returns `codex_home.join("managed_config.toml")`.

**Call relations**: This helper is used by `load_config_layers_internal` when no explicit managed config path override is supplied. It isolates the platform conditional so the loader logic can treat the result uniformly.

*Call graph*: 2 external calls (join, from).


### `config/src/loader/macos.rs`

`io_transport` · `config load`

This module exists only for macOS builds and provides the managed-preferences half of admin configuration. It defines constants for the managed preferences domain (`com.openai.codex`) and the two keys used to store base64-encoded TOML payloads: one for config and one for requirements. `ManagedAdminConfigLayer` carries both the parsed `TomlValue` and the original TOML text so later diagnostics can preserve source fidelity.

The async entrypoints support two sources: an explicit base64 override string, or the real system preferences store. `load_managed_admin_config_layer` and `load_managed_admin_requirements_layer` first honor overrides, trimming whitespace and treating empty strings as absent. Otherwise they offload synchronous Core Foundation access to `tokio::task::spawn_blocking`, converting task cancellation/panic into generic I/O failures with error logging.

`load_managed_preference` is the FFI boundary. It calls `CFPreferencesCopyAppValue` with `CFString` keys, returns `Ok(None)` when the preference is missing, and wraps the returned Core Foundation string under the create rule before converting it to Rust `String`.

Config payloads go through `parse_managed_config_base64`: base64 decode, UTF-8 decode, TOML parse, optional strict validation against `ConfigToml`, and a root-type check requiring a table. Requirements payloads only need decoding because they are later interpreted by `RequirementsLayerEntry::from_toml`. Strict validation uses `AbsolutePathBufGuard` with a caller-supplied base directory so relative-path semantics match the rest of config loading.

#### Function details

##### `managed_preferences_requirements_source`  (lines 30–35)

```
fn managed_preferences_requirements_source() -> RequirementSource
```

**Purpose**: Constructs the `RequirementSource` metadata describing the managed-preferences requirements layer. It records both the macOS preferences domain and the specific key name.

**Data flow**: It takes no arguments and returns `RequirementSource::MdmManagedPreferences { domain, key }`, allocating owned `String`s from the module constants.

**Call relations**: This helper is used when wrapping decoded managed requirements into `RequirementsLayerEntry` values so downstream diagnostics and provenance reporting can identify the source precisely.


##### `load_managed_admin_config_layer`  (lines 37–63)

```
async fn load_managed_admin_config_layer(
    override_base64: Option<&str>,
    strict_config: bool,
    base_dir: &Path,
) -> io::Result<Option<ManagedAdminConfigLayer>>
```

**Purpose**: Loads the managed config TOML from either an override base64 string or the macOS managed preferences store. It is the async public entrypoint for MDM-backed config.

**Data flow**: Inputs are `override_base64`, `strict_config`, and `base_dir`. If an override is present, it trims it and returns `Ok(None)` for empty input or `parse_managed_config_base64(trimmed, strict_config, base_dir).map(Some)` otherwise. Without an override, it clones `base_dir` into a `PathBuf`, runs `load_managed_admin_config` in `spawn_blocking`, and returns the task result or an `io::Error::other` after logging cancellation/failure.

**Call relations**: This function is called by `load_config_layers_internal` on macOS. It delegates actual preference reading to `load_managed_admin_config` in the blocking path and delegates decoding/parsing to `parse_managed_config_base64` in both override and preference-backed flows.

*Call graph*: calls 1 internal fn (parse_managed_config_base64); called by 1 (load_config_layers_internal); 4 external calls (to_path_buf, other, spawn_blocking, error!).


##### `load_managed_admin_config`  (lines 65–74)

```
fn load_managed_admin_config(
    strict_config: bool,
    base_dir: &Path,
) -> io::Result<Option<ManagedAdminConfigLayer>>
```

**Purpose**: Synchronously reads the managed config preference and parses it if present. It is the blocking worker used behind the async wrapper.

**Data flow**: Inputs are `strict_config` and `base_dir`. It calls `load_managed_preference(MANAGED_PREFERENCES_CONFIG_KEY)`, trims any returned string, maps non-empty content through `parse_managed_config_base64`, and uses `transpose()` to return `io::Result<Option<ManagedAdminConfigLayer>>`.

**Call relations**: This function is invoked only inside `load_managed_admin_config_layer` via `spawn_blocking`. It isolates the synchronous Core Foundation preference access from the async caller.

*Call graph*: calls 1 internal fn (load_managed_preference).


##### `load_managed_admin_requirements_layer`  (lines 76–106)

```
async fn load_managed_admin_requirements_layer(
    override_base64: Option<&str>,
) -> io::Result<Option<RequirementsLayerEntry>>
```

**Purpose**: Loads managed requirements TOML from an override or from macOS managed preferences and wraps it as a `RequirementsLayerEntry`. It mirrors the config-loading path but skips TOML parsing at this stage.

**Data flow**: It takes `override_base64`. For an override, it trims, returns `Ok(None)` if empty, otherwise decodes via `parse_managed_requirements_base64` and wraps the resulting TOML string with `RequirementsLayerEntry::from_toml(managed_preferences_requirements_source(), contents)`. Without an override, it runs `load_managed_admin_requirements` in `spawn_blocking`, maps any returned string into the same entry type, and converts task failures into `io::Error::other` after logging.

**Call relations**: This function is called by `load_config_layers_state` when managed requirements are enabled on macOS. It delegates synchronous preference access to `load_managed_admin_requirements` and source metadata creation to `managed_preferences_requirements_source`.

*Call graph*: calls 1 internal fn (parse_managed_requirements_base64); called by 1 (load_config_layers_state); 3 external calls (other, spawn_blocking, error!).


##### `load_managed_admin_requirements`  (lines 108–114)

```
fn load_managed_admin_requirements() -> io::Result<Option<String>>
```

**Purpose**: Synchronously reads the managed requirements preference and decodes it if present. It is the blocking worker behind the async requirements loader.

**Data flow**: It calls `load_managed_preference(MANAGED_PREFERENCES_REQUIREMENTS_KEY)`, trims any returned string, maps it through `parse_managed_requirements_base64`, and transposes the optional result into `io::Result<Option<String>>`.

**Call relations**: This function is used only by `load_managed_admin_requirements_layer` inside `spawn_blocking`. It keeps the async wrapper free of direct Core Foundation calls.

*Call graph*: calls 1 internal fn (load_managed_preference).


##### `load_managed_preference`  (lines 116–138)

```
fn load_managed_preference(key_name: &str) -> io::Result<Option<String>>
```

**Purpose**: Reads a single managed preference string from the macOS preferences domain using Core Foundation FFI. It returns absence distinctly from malformed content.

**Data flow**: Input is `key_name: &str`. It constructs `CFString` values for the key and application ID, calls `CFPreferencesCopyAppValue`, checks for a null pointer and returns `Ok(None)` with debug logging if missing, otherwise wraps the returned object with `CFString::wrap_under_create_rule`, converts it to `String`, and returns `Ok(Some(value))`.

**Call relations**: This low-level FFI helper is called by both `load_managed_admin_config` and `load_managed_admin_requirements`. It does not parse or decode the value; it only retrieves the raw managed-preference string.

*Call graph*: called by 2 (load_managed_admin_config, load_managed_admin_requirements); 3 external calls (new, wrap_under_create_rule, debug!).


##### `parse_managed_config_base64`  (lines 140–182)

```
fn parse_managed_config_base64(
    encoded: &str,
    strict_config: bool,
    base_dir: &Path,
) -> io::Result<ManagedAdminConfigLayer>
```

**Purpose**: Decodes a base64-encoded managed config payload, parses it as TOML, optionally validates it strictly, and enforces a table root. It turns the raw preference string into a usable config layer.

**Data flow**: Inputs are the encoded string, `strict_config`, and `base_dir`. It decodes to UTF-8 TOML text with `decode_managed_preferences_base64`, builds a source name string, parses `TomlValue` with `toml::from_str`, maps parse errors either to rich config diagnostics (strict mode) or plain `InvalidData`, runs `validate_managed_config_toml_strictly_if_requested`, then returns `ManagedAdminConfigLayer { config, raw_toml }` if the parsed root is `TomlValue::Table`; any non-table root becomes an `InvalidData` error.

**Call relations**: This parser is used by `load_managed_admin_config_layer` directly for overrides and indirectly through `load_managed_admin_config` for real preferences. It delegates decoding to `decode_managed_preferences_base64` and strict schema checks to `validate_managed_config_toml_strictly_if_requested`.

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

**Purpose**: Performs strict unknown-field validation for managed config only when requested. It preserves the same relative-path semantics as file-backed config by installing a base-directory guard.

**Data flow**: Inputs are `strict_config`, `source_name`, raw TOML text, parsed `TomlValue`, and `base_dir`. If strict mode is off it returns `Ok(())`. Otherwise it creates an `AbsolutePathBufGuard`, clones the parsed value into `config_error_from_ignored_toml_value_fields_for_source_name::<ConfigToml>`, and returns either `Ok(())` or an `InvalidData` error produced by `io_error_from_config_error`.

**Call relations**: This function is called only from `parse_managed_config_base64` after TOML parsing succeeds. It exists so managed-preference config can participate in the same strict validation regime as file-backed config.

*Call graph*: calls 2 internal fn (io_error_from_config_error, new); called by 1 (parse_managed_config_base64); 1 external calls (clone).


##### `parse_managed_requirements_base64`  (lines 210–212)

```
fn parse_managed_requirements_base64(encoded: &str) -> io::Result<String>
```

**Purpose**: Decodes a base64-encoded managed requirements payload into its raw TOML string. It is intentionally thin because requirements parsing happens later.

**Data flow**: It takes `encoded: &str`, forwards it to `decode_managed_preferences_base64`, and returns the resulting `io::Result<String>` unchanged.

**Call relations**: This helper is called by `load_managed_admin_requirements_layer` and `load_managed_admin_requirements`. It exists mainly for symmetry with config parsing and to keep requirements-specific call sites readable.

*Call graph*: calls 1 internal fn (decode_managed_preferences_base64); called by 1 (load_managed_admin_requirements_layer).


##### `decode_managed_preferences_base64`  (lines 214–223)

```
fn decode_managed_preferences_base64(encoded: &str) -> io::Result<String>
```

**Purpose**: Performs the raw base64 and UTF-8 decoding step shared by managed config and requirements loaders. It converts malformed encoding into `InvalidData` I/O errors with logging.

**Data flow**: Input is the encoded preference string. It decodes bytes with `BASE64_STANDARD.decode(encoded.as_bytes())`, maps decode failures to `io::ErrorKind::InvalidData`, then converts the bytes to `String::from_utf8`, again mapping UTF-8 failures to `InvalidData`. On success it returns the decoded text.

**Call relations**: This function is the common leaf used by both `parse_managed_config_base64` and `parse_managed_requirements_base64`. It deliberately stops at text decoding so higher layers can decide how to interpret the contents.

*Call graph*: called by 2 (parse_managed_config_base64, parse_managed_requirements_base64); 1 external calls (from_utf8).


### Diagnostics and strict validation
These files turn parse and schema problems into precise user-facing errors and enforce strict unknown-field validation across loaded layers.

### `config/src/diagnostics.rs`

`util` · `config load`

This file is responsible for locating and formatting configuration errors precisely. `ConfigError` stores a path, a 1-based `TextRange`, and a message; `ConfigLoadError` wraps that structured error plus an optional underlying `toml::de::Error` so callers can expose both friendly display text and an error source chain. `ConfigDiagnosticSource` abstracts over real filesystem paths versus synthetic display names for non-file layers.

The parsing helpers work at two levels. `config_error_from_toml` and `config_error_from_toml_for_source` use the span already attached to a `toml::de::Error` when available. `config_error_from_typed_toml_for_source` goes further: it parses with `toml::de::Deserializer`, deserializes through `serde_path_to_error`, and then tries to recover a more specific span by walking the TOML document structure with `span_for_config_path`. That path-to-span logic uses `toml_edit` nodes (`Item`, `Table`, `Value`) and special-cases the `[features]` table so type errors point at the first invalid feature value rather than the whole table.

For layered config, `first_layer_config_error_for_entries` iterates layers in precedence order, reading raw TOML from in-memory layers or from disk, temporarily setting `AbsolutePathBufGuard` so relative-path fields deserialize with the same base directory semantics as normal loading, and returns the first concrete per-layer error. Formatting helpers then render `path:line:column: message` plus a source line and caret underline. Lower-level utilities convert byte spans to line/column positions, locate spans for serde paths or explicit TOML key paths, and traverse nested maps/arrays/tables safely.

#### Function details

##### `ConfigError::new`  (lines 44–50)

```
fn new(path: PathBuf, range: TextRange, message: impl Into<String>) -> Self
```

**Purpose**: Constructs a structured config error from a path, text range, and message.

**Data flow**: Consumes a `PathBuf`, `TextRange`, and message-like input, converts the message into `String`, and returns `ConfigError`.

**Call relations**: Used by all error-construction helpers once they have determined the source path and span.

*Call graph*: called by 4 (config_error_from_toml_for_source, config_error_from_typed_toml_for_source, config_error_from_ignored_toml_value_fields_for_source, unknown_field_error_from_paths); 1 external calls (into).


##### `ConfigLoadError::new`  (lines 60–62)

```
fn new(error: ConfigError, source: Option<toml::de::Error>) -> Self
```

**Purpose**: Wraps a `ConfigError` together with an optional underlying TOML deserialization error.

**Data flow**: Stores the provided `ConfigError` and optional `toml::de::Error` in a new `ConfigLoadError`.

**Call relations**: Called by `io_error_from_config_error` when surfacing config failures through `std::io::Error`.

*Call graph*: called by 1 (io_error_from_config_error).


##### `ConfigLoadError::config_error`  (lines 64–66)

```
fn config_error(&self) -> &ConfigError
```

**Purpose**: Returns the structured `ConfigError` inside a load error.

**Data flow**: Borrows and returns `&self.error`.

**Call relations**: Used by callers that need machine-readable path/range/message details after catching a load error.


##### `ConfigLoadError::fmt`  (lines 70–79)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a load error as `path:line:column: message`.

**Data flow**: Reads the wrapped `ConfigError` fields and writes the formatted string to the formatter.

**Call relations**: Provides the user-facing display form when config load errors are printed.

*Call graph*: 1 external calls (write!).


##### `ConfigLoadError::source`  (lines 83–87)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the optional underlying TOML error as the standard error source.

**Data flow**: Returns `self.source.as_ref()` cast to `&(dyn Error)` when present.

**Call relations**: Supports error chaining for callers that want both friendly and low-level parse details.


##### `ConfigDiagnosticSource::to_path_buf`  (lines 97–102)

```
fn to_path_buf(self) -> PathBuf
```

**Purpose**: Converts either a real path or a synthetic display name into a `PathBuf` for storage in `ConfigError`.

**Data flow**: Matches `self`: `Path(path)` clones the filesystem path, `DisplayName(name)` constructs a `PathBuf` from the display string.

**Call relations**: Used by all source-aware error constructors so diagnostics can uniformly carry a path-like identifier.

*Call graph*: called by 4 (config_error_from_toml_for_source, config_error_from_typed_toml_for_source, config_error_from_ignored_toml_value_fields_for_source, unknown_field_error_from_paths); 1 external calls (from).


##### `io_error_from_config_error`  (lines 105–111)

```
fn io_error_from_config_error(
    kind: io::ErrorKind,
    error: ConfigError,
    source: Option<toml::de::Error>,
) -> io::Error
```

**Purpose**: Packages a structured config error into an `std::io::Error` of a caller-chosen kind.

**Data flow**: Constructs `ConfigLoadError::new(error, source)` and wraps it with `io::Error::new(kind, ...)`.

**Call relations**: Called by config-loading entry points that expose I/O-style errors but want rich config diagnostics attached.

*Call graph*: calls 1 internal fn (new); called by 5 (read_config_from_path, validate_config_toml_strictly, load_config_layers_state, validate_managed_config_toml_strictly_if_requested, validate_config_toml_strictly); 1 external calls (new).


##### `config_error_from_toml`  (lines 113–119)

```
fn config_error_from_toml(
    path: impl AsRef<Path>,
    contents: &str,
    err: toml::de::Error,
) -> ConfigError
```

**Purpose**: Builds a `ConfigError` from a raw TOML parse/deserialization error for a real file path.

**Data flow**: Converts the input path to `ConfigDiagnosticSource::Path` and delegates to `config_error_from_toml_for_source`.

**Call relations**: Used when a plain `toml::de::Error` already exists and no typed-path recovery is needed.

*Call graph*: calls 1 internal fn (config_error_from_toml_for_source); called by 1 (read_config_from_path); 2 external calls (as_ref, Path).


##### `config_error_from_toml_for_source`  (lines 121–131)

```
fn config_error_from_toml_for_source(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    err: toml::de::Error,
) -> ConfigError
```

**Purpose**: Builds a `ConfigError` from a TOML error and either a real path or synthetic source name, using the error's byte span when available.

**Data flow**: Reads `err.span()`, converts it to a `TextRange` with `text_range_from_span` or falls back to `default_range`, then constructs `ConfigError::new(source.to_path_buf(), range, err.message())`.

**Call relations**: Shared by raw parse-error paths and by typed parsing when TOML parsing itself fails before serde-path recovery can run.

*Call graph*: calls 2 internal fn (to_path_buf, new); called by 3 (config_error_from_toml, config_error_from_typed_toml_for_source, config_error_from_ignored_toml_fields); 2 external calls (message, span).


##### `config_error_from_typed_toml`  (lines 133–141)

```
fn config_error_from_typed_toml(
    path: impl AsRef<Path>,
    contents: &str,
) -> Option<ConfigError>
```

**Purpose**: Attempts typed deserialization of TOML and returns a structured error with a precise span if deserialization fails.

**Data flow**: Wraps the real path in `ConfigDiagnosticSource::Path` and delegates to `config_error_from_typed_toml_for_source`.

**Call relations**: Used when callers want schema-aware diagnostics for a specific file.

*Call graph*: 2 external calls (as_ref, Path).


##### `config_error_from_typed_toml_for_source`  (lines 143–169)

```
fn config_error_from_typed_toml_for_source(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
) -> Option<ConfigError>
```

**Purpose**: Performs typed TOML deserialization with serde-path tracking and maps any failure to the most specific source span it can find.

**Data flow**: Parses the TOML into a `toml::de::Deserializer`; if parsing fails, it returns `config_error_from_toml_for_source`. Otherwise it deserializes `T` through `serde_path_to_error::deserialize`. On success it returns `None`. On failure it clones the serde path, extracts the inner `toml::de::Error`, tries `span_for_config_path(contents, &path_hint)`, falls back to `toml_err.span()`, converts the chosen span to `TextRange`, and returns `Some(ConfigError::new(...))`.

**Call relations**: This is the main schema-aware diagnostic routine used by per-layer validation helpers.

*Call graph*: calls 4 internal fn (to_path_buf, new, config_error_from_toml_for_source, span_for_config_path); 2 external calls (deserialize, parse).


##### `first_layer_config_error`  (lines 171–186)

```
async fn first_layer_config_error(
    layers: &ConfigLayerStack,
    config_toml_file: &str,
) -> Option<ConfigError>
```

**Purpose**: Finds the first concrete per-layer config error in a `ConfigLayerStack`, preferring actual source files/layers over opaque merged-config failures.

**Data flow**: Requests layers from the stack in lowest-precedence-first order with disabled layers excluded, then delegates to `first_layer_config_error_for_entries`.

**Call relations**: Used by higher-level config loading when merged validation fails and the system wants to point the user at the first offending layer.

*Call graph*: calls 1 internal fn (get_layers).


##### `first_layer_config_error_from_entries`  (lines 188–193)

```
async fn first_layer_config_error_from_entries(
    layers: &[ConfigLayerEntry],
    config_toml_file: &str,
) -> Option<ConfigError>
```

**Purpose**: Variant of first-layer error lookup that operates on an explicit slice of layer entries.

**Data flow**: Passes `layers.iter()` and the config filename to `first_layer_config_error_for_entries`.

**Call relations**: Used by callers that already have a filtered or custom-ordered layer list.

*Call graph*: 1 external calls (iter).


##### `first_layer_config_error_for_entries`  (lines 195–247)

```
async fn first_layer_config_error_for_entries(
    layers: I,
    config_toml_file: &str,
) -> Option<ConfigError>
```

**Purpose**: Iterates config layers, parses each layer in its own base-directory context, and returns the first typed TOML error found.

**Data flow**: For each `ConfigLayerEntry`, it first checks `raw_toml()`. For in-memory/raw layers it formats a display name, requires a base dir, installs `AbsolutePathBufGuard` for that base, and runs `config_error_from_typed_toml_for_source`. For file-backed layers it resolves a path with `config_path_for_layer`, reads the file asynchronously, skips missing/unreadable files with debug logging, installs an `AbsolutePathBufGuard` for the parent directory, and runs `config_error_from_typed_toml`. It returns the first `Some(ConfigError)` or `None` if all layers parse cleanly.

**Call relations**: This is the workhorse behind both public first-layer helpers, bridging config-layer metadata, filesystem I/O, and typed diagnostics.

*Call graph*: calls 2 internal fn (config_path_for_layer, new); 4 external calls (DisplayName, format_config_layer_source, read_to_string, debug!).


##### `config_path_for_layer`  (lines 249–262)

```
fn config_path_for_layer(layer: &ConfigLayerEntry, config_toml_file: &str) -> Option<PathBuf>
```

**Purpose**: Maps a config layer source to the on-disk path of its TOML file when one exists.

**Data flow**: Matches `layer.name`: system/user/legacy-file layers return their stored file path, project layers append `config_toml_file` to the `.codex` folder, and non-file-backed layers return `None`.

**Call relations**: Used by `first_layer_config_error_for_entries` when it needs to read a file-backed layer from disk.

*Call graph*: called by 1 (first_layer_config_error_for_entries).


##### `text_range_from_span`  (lines 264–273)

```
fn text_range_from_span(contents: &str, span: std::ops::Range<usize>) -> TextRange
```

**Purpose**: Converts a byte span into a 1-based inclusive text range suitable for diagnostics.

**Data flow**: Computes the start position from `span.start`, computes an inclusive end index (`span.end - 1` when non-empty), converts both offsets with `position_for_offset`, and returns `TextRange { start, end }`.

**Call relations**: Used whenever TOML or recovered path spans need to become line/column coordinates.

*Call graph*: calls 1 internal fn (position_for_offset).


##### `format_config_error`  (lines 275–309)

```
fn format_config_error(error: &ConfigError, contents: &str) -> String
```

**Purpose**: Renders a structured config error as a human-readable message with source line and caret underline.

**Data flow**: Builds a string containing `path:line:column: message`, looks up the referenced line in `contents`, prints a gutter and the source line, computes highlight width for same-line ranges, and appends a caret marker under the offending column(s). If the line is unavailable, it returns just the header.

**Call relations**: Used by `format_config_error_with_source` and any caller that already has file contents in memory.

*Call graph*: called by 1 (format_config_error_with_source); 2 external calls (new, writeln!).


##### `format_config_error_with_source`  (lines 311–316)

```
fn format_config_error_with_source(error: &ConfigError) -> String
```

**Purpose**: Formats a config error by reading the referenced file contents automatically when possible.

**Data flow**: Attempts `std::fs::read_to_string(&error.path)` and passes either the file contents or an empty string to `format_config_error`.

**Call relations**: Convenience wrapper for callers that only have a `ConfigError` and want a fully rendered message.

*Call graph*: calls 1 internal fn (format_config_error); 1 external calls (read_to_string).


##### `position_for_offset`  (lines 318–347)

```
fn position_for_offset(contents: &str, index: usize) -> TextPosition
```

**Purpose**: Converts a byte offset into a 1-based line/column position, tolerating offsets past EOF and invalid UTF-8 boundaries conservatively.

**Data flow**: Reads the file bytes, clamps the index to the last byte when needed, tracks any overflow as `column_offset`, finds the start of the containing line by searching backward for `\n`, counts preceding newlines to determine the line number, computes the column by decoding the slice from line start through the index as UTF-8 and counting chars (falling back to byte distance on decode failure), then adds the overflow offset and returns `TextPosition`.

**Call relations**: Used by `text_range_from_span` for all byte-span-to-text-position conversions.

*Call graph*: called by 1 (text_range_from_span); 1 external calls (from_utf8).


##### `default_range`  (lines 349–355)

```
fn default_range() -> TextRange
```

**Purpose**: Provides a fallback text range at line 1, column 1 when no better span information is available.

**Data flow**: Constructs a single `TextPosition { line: 1, column: 1 }` and uses it for both start and end.

**Call relations**: Used by error constructors when TOML/serde errors do not carry a span.


##### `span_for_path`  (lines 363–371)

```
fn span_for_path(contents: &str, path: &SerdePath) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the byte span in a TOML document corresponding to a serde path by traversing the parsed `toml_edit` document tree.

**Data flow**: Parses `contents` into `Document<String>`, resolves the target node with `node_for_path`, and returns that node's span from the underlying `Item`, `Table`, or `Value`.

**Call relations**: Used by `span_for_config_path` as the general path-to-span mechanism.

*Call graph*: calls 1 internal fn (node_for_path); called by 1 (span_for_config_path).


##### `span_for_config_path`  (lines 373–383)

```
fn span_for_config_path(
    contents: &str,
    path: &SerdePath,
) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the best byte span for a config serde path, with a special case for the `[features]` table so type errors point at the first invalid feature value.

**Data flow**: Checks `is_features_table_path(path)`; if true and `span_for_features_value(contents)` succeeds, returns that span. Otherwise it falls back to `span_for_path(contents, path)`.

**Call relations**: Used by typed TOML diagnostics and other config-specific error mappers that want better-than-default serde spans.

*Call graph*: calls 3 internal fn (is_features_table_path, span_for_features_value, span_for_path); called by 2 (config_error_from_typed_toml_for_source, config_error_from_ignored_toml_value_fields_for_source).


##### `span_for_toml_key_path`  (lines 385–425)

```
fn span_for_toml_key_path(
    contents: &str,
    path: &[String],
) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the span for an explicit TOML key path expressed as string segments, preferring the key token span for the final segment when available.

**Data flow**: Parses the document, walks through `TomlNode` values segment by segment using `map_child` or numeric `seq_child`, and on the final segment first tries to return the key span from a table-like container. If that fails, it returns the span of the resolved node itself.

**Call relations**: Used by unknown-field diagnostics that already know the TOML key path rather than a serde path.

*Call graph*: calls 2 internal fn (map_child, seq_child); called by 1 (unknown_field_error_from_paths); 1 external calls (Item).


##### `is_features_table_path`  (lines 427–431)

```
fn is_features_table_path(path: &SerdePath) -> bool
```

**Purpose**: Detects whether a serde path refers exactly to the top-level `features` table.

**Data flow**: Iterates the path segments and returns true only when the first segment is a map key `features` and there are no additional segments.

**Call relations**: Used by `span_for_config_path` to trigger the features-specific span heuristic.

*Call graph*: called by 1 (span_for_config_path); 2 external calls (iter, matches!).


##### `span_for_features_value`  (lines 433–448)

```
fn span_for_features_value(contents: &str) -> Option<std::ops::Range<usize>>
```

**Purpose**: Finds the span of the first non-boolean value inside the top-level `features` table, which is typically the most useful location for a schema/type error there.

**Data flow**: Parses the document, gets the root table and `features` item, iterates its entries, skips boolean values and `Item::None`, and returns the span of the first other value/table/array-of-tables encountered.

**Call relations**: Special-case helper used only by `span_for_config_path`.

*Call graph*: called by 1 (span_for_config_path).


##### `node_for_path`  (lines 450–477)

```
fn node_for_path(item: &'a Item, path: &SerdePath) -> Option<TomlNode<'a>>
```

**Purpose**: Traverses a `toml_edit::Item` tree according to a serde path and returns the corresponding TOML node when possible.

**Data flow**: Collects path segments into a vector, starts from `TomlNode::Item(item)`, and walks segments in order. Map/enum segments try `map_child`; if missing and not final, they are skipped to tolerate serde wrapper segments. Sequence segments use `seq_child`. Unknown segments abort with `None`.

**Call relations**: Used by `span_for_path` to bridge serde-path semantics to TOML document structure.

*Call graph*: calls 2 internal fn (map_child, seq_child); called by 1 (span_for_path); 2 external calls (iter, Item).


##### `map_child`  (lines 479–489)

```
fn map_child(node: &TomlNode<'a>, key: &str) -> Option<TomlNode<'a>>
```

**Purpose**: Looks up a named child key from a TOML node if that node is table-like.

**Data flow**: Matches the node: `Item` and `Table` use `get(key)` and wrap the result as `TomlNode::Item`; inline-table values use `get(key)` and wrap as `TomlNode::Value`; other node kinds return `None`.

**Call relations**: Used by both serde-path and explicit-key-path traversal helpers.

*Call graph*: called by 2 (node_for_path, span_for_toml_key_path).


##### `seq_child`  (lines 491–498)

```
fn seq_child(node: &TomlNode<'a>, index: usize) -> Option<TomlNode<'a>>
```

**Purpose**: Looks up an indexed child from an array or array-of-tables TOML node.

**Data flow**: Matches the node: array values return the indexed `Value`, array-of-tables items return the indexed `Table`, and unsupported node kinds return `None`.

**Call relations**: Used by both `node_for_path` and `span_for_toml_key_path` when traversing sequence segments.

*Call graph*: called by 2 (node_for_path, span_for_toml_key_path).


### `config/src/strict_config.rs`

`domain_logic` · `config load`

This module adds strictness to TOML config parsing by combining `serde_ignored`, `serde_path_to_error`, and custom diagnostics helpers. The public entry point parses raw TOML text into `toml::Value`; parse failures become `ConfigError` via `config_error_from_toml_for_source`, while successful parses are re-deserialized through a `serde_ignored::Deserializer` so unknown fields can be collected instead of silently dropped. The core routine, `config_error_from_ignored_toml_value_fields_for_source`, gathers two classes of problems: generic ignored-field paths reported by serde and unknown feature keys discovered manually under `[features]` and `[profiles.<name>.features]` using `codex_features::is_known_feature_key`.

Control flow intentionally prioritizes type/shape errors over ignored-field errors. If deserialization fails, the code uses the path-aware error from `serde_path_to_error`, tries to locate the offending span with `span_for_config_path`, falls back to the TOML parser span, then to `default_range`, and returns that concrete diagnostic. Only when deserialization succeeds does it synthesize an "unknown configuration field" error from the first ignored path or unknown feature path. Helper functions expose lighter-weight queries for the first ignored field or first unknown feature field, and recursive path walkers flatten `serde_ignored::Path` into dotted key segments while skipping wrapper nodes like `Some` and newtype wrappers.

#### Function details

##### `config_error_from_ignored_toml_fields`  (lines 15–26)

```
fn config_error_from_ignored_toml_fields(
    path: impl AsRef<Path>,
    contents: &str,
) -> Option<ConfigError>
```

**Purpose**: Parses TOML text and returns a strict-validation `ConfigError` if parsing fails, deserialization finds an unknown field, or feature-key validation fails. It is the main file-path-based entry point for strict config checking.

**Data flow**: Takes a path-like source and TOML contents string, wraps the path in `ConfigDiagnosticSource::Path`, parses `contents` into `TomlValue`, and either forwards the parsed value into strict field validation or converts the parse error with `config_error_from_toml_for_source`. It returns `Option<ConfigError>`.

**Call relations**: Used by strict config validation callers that start from raw file contents. It delegates parse-error formatting to diagnostics helpers and successful parses to the value-based strict validator.

*Call graph*: calls 1 internal fn (config_error_from_toml_for_source); 2 external calls (as_ref, Path).


##### `config_error_from_ignored_toml_value_fields`  (lines 28–38)

```
fn config_error_from_ignored_toml_value_fields(
    path: impl AsRef<Path>,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError>
```

**Purpose**: Runs strict ignored-field validation when the caller already has a parsed `TomlValue`. It is the path-based wrapper around the source-generic core routine.

**Data flow**: Takes a path-like source, TOML contents, and a parsed `TomlValue`; wraps the path in `ConfigDiagnosticSource::Path`; and forwards all three to `config_error_from_ignored_toml_value_fields_for_source`. It returns the resulting optional `ConfigError`.

**Call relations**: Used internally when parsing has already happened elsewhere but strict unknown-field checking still needs file-path diagnostics.

*Call graph*: 2 external calls (as_ref, Path).


##### `config_error_from_ignored_toml_value_fields_for_source_name`  (lines 40–50)

```
fn config_error_from_ignored_toml_value_fields_for_source_name(
    source_name: &str,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError>
```

**Purpose**: Runs strict ignored-field validation for non-file sources identified by a display name. This supports diagnostics for synthetic or remote config sources.

**Data flow**: Takes a source name string, contents, and parsed `TomlValue`, wraps the name in `ConfigDiagnosticSource::DisplayName`, and forwards to the core source-aware validator. It returns `Option<ConfigError>`.

**Call relations**: Used when config comes from something like a base64 payload or remote source rather than a filesystem path, so diagnostics still carry a meaningful source identifier.

*Call graph*: 1 external calls (DisplayName).


##### `config_error_from_ignored_toml_value_fields_for_source`  (lines 52–85)

```
fn config_error_from_ignored_toml_value_fields_for_source(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError>
```

**Purpose**: Performs the actual strict validation pass: collect ignored fields, detect unknown feature keys, deserialize into the target type, and produce the most relevant diagnostic. It is the module's central decision point.

**Data flow**: Takes a `ConfigDiagnosticSource`, TOML contents, and parsed `TomlValue`. It first computes unknown feature paths, then deserializes through `serde_ignored::Deserializer`, collecting ignored paths via `ignored_path_segments`. If deserialization succeeds, it returns the first unknown-field error from ignored paths or unknown feature paths; if deserialization fails, it computes a source range from `span_for_config_path`, TOML span, or `default_range`, and returns a `ConfigError` with the underlying serde/TOML message.

**Call relations**: This function is reached from all public wrappers in the file. It delegates path flattening to `ignored_path_segments`, feature scanning to `unknown_feature_toml_value_path`, and final unknown-field formatting to `unknown_field_error_from_paths`.

*Call graph*: calls 5 internal fn (to_path_buf, new, span_for_config_path, unknown_feature_toml_value_path, unknown_field_error_from_paths); 3 external calls (new, new, deserialize).


##### `ignored_toml_value_field`  (lines 87–103)

```
fn ignored_toml_value_field(value: TomlValue) -> Option<String>
```

**Purpose**: Returns the first ignored field path, as a dotted string, when a value can otherwise deserialize successfully. It is a lightweight query used when callers only need the field name rather than a full diagnostic.

**Data flow**: Consumes a `TomlValue`, deserializes it with `serde_ignored::deserialize`, collects non-empty ignored paths via `ignored_path_segments`, returns `None` if deserialization fails, and otherwise returns the first collected path joined with dots.

**Call relations**: This helper reuses the same ignored-path collection strategy as the full validator but intentionally skips diagnostic span computation and type-error reporting.

*Call graph*: 2 external calls (new, deserialize).


##### `unknown_feature_toml_value_field`  (lines 105–110)

```
fn unknown_feature_toml_value_field(value: &TomlValue) -> Option<String>
```

**Purpose**: Returns the first unknown feature-key path as a dotted string. It isolates feature-key validation from the broader ignored-field machinery.

**Data flow**: Borrows a `TomlValue`, calls `unknown_feature_toml_value_path`, takes the first path if any, joins its segments with dots, and returns `Option<String>`.

**Call relations**: Called by `validate_cli_overrides_strictly` and other code that wants a simple unknown-feature indicator without constructing a full `ConfigError`.

*Call graph*: calls 1 internal fn (unknown_feature_toml_value_path); called by 1 (validate_cli_overrides_strictly).


##### `unknown_field_error_from_paths`  (lines 112–127)

```
fn unknown_field_error_from_paths(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    ignored_paths: Vec<Vec<String>>,
) -> Option<ConfigError>
```

**Purpose**: Builds a concrete `ConfigError` for the first unknown path in a list. It translates dotted path segments into a source range and standardized message text.

**Data flow**: Takes a diagnostic source, TOML contents, and a vector of path-segment vectors; selects the first path, joins it into `ignored_path`, computes a range with `span_for_toml_key_path` or `default_range`, and returns `Some(ConfigError::new(..., format!("unknown configuration field `{ignored_path}`")))`. If no paths exist, it returns `None`.

**Call relations**: Used by the core strict validator after successful deserialization to turn either ignored-field paths or unknown-feature paths into a user-facing diagnostic.

*Call graph*: calls 3 internal fn (to_path_buf, new, span_for_toml_key_path); called by 1 (config_error_from_ignored_toml_value_fields_for_source); 1 external calls (format!).


##### `unknown_feature_toml_value_path`  (lines 129–148)

```
fn unknown_feature_toml_value_path(value: &TomlValue) -> Vec<Vec<String>>
```

**Purpose**: Scans a TOML document for feature keys that are not recognized by the feature registry. It checks both top-level features and profile-scoped feature tables.

**Data flow**: Borrows a `TomlValue`, requires the root to be a table, initializes an output vector, pushes unknown paths from `root["features"]`, then iterates `root["profiles"]` tables and pushes unknown paths from each profile's `features` table using prefixes like `profiles.<name>.features`. It returns `Vec<Vec<String>>`.

**Call relations**: Called by both the full strict validator and the simpler `unknown_feature_toml_value_field` helper. It delegates the actual table-key filtering to `push_unknown_feature_paths`.

*Call graph*: calls 1 internal fn (push_unknown_feature_paths); called by 2 (config_error_from_ignored_toml_value_fields_for_source, unknown_feature_toml_value_field); 2 external calls (as_table, new).


##### `push_unknown_feature_paths`  (lines 150–171)

```
fn push_unknown_feature_paths(
    paths: &mut Vec<Vec<String>>,
    prefix: &[&str],
    features: Option<&TomlValue>,
)
```

**Purpose**: Appends dotted-path segments for every unknown feature key found in a specific features table. It is the low-level scanner used by the broader feature-path traversal.

**Data flow**: Takes a mutable output vector, a prefix slice, and an optional TOML value. If the value is a table, it iterates its keys, filters out known feature keys via `is_known_feature_key`, builds `Vec<String>` paths by copying the prefix and appending the unknown key, and pushes them into `paths`.

**Call relations**: Used exclusively by `unknown_feature_toml_value_path` for both top-level and profile-scoped feature tables.

*Call graph*: called by 1 (unknown_feature_toml_value_path).


##### `ignored_path_segments`  (lines 173–177)

```
fn ignored_path_segments(path: &serde_ignored::Path<'_>) -> Vec<String>
```

**Purpose**: Converts a `serde_ignored::Path` into a flat vector of string segments. It normalizes the recursive path representation into the dotted-path form used elsewhere in the module.

**Data flow**: Creates an empty `Vec<String>`, calls `push_ignored_path_segments(path, &mut segments)`, and returns the filled vector.

**Call relations**: Used by both the full strict validator and `ignored_toml_value_field` when collecting ignored-field paths from serde callbacks.

*Call graph*: calls 1 internal fn (push_ignored_path_segments); 1 external calls (new).


##### `push_ignored_path_segments`  (lines 179–196)

```
fn push_ignored_path_segments(path: &serde_ignored::Path<'_>, segments: &mut Vec<String>)
```

**Purpose**: Recursively walks a `serde_ignored::Path` and appends its meaningful map/sequence segments. It intentionally skips wrapper nodes that do not correspond to TOML key names.

**Data flow**: Matches on the path enum: `Root` adds nothing; `Seq` recurses into the parent then pushes the numeric index; `Map` recurses then pushes the key string; `Some`, `NewtypeStruct`, and `NewtypeVariant` recurse without adding a segment. It mutates the provided `segments` vector in place.

**Call relations**: Called only by `ignored_path_segments` as the recursive implementation detail for flattening serde's path structure.

*Call graph*: called by 1 (ignored_path_segments).


### Effective config assembly
These files assemble the full precedence stack and derive higher-level effective artifacts such as agent roles and lockfiles from the layered configuration state.

### `config/src/loader/mod.rs`

`orchestration` · `config load`

This is the central orchestration module for configuration loading. Its top-level `load_config_layers_state` function builds two parallel products: composed admin requirements and an ordered `ConfigLayerStack`. It starts by optionally loading requirements from cloud bundles, macOS managed preferences, the system `requirements.toml`, and legacy `managed_config.toml` backfill. It then loads managed config layers, thread-specific layers, system config, user config, optional profile-v2 config, project-local layers, and runtime CLI overrides.

Several invariants are enforced here. User profile-v2 selection is rejected if the base user config still contains a matching legacy `profile = ...` or `[profiles.<name>]` entry. Relative paths in TOML are normalized against each layer's own directory using `AbsolutePathBufGuard` plus a `ConfigToml` round-trip. Strict mode rejects ignored or unknown fields in file-backed config and CLI overrides.

Project-local loading is trust-aware. The module computes a `ProjectTrustContext` from merged non-project config, project-root markers, git checkout/repo roots, and the user's configured trust map. Untrusted projects still produce layer entries, but those entries are disabled and carry a human-readable reason; trusted projects may hard-fail on malformed TOML. Project-local config is also sanitized by removing a denylist of sensitive keys such as model-provider and URL settings, with startup warnings emitted when trusted project config attempted to set them.

The module also contains platform-specific system path helpers, Windows known-folder resolution, legacy managed-config-to-requirements translation, and linked-worktree hook merging that replaces only `hooks` from the root checkout while preserving local project settings.

#### Function details

##### `first_layer_config_error_from_entries`  (lines 76–78)

```
async fn first_layer_config_error_from_entries(layers: &[ConfigLayerEntry]) -> Option<ConfigError>
```

**Purpose**: Finds the first typed config diagnostic among already loaded layer entries using the `ConfigToml` schema. It is used to improve error attribution when later merged operations fail.

**Data flow**: It takes a slice of `ConfigLayerEntry`, forwards it to `typed_first_layer_config_error_from_entries::<ConfigToml>(..., CONFIG_TOML_FILE)`, awaits the result, and returns `Option<ConfigError>`.

**Call relations**: This helper is called from `load_config_layers_state` when project-root marker parsing or trust-context deserialization fails after multiple layers have already been loaded. It lets the loader surface the earliest layer-specific config error instead of a generic merged-config failure.

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

**Purpose**: Builds the complete `ConfigLayerStack`, including requirements composition, config layer ordering, trust-gated project layers, managed/admin backfill, thread layers, and startup warnings. It is the main configuration assembly pipeline for the application.

**Data flow**: Inputs are the filesystem, `codex_home`, optional `cwd`, CLI override pairs, `ConfigLoadOptions`, and a `ThreadConfigLoader`. It unpacks overrides and flags, optionally loads cloud bundle layers, managed requirements, and system requirements; loads managed config layers; composes requirements via `compose_requirements`; loads thread layers; builds and optionally strict-validates a CLI override TOML layer; loads system and user/profile config files; if `cwd` exists, merges current layers to derive project-root markers and trust context, then loads project layers and warnings; appends runtime and thread layers by precedence; appends legacy managed config layers from file and MDM after resolving relative paths; finally constructs `ConfigLayerStack::new(...)`, applies exec-policy ignore flags and startup warnings, and returns it.

**Call relations**: This function is called by higher-level config consumers such as general config loading, plugin config loading, and many tests. It delegates almost every phase: low-level managed I/O to `layer_io::load_config_layers_internal`, requirements loading to `load_requirements_toml` and macOS helpers, file-backed config parsing to `load_config_toml_for_required_layer`, trust computation to `project_trust_context`, project traversal to `load_project_layers`, and insertion ordering to `insert_layer_by_precedence`.

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

**Purpose**: Loads one user-scoped config layer, optionally representing a selected profile-v2 file, or returns an empty layer when user config is disabled. It preserves source metadata including the profile name.

**Data flow**: Inputs are the filesystem, target user config file, optional `ProfileV2Name`, `ignore_user_config`, and `strict_config`. It converts the profile to `Option<String>`, returns a `ConfigLayerEntry::new` with an empty table if user config is ignored, otherwise calls `load_config_toml_for_required_layer` and wraps the parsed TOML in a `ConfigLayerSource::User { file, profile }` entry.

**Call relations**: This helper is called twice from `load_config_layers_state`: once for the base `${CODEX_HOME}/config.toml` and again for the selected profile-v2 file when distinct. It delegates actual file reading and validation to `load_config_toml_for_required_layer`.

*Call graph*: calls 2 internal fn (load_config_toml_for_required_layer, new); called by 1 (load_config_layers_state); 3 external calls (Table, new, clone).


##### `insert_layer_by_precedence`  (lines 453–461)

```
fn insert_layer_by_precedence(layers: &mut Vec<ConfigLayerEntry>, layer: ConfigLayerEntry)
```

**Purpose**: Inserts a config layer into an existing vector according to `ConfigLayerSource` precedence ordering. It keeps thread-provided layers in the correct relative position among already loaded layers.

**Data flow**: It takes `&mut Vec<ConfigLayerEntry>` and a new `ConfigLayerEntry`. It scans for the first existing layer whose precedence is greater than the new layer's precedence; if found it inserts at that index, otherwise it pushes to the end. It returns `()` after mutating the vector.

**Call relations**: This function is used by `load_config_layers_state` when integrating thread config layers after the main stack has been assembled. It does not load or transform config contents; it only maintains ordering semantics.

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

**Purpose**: Loads a config file for a layer that must always exist in the stack, using an empty table when the file is absent. It handles parsing, strict validation, relative-path resolution, and source-specific entry construction.

**Data flow**: Inputs are the filesystem, absolute TOML file path, `strict_config`, and a `create_entry` closure. It reads the file via `PathUri`; on success it requires a parent directory, parses TOML, wraps parse errors with config diagnostics, optionally calls `validate_config_toml_strictly`, resolves relative paths against the parent directory, and passes the resulting `TomlValue` to `create_entry`. On `NotFound`, it uses `TomlValue::Table(empty)` instead; other read errors are wrapped with a path-specific message.

**Call relations**: This helper is called by `load_config_layers_state` for system config and by `load_user_config_layer` for user/profile config. It centralizes the common 'required layer entry even when missing' behavior so callers only supply source metadata.

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

**Purpose**: Rejects ignored or unknown fields in a parsed config TOML document under strict mode, using the file's directory as the path-resolution base. It is the shared strict validator for file-backed config layers.

**Data flow**: Inputs are the TOML file path, raw contents, parsed `TomlValue`, and `base_dir`. It installs `AbsolutePathBufGuard::new(base_dir)`, clones the value into `config_error_from_ignored_toml_value_fields::<ConfigToml>`, and returns `Ok(())` or an `InvalidData` error built by `io_error_from_config_error`.

**Call relations**: This function is called from `load_config_toml_for_required_layer` and from `load_project_layers` when a trusted project config is being loaded in strict mode. It is intentionally narrower than full parsing: callers must already have a parsed TOML value.

*Call graph*: calls 2 internal fn (io_error_from_config_error, new); called by 2 (load_config_toml_for_required_layer, load_project_layers); 1 external calls (clone).


##### `validate_cli_overrides_strictly`  (lines 543–564)

```
fn validate_cli_overrides_strictly(
    cli_overrides_layer: &TomlValue,
    base_dir: &Path,
) -> io::Result<()>
```

**Purpose**: Checks runtime `-c/--config` overrides for unknown fields before they are merged into the stack. It treats both ignored schema fields and unknown feature flags as hard errors.

**Data flow**: Inputs are the CLI override layer as `&TomlValue` and a `base_dir`. It installs `AbsolutePathBufGuard`, clones the value into `ignored_toml_value_field::<ConfigToml>`, checks `unknown_feature_toml_value_field`, and returns `Ok(())` or an `InvalidData` `io::Error` naming the offending dotted path.

**Call relations**: This validator is called by `load_config_layers_state` only when strict mode is enabled and CLI overrides are present. It runs before relative-path resolution so malformed overrides fail early.

*Call graph*: calls 2 internal fn (unknown_feature_toml_value_field, new); called by 1 (load_config_layers_state); 3 external calls (clone, new, format!).


##### `load_requirements_toml`  (lines 568–612)

```
async fn load_requirements_toml(
    fs: &dyn ExecutorFileSystem,
    requirements_toml_file: &AbsolutePathBuf,
) -> io::Result<Option<RequirementsLayerEntry>>
```

**Purpose**: Loads the platform system `requirements.toml` file, if present, into a `RequirementsLayerEntry` with an attached base directory. Missing files are treated as absence rather than failure.

**Data flow**: Inputs are the filesystem and an absolute requirements file path. It reads the file text; on success it requires a parent directory, converts that parent to `AbsolutePathBuf`, constructs `RequirementsLayerEntry::from_toml(RequirementSource::SystemRequirementsToml { file }, contents)`, attaches the base dir with `.with_base_dir(...)`, and returns `Ok(Some(entry))`. `NotFound` returns `Ok(None)`; other read errors are wrapped with a path-specific message.

**Call relations**: This function is called by `load_config_layers_state` when managed requirements are enabled, and by tests exercising requirements behavior. It is the requirements analogue of file-backed config loading but leaves TOML interpretation to `RequirementsLayerEntry`.

*Call graph*: calls 5 internal fn (from_toml, read_file_text, from_absolute_path, parent, from_abs_path); called by 4 (load_config_layers_state, cloud_config_bundle_are_not_overwritten_by_system_requirements, load_single_requirements_toml, system_remote_sandbox_config_keeps_cloud_sandbox_modes); 3 external calls (new, format!, clone).


##### `system_requirements_toml_file`  (lines 620–622)

```
fn system_requirements_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: Returns the default absolute path to the system requirements file for the current platform. Unix uses a fixed `/etc` path; Windows delegates to ProgramData-based resolution.

**Data flow**: It takes no arguments and returns `io::Result<AbsolutePathBuf>`. On Unix it wraps `/etc/codex/requirements.toml` with `from_absolute_path`; on Windows it delegates to `windows_system_requirements_toml_file`.

**Call relations**: This helper is used by `system_requirements_toml_file_with_overrides` when no explicit override path is configured. It isolates platform-specific path selection.

*Call graph*: calls 2 internal fn (windows_system_requirements_toml_file, from_absolute_path); called by 1 (system_requirements_toml_file_with_overrides); 1 external calls (new).


##### `system_requirements_toml_file_with_overrides`  (lines 624–631)

```
fn system_requirements_toml_file_with_overrides(
    overrides: &LoaderOverrides,
) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Chooses either an override path or the platform default for the system requirements file. It ensures the chosen path is absolute.

**Data flow**: Input is `&LoaderOverrides`. If `system_requirements_path` is set, it validates and wraps it with `AbsolutePathBuf::from_absolute_path`; otherwise it calls `system_requirements_toml_file`. It returns the resulting `AbsolutePathBuf`.

**Call relations**: This function is called by `load_config_layers_state` before attempting to load system requirements. It is a small policy layer over the platform default helper.

*Call graph*: calls 2 internal fn (system_requirements_toml_file, from_absolute_path); called by 1 (load_config_layers_state).


##### `system_config_toml_file`  (lines 639–641)

```
fn system_config_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: Returns the default absolute path to the system config file for the current platform. Unix uses `/etc/codex/config.toml`; Windows uses the ProgramData-based Codex directory.

**Data flow**: It takes no arguments and returns `io::Result<AbsolutePathBuf>`. On Unix it wraps the constant path with `from_absolute_path`; on Windows it delegates to `windows_system_config_toml_file`.

**Call relations**: This helper is used by `system_config_toml_file_with_overrides` when no explicit system config path override is present.

*Call graph*: calls 2 internal fn (windows_system_config_toml_file, from_absolute_path); called by 1 (system_config_toml_file_with_overrides); 1 external calls (new).


##### `system_config_toml_file_with_overrides`  (lines 643–650)

```
fn system_config_toml_file_with_overrides(
    overrides: &LoaderOverrides,
) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Chooses either an override path or the platform default for the system config file. It normalizes the result into `AbsolutePathBuf`.

**Data flow**: Input is `&LoaderOverrides`. It returns `AbsolutePathBuf::from_absolute_path(path)` when `system_config_path` is set, otherwise `system_config_toml_file()`.

**Call relations**: This function is called by `load_config_layers_state` before loading the system config layer. It mirrors the requirements-path override logic.

*Call graph*: calls 2 internal fn (system_config_toml_file, from_absolute_path); called by 1 (load_config_layers_state).


##### `windows_codex_system_dir`  (lines 653–662)

```
fn windows_codex_system_dir() -> PathBuf
```

**Purpose**: Builds the Windows system configuration directory under ProgramData, with a fallback when known-folder lookup fails. It centralizes the `OpenAI\Codex` suffix.

**Data flow**: It takes no arguments, calls `windows_program_data_dir_from_known_folder()`, falls back to `PathBuf::from(DEFAULT_PROGRAM_DATA_DIR_WINDOWS)` after logging a warning on error, then appends `OpenAI/Codex` and returns the resulting `PathBuf`.

**Call relations**: This helper is used by both Windows-specific system path constructors for config and requirements files. It keeps the fallback behavior consistent across both.

*Call graph*: calls 1 internal fn (windows_program_data_dir_from_known_folder); called by 2 (windows_system_config_toml_file, windows_system_requirements_toml_file).


##### `windows_system_requirements_toml_file`  (lines 665–668)

```
fn windows_system_requirements_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: Constructs the Windows absolute path to `requirements.toml` under the Codex system directory. It validates the resulting path as absolute.

**Data flow**: It calls `windows_codex_system_dir().join("requirements.toml")`, then converts the `PathBuf` into `AbsolutePathBuf` with `try_from`, returning `io::Result<AbsolutePathBuf>`.

**Call relations**: This function is called by `system_requirements_toml_file` on Windows and by tests that verify the expected suffix.

*Call graph*: calls 2 internal fn (windows_codex_system_dir, try_from); called by 1 (system_requirements_toml_file).


##### `windows_system_config_toml_file`  (lines 671–674)

```
fn windows_system_config_toml_file() -> io::Result<AbsolutePathBuf>
```

**Purpose**: Constructs the Windows absolute path to `config.toml` under the Codex system directory. It validates the resulting path as absolute.

**Data flow**: It calls `windows_codex_system_dir().join("config.toml")`, then converts the path with `AbsolutePathBuf::try_from` and returns the result.

**Call relations**: This function is called by `system_config_toml_file` on Windows and by tests that verify the expected suffix.

*Call graph*: calls 2 internal fn (windows_codex_system_dir, try_from); called by 1 (system_config_toml_file).


##### `windows_program_data_dir_from_known_folder`  (lines 677–723)

```
fn windows_program_data_dir_from_known_folder() -> io::Result<PathBuf>
```

**Purpose**: Resolves the Windows ProgramData directory using `SHGetKnownFolderPath` and converts the returned UTF-16 buffer into a `PathBuf`. It handles HRESULT failures, null pointers, and memory ownership explicitly.

**Data flow**: It calls the Windows shell API with `FOLDERID_ProgramData`, first converting `KF_FLAG_DEFAULT` to `u32`. On nonzero HRESULT or null output pointer it returns `io::Error::other(...)`. On success it walks the null-terminated UTF-16 buffer to compute length, builds a slice with `from_raw_parts`, converts it via `OsString::from_wide` into `PathBuf`, frees the COM-allocated memory with `CoTaskMemFree`, and returns the path.

**Call relations**: This low-level helper is used by `windows_codex_system_dir` and by Windows-only tests. It is the only place in this module that touches Win32 APIs directly.

*Call graph*: called by 3 (windows_system_config_toml_file_uses_expected_suffix, windows_system_requirements_toml_file_uses_expected_suffix, windows_codex_system_dir); 6 external calls (from_wide, from, other, format!, from_raw_parts, try_from).


##### `requirements_layers_from_legacy_scheme`  (lines 725–769)

```
fn requirements_layers_from_legacy_scheme(
    loaded_config_layers: LoadedConfigLayers,
) -> io::Result<Vec<RequirementsLayerEntry>>
```

**Purpose**: Backfills admin requirements from legacy managed config layers by reinterpreting selected config fields as constraints. It preserves precedence by ordering file-backed legacy config before MDM-backed legacy config.

**Data flow**: Input is `LoadedConfigLayers`. It destructures file and MDM managed config options, preallocates a vector sized to the number of present layers, iterates over present sources in low-to-high precedence order, deserializes each `TomlValue` into `LegacyManagedConfigToml`, converts that struct with `legacy_requirements_to_toml_value`, wraps the result in `RequirementsLayerEntry::from_toml_value(source, ...)`, and returns the vector.

**Call relations**: This function is called by `load_config_layers_state` when managed requirements are enabled, after low-level managed config loading has completed. It bridges the old `managed_config.toml` scheme into the newer requirements composition pipeline.

*Call graph*: calls 2 internal fn (legacy_requirements_to_toml_value, from_toml_value); called by 1 (load_config_layers_state); 2 external calls (with_capacity, from).


##### `legacy_requirements_to_toml_value`  (lines 771–808)

```
fn legacy_requirements_to_toml_value(legacy: LegacyManagedConfigToml) -> io::Result<TomlValue>
```

**Purpose**: Transforms a parsed `LegacyManagedConfigToml` into a synthetic requirements-style TOML table. It encodes single-value legacy admin settings as allowed-value lists with compatibility tweaks.

**Data flow**: Input is `LegacyManagedConfigToml { approval_policy, approvals_reviewer, sandbox_mode }`. It builds a fresh TOML table, inserting `allowed_approval_policies` as a one-element array when present; inserting `allowed_approvals_reviewers` with `AutoReview` plus `User` or just the configured reviewer; and inserting `allowed_sandbox_modes` with `ReadOnly` always included plus the required mode when different. It returns `TomlValue::Table(table)`.

**Call relations**: This converter is called by `requirements_layers_from_legacy_scheme`. It delegates serialization of Rust values into TOML arrays to `toml_value_from_serializable`.

*Call graph*: calls 1 internal fn (toml_value_from_serializable); called by 1 (requirements_layers_from_legacy_scheme); 3 external calls (Table, new, vec!).


##### `toml_value_from_serializable`  (lines 810–812)

```
fn toml_value_from_serializable(value: T) -> io::Result<TomlValue>
```

**Purpose**: Serializes an arbitrary `serde::Serialize` value into `toml::Value`, converting serialization failures into `InvalidData` I/O errors. It is a tiny adapter used by legacy requirements backfill.

**Data flow**: It takes a generic serializable `value`, calls `TomlValue::try_from(value)`, and returns either the TOML value or `io::Error::new(io::ErrorKind::InvalidData, err)`.

**Call relations**: This helper is used only by `legacy_requirements_to_toml_value` to avoid repeating TOML serialization error handling.

*Call graph*: called by 1 (legacy_requirements_to_toml_value); 1 external calls (try_from).


##### `ProjectTrustDecision::is_trusted`  (lines 837–839)

```
fn is_trusted(&self) -> bool
```

**Purpose**: Reports whether a trust decision explicitly marks a project as trusted. It treats missing trust and explicit untrusted as false.

**Data flow**: It reads `self.trust_level` and returns `true` only when it matches `Some(TrustLevel::Trusted)`.

**Call relations**: This method is used by `ProjectTrustContext::disabled_reason_for_decision` and by project-layer loading logic to decide whether malformed project config should hard-fail or merely be ignored behind a disabled layer.

*Call graph*: called by 1 (disabled_reason_for_decision); 1 external calls (matches!).


##### `ProjectTrustContext::decision_for_dir`  (lines 843–886)

```
fn decision_for_dir(&self, dir: &AbsolutePathBuf) -> ProjectTrustDecision
```

**Purpose**: Determines the effective trust decision for a directory by checking the directory itself, then the computed project root, then the repo root. It also records which trust key should be mentioned in diagnostics.

**Data flow**: Input is `&AbsolutePathBuf dir`. It generates normalized lookup keys for `dir`, searches `self.projects_trust` via `project_trust_for_lookup_key`, then falls back to `self.project_root_lookup_keys`, then optional `self.repo_root_lookup_keys`. If any match is found it returns `ProjectTrustDecision { trust_level: Some(...), trust_key }`; otherwise it returns `trust_level: None` with `trust_key` set to `repo_root_key` if available or `project_root_key` otherwise.

**Call relations**: This method is called by `load_project_layers` for each `.codex` directory between project root and cwd. It delegates normalization and matching to `normalized_project_trust_keys` and `project_trust_for_lookup_key`.

*Call graph*: calls 3 internal fn (normalized_project_trust_keys, project_trust_for_lookup_key, as_path); called by 1 (load_project_layers).


##### `ProjectTrustContext::disabled_reason_for_decision`  (lines 888–904)

```
fn disabled_reason_for_decision(&self, decision: &ProjectTrustDecision) -> Option<String>
```

**Purpose**: Builds the user-facing explanation for why project-local config is disabled for a given trust decision. Trusted projects produce no reason.

**Data flow**: Input is `&ProjectTrustDecision`. If `decision.is_trusted()` it returns `None`. Otherwise it formats a message mentioning `project-local config, hooks, and exec policies`, the selected trust key, and `self.user_config_file`; explicit `Untrusted` gets a stronger 'marked as untrusted' message, while missing trust gets an 'add as trusted project' message.

**Call relations**: This method is called by `load_project_layers` after computing a trust decision for each directory. Its output is passed into `project_layer_entry` to create disabled layers with explanatory text.

*Call graph*: calls 2 internal fn (is_trusted, as_path); called by 1 (load_project_layers); 1 external calls (format!).


##### `ProjectTrustContext::root_checkout_hooks_folder_for_dir`  (lines 906–916)

```
fn root_checkout_hooks_folder_for_dir(&self, dir: &AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: For linked git worktrees, computes the corresponding `.codex` hooks folder under the repository root checkout. It returns `None` for ordinary checkouts where checkout root and repo root are the same.

**Data flow**: Input is `&AbsolutePathBuf dir`. It reads `self.checkout_root` and `self.repo_root`, returns `None` if either is absent or equal, strips `checkout_root` from `dir` to get a relative path, then returns `Some(repo_root.join(relative_dir).join(".codex"))`.

**Call relations**: This method is called by `load_project_layers` so linked worktrees can inherit hook declarations from the root checkout. The resulting path is later consumed by `merge_root_checkout_project_hooks`.

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

**Purpose**: Constructs a `ConfigLayerEntry` for a project `.codex` directory, optionally marking it disabled and attaching a hooks-folder override. It standardizes project-layer source metadata.

**Data flow**: Inputs are the `.codex` folder path, parsed config `TomlValue`, optional disabled reason, and optional hooks override folder. It creates `ConfigLayerSource::Project { dot_codex_folder }`, chooses `ConfigLayerEntry::new_disabled` or `ConfigLayerEntry::new` based on the reason, then applies `.with_hooks_config_folder_override(...)` and returns the entry.

**Call relations**: This helper is called repeatedly by `load_project_layers` for both populated and empty project layers. It encapsulates the common source/disabled bookkeeping.

*Call graph*: calls 2 internal fn (new, new_disabled); called by 1 (load_project_layers); 1 external calls (clone).


##### `sanitize_project_config`  (lines 937–950)

```
fn sanitize_project_config(config: &mut TomlValue) -> Vec<String>
```

**Purpose**: Removes project-local keys that are forbidden from repository-controlled config and returns the list of keys that were stripped. It enforces the `PROJECT_LOCAL_CONFIG_DENYLIST` policy.

**Data flow**: Input is `&mut TomlValue`. If the value is not a table it returns an empty `Vec<String>`. Otherwise it mutates the table in place, removing each denylisted key and collecting the removed key names into a vector, which it returns.

**Call relations**: This function is called by `load_project_layers` after parsing project config and before path resolution/merging. Its returned key list is later turned into a startup warning by `project_ignored_config_keys_warning`.

*Call graph*: called by 1 (load_project_layers); 2 external calls (as_table_mut, new).


##### `project_ignored_config_keys_warning`  (lines 952–967)

```
fn project_ignored_config_keys_warning(
    dot_codex_folder: &AbsolutePathBuf,
    ignored_keys: &[String],
) -> String
```

**Purpose**: Formats the startup warning shown when trusted project config attempted to set denylisted keys. The message points users to user-level config as the supported location.

**Data flow**: Inputs are the `.codex` folder path and the list of ignored key names. It computes the full config file path with `.join(CONFIG_TOML_FILE)`, joins the key names with `, `, and returns a formatted warning string.

**Call relations**: This helper is called by `load_project_layers` only when a trusted project config had denylisted keys removed. The resulting string is accumulated into stack-level startup warnings.

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

**Purpose**: Builds the trust-evaluation context for project-local config by combining merged config, discovered project roots, git roots, and the user's configured trust map. It precomputes normalized lookup keys used during per-directory decisions.

**Data flow**: Inputs are the filesystem, merged non-project config, cwd, project-root markers, config base dir, and user config file path. It deserializes `merged_config` into `ProjectTrustConfigToml` under an `AbsolutePathBufGuard`, finds the project root with `find_project_root`, computes normalized lookup keys and canonical trust keys for project and repo roots, discovers checkout and repo roots, filters the `projects` map down to entries with `trust_level`, and returns a populated `ProjectTrustContext`.

**Call relations**: This function is called by `load_config_layers_state` before loading project layers. It delegates filesystem/project discovery to `find_project_root`, `find_git_checkout_root`, and `resolve_root_git_project_for_trust`, and key normalization to `normalized_project_trust_keys`.

*Call graph*: calls 4 internal fn (find_git_checkout_root, find_project_root, normalized_project_trust_keys, new); called by 1 (load_config_layers_state); 3 external calls (clone, resolve_root_git_project_for_trust, clone).


##### `project_trust_key`  (lines 1023–1028)

```
fn project_trust_key(path: &Path) -> String
```

**Purpose**: Computes the preferred string key for storing trust decisions for a path. It favors normalized/canonical forms and falls back to a normalized raw path string.

**Data flow**: Input is `&Path`. It calls `normalized_project_trust_keys(path)`, returns the first key if any, otherwise normalizes `path.to_string_lossy().to_string()` with `normalize_project_trust_lookup_key`.

**Call relations**: This helper is used by trust-management code outside this file and by tests. It is the public-facing key generator corresponding to the internal lookup normalization logic.

*Call graph*: calls 1 internal fn (normalized_project_trust_keys); called by 5 (thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config, thread_start_with_nested_git_cwd_trusts_repo_root, test_set_project_trusted_migrates_top_level_inline_projects_preserving_entries, set_project_trust_level_inner, trusted_project_edit).


##### `normalized_project_trust_keys`  (lines 1030–1043)

```
fn normalized_project_trust_keys(path: &Path) -> Vec<String>
```

**Purpose**: Generates one or two normalized lookup keys for a path: a canonicalized form and, when different, the original normalized form. This improves matching across symlinks and Windows path casing/UNC variants.

**Data flow**: Input is `&Path`. It converts the raw path to string and normalizes it with `normalize_project_trust_lookup_key`, canonicalizes the path with `dunce::canonicalize` falling back to the original path on error, normalizes that canonical string too, and returns either a one-element vector when both forms match or a two-element vector `[canonical, raw]` when they differ.

**Call relations**: This helper is used by `ProjectTrustContext::decision_for_dir`, `project_trust_context`, and `project_trust_key`. It centralizes the path normalization strategy for trust lookups.

*Call graph*: calls 1 internal fn (normalize_project_trust_lookup_key); called by 3 (decision_for_dir, project_trust_context, project_trust_key); 3 external calls (to_string_lossy, canonicalize, vec!).


##### `normalize_project_trust_lookup_key`  (lines 1045–1051)

```
fn normalize_project_trust_lookup_key(key: String) -> String
```

**Purpose**: Normalizes a trust lookup key string for platform-specific comparison. On Windows it lowercases the key; on other platforms it leaves it unchanged.

**Data flow**: It takes ownership of a `String`, conditionally applies `to_ascii_lowercase()` when `cfg!(windows)` is true, and returns the normalized string.

**Call relations**: This helper is used by `normalized_project_trust_keys` and `project_trust_for_lookup_key` so both generated lookup keys and stored keys are compared consistently.

*Call graph*: called by 1 (normalized_project_trust_keys); 1 external calls (cfg!).


##### `project_trust_for_lookup_key`  (lines 1052–1068)

```
fn project_trust_for_lookup_key(
    projects_trust: &std::collections::HashMap<String, TrustLevel>,
    lookup_key: &str,
) -> Option<(String, TrustLevel)>
```

**Purpose**: Looks up a trust level for a normalized key, first by exact map key and then by normalized comparison across all stored keys. It returns both the matched stored key and the trust level.

**Data flow**: Inputs are the `projects_trust` map and a `lookup_key`. It first checks `projects_trust.get(lookup_key)` for an exact match. If absent, it filters all entries whose normalized stored key equals `lookup_key`, sorts matches by key for deterministic selection, and returns the first `(key.clone(), trust_level)` if any.

**Call relations**: This helper is called by `ProjectTrustContext::decision_for_dir` during directory, project-root, and repo-root trust checks. It exists so older or differently normalized stored keys still match current lookup keys.

*Call graph*: called by 1 (decision_for_dir).


##### `resolve_relative_paths_in_config_toml`  (lines 1076–1099)

```
fn resolve_relative_paths_in_config_toml(
    value_from_config_toml: TomlValue,
    base_dir: &Path,
) -> io::Result<TomlValue>
```

**Purpose**: Resolves path-valued fields in a raw config TOML tree against a base directory while preserving unknown fields and original shape. It uses a `ConfigToml` round-trip only for recognized fields.

**Data flow**: Inputs are a `TomlValue` and `base_dir`. It installs `AbsolutePathBufGuard::new(base_dir)`, attempts to deserialize a clone into `ConfigToml`, and if that fails returns the original value unchanged. On success it serializes the resolved `ConfigToml` back into `TomlValue`, then calls `copy_shape_from_original(&original, &resolved)` to reinsert any fields dropped by the typed round-trip, and returns the merged result.

**Call relations**: This function is called throughout the loader pipeline: system/user/project config loading, CLI overrides, cloud fragments, root-checkout hook merging, and tests. It delegates structural preservation to `copy_shape_from_original`.

*Call graph*: calls 2 internal fn (copy_shape_from_original, new); called by 7 (cloud_config_layers_from_fragments_impl, load_config_layers_state, load_config_toml_for_required_layer, load_project_layers, merge_root_checkout_project_hooks, ensure_resolve_relative_paths_in_config_toml_preserves_all_fields, load_role_layer_toml); 2 external calls (clone, try_from).


##### `copy_shape_from_original`  (lines 1105–1128)

```
fn copy_shape_from_original(original: &TomlValue, resolved: &TomlValue) -> TomlValue
```

**Purpose**: Rebuilds a TOML tree using values from a resolved typed round-trip where available, but preserving every key and array slot from the original tree. It prevents unknown fields from disappearing during path resolution.

**Data flow**: Inputs are `original: &TomlValue` and `resolved: &TomlValue`. For tables, it creates a new map and recursively copies each original key using the resolved child when present or the original child otherwise. For arrays, it does the same by index. For scalar or mismatched variants, it returns `resolved_value.clone()`.

**Call relations**: This helper is called only by `resolve_relative_paths_in_config_toml`. It is the mechanism that preserves original TOML shape after typed path resolution.

*Call graph*: called by 1 (resolve_relative_paths_in_config_toml); 4 external calls (Array, Table, new, new).


##### `find_project_root`  (lines 1130–1153)

```
async fn find_project_root(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
    project_root_markers: &[String],
) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Finds the nearest ancestor directory that contains any configured project-root marker, falling back to `cwd` when none are found. An empty marker list disables searching and treats `cwd` as the root.

**Data flow**: Inputs are the filesystem, `cwd`, and a slice of marker names. If the marker list is empty it returns `cwd.clone()`. Otherwise it iterates `cwd.ancestors()`, joins each marker onto each ancestor, converts to `PathUri`, and returns the first ancestor whose marker path has metadata; if none match it returns `cwd.clone()`.

**Call relations**: This function is called by `project_trust_context` before project-layer traversal. It delegates existence checks to `ExecutorFileSystem::get_metadata`.

*Call graph*: calls 2 internal fn (ancestors, from_abs_path); called by 1 (project_trust_context); 2 external calls (get_metadata, clone).


##### `find_git_checkout_root`  (lines 1155–1177)

```
async fn find_git_checkout_root(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the nearest ancestor containing a `.git` entry, starting from `cwd` if it is a directory or from its parent otherwise. It identifies the checkout root used for linked-worktree hook handling.

**Data flow**: Inputs are the filesystem and `cwd`. It checks metadata for `cwd`; if `cwd` is not a directory it falls back to `cwd.parent()?`. It then walks ancestors, checking for `.git` via `get_metadata`, and returns `Some(dir)` for the first match or `None` if none are found.

**Call relations**: This helper is called by `project_trust_context` alongside `resolve_root_git_project_for_trust`. The distinction between checkout root and repo root is later used by `root_checkout_hooks_folder_for_dir`.

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

**Purpose**: Loads `.codex/config.toml` layers from the project root down to the current working directory, applying trust gating, denylist sanitization, strict validation, path resolution, linked-worktree hook merging, and startup warnings. It returns both the ordered layers and any warnings generated during loading.

**Data flow**: Inputs are the filesystem, `cwd`, `project_root`, `trust_context`, `codex_home`, and `strict_config`. It normalizes `codex_home`, builds the inclusive ancestor list from project root to cwd, and for each directory with a `.codex` folder computes a trust decision, disabled reason, and optional root-checkout hooks override. It skips `.codex` folders that are actually the user's `codex_home`. For each config file: if present and parseable, trusted layers may be strict-validated, sanitized with `sanitize_project_config`, path-resolved, and hook-merged; malformed trusted config errors out, while malformed untrusted config becomes an empty disabled layer. If the config file is missing, it still creates an empty layer after hook merging. It accumulates warnings for ignored denylisted keys in trusted layers and returns `LoadedProjectLayers { layers, startup_warnings }`.

**Call relations**: This function is called by `load_config_layers_state` only when a `cwd` is available. It relies on `ProjectTrustContext` methods for trust decisions, `project_layer_entry` for entry construction, `resolve_relative_paths_in_config_toml` for path normalization, `sanitize_project_config` and `project_ignored_config_keys_warning` for denylist handling, and `merge_root_checkout_project_hooks` for linked-worktree hook replacement.

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

**Purpose**: For linked worktrees, replaces only the `hooks` section of a project config with the corresponding section from the root checkout's `.codex/config.toml`. It leaves all other project-local settings untouched.

**Data flow**: Inputs are the filesystem, mutable project config `TomlValue`, optional hooks config folder override, and `is_trusted`. If no override folder is provided it returns the config unchanged. Otherwise it reads the root hooks config file, parsing TOML when present; parse errors are fatal only for trusted projects and otherwise degrade to an empty table. It resolves relative paths in the root config, removes `hooks` from the local config table if the local config is a table, inserts cloned `hooks` from the root config when present, and returns the modified config.

**Call relations**: This helper is called by `load_project_layers` for both populated and empty project layers whenever linked-worktree hook inheritance may apply. It delegates path normalization to `resolve_relative_paths_in_config_toml`.

*Call graph*: calls 3 internal fn (resolve_relative_paths_in_config_toml, read_file_text, from_abs_path); called by 1 (load_project_layers); 6 external calls (Table, as_table_mut, new, format!, from_str, new).


##### `unit_tests::ensure_resolve_relative_paths_in_config_toml_preserves_all_fields`  (lines 1414–1448)

```
fn ensure_resolve_relative_paths_in_config_toml_preserves_all_fields() -> anyhow::Result<()>
```

**Purpose**: Verifies that path resolution updates recognized path fields while preserving unrelated unknown fields in the resulting TOML tree. It guards the shape-preservation behavior of `resolve_relative_paths_in_config_toml`.

**Data flow**: The test creates a temp directory, parses a TOML snippet containing a path field, a normal recognized field, and an unknown field, runs `resolve_relative_paths_in_config_toml`, constructs the expected `TomlValue` with the path resolved against the temp dir, and asserts equality.

**Call relations**: This unit test exercises `resolve_relative_paths_in_config_toml` directly and indirectly validates `copy_shape_from_original` by ensuring the unknown `foo` field survives the typed round-trip.

*Call graph*: calls 2 internal fn (resolve_relative_paths_in_config_toml, resolve_path_against_base); 5 external calls (String, assert_eq!, tempdir, from_str, new).


##### `unit_tests::legacy_managed_config_backfill_includes_read_only_sandbox_mode`  (lines 1451–1469)

```
fn legacy_managed_config_backfill_includes_read_only_sandbox_mode() -> io::Result<()>
```

**Purpose**: Checks that legacy sandbox requirements backfill always includes `read-only` even when the legacy managed config requested a stricter mode. This preserves the compatibility rule documented in the converter.

**Data flow**: The test constructs `LegacyManagedConfigToml` with `sandbox_mode: Some(WorkspaceWrite)`, converts it with `legacy_requirements_to_toml_value`, and asserts that the resulting TOML table contains `allowed_sandbox_modes = ["read-only", "workspace-write"]`.

**Call relations**: This test targets `legacy_requirements_to_toml_value` and documents the special-case behavior for sandbox requirements backfill.

*Call graph*: 1 external calls (assert_eq!).


##### `unit_tests::legacy_managed_config_backfill_allows_user_when_guardian_is_required`  (lines 1472–1490)

```
fn legacy_managed_config_backfill_allows_user_when_guardian_is_required() -> io::Result<()>
```

**Purpose**: Verifies that legacy `approvals_reviewer = auto_review` backfills to a requirements list that also allows `user`. This encodes the compatibility exception for opting out of the auto-reviewer.

**Data flow**: The test builds `LegacyManagedConfigToml` with `approvals_reviewer: Some(AutoReview)`, converts it, and asserts that `allowed_approvals_reviewers` contains both `auto_review` and `user`.

**Call relations**: This test exercises the reviewer-specific branch in `legacy_requirements_to_toml_value`.

*Call graph*: 1 external calls (assert_eq!).


##### `unit_tests::legacy_managed_config_backfill_preserves_user_only_approvals_reviewer`  (lines 1493–1508)

```
fn legacy_managed_config_backfill_preserves_user_only_approvals_reviewer() -> io::Result<()>
```

**Purpose**: Checks that a legacy `approvals_reviewer = user` setting remains a single allowed reviewer rather than gaining extra values. It complements the auto-review compatibility test.

**Data flow**: The test constructs `LegacyManagedConfigToml` with `approvals_reviewer: Some(User)`, converts it, and asserts that the resulting TOML contains only `allowed_approvals_reviewers = ["user"]`.

**Call relations**: This test covers the non-special-case reviewer branch of `legacy_requirements_to_toml_value`.

*Call graph*: 1 external calls (assert_eq!).


##### `unit_tests::windows_system_requirements_toml_file_uses_expected_suffix`  (lines 1512–1530)

```
fn windows_system_requirements_toml_file_uses_expected_suffix()
```

**Purpose**: Ensures the Windows system requirements path ends with `OpenAI\Codex\requirements.toml` and matches the ProgramData-derived expected path when available. It protects the Windows path-construction logic.

**Data flow**: The test computes an expected path from `windows_program_data_dir_from_known_folder()` or the default fallback, appends the known suffix, then asserts equality and suffix matching against `windows_system_requirements_toml_file()`.

**Call relations**: This Windows-only test exercises `windows_program_data_dir_from_known_folder` and `windows_system_requirements_toml_file` together.

*Call graph*: calls 1 internal fn (windows_program_data_dir_from_known_folder); 2 external calls (assert!, assert_eq!).


##### `unit_tests::windows_system_config_toml_file_uses_expected_suffix`  (lines 1534–1552)

```
fn windows_system_config_toml_file_uses_expected_suffix()
```

**Purpose**: Ensures the Windows system config path ends with `OpenAI\Codex\config.toml` and matches the ProgramData-derived expected path when available. It mirrors the requirements-path test for config.

**Data flow**: The test computes the expected ProgramData-based config path, then asserts equality and suffix matching against `windows_system_config_toml_file()`.

**Call relations**: This Windows-only test validates `windows_program_data_dir_from_known_folder` and `windows_system_config_toml_file`.

*Call graph*: calls 1 internal fn (windows_program_data_dir_from_known_folder); 2 external calls (assert!, assert_eq!).


### `core/src/config/agent_roles.rs`

`config` · `config load`

This file implements agent-role configuration loading for both layered and non-layered config setups. The top-level `load_agent_roles` walks the `ConfigLayerStack` from lowest to highest precedence, reading inline `[agents.roles]` declarations from each layer and discovering additional `.toml` role files under each layer’s `agents/` directory. Within a layer, duplicate role names are rejected with warnings; across layers, higher-precedence roles override lower-precedence ones but inherit missing fields via `merge_missing_role_fields`. Every final role must have a non-empty description.

Role definitions can come directly from `AgentRoleToml` or indirectly through `config_file`. `read_declared_role` first normalizes the inline TOML into `AgentRoleConfig`, validates that any referenced config file exists and is a file, then optionally reads and parses that file with `read_resolved_agent_role_file`. Parsed role files may override the role name and supply description or nickname candidates. `parse_agent_role_file_contents` is careful about path resolution: it installs an `AbsolutePathBufGuard` rooted at the config base directory so relative paths inside the role file deserialize correctly. It strips metadata keys (`name`, `description`, `nickname_candidates`) from the returned `TomlValue` so the remaining `config` field is the actual role config payload.

Validation is strict and concrete: descriptions cannot be blank, discovered role files must define `developer_instructions` when no role-name hint is supplied, nickname candidates must be non-empty, unique, and limited to ASCII alphanumerics plus spaces/hyphens/underscores, and malformed roles are downgraded to startup warnings rather than aborting layered config load.

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

**Purpose**: Loads all agent roles from the layered config stack, merging inline declarations and discovered role files across precedence layers. It accumulates malformed-role problems into startup warnings instead of failing the whole layered load.

**Data flow**: Takes filesystem handle, root `ConfigToml`, `ConfigLayerStack`, and mutable startup-warning vector → gets enabled layers in lowest-precedence-first order → if no layers exist, delegates to `load_agent_roles_without_layers` → otherwise for each layer: parses optional `agents` TOML with `agents_toml_from_layer`, reads declared roles with `read_declared_role`, tracks referenced config files, discovers undeclared role files under `<config_folder>/agents` with `discover_agent_roles_in_dir`, rejects duplicates within the layer, then merges each layer role into the cumulative `roles` map by filling missing fields from any existing lower-precedence role via `merge_missing_role_fields`, validating required descriptions before insertion → returns the final `BTreeMap<String, AgentRoleConfig>`.

**Call relations**: Called during config loading with layer stacks; it orchestrates all helper functions in this file and decides when malformed definitions become warnings versus hard errors.

*Call graph*: calls 8 internal fn (get_layers, agents_toml_from_layer, discover_agent_roles_in_dir, load_agent_roles_without_layers, merge_missing_role_fields, push_agent_role_warning, read_declared_role, validate_required_agent_role_description); called by 1 (load_config_with_layer_stack); 4 external calls (new, new, new, format!).


##### `push_agent_role_warning`  (lines 118–122)

```
fn push_agent_role_warning(startup_warnings: &mut Vec<String>, err: std::io::Error)
```

**Purpose**: Formats and records a startup warning for a malformed agent-role definition. It also logs the warning through tracing.

**Data flow**: Takes mutable warning vector and `std::io::Error` → formats `"Ignoring malformed agent role definition: {err}"` → emits `tracing::warn!` and pushes the message into `startup_warnings`.

**Call relations**: Used throughout layered loading and discovery whenever a single bad role should be skipped without aborting the entire config load.

*Call graph*: called by 2 (discover_agent_roles_in_dir, load_agent_roles); 2 external calls (format!, warn!).


##### `load_agent_roles_without_layers`  (lines 124–144)

```
async fn load_agent_roles_without_layers(
    fs: &dyn ExecutorFileSystem,
    cfg: &ConfigToml,
) -> std::io::Result<BTreeMap<String, AgentRoleConfig>>
```

**Purpose**: Loads agent roles from a plain `ConfigToml` when no config layers are active. Unlike layered loading, duplicate or malformed roles are returned as hard errors.

**Data flow**: Takes filesystem handle and root `ConfigToml` → initializes an empty `BTreeMap` → if `cfg.agents` exists, iterates declared roles, reads each with `read_declared_role`, validates required description, and inserts into the map → if insertion replaces an existing role name, returns `InvalidInput` duplicate-role error → otherwise returns the completed role map.

**Call relations**: Called only by `load_agent_roles` when the layer stack is empty, providing stricter non-layered semantics.

*Call graph*: calls 2 internal fn (read_declared_role, validate_required_agent_role_description); called by 1 (load_agent_roles); 3 external calls (new, new, format!).


##### `read_declared_role`  (lines 146–163)

```
async fn read_declared_role(
    fs: &dyn ExecutorFileSystem,
    declared_role_name: &str,
    role_toml: &AgentRoleToml,
) -> std::io::Result<(String, AgentRoleConfig)>
```

**Purpose**: Resolves one declared role from inline TOML, optionally following its `config_file` to load additional metadata and possibly a different role name. It combines inline and file-backed role information into one normalized result.

**Data flow**: Takes filesystem handle, declared role name, and `AgentRoleToml` → builds initial `AgentRoleConfig` with `agent_role_config_from_toml` → initializes `role_name` from the declared name → if `role.config_file` is present, converts it to `AbsolutePathBuf`, reads and parses the file with `read_resolved_agent_role_file`, replaces `role_name` with the parsed file’s role name, and fills `role.description` / `role.nickname_candidates` from the file when present → returns `(role_name, role)`.

**Call relations**: Used by both layered and non-layered loaders for inline role declarations, encapsulating the precedence between inline metadata and file-backed metadata.

*Call graph*: calls 3 internal fn (agent_role_config_from_toml, read_resolved_agent_role_file, from_absolute_path); called by 2 (load_agent_roles, load_agent_roles_without_layers).


##### `merge_missing_role_fields`  (lines 165–172)

```
fn merge_missing_role_fields(role: &mut AgentRoleConfig, fallback: &AgentRoleConfig)
```

**Purpose**: Fills any missing fields in a higher-precedence role from a lower-precedence fallback role. It performs fieldwise inheritance rather than deep merging.

**Data flow**: Takes mutable `AgentRoleConfig` and fallback `AgentRoleConfig` → for each of `description`, `config_file`, and `nickname_candidates`, replaces `None` in `role` with the cloned fallback value → returns `()`.

**Call relations**: Used by layered loading when a higher-precedence layer overrides a role name but omits some optional fields that should inherit from lower precedence.

*Call graph*: called by 1 (load_agent_roles).


##### `agents_toml_from_layer`  (lines 174–189)

```
fn agents_toml_from_layer(
    layer_toml: &TomlValue,
    config_base_dir: Option<&Path>,
) -> std::io::Result<Option<AgentsToml>>
```

**Purpose**: Extracts and deserializes the `agents` section from a raw layer TOML value, resolving relative paths against the layer’s config directory while deserializing. It returns `None` when the layer has no `agents` section.

**Data flow**: Takes raw layer `TomlValue` and optional config base dir → looks up `layer_toml.get("agents")`; if absent returns `Ok(None)` → installs `AbsolutePathBufGuard` for the base dir while in scope → clones the `agents` value and `try_into()`s it as `AgentsToml`, mapping deserialization failures to `InvalidData` → returns `Ok(Some(AgentsToml))`.

**Call relations**: Used by `load_agent_roles` before iterating declared roles in each config layer.

*Call graph*: called by 1 (load_agent_roles); 1 external calls (get).


##### `agent_role_config_from_toml`  (lines 191–216)

```
async fn agent_role_config_from_toml(
    fs: &dyn ExecutorFileSystem,
    role_name: &str,
    role: &AgentRoleToml,
) -> std::io::Result<AgentRoleConfig>
```

**Purpose**: Normalizes one inline `AgentRoleToml` into `AgentRoleConfig` and validates any referenced config file. It is the inline-TOML parsing step before optional file resolution.

**Data flow**: Takes filesystem handle, role name, and `AgentRoleToml` → converts optional `config_file` to `AbsolutePathBuf`, validating path syntax → calls `validate_agent_role_config_file` if present → normalizes optional description with `normalize_agent_role_description` and nickname candidates with `normalize_agent_role_nickname_candidates` using field-specific labels → returns `AgentRoleConfig { description, config_file: path_buf, nickname_candidates }`.

**Call relations**: Called by `read_declared_role` for every inline role declaration.

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

**Purpose**: Parses a role file’s TOML contents, validates its metadata and developer instructions, resolves relative paths against the file’s base directory, and returns both role metadata and the remaining config payload. It is the central parser for discovered and referenced role files.

**Data flow**: Takes raw file contents, role-file label path, config base dir, and optional role-name hint → parses contents into `TomlValue` with `toml::from_str`, mapping parse errors to `InvalidData` with file path context → installs `AbsolutePathBufGuard` rooted at `config_base_dir` and deserializes a cloned value into `RawAgentRoleFileToml`, again mapping errors with file path context → normalizes optional description, validates `developer_instructions` presence/blankness depending on whether a role-name hint exists, resolves the final role name from trimmed `name` or the hint, normalizes nickname candidates, then mutates the original `TomlValue` table to remove `name`, `description`, and `nickname_candidates` → returns `ResolvedAgentRoleFile { role_name, description, nickname_candidates, config }`.

**Call relations**: Used when reading role files from disk and also by layer-loading code that needs to parse role-file TOML content directly.

*Call graph*: calls 4 internal fn (normalize_agent_role_description, normalize_agent_role_nickname_candidates, validate_agent_role_file_developer_instructions, new); called by 2 (load_role_layer_toml, read_resolved_agent_role_file); 3 external calls (new, format!, from_str).


##### `read_resolved_agent_role_file`  (lines 318–332)

```
async fn read_resolved_agent_role_file(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    role_name_hint: Option<&str>,
) -> std::io::Result<ResolvedAgentRoleFile>
```

**Purpose**: Reads a role file from the executor filesystem and parses it into a resolved role-file structure. It derives the config base directory from the file’s parent path.

**Data flow**: Takes filesystem handle, absolute path, and optional role-name hint → converts the path to `PathUri`, reads file text via `fs.read_file_text`, computes `config_base_dir` as the parent directory or the path itself, and calls `parse_agent_role_file_contents` with the contents and derived paths → returns `ResolvedAgentRoleFile`.

**Call relations**: Used by declared-role resolution and directory discovery whenever a role definition lives in its own TOML file.

*Call graph*: calls 5 internal fn (parse_agent_role_file_contents, read_file_text, as_path, parent, from_abs_path); called by 2 (discover_agent_roles_in_dir, read_declared_role).


##### `normalize_agent_role_description`  (lines 334–346)

```
fn normalize_agent_role_description(
    field_label: &str,
    description: Option<&str>,
) -> std::io::Result<Option<String>>
```

**Purpose**: Validates and trims an optional role description. Blank descriptions are rejected, while absent descriptions remain `None`.

**Data flow**: Takes a field label and optional description string → trims the string if present → returns `InvalidInput` if the trimmed value is empty, `Some(trimmed.to_string())` if non-empty, or `None` if absent.

**Call relations**: Used for both inline role declarations and parsed role files so description validation is consistent.

*Call graph*: called by 2 (agent_role_config_from_toml, parse_agent_role_file_contents); 2 external calls (new, format!).


##### `validate_required_agent_role_description`  (lines 348–360)

```
fn validate_required_agent_role_description(
    role_name: &str,
    description: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Enforces that a final resolved role has a description. This is stricter than normalization because it rejects missing descriptions entirely.

**Data flow**: Takes role name and optional description → returns `Ok(())` if present, otherwise returns `InvalidInput` stating that the role must define a description.

**Call relations**: Called after merging role fields so the final effective role cannot omit a description.

*Call graph*: called by 2 (load_agent_roles, load_agent_roles_without_layers); 2 external calls (new, format!).


##### `validate_agent_role_file_developer_instructions`  (lines 362–385)

```
fn validate_agent_role_file_developer_instructions(
    role_file_label: &Path,
    developer_instructions: Option<&str>,
    require_present: bool,
) -> std::io::Result<()>
```

**Purpose**: Validates the `developer_instructions` field inside a role file, optionally requiring it to be present. Blank strings are always rejected.

**Data flow**: Takes role-file path label, optional developer instructions, and `require_present` flag → trims the string if present → returns `InvalidInput` for blank strings, `Ok(())` for non-empty strings, `InvalidInput` for missing values when `require_present` is true, and `Ok(())` for missing values otherwise.

**Call relations**: Used by `parse_agent_role_file_contents`; discovered standalone role files require developer instructions, while referenced files with a role-name hint may omit them.

*Call graph*: called by 1 (parse_agent_role_file_contents); 2 external calls (new, format!).


##### `validate_agent_role_config_file`  (lines 387–420)

```
async fn validate_agent_role_config_file(
    fs: &dyn ExecutorFileSystem,
    role_name: &str,
    config_file: Option<&AbsolutePathBuf>,
) -> std::io::Result<()>
```

**Purpose**: Checks that an inline role’s `config_file` points to an existing file in the executor filesystem. It rejects missing paths and directories with role-specific error messages.

**Data flow**: Takes filesystem handle, role name, and optional absolute config-file path → if absent returns `Ok(())` → converts the path to `PathUri`, fetches metadata with `fs.get_metadata`, mapping lookup failures to `InvalidInput` mentioning `agents.{role_name}.config_file` → returns `Ok(())` if `metadata.is_file`, otherwise returns `InvalidInput` stating the path must point to a file.

**Call relations**: Called by `agent_role_config_from_toml` before any role file is later read, so bad config-file references fail early.

*Call graph*: calls 1 internal fn (from_abs_path); called by 1 (agent_role_config_from_toml); 3 external calls (new, get_metadata, format!).


##### `normalize_agent_role_nickname_candidates`  (lines 422–472)

```
fn normalize_agent_role_nickname_candidates(
    field_label: &str,
    nickname_candidates: Option<&[String]>,
) -> std::io::Result<Option<Vec<String>>>
```

**Purpose**: Validates, trims, deduplicates, and normalizes optional nickname candidates for a role. It enforces a restricted ASCII character set and rejects empty lists or blank entries.

**Data flow**: Takes field label and optional slice of nickname strings → returns `Ok(None)` if absent → rejects empty slices → iterates candidates, trimming each, rejecting blanks, rejecting duplicates via a `BTreeSet`, and rejecting any character outside ASCII alphanumerics plus space/hyphen/underscore → collects normalized names into a `Vec<String>` and returns `Ok(Some(vec))`.

**Call relations**: Used for both inline role declarations and parsed role files so nickname validation is centralized.

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

**Purpose**: Recursively discovers standalone role files under an `agents/` directory, skipping files already referenced by declared roles. Malformed or duplicate discovered roles become startup warnings rather than hard failures.

**Data flow**: Takes filesystem handle, agents directory path, set of declared role-file paths, and mutable startup warnings → collects candidate TOML files with `collect_agent_role_files` → for each file, skips it if its path is in `declared_role_files`, otherwise reads and parses it with `read_resolved_agent_role_file` → on parse/read error, records a warning and continues → rejects duplicate discovered role names within the directory with a warning → inserts each valid discovered role into a `BTreeMap` as `AgentRoleConfig { description, config_file: Some(path), nickname_candidates }` → returns the discovered-role map.

**Call relations**: Called by layered loading for each layer config folder to supplement inline declarations with filesystem-discovered roles.

*Call graph*: calls 3 internal fn (collect_agent_role_files, push_agent_role_warning, read_resolved_agent_role_file); called by 1 (load_agent_roles); 4 external calls (new, contains, new, format!).


##### `collect_agent_role_files`  (lines 521–554)

```
async fn collect_agent_role_files(
    fs: &dyn ExecutorFileSystem,
    dir: &AbsolutePathBuf,
) -> std::io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Recursively walks an `agents/` directory and returns all `.toml` files in sorted order. Missing directories are treated as empty rather than errors.

**Data flow**: Takes filesystem handle and absolute directory path → initializes `files` and a stack of directories starting with the root → repeatedly pops a directory, converts it to `PathUri`, and reads entries with `fs.read_directory`; `NotFound` is ignored, other errors are returned → for each entry, joins its file name onto the current directory, pushing subdirectories onto the stack and collecting files whose extension is exactly `toml` → sorts the resulting `Vec<AbsolutePathBuf>` and returns it.

**Call relations**: Used by `discover_agent_roles_in_dir` as the filesystem traversal primitive for standalone role discovery.

*Call graph*: calls 2 internal fn (join, from_abs_path); called by 1 (discover_agent_roles_in_dir); 3 external calls (new, read_directory, vec!).


### `core/src/config_lock.rs`

`config` · `config load`

This file defines the lockfile contract around `ConfigLockfileToml`, including the current `CONFIG_LOCK_VERSION`, a small `ConfigLockReplayOptions` flag set, and helper routines for converting between runtime config structures and TOML-safe lockfile content. The main read path asynchronously loads a lockfile from disk with `tokio::fs::read_to_string`, parses it with `toml::from_str`, and immediately rejects unsupported metadata versions before the caller can trust the contents.

The replay-validation path is careful about false mismatches. `validate_config_lock_replay` first checks metadata shape on both lockfiles, optionally ignores `codex_version` differences, removes `debug.config_lockfile` controls from both sides, and clears removed compatibility entries from `config.features` before comparing whole `ConfigLockfileToml` values. When they differ, it renders both values back to pretty TOML and produces a compact unified diff via `similar::TextDiff`, so failures explain the exact config drift.

For lockfile injection back into the layered config system, `lock_layer_from_config` serializes the sanitized config body into a `toml::Value` and wraps it in a `ConfigLayerEntry` sourced as a user file at the lock path. The file also centralizes lock-related `io::Error` creation and provides `toml_round_trip`, which verifies that a resolved value can be losslessly represented in TOML by converting to `toml::Value`, deserializing into `T`, and comparing the represented shape back to the original.

#### Function details

##### `read_config_lock_from_path`  (lines 19–36)

```
async fn read_config_lock_from_path(
    path: &AbsolutePathBuf,
) -> io::Result<ConfigLockfileToml>
```

**Purpose**: Loads a config lockfile from disk and returns a parsed `ConfigLockfileToml` only if its metadata shape is supported. It turns both file I/O and TOML parse failures into lock-specific `io::Error`s that mention the path.

**Data flow**: Takes an `&AbsolutePathBuf`, reads the file contents as UTF-8 text, parses that text into `ConfigLockfileToml`, then validates the `version` field through metadata checks. On success it returns the parsed lockfile; on failure it returns an `io::Error` describing the read, parse, or version problem.

**Call relations**: It is used during lock-aware config building by `build_inner`, which needs a trusted lockfile before replaying or layering config. Internally it delegates metadata validation after parsing so callers never receive a structurally unsupported lockfile.

*Call graph*: calls 1 internal fn (validate_config_lock_metadata_shape); called by 1 (build_inner); 2 external calls (read_to_string, from_str).


##### `config_lockfile`  (lines 38–44)

```
fn config_lockfile(config: ConfigToml) -> ConfigLockfileToml
```

**Purpose**: Wraps a resolved `ConfigToml` into the persisted lockfile envelope. It stamps the current lock format version and the build-time Codex package version alongside the config payload.

**Data flow**: Consumes a `ConfigToml` by value and constructs a `ConfigLockfileToml` with `version` set to `CONFIG_LOCK_VERSION`, `codex_version` set from `env!("CARGO_PKG_VERSION")`, and `config` set to the provided value. It returns the assembled lockfile struct without side effects.

**Call relations**: It is called by `to_config_lockfile_toml` when the system materializes a lockfile representation from resolved config. It does not perform validation itself because it is producing the canonical shape.

*Call graph*: called by 1 (to_config_lockfile_toml); 1 external calls (env!).


##### `validate_config_lock_replay`  (lines 46–74)

```
fn validate_config_lock_replay(
    expected_lock: &ConfigLockfileToml,
    actual_lock: &ConfigLockfileToml,
    options: ConfigLockReplayOptions,
) -> io::Result<()>
```

**Purpose**: Checks that a replayed effective config matches an expected lockfile, with optional tolerance for Codex version drift. When the normalized lockfiles differ, it returns a detailed diff instead of a generic mismatch.

**Data flow**: Accepts expected and actual `&ConfigLockfileToml` plus `ConfigLockReplayOptions`. It validates both metadata blocks, optionally rejects differing `codex_version` values, normalizes both lockfiles for comparison, compares them for equality, and if unequal serializes both to TOML and computes a unified diff string. It returns `Ok(())` on match or an `io::Error` describing the mismatch.

**Call relations**: It is invoked by runtime validation (`validate_config_lock_if_configured`) and several tests that exercise version mismatch and diff behavior. Its main delegation is to `config_lock_for_comparison` for normalization and `compact_diff` for human-readable diagnostics.

*Call graph*: calls 4 internal fn (compact_diff, config_lock_error, config_lock_for_comparison, validate_config_lock_metadata_shape); called by 5 (lock_validation_can_ignore_codex_version_mismatch, lock_validation_ignores_removed_apps_mcp_path_override, lock_validation_rejects_codex_version_mismatch_by_default, lock_validation_reports_config_diff, validate_config_lock_if_configured); 1 external calls (format!).


##### `lock_layer_from_config`  (lines 76–91)

```
fn lock_layer_from_config(
    lock_path: &AbsolutePathBuf,
    lockfile: &ConfigLockfileToml,
) -> io::Result<ConfigLayerEntry>
```

**Purpose**: Converts lockfile config content into a `ConfigLayerEntry` that can be inserted into the layered config stack as if it came from a user file. It deliberately excludes lock-control debug settings from that layer.

**Data flow**: Takes the lockfile path and a `&ConfigLockfileToml`, clones and sanitizes `lockfile.config` via `config_without_lock_controls`, serializes the sanitized config into a `toml::Value`, and constructs a `ConfigLayerEntry` with `ConfigLayerSource::User { file, profile: None }`. It returns the new layer entry or an `io::Error` if serialization fails.

**Call relations**: It is called by `build_inner` when replaying a lockfile into the config layer stack. It depends on `config_without_lock_controls` to avoid feeding lock-debug knobs back into normal config resolution.

*Call graph*: calls 3 internal fn (new, config_without_lock_controls, toml_value); called by 1 (build_inner); 1 external calls (clone).


##### `config_without_lock_controls`  (lines 93–97)

```
fn config_without_lock_controls(config: &ConfigToml) -> ConfigToml
```

**Purpose**: Produces a cloned `ConfigToml` with lockfile-specific debug controls removed. This gives callers a non-mutating way to sanitize config before comparison or layering.

**Data flow**: Receives `&ConfigToml`, clones it, mutates the clone through `clear_config_lock_debug_controls`, and returns the cleaned `ConfigToml`. It does not touch the original input.

**Call relations**: It is used both by `build_inner` and `lock_layer_from_config` wherever a sanitized copy is needed. The actual field-level cleanup is delegated to `clear_config_lock_debug_controls`.

*Call graph*: calls 1 internal fn (clear_config_lock_debug_controls); called by 2 (build_inner, lock_layer_from_config); 1 external calls (clone).


##### `clear_config_lock_debug_controls`  (lines 99–110)

```
fn clear_config_lock_debug_controls(config: &mut ConfigToml)
```

**Purpose**: Removes `debug.config_lockfile` from a mutable `ConfigToml`, and drops the whole `debug` section if that was its only remaining content. This keeps lock-control settings from affecting persisted or compared config state.

**Data flow**: Takes `&mut ConfigToml`, checks `config.debug`, sets `debug.config_lockfile = None` when present, then clears `config.debug` entirely if the remaining debug section is effectively empty by this criterion. It returns no value and mutates the passed config in place.

**Call relations**: It is the shared low-level sanitizer used by `config_without_lock_controls`, `config_lock_for_comparison`, and `drop_lockfile_inputs`. Those callers use it either before persistence/comparison or while cleaning transient inputs.

*Call graph*: called by 3 (config_lock_for_comparison, config_without_lock_controls, drop_lockfile_inputs).


##### `validate_config_lock_metadata_shape`  (lines 112–120)

```
fn validate_config_lock_metadata_shape(lock: &ConfigLockfileToml) -> io::Result<()>
```

**Purpose**: Enforces that a lockfile uses the single supported metadata version. It is intentionally narrow: only the top-level version field is checked here.

**Data flow**: Accepts `&ConfigLockfileToml`, reads `lock.version`, compares it to `CONFIG_LOCK_VERSION`, and returns `Ok(())` if they match. Otherwise it constructs and returns an `io::Error` explaining the unsupported version.

**Call relations**: It is called immediately after parsing in `read_config_lock_from_path` and before replay comparison in `validate_config_lock_replay`. This ensures both persisted and in-memory lockfiles are rejected consistently when the format version changes.

*Call graph*: calls 1 internal fn (config_lock_error); called by 2 (read_config_lock_from_path, validate_config_lock_replay); 1 external calls (format!).


##### `config_lock_for_comparison`  (lines 122–135)

```
fn config_lock_for_comparison(
    lockfile: &ConfigLockfileToml,
    options: ConfigLockReplayOptions,
) -> ConfigLockfileToml
```

**Purpose**: Normalizes a lockfile into the form used for replay equality checks. It strips lock-debug controls, removes obsolete compatibility feature entries, and can blank out the Codex version field when configured.

**Data flow**: Takes `&ConfigLockfileToml` and `ConfigLockReplayOptions`, clones the lockfile, mutates `lockfile.config` to clear debug lock controls, calls `clear_removed_compatibility_entries` on `config.features` when present, optionally clears `codex_version`, and returns the normalized clone.

**Call relations**: It is only used by `validate_config_lock_replay`, which compares normalized expected and actual lockfiles rather than raw values. Its job is to encode the comparison invariants in one place.

*Call graph*: calls 1 internal fn (clear_config_lock_debug_controls); called by 1 (validate_config_lock_replay); 1 external calls (clone).


##### `config_lock_error`  (lines 137–139)

```
fn config_lock_error(message: impl Into<String>) -> io::Error
```

**Purpose**: Creates a standardized `io::Error` for lockfile-related failures. It keeps all lock helpers returning the same error kind and formatting style.

**Data flow**: Accepts any message convertible into `String`, converts it, and wraps it with `io::Error::other`. It returns the constructed error without mutating external state.

**Call relations**: It is the common error constructor used by validation, TOML conversion, and replay comparison helpers such as `toml_round_trip`, `validate_config_lock_metadata_shape`, and `validate_config_lock_replay`.

*Call graph*: called by 3 (toml_round_trip, validate_config_lock_metadata_shape, validate_config_lock_replay); 2 external calls (into, other).


##### `compact_diff`  (lines 141–157)

```
fn compact_diff(root: &str, expected: &T, actual: &T) -> io::Result<String>
```

**Purpose**: Builds a short unified diff between two serializable values by rendering them as pretty TOML. The output is intended for lock replay mismatch messages.

**Data flow**: Takes a root label plus `expected` and `actual` values implementing `Serialize`, serializes each to pretty TOML strings, feeds those strings into `TextDiff::from_lines`, and formats a unified diff with a small context radius and `expected`/`actual` headers. It returns the diff string or an `io::Error` if serialization fails.

**Call relations**: It is called only from `validate_config_lock_replay` after normalized lockfiles compare unequal. That caller uses the diff to explain exactly what changed in the replayed config.

*Call graph*: called by 1 (validate_config_lock_replay); 2 external calls (from_lines, to_string_pretty).


##### `toml_value`  (lines 159–162)

```
fn toml_value(value: &T, label: &str) -> io::Result<toml::Value>
```

**Purpose**: Converts an arbitrary serializable value into `toml::Value` with a labeled error message. It is the basic serialization primitive used by higher-level lock helpers.

**Data flow**: Accepts `&T` where `T: Serialize` and a human-readable label, attempts `toml::Value::try_from(value)`, and returns the resulting `toml::Value` or an `io::Error` naming the label on failure.

**Call relations**: It is used by `lock_layer_from_config` to build a config layer payload and by `toml_round_trip` as the first and final representation check. It centralizes TOML-shape conversion errors.

*Call graph*: called by 2 (lock_layer_from_config, toml_round_trip); 1 external calls (try_from).


##### `toml_round_trip`  (lines 164–179)

```
fn toml_round_trip(value: &impl Serialize, label: &'static str) -> io::Result<T>
```

**Purpose**: Verifies that a resolved value can be losslessly represented in TOML and deserialized back into a target type `T`. This catches values whose serialized TOML shape would drop or alter information.

**Data flow**: Takes a serializable input reference and a static label, converts the input to `toml::Value`, deserializes that value into `T`, reserializes the resulting `T` back to `toml::Value`, and compares the represented shape to the original. It returns the deserialized `T` on exact shape preservation or an `io::Error` if conversion fails or the round-trip changes the value.

**Call relations**: It is called by `resolved_config_to_toml` when turning resolved config into TOML-safe structures. Internally it relies on `toml_value` for both the initial and verification serialization steps and uses `config_lock_error` for all failure cases.

*Call graph*: calls 2 internal fn (config_lock_error, toml_value); called by 1 (resolved_config_to_toml); 2 external calls (clone, format!).
