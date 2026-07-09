# Configuration, feature resolution, and startup policy assembly  `stage-4`

This stage is the startup control room. It gathers every setting that can affect Codex before real work begins, then produces the final runtime configuration used by the app, server, tools, sandbox, and TUI.

First, the config ingestion parts read layered sources: managed policy, cloud settings, user and project files, thread overrides, and command-line flags. Shared CLI options, project-root markers, app-server config loading, and the central core config builder all feed into this. Requirements and permission files then turn human settings into concrete rules for files, network access, hooks, and sandbox limits.

Next, feature and catalog parts decide what is available: feature flags, models, providers, plugins, marketplaces, MCP tool servers, skills, presets, and bundled assets. Editing helpers safely update config files for plugins, marketplaces, and MCP servers, and migration code imports compatible external-agent settings.

Finally, the stage prepares policies for real execution. It resolves Windows sandbox permissions, executable paths, tool settings, service tiers, keymaps, and TUI persistence. Debug and config-lock files make the result explainable and repeatable, so later sessions can prove they used the same effective rules.

## Sub-stages

- [Config layer ingestion and requirements composition](stage-4.1.md) `stage-4.1` — 42 files
- [Feature flags, provider catalogs, and built-in asset installation](stage-4.2.md) `stage-4.2` — 33 files

## Files in this stage

### Config sources and effective assembly
These files define shared CLI and config inputs, expose config-loading facades, and assemble the fully resolved runtime configuration used by the rest of the system.

### `utils/cli/src/shared_options.rs`

`config` · `startup / command-line parsing`

This file is the common menu of command-line choices for Codex. Instead of making every command define its own separate flags for things like the model, working directory, sandbox mode, images, or local provider, this file puts those shared choices in one struct called `SharedCliOptions`. The `clap` annotations tell the command-line parser how each option should look, such as `--model`, `--image`, `--cd`, or the deliberately scary `--dangerously-bypass-approvals-and-sandbox` flag.

The file also solves a practical problem: command-line tools often have options at more than one level. For example, a user might put a model choice on the main command, then run a subcommand that has its own options. The code needs clear rules for which value wins. The two methods here are those rules.

Some options are inherited from a root command if the more specific command did not choose them. Others are merged, such as images and extra writable directories. Safety-related options get special care: if a subcommand explicitly chooses a sandbox setting, that choice is respected instead of accidentally inheriting a dangerous bypass from above. Without this file, different Codex commands could interpret the same flags differently, or accidentally ignore important safety and workspace settings.

#### Function details

##### `SharedCliOptions::inherit_exec_root_options`  (lines 66–129)

```
fn inherit_exec_root_options(&mut self, root: &Self)
```

**Purpose**: This function fills in missing options on one command from a root, or top-level, command. It is used when a more specific command should inherit defaults from the command that wrapped it, while still keeping anything the specific command already chose.

**Data flow**: It starts with two sets of command-line options: `self`, which may be incomplete, and `root`, which represents the outer command's choices. For each setting, it copies the root value only when `self` has not already chosen a value. List-like settings, such as images and extra writable directories, are combined with the root values first. The result is that `self` is updated in place with inherited defaults and merged lists.

**Call relations**: This method is part of the setup path that combines shared command-line options before Codex acts on them. It does not hand work to another project-specific function in this file; its job is to apply the inheritance rules directly so later code can read one completed `SharedCliOptions` value.


##### `SharedCliOptions::apply_subcommand_overrides`  (lines 131–176)

```
fn apply_subcommand_overrides(&mut self, subcommand: Self)
```

**Purpose**: This function applies a subcommand's options on top of an existing set of options. It lets the more specific command override the broader command where the user clearly supplied a value.

**Data flow**: It takes the current options in `self` and a separate `subcommand` options value. If the subcommand contains a model, provider, profile, working directory, sandbox choice, or safety bypass choice, those values replace or update the current ones. Images from the subcommand replace the current images when present, while extra writable directories are added to the existing list. The result is an updated `self` that reflects the subcommand's more specific choices.

**Call relations**: This method is used after options have been parsed and a subcommand's settings need to be layered onto the main command's settings. Like the inheritance method, it keeps the merging logic local so the rest of the CLI can use the final options without re-deciding precedence rules.


### `app-server/src/config/mod.rs`

`config` · `config load`

This file does not contain settings itself. Instead, it tells Rust that there is a configuration submodule named `external_agent_config`. A module is like a labeled folder in the code: it groups related code so other files can find it in a predictable place.

The real work lives in `external_agent_config`, which likely defines or loads settings for an external agent that the app server talks to or controls. Without this small file, that configuration code would not be connected into the `config` section of the app server. Other code would have a harder time importing it, or might not be able to see it at all.

The `pub(crate)` part means this module is visible inside this Rust crate, but not exposed as a public API to outside crates. In plain terms: it is shared within the app server, but kept private from the wider world. This helps keep configuration internals organized without making them part of the project's external contract.


### `app-server/src/config_manager.rs`

`config` · `config load and request handling`

Codex has many sources of settings: a home directory, a user config file, command-line overrides, cloud-managed config, per-thread session config, and temporary request overrides. This file acts like the front desk for all of them. Instead of each part of the server guessing how to assemble configuration, they ask `ConfigManager` for the latest usable `Config`.

`ConfigManager` stores the long-lived ingredients needed to build config, including the Codex home folder, loader options, cloud config loader, and thread config loader. Some of these can change while the server is running, so they are kept behind read-write locks, which are locks that let many readers or one writer safely access shared data.

When a caller asks for config, the manager gathers the current overrides, merges request-specific values, builds the config through Codex's config builder, then applies two final server-side adjustments: runtime feature enablement and executable paths discovered from process startup. It also exposes lower-level config layer loading for tools that need to inspect where settings came from.

A key safety rule appears near the end: runtime feature toggles cannot override features protected by config files or feature requirements. In everyday terms, live switches can change only the lights that are not locked behind a cover.

#### Function details

##### `ConfigManager::new`  (lines 41–60)

```
fn new(
        codex_home: PathBuf,
        cli_overrides: Vec<(String, TomlValue)>,
        loader_overrides: LoaderOverrides,
        strict_config: bool,
        cloud_config_bundle: CloudConfigBu
```

**Purpose**: Creates a new shared configuration manager from the startup inputs. It stores fixed choices, such as the Codex home directory, and wraps changeable pieces in safe shared containers so the server can update them later.

**Data flow**: The caller gives paths, command-line overrides, loader options, strictness, cloud and thread loaders, and executable-path information. The function packages those values into a `ConfigManager`, putting mutable values behind shared read-write locks. The result is a manager that other server components can clone and use.

**Call relations**: This is used during server and test setup, including startup flows such as `start_uninitialized` and `run_main_with_transport_options`. Later functions on the manager rely on the stored pieces when they load or refresh configuration.

*Call graph*: called by 5 (start_uninitialized, refresh_test_state, build_test_processor, derive_config_from_params_uses_session_thread_config_model_provider, run_main_with_transport_options); 3 external calls (new, new, new).


##### `ConfigManager::codex_home`  (lines 62–64)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Returns the Codex home directory known by this manager. Other code uses this as the base place for finding config files and related state.

**Data flow**: It reads the stored home path and returns it as a path reference. Nothing is changed.

**Call relations**: This is a small helper used by `user_config_path`, `load_default_config`, and plugin-related code that needs to know where Codex lives on disk.

*Call graph*: called by 3 (load_default_config, user_config_path, emit_plugin_toggle_events); 1 external calls (as_path).


##### `ConfigManager::user_config_path`  (lines 66–68)

```
fn user_config_path(&self) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Computes the path to the selected user configuration file. This respects any loader override that says to use a non-default config file.

**Data flow**: It reads the manager's Codex home path and loader override settings. It asks the loader override logic to resolve the user config path. The result is either an absolute path or an input/output error.

**Call relations**: This builds on `ConfigManager::codex_home`. It is used when code needs to know exactly which user config file is active, especially during default config loading or config editing.

*Call graph*: calls 2 internal fn (codex_home, user_config_path).


##### `ConfigManager::current_cli_overrides`  (lines 70–75)

```
fn current_cli_overrides(&self) -> Vec<(String, TomlValue)>
```

**Purpose**: Returns the current command-line override settings. These are settings originally supplied outside the config file, and they should keep taking precedence when config is reloaded.

**Data flow**: It reads the shared override list through a read lock and clones it. If the lock cannot be read, it safely returns an empty list rather than crashing.

**Call relations**: Most config-loading paths call this before building config, including `load_latest_config`, `load_with_overrides`, `load_for_cwd`, `load_default_config`, `load_config_layers`, and thread startup.

*Call graph*: called by 6 (load_config_layers, load_default_config, load_for_cwd, load_latest_config, load_with_overrides, thread_start_task).


##### `ConfigManager::current_cloud_config_bundle`  (lines 77–82)

```
fn current_cloud_config_bundle(&self) -> CloudConfigBundleLoader
```

**Purpose**: Returns the current cloud-managed configuration loader. This lets config loading include settings supplied by a remote service when such settings are available.

**Data flow**: It reads the shared cloud config loader through a read lock and clones it. If the lock cannot be read, it falls back to the default empty loader.

**Call relations**: This is pulled into full config construction by `load_with_cli_overrides` and into layer inspection by `load_config_layers`.

*Call graph*: called by 2 (load_config_layers, load_with_cli_overrides).


##### `ConfigManager::extend_runtime_feature_enablement`  (lines 84–92)

```
fn extend_runtime_feature_enablement(&self, enablement: I) -> Result<(), ()>
```

**Purpose**: Adds or updates live feature switches while the server is running. This is used for experimental feature enablement without rewriting config files.

**Data flow**: It receives feature-name to enabled-or-disabled pairs. It takes a write lock on the runtime feature map and extends the stored map. It returns success, or a simple error if the lock cannot be acquired.

**Call relations**: The experimental feature setting flow calls this through `set_experimental_feature_enablement`. Later config loads apply these stored choices unless the features are protected by config policy.

*Call graph*: called by 1 (set_experimental_feature_enablement).


##### `ConfigManager::replace_cloud_config_bundle_loader`  (lines 94–106)

```
fn replace_cloud_config_bundle_loader(
        &self,
        auth_manager: Arc<AuthManager>,
        chatgpt_base_url: String,
    )
```

**Purpose**: Swaps in a new cloud config loader after ChatGPT authentication or cloud context changes. This lets future config loads see the latest cloud-managed settings.

**Data flow**: It receives an authentication manager and base URL, builds a fresh cloud config loader using the Codex home directory, and writes it into the shared slot. If the write lock fails, it logs a warning and leaves the old loader in place.

**Call relations**: Login completion paths call this after authentication state changes. Subsequent calls to `current_cloud_config_bundle`, `load_with_cli_overrides`, or `load_config_layers` will then use the updated loader.

*Call graph*: called by 2 (login_chatgpt_auth_tokens_response, send_chatgpt_login_completion_notifications); 3 external calls (clone, cloud_config_bundle_loader, warn!).


##### `ConfigManager::replace_thread_config_loader`  (lines 108–117)

```
fn replace_thread_config_loader(
        &self,
        thread_config_loader: Arc<dyn ThreadConfigLoader>,
    )
```

**Purpose**: Replaces the component that knows how to load per-thread configuration. A thread here means a conversation or session whose settings may differ from the global defaults.

**Data flow**: It receives a new thread config loader and tries to store it behind the shared write lock. If the lock cannot be acquired, it logs a warning and keeps the previous loader.

**Call relations**: This prepares future config loads. `current_thread_config_loader` is the reader side that later hands the active loader to full config loading and config layer inspection.

*Call graph*: 1 external calls (warn!).


##### `ConfigManager::current_thread_config_loader`  (lines 119–124)

```
fn current_thread_config_loader(&self) -> Arc<dyn ThreadConfigLoader>
```

**Purpose**: Returns the currently active per-thread config loader. If the stored loader cannot be read, it uses a no-op loader, meaning a loader that intentionally adds nothing.

**Data flow**: It reads the shared loader, clones the shared pointer, and returns it. On lock failure, it creates and returns a no-op replacement.

**Call relations**: Both `load_with_cli_overrides` and `load_config_layers` call this so thread-specific settings can be included in the config view.

*Call graph*: called by 2 (load_config_layers, load_with_cli_overrides).


##### `ConfigManager::sync_default_client_residency_requirement`  (lines 126–136)

```
async fn sync_default_client_residency_requirement(&self)
```

**Purpose**: Updates the default network client with the latest data residency requirement from config. Data residency means a policy about where data is allowed to be processed or stored.

**Data flow**: It loads the latest config. If loading succeeds, it reads the `enforce_residency` setting and sends that value to the default client setup. If loading fails, it logs a warning.

**Call relations**: Authentication refresh and login completion code call this after credentials change. It depends on `load_latest_config` so the client policy follows the same config rules as the rest of the server.

*Call graph*: calls 2 internal fn (load_latest_config, set_default_client_residency_requirement); called by 2 (login_chatgpt_auth_tokens_response, send_chatgpt_login_completion_notifications); 1 external calls (warn!).


##### `ConfigManager::load_latest_config`  (lines 138–149)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> std::io::Result<Config>
```

**Purpose**: Loads the freshest normal configuration using the manager's current command-line overrides. This is the common path for code that simply wants the current effective config.

**Data flow**: It gathers current command-line overrides, supplies no request-specific overrides, uses default typed overrides, and optionally supplies a fallback current working directory. It delegates the actual build to `load_with_cli_overrides` and returns the resulting `Config` or an error.

**Call relations**: Many refresh and inspection paths call this, including `sync_default_client_residency_requirement`, `load_latest_config_for_thread`, plugin cache refresh, and strict refresh work. It is a convenience wrapper around the more general loader.

*Call graph*: calls 2 internal fn (current_cli_overrides, load_with_cli_overrides); called by 10 (load_latest_config_for_thread, sync_default_client_residency_requirement, queue_strict_refresh, maybe_refresh_plugin_caches_for_current_config, load_latest_config, load_latest_config, load_latest_config, load_latest_config, load_latest_config, load_latest_config); 1 external calls (default).


##### `ConfigManager::load_latest_config_for_thread`  (lines 151–164)

```
async fn load_latest_config_for_thread(
        &self,
        thread_config: &Config,
    ) -> std::io::Result<Config>
```

**Purpose**: Refreshes configuration for an existing conversation or session while preserving that session's own config layers. This keeps a running thread consistent but still picks up newer global settings.

**Data flow**: It takes an existing thread config, reloads the latest config using that thread's current working directory as a fallback, then asks the old thread config to rebuild itself while preserving session-specific layers. Finally it applies runtime feature switches and executable paths, and returns the refreshed config.

**Call relations**: Thread-aware flows such as refresh config building, experimental feature listing, and MCP server status listing call this. It builds on `load_latest_config` and then finishes with the same final adjustments used by other load paths.

*Call graph*: calls 3 internal fn (apply_arg0_paths, apply_runtime_feature_enablement, load_latest_config); called by 3 (build_refresh_config, experimental_feature_list_response, list_mcp_server_status); 1 external calls (rebuild_preserving_session_layers).


##### `ConfigManager::load_default_config`  (lines 166–185)

```
async fn load_default_config(&self) -> std::io::Result<Config>
```

**Purpose**: Loads a default Codex configuration for the manager's home directory and command-line overrides. It is useful when the server needs a baseline config outside a specific request.

**Data flow**: It asks the core config system to load defaults using the Codex home and current command-line overrides. If user config path or profile overrides are set, it updates the config layer stack so the selected user config path and profile are preserved. It then applies runtime feature switches and executable paths before returning the config.

**Call relations**: This is a higher-level default-loading path. It uses helpers such as `codex_home`, `current_cli_overrides`, `user_config_path`, `apply_runtime_feature_enablement`, and `apply_arg0_paths`.

*Call graph*: calls 5 internal fn (apply_arg0_paths, apply_runtime_feature_enablement, codex_home, current_cli_overrides, user_config_path); 4 external calls (clone, Table, load_default_with_cli_overrides_for_codex_home, new).


##### `ConfigManager::load_with_overrides`  (lines 187–199)

```
async fn load_with_overrides(
        &self,
        request_overrides: Option<HashMap<String, serde_json::Value>>,
        typesafe_overrides: ConfigOverrides,
    ) -> std::io::Result<Config>
```

**Purpose**: Loads config with temporary request-level overrides plus typed override values. This is for operations that need a one-off setting change without changing stored config.

**Data flow**: It reads current command-line overrides, receives optional JSON-style request overrides and structured `ConfigOverrides`, then forwards all of that to `load_with_cli_overrides` with no fallback working directory. The output is a fully built `Config` or an error.

**Call relations**: Session persistence and thread startup use this when they need to mix normal config with request-specific choices. The real merging and building happens in `load_with_cli_overrides`.

*Call graph*: calls 2 internal fn (current_cli_overrides, load_with_cli_overrides); called by 2 (persist_session, thread_start_task).


##### `ConfigManager::load_for_cwd`  (lines 201–214)

```
async fn load_for_cwd(
        &self,
        request_overrides: Option<HashMap<String, serde_json::Value>>,
        typesafe_overrides: ConfigOverrides,
        cwd: Option<PathBuf>,
    ) -> std::io
```

**Purpose**: Loads config as it should apply to a specific current working directory. This matters because project-local settings may depend on where the command or thread is running.

**Data flow**: It receives optional request overrides, typed overrides, and an optional directory. It combines them with the current command-line overrides and delegates to `load_with_cli_overrides`. The result reflects the chosen directory when config loading needs one.

**Call relations**: Command execution, hook listing, thread fork and resume, thread setting construction, and Windows sandbox setup call this when the current directory matters.

*Call graph*: calls 2 internal fn (current_cli_overrides, load_with_cli_overrides); called by 6 (hooks_list_response, exec_one_off_command_inner, thread_fork_inner, thread_resume_inner, build_thread_settings_overrides, windows_sandbox_setup_start_inner).


##### `ConfigManager::load_with_cli_overrides`  (lines 217–257)

```
async fn load_with_cli_overrides(
        &self,
        cli_overrides: &[(String, TomlValue)],
        request_overrides: Option<HashMap<String, serde_json::Value>>,
        mut typesafe_overrides: C
```

**Purpose**: Builds the full effective config from all active sources. This is the central assembly line for configuration in this file.

**Data flow**: It starts with command-line overrides and optional request overrides. A special request override, `bypass_hook_trust`, is checked to make sure it is a boolean and then moved into typed overrides. Other request override values are converted from JSON to TOML and merged with command-line overrides. The function then configures the core `ConfigBuilder` with home path, overrides, strict mode, fallback directory, cloud config, and thread loader. After the builder returns a config, it applies runtime feature switches and executable paths.

**Call relations**: `load_latest_config`, `load_with_overrides`, `load_for_cwd`, and thread startup all funnel into this function. It calls the helper readers for cloud and thread loaders, then uses `apply_runtime_feature_enablement` and `apply_arg0_paths` as final polishing steps.

*Call graph*: calls 4 internal fn (apply_arg0_paths, apply_runtime_feature_enablement, current_cloud_config_bundle, current_thread_config_loader); called by 4 (load_for_cwd, load_latest_config, load_with_overrides, thread_start_task); 3 external calls (clone, clone, default).


##### `ConfigManager::load_config_layers_for_cwd`  (lines 259–264)

```
async fn load_config_layers_for_cwd(
        &self,
        cwd: AbsolutePathBuf,
    ) -> std::io::Result<ConfigLayerStack>
```

**Purpose**: Loads the raw configuration layer stack for a particular directory. A layer stack is the ordered set of config sources, such as defaults, user settings, project settings, and managed settings.

**Data flow**: It receives an absolute current working directory and passes it to `load_config_layers` as the directory to consider. It returns the resulting `ConfigLayerStack` or an error.

**Call relations**: `resolve_cwd_config` calls this when it needs to inspect config layers for a directory. This is a thin convenience wrapper around `load_config_layers`.

*Call graph*: calls 1 internal fn (load_config_layers); called by 1 (resolve_cwd_config).


##### `ConfigManager::load_config_layers`  (lines 266–284)

```
async fn load_config_layers(
        &self,
        cwd: Option<AbsolutePathBuf>,
    ) -> std::io::Result<ConfigLayerStack>
```

**Purpose**: Loads the config layers without necessarily building the final `Config` object. This is useful for tools that need to see where settings came from, not just the final answer.

**Data flow**: It reads the current thread loader, command-line overrides, cloud config loader, loader override settings, and strict mode. It passes these plus the filesystem, Codex home, and optional directory into the lower-level layer loader. The output is a `ConfigLayerStack` describing the effective layered state.

**Call relations**: `load_config_layers_for_cwd` and permission-profile listing call this. It mirrors the same ingredients used by full config loading so layer inspection matches normal behavior.

*Call graph*: calls 4 internal fn (current_cli_overrides, current_cloud_config_bundle, current_thread_config_loader, load_config_layers_state); called by 2 (load_config_layers_for_cwd, permission_profile_list_response); 1 external calls (clone).


##### `ConfigManager::apply_runtime_feature_enablement`  (lines 286–288)

```
fn apply_runtime_feature_enablement(&self, config: &mut Config)
```

**Purpose**: Applies the manager's stored live feature switches to a config. It is the object-method wrapper around the standalone feature-application function.

**Data flow**: It reads the current runtime feature map from the manager, then passes the mutable config and that map to the standalone `apply_runtime_feature_enablement`. The config may have feature flags changed as a result.

**Call relations**: Full loading paths call this after config creation, including `load_default_config`, `load_latest_config_for_thread`, and `load_with_cli_overrides`. It bridges stored manager state to the pure helper function.

*Call graph*: calls 2 internal fn (current_runtime_feature_enablement, apply_runtime_feature_enablement); called by 3 (load_default_config, load_latest_config_for_thread, load_with_cli_overrides).


##### `ConfigManager::current_runtime_feature_enablement`  (lines 290–295)

```
fn current_runtime_feature_enablement(&self) -> BTreeMap<String, bool>
```

**Purpose**: Returns the current live feature switch map. These are runtime choices stored by feature-name and true-or-false value.

**Data flow**: It reads the shared runtime feature map and clones it. If the read lock fails, it returns an empty map so config loading can continue safely.

**Call relations**: Only `ConfigManager::apply_runtime_feature_enablement` calls this. It keeps the lock-reading detail separate from the feature-application logic.

*Call graph*: called by 1 (apply_runtime_feature_enablement).


##### `ConfigManager::apply_arg0_paths`  (lines 297–301)

```
fn apply_arg0_paths(&self, config: &mut Config)
```

**Purpose**: Copies executable paths discovered at process startup into the config. These paths tell Codex where to find its own executable and related sandbox or wrapper executables.

**Data flow**: It reads the stored `arg0_paths` from the manager and writes those path values into the mutable config. It returns nothing; the config is changed in place.

**Call relations**: Config-loading paths call this at the end of loading, including `load_default_config`, `load_latest_config_for_thread`, and `load_with_cli_overrides`. This makes sure the built config knows the actual executable paths used by this server process.

*Call graph*: called by 3 (load_default_config, load_latest_config_for_thread, load_with_cli_overrides).


##### `ConfigManager::new_for_tests`  (lines 304–319)

```
fn new_for_tests(
        codex_home: PathBuf,
        cli_overrides: Vec<(String, TomlValue)>,
        loader_overrides: LoaderOverrides,
        cloud_config_bundle: CloudConfigBundleLoader,
    ) -
```

**Purpose**: Creates a `ConfigManager` with simple defaults for tests. It avoids requiring production-only pieces such as strict config, real process dispatch paths, or a real thread config loader.

**Data flow**: Test code supplies a Codex home, command-line overrides, loader overrides, and a cloud config loader. The function fills in test-friendly defaults and calls the normal constructor. The result is a usable manager for unit and integration tests.

**Call relations**: Many config tests call this when they need a controlled manager. It keeps test setup short while still exercising the same main constructor as production code.

*Call graph*: called by 9 (invalid_user_value_rejected_even_if_overridden_by_managed, load_default_config_preserves_selected_user_config_path_after_load_error, read_includes_origins_and_layers, read_reports_managed_overrides_user_and_session_flags, write_value_defaults_to_selected_user_config_path, write_value_rejects_feature_requirement_conflict, write_value_reports_managed_override, write_value_reports_override, write_value_succeeds_when_managed_preferences_expand_home_directory_paths); 3 external calls (new, new, default).


##### `ConfigManager::without_managed_config_for_tests`  (lines 322–329)

```
fn without_managed_config_for_tests(codex_home: PathBuf) -> Self
```

**Purpose**: Creates a test `ConfigManager` that deliberately ignores managed configuration. Managed configuration means centrally supplied settings that can override local user choices.

**Data flow**: It receives a Codex home, creates empty command-line overrides, uses loader overrides that disable managed config for tests, and uses the default cloud config loader. It returns a test manager through `new_for_tests`.

**Call relations**: Config editing and validation tests call this when they need a clean local-only setup. It builds on `new_for_tests`, which then builds on the normal manager constructor.

*Call graph*: calls 2 internal fn (default, without_managed_config_for_tests); called by 12 (batch_write_rejects_legacy_profile_selector, clear_missing_nested_config_is_noop, reserved_builtin_provider_override_rejected, upsert_merges_tables_replace_overwrites, version_conflict_rejected, write_value_defaults_to_user_config_path, write_value_preserves_comments_and_order, write_value_rejects_legacy_profile_selector, write_value_rejects_legacy_profile_table, write_value_supports_custom_mcp_server_default_tool_approval_mode (+2 more)); 2 external calls (new_for_tests, new).


##### `protected_feature_keys`  (lines 332–349)

```
fn protected_feature_keys(config_layer_stack: &ConfigLayerStack) -> BTreeSet<String>
```

**Purpose**: Finds feature flags that runtime switches are not allowed to change. A feature is protected if it is already set in the effective config or appears in feature requirements.

**Data flow**: It reads the effective config layer stack and collects keys under the `features` table. It also reads feature requirements and adds any required feature names. The output is a sorted set of protected feature keys.

**Call relations**: The standalone `apply_runtime_feature_enablement` function calls this before applying live feature changes. This provides the guardrail that prevents runtime toggles from overriding config-controlled or requirement-controlled features.

*Call graph*: calls 2 internal fn (effective_config, requirements_toml); called by 1 (apply_runtime_feature_enablement).


##### `apply_runtime_feature_enablement`  (lines 351–371)

```
fn apply_runtime_feature_enablement(
    config: &mut Config,
    runtime_feature_enablement: &BTreeMap<String, bool>,
)
```

**Purpose**: Applies live feature toggles to a config, but only when doing so is allowed. It skips protected features and ignores unknown feature names.

**Data flow**: It receives a mutable config and a map of feature names to enabled-or-disabled values. It first computes protected feature names from the config layer stack. For each runtime entry, it skips protected names, looks up known feature definitions, and sets the feature state in the config. If setting a feature fails, it logs a warning and continues.

**Call relations**: The method `ConfigManager::apply_runtime_feature_enablement` calls this after loading config. This function contains the actual policy: runtime choices can adjust known, unprotected features but cannot override stronger config sources.

*Call graph*: calls 1 internal fn (protected_feature_keys); called by 1 (apply_runtime_feature_enablement); 2 external calls (feature_for_key, warn!).


### `config/src/project_root_markers.rs`

`config` · `config load`

Many tools need to know where a project begins. For example, if you open a file deep inside a folder tree, the tool may walk upward until it finds a marker like `.git`, much like finding the front door of a building by following hallway signs. This file supplies the default marker and reads any custom markers from configuration.

The main setting is `project_root_markers`. If the user does not set it, this file says “no custom choice was made,” so the wider configuration code can fall back to the default. If the user sets it to an array of strings, those strings become the markers to search for. An empty array is meaningful: it says root detection should be disabled. If the setting exists but is not an array of strings, the file returns an input error instead of guessing, because a wrong root can make the rest of the tool behave in confusing ways.

The default is simple: `.git`. That means, unless told otherwise, the project root is found by looking for a Git repository folder.

#### Function details

##### `project_root_markers_from_config`  (lines 16–43)

```
fn project_root_markers_from_config(config: &TomlValue) -> io::Result<Option<Vec<String>>>
```

**Purpose**: This function reads the `project_root_markers` entry from an already-merged TOML configuration value. It returns either no custom setting, a list of marker names, an explicit empty list meaning “turn this feature off,” or an error if the setting is written incorrectly.

**Data flow**: It receives a TOML value, which is the parsed configuration data. First it checks whether that value is a table, then looks for `project_root_markers`. If the entry is missing, it returns `None`. If the entry is present, it must be an array; each item in that array must be a string. Valid strings are copied into a new list and returned as `Some(list)`. If the shape is wrong, it returns an invalid-data error explaining that the setting must be an array of strings.

**Call relations**: During configuration loading, `load_config_layers_state` calls this function after the configuration layers have been combined. This function does the focused checking and extraction for this one setting, then hands back either the markers or a clear error so the larger loader can continue or stop safely.

*Call graph*: called by 1 (load_config_layers_state); 3 external calls (as_table, new, new).


##### `default_project_root_markers`  (lines 45–50)

```
fn default_project_root_markers() -> Vec<String>
```

**Purpose**: This function provides the built-in project root markers used when the user has not chosen their own. Currently it returns `.git`, so Git repositories are recognized as project roots by default.

**Data flow**: It reads the file’s constant default marker list, converts each borrowed text value into an owned string, and returns those strings in a vector. It does not read files, inspect the current directory, or change any state.

**Call relations**: This function is the fallback source for root markers when configuration does not provide `project_root_markers`. It keeps the default choice in one place, separate from the code that reads user-provided settings.


### `core/src/config/mod.rs`

`config` · `config load and startup, with some helpers used during runtime reconfiguration`

This is the main configuration assembly room for Codex. Many parts of Codex need answers to practical questions: Which model should be used? What files may tools read or write? Should commands ask for approval? Which MCP servers and plugins are available? Where should logs, history, and state be stored? This file gathers those answers from several places and makes them consistent.

The important idea is layering. Codex can receive settings from defaults, user config files, project config files, session flags, cloud-managed requirements, and test or harness overrides. This file merges those layers, checks that required safety rules are obeyed, and falls back with warnings when allowed. It is like a building inspector: the user may choose a layout, but managed requirements can still say certain doors must stay locked.

The file also bridges old and new permission systems. Older settings such as `sandbox_mode` are converted into newer permission profiles, while named profiles are resolved into concrete file and network rules. It also builds supporting config for model management, plugin loading, MCP tool servers, web search, multi-agent behavior, terminal UI preferences, telemetry, auth storage, and project trust. Without this file, each subsystem would interpret raw TOML differently, safety requirements could be skipped, and startup would not have one trustworthy source of truth.

#### Function details

##### `GhostSnapshotConfig::default`  (lines 182–188)

```
fn default() -> Self
```

**Purpose**: Provides safe legacy defaults for the old `ghost_snapshot` settings. The snapshot feature no longer produces snapshots, but old config files can still mention these keys without breaking startup.

**Data flow**: No input is needed. It creates a `GhostSnapshotConfig` with default thresholds for large untracked files and directories, and warnings enabled. The result is used as a compatibility value.

**Call relations**: During full config construction, the loader starts from this default and then applies any old `ghost_snapshot` values it finds. Tests and default config construction also rely on it so legacy settings remain harmless.

*Call graph*: called by 2 (load_config_with_layer_stack, new_config).


##### `default_multi_agent_v2_usage_hint_text`  (lines 250–254)

```
fn default_multi_agent_v2_usage_hint_text(usage_hint_text: &str, max_concurrency: usize) -> String
```

**Purpose**: Builds the default instruction text shown to agents when multi-agent v2 is enabled. It explains how agents should collaborate and how many concurrent agent slots are available.

**Data flow**: It receives a role-specific hint and a maximum concurrency number. It combines them with shared collaboration guidance and returns one final instruction string.

**Call relations**: The multi-agent default builder calls this when it creates root-agent and sub-agent guidance. That keeps the repeated collaboration rules in one place.

*Call graph*: called by 1 (defaults_for_max_concurrency); 1 external calls (format!).


##### `resolve_sqlite_home_env`  (lines 266–278)

```
fn resolve_sqlite_home_env(resolved_cwd: &Path) -> Option<PathBuf>
```

**Purpose**: Interprets the environment variable that can move Codex's SQLite state directory. SQLite is the local database storage used for some state.

**Data flow**: It reads the environment variable, trims whitespace, ignores it if empty, and turns it into a path. Relative paths are resolved against the current working directory; absolute paths are used as-is.

**Call relations**: The main config loader uses this as one possible source for `sqlite_home`, after explicit config and before falling back to the Codex home directory.

*Call graph*: 3 external calls (join, from, var).


##### `resolve_cli_auth_credentials_store_mode`  (lines 280–291)

```
fn resolve_cli_auth_credentials_store_mode(
    configured: AuthCredentialsStoreMode,
    package_version: &str,
) -> AuthCredentialsStoreMode
```

**Purpose**: Chooses where CLI login credentials should be stored, with a special fallback for local development builds. Local dev builds avoid keyring storage when the setting is `auto` or `keyring`.

**Data flow**: It receives the configured credential storage mode and package version. If this is the local development version and the mode would use a keyring, it returns file storage; otherwise it returns the configured mode.

**Call relations**: The main config loader calls this before placing the auth storage choice into `Config`, so auth code later receives the resolved behavior rather than raw user input.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_mcp_oauth_credentials_store_mode`  (lines 293–304)

```
fn resolve_mcp_oauth_credentials_store_mode(
    configured: OAuthCredentialsStoreMode,
    package_version: &str,
) -> OAuthCredentialsStoreMode
```

**Purpose**: Chooses where MCP OAuth credentials should be stored, with the same local-development safety fallback as CLI credentials.

**Data flow**: It receives the configured MCP OAuth storage mode and package version. For local development builds, keyring-like choices become file storage; all other cases keep the original mode.

**Call relations**: The main config loader calls this while building the MCP-related fields of `Config`, and later MCP setup uses the resolved choice.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `test_config`  (lines 307–316)

```
async fn test_config() -> Config
```

**Purpose**: Creates a default `Config` in a temporary Codex home for tests. It gives tests a clean, isolated configuration without using the real user's files.

**Data flow**: It creates a temporary directory, loads default TOML with default overrides, and returns a ready `Config`. If setup fails, the test fails immediately.

**Call relations**: Many tests call this when they need a realistic but isolated configuration. Internally it uses the same lower-level loading path as production, minus managed requirements enforcement for convenience.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 32 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent, guardian_review_session_compact_scope_change_invalidates_cached_session, guardian_review_session_config_change_invalidates_cached_session, guardian_review_session_config_disables_hooks, guardian_review_session_config_disables_skill_instructions, guardian_review_session_config_allows_pinned_disabled_feature, guardian_review_session_config_clears_legacy_notify, guardian_review_session_config_clears_parent_developer_instructions, guardian_review_session_config_disables_mcp_apps_plugins_and_memories (+15 more)); 4 external calls (load_from_base_config_with_overrides, default, default, tempdir).


##### `Permissions::from_approval_and_profile`  (lines 352–368)

```
fn from_approval_and_profile(
        approval_policy: Constrained<AskForApproval>,
        permission_profile: Constrained<PermissionProfile>,
    ) -> ConstraintResult<Self>
```

**Purpose**: Builds a minimal `Permissions` object from an approval policy and permission profile. This is useful when code needs permissions without loading a full config file.

**Data flow**: It takes constrained approval and permission values, converts the permission profile into internal state, and fills the remaining permission fields with safe defaults. It returns either a complete `Permissions` value or a constraint error.

**Call relations**: Tests and helper config constructors use this to create permission settings directly. It delegates profile-state creation to the resolved permission-profile module.

*Call graph*: calls 2 internal fn (from_constrained_legacy, default); called by 3 (permission_snapshot_setter_preserves_permission_constraints, new_config, debug_config_output_filters_sandbox_modes_blocked_by_deny_read_requirements); 1 external calls (new).


##### `Permissions::permission_profile_state`  (lines 370–372)

```
fn permission_profile_state(&self) -> &PermissionProfileState
```

**Purpose**: Gives internal code read-only access to the stored permission profile state. The state includes both the profile and metadata about how it was selected.

**Data flow**: It reads the `Permissions` object and returns a reference to its internal profile state. Nothing is changed.

**Call relations**: This is a small accessor used by nearby modules that need the richer state, not just the simplified permission profile.


##### `Permissions::set_permission_profile_state`  (lines 374–379)

```
fn set_permission_profile_state(
        &mut self,
        permission_profile_state: PermissionProfileState,
    )
```

**Purpose**: Replaces the internal permission profile state. This is used when another part of the system has already resolved and validated a new state.

**Data flow**: It receives a new `PermissionProfileState` and stores it inside `Permissions`. It does not return a value.

**Call relations**: Permission update code calls this after resolving a profile elsewhere, so the `Permissions` object stays in sync with the chosen profile.

*Call graph*: called by 1 (apply_permission_profile_to_permissions).


##### `Permissions::set_permission_profile_from_session_snapshot`  (lines 386–392)

```
fn set_permission_profile_from_session_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies a permission snapshot that came from an existing session. A snapshot is a trusted record of the permissions that core session state already chose.

**Data flow**: It receives a snapshot, asks the internal state to accept it, and returns success or a constraint error. The permission state may be updated.

**Call relations**: Clients that mirror session state use this bridge instead of resolving named profiles themselves. It hands the actual validation to `PermissionProfileState`.

*Call graph*: calls 1 internal fn (set_permission_profile_snapshot).


##### `Permissions::replace_permission_profile_from_session_snapshot`  (lines 397–407)

```
fn replace_permission_profile_from_session_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Forcefully replaces local permission constraints with a trusted session snapshot. This is for clients that must mirror core state even if their local config would reject it.

**Data flow**: It receives a session snapshot, wraps its profile as the only allowed value, converts the snapshot into resolved profile data, and replaces the internal state. It returns success or a constraint error.

**Call relations**: This is a stronger version of the snapshot setter. It is used when preserving session truth matters more than local config constraints.

*Call graph*: calls 4 internal fn (allow_only, into_resolved_permission_profile, permission_profile, from_constrained_resolved).


##### `Permissions::permission_profile`  (lines 411–413)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: Returns the canonical permission profile before runtime workspace roots are expanded. The canonical profile is the source version stored by config.

**Data flow**: It reads the internal profile state and returns a reference to the current profile. It does not modify anything.

**Call relations**: Several permission projections call this before deriving file-system, network, or materialized runtime views.

*Call graph*: calls 1 internal fn (permission_profile); called by 2 (materialized_permission_profile, network_sandbox_policy).


##### `Permissions::can_set_permission_profile`  (lines 415–421)

```
fn can_set_permission_profile(
        &self,
        permission_profile: &PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Checks whether a proposed permission profile is allowed by the current constraints. It answers the question before actually changing permissions.

**Data flow**: It receives a profile candidate, compares it against the internal constraints, and returns success or a constraint error. No state changes.

**Call relations**: Callers that let users or sessions change sandbox behavior use this as a guard before applying the profile.

*Call graph*: calls 1 internal fn (can_set_legacy_permission_profile); called by 1 (sandbox_mode_is_allowed_by_permissions).


##### `Permissions::set_workspace_roots`  (lines 423–425)

```
fn set_workspace_roots(&mut self, workspace_roots: Vec<AbsolutePathBuf>)
```

**Purpose**: Sets the runtime workspace roots used by permission profiles. Workspace roots are the directories treated as the active working area for the session.

**Data flow**: It receives a list of absolute paths and stores it. Future permission calculations will use these roots.

**Call relations**: Runtime setup or session updates can call this when the active workspace changes.


##### `Permissions::workspace_roots`  (lines 427–429)

```
fn workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the runtime workspace roots currently stored in permissions.

**Data flow**: It reads the list of roots and returns it as a slice. Nothing is changed.

**Call relations**: The higher-level `Config::set_legacy_sandbox_policy` uses this after updating permissions so the top-level config mirrors the permission state.

*Call graph*: called by 1 (set_legacy_sandbox_policy).


##### `Permissions::user_visible_workspace_roots`  (lines 433–435)

```
fn user_visible_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns workspace roots that came from user-facing config or runtime selection. It intentionally excludes internal Codex-only helper paths.

**Data flow**: It reads the stored workspace roots and returns them directly. No data is transformed.

**Call relations**: UI or reporting code can use this when it should show only roots meaningful to the user.


##### `Permissions::profile_workspace_roots`  (lines 437–439)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns workspace roots that are defined by the active permission profile itself. These are separate from runtime roots such as the current directory.

**Data flow**: It asks the internal permission profile state for its profile-level roots and returns them. Nothing is changed.

**Call relations**: Top-level config combines these with runtime roots when computing the full effective workspace root list.

*Call graph*: calls 1 internal fn (profile_workspace_roots); called by 1 (effective_workspace_roots).


##### `Permissions::materialized_permission_profile`  (lines 441–445)

```
fn materialized_permission_profile(&self) -> PermissionProfile
```

**Purpose**: Creates the actual runtime permission profile by replacing symbolic workspace-root markers with concrete directories.

**Data flow**: It clones the stored canonical profile, applies the current workspace root list, and returns a concrete profile. The stored profile is not changed.

**Call relations**: Permission projections for file-system sandboxing and legacy sandbox compatibility use this because tools need real paths, not symbols.

*Call graph*: calls 1 internal fn (permission_profile); called by 3 (effective_permission_profile, file_system_sandbox_policy, legacy_sandbox_policy).


##### `Permissions::effective_permission_profile`  (lines 449–451)

```
fn effective_permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the permission profile that should be enforced at runtime. It includes runtime workspace-root expansion.

**Data flow**: It reads the stored profile and workspace roots, materializes them, and returns the resulting profile.

**Call relations**: Runtime tool execution can use this when it needs the complete current permission picture.

*Call graph*: calls 1 internal fn (materialized_permission_profile).


##### `Permissions::active_permission_profile`  (lines 454–456)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Reports the named permission profile currently selected, if there is one. Some permissions may come from an anonymous or legacy profile, so this can be absent.

**Data flow**: It asks the profile state for active profile metadata and returns it as an optional value. Nothing changes.

**Call relations**: Session configuration and UI code use this to show or preserve the selected named profile.

*Call graph*: calls 1 internal fn (active_permission_profile).


##### `Permissions::file_system_sandbox_policy`  (lines 459–462)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Derives the file access rules that spawned tools should follow. A sandbox policy is the rule set that limits reads and writes.

**Data flow**: It materializes the permission profile and converts it into a file-system sandbox policy. The result describes allowed and denied paths.

**Call relations**: Tool execution and sandbox setup use this projection because they need concrete file rules.

*Call graph*: calls 1 internal fn (materialized_permission_profile).


##### `Permissions::network_sandbox_policy`  (lines 465–467)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Derives the network access rules from the current permission profile. This says whether network access is enabled, disabled, or controlled.

**Data flow**: It reads the canonical profile and returns its network policy. Workspace roots are not relevant here.

**Call relations**: Network proxy setup and runtime permission checks use this when deciding how external traffic should be treated.

*Call graph*: calls 1 internal fn (permission_profile).


##### `Permissions::legacy_sandbox_policy`  (lines 470–473)

```
fn legacy_sandbox_policy(&self, cwd: &Path) -> SandboxPolicy
```

**Purpose**: Converts modern permission profiles into the older `SandboxPolicy` shape. This keeps older code paths working while newer profile logic remains the source of truth.

**Data flow**: It materializes the permission profile using the current roots, then converts it into a legacy sandbox policy for a given current directory.

**Call relations**: The top-level `Config::legacy_sandbox_policy` calls this for consumers that still expect legacy sandbox settings.

*Call graph*: calls 1 internal fn (materialized_permission_profile); called by 1 (legacy_sandbox_policy); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `Permissions::can_set_legacy_sandbox_policy`  (lines 477–492)

```
fn can_set_legacy_sandbox_policy(
        &self,
        sandbox_policy: &SandboxPolicy,
        cwd: &Path,
    ) -> ConstraintResult<()>
```

**Purpose**: Checks whether an old-style sandbox policy can be accepted under the current permission constraints.

**Data flow**: It receives a legacy sandbox policy and current directory, converts that policy into the modern permission profile form, and checks constraints. It returns success or a constraint error without changing state.

**Call relations**: The setter for legacy sandbox policies calls this first, so invalid changes are rejected before any permission fields are updated.

*Call graph*: calls 5 internal fn (can_set_legacy_permission_profile, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 1 (set_legacy_sandbox_policy).


##### `Permissions::set_legacy_sandbox_policy`  (lines 496–534)

```
fn set_legacy_sandbox_policy(
        &mut self,
        sandbox_policy: SandboxPolicy,
        cwd: &Path,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies an old-style sandbox policy while keeping the modern permission profile state consistent.

**Data flow**: It validates the legacy policy, converts it into file, network, and modern permission profile forms, updates workspace roots based on the policy, and stores the profile. It returns success or a constraint error.

**Call relations**: Top-level config calls this when legacy sandbox settings are changed, and this method performs the actual permission-state update.

*Call graph*: calls 6 internal fn (can_set_legacy_sandbox_policy, set_legacy_permission_profile, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 1 (set_legacy_sandbox_policy); 1 external calls (vec!).


##### `Permissions::set_permission_profile`  (lines 537–543)

```
fn set_permission_profile(
        &mut self,
        permission_profile: PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Sets the current permission profile directly using the modern profile format.

**Data flow**: It receives a permission profile and asks the internal state to store it if constraints allow. It returns success or a constraint error.

**Call relations**: Code that already works with modern profiles can call this without going through legacy sandbox conversion.

*Call graph*: calls 1 internal fn (set_legacy_permission_profile).


##### `profile_allows_configured_network_proxy`  (lines 549–556)

```
fn profile_allows_configured_network_proxy(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Decides whether a permission profile is allowed to inherit configured network proxy behavior. Disabled permissions mean Codex is not controlling the network sandbox, so adding a managed proxy would unexpectedly narrow access.

**Data flow**: It receives a permission profile and returns true only for managed or external profiles whose network policy is enabled. Disabled profiles return false.

**Call relations**: The main config loader and active-profile network proxy recalculation use this before applying proxy allowlists.

*Call graph*: called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `build_network_proxy_spec`  (lines 558–589)

```
fn build_network_proxy_spec(
    configured_network_proxy_config: NetworkProxyConfig,
    network_requirements: Option<Sourced<codex_config::NetworkConstraints>>,
    permission_profile: &PermissionPr
```

**Purpose**: Builds the final managed network proxy plan from user config, managed requirements, and the active permission profile.

**Data flow**: It receives proxy config, optional network requirements, and a permission profile. It combines them into a `NetworkProxySpec`, wraps errors with requirement-source context when useful, and returns either no proxy or a proxy spec.

**Call relations**: Full config loading and runtime profile switching call this after deciding which network settings are eligible.

*Call graph*: calls 1 internal fn (from_config_and_constraints); called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `MultiAgentV2Config::defaults_for_max_concurrency`  (lines 1079–1099)

```
fn defaults_for_max_concurrency(max_concurrent_threads_per_session: usize) -> Self
```

**Purpose**: Creates default settings for multi-agent v2 based on how many agents may run at once.

**Data flow**: It receives a concurrency limit and fills timeout values, instruction text, namespace behavior, and display flags. It returns a complete multi-agent v2 config.

**Call relations**: The resolver for multi-agent v2 config uses this as the base before applying user-specified overrides.

*Call graph*: calls 1 internal fn (default_multi_agent_v2_usage_hint_text); called by 1 (resolve_multi_agent_v2_config).


##### `MultiAgentV2Config::default`  (lines 1103–1107)

```
fn default() -> Self
```

**Purpose**: Provides the standard multi-agent v2 defaults. It uses the built-in concurrency limit.

**Data flow**: It has no input. It calls the concurrency-aware default builder and returns the resulting config.

**Call relations**: Default config construction uses this when no custom multi-agent v2 settings are supplied.

*Call graph*: called by 1 (new_config); 1 external calls (defaults_for_max_concurrency).


##### `Config::codex_home`  (lines 1127–1129)

```
fn codex_home(&self) -> PathBuf
```

**Purpose**: Returns the Codex home directory for authentication code. Codex home is where user-level Codex state and config live.

**Data flow**: It reads `self.codex_home`, clones it into a normal path buffer, and returns it.

**Call relations**: This is part of the `AuthManagerConfig` interface, letting login code use `Config` without knowing all of its fields.

*Call graph*: calls 1 internal fn (to_path_buf).


##### `Config::cli_auth_credentials_store_mode`  (lines 1131–1133)

```
fn cli_auth_credentials_store_mode(&self) -> AuthCredentialsStoreMode
```

**Purpose**: Returns the resolved storage mode for CLI authentication credentials.

**Data flow**: It reads the config field and returns the enum value. Nothing is changed.

**Call relations**: Auth management code calls this through the `AuthManagerConfig` interface when deciding whether to use a file, keyring, or automatic choice.


##### `Config::auth_keyring_backend_kind`  (lines 1135–1137)

```
fn auth_keyring_backend_kind(&self) -> AuthKeyringBackendKind
```

**Purpose**: Returns which operating-system keyring backend should be used for credentials. A keyring is the OS secure credential store.

**Data flow**: It delegates to the config's keyring resolution helper and returns the backend kind.

**Call relations**: MCP config creation calls this so OAuth setup can use the same keyring decision as the rest of auth.

*Call graph*: called by 1 (to_mcp_config_with_plugin_registrations); 1 external calls (auth_keyring_backend_kind).


##### `Config::forced_chatgpt_workspace_id`  (lines 1139–1141)

```
fn forced_chatgpt_workspace_id(&self) -> Option<Vec<String>>
```

**Purpose**: Returns any configured restriction on which ChatGPT workspaces may be used.

**Data flow**: It clones the optional workspace ID list from config and returns it.

**Call relations**: Authentication code reads this through the `AuthManagerConfig` interface to enforce login restrictions.


##### `Config::chatgpt_base_url`  (lines 1143–1145)

```
fn chatgpt_base_url(&self) -> String
```

**Purpose**: Returns the base URL used for ChatGPT backend requests.

**Data flow**: It clones the configured URL string and returns it.

**Call relations**: Auth and MCP-related code call this through shared configuration interfaces.


##### `ConfigBuilder::codex_home`  (lines 1161–1164)

```
fn codex_home(mut self, codex_home: PathBuf) -> Self
```

**Purpose**: Sets the Codex home directory on a config builder.

**Data flow**: It receives a path, stores it in the builder, and returns the builder so calls can be chained.

**Call relations**: Callers use this before `build` when they want to load config from a specific home directory instead of the default.


##### `ConfigBuilder::cli_overrides`  (lines 1166–1169)

```
fn cli_overrides(mut self, cli_overrides: Vec<(String, TomlValue)>) -> Self
```

**Purpose**: Sets command-line override values on a config builder.

**Data flow**: It receives key-value override pairs, stores them, and returns the builder for chaining.

**Call relations**: Startup paths use this so flags can override values from config files.


##### `ConfigBuilder::harness_overrides`  (lines 1171–1174)

```
fn harness_overrides(mut self, harness_overrides: ConfigOverrides) -> Self
```

**Purpose**: Sets runtime-only overrides that do not come from normal TOML config. Examples include current directory and executable paths.

**Data flow**: It receives a `ConfigOverrides` value, stores it, and returns the builder.

**Call relations**: CLI subcommands and tests use this to force behavior for a particular run.


##### `ConfigBuilder::loader_overrides`  (lines 1176–1179)

```
fn loader_overrides(mut self, loader_overrides: LoaderOverrides) -> Self
```

**Purpose**: Sets overrides for the lower-level config layer loader.

**Data flow**: It receives loader options, stores them, and returns the builder.

**Call relations**: Tests and profile-loading paths use this when they need to skip or alter managed config loading.


##### `ConfigBuilder::strict_config`  (lines 1181–1184)

```
fn strict_config(mut self, strict_config: bool) -> Self
```

**Purpose**: Controls whether config loading should be strict about errors and unknowns.

**Data flow**: It receives a boolean, stores it, and returns the builder.

**Call relations**: Startup can enable this when it wants invalid config to fail early rather than be tolerated.


##### `ConfigBuilder::cloud_config_bundle`  (lines 1186–1189)

```
fn cloud_config_bundle(mut self, cloud_config_bundle: CloudConfigBundleLoader) -> Self
```

**Purpose**: Supplies cloud-managed config data to the builder.

**Data flow**: It receives a cloud bundle loader, stores it, and returns the builder.

**Call relations**: Managed or enterprise-style configuration flows use this before building the final config.


##### `ConfigBuilder::thread_config_loader`  (lines 1191–1197)

```
fn thread_config_loader(
        mut self,
        thread_config_loader: Arc<dyn ThreadConfigLoader>,
    ) -> Self
```

**Purpose**: Supplies a loader for thread-scoped configuration. Thread-scoped config is config tied to a specific conversation or session thread.

**Data flow**: It receives a shared loader object, stores it, and returns the builder.

**Call relations**: App-server or session-aware startup code can use this so thread settings participate in the same layer merge.


##### `ConfigBuilder::fallback_cwd`  (lines 1199–1202)

```
fn fallback_cwd(mut self, fallback_cwd: Option<PathBuf>) -> Self
```

**Purpose**: Sets a fallback current working directory for config loading.

**Data flow**: It receives an optional path, stores it, and returns the builder.

**Call relations**: Builder startup uses this if harness overrides did not already provide a current directory.


##### `ConfigBuilder::build`  (lines 1204–1207)

```
async fn build(self) -> std::io::Result<Config>
```

**Purpose**: Starts building the final `Config`. It boxes the work so the large async load process does not use too much stack space.

**Data flow**: It consumes the builder, runs the inner build future, and returns either a complete config or an I/O error.

**Call relations**: Runtime startup helpers call this after setting builder options. It hands all real work to `build_inner`.

*Call graph*: calls 1 internal fn (build_inner); called by 1 (build_config_on_runtime_worker); 1 external calls (pin).


##### `ConfigBuilder::build_inner`  (lines 1209–1316)

```
async fn build_inner(self) -> std::io::Result<Config>
```

**Purpose**: Performs the full builder-based config loading flow. It finds paths, loads config layers, handles config lock replay, and constructs the final `Config`.

**Data flow**: It consumes builder fields, resolves Codex home and current directory, loads and merges config layers, deserializes the merged TOML, optionally replaces it with a config lock, and returns a final config.

**Call relations**: `build` calls this. It delegates raw layer loading to `codex_config`, then delegates final interpretation to `Config::load_config_with_layer_stack`.

*Call graph*: calls 9 internal fn (load_config_layers_state, new, find_codex_home, config_without_lock_controls, lock_layer_from_config, read_config_lock_from_path, current_dir, from_absolute_path, relative_to_current_dir); called by 1 (build); 5 external calls (new, load_config_with_layer_stack, new, io_error_from_config_error, vec!).


##### `ConfigBuilder::without_managed_config_for_tests`  (lines 1319–1321)

```
fn without_managed_config_for_tests() -> Self
```

**Purpose**: Creates a builder preset that skips managed configuration for tests.

**Data flow**: It starts with a default builder, applies test loader overrides, and returns the builder.

**Call relations**: Tests call this when they need predictable local config behavior without cloud or managed requirements.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 58 (test_config_with_cli_overrides, inline_instructions_set_base_instructions, active_profile_is_cleared_when_requirements_force_fallback, agent_role_file_metadata_overrides_config_toml_metadata, agent_role_file_name_takes_precedence_over_config_key, agent_role_file_without_developer_instructions_is_dropped_with_warning, agent_role_relative_config_file_resolves_against_config_toml, agent_role_without_description_after_merge_is_dropped_with_warning, approvals_reviewer_can_be_set_in_config_without_guardian_approval, approvals_reviewer_defaults_to_manual_only_without_guardian_feature (+15 more)); 1 external calls (default).


##### `Config::multi_agent_version_from_features`  (lines 1325–1333)

```
fn multi_agent_version_from_features(&self) -> MultiAgentVersion
```

**Purpose**: Decides which multi-agent system version is active based on feature flags.

**Data flow**: It reads enabled features and returns v2, v1, or disabled. V2 takes priority over the older collaboration feature.

**Call relations**: Session and agent orchestration code can use this after config load to choose the correct agent tool surface.

*Call graph*: 1 external calls (enabled).


##### `Config::validate_multi_agent_v2_config`  (lines 1335–1344)

```
fn validate_multi_agent_v2_config(&self) -> std::io::Result<()>
```

**Purpose**: Rejects an incompatible setting combination for multi-agent v2. The older `agents.max_threads` setting cannot be used with v2.

**Data flow**: It reads feature flags and `agent_max_threads`. If v2 is enabled and the old setting is present, it returns an invalid-input error; otherwise it succeeds.

**Call relations**: Runtime setup can call this after loading config to catch conflicting agent settings before work begins.

*Call graph*: 2 external calls (new, enabled).


##### `Config::effective_agent_max_threads`  (lines 1346–1360)

```
fn effective_agent_max_threads(
        &self,
        multi_agent_version: MultiAgentVersion,
    ) -> Option<usize>
```

**Purpose**: Calculates how many child agent threads may be used for the active multi-agent mode.

**Data flow**: It receives the selected multi-agent version. For v2 it uses the v2 concurrency limit minus the root agent; for older or disabled modes it uses the old agent limit or default.

**Call relations**: Agent orchestration uses this to enforce thread limits consistently across old and new multi-agent modes.


##### `Config::legacy_sandbox_policy`  (lines 1362–1364)

```
fn legacy_sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Returns the current permissions in the old sandbox-policy format.

**Data flow**: It reads the config current directory and delegates to `Permissions::legacy_sandbox_policy`. The output is a legacy sandbox policy.

**Call relations**: Older callers that still speak `SandboxPolicy` use this instead of reading modern permission profiles directly.

*Call graph*: calls 2 internal fn (legacy_sandbox_policy, as_path).


##### `Config::set_legacy_sandbox_policy`  (lines 1366–1378)

```
fn set_legacy_sandbox_policy(
        &mut self,
        sandbox_policy: SandboxPolicy,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies an old-style sandbox policy to the whole config and keeps workspace root fields synchronized.

**Data flow**: It receives a legacy policy, marks whether workspace roots were explicitly set, asks `Permissions` to apply it, then copies the updated roots back to the top-level config.

**Call relations**: Legacy sandbox-changing code calls this higher-level wrapper so both `Config` and `Permissions` stay aligned.

*Call graph*: calls 3 internal fn (set_legacy_sandbox_policy, workspace_roots, as_path); 1 external calls (matches!).


##### `Config::effective_workspace_roots`  (lines 1380–1385)

```
fn effective_workspace_roots(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the full set of workspace roots that should matter at runtime.

**Data flow**: It starts with top-level runtime roots, appends roots supplied by the active permission profile, removes duplicates, and returns the combined list.

**Call relations**: Runtime and UI code use this when they need the complete workspace view rather than just one source of roots.

*Call graph*: calls 2 internal fn (profile_workspace_roots, dedupe_absolute_paths).


##### `Config::to_models_manager_config`  (lines 1387–1397)

```
fn to_models_manager_config(&self) -> ModelsManagerConfig
```

**Purpose**: Extracts the part of `Config` needed by the model manager. The model manager controls model catalog and context-window behavior.

**Data flow**: It reads model-related limits, instructions, personality feature state, and catalog overrides, then returns a smaller `ModelsManagerConfig`.

**Call relations**: Model-management code calls this instead of depending on the entire large `Config` type.

*Call graph*: 1 external calls (enabled).


##### `Config::plugins_config_input`  (lines 1400–1407)

```
fn plugins_config_input(&self) -> PluginsConfigInput
```

**Purpose**: Builds the input object used to decide which plugins are available.

**Data flow**: It reads the config layer stack, plugin feature flags, remote-plugin feature flag, and ChatGPT base URL. It returns a `PluginsConfigInput`.

**Call relations**: MCP config construction calls this before asking the plugin manager for active plugins.

*Call graph*: calls 1 internal fn (new); called by 1 (to_mcp_config_with_plugin_registrations); 2 external calls (clone, enabled).


##### `Config::apply_plugin_mcp_server_requirements`  (lines 1410–1427)

```
fn apply_plugin_mcp_server_requirements(
        &self,
        plugin_id: &str,
        mcp_servers: &mut HashMap<String, McpServerConfig>,
    )
```

**Purpose**: Applies managed allowlists to MCP servers supplied by a plugin. MCP servers provide external tools using the Model Context Protocol.

**Data flow**: It receives a plugin ID and mutable server map. It disables plugin servers that do not match plugin requirements and also handles the special case of an empty global MCP allowlist.

**Call relations**: When building MCP config, each active plugin's servers pass through this filter before registration.

*Call graph*: calls 3 internal fn (requirements, filter_mcp_servers_by_requirements, filter_plugin_mcp_servers_by_requirements); called by 1 (to_mcp_config_with_plugin_registrations).


##### `Config::to_mcp_config`  (lines 1429–1438)

```
async fn to_mcp_config(
        &self,
        plugins_manager: &codex_core_plugins::PluginsManager,
    ) -> McpConfig
```

**Purpose**: Builds the MCP runtime config using the normal plugin registrations.

**Data flow**: It receives a plugin manager, calls the more general MCP builder with no extra registrations, and returns an `McpConfig`.

**Call relations**: MCP startup code calls this common path. It delegates the detailed catalog construction to `to_mcp_config_with_plugin_registrations`.

*Call graph*: calls 1 internal fn (to_mcp_config_with_plugin_registrations).


##### `Config::to_mcp_config_with_plugin_registrations`  (lines 1440–1508)

```
async fn to_mcp_config_with_plugin_registrations(
        &self,
        plugins_manager: &codex_core_plugins::PluginsManager,
        additional_plugin_registrations: impl IntoIterator<Item = McpServ
```

**Purpose**: Builds the full MCP configuration, including plugin-provided servers, extra registrations, configured servers, auth settings, sandbox settings, and capabilities.

**Data flow**: It asks the plugin manager for plugins allowed by config, filters their MCP servers, registers plugin and extra servers, then registers user-configured servers. It returns an `McpConfig` with all connection and capability details.

**Call relations**: `to_mcp_config` calls this for the standard path. Tests or advanced flows can pass extra server registrations through this lower-level method.

*Call graph*: calls 11 internal fn (new, from_config, from_plugin, builder, get, plugins_for_config, apply_plugin_mcp_server_requirements, auth_keyring_backend_kind, plugins_config_input, prefix_mcp_tool_names (+1 more)); called by 1 (to_mcp_config); 5 external calls (default, default, default, enabled, use_legacy_landlock).


##### `Config::prefix_mcp_tool_names`  (lines 1510–1512)

```
fn prefix_mcp_tool_names(&self) -> bool
```

**Purpose**: Decides whether MCP tool names should be prefixed to avoid name collisions.

**Data flow**: It reads the `NonPrefixedMcpToolNames` feature flag and returns false only when that feature is enabled.

**Call relations**: MCP config construction uses this to choose how tool names are exposed to the model.

*Call graph*: called by 1 (to_mcp_config_with_plugin_registrations); 1 external calls (enabled).


##### `Config::rebuild_preserving_session_layers`  (lines 1514–1575)

```
async fn rebuild_preserving_session_layers(
        &self,
        refreshed_config: &Config,
    ) -> std::io::Result<Self>
```

**Purpose**: Rebuilds config from refreshed files while keeping session-specific layers from the existing config. This is useful for runtime reloads that should not forget flags set for the current session.

**Data flow**: It combines non-session layers from the refreshed config with session layers from the current config, sorts them by precedence, rebuilds the layer stack, deserializes it, and loads a new `Config` using the current cwd.

**Call relations**: Runtime reload code can call this after user or project config changes. It delegates final interpretation to `load_config_with_layer_stack`.

*Call graph*: calls 3 internal fn (get_layers, new, to_path_buf); 2 external calls (default, load_config_with_layer_stack).


##### `Config::load_with_cli_overrides`  (lines 1578–1585)

```
async fn load_with_cli_overrides(
        cli_overrides: Vec<(String, TomlValue)>,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads a normal full configuration with command-line overrides.

**Data flow**: It creates a default builder, attaches CLI override key-value pairs, builds the config, and returns the result.

**Call relations**: This is the preferred public entry for startup paths that only need CLI overrides.

*Call graph*: 1 external calls (default).


##### `Config::load_default_with_cli_overrides`  (lines 1588–1597)

```
async fn load_default_with_cli_overrides(
        cli_overrides: Vec<(String, TomlValue)>,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads default config plus CLI overrides when user config files should not be read or are invalid.

**Data flow**: It finds the Codex home directory, then delegates to the Codex-home-specific default loader. It returns a complete fallback config.

**Call relations**: Recovery startup paths use this when normal config loading fails but the application still needs a safe baseline.

*Call graph*: calls 1 internal fn (find_codex_home); 1 external calls (load_default_with_cli_overrides_for_codex_home).


##### `Config::load_default_with_cli_overrides_for_codex_home`  (lines 1601–1623)

```
async fn load_default_with_cli_overrides_for_codex_home(
        codex_home: PathBuf,
        cli_overrides: Vec<(String, TomlValue)>,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads default config for a specific Codex home without reading user, project, or system config layers.

**Data flow**: It serializes default TOML, merges CLI overrides into it, deserializes with the Codex home as the path base, and builds a final config from an empty layer stack.

**Call relations**: The broader default loader calls this after finding Codex home. It still uses the main final config constructor so defaults are interpreted consistently.

*Call graph*: calls 2 internal fn (deserialize_config_toml_with_base, from_absolute_path_checked); 7 external calls (load_config_with_layer_stack, build_cli_overrides_layer, merge_toml_values, default, default, default, try_from).


##### `Config::load_with_cli_overrides_and_harness_overrides`  (lines 1632–1641)

```
async fn load_with_cli_overrides_and_harness_overrides(
        cli_overrides: Vec<(String, TomlValue)>,
        harness_overrides: ConfigOverrides,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads full config with both CLI overrides and runtime-only harness overrides.

**Data flow**: It creates a default builder, attaches both override sets, builds the config, and returns the result.

**Call relations**: Subcommands such as noninteractive execution use this when they must force settings that are not representable in `config.toml`.

*Call graph*: 1 external calls (default).


##### `resolve_profile_v2_config_path`  (lines 1644–1652)

```
fn resolve_profile_v2_config_path(
    codex_home: &Path,
    profile_name: &ProfileV2Name,
) -> AbsolutePathBuf
```

**Purpose**: Builds the file path for a named v2 config profile. Profiles are stored as separate TOML files under the Codex home directory.

**Data flow**: It receives Codex home and a profile name, appends the profile suffix, resolves it against Codex home, and returns an absolute path.

**Call relations**: CLI profile loading and app-server archive startup call this to locate profile-specific config files.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 3 (loader_overrides_for_profile, run_main, start_app_server_for_archive_command); 1 external calls (format!).


##### `load_config_as_toml_with_cli_overrides`  (lines 1657–1670)

```
async fn load_config_as_toml_with_cli_overrides(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_overrides: Vec<(String, TomlValue)>,
    loader_overrides: LoaderOverrides,
) -> std:
```

**Purpose**: Loads merged config as raw `ConfigToml` with CLI overrides. It is deprecated because it does not produce fully enforced runtime `Config`.

**Data flow**: It forwards Codex home, current directory, CLI overrides, and loader overrides to the next helper and returns the raw TOML config.

**Call relations**: Older callers use this compatibility path. It delegates immediately to the more general loader-overrides helper.

*Call graph*: calls 1 internal fn (load_config_as_toml_with_cli_and_loader_overrides).


##### `load_config_as_toml_with_cli_and_loader_overrides`  (lines 1676–1684)

```
async fn load_config_as_toml_with_cli_and_loader_overrides(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_overrides: Vec<(String, TomlValue)>,
    loader_overrides: LoaderOverrides
```

**Purpose**: Loads merged config as raw `ConfigToml` with CLI and loader overrides. It is also deprecated for most callers.

**Data flow**: It passes its arguments to the load-options version and returns the resulting raw config.

**Call relations**: It exists as a compatibility step between the older helper name and the newer load-options helper.

*Call graph*: calls 1 internal fn (load_config_as_toml_with_cli_and_load_options); called by 1 (load_config_as_toml_with_cli_overrides).


##### `load_config_as_toml_with_cli_and_load_options`  (lines 1690–1699)

```
async fn load_config_as_toml_with_cli_and_load_options(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_overrides: Vec<(String, TomlValue)>,
    options: impl Into<ConfigLoadOptions>
```

**Purpose**: Loads only the deserialized TOML part of the config using general load options.

**Data flow**: It calls the layer-stack loader, then extracts and returns only the `config_toml` field from the result.

**Call relations**: Deprecated raw-config callers use this when they need merged TOML but not the final `Config` object.

*Call graph*: calls 1 internal fn (load_config_toml_with_layer_stack); called by 1 (load_config_as_toml_with_cli_and_loader_overrides).


##### `load_config_toml_with_layer_stack`  (lines 1713–1739)

```
async fn load_config_toml_with_layer_stack(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_overrides: Vec<(String, TomlValue)>,
    options: impl Into<ConfigLoadOptions>,
) -> std::
```

**Purpose**: Loads merged TOML together with the layer stack that produced it. This is for startup paths that need to inspect raw config before full construction.

**Data flow**: It loads config layers, gets their effective merged TOML, deserializes it with a base directory for relative paths, and returns both the TOML and stack.

**Call relations**: Bootstrap and archive-server paths use this when they need both raw config and managed requirements context.

*Call graph*: calls 2 internal fn (load_config_layers_state, deserialize_config_toml_with_base); called by 4 (load_config_as_toml_with_cli_and_load_options, load_bootstrap_config_or_exit, load_bootstrap_config_or_exit, start_app_server_for_archive_command).


##### `deserialize_config_toml_with_base`  (lines 1741–1751)

```
fn deserialize_config_toml_with_base(
    root_value: TomlValue,
    config_base_dir: &Path,
) -> std::io::Result<ConfigToml>
```

**Purpose**: Turns a generic TOML value into `ConfigToml` while resolving relative paths against a chosen base directory.

**Data flow**: It installs a temporary path-resolution guard, deserializes the TOML value, and returns either `ConfigToml` or an invalid-data error.

**Call relations**: Config loaders and config editing code use this so relative paths mean the same thing wherever deserialization happens.

*Call graph*: calls 1 internal fn (new); called by 5 (apply_edits, load_role_layer_toml, deserialize_effective_config, load_default_with_cli_overrides_for_codex_home, load_config_toml_with_layer_stack); 1 external calls (try_into).


##### `validate_feature_requirements_for_config_toml`  (lines 1754–1760)

```
fn validate_feature_requirements_for_config_toml(
    cfg: &ConfigToml,
    feature_requirements: Option<&Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<()>
```

**Purpose**: Checks feature settings in raw config against managed feature requirements.

**Data flow**: It receives parsed config and optional feature requirements, validates explicit feature choices, then validates required feature states. It returns success or an I/O error.

**Call relations**: Config editing calls this before saving changes that might violate managed feature policy.

*Call graph*: calls 2 internal fn (validate_explicit_feature_settings_in_config_toml, validate_feature_requirements_in_config_toml); called by 1 (apply_edits).


##### `load_catalog_json`  (lines 1762–1783)

```
fn load_catalog_json(path: &AbsolutePathBuf) -> std::io::Result<ModelsResponse>
```

**Purpose**: Reads and validates a custom model catalog JSON file. A model catalog lists available models and their metadata.

**Data flow**: It receives a path, reads the file, parses it as JSON into a model response, checks that at least one model exists, and returns the catalog or an error.

**Call relations**: The model catalog resolver calls this when config points to a custom catalog file.

*Call graph*: 3 external calls (new, format!, read_to_string).


##### `load_model_catalog`  (lines 1785–1791)

```
fn load_model_catalog(
    model_catalog_json: Option<AbsolutePathBuf>,
) -> std::io::Result<Option<ModelsResponse>>
```

**Purpose**: Optionally loads a custom model catalog from a configured path.

**Data flow**: It receives an optional path. If present, it loads and validates the JSON file; if absent, it returns `None`.

**Call relations**: The main config loader calls this while filling the model-catalog field.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `filter_mcp_servers_by_requirements`  (lines 1793–1816)

```
fn filter_mcp_servers_by_requirements(
    mcp_servers: &mut HashMap<String, McpServerConfig>,
    mcp_requirements: Option<&Sourced<BTreeMap<String, McpServerRequirement>>>,
)
```

**Purpose**: Disables configured MCP servers that are not allowed by managed requirements.

**Data flow**: It receives a mutable server map and an optional allowlist. If an allowlist exists, each server is checked by name and identity; disallowed servers are marked disabled with a reason.

**Call relations**: Plugin filtering and MCP constraint construction use this to enforce server allowlists.

*Call graph*: called by 1 (apply_plugin_mcp_server_requirements).


##### `filter_plugin_mcp_servers_by_requirements`  (lines 1818–1845)

```
fn filter_plugin_mcp_servers_by_requirements(
    plugin_config_name: &str,
    mcp_servers: &mut HashMap<String, McpServerConfig>,
    plugin_requirements: Option<&Sourced<BTreeMap<String, PluginRequ
```

**Purpose**: Disables MCP servers from one plugin unless managed plugin requirements allow them.

**Data flow**: It receives a plugin name, mutable server map, and optional plugin requirements. It finds requirements for that plugin, checks each server, and marks disallowed ones disabled.

**Call relations**: `Config::apply_plugin_mcp_server_requirements` calls this before plugin MCP servers are registered.

*Call graph*: called by 1 (apply_plugin_mcp_server_requirements).


##### `constrain_mcp_servers`  (lines 1847–1860)

```
fn constrain_mcp_servers(
    mcp_servers: HashMap<String, McpServerConfig>,
    mcp_requirements: Option<&Sourced<BTreeMap<String, McpServerRequirement>>>,
) -> ConstraintResult<Constrained<HashMap<S
```

**Purpose**: Wraps MCP server configuration in a constraint-aware value. Constraints can normalize the map by disabling disallowed servers.

**Data flow**: It receives the server map and optional requirements. Without requirements it allows any map; with requirements it returns a constrained value that filters servers through the requirements.

**Call relations**: The main config loader calls this before storing `mcp_servers` in the final config.

*Call graph*: calls 2 internal fn (allow_any, normalized); called by 1 (load_config_with_layer_stack).


##### `apply_requirement_constrained_value`  (lines 1862–1896)

```
fn apply_requirement_constrained_value(
    field_name: &'static str,
    configured_value: T,
    constrained_value: &mut ConstrainedWithSource<T>,
    startup_warnings: &mut Vec<String>,
) -> std::i
```

**Purpose**: Applies a configured value to a requirement-constrained setting, falling back with a startup warning if the value is not allowed.

**Data flow**: It receives a field name, candidate value, constrained holder, and warning list. It tries to set the candidate; on failure it logs, warns, restores the requirement-compliant fallback, and reports whether fallback happened.

**Call relations**: The main config loader uses this repeatedly for approvals, permission profiles, web search, and Windows sandbox settings.

*Call graph*: called by 1 (load_config_with_layer_stack); 4 external calls (get, set, format!, warn!).


##### `mcp_server_matches_requirement`  (lines 1898–1916)

```
fn mcp_server_matches_requirement(
    requirement: &McpServerRequirement,
    server: &McpServerConfig,
) -> bool
```

**Purpose**: Checks whether an MCP server matches the identity required by a managed allowlist.

**Data flow**: It receives one requirement and one server config. It compares command-based servers by command and URL-based servers by URL, then returns true or false.

**Call relations**: Both MCP filtering helpers use this as their per-server identity test.

*Call graph*: 1 external calls (matches!).


##### `load_global_mcp_servers`  (lines 1918–1952)

```
async fn load_global_mcp_servers(
    codex_home: &Path,
) -> std::io::Result<BTreeMap<String, McpServerConfig>>
```

**Purpose**: Loads globally configured MCP servers without a project context. It is used by commands that edit or inspect global MCP config.

**Data flow**: It loads config layers for Codex home with no current directory, extracts the `mcp_servers` TOML table if present, rejects deprecated inline bearer tokens, deserializes the servers, and returns them.

**Call relations**: MCP add, remove, and list commands call this because they need raw global server definitions rather than the full runtime config.

*Call graph*: calls 2 internal fn (load_config_layers_state, ensure_no_inline_bearer_tokens); called by 11 (run_add, run_remove, add_and_remove_server_updates_global_config, add_cant_add_command_and_url, add_streamable_http_rejects_removed_flag, add_streamable_http_with_custom_env_var, add_streamable_http_with_oauth_options, add_streamable_http_without_manual_token, add_with_env_preserves_key_order_and_values, get_disabled_server_shows_single_line (+1 more)); 3 external calls (new, new, default).


##### `ensure_no_inline_bearer_tokens`  (lines 1956–1973)

```
fn ensure_no_inline_bearer_tokens(value: &TomlValue) -> std::io::Result<()>
```

**Purpose**: Rejects old MCP config that stores bearer tokens directly in config. Bearer tokens are secrets and should come from environment variables instead.

**Data flow**: It receives a TOML value, looks for `bearer_token` keys under MCP server tables, and returns an invalid-data error if one is found.

**Call relations**: `load_global_mcp_servers` calls this before deserializing servers so users get a clear message about the unsupported field.

*Call graph*: called by 1 (load_global_mcp_servers); 3 external calls (as_table, new, format!).


##### `set_project_trust_level_inner`  (lines 1975–2042)

```
fn set_project_trust_level_inner(
    doc: &mut DocumentMut,
    project_path: &Path,
    trust_level: TrustLevel,
) -> anyhow::Result<()>
```

**Purpose**: Edits a TOML document in memory to record whether a project is trusted or untrusted. Project trust influences default approvals and sandbox behavior.

**Data flow**: It receives a mutable TOML document, project path, and trust level. It ensures the `[projects]` structure exists in a readable table form, creates or updates the project entry, and writes `trust_level`.

**Call relations**: The config editing layer calls this while applying trust edits to `config.toml`.

*Call graph*: calls 1 internal fn (project_trust_key); called by 1 (apply); 7 external calls (as_table_mut, anyhow!, to_string, Table, new, table, value).


##### `set_project_trust_level`  (lines 2046–2056)

```
fn set_project_trust_level(
    codex_home: &Path,
    project_path: &Path,
    trust_level: TrustLevel,
) -> anyhow::Result<()>
```

**Purpose**: Persists a project's trust level into `CODEX_HOME/config.toml`.

**Data flow**: It receives Codex home, project path, and trust level. It builds a config edit operation and applies it synchronously, returning success or an error.

**Call relations**: Thread startup, project-aware commands, and tests call this to mark projects trusted or untrusted.

*Call graph*: calls 1 internal fn (new); called by 10 (thread_start_task, config_read_includes_project_layers_for_cwd, hooks_list_uses_each_cwds_effective_feature_enablement, hooks_list_uses_root_repo_hooks_for_linked_worktrees, mcp_server_status_list_uses_thread_project_local_config, permission_profile_list_discovers_project_profiles_without_default_selection, permission_profile_list_resolves_project_profiles_and_paginates, plugin_list_uses_home_config_for_enabled_state, thread_start_respects_project_config_from_cwd, thread_start_skips_trust_write_when_project_is_already_trusted).


##### `set_default_oss_provider`  (lines 2059–2072)

```
fn set_default_oss_provider(codex_home: &Path, provider: &str) -> std::io::Result<()>
```

**Purpose**: Saves the default open-source model provider preference to config. It validates the provider name before writing.

**Data flow**: It receives Codex home and provider string, validates the provider, builds a TOML edit for `oss_provider`, applies it, and returns success or an I/O error.

**Call relations**: CLI flows that set local or OSS provider preferences use this helper to update config safely.

*Call graph*: calls 2 internal fn (validate_oss_provider, new); 1 external calls (vec!).


##### `resolve_tool_suggest_config`  (lines 2091–2096)

```
fn resolve_tool_suggest_config(
    config_toml: &ConfigToml,
    config_layer_stack: &ConfigLayerStack,
) -> ToolSuggestConfig
```

**Purpose**: Computes the final tool-suggestion settings from parsed config and the layer stack.

**Data flow**: It reads the `tool_suggest` section from `ConfigToml`, then delegates to the shared resolver that also considers layer ordering.

**Call relations**: The main config loader calls this while constructing the final `Config`.

*Call graph*: calls 1 internal fn (resolve_tool_suggest_config_from_config); called by 1 (load_config_with_layer_stack).


##### `resolve_tool_suggest_config_from_layer_stack`  (lines 2098–2107)

```
fn resolve_tool_suggest_config_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
) -> ToolSuggestConfig
```

**Purpose**: Computes tool-suggestion settings directly from a config layer stack.

**Data flow**: It extracts the effective `tool_suggest` value from merged config if possible, then delegates to the common resolver. It returns normalized discoverable and disabled tool lists.

**Call relations**: Runtime config refresh paths call this when they reload config layers without rebuilding the entire `Config`.

*Call graph*: calls 2 internal fn (effective_config, resolve_tool_suggest_config_from_config); called by 2 (refresh_runtime_config, reload_user_config_layer).


##### `resolve_tool_suggest_config_from_config`  (lines 2109–2169)

```
fn resolve_tool_suggest_config_from_config(
    tool_suggest: Option<&ToolSuggestConfig>,
    config_layer_stack: &ConfigLayerStack,
) -> ToolSuggestConfig
```

**Purpose**: Normalizes tool-suggestion config and merges disabled-tool entries in layer order.

**Data flow**: It trims empty discoverable IDs, deduplicates disabled tools, and if layer data is available, collects disabled tools from each active layer from low to high precedence. It returns a clean `ToolSuggestConfig`.

**Call relations**: Both public tool-suggestion resolvers delegate here so config-load and reload behavior match.

*Call graph*: calls 1 internal fn (get_layers); called by 2 (resolve_tool_suggest_config, resolve_tool_suggest_config_from_layer_stack); 2 external calls (new, new).


##### `thread_store_config`  (lines 2171–2177)

```
fn thread_store_config(thread_store: Option<ThreadStoreToml>) -> ThreadStoreConfig
```

**Purpose**: Converts experimental thread-store TOML into the runtime enum. The thread store is where conversation threads are persisted.

**Data flow**: It receives an optional TOML setting and returns local storage, in-memory storage with an ID, or local storage by default.

**Call relations**: The main config loader calls this while filling the experimental thread-store field.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `is_session_layer`  (lines 2179–2181)

```
fn is_session_layer(source: &ConfigLayerSource) -> bool
```

**Purpose**: Identifies whether a config layer came from session flags.

**Data flow**: It receives a layer source and returns true if it is the session-flags source.

**Call relations**: Config rebuilding uses this to preserve session-specific layers while replacing refreshed user or project layers.

*Call graph*: 1 external calls (matches!).


##### `EffectivePermissionSelection::has_profiles`  (lines 2206–2210)

```
fn has_profiles(&self) -> bool
```

**Purpose**: Reports whether the effective permission selection contains any named permission profiles.

**Data flow**: It reads the optional profile catalog and returns true only when it exists and is not empty.

**Call relations**: The main config loader uses this to reject a config that defines profiles but never selects one.


##### `EffectivePermissionSelection::profiles_are_active`  (lines 2212–2224)

```
fn profiles_are_active(
        &self,
        default_permissions_override: Option<&str>,
        permission_config_syntax: Option<PermissionConfigSyntax>,
    ) -> bool
```

**Purpose**: Decides whether named permission profiles should be used instead of legacy sandbox settings.

**Data flow**: It checks managed requirements, command-line default-permission override, detected permission syntax, and absence of explicit legacy syntax. It returns true when profile mode is active.

**Call relations**: The main config loader calls this before compiling permissions, because profile and legacy modes are interpreted differently.

*Call graph*: 1 external calls (matches!).


##### `resolve_permission_config_syntax`  (lines 2227–2281)

```
fn resolve_permission_config_syntax(
    config_layer_stack: &ConfigLayerStack,
    cfg: &ConfigToml,
    sandbox_mode_override: Option<SandboxMode>,
) -> Option<PermissionConfigSyntax>
```

**Purpose**: Detects whether config is using old `sandbox_mode` syntax or newer named permission profiles.

**Data flow**: It checks overrides first, then session flags, then active layers in precedence order, and finally merged config fields. It returns legacy, profiles, or no explicit syntax.

**Call relations**: The main config loader uses this decision to choose the permission resolution path.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (load_config_with_layer_stack).


##### `apply_managed_filesystem_constraints`  (lines 2283–2312)

```
fn apply_managed_filesystem_constraints(
    file_system_sandbox_policy: &mut FileSystemSandboxPolicy,
    filesystem_constraints: &codex_config::FilesystemConstraints,
)
```

**Purpose**: Adds managed file read-deny rules to a file-system sandbox policy.

**Data flow**: It receives a mutable sandbox policy and filesystem constraints. Each deny-read rule becomes either a glob-pattern deny entry or an absolute-path deny entry, and duplicate entries are skipped.

**Call relations**: The main config loader applies this after permission profiles are constrained, ensuring managed file restrictions are present in the final runtime policy.

*Call graph*: calls 1 internal fn (try_from); called by 1 (load_config_with_layer_stack).


##### `dedupe_absolute_paths`  (lines 2346–2349)

```
fn dedupe_absolute_paths(paths: &mut Vec<AbsolutePathBuf>)
```

**Purpose**: Removes duplicate absolute paths while preserving the first occurrence.

**Data flow**: It receives a mutable vector of absolute paths, tracks paths already seen, and removes repeats in place.

**Call relations**: Workspace-root resolution uses this whenever roots are combined from current directory, overrides, and profile-defined roots.

*Call graph*: called by 2 (effective_workspace_roots, load_config_with_layer_stack); 1 external calls (new).


##### `resolve_oss_provider`  (lines 2353–2363)

```
fn resolve_oss_provider(
    explicit_provider: Option<&str>,
    config_toml: &ConfigToml,
) -> Option<String>
```

**Purpose**: Chooses the open-source provider preference from an explicit override or global config.

**Data flow**: It receives an optional explicit provider and parsed config. It returns the explicit provider if present, otherwise the configured `oss_provider`, otherwise `None`.

**Call relations**: CLI startup and archive server setup call this when deciding which local provider option should apply.

*Call graph*: called by 3 (run_main, run_main, start_app_server_for_archive_command).


##### `resolve_web_search_mode`  (lines 2366–2377)

```
fn resolve_web_search_mode(config_toml: &ConfigToml, features: &Features) -> Option<WebSearchMode>
```

**Purpose**: Chooses the preferred web-search mode from config and feature flags.

**Data flow**: It first uses an explicit `web_search` config value. If absent, feature flags can select cached or live search. If nothing applies, it returns `None`.

**Call relations**: The main config loader calls this before applying managed web-search constraints.

*Call graph*: calls 1 internal fn (enabled); called by 1 (load_config_with_layer_stack).


##### `resolve_web_search_config`  (lines 2379–2386)

```
fn resolve_web_search_config(config_toml: &ConfigToml) -> Option<WebSearchConfig>
```

**Purpose**: Extracts extra web-search tool parameters from config.

**Data flow**: It looks under the `tools.web_search` section, clones it if present, converts it to the runtime type, and returns it as optional config.

**Call relations**: The main config loader stores this alongside the constrained web-search mode.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_experimental_request_user_input_enabled`  (lines 2388–2394)

```
fn resolve_experimental_request_user_input_enabled(config_toml: &ConfigToml) -> bool
```

**Purpose**: Determines whether the experimental request-user-input tool should be registered.

**Data flow**: It reads the optional tool config. If the setting is missing, it defaults to enabled; otherwise it returns the configured enabled flag.

**Call relations**: The main config loader calls this while preparing tool-surface settings.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_code_mode_config`  (lines 2396–2405)

```
fn resolve_code_mode_config(config_toml: &ConfigToml) -> CodeModeConfig
```

**Purpose**: Builds the runtime config for the experimental code-mode tool surface.

**Data flow**: It reads code-mode feature configuration, extracts excluded tool namespaces if present, and returns a `CodeModeConfig` with an empty list by default.

**Call relations**: The main config loader calls this after feature resolution.

*Call graph*: calls 1 internal fn (code_mode_toml_config); called by 1 (load_config_with_layer_stack).


##### `resolve_multi_agent_v2_config`  (lines 2407–2462)

```
fn resolve_multi_agent_v2_config(config_toml: &ConfigToml) -> MultiAgentV2Config
```

**Purpose**: Builds the runtime multi-agent v2 settings by combining defaults with optional feature config.

**Data flow**: It reads multi-agent v2 feature config, chooses a concurrency limit, creates matching defaults, applies configured timeout and prompt overrides, and returns a `MultiAgentV2Config`.

**Call relations**: The main config loader calls this before validating multi-agent limits and namespace names.

*Call graph*: calls 3 internal fn (defaults_for_max_concurrency, multi_agent_v2_toml_config, resolve_optional_prompt_text); called by 1 (load_config_with_layer_stack).


##### `resolve_terminal_resize_reflow_config`  (lines 2464–2476)

```
fn resolve_terminal_resize_reflow_config(config_toml: &ConfigToml) -> TerminalResizeReflowConfig
```

**Purpose**: Translates terminal resize reflow settings into runtime behavior. Reflow means recalculating displayed transcript rows after the terminal changes size.

**Data flow**: It reads TUI config. Missing settings mean automatic row limits, zero disables the cap, and positive values become an explicit row limit.

**Call relations**: The main config loader stores this for the terminal UI.

*Call graph*: called by 1 (load_config_with_layer_stack); 2 external calls (default, Limit).


##### `resolve_optional_prompt_text`  (lines 2478–2487)

```
fn resolve_optional_prompt_text(
    configured: Option<&Option<String>>,
    default: Option<String>,
) -> Option<String>
```

**Purpose**: Resolves optional prompt text where an empty string means disable the prompt.

**Data flow**: It receives an optional configured optional string and a default. A configured empty string returns `None`, a configured non-empty string returns that value, and missing config returns the default.

**Call relations**: Multi-agent v2 config resolution uses this for root-agent and sub-agent instruction prompts.

*Call graph*: called by 1 (resolve_multi_agent_v2_config).


##### `code_mode_toml_config`  (lines 2489–2494)

```
fn code_mode_toml_config(features: Option<&FeaturesToml>) -> Option<&CodeModeConfigToml>
```

**Purpose**: Extracts code-mode feature configuration only when the feature uses a config object rather than a simple enabled flag.

**Data flow**: It receives optional feature TOML and returns the code-mode config reference if present in config form. Plain enabled form returns `None`.

**Call relations**: `resolve_code_mode_config` calls this to find optional detailed settings.

*Call graph*: called by 1 (resolve_code_mode_config).


##### `multi_agent_v2_toml_config`  (lines 2496–2501)

```
fn multi_agent_v2_toml_config(features: Option<&FeaturesToml>) -> Option<&MultiAgentV2ConfigToml>
```

**Purpose**: Extracts multi-agent v2 feature configuration only when detailed config is present.

**Data flow**: It receives optional feature TOML and returns the multi-agent v2 config reference if present in config form. Plain enabled form returns `None`.

**Call relations**: `resolve_multi_agent_v2_config` calls this before applying detailed overrides.

*Call graph*: called by 1 (resolve_multi_agent_v2_config).


##### `network_proxy_toml_config`  (lines 2503–2508)

```
fn network_proxy_toml_config(features: Option<&FeaturesToml>) -> Option<&NetworkProxyConfigToml>
```

**Purpose**: Extracts network-proxy feature configuration only when detailed config is present.

**Data flow**: It receives optional feature TOML and returns the network-proxy config reference if present in config form. Plain enabled form returns `None`.

**Call relations**: The main config loader and active-profile network recalculation use this before applying proxy feature settings.

*Call graph*: called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `resolve_web_search_mode_for_turn`  (lines 2510–2544)

```
fn resolve_web_search_mode_for_turn(
    web_search_mode: &Constrained<WebSearchMode>,
    permission_profile: &PermissionProfile,
) -> WebSearchMode
```

**Purpose**: Chooses the actual web-search mode for one turn, taking both user preference and permission constraints into account.

**Data flow**: It receives a constrained web-search setting and a permission profile. If permissions are disabled, it prefers safer fallbacks. Otherwise it tries the preferred mode, then cached, live, and disabled, returning disabled if nothing is allowed.

**Call relations**: Turn-handling code can call this when deciding whether the web search tool should be live, cached, or unavailable for that turn.

*Call graph*: calls 2 internal fn (can_set, value); 1 external calls (matches!).


##### `validate_multi_agent_v2_wait_timeout`  (lines 2546–2560)

```
fn validate_multi_agent_v2_wait_timeout(label: &str, value: i64) -> std::io::Result<()>
```

**Purpose**: Checks that a multi-agent v2 wait timeout is inside hard allowed bounds.

**Data flow**: It receives a label and numeric timeout. Values below the hard minimum or above the hard maximum return invalid-input errors; valid values succeed.

**Call relations**: The main config loader calls this for minimum, maximum, and default wait timeouts before accepting multi-agent v2 config.

*Call graph*: called by 1 (load_config_with_layer_stack); 2 external calls (new, format!).


##### `validate_multi_agent_v2_tool_namespace`  (lines 2562–2623)

```
fn validate_multi_agent_v2_tool_namespace(namespace: Option<&str>) -> std::io::Result<()>
```

**Purpose**: Validates a custom tool namespace for multi-agent v2 tools. A namespace is the prefix used to group tool names.

**Data flow**: It receives an optional namespace. Missing is allowed; present values must be non-empty, trimmed, short enough, ASCII alphanumeric plus `_` or `-`, and not reserved. It returns success or a clear error.

**Call relations**: The main config loader calls this before storing multi-agent v2 config.

*Call graph*: called by 1 (load_config_with_layer_stack); 2 external calls (new, format!).


##### `Config::load_from_base_config_with_overrides`  (lines 2627–2642)

```
async fn load_from_base_config_with_overrides(
        cfg: ConfigToml,
        overrides: ConfigOverrides,
        codex_home: AbsolutePathBuf,
    ) -> std::io::Result<Self>
```

**Purpose**: Test-only helper that builds a `Config` from a base TOML object and overrides. It skips managed requirements.

**Data flow**: It receives config TOML, overrides, and Codex home, creates a default layer stack, and delegates to the main config constructor.

**Call relations**: Test helpers call this to exercise config construction without going through real layer loading.

*Call graph*: 2 external calls (load_config_with_layer_stack, default).


##### `Config::load_config_with_layer_stack`  (lines 2644–3730)

```
async fn load_config_with_layer_stack(
        fs: &dyn ExecutorFileSystem,
        cfg: ConfigToml,
        overrides: ConfigOverrides,
        codex_home: AbsolutePathBuf,
        config_layer_stack
```

**Purpose**: This is the core config constructor. It turns parsed TOML, runtime overrides, Codex home, and a layer stack with requirements into the final `Config` used by Codex.

**Data flow**: It validates raw settings, resolves feature flags, permissions, project trust, workspace roots, model providers, MCP servers, auth storage, paths, prompts, UI settings, telemetry, and safety requirements. It returns a fully populated `Config` or a detailed error.

**Call relations**: Almost every public config-loading path eventually delegates here. It coordinates many helper functions in this file plus specialized modules for permissions, roles, features, network proxy, and telemetry.

*Call graph*: calls 47 internal fn (derive_permission_profile, get_active_project, validate_model_providers, requirements, requirements_toml, startup_warnings, default, load_agent_roles, apply_managed_filesystem_constraints, apply_requirement_constrained_value (+15 more)); 19 external calls (pin, default, try_read_non_empty_file, new, new, sandbox_mode_requirement_for_permission_profile, resolve_root_git_project_for_trust, memory_root, built_in_model_providers, merge_configured_model_providers (+9 more)).


##### `Config::try_read_non_empty_file`  (lines 3735–3764)

```
async fn try_read_non_empty_file(
        fs: &dyn ExecutorFileSystem,
        path: Option<&AbsolutePathBuf>,
        context: &str,
    ) -> std::io::Result<Option<String>>
```

**Purpose**: Reads an optional prompt or instruction file and rejects empty files.

**Data flow**: It receives a filesystem interface, optional absolute path, and human-readable context. Missing path returns `None`; present path is read as text, trimmed, and returned if non-empty, otherwise an error is produced.

**Call relations**: The main config loader uses this for model instruction files and compact prompt files.

*Call graph*: calls 2 internal fn (read_file_text, from_abs_path); 2 external calls (new, format!).


##### `Config::set_windows_sandbox_enabled`  (lines 3766–3777)

```
fn set_windows_sandbox_enabled(&mut self, value: bool)
```

**Purpose**: Turns the unelevated Windows sandbox mode on or off without disturbing an elevated sandbox setting.

**Data flow**: It receives a boolean. True sets the Windows sandbox mode to unelevated; false clears it only if it was currently unelevated.

**Call relations**: Runtime controls can call this to toggle the normal Windows sandbox flag after config load.

*Call graph*: 1 external calls (matches!).


##### `Config::set_windows_elevated_sandbox_enabled`  (lines 3779–3790)

```
fn set_windows_elevated_sandbox_enabled(&mut self, value: bool)
```

**Purpose**: Turns the elevated Windows sandbox mode on or off without disturbing an unelevated sandbox setting.

**Data flow**: It receives a boolean. True sets the Windows sandbox mode to elevated; false clears it only if it was currently elevated.

**Call relations**: Runtime controls can call this to toggle elevated Windows sandbox behavior after config load.

*Call graph*: 1 external calls (matches!).


##### `Config::managed_network_requirements_enabled`  (lines 3792–3801)

```
fn managed_network_requirements_enabled(&self) -> bool
```

**Purpose**: Reports whether managed network requirements are active for the current config.

**Data flow**: It checks that permissions are not fully disabled and that requirements TOML contains a network section. It returns true or false.

**Call relations**: Runtime or UI code can use this to explain why network behavior is being constrained.

*Call graph*: calls 1 internal fn (requirements_toml); 1 external calls (matches!).


##### `Config::network_proxy_spec_for_active_permission_profile`  (lines 3803–3848)

```
fn network_proxy_spec_for_active_permission_profile(
        &self,
        active_permission_profile: &ActivePermissionProfile,
        permission_profile: &PermissionProfile,
    ) -> std::io::Resul
```

**Purpose**: Recomputes the network proxy spec for a newly selected active permission profile.

**Data flow**: It receives active-profile metadata and a permission profile, reloads effective config to find that profile's proxy settings when allowed, applies network-proxy feature config if enabled, then builds a final proxy spec with managed requirements.

**Call relations**: Permission-profile switching code uses this so network proxy behavior follows the selected profile without rebuilding the entire config.

*Call graph*: calls 8 internal fn (effective_config, requirements, build_network_proxy_spec, network_proxy_toml_config, apply_network_proxy_feature_config, network_proxy_config_for_profile_selection, profile_allows_configured_network_proxy, network_sandbox_policy); 2 external calls (enabled, default).


##### `Config::bundled_skills_enabled`  (lines 3850–3852)

```
fn bundled_skills_enabled(&self) -> bool
```

**Purpose**: Reports whether bundled skills are enabled according to the config layer stack. Skills are packaged capabilities or instructions Codex can use.

**Data flow**: It passes the config layer stack to the manager helper and returns the boolean result.

**Call relations**: Skill-loading code can call this to decide whether bundled skills should be made available.

*Call graph*: calls 1 internal fn (bundled_skills_enabled_from_stack).


##### `guardian_policy_config_from_requirements`  (lines 3855–3859)

```
fn guardian_policy_config_from_requirements(
    requirements_toml: &ConfigRequirementsToml,
) -> Option<String>
```

**Purpose**: Extracts Guardian policy configuration from managed requirements. Guardian is the review/safety layer that can evaluate risky actions.

**Data flow**: It reads the requirements TOML policy text and normalizes it by trimming whitespace and dropping empty values.

**Call relations**: The main config loader calls this before falling back to local auto-review policy config.

*Call graph*: calls 1 internal fn (normalize_guardian_policy_config); called by 1 (load_config_with_layer_stack).


##### `merge_managed_permission_profiles`  (lines 3861–3890)

```
fn merge_managed_permission_profiles(
    configured_permissions: Option<&PermissionsToml>,
    requirements_toml: &ConfigRequirementsToml,
) -> std::io::Result<Option<PermissionsToml>>
```

**Purpose**: Combines user-defined permission profiles with profiles supplied by managed requirements.

**Data flow**: It receives optional configured profiles and requirements. Managed profiles are added unless they conflict with a user-defined profile of the same name; conflicts return an error.

**Call relations**: Effective permission selection calls this before validating and selecting a default profile.

*Call graph*: called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `resolve_effective_permission_selection`  (lines 3892–3916)

```
fn resolve_effective_permission_selection(
    configured_permissions: Option<&PermissionsToml>,
    default_permissions_override: Option<&'a str>,
    configured_default_permissions: Option<&'a str>,
```

**Purpose**: Builds the effective permission-profile catalog and selected profile ID.

**Data flow**: It merges managed profiles, validates user profile names, checks required profile references, resolves the selected default permission profile, and returns an `EffectivePermissionSelection`.

**Call relations**: The main config loader calls this before compiling permissions into concrete sandbox policies.

*Call graph*: calls 4 internal fn (merge_managed_permission_profiles, validate_user_permission_profile_names, resolve_default_permissions, validate_required_permission_profile_catalog); called by 1 (load_config_with_layer_stack).


##### `resolve_default_permissions`  (lines 3918–3954)

```
fn resolve_default_permissions(
    default_permissions_override: Option<&'a str>,
    configured_default_permissions: Option<&'a str>,
    requirements_toml: &'a ConfigRequirementsToml,
    startup_w
```

**Purpose**: Chooses the selected permission profile while respecting managed allowlists.

**Data flow**: It starts from a command-line override or configured default. If requirements restrict allowed profiles, it uses the selected value only when allowed; otherwise it falls back to a required or implicit default and records a warning.

**Call relations**: Effective permission selection uses this after profile catalogs are merged and before profiles are compiled.

*Call graph*: calls 1 internal fn (is_permission_allowed); called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `validate_required_permission_profile_catalog`  (lines 3956–4008)

```
fn validate_required_permission_profile_catalog(
    requirements_toml: &ConfigRequirementsToml,
    available_permissions: Option<&PermissionsToml>,
) -> std::io::Result<()>
```

**Purpose**: Checks that managed permission-profile requirements refer to real and allowed profiles.

**Data flow**: It examines allowed profile names and default permissions from requirements. It verifies every allowed profile is built in or configured, ensures a default can be determined, and confirms the default is allowed.

**Call relations**: Effective permission selection calls this so bad managed requirements fail early with clear errors.

*Call graph*: calls 1 internal fn (is_permission_allowed); called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `implicit_default_permissions`  (lines 4010–4016)

```
fn implicit_default_permissions(
    allowed_permission_profiles: &BTreeMap<String, bool>,
) -> Option<&'static str>
```

**Purpose**: Chooses an implicit managed default permission profile when requirements allow both built-in workspace and read-only profiles.

**Data flow**: It receives an allowlist map. If both `:workspace` and `:read-only` are allowed, it returns `:workspace`; otherwise it returns `None`.

**Call relations**: Default-permission resolution and requirement validation use this when requirements do not explicitly name a default.

*Call graph*: calls 1 internal fn (is_permission_allowed).


##### `is_permission_allowed`  (lines 4018–4026)

```
fn is_permission_allowed(
    allowed_permission_profiles: &BTreeMap<String, bool>,
    profile_id: &str,
) -> bool
```

**Purpose**: Checks whether a permission profile ID is allowed by a requirements allowlist.

**Data flow**: It receives the allowlist map and profile ID. It returns the stored boolean for that ID, or false if the ID is absent.

**Call relations**: Permission default resolution, implicit default selection, and requirement validation all use this small shared check.

*Call graph*: called by 3 (implicit_default_permissions, resolve_default_permissions, validate_required_permission_profile_catalog).


##### `normalize_guardian_policy_config`  (lines 4028–4033)

```
fn normalize_guardian_policy_config(value: Option<&str>) -> Option<String>
```

**Purpose**: Cleans optional Guardian policy text by trimming whitespace and dropping empty strings.

**Data flow**: It receives optional text. Non-empty trimmed text becomes a new string; missing or empty text becomes `None`.

**Call relations**: Managed and local Guardian policy config extraction both use this normalization.

*Call graph*: called by 1 (guardian_policy_config_from_requirements).


##### `find_codex_home`  (lines 4043–4045)

```
fn find_codex_home() -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Finds the Codex home directory, usually from `CODEX_HOME` or the default `~/.codex` path.

**Data flow**: It delegates to the shared home-directory utility and returns an absolute path or an I/O error.

**Call relations**: Startup, CLI commands, profile loading, logging setup, and fallback config loading call this whenever they need the root config/state directory.

*Call graph*: called by 21 (from_listen_url, default_control_socket_path, run_main_with_transport_options, cli_main, disable_feature_in_config, fallback_state_check, enable_feature_in_config, loader_overrides_for_profile, run_add, run_remove (+11 more)); 1 external calls (find_codex_home).


##### `log_dir`  (lines 4049–4051)

```
fn log_dir(cfg: &Config) -> std::io::Result<PathBuf>
```

**Purpose**: Returns the configured log directory path.

**Data flow**: It receives a `Config`, clones its `log_dir` field, and returns it as an I/O result.

**Call relations**: Logging initialization calls this after config load to know where log files should be written.

*Call graph*: called by 1 (init_login_file_logging).


### `exec-server/src/runtime_paths.rs`

`data_model` · `startup and child-process setup`

When the exec server starts child processes, those children sometimes need to call back into Codex itself, including hidden helper modes and, on Linux, a sandbox helper that may be found through a special executable alias. This file is the shared “address card” for those paths.

The main type, `ExecServerRuntimePaths`, stores two paths. The first is required: the stable path to the Codex executable. The second is optional: the Linux sandbox alias, only needed on platforms or setups that use it. Both are stored as absolute paths, meaning they start from the filesystem root rather than depending on the process’s current working directory. That matters because child processes may run from different directories; a relative path would be like giving someone directions that only work if they start in the same room.

The constructors turn ordinary `PathBuf` values into `AbsolutePathBuf` values, rejecting missing or non-absolute paths with an input error. This keeps path mistakes near startup or setup time instead of letting them appear later as confusing child-process launch failures.

#### Function details

##### `ExecServerRuntimePaths::from_optional_paths`  (lines 16–27)

```
fn from_optional_paths(
        codex_self_exe: Option<PathBuf>,
        codex_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds the runtime path bundle when the Codex executable path may or may not have been configured yet. It requires the main Codex executable path and gives a clear error if it is missing.

**Data flow**: It receives two optional filesystem paths: one for the Codex executable and one for the Linux sandbox alias. It first checks that the Codex executable path is present; if not, it returns an input error saying the path is not configured. If it is present, it passes both paths on to `ExecServerRuntimePaths::new`, which checks that the supplied paths are absolute and returns the finished runtime path bundle.

**Call relations**: Higher-level startup and command-building code calls this when it is collecting settings before launching or preparing server work. This function acts as the gatekeeper for the required executable path, then hands off to `ExecServerRuntimePaths::new` for the actual path validation and struct creation.

*Call graph*: called by 8 (run_main_with_transport_options, list_accessible_connectors_from_mcp_tools_with_options_and_status, build_prompt_input, run_main, run_main, run_main, run_main, start_app_server_for_archive_command); 1 external calls (new).


##### `ExecServerRuntimePaths::new`  (lines 29–37)

```
fn new(
        codex_self_exe: PathBuf,
        codex_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self>
```

**Purpose**: Creates an `ExecServerRuntimePaths` value from concrete paths, while enforcing that every provided path is absolute. Use this when the caller already knows the main Codex executable path exists.

**Data flow**: It takes a required Codex executable path and an optional Linux sandbox alias path. It runs each supplied path through `absolute_path`; the optional sandbox path is checked only if it was provided. If all checks pass, it returns a struct containing the validated absolute paths. If any path is not absolute, it returns an input error instead of creating an unsafe or unreliable configuration.

**Call relations**: This is the central constructor used by tests, runtime setup code, exec-server command setup, and permission-related helper logic. It relies on `absolute_path` for the low-level check, then supplies the validated path bundle to the rest of the exec-server flow that needs to launch or reason about child processes.

*Call graph*: calls 1 internal fn (absolute_path); called by 27 (runtime_start_args_forward_environment_manager, run_exec_server_command, test_runtime_paths, build_with_home_and_base_url, test_runtime_paths, helper_permissions_include_helper_read_root_without_additional_permissions, helper_permissions_include_linux_sandbox_alias_parent, helper_permissions_preserve_existing_writes, sandbox_exec_request_carries_helper_env, processor_exit_reports_closed_virtual_stream (+15 more)).


##### `absolute_path`  (lines 40–43)

```
fn absolute_path(path: PathBuf) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Converts a normal filesystem path into an `AbsolutePathBuf`, or reports an error if the path is not absolute. This keeps the rest of the code from accidentally using paths that depend on the current directory.

**Data flow**: It receives a `PathBuf`, views it as a path, and asks `AbsolutePathBuf::from_absolute_path` to verify and wrap it. On success, it returns the absolute-path wrapper. On failure, it turns the validation problem into a standard input error that callers can return upward.

**Call relations**: `ExecServerRuntimePaths::new` calls this for each path it wants to store. This helper keeps the validation rule in one place, so the constructor can stay focused on building the runtime path bundle.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (new); 1 external calls (as_path).


### `tools/src/tool_config.rs`

`config` · `startup and session setup`

This file is a decision table for tool behavior. The project has several ways to run shell commands: a classic shell command path, a newer “unified exec” path, and a special zsh-fork path for intercepting zsh shell execution on Unix. Those choices cannot be made from one setting alone. They depend on feature flags, the model’s requested shell type, the operating system, terminal support, the user’s shell, and whether required executable paths are valid.

The file keeps those rules in one place so the rest of the system can ask simple questions like “what shell tool should this model use?” or “does this session have a tool environment?” Without this file, these rules would be scattered around the codebase, and it would be easy to accidentally enable a shell backend that an administrator or deployment meant to keep off.

A key idea here is separation between policy and runtime reality. Feature flags say what is allowed in principle. Later, session checks confirm whether the current machine and user setup can actually use that mode. For example, zsh-fork unified execution is only chosen when the feature combination allows it, the system is Unix, the user shell is zsh, and the needed paths can be converted into absolute paths. Otherwise the code safely falls back to direct execution.

#### Function details

##### `request_user_input_available_modes`  (lines 38–47)

```
fn request_user_input_available_modes(features: &Features) -> Vec<ModeKind>
```

**Purpose**: Builds the list of collaboration modes that may show a “request user input” option in the text user interface. It also allows the default mode to appear when a specific feature flag says that default mode should be able to request user input.

**Data flow**: It takes the active feature set as input. It reads the fixed list of collaboration modes visible in the interface, keeps only the modes that either already allow user input requests or qualify through the default-mode feature flag, and returns the filtered list.

**Call relations**: This is used when the interface or configuration layer needs to know which visible modes can support asking the user for more input. It depends on the shared mode definitions and the enabled feature flags, but it does not call other project-specific helper functions from this file.


##### `shell_command_backend_for_features`  (lines 49–55)

```
fn shell_command_backend_for_features(features: &Features) -> ShellCommandBackendConfig
```

**Purpose**: Chooses which backend should run ordinary shell commands based on enabled features. It picks the zsh-fork backend only when both the shell tool and zsh-fork feature are enabled; otherwise it stays with the classic backend.

**Data flow**: It receives the feature set. It checks whether the shell tool feature is enabled and whether zsh-fork is also enabled. The output is a small enum value saying either “Classic” or “ZshFork.”

**Call relations**: This function is called by shell_type_for_model_and_features when that higher-level function needs to translate feature policy into the actual shell tool type. It is one smaller rule inside the larger shell-selection decision.

*Call graph*: calls 1 internal fn (enabled); called by 1 (shell_type_for_model_and_features).


##### `unified_exec_feature_mode_for_features`  (lines 67–79)

```
fn unified_exec_feature_mode_for_features(features: &Features) -> UnifiedExecFeatureMode
```

**Purpose**: Decides whether feature policy allows unified exec, and if so whether it should be direct or zsh-fork based. Unified exec is a newer execution path, and this function makes sure it is not silently enabled unless the required feature flags explicitly allow it.

**Data flow**: It takes the active feature set. It first rejects unified exec if the shell tool itself is off or unified exec is off. If zsh-fork is enabled, it only returns the zsh-fork unified mode when the separate composition flag is also enabled. If zsh-fork is not enabled, it returns direct unified exec. The result is Disabled, Direct, or ZshFork.

**Call relations**: This function is called by shell_type_for_model_and_features before that function considers the model request and platform support. It supplies the policy-level answer: what unified-exec mode, if any, the configured features permit.

*Call graph*: calls 1 internal fn (enabled); called by 1 (shell_type_for_model_and_features).


##### `shell_type_for_model_and_features`  (lines 81–116)

```
fn shell_type_for_model_and_features(
    model_info: &ModelInfo,
    features: &Features,
) -> ConfigShellToolType
```

**Purpose**: Chooses the final shell tool type that should be exposed for a model under the current feature flags and platform support. It protects against unsupported or disabled paths by falling back to safer shell-command behavior or disabling the shell tool entirely.

**Data flow**: It receives model information and the active feature set. It first asks what unified-exec mode the features allow, then adjusts the model’s requested shell type if unified exec is disabled or if the model asked for a default/local shell. It also checks which classic shell-command backend is configured. Finally, if the shell tool feature is off it returns Disabled; if unified exec is allowed and the system supports the needed terminal feature, it returns UnifiedExec; otherwise it returns ShellCommand.

**Call relations**: This is the main shell-selection function in the file. It calls unified_exec_feature_mode_for_features for the high-level feature policy, shell_command_backend_for_features for the shell-command backend rule, and an external conpty_supported check to see whether the current platform can actually use unified exec.

*Call graph*: calls 3 internal fn (enabled, shell_command_backend_for_features, unified_exec_feature_mode_for_features); 2 external calls (conpty_supported, matches!).


##### `UnifiedExecShellMode::for_session`  (lines 131–164)

```
fn for_session(
        feature_mode: UnifiedExecFeatureMode,
        user_shell_type: ToolUserShellType,
        shell_zsh_path: Option<&PathBuf>,
        main_execve_wrapper_exe: Option<&PathBuf>,
```

**Purpose**: Chooses how unified exec should run for one concrete session. It uses the policy-level mode plus real session details, such as the user’s shell and the paths to required executables, to decide whether zsh-fork can actually be used.

**Data flow**: It receives the requested unified-exec feature mode, the detected user shell type, and optional paths for zsh and the exec wrapper program. If the system is Unix, the feature mode asks for zsh-fork, the user shell is zsh, both paths are present, and both paths can be converted into absolute paths, it returns a ZshFork configuration containing those absolute paths. If any condition fails, it returns Direct. Invalid paths are logged as warnings before falling back.

**Call relations**: This function is used during session setup by callers such as spawn_review_thread and make_turn_context when they need a concrete execution mode for a running conversation or review. Tests also call it to confirm that zsh-fork is selected only when every required input matches.

*Call graph*: calls 1 internal fn (try_from); called by 3 (spawn_review_thread, make_turn_context, unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match); 3 external calls (ZshFork, cfg!, matches!).


##### `ToolEnvironmentMode::from_count`  (lines 175–181)

```
fn from_count(count: usize) -> Self
```

**Purpose**: Turns a number of tool environments into a simple category: none, one, or many. This gives later code a clearer value to reason about than a raw number.

**Data flow**: It takes a count as input. A count of 0 becomes None, a count of 1 becomes Single, and any larger count becomes Multiple. It returns that category and does not change anything else.

**Call relations**: This is called by tool_environment_mode when some other part of the system has counted available environments and wants the standardized category used by this file’s configuration model.

*Call graph*: called by 1 (tool_environment_mode).


##### `ToolEnvironmentMode::has_environment`  (lines 183–185)

```
fn has_environment(self) -> bool
```

**Purpose**: Answers the yes-or-no question: does this tool environment mode include at least one environment? It is a convenience check for code that does not care whether there is one or many.

**Data flow**: It receives a ToolEnvironmentMode value. It checks whether that value is not None, then returns true for Single or Multiple and false for None.

**Call relations**: This helper is meant to be called wherever code needs a quick boolean check after a ToolEnvironmentMode has already been chosen. It does not call other project-specific functions, only a standard pattern-matching check.

*Call graph*: 1 external calls (matches!).


### `core/src/session/config_lock.rs`

`domain_logic` · `session setup, replay validation, and config lock export`

A config lock is like a recipe card for a session: it records the final ingredients Codex actually used after defaults, profiles, feature switches, model-catalog choices, and other setup steps have been resolved. Without this file, replaying a session could silently drift because two different input paths might produce different runtime behavior.

The main flow starts with a SessionConfiguration, which represents the session after setup. The file builds a ConfigToml value from the already-resolved configuration layer stack, then patches in extra values that only become known during session construction, such as the chosen model, prompts, approval behavior, and feature settings. It also removes inputs that should not be part of the replay contract, such as profile names, debug controls, file paths, and environment-specific permission inputs.

Once that cleaned and resolved configuration is ready, it is wrapped as a ConfigLockfileToml. The file can then either validate it against an expected lock, or write it to disk using the conversation id as the filename. The tests check that important resolved fields are included, optional model-catalog-derived fields can be skipped, and validation catches real drift while allowing specific compatibility exceptions.

#### Function details

##### `validate_config_lock_if_configured`  (lines 20–41)

```
async fn validate_config_lock_if_configured(
    session_configuration: &SessionConfiguration,
) -> anyhow::Result<()>
```

**Purpose**: This function checks whether the current root session matches a previously supplied config lock. It is used to stop a replay from continuing if the effective settings have changed in a meaningful way.

**Data flow**: It receives a SessionConfiguration. If the session is a non-root agent, or there is no expected config lock attached to the original config, it does nothing and succeeds. Otherwise it converts the live session into a fresh lockfile, reads the version-mismatch policy from the original config, compares expected versus actual, and returns success or an error explaining that config lock replay validation failed.

**Call relations**: When replay validation is needed, this function asks SessionConfiguration::to_config_lockfile_toml to build the actual lock from the live session, then hands both locks to validate_config_lock_replay. It sits at the boundary between session setup and the lower-level lock comparison code.

*Call graph*: calls 1 internal fn (validate_config_lock_replay); 1 external calls (to_config_lockfile_toml).


##### `export_config_lock_if_configured`  (lines 43–69)

```
async fn export_config_lock_if_configured(
    session_configuration: &SessionConfiguration,
    conversation_id: ThreadId,
) -> anyhow::Result<()>
```

**Purpose**: This function writes the session's config lock to a file when config-lock exporting has been enabled. It gives users or tooling a durable record of the exact resolved settings for a conversation.

**Data flow**: It receives a SessionConfiguration and a conversation ThreadId. It reads the export directory from the original config; if none is set, it exits successfully. If exporting is enabled, it builds the lockfile, converts it into pretty TOML text, creates the export directory if needed, and writes a file named after the conversation id.

**Call relations**: This function uses SessionConfiguration::to_config_lockfile_toml to create the lock, then relies on TOML serialization and async filesystem calls to create the directory and write the file. It is the outward-facing export path for the lock-building logic in this file.

*Call graph*: 5 external calls (to_config_lockfile_toml, format!, create_dir_all, write, to_string_pretty).


##### `SessionConfiguration::to_config_lockfile_toml`  (lines 72–76)

```
fn to_config_lockfile_toml(&self) -> anyhow::Result<ConfigLockfileToml>
```

**Purpose**: This method converts a live SessionConfiguration into the structured TOML object used for config lock files. It is the common entry point for both validation and export.

**Data flow**: It reads the SessionConfiguration, asks session_configuration_to_lock_config_toml to produce the cleaned resolved configuration, then wraps that configuration with config-lock metadata such as the lock format version. The result is a ConfigLockfileToml or an error if conversion fails.

**Call relations**: Both validate_config_lock_if_configured and export_config_lock_if_configured call this method before comparing or writing a lock. Internally, it delegates the detailed field selection to session_configuration_to_lock_config_toml, then hands the result to config_lockfile for final packaging.

*Call graph*: calls 2 internal fn (config_lockfile, session_configuration_to_lock_config_toml).


##### `session_configuration_to_lock_config_toml`  (lines 79–100)

```
fn session_configuration_to_lock_config_toml(
    sc: &SessionConfiguration,
) -> anyhow::Result<ConfigToml>
```

**Purpose**: This function builds the actual configuration section that will go inside a config lock. It records the resolved behavior Codex ran with, while removing input-only details that should not affect replay comparison.

**Data flow**: It starts with the effective configuration produced by the original config's layer stack. If configured to do so, it copies session-resolved values such as model and prompts from the live SessionConfiguration. It always saves additional resolved Config fields, then drops profile, debug, file-include, sandbox, and permission inputs that are not meant to be locked. The output is a cleaned ConfigToml.

**Call relations**: SessionConfiguration::to_config_lockfile_toml calls this function as the main conversion step. This function coordinates three helpers: save_session_resolved_fields for values known only after session setup, save_config_resolved_fields for normalized config values, and drop_lockfile_inputs for removing non-replayable inputs.

*Call graph*: calls 3 internal fn (drop_lockfile_inputs, save_config_resolved_fields, save_session_resolved_fields); called by 1 (to_config_lockfile_toml).


##### `save_session_resolved_fields`  (lines 107–118)

```
fn save_session_resolved_fields(sc: &SessionConfiguration, lock_config: &mut ConfigToml)
```

**Purpose**: This function copies session-time choices into the lock when the lock should be fully self-contained. These are values that may not appear directly in the original TOML files but still affect how the session behaves.

**Data flow**: It receives the live SessionConfiguration and a mutable ConfigToml being built for the lock. It writes in the selected model, reasoning settings, service tier, base and developer instructions, compact prompt, personality, approval policy, and approval reviewer. It changes the ConfigToml in place and returns nothing.

**Call relations**: session_configuration_to_lock_config_toml calls this only when the config says to save fields resolved from the model catalog. It supplies the session-specific parts of the lock before save_config_resolved_fields adds broader resolved config values.

*Call graph*: called by 1 (session_configuration_to_lock_config_toml).


##### `save_config_resolved_fields`  (lines 125–174)

```
fn save_config_resolved_fields(
    config: &Config,
    lock_config: &mut ConfigToml,
) -> anyhow::Result<()>
```

**Purpose**: This function records resolved settings that live on Config after defaults, normalization, feature expansion, and other higher-level setup. Its goal is to lock what Codex actually used, not just what a user typed.

**Data flow**: It receives the resolved Config and a mutable ConfigToml. It writes values such as web search mode, model provider, reasoning effort, verbosity, instruction-inclusion flags, environment context, terminal timeout, feature states, multi-agent settings, memories, agent limits, and skill instruction settings. Some complex values are converted back into their TOML form through resolved_config_to_toml. The ConfigToml is updated in place, and errors are returned if conversion fails.

**Call relations**: session_configuration_to_lock_config_toml calls this after optionally saving session-resolved fields. This function uses resolved_config_to_toml for complex nested config objects and makes sure feature aliases become explicit feature states so replay comparison is stable.

*Call graph*: calls 1 internal fn (resolved_config_to_toml); called by 1 (session_configuration_to_lock_config_toml); 1 external calls (Config).


##### `drop_lockfile_inputs`  (lines 176–191)

```
fn drop_lockfile_inputs(lock_config: &mut ConfigToml)
```

**Purpose**: This function removes settings that are inputs to configuration resolution rather than final replayable results. It keeps the lock focused on behavior, not on the path taken to produce that behavior.

**Data flow**: It receives a mutable ConfigToml. It clears profile data, debug config-lock controls, instruction file paths, model catalog input paths, sandbox and permission inputs, and a legacy experimental tool flag. The same ConfigToml comes out changed in place.

**Call relations**: session_configuration_to_lock_config_toml calls this as the final cleanup step before returning the lock configuration. It also calls clear_config_lock_debug_controls so debug-only controls do not become part of the replay contract.

*Call graph*: calls 1 internal fn (clear_config_lock_debug_controls); called by 1 (session_configuration_to_lock_config_toml).


##### `resolved_config_to_toml`  (lines 193–201)

```
fn resolved_config_to_toml(
    value: &impl serde::Serialize,
    label: &'static str,
) -> anyhow::Result<Toml>
```

**Purpose**: This helper converts an already-resolved Rust config value back into the matching TOML-shaped type. It is used when the lock needs to store complex nested settings in the same shape a config file would use.

**Data flow**: It receives a serializable value and a label used for error messages. It performs a TOML round trip, meaning it serializes the value and deserializes it into the requested TOML type. It returns the TOML-shaped value or an error if the conversion fails.

**Call relations**: save_config_resolved_fields calls this for nested settings such as multi-agent configuration and memories. The helper delegates the actual conversion to toml_round_trip and wraps any failure as an anyhow error for the caller.

*Call graph*: calls 1 internal fn (toml_round_trip); called by 1 (save_config_resolved_fields).


##### `tests::lock_contains_prompts_and_materializes_features`  (lines 210–277)

```
async fn lock_contains_prompts_and_materializes_features()
```

**Purpose**: This test checks that a generated config lock includes important resolved prompt and model values, and that feature settings are written explicitly. It protects against locks that look valid but omit behavior-changing details.

**Data flow**: It creates a test session configuration, changes the resolved base instructions, developer instructions, and compact prompt, then builds a lockfile. It inspects the lock and asserts that prompts, model fields, cleaned profile/debug inputs, memories, all feature states, and the lockfile version are present or absent as expected.

**Call relations**: The test calls make_session_configuration_for_tests to get a realistic session and then exercises SessionConfiguration::to_config_lockfile_toml through the public method. Its assertions cover work done by save_session_resolved_fields, save_config_resolved_fields, and drop_lockfile_inputs.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (assert!, assert_eq!).


##### `tests::lock_skips_session_values_when_model_catalog_fields_are_not_saved`  (lines 280–303)

```
async fn lock_skips_session_values_when_model_catalog_fields_are_not_saved()
```

**Purpose**: This test verifies that model-catalog-derived session values are not written into the lock when that option is disabled. It confirms the export behavior can be intentionally less self-contained.

**Data flow**: It creates a test session configuration, clones and modifies its original config so config_lock_save_fields_resolved_from_model_catalog is false, then fills in session-only values such as prompts and service tier. After building the lockfile, it checks that those session-derived fields remain absent.

**Call relations**: The test reaches the conversion path through SessionConfiguration::to_config_lockfile_toml. It specifically checks the branch in session_configuration_to_lock_config_toml that decides whether save_session_resolved_fields should run.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (new, assert_eq!).


##### `tests::lock_validation_reports_config_diff`  (lines 306–321)

```
async fn lock_validation_reports_config_diff()
```

**Purpose**: This test checks that validation reports a useful error when the replayed configuration differs from the expected lock. It ensures real drift is not silently accepted.

**Data flow**: It creates a test session, builds an expected lock, clones it into an actual lock, then changes the actual model field. It calls validate_config_lock_replay and expects an error whose message mentions that the effective config does not match and points to the model field.

**Call relations**: Rather than going through validate_config_lock_if_configured, this test calls validate_config_lock_replay directly to focus on comparison behavior. It uses a lock produced by SessionConfiguration::to_config_lockfile_toml as the realistic baseline.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests); 2 external calls (assert!, default).


##### `tests::lock_validation_ignores_removed_apps_mcp_path_override`  (lines 324–347)

```
async fn lock_validation_ignores_removed_apps_mcp_path_override()
```

**Purpose**: This test confirms that validation tolerates an old or removed compatibility input called apps_mcp_path_override. It prevents older lockfiles from failing just because that input is no longer part of the current lock output.

**Data flow**: It creates a test lock, turns it into a TOML value, manually inserts the removed apps_mcp_path_override feature entry into the expected lock, converts that value back into a ConfigLockfileToml, and compares it with the current actual lock. The expected result is successful validation.

**Call relations**: The test uses SessionConfiguration::to_config_lockfile_toml to create the current lock and validate_config_lock_replay to check compatibility behavior. It exercises the comparison layer's ability to ignore a known removed input.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests); 6 external calls (default, from_iter, Boolean, String, Table, try_from).


##### `tests::lock_validation_rejects_codex_version_mismatch_by_default`  (lines 350–368)

```
async fn lock_validation_rejects_codex_version_mismatch_by_default()
```

**Purpose**: This test checks that config-lock validation normally rejects a lock made by a different Codex version. That protects users from assuming a replay is identical when the program version itself may have changed behavior.

**Data flow**: It creates a test session, builds an expected lock, changes its codex_version to an older value, then builds a fresh actual lock. It calls validate_config_lock_replay with default options and expects an error that mentions the version mismatch and the debug option for allowing it.

**Call relations**: The test calls validate_config_lock_replay directly with default replay options. It uses SessionConfiguration::to_config_lockfile_toml to create both sides of the comparison before deliberately changing the expected version.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests); 2 external calls (assert!, default).


##### `tests::lock_validation_can_ignore_codex_version_mismatch`  (lines 371–385)

```
async fn lock_validation_can_ignore_codex_version_mismatch()
```

**Purpose**: This test verifies the opt-in escape hatch for Codex version mismatches. It shows that version drift can be allowed when the caller explicitly chooses that policy.

**Data flow**: It creates a test session, builds an expected lock, changes its codex_version, and builds a fresh actual lock. It then calls validate_config_lock_replay with allow_codex_version_mismatch set to true, and expects validation to succeed.

**Call relations**: The test focuses on validate_config_lock_replay's option handling. It uses SessionConfiguration::to_config_lockfile_toml for realistic lock data, then confirms that the replay option overrides the default version check.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests).


### `tui/src/debug_config.rs`

`domain_logic` · `request handling when /debug-config is displayed`

This file is a diagnostic window into the app’s configuration. In this project, settings can come from several places: system files, user files, project files, command-line or session flags, mobile-device-management style enterprise policy, and cloud-managed enterprise policy. Those layers can override each other, so when behavior is surprising, users and developers need a clear “receipt” showing where each rule came from.

The main job here is to turn the configuration stack into readable lines for the terminal user interface. It lists every layer from weakest to strongest, including disabled layers and the reason they were disabled. Then it lists requirements, which are rules that restrict what settings are allowed, such as sandbox modes, approval policies, web search modes, managed hooks, network limits, filesystem read blocks, and residency requirements.

The file also adds current session runtime details when a network proxy is active. That is important because proxy environment variables affect how subprocesses connect to the network.

Most helper functions are small translators. They turn internal values like `SandboxModeRequirement::ReadOnly` into plain strings like `read-only`, flatten nested TOML settings into `a.b = value` lines, or join empty lists as `<empty>` so the debug output stays unambiguous.

#### Function details

##### `new_debug_config_output`  (lines 25–55)

```
fn new_debug_config_output(
    config: &Config,
    session_network_proxy: Option<&SessionNetworkProxyRuntime>,
) -> PlainHistoryCell
```

**Purpose**: Builds the complete history cell shown for `/debug-config` in the terminal UI. It combines configuration-layer information with optional session network proxy details.

**Data flow**: It receives the current `Config` and, if present, the session network proxy runtime. It asks the renderer to produce the main debug lines, appends proxy environment variable lines when a proxy exists, then wraps everything in a `PlainHistoryCell` for display.

**Call relations**: This is the public entry point for this file’s production behavior. `add_debug_config_output` calls it when the user asks for debug configuration output; it then delegates most formatting to `render_debug_config_lines` and uses `session_all_proxy_url` for the proxy line.

*Call graph*: calls 3 internal fn (render_debug_config_lines, session_all_proxy_url, new); called by 1 (add_debug_config_output); 1 external calls (format!).


##### `sandbox_mode_is_allowed_by_permissions`  (lines 57–73)

```
fn sandbox_mode_is_allowed_by_permissions(
    permissions: &Permissions,
    mode: SandboxModeRequirement,
) -> bool
```

**Purpose**: Checks whether a sandbox mode is actually allowed under the current permission rules. This prevents the debug output from claiming that a mode is available when another permission restriction blocks it.

**Data flow**: It receives the current permissions and one sandbox-mode requirement. It converts that mode into the matching permission profile, asks the permissions object whether that profile can be set, and returns `true` only if the check succeeds.

**Call relations**: It is used as the filtering rule passed into `render_debug_config_lines` from `new_debug_config_output`. The tests also call it to prove that blocked sandbox modes are hidden from the rendered output.

*Call graph*: calls 3 internal fn (can_set_permission_profile, read_only, workspace_write).


##### `session_all_proxy_url`  (lines 75–81)

```
fn session_all_proxy_url(http_addr: &str, socks_addr: &str, socks_enabled: bool) -> String
```

**Purpose**: Chooses the correct URL for the `ALL_PROXY` environment variable. It uses SOCKS when SOCKS proxying is enabled, otherwise it falls back to HTTP.

**Data flow**: It receives an HTTP address, a SOCKS address, and a yes/no flag. If the flag is true it returns a `socks5h://...` URL; otherwise it returns an `http://...` URL.

**Call relations**: It is called by `new_debug_config_output` while adding session proxy details. Two focused tests check both branches so the displayed proxy instructions stay reliable.

*Call graph*: called by 1 (new_debug_config_output); 1 external calls (format!).


##### `render_debug_config_lines`  (lines 83–305)

```
fn render_debug_config_lines(
    stack: &ConfigLayerStack,
    sandbox_mode_is_effectively_allowed: impl Fn(SandboxModeRequirement) -> bool,
) -> Vec<Line<'static>>
```

**Purpose**: Creates the main list of terminal lines for the `/debug-config` display. It shows configuration layers first, then the requirements that restrict allowed settings.

**Data flow**: It receives a configuration layer stack and a function that says whether each sandbox mode is effectively allowed. It reads the stack layers, requirement values, and requirement sources, formats each visible item into human-readable terminal lines, and returns the full list.

**Call relations**: This is the central formatter. `new_debug_config_output` calls it for real UI output, while test helpers call it to compare rendered text. It calls many smaller helpers so each kind of value, such as hooks, residency, web search, or network rules, is formatted consistently.

*Call graph*: calls 10 internal fn (get_layers, requirements, requirements_toml, format_managed_hooks_requirements, format_network_constraints, format_residency_requirement, join_or_empty, normalize_allowed_web_search_modes, render_non_file_layer_details, requirement_line); called by 2 (new_debug_config_output, render_stack_to_text_with_sandbox_mode_filter); 4 external calls (new, format_config_layer_source, format!, vec!).


##### `render_non_file_layer_details`  (lines 307–318)

```
fn render_non_file_layer_details(layer: &ConfigLayerEntry) -> Vec<Line<'static>>
```

**Purpose**: Adds extra detail for configuration layers that do not come from normal config files. This matters because session flags and managed policies would otherwise appear only as names, not as useful values.

**Data flow**: It receives one configuration layer. If the layer is session flags, it flattens and prints those flags. If it is enterprise or MDM managed configuration, it prints the raw managed value. For ordinary file-backed layers, it returns no extra lines.

**Call relations**: It is called while `render_debug_config_lines` is listing the stack. It hands session-flag layers to `render_session_flag_details` and managed layers to `render_non_file_layer_value`.

*Call graph*: calls 2 internal fn (render_non_file_layer_value, render_session_flag_details); called by 1 (render_debug_config_lines); 1 external calls (new).


##### `render_session_flag_details`  (lines 320–332)

```
fn render_session_flag_details(config: &TomlValue) -> Vec<Line<'static>>
```

**Purpose**: Turns session flag TOML into simple key-value lines. Session flags are temporary settings for the current run, so showing them plainly helps explain why this session behaves differently.

**Data flow**: It receives a TOML value, flattens nested tables into dotted keys, and returns one display line per key-value pair. If there are no flags, it returns a dimmed `<none>` line.

**Call relations**: It is called by `render_non_file_layer_details` for the `SessionFlags` layer. It relies on `flatten_toml_key_values` to walk through nested TOML data.

*Call graph*: calls 1 internal fn (flatten_toml_key_values); called by 1 (render_non_file_layer_details); 2 external calls (new, vec!).


##### `format_managed_hooks_requirements`  (lines 334–349)

```
fn format_managed_hooks_requirements(hooks: &ManagedHooksRequirementsToml) -> String
```

**Purpose**: Summarizes managed hook requirements in one compact string. Hooks are configured commands that can run around tool use, so the debug output shows where managed hooks live and how many handlers are required.

**Data flow**: It receives managed hook requirements. It collects the managed directory paths when present, counts hook handlers, joins those parts with commas, and returns the summary string.

**Call relations**: It is called by `render_debug_config_lines` when the requirements include hooks. It uses `join_or_empty` so even an empty summary has a clear printed value.

*Call graph*: calls 1 internal fn (join_or_empty); called by 1 (render_debug_config_lines); 2 external calls (new, format!).


##### `render_non_file_layer_value`  (lines 351–368)

```
fn render_non_file_layer_value(layer: &ConfigLayerEntry) -> Vec<Line<'static>>
```

**Purpose**: Formats the value of an enterprise-managed or MDM-managed configuration layer. This lets people see the actual managed configuration text that influenced the app.

**Data flow**: It receives a configuration layer, chooses a label for the source, then prefers the layer’s raw TOML text if available. It returns either a single line, an `<empty>` line, or several indented lines for multi-line TOML.

**Call relations**: It is called by `render_non_file_layer_details` for managed non-file layers. It uses `non_file_layer_value_label` to choose wording that matches the source type.

*Call graph*: calls 2 internal fn (raw_toml, non_file_layer_value_label); called by 1 (render_non_file_layer_details); 1 external calls (vec!).


##### `non_file_layer_value_label`  (lines 370–382)

```
fn non_file_layer_value_label(source: &ConfigLayerSource) -> &'static str
```

**Purpose**: Chooses the human-readable label for a non-file configuration value. For example, it distinguishes MDM values from enterprise-managed cloud values.

**Data flow**: It receives a configuration layer source and returns a fixed label string such as `MDM value` or `Enterprise-managed config value`.

**Call relations**: It is called by `render_non_file_layer_value` right before the managed value is printed.

*Call graph*: called by 1 (render_non_file_layer_value).


##### `flatten_toml_key_values`  (lines 384–407)

```
fn flatten_toml_key_values(
    value: &TomlValue,
    prefix: Option<&str>,
    out: &mut Vec<(String, String)>,
)
```

**Purpose**: Walks through nested TOML data and turns it into flat dotted key-value pairs. This makes deeply nested session flags easier to read in a terminal list.

**Data flow**: It receives a TOML value, an optional current key prefix, and an output list to fill. Tables are visited in sorted key order; non-table values are formatted and pushed into the output list.

**Call relations**: It is called by `render_session_flag_details`. It calls `format_toml_value` when it reaches an actual value instead of another table.

*Call graph*: calls 1 internal fn (format_toml_value); called by 1 (render_session_flag_details); 1 external calls (format!).


##### `format_toml_value`  (lines 409–411)

```
fn format_toml_value(value: &TomlValue) -> String
```

**Purpose**: Converts a TOML value into the text form shown in debug output. It keeps the display consistent with TOML’s own formatting rules.

**Data flow**: It receives a TOML value and returns that value’s string representation.

**Call relations**: It is called while flattening session flags and when rendering managed layer values without raw TOML text.

*Call graph*: called by 1 (flatten_toml_key_values); 1 external calls (to_string).


##### `requirement_line`  (lines 413–422)

```
fn requirement_line(
    name: &str,
    value: String,
    source: Option<&RequirementSource>,
) -> Line<'static>
```

**Purpose**: Builds one standard line for a requirement. It keeps requirement output consistent by always showing the name, value, and source.

**Data flow**: It receives a requirement name, its already-formatted value, and an optional source. It uses the source text when available or `<unspecified>` otherwise, then returns a terminal line.

**Call relations**: It is called many times by `render_debug_config_lines`, once for each requirement that should be displayed.

*Call graph*: called by 1 (render_debug_config_lines); 1 external calls (format!).


##### `join_or_empty`  (lines 424–430)

```
fn join_or_empty(values: Vec<String>) -> String
```

**Purpose**: Joins a list of strings for display, while making empty lists explicit. This avoids confusing blank output when a requirement intentionally allows nothing.

**Data flow**: It receives a list of strings. If the list is empty it returns `<empty>`; otherwise it returns the strings separated by commas.

**Call relations**: It is used by the main debug renderer and by helper formatters such as managed hooks and network constraints.

*Call graph*: called by 3 (format_managed_hooks_requirements, format_network_constraints, render_debug_config_lines).


##### `normalize_allowed_web_search_modes`  (lines 432–444)

```
fn normalize_allowed_web_search_modes(
    modes: &[WebSearchModeRequirement],
) -> Vec<WebSearchModeRequirement>
```

**Purpose**: Normalizes the allowed web search modes before printing them. It makes sure disabled web search is represented correctly in the displayed requirement.

**Data flow**: It receives a slice of web search mode requirements. If the slice is empty, it returns a list containing only `Disabled`; otherwise it copies the modes and adds `Disabled` if it was missing.

**Call relations**: It is called by `render_debug_config_lines` before web search requirements are converted to text. A test covers the empty-list case.

*Call graph*: called by 1 (render_debug_config_lines); 3 external calls (is_empty, to_vec, vec!).


##### `format_sandbox_mode_requirement`  (lines 446–453)

```
fn format_sandbox_mode_requirement(mode: SandboxModeRequirement) -> String
```

**Purpose**: Turns an internal sandbox-mode requirement into the short string users see. The sandbox is the safety boundary that limits what the app can do.

**Data flow**: It receives one sandbox mode and returns names such as `read-only`, `workspace-write`, `danger-full-access`, or `external-sandbox`.

**Call relations**: It is used by `render_debug_config_lines` while printing allowed sandbox modes.


##### `format_residency_requirement`  (lines 455–459)

```
fn format_residency_requirement(requirement: ResidencyRequirement) -> String
```

**Purpose**: Turns a data residency requirement into display text. Residency requirements say where data is allowed to be processed or stored.

**Data flow**: It receives one residency requirement and returns its short printed form, currently `us` for the United States requirement.

**Call relations**: It is called by `render_debug_config_lines` when an `enforce_residency` requirement is present.

*Call graph*: called by 1 (render_debug_config_lines).


##### `format_network_constraints`  (lines 461–524)

```
fn format_network_constraints(network: &NetworkConstraints) -> String
```

**Purpose**: Summarizes network restrictions in one readable string. These restrictions explain what network behavior is allowed, such as ports, domains, Unix sockets, and proxy rules.

**Data flow**: It receives network constraints. For each field that is present, it adds a `name=value` part, formats domain and Unix socket permission maps, then joins all parts or returns `<empty>`.

**Call relations**: It is called by `render_debug_config_lines` when network requirements exist. It uses shared joining behavior and specialized permission formatting helpers for nested allow/deny maps.

*Call graph*: calls 1 internal fn (join_or_empty); called by 1 (render_debug_config_lines); 2 external calls (new, format!).


##### `format_network_permission_entries`  (lines 526–535)

```
fn format_network_permission_entries(
    entries: &std::collections::BTreeMap<String, T>,
    format_value: impl Fn(T) -> &'static str,
) -> String
```

**Purpose**: Formats a map of network permission entries as `{key=value, ...}`. It is a small reusable helper for domain and Unix socket allow/deny lists.

**Data flow**: It receives a sorted map from names to permission values plus a function that converts each permission into text. It builds one `key=permission` part per entry and returns them inside braces.

**Call relations**: It supports network-constraint formatting, where both domain permissions and Unix socket permissions need the same map-shaped display.

*Call graph*: 1 external calls (format!).


##### `format_network_domain_permission`  (lines 537–542)

```
fn format_network_domain_permission(permission: NetworkDomainPermissionToml) -> &'static str
```

**Purpose**: Converts a domain network permission into `allow` or `deny`. This is used for rules about hostnames such as `example.com`.

**Data flow**: It receives a domain permission enum and returns the matching static text.

**Call relations**: It is used as the value formatter when domain permission entries are displayed inside network constraints.


##### `format_network_unix_socket_permission`  (lines 544–551)

```
fn format_network_unix_socket_permission(
    permission: NetworkUnixSocketPermissionToml,
) -> &'static str
```

**Purpose**: Converts a Unix socket network permission into `allow` or `deny`. A Unix socket is a local file-like endpoint that programs can use to communicate on Unix-style systems.

**Data flow**: It receives a Unix socket permission enum and returns the matching static text.

**Call relations**: It is used as the value formatter when Unix socket permission entries are displayed inside network constraints.


##### `tests::empty_toml_table`  (lines 595–597)

```
fn empty_toml_table() -> TomlValue
```

**Purpose**: Creates an empty TOML table for tests. This keeps test setup short when a configuration layer needs a valid but blank TOML value.

**Data flow**: It takes no input, creates a new empty TOML table, and returns it as a TOML value.

**Call relations**: Several tests call it while constructing sample configuration layers for the debug renderer.

*Call graph*: 2 external calls (Table, new).


##### `tests::absolute_path`  (lines 599–601)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute path object from a string during tests. This helps tests create realistic config-file paths on different operating systems.

**Data flow**: It receives a path string, validates it as absolute, and returns the project’s absolute-path type. If the path is not absolute, the test fails immediately.

**Call relations**: Tests call it when they need system, user, project, or managed-configuration paths.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `tests::render_to_text`  (lines 603–614)

```
fn render_to_text(lines: &[Line<'static>]) -> String
```

**Purpose**: Converts styled terminal lines into plain text for assertions. Tests do not care about colors or bold text, only the visible words.

**Data flow**: It receives rendered `Line` values, pulls out each span’s text content, joins spans into lines, then joins lines with newline characters.

**Call relations**: It is used by `tests::render_stack_to_text_with_sandbox_mode_filter` after the production renderer creates styled lines.

*Call graph*: 1 external calls (iter).


##### `tests::render_stack_to_text`  (lines 616–618)

```
fn render_stack_to_text(stack: &ConfigLayerStack) -> String
```

**Purpose**: Renders a configuration stack to plain text for tests using a sandbox filter that allows every mode. It is the common shortcut for most renderer tests.

**Data flow**: It receives a configuration stack, passes it to the more flexible test helper with an always-true sandbox filter, and returns the plain text output.

**Call relations**: Many tests call this helper when they do not need to simulate sandbox modes being blocked.

*Call graph*: 1 external calls (render_stack_to_text_with_sandbox_mode_filter).


##### `tests::render_stack_to_text_with_sandbox_mode_filter`  (lines 620–628)

```
fn render_stack_to_text_with_sandbox_mode_filter(
        stack: &ConfigLayerStack,
        sandbox_mode_is_effectively_allowed: impl Fn(SandboxModeRequirement) -> bool,
    ) -> String
```

**Purpose**: Renders a configuration stack to plain text while letting a test control which sandbox modes are considered allowed. This makes it possible to test filtering behavior.

**Data flow**: It receives a stack and a sandbox-mode filter function. It calls the production `render_debug_config_lines`, then converts the styled lines to plain text.

**Call relations**: It is called by `tests::render_stack_to_text` and by the test that checks sandbox modes blocked by filesystem restrictions.

*Call graph*: calls 1 internal fn (render_debug_config_lines); 1 external calls (render_to_text).


##### `tests::debug_config_output_lists_all_layers_including_disabled`  (lines 631–669)

```
fn debug_config_output_lists_all_layers_including_disabled()
```

**Purpose**: Checks that the debug output shows every configuration layer, including disabled ones. It also verifies that disabled layers show their reason.

**Data flow**: It builds a stack with one enabled system layer and one disabled project layer, renders it, and asserts that enabled, disabled, reason, and empty requirements text appear.

**Call relations**: This test exercises the layer-listing branch of `render_debug_config_lines` through the test render helper.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, assert!, cfg!, default, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_lists_requirement_sources`  (lines 672–868)

```
fn debug_config_output_lists_requirement_sources()
```

**Purpose**: Checks that many different requirement types are printed with the correct source. This protects the main diagnostic value of `/debug-config`: explaining where restrictions came from.

**Data flow**: It builds a rich set of requirements, including approvals, sandbox modes, web search, managed features, network rules, filesystem read denial, and residency. It renders the stack and asserts that the expected text and sources appear.

**Call relations**: This broad test drives `render_debug_config_lines` through most requirement-formatting paths and indirectly covers many helper formatters.

*Call graph*: calls 5 internal fn (new, new, allow_any, new, read_only); 9 external calls (from, default, default, assert!, cfg!, assert_snapshot!, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_filters_sandbox_modes_blocked_by_deny_read_requirements`  (lines 871–955)

```
fn debug_config_output_filters_sandbox_modes_blocked_by_deny_read_requirements()
```

**Purpose**: Checks that sandbox modes blocked by effective permissions are not shown as available. This prevents misleading debug output when extra filesystem restrictions narrow what is really allowed.

**Data flow**: It creates requirements that list several sandbox modes, then creates permissions that allow only some of them. It renders with a filter based on `sandbox_mode_is_allowed_by_permissions` and asserts that blocked modes are absent.

**Call relations**: This test connects the permission-check helper with `render_debug_config_lines`, matching the same pattern used by `new_debug_config_output`.

*Call graph*: calls 7 internal fn (new, new, allow_any, new, new, from_approval_and_profile, read_only); 9 external calls (new, default, assert!, cfg!, default, assert_snapshot!, absolute_path, render_stack_to_text_with_sandbox_mode_filter, vec!).


##### `tests::debug_config_output_lists_approvals_reviewer_as_requirement`  (lines 958–978)

```
fn debug_config_output_lists_approvals_reviewer_as_requirement()
```

**Purpose**: Checks that approvals reviewer requirements appear in the debug output. An approvals reviewer decides who or what reviews approval requests.

**Data flow**: It builds requirements containing an auto-reviewer setting, renders the stack, and asserts that the reviewer line appears and the requirements section is not empty.

**Call relations**: This test targets the approvals-reviewer branch inside `render_debug_config_lines`.

*Call graph*: calls 3 internal fn (new, allow_any, new); 6 external calls (new, default, assert!, default, render_stack_to_text, vec!).


##### `tests::debug_config_output_formats_unix_socket_permissions`  (lines 981–1013)

```
fn debug_config_output_formats_unix_socket_permissions()
```

**Purpose**: Checks that Unix socket network permissions are printed clearly as allow and deny entries. This matters because socket rules are easy to miss if they are not displayed explicitly.

**Data flow**: It builds network constraints with one allowed and one denied socket path, renders the stack, and asserts that both entries appear in the expected order and format.

**Call relations**: This test exercises the network formatting path, including Unix socket permission formatting.

*Call graph*: calls 2 internal fn (new, new); 7 external calls (from, default, new, default, assert!, default, render_stack_to_text).


##### `tests::debug_config_output_lists_session_flag_key_value_pairs`  (lines 1016–1043)

```
fn debug_config_output_lists_session_flag_key_value_pairs()
```

**Purpose**: Checks that session flags are shown as flattened key-value pairs. This confirms that nested temporary settings are visible in the debug output.

**Data flow**: It parses sample TOML session flags with both top-level and nested values, renders the stack, and asserts that dotted keys and values appear.

**Call relations**: This test covers `render_non_file_layer_details`, `render_session_flag_details`, and `flatten_toml_key_values` through the main stack renderer.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert!, default, render_stack_to_text, vec!).


##### `tests::debug_config_output_shows_legacy_mdm_layer_value`  (lines 1046–1077)

```
fn debug_config_output_shows_legacy_mdm_layer_value()
```

**Purpose**: Checks that legacy MDM-managed configuration is shown with its raw TOML content. MDM means mobile device management, a common way for organizations to enforce settings.

**Data flow**: It builds a managed layer with raw TOML text, renders the stack, and asserts that the MDM label and original TOML lines appear.

**Call relations**: This test exercises the managed non-file layer rendering path through `render_non_file_layer_value`.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, assert!, cfg!, default, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_shows_enterprise_managed_layer_value`  (lines 1080–1115)

```
fn debug_config_output_shows_enterprise_managed_layer_value()
```

**Purpose**: Checks that cloud or enterprise-managed configuration is labeled separately from MDM configuration. This helps users identify which management system supplied a policy.

**Data flow**: It builds an enterprise-managed layer with raw TOML text, renders the stack, and asserts that the enterprise label appears, the MDM label does not, and the raw TOML is preserved.

**Call relations**: This test covers label selection in `non_file_layer_value_label` and multi-line managed value rendering.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, assert!, cfg!, default, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_normalizes_empty_web_search_mode_list`  (lines 1118–1160)

```
fn debug_config_output_normalizes_empty_web_search_mode_list()
```

**Purpose**: Checks that an empty allowed web search list is displayed as `disabled`. This makes an intentionally empty allowance readable instead of looking like missing output.

**Data flow**: It builds requirements with an empty web search mode list, renders the stack, and asserts that the output says `disabled` with the correct source.

**Call relations**: This test directly protects the behavior in `normalize_allowed_web_search_modes` as used by `render_debug_config_lines`.

*Call graph*: calls 3 internal fn (new, allow_any, new); 4 external calls (new, default, assert!, render_stack_to_text).


##### `tests::debug_config_output_lists_managed_hooks_requirement`  (lines 1163–1206)

```
fn debug_config_output_lists_managed_hooks_requirement()
```

**Purpose**: Checks that managed hook requirements are summarized in the output. It especially verifies that hook handler counts are visible.

**Data flow**: It builds managed hook requirements with directories and one command handler, renders the stack, and asserts that hook text, handler count, and source appear.

**Call relations**: This test exercises `format_managed_hooks_requirements` through the main renderer.

*Call graph*: calls 3 internal fn (new, allow_any, new); 9 external calls (default, new, default, assert!, cfg!, default, from, render_stack_to_text, vec!).


##### `tests::session_all_proxy_url_uses_socks_when_enabled`  (lines 1209–1218)

```
fn session_all_proxy_url_uses_socks_when_enabled()
```

**Purpose**: Checks that SOCKS proxying wins when SOCKS support is enabled. This protects the proxy environment variable shown to users.

**Data flow**: It passes HTTP and SOCKS addresses with the SOCKS flag set to true, then asserts that the returned URL uses the `socks5h://` scheme and SOCKS address.

**Call relations**: This is a focused test for the true branch of `session_all_proxy_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_all_proxy_url_uses_http_when_socks_disabled`  (lines 1221–1230)

```
fn session_all_proxy_url_uses_http_when_socks_disabled()
```

**Purpose**: Checks that HTTP proxying is used when SOCKS support is disabled. This protects the fallback proxy behavior shown in `/debug-config`.

**Data flow**: It passes HTTP and SOCKS addresses with the SOCKS flag set to false, then asserts that the returned URL uses the `http://` scheme and HTTP address.

**Call relations**: This is a focused test for the false branch of `session_all_proxy_url`.

*Call graph*: 1 external calls (assert_eq!).


### Permission profile resolution
These files define the TOML-facing permission syntax, compile it into canonical runtime profiles, preserve resolved identities, and adapt them for compatibility and UI warnings.

### `config/src/permissions_toml.rs`

`config` · `config load`

This file is the bridge between human-written permission profiles and the stricter settings the program actually uses while running. A TOML file is a plain text configuration format; this code describes what keys are allowed, how they are read, and how profile inheritance works when one profile extends another. Without this file, the system could not reliably turn a permissions file into clear rules like “this domain is allowed,” “this folder is readable,” or “inject this secret header into matching network requests.”

The main shape is `PermissionsToml`, a map of named permission profiles. Each profile can describe workspace roots, filesystem rules, and network rules. Profiles can extend parent profiles, much like copying a recipe and then changing a few ingredients. The resolver walks up the parent chain, checks for missing parents or loops, then merges parent settings before child settings so the child wins on conflicts.

Network settings are the largest part. They can enable or restrict networking, list allowed or denied domains, allow Unix socket paths, and configure MITM hooks. Here, “MITM” means the proxy can inspect or alter matching requests, for example by stripping or injecting headers. The file also validates that hook actions are meaningful and that hooks do not point at actions that do not exist.

#### Function details

##### `PermissionsToml::is_empty`  (lines 29–31)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the permissions file contains any named profiles. This is useful when code needs to know if there is anything to apply at all.

**Data flow**: It reads the profile map inside `PermissionsToml` and asks whether that map has no entries. It returns `true` for an empty configuration and `false` when at least one profile is present.

**Call relations**: This is a small query helper for code that has already parsed permissions. It does not call into other project logic; it simply reports whether the top-level profile collection has content.


##### `PermissionsToml::resolve_profile`  (lines 40–108)

```
fn resolve_profile(
        &self,
        profile_name: &str,
        mut parent_profile: F,
    ) -> Result<PermissionProfileToml, PermissionProfileResolutionError>
```

**Purpose**: Builds one complete permission profile from a named profile and all the profiles it extends. It also catches common configuration mistakes, such as missing parents or inheritance loops.

**Data flow**: It receives the profile name to load and a lookup function for parent profiles that may live outside this `PermissionsToml`. It walks from the selected profile to its parent, then that parent’s parent, collecting each one. If it finds a cycle, missing profile, or unsupported built-in parent, it returns a clear error. Otherwise it merges parents first and children after, returning the final combined profile.

**Call relations**: The broader config resolver calls this through `resolve_permission_profile` when it needs the usable version of a named profile. During the walk it may ask the supplied parent lookup for profiles not found locally, and at the end it hands each parent-child pair to `merge_permission_profiles` to combine them in the right order.

*Call graph*: called by 1 (resolve_permission_profile); 2 external calls (new, once).


##### `merge_permission_profiles`  (lines 158–191)

```
fn merge_permission_profiles(
    mut parent: PermissionProfileToml,
    mut child: PermissionProfileToml,
) -> Result<PermissionProfileToml, PermissionProfileResolutionError>
```

**Purpose**: Combines a parent permission profile with a child permission profile so the child can override or add to the parent’s settings. It preserves the selected child profile’s declaration metadata instead of letting inherited descriptions leak in.

**Data flow**: It receives two profile objects. Before merging, it clears the parent’s description and `extends` fields because those belong to the chosen profile, not the inherited one. If both profiles define network domains, it normalizes their host names so equivalent names merge correctly. It then converts both profiles into generic TOML values, overlays the child onto the parent, and converts the result back into a typed profile. Serialization or deserialization failures become profile resolution errors.

**Call relations**: This is the merging step used by `PermissionsToml::resolve_profile` after the inheritance chain is known. It relies on `normalize_profile_network_domains` for host-name cleanup and on `merge_toml_values` for the actual TOML overlay behavior.

*Call graph*: calls 2 internal fn (merge_toml_values, normalize_profile_network_domains); 1 external calls (try_from).


##### `normalize_profile_network_domains`  (lines 193–207)

```
fn normalize_profile_network_domains(profile: &mut PermissionProfileToml)
```

**Purpose**: Cleans up the domain names inside a profile’s network permissions before profiles are merged. This prevents the same host written in different forms from being treated as two unrelated rules.

**Data flow**: It receives a mutable permission profile. If the profile has network domain entries, it temporarily takes the map out, normalizes each domain pattern with `normalize_host`, and puts the cleaned map back. If there are no domain rules, it leaves the profile unchanged.

**Call relations**: It is called only by `merge_permission_profiles`, specifically when both parent and child contain domain rules. Its job is to prepare those maps so the later TOML merge combines matching hosts predictably.

*Call graph*: called by 1 (merge_permission_profiles); 1 external calls (take).


##### `WorkspaceRootsToml::enabled_roots`  (lines 216–220)

```
fn enabled_roots(&self) -> impl Iterator<Item = &String>
```

**Purpose**: Returns only the workspace root paths that are switched on. This lets later code ignore roots that are present in the file but explicitly disabled.

**Data flow**: It reads the map of root path strings to boolean enabled flags. It filters out entries set to `false` and yields references to the path strings whose flag is `true`.

**Call relations**: This is a convenience method for consumers of parsed workspace-root settings. It does not call other project code; it turns the raw map into the list that permission-building code usually wants.


##### `FilesystemPermissionsToml::is_empty`  (lines 234–236)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any filesystem permission rules were configured. This tells callers whether there are file access rules to apply.

**Data flow**: It reads the filesystem permission entries map and returns `true` if there are no path or pattern rules, otherwise `false`. The optional glob scan depth does not affect this answer.

**Call relations**: This helper is used by code that inspects parsed filesystem settings. It stands alone and does not delegate to other functions.


##### `NetworkDomainPermissionsToml::is_empty`  (lines 253–255)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any domain allow or deny rules were configured. It is a quick way to tell if network domain filtering has explicit entries.

**Data flow**: It looks at the domain permission map and returns `true` when the map is empty. If any domain pattern has an allow or deny rule, it returns `false`.

**Call relations**: This is a simple query on parsed network-domain configuration. It does not call other functions and is meant for later config application code.


##### `NetworkDomainPermissionsToml::allowed_domains`  (lines 257–265)

```
fn allowed_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Collects the domain patterns that are explicitly allowed. It gives callers a plain list when they only care about allow rules.

**Data flow**: It scans every domain entry, keeps only those whose permission is `allow`, clones their pattern strings, and returns them as a vector. If there are no allowed domains, it returns `None` instead of an empty list.

**Call relations**: This helper is used after TOML has been parsed, when another part of the system wants a compact allow-list. It works directly from the stored entries and does not call project-specific helpers.


##### `NetworkDomainPermissionsToml::denied_domains`  (lines 267–275)

```
fn denied_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Collects the domain patterns that are explicitly denied. It gives callers a plain list when they only care about block rules.

**Data flow**: It scans every domain entry, keeps only those whose permission is `deny`, clones their pattern strings, and returns them as a vector. If there are no denied domains, it returns `None` instead of an empty list.

**Call relations**: This is the deny-list counterpart to `allowed_domains`. It is a read-only helper for consumers of parsed network-domain settings.


##### `NetworkDomainPermissionToml::fmt`  (lines 288–294)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Turns a domain permission value into the text `allow` or `deny`. This is used when the value needs to be displayed or included in a message.

**Data flow**: It receives an `Allow` or `Deny` enum value, chooses the matching lowercase word, and writes that word into the formatter. The output is formatted text, not a changed permission.

**Call relations**: Rust’s display formatting calls this when code prints a `NetworkDomainPermissionToml`. It uses the formatter’s `write_str` method to hand back the chosen word.

*Call graph*: 1 external calls (write_str).


##### `NetworkUnixSocketPermissionsToml::is_empty`  (lines 304–306)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any Unix socket permission rules were configured. A Unix socket is a local communication path on Unix-like systems, often represented by a filesystem path.

**Data flow**: It reads the Unix socket permission map and returns `true` if no paths are listed. If any path has an allow or deny rule, it returns `false`.

**Call relations**: This is a simple inspection helper for parsed network settings. It does not call other project functions.


##### `NetworkUnixSocketPermissionsToml::allow_unix_sockets`  (lines 308–314)

```
fn allow_unix_sockets(&self) -> Vec<String>
```

**Purpose**: Returns the Unix socket paths that are explicitly allowed. This is useful when code needs the approved local socket paths without the denied ones.

**Data flow**: It scans the socket permission entries, keeps only paths marked `allow`, clones those path strings, and returns them in a vector. Denied paths are skipped.

**Call relations**: This helper sits on top of the parsed socket-permission map. It does not apply the rules itself; it prepares the allowed paths for later config or policy code.


##### `NetworkUnixSocketPermissionToml::fmt`  (lines 327–333)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Turns a Unix socket permission value into the text `allow` or `deny`. This supports clear display and error messages.

**Data flow**: It receives an `Allow` or `Deny` enum value, maps it to its lowercase word, and writes that word into the supplied formatter. The permission itself is not changed.

**Call relations**: Rust’s display formatting uses this method when a `NetworkUnixSocketPermissionToml` is printed. It hands the final text to the formatter through `write_str`.

*Call graph*: 1 external calls (write_str).


##### `NetworkMitmToml::deserialize`  (lines 414–426)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads the MITM network section from configuration and immediately checks that its action definitions are valid. This prevents invalid hook/action setups from silently entering the runtime config.

**Data flow**: It receives a Serde deserializer, first reads the raw `hooks` and `actions` fields into an unchecked temporary structure, then builds the real `NetworkMitmToml`. Before returning it, it runs validation. If validation fails, deserialization fails with a human-readable error.

**Call relations**: Serde calls this automatically when parsing a `NetworkMitmToml` from TOML. It delegates the safety check to `validate_action_definitions` before handing the parsed value back to the config loader.

*Call graph*: 1 external calls (deserialize).


##### `NetworkMitmToml::validate_action_definitions`  (lines 430–454)

```
fn validate_action_definitions(&self) -> Result<(), String>
```

**Purpose**: Checks that MITM actions and hooks are not empty in ways that would make them meaningless. It catches mistakes like defining an action with no operations or a hook with no actions to run.

**Data flow**: It reads the optional action map and rejects any action whose operation lists are both empty. It then reads the optional hook map and rejects any hook whose `action` list is empty. It returns `Ok` if everything has enough information, or an error string naming the bad config path.

**Call relations**: This validation runs during `NetworkMitmToml::deserialize` and is also the first step inside `validate_action_references`. It formats clear error messages so configuration loading can tell the user exactly what is wrong.

*Call graph*: called by 1 (validate_action_references); 1 external calls (format!).


##### `NetworkMitmToml::validate_action_references`  (lines 456–477)

```
fn validate_action_references(
        &self,
        actions_by_name: &IndexMap<String, NetworkMitmActionToml>,
    ) -> Result<(), String>
```

**Purpose**: Checks that every MITM hook names actions that actually exist. This prevents a hook from saying “run action X” when no action X was defined.

**Data flow**: It receives the full action map to check against. First it reruns the basic definition checks. Then, for each hook and each action name listed by that hook, it looks for the name in the action map. If a name is missing, it returns an error string that points to the hook and missing action; otherwise it returns success.

**Call relations**: Callers use this when actions may come from a combined or external action map. It builds on `validate_action_definitions`, then uses the supplied map as the source of truth for valid action names.

*Call graph*: calls 1 internal fn (validate_action_definitions); 2 external calls (contains_key, format!).


##### `NetworkMitmToml::to_runtime_hooks`  (lines 479–492)

```
fn to_runtime_hooks(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> Vec<MitmHookConfig>
```

**Purpose**: Converts parsed MITM hook configuration into the runtime hook objects used by the network proxy. This is the step where TOML-shaped data becomes proxy-shaped data.

**Data flow**: It reads the optional hook map. If there are hooks, it converts each hook into a `MitmHookConfig`, using the provided action map to expand action names into actual operations. If no hooks are configured, it returns an empty vector.

**Call relations**: Network settings call this while applying TOML config to `NetworkProxyConfig`. For each hook, it hands conversion work to `NetworkMitmHookToml::to_runtime`.


##### `NetworkMitmActionToml::is_empty`  (lines 496–498)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether an MITM action has no work to do. An action is empty if it neither strips request headers nor injects new ones.

**Data flow**: It reads the action’s two operation lists. If both lists are empty, it returns `true`; if either list has at least one operation, it returns `false`.

**Call relations**: This is used by MITM validation to reject action definitions that would do nothing. It is a small helper focused only on one action object.


##### `NetworkToml::apply_to_network_proxy_config`  (lines 502–558)

```
fn apply_to_network_proxy_config(&self, config: &mut NetworkProxyConfig)
```

**Purpose**: Overlays the network settings from TOML onto an existing runtime network proxy configuration. It only changes fields that were explicitly present in the TOML profile.

**Data flow**: It receives parsed network settings and a mutable `NetworkProxyConfig`. For each optional setting, it checks whether the TOML provided a value; if so, it copies that value into the runtime config. Domain rules are overlaid through `overlay_network_domain_permissions`, Unix socket rules are translated into proxy permission values, and MITM hooks are converted into runtime hook configs. At the end, it turns on MITM behavior when limited network mode is active or when hooks are configured.

**Call relations**: This is the main handoff from configuration to the network proxy. It is called by `to_network_proxy_config` when building a fresh config and by `apply_network` when applying network settings into a broader existing configuration.

*Call graph*: calls 1 internal fn (overlay_network_domain_permissions); called by 2 (to_network_proxy_config, apply_network).


##### `NetworkToml::to_network_proxy_config`  (lines 560–564)

```
fn to_network_proxy_config(&self) -> NetworkProxyConfig
```

**Purpose**: Builds a complete runtime network proxy configuration from this TOML network section. It is a convenient one-step conversion when there is no existing config to overlay.

**Data flow**: It starts with the default `NetworkProxyConfig`, then calls `apply_to_network_proxy_config` to copy all explicit TOML settings into it. The finished runtime config is returned to the caller.

**Call relations**: This is a wrapper around `apply_to_network_proxy_config`. It is useful when callers want a new config object rather than modifying one they already have.

*Call graph*: calls 1 internal fn (apply_to_network_proxy_config); 1 external calls (default).


##### `NetworkMitmHookToml::to_runtime`  (lines 568–583)

```
fn to_runtime(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> MitmHookConfig
```

**Purpose**: Converts one parsed MITM hook into the runtime hook format used by the proxy. A hook says which requests match and which actions should run for those requests.

**Data flow**: It reads the hook’s host, methods, path prefixes, query rules, header rules, optional body matcher, and action names. It copies the match rules into a `MitmHookMatchConfig` and calls `selected_actions` to turn action names into concrete strip/inject operations. It returns a complete `MitmHookConfig`.

**Call relations**: This is called while `NetworkMitmToml::to_runtime_hooks` converts all configured hooks. It delegates action expansion to `NetworkMitmHookToml::selected_actions` so matching logic and action selection stay separate.

*Call graph*: calls 1 internal fn (selected_actions).


##### `NetworkMitmHookToml::selected_actions`  (lines 585–608)

```
fn selected_actions(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> MitmHookActionsConfig
```

**Purpose**: Expands the action names listed by one hook into the actual header operations the proxy should perform. It combines multiple named actions in the order the hook lists them.

**Data flow**: It receives an optional map of action definitions. If no map is supplied, it returns an empty action set. Otherwise it creates an empty runtime action config, looks up each action name from the hook, and appends that action’s headers-to-strip and headers-to-inject. Injected header entries are converted into runtime header configs before being added.

**Call relations**: This is called by `NetworkMitmHookToml::to_runtime` for each hook. It uses `NetworkMitmInjectedHeaderToml::to_runtime` for the small conversion of each injected header.

*Call graph*: called by 1 (to_runtime); 1 external calls (default).


##### `NetworkMitmInjectedHeaderToml::to_runtime`  (lines 612–619)

```
fn to_runtime(&self) -> InjectedHeaderConfig
```

**Purpose**: Converts one configured injected header into the runtime format expected by the proxy. Injected headers can get their secret value from an environment variable or a file, with an optional prefix.

**Data flow**: It reads the header name, optional secret environment variable name, optional secret file path, and optional prefix from the TOML object. It clones those fields into a new `InjectedHeaderConfig` and returns it.

**Call relations**: This is used when `NetworkMitmHookToml::selected_actions` expands named actions into proxy-ready operations. It handles the final per-header translation step.


##### `overlay_network_domain_permissions`  (lines 622–635)

```
fn overlay_network_domain_permissions(
    config: &mut NetworkProxyConfig,
    domains: &NetworkDomainPermissionsToml,
)
```

**Purpose**: Applies domain allow and deny rules from parsed TOML onto an existing network proxy configuration. It updates the proxy’s domain rule set without replacing unrelated settings.

**Data flow**: It receives a mutable `NetworkProxyConfig` and parsed domain permissions. For each domain pattern, it translates the TOML permission into the proxy’s permission type, then inserts or updates that domain rule in the proxy config. Host names are normalized during insertion so equivalent domain spellings line up.

**Call relations**: This helper is called by `NetworkToml::apply_to_network_proxy_config` when network TOML includes domain rules, and also by `apply_network_constraints` when domain constraints are applied elsewhere. It centralizes the permission translation so both paths behave the same way.

*Call graph*: called by 2 (apply_to_network_proxy_config, apply_network_constraints).


### `core/src/config/permissions.rs`

`config` · `config load and startup`

Codex can run commands on a user’s machine, so it needs clear boundaries: which files may be read or written, and whether network access is allowed. This file is the translator between configuration text and those runtime boundaries. Think of it like a building access desk: a profile name such as “read only” or “workspace” becomes a badge with specific doors it can open.

The file supports three built-in profiles: read-only, workspace-write, and full access. It can also resolve user-defined profiles from a TOML configuration file, including profiles that extend built-in ones. Once a profile is chosen, the file compiles filesystem entries into sandbox policy objects, checks that paths are safe and unambiguous, warns about entries this Codex version does not understand, and validates glob patterns. A glob is a path pattern such as `*.env` or `**` that can match many files.

It also separates two related network ideas. A permission profile may say whether the sandbox can use the network, while feature configuration may describe a managed network proxy. This file merges those settings carefully so a profile does not accidentally start proxy behavior by itself.

Without this file, Codex would not have a reliable way to turn user intent into enforceable safety rules.

#### Function details

##### `default_builtin_permission_profile_name`  (lines 48–59)

```
fn default_builtin_permission_profile_name(
    active_project: &ProjectConfig,
    windows_sandbox_level: WindowsSandboxLevel,
) -> &'static str
```

**Purpose**: Chooses which built-in permission profile Codex should use when the user has not picked one. It prefers workspace access for projects marked trusted or untrusted, unless Windows sandboxing is disabled, and otherwise falls back to read-only.

**Data flow**: It receives the active project settings and the Windows sandbox level. It checks whether the project is trusted or explicitly untrusted, then considers whether the current platform is Windows with sandboxing disabled. It returns the name of the built-in profile Codex should use.

**Call relations**: This is an early selection helper. It relies on the project’s trust checks and feeds later profile compilation by naming the default profile.

*Call graph*: calls 2 internal fn (is_trusted, is_untrusted); 1 external calls (cfg!).


##### `is_builtin_permission_profile_name`  (lines 61–68)

```
fn is_builtin_permission_profile_name(profile_name: &str) -> bool
```

**Purpose**: Answers whether a profile name is one of Codex’s reserved built-in names. This prevents custom and built-in profiles from being confused.

**Data flow**: It receives a profile name string, compares it with the three reserved built-in names, and returns true or false.

**Call relations**: Profile-selection code calls this before looking for custom configuration, especially when preparing workspace roots or network proxy settings.

*Call graph*: called by 2 (compile_permission_profile_workspace_roots, network_proxy_config_for_profile_selection); 1 external calls (matches!).


##### `builtin_permission_profile`  (lines 70–97)

```
fn builtin_permission_profile(
    profile_name: &str,
    workspace_write: Option<&SandboxWorkspaceWrite>,
) -> Option<PermissionProfile>
```

**Purpose**: Builds the actual built-in permission profile for a reserved profile name. It is used when no custom TOML profile needs to be read.

**Data flow**: It receives a profile name and optional workspace-write settings. For read-only it creates a read-only profile; for workspace-write it may include network and temporary-directory choices; for full access it disables sandboxing. Unknown names produce no profile.

**Call relations**: Configuration loading and profile compilation call this first. If it returns a profile, later custom-profile resolution is skipped.

*Call graph*: calls 3 internal fn (read_only, workspace_write, workspace_write_with); called by 2 (load_config_with_layer_stack, compile_permission_profile_selection).


##### `validate_user_permission_profile_names`  (lines 99–118)

```
fn validate_user_permission_profile_names(
    permissions: Option<&PermissionsToml>,
) -> io::Result<()>
```

**Purpose**: Checks that user-defined permission profile names do not start with `:`, because that prefix is reserved for built-in names. This avoids future collisions and confusing configuration.

**Data flow**: It receives the optional permissions table. If no table exists, it succeeds. If a user profile name starts with `:`, it returns an invalid-input error; otherwise it returns success.

**Call relations**: The effective permission-selection flow calls this while validating configuration before Codex commits to a profile.

*Call graph*: called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `network_proxy_config_from_profile_network`  (lines 120–132)

```
fn network_proxy_config_from_profile_network(
    network: Option<&NetworkToml>,
) -> NetworkProxyConfig
```

**Purpose**: Creates network proxy settings from the network section of a permission profile, but deliberately keeps the managed proxy disabled. This lets profiles describe proxy details without turning the proxy feature on by themselves.

**Data flow**: It receives an optional network configuration from a profile. It converts that to a proxy configuration or starts from defaults, then forces the proxy-enabled flag to false. It returns the prepared proxy configuration.

**Call relations**: Network proxy selection calls this after resolving a custom profile’s network section.

*Call graph*: called by 1 (network_proxy_config_for_profile_selection).


##### `apply_network_proxy_feature_config`  (lines 134–192)

```
fn apply_network_proxy_feature_config(
    config: &mut NetworkProxyConfig,
    feature_config: &NetworkProxyConfigToml,
)
```

**Purpose**: Applies the separate network-proxy feature configuration on top of an existing proxy configuration. This is where the feature switch and proxy-specific allow or deny lists are copied into the runtime proxy settings.

**Data flow**: It receives a mutable proxy configuration and feature configuration from TOML. It translates feature-specific mode, domain, and Unix socket permission values into the profile-style network format, then applies them to the existing proxy config.

**Call relations**: Configuration loading and active-profile proxy setup call this after base proxy settings are known, so feature-level choices can override or complete them.

*Call graph*: called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `resolve_permission_profile`  (lines 194–201)

```
fn resolve_permission_profile(
    permissions: &PermissionsToml,
    profile_name: &str,
) -> io::Result<PermissionProfileToml>
```

**Purpose**: Finds and expands a named custom permission profile. Expansion means following any `extends` relationship so the final profile includes inherited settings.

**Data flow**: It receives the permissions table and a profile name. It asks the TOML permissions object to resolve the profile, allowing certain built-in profiles as extendable parents. It returns the resolved profile or an invalid-input error.

**Call relations**: Filesystem compilation, workspace-root compilation, and network proxy selection call this whenever the chosen profile is not a direct built-in profile.

*Call graph*: calls 1 internal fn (resolve_profile); called by 3 (compile_permission_profile, compile_permission_profile_workspace_roots, network_proxy_config_for_profile_selection).


##### `extensible_builtin_parent_profile`  (lines 203–214)

```
fn extensible_builtin_parent_profile(profile_name: &str) -> Option<PermissionProfileToml>
```

**Purpose**: Provides built-in profiles that custom profiles are allowed to extend. Only read-only and workspace-write are available this way.

**Data flow**: It receives a profile name. If the name is an extendable built-in profile, it creates the corresponding filesystem policy and converts it into TOML-shaped profile data. Otherwise it returns nothing.

**Call relations**: Profile resolution uses this as a callback when a custom profile says it extends a built-in profile.

*Call graph*: calls 3 internal fn (permission_profile_toml_from_file_system_policy, read_only, workspace_write).


##### `permission_profile_toml_from_file_system_policy`  (lines 216–233)

```
fn permission_profile_toml_from_file_system_policy(
    file_system: FileSystemSandboxPolicy,
) -> PermissionProfileToml
```

**Purpose**: Converts an internal filesystem sandbox policy back into the TOML-shaped profile format. This lets built-in policies act like parent profiles for custom profiles.

**Data flow**: It receives a filesystem policy with entries and optional glob-scan depth. It creates a TOML filesystem table, inserts each policy entry into that table, and returns a permission profile containing that filesystem section.

**Call relations**: The extendable built-in parent helper calls this when turning built-in read-only or workspace-write rules into something profile resolution can merge.

*Call graph*: calls 1 internal fn (insert_filesystem_permission_toml); called by 1 (extensible_builtin_parent_profile); 1 external calls (new).


##### `insert_filesystem_permission_toml`  (lines 235–253)

```
fn insert_filesystem_permission_toml(
    entries: &mut BTreeMap<String, FilesystemPermissionToml>,
    entry: FileSystemSandboxEntry,
)
```

**Purpose**: Adds one internal filesystem rule to a TOML-style map. It preserves whether the rule was for an exact path, a glob pattern, or a special symbolic path.

**Data flow**: It receives a mutable TOML entries map and one sandbox entry. It converts the entry path into a string key or delegates special paths to a helper, then stores the access mode under that key.

**Call relations**: The policy-to-profile conversion loop calls this for each filesystem sandbox entry.

*Call graph*: calls 1 internal fn (insert_special_filesystem_permission_toml); called by 1 (permission_profile_toml_from_file_system_policy); 1 external calls (Access).


##### `insert_special_filesystem_permission_toml`  (lines 255–301)

```
fn insert_special_filesystem_permission_toml(
    entries: &mut BTreeMap<String, FilesystemPermissionToml>,
    value: FileSystemSpecialPath,
    access: FileSystemAccessMode,
)
```

**Purpose**: Converts a special filesystem path, such as workspace roots or temporary directories, into its TOML key form. Special paths are symbolic names that are resolved later.

**Data flow**: It receives the TOML entries map, a special path value, and an access mode. It writes keys like `:root`, `:minimal`, or `:workspace_roots`, using scoped nested entries when the special path includes a subpath.

**Call relations**: General filesystem-entry insertion calls this whenever the internal rule uses a special symbolic path.

*Call graph*: calls 1 internal fn (insert_scoped_filesystem_permission_toml); called by 1 (insert_filesystem_permission_toml); 1 external calls (Access).


##### `insert_scoped_filesystem_permission_toml`  (lines 303–323)

```
fn insert_scoped_filesystem_permission_toml(
    entries: &mut BTreeMap<String, FilesystemPermissionToml>,
    path: String,
    subpath: PathBuf,
    access: FileSystemAccessMode,
)
```

**Purpose**: Stores a permission for a subpath beneath a larger path key. This is how TOML can say, for example, that only a folder inside the workspace roots has a particular access mode.

**Data flow**: It receives the entries map, the parent path key, the subpath, and the access mode. It ensures the parent key is represented as a scoped map and then records the subpath permission inside it.

**Call relations**: Special-path conversion calls this for special paths that carry nested subpaths.

*Call graph*: called by 1 (insert_special_filesystem_permission_toml); 3 external calls (from, to_string_lossy, Scoped).


##### `network_proxy_config_for_profile_selection`  (lines 325–344)

```
fn network_proxy_config_for_profile_selection(
    permissions: Option<&PermissionsToml>,
    profile_name: &str,
) -> io::Result<NetworkProxyConfig>
```

**Purpose**: Finds the network proxy configuration associated with the selected permission profile. Built-in profiles get the default proxy configuration; custom profiles may provide proxy details.

**Data flow**: It receives an optional permissions table and a profile name. If the name is built-in, it returns defaults. Otherwise it rejects unknown reserved names, resolves the custom profile, converts its network section, and returns the result.

**Call relations**: Configuration loading and active-profile proxy setup call this when they need proxy settings tied to the selected permission profile.

*Call graph*: calls 4 internal fn (is_builtin_permission_profile_name, network_proxy_config_from_profile_network, reject_unknown_builtin_permission_profile, resolve_permission_profile); called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile); 1 external calls (default).


##### `compile_permission_profile`  (lines 346–409)

```
fn compile_permission_profile(
    permissions: &PermissionsToml,
    profile_name: &str,
    policy_cwd: &Path,
    startup_warnings: &mut Vec<String>,
) -> io::Result<(FileSystemSandboxPolicy, Netwo
```

**Purpose**: Turns a resolved custom permission profile into runtime sandbox policies for files and network. This is the main compiler for user-defined permission profiles.

**Data flow**: It receives the permissions table, profile name, base directory for resolving paths, and a warning list. It resolves the profile, starts from restricted filesystem and network defaults, compiles each filesystem entry, validates glob settings, emits warnings for unsupported or empty rules, and returns the final filesystem and network policies.

**Call relations**: Profile selection calls this after it has determined the chosen profile is custom. It delegates detailed path parsing to filesystem helpers and network handling to the network policy compiler.

*Call graph*: calls 9 internal fn (compile_filesystem_permission, compile_network_sandbox_policy, missing_filesystem_entries_warning, push_warning, resolve_permission_profile, unbounded_unreadable_globstar_paths, unsupported_read_write_glob_paths, validate_glob_scan_max_depth, restricted); called by 1 (compile_permission_profile_selection); 3 external calls (new, cfg!, format!).


##### `compile_permission_profile_selection`  (lines 411–430)

```
fn compile_permission_profile_selection(
    permissions: Option<&PermissionsToml>,
    profile_name: &str,
    workspace_write: Option<&SandboxWorkspaceWrite>,
    policy_cwd: &Path,
    startup_warn
```

**Purpose**: Compiles whichever permission profile the user selected, whether built-in or custom. It is the high-level entry point for turning a selected profile name into runtime permissions.

**Data flow**: It receives optional custom permissions, a profile name, optional workspace-write settings, a policy base directory, and warning storage. It first tries built-in profiles. If none matches, it rejects unknown reserved names, requires a permissions table, and compiles the custom profile.

**Call relations**: Configuration loading calls this to produce the sandbox permissions Codex will actually enforce during a session.

*Call graph*: calls 3 internal fn (builtin_permission_profile, compile_permission_profile, reject_unknown_builtin_permission_profile); called by 1 (load_config_with_layer_stack).


##### `compile_permission_profile_workspace_roots`  (lines 432–453)

```
fn compile_permission_profile_workspace_roots(
    permissions: Option<&PermissionsToml>,
    profile_name: &str,
    policy_cwd: &Path,
) -> io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Extracts any extra workspace roots declared by a custom permission profile. Built-in profiles do not add extra roots here.

**Data flow**: It receives optional permissions, a profile name, and the base directory for path resolution. Built-in names return an empty list. Custom names are resolved, and enabled workspace root paths are converted into absolute paths.

**Call relations**: Configuration loading calls this alongside permission compilation so runtime workspace-root lists match the chosen custom profile.

*Call graph*: calls 4 internal fn (compile_workspace_roots, is_builtin_permission_profile_name, reject_unknown_builtin_permission_profile, resolve_permission_profile); called by 1 (load_config_with_layer_stack); 1 external calls (new).


##### `compile_workspace_roots`  (lines 455–465)

```
fn compile_workspace_roots(
    workspace_roots: Option<&WorkspaceRootsToml>,
    policy_cwd: &Path,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Converts enabled workspace-root entries from configuration into absolute paths. These roots can later be used by symbolic rules such as `:workspace_roots`.

**Data flow**: It receives an optional workspace-roots section and a base directory. If no section exists, it returns an empty list. Otherwise it resolves each enabled root against the base directory and returns the collected absolute paths.

**Call relations**: Custom-profile workspace-root compilation calls this after the profile has been resolved.

*Call graph*: called by 1 (compile_permission_profile_workspace_roots).


##### `reject_unknown_builtin_permission_profile`  (lines 467–476)

```
fn reject_unknown_builtin_permission_profile(profile_name: &str) -> io::Result<()>
```

**Purpose**: Rejects profile names that look like reserved built-in names but are not known by this version of Codex. This gives a clear error instead of treating a misspelled built-in as a custom profile.

**Data flow**: It receives a profile name. If the name starts with `:`, it returns an invalid-input error naming the unknown built-in profile. Otherwise it succeeds.

**Call relations**: Profile selection, workspace-root selection, and network proxy selection call this after known built-in names have already been checked.

*Call graph*: called by 3 (compile_permission_profile_selection, compile_permission_profile_workspace_roots, network_proxy_config_for_profile_selection); 2 external calls (new, format!).


##### `get_readable_roots_required_for_codex_runtime`  (lines 481–507)

```
fn get_readable_roots_required_for_codex_runtime(
    codex_home: &Path,
    zsh_path: Option<&PathBuf>,
    main_execve_wrapper_exe: Option<&PathBuf>,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns filesystem locations that Codex itself must be able to read so shell commands can start correctly. These paths are added even when user permissions are otherwise tight.

**Data flow**: It receives the Codex home directory, optional zsh path, and optional exec wrapper path. It converts valid absolute paths into readable roots, treating wrapper paths under Codex’s temporary `arg0` area as their parent directory. It returns the roots that should be readable.

**Call relations**: Configuration loading calls this when building the final filesystem policy, so the sandbox does not accidentally block Codex’s own launch support files.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (load_config_with_layer_stack); 2 external calls (join, new).


##### `compile_network_sandbox_policy`  (lines 509–522)

```
fn compile_network_sandbox_policy(
    network: Option<&NetworkToml>,
    base_network_sandbox_policy: NetworkSandboxPolicy,
) -> NetworkSandboxPolicy
```

**Purpose**: Chooses the runtime network sandbox policy from a profile’s network section. If the profile does not say anything, it keeps the provided base policy.

**Data flow**: It receives optional network settings and a base network policy. `enabled = true` becomes full network access, `enabled = false` becomes restricted access, and no value keeps the base. It returns the resulting network policy.

**Call relations**: The custom profile compiler calls this after filesystem rules are compiled.

*Call graph*: called by 1 (compile_permission_profile).


##### `compile_filesystem_permission`  (lines 524–569)

```
fn compile_filesystem_permission(
    path: &str,
    permission: &FilesystemPermissionToml,
    policy_cwd: &Path,
    startup_warnings: &mut Vec<String>,
) -> io::Result<Vec<FileSystemSandboxEntry>>
```

**Purpose**: Compiles one TOML filesystem permission entry into one or more runtime sandbox entries. It understands both direct path permissions and scoped subpath permissions.

**Data flow**: It receives a path key, the permission value, the policy base directory, and warning storage. Direct access entries become one sandbox entry. Scoped entries are processed one by one, with deny globs becoming pattern rules when allowed and other entries becoming exact or special paths. It returns the list of compiled sandbox entries.

**Call relations**: The custom profile compiler calls this for every configured filesystem rule, and this function delegates the path-specific decisions to lower-level helpers.

*Call graph*: calls 6 internal fn (compile_filesystem_access_path, compile_read_write_glob_path, compile_scoped_filesystem_path, compile_scoped_filesystem_pattern, contains_glob_chars, parse_special_path); called by 1 (compile_permission_profile); 1 external calls (new).


##### `compile_filesystem_access_path`  (lines 571–592)

```
fn compile_filesystem_access_path(
    path: &str,
    access: FileSystemAccessMode,
    startup_warnings: &mut Vec<String>,
) -> io::Result<FileSystemPath>
```

**Purpose**: Compiles the path part of a direct filesystem access rule. It decides whether a glob pattern is allowed or whether the path must be treated as a normal exact path.

**Data flow**: It receives a path string, an access mode, and warning storage. Non-glob paths are parsed normally. Deny glob paths become glob-pattern rules. Read or write paths may only use a trailing `/**` shortcut; otherwise an error is returned. It returns a runtime filesystem path value.

**Call relations**: Direct filesystem permission compilation calls this when the TOML entry is a simple access rule.

*Call graph*: calls 4 internal fn (compile_filesystem_path, compile_read_write_glob_path, contains_glob_chars, parse_absolute_path); called by 1 (compile_filesystem_permission).


##### `compile_filesystem_path`  (lines 594–605)

```
fn compile_filesystem_path(
    path: &str,
    startup_warnings: &mut Vec<String>,
) -> io::Result<FileSystemPath>
```

**Purpose**: Parses a filesystem path string into the internal path form. It supports special symbolic paths and real absolute paths.

**Data flow**: It receives a path string and warning storage. If the string is a special path like `:tmpdir`, it returns a special-path value and may warn if the special path is unknown. Otherwise it requires and returns an absolute path.

**Call relations**: Both direct and scoped path compilation call this when they need a normal filesystem path result.

*Call graph*: calls 3 internal fn (maybe_push_unknown_special_path_warning, parse_absolute_path, parse_special_path); called by 2 (compile_filesystem_access_path, compile_scoped_filesystem_path).


##### `compile_scoped_filesystem_path`  (lines 607–640)

```
fn compile_scoped_filesystem_path(
    path: &str,
    subpath: &str,
    startup_warnings: &mut Vec<String>,
) -> io::Result<FileSystemPath>
```

**Purpose**: Compiles a nested permission such as a subfolder under an absolute path or under `:workspace_roots`. It makes sure the subpath cannot escape upward with `..`.

**Data flow**: It receives a parent path, subpath, and warning storage. A subpath of `.` means the parent path itself. Special parents are allowed only if they support nesting. Absolute parent paths are combined with the safe relative subpath. It returns the compiled filesystem path.

**Call relations**: Scoped filesystem permission compilation calls this for literal scoped entries that are not being turned into deny glob patterns.

*Call graph*: calls 6 internal fn (compile_filesystem_path, maybe_push_unknown_special_path_warning, parse_absolute_path, parse_relative_subpath, parse_special_path, resolve_path_against_base); called by 1 (compile_filesystem_permission); 4 external calls (project_roots, unknown, new, format!).


##### `compile_scoped_filesystem_pattern`  (lines 642–675)

```
fn compile_scoped_filesystem_pattern(
    path: &str,
    subpath: &str,
    access: FileSystemAccessMode,
    _policy_cwd: &Path,
) -> io::Result<String>
```

**Purpose**: Compiles a scoped deny glob into a runtime glob pattern. This is used for rules like denying certain file patterns under workspace roots.

**Data flow**: It receives a parent path, subpath glob, access mode, and policy base directory. It rejects anything except deny access, checks that the subpath is a safe descendant path, then returns either a symbolic workspace-roots glob pattern or an absolute joined pattern.

**Call relations**: Scoped filesystem permission compilation calls this only when a scoped subpath contains glob characters and the rule is a deny rule.

*Call graph*: calls 4 internal fn (parse_absolute_path, parse_relative_subpath, parse_special_path, project_roots_glob_pattern); called by 1 (compile_filesystem_permission); 2 external calls (new, format!).


##### `compile_read_write_glob_path`  (lines 677–693)

```
fn compile_read_write_glob_path(path: &str, access: FileSystemAccessMode) -> io::Result<&str>
```

**Purpose**: Allows read or write rules to use only a simple trailing `/**` subtree shortcut, not arbitrary glob matching. This protects against pretending the sandbox can enforce glob-based write permissions that it cannot fully express.

**Data flow**: It receives a path and access mode. If there are no glob characters, it returns the path unchanged. If the only glob is a trailing `/**`, it returns the path without that suffix. Other glob use returns an invalid-input error.

**Call relations**: Direct and scoped filesystem compilation call this when read or write access is combined with path text that may contain glob characters.

*Call graph*: calls 2 internal fn (contains_glob_chars, remove_trailing_glob_suffix); called by 2 (compile_filesystem_access_path, compile_filesystem_permission); 2 external calls (new, format!).


##### `unsupported_read_write_glob_paths`  (lines 695–718)

```
fn unsupported_read_write_glob_paths(filesystem: &FilesystemPermissionsToml) -> Vec<String>
```

**Purpose**: Finds read or write glob rules that may not be fully supported on non-macOS sandboxes. These are warning candidates, not immediate compilation errors in this scan.

**Data flow**: It receives a filesystem permissions table. It walks direct and scoped entries, looking for non-deny access where glob characters remain after ignoring a trailing `/**`. It returns the matching path strings.

**Call relations**: The custom profile compiler calls this on non-macOS platforms so it can add startup warnings before compiling entries.

*Call graph*: calls 2 internal fn (contains_glob_chars, remove_trailing_glob_suffix); called by 1 (compile_permission_profile); 2 external calls (new, format!).


##### `unbounded_unreadable_globstar_paths`  (lines 720–744)

```
fn unbounded_unreadable_globstar_paths(filesystem: &FilesystemPermissionsToml) -> Vec<String>
```

**Purpose**: Finds deny-read glob rules that use `**` without a configured scan-depth limit. On some platforms, unbounded recursive glob expansion is not natively supported.

**Data flow**: It receives a filesystem permissions table. If `glob_scan_max_depth` is set, it returns no warnings. Otherwise it scans direct and scoped deny entries for `**` and returns the affected path strings.

**Call relations**: The custom profile compiler calls this on non-macOS platforms to warn users about deny patterns that may need a depth cap.

*Call graph*: called by 1 (compile_permission_profile); 2 external calls (new, format!).


##### `validate_glob_scan_max_depth`  (lines 746–754)

```
fn validate_glob_scan_max_depth(max_depth: Option<usize>) -> io::Result<Option<usize>>
```

**Purpose**: Checks that a configured glob scan depth is valid. A depth of zero is rejected because it would not make sense as a maximum scan depth.

**Data flow**: It receives an optional depth number. If the value is `Some(0)`, it returns an invalid-input error. Any other value, including no value, is returned unchanged.

**Call relations**: The custom profile compiler calls this before storing the depth on the runtime filesystem policy.

*Call graph*: called by 1 (compile_permission_profile); 1 external calls (new).


##### `contains_glob_chars`  (lines 756–758)

```
fn contains_glob_chars(path: &str) -> bool
```

**Purpose**: Checks whether a path string contains glob-pattern characters such as `*`, `?`, `[`, or `]`. It uses platform-aware behavior for Windows paths.

**Data flow**: It receives a path string, passes it to the platform-aware checker with the current operating-system setting, and returns true or false.

**Call relations**: Filesystem compilation and warning scans call this whenever they need to distinguish literal paths from pattern-like paths.

*Call graph*: calls 1 internal fn (contains_glob_chars_for_platform); called by 4 (compile_filesystem_access_path, compile_filesystem_permission, compile_read_write_glob_path, unsupported_read_write_glob_paths); 1 external calls (cfg!).


##### `contains_glob_chars_for_platform`  (lines 760–768)

```
fn contains_glob_chars_for_platform(path: &str, is_windows: bool) -> bool
```

**Purpose**: Performs the actual glob-character check, with special normalization for Windows device paths. This avoids mistaking Windows path prefixes for ordinary text.

**Data flow**: It receives a path string and a flag saying whether to use Windows rules. On Windows it first normalizes device-style paths if possible, then scans the resulting string for glob characters. It returns true or false.

**Call relations**: The public glob check helper calls this with the current platform choice.

*Call graph*: calls 1 internal fn (normalize_windows_device_path); called by 1 (contains_glob_chars).


##### `remove_trailing_glob_suffix`  (lines 770–772)

```
fn remove_trailing_glob_suffix(path: &str) -> &str
```

**Purpose**: Removes a trailing `/**` from a path if it is present. In this file, that suffix means “the whole subtree under this directory” for certain read or write rules.

**Data flow**: It receives a path string. If the string ends with `/**`, it returns the part before that suffix; otherwise it returns the original string slice.

**Call relations**: Read/write glob validation and warning scans use this to allow the special subtree form while still detecting other glob characters.

*Call graph*: called by 2 (compile_read_write_glob_path, unsupported_read_write_glob_paths).


##### `parse_special_path`  (lines 779–791)

```
fn parse_special_path(path: &str) -> Option<FileSystemSpecialPath>
```

**Purpose**: Recognizes symbolic filesystem paths such as `:root`, `:minimal`, and `:workspace_roots`. Unknown `:`-prefixed names are kept as unknown values instead of causing immediate failure.

**Data flow**: It receives a path string. Known special names become specific special-path values. Any other string beginning with `:` becomes an unknown special path, and ordinary paths return nothing.

**Call relations**: Filesystem path compilation calls this before trying to parse a real absolute path. Keeping unknown values lets older Codex versions warn rather than reject newer configuration.

*Call graph*: called by 4 (compile_filesystem_path, compile_filesystem_permission, compile_scoped_filesystem_path, compile_scoped_filesystem_pattern); 2 external calls (project_roots, unknown).


##### `parse_absolute_path`  (lines 793–795)

```
fn parse_absolute_path(path: &str) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Parses a path string as an absolute path using rules for the current platform. It also allows user-home forms such as `~` and `~/...` through the absolute-path utility.

**Data flow**: It receives a path string, calls the platform-aware parser using the current operating system, and returns an absolute path or an invalid-input error.

**Call relations**: Filesystem path and pattern compilation call this whenever a configured path is not a special symbolic path.

*Call graph*: calls 1 internal fn (parse_absolute_path_for_platform); called by 4 (compile_filesystem_access_path, compile_filesystem_path, compile_scoped_filesystem_path, compile_scoped_filesystem_pattern); 1 external calls (cfg!).


##### `parse_absolute_path_for_platform`  (lines 797–809)

```
fn parse_absolute_path_for_platform(path: &str, is_windows: bool) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Checks and converts a path string into an absolute path under a chosen platform’s rules. This is the core validation that rejects relative top-level filesystem rules.

**Data flow**: It receives a path string and a Windows-or-not flag. It normalizes Windows device paths when needed, checks whether the result is absolute or home-relative, and then asks the absolute-path utility to produce an absolute path. Invalid relative paths become errors.

**Call relations**: The current-platform absolute-path parser delegates to this function.

*Call graph*: calls 3 internal fn (is_absolute_path_for_platform, normalize_absolute_path_for_platform, from_absolute_path); called by 1 (parse_absolute_path); 2 external calls (new, format!).


##### `is_absolute_path_for_platform`  (lines 811–818)

```
fn is_absolute_path_for_platform(path: &str, normalized_path: &Path, is_windows: bool) -> bool
```

**Purpose**: Decides whether a path counts as absolute on a chosen platform. Windows needs extra checks because absolute paths can look like `C:\...` or network shares.

**Data flow**: It receives the original path string, a normalized path, and a Windows-or-not flag. On Windows it checks both original and normalized strings with Windows rules; on other systems it uses the standard absolute-path test. It returns true or false.

**Call relations**: The platform-aware absolute-path parser calls this before accepting a configured filesystem path.

*Call graph*: calls 1 internal fn (is_windows_absolute_path); called by 1 (parse_absolute_path_for_platform); 2 external calls (is_absolute, to_string_lossy).


##### `normalize_absolute_path_for_platform`  (lines 820–829)

```
fn normalize_absolute_path_for_platform(path: &str, is_windows: bool) -> Cow<'_, Path>
```

**Purpose**: Normalizes Windows device-path forms before absolute-path validation. On non-Windows platforms it leaves the path untouched.

**Data flow**: It receives a path string and a Windows-or-not flag. If not Windows, it returns a borrowed view of the original path. If Windows and the path has a recognized device prefix, it returns an owned normalized path; otherwise it borrows the original.

**Call relations**: The platform-aware absolute-path parser calls this before checking whether the path is absolute.

*Call graph*: calls 1 internal fn (normalize_windows_device_path); called by 1 (parse_absolute_path_for_platform); 4 external calls (Borrowed, Owned, new, from).


##### `normalize_windows_device_path`  (lines 831–849)

```
fn normalize_windows_device_path(path: &str) -> Option<String>
```

**Purpose**: Turns Windows device-style prefixes like `\\?\` and `\\.\` into more ordinary absolute path forms when possible. This helps later validation treat equivalent Windows paths consistently.

**Data flow**: It receives a path string. It recognizes UNC network-device forms and drive-letter device forms, rewrites them into standard-looking paths, and returns the normalized string. Unrecognized paths return nothing.

**Call relations**: Windows-aware glob checking and absolute-path normalization both call this before interpreting path text.

*Call graph*: calls 1 internal fn (is_windows_drive_absolute_path); called by 2 (contains_glob_chars_for_platform, normalize_absolute_path_for_platform); 1 external calls (format!).


##### `is_windows_absolute_path`  (lines 851–853)

```
fn is_windows_absolute_path(path: &str) -> bool
```

**Purpose**: Checks whether a string is an absolute Windows path. It accepts drive-letter paths and network-share style paths.

**Data flow**: It receives a path string. It returns true if the path looks like `C:\...`, `C:/...`, or starts with a double backslash network prefix.

**Call relations**: Platform-aware absolute-path checking calls this when using Windows rules.

*Call graph*: calls 1 internal fn (is_windows_drive_absolute_path); called by 1 (is_absolute_path_for_platform).


##### `is_windows_drive_absolute_path`  (lines 855–861)

```
fn is_windows_drive_absolute_path(path: &str) -> bool
```

**Purpose**: Checks for the Windows drive-letter absolute path shape, such as `C:\folder` or `C:/folder`. This is a small helper for Windows path validation.

**Data flow**: It receives a path string. It inspects the first three bytes for an ASCII letter, a colon, and then a slash or backslash. It returns true or false.

**Call relations**: Windows absolute-path detection and Windows device-path normalization call this to recognize drive-rooted paths.

*Call graph*: called by 2 (is_windows_absolute_path, normalize_windows_device_path); 1 external calls (matches!).


##### `parse_relative_subpath`  (lines 863–880)

```
fn parse_relative_subpath(subpath: &str) -> io::Result<PathBuf>
```

**Purpose**: Validates that a scoped subpath is a safe descendant path. It rejects empty strings, `.`, `..`, and anything with non-normal path components.

**Data flow**: It receives a subpath string. It inspects the path components and accepts only normal directory or file names. A valid subpath becomes a `PathBuf`; invalid input returns an error explaining that the subpath must stay below its parent.

**Call relations**: Scoped filesystem path and scoped glob-pattern compilation call this before combining a subpath with a parent path.

*Call graph*: called by 2 (compile_scoped_filesystem_path, compile_scoped_filesystem_pattern); 3 external calls (new, new, format!).


##### `push_warning`  (lines 882–885)

```
fn push_warning(startup_warnings: &mut Vec<String>, message: String)
```

**Purpose**: Records a startup warning and also writes it to the tracing log. This keeps user-visible warnings and diagnostic logs in sync.

**Data flow**: It receives the warning list and a message. It logs the message, pushes it into the list, and returns nothing.

**Call relations**: Profile compilation and unknown special-path handling call this whenever configuration should not fail but should be brought to the user’s attention.

*Call graph*: called by 2 (compile_permission_profile, maybe_push_unknown_special_path_warning); 1 external calls (warn!).


##### `missing_filesystem_entries_warning`  (lines 887–891)

```
fn missing_filesystem_entries_warning(profile_name: &str) -> String
```

**Purpose**: Builds the warning text used when a permission profile has no recognized filesystem entries. This tells the user that filesystem access will remain restricted.

**Data flow**: It receives the profile name and formats a clear warning string mentioning that this Codex version may not recognize the intended entries. It returns that string.

**Call relations**: The custom profile compiler calls this before passing the message to the warning recorder.

*Call graph*: called by 1 (compile_permission_profile); 1 external calls (format!).


##### `maybe_push_unknown_special_path_warning`  (lines 893–912)

```
fn maybe_push_unknown_special_path_warning(
    special: &FileSystemSpecialPath,
    startup_warnings: &mut Vec<String>,
)
```

**Purpose**: Warns when a configured special filesystem path is unknown to this Codex version. Unknown special paths are ignored rather than causing configuration load to fail.

**Data flow**: It receives a special-path value and warning storage. If the value is not unknown, it does nothing. If it is unknown, it formats a message, including nested subpath information when present, and records the warning.

**Call relations**: Filesystem path compilation calls this after parsing special paths, so forward-compatible configuration problems are visible during startup.

*Call graph*: calls 1 internal fn (push_warning); called by 2 (compile_filesystem_path, compile_scoped_filesystem_path); 1 external calls (format!).


### `core/src/config/resolved_permission_profile.rs`

`config` · `config load and runtime permission updates`

A permission profile is the set of rules that says what the system may do, such as read files, write files, or use broader access. This file turns that raw profile into a richer record: not just “these are the permissions,” but also “this is the active profile name,” “this built-in profile was selected,” and “these workspace folders came from the profile.” That matters because user interfaces and sessions need to report the active profile accurately, while the permission engine needs the concrete rules.

The file separates three cases. A legacy profile has no active profile identity. A built-in profile is one of the known standard choices, such as read-only or workspace access. A named profile is a custom profile chosen by its id. Think of it like a travel ticket: the raw permission rules are the seat assignment, while the active profile id is the ticket label that explains which fare or package produced it.

It also defines snapshots. A snapshot is a trusted bundle of the concrete profile plus its active identity, used when session state needs to be carried forward without resolving the profile name again. Finally, PermissionProfileState wraps the resolved profile in a constraint. A constraint is a guardrail: before replacing the profile, the new one is checked against the allowed limits. Without this file, the system could lose profile identity, mix up workspace roots, or accept a permission change that should have been blocked.

#### Function details

##### `BuiltInPermissionProfileId::from_str`  (lines 18–25)

```
fn from_str(id: &str) -> Option<Self>
```

**Purpose**: This turns a text id into one of the known built-in permission profile choices. It is used to tell whether an active profile id refers to a standard profile or to a custom named one.

**Data flow**: It receives a string id. It compares that id with the known built-in profile names for read-only, workspace, and danger-full-access. It returns the matching built-in enum value, or nothing if the id is not one of those standard names.

**Call relations**: When ResolvedPermissionProfile::from_active_profile is given an active profile id, it calls this first. If this function recognizes the id, the profile is stored as built-in; otherwise the same id is treated as a named custom profile.

*Call graph*: called by 1 (from_active_profile).


##### `BuiltInPermissionProfileId::as_str`  (lines 27–33)

```
fn as_str(self) -> &'static str
```

**Purpose**: This converts a built-in profile choice back into its public text id. It is used when the system needs to report or save which built-in profile is active.

**Data flow**: It receives a built-in profile enum value. It matches that value to the corresponding constant string id. It returns that static string without changing any stored state.

**Call relations**: ResolvedPermissionProfile::active_permission_profile uses this when rebuilding an ActivePermissionProfile for a built-in profile, so callers see the standard profile id rather than the internal enum value.


##### `ResolvedPermissionProfile::from_active_profile`  (lines 78–103)

```
fn from_active_profile(
        permission_profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
        profile_workspace_roots: Vec<AbsolutePathBuf>,
    )
```

**Purpose**: This builds the richer internal record for a permission profile when the caller may also know the active profile id. It decides whether the profile is legacy, built-in, or named.

**Data flow**: It receives a concrete PermissionProfile, an optional ActivePermissionProfile, and any workspace roots declared by the profile. If there is no active profile id, it returns a legacy resolved profile. If there is an id, it checks whether that id is built-in; built-in ids become BuiltIn records, and all other ids become Named records. The original permission rules and workspace roots are kept with the chosen identity.

**Call relations**: PermissionProfileSnapshot::active_with_profile_workspace_roots and PermissionProfileState::from_constrained_active_profile call this after a profile id has already been resolved elsewhere. Inside, it calls BuiltInPermissionProfileId::from_str to classify the id, or falls back to ResolvedPermissionProfile::legacy when there is no id.

*Call graph*: calls 1 internal fn (from_str); called by 2 (active_with_profile_workspace_roots, from_constrained_active_profile); 3 external calls (BuiltIn, Named, legacy).


##### `ResolvedPermissionProfile::legacy`  (lines 105–107)

```
fn legacy(permission_profile: PermissionProfile) -> Self
```

**Purpose**: This creates a resolved profile for old-style or local permission settings that do not have an active profile name. It keeps the concrete permission rules but intentionally records no profile identity.

**Data flow**: It receives a PermissionProfile. It wraps that profile in the Legacy variant. The result can still be queried for its permissions, but it will report no active profile id and no profile-defined workspace roots.

**Call relations**: This is the common path for older configuration flows and direct permission overrides. Snapshot creation, constrained legacy setup, permission checks, and legacy setters all call it when they need to represent permissions without a named or built-in profile.

*Call graph*: called by 4 (legacy, can_set_legacy_permission_profile, from_constrained_legacy, set_legacy_permission_profile); 1 external calls (Legacy).


##### `ResolvedPermissionProfile::permission_profile`  (lines 109–115)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: This returns the concrete permission rules no matter how the profile was identified. Callers use it when they care about what actions are allowed, not where the rules came from.

**Data flow**: It reads the current resolved profile variant. Whether the variant is legacy, built-in, or named, it returns a shared reference to the stored PermissionProfile. It does not copy or change anything.

**Call relations**: PermissionProfileSnapshot::permission_profile and PermissionProfileState constraint checks rely on this view. It is the bridge from the richer identity-carrying wrapper back to the actual permission rules.

*Call graph*: called by 1 (permission_profile).


##### `ResolvedPermissionProfile::active_permission_profile`  (lines 117–129)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: This reconstructs the active profile identity, if the resolved profile has one. It lets other parts of the system report which built-in or custom profile is selected.

**Data flow**: It reads the resolved profile. For legacy profiles it returns nothing. For built-in profiles it converts the internal built-in id back to its standard string and includes the stored extension information. For named profiles it returns the stored custom id and extension information.

**Call relations**: PermissionProfileSnapshot and PermissionProfileState expose this result to callers that need session state, user interface state, or outgoing protocol data. For built-in profiles, it depends on BuiltInPermissionProfileId::as_str to produce the public id.

*Call graph*: called by 1 (active_permission_profile).


##### `ResolvedPermissionProfile::profile_workspace_roots`  (lines 131–137)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: This returns the workspace folders that were declared by the active profile itself. These roots are kept separate from temporary or turn-specific workspace roots.

**Data flow**: It reads the resolved profile. Legacy profiles return an empty list because they do not carry profile-defined roots. Built-in and named profiles return the stored list of absolute paths.

**Call relations**: PermissionProfileSnapshot and PermissionProfileState call this when higher-level permission code needs to include profile-declared workspaces in its view of allowed locations.

*Call graph*: called by 1 (profile_workspace_roots).


##### `PermissionProfileSnapshot::legacy`  (lines 146–150)

```
fn legacy(permission_profile: PermissionProfile) -> Self
```

**Purpose**: This creates a trusted snapshot for a permission profile that has no active profile id. It is meant for legacy data or deliberate local overrides.

**Data flow**: It receives a concrete PermissionProfile. It turns that into a legacy ResolvedPermissionProfile and stores it inside a snapshot. The output is a snapshot that preserves the permission rules but clears active profile metadata.

**Call relations**: Several configuration and session flows call this when they need to install or test permissions without associating them with a named profile. It delegates the actual legacy wrapping to ResolvedPermissionProfile::legacy.

*Call graph*: calls 1 internal fn (legacy); called by 4 (set_permission_profile_projection, side_fork_config_inherits_parent_thread_runtime_settings, update_feature_flags_disabling_guardian_clears_review_policy_and_restores_default, session_configured_syncs_widget_config_permissions_and_cwd).


##### `PermissionProfileSnapshot::active`  (lines 158–167)

```
fn active(
        permission_profile: PermissionProfile,
        active_permission_profile: ActivePermissionProfile,
    ) -> Self
```

**Purpose**: This creates a trusted snapshot for a permission profile that is known to come from an active profile id. It is the simple version used when there are no profile-declared workspace roots to carry along.

**Data flow**: It receives a PermissionProfile and an ActivePermissionProfile. It passes both onward with an empty workspace-root list. The result is a snapshot containing the concrete permissions and the active identity.

**Call relations**: Many runtime and UI flows call this after selecting or syncing a profile. It hands the work to PermissionProfileSnapshot::active_with_profile_workspace_roots so all active snapshots are built through the same path.

*Call graph*: called by 21 (permission_snapshot_setter_preserves_permission_constraints, apply, sync_auto_review_runtime_state_from_effective_config, try_set_builtin_active_permission_profile_on_config, handle_event, permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread, profile_permissions_selection_emits_active_custom_profile, profile_permissions_selection_emits_auto_review_mode_event, profile_permissions_selection_emits_named_profile_event_only, profile_permissions_selection_popup_snapshot (+11 more)); 2 external calls (active_with_profile_workspace_roots, new).


##### `PermissionProfileSnapshot::active_with_profile_workspace_roots`  (lines 175–187)

```
fn active_with_profile_workspace_roots(
        permission_profile: PermissionProfile,
        active_permission_profile: ActivePermissionProfile,
        profile_workspace_roots: Vec<AbsolutePathBuf>
```

**Purpose**: This creates a trusted snapshot for an active profile and also preserves workspace folders declared by that profile. It is used when those profile roots must travel with the permission settings.

**Data flow**: It receives concrete permission rules, an active profile identity, and a list of absolute workspace paths. It asks ResolvedPermissionProfile::from_active_profile to classify the active id as built-in or named, then stores the resolved result inside the snapshot.

**Call relations**: Callers use this when applying a profile projection or when status reporting must include profile-defined workspace roots. It is the snapshot constructor that keeps identity, rules, and profile roots together.

*Call graph*: calls 1 internal fn (from_active_profile); called by 2 (set_permission_profile_projection, status_permissions_workspace_roots_include_profile_defined_directories).


##### `PermissionProfileSnapshot::from_session_snapshot`  (lines 195–205)

```
fn from_session_snapshot(
        permission_profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
    ) -> Self
```

**Purpose**: This rebuilds a trusted permission snapshot from session state that already contains the concrete profile and maybe an active profile id. It avoids re-resolving the id through configuration.

**Data flow**: It receives a PermissionProfile and an optional ActivePermissionProfile. If an active identity is present, it creates an active snapshot. If not, it creates a legacy snapshot. It returns the reconstructed PermissionProfileSnapshot.

**Call relations**: Session and runtime update flows call this when applying settings captured from core session state. It chooses between PermissionProfileSnapshot::active and PermissionProfileSnapshot::legacy based on whether the session recorded an active profile.

*Call graph*: called by 6 (apply_permission_profile_selection, apply_runtime_policy_overrides, update_feature_flags, on_session_configured_with_display_and_fork_parent_title, apply_thread_settings, set_permission_profile_with_active_profile); 2 external calls (active, legacy).


##### `PermissionProfileSnapshot::permission_profile`  (lines 208–210)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: This exposes the concrete permission rules stored in a snapshot. It is useful when code needs the rules before installing or replacing the full resolved state.

**Data flow**: It reads the snapshot’s internal ResolvedPermissionProfile and returns a shared reference to its PermissionProfile. The snapshot itself is not changed.

**Call relations**: Replacement code calls this when it needs to inspect the permission profile inside a session snapshot. It delegates to ResolvedPermissionProfile::permission_profile.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (replace_permission_profile_from_session_snapshot).


##### `PermissionProfileSnapshot::active_permission_profile`  (lines 213–215)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: This exposes the active profile identity stored in a snapshot, if one exists. It lets callers distinguish legacy permission data from a named or built-in profile selection.

**Data flow**: It reads the snapshot’s resolved profile. It returns an ActivePermissionProfile for built-in or named profiles, or nothing for legacy profiles. The snapshot remains unchanged.

**Call relations**: This is a public-facing read method for snapshot users. It delegates to ResolvedPermissionProfile::active_permission_profile so the identity reconstruction rules stay in one place.

*Call graph*: calls 1 internal fn (active_permission_profile).


##### `PermissionProfileSnapshot::profile_workspace_roots`  (lines 218–220)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: This exposes workspace roots that were captured as part of the active profile snapshot. Callers use it when permission installation needs those roots alongside the profile rules.

**Data flow**: It reads the snapshot’s resolved profile and returns a shared slice of absolute paths. Legacy snapshots return an empty slice, while active built-in or named snapshots may return stored roots.

**Call relations**: This method is the snapshot-level doorway to ResolvedPermissionProfile::profile_workspace_roots. Higher-level permission code can use it without needing to know which resolved profile variant is inside.

*Call graph*: calls 1 internal fn (profile_workspace_roots).


##### `PermissionProfileSnapshot::into_resolved_permission_profile`  (lines 222–224)

```
fn into_resolved_permission_profile(self) -> ResolvedPermissionProfile
```

**Purpose**: This consumes a snapshot and extracts the resolved profile stored inside it. It is used when the snapshot is ready to be installed into mutable permission state.

**Data flow**: It takes ownership of the snapshot. It removes and returns the internal ResolvedPermissionProfile. After this, the original snapshot is no longer available because its contents have been moved out.

**Call relations**: PermissionProfileState::set_permission_profile_snapshot and replacement flows call this before setting constrained state. It is the handoff point from a portable snapshot to the live resolved-profile state.

*Call graph*: called by 2 (replace_permission_profile_from_session_snapshot, set_permission_profile_snapshot).


##### `PermissionProfileState::from_constrained_legacy`  (lines 233–239)

```
fn from_constrained_legacy(
        constrained_permission_profile: Constrained<PermissionProfile>,
    ) -> ConstraintResult<Self>
```

**Purpose**: This builds live permission-profile state from an already constrained legacy PermissionProfile. It keeps the existing safety guardrail while adding the resolved-profile wrapper.

**Data flow**: It receives a Constrained<PermissionProfile>, meaning a permission profile bundled with rules about what future values are allowed. It reads and clones the current profile, wraps it as legacy, and then builds constrained resolved state from it. It returns either the new PermissionProfileState or a constraint error.

**Call relations**: Configuration code that starts from older approval/profile settings calls this. It delegates the shared constraint setup to PermissionProfileState::from_constrained_resolved.

*Call graph*: calls 2 internal fn (get, legacy); called by 1 (from_approval_and_profile); 1 external calls (from_constrained_resolved).


##### `PermissionProfileState::from_constrained_active_profile`  (lines 241–252)

```
fn from_constrained_active_profile(
        constrained_permission_profile: Constrained<PermissionProfile>,
        active_permission_profile: Option<ActivePermissionProfile>,
        profile_workspac
```

**Purpose**: This builds live permission-profile state when configuration has already resolved an active profile selection. It preserves the active profile identity and workspace roots while keeping permission constraints in force.

**Data flow**: It receives constrained concrete permissions, an optional active profile identity, and profile-defined workspace roots. It reads and clones the concrete profile, resolves it into legacy, built-in, or named form, and then wraps that resolved value with the same constraint rules. It returns the new state or a constraint error.

**Call relations**: The config loading path calls this after reading layered configuration. It uses ResolvedPermissionProfile::from_active_profile to preserve profile identity, then passes the result to PermissionProfileState::from_constrained_resolved.

*Call graph*: calls 2 internal fn (get, from_active_profile); called by 1 (load_config_with_layer_stack); 1 external calls (from_constrained_resolved).


##### `PermissionProfileState::from_constrained_resolved`  (lines 254–268)

```
fn from_constrained_resolved(
        constrained_permission_profile: Constrained<PermissionProfile>,
        resolved_permission_profile: ResolvedPermissionProfile,
    ) -> ConstraintResult<Self>
```

**Purpose**: This is the core constructor that attaches permission guardrails to a resolved profile. It ensures future replacements are checked against the original permission-profile constraint.

**Data flow**: It receives a constrained concrete PermissionProfile and a ResolvedPermissionProfile. It builds a new constrained wrapper around the resolved profile. The wrapper’s check looks inside any future resolved-profile candidate, pulls out its concrete PermissionProfile, and asks the original constraint whether that concrete profile is allowed. It returns PermissionProfileState if the starting value passes the check.

**Call relations**: Both legacy and active-profile constructors use this shared path. Replacement flows also use it when rebuilding state from a session snapshot, so all resolved profiles obey the same permission limits.

*Call graph*: calls 1 internal fn (new); called by 1 (replace_permission_profile_from_session_snapshot).


##### `PermissionProfileState::permission_profile`  (lines 270–272)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: This returns the concrete permission rules from the live constrained state. It is the normal read path for code that needs to know what permissions are currently effective.

**Data flow**: It reads the constrained resolved profile, then returns a shared reference to the PermissionProfile inside it. Nothing is copied or changed.

**Call relations**: Permission APIs and sandbox-policy code call this when they need the current permissions. It hides the legacy versus built-in versus named distinction from callers that only need the rules.

*Call graph*: calls 1 internal fn (get); called by 3 (permission_profile, network_sandbox_policy, permission_profile).


##### `PermissionProfileState::active_permission_profile`  (lines 274–278)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: This returns the active profile identity from live state, if there is one. It allows the rest of the system to show or send the current profile selection.

**Data flow**: It reads the constrained resolved profile and asks it for its active identity. The result is an ActivePermissionProfile for built-in or named profiles, or nothing for legacy state.

**Call relations**: Higher-level active-profile accessors call this to surface current profile metadata. It keeps those callers from needing to know the internal resolved-profile variants.

*Call graph*: calls 1 internal fn (get); called by 2 (active_permission_profile, active_permission_profile).


##### `PermissionProfileState::profile_workspace_roots`  (lines 280–284)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: This returns workspace folders that came from the current active profile. It supports permission decisions or status views that must include those profile-declared roots.

**Data flow**: It reads the constrained resolved profile and returns the stored root list as a shared slice. If the live state is legacy, the returned list is empty.

**Call relations**: Higher-level workspace-root accessors call this when building the full set of permitted workspaces. It forwards to the resolved profile stored inside the constraint.

*Call graph*: calls 1 internal fn (get); called by 2 (profile_workspace_roots, profile_workspace_roots).


##### `PermissionProfileState::can_set_legacy_permission_profile`  (lines 286–292)

```
fn can_set_legacy_permission_profile(
        &self,
        permission_profile: &PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: This checks whether a proposed legacy permission profile would be allowed by the current constraint, without actually changing anything. It is a safe “would this be accepted?” test.

**Data flow**: It receives a proposed PermissionProfile by reference. It clones that profile, wraps the clone as a legacy resolved profile, and asks the constrained state whether that candidate can be set. It returns success or a constraint error, and the current state remains unchanged.

**Call relations**: Permission-setting code calls this before applying legacy sandbox or permission profile changes. It uses ResolvedPermissionProfile::legacy so the proposed concrete profile is tested in the same shape that would later be installed.

*Call graph*: calls 2 internal fn (can_set, legacy); called by 2 (can_set_legacy_sandbox_policy, can_set_permission_profile); 1 external calls (clone).


##### `PermissionProfileState::set_legacy_permission_profile`  (lines 294–300)

```
fn set_legacy_permission_profile(
        &mut self,
        permission_profile: PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: This replaces the live state with a new legacy permission profile, but only if the constraint allows it. It is used for old-style permission updates and tests.

**Data flow**: It receives a new PermissionProfile. It wraps it as a legacy resolved profile and asks the constrained wrapper to set that value. If the constraint approves, the live state changes; if not, the old state remains and an error is returned.

**Call relations**: Sandbox and permission setters call this when applying direct legacy-style permission changes. The constraint wrapper performs the final safety check before the new value becomes active.

*Call graph*: calls 2 internal fn (set, legacy); called by 3 (set_legacy_sandbox_policy, set_permission_profile, set_permission_profile_for_tests).


##### `PermissionProfileState::set_permission_profile_snapshot`  (lines 302–308)

```
fn set_permission_profile_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: This replaces the live state using a trusted snapshot that may include active profile identity and profile workspace roots. It keeps the existing permission constraint active during the replacement.

**Data flow**: It receives a PermissionProfileSnapshot. It consumes the snapshot to extract its ResolvedPermissionProfile, then tries to set that resolved profile in the constrained state. If the concrete permissions inside the snapshot pass the constraint, the live state is updated; otherwise the update is rejected.

**Call relations**: Session-snapshot and projection code call this when applying a previously captured profile selection. It uses PermissionProfileSnapshot::into_resolved_permission_profile as the handoff from snapshot form into live constrained state.

*Call graph*: calls 2 internal fn (set, into_resolved_permission_profile); called by 2 (set_permission_profile_from_session_snapshot, set_permission_profile_projection).


### `tui/src/permission_compat.rs`

`domain_logic` · `permission setup before sending settings to older or remote APIs`

The project has a canonical permission model: the main, trusted way to describe what files and network access the app is allowed to use. Some older parts of the system, or remote app servers, still expect a simpler “legacy” permission format. This file is the adapter between the two, like a travel plug that lets a new charger fit an old wall socket.

The main function first tries the easy path: if the current permission profile can already be expressed in the older format, it returns the profile unchanged. If that fails, it builds a safer compatibility profile. It keeps the important parts that the legacy format can represent: writable file roots and the network policy. It also checks whether the current temporary directory from `TMPDIR` and the common `/tmp` directory are writable, because the legacy format has special switches for blocking those. The current working directory is treated specially so it is not duplicated in the extra writable roots list.

The result is not a perfect copy of every modern rule. Instead, it is the closest older-style profile that preserves meaningful write access and network restrictions. Without this file, a modern permission profile that cannot be directly translated could fail when sent to older APIs, or lose important writable locations during compatibility conversion.

#### Function details

##### `legacy_compatible_permission_profile`  (lines 8–42)

```
fn legacy_compatible_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &Path,
) -> PermissionProfile
```

**Purpose**: This function returns a permission profile that older APIs can understand. If the given profile already fits the old format, it leaves it alone; otherwise it builds a compatible workspace-write profile that preserves writable roots and network restrictions as well as the old format allows.

**Data flow**: It receives a permission profile and the current working directory. First it asks the profile whether it can turn itself into the legacy sandbox policy; if yes, it simply returns a clone of the original profile. If not, it reads the file-system and network rules, gathers writable roots relative to the current directory, removes the current directory from the extra-root list, checks whether `TMPDIR` and `/tmp` are writable, and then creates a new workspace-write permission profile with those preserved settings. The output is a `PermissionProfile` intended to project successfully into the legacy format.

**Call relations**: This is called by `turn_permissions_overrides` when permission settings need to be prepared for compatibility. The test `tests::compatibility_profile_preserves_unbridgeable_write_roots` also calls it to prove that write roots not directly expressible in the original legacy conversion are still carried across. Inside, it relies on the permission model’s own helpers to inspect file-system policy, network policy, and legacy convertibility, then hands the gathered information to `workspace_write_with` to build the fallback profile.

*Call graph*: calls 5 internal fn (file_system_sandbox_policy, network_sandbox_policy, to_legacy_sandbox_policy, workspace_write_with, from_absolute_path); called by 2 (turn_permissions_overrides, compatibility_profile_preserves_unbridgeable_write_roots); 3 external calls (new, clone, var_os).


##### `tests::compatibility_profile_preserves_unbridgeable_write_roots`  (lines 56–92)

```
fn compatibility_profile_preserves_unbridgeable_write_roots()
```

**Purpose**: This test checks that the compatibility conversion does not throw away an extra writable directory when the original managed permission profile cannot be directly represented in the old format. It protects against a regression where older API compatibility would silently remove allowed write access.

**Data flow**: It builds a fake current directory, a separate writable root, and a managed permission profile that allows reading the root filesystem but writing only the extra root. It passes that profile into `legacy_compatible_permission_profile`, converts the result to the legacy sandbox policy, extracts the writable roots from that policy, and compares them with the expected list. The expected result contains both the extra writable root and the current working directory.

**Call relations**: This test exercises the fallback path in `legacy_compatible_permission_profile`. It sets up a permission shape that needs compatibility repair, then uses the same legacy projection method that production code depends on to confirm the repaired profile can be understood by the older policy system.

*Call graph*: calls 2 internal fn (legacy_compatible_permission_profile, try_from); 2 external calls (assert_eq!, vec!).


### `tui/src/additional_dirs.rs`

`domain_logic` · `startup`

This file is a small safety check around filesystem permissions. The program can be started with `--add-dir`, meaning “also allow writing in these folders.” But that only makes sense in permission modes that allow extra writable roots. If the program is running in a stricter sandbox, those folders cannot be used, and silently ignoring them would be confusing.

The main function, `add_dir_warning_message`, looks at three things: the list of extra folders, the resolved permission profile, and the current working directory. A permission profile is the program’s chosen safety mode, such as read-only, workspace-write, full access, or an externally supplied sandbox. The function returns no warning if there are no extra folders, if permissions are fully open, if an external sandbox is in charge, or if the current workspace is writable in the way that supports extra directories. Otherwise, it builds a clear message telling the user that `--add-dir` is being ignored and suggests using `workspace-write` or `danger-full-access` instead.

The private helper `format_warning` turns the folder list into a readable sentence. The tests cover the important permission cases so this user-facing warning appears only when it should.

#### Function details

##### `add_dir_warning_message`  (lines 7–33)

```
fn add_dir_warning_message(
    additional_dirs: &[PathBuf],
    permission_profile: &PermissionProfile,
    cwd: &std::path::Path,
) -> Option<String>
```

**Purpose**: Decides whether to show a warning that `--add-dir` folders will be ignored. It is used when startup code has already resolved the effective permission profile and needs to tell the user whether their extra writable folders can actually take effect.

**Data flow**: It receives a list of extra directory paths, a permission profile, and the current working directory. It first exits with no message if there are no extra directories, if permissions are disabled/full access, or if an external sandbox is responsible. Otherwise it asks the permission profile for its filesystem sandbox policy, checks whether that policy already allows broad disk writing or writing from the current workspace, and only then creates a warning string. The result is either `None` for “no warning needed” or `Some(message)` for “show this warning to the user.”

**Call relations**: During normal startup, `run_main` calls this after command-line options and permissions have been resolved. If a warning is needed, this function hands off to `format_warning` to build the user-facing sentence. The test `tests::warns_for_read_only` also calls it directly to confirm the warning behavior in a read-only sandbox.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, format_warning); called by 2 (warns_for_read_only, run_main); 2 external calls (is_empty, matches!).


##### `format_warning`  (lines 35–44)

```
fn format_warning(additional_dirs: &[PathBuf]) -> String
```

**Purpose**: Builds the exact warning text shown when extra directories cannot be honored. It keeps the wording in one place so the main decision function can stay focused on permission checks.

**Data flow**: It receives the list of directory paths. It turns each path into displayable text, joins them with commas, and inserts that list into a fixed warning sentence. The output is a single string ready to print or otherwise show to the user.

**Call relations**: `add_dir_warning_message` calls this only after it has decided that a warning is truly needed. This helper does not decide policy; it only formats the final message.

*Call graph*: called by 1 (add_dir_warning_message); 2 external calls (iter, format!).


##### `tests::returns_none_for_workspace_write`  (lines 61–68)

```
fn returns_none_for_workspace_write()
```

**Purpose**: Checks that `workspace-write` permissions do not produce an `--add-dir` warning. This confirms that the normal writable-workspace mode accepts additional directories without scaring the user unnecessarily.

**Data flow**: The test creates a workspace-write permission profile and one example extra directory. It passes those, along with a sample current directory, into the warning check and expects the result to be `None`. Nothing is changed outside the test.

**Call relations**: This test exercises the same decision path that startup code uses through `add_dir_warning_message`, but in a controlled case where no warning should be returned.

*Call graph*: calls 1 internal fn (workspace_write); 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_for_danger_full_access`  (lines 71–78)

```
fn returns_none_for_danger_full_access()
```

**Purpose**: Checks that full-access mode does not produce an `--add-dir` warning. In this mode the program already has broad filesystem access, so extra writable roots are not blocked by the sandbox logic.

**Data flow**: The test builds a `Disabled` permission profile, which represents the unrestricted or danger-full-access case, plus one example extra directory. It calls the warning check with a sample current directory and verifies that the answer is `None`.

**Call relations**: This test covers the branch in `add_dir_warning_message` that exits early for disabled permissions, matching how startup should behave when the user has chosen full access.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_for_external_sandbox`  (lines 81–90)

```
fn returns_none_for_external_sandbox()
```

**Purpose**: Checks that no warning is produced when an external sandbox is in charge. In that case, this code does not know enough to say whether `--add-dir` will work, so it stays quiet.

**Data flow**: The test creates an external permission profile with network sandboxing enabled and one example extra directory. It runs the warning decision and expects `None`, meaning no local warning text is produced.

**Call relations**: This test verifies the early-exit branch in `add_dir_warning_message` for externally managed permission setups.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::warns_for_read_only`  (lines 93–102)

```
fn warns_for_read_only()
```

**Purpose**: Checks that read-only permissions do produce a warning when `--add-dir` is supplied. This protects the user from assuming extra writable directories will work in a mode that does not allow writing.

**Data flow**: The test creates a read-only profile and two extra paths, one relative and one absolute. It calls `add_dir_warning_message`, unwraps the expected message, and compares it with the exact warning text. The output being checked is the human-readable warning string.

**Call relations**: This test calls `add_dir_warning_message` directly and verifies that, in the read-only path, the function reaches `format_warning` and returns the full user-facing message.

*Call graph*: calls 2 internal fn (read_only, add_dir_warning_message); 3 external calls (new, assert_eq!, vec!).


##### `tests::warns_when_profile_can_write_elsewhere_but_not_cwd`  (lines 105–132)

```
fn warns_when_profile_can_write_elsewhere_but_not_cwd()
```

**Purpose**: Checks a subtle case: a profile may allow writing somewhere, but not from the current workspace. The test makes sure `--add-dir` still gets warned about when the active workspace itself is not writable under the policy.

**Data flow**: The test constructs a custom managed permission profile. That profile can read the filesystem root and write to `/tmp/writable`, but the sample current directory is `/tmp/project`, which is not writable. It supplies `/tmp/extra` as an added directory and expects the warning message to be returned.

**Call relations**: This test exercises the deeper filesystem-policy checks inside `add_dir_warning_message`, especially the check that asks whether the policy can write using the current working directory as the workspace base.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_when_no_additional_dirs`  (lines 135–142)

```
fn returns_none_when_no_additional_dirs()
```

**Purpose**: Checks that no warning appears when the user did not provide any `--add-dir` entries. Even in read-only mode, there is nothing to ignore if the list is empty.

**Data flow**: The test creates a read-only permission profile and an empty directory list. It passes these into the warning function with a sample current directory and verifies that the result is `None`.

**Call relations**: This test covers the first early-exit branch of `add_dir_warning_message`, where the function returns immediately because there are no additional directories to warn about.

*Call graph*: calls 1 internal fn (read_only); 2 external calls (new, assert_eq!).


### Windows sandbox policy
These files translate resolved permissions into Windows-specific enforcement details and orchestrate sandbox setup and persistence.

### `windows-sandbox-rs/src/cap.rs`

`domain_logic` · `sandbox setup and permission preparation`

Windows uses security identifiers, often called SIDs, as labels for permissions. This file gives the sandbox its own special SIDs, called capability SIDs, so it can say: “this sandbox may write here, but not there.” Think of each SID like a colored wristband. A process wearing the right wristband can enter a certain area; one without it cannot.

The main stored object is `CapSids`. It contains a general workspace SID, a read-only SID, and two maps for more precise permissions: one SID per workspace folder and one SID per extra writable root. The file saves these values in a `cap_sid` file under the Codex home directory. That matters because permissions placed on disk must keep referring to the same SID later. If the SID changed every run, old permission rules would point at the wrong “wristband.”

The file also normalizes paths before using them as keys. That means different spellings of the same Windows path, such as different slashes or letter case, share one SID instead of accidentally creating duplicates. Finally, it has helper functions for comparing writable roots: whether one path contains another, whether two roots overlap, and how specific a root is by counting its path parts.

#### Function details

##### `cap_sid_file`  (lines 35–37)

```
fn cap_sid_file(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the file where capability SIDs are saved. Other code uses this single helper so everyone agrees on the same storage location.

**Data flow**: It receives the Codex home folder path. It appends the fixed filename `cap_sid`. It returns the full path where the SID data should be read from or written to.

**Call relations**: When sandbox setup or permission code needs saved capability IDs, it first asks this function where the storage file lives. It is used by the loading and updating functions, and also by outside permission code that needs to find the same file.

*Call graph*: called by 4 (apply_capability_denies_for_world_writable_for_permissions, load_or_create_cap_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path); 1 external calls (join).


##### `make_random_cap_sid_string`  (lines 39–46)

```
fn make_random_cap_sid_string() -> String
```

**Purpose**: Creates a new random-looking Windows capability SID string. This is used when the sandbox needs a fresh permission label that is unlikely to collide with any other label.

**Data flow**: It starts with system-provided random seed data, generates four random numbers, and inserts them into a Windows SID-shaped string. The result is a text value like `S-1-5-21-...`.

**Call relations**: The loading and lookup functions call this only when a needed SID does not already exist. After a new SID is made, those callers usually save it through `persist_caps` so future runs reuse the same value.

*Call graph*: called by 3 (load_or_create_cap_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path); 2 external calls (from_entropy, format!).


##### `persist_caps`  (lines 48–55)

```
fn persist_caps(path: &Path, caps: &CapSids) -> Result<()>
```

**Purpose**: Writes the current set of capability SIDs to disk. This makes newly created permission labels survive after the program exits.

**Data flow**: It receives a file path and a `CapSids` object. It creates the parent directory if needed, turns the object into JSON text, and writes that text to the file. It returns success or an error with context about what failed.

**Call relations**: Whenever `load_or_create_cap_sids`, `workspace_cap_sid_for_cwd`, or `writable_root_cap_sid_for_path` creates or upgrades SID data, they hand the updated object to this function so the change is not lost.

*Call graph*: called by 3 (load_or_create_cap_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path); 4 external calls (parent, create_dir_all, write, to_string).


##### `load_or_create_cap_sids`  (lines 57–86)

```
fn load_or_create_cap_sids(codex_home: &Path) -> Result<CapSids>
```

**Purpose**: Loads the sandbox capability SIDs from disk, or creates and saves them if they do not exist yet. It also understands an older storage format that contained only one plain SID string.

**Data flow**: It receives the Codex home folder, finds the `cap_sid` file, and checks whether it already exists. If the file contains JSON, it parses it as `CapSids`. If it contains an older non-empty plain string, it keeps that as the workspace SID, creates the missing newer fields, and rewrites the file as JSON. If nothing usable exists, it creates fresh workspace and read-only SIDs and saves them. It returns the complete `CapSids` set.

**Call relations**: This is the main doorway for other sandbox security setup code to get capability IDs. Workspace-specific and writable-root-specific lookup functions call it before adding more entries, and higher-level sandbox launch and permission preparation code calls it when building the security environment.

*Call graph*: calls 3 internal fn (cap_sid_file, make_random_cap_sid_string, persist_caps); called by 9 (apply_capability_denies_for_world_writable_for_permissions, equivalent_cwd_spellings_share_workspace_sid_key, write_roots_get_path_scoped_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path, run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_legacy_session_security, root_capability_sids_only_include_active_roots); 2 external calls (new, read_to_string).


##### `workspace_cap_sid_for_cwd`  (lines 89–100)

```
fn workspace_cap_sid_for_cwd(codex_home: &Path, cwd: &Path) -> Result<String>
```

**Purpose**: Returns the capability SID for a particular workspace folder, creating it if this workspace has not been seen before. This keeps each workspace’s write permission separate from other workspaces.

**Data flow**: It receives the Codex home folder and the current working directory path. It loads the saved SID data, turns the directory path into a canonical key so equivalent path spellings match, and looks for an existing SID in the workspace map. If found, it returns that SID. If missing, it creates a new SID, stores it under that path key, saves the updated data, and returns the new SID.

**Call relations**: The root-selection helper `workspace_write_cap_sid_for_root` calls this when the writable root is the workspace itself. Tests call it directly to prove that differently spelled versions of the same path share one stored SID.

*Call graph*: calls 5 internal fn (cap_sid_file, load_or_create_cap_sids, make_random_cap_sid_string, persist_caps, canonical_path_key); called by 2 (equivalent_cwd_spellings_share_workspace_sid_key, workspace_write_cap_sid_for_root).


##### `writable_root_cap_sid_for_path`  (lines 103–114)

```
fn writable_root_cap_sid_for_path(codex_home: &Path, root: &Path) -> Result<String>
```

**Purpose**: Returns the capability SID for an extra writable root outside the main workspace, creating it if needed. This prevents an old extra-root permission from automatically applying to unrelated future sandbox runs.

**Data flow**: It receives the Codex home folder and a writable root path. It loads the saved SID data, normalizes the root path into a stable key, and checks the writable-root map. If a SID is already stored, it returns it. Otherwise it creates a new SID, inserts it for that root, saves the file, and returns the new value.

**Call relations**: `workspace_write_cap_sid_for_root` calls this whenever the allowed write root is not the workspace directory itself. The tests verify that this produces a different SID from the workspace SID and that the same extra root gets the same SID when requested again.

*Call graph*: calls 5 internal fn (cap_sid_file, load_or_create_cap_sids, make_random_cap_sid_string, persist_caps, canonical_path_key); called by 1 (workspace_write_cap_sid_for_root).


##### `workspace_write_cap_sid_for_root`  (lines 116–126)

```
fn workspace_write_cap_sid_for_root(
    codex_home: &Path,
    cwd: &Path,
    root: &Path,
) -> Result<String>
```

**Purpose**: Chooses the correct capability SID for a writable root. If the root is the workspace, it uses the workspace-specific SID; if it is another allowed folder, it uses that folder’s own SID.

**Data flow**: It receives the Codex home folder, the workspace path, and the writable root path. It canonicalizes the workspace and root for comparison. If they refer to the same place, it returns the workspace SID. Otherwise it returns the SID scoped to the extra writable root.

**Call relations**: Higher-level permission-building code calls this while assembling the list of capability SIDs that should be active for a sandbox run. It delegates to `workspace_cap_sid_for_cwd` or `writable_root_cap_sid_for_path` so the right kind of isolation is used.

*Call graph*: calls 3 internal fn (workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path, canonical_path_key); called by 4 (write_roots_get_path_scoped_sids, root_capability_sids, legacy_deny_path_includes_nested_active_root_sid, root_capability_sids_only_include_active_roots).


##### `workspace_write_root_contains_path`  (lines 128–130)

```
fn workspace_write_root_contains_path(root: &Path, path: &Path) -> bool
```

**Purpose**: Checks whether one writable root contains a given path after normalizing both paths. This helps decide whether a file or folder falls inside an allowed write area.

**Data flow**: It receives a root path and another path. It canonicalizes both, then checks whether the second path starts with the root path. It returns `true` if the path is inside that root, otherwise `false`.

**Call relations**: `workspace_write_root_overlaps_path` uses this helper twice, once in each direction, to decide whether two paths overlap at all.

*Call graph*: calls 1 internal fn (canonicalize_path); called by 1 (workspace_write_root_overlaps_path).


##### `workspace_write_root_overlaps_path`  (lines 132–134)

```
fn workspace_write_root_overlaps_path(root: &Path, path: &Path) -> bool
```

**Purpose**: Checks whether a writable root and another path overlap. Overlap means either the root contains the path, or the path contains the root.

**Data flow**: It receives two paths. It asks `workspace_write_root_contains_path` whether the first contains the second, then whether the second contains the first. It returns `true` if either check succeeds.

**Call relations**: This function builds on the simpler containment helper to support permission decisions where nested folders matter. For example, it can detect both “this file is under the writable root” and “this writable root is under a protected folder.”

*Call graph*: calls 1 internal fn (workspace_write_root_contains_path).


##### `workspace_write_root_specificity`  (lines 136–138)

```
fn workspace_write_root_specificity(root: &Path) -> usize
```

**Purpose**: Measures how specific a writable root path is by counting how many path components it has. Deeper paths are more specific than broad parent folders.

**Data flow**: It receives a root path, canonicalizes it, counts the pieces of the path, and returns that count. A path like `C:\work\project\src` has more components than `C:\work`.

**Call relations**: This helper is intended for code that needs to compare or order writable roots by narrowness. It does not call other sandbox SID functions; it only relies on path normalization.

*Call graph*: calls 1 internal fn (canonicalize_path).


##### `tests::equivalent_cwd_spellings_share_workspace_sid_key`  (lines 150–175)

```
fn equivalent_cwd_spellings_share_workspace_sid_key()
```

**Purpose**: Tests that two different spellings of the same workspace path receive the same workspace SID. This protects against accidental duplicate permissions caused by Windows path case or slash differences.

**Data flow**: It creates a temporary Codex home and workspace folder. It gets the workspace’s canonical path, then creates an alternate spelling with forward slashes and uppercase letters. It asks for a workspace SID for both spellings, compares that they are equal, then reloads the saved data and checks that only one workspace entry was stored.

**Call relations**: This test exercises `workspace_cap_sid_for_cwd` and `load_or_create_cap_sids`. It confirms that their use of canonical path keys works as intended before higher-level sandbox code depends on those stable keys.

*Call graph*: calls 2 internal fn (load_or_create_cap_sids, workspace_cap_sid_for_cwd); 5 external calls (from, assert_eq!, canonicalize, create_dir_all, tempdir).


##### `tests::write_roots_get_path_scoped_sids`  (lines 178–202)

```
fn write_roots_get_path_scoped_sids()
```

**Purpose**: Tests that the main workspace and an extra writable root get separate capability SIDs. This ensures extra write permissions are scoped to the exact root that was allowed.

**Data flow**: It creates temporary Codex home, workspace, and extra-root folders. It asks `workspace_write_cap_sid_for_root` for the workspace SID and for the extra root SID. It checks that they are different, checks that requesting the extra-root SID directly returns the same value, and reloads the saved data to confirm one workspace entry and one extra-root entry were recorded.

**Call relations**: This test drives `workspace_write_cap_sid_for_root`, which in turn chooses between workspace and extra-root SID creation. It also calls `writable_root_cap_sid_for_path` and `load_or_create_cap_sids` to verify the saved state matches the intended split.

*Call graph*: calls 2 internal fn (load_or_create_cap_sids, workspace_write_cap_sid_for_root); 4 external calls (assert_eq!, assert_ne!, create_dir_all, tempdir).


### `windows-sandbox-rs/src/deny_read_resolver.rs`

`domain_logic` · `sandbox setup`

Codex sandbox policies can say “do not let the program read these files,” and those rules may be exact paths or glob patterns. A glob pattern is a path with wildcards, like `*.env`, that can match many files. Windows access control lists, or ACLs, are the operating system rules used to allow or deny file access, but they cannot directly apply a wildcard pattern. This file bridges that gap.

It first keeps exact unreadable paths as-is, even if the file does not exist yet. That matters because a secret file might be created later, and the sandbox still needs to know about it. For glob rules, it takes a snapshot of files and folders that already exist, walks the filesystem from the deepest safe starting folder, and adds anything that matches the deny-read rule.

The scanning is careful. It avoids duplicate paths, limits how deep it searches when the pattern is not truly recursive, and tracks real directory identities so symbolic links or Windows junctions cannot trap it in an endless loop. In short, this file acts like a translator: it turns broad human-friendly sandbox rules into the exact list of Windows paths that the ACL layer can deny.

#### Function details

##### `resolve_windows_deny_read_paths`  (lines 23–69)

```
fn resolve_windows_deny_read_paths(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> Result<Vec<AbsolutePathBuf>, String>
```

**Purpose**: This is the main resolver. It takes a sandbox policy and the current working directory, then produces the concrete absolute paths that should be denied for reading on Windows.

**Data flow**: It starts with an empty list and a set used to avoid duplicates. Exact unreadable roots from the policy are converted into absolute paths and added immediately. Then it collects unreadable glob patterns, builds a matcher for those patterns, chooses a scan plan for each pattern, walks the existing filesystem under that plan, and returns the final list of unique absolute paths or an error message if something is invalid.

**Call relations**: This function is the entry point for the file’s real work. It asks the policy for exact deny-read roots and glob deny-read patterns, builds a temporary restricted policy so `ReadDenyMatcher` can test paths, then hands each glob scan to `glob_scan_plan` and `collect_existing_glob_matches`. The tests call it to prove that glob expansion, missing exact paths, invalid glob errors, and alias handling behave correctly.

*Call graph*: calls 8 internal fn (get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd, restricted, try_new, as_path, collect_existing_glob_matches, glob_scan_plan, push_absolute_path); called by 3 (aliased_glob_roots_each_preserve_their_lexical_matches, glob_patterns_expand_to_existing_matches, invalid_glob_patterns_fail_before_expansion); 2 external calls (new, new).


##### `collect_existing_glob_matches`  (lines 71–123)

```
fn collect_existing_glob_matches(
    path: &Path,
    matcher: &ReadDenyMatcher,
    paths: &mut Vec<AbsolutePathBuf>,
    seen_paths: &mut HashSet<PathBuf>,
    seen_scan_dirs: &mut HashSet<PathBuf>
```

**Purpose**: This function walks through files and folders that already exist and adds the ones that match the deny-read glob rules. It is the filesystem scanner used after a glob pattern has been turned into a scan plan.

**Data flow**: It receives a starting path, a matcher, the growing output list, duplicate-tracking sets, an optional maximum depth, and the current depth. If the path does not exist, it stops. If the matcher says the path should be denied, it adds the path. If the path is a directory, it records the directory’s real location to avoid loops, checks the depth limit, reads its children, and repeats the same process for each child.

**Call relations**: It is called by `resolve_windows_deny_read_paths` for each glob pattern. When it finds a denied path, it delegates to `push_absolute_path` so all path cleanup and duplicate handling stays consistent. It uses `ReadDenyMatcher` to decide whether a visited path is actually covered by the deny-read policy.

*Call graph*: calls 2 internal fn (is_read_denied, push_absolute_path); called by 1 (resolve_windows_deny_read_paths); 5 external calls (exists, metadata, to_path_buf, canonicalize, read_dir).


##### `push_absolute_path`  (lines 125–136)

```
fn push_absolute_path(
    paths: &mut Vec<AbsolutePathBuf>,
    seen: &mut HashSet<PathBuf>,
    path: PathBuf,
) -> Result<(), String>
```

**Purpose**: This helper adds one path to the result list only if it is a valid absolute path and has not already been added. It keeps the resolver’s output clean and duplicate-free.

**Data flow**: It receives the output list, a set of paths already seen, and a candidate path. It simplifies the path, converts it into the project’s absolute-path type, and returns an error if that conversion fails. If the absolute path is new, it appends it to the output list; otherwise it leaves the list unchanged.

**Call relations**: Both `resolve_windows_deny_read_paths` and `collect_existing_glob_matches` call this helper whenever they want to add a deny-read target. This means exact policy paths and glob-discovered paths go through the same validation and duplicate-removal step.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (collect_existing_glob_matches, resolve_windows_deny_read_paths); 1 external calls (simplified).


##### `glob_scan_plan`  (lines 138–170)

```
fn glob_scan_plan(pattern: &str, configured_max_depth: Option<usize>) -> GlobScanPlan
```

**Purpose**: This function decides where a glob scan should start and how deep it should go. Its job is to avoid scanning huge parts of the disk when only a smaller directory could possibly match.

**Data flow**: It receives a glob pattern and an optional configured depth limit. It looks for the first wildcard character, then finds the deepest literal directory before that wildcard. That directory becomes the scan root. It also passes the remaining pattern text to `effective_glob_scan_max_depth` to decide the depth limit, and returns both pieces as a `GlobScanPlan`.

**Call relations**: It is called by `resolve_windows_deny_read_paths` before each filesystem walk. It hands the resolver a practical search plan, and it relies on `effective_glob_scan_max_depth` for the depth calculation. The tests call it directly to check root selection and depth behavior.

*Call graph*: calls 1 internal fn (effective_glob_scan_max_depth); called by 1 (resolve_windows_deny_read_paths); 1 external calls (from).


##### `effective_glob_scan_max_depth`  (lines 172–186)

```
fn effective_glob_scan_max_depth(
    pattern_suffix: &str,
    configured_max_depth: Option<usize>,
) -> Option<usize>
```

**Purpose**: This function calculates a safe scan depth for the part of a glob pattern that remains after the scan root. It prevents simple patterns from scanning deeper than they need to.

**Data flow**: It receives the pattern suffix and an optional user-configured maximum depth. It splits the suffix into path components. If the suffix contains `**`, meaning “match across any number of directories,” it uses the configured limit as-is. Otherwise it sets the limit to the number of remaining path components, capped by the configured maximum if one was provided.

**Call relations**: It is used only by `glob_scan_plan`. Together, they make sure the later filesystem scan searches far enough to find valid matches but not so far that a non-recursive pattern accidentally walks an entire tree.

*Call graph*: called by 1 (glob_scan_plan).


##### `tests::unreadable_glob_entry`  (lines 205–210)

```
fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry
```

**Purpose**: This test helper creates a sandbox policy entry that denies reads for a glob pattern. It keeps the test setup short and clear.

**Data flow**: It receives a pattern string. It wraps that string as a `GlobPattern`, marks the access mode as deny, and returns a complete `FileSystemSandboxEntry` ready to put into a policy.

**Call relations**: The test cases call this helper when they need a deny-read glob rule. It feeds those rules into `FileSystemSandboxPolicy::restricted`, which is then used by the resolver or by scan-plan checks.


##### `tests::unreadable_path_entry`  (lines 212–219)

```
fn unreadable_path_entry(path: PathBuf) -> FileSystemSandboxEntry
```

**Purpose**: This test helper creates a sandbox policy entry that denies reads for one exact path. It is used to test behavior that should not depend on glob expansion.

**Data flow**: It receives a path buffer, converts it into the project’s absolute-path type, wraps it as an exact filesystem path, marks the access mode as deny, and returns the finished policy entry.

**Call relations**: The exact-missing-path test uses this helper to build a policy entry before calling the resolver. It depends on the same absolute-path validation used elsewhere in the project.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `tests::scan_root_uses_literal_prefix_before_glob`  (lines 222–239)

```
fn scan_root_uses_literal_prefix_before_glob()
```

**Purpose**: This test checks that glob scanning starts at the deepest ordinary directory before the first wildcard. That avoids unnecessarily scanning from the current directory or a whole drive.

**Data flow**: It supplies several glob patterns to `glob_scan_plan`, including Unix-style and Windows-style paths. It compares each returned root path with the expected scan root.

**Call relations**: The test harness runs this to protect the behavior used by `resolve_windows_deny_read_paths`. If this failed, glob scans could become much broader and slower than intended.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::scan_depth_is_bounded_for_non_recursive_globs`  (lines 242–255)

```
fn scan_depth_is_bounded_for_non_recursive_globs()
```

**Purpose**: This test checks that non-recursive glob patterns get a limited scan depth. A pattern like `*.env` should not search through every nested folder.

**Data flow**: It passes several patterns into `glob_scan_plan` and inspects the `max_depth` value in the returned plan. It expects shallow patterns to have small fixed limits and recursive `**` patterns to be unlimited when no configured cap is present.

**Call relations**: This test protects the depth-planning logic that `resolve_windows_deny_read_paths` relies on before calling the recursive scanner.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::configured_depth_caps_recursive_glob_scans`  (lines 258–267)

```
fn configured_depth_caps_recursive_glob_scans()
```

**Purpose**: This test confirms that a configured maximum depth is respected. It matters because recursive glob scans can otherwise become expensive on large directory trees.

**Data flow**: It calls `glob_scan_plan` with patterns and a configured depth of `Some(...)`. It then checks that recursive and non-recursive scans are capped as expected.

**Call relations**: The test harness uses this to verify the connection between scan planning and the policy’s glob scan depth setting. That setting is later used by `resolve_windows_deny_read_paths` during real resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::exact_missing_paths_are_preserved`  (lines 270–287)

```
fn exact_missing_paths_are_preserved()
```

**Purpose**: This test proves that exact deny-read paths are kept even when the file does not exist yet. That is important for blocking files that may be created later.

**Data flow**: It creates a temporary directory, builds an absolute current working directory, chooses a missing file path, and creates a restricted policy denying that path. It calls the resolver and checks that the missing absolute path still appears in the output.

**Call relations**: The test calls the resolver through the same path used in production. It specifically exercises the part of `resolve_windows_deny_read_paths` that adds exact unreadable roots through `push_absolute_path` without first checking whether the file exists.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 3 external calls (new, assert_eq!, vec!).


##### `tests::glob_patterns_expand_to_existing_matches`  (lines 290–313)

```
fn glob_patterns_expand_to_existing_matches()
```

**Purpose**: This test checks that recursive glob deny rules expand to the matching files that already exist. It makes sure matching secret files are found both at the root and in nested folders.

**Data flow**: It creates a temporary folder, writes two `.env` files and one non-matching text file, builds a deny-read glob policy, and runs the resolver. It converts the result into a set and compares it with the two expected `.env` paths.

**Call relations**: This test calls `resolve_windows_deny_read_paths`, which then uses `glob_scan_plan`, `ReadDenyMatcher`, and `collect_existing_glob_matches`. It confirms that the whole glob expansion path works end to end.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_windows_deny_read_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `tests::invalid_glob_patterns_fail_before_expansion`  (lines 316–330)

```
fn invalid_glob_patterns_fail_before_expansion()
```

**Purpose**: This test verifies that invalid glob patterns produce a clear error instead of silently scanning or ignoring the rule. That helps catch broken sandbox policies early.

**Data flow**: It builds a policy containing an invalid glob range, calls the resolver, and expects an error. It checks that the error message mentions both an invalid deny-read glob pattern and the invalid range.

**Call relations**: This test calls `resolve_windows_deny_read_paths` and exercises the point where the resolver asks `ReadDenyMatcher` to build a matcher. If matcher construction fails, the resolver returns the error before doing filesystem expansion.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_windows_deny_read_paths); 3 external calls (new, assert!, vec!).


##### `tests::non_recursive_globs_do_not_expand_nested_matches`  (lines 333–350)

```
fn non_recursive_globs_do_not_expand_nested_matches()
```

**Purpose**: This test ensures that a non-recursive glob only matches files at the intended level. For example, `/*.env` should not also block `app/.env`.

**Data flow**: It creates one `.env` file at the temporary directory root and another inside a subdirectory. It builds a non-recursive deny-read glob policy, runs the resolver, and checks that only the root file is returned.

**Call relations**: The test protects the interaction between `glob_scan_plan` and `collect_existing_glob_matches`. If scan depth were too large, the resolver could incorrectly add nested files that the policy did not mean to deny.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `tests::aliased_glob_roots_each_preserve_their_lexical_matches`  (lines 354–380)

```
fn aliased_glob_roots_each_preserve_their_lexical_matches()
```

**Purpose**: This Unix-only test checks that two different symbolic-link paths to the same real directory are both preserved in the output. This matters because the ACL layer may need the path form that matched the policy, not only the final real location.

**Data flow**: It creates a real target directory with a secret file, then creates two symbolic links pointing at that target. It builds two deny-read glob rules, one through each alias, runs the resolver, and checks that the results contain both alias-based paths.

**Call relations**: The test calls `resolve_windows_deny_read_paths`, which uses canonical directory identities only to avoid scan loops while keeping the original path spelling for matched results. This confirms that loop prevention does not erase distinct policy-facing paths.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_windows_deny_read_paths); 6 external calls (new, assert_eq!, create_dir_all, write, symlink, vec!).


### `windows-sandbox-rs/src/resolved_permissions.rs`

`domain_logic` · `sandbox setup before launching a restricted Windows command`

Codex has user-facing permission profiles, such as “read only” or “workspace write.” The Windows sandbox cannot use those profiles directly. It needs concrete Windows paths and a choice of sandbox token, which is like choosing the right set of keys before entering a locked building. This file performs that translation.

The main type, `ResolvedWindowsSandboxPermissions`, stores the resolved file-system policy and network policy. It only accepts managed, restricted profiles, because profiles that disable sandboxing or allow unrestricted file access cannot be safely enforced by this Windows sandbox layer. If a profile refers to symbolic workspace roots, such as “the project folders,” this file expands those placeholders into the actual runtime workspace paths.

It also answers practical questions used by the rest of the sandbox code: should network access be blocked, are platform-default read paths included, which roots are readable from the current working directory, and which roots are writable. Writable temporary directories get special Windows treatment: a `Tmpdir` permission is converted into the actual `TEMP` and `TMP` environment variable paths, if they are absolute.

Finally, `token_mode_for_permission_profile` chooses between a read-only restricted token and a token that grants write capabilities. It refuses full-disk write access because this sandbox cannot enforce that safely. The tests in the file pin down these important edge cases.

#### Function details

##### `token_mode_for_permission_profile`  (lines 38–59)

```
fn token_mode_for_permission_profile(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    cwd: &Path,
    env_map: &HashMap<String, String>,
) -> Result<WindowsSan
```

**Purpose**: Chooses which family of Windows restricted token is needed for a permission profile. It returns a read-only token mode when no writable roots are allowed, and a writable-roots token mode when the profile permits writing somewhere.

**Data flow**: It receives a permission profile, the workspace roots, the command’s current directory, and environment variables. It first resolves the profile into Windows-ready permissions, rejects full-disk write access, then checks whether any writable roots exist for the current directory. The result is either `ReadOnlyCapability`, `WritableRootsCapability`, or an error explaining why the profile cannot be enforced.

**Call relations**: This is the top-level decision point for token selection. It calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots` to do the profile translation, then uses the resolved writable roots to choose the token mode. The tests call it to confirm read-only profiles, workspace-write profiles, and unsafe full-disk write profiles behave correctly.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); called by 3 (token_mode_for_profile_with_writable_roots_uses_write_capabilities, token_mode_for_profile_without_writable_roots_uses_readonly_capability, token_mode_rejects_full_disk_write_entries); 1 external calls (bail!).


##### `ResolvedWindowsSandboxPermissions::try_from_permission_profile`  (lines 62–78)

```
fn try_from_permission_profile(permission_profile: &PermissionProfile) -> Result<Self>
```

**Purpose**: Converts a Codex permission profile into a Windows-local permission object, but only if the profile is safe for this sandbox to enforce. It rejects disabled sandboxing and unrestricted file-system access.

**Data flow**: It takes a `PermissionProfile`. If the profile is not a managed profile, it returns an error. If the profile’s file-system policy is not restricted, it also returns an error. Otherwise, it extracts the runtime file-system and network policies and stores them in `ResolvedWindowsSandboxPermissions`.

**Call relations**: This is the basic resolver used before any Windows sandbox-specific decisions are made. It calls the protocol layer’s `to_runtime_permissions` method to turn the profile into concrete policies. Other code, including tests and the workspace-root-aware resolver, relies on it as the first safety gate.

*Call graph*: calls 1 internal fn (to_runtime_permissions); called by 3 (permission_profile_rejects_disabled_profiles, permission_profile_rejects_unrestricted_managed_filesystem, permission_profile_workspace_write_uses_windows_temp_env_vars); 2 external calls (bail!, matches!).


##### `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`  (lines 82–91)

```
fn try_from_permission_profile_for_workspace_roots(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Result<Self>
```

**Purpose**: Converts a managed permission profile into Windows-ready permissions and expands symbolic workspace-root entries into real paths. This is the version used when the sandbox knows the actual workspace folders for the current run.

**Data flow**: It receives a permission profile and a list of absolute workspace roots. It first calls `try_from_permission_profile` to validate and extract the policy. Then it replaces project-root placeholders in the file-system policy with the supplied workspace root paths. It returns the updated `ResolvedWindowsSandboxPermissions` or an error if the profile cannot be enforced.

**Call relations**: This is the main entry point used by the broader Windows sandbox setup code, including elevated setup, allow-path computation, world-writable scans, and sandbox capture. It builds on `try_from_permission_profile` and hands back a resolved permission object that later steps can query.

*Call graph*: called by 19 (run_elevated_setup, spawn_world_writable_scan, world_writable_warning_details, run_elevated_setup, compute_allow_paths, run_windows_sandbox_capture_for_permission_profile, permission_profile_workspace_root_uses_runtime_workspace_roots, permission_profile_workspace_roots_expand_all_runtime_workspace_roots, token_mode_for_permission_profile, run_setup_refresh (+9 more)); 1 external calls (try_from_permission_profile).


##### `ResolvedWindowsSandboxPermissions::should_apply_network_block`  (lines 93–95)

```
fn should_apply_network_block(&self) -> bool
```

**Purpose**: Answers whether the Windows sandbox should block network access. It is true when the resolved network policy says networking is not enabled.

**Data flow**: It reads the stored network policy from `ResolvedWindowsSandboxPermissions`. If that policy is disabled or restricted in a way that means network access is not enabled, it returns `true`; otherwise it returns `false`.

**Call relations**: This is a small query method used by sandbox setup code when deciding whether to add network-blocking rules. It delegates the meaning of “enabled” to the network policy itself.

*Call graph*: calls 1 internal fn (is_enabled).


##### `ResolvedWindowsSandboxPermissions::network_policy`  (lines 97–99)

```
fn network_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Returns the resolved network policy stored in this Windows permission object. Callers use it when they need the exact network setting, not just a yes-or-no block decision.

**Data flow**: It reads the `network` field and returns it unchanged. Nothing else is modified.

**Call relations**: This method is called by `from_permissions`, which needs to carry the network policy forward while building another sandbox configuration object.

*Call graph*: called by 1 (from_permissions).


##### `ResolvedWindowsSandboxPermissions::is_enforceable_by_windows_sandbox`  (lines 101–103)

```
fn is_enforceable_by_windows_sandbox(&self) -> bool
```

**Purpose**: Checks whether these permissions are of the restricted file-system kind that the Windows sandbox knows how to enforce. It is a safety check before applying Windows-specific restrictions.

**Data flow**: It looks at the stored file-system policy kind. If it is `Restricted`, it returns `true`; otherwise it returns `false`.

**Call relations**: World-writable protection code calls this before applying capability denies. The method keeps that caller from trying to enforce a permission shape that does not fit this sandbox model.

*Call graph*: called by 1 (apply_capability_denies_for_world_writable_for_permissions); 1 external calls (matches!).


##### `ResolvedWindowsSandboxPermissions::has_full_disk_read_access`  (lines 105–107)

```
fn has_full_disk_read_access(&self) -> bool
```

**Purpose**: Reports whether the file-system policy allows reading the whole disk. This matters because full read access changes how the sandbox gathers readable paths.

**Data flow**: It asks the stored file-system policy whether full-disk read access is present. It returns that answer as a boolean and does not change any state.

**Call relations**: Read-root gathering code calls this while deciding whether it needs to enumerate specific readable roots or can treat the disk as broadly readable.

*Call graph*: calls 1 internal fn (has_full_disk_read_access); called by 1 (gather_read_roots).


##### `ResolvedWindowsSandboxPermissions::include_platform_defaults`  (lines 109–111)

```
fn include_platform_defaults(&self) -> bool
```

**Purpose**: Reports whether the file-system policy should include Windows platform-default readable locations. These defaults are common system paths that programs may need just to start and run normally.

**Data flow**: It asks the stored file-system policy whether platform defaults are included. The returned boolean tells the caller whether to add those default paths.

**Call relations**: Read-root gathering code calls this when assembling the final set of paths a sandboxed process can read.

*Call graph*: calls 1 internal fn (include_platform_defaults); called by 1 (gather_read_roots).


##### `ResolvedWindowsSandboxPermissions::readable_roots_for_cwd`  (lines 113–119)

```
fn readable_roots_for_cwd(&self, cwd: &Path) -> Vec<PathBuf>
```

**Purpose**: Computes the concrete folders that should be readable for a command running from a given current directory. It turns policy entries into ordinary Windows path buffers.

**Data flow**: It receives the command’s current directory. It asks the file-system policy for readable roots relative to that directory, converts the project’s absolute-path wrapper into standard `PathBuf` values, and returns the list.

**Call relations**: The read-root gathering flow calls this when building the sandbox’s allow-list for read access. It relies on the lower-level file-system policy to understand current-directory-relative rules.

*Call graph*: calls 1 internal fn (get_readable_roots_with_cwd); called by 1 (gather_read_roots).


##### `ResolvedWindowsSandboxPermissions::uses_write_capabilities_for_cwd`  (lines 121–127)

```
fn uses_write_capabilities_for_cwd(
        &self,
        cwd: &Path,
        env_map: &HashMap<String, String>,
    ) -> bool
```

**Purpose**: Answers whether a command running from this current directory needs any write capability at all. It is a convenience check used before setting up more expensive or stricter Windows write rules.

**Data flow**: It receives the current directory and environment variables. It calls `writable_roots_for_cwd` and returns `true` if that list is not empty, or `false` if there are no writable roots.

**Call relations**: Several sandbox setup paths call this before preparing write-capability handling, including world-writable deny logic, legacy session capability roots, and elevated spawn setup. It depends entirely on `writable_roots_for_cwd` for the actual path calculation.

*Call graph*: calls 1 internal fn (writable_roots_for_cwd); called by 3 (apply_capability_denies_for_world_writable_for_permissions, legacy_session_capability_roots, prepare_elevated_spawn_context_for_permissions).


##### `ResolvedWindowsSandboxPermissions::writable_roots_for_cwd`  (lines 129–170)

```
fn writable_roots_for_cwd(
        &self,
        cwd: &Path,
        env_map: &HashMap<String, String>,
    ) -> Vec<WindowsWritableRoot>
```

**Purpose**: Computes the concrete folders the sandboxed command may write to. It also translates Codex’s temporary-directory permission into Windows `TEMP` and `TMP` paths.

**Data flow**: It receives the current directory and an environment map. It clones the file-system policy, removes special temporary-directory entries from the normal path calculation, asks the policy for writable roots, and converts those roots into `WindowsWritableRoot` values with any read-only subpaths preserved. If the original policy had a writable `Tmpdir` entry, it adds absolute temp paths from `TEMP` and `TMP`. The result is a list of writable Windows roots.

**Call relations**: This is the main write-path calculator used by allow-path computation, write-root gathering, full-read-root gathering, and `uses_write_capabilities_for_cwd`. It calls `has_writable_tmpdir_entry` to detect temp permission and `windows_temp_env_roots` to find the actual Windows temp directories.

*Call graph*: calls 2 internal fn (has_writable_tmpdir_entry, windows_temp_env_roots); called by 4 (compute_allow_paths_for_permissions, uses_write_capabilities_for_cwd, gather_full_read_roots_for_permissions, gather_write_roots_for_permissions); 1 external calls (clone).


##### `ResolvedWindowsSandboxPermissions::has_writable_tmpdir_entry`  (lines 172–184)

```
fn has_writable_tmpdir_entry(&self) -> bool
```

**Purpose**: Checks whether the policy explicitly allows writing to the special temporary directory. This is needed because Windows temp folders come from environment variables rather than a single fixed path.

**Data flow**: It scans the stored file-system policy entries. If it finds a `Tmpdir` special path whose access mode allows writing, it returns `true`; otherwise it returns `false`.

**Call relations**: `writable_roots_for_cwd` calls this before adding `TEMP` and `TMP` paths to the writable root list. This keeps temporary-directory handling separate from ordinary path expansion.

*Call graph*: called by 1 (writable_roots_for_cwd).


##### `windows_temp_env_roots`  (lines 187–198)

```
fn windows_temp_env_roots(env_map: &HashMap<String, String>) -> Vec<PathBuf>
```

**Purpose**: Finds the actual Windows temporary directories from the `TEMP` and `TMP` environment variables. It only keeps absolute paths, because sandbox rules need complete paths rather than relative ones.

**Data flow**: It receives an environment-variable map. For each of `TEMP` and `TMP`, it first looks in that map, then falls back to the real process environment. It converts found values into paths, filters out relative paths, and returns the remaining absolute paths.

**Call relations**: `writable_roots_for_cwd` calls this when a profile grants writable temporary-directory access. The function provides the concrete Windows paths that stand in for Codex’s symbolic `Tmpdir` permission.

*Call graph*: called by 1 (writable_roots_for_cwd).


##### `tests::workspace_roots_for`  (lines 211–213)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds a one-item workspace-root list for tests. It keeps the test setup short and makes sure the supplied path is treated as an absolute workspace root.

**Data flow**: It receives a path, converts it into an `AbsolutePathBuf`, wraps it in a vector, and returns that vector. If the path is not absolute, the test fails immediately.

**Call relations**: Several tests call this helper before invoking permission resolution or token-mode selection. It provides the runtime workspace roots expected by `try_from_permission_profile_for_workspace_roots` and `token_mode_for_permission_profile`.

*Call graph*: 1 external calls (vec!).


##### `tests::permission_profile_workspace_write_uses_windows_temp_env_vars`  (lines 216–245)

```
fn permission_profile_workspace_write_uses_windows_temp_env_vars()
```

**Purpose**: Verifies that a workspace-write profile includes the Windows temp directory from `TEMP` and `TMP` as writable roots. This protects the special Windows behavior for temporary files.

**Data flow**: The test creates a temporary workspace and a temporary directory, places that directory into an environment map as both `TEMP` and `TMP`, resolves a workspace-write profile, and asks for writable roots. It compares the result with the expected set: the temp directory and the canonical current workspace directory.

**Call relations**: This test calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile` and then exercises `writable_roots_for_cwd` indirectly through the resolved permissions. It confirms the path added by `windows_temp_env_roots` is included.

*Call graph*: calls 2 internal fn (workspace_write, try_from_permission_profile); 5 external calls (new, new, assert_eq!, canonicalize, create_dir_all).


##### `tests::permission_profile_workspace_root_uses_runtime_workspace_roots`  (lines 248–284)

```
fn permission_profile_workspace_root_uses_runtime_workspace_roots()
```

**Purpose**: Verifies that a symbolic project-root permission is expanded to the actual workspace root supplied at runtime. This ensures sandbox rules follow the current session’s real workspace, not a placeholder.

**Data flow**: The test creates a workspace with a subdirectory as the command’s current directory. It builds a managed profile that grants write access to project roots, supplies the runtime workspace root, resolves the profile, and asks for writable roots. The result must be the canonical workspace root.

**Call relations**: This test calls `workspace_roots_for` and `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`. It focuses on the workspace-root materialization step before writable roots are calculated.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 6 external calls (new, new, assert_eq!, create_dir_all, vec!, workspace_roots_for).


##### `tests::permission_profile_workspace_roots_expand_all_runtime_workspace_roots`  (lines 287–378)

```
fn permission_profile_workspace_roots_expand_all_runtime_workspace_roots()
```

**Purpose**: Verifies that project-root placeholders expand across every runtime workspace root, including subpaths and glob patterns. A glob pattern is a path-matching rule, such as “all `.env` files.”

**Data flow**: The test creates two absolute workspace roots and a profile with three entries: write each project root, deny each `.git` folder, and deny matching `.env` files. After resolving the profile with both roots, it compares the resulting file-system policy with the expected expanded entries for both roots.

**Call relations**: This test calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`. It checks that the resolver expands one symbolic policy into multiple concrete path and pattern entries.

*Call graph*: calls 2 internal fn (from_absolute_path, try_from_permission_profile_for_workspace_roots); 3 external calls (new, assert_eq!, vec!).


##### `tests::token_mode_for_profile_without_writable_roots_uses_readonly_capability`  (lines 381–396)

```
fn token_mode_for_profile_without_writable_roots_uses_readonly_capability()
```

**Purpose**: Verifies that a read-only permission profile selects the read-only Windows token mode. This confirms the sandbox does not request write powers when none are needed.

**Data flow**: The test creates a temporary workspace, builds a workspace-root list, and calls `token_mode_for_permission_profile` with a read-only profile. It expects the returned token mode to be `ReadOnlyCapability`.

**Call relations**: This test exercises the top-level token-mode decision function. It depends on writable-root calculation returning an empty list for a read-only profile.

*Call graph*: calls 2 internal fn (read_only, token_mode_for_permission_profile); 5 external calls (new, new, assert_eq!, create_dir_all, workspace_roots_for).


##### `tests::token_mode_for_profile_with_writable_roots_uses_write_capabilities`  (lines 399–414)

```
fn token_mode_for_profile_with_writable_roots_uses_write_capabilities()
```

**Purpose**: Verifies that a workspace-write profile selects the Windows token mode that supports writable roots. This confirms write permissions are reflected in the token choice.

**Data flow**: The test creates a temporary workspace, builds the workspace-root list, and calls `token_mode_for_permission_profile` with a workspace-write profile. It expects `WritableRootsCapability` as the result.

**Call relations**: This test calls the same top-level token-mode function as the read-only test, but with a profile that should produce writable roots. It proves that token selection changes when write access is present.

*Call graph*: calls 2 internal fn (workspace_write, token_mode_for_permission_profile); 5 external calls (new, new, assert_eq!, create_dir_all, workspace_roots_for).


##### `tests::permission_profile_rejects_disabled_profiles`  (lines 417–427)

```
fn permission_profile_rejects_disabled_profiles()
```

**Purpose**: Verifies that disabled sandbox profiles are rejected by Windows permission resolution. A disabled profile means there is no managed sandbox policy to enforce.

**Data flow**: The test passes `PermissionProfile::Disabled` into `try_from_permission_profile`. It expects an error and checks that the error message explains only managed profiles can be enforced.

**Call relations**: This test exercises the first safety gate inside `ResolvedWindowsSandboxPermissions::try_from_permission_profile`. It ensures callers do not accidentally treat “sandbox disabled” as a valid restricted Windows setup.

*Call graph*: calls 1 internal fn (try_from_permission_profile); 1 external calls (assert!).


##### `tests::permission_profile_rejects_unrestricted_managed_filesystem`  (lines 430–444)

```
fn permission_profile_rejects_unrestricted_managed_filesystem()
```

**Purpose**: Verifies that managed profiles with unrestricted file-system access are rejected. The Windows sandbox layer in this file only supports restricted file-system policies.

**Data flow**: The test builds a managed profile whose file-system permission is unrestricted and whose network policy is restricted. It passes that profile to `try_from_permission_profile`, expects an error, and checks that the message mentions restricted managed file-system permissions.

**Call relations**: This test targets the second safety gate in `ResolvedWindowsSandboxPermissions::try_from_permission_profile`. It makes sure unrestricted file access is not accepted as enforceable by this Windows sandbox path.

*Call graph*: calls 1 internal fn (try_from_permission_profile); 1 external calls (assert!).


##### `tests::token_mode_rejects_full_disk_write_entries`  (lines 447–477)

```
fn token_mode_rejects_full_disk_write_entries()
```

**Purpose**: Verifies that token-mode selection rejects profiles asking for full-disk write access. This matters because the Windows sandbox code cannot safely enforce a permission that broad.

**Data flow**: The test creates a workspace and a managed restricted profile with write access to the root of the disk. It calls `token_mode_for_permission_profile`, expects an error, and checks that the error message says full-disk writes cannot be enforced.

**Call relations**: This test exercises the explicit full-disk-write check in `token_mode_for_permission_profile`. It confirms the top-level token decision fails closed instead of choosing a token for an unsafe profile.

*Call graph*: calls 1 internal fn (token_mode_for_permission_profile); 6 external calls (new, new, assert!, create_dir_all, vec!, workspace_roots_for).


### `windows-sandbox-rs/src/allow.rs`

`domain_logic` · `sandbox setup before launching a command`

A sandbox needs a clear boundary: "the command may write here, but not there." This file builds that boundary for Windows. It starts from already-resolved sandbox permissions, the command's current working directory, and selected environment variables such as temporary-folder paths. From that, it produces an AllowDenyPaths value: one set of paths to allow for writing, and one set of paths to deny even if they sit inside an allowed folder.

The important idea is that broad write access can still need small protected pockets. For example, a workspace may be writable, but its .git folder, .codex folder, or .agents folder may need to stay read-only. This is like giving someone a key to an office while keeping the filing cabinet locked.

The main function asks the resolved permission object for writable roots that apply to the command's current directory. It normalizes each writable root into a stable Windows-friendly path, adds it only if it actually exists, and then adds any existing read-only subpaths to the deny set. Missing paths are ignored, so the sandbox is not cluttered with rules for things that are not present. The tests cover common policy choices: extra writable roots, workspace roots, temporary folders, Unix-style /tmp being irrelevant on Windows, and protected project metadata folders.

#### Function details

##### `compute_allow_paths_for_permissions`  (lines 14–42)

```
fn compute_allow_paths_for_permissions(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
) -> AllowDenyPaths
```

**Purpose**: Builds the concrete allow and deny path lists for a sandbox run. It answers the practical question: which existing places on disk should the command be able to write, and which existing subpaths should remain protected?

**Data flow**: It receives resolved permissions, the command's current working directory, and an environment-variable map. It asks the permissions object for writable roots that apply in that situation, normalizes each writable root path, keeps only paths that exist, and collects protected read-only subpaths into a separate deny set. It returns an AllowDenyPaths value containing those two sets.

**Call relations**: This is the production helper that other sandbox-building code relies on. It is called when building deny-write payloads, applying older session access-control rules, computing legacy capability roots, and preparing an elevated spawn context. In tests, tests::compute_allow_paths wraps it so each test can focus on a policy scenario rather than permission-resolution setup.

*Call graph*: calls 1 internal fn (writable_roots_for_cwd); called by 5 (compute_allow_paths, build_payload_deny_write_paths, apply_legacy_session_acl_rules, legacy_session_capability_roots, prepare_elevated_spawn_context_for_permissions); 2 external calls (new, canonicalize).


##### `tests::workspace_write_profile`  (lines 53–64)

```
fn workspace_write_profile(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> PermissionProfile
```

**Purpose**: Creates a test permission profile that allows writing in workspace-related locations. The test can choose whether temporary directories should be excluded.

**Data flow**: It receives extra writable roots and two boolean choices about excluding temporary locations. It passes those choices into the protocol helper that creates a workspace-write permission profile. The result is a PermissionProfile ready for the test to resolve and use.

**Call relations**: Most tests call this helper before computing allow paths. It hides the noisy setup detail of creating a workspace-write profile, so the tests can read more like examples of expected sandbox behavior.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `tests::workspace_roots_for`  (lines 66–68)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Turns one workspace path into the list format expected by the permission resolver. It is a small convenience helper for tests that only need one workspace root.

**Data flow**: It receives a filesystem path, checks and converts it into an absolute workspace path type, and wraps it in a one-item vector. The output is the workspace-root list passed into permission resolution.

**Call relations**: The test cases use this before calling tests::compute_allow_paths. It supplies the runtime workspace root that lets the permission resolver decide what the command's workspace is.

*Call graph*: 1 external calls (vec!).


##### `tests::compute_allow_paths`  (lines 70–83)

```
fn compute_allow_paths(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
        command_cwd: &Path,
        env_map: &HashMap<String, String>,
    ) -> All
```

**Purpose**: Connects test-friendly permission profiles to the real allow-path computation. It lets tests start with a PermissionProfile and still exercise the production function.

**Data flow**: It receives a permission profile, workspace roots, the command's current directory, and an environment map. It first resolves the profile for those workspace roots, then passes the resolved permissions into compute_allow_paths_for_permissions. It returns the resulting allow and deny sets.

**Call relations**: All behavior-focused tests call this helper. It sits between the test setup helpers and the production function, ensuring the tests use the same permission-resolution path as real sandbox setup.

*Call graph*: calls 2 internal fn (compute_allow_paths_for_permissions, try_from_permission_profile_for_workspace_roots).


##### `tests::includes_additional_writable_roots`  (lines 86–119)

```
fn includes_additional_writable_roots()
```

**Purpose**: Checks that an explicitly added writable root is included along with the command workspace. This protects the feature where a user or policy grants write access to an extra folder.

**Data flow**: The test creates temporary workspace and extra-root directories, builds a workspace-write profile containing the extra root, resolves paths through tests::compute_allow_paths, and inspects the result. The expected output is that both existing directories appear in the allow set and the deny set is empty.

**Call relations**: The Rust test runner calls this test. Inside, it uses tests::workspace_write_profile, tests::workspace_roots_for, and tests::compute_allow_paths to drive the real compute_allow_paths_for_permissions function.

*Call graph*: 8 external calls (new, new, assert!, create_dir_all, vec!, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::uses_runtime_workspace_roots_for_workspace_root`  (lines 122–153)

```
fn uses_runtime_workspace_roots_for_workspace_root()
```

**Purpose**: Checks that the sandbox allows the actual runtime workspace root, not merely the command's deeper current directory. This matters when a command starts inside a subfolder but should still be allowed to write across the workspace.

**Data flow**: The test creates a workspace with a subdirectory as the command's current directory. It builds a profile with no extra roots, computes allow paths, and verifies that the workspace root is allowed while the subdirectory itself is not separately added as its own allow rule. The deny set should stay empty.

**Call relations**: The test runner invokes it as part of the allow-path test suite. It uses the shared test helpers, which in turn reach the production computation through tests::compute_allow_paths.

*Call graph*: 7 external calls (new, new, assert!, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::excludes_tmp_env_vars_when_requested`  (lines 156–191)

```
fn excludes_tmp_env_vars_when_requested()
```

**Purpose**: Checks that TEMP and TMP environment-variable folders are not allowed when the policy says to exclude them. This prevents accidental write access to temporary folders when that access has been deliberately turned off.

**Data flow**: The test creates a workspace and a temporary directory, places that temporary directory in the TEMP and TMP environment entries, and builds a profile that excludes environment temporary folders. After computing paths, it expects the workspace to be allowed, the temporary directory not to be allowed, and no denied subpaths.

**Call relations**: The test runner calls this test. The test uses the same helper chain as the others, ending in compute_allow_paths_for_permissions, to verify the real policy behavior.

*Call graph*: 7 external calls (new, new, assert!, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::includes_tmp_env_vars_when_requested`  (lines 194–227)

```
fn includes_tmp_env_vars_when_requested()
```

**Purpose**: Checks that TEMP and TMP environment-variable folders are allowed when the policy permits them. This confirms that tools needing temporary write space can receive it.

**Data flow**: The test creates a workspace and a temporary directory, records the temporary directory in TEMP and TMP, and builds a profile that does not exclude those folders. It computes the allow paths and compares them to the expected set containing the workspace and temporary directory. The deny set should be empty.

**Call relations**: The test runner invokes it. It builds its setup through tests::workspace_write_profile and tests::workspace_roots_for, then uses tests::compute_allow_paths to exercise the production computation.

*Call graph*: 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::ignores_unix_slash_tmp_for_windows_allow_roots`  (lines 230–254)

```
fn ignores_unix_slash_tmp_for_windows_allow_roots()
```

**Purpose**: Checks that the Unix-style /tmp rule does not add anything special on Windows. This keeps Windows sandbox rules tied to real Windows paths rather than Unix conventions.

**Data flow**: The test creates only a workspace directory and builds a profile where Unix /tmp would not be excluded, while environment temporary folders are excluded. After computing paths, it expects only the workspace to be allowed and no deny paths to appear.

**Call relations**: The Rust test runner calls this test. It uses the shared profile, workspace-root, and compute helpers to confirm the Windows-specific behavior of compute_allow_paths_for_permissions.

*Call graph*: 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::denies_git_dir_inside_writable_root`  (lines 257–285)

```
fn denies_git_dir_inside_writable_root()
```

**Purpose**: Checks that a .git directory inside an allowed workspace is still put into the deny set. This protects repository metadata even when the rest of the workspace is writable.

**Data flow**: The test creates a workspace with an actual .git directory, computes allow and deny paths, and compares the result to the expected sets. The workspace should be allowed, while the .git directory should be denied.

**Call relations**: The test runner invokes it. The helper path resolves the permission profile and calls compute_allow_paths_for_permissions, confirming that protected subpaths supplied by permission resolution become deny rules.

*Call graph*: 8 external calls (new, new, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::denies_git_file_inside_writable_root`  (lines 288–317)

```
fn denies_git_file_inside_writable_root()
```

**Purpose**: Checks that a .git file, not just a .git directory, is protected inside a writable workspace. This matters for Git worktrees, where .git can be a file pointing elsewhere.

**Data flow**: The test creates a workspace and writes a .git file into it. It computes allow and deny paths, then expects the workspace in the allow set and the .git file in the deny set.

**Call relations**: The test runner calls this scenario. Through the shared helpers, it verifies that compute_allow_paths_for_permissions respects protected subpaths whether they are files or directories.

*Call graph*: 9 external calls (new, new, assert_eq!, canonicalize, create_dir_all, write, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::denies_codex_and_agents_inside_writable_root`  (lines 320–353)

```
fn denies_codex_and_agents_inside_writable_root()
```

**Purpose**: Checks that .codex and .agents directories inside a writable workspace are still protected. These folders may contain tool or agent state that should not be freely modified by sandboxed commands.

**Data flow**: The test creates a workspace containing .codex and .agents directories. It computes the sandbox paths and expects the workspace to be allowed while both protected directories are returned in the deny set.

**Call relations**: The test runner invokes it with the same helper chain used by the other tests. It confirms that protected project metadata directories provided by permission resolution are passed through into the final deny paths.

*Call graph*: 8 external calls (new, new, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::skips_protected_subdirs_when_missing`  (lines 356–379)

```
fn skips_protected_subdirs_when_missing()
```

**Purpose**: Checks that missing protected folders are not added to the deny set. This keeps the sandbox rule list focused on paths that actually exist.

**Data flow**: The test creates a workspace without protected subdirectories, computes allow and deny paths, and checks that there is exactly one allowed path and no denied paths. The before state has no .git, .codex, or .agents entries; the after state has no deny rules for them.

**Call relations**: The Rust test runner calls this test. It exercises compute_allow_paths_for_permissions through the shared test helper and confirms the function's existence check for deny paths.

*Call graph*: 8 external calls (new, new, assert!, assert_eq!, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


### `core/src/windows_sandbox.rs`

`orchestration` · `config load and Windows sandbox setup`

On Windows, Codex can run commands inside a sandbox, which is a protective boundary that limits what those commands can read or change. This file is the bridge between user configuration, feature flags, the Windows-specific sandbox engine, and telemetry. Without it, Codex would not have one clear place to decide whether sandboxing is off, using the older restricted-token mode, or using the newer elevated setup mode.

The file first translates settings into a simple sandbox level. It prefers an explicit Windows sandbox setting from the config file, then falls back to older feature-flag names so existing users do not lose their behavior after an upgrade. It also reads whether the sandbox should use a private desktop, defaulting to yes.

For actual setup, it wraps Windows-only sandbox calls with safe cross-platform functions. On Windows, these functions call the real setup code. On other operating systems, they either return false or produce a clear error, like a sign saying “this door only exists on Windows.”

The main setup flow, `run_windows_sandbox_setup`, times the operation, runs the blocking Windows setup work on a background thread so it does not stall the async runtime, saves the chosen sandbox mode back to the user config, and emits metrics for success or failure.

#### Function details

##### `WindowsSandboxLevel::from_config`  (lines 31–37)

```
fn from_config(config: &Config) -> WindowsSandboxLevel
```

**Purpose**: This chooses the effective Windows sandbox level from the full Codex configuration. It gives priority to an explicit Windows sandbox setting, and only falls back to feature flags when the setting is absent.

**Data flow**: It receives a `Config`, reads `permissions.windows_sandbox_mode`, and turns `Elevated` into an elevated sandbox level or `Unelevated` into a restricted-token sandbox level. If no explicit mode is set, it passes the config’s feature flags to `WindowsSandboxLevel::from_features` and returns that result.

**Call relations**: This is the main config-based decision point. The small public wrapper `windows_sandbox_level_from_config` calls it, and when it needs feature-flag fallback it hands off to `WindowsSandboxLevel::from_features`.

*Call graph*: 1 external calls (from_features).


##### `WindowsSandboxLevel::from_features`  (lines 39–48)

```
fn from_features(features: &Features) -> WindowsSandboxLevel
```

**Purpose**: This chooses a sandbox level from feature flags alone. It is used when the user has not set a direct Windows sandbox mode in the config.

**Data flow**: It receives a `Features` object and asks whether the elevated Windows sandbox feature is enabled first. If so, it returns `Elevated`; otherwise it checks the older Windows sandbox feature and returns `RestrictedToken` if that is enabled, or `Disabled` if neither flag is enabled.

**Call relations**: This is the fallback used by `WindowsSandboxLevel::from_config`. It depends on the feature system’s `enabled` check to answer each yes-or-no feature question.

*Call graph*: calls 1 internal fn (enabled).


##### `windows_sandbox_level_from_config`  (lines 51–53)

```
fn windows_sandbox_level_from_config(config: &Config) -> WindowsSandboxLevel
```

**Purpose**: This is a simple public helper for callers that want the Windows sandbox level from a full config. It keeps callers from needing to know about the extension trait method directly.

**Data flow**: It receives a `Config`, passes it unchanged to `WindowsSandboxLevel::from_config`, and returns the resulting sandbox level.

**Call relations**: It is a thin doorway into `WindowsSandboxLevel::from_config`. The real decision-making happens there.

*Call graph*: 1 external calls (from_config).


##### `windows_sandbox_level_from_features`  (lines 55–57)

```
fn windows_sandbox_level_from_features(features: &Features) -> WindowsSandboxLevel
```

**Purpose**: This is a simple public helper for callers that only have feature flags and need to know the Windows sandbox level. It hides the trait-method detail behind an ordinary function.

**Data flow**: It receives `Features`, passes them to `WindowsSandboxLevel::from_features`, and returns the sandbox level chosen from those flags.

**Call relations**: It is a thin wrapper around `WindowsSandboxLevel::from_features`. The feature checks happen in that underlying method.

*Call graph*: 1 external calls (from_features).


##### `resolve_windows_sandbox_mode`  (lines 59–64)

```
fn resolve_windows_sandbox_mode(cfg: &ConfigToml) -> Option<WindowsSandboxModeToml>
```

**Purpose**: This reads the raw config file format and finds the requested Windows sandbox mode, while still accepting older feature-flag settings. This matters because users may have config files written before the newer Windows config section existed.

**Data flow**: It receives a `ConfigToml`, first looks for `windows.sandbox`, and returns it if present. If not present, it looks at the older `features` section through `legacy_windows_sandbox_mode` and returns whatever legacy mode can be inferred, or `None` if no sandbox preference exists.

**Call relations**: The config-loading flow `load_config_with_layer_stack` calls this while turning config files into runtime settings. It delegates legacy compatibility to `legacy_windows_sandbox_mode`.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_windows_sandbox_private_desktop`  (lines 66–71)

```
fn resolve_windows_sandbox_private_desktop(cfg: &ConfigToml) -> bool
```

**Purpose**: This reads whether Windows sandbox setup should use a private desktop. A private desktop is a separate Windows UI space, which can reduce unwanted interaction with the normal user desktop.

**Data flow**: It receives a `ConfigToml`, checks `windows.sandbox_private_desktop`, and returns that value if it is set. If the user did not set it, it returns `true` as the default.

**Call relations**: The config-loading flow `load_config_with_layer_stack` calls this when building the final runtime configuration. It does not call other helpers because the rule is only one direct lookup plus a default.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `legacy_windows_sandbox_mode`  (lines 73–78)

```
fn legacy_windows_sandbox_mode(
    features: Option<&FeaturesToml>,
) -> Option<WindowsSandboxModeToml>
```

**Purpose**: This translates older feature-flag-style config into the newer Windows sandbox mode. It helps old configuration files keep working.

**Data flow**: It receives an optional `FeaturesToml`. If there are no features, it returns `None`; otherwise it extracts the feature entries and passes them to `legacy_windows_sandbox_mode_from_entries`, then returns that answer.

**Call relations**: This is used by `resolve_windows_sandbox_mode` as the backward-compatibility path. It hands the detailed key checking to `legacy_windows_sandbox_mode_from_entries`.

*Call graph*: calls 1 internal fn (legacy_windows_sandbox_mode_from_entries).


##### `legacy_windows_sandbox_mode_from_entries`  (lines 80–103)

```
fn legacy_windows_sandbox_mode_from_entries(
    entries: &BTreeMap<String, bool>,
) -> Option<WindowsSandboxModeToml>
```

**Purpose**: This inspects the old feature keys and decides whether they mean elevated sandboxing, unelevated sandboxing, or no sandbox mode. It knows the old names that may still appear in user config.

**Data flow**: It receives a map of feature-name strings to true-or-false values. If the elevated sandbox key is true, it returns `Elevated`; otherwise, if the standard Windows sandbox key or the older experimental key is true, it returns `Unelevated`; if none are true, it returns `None`.

**Call relations**: It is the detailed worker called by `legacy_windows_sandbox_mode`. This keeps the older-key compatibility rules in one focused place.

*Call graph*: called by 1 (legacy_windows_sandbox_mode).


##### `sandbox_setup_is_complete`  (lines 111–113)

```
fn sandbox_setup_is_complete(_codex_home: &Path) -> bool
```

**Purpose**: This checks whether the elevated Windows sandbox has already been set up for the given Codex home directory. On non-Windows systems, it always says no because the Windows sandbox does not apply there.

**Data flow**: It receives the path to `codex_home`. On Windows it passes that path to the Windows sandbox library and returns the library’s yes-or-no answer; on other operating systems it ignores the path and returns `false`.

**Call relations**: During elevated setup, `run_windows_sandbox_setup_and_persist` uses this check before doing expensive setup work. The actual Windows check is performed by the external Windows sandbox implementation.

*Call graph*: 1 external calls (sandbox_setup_is_complete).


##### `elevated_setup_failure_details`  (lines 124–126)

```
fn elevated_setup_failure_details(_err: &anyhow::Error) -> Option<(String, String)>
```

**Purpose**: This extracts safe, metric-friendly details from an elevated setup error. It separates an error code and a sanitized message so telemetry can group failures without sending messy or unsafe text.

**Data flow**: It receives an error. On Windows it asks the sandbox library whether the error contains a setup failure, copies the failure code, sanitizes the message, and returns both; if no setup failure is found it returns `None`. On non-Windows it always returns `None`.

**Call relations**: When setup metrics are being recorded, `emit_windows_sandbox_setup_failure_metrics` calls this to add extra detail for elevated sandbox failures. It relies on the Windows sandbox library to recognize and sanitize setup-specific errors.

*Call graph*: called by 1 (emit_windows_sandbox_setup_failure_metrics); 2 external calls (extract_setup_failure, sanitize_setup_metric_tag_value).


##### `elevated_setup_failure_metric_name`  (lines 143–145)

```
fn elevated_setup_failure_metric_name(_err: &anyhow::Error) -> &'static str
```

**Purpose**: This chooses the metric name for an elevated setup failure. It distinguishes a user-canceled helper launch from other failures, so cancellation is not lumped together with broken setup.

**Data flow**: It receives an error. On Windows it checks whether the sandbox library can extract a setup failure and whether its code means the orchestrator helper launch was canceled; if so, it returns the canceled metric name, otherwise the general failure metric name. On non-Windows this function panics because it should never be used there.

**Call relations**: The failure-metrics function calls this only inside Windows-specific code when an elevated setup fails. It uses the Windows sandbox library’s error extraction to make the naming decision.

*Call graph*: called by 1 (emit_windows_sandbox_setup_failure_metrics); 2 external calls (extract_setup_failure, panic!).


##### `run_elevated_setup`  (lines 178–186)

```
fn run_elevated_setup(
    _permission_profile: &PermissionProfile,
    _workspace_roots: &[AbsolutePathBuf],
    _command_cwd: &Path,
    _env_map: &HashMap<String, String>,
    _codex_home: &Path,
)
```

**Purpose**: This starts the real elevated Windows sandbox setup. Elevated setup means Codex asks Windows for stronger setup privileges so it can create or update the sandbox environment.

**Data flow**: It receives the permission profile, workspace roots, command working directory, environment variables, and Codex home path. On Windows it converts the permission profile and workspace roots into Windows sandbox permissions, builds a setup request, and calls the Windows sandbox library; on other operating systems it returns an error saying this is Windows-only.

**Call relations**: The background setup flow in `run_windows_sandbox_setup_and_persist` calls this when the requested mode is elevated and setup is not already complete. It hands the platform-specific work to the external Windows sandbox library.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 3 external calls (bail!, run_elevated_setup, default).


##### `run_elevated_provisioning_setup`  (lines 189–191)

```
fn run_elevated_provisioning_setup(_codex_home: &Path, _real_user: &str) -> anyhow::Result<()>
```

**Purpose**: This runs a separate elevated provisioning setup step for the Windows sandbox. Provisioning here means preparing shared sandbox support for a real Windows user account.

**Data flow**: It receives the Codex home path and the real user name. On Windows it passes both to the Windows sandbox library; on non-Windows it returns a clear Windows-only error.

**Call relations**: The higher-level `run_elevated` flow calls this when it needs provisioning. This wrapper keeps the rest of the code from directly depending on platform-specific sandbox calls.

*Call graph*: called by 1 (run_elevated); 2 external calls (bail!, run_elevated_provisioning_setup).


##### `run_legacy_setup_preflight`  (lines 231–239)

```
fn run_legacy_setup_preflight(
    _permission_profile: &PermissionProfile,
    _workspace_roots: &[AbsolutePathBuf],
    _command_cwd: &Path,
    _env_map: &HashMap<String, String>,
    _codex_home:
```

**Purpose**: This runs the setup check for the older, unelevated Windows sandbox mode before Codex tries to use it. A preflight is like checking a seatbelt before driving: it verifies the conditions are ready.

**Data flow**: It receives the permission profile, workspace roots, working directory, environment variables, and Codex home path. On Windows it passes them to the legacy preflight function in the Windows sandbox library; on non-Windows it returns a Windows-only error.

**Call relations**: The setup worker `run_windows_sandbox_setup_and_persist` calls this when the requested mode is unelevated. The real legacy sandbox checks happen in the Windows sandbox library.

*Call graph*: 2 external calls (bail!, run_windows_sandbox_legacy_preflight).


##### `run_setup_refresh_with_extra_read_roots`  (lines 242–251)

```
fn run_setup_refresh_with_extra_read_roots(
    _permission_profile: &PermissionProfile,
    _workspace_roots: &[AbsolutePathBuf],
    _command_cwd: &Path,
    _env_map: &HashMap<String, String>,
```

**Purpose**: This refreshes Windows sandbox setup when the sandbox needs extra directories that commands may read. It is used to widen read access without changing the whole permission model by hand.

**Data flow**: It receives the current permission profile, workspace roots, working directory, environment variables, Codex home path, and a list of extra read-only paths. On Windows it forwards all of that to the Windows sandbox library with proxy enforcement disabled; on non-Windows it returns a Windows-only error.

**Call relations**: `grant_read_root_non_elevated` calls this when it needs to add read roots for the non-elevated sandbox path. The function then delegates the actual refresh to the platform-specific sandbox implementation.

*Call graph*: called by 1 (grant_read_root_non_elevated); 2 external calls (bail!, run_setup_refresh_with_extra_read_roots).


##### `run_windows_sandbox_setup`  (lines 269–294)

```
async fn run_windows_sandbox_setup(request: WindowsSandboxSetupRequest) -> anyhow::Result<()>
```

**Purpose**: This is the main async entry point for setting up the Windows sandbox from a prepared request. It times the setup, records whether it succeeded or failed, and returns the original result to the caller.

**Data flow**: It receives a `WindowsSandboxSetupRequest`, notes the start time, remembers the requested mode, and builds a safe telemetry tag for the current originator. It then calls `run_windows_sandbox_setup_and_persist`; if that succeeds it emits success metrics and returns `Ok`, and if it fails it emits failure metrics and returns the error.

**Call relations**: `windows_sandbox_setup_start_inner` calls this when the user or system starts sandbox setup. This function coordinates the real setup worker and the telemetry helpers, making sure every outcome is measured.

*Call graph*: calls 4 internal fn (emit_windows_sandbox_setup_failure_metrics, emit_windows_sandbox_setup_success_metrics, run_windows_sandbox_setup_and_persist, originator); called by 1 (windows_sandbox_setup_start_inner); 2 external calls (now, sanitize_metric_tag_value).


##### `run_windows_sandbox_setup_and_persist`  (lines 296–343)

```
async fn run_windows_sandbox_setup_and_persist(
    request: WindowsSandboxSetupRequest,
) -> anyhow::Result<()>
```

**Purpose**: This performs the sandbox setup work and then saves the selected sandbox mode into the user’s config. It is the part that turns a successful setup into a remembered preference.

**Data flow**: It receives a setup request and splits out the mode, permissions, roots, working directory, environment, and Codex home. It runs the blocking Windows setup work on a background thread: elevated mode runs elevated setup only if setup is not already complete, while unelevated mode runs the legacy preflight. After setup succeeds, it edits the config to set the Windows sandbox mode and remove old legacy sandbox keys.

**Call relations**: `run_windows_sandbox_setup` calls this and then records metrics around its result. Inside, it uses platform wrapper functions such as `sandbox_setup_is_complete`, `run_elevated_setup`, and `run_legacy_setup_preflight`, and it uses `windows_sandbox_setup_mode_tag` when writing the mode to config.

*Call graph*: calls 2 internal fn (new, windows_sandbox_setup_mode_tag); called by 1 (run_windows_sandbox_setup); 1 external calls (spawn_blocking).


##### `emit_windows_sandbox_setup_success_metrics`  (lines 345–368)

```
fn emit_windows_sandbox_setup_success_metrics(
    mode: WindowsSandboxSetupMode,
    originator_tag: &str,
    duration: std::time::Duration,
)
```

**Purpose**: This records telemetry for a successful Windows sandbox setup. Telemetry here means counters and timing data that help maintainers understand real-world setup behavior.

**Data flow**: It receives the setup mode, originator tag, and elapsed duration. If telemetry is available, it turns the mode into a short tag, records the setup duration with a success result, and increments a setup-success counter; if telemetry is not available, it quietly does nothing.

**Call relations**: `run_windows_sandbox_setup` calls this after setup and config persistence succeed. It uses `windows_sandbox_setup_mode_tag` so all metrics use the same mode spelling.

*Call graph*: calls 1 internal fn (windows_sandbox_setup_mode_tag); called by 1 (run_windows_sandbox_setup); 1 external calls (global).


##### `emit_windows_sandbox_setup_failure_metrics`  (lines 370–424)

```
fn emit_windows_sandbox_setup_failure_metrics(
    mode: WindowsSandboxSetupMode,
    originator_tag: &str,
    duration: std::time::Duration,
    _err: &anyhow::Error,
)
```

**Purpose**: This records telemetry when Windows sandbox setup fails. It captures the mode, timing, and, for some Windows elevated failures, extra failure details.

**Data flow**: It receives the setup mode, originator tag, elapsed duration, and error. If telemetry is available, it records a failed setup duration and increments a general setup-failure counter. For elevated mode on Windows it may add a sanitized code and message and use a special canceled-vs-failed metric name; for unelevated mode it increments the legacy preflight failure counter.

**Call relations**: `run_windows_sandbox_setup` calls this after `run_windows_sandbox_setup_and_persist` returns an error. It calls `elevated_setup_failure_details`, `elevated_setup_failure_metric_name`, and `windows_sandbox_setup_mode_tag` to shape the telemetry.

*Call graph*: calls 3 internal fn (elevated_setup_failure_details, elevated_setup_failure_metric_name, windows_sandbox_setup_mode_tag); called by 1 (run_windows_sandbox_setup); 3 external calls (global, matches!, vec!).


##### `windows_sandbox_setup_mode_tag`  (lines 426–431)

```
fn windows_sandbox_setup_mode_tag(mode: WindowsSandboxSetupMode) -> &'static str
```

**Purpose**: This converts the internal setup mode into the short text used in config and metrics. Keeping this in one function prevents different parts of the code from spelling the same mode in different ways.

**Data flow**: It receives a `WindowsSandboxSetupMode`. If the mode is `Elevated`, it returns the string `elevated`; if the mode is `Unelevated`, it returns `unelevated`.

**Call relations**: The setup persistence and both metrics functions call this whenever they need a stable text label for the mode. It is a small shared vocabulary helper for this file.

*Call graph*: called by 3 (emit_windows_sandbox_setup_failure_metrics, emit_windows_sandbox_setup_success_metrics, run_windows_sandbox_setup_and_persist).


### Config editing and migration utilities
These files provide targeted editors and migration helpers that import or persist user-managed configuration sections and related assets.

### `config/src/marketplace_edit.rs`

`config` · `when marketplace commands update the user's config`

A marketplace here is a named source of extra content, such as a Git repository or local path. This file is the small “config editor” that records where each marketplace came from, when it was last updated, and which revision or branch it uses. Without it, commands that add or remove marketplaces would either lose that information or have to rewrite the configuration file by hand.

The file works with a TOML file, which is a human-readable configuration format. It uses `toml_edit`, a library that can read and rewrite TOML while preserving its structure better than a simple parse-and-dump approach.

The main flow is simple. To save a marketplace, `record_user_marketplace` opens the config file if it exists, or starts a new empty document if it does not. Then `upsert_marketplace` creates or replaces the named entry under the top-level `marketplaces` table. To remove a marketplace, `remove_user_marketplace_config` reads the config, asks `remove_marketplace` to delete the named entry, and writes the file back only if something was actually removed.

One important detail is case sensitivity. If the user asks to remove `Debug` but the file contains `debug`, the code does not silently remove it. It reports a `NameCaseMismatch` with the configured name, so callers can give a clearer message.

#### Function details

##### `record_user_marketplace`  (lines 29–39)

```
fn record_user_marketplace(
    codex_home: &Path,
    marketplace_name: &str,
    update: &MarketplaceConfigUpdate<'_>,
) -> std::io::Result<()>
```

**Purpose**: Records or replaces one marketplace entry in the user's config file. It is used after a marketplace has been added or updated so the program remembers where it came from and how to refresh it later.

**Data flow**: It receives the user's config directory, the marketplace name, and a `MarketplaceConfigUpdate` containing details like source URL, revision, branch name, and sparse paths. It builds the config file path, reads the existing TOML document or creates an empty one, inserts the marketplace data, makes sure the config directory exists, and writes the updated TOML text back to disk. The result is either success or an input/output error from reading, parsing, creating directories, or writing.

**Call relations**: This is the public save path for marketplace config changes. In this file's tests it is used to set up config entries before removal behavior is checked. Internally it hands reading to `read_or_create_document`, hands the actual TOML entry creation to `upsert_marketplace`, then uses filesystem calls to persist the result.

*Call graph*: calls 2 internal fn (read_or_create_document, upsert_marketplace); called by 2 (remove_user_marketplace_config_reports_case_mismatch, remove_user_marketplace_removes_requested_entry); 3 external calls (join, create_dir_all, write).


##### `remove_user_marketplace`  (lines 41–44)

```
fn remove_user_marketplace(codex_home: &Path, marketplace_name: &str) -> std::io::Result<bool>
```

**Purpose**: Removes a marketplace entry and returns a simple yes-or-no answer. It is a convenience wrapper for callers that only care whether an entry was actually deleted.

**Data flow**: It receives the config directory and requested marketplace name. It asks `remove_user_marketplace_config` for the detailed removal result, then turns that result into `true` only when the entry was removed. Other non-error outcomes, such as not found or name case mismatch, become `false`.

**Call relations**: This function sits above the more detailed removal API. Tests call it when they want simple boolean behavior. It delegates all real file reading, TOML editing, and writing to `remove_user_marketplace_config`.

*Call graph*: calls 1 internal fn (remove_user_marketplace_config); called by 2 (remove_user_marketplace_removes_requested_entry, remove_user_marketplace_returns_false_when_missing).


##### `remove_user_marketplace_config`  (lines 46–69)

```
fn remove_user_marketplace_config(
    codex_home: &Path,
    marketplace_name: &str,
) -> std::io::Result<RemoveMarketplaceConfigOutcome>
```

**Purpose**: Removes a named marketplace from the user's config file and reports exactly what happened. It distinguishes between successfully removed, not found, and found only with different letter casing.

**Data flow**: It receives the config directory and marketplace name. It reads the TOML config file; if the file does not exist, it returns `NotFound`. If the file exists, it parses the text, asks `remove_marketplace` to remove the entry from the in-memory TOML document, and writes the document back only when an entry was removed. Its output is a `RemoveMarketplaceConfigOutcome` or an input/output or parse error.

**Call relations**: This is the main removal path. `remove_user_marketplace` calls it when only a boolean is needed, while tests call it directly to check detailed outcomes. It relies on `remove_marketplace` for the actual edit and uses filesystem calls around that edit to read and save the config file.

*Call graph*: calls 1 internal fn (remove_marketplace); called by 3 (remove_user_marketplace, remove_user_marketplace_config_removes_inline_table_entry, remove_user_marketplace_config_reports_case_mismatch); 4 external calls (join, create_dir_all, read_to_string, write).


##### `read_or_create_document`  (lines 71–79)

```
fn read_or_create_document(config_path: &Path) -> std::io::Result<DocumentMut>
```

**Purpose**: Loads the TOML config document if it exists, or creates a new empty TOML document if it does not. This lets the add/update path work for first-time users with no config file yet.

**Data flow**: It receives a path to the config file. It tries to read the file as text. If reading succeeds, it parses the text as editable TOML. If the file is missing, it returns a fresh empty document. If reading fails for another reason or parsing fails, it returns an error.

**Call relations**: This helper is called by `record_user_marketplace` before inserting a marketplace entry. It keeps the public save function focused on the larger flow instead of mixing in the special case for a missing config file.

*Call graph*: called by 1 (record_user_marketplace); 2 external calls (new, read_to_string).


##### `upsert_marketplace`  (lines 81–118)

```
fn upsert_marketplace(
    doc: &mut DocumentMut,
    marketplace_name: &str,
    update: &MarketplaceConfigUpdate<'_>,
)
```

**Purpose**: Adds or replaces one marketplace entry inside an editable TOML document. “Upsert” means update it if it exists, or insert it if it does not.

**Data flow**: It receives a mutable TOML document, a marketplace name, and update details. It makes sure the document has a top-level `marketplaces` table, replacing a non-table value if necessary. Then it builds a table for the named marketplace with fields such as `last_updated`, `last_revision`, `source_type`, `source`, `ref`, and `sparse_paths`, omitting optional fields when they are absent. The document is changed in place and nothing is returned.

**Call relations**: This is the core write logic behind `record_user_marketplace`. It uses `new_implicit_table` when it needs to create the parent `marketplaces` table, then fills in TOML values that `record_user_marketplace` later writes to disk.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 1 (record_user_marketplace); 6 external calls (as_table_mut, Table, Value, new, Array, value).


##### `remove_marketplace`  (lines 120–167)

```
fn remove_marketplace(
    doc: &mut DocumentMut,
    marketplace_name: &str,
) -> RemoveMarketplaceConfigOutcome
```

**Purpose**: Deletes one marketplace entry from an editable TOML document. It also cleans up an empty `marketplaces` section and detects when the requested name differs only by letter case.

**Data flow**: It receives a mutable TOML document and the requested marketplace name. It looks for the top-level `marketplaces` value. If that value is a normal table or an inline table, it tries to remove the exact key. If the exact key is missing, it checks whether another key matches ignoring ASCII letter case. If removal succeeds and no marketplaces remain, it removes the whole `marketplaces` section. It returns `Removed`, `NotFound`, or `NameCaseMismatch`.

**Call relations**: This function does the in-memory removal for `remove_user_marketplace_config`. It calls `case_mismatched_key` to produce a helpful outcome when a user typed the right name with the wrong capitalization.

*Call graph*: calls 1 internal fn (case_mismatched_key); called by 1 (remove_user_marketplace_config); 1 external calls (as_table_mut).


##### `case_mismatched_key`  (lines 169–175)

```
fn case_mismatched_key(
    mut keys: impl Iterator<Item = &'a str>,
    requested_name: &str,
) -> Option<String>
```

**Purpose**: Finds an existing marketplace key that matches the requested name except for capitalization. This helps the program avoid silently failing or deleting the wrong-looking name.

**Data flow**: It receives an iterator of existing keys and the name the user requested. It scans the keys for one that is not exactly equal but is equal when ASCII letter case is ignored. If it finds one, it returns that configured key as a string; otherwise it returns nothing.

**Call relations**: This helper is called by `remove_marketplace` after exact removal fails. Its result lets the removal flow return `NameCaseMismatch` instead of the less helpful `NotFound`.

*Call graph*: called by 1 (remove_marketplace); 1 external calls (find).


##### `new_implicit_table`  (lines 177–181)

```
fn new_implicit_table() -> TomlTable
```

**Purpose**: Creates a TOML table marked as implicit, meaning it can exist as a parent container without necessarily being written as an explicit header right away. This is useful when constructing the `marketplaces` parent section cleanly.

**Data flow**: It creates a new empty TOML table, marks it as implicit, and returns it. It does not read or write any external data.

**Call relations**: This small helper is used by `upsert_marketplace` when the document does not yet have a usable `marketplaces` table. It keeps that table-creation detail in one place.

*Call graph*: called by 1 (upsert_marketplace); 1 external calls (new).


##### `tests::remove_user_marketplace_removes_requested_entry`  (lines 190–215)

```
fn remove_user_marketplace_removes_requested_entry()
```

**Purpose**: Checks that removing one marketplace deletes only the requested entry and leaves other entries alone. This protects against accidentally wiping the whole marketplace list.

**Data flow**: The test creates a temporary config directory, records two marketplaces, removes one of them, then reads the config file back. It expects the removal call to return `true`, the remaining marketplace table to contain exactly one entry, and that entry to be the untouched marketplace.

**Call relations**: This test drives the public save and simple remove functions together: it uses `record_user_marketplace` to create realistic config data, then calls `remove_user_marketplace` to verify the normal removal path.

*Call graph*: calls 2 internal fn (record_user_marketplace, remove_user_marketplace); 5 external calls (new, assert!, assert_eq!, read_to_string, from_str).


##### `tests::remove_user_marketplace_returns_false_when_missing`  (lines 218–224)

```
fn remove_user_marketplace_returns_false_when_missing()
```

**Purpose**: Checks that trying to remove a marketplace from an empty or missing config does not count as a successful removal. This gives callers a safe, predictable answer when there is nothing to delete.

**Data flow**: The test creates a temporary config directory with no recorded marketplace, calls `remove_user_marketplace`, and expects the returned boolean to be `false`. No config entry is created as part of the test setup.

**Call relations**: This test exercises the convenience wrapper `remove_user_marketplace`, which in turn calls the detailed removal function. It confirms that the missing-file or missing-entry path is surfaced as a simple false value.

*Call graph*: calls 1 internal fn (remove_user_marketplace); 2 external calls (new, assert!).


##### `tests::remove_user_marketplace_config_reports_case_mismatch`  (lines 227–247)

```
fn remove_user_marketplace_config_reports_case_mismatch()
```

**Purpose**: Checks that the detailed removal function reports a capitalization mismatch instead of pretending the marketplace is simply missing. This matters for clear user feedback.

**Data flow**: The test creates a temporary config, records a marketplace named `debug`, then asks to remove `Debug`. It expects the result to be `NameCaseMismatch` and to include the actual configured name, `debug`.

**Call relations**: This test uses `record_user_marketplace` to set up the stored name, then calls `remove_user_marketplace_config` directly because it needs the detailed outcome rather than a boolean. It verifies the path through `remove_marketplace` and `case_mismatched_key`.

*Call graph*: calls 2 internal fn (record_user_marketplace, remove_user_marketplace_config); 2 external calls (new, assert_eq!).


##### `tests::remove_user_marketplace_config_removes_inline_table_entry`  (lines 250–275)

```
fn remove_user_marketplace_config_removes_inline_table_entry()
```

**Purpose**: Checks that removal works when the `marketplaces` section is written as an inline TOML table rather than the more usual table format. This protects compatibility with different valid ways users or tools may format TOML.

**Data flow**: The test writes a config file by hand using inline table syntax with two marketplaces. It calls `remove_user_marketplace_config` for one entry, expects a `Removed` outcome, then reads and parses the file to confirm only the other entry remains.

**Call relations**: This test calls the detailed removal function directly and sets up the file with raw filesystem writing. It specifically exercises the branch in `remove_marketplace` that edits inline TOML tables.

*Call graph*: calls 1 internal fn (remove_user_marketplace_config); 6 external calls (new, assert!, assert_eq!, read_to_string, write, from_str).


### `config/src/mcp_edit.rs`

`config` · `config load and config update`

This file is the bridge between in-memory MCP server settings and the user’s TOML config file. TOML is a human-readable settings format, and MCP servers are external tool servers the app can talk to. Without this file, commands that add, remove, enable, or change MCP servers would not have a reliable way to persist those changes.

There are two main jobs here. First, load_global_mcp_servers reads config.toml from the Codex home directory, looks for the mcp_servers section, checks that it does not contain an unsupported inline bearer_token field, and turns that TOML data into McpServerConfig values used by the rest of the app.

Second, ConfigEditsBuilder provides a small “edit plan” for writing config changes. Code elsewhere creates the builder, tells it what MCP server map should replace the current one, and then calls apply. The write work is done in a blocking task so it does not stall the async runtime, which is the part of the program that keeps many tasks moving at once.

The file is careful to preserve the rest of the config document: it reads the existing TOML document, replaces only the mcp_servers table, creates the config directory if needed, and writes the result back. Helper functions turn Rust data like lists, environment variables, headers, tool settings, and OAuth fields into TOML tables and arrays.

#### Function details

##### `load_global_mcp_servers`  (lines 20–41)

```
async fn load_global_mcp_servers(
    codex_home: &Path,
) -> std::io::Result<BTreeMap<String, McpServerConfig>>
```

**Purpose**: This loads all globally configured MCP servers from the user's config.toml file. If the file or the MCP section is missing, it returns an empty map rather than treating that as an error.

**Data flow**: It receives the Codex home folder path, builds the path to config.toml, and reads the file asynchronously. It parses the text as TOML, finds the mcp_servers section, checks for forbidden inline bearer tokens, and then converts that section into a name-to-server-config map. The result is either that map, an empty map, or an I/O-style error if the file cannot be read or the TOML is invalid.

**Call relations**: This is the public read side of the file. During config loading, callers use it to get the current MCP server settings. Before handing the data back, it calls ensure_no_inline_bearer_tokens so old or unsafe token placement is caught early.

*Call graph*: calls 1 internal fn (ensure_no_inline_bearer_tokens); 3 external calls (new, join, read_to_string).


##### `ensure_no_inline_bearer_tokens`  (lines 43–60)

```
fn ensure_no_inline_bearer_tokens(value: &TomlValue) -> std::io::Result<()>
```

**Purpose**: This checks the MCP server TOML data for a bearer_token field that is no longer supported. It protects users from storing secret tokens directly in the config file, and tells them to use bearer_token_env_var instead.

**Data flow**: It receives a TOML value that should represent the mcp_servers table. If it is not a table, it leaves it alone. If it is a table, it looks at each server entry and returns an error as soon as it finds bearer_token; otherwise it returns success without changing anything.

**Call relations**: load_global_mcp_servers calls this immediately after finding the mcp_servers section. That means invalid secret-token configuration is rejected before the server settings are converted into McpServerConfig values.

*Call graph*: called by 1 (load_global_mcp_servers); 3 external calls (as_table, new, format!).


##### `ConfigEditsBuilder::new`  (lines 68–73)

```
fn new(codex_home: &Path) -> Self
```

**Purpose**: This starts a new config edit plan for a given Codex home directory. Other parts of the app use it when they are about to change saved settings, such as adding or removing an MCP server.

**Data flow**: It takes a path to the Codex home folder, copies that path into the builder, and starts with no requested MCP server replacement. The output is a ConfigEditsBuilder ready to be given one or more edits.

**Call relations**: Many higher-level commands create this builder when they need to write config changes. After creation, those callers can add an MCP-server replacement with ConfigEditsBuilder::replace_mcp_servers and then persist the edit with ConfigEditsBuilder::apply.

*Call graph*: called by 43 (skills_config_write_response_inner, disable_feature_in_config, enable_feature_in_config, run_add, run_remove, run_elevated, get_disabled_server_shows_single_line, list_and_get_render_expected_output, replace_mcp_servers_serializes_oauth_client_id, replace_mcp_servers_serializes_per_tool_approval_overrides (+15 more)); 1 external calls (to_path_buf).


##### `ConfigEditsBuilder::replace_mcp_servers`  (lines 75–78)

```
fn replace_mcp_servers(mut self, servers: &BTreeMap<String, McpServerConfig>) -> Self
```

**Purpose**: This records that the saved MCP server list should be replaced with the provided server map. It does not write anything yet; it just updates the edit plan.

**Data flow**: It receives the builder and a map of server names to server configs. It clones that map into the builder’s pending changes and returns the builder so calls can be chained together.

**Call relations**: Callers use this after ConfigEditsBuilder::new and before ConfigEditsBuilder::apply. Later, ConfigEditsBuilder::apply_blocking notices this pending replacement and passes it to replace_mcp_servers to actually rewrite the TOML document.


##### `ConfigEditsBuilder::apply`  (lines 80–86)

```
async fn apply(self) -> std::io::Result<()>
```

**Purpose**: This saves the builder’s pending config edits without blocking the async parts of the program. It is the public “commit these config changes” step.

**Data flow**: It takes ownership of the builder and sends the disk-writing work to a blocking task. When that task finishes, it returns success or the I/O error from the write; if the background task panics, it turns that into an ordinary I/O error message.

**Call relations**: Higher-level commands call this after building an edit plan. It hands the real file work to ConfigEditsBuilder::apply_blocking so slow disk operations do not freeze other async work.

*Call graph*: 1 external calls (spawn_blocking).


##### `ConfigEditsBuilder::apply_blocking`  (lines 88–96)

```
fn apply_blocking(self) -> std::io::Result<()>
```

**Purpose**: This performs the actual read-modify-write operation for config.toml. It is separated from apply because file system work can block the current thread.

**Data flow**: It builds the config.toml path, reads the existing document or creates a blank one, applies the pending MCP server replacement if there is one, makes sure the Codex home directory exists, and writes the updated TOML text to disk. The output is success or a file/parsing error.

**Call relations**: ConfigEditsBuilder::apply runs this inside a blocking task. It calls read_or_create_document to get a mutable TOML document, calls replace_mcp_servers when needed, and then uses the file system to create directories and write the final document.

*Call graph*: calls 2 internal fn (read_or_create_document, replace_mcp_servers); 3 external calls (join, create_dir_all, write).


##### `read_or_create_document`  (lines 99–107)

```
fn read_or_create_document(config_path: &Path) -> std::io::Result<DocumentMut>
```

**Purpose**: This opens config.toml as an editable TOML document, or creates an empty document if the file does not exist yet. It lets config edits work for both existing users and first-time users.

**Data flow**: It receives the config file path and tries to read it as text. If reading succeeds, it parses the text into a mutable TOML document. If the file is missing, it returns a new empty document. Other read errors or invalid TOML become errors.

**Call relations**: ConfigEditsBuilder::apply_blocking calls this at the start of saving changes. The returned document is then passed through editing steps before being written back to disk.

*Call graph*: called by 1 (apply_blocking); 2 external calls (new, read_to_string).


##### `replace_mcp_servers`  (lines 109–122)

```
fn replace_mcp_servers(doc: &mut DocumentMut, servers: &BTreeMap<String, McpServerConfig>)
```

**Purpose**: This replaces the mcp_servers section inside an editable TOML document. If the new server map is empty, it removes the section entirely so the config stays clean.

**Data flow**: It receives a mutable TOML document and a sorted map of server configs. It edits the root table: for an empty map it removes mcp_servers; otherwise it builds a new TOML table, serializes each server into that table, and inserts it under mcp_servers.

**Call relations**: ConfigEditsBuilder::apply_blocking calls this when the edit plan includes MCP server changes. For each server, it delegates the detailed conversion to serialize_mcp_server.

*Call graph*: calls 1 internal fn (serialize_mcp_server); called by 1 (apply_blocking); 3 external calls (as_table_mut, Table, new).


##### `serialize_mcp_server`  (lines 124–250)

```
fn serialize_mcp_server(config: &McpServerConfig) -> TomlItem
```

**Purpose**: This turns one McpServerConfig value into the TOML table that should be written to config.toml. It is where the Rust representation of a server becomes readable saved settings.

**Data flow**: It receives one server config and creates a TOML table. Depending on the transport type, it writes either command-based settings for a local stdio server or URL/header/token-environment settings for a streamable HTTP server. It then adds optional fields such as enabled status, environment ID, timeouts, tool approval rules, enabled or disabled tool lists, scopes, OAuth information, and per-tool settings. The output is a TOML item ready to insert into the mcp_servers table.

**Call relations**: replace_mcp_servers calls this once per server while rebuilding the mcp_servers section. It uses array_from_strings, array_from_env_vars, and table_from_pairs for repeated TOML-building patterns, and checks is_local_environment to avoid writing the default environment unnecessarily.

*Call graph*: calls 4 internal fn (array_from_env_vars, array_from_strings, table_from_pairs, is_local_environment); called by 1 (replace_mcp_servers); 3 external calls (Table, new, value).


##### `array_from_strings`  (lines 252–258)

```
fn array_from_strings(values: &[String]) -> TomlItem
```

**Purpose**: This converts a list of strings into a TOML array. It is used for settings like command arguments, enabled tools, disabled tools, and scopes.

**Data flow**: It receives a slice of strings, creates a new TOML array, pushes each string into it, and returns that array wrapped as a TOML item. It does not change the original list.

**Call relations**: serialize_mcp_server calls this whenever a server setting is naturally a list of plain text values. This keeps array-writing consistent across several fields.

*Call graph*: called by 1 (serialize_mcp_server); 2 external calls (Value, new).


##### `array_from_env_vars`  (lines 260–276)

```
fn array_from_env_vars(env_vars: &[McpServerEnvVar]) -> TomlItem
```

**Purpose**: This converts configured environment-variable references into a TOML array. It supports both simple names and richer entries that include a source.

**Data flow**: It receives a list of McpServerEnvVar values. For a simple name, it adds that name as a string. For a configured entry, it creates an inline TOML table with the variable name and, when present, its source. It returns the completed array as a TOML item.

**Call relations**: serialize_mcp_server calls this when writing the env_vars field for stdio-based MCP servers. It hides the detail of representing mixed simple and structured environment variable entries in TOML.

*Call graph*: called by 1 (serialize_mcp_server); 3 external calls (Value, new, new).


##### `table_from_pairs`  (lines 278–290)

```
fn table_from_pairs(pairs: I) -> TomlItem
```

**Purpose**: This converts key-value string pairs into a TOML table, sorted by key. It is used for settings such as environment variables and HTTP headers, where stable ordering makes the saved file easier to read and compare.

**Data flow**: It receives an iterable collection of string key-value references, collects and sorts them by key, then inserts each pair into a new TOML table. It returns that table as a TOML item.

**Call relations**: serialize_mcp_server calls this when it needs to write map-like settings such as env, http_headers, and env_http_headers. By centralizing the sorting and table creation, the saved config has predictable output.

*Call graph*: called by 1 (serialize_mcp_server); 4 external calls (into_iter, Table, new, value).


### `config/src/plugin_edit.rs`

`config` · `when plugin settings are changed`

This file is the small “config editor” for plugin settings. When a user turns a plugin on or off, the system needs to record that choice in the Codex home configuration file. Without this file, plugin state changes might not be saved, might overwrite unrelated settings, or might write to the wrong place if the config file is a symbolic link, which is a file that points to another file.

The public functions offer simple actions: set one plugin’s `enabled` value, clear one plugin’s entry, or apply a batch of edits. The actual file work is moved onto a blocking task so it does not stall the async runtime, which is the part of the program that keeps many tasks moving at once.

The editor reads the existing TOML document, where TOML is a human-readable config format. If the file is missing, it starts from an empty document. It then finds or creates the `[plugins]` area and the table for the chosen plugin. If an existing plugin entry has other fields, such as a source path, those are kept. If the old value had spacing or decoration around it, the replacement tries to preserve that style. Finally, if something really changed, the file is written atomically, meaning it is replaced in a safer all-at-once way rather than being left half-written.

#### Function details

##### `set_user_plugin_enabled`  (lines 21–34)

```
async fn set_user_plugin_enabled(
    codex_home: &Path,
    plugin_key: String,
    enabled: bool,
) -> std::io::Result<()>
```

**Purpose**: Records that one plugin should be enabled or disabled in the user's config file. This is the convenient public entry point for changing a plugin's on/off state.

**Data flow**: It receives the Codex home folder, a plugin key, and a true-or-false enabled value. It wraps that request into a single config edit and sends it to the shared edit-applying function. The result is success or an input/output error if the config file could not be read or written.

**Call relations**: Tests call this function to check the main user-facing behavior. It immediately hands the real work to `apply_user_plugin_config_edits`, so the same editing path is used whether there is one change or many.

*Call graph*: calls 1 internal fn (apply_user_plugin_config_edits); called by 3 (set_user_plugin_enabled_follows_config_symlink, set_user_plugin_enabled_preserves_existing_plugin_fields, set_user_plugin_enabled_writes_plugin_entry); 1 external calls (vec!).


##### `clear_user_plugin`  (lines 36–38)

```
async fn clear_user_plugin(codex_home: &Path, plugin_key: String) -> std::io::Result<()>
```

**Purpose**: Removes one plugin's configuration entry from the user's config file. This is used when the system should forget a plugin-specific setting rather than merely turn it off.

**Data flow**: It receives the Codex home folder and a plugin key. It wraps that into a clear edit and passes it onward. It returns success if the plugin was removed or was already absent, and returns an error only if the underlying config file operation fails.

**Call relations**: Tests call this function for removal cases. Like the enable/disable helper, it delegates to `apply_user_plugin_config_edits` so all plugin config changes go through one path.

*Call graph*: calls 1 internal fn (apply_user_plugin_config_edits); called by 2 (clear_user_plugin_missing_entry_does_not_create_config, clear_user_plugin_removes_empty_plugins_table); 1 external calls (vec!).


##### `apply_user_plugin_config_edits`  (lines 40–48)

```
async fn apply_user_plugin_config_edits(
    codex_home: &Path,
    edits: Vec<PluginConfigEdit>,
) -> std::io::Result<()>
```

**Purpose**: Applies one or more plugin config changes without blocking the async part of the program. It is the async-safe wrapper around the real disk editing work.

**Data flow**: It receives the Codex home folder and a list of edits. It copies the folder path so it can be moved into a background blocking task, then waits for that task to finish. It returns the result of the file update, or turns a background task panic into a normal input/output error.

**Call relations**: `set_user_plugin_enabled` and `clear_user_plugin` both call this function. It schedules `apply_user_plugin_config_edits_blocking` because reading, parsing, and writing files can pause a thread, and that should not happen directly on the async runtime.

*Call graph*: called by 2 (clear_user_plugin, set_user_plugin_enabled); 2 external calls (to_path_buf, spawn_blocking).


##### `apply_user_plugin_config_edits_blocking`  (lines 50–75)

```
fn apply_user_plugin_config_edits_blocking(
    codex_home: &Path,
    edits: Vec<PluginConfigEdit>,
) -> std::io::Result<()>
```

**Purpose**: Does the actual config-file editing on disk. It reads the TOML document, applies each requested plugin change, and writes the file back only if something changed.

**Data flow**: It starts with a Codex home folder and a list of edits. If the list is empty, it stops immediately. Otherwise it finds the config path, resolves any symlink write target, reads or creates a TOML document, applies each edit, tracks whether the document changed, and writes the final text atomically if needed. The output is success or a file/parsing error.

**Call relations**: This is called from the async wrapper `apply_user_plugin_config_edits`. Inside the edit loop it calls `set_plugin_enabled` for enable/disable edits and `clear_plugin` for removal edits, then relies on path and atomic-write helpers to persist the result safely.

*Call graph*: calls 3 internal fn (clear_plugin, read_or_create_document, set_plugin_enabled); 3 external calls (join, resolve_symlink_write_paths, write_atomically).


##### `read_or_create_document`  (lines 77–88)

```
fn read_or_create_document(config_path: Option<&Path>) -> std::io::Result<DocumentMut>
```

**Purpose**: Loads the config file as an editable TOML document, or creates an empty document when there is no file to read. This lets later code treat missing config as a blank starting point.

**Data flow**: It receives an optional path. If there is no path, it returns a new empty TOML document. If the path exists, it reads the text and parses it. If the file is missing, it also returns an empty document. Other read errors, or invalid TOML text, become errors.

**Call relations**: `apply_user_plugin_config_edits_blocking` calls this before making edits. It supplies the editable document that `set_plugin_enabled` or `clear_plugin` will change.

*Call graph*: called by 1 (apply_user_plugin_config_edits_blocking); 2 external calls (new, read_to_string).


##### `set_plugin_enabled`  (lines 90–103)

```
fn set_plugin_enabled(doc: &mut DocumentMut, plugin_key: &str, enabled: bool) -> bool
```

**Purpose**: Sets the `enabled` field for one plugin inside an editable TOML document. It also preserves any other fields already stored for that plugin.

**Data flow**: It receives the TOML document, a plugin key, and the desired true-or-false value. It makes sure the top-level `plugins` table exists, makes sure the chosen plugin entry can be written as a table, prepares a new `enabled` value, copies style details from the old value if present, and stores the new value. It returns whether it successfully changed the document.

**Call relations**: `apply_user_plugin_config_edits_blocking` calls this when processing a set-enabled edit. It depends on `ensure_plugins_table` and `ensure_table_for_write` to create or normalize the right TOML tables, and uses `preserve_decor` so the edit is less disruptive to the user's file style.

*Call graph*: calls 3 internal fn (ensure_plugins_table, ensure_table_for_write, preserve_decor); called by 1 (apply_user_plugin_config_edits_blocking); 1 external calls (value).


##### `clear_plugin`  (lines 105–114)

```
fn clear_plugin(doc: &mut DocumentMut, plugin_key: &str) -> bool
```

**Purpose**: Removes one plugin's entry from the `plugins` section of the TOML document. It avoids creating new config structure just to remove something that is not there.

**Data flow**: It receives the editable document and a plugin key. It looks for an existing `plugins` item, checks that it can be read as a table, and removes the entry matching the plugin key. It returns true if an entry was actually removed and false if there was nothing to remove or the structure was not suitable.

**Call relations**: `apply_user_plugin_config_edits_blocking` calls this for clear edits. It uses `ensure_table_for_read` only after an existing `plugins` item is found, so clearing a missing plugin does not create a new config file.

*Call graph*: calls 1 internal fn (ensure_table_for_read); called by 1 (apply_user_plugin_config_edits_blocking); 1 external calls (as_table_mut).


##### `ensure_plugins_table`  (lines 116–122)

```
fn ensure_plugins_table(doc: &mut DocumentMut) -> Option<&mut TomlTable>
```

**Purpose**: Makes sure the TOML document has a writable top-level `plugins` table. This gives plugin edits a predictable place to store plugin-specific settings.

**Data flow**: It receives the editable TOML document. If there is no `plugins` entry, it inserts a new implicit table, which is a table used for structure without necessarily printing its own header. It then converts or confirms that the entry is writable as a table and returns it, or returns nothing if that cannot be done.

**Call relations**: `set_plugin_enabled` calls this before writing a plugin's `enabled` field. It uses `new_implicit_table` for newly created structure and `ensure_table_for_write` to normalize existing TOML items.

*Call graph*: calls 2 internal fn (ensure_table_for_write, new_implicit_table); called by 1 (set_plugin_enabled); 2 external calls (as_table_mut, Table).


##### `ensure_table_for_write`  (lines 124–140)

```
fn ensure_table_for_write(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Turns a TOML item into a table when it is reasonable to do so, so later code can write nested settings into it. It is a small compatibility helper for different ways TOML may represent data.

**Data flow**: It receives a mutable TOML item. If the item is already a table, it returns that table. If it is an inline table, like `{ enabled = true }`, it converts it into a normal table. If it is empty, it creates a new implicit table. If it is another kind of item that should not be treated as a table, it returns nothing.

**Call relations**: `ensure_plugins_table` uses this for the top-level `plugins` item, and `set_plugin_enabled` uses it for a specific plugin item. It calls `new_implicit_table` when it needs a fresh table.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 2 (ensure_plugins_table, set_plugin_enabled); 2 external calls (Table, as_table_mut).


##### `ensure_table_for_read`  (lines 142–152)

```
fn ensure_table_for_read(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Checks whether a TOML item can be read as a table, converting inline tables when possible. It is used for removal, where the code should not invent new structure just to delete something.

**Data flow**: It receives a mutable TOML item. If the item is already a table, it returns it. If it is an inline table, it copies that inline data into a normal table and returns the result. If it is anything else, it returns nothing.

**Call relations**: `clear_plugin` calls this after it finds an existing `plugins` entry. When conversion from an inline table is needed, it delegates to `table_from_inline`.

*Call graph*: calls 1 internal fn (table_from_inline); called by 1 (clear_plugin); 2 external calls (Table, as_table_mut).


##### `table_from_inline`  (lines 154–162)

```
fn table_from_inline(inline: &toml_edit::InlineTable) -> TomlTable
```

**Purpose**: Converts a compact TOML inline table into a regular TOML table. This lets the rest of the editor use one table shape internally.

**Data flow**: It receives an inline table. It creates a new implicit table, copies each key and value into it, and removes suffix decoration from copied values so the converted table has cleaner formatting. It returns the new table.

**Call relations**: `ensure_table_for_read` calls this when it needs to read an inline table as a normal table. `ensure_table_for_write` also uses the same conversion path when preparing data for writing.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 1 (ensure_table_for_read); 2 external calls (iter, Value).


##### `new_implicit_table`  (lines 164–168)

```
fn new_implicit_table() -> TomlTable
```

**Purpose**: Creates a TOML table that is marked as implicit. An implicit table acts like supporting structure in the document rather than necessarily being printed as its own explicit section.

**Data flow**: It creates a fresh TOML table, marks it as implicit, and returns it. Nothing else is read or changed.

**Call relations**: This helper is used whenever the editor needs new TOML structure: for the top-level plugin area, for missing plugin entries, and during inline-table conversion.

*Call graph*: called by 3 (ensure_plugins_table, ensure_table_for_write, table_from_inline); 1 external calls (new).


##### `preserve_decor`  (lines 170–178)

```
fn preserve_decor(existing: &TomlItem, replacement: &mut TomlItem)
```

**Purpose**: Copies formatting decoration from an old TOML value onto a replacement value. This helps a simple value change avoid unnecessarily changing the look of the user's config file.

**Data flow**: It receives the existing TOML item and the replacement TOML item. If both are plain values, it copies decoration such as surrounding spacing or comments metadata from the old value to the new one. It does not return a value; it changes the replacement item in place.

**Call relations**: `set_plugin_enabled` calls this just before replacing an existing `enabled` value. Its job is narrow: keep the edit focused on the boolean value instead of disturbing nearby formatting.

*Call graph*: called by 1 (set_plugin_enabled).


##### `tests::set_user_plugin_enabled_writes_plugin_entry`  (lines 187–207)

```
async fn set_user_plugin_enabled_writes_plugin_entry()
```

**Purpose**: Checks that enabling a plugin creates the expected plugin entry in a new config file. It proves the simplest save path works.

**Data flow**: It creates a temporary Codex home folder, calls `set_user_plugin_enabled` for a sample plugin, reads the resulting config, and compares it with the expected TOML value. The temporary folder is changed by creating a config file.

**Call relations**: This test exercises the public enable/disable helper from the outside, the same way higher-level code would. It uses `read_config` to inspect the file after the edit.

*Call graph*: calls 1 internal fn (set_user_plugin_enabled); 4 external calls (new, assert_eq!, read_config, from_str).


##### `tests::set_user_plugin_enabled_preserves_existing_plugin_fields`  (lines 210–240)

```
async fn set_user_plugin_enabled_preserves_existing_plugin_fields()
```

**Purpose**: Checks that changing `enabled` does not erase other fields already stored for the plugin. This protects user data such as a plugin source path.

**Data flow**: It creates a temporary config file containing `enabled = false` and another field. It calls `set_user_plugin_enabled` to change the plugin to enabled, then reads the file back and compares it with TOML that still includes the other field. The config file is updated but not stripped down.

**Call relations**: This test calls the public setting function and indirectly checks the behavior of `set_plugin_enabled`, especially its table-editing approach that preserves existing keys.

*Call graph*: calls 1 internal fn (set_user_plugin_enabled); 5 external calls (new, assert_eq!, read_config, write, from_str).


##### `tests::clear_user_plugin_removes_empty_plugins_table`  (lines 243–262)

```
async fn clear_user_plugin_removes_empty_plugins_table()
```

**Purpose**: Checks that clearing the only plugin entry removes it from the file and leaves no printed plugin config behind. This verifies the cleanup behavior for a simple removal.

**Data flow**: It writes a temporary config file with one plugin entry, calls `clear_user_plugin`, then reads the raw file text. The expected after-state is an empty string.

**Call relations**: This test calls the public clear helper and therefore exercises the removal path through `apply_user_plugin_config_edits` and `clear_plugin`.

*Call graph*: calls 1 internal fn (clear_user_plugin); 3 external calls (new, assert_eq!, write).


##### `tests::clear_user_plugin_missing_entry_does_not_create_config`  (lines 265–273)

```
async fn clear_user_plugin_missing_entry_does_not_create_config()
```

**Purpose**: Checks that trying to clear a plugin that is not configured does not create a new config file. This matters because a no-op should not leave files behind.

**Data flow**: It creates an empty temporary Codex home folder, calls `clear_user_plugin` for a sample plugin, and then checks that the config file path still does not exist. The folder remains without a config file.

**Call relations**: This test confirms the no-change path in the public clear flow. It indirectly checks that `clear_plugin` returns false when there is nothing to remove, so the blocking editor does not write anything.

*Call graph*: calls 1 internal fn (clear_user_plugin); 2 external calls (new, assert!).


##### `tests::set_user_plugin_enabled_follows_config_symlink`  (lines 277–302)

```
async fn set_user_plugin_enabled_follows_config_symlink()
```

**Purpose**: Checks that writing plugin settings respects a config file symlink. In plain terms, if `config.toml` is a shortcut to another file, the real target file should receive the update.

**Data flow**: On Unix systems, it creates a temporary folder, makes `config.toml` a symlink to another file, calls `set_user_plugin_enabled`, then reads the symlink target and compares its TOML contents with the expected plugin entry. The target file is created or updated.

**Call relations**: This test exercises the public set function while specifically checking the path-resolution behavior used inside `apply_user_plugin_config_edits_blocking`.

*Call graph*: calls 1 internal fn (set_user_plugin_enabled); 4 external calls (new, assert_eq!, read_to_string, from_str).


##### `tests::read_config`  (lines 304–306)

```
fn read_config(codex_home: &Path) -> toml::Value
```

**Purpose**: Reads the temporary test config file and parses it as TOML. It is a small test helper that keeps assertions focused on config meaning rather than raw text formatting.

**Data flow**: It receives a Codex home folder, reads the `config.toml` file inside it, parses the text into a TOML value, and returns that parsed value to the test.

**Call relations**: The plugin-setting tests call this helper after making changes. It does not participate in production code; it only supports test checks.

*Call graph*: 3 external calls (join, read_to_string, from_str).


### `external-agent-migration/src/lib.rs`

`domain_logic` · `migration/import`

This file is a migration toolbox. Its job is to look at files written for another coding agent, understand the parts Codex can reuse, and write new Codex-friendly configuration without overwriting existing user work. Without it, users moving from Claude-style setup to Codex would have to manually translate server settings, hook scripts, subagent instructions, and slash-command templates.

The file works like a careful customs checkpoint. It reads source files, checks whether each item is safe and supported, rewrites names and paths where needed, and then exports only the clean results. MCP server settings are read from JSON and converted into TOML, Codex’s configuration format. Hooks are copied and rewritten so commands point at Codex’s hooks directory. Subagents are converted from Markdown with YAML frontmatter into TOML agent files. Commands are converted into Codex skills when they have a description, a safe name, and no unsupported template tricks.

A major theme is caution. If a setting contains dynamic shell placeholders, unsupported transports, duplicate command names, malformed frontmatter, or hooks with behavior Codex cannot represent, the code skips it instead of guessing. It also avoids overwriting existing files. That makes migration conservative: better to leave something for a human than silently create a broken or unsafe configuration.

#### Function details

##### `build_mcp_config_from_external`  (lines 44–84)

```
fn build_mcp_config_from_external(
    source_root: &Path,
    external_agent_home: Option<&Path>,
    settings: Option<&JsonValue>,
) -> io::Result<TomlValue>
```

**Purpose**: Builds a Codex TOML configuration section for MCP servers found in the external agent’s files. MCP means “Model Context Protocol,” a way tools or services can be connected to the agent.

**Data flow**: It receives a project folder, an optional external-agent home folder, and optional settings. It reads MCP server JSON, filters out disabled or unsupported servers, converts each safe server into TOML, and returns either a TOML table or an empty table when nothing can be migrated.

**Call relations**: This is the public entry point for MCP migration. It asks read_external_mcp_servers to gather raw server definitions, then asks mcp_server_toml_table to translate each one into Codex’s format.

*Call graph*: calls 2 internal fn (mcp_server_toml_table, read_external_mcp_servers); 3 external calls (default, Table, new).


##### `hooks_migration_description`  (lines 86–99)

```
fn hooks_migration_description(
    source_external_agent_dir: &Path,
    target_hooks: &Path,
) -> io::Result<Option<String>>
```

**Purpose**: Creates a short human-readable sentence describing a hook migration, but only if there are hooks worth migrating.

**Data flow**: It receives the source external-agent directory and the target hooks file path. It checks which hook events would migrate, then returns either no description or a sentence showing source and target locations.

**Call relations**: This is used when another part of the program wants to preview or explain the migration. It relies on hook_migration_event_names to decide whether there is anything to describe.

*Call graph*: calls 1 internal fn (hook_migration_event_names); 1 external calls (format!).


##### `hook_migration_event_names`  (lines 101–107)

```
fn hook_migration_event_names(
    source_external_agent_dir: &Path,
    target_hooks: &Path,
) -> io::Result<Vec<String>>
```

**Purpose**: Reports which hook event names can be migrated from the external-agent settings.

**Data flow**: It receives the source external-agent directory and target hooks path. It builds the hook migration plan and returns the event names found in that plan.

**Call relations**: hooks_migration_description calls this to decide whether to show a migration message. Internally it delegates the real inspection work to hook_migration.

*Call graph*: calls 1 internal fn (hook_migration); called by 1 (hooks_migration_description); 1 external calls (parent).


##### `import_hooks`  (lines 109–132)

```
fn import_hooks(source_external_agent_dir: &Path, target_hooks: &Path) -> io::Result<bool>
```

**Purpose**: Copies supported external-agent hooks into Codex and writes a Codex hooks JSON file when it is safe to do so.

**Data flow**: It receives the source external-agent directory and the target hooks file. It builds a migration payload, creates the target directory if needed, copies hook scripts, writes hooks JSON only if the target file is missing or empty, and returns whether it wrote active hooks.

**Call relations**: This is the public hook import function. It uses hook_migration to plan the JSON, copy_hook_scripts to move script files, and is_missing_or_empty_text_file to avoid overwriting existing hook configuration.

*Call graph*: calls 4 internal fn (copy_hook_scripts, hook_migration, invalid_data_error, is_missing_or_empty_text_file); 7 external calls (Object, parent, format!, create_dir_all, write, new, to_string_pretty).


##### `count_missing_subagents`  (lines 134–136)

```
fn count_missing_subagents(source_agents: &Path, target_agents: &Path) -> io::Result<usize>
```

**Purpose**: Counts how many external-agent subagents do not yet exist in the Codex target directory.

**Data flow**: It receives source and target agent directories. It asks for the missing subagent names and returns their count.

**Call relations**: This is a small reporting wrapper around missing_subagent_names, useful for previews or summaries before importing.

*Call graph*: calls 1 internal fn (missing_subagent_names).


##### `missing_subagent_names`  (lines 138–156)

```
fn missing_subagent_names(
    source_agents: &Path,
    target_agents: &Path,
) -> io::Result<Vec<String>>
```

**Purpose**: Finds external-agent subagents that could be imported but do not already have matching Codex files.

**Data flow**: It receives source and target agent directories. It scans Markdown agent files, parses each one, extracts required metadata, computes the target TOML path, and returns the names whose target files are absent.

**Call relations**: count_missing_subagents uses this for a simple number. It shares much of the same discovery path as import_subagents but stops before writing files.

*Call graph*: calls 4 internal fn (agent_metadata, agent_source_files, parse_document, subagent_target_file); called by 1 (count_missing_subagents); 1 external calls (new).


##### `import_subagents`  (lines 158–181)

```
fn import_subagents(source_agents: &Path, target_agents: &Path) -> io::Result<Vec<String>>
```

**Purpose**: Converts supported external-agent subagent Markdown files into Codex TOML agent files.

**Data flow**: It receives source and target agent directories. If the source exists, it creates the target directory, scans Markdown files, skips already-imported targets, parses metadata and body text, writes TOML, and returns the imported agent names.

**Call relations**: This is the public subagent import function. It depends on agent_source_files for discovery, agent_metadata for validation, subagent_target_file for naming, and render_agent_toml for final output.

*Call graph*: calls 5 internal fn (agent_metadata, agent_source_files, parse_document, render_agent_toml, subagent_target_file); 4 external calls (is_dir, new, create_dir_all, write).


##### `count_missing_commands`  (lines 183–185)

```
fn count_missing_commands(source_commands: &Path, target_skills: &Path) -> io::Result<usize>
```

**Purpose**: Counts how many external-agent command templates can become Codex skills and are not already present.

**Data flow**: It receives source command and target skill directories. It asks for the missing command names and returns their count.

**Call relations**: This is a reporting wrapper around missing_command_names, useful before running the import.

*Call graph*: calls 1 internal fn (missing_command_names).


##### `missing_command_names`  (lines 187–196)

```
fn missing_command_names(
    source_commands: &Path,
    target_skills: &Path,
) -> io::Result<Vec<String>>
```

**Purpose**: Finds supported command templates whose matching Codex skill folders do not exist yet.

**Data flow**: It receives the source command directory and target skills directory. It gathers unique supported command sources, filters out names already present in the target directory, and returns the remaining skill names.

**Call relations**: count_missing_commands calls this for summary counts. It relies on unique_supported_command_sources to avoid unsafe or duplicate command conversions.

*Call graph*: calls 1 internal fn (unique_supported_command_sources); called by 1 (count_missing_commands).


##### `import_commands`  (lines 198–224)

```
fn import_commands(source_commands: &Path, target_skills: &Path) -> io::Result<Vec<String>>
```

**Purpose**: Converts supported external-agent command Markdown files into Codex skill folders.

**Data flow**: It receives the source command directory and target skills directory. It creates target folders, skips existing skills, reads each supported command, builds a description and source name, writes SKILL.md, and returns the imported skill names.

**Call relations**: This is the public command import function. It uses unique_supported_command_sources to decide what is safe, parse_document to read each file, and render_command_skill to produce the skill document.

*Call graph*: calls 5 internal fn (command_skill_description, command_source_name, parse_document, render_command_skill, unique_supported_command_sources); 5 external calls (is_dir, join, new, create_dir_all, write).


##### `read_external_mcp_servers`  (lines 226–269)

```
fn read_external_mcp_servers(
    source_root: &Path,
    external_agent_home: Option<&Path>,
) -> io::Result<BTreeMap<String, JsonValue>>
```

**Purpose**: Collects raw MCP server definitions from the places the external agent may store them.

**Data flow**: It receives the project root and optional external-agent home. It reads project-level MCP JSON files, project-specific entries, and possibly home-level project entries, merging matching server definitions into one ordered map.

**Call relations**: build_mcp_config_from_external calls this before conversion. It uses append_mcp_servers_from_value for merging and append_external_agent_project_mcp_servers for the home-level fallback.

*Call graph*: calls 4 internal fn (append_external_agent_project_mcp_servers, append_mcp_servers_from_value, external_agent_project_config_file, project_path_matches_source_root); called by 1 (build_mcp_config_from_external); 4 external calls (new, join, read_to_string, from_str).


##### `append_external_agent_project_mcp_servers`  (lines 271–295)

```
fn append_external_agent_project_mcp_servers(
    source_file: &Path,
    source_root: &Path,
    servers: &mut BTreeMap<String, JsonValue>,
) -> io::Result<()>
```

**Purpose**: Adds MCP servers from a home-level external-agent project config when they belong to the current project.

**Data flow**: It receives a config file path, a project root, and the server map being built. If the file exists and contains matching project entries, it appends those servers without replacing ones already found.

**Call relations**: read_external_mcp_servers calls this after reading project-local files, so project-local definitions stay stronger than home-level ones.

*Call graph*: calls 2 internal fn (append_mcp_servers_from_value, project_path_matches_source_root); called by 1 (read_external_mcp_servers); 3 external calls (is_file, read_to_string, from_str).


##### `append_mcp_servers_from_value`  (lines 303–323)

```
fn append_mcp_servers_from_value(
    value: &JsonValue,
    servers: &mut BTreeMap<String, JsonValue>,
    merge: McpServerMerge,
)
```

**Purpose**: Copies MCP server entries from one parsed JSON value into the shared server map.

**Data flow**: It receives a JSON value, the destination map, and a merge rule. It looks for a mcpServers object and inserts each server, either overwriting old values or preserving existing ones.

**Call relations**: Both read_external_mcp_servers and append_external_agent_project_mcp_servers use this to apply the same merge behavior consistently.

*Call graph*: called by 2 (append_external_agent_project_mcp_servers, read_external_mcp_servers); 1 external calls (get).


##### `project_path_matches_source_root`  (lines 325–336)

```
fn project_path_matches_source_root(project_path: &str, source_root: &Path) -> bool
```

**Purpose**: Checks whether a project path written in external-agent config refers to the current project.

**Data flow**: It receives a path string and the current source root. It first compares them directly, then tries canonical paths, which resolve symbolic links and relative pieces, and returns true only when they match.

**Call relations**: MCP config readers use this before importing project-specific server settings, so settings for another repository are not accidentally migrated.

*Call graph*: called by 2 (append_external_agent_project_mcp_servers, read_external_mcp_servers); 2 external calls (canonicalize, new).


##### `mcp_server_toml_table`  (lines 338–396)

```
fn mcp_server_toml_table(
    server_name: &str,
    server_config: Option<&serde_json::Map<String, JsonValue>>,
    enabled_servers: &[String],
    disabled_servers: &BTreeSet<String>,
) -> Option<to
```

**Purpose**: Converts one external-agent MCP server definition into one Codex TOML table, if Codex can safely represent it.

**Data flow**: It receives a server name, its JSON object, enabled and disabled server lists. It rejects disabled servers, unsupported transports, and unsafe environment placeholders, then returns a TOML table for command-based or URL-based servers.

**Call relations**: build_mcp_config_from_external calls this for each gathered server. It delegates environment and header details to append_env_config and append_header_config.

*Call graph*: calls 5 internal fn (append_env_config, append_header_config, contains_env_placeholder, json_string_vec, mcp_server_is_disabled); called by 1 (build_mcp_config_from_external); 4 external calls (Array, String, matches!, new).


##### `mcp_server_is_disabled`  (lines 398–414)

```
fn mcp_server_is_disabled(
    server_name: &str,
    server_config: &serde_json::Map<String, JsonValue>,
    enabled_servers: &[String],
    disabled_servers: &BTreeSet<String>,
) -> bool
```

**Purpose**: Decides whether an MCP server should be skipped because settings say it is off.

**Data flow**: It receives a server name, its config object, an allow-list, and a deny-list. It checks enabled and disabled flags plus the provided lists, then returns true when the server should not migrate.

**Call relations**: mcp_server_toml_table uses this before doing any deeper conversion, so disabled servers never reach the output.

*Call graph*: called by 1 (mcp_server_toml_table); 2 external calls (contains, get).


##### `append_header_config`  (lines 416–456)

```
fn append_header_config(
    table: &mut toml::map::Map<String, TomlValue>,
    headers: &serde_json::Map<String, JsonValue>,
) -> Option<()>
```

**Purpose**: Converts HTTP header settings for an MCP server into Codex’s TOML style.

**Data flow**: It receives a TOML table and JSON header map. It separates plain headers from headers whose values should come from environment variables, recognizes Bearer token headers specially, and returns nothing if a header uses an unsafe mixed placeholder.

**Call relations**: mcp_server_toml_table calls this for URL-based MCP servers that include headers.

*Call graph*: calls 3 internal fn (contains_env_placeholder, json_string, parse_env_placeholder); called by 1 (mcp_server_toml_table); 4 external calls (insert, String, Table, new).


##### `append_env_config`  (lines 458–483)

```
fn append_env_config(
    table: &mut toml::map::Map<String, TomlValue>,
    env: &serde_json::Map<String, JsonValue>,
) -> Option<()>
```

**Purpose**: Converts environment variable settings for a command-based MCP server into Codex’s TOML style.

**Data flow**: It receives a TOML table and JSON environment map. It separates fixed values from values that should be copied from the user’s environment, and rejects mixed placeholder strings it cannot safely translate.

**Call relations**: mcp_server_toml_table calls this when a command MCP server has an env section.

*Call graph*: calls 3 internal fn (contains_env_placeholder, json_string, parse_env_placeholder); called by 1 (mcp_server_toml_table); 6 external calls (insert, Array, String, Table, new, new).


##### `parse_env_placeholder`  (lines 485–499)

```
fn parse_env_placeholder(value: &str) -> Option<String>
```

**Purpose**: Recognizes simple shell-style environment placeholders like ${TOKEN} or ${TOKEN:-fallback}.

**Data flow**: It receives a string. If the whole string is a valid placeholder with a valid variable name, it returns that variable name; otherwise it returns nothing.

**Call relations**: append_env_config and append_header_config use this to tell the difference between safe direct environment references and strings that would need more complex shell expansion.

*Call graph*: called by 2 (append_env_config, append_header_config).


##### `contains_env_placeholder`  (lines 501–503)

```
fn contains_env_placeholder(value: &str) -> bool
```

**Purpose**: Checks whether a string appears to contain an environment placeholder.

**Data flow**: It receives a string and returns true if it contains the marker ${.

**Call relations**: MCP conversion functions use this as a safety check. If a value contains a placeholder but is not a simple whole-value placeholder, migration usually skips it.

*Call graph*: called by 3 (append_env_config, append_header_config, mcp_server_toml_table).


##### `hook_migration`  (lines 505–535)

```
fn hook_migration(
    source_external_agent_dir: &Path,
    target_config_dir: Option<&Path>,
) -> io::Result<serde_json::Map<String, JsonValue>>
```

**Purpose**: Builds the Codex hooks JSON payload that can be migrated from external-agent settings.

**Data flow**: It receives the source external-agent directory and an optional Codex config directory. It reads settings.json and settings.local.json, honors disableAllHooks, converts supported hook groups, and returns a JSON map grouped by hook event.

**Call relations**: import_hooks uses this to write the final hooks file, and hook_migration_event_names uses it to report which hook events would be migrated.

*Call graph*: calls 1 internal fn (append_convertible_hook_groups); called by 2 (hook_migration_event_names, import_hooks); 5 external calls (join, new, read_to_string, new, from_str).


##### `append_convertible_hook_groups`  (lines 537–660)

```
fn append_convertible_hook_groups(
    settings: &JsonValue,
    hooks_payload: &mut serde_json::Map<String, JsonValue>,
    target_config_dir: Option<&Path>,
)
```

**Purpose**: Pulls only the hook groups Codex can safely understand out of one settings JSON value.

**Data flow**: It receives parsed settings, the output hook payload, and an optional target config directory. It scans known hook events, skips unsupported conditions and hook types, rewrites command paths and status text, and appends valid hook groups to the output.

**Call relations**: hook_migration calls this for each settings file. Several tests also call it directly to prove unsupported handlers and negative timeouts are handled safely.

*Call graph*: calls 2 internal fn (rewrite_external_agent_terms, rewrite_hook_command); called by 3 (hook_migration, hook_migration_drops_negative_timeouts, hook_migration_ignores_unsupported_handlers); 9 external calls (Array, Number, Object, String, get, entry, new, new, from).


##### `rewrite_hook_command`  (lines 662–677)

```
fn rewrite_hook_command(command: &str, target_config_dir: Option<&Path>) -> String
```

**Purpose**: Rewrites hook commands so script paths that used to point into the external-agent hooks folder point into Codex’s copied hooks folder.

**Data flow**: It receives a command string and optional target config directory. If no target is known or the command looks Windows-specific, it leaves it unchanged; otherwise it rewrites safe quoted and unquoted hook paths.

**Call relations**: append_convertible_hook_groups calls this while building migrated hook commands. It hands the detailed path scanning to replace_quoted_hook_paths and replace_unquoted_hook_paths.

*Call graph*: calls 3 internal fn (looks_like_windows_hook_command, replace_quoted_hook_paths, replace_unquoted_hook_paths); called by 1 (append_convertible_hook_groups); 1 external calls (format!).


##### `replace_quoted_hook_paths`  (lines 679–711)

```
fn replace_quoted_hook_paths(
    command: &str,
    quote: char,
    source_hooks_path: &str,
    target_hooks_dir: &Path,
) -> String
```

**Purpose**: Rewrites source hook paths that appear inside matching quotes.

**Data flow**: It receives a command, a quote character, the source hooks path text, and the target hooks directory. It scans quoted chunks, replaces safe source hook paths with quoted target paths, and returns the rewritten command.

**Call relations**: rewrite_hook_command calls this once for single quotes and once for double quotes before trying unquoted paths.

*Call graph*: calls 1 internal fn (target_hook_path_replacement); called by 1 (rewrite_hook_command).


##### `replace_unquoted_hook_paths`  (lines 713–744)

```
fn replace_unquoted_hook_paths(
    command: &str,
    source_hooks_path: &str,
    target_hooks_dir: &Path,
) -> String
```

**Purpose**: Rewrites source hook paths that appear as plain shell words rather than inside quotes.

**Data flow**: It receives a command, the source hooks path text, and the target hooks directory. It finds unquoted source paths, expands to the full shell path word, skips assignment values, replaces safe static paths, and returns the rewritten command.

**Call relations**: rewrite_hook_command calls this after quoted replacements. It relies on shell-path helper functions to avoid changing unrelated shell syntax.

*Call graph*: calls 5 internal fn (find_unquoted_source_hook_path, is_assignment_value_start, shell_path_end, shell_path_start, target_hook_path_replacement); called by 1 (rewrite_hook_command).


##### `find_unquoted_source_hook_path`  (lines 746–781)

```
fn find_unquoted_source_hook_path(
    command: &str,
    source_hooks_path: &str,
    start: usize,
) -> Option<usize>
```

**Purpose**: Finds the next source hooks path that is not inside shell quotes.

**Data flow**: It receives a command, the source hooks path text, and a start position. It walks the command while tracking single quotes, double quotes, and backslash escapes, then returns the index of the next unquoted match.

**Call relations**: replace_unquoted_hook_paths uses this repeatedly to find candidate paths before deciding whether they are safe to replace.

*Call graph*: called by 1 (replace_unquoted_hook_paths).


##### `is_pure_shell_path_content`  (lines 783–787)

```
fn is_pure_shell_path_content(content: &str, source_hooks_start: usize) -> bool
```

**Purpose**: Checks whether a found hook path is part of a plain path rather than embedded in more complex shell text.

**Data flow**: It receives the full path-like content and the position where the source hooks path begins. It examines the prefix and returns true only for simple path forms.

**Call relations**: target_hook_path_replacement uses this before producing a replacement, preventing risky rewrites inside complicated shell expressions.

*Call graph*: called by 1 (target_hook_path_replacement).


##### `shell_path_start`  (lines 789–795)

```
fn shell_path_start(command: &str, end: usize) -> usize
```

**Purpose**: Finds where a shell path word begins before a known position.

**Data flow**: It receives a command and an end index. It scans backward by looking for shell boundary characters and returns the start of the current path-like word.

**Call relations**: replace_unquoted_hook_paths uses this to replace the whole path word, not just the middle part that matched the source hooks directory.

*Call graph*: called by 1 (replace_unquoted_hook_paths).


##### `shell_path_end`  (lines 797–813)

```
fn shell_path_end(command: &str, start: usize) -> usize
```

**Purpose**: Finds where a shell path word ends after a known position.

**Data flow**: It receives a command and a start index. It scans forward, respecting backslash escapes, and stops at a shell boundary or the end of the command.

**Call relations**: replace_unquoted_hook_paths uses this together with shell_path_start to isolate the path that may need rewriting.

*Call graph*: calls 1 internal fn (is_shell_path_boundary); called by 1 (replace_unquoted_hook_paths).


##### `is_shell_path_boundary`  (lines 815–817)

```
fn is_shell_path_boundary(ch: char) -> bool
```

**Purpose**: Identifies characters that normally separate shell words or commands.

**Data flow**: It receives one character and returns true for whitespace and shell separators like pipes, semicolons, redirects, equals signs, and parentheses.

**Call relations**: shell_path_end uses this while finding the end of a path word.

*Call graph*: called by 1 (shell_path_end); 1 external calls (matches!).


##### `is_assignment_value_start`  (lines 819–824)

```
fn is_assignment_value_start(command: &str, path_start: usize) -> bool
```

**Purpose**: Detects when a path appears immediately after an equals sign in a shell assignment.

**Data flow**: It receives a command and the path start index. It looks at the previous character and returns true if the path is the value side of an assignment.

**Call relations**: replace_unquoted_hook_paths uses this to avoid rewriting variable assignments, because changing only the assigned text could alter shell behavior unexpectedly.

*Call graph*: called by 1 (replace_unquoted_hook_paths).


##### `target_hook_path_replacement`  (lines 826–839)

```
fn target_hook_path_replacement(
    target_hooks_dir: &Path,
    path: &str,
    source_hooks_start: usize,
    suffix: &str,
) -> Option<String>
```

**Purpose**: Builds the replacement path for a migrated hook script, but only when the old path is simple and static.

**Data flow**: It receives the target hooks directory, the original path text, where the source hook path starts, and the path suffix. It rejects dynamic or complex paths, then returns a safely single-quoted target path.

**Call relations**: Both quoted and unquoted path replacement functions call this as the final safety gate before changing a command.

*Call graph*: calls 3 internal fn (is_pure_shell_path_content, is_static_hook_path_suffix, shell_single_quote); called by 2 (replace_quoted_hook_paths, replace_unquoted_hook_paths); 1 external calls (join).


##### `is_static_hook_path_suffix`  (lines 841–846)

```
fn is_static_hook_path_suffix(suffix: &str) -> bool
```

**Purpose**: Checks that the part of a hook path after the hooks directory is a fixed file path.

**Data flow**: It receives the suffix string. It returns false for empty suffixes or suffixes containing shell wildcards, variables, command substitution, escapes, or brace syntax.

**Call relations**: target_hook_path_replacement uses this to avoid rewriting paths that depend on runtime shell expansion.

*Call graph*: called by 1 (target_hook_path_replacement).


##### `looks_like_windows_hook_command`  (lines 848–857)

```
fn looks_like_windows_hook_command(command: &str) -> bool
```

**Purpose**: Detects hook commands that appear to use Windows path or environment-variable syntax.

**Data flow**: It receives a command string and checks for backslash hook paths, percent-style variables, or PowerShell environment variables. It returns true when the command should be left alone.

**Call relations**: rewrite_hook_command calls this first, because its path rewriting logic is aimed at Unix-style shell commands.

*Call graph*: calls 1 internal fn (external_agent_project_dir_env_var); called by 1 (rewrite_hook_command); 1 external calls (format!).


##### `shell_single_quote`  (lines 859–861)

```
fn shell_single_quote(value: &str) -> String
```

**Purpose**: Quotes a string so it can be used safely as one shell argument in Unix-style shells.

**Data flow**: It receives a value string, escapes any single quote inside it, wraps the result in single quotes, and returns that shell-safe text.

**Call relations**: target_hook_path_replacement uses this when inserting migrated hook script paths into commands.

*Call graph*: called by 1 (target_hook_path_replacement); 1 external calls (format!).


##### `copy_hook_scripts`  (lines 863–870)

```
fn copy_hook_scripts(source_external_agent_dir: &Path, target_config_dir: &Path) -> io::Result<()>
```

**Purpose**: Copies the external-agent hooks directory into Codex’s hooks directory without replacing existing scripts.

**Data flow**: It receives the source external-agent directory and target Codex config directory. If the source hooks directory exists, it recursively copies files to the target hooks folder, skipping files already there.

**Call relations**: import_hooks calls this before writing active hooks. A test also calls it to confirm existing target scripts are preserved.

*Call graph*: calls 1 internal fn (copy_dir_recursive_skip_existing); called by 2 (import_hooks, hook_script_copy_keeps_existing_target_scripts); 1 external calls (join).


##### `copy_dir_recursive_skip_existing`  (lines 872–886)

```
fn copy_dir_recursive_skip_existing(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Recursively copies a directory tree while leaving existing target files untouched.

**Data flow**: It receives source and target directories. It creates the target, walks each entry, recurses into subdirectories, copies missing files, and does not overwrite files that already exist.

**Call relations**: copy_hook_scripts uses this for the actual file copying work.

*Call graph*: called by 1 (copy_hook_scripts); 4 external calls (join, copy, create_dir_all, read_dir).


##### `agent_source_files`  (lines 888–909)

```
fn agent_source_files(source_agents: &Path) -> io::Result<Vec<PathBuf>>
```

**Purpose**: Finds external-agent subagent Markdown files that are candidates for import.

**Data flow**: It receives a source agent directory. If the directory exists, it lists regular .md files, skips README.md, sorts the paths, and returns them.

**Call relations**: missing_subagent_names and import_subagents both use this so preview and import look at the same files.

*Call graph*: called by 2 (import_subagents, missing_subagent_names); 3 external calls (is_dir, new, read_dir).


##### `subagent_target_file`  (lines 911–913)

```
fn subagent_target_file(source_file: &Path, target_agents: &Path) -> Option<PathBuf>
```

**Purpose**: Calculates the Codex TOML filename for a source subagent Markdown file.

**Data flow**: It receives a source file path and target agents directory. It takes the source filename stem and returns target/stem.toml, or nothing if the stem cannot be read as text.

**Call relations**: missing_subagent_names and import_subagents use this to decide whether a subagent already exists and where to write it.

*Call graph*: called by 2 (import_subagents, missing_subagent_names); 2 external calls (join, format!).


##### `command_source_files`  (lines 915–920)

```
fn command_source_files(source_commands: &Path) -> io::Result<Vec<PathBuf>>
```

**Purpose**: Finds all Markdown command files under the external-agent command directory.

**Data flow**: It receives the source commands directory. It recursively collects .md files, sorts them, and returns the list.

**Call relations**: unique_supported_command_sources calls this before filtering commands for safe skill conversion.

*Call graph*: calls 1 internal fn (collect_markdown_files); called by 1 (unique_supported_command_sources); 1 external calls (new).


##### `unique_supported_command_sources`  (lines 922–942)

```
fn unique_supported_command_sources(source_commands: &Path) -> io::Result<Vec<(PathBuf, String)>>
```

**Purpose**: Selects command files that can safely become Codex skills and have unique generated names.

**Data flow**: It receives the source command directory. It parses each Markdown command, asks whether it is supported, groups files by generated skill name, drops name collisions, and returns one source file per unique name.

**Call relations**: missing_command_names and import_commands rely on this shared filter so counting and importing agree.

*Call graph*: calls 3 internal fn (command_skill_name_if_supported, command_source_files, parse_document); called by 2 (import_commands, missing_command_names); 1 external calls (new).


##### `collect_markdown_files`  (lines 944–961)

```
fn collect_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) -> io::Result<()>
```

**Purpose**: Recursively gathers Markdown files from a directory tree.

**Data flow**: It receives a directory and a growing file list. It walks subdirectories, adds regular .md files, and leaves the list unchanged if the directory does not exist.

**Call relations**: command_source_files uses this as its recursive scanner.

*Call graph*: called by 1 (command_source_files); 2 external calls (is_dir, read_dir).


##### `parse_document`  (lines 963–966)

```
fn parse_document(source_file: &Path) -> io::Result<ParsedDocument>
```

**Purpose**: Reads a Markdown file and splits it into frontmatter metadata and body text.

**Data flow**: It receives a file path, reads the file as text, passes the content to parse_document_content, and returns the parsed document.

**Call relations**: Subagent and command import paths call this whenever they need metadata such as name or description from a source Markdown file.

*Call graph*: calls 1 internal fn (parse_document_content); called by 4 (import_commands, import_subagents, missing_subagent_names, unique_supported_command_sources); 1 external calls (read_to_string).


##### `parse_document_content`  (lines 968–995)

```
fn parse_document_content(content: &str) -> ParsedDocument
```

**Purpose**: Splits raw Markdown content into optional YAML frontmatter and the main body.

**Data flow**: It receives a Markdown string. If it starts with frontmatter delimiters, it finds the closing delimiter, parses the YAML frontmatter, and returns a ParsedDocument; otherwise the whole text becomes the body.

**Call relations**: parse_document calls this for real files. Tests call it directly to check frontmatter parsing and validation rules.

*Call graph*: calls 2 internal fn (frontmatter_end, parse_frontmatter); called by 8 (parse_document, command_skill_names_must_fit_codex_skill_loader_limit, commands_with_provider_runtime_expansion_are_skipped, commands_without_description_are_skipped, frontmatter_accepts_crlf_delimiters, subagent_accepts_yaml_block_lists_by_ignoring_unsupported_fields, subagent_preserves_default_model_when_source_model_is_present, subagent_requires_minimum_codex_agent_fields); 1 external calls (new).


##### `frontmatter_end`  (lines 997–1009)

```
fn frontmatter_end(rest: &str) -> Option<(usize, usize)>
```

**Purpose**: Finds the closing --- delimiter for a Markdown frontmatter block.

**Data flow**: It receives the text after the opening delimiter. It searches for several newline styles, including Unix and Windows line endings, and returns where the frontmatter ends and the body begins.

**Call relations**: parse_document_content uses this to handle source files written on different operating systems.

*Call graph*: called by 1 (parse_document_content).


##### `parse_frontmatter`  (lines 1011–1034)

```
fn parse_frontmatter(
    raw_frontmatter: &str,
) -> (BTreeMap<String, FrontmatterValue>, Option<String>)
```

**Purpose**: Parses YAML frontmatter into a simple key-value map used by the migration code.

**Data flow**: It receives raw YAML text. It parses it, requires the top level to be a mapping, converts each usable key and value into simplified frontmatter values, and returns the map plus any parse error message.

**Call relations**: parse_document_content calls this after finding a frontmatter block.

*Call graph*: calls 1 internal fn (frontmatter_value_from_yaml); called by 1 (parse_document_content); 2 external calls (new, from_str).


##### `frontmatter_value_from_yaml`  (lines 1036–1045)

```
fn frontmatter_value_from_yaml(value: &YamlValue) -> FrontmatterValue
```

**Purpose**: Turns a YAML value into either a simple string-like value or a marker for unsupported complex data.

**Data flow**: It receives one YAML value. Strings, booleans, and numbers become trimmed scalar text; nulls, lists, maps, and tagged values become Other.

**Call relations**: parse_frontmatter uses this so later code can safely ask for simple fields like name and description while ignoring complex fields.

*Call graph*: called by 1 (parse_frontmatter); 3 external calls (to_string, trim, Scalar).


##### `agent_metadata`  (lines 1047–1071)

```
fn agent_metadata(document: &ParsedDocument) -> Option<AgentMetadata>
```

**Purpose**: Extracts the minimum metadata needed to import a subagent.

**Data flow**: It receives a parsed document. It rejects documents with frontmatter errors or empty bodies, requires non-empty name and description fields, optionally reads permission mode and effort, and returns structured metadata.

**Call relations**: missing_subagent_names and import_subagents call this to decide whether a Markdown agent is valid. A test also uses it before rendering an agent.

*Call graph*: calls 1 internal fn (frontmatter_string); called by 3 (import_subagents, missing_subagent_names, subagent_preserves_default_model_when_source_model_is_present).


##### `render_agent_toml`  (lines 1073–1106)

```
fn render_agent_toml(body: &str, metadata: &AgentMetadata) -> io::Result<String>
```

**Purpose**: Creates the Codex TOML text for one imported subagent.

**Data flow**: It receives the source body and extracted metadata. It writes name, rewritten description, optional reasoning effort, optional sandbox mode, and rewritten developer instructions, then serializes everything as TOML.

**Call relations**: import_subagents calls this before writing each target file. It uses render_agent_body, map_agent_reasoning_effort, and text rewriting helpers.

*Call graph*: calls 3 internal fn (map_agent_reasoning_effort, render_agent_body, rewrite_external_agent_terms); called by 2 (import_subagents, subagent_preserves_default_model_when_source_model_is_present); 5 external calls (String, Table, format!, new, to_string_pretty).


##### `render_agent_body`  (lines 1108–1115)

```
fn render_agent_body(body: &str) -> String
```

**Purpose**: Prepares the instruction body for a migrated subagent.

**Data flow**: It receives Markdown body text, trims it, rewrites external-agent terms to Codex terms, and returns a fallback sentence if no instructions remain.

**Call relations**: render_agent_toml calls this when filling the developer_instructions field.

*Call graph*: calls 1 internal fn (rewrite_external_agent_terms); called by 1 (render_agent_toml).


##### `command_skill_name`  (lines 1117–1122)

```
fn command_skill_name(source_commands: &Path, source_file: &Path) -> String
```

**Purpose**: Builds the Codex skill name for a source command file.

**Data flow**: It receives the source command root and one command file path. It turns the relative command path into a source name, adds a prefix, slugifies it, and returns the final skill name.

**Call relations**: command_skill_name_if_supported calls this while deciding whether a command can be imported.

*Call graph*: calls 1 internal fn (slugify_name); called by 1 (command_skill_name_if_supported); 1 external calls (format!).


##### `command_skill_name_if_supported`  (lines 1124–1145)

```
fn command_skill_name_if_supported(
    source_commands: &Path,
    source_file: &Path,
    document: &ParsedDocument,
) -> Option<String>
```

**Purpose**: Decides whether a command file can become a Codex skill and returns its generated name if so.

**Data flow**: It receives the source command root, source file path, and parsed document. It skips README files, requires a description, checks generated name and description length limits, rejects unsupported template features, and returns the skill name when all checks pass.

**Call relations**: unique_supported_command_sources calls this for every command file before grouping by name.

*Call graph*: calls 4 internal fn (command_skill_description, command_skill_name, command_source_name, has_unsupported_command_template_features); called by 1 (unique_supported_command_sources); 1 external calls (file_stem).


##### `command_skill_description`  (lines 1147–1154)

```
fn command_skill_description(document: &ParsedDocument, _source_name: &str) -> Option<String>
```

**Purpose**: Extracts the description field required for a command to become a skill.

**Data flow**: It receives a parsed document and source name. It reads the description frontmatter field, requires it to be non-empty, and returns it as text.

**Call relations**: command_skill_name_if_supported uses this as a support check, and import_commands uses it again when rendering the final SKILL.md.

*Call graph*: called by 2 (command_skill_name_if_supported, import_commands).


##### `command_source_name`  (lines 1156–1165)

```
fn command_source_name(source_commands: &Path, source_file: &Path) -> String
```

**Purpose**: Creates a readable source command name from a command file path.

**Data flow**: It receives the source command root and a source file path. It strips the root if possible, removes the extension, joins path components with dashes, and returns that name.

**Call relations**: command_skill_name_if_supported uses this for validation context, and import_commands includes it in the generated skill instructions.

*Call graph*: called by 2 (command_skill_name_if_supported, import_commands); 1 external calls (strip_prefix).


##### `render_command_skill`  (lines 1167–1179)

```
fn render_command_skill(body: &str, name: &str, description: &str, source_name: &str) -> String
```

**Purpose**: Creates the SKILL.md content for a migrated command template.

**Data flow**: It receives the command body, skill name, description, and source command name. It rewrites external-agent terms, supplies a fallback body if empty, quotes YAML fields, and returns a complete Markdown skill document.

**Call relations**: import_commands writes this output into each new skill folder.

*Call graph*: calls 1 internal fn (rewrite_external_agent_terms); called by 1 (import_commands); 1 external calls (format!).


##### `has_unsupported_command_template_features`  (lines 1181–1190)

```
fn has_unsupported_command_template_features(template: &str) -> bool
```

**Purpose**: Detects command templates that rely on external-agent runtime features Codex cannot safely reproduce.

**Data flow**: It receives template text and checks for argument placeholders, moustache-style template markers, shell execution markers, and @file-like tokens. It returns true when the command should be skipped.

**Call relations**: command_skill_name_if_supported calls this before accepting a command for import.

*Call graph*: calls 1 internal fn (contains_numbered_argument_placeholder); called by 1 (command_skill_name_if_supported).


##### `contains_numbered_argument_placeholder`  (lines 1192–1197)

```
fn contains_numbered_argument_placeholder(template: &str) -> bool
```

**Purpose**: Checks for numbered placeholders like $1 or $2 in a command template.

**Data flow**: It receives template text, scans adjacent bytes for a dollar sign followed by a digit, and returns whether one is found.

**Call relations**: has_unsupported_command_template_features uses this as one of its skip checks.

*Call graph*: called by 1 (has_unsupported_command_template_features).


##### `frontmatter_string`  (lines 1199–1207)

```
fn frontmatter_string(
    frontmatter: &BTreeMap<String, FrontmatterValue>,
    key: &str,
) -> Option<String>
```

**Purpose**: Reads one simple string field from parsed frontmatter.

**Data flow**: It receives the frontmatter map and a key. It returns the scalar text for that key if present, or nothing if the field is missing or complex.

**Call relations**: agent_metadata uses this for optional fields such as permissionMode and effort.

*Call graph*: called by 1 (agent_metadata).


##### `map_agent_reasoning_effort`  (lines 1209–1219)

```
fn map_agent_reasoning_effort(effort: &str) -> Option<String>
```

**Purpose**: Translates external-agent reasoning effort names into Codex-supported names.

**Data flow**: It receives an effort string. It maps max to xhigh, accepts known Codex effort levels, and returns nothing for unknown values.

**Call relations**: render_agent_toml uses this before adding model_reasoning_effort to the imported agent.

*Call graph*: called by 1 (render_agent_toml); 1 external calls (matches!).


##### `map_agent_permission_mode`  (lines 1221–1227)

```
fn map_agent_permission_mode(permission_mode: &str) -> Option<&'static str>
```

**Purpose**: Translates external-agent permission modes into Codex sandbox modes.

**Data flow**: It receives a permission mode string. It maps acceptEdits to workspace-write and readOnly to read-only, returning nothing for modes it does not understand.

**Call relations**: render_agent_toml uses this when deciding whether to include a sandbox_mode for a migrated subagent.


##### `json_string_vec`  (lines 1229–1234)

```
fn json_string_vec(value: &JsonValue) -> Vec<String>
```

**Purpose**: Normalizes a JSON value into a list of strings.

**Data flow**: It receives a JSON value. Arrays become a list of their string-like elements, single scalar values become a one-item list, and objects or nulls are ignored.

**Call relations**: build_mcp_config_from_external and mcp_server_toml_table use this for settings such as enabled server names and command arguments.

*Call graph*: calls 1 internal fn (json_string); called by 1 (mcp_server_toml_table).


##### `json_string`  (lines 1236–1244)

```
fn json_string(value: &JsonValue) -> Option<String>
```

**Purpose**: Turns simple JSON scalar values into strings.

**Data flow**: It receives a JSON value. Strings, booleans, and numbers become text, null and structured values return nothing.

**Call relations**: json_string_vec, append_env_config, and append_header_config use this when reading permissive external-agent JSON settings.

*Call graph*: called by 3 (append_env_config, append_header_config, json_string_vec); 2 external calls (clone, to_string).


##### `json_u64`  (lines 1246–1251)

```
fn json_u64(value: &JsonValue) -> Option<u64>
```

**Purpose**: Reads a non-negative integer from a JSON value.

**Data flow**: It receives a JSON value. It rejects booleans and nulls, accepts unsigned numbers, or parses strings as unsigned integers, returning nothing on failure.

**Call relations**: append_convertible_hook_groups uses this when copying hook timeouts, which means negative or non-numeric timeouts are dropped.

*Call graph*: 3 external calls (as_u64, is_boolean, is_null).


##### `yaml_string`  (lines 1253–1255)

```
fn yaml_string(value: &str) -> String
```

**Purpose**: Quotes a string so it can be safely written as a YAML string.

**Data flow**: It receives text, escapes backslashes and double quotes, wraps it in double quotes, and returns the result.

**Call relations**: render_command_skill uses this for generated skill frontmatter fields.

*Call graph*: 1 external calls (format!).


##### `slugify_name`  (lines 1257–1276)

```
fn slugify_name(value: &str) -> String
```

**Purpose**: Turns arbitrary text into a simple lowercase dash-separated name.

**Data flow**: It receives a string. Letters and numbers are kept in lowercase, other runs become single dashes, leading and trailing dashes are removed, and an empty result becomes migrated.

**Call relations**: command_skill_name uses this so command-derived skill names fit Codex’s naming style.

*Call graph*: called by 1 (command_skill_name); 1 external calls (new).


##### `FrontmatterValue::as_scalar`  (lines 1279–1284)

```
fn as_scalar(&self) -> Option<&str>
```

**Purpose**: Returns the text inside a frontmatter value only when it is a simple scalar.

**Data flow**: It receives a FrontmatterValue. Scalar values produce their string slice, while Other values produce nothing.

**Call relations**: Metadata readers use this to safely ignore complex YAML fields such as lists or maps.


##### `is_missing_or_empty_text_file`  (lines 1287–1296)

```
fn is_missing_or_empty_text_file(path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether a target text file is safe for migration to write into.

**Data flow**: It receives a path. Missing files count as safe, non-files count as unsafe, and regular files count as safe only when their trimmed text is empty.

**Call relations**: import_hooks uses this to avoid overwriting an existing hooks configuration.

*Call graph*: called by 1 (import_hooks); 3 external calls (exists, is_file, read_to_string).


##### `rewrite_external_agent_terms`  (lines 1298–1308)

```
fn rewrite_external_agent_terms(content: &str) -> String
```

**Purpose**: Renames external-agent-specific words inside migrated text so the result reads naturally in Codex.

**Data flow**: It receives text. It replaces the external-agent doc filename with AGENTS.md and replaces known name variants with Codex, using word-boundary-aware matching.

**Call relations**: Hook status messages, agent descriptions and bodies, and command skill content all call this before being written.

*Call graph*: calls 3 internal fn (external_agent_doc_file_name, external_agent_term_variants, replace_case_insensitive_with_boundaries); called by 4 (append_convertible_hook_groups, render_agent_body, render_agent_toml, render_command_skill).


##### `replace_case_insensitive_with_boundaries`  (lines 1310–1347)

```
fn replace_case_insensitive_with_boundaries(
    input: &str,
    needle: &str,
    replacement: &str,
) -> String
```

**Purpose**: Replaces a word or phrase regardless of letter case, but only when it appears as a separate word-like unit.

**Data flow**: It receives input text, a search phrase, and replacement text. It scans a lowercase copy, checks word boundaries around each match, builds a new string only when replacements happen, and returns the result.

**Call relations**: rewrite_external_agent_terms uses this repeatedly for each external-agent term variant.

*Call graph*: calls 1 internal fn (is_word_byte); called by 1 (rewrite_external_agent_terms); 1 external calls (with_capacity).


##### `is_word_byte`  (lines 1349–1351)

```
fn is_word_byte(byte: u8) -> bool
```

**Purpose**: Defines what counts as a word character for safe text replacement.

**Data flow**: It receives one byte and returns true for ASCII letters, digits, and underscore.

**Call relations**: replace_case_insensitive_with_boundaries uses this to avoid replacing text inside larger identifiers.

*Call graph*: called by 1 (replace_case_insensitive_with_boundaries).


##### `invalid_data_error`  (lines 1353–1355)

```
fn invalid_data_error(message: impl Into<String>) -> io::Error
```

**Purpose**: Creates an input/output error that means the source data was malformed or could not be safely processed.

**Data flow**: It receives a message, wraps it in an io::Error with InvalidData kind, and returns that error.

**Call relations**: import_hooks and parsing/conversion paths use this style when serialization or source JSON data is invalid.

*Call graph*: called by 1 (import_hooks); 2 external calls (into, new).


##### `external_agent_config_dir`  (lines 1357–1359)

```
fn external_agent_config_dir() -> String
```

**Purpose**: Returns the external-agent configuration directory name.

**Data flow**: It uses the configured source agent name and returns a dot-prefixed directory name such as .claude.

**Call relations**: Migration helpers and tests use this whenever they need to refer to the source agent’s config directory consistently.

*Call graph*: called by 4 (hook_script_copy_keeps_existing_target_scripts, mcp_migration_preserves_repo_servers_over_home_project_entries, mcp_migration_reads_matching_project_entries_from_home_external_project_config, source_path); 1 external calls (format!).


##### `external_agent_project_config_file`  (lines 1361–1363)

```
fn external_agent_project_config_file() -> String
```

**Purpose**: Returns the external-agent project configuration filename.

**Data flow**: It uses the configured source agent name and returns a dot-prefixed JSON filename such as .claude.json.

**Call relations**: MCP readers use this to find project-level server settings. Tests use it to build realistic fixture files.

*Call graph*: called by 4 (read_external_mcp_servers, mcp_migration_preserves_repo_servers_over_home_project_entries, mcp_migration_reads_matching_project_entries_from_home_external_project_config, mcp_migration_reads_matching_project_entries_from_repo_external_project_config); 1 external calls (format!).


##### `external_agent_project_dir_env_var`  (lines 1365–1370)

```
fn external_agent_project_dir_env_var() -> String
```

**Purpose**: Returns the external-agent environment variable name that points at a project directory.

**Data flow**: It uppercases the configured source agent name and appends _PROJECT_DIR.

**Call relations**: Hook command rewriting uses this when detecting Windows-style commands. Tests use it to build source hook command examples.

*Call graph*: called by 2 (looks_like_windows_hook_command, hook_command_paths_rewrite_to_target_hook_dir); 1 external calls (format!).


##### `external_agent_doc_file_name`  (lines 1372–1374)

```
fn external_agent_doc_file_name() -> String
```

**Purpose**: Returns the external-agent documentation filename that should be renamed during migration.

**Data flow**: It uses the configured source agent name and returns a Markdown filename such as claude.md.

**Call relations**: rewrite_external_agent_terms calls this before replacing that filename with AGENTS.md.

*Call graph*: called by 1 (rewrite_external_agent_terms); 1 external calls (format!).


##### `external_agent_term_variants`  (lines 1376–1384)

```
fn external_agent_term_variants() -> [String; 5]
```

**Purpose**: Lists common spelling variants of the external agent’s name that should become Codex in migrated text.

**Data flow**: It builds several strings such as space-separated, dash-separated, underscore-separated, joined, and plain forms of the source agent name.

**Call relations**: rewrite_external_agent_terms loops through these variants to clean up migrated descriptions and instructions.

*Call graph*: called by 1 (rewrite_external_agent_terms); 1 external calls (format!).


##### `tests::source_path`  (lines 1391–1395)

```
fn source_path(relative_path: &str) -> PathBuf
```

**Purpose**: Builds a test path under a fake repository’s external-agent config directory.

**Data flow**: It receives a relative path and returns /repo/.claude plus that relative path.

**Call relations**: Command and subagent tests use this helper so their fixture paths look like real source files.

*Call graph*: calls 1 internal fn (external_agent_config_dir); 1 external calls (new).


##### `tests::source_hook_command`  (lines 1397–1402)

```
fn source_hook_command(script_name: &str) -> String
```

**Purpose**: Builds a sample Unix-style hook command pointing at the external-agent hooks directory.

**Data flow**: It receives a script name and returns a command such as python3 .claude/hooks/script.

**Call relations**: Hook migration tests use this to create realistic source commands that should be rewritten.

*Call graph*: 1 external calls (format!).


##### `tests::source_hook_command_with_project_dir`  (lines 1404–1410)

```
fn source_hook_command_with_project_dir(script_name: &str) -> String
```

**Purpose**: Builds a sample hook command that uses the external-agent project-directory environment variable.

**Data flow**: It receives a script name and returns a command containing the project directory variable plus the external-agent hooks path.

**Call relations**: Hook path rewrite tests use this to verify project-relative source paths are rewritten correctly.

*Call graph*: 1 external calls (format!).


##### `tests::migrated_hook_command`  (lines 1412–1414)

```
fn migrated_hook_command(script_name: &str) -> String
```

**Purpose**: Builds the expected migrated hook command for tests.

**Data flow**: It receives a script name and returns the quoted Codex hook command expected after rewriting.

**Call relations**: Hook migration tests compare actual rewritten commands against this helper’s output.

*Call graph*: 1 external calls (migrated_quoted_hook_command).


##### `tests::migrated_quoted_hook_command`  (lines 1416–1424)

```
fn migrated_quoted_hook_command(script_name: &str) -> String
```

**Purpose**: Builds the exact expected command text for a migrated hook script path.

**Data flow**: It receives a script name, joins it under /repo/.codex/hooks, shell-quotes the path, and prefixes it with python3.

**Call relations**: tests::migrated_hook_command and hook rewrite tests use this to avoid repeating expected string construction.

*Call graph*: 2 external calls (new, format!).


##### `tests::env_placeholder_accepts_defaults`  (lines 1427–1432)

```
fn env_placeholder_accepts_defaults()
```

**Purpose**: Checks that environment placeholders with default values are still recognized.

**Data flow**: It passes ${TOKEN:-fallback} into the parser and expects TOKEN as the extracted variable name.

**Call relations**: This protects parse_env_placeholder behavior used by MCP environment and header migration.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mcp_migration_skips_placeholder_args`  (lines 1435–1452)

```
fn mcp_migration_skips_placeholder_args()
```

**Purpose**: Verifies MCP command arguments with unsafe environment placeholders are skipped.

**Data flow**: It writes a temporary .mcp.json with an argument using ${DATABASE_URL}, runs MCP migration, and expects an empty TOML table.

**Call relations**: This test guards the safety check inside mcp_server_toml_table.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::mcp_migration_prefers_command_transport_for_mixed_server_config`  (lines 1455–1495)

```
fn mcp_migration_prefers_command_transport_for_mixed_server_config()
```

**Purpose**: Verifies a server with both command and URL fields is migrated as a command server when that is valid.

**Data flow**: It writes a mixed MCP server config, runs migration, and compares the output to TOML containing command and args.

**Call relations**: This test protects build_mcp_config_from_external and mcp_server_toml_table conversion choices.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::mcp_migration_skips_unsupported_transports`  (lines 1498–1530)

```
fn mcp_migration_skips_unsupported_transports()
```

**Purpose**: Checks that unsupported MCP transport types are skipped while supported URL servers still migrate.

**Data flow**: It creates one unsupported SSE server and one supported URL server with a bearer token environment variable, then expects only the supported server in TOML.

**Call relations**: This test covers transport filtering and header conversion in mcp_server_toml_table and append_header_config.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::mcp_migration_reads_matching_project_entries_from_repo_external_project_config`  (lines 1533–1578)

```
fn mcp_migration_reads_matching_project_entries_from_repo_external_project_config()
```

**Purpose**: Verifies project-specific MCP entries in the repository config are read only for the matching project.

**Data flow**: It creates two fake project directories, writes project-specific server entries for both, runs migration for one project, and expects only matching plus top-level servers.

**Call relations**: This test protects read_external_mcp_servers and project_path_matches_source_root.

*Call graph*: calls 1 internal fn (external_agent_project_config_file); 5 external calls (assert_eq!, create_dir_all, write, json!, new).


##### `tests::mcp_migration_reads_matching_project_entries_from_home_external_project_config`  (lines 1581–1617)

```
fn mcp_migration_reads_matching_project_entries_from_home_external_project_config()
```

**Purpose**: Verifies MCP project entries can also be read from the external-agent home-level config.

**Data flow**: It creates a fake project and home config, writes a matching project server, runs migration with external-agent home, and expects that server in TOML.

**Call relations**: This test covers read_external_mcp_servers calling append_external_agent_project_mcp_servers.

*Call graph*: calls 2 internal fn (external_agent_config_dir, external_agent_project_config_file); 5 external calls (assert_eq!, create_dir_all, write, json!, new).


##### `tests::mcp_migration_preserves_repo_servers_over_home_project_entries`  (lines 1620–1670)

```
fn mcp_migration_preserves_repo_servers_over_home_project_entries()
```

**Purpose**: Checks that repository MCP server definitions win over home-level definitions with the same name.

**Data flow**: It writes one server in the repo and a same-named server plus another server in home config, runs migration, and expects the repo version to remain.

**Call relations**: This test protects the PreserveExisting merge behavior used for home-level MCP entries.

*Call graph*: calls 2 internal fn (external_agent_config_dir, external_agent_project_config_file); 5 external calls (assert_eq!, create_dir_all, write, json!, new).


##### `tests::mcp_migration_skips_disabled_servers`  (lines 1673–1706)

```
fn mcp_migration_skips_disabled_servers()
```

**Purpose**: Verifies disabled MCP servers and servers not in an enabled allow-list are skipped.

**Data flow**: It writes enabled, disabled, and unlisted servers, supplies settings with enabled and disabled lists, and expects only the allowed server to migrate.

**Call relations**: This test guards mcp_server_is_disabled and its use inside MCP conversion.

*Call graph*: 4 external calls (assert_eq!, write, json!, new).


##### `tests::command_skill_names_include_nested_paths`  (lines 1709–1714)

```
fn command_skill_names_include_nested_paths()
```

**Purpose**: Checks that nested command paths become skill names that include their folder structure.

**Data flow**: It builds a source root and nested command file path, generates the skill name, and expects source-command-pr-review.

**Call relations**: This protects command_source_name and command_skill_name behavior.

*Call graph*: 2 external calls (assert_eq!, source_path).


##### `tests::command_skill_names_must_fit_codex_skill_loader_limit`  (lines 1717–1723)

```
fn command_skill_names_must_fit_codex_skill_loader_limit()
```

**Purpose**: Verifies overly long generated skill names are rejected.

**Data flow**: It builds a deeply nested command path, parses a minimal valid document, and expects command_skill_name_if_supported to return nothing.

**Call relations**: This test protects the name length limit in command migration.

*Call graph*: calls 1 internal fn (parse_document_content); 2 external calls (assert!, source_path).


##### `tests::commands_with_provider_runtime_expansion_are_skipped`  (lines 1726–1734)

```
fn commands_with_provider_runtime_expansion_are_skipped()
```

**Purpose**: Checks that command templates using external-agent runtime expansion features are not imported.

**Data flow**: It parses a command containing $ARGUMENTS and an @file token, then expects the support check to reject it.

**Call relations**: This test guards has_unsupported_command_template_features through command_skill_name_if_supported.

*Call graph*: calls 1 internal fn (parse_document_content); 2 external calls (assert!, source_path).


##### `tests::commands_without_description_are_skipped`  (lines 1737–1743)

```
fn commands_without_description_are_skipped()
```

**Purpose**: Verifies command files without a description are not converted into skills.

**Data flow**: It parses a README-like document with no frontmatter description and expects the command support check to return nothing.

**Call relations**: This test protects command_skill_description and README skipping rules.

*Call graph*: calls 1 internal fn (parse_document_content); 2 external calls (assert!, source_path).


##### `tests::command_slug_collisions_are_skipped`  (lines 1746–1765)

```
fn command_slug_collisions_are_skipped()
```

**Purpose**: Checks that two command files producing the same skill name are both skipped.

**Data flow**: It writes two command files whose names slugify to the same value, asks for unique supported sources, and expects none.

**Call relations**: This protects unique_supported_command_sources so migration does not choose an arbitrary winner for a name collision.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, new).


##### `tests::subagent_accepts_yaml_block_lists_by_ignoring_unsupported_fields`  (lines 1768–1774)

```
fn subagent_accepts_yaml_block_lists_by_ignoring_unsupported_fields()
```

**Purpose**: Verifies subagent migration ignores complex frontmatter fields it does not need.

**Data flow**: It parses an agent document with list fields such as tools and skills, then checks required metadata is still accepted.

**Call relations**: This test protects parse_frontmatter and agent_metadata from being too strict.

*Call graph*: calls 1 internal fn (parse_document_content); 1 external calls (assert!).


##### `tests::subagent_requires_minimum_codex_agent_fields`  (lines 1777–1785)

```
fn subagent_requires_minimum_codex_agent_fields()
```

**Purpose**: Checks that subagents need both a description and non-empty body instructions.

**Data flow**: It parses one document missing a description and one missing a body, then expects both to be rejected.

**Call relations**: This test guards the validation rules in agent_metadata.

*Call graph*: calls 1 internal fn (parse_document_content); 1 external calls (assert!).


##### `tests::subagent_preserves_default_model_when_source_model_is_present`  (lines 1788–1808)

```
fn subagent_preserves_default_model_when_source_model_is_present()
```

**Purpose**: Verifies source model fields are not copied into Codex subagent TOML.

**Data flow**: It parses a subagent with a source model and effort, extracts metadata, renders TOML, and compares it to output that includes reasoning effort but no model.

**Call relations**: This protects agent_metadata and render_agent_toml so migration does not pin Codex to an external-agent model name.

*Call graph*: calls 3 internal fn (agent_metadata, parse_document_content, render_agent_toml); 2 external calls (assert_eq!, from_str).


##### `tests::subagent_target_preserves_dotted_file_stem`  (lines 1811–1819)

```
fn subagent_target_preserves_dotted_file_stem()
```

**Purpose**: Checks that source agent filenames with dots keep those dots in the target TOML filename.

**Data flow**: It builds a source path like security.audit.md and expects the target path security.audit.toml.

**Call relations**: This test protects subagent_target_file naming behavior.

*Call graph*: 3 external calls (new, assert_eq!, source_path).


##### `tests::frontmatter_accepts_crlf_delimiters`  (lines 1822–1845)

```
fn frontmatter_accepts_crlf_delimiters()
```

**Purpose**: Verifies Markdown frontmatter parsing works with Windows-style line endings.

**Data flow**: It parses content using CRLF newlines and checks the parsed name, description, and body.

**Call relations**: This test protects frontmatter_end and parse_document_content.

*Call graph*: calls 1 internal fn (parse_document_content); 1 external calls (assert_eq!).


##### `tests::hook_migration_ignores_unsupported_handlers`  (lines 1848–1903)

```
fn hook_migration_ignores_unsupported_handlers()
```

**Purpose**: Checks that hook migration skips hook groups or handlers Codex cannot represent.

**Data flow**: It builds settings with conditional hooks, HTTP hooks, prompt hooks, and one supported command hook, then expects only the supported command hook in the output.

**Call relations**: This test calls append_convertible_hook_groups directly to guard its filtering rules.

*Call graph*: calls 1 internal fn (append_convertible_hook_groups); 4 external calls (new, assert_eq!, new, json!).


##### `tests::hook_migration_honors_disable_all_hooks`  (lines 1906–1926)

```
fn hook_migration_honors_disable_all_hooks()
```

**Purpose**: Verifies disableAllHooks prevents hook migration.

**Data flow**: It writes settings with disableAllHooks set to true and a hook definition, runs hook_migration, and expects an empty map.

**Call relations**: This protects hook_migration’s global disable behavior.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::hook_migration_honors_settings_local_disable_override`  (lines 1929–1979)

```
fn hook_migration_honors_settings_local_disable_override()
```

**Purpose**: Checks that settings.local.json can override disableAllHooks from settings.json.

**Data flow**: It writes project settings disabling all hooks and local settings enabling them, runs hook_migration, and expects hooks from both files to appear.

**Call relations**: This protects hook_migration’s order-sensitive handling of settings files.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::hook_command_paths_rewrite_to_target_hook_dir`  (lines 1982–2129)

```
fn hook_command_paths_rewrite_to_target_hook_dir()
```

**Purpose**: Exhaustively checks which hook command paths are rewritten and which are left alone.

**Data flow**: It feeds many command strings into rewrite_hook_command, including quoted paths, project-variable paths, assignments, dynamic suffixes, Windows paths, and plugin paths, then compares each result to the expected string.

**Call relations**: This test protects rewrite_hook_command and its quoted, unquoted, shell-boundary, and Windows-skip helpers.

*Call graph*: calls 1 internal fn (external_agent_project_dir_env_var); 2 external calls (assert_eq!, format!).


##### `tests::hook_script_copy_keeps_existing_target_scripts`  (lines 2132–2149)

```
fn hook_script_copy_keeps_existing_target_scripts()
```

**Purpose**: Verifies hook script copying does not overwrite a user’s existing target script.

**Data flow**: It creates source and target hook files with the same name but different content, copies hooks, and checks the target content is unchanged.

**Call relations**: This test guards copy_hook_scripts and copy_dir_recursive_skip_existing.

*Call graph*: calls 2 internal fn (copy_hook_scripts, external_agent_config_dir); 4 external calls (assert_eq!, create_dir_all, write, new).


##### `tests::hook_migration_drops_negative_timeouts`  (lines 2152–2183)

```
fn hook_migration_drops_negative_timeouts()
```

**Purpose**: Checks that invalid negative hook timeouts are omitted rather than copied.

**Data flow**: It builds a hook with timeout -1, converts it, and expects the migrated hook to contain the command but no timeout field.

**Call relations**: This protects json_u64 behavior as used by append_convertible_hook_groups.

*Call graph*: calls 1 internal fn (append_convertible_hook_groups); 3 external calls (assert_eq!, new, json!).


### `execpolicy-legacy/build.rs`

`orchestration` · `build time`

Rust projects can include a build script, named `build.rs`, that Cargo runs before compiling the actual code. This file uses that hook for one very specific job: it watches the default execution policy file. The policy file is not Rust code, so Cargo would not automatically know that changing it should trigger a rebuild. Without this script, a developer could edit `src/default.policy` and Cargo might incorrectly reuse old build output, leaving the program built with stale assumptions or embedded data. The script solves that by printing a special instruction in the format Cargo understands: `cargo:rerun-if-changed=...`. You can think of it like putting a sticky note on the build process that says, “If this policy document changes, start over.” There is no parsing, validation, or policy logic here. Its only purpose is to connect a non-code file to Cargo’s change tracking so builds stay reliable.

#### Function details

##### `main`  (lines 1–3)

```
fn main()
```

**Purpose**: This is the build script’s entry function. It tells Cargo that `src/default.policy` is an important input, so the package should be rebuilt when that file changes.

**Data flow**: Nothing is passed in by the program itself. When Cargo runs this script, it prints one line of text to standard output. Cargo reads that line as a build instruction, and from then on it watches `src/default.policy` as a file that can invalidate the previous build.

**Call relations**: Cargo calls this function before compiling the package. The function hands its instruction to Cargo by printing it, and Cargo uses that message to decide when this build script and the package need to run again.

*Call graph*: 1 external calls (println!).


### TUI config synchronization and runtime settings
These files keep app and chat-widget settings synchronized with persisted config, resolve service-tier behavior, and apply user-facing runtime policy inside the TUI.

### `tui/src/config_update.rs`

`domain_logic` · `request handling and settings changes`

The TUI lets users change settings while the app is running. Some settings are not supposed to be written straight into `config.toml` by the TUI, because the app server owns the rules for reading, merging, validating, and reloading configuration. This file is the TUI’s small toolkit for speaking that language.

Most helpers here build `ConfigEdit` values. A `ConfigEdit` is like a short instruction note: “at this config path, put this value” or “clear this value.” Other helpers group several notes together for common user actions, such as picking a model, changing the service tier, enabling memories, trusting a project, or toggling a feature.

At the bottom, the file sends those edits to the app server using typed requests. “Typed” means the request and response have known Rust shapes, so the TUI is less likely to send the wrong kind of message. Each request gets a unique id, like a receipt number, so it can be tracked.

An important behavior is that clearing a value is done by writing JSON `null`, not by separately deleting a file entry. Another subtle point is feature toggles: if a feature is normally off by default, turning it off clears the override instead of writing `false`, keeping the config cleaner.

#### Function details

##### `replace_config_value`  (lines 30–36)

```
fn replace_config_value(key_path: impl Into<String>, value: JsonValue) -> ConfigEdit
```

**Purpose**: Builds one config-change instruction that says, “replace the value at this setting path with this new value.” It is the basic building block used by many other helpers in this file.

**Data flow**: It receives a config key path, such as `model` or `features.some_feature`, and a JSON value. It turns the key path into a string, pairs it with the value, marks the merge strategy as replacement, and returns a `ConfigEdit` ready to send to the app server.

**Call relations**: Other parts of the TUI and several helpers in this file call this when they need a precise config write. `clear_config_value`, `trusted_project_edit`, `build_feature_enabled_edit`, and `build_oss_provider_edit` all rely on it to create the final edit object.

*Call graph*: called by 6 (update_feature_flags, handle_event, build_feature_enabled_edit, build_oss_provider_edit, clear_config_value, trusted_project_edit); 1 external calls (into).


##### `clear_config_value`  (lines 38–40)

```
fn clear_config_value(key_path: impl Into<String>) -> ConfigEdit
```

**Purpose**: Builds one config-change instruction that clears a setting. In this system, clearing means writing JSON `null` at that config path.

**Data flow**: It receives a config key path. It passes that path and a JSON null value into `replace_config_value`, then returns the resulting `ConfigEdit`.

**Call relations**: This is used when the TUI wants to remove an override rather than store a new concrete value. Feature flag updates and event handling call it directly, and `build_feature_enabled_edit` uses it when disabling a feature that is already off by default.

*Call graph*: calls 1 internal fn (replace_config_value); called by 3 (update_feature_flags, handle_event, build_feature_enabled_edit).


##### `app_scoped_key_path`  (lines 42–45)

```
fn app_scoped_key_path(app_id: &str, key_path: &str) -> String
```

**Purpose**: Builds a config key path for settings that belong to one specific app id. It makes sure the app id is written safely as a JSON-style string inside the path.

**Data flow**: It receives an app id and a setting path inside that app. It quotes the app id using JSON string formatting, then returns a combined path like `apps."app-id".some.setting`.

**Call relations**: This helper prepares paths for callers that need app-specific config keys. It does not send anything itself; it only returns the correctly shaped string for later use in config edits.

*Call graph*: 2 external calls (format!, String).


##### `format_config_error`  (lines 47–49)

```
fn format_config_error(err: &impl Display) -> String
```

**Purpose**: Turns a config-related error into a readable string for display to the user. It uses the error’s full formatted form, which can include helpful context.

**Data flow**: It receives something that can be displayed as text. It formats it into a string and returns that string, without changing any outside state.

**Call relations**: When config writes or trust persistence fail, callers such as feature flag updating, event handling, and trust-saving code use this to present the error consistently in the TUI.

*Call graph*: called by 3 (update_feature_flags, handle_event, persist_selected_trust); 1 external calls (format!).


##### `trusted_project_edit`  (lines 51–59)

```
fn trusted_project_edit(project_path: &Path) -> ConfigEdit
```

**Purpose**: Builds the config edit that marks a project as trusted. Trusting a project matters because it tells the system that this folder is allowed to run with a higher level of confidence.

**Data flow**: It receives a project path. It turns that path into the project’s config key, escapes characters that would break the config path, builds a path ending in `trust_level`, and returns an edit that writes the value `Trusted` there.

**Call relations**: This is the private helper behind `write_trusted_project`. It creates the single edit, then `write_trusted_project` sends it to the app server through the normal batch write path.

*Call graph*: calls 2 internal fn (project_trust_key, replace_config_value); 2 external calls (format!, json!).


##### `build_model_selection_edits`  (lines 61–78)

```
fn build_model_selection_edits(
    model: &str,
    effort: Option<impl ToString>,
) -> Vec<ConfigEdit>
```

**Purpose**: Builds the config edits needed when the user picks a model and optionally a reasoning effort. Reasoning effort is an extra setting that can be set or cleared alongside the model.

**Data flow**: It receives a model name and an optional effort value. It always creates an edit for `model`; if effort is present it writes that effort, and if effort is absent it clears `model_reasoning_effort`. It returns both edits as a list.

**Call relations**: The TUI event handler calls this when the user changes model-related settings. The returned edits are later handed to `write_config_batch` so the app server can store and reload them.

*Call graph*: called by 1 (handle_event); 1 external calls (vec!).


##### `build_service_tier_selection_edits`  (lines 80–97)

```
fn build_service_tier_selection_edits(service_tier: Option<&str>) -> Vec<ConfigEdit>
```

**Purpose**: Builds the config edit for the selected service tier, such as fast, flex, or the default request value. A service tier is the requested level or style of backend service.

**Data flow**: It receives an optional service tier string. If there is no tier, it returns an edit that clears `service_tier`. If there is a tier, it normalizes known request values like fast and flex into the config spelling, then returns an edit that writes that value.

**Call relations**: The TUI event handler calls this after the user changes service tier. The resulting edit list is sent through `write_config_batch` with other app-server-owned config changes.

*Call graph*: called by 1 (handle_event); 1 external calls (vec!).


##### `build_windows_sandbox_mode_edits`  (lines 100–115)

```
fn build_windows_sandbox_mode_edits(elevated_enabled: bool) -> Vec<ConfigEdit>
```

**Purpose**: Builds the Windows-only config edits for choosing elevated or unelevated sandbox mode. A sandbox is a safety boundary that limits what a process can do.

**Data flow**: It receives whether elevated sandboxing is enabled. It writes `windows.sandbox` to either `elevated` or `unelevated`, then also clears several older or related feature flag keys so they do not conflict with the newer setting. It returns all edits as a list.

**Call relations**: On Windows builds, the TUI event handler calls this when the sandbox mode changes. The edits are then written through the same app server batch update path as other config choices.

*Call graph*: called by 1 (handle_event); 1 external calls (vec!).


##### `build_feature_enabled_edit`  (lines 117–128)

```
fn build_feature_enabled_edit(feature_key: &str, enabled: bool) -> ConfigEdit
```

**Purpose**: Builds the config edit for turning one feature on or off. It keeps the config tidy by clearing unnecessary entries for features that are off by default.

**Data flow**: It receives a feature key and a desired enabled-or-disabled value. It checks the known feature list to see whether that feature defaults to off. If the user is enabling it, or if the feature normally defaults on, it writes an explicit boolean value. If the feature defaults off and the user is disabling it, it clears the config entry instead.

**Call relations**: Feature flag update code calls this once per feature change. This helper chooses whether the next step should be a real replacement edit or a clearing edit, and those edits are later sent with `write_config_batch`.

*Call graph*: calls 2 internal fn (clear_config_value, replace_config_value); called by 1 (update_feature_flags); 2 external calls (format!, json!).


##### `build_memory_settings_edits`  (lines 130–141)

```
fn build_memory_settings_edits(
    use_memories: bool,
    generate_memories: bool,
) -> Vec<ConfigEdit>
```

**Purpose**: Builds the two config edits for memory behavior: whether memories are used and whether new memories are generated. These settings control how the app remembers information across interactions.

**Data flow**: It receives two boolean values. It writes one to `memories.use_memories` and the other to `memories.generate_memories`, then returns both edits in a list.

**Call relations**: Memory settings update code calls this when the user changes memory preferences. The returned edits are passed onward to `write_config_batch` so the app server can save them.

*Call graph*: called by 1 (update_memory_settings); 1 external calls (vec!).


##### `build_oss_provider_edit`  (lines 143–145)

```
fn build_oss_provider_edit(provider: &str) -> ConfigEdit
```

**Purpose**: Builds the config edit for selecting the open-source provider setting. This records which provider name should be used for OSS-related behavior.

**Data flow**: It receives a provider name as text. It wraps that text as a JSON value, creates an edit for the `oss_provider` key, and returns it.

**Call relations**: This is a small convenience wrapper around `replace_config_value`. A caller can use it when building a batch of config edits that will later be sent to the app server.

*Call graph*: calls 1 internal fn (replace_config_value); 1 external calls (json!).


##### `write_config_batch`  (lines 147–164)

```
async fn write_config_batch(
    request_handle: AppServerRequestHandle,
    edits: Vec<ConfigEdit>,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Sends a group of config edits to the app server and asks it to write them. This is the main bridge between the TUI’s setting changes and the server-owned configuration system.

**Data flow**: It receives an app server request handle and a list of edits. It creates a unique request id, wraps the edits in a `ConfigBatchWrite` request, asks the app server to reload user config after writing, waits for the response, and returns either the write response or an error with TUI-specific context.

**Call relations**: Many user actions eventually flow into this function: feature updates, memory updates, event handling, project trust writes, and app startup paths. It hands the prepared edits off to the app server through `request_typed`, which performs the actual communication.

*Call graph*: calls 1 internal fn (request_typed); called by 5 (update_feature_flags, update_memory_settings, handle_event, write_trusted_project, run_ratatui_app); 2 external calls (String, format!).


##### `write_trusted_project`  (lines 166–171)

```
async fn write_trusted_project(
    request_handle: AppServerRequestHandle,
    project_path: &Path,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Marks one project as trusted by writing the appropriate trust config through the app server. It is a focused helper for the project-trust workflow.

**Data flow**: It receives an app server request handle and a project path. It converts the path into a trust-level edit using `trusted_project_edit`, puts that edit into a one-item list, sends it with `write_config_batch`, and returns the server’s write response or an error.

**Call relations**: Trust persistence code calls this after the user chooses to trust a project. This function delegates the edit creation to `trusted_project_edit` and delegates the server write to `write_config_batch`.

*Call graph*: calls 1 internal fn (write_config_batch); called by 1 (persist_selected_trust); 1 external calls (vec!).


##### `read_effective_config`  (lines 173–188)

```
async fn read_effective_config(
    request_handle: AppServerRequestHandle,
    cwd: String,
) -> Result<ConfigReadResponse>
```

**Purpose**: Asks the app server for the effective configuration for a given working directory. “Effective” means the final settings after all config sources and overrides have been combined.

**Data flow**: It receives an app server request handle and a current working directory string. It creates a unique request id, sends a `ConfigRead` request with that directory and without asking for layer-by-layer details, waits for the response, and returns the config response or an error with context.

**Call relations**: Code that needs to check the config after an overridden write calls this. The function does not interpret the config itself; it simply requests the combined result from the app server.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (read_effective_config_after_overridden_write); 2 external calls (String, format!).


##### `write_skill_enabled`  (lines 190–208)

```
async fn write_skill_enabled(
    request_handle: AppServerRequestHandle,
    path: AbsolutePathBuf,
    enabled: bool,
) -> Result<()>
```

**Purpose**: Enables or disables a skill in the skills configuration through the app server. A skill is identified here by its filesystem path.

**Data flow**: It receives an app server request handle, an absolute path to the skill, and the desired enabled state. It creates a unique request id, sends a `SkillsConfigWrite` request containing the path and enabled value, waits for the server response, ignores the response body after confirming success, and returns `Ok(())` or an error.

**Call relations**: The TUI event handler calls this when the user toggles a skill. Like the config write helpers, it uses `request_typed` so the app server owns the actual write and validation.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (handle_event); 2 external calls (String, format!).


### `tui/src/app/config_persistence.rs`

`orchestration` · `cross-cutting during config reloads, settings changes, thread transitions, and tests`

The app has several copies of “what the settings are”: the durable config file on disk, the main App config in memory, the ChatWidget’s session-facing copy, and sometimes the active Codex thread’s turn context. This file is the glue that keeps those copies from drifting apart. Without it, a user could change a permission mode or feature flag and see the UI update while the next model turn still uses old rules, or the disk file could change while the running app keeps stale settings.

The file rebuilds full Config objects when the current working directory or permission profile changes. It writes user-facing settings through the app server, then updates memory only after the write succeeds. If a higher-priority config layer overrides the saved value, it reads back the effective config and adjusts the UI to match reality. This is like writing a note to a shared whiteboard, then checking whether a manager’s pinned rule overrode it.

It also carries runtime-only overrides forward across config reloads, sends turn-context updates to the active Codex session, and shows helpful error or info messages in the chat. Windows-only helpers do the same for sandbox settings. The tests cover these synchronization edges so thread transitions, broken config files, cloud requirements, and UI-only choices behave predictly.

#### Function details

##### `build_config_on_runtime_worker`  (lines 17–26)

```
async fn build_config_on_runtime_worker(
    builder: ConfigBuilder,
    error_context: String,
) -> Result<Config>
```

**Purpose**: Builds a Config on a Tokio worker task so config loading does not block the main async flow. It also turns task failures into clear errors and rethrows panics instead of hiding them.

**Data flow**: It receives a ConfigBuilder and a human-readable error context. It runs the builder’s async build work in a spawned task, then returns the completed Config or an error decorated with the context.

**Call relations**: Both App::rebuild_config_for_cwd and App::rebuild_config_for_permission_profile use this helper after preparing the right builder inputs. It is the common doorway from app state into a fresh Config.

*Call graph*: calls 1 internal fn (build); called by 2 (rebuild_config_for_cwd, rebuild_config_for_permission_profile); 2 external calls (resume_unwind, spawn).


##### `App::rebuild_config_for_cwd`  (lines 29–44)

```
async fn rebuild_config_for_cwd(&self, cwd: PathBuf) -> Result<Config>
```

**Purpose**: Rebuilds the app configuration as if the app were operating from a specific working directory. This matters because project-local config can depend on where the current thread is rooted.

**Data flow**: It takes a target directory, copies the app’s existing override settings, replaces the override current directory, and builds a new Config using the same Codex home, CLI overrides, loader overrides, and cloud config bundle. It returns the fresh Config or a contextual error.

**Call relations**: It hands the actual build to build_config_on_runtime_worker. App::refresh_in_memory_config_from_disk uses it for live reloads, and App::rebuild_config_for_resume_or_fallback uses it when resuming a session.

*Call graph*: calls 1 internal fn (build_config_on_runtime_worker); called by 2 (rebuild_config_for_resume_or_fallback, refresh_in_memory_config_from_disk); 4 external calls (clone, display, default, format!).


##### `App::rebuild_config_for_permission_profile`  (lines 46–66)

```
async fn rebuild_config_for_permission_profile(
        &self,
        profile_id: &str,
    ) -> Result<Config>
```

**Purpose**: Rebuilds configuration with a named permission profile selected. This lets the app resolve what a profile really means before applying it to the live session.

**Data flow**: It takes a profile id, starts from the current chat widget directory, clears sandbox and permission overrides that would interfere, sets the requested default permissions, and builds a new Config. The result includes the resolved permission profile, active profile, and network settings.

**Call relations**: It delegates the expensive build to build_config_on_runtime_worker. App::apply_permission_profile_selection uses it for normal permission changes, and the Windows setup path uses it when a chosen profile must be resolved.

*Call graph*: calls 1 internal fn (build_config_on_runtime_worker); called by 2 (apply_permission_profile_selection, windows_setup_permissions); 2 external calls (default, format!).


##### `App::windows_setup_permissions`  (lines 69–89)

```
async fn windows_setup_permissions(
        &self,
        preset: &ApprovalPreset,
        profile_selection: Option<&PermissionProfileSelection>,
    ) -> Result<WindowsSetupPermissions>
```

**Purpose**: Prepares Windows permission information for setup flows. It either resolves a selected permission profile or falls back to a preset’s built-in permission profile.

**Data flow**: It receives a Windows approval preset and an optional profile selection. If a selection exists, it rebuilds config for that profile and returns the resolved profile plus workspace roots; otherwise it returns the preset profile plus the current config’s workspace roots.

**Call relations**: When a profile is selected, it calls App::rebuild_config_for_permission_profile. This is Windows-only support code for permission setup before the sandbox or approval state is applied.

*Call graph*: calls 1 internal fn (rebuild_config_for_permission_profile).


##### `App::apply_permission_profile_selection`  (lines 91–206)

```
async fn apply_permission_profile_selection(
        &mut self,
        selection: PermissionProfileSelection,
    ) -> bool
```

**Purpose**: Applies a user’s chosen permission profile to the running app, the chat widget, and the active Codex turn context. It makes a permissions menu choice take effect immediately, not just in a future config reload.

**Data flow**: It receives a selection containing a profile id, optional approval policy, optional reviewer, and display label. It resolves the profile through a rebuilt Config, updates the app config, patches the chat widget, stores runtime overrides, syncs cached session settings, sends an override command to Codex, and adds a history message. It returns true on success and false after showing an error.

**Call relations**: It calls App::rebuild_config_for_permission_profile first, then uses App::try_set_approval_policy_on_config if needed. It sends the final permission state through AppCommand::override_turn_context and records the visible update in history.

*Call graph*: calls 4 internal fn (from_session_snapshot, from_config, rebuild_config_for_permission_profile, try_set_approval_policy_on_config); 7 external calls (new, override_turn_context, CodexOp, InsertHistoryCell, format!, new_info_event, warn!).


##### `App::refresh_in_memory_config_from_disk`  (lines 208–216)

```
async fn refresh_in_memory_config_from_disk(&mut self) -> Result<()>
```

**Purpose**: Reloads the app’s in-memory Config from the saved configuration files. This keeps the running TUI aligned with edits made on disk.

**Data flow**: It reads the current directory from the chat widget, rebuilds Config for that directory, reapplies runtime-only policy overrides, replaces self.config, and refreshes plugin mention settings in the chat widget. It returns success or the reload error.

**Call relations**: It calls App::rebuild_config_for_cwd and then App::apply_runtime_policy_overrides. App::refresh_in_memory_config_from_disk_best_effort wraps it when failure should not stop the user flow.

*Call graph*: calls 2 internal fn (apply_runtime_policy_overrides, rebuild_config_for_cwd); called by 1 (refresh_in_memory_config_from_disk_best_effort).


##### `App::refresh_in_memory_config_from_disk_best_effort`  (lines 218–226)

```
async fn refresh_in_memory_config_from_disk_best_effort(&mut self, action: &str)
```

**Purpose**: Tries to reload config from disk but deliberately keeps going if reload fails. This is used before thread changes where a broken config file should not trap the user.

**Data flow**: It receives an action label for logging. It calls the strict reload method; on error it logs a warning and leaves the existing in-memory config untouched.

**Call relations**: It is a forgiving wrapper around App::refresh_in_memory_config_from_disk. Callers can use it before transitions like starting or switching threads without risking a hard failure.

*Call graph*: calls 1 internal fn (refresh_in_memory_config_from_disk); 1 external calls (warn!).


##### `App::read_effective_config_after_overridden_write`  (lines 228–248)

```
async fn read_effective_config_after_overridden_write(
        &mut self,
        app_server: &mut AppServerSession,
        setting: &str,
    ) -> Option<ConfigReadResponse>
```

**Purpose**: Reads back the effective configuration after a saved write did not actually win. “Effective” means the final settings after all config layers, including higher-priority managed settings, are applied.

**Data flow**: It uses the current chat widget directory and the app server request handle to ask for the effective config. It returns that response if available; if the read fails, it logs a warning, tells the user the saved setting could not be refreshed, and returns None.

**Call relations**: Feature flag, memory, and Windows sandbox update paths call this after an overridden write. The returned response feeds synchronization helpers that make the UI match the real effective settings.

*Call graph*: calls 2 internal fn (request_handle, read_effective_config); called by 3 (sync_windows_sandbox_after_overridden_write, update_feature_flags, update_memory_settings); 2 external calls (format!, warn!).


##### `App::rebuild_config_for_resume_or_fallback`  (lines 250–271)

```
async fn rebuild_config_for_resume_or_fallback(
        &mut self,
        current_cwd: &Path,
        resume_cwd: PathBuf,
    ) -> Result<Config>
```

**Purpose**: Rebuilds configuration for a resumed session, with a safe fallback when the resumed session is in the same directory. This avoids failing resume just because the current config file became broken.

**Data flow**: It receives the current directory and the resume directory. It tries to rebuild config for the resume directory; if that fails and the directories differ, it returns the error, but if they are the same it logs a warning and returns the current in-memory config clone.

**Call relations**: It calls App::rebuild_config_for_cwd to do the real rebuild and uses session_resume::cwds_differ to decide whether fallback is safe. It protects same-directory resume flows from unnecessary breakage.

*Call graph*: calls 2 internal fn (rebuild_config_for_cwd, cwds_differ); 3 external calls (clone, display, warn!).


##### `App::apply_runtime_policy_overrides`  (lines 273–302)

```
fn apply_runtime_policy_overrides(&mut self, config: &mut Config)
```

**Purpose**: Carries temporary runtime permission choices into a freshly reloaded Config. This prevents a disk reload from undoing permissions the user changed during the current session.

**Data flow**: It receives a mutable Config, checks stored runtime approval-policy and permission-profile overrides, and writes them into that Config. If applying an override fails, it logs and shows an error message without crashing.

**Call relations**: App::refresh_in_memory_config_from_disk calls this immediately after rebuilding from disk. It preserves choices made by flows such as App::apply_permission_profile_selection and feature toggles.

*Call graph*: calls 1 internal fn (from_session_snapshot); called by 1 (refresh_in_memory_config_from_disk); 2 external calls (format!, warn!).


##### `App::set_approvals_reviewer_in_app_and_widget`  (lines 304–307)

```
fn set_approvals_reviewer_in_app_and_widget(&mut self, reviewer: ApprovalsReviewer)
```

**Purpose**: Sets who reviews approvals in both the app config and the chat widget copy. It is a small helper to avoid updating one copy and forgetting the other.

**Data flow**: It receives an ApprovalsReviewer value, stores it in self.config, and sends the same value to the chat widget. It has no separate return value.

**Call relations**: App::update_feature_flags and App::sync_feature_state_from_effective_config use it when reviewer state changes. It keeps the UI and app memory synchronized.

*Call graph*: called by 2 (sync_feature_state_from_effective_config, update_feature_flags).


##### `App::try_set_approval_policy_on_config`  (lines 309–324)

```
fn try_set_approval_policy_on_config(
        &mut self,
        config: &mut Config,
        policy: AskForApproval,
        user_message_prefix: &str,
        log_message: &str,
    ) -> bool
```

**Purpose**: Attempts to set an approval policy on a Config and reports a user-friendly error if the policy is not allowed. An approval policy controls when Codex must ask the user before doing something.

**Data flow**: It receives a mutable Config, a requested policy, and message text for the user and logs. It converts the policy to the core form and writes it into the config; success returns true, failure logs, shows an error, and returns false.

**Call relations**: Permission-profile selection and feature-flag updates call this before committing staged settings. It acts as the validation gate for approval policy changes.

*Call graph*: calls 1 internal fn (to_core); called by 2 (apply_permission_profile_selection, update_feature_flags); 2 external calls (format!, warn!).


##### `App::try_set_builtin_active_permission_profile_on_config`  (lines 326–361)

```
fn try_set_builtin_active_permission_profile_on_config(
        &mut self,
        config: &mut Config,
        active_permission_profile: ActivePermissionProfile,
        user_message_prefix: &str,
```

**Purpose**: Sets a built-in active permission profile on a Config, if that active profile is supported. A permission profile is the bundle of sandbox and access rules for Codex.

**Data flow**: It receives a mutable Config, an active profile description, and error-message text. It looks up the matching built-in PermissionProfile, writes a session snapshot into the config, and returns the profile; if unsupported or invalid, it reports the problem and returns None.

**Call relations**: App::update_feature_flags and App::sync_auto_review_runtime_state_from_effective_config use it when the Auto-review mode needs matching sandbox permissions. It centralizes the built-in-profile lookup and error handling.

*Call graph*: calls 1 internal fn (active); called by 2 (sync_auto_review_runtime_state_from_effective_config, update_feature_flags); 2 external calls (format!, warn!).


##### `App::update_feature_flags`  (lines 363–616)

```
async fn update_feature_flags(
        &mut self,
        app_server: &mut AppServerSession,
        updates: Vec<(Feature, bool)>,
    )
```

**Purpose**: Persists experimental feature changes and then updates the running app to match. It also applies companion settings for features that require more than a simple on/off flag, especially Auto-review.

**Data flow**: It receives an app server session and a list of feature enable/disable updates. It stages changes in a cloned Config, builds config-file edits, writes them through the app server, handles overridden writes by reading effective config, and on success updates self.config, the chat widget, runtime permission overrides, active thread context, Windows sandbox context, and user messages.

**Call relations**: It uses many helpers in this file: App::try_set_approval_policy_on_config, App::try_set_builtin_active_permission_profile_on_config, App::read_effective_config_after_overridden_write, App::sync_feature_state_from_effective_config, App::sync_auto_review_runtime_state_from_effective_config, App::set_approvals_reviewer_in_app_and_widget, App::propagate_windows_sandbox_turn_context, and overridden_write_message. It is the main orchestration point for feature toggle changes.

*Call graph*: calls 18 internal fn (from, from_session_snapshot, from_config, propagate_windows_sandbox_turn_context, read_effective_config_after_overridden_write, set_approvals_reviewer_in_app_and_widget, sync_auto_review_runtime_state_from_effective_config, sync_feature_state_from_effective_config, try_set_approval_policy_on_config, try_set_builtin_active_permission_profile_on_config (+8 more)); 7 external calls (new, with_capacity, override_turn_context, format!, json!, error!, warn!).


##### `App::update_memory_settings`  (lines 618–664)

```
async fn update_memory_settings(
        &mut self,
        app_server: &mut AppServerSession,
        use_memories: bool,
        generate_memories: bool,
    ) -> bool
```

**Purpose**: Saves memory settings and updates the running UI to match. These settings control whether the app uses stored memories and whether it generates new ones.

**Data flow**: It receives desired memory booleans, builds config edits, writes them through the app server, and handles errors or overridden writes. If the write applies normally, it updates self.config.memories and tells the chat widget; it returns true when the app state was updated successfully.

**Call relations**: App::update_memory_settings_with_app_server calls this before updating the current thread’s memory mode. On overridden writes it uses App::read_effective_config_after_overridden_write, App::sync_memory_state_from_effective_config, and overridden_write_message.

*Call graph*: calls 6 internal fn (read_effective_config_after_overridden_write, sync_memory_state_from_effective_config, overridden_write_message, request_handle, build_memory_settings_edits, write_config_batch); called by 1 (update_memory_settings_with_app_server); 3 external calls (format!, error!, warn!).


##### `App::update_memory_settings_with_app_server`  (lines 666–701)

```
async fn update_memory_settings_with_app_server(
        &mut self,
        app_server: &mut AppServerSession,
        use_memories: bool,
        generate_memories: bool,
    )
```

**Purpose**: Updates global memory settings and, if needed, updates the current thread’s memory mode too. This keeps the active conversation consistent with the saved setting.

**Data flow**: It records the previous generate-memories value, calls App::update_memory_settings, and stops if saving failed or the value did not change. If there is a current thread, it sends the matching enabled or disabled mode to the app server and reports any failure.

**Call relations**: It builds on App::update_memory_settings. After the config/UI update succeeds, it hands the thread-specific change to the app server through thread_memory_mode_set.

*Call graph*: calls 2 internal fn (update_memory_settings, thread_memory_mode_set); 2 external calls (format!, error!).


##### `App::reset_memories_with_app_server`  (lines 703–716)

```
async fn reset_memories_with_app_server(
        &mut self,
        app_server: &mut AppServerSession,
    )
```

**Purpose**: Asks the app server to delete local memories and reports the result to the user. This is the reset button for memory data.

**Data flow**: It sends a memory_reset request to the app server. On failure it logs and shows an error; on success it adds an informational chat message saying local memories were reset.

**Call relations**: It does not call other helpers in this file. It is a direct app-server action with user feedback in the chat widget.

*Call graph*: calls 1 internal fn (memory_reset); 2 external calls (format!, error!).


##### `App::reasoning_label`  (lines 718–723)

```
fn reasoning_label(reasoning_effort: Option<&ReasoningEffortConfig>) -> String
```

**Purpose**: Turns an optional reasoning-effort setting into text suitable for display. Missing or explicitly none becomes “default.”

**Data flow**: It receives an optional ReasoningEffortConfig reference. It returns “default” for no special effort, otherwise the effort’s string name.

**Call relations**: This is a formatting helper for reasoning settings. It stands alone and is used where the app needs a human-readable effort label.


##### `App::reasoning_label_for`  (lines 725–730)

```
fn reasoning_label_for(
        model: &str,
        reasoning_effort: Option<&ReasoningEffortConfig>,
    ) -> Option<String>
```

**Purpose**: Returns a display label for reasoning effort when the selected model should show one. Auto-selected Codex models hide this label.

**Data flow**: It receives a model name and optional reasoning effort. If the model name starts with “codex-auto-”, it returns None; otherwise it returns the label from App::reasoning_label.

**Call relations**: It wraps App::reasoning_label with model-specific display logic. It is used by UI code that wants to avoid showing misleading effort labels for automatic models.


##### `App::token_usage`  (lines 732–734)

```
fn token_usage(&self) -> crate::token_usage::TokenUsage
```

**Purpose**: Returns the current token usage reported by the chat widget. Tokens are chunks of text counted for model input and output usage.

**Data flow**: It reads token usage from self.chat_widget and returns that value. It does not change app state.

**Call relations**: This is a simple pass-through from App to ChatWidget. Other app-level code can ask App for usage without reaching into the widget directly.


##### `App::on_update_reasoning_effort`  (lines 736–741)

```
fn on_update_reasoning_effort(&mut self, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Updates the live reasoning-effort setting in both app config and chat widget. This makes a user’s effort selection affect new session behavior and visible UI state.

**Data flow**: It receives an optional ReasoningEffortConfig, stores a clone in self.config.model_reasoning_effort, and passes the value to the chat widget. It returns nothing.

**Call relations**: The test tests::update_reasoning_effort_updates_collaboration_mode verifies this dual update. The comment notes this is temporary because config is being used as a state holder.


##### `App::on_update_personality`  (lines 743–746)

```
fn on_update_personality(&mut self, personality: Personality)
```

**Purpose**: Updates the selected assistant personality in the app config and chat widget. A personality changes the style preset the assistant should use.

**Data flow**: It receives a Personality value, stores it as Some(personality) in self.config, and tells the chat widget to use the same personality. It returns nothing.

**Call relations**: This mirrors other small synchronization helpers in this file. It keeps the app’s stored state and the chat-facing copy aligned.


##### `App::sync_tui_theme_selection`  (lines 748–751)

```
fn sync_tui_theme_selection(&mut self, name: String)
```

**Purpose**: Records a selected TUI theme in both the app config and chat widget. This keeps the visual theme choice visible to both persistence and rendering-facing state.

**Data flow**: It receives a theme name string, stores a clone in self.config.tui_theme, and sets the chat widget theme to the same name. It returns nothing.

**Call relations**: Its behavior is covered by tests::sync_tui_theme_selection_updates_chat_widget_config_copy. Runtime theme application is handled separately by App::restore_runtime_theme_from_config.


##### `App::sync_tui_pet_selection`  (lines 754–757)

```
fn sync_tui_pet_selection(&mut self, pet: String)
```

**Purpose**: In tests, records a selected TUI pet in both the app config and chat widget. A TUI pet is a decorative UI choice.

**Data flow**: It receives a pet id string, stores a clone in self.config.tui_pet, and sets the chat widget pet to the same id. It returns nothing.

**Call relations**: This function is compiled only for tests and is checked by tests::sync_tui_pet_selection_updates_chat_widget_config_copy. The production disable path uses App::sync_tui_pet_disabled.


##### `App::sync_tui_pet_disabled`  (lines 759–763)

```
fn sync_tui_pet_disabled(&mut self)
```

**Purpose**: Disables the TUI pet in both the app config and chat widget. It uses the project’s special disabled-pet id.

**Data flow**: It creates the disabled pet id string, stores it in self.config.tui_pet, and passes it to the chat widget. It returns nothing.

**Call relations**: The test tests::sync_tui_pet_disabled_updates_chat_widget_config_copy checks that both copies are updated. This follows the same sync pattern as theme and pet selection.


##### `App::restore_runtime_theme_from_config`  (lines 765–781)

```
fn restore_runtime_theme_from_config(&self)
```

**Purpose**: Applies the syntax-highlighting theme named in config, or falls back to the adaptive default theme. Syntax highlighting is the coloring used for code in the TUI.

**Data flow**: It reads self.config.tui_theme and codex_home. If the named theme can be resolved, it sets that runtime theme; otherwise it resolves the adaptive default theme and sets it if found.

**Call relations**: It calls render/highlight helpers to resolve and set themes. App::sync_tui_theme_selection stores the chosen name; this function turns the stored name into active rendering state.

*Call graph*: calls 3 internal fn (adaptive_default_theme_name, resolve_theme_by_name, set_syntax_theme).


##### `App::personality_label`  (lines 783–789)

```
fn personality_label(personality: Personality) -> &'static str
```

**Purpose**: Turns a Personality enum value into a short display label. This gives the UI stable text for each personality option.

**Data flow**: It receives a Personality and returns one of “None”, “Friendly”, or “Pragmatic”. It does not read or change app state.

**Call relations**: This is a standalone formatting helper. It supports UI display for the personality setting updated by App::on_update_personality.


##### `App::sync_feature_state_from_effective_config`  (lines 791–839)

```
fn sync_feature_state_from_effective_config(
        &mut self,
        effective_config: &ConfigReadResponse,
        feature_updates: &[(Feature, bool)],
    )
```

**Purpose**: Adjusts feature and related approval settings after a config write was overridden. It makes the app reflect the settings that actually took effect, not merely the settings the user tried to save.

**Data flow**: It receives an effective config response and the feature updates that were attempted. It reads each feature’s real enabled value, writes it into self.config and the chat widget, then syncs approval reviewer and approval policy where present. If Guardian Approval ended up disabled, it resets reviewer state to the user.

**Call relations**: App::update_feature_flags calls this after an overridden feature write. It uses feature_enabled_from_effective_config, approvals_reviewer_from_effective_config, approval_policy_from_effective_config, and App::set_approvals_reviewer_in_app_and_widget.

*Call graph*: calls 4 internal fn (set_approvals_reviewer_in_app_and_widget, approval_policy_from_effective_config, approvals_reviewer_from_effective_config, feature_enabled_from_effective_config); called by 1 (update_feature_flags); 3 external calls (iter, format!, warn!).


##### `App::sync_auto_review_runtime_state_from_effective_config`  (lines 841–911)

```
async fn sync_auto_review_runtime_state_from_effective_config(
        &mut self,
        effective_config: &ConfigReadResponse,
        feature_updates: &[(Feature, bool)],
    )
```

**Purpose**: After an overridden feature write, applies live Auto-review runtime state only if the effective config truly supports it. This prevents the current thread from entering Auto-review when a higher-priority config disabled the needed pieces.

**Data flow**: It checks that Guardian Approval was part of the attempted update, is effectively enabled, and uses workspace-write sandbox mode. Then it applies the Auto-review built-in permission profile, updates the chat widget, stores a runtime permission override, syncs cached session permissions, and submits a turn-context override command.

**Call relations**: App::update_feature_flags calls it after reading effective config for an overridden write. It relies on sandbox_mode_from_effective_config and App::try_set_builtin_active_permission_profile_on_config, then notifies the active thread through AppCommand::override_turn_context.

*Call graph*: calls 6 internal fn (from, active, from_config, try_set_builtin_active_permission_profile_on_config, sandbox_mode_from_effective_config, op_can_change_pending_replay_state); called by 1 (update_feature_flags); 4 external calls (override_turn_context, iter, format!, warn!).


##### `App::sync_memory_state_from_effective_config`  (lines 913–934)

```
fn sync_memory_state_from_effective_config(
        &mut self,
        effective_config: &ConfigReadResponse,
    ) -> bool
```

**Purpose**: Updates memory settings from an effective config response after a saved memory change was overridden. It keeps the UI honest about what settings are actually active.

**Data flow**: It reads the memories section from the effective config. If present, it uses provided values or falls back to current values, writes them into self.config.memories, updates the chat widget, and returns true; if missing, it logs a warning and returns false.

**Call relations**: App::update_memory_settings calls this when the app server reports an overridden memory write. It uses memories_from_effective_config to decode the relevant section.

*Call graph*: calls 1 internal fn (memories_from_effective_config); called by 1 (update_memory_settings); 1 external calls (warn!).


##### `App::sync_windows_sandbox_after_overridden_write`  (lines 937–962)

```
async fn sync_windows_sandbox_after_overridden_write(
        &mut self,
        app_server: &mut AppServerSession,
        write_response: &ConfigWriteResponse,
    )
```

**Purpose**: On Windows, updates the live sandbox mode after a sandbox config write was overridden. It reports the override and then makes the app match the effective config.

**Data flow**: It receives the app server session and write response, extracts a friendly override message, shows it to the user, reads the effective config, pulls out the Windows sandbox mode, stores it in self.config, updates the chat widget, and propagates the turn context.

**Call relations**: It uses overridden_write_message, App::read_effective_config_after_overridden_write, windows_sandbox_mode_from_effective_config, and App::propagate_windows_sandbox_turn_context. It exists only on Windows builds.

*Call graph*: calls 4 internal fn (propagate_windows_sandbox_turn_context, read_effective_config_after_overridden_write, overridden_write_message, windows_sandbox_mode_from_effective_config); 2 external calls (format!, warn!).


##### `App::propagate_windows_sandbox_turn_context`  (lines 964–984)

```
fn propagate_windows_sandbox_turn_context(&self)
```

**Purpose**: On Windows, sends the current Windows sandbox level to the active Codex turn context. This makes sandbox changes affect the running thread immediately.

**Data flow**: It reads the sandbox level from self.config through the Windows sandbox helper, builds an override-turn-context command containing that level, and sends it on the app event channel. On non-Windows builds, the body is inactive.

**Call relations**: App::update_feature_flags and App::sync_windows_sandbox_after_overridden_write call this when Windows sandbox-related settings may have changed. It hands the final value to Codex through AppEvent::CodexOp.

*Call graph*: calls 1 internal fn (level_from_config); called by 2 (sync_windows_sandbox_after_overridden_write, update_feature_flags); 2 external calls (override_turn_context, CodexOp).


##### `overridden_write_message`  (lines 987–993)

```
fn overridden_write_message(write_response: &ConfigWriteResponse) -> &str
```

**Purpose**: Returns a readable explanation for why a config write was saved but did not apply. It provides a default message when the server did not include one.

**Data flow**: It receives a ConfigWriteResponse, checks its overridden metadata, and returns the metadata message if present. Otherwise it returns a generic explanation about a higher-priority config layer.

**Call relations**: Feature flag, memory setting, and Windows sandbox update flows call this when WriteStatus says the write was overridden. The message is shown to the user and logged.

*Call graph*: called by 3 (sync_windows_sandbox_after_overridden_write, update_feature_flags, update_memory_settings).


##### `feature_enabled_from_effective_config`  (lines 995–1008)

```
fn feature_enabled_from_effective_config(
    effective_config: &ConfigReadResponse,
    feature: Feature,
) -> bool
```

**Purpose**: Reads one feature flag’s effective enabled value from a config read response. If the feature is not explicitly listed, it falls back to the feature’s built-in default.

**Data flow**: It receives an effective config and a Feature. It finds the root features table, decodes it, looks up the feature key, and returns that value or the default.

**Call relations**: App::sync_feature_state_from_effective_config calls it for each attempted feature update. It uses features_toml_from_json to decode the JSON-shaped config data.

*Call graph*: called by 1 (sync_feature_state_from_effective_config).


##### `approvals_reviewer_from_effective_config`  (lines 1010–1017)

```
fn approvals_reviewer_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<ApprovalsReviewer>
```

**Purpose**: Extracts the effective approvals reviewer from a config read response, if one was reported. It converts the app-server protocol value into the core app type.

**Data flow**: It receives an effective config response, checks the approvals_reviewer field, maps it to the core type when present, and returns Some or None.

**Call relations**: App::sync_feature_state_from_effective_config uses this after overridden feature writes. The result feeds App::set_approvals_reviewer_in_app_and_widget.

*Call graph*: called by 1 (sync_feature_state_from_effective_config).


##### `approval_policy_from_effective_config`  (lines 1019–1023)

```
fn approval_policy_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<AskForApproval>
```

**Purpose**: Extracts the effective approval policy from a config read response, if present. The approval policy controls when Codex must ask before taking actions.

**Data flow**: It receives an effective config response and returns its approval_policy field as an Option. It does not transform or mutate anything.

**Call relations**: App::sync_feature_state_from_effective_config calls it after overridden writes. If a policy is present, that helper updates both config and chat widget state.

*Call graph*: called by 1 (sync_feature_state_from_effective_config).


##### `sandbox_mode_from_effective_config`  (lines 1025–1029)

```
fn sandbox_mode_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<AppServerSandboxMode>
```

**Purpose**: Extracts the effective general sandbox mode from a config read response. Sandbox mode describes how restricted Codex is when touching the workspace.

**Data flow**: It receives an effective config response and returns the sandbox_mode field as an Option. It does not change state.

**Call relations**: App::sync_auto_review_runtime_state_from_effective_config uses it to confirm that Auto-review’s expected workspace-write sandbox mode is actually effective.

*Call graph*: called by 1 (sync_auto_review_runtime_state_from_effective_config).


##### `memories_from_effective_config`  (lines 1031–1037)

```
fn memories_from_effective_config(effective_config: &ConfigReadResponse) -> Option<MemoriesToml>
```

**Purpose**: Decodes the memories section from an effective config response. This section contains settings for using and generating memories.

**Data flow**: It receives the effective config, looks in the additional config data for “memories”, tries to deserialize that JSON value into MemoriesToml, and returns Some on success or None on absence/failure.

**Call relations**: App::sync_memory_state_from_effective_config calls it after an overridden memory write. It is the bridge from generic config data to typed memory settings.

*Call graph*: called by 1 (sync_memory_state_from_effective_config).


##### `features_toml_from_json`  (lines 1039–1041)

```
fn features_toml_from_json(value: &serde_json::Value) -> Option<FeaturesToml>
```

**Purpose**: Decodes a JSON value into the typed feature-flags table used by config code. It returns None if the data is not shaped correctly.

**Data flow**: It receives a JSON value, clones it, and asks serde_json to convert it into FeaturesToml. The result is an Option containing the typed table or nothing.

**Call relations**: feature_enabled_from_effective_config uses it when reading feature flags from the effective config’s additional data.

*Call graph*: 2 external calls (clone, from_value).


##### `windows_sandbox_mode_from_effective_config`  (lines 1044–1053)

```
fn windows_sandbox_mode_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<codex_config::types::WindowsSandboxModeToml>
```

**Purpose**: On Windows, extracts the effective Windows sandbox mode from a config read response. This is separate from the general sandbox mode because Windows has its own sandbox settings table.

**Data flow**: It receives an effective config response, decodes the additional “windows” table, and returns its sandbox field if present. Otherwise it returns None.

**Call relations**: App::sync_windows_sandbox_after_overridden_write calls it after reading effective config. It uses windows_toml_from_json to decode the Windows table.

*Call graph*: called by 1 (sync_windows_sandbox_after_overridden_write).


##### `windows_toml_from_json`  (lines 1056–1058)

```
fn windows_toml_from_json(value: &serde_json::Value) -> Option<WindowsToml>
```

**Purpose**: On Windows, decodes a JSON value into the typed Windows config table. It returns None if decoding fails.

**Data flow**: It receives a JSON value, clones it, and converts it into WindowsToml with serde_json. The output is an optional typed Windows settings object.

**Call relations**: windows_sandbox_mode_from_effective_config uses it to inspect Windows-specific effective config data.

*Call graph*: 2 external calls (clone, from_value).


##### `tests::update_reasoning_effort_updates_collaboration_mode`  (lines 1072–1087)

```
async fn update_reasoning_effort_updates_collaboration_mode()
```

**Purpose**: Checks that changing reasoning effort updates both the chat widget and app config. This protects against UI state and stored app state drifting apart.

**Data flow**: It creates a test app, seeds the chat widget with Medium effort, calls App::on_update_reasoning_effort with High, and asserts both copies now show High.

**Call relations**: It directly exercises App::on_update_reasoning_effort. The test uses make_test_app to build a safe app fixture.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


##### `tests::refresh_in_memory_config_from_disk_loads_latest_apps_state`  (lines 1090–1126)

```
async fn refresh_in_memory_config_from_disk_loads_latest_apps_state() -> Result<()>
```

**Purpose**: Verifies that a disk config edit for app enablement is loaded into the running Config after refresh. This proves refresh is not just reusing stale in-memory data.

**Data flow**: It creates a test app and temporary Codex home, writes app settings through config edits, confirms the old in-memory config does not see them, refreshes from disk, and asserts the new state is present.

**Call relations**: It exercises App::refresh_in_memory_config_from_disk. It uses ConfigEditsBuilder and app_enabled_in_effective_config as test support.

*Call graph*: calls 1 internal fn (make_test_app); 4 external calls (assert_eq!, for_config, tempdir, vec!).


##### `tests::refresh_in_memory_config_from_disk_keeps_cloud_requirements_for_thread_transitions`  (lines 1131–1186)

```
async fn refresh_in_memory_config_from_disk_keeps_cloud_requirements_for_thread_transitions() -> Result<()>
```

**Purpose**: Ensures config reloads keep cloud-managed requirements during thread transitions. This guards enterprise or cloud policy from being accidentally dropped when local config is refreshed.

**Data flow**: It builds a config with a cloud requirement for allowed approval policies, writes a local config marker, verifies the requirement is active, refreshes from disk, and then checks both the local marker and cloud requirement remain effective.

**Call relations**: It exercises App::refresh_in_memory_config_from_disk and the ConfigBuilder setup path. The comments explain this protects flows such as new, clear, fork, side conversations, and session picking.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, loader_with_enterprise_requirement, make_test_app); 5 external calls (assert_eq!, default, format!, write, tempdir).


##### `tests::refresh_in_memory_config_from_disk_best_effort_keeps_current_config_on_error`  (lines 1189–1202)

```
async fn refresh_in_memory_config_from_disk_best_effort_keeps_current_config_on_error() -> Result<()>
```

**Purpose**: Checks that the best-effort reload path does not replace config when the config file is broken. This protects thread transitions from a malformed config file.

**Data flow**: It creates a test app, writes invalid TOML to config.toml, saves the original Config, calls the best-effort refresh, and asserts the original Config is still present.

**Call relations**: It exercises App::refresh_in_memory_config_from_disk_best_effort, which wraps App::refresh_in_memory_config_from_disk without propagating failure.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert_eq!, write, tempdir).


##### `tests::refresh_in_memory_config_from_disk_uses_active_chat_widget_cwd`  (lines 1205–1242)

```
async fn refresh_in_memory_config_from_disk_uses_active_chat_widget_cwd() -> Result<()>
```

**Purpose**: Verifies that config refresh uses the current chat thread’s working directory, not a stale directory from self.config. This matters when the displayed thread has moved to a different project.

**Data flow**: It creates a test app, gives the chat widget a thread session with a new directory, confirms self.config still has the old directory, refreshes from disk, and asserts self.config now matches the widget directory.

**Call relations**: It exercises App::refresh_in_memory_config_from_disk and indirectly App::rebuild_config_for_cwd. It uses a ThreadSessionState fixture to simulate the active chat session.

*Call graph*: calls 3 internal fn (read_only, new, make_test_app); 4 external calls (new, new, assert_eq!, tempdir).


##### `tests::refresh_in_memory_config_from_disk_updates_resize_reflow_config`  (lines 1245–1264)

```
async fn refresh_in_memory_config_from_disk_updates_resize_reflow_config() -> Result<()>
```

**Purpose**: Checks that TUI resize reflow settings written on disk are picked up by a config refresh. Resize reflow controls how terminal content is rewrapped after size changes.

**Data flow**: It creates a test app and temporary config file with a max row limit, refreshes from disk, and asserts the app config contains the new limit.

**Call relations**: It directly tests App::refresh_in_memory_config_from_disk. This protects a specific TUI setting from being missed by reload logic.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert_eq!, write, tempdir).


##### `tests::overridden_disabled_guardian_does_not_apply_auto_review_companions`  (lines 1267–1304)

```
async fn overridden_disabled_guardian_does_not_apply_auto_review_companions() -> Result<()>
```

**Purpose**: Ensures that if effective config disables Guardian Approval, the app does not still apply Auto-review companion settings. This prevents a half-enabled and misleading permissions state.

**Data flow**: It creates a test app, builds an effective config where approval policy and reviewer look Auto-review-like but guardian_approval is false, syncs feature state, and asserts Guardian Approval is disabled and reviewer resets to User while the old approval policy remains.

**Call relations**: It exercises App::sync_feature_state_from_effective_config. The test uses serde_json to build the effective config response.

*Call graph*: calls 1 internal fn (make_test_app); 4 external calls (assert!, assert_eq!, from_value, json!).


##### `tests::rebuild_config_for_resume_or_fallback_uses_current_config_on_same_cwd_error`  (lines 1307–1322)

```
async fn rebuild_config_for_resume_or_fallback_uses_current_config_on_same_cwd_error() -> Result<()>
```

**Purpose**: Verifies that resume falls back to the current config when rebuilding for the same directory fails. This makes same-directory resume robust against a newly broken config file.

**Data flow**: It creates a test app, writes invalid config, saves the current config and current directory, calls App::rebuild_config_for_resume_or_fallback with the same directory, and asserts the returned Config equals the saved one.

**Call relations**: It directly tests the fallback branch in App::rebuild_config_for_resume_or_fallback.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert_eq!, write, tempdir).


##### `tests::rebuild_config_for_resume_or_fallback_errors_when_cwd_changes`  (lines 1325–1340)

```
async fn rebuild_config_for_resume_or_fallback_errors_when_cwd_changes() -> Result<()>
```

**Purpose**: Verifies that resume does not hide config rebuild errors when the resumed directory is different. A different project may need different settings, so falling back would be unsafe.

**Data flow**: It creates a test app, writes invalid config, chooses a different temporary directory as the resume directory, calls App::rebuild_config_for_resume_or_fallback, and asserts the result is an error.

**Call relations**: It tests the error branch in App::rebuild_config_for_resume_or_fallback, including its directory comparison behavior.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert!, write, tempdir).


##### `tests::sync_tui_theme_selection_updates_chat_widget_config_copy`  (lines 1343–1353)

```
async fn sync_tui_theme_selection_updates_chat_widget_config_copy()
```

**Purpose**: Checks that selecting a TUI theme updates both app config and chat widget config copy. This protects against visual preference drift.

**Data flow**: It creates a test app, calls App::sync_tui_theme_selection with “dracula”, and asserts both self.config and chat_widget.config_ref contain that theme name.

**Call relations**: It directly exercises App::sync_tui_theme_selection.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


##### `tests::sync_tui_pet_selection_updates_chat_widget_config_copy`  (lines 1356–1366)

```
async fn sync_tui_pet_selection_updates_chat_widget_config_copy()
```

**Purpose**: Checks that selecting a TUI pet updates both app config and chat widget config copy. This test covers the test-only pet selection helper.

**Data flow**: It creates a test app, calls App::sync_tui_pet_selection with “chefito”, and asserts both config copies contain that pet id.

**Call relations**: It directly exercises App::sync_tui_pet_selection, which is compiled for tests.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


##### `tests::sync_tui_pet_disabled_updates_chat_widget_config_copy`  (lines 1369–1382)

```
async fn sync_tui_pet_disabled_updates_chat_widget_config_copy()
```

**Purpose**: Checks that disabling the TUI pet updates both app config and chat widget config copy. This makes sure the special disabled value is used consistently.

**Data flow**: It creates a test app, calls App::sync_tui_pet_disabled, and asserts both config copies contain the disabled pet id.

**Call relations**: It directly exercises App::sync_tui_pet_disabled.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


### `tui/src/service_tier_resolution.rs`

`domain_logic` · `session setup and model/config refresh`

This file answers a simple but important question: when the app talks to the model service, should it ask for a special service tier such as a faster mode? A service tier is like choosing a lane at a toll booth: some cars can use the express lane, some cannot, and sometimes the driver has already chosen a lane in advance.

The code first looks at the user's configuration. If the user explicitly set a service tier, that choice is considered. There is also a compatibility path for an older “fast default opt out” notice, which can produce the default request value.

Then it checks whether the FastMode feature is enabled. A feature flag is a switch that can turn a behavior on or off. If FastMode is off, this file deliberately returns no tier at all.

If FastMode is on, the code compares the requested model against the known model presets. A model preset describes what a model supports, including which service tiers are allowed and whether it has a default tier. The file avoids sending an unsupported tier. If the user's chosen tier is valid, it is used. If not, the tier is dropped. If the user did not choose one, the model's own default tier may be used, but only if the model says it supports it.

One important detail is that the update sent to the core may fall back to a special default request value for known models. This lets the core receive an explicit instruction even when no specific valid tier was resolved.

#### Function details

##### `configured_service_tier`  (lines 6–11)

```
fn configured_service_tier(config: &Config) -> Option<String>
```

**Purpose**: This function reads the user's configuration and finds the service tier the user appears to have chosen. It also preserves an older setting path by turning a specific opt-out notice into the standard default request value.

**Data flow**: It receives the full configuration. It first checks whether `config.service_tier` already contains a tier string. If so, it returns a copy of that string. If not, it checks whether the old fast-default opt-out flag is set to true; when it is, it returns the standard default request value. If neither source provides a tier, it returns nothing.

**Call relations**: This is the first step used by `effective_service_tier`. It supplies the raw configured choice before that choice is checked against feature flags and model support.

*Call graph*: called by 1 (effective_service_tier).


##### `effective_service_tier`  (lines 13–36)

```
fn effective_service_tier(
    config: &Config,
    model: &str,
    models: &[ModelPreset],
) -> Option<String>
```

**Purpose**: This function decides the actual service tier that should be used for a particular model. It combines three things: whether FastMode is enabled, what the user configured, and what the selected model says it can support.

**Data flow**: It receives the configuration, the selected model name, and the list of known model presets. If FastMode is turned off, it returns nothing immediately. Otherwise, it asks `configured_service_tier` for the user's configured tier. It then looks up the selected model in the presets. If the model is unknown, it returns the configured value as-is. If the model is known, it keeps a configured default request value, keeps a configured tier only when `model_supports_service_tier` says the model supports it, drops unsupported configured tiers, or uses the model's own default tier when there was no configured tier and that default is supported.

**Call relations**: This is the main decision point in the file. It is called when creating state with `new_with_op_target`, when refreshing the effective tier, and by `service_tier_update_for_core` before an update is sent onward. It relies on `configured_service_tier` for the user's starting preference and on `model_supports_service_tier` to avoid choosing a tier the model cannot use.

*Call graph*: calls 2 internal fn (configured_service_tier, model_supports_service_tier); called by 3 (new_with_op_target, refresh_effective_service_tier, service_tier_update_for_core); 1 external calls (iter).


##### `service_tier_update_for_core`  (lines 38–57)

```
fn service_tier_update_for_core(
    config: &Config,
    model: &str,
    models: &[ModelPreset],
) -> Option<Option<String>>
```

**Purpose**: This function prepares the service-tier value that should be sent to the core part of the application. It distinguishes between “do not send an update” and “send an update whose value may be empty or defaulted.”

**Data flow**: It receives the configuration, the selected model name, and the known model presets. If FastMode is off, it returns nothing, meaning no core update is needed. If FastMode is on, it asks `effective_service_tier` for the resolved tier. When a tier is found, it wraps that string in an update result. If no effective tier is found but the model is known, it sends the standard default request value instead. If the model is unknown, it returns nothing.

**Call relations**: This function is used when building session configuration through `session_config_with_effective_service_tier`, and the call graph also records use from a same-named path. It hands the core a clean instruction after `effective_service_tier` has done the detailed decision-making.

*Call graph*: calls 1 internal fn (effective_service_tier); called by 2 (session_config_with_effective_service_tier, service_tier_update_for_core); 1 external calls (iter).


##### `model_supports_service_tier`  (lines 59–64)

```
fn model_supports_service_tier(model: &ModelPreset, service_tier: &str) -> bool
```

**Purpose**: This small helper answers whether a model preset lists a given service tier as supported. It prevents the app from asking a model for a tier it does not advertise.

**Data flow**: It receives one model preset and one service-tier name. It looks through the preset's list of supported tiers and returns true if any tier has the same identifier. Otherwise, it returns false. It does not change anything.

**Call relations**: This helper is called by `effective_service_tier` whenever a configured tier or a model default tier needs to be checked before being used.

*Call graph*: called by 1 (effective_service_tier).


### `tui/src/chatwidget/service_tiers.rs`

`domain_logic` · `cross-cutting during chat UI setup and user tier changes`

A service tier is a choice about how the model should be used, for example a special “fast” tier. This file sits inside `ChatWidget`, the main terminal chat interface, and answers practical questions: What tier is selected? Does this model support that tier? Should the fast-mode status be shown? Can the user toggle it right now?

The file works like a small control panel. First, it reads the user’s configured tier from the app configuration. Then it resolves the “effective” tier, meaning the tier that should actually be used after considering the current model and the model catalog. The model catalog is the list of known models and the tiers each one supports.

When the user changes a tier from the UI, this file updates local state, refreshes model-dependent UI surfaces, sends an event to the core engine so future chat turns use the new tier, and sends another event so the choice can be persisted. It also feeds slash-command options into the bottom pane, so users only see tier commands that make sense for the current model.

An important detail is that the file is conservative. If the model list cannot be read, it falls back to safe defaults, such as no available commands or no tier support, rather than guessing.

#### Function details

##### `ChatWidget::set_service_tier`  (lines 14–18)

```
fn set_service_tier(&mut self, service_tier: Option<String>)
```

**Purpose**: Changes the service tier stored in the chat widget’s configuration. It also refreshes the derived tier and any UI areas that depend on the chosen model or tier.

**Data flow**: It receives an optional tier name. It writes that value into `self.config.service_tier`, recalculates the tier that should actually be used, and then refreshes model-dependent UI surfaces. It does not directly save the choice or notify the core engine; it only updates the widget’s local state.

**Call relations**: This is called by `ChatWidget::set_service_tier_selection` after the user chooses a tier. As part of the update, it calls `ChatWidget::refresh_effective_service_tier` so the widget’s active tier stays consistent with the current model and catalog.

*Call graph*: calls 1 internal fn (refresh_effective_service_tier); called by 1 (set_service_tier_selection).


##### `ChatWidget::current_service_tier`  (lines 20–22)

```
fn current_service_tier(&self) -> Option<&str>
```

**Purpose**: Returns the service tier that is currently effective for the chat widget. Other UI actions use this to decide whether a click should turn a tier on or turn it back to the default.

**Data flow**: It reads `self.effective_service_tier`, converts it from an owned stored string into a borrowed text value if present, and returns that optional text. Nothing is changed.

**Call relations**: This is used by `ChatWidget::toggle_fast_mode_from_ui` and `ChatWidget::toggle_service_tier_from_ui` when they compare the current tier with the tier the user is trying to select.

*Call graph*: called by 2 (toggle_fast_mode_from_ui, toggle_service_tier_from_ui).


##### `ChatWidget::configured_service_tier`  (lines 24–26)

```
fn configured_service_tier(&self) -> Option<String>
```

**Purpose**: Returns the service tier exactly as it is stored in configuration, before any model-specific resolution is applied. This is useful when code needs the saved user preference rather than the final active tier.

**Data flow**: It reads `self.config.service_tier`, clones the optional string, and returns that copy. It does not change the widget.

**Call relations**: No caller is listed in the provided graph, but it serves as a simple accessor for code that needs to inspect the configured service tier.


##### `ChatWidget::service_tier_update_for_core`  (lines 28–34)

```
fn service_tier_update_for_core(&self) -> Option<Option<String>>
```

**Purpose**: Builds the service-tier update that should be sent to the core chat engine. It makes sure the core receives the right value for the current model and available service tiers.

**Data flow**: It reads the app configuration, the current model, and the model catalog. It passes those into the shared service-tier resolution helper, which decides whether there is an update and what value should be sent. The result is an optional update, where the nested optional value represents whether to set a concrete tier or clear it.

**Call relations**: This function delegates the actual decision to the external `service_tier_resolution::service_tier_update_for_core` helper. It acts as the chat widget’s bridge from local UI state to the core engine’s expected update format.

*Call graph*: calls 1 internal fn (service_tier_update_for_core).


##### `ChatWidget::should_show_fast_status`  (lines 36–41)

```
fn should_show_fast_status(&self, model: &str, service_tier: Option<&str>) -> bool
```

**Purpose**: Decides whether the UI should show that fast mode is active. It only says yes when the selected tier is the fast tier, the current model supports it, and the user has a ChatGPT account.

**Data flow**: It receives a model name and an optional service-tier name. It checks whether the tier is present, equals the known fast-tier request value, is supported by the model, and the account allows it. It returns `true` only when all of those conditions are met.

**Call relations**: No direct caller is listed in the graph. It relies on `ChatWidget::model_supports_service_tier` to avoid showing fast status for a model that cannot actually use that tier.


##### `ChatWidget::fast_mode_enabled`  (lines 43–45)

```
fn fast_mode_enabled(&self) -> bool
```

**Purpose**: Checks whether the fast-mode feature is enabled in the app’s feature flags. A feature flag is a switch that lets the app turn a feature on or off without removing the code.

**Data flow**: It reads `self.config.features` and asks whether `Feature::FastMode` is enabled. It returns a simple yes-or-no value and changes nothing.

**Call relations**: This is used by `ChatWidget::can_toggle_fast_mode_from_keybinding` to decide whether the keyboard shortcut should work, and by `ChatWidget::sync_service_tier_commands` to decide whether service-tier commands should be enabled in the bottom pane.

*Call graph*: called by 2 (can_toggle_fast_mode_from_keybinding, sync_service_tier_commands).


##### `ChatWidget::can_toggle_fast_mode_from_keybinding`  (lines 47–52)

```
fn can_toggle_fast_mode_from_keybinding(&self) -> bool
```

**Purpose**: Decides whether the fast-mode keyboard shortcut is allowed right now. It prevents the shortcut from working when fast mode is disabled, unsupported by the current model, a chat turn is already running, or a modal/popup is open.

**Data flow**: It reads the feature flag, checks whether the current model has a fast tier, checks whether a user turn is pending or running, and checks whether the bottom pane is free of popups. It returns `true` only when the UI is in a safe state for toggling.

**Call relations**: It calls `ChatWidget::fast_mode_enabled` first, then `ChatWidget::current_model_fast_service_tier` to confirm there is a fast tier to toggle. It is used as a guard before a keybinding is allowed to trigger a tier change.

*Call graph*: calls 2 internal fn (current_model_fast_service_tier, fast_mode_enabled).


##### `ChatWidget::toggle_fast_mode_from_ui`  (lines 54–64)

```
fn toggle_fast_mode_from_ui(&mut self)
```

**Purpose**: Turns fast mode on or off from the UI. If fast mode is already selected, it switches back to the default tier; otherwise it selects the current model’s fast tier.

**Data flow**: It first looks up the fast tier for the current model. If there is none, it stops. If there is one, it compares that tier with the current effective tier. The output is a new tier choice, either the fast tier’s ID or the default tier value, which is then applied through `set_service_tier_selection`.

**Call relations**: This function calls `ChatWidget::current_model_fast_service_tier` to find the fast option, `ChatWidget::current_service_tier` to see what is active now, and `ChatWidget::set_service_tier_selection` to update local state, notify the core engine, and persist the selection.

*Call graph*: calls 3 internal fn (current_model_fast_service_tier, current_service_tier, set_service_tier_selection).


##### `ChatWidget::toggle_service_tier_from_ui`  (lines 66–73)

```
fn toggle_service_tier_from_ui(&mut self, command: ServiceTierCommand)
```

**Purpose**: Turns a specific service tier on or off from a UI command. Selecting the already-active tier resets the chat back to the default tier.

**Data flow**: It receives a `ServiceTierCommand`, which contains the tier the user chose. It compares that command’s ID with the current effective tier. It then creates the next tier value, either the command’s tier ID or the default tier request value, and applies it.

**Call relations**: This function is the general version of the fast-mode toggle. It calls `ChatWidget::current_service_tier` for comparison and hands the final choice to `ChatWidget::set_service_tier_selection`, which performs the actual update and event sending.

*Call graph*: calls 2 internal fn (current_service_tier, set_service_tier_selection).


##### `ChatWidget::sync_service_tier_commands`  (lines 75–80)

```
fn sync_service_tier_commands(&mut self)
```

**Purpose**: Updates the bottom pane so its service-tier slash commands match the current model and feature settings. This keeps the command list from offering choices that are unavailable.

**Data flow**: It checks whether fast mode is enabled, sends that enabled/disabled state to the bottom pane, then builds the list of tier commands supported by the current model and sends that list to the bottom pane. The bottom pane’s visible command state changes as a result.

**Call relations**: It calls `ChatWidget::fast_mode_enabled` to decide whether tier commands should be usable, and `ChatWidget::current_model_service_tier_commands` to get the concrete commands to display.

*Call graph*: calls 2 internal fn (current_model_service_tier_commands, fast_mode_enabled).


##### `ChatWidget::current_model_service_tier_commands`  (lines 82–104)

```
fn current_model_service_tier_commands(&self) -> Vec<ServiceTierCommand>
```

**Purpose**: Builds the list of service-tier commands that apply to the currently selected model. These commands are what the UI can show to let the user pick a tier.

**Data flow**: It reads the current model name and tries to read the model catalog. If it finds a catalog entry for the current model, it converts each supported service tier into a `ServiceTierCommand` with an ID, lowercase display name, and description. If the catalog cannot be read or the model is missing, it returns an empty list.

**Call relations**: This function feeds `ChatWidget::sync_service_tier_commands`, which updates the bottom pane, and `ChatWidget::current_model_fast_service_tier`, which searches these commands for the fast tier.

*Call graph*: called by 2 (current_model_fast_service_tier, sync_service_tier_commands).


##### `ChatWidget::set_service_tier_selection`  (lines 106–125)

```
fn set_service_tier_selection(&mut self, service_tier: Option<String>)
```

**Purpose**: Applies a user’s service-tier choice everywhere it needs to go. It updates the widget, tells the core chat engine about the new turn context, and asks the app to save the selection.

**Data flow**: It receives an optional tier string. First it updates local chat-widget state through `set_service_tier`. Then it sends an app event containing a core command that overrides only the service-tier part of the turn context. Finally, it sends another app event asking the app to persist the selected tier. The input becomes both live runtime state and saved preference.

**Call relations**: This is called by `ChatWidget::toggle_fast_mode_from_ui` and `ChatWidget::toggle_service_tier_from_ui` after they decide the next tier. It calls `ChatWidget::set_service_tier` for local state, uses the external `AppCommand::override_turn_context` builder to create the core update, and wraps that command in an external `AppEvent::CodexOp` event for delivery.

*Call graph*: calls 1 internal fn (set_service_tier); called by 2 (toggle_fast_mode_from_ui, toggle_service_tier_from_ui); 2 external calls (override_turn_context, CodexOp).


##### `ChatWidget::model_supports_service_tier`  (lines 127–143)

```
fn model_supports_service_tier(&self, model: &str, service_tier: &str) -> bool
```

**Purpose**: Checks whether a particular model supports a particular service tier. This prevents the UI from claiming or selecting a tier that the model catalog does not allow.

**Data flow**: It receives a model name and a service-tier ID. It tries to read the model catalog, finds the matching model entry, and checks whether any of that model’s service tiers has the requested ID. It returns `false` if the catalog cannot be read, the model is not found, or the tier is absent.

**Call relations**: No direct caller is listed in the provided graph, though `ChatWidget::should_show_fast_status` uses this check in the source code to decide whether the fast-status indicator is truthful for the given model.


##### `ChatWidget::current_model_fast_service_tier`  (lines 145–149)

```
fn current_model_fast_service_tier(&self) -> Option<ServiceTierCommand>
```

**Purpose**: Finds the fast service tier for the current model, if that model offers one. This gives the fast-mode toggle a concrete tier ID to select.

**Data flow**: It asks for all service-tier commands for the current model, then searches that list for a command whose name matches the known fast-tier label, ignoring letter case. It returns that command if found, or nothing if the current model has no fast tier.

**Call relations**: It calls `ChatWidget::current_model_service_tier_commands` to get the available tier choices. It is used by `ChatWidget::can_toggle_fast_mode_from_keybinding` to decide whether the shortcut can be enabled, and by `ChatWidget::toggle_fast_mode_from_ui` to know what tier should be selected.

*Call graph*: calls 1 internal fn (current_model_service_tier_commands); called by 2 (can_toggle_fast_mode_from_keybinding, toggle_fast_mode_from_ui).


##### `ChatWidget::refresh_effective_service_tier`  (lines 151–157)

```
fn refresh_effective_service_tier(&mut self)
```

**Purpose**: Recalculates the tier that should actually be active for the current model. This matters because the configured tier may not be valid for every model.

**Data flow**: It reads the configuration, current model, and model catalog. It passes those into the shared service-tier resolution helper, receives the effective tier, and stores it in `self.effective_service_tier`. The widget’s derived active tier is updated.

**Call relations**: This is called by `ChatWidget::set_service_tier` whenever the configured tier changes. It delegates the resolution rules to the external `service_tier_resolution::effective_service_tier` function.

*Call graph*: calls 1 internal fn (effective_service_tier); called by 1 (set_service_tier).


### `tui/src/chatwidget/settings.rs`

`domain_logic` · `main loop and request handling`

The ChatWidget is the main chat screen in the terminal user interface. This file is its settings control panel. It changes the widget's local copy of configuration, then refreshes the visible parts of the screen that depend on that setting. For example, if the model changes, the header, footer status line, terminal title, image-paste availability, and service-tier commands may all need to change together.

A large part of the file is about collaboration modes. A collaboration mode is a preset way for the assistant to work, such as normal mode or Plan mode. The file keeps both a base mode and an active mask, which is like a transparent overlay that can temporarily replace the model, reasoning effort, or instructions. It also decides when to show a Plan-mode nudge, which is a footer hint shown when the user's draft looks planning-related.

The file also listens for thread setting updates from the app server. When a notification matches the current thread, it copies in the server's settings: working folder, model, permissions, approval policy, service tier, personality, and collaboration mode. Then it refreshes the UI so the screen matches reality.

In short, this file prevents settings drift. It makes sure that a change in one place is reflected everywhere the user can see or depend on it.

#### Function details

##### `ChatWidget::set_approval_policy`  (lines 8–19)

```
fn set_approval_policy(&mut self, policy: AskForApproval)
```

**Purpose**: Changes when the chat should ask the user before doing something sensitive, such as running a command. It updates the widget's local configuration and refreshes the status display if the change succeeds.

**Data flow**: It receives a user-facing approval policy, converts it into the core policy format, and tries to store it in the permission settings. On success, the visible status areas are refreshed; on failure, it logs a warning and leaves the UI refresh out.

**Call relations**: This is used during thread settings synchronization by apply_thread_settings, so server-provided approval rules become the rules shown and used in the chat widget.

*Call graph*: calls 1 internal fn (to_core); called by 1 (apply_thread_settings); 1 external calls (warn!).


##### `ChatWidget::set_permission_profile_from_session_snapshot`  (lines 22–31)

```
fn set_permission_profile_from_session_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Replaces the widget's permission profile using a snapshot from an existing session. This is useful when restoring or syncing the exact permission state of a conversation.

**Data flow**: It receives a permission snapshot, asks the permission configuration to apply it, then refreshes status surfaces. It returns success or a constraint error if the snapshot cannot be applied.

**Call relations**: No caller is shown in the provided graph, but it is part of the settings API for copying session permission state into the widget.


##### `ChatWidget::set_permission_profile_with_active_profile`  (lines 33–48)

```
fn set_permission_profile_with_active_profile(
        &mut self,
        profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
    ) -> ConstraintResult<()>
```

**Purpose**: Builds and applies a permission profile from a base profile plus an optional active profile. It lets callers describe permissions in higher-level pieces rather than preparing a full snapshot themselves.

**Data flow**: It receives a permission profile and optional active profile, turns them into a session snapshot, stores that snapshot in the permission configuration, refreshes status surfaces, and returns success or a constraint error.

**Call relations**: It calls from_session_snapshot to build the snapshot. No caller is shown in the provided graph, but it is a convenience path for updating permissions and UI together.

*Call graph*: calls 1 internal fn (from_session_snapshot).


##### `ChatWidget::set_permission_network`  (lines 50–55)

```
fn set_permission_network(
        &mut self,
        network: Option<crate::legacy_core::config::NetworkProxySpec>,
    )
```

**Purpose**: Changes the network proxy rule used by the widget's permission configuration. This controls what network setting the session should use.

**Data flow**: It receives either a network proxy specification or no network setting, then writes that value into the permission configuration. It does not return a value or refresh visible UI.

**Call relations**: No caller is shown in the provided graph. It is a direct setter for the network part of the permission state.


##### `ChatWidget::set_windows_sandbox_mode`  (lines 58–66)

```
fn set_windows_sandbox_mode(&mut self, mode: Option<WindowsSandboxModeToml>)
```

**Purpose**: Sets the Windows sandbox mode in the local configuration. On Windows, it also updates the footer if the sandbox is degraded to a restricted-token level.

**Data flow**: It receives an optional Windows sandbox setting and stores it. On Windows builds, it reads the effective sandbox level from the config and tells the bottom pane whether degraded sandbox status should be shown.

**Call relations**: No caller is shown in the provided graph. It is only meaningful for Windows-specific sandbox behavior.

*Call graph*: 1 external calls (matches!).


##### `ChatWidget::set_feature_enabled`  (lines 69–117)

```
fn set_feature_enabled(&mut self, feature: Feature, enabled: bool) -> bool
```

**Purpose**: Turns a feature flag on or off and updates every visible command or indicator affected by that feature. A feature flag is a switch that enables optional behavior such as plugins, goals, or image mentions.

**Data flow**: It receives a feature and a desired true-or-false state, tries to store that state, then reads back the effective value. Depending on which feature changed, it refreshes service tier, personality, plugins, goals, mentions, idle-sleep prevention, or Windows sandbox UI, and returns the effective enabled value.

**Call relations**: It calls several sync helpers, including sync_personality_command_enabled, sync_plugins_command_enabled, sync_goal_command_enabled, sync_mentions_v2_enabled, and update_collaboration_mode_indicator. Those helpers keep the bottom pane and indicators aligned with feature availability.

*Call graph*: calls 5 internal fn (sync_goal_command_enabled, sync_mentions_v2_enabled, sync_personality_command_enabled, sync_plugins_command_enabled, update_collaboration_mode_indicator); 2 external calls (matches!, warn!).


##### `ChatWidget::set_approvals_reviewer`  (lines 119–122)

```
fn set_approvals_reviewer(&mut self, policy: ApprovalsReviewer)
```

**Purpose**: Changes who or what reviews approval requests. This affects the approval status shown by the widget.

**Data flow**: It receives an approvals reviewer policy, stores it in the configuration, and refreshes status surfaces so the visible state matches the new reviewer setting.

**Call relations**: apply_thread_settings calls this when server thread settings include a reviewer policy, making the local chat screen follow the server's latest approval setup.

*Call graph*: called by 1 (apply_thread_settings).


##### `ChatWidget::set_full_access_warning_acknowledged`  (lines 124–126)

```
fn set_full_access_warning_acknowledged(&mut self, acknowledged: bool)
```

**Purpose**: Records whether the user has acknowledged the full-access warning. This prevents repeatedly showing a warning the user has already accepted.

**Data flow**: It receives a boolean and stores it as the hide-full-access-warning notice setting. It does not return a value.

**Call relations**: No caller is shown in the provided graph. It is part of the notice-dismissal settings used by the wider widget.


##### `ChatWidget::set_world_writable_warning_acknowledged`  (lines 128–130)

```
fn set_world_writable_warning_acknowledged(&mut self, acknowledged: bool)
```

**Purpose**: Records whether the user has acknowledged the warning about a world-writable location. World-writable means other users on the machine may be able to change files there.

**Data flow**: It receives a boolean and stores it as the hide-world-writable-warning notice setting. It does not return a value.

**Call relations**: No caller is shown in the provided graph. It pairs with world_writable_warning_hidden to remember whether the warning should be suppressed.


##### `ChatWidget::world_writable_warning_hidden`  (lines 133–138)

```
fn world_writable_warning_hidden(&self) -> bool
```

**Purpose**: Answers whether the world-writable warning should currently be hidden. If the setting was never stored, it treats the warning as not hidden.

**Data flow**: It reads the optional stored notice flag and converts a missing value into false. It returns a boolean.

**Call relations**: No caller is shown in the provided graph, but this is the read side of the world-writable warning acknowledgement setting.


##### `ChatWidget::set_plan_mode_reasoning_effort`  (lines 145–160)

```
fn set_plan_mode_reasoning_effort(&mut self, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Sets a special reasoning-effort override used only for Plan mode. Reasoning effort is the selected depth or intensity of model reasoning.

**Data flow**: It receives an optional reasoning-effort setting and stores it. If Plan mode is currently active, it immediately updates the active mode mask, either using the override or falling back to the Plan preset, then refreshes model-dependent UI.

**Call relations**: It checks collaboration_modes_enabled, may read the Plan preset through plan_mask, and finishes with refresh_model_dependent_surfaces so the header and footer reflect the change immediately.

*Call graph*: calls 3 internal fn (collaboration_modes_enabled, refresh_model_dependent_surfaces, plan_mask).


##### `ChatWidget::set_reasoning_effort`  (lines 166–181)

```
fn set_reasoning_effort(&mut self, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Sets the normal, non-Plan reasoning effort. It deliberately avoids changing the active Plan mask, because Plan mode has its own preset and override.

**Data flow**: It receives an optional reasoning effort, writes it into the stored current collaboration mode, and, when a non-Plan mask is active, writes it into that mask too. Then it refreshes model-dependent UI.

**Call relations**: It uses collaboration_modes_enabled to decide whether active masks apply, then calls refresh_model_dependent_surfaces. This keeps normal mode changes separate from Plan-mode-specific behavior.

*Call graph*: calls 2 internal fn (collaboration_modes_enabled, refresh_model_dependent_surfaces).


##### `ChatWidget::set_personality`  (lines 184–186)

```
fn set_personality(&mut self, personality: Personality)
```

**Purpose**: Stores the selected assistant personality in the widget's configuration. Personality changes how the assistant presents itself when the feature is available.

**Data flow**: It receives a personality value and saves it as the current configured personality. It does not return a value or refresh UI directly.

**Call relations**: No caller is shown in the provided graph. Other parts of the widget can use the stored configuration when sending turns or drawing controls.


##### `ChatWidget::status_account_display`  (lines 188–190)

```
fn status_account_display(&self) -> Option<&StatusAccountDisplay>
```

**Purpose**: Returns the account display information currently known to the widget. This is the user-facing account status, if any.

**Data flow**: It reads the optional stored account display value and returns it by reference. Nothing is changed.

**Call relations**: No caller is shown in the provided graph. It is a small getter for other widget code that needs account display state.


##### `ChatWidget::runtime_model_provider_base_url`  (lines 192–194)

```
fn runtime_model_provider_base_url(&self) -> Option<&str>
```

**Purpose**: Returns the runtime model provider base URL, if one is set. This is the server address used for model-provider communication.

**Data flow**: It reads an optional stored string and returns it as an optional string slice. Nothing is changed.

**Call relations**: No caller is shown in the provided graph. It exposes provider connection state without giving callers ownership of the stored string.


##### `ChatWidget::model_catalog`  (lines 197–199)

```
fn model_catalog(&self) -> Arc<ModelCatalog>
```

**Purpose**: Returns the shared model catalog used by the widget. The model catalog is the list of known models and their abilities.

**Data flow**: It clones the shared reference-counted pointer to the catalog and returns it. The catalog data itself is not copied.

**Call relations**: No caller is shown in the provided graph; the function is marked for test use. It lets tests or nearby code inspect the same catalog the widget uses.


##### `ChatWidget::current_plan_type`  (lines 201–203)

```
fn current_plan_type(&self) -> Option<PlanType>
```

**Purpose**: Returns the current account plan type, if known. This can describe what level of service the account has.

**Data flow**: It reads the stored optional plan type and returns it. Nothing is changed.

**Call relations**: No caller is shown in the provided graph. It is a simple read-only view of account state.


##### `ChatWidget::has_chatgpt_account`  (lines 205–207)

```
fn has_chatgpt_account(&self) -> bool
```

**Purpose**: Reports whether the widget knows the user has a ChatGPT account connected.

**Data flow**: It reads the stored boolean and returns it. Nothing is changed.

**Call relations**: No caller is shown in the provided graph. update_account_state is the function that updates this stored value.


##### `ChatWidget::has_codex_backend_auth`  (lines 209–211)

```
fn has_codex_backend_auth(&self) -> bool
```

**Purpose**: Reports whether the widget has authentication for the Codex backend. This affects which backend-dependent commands can be used.

**Data flow**: It reads the stored boolean and returns it. Nothing is changed.

**Call relations**: No caller is shown in the provided graph. update_account_state writes this value and also enables or disables related bottom-pane commands.


##### `ChatWidget::update_account_state`  (lines 213–235)

```
fn update_account_state(
        &mut self,
        status_account_display: Option<StatusAccountDisplay>,
        plan_type: Option<PlanType>,
        has_chatgpt_account: bool,
        has_codex_back
```

**Purpose**: Updates the widget's account-related state and turns account-dependent commands on or off. It also clears pending account refresh work when the account identity or backend access changes.

**Data flow**: It receives account display data, plan type, and two authentication booleans. If important account state changed, it clears pending token activity and rate-limit refresh requests, stores the new values, and updates bottom-pane connector and token-activity command availability.

**Call relations**: No caller is shown in the provided graph. It is the central place where new account information becomes visible and actionable in the chat UI.


##### `ChatWidget::set_tui_theme`  (lines 238–240)

```
fn set_tui_theme(&mut self, theme: Option<String>)
```

**Purpose**: Stores an optional terminal UI theme override. This changes which syntax or visual theme the widget should use.

**Data flow**: It receives either a theme name or no override and writes it into the configuration. It does not return a value.

**Call relations**: No caller is shown in the provided graph. Other drawing code can later read the configuration to apply the theme.


##### `ChatWidget::set_model`  (lines 243–256)

```
fn set_model(&mut self, model: &str)
```

**Purpose**: Changes the active model used by the chat and updates the UI surfaces that depend on the model. The model choice affects capabilities such as image input and status labels.

**Data flow**: It receives a model name, stores it in the current collaboration mode, and, if collaboration masks are active, stores it in the active mask too. It then refreshes service tier and model-dependent displays.

**Call relations**: It checks collaboration_modes_enabled and calls refresh_model_dependent_surfaces. current_model later reads the resulting effective model.

*Call graph*: calls 2 internal fn (collaboration_modes_enabled, refresh_model_dependent_surfaces).


##### `ChatWidget::current_model`  (lines 258–266)

```
fn current_model(&self) -> &str
```

**Purpose**: Returns the model name that is effectively active right now. It accounts for collaboration-mode overlays before falling back to the base stored model.

**Data flow**: It reads whether collaboration modes are enabled, then reads the active mask's model if present, otherwise the current collaboration mode's model. It returns a string reference and changes nothing.

**Call relations**: It is used by current_model_supports_images, current_model_supports_personality, model_display_name, and set_collaboration_mask to make decisions based on the actual model the user is using.

*Call graph*: calls 1 internal fn (collaboration_modes_enabled); called by 4 (current_model_supports_images, current_model_supports_personality, model_display_name, set_collaboration_mask).


##### `ChatWidget::sync_personality_command_enabled`  (lines 268–271)

```
fn sync_personality_command_enabled(&mut self)
```

**Purpose**: Turns the personality command in the bottom pane on or off to match the Personality feature flag.

**Data flow**: It reads whether the Personality feature is enabled in the config and sends that boolean to the bottom pane. It returns nothing.

**Call relations**: set_feature_enabled calls it when the Personality feature changes, and apply_thread_settings calls it after syncing settings from the server.

*Call graph*: called by 2 (apply_thread_settings, set_feature_enabled).


##### `ChatWidget::sync_plugins_command_enabled`  (lines 273–276)

```
fn sync_plugins_command_enabled(&mut self)
```

**Purpose**: Turns the plugins command in the bottom pane on or off to match the Plugins feature flag.

**Data flow**: It reads the Plugins feature state and passes that enabled value to the bottom pane. It returns nothing.

**Call relations**: set_feature_enabled calls it when plugin support changes, so the visible command does not invite users to use a disabled feature.

*Call graph*: called by 1 (set_feature_enabled).


##### `ChatWidget::sync_goal_command_enabled`  (lines 278–281)

```
fn sync_goal_command_enabled(&mut self)
```

**Purpose**: Turns the goal command in the bottom pane on or off to match the Goals feature flag.

**Data flow**: It reads the Goals feature state and sends it to the bottom pane. It returns nothing.

**Call relations**: set_feature_enabled calls it when the Goals feature changes. That same caller also clears goal state when goals are disabled.

*Call graph*: called by 1 (set_feature_enabled).


##### `ChatWidget::sync_mentions_v2_enabled`  (lines 283–286)

```
fn sync_mentions_v2_enabled(&mut self)
```

**Purpose**: Tells the bottom pane whether the newer mentions feature is enabled. Mentions are special references the user can insert into a message.

**Data flow**: It reads the MentionsV2 feature state and writes the enabled value into the bottom pane. It returns nothing.

**Call relations**: set_feature_enabled calls it when MentionsV2 changes, keeping composer behavior aligned with the feature flag.

*Call graph*: called by 1 (set_feature_enabled).


##### `ChatWidget::current_model_supports_personality`  (lines 288–300)

```
fn current_model_supports_personality(&self) -> bool
```

**Purpose**: Checks whether the currently active model says it supports personality settings. If the model cannot be found or the catalog cannot be read, it returns false.

**Data flow**: It gets the current model name, asks the model catalog for available models, searches for the matching model, and returns that model's personality-support flag. If anything fails, the answer is false.

**Call relations**: It calls current_model so it respects collaboration-mode overrides. No caller is shown in the provided graph, but it is meant for UI or validation code that decides whether personality can be used.

*Call graph*: calls 1 internal fn (current_model).


##### `ChatWidget::current_model_supports_images`  (lines 306–318)

```
fn current_model_supports_images(&self) -> bool
```

**Purpose**: Checks whether the active model advertises support for image input. If the catalog cannot be read, it defaults to true so a temporary catalog problem does not block the user.

**Data flow**: It reads the current model, looks that model up in the catalog, and checks whether Image appears in its input types. It returns true on catalog failure or missing data fallback.

**Call relations**: sync_image_paste_enabled calls this before enabling image paste in the composer. It calls current_model so it uses the effective model.

*Call graph*: calls 1 internal fn (current_model); called by 1 (sync_image_paste_enabled).


##### `ChatWidget::sync_image_paste_enabled`  (lines 320–323)

```
fn sync_image_paste_enabled(&mut self)
```

**Purpose**: Enables or disables image pasting in the bottom pane based on the active model's abilities.

**Data flow**: It calls current_model_supports_images, receives a boolean, and sends that boolean to the bottom pane. It returns nothing.

**Call relations**: refresh_model_display calls this whenever the effective model display is refreshed, so paste affordances change along with model changes.

*Call graph*: calls 1 internal fn (current_model_supports_images); called by 1 (refresh_model_display).


##### `ChatWidget::image_inputs_not_supported_message`  (lines 325–330)

```
fn image_inputs_not_supported_message(&self) -> String
```

**Purpose**: Builds the warning message shown when the user tries to use images with a model that does not support them.

**Data flow**: It reads the current model name and formats a sentence telling the user to remove images or switch models. It returns that string.

**Call relations**: No caller is shown in the provided graph. It complements current_model_supports_images by providing the user-facing explanation.

*Call graph*: 1 external calls (format!).


##### `ChatWidget::current_collaboration_mode`  (lines 333–335)

```
fn current_collaboration_mode(&self) -> &CollaborationMode
```

**Purpose**: Returns the stored current collaboration mode. This is mainly used in tests to inspect internal state.

**Data flow**: It returns a reference to the current collaboration mode without changing anything.

**Call relations**: No caller is shown in the provided graph; the code comment notes it is used in tests.


##### `ChatWidget::current_reasoning_effort`  (lines 337–339)

```
fn current_reasoning_effort(&self) -> Option<ReasoningEffortConfig>
```

**Purpose**: Returns the reasoning effort that is effectively active right now. It includes collaboration-mode overrides when they apply.

**Data flow**: It calls effective_reasoning_effort and returns that optional reasoning-effort value. Nothing is changed.

**Call relations**: It is a public-facing wrapper around effective_reasoning_effort for code that needs the current setting without knowing about masks.

*Call graph*: calls 1 internal fn (effective_reasoning_effort).


##### `ChatWidget::on_thread_settings_updated`  (lines 341–357)

```
fn on_thread_settings_updated(
        &mut self,
        notification: ThreadSettingsUpdatedNotification,
    )
```

**Purpose**: Responds to a server notification that a thread's settings changed. It only applies the update if the notification belongs to the currently open thread.

**Data flow**: It receives a notification, parses the thread id, ignores it if parsing fails or the id does not match the active thread, and otherwise passes the included settings to apply_thread_settings.

**Call relations**: It calls from_string to validate the thread id and apply_thread_settings to do the actual sync. It logs a warning for an invalid id.

*Call graph*: calls 2 internal fn (from_string, apply_thread_settings); 1 external calls (warn!).


##### `ChatWidget::active_collaboration_mode_kind`  (lines 360–362)

```
fn active_collaboration_mode_kind(&self) -> ModeKind
```

**Purpose**: Returns the active collaboration mode kind for tests. A mode kind is the named mode, such as Default or Plan.

**Data flow**: It calls active_mode_kind and returns the result. Nothing is changed.

**Call relations**: It is compiled for tests and delegates to active_mode_kind, which is used by the real UI policy code.

*Call graph*: calls 1 internal fn (active_mode_kind).


##### `ChatWidget::is_session_configured`  (lines 364–366)

```
fn is_session_configured(&self) -> bool
```

**Purpose**: Reports whether the widget is attached to a thread session. A configured session has a thread id.

**Data flow**: It checks whether thread_id is present and returns true or false. Nothing is changed.

**Call relations**: No caller is shown in the provided graph. It is a simple readiness check for code that should only run after a session exists.


##### `ChatWidget::collaboration_modes_enabled`  (lines 368–370)

```
fn collaboration_modes_enabled(&self) -> bool
```

**Purpose**: Reports whether collaboration modes are enabled. In this file it always returns true, making the feature unconditional here.

**Data flow**: It takes no outside data and returns true. Nothing is changed.

**Call relations**: Many functions call it before reading or changing collaboration masks, including current_model, effective_collaboration_mode, effective_reasoning_effort, cycle_collaboration_mode, set_collaboration_mask, set_model, and mode label or indicator helpers.

*Call graph*: called by 11 (collaboration_mode_indicator, collaboration_mode_label, current_model, cycle_collaboration_mode, effective_collaboration_mode, effective_reasoning_effort, set_collaboration_mask, set_model, set_plan_mode_reasoning_effort, set_reasoning_effort (+1 more)).


##### `ChatWidget::plan_mode_nudge_scope`  (lines 373–376)

```
fn plan_mode_nudge_scope(&self) -> PlanModeNudgeScope
```

**Purpose**: Decides whether dismissing the Plan-mode nudge should apply to a new-thread draft or to the current thread. This keeps a dismissal from lasting too broadly.

**Data flow**: It checks whether a thread id exists. If not, it returns the NewThread scope; otherwise it returns the Thread scope.

**Call relations**: should_show_plan_mode_nudge reads this scope before showing the nudge, dismiss_plan_mode_nudge stores this scope as dismissed, and set_collaboration_mask uses it when entering Plan mode.

*Call graph*: called by 3 (dismiss_plan_mode_nudge, set_collaboration_mask, should_show_plan_mode_nudge).


##### `ChatWidget::should_show_plan_mode_nudge`  (lines 384–399)

```
fn should_show_plan_mode_nudge(&self) -> bool
```

**Purpose**: Decides whether the footer should show a hint suggesting Plan mode. It looks for planning-related text while avoiding command drafts, active tasks, popups, and already-dismissed scopes.

**Data flow**: It reads the composer text and UI state, checks that Plan mode exists and is not already active, rejects slash and shell commands, looks for a planning keyword, and checks dismissal history. It returns true only when all conditions say the nudge is helpful.

**Call relations**: refresh_plan_mode_nudge calls it to set the actual bottom-pane visibility. It uses active_mode_kind, collaboration_modes_enabled, plan_mode_nudge_scope, and plan_mask.

*Call graph*: calls 4 internal fn (active_mode_kind, collaboration_modes_enabled, plan_mode_nudge_scope, plan_mask); called by 1 (refresh_plan_mode_nudge).


##### `ChatWidget::refresh_plan_mode_nudge`  (lines 402–405)

```
fn refresh_plan_mode_nudge(&mut self)
```

**Purpose**: Updates the bottom pane so the Plan-mode nudge is either visible or hidden according to the current policy.

**Data flow**: It calls should_show_plan_mode_nudge, gets a boolean, and passes that boolean to the bottom pane. It returns nothing.

**Call relations**: dismiss_plan_mode_nudge, set_collaboration_mask, and set_effective_collaboration_mode call this after state changes that could affect whether the hint should appear.

*Call graph*: calls 1 internal fn (should_show_plan_mode_nudge); called by 3 (dismiss_plan_mode_nudge, set_collaboration_mask, set_effective_collaboration_mode).


##### `ChatWidget::dismiss_plan_mode_nudge`  (lines 408–412)

```
fn dismiss_plan_mode_nudge(&mut self)
```

**Purpose**: Hides the Plan-mode nudge for the current dismissal scope. This lets the user say, in effect, 'not now' for this draft or thread.

**Data flow**: It computes the current nudge scope, records that scope as dismissed, and refreshes the nudge visibility. It returns nothing.

**Call relations**: It calls plan_mode_nudge_scope and refresh_plan_mode_nudge. After this, should_show_plan_mode_nudge will see the dismissal and avoid showing the hint for that scope.

*Call graph*: calls 2 internal fn (plan_mode_nudge_scope, refresh_plan_mode_nudge).


##### `ChatWidget::initial_collaboration_mask`  (lines 414–424)

```
fn initial_collaboration_mask(
        _config: &Config,
        model_catalog: &ModelCatalog,
        model_override: Option<&str>,
    ) -> Option<CollaborationModeMask>
```

**Purpose**: Builds the starting collaboration-mode mask for a widget. A mask is an overlay that can set the mode, model, reasoning effort, or instructions.

**Data flow**: It asks collaboration mode presets for the default mask. If a model override was supplied, it writes that model into the mask, then returns the completed mask or None if no default exists.

**Call relations**: It calls default_mask. No caller is shown in the provided graph, but it is the initialization path for collaboration-mode overlay state.

*Call graph*: calls 1 internal fn (default_mask).


##### `ChatWidget::active_mode_kind`  (lines 426–431)

```
fn active_mode_kind(&self) -> ModeKind
```

**Purpose**: Returns the currently active collaboration mode kind, using Default when no active mask names a mode.

**Data flow**: It reads the active collaboration mask, extracts its mode if present, and otherwise returns Default. Nothing is changed.

**Call relations**: It is used by active_collaboration_mode_kind, collaboration_mode_indicator, collaboration_mode_label, set_collaboration_mask, and should_show_plan_mode_nudge.

*Call graph*: called by 5 (active_collaboration_mode_kind, collaboration_mode_indicator, collaboration_mode_label, set_collaboration_mask, should_show_plan_mode_nudge).


##### `ChatWidget::effective_reasoning_effort`  (lines 433–442)

```
fn effective_reasoning_effort(&self) -> Option<ReasoningEffortConfig>
```

**Purpose**: Returns the reasoning effort that should actually be used now, after applying any collaboration-mode overlay.

**Data flow**: It first reads the base current collaboration mode's reasoning effort. If collaboration modes are disabled, it returns that. Otherwise it returns the active mask's reasoning effort when present, or the base value as a fallback.

**Call relations**: current_reasoning_effort and set_collaboration_mask call this. It uses collaboration_modes_enabled to decide whether masks matter.

*Call graph*: calls 1 internal fn (collaboration_modes_enabled); called by 2 (current_reasoning_effort, set_collaboration_mask).


##### `ChatWidget::effective_collaboration_mode`  (lines 444–452)

```
fn effective_collaboration_mode(&self) -> CollaborationMode
```

**Purpose**: Builds the full collaboration mode that is active right now. It combines the stored base mode with the active mask when collaboration modes are enabled.

**Data flow**: It reads the current collaboration mode and, if there is an active mask, applies that mask to produce a complete mode. If collaboration modes are disabled or there is no mask, it returns the stored mode clone.

**Call relations**: refresh_model_display uses it to update visible model text, and submit_collaboration_mode_settings_update sends it to the app server when the user changes modes.

*Call graph*: calls 1 internal fn (collaboration_modes_enabled); called by 2 (refresh_model_display, submit_collaboration_mode_settings_update).


##### `ChatWidget::refresh_model_display`  (lines 454–461)

```
fn refresh_model_display(&mut self)
```

**Purpose**: Refreshes visible UI pieces that depend directly on the active model. This includes the session header, image paste availability, service-tier commands, and terminal title.

**Data flow**: It computes the effective collaboration mode, writes its model into the session header, syncs image paste support, syncs service-tier commands, and refreshes the terminal title.

**Call relations**: refresh_model_dependent_surfaces calls this as one half of the broader refresh. It calls effective_collaboration_mode and sync_image_paste_enabled.

*Call graph*: calls 2 internal fn (effective_collaboration_mode, sync_image_paste_enabled); called by 1 (refresh_model_dependent_surfaces).


##### `ChatWidget::refresh_model_dependent_surfaces`  (lines 471–474)

```
fn refresh_model_dependent_surfaces(&mut self)
```

**Purpose**: Refreshes all UI surfaces that depend on model, reasoning effort, or collaboration mode. It exists to avoid bugs where one visible area updates but another stays stale.

**Data flow**: It refreshes the model display and then refreshes the status line. It returns nothing.

**Call relations**: set_collaboration_mask, set_effective_collaboration_mode, set_model, set_plan_mode_reasoning_effort, and set_reasoning_effort call this after changing model-related state.

*Call graph*: calls 1 internal fn (refresh_model_display); called by 5 (set_collaboration_mask, set_effective_collaboration_mode, set_model, set_plan_mode_reasoning_effort, set_reasoning_effort).


##### `ChatWidget::apply_thread_settings`  (lines 476–523)

```
fn apply_thread_settings(&mut self, mut settings: ThreadSettings)
```

**Purpose**: Copies server-provided thread settings into the local chat widget. This is the main bridge from app-server truth to the terminal UI's live settings.

**Data flow**: It receives thread settings, notices whether the working folder changed, applies the new folder, model provider, service tier, approval policy, reviewer, personality, permissions, model, reasoning effort, and collaboration mode. It then refreshes service tier, status surfaces, commands, skills if the folder changed, plugin mentions, and requests a redraw.

**Call relations**: on_thread_settings_updated calls this after confirming the notification belongs to the active thread. It calls apply_thread_settings_cwd, set_approval_policy, set_approvals_reviewer, set_effective_collaboration_mode, sync_personality_command_enabled, and permission snapshot builders; it logs if permission syncing fails.

*Call graph*: calls 7 internal fn (from_session_snapshot, from_legacy_sandbox_policy_for_cwd, apply_thread_settings_cwd, set_approval_policy, set_approvals_reviewer, set_effective_collaboration_mode, sync_personality_command_enabled); called by 1 (on_thread_settings_updated); 2 external calls (error!, warn!).


##### `ChatWidget::apply_thread_settings_cwd`  (lines 525–544)

```
fn apply_thread_settings_cwd(&mut self, cwd: AbsolutePathBuf)
```

**Purpose**: Updates the widget's current working folder and keeps workspace roots consistent. The working folder matters because permissions, project labels, and skills can depend on it.

**Data flow**: It receives an absolute path, replaces the config's current folder, updates the cached current folder, clears the project-root-name cache, and, if the old folder was a workspace root, swaps in the new folder while preserving other roots. It then updates permission workspace roots.

**Call relations**: apply_thread_settings calls this before applying the rest of the server settings, so later permission and skill refresh work sees the correct folder.

*Call graph*: calls 1 internal fn (to_path_buf); called by 1 (apply_thread_settings); 3 external calls (replace, take, clone).


##### `ChatWidget::set_effective_collaboration_mode`  (lines 546–565)

```
fn set_effective_collaboration_mode(&mut self, mode: CollaborationMode)
```

**Purpose**: Sets the active collaboration mode from a complete mode object, usually received from thread settings. It updates internal mode state and all affected UI indicators.

**Data flow**: It receives a collaboration mode, separates its mode kind and settings, updates the stored current mode when the mode is Default, creates a new active mask from the settings, then refreshes the mode indicator, Plan nudge, and model-dependent UI.

**Call relations**: apply_thread_settings calls this during server sync. It calls update_collaboration_mode_indicator, refresh_plan_mode_nudge, and refresh_model_dependent_surfaces.

*Call graph*: calls 3 internal fn (refresh_model_dependent_surfaces, refresh_plan_mode_nudge, update_collaboration_mode_indicator); called by 1 (apply_thread_settings).


##### `ChatWidget::model_display_name`  (lines 567–574)

```
fn model_display_name(&self) -> &str
```

**Purpose**: Returns the model name to show to the user, with a friendly default when the current model string is empty.

**Data flow**: It reads the current model. If that string is empty, it returns DEFAULT_MODEL_DISPLAY_NAME; otherwise it returns the model string.

**Call relations**: It calls current_model, so it respects collaboration-mode overlays. No caller is shown in the provided graph.

*Call graph*: calls 1 internal fn (current_model).


##### `ChatWidget::collaboration_mode_label`  (lines 577–585)

```
fn collaboration_mode_label(&self) -> Option<&'static str>
```

**Purpose**: Returns the label for the current collaboration mode when that mode should be visible in the terminal UI.

**Data flow**: It first checks whether collaboration modes are enabled. Then it reads the active mode kind and returns its display name only if that mode is marked visible for the TUI.

**Call relations**: It calls collaboration_modes_enabled and active_mode_kind. No caller is shown in the provided graph, but it supplies text for visible mode status.

*Call graph*: calls 2 internal fn (active_mode_kind, collaboration_modes_enabled).


##### `ChatWidget::collaboration_mode_indicator`  (lines 587–595)

```
fn collaboration_mode_indicator(&self) -> Option<CollaborationModeIndicator>
```

**Purpose**: Chooses the small indicator shown for the active collaboration mode. Currently Plan mode gets an indicator, while Default, Pair Programming, and Execute do not.

**Data flow**: It checks whether collaboration modes are enabled, reads the active mode kind, and returns a Plan indicator only for Plan mode. Otherwise it returns None.

**Call relations**: update_collaboration_mode_indicator and refresh_goal_status_indicator_for_time_tick call this. It calls active_mode_kind and collaboration_modes_enabled.

*Call graph*: calls 2 internal fn (active_mode_kind, collaboration_modes_enabled); called by 2 (refresh_goal_status_indicator_for_time_tick, update_collaboration_mode_indicator).


##### `ChatWidget::update_collaboration_mode_indicator`  (lines 597–607)

```
fn update_collaboration_mode_indicator(&mut self)
```

**Purpose**: Updates the bottom-pane indicator area, choosing between a collaboration-mode indicator and a goal-status indicator. Collaboration mode takes priority over goal status.

**Data flow**: It computes the collaboration indicator. If there is none, it computes a goal indicator for the current time. It stores the current goal indicator and sends both indicator values to the bottom pane.

**Call relations**: on_thread_goal_updated, set_collaboration_mask, set_effective_collaboration_mode, and set_feature_enabled call this after state changes. It calls collaboration_mode_indicator and goal_status_indicator.

*Call graph*: calls 2 internal fn (collaboration_mode_indicator, goal_status_indicator); called by 4 (on_thread_goal_updated, set_collaboration_mask, set_effective_collaboration_mode, set_feature_enabled); 1 external calls (now).


##### `ChatWidget::refresh_goal_status_indicator_for_time_tick`  (lines 609–618)

```
fn refresh_goal_status_indicator_for_time_tick(&mut self)
```

**Purpose**: Updates the goal-status indicator as time passes. This matters because a goal indicator may change appearance based on elapsed time.

**Data flow**: It first exits if a collaboration-mode indicator is currently showing. Otherwise it computes the current goal indicator and, if it differs from the stored one, updates the stored value and bottom pane.

**Call relations**: No caller is shown in the provided graph. It calls collaboration_mode_indicator and goal_status_indicator, using the current time.

*Call graph*: calls 2 internal fn (collaboration_mode_indicator, goal_status_indicator); 1 external calls (now).


##### `ChatWidget::goal_status_indicator`  (lines 620–627)

```
fn goal_status_indicator(&self, now: Instant) -> Option<GoalStatusIndicator>
```

**Purpose**: Computes the visible goal-status indicator, if the Goals feature is enabled and there is current goal state.

**Data flow**: It receives the current time, checks the Goals feature flag, reads the current goal status, and asks that state for the right indicator based on time and active-turn timing. It returns an optional indicator.

**Call relations**: update_collaboration_mode_indicator and refresh_goal_status_indicator_for_time_tick call this when they need to decide what goal status to show.

*Call graph*: called by 2 (refresh_goal_status_indicator_for_time_tick, update_collaboration_mode_indicator).


##### `ChatWidget::on_thread_goal_updated`  (lines 629–648)

```
fn on_thread_goal_updated(&mut self, goal: AppThreadGoal, turn_id: Option<String>)
```

**Purpose**: Applies a goal-status update for the current thread. Goal status can show progress or budget-limited state in the UI.

**Data flow**: It receives a goal object and optional turn id, ignores the update if it belongs to another active thread, clears goal state if the Goals feature is disabled, marks a turn as budget-limited when appropriate, stores a new goal status state with the current time, and updates indicators.

**Call relations**: It calls GoalStatusState::new and update_collaboration_mode_indicator. No caller is shown in the provided graph, but it is the entry point for goal update events.

*Call graph*: calls 2 internal fn (new, update_collaboration_mode_indicator); 1 external calls (now).


##### `ChatWidget::cycle_collaboration_mode`  (lines 651–662)

```
fn cycle_collaboration_mode(&mut self)
```

**Purpose**: Moves to the next available collaboration mode, such as switching between Plan and Default. It is the user-facing 'cycle mode' action.

**Data flow**: It first checks whether collaboration modes are enabled. Then it asks the collaboration-mode presets for the next mask and, if one exists, applies it as a user action.

**Call relations**: It calls collaboration_modes_enabled, next_mask, and set_collaboration_mask_from_user_action. The last call both updates local UI state and submits the change for the thread.

*Call graph*: calls 3 internal fn (collaboration_modes_enabled, set_collaboration_mask_from_user_action, next_mask).


##### `ChatWidget::set_collaboration_mask_from_user_action`  (lines 664–667)

```
fn set_collaboration_mask_from_user_action(&mut self, mask: CollaborationModeMask)
```

**Purpose**: Applies a collaboration-mode mask chosen by the user and tells the app server about the change. This keeps local UI and thread settings in step.

**Data flow**: It receives a collaboration mask, applies it locally through set_collaboration_mask, then submits an update for the current thread if one exists.

**Call relations**: cycle_collaboration_mode calls this after choosing the next mask. It calls set_collaboration_mask and submit_collaboration_mode_settings_update.

*Call graph*: calls 2 internal fn (set_collaboration_mask, submit_collaboration_mode_settings_update); called by 1 (cycle_collaboration_mode).


##### `ChatWidget::set_collaboration_mask`  (lines 673–714)

```
fn set_collaboration_mask(&mut self, mut mask: CollaborationModeMask)
```

**Purpose**: Changes the active collaboration-mode overlay and refreshes every UI piece affected by that mode. It also explains to the user when switching modes changes the model or reasoning effort.

**Data flow**: It receives a mask, records the previous mode, model, and reasoning effort, applies a Plan-mode reasoning override if needed, dismisses the Plan nudge when entering Plan mode, stores the mask, refreshes indicators, nudge, and model-dependent UI, compares old and new effective settings, optionally adds an informational message, and requests a redraw.

**Call relations**: set_collaboration_mask_from_user_action calls this for user-driven changes. It calls active_mode_kind, collaboration_modes_enabled, current_model, effective_reasoning_effort, plan_mode_nudge_scope, update_collaboration_mode_indicator, refresh_plan_mode_nudge, and refresh_model_dependent_surfaces.

*Call graph*: calls 8 internal fn (active_mode_kind, collaboration_modes_enabled, current_model, effective_reasoning_effort, plan_mode_nudge_scope, refresh_model_dependent_surfaces, refresh_plan_mode_nudge, update_collaboration_mode_indicator); called by 1 (set_collaboration_mask_from_user_action); 1 external calls (format!).


##### `ChatWidget::submit_collaboration_mode_settings_update`  (lines 716–737)

```
fn submit_collaboration_mode_settings_update(&self)
```

**Purpose**: Sends the current effective collaboration mode to the app server as a thread setting update. This makes a local user mode switch persist with the conversation.

**Data flow**: It checks for an active thread id and returns if there is none. If a thread exists, it builds an override-turn-context command containing the effective collaboration mode and sends it through the app event channel.

**Call relations**: set_collaboration_mask_from_user_action calls this after applying a user-selected mask. It calls effective_collaboration_mode and uses AppCommand::override_turn_context to package the update.

*Call graph*: calls 1 internal fn (effective_collaboration_mode); called by 1 (set_collaboration_mask_from_user_action); 1 external calls (override_turn_context).


### `tui/src/keymap.rs`

`domain_logic` · `config load, startup, and input handling`

The TUI has many places where keys can mean different things: the main chat screen, the message composer, the text editor inside the composer, Vim-style editing modes, transcript pagers, list popups, and approval dialogs. This file is the translator and safety inspector for all of those shortcuts. It starts with the loaded configuration, fills in missing entries from built-in defaults, and respects explicit empty lists as “unbind this action.” Some composer actions can also fall back to global bindings, like a shared shortcut shelf. After building the full RuntimeKeymap, it checks for trouble. For example, if Ctrl-T opens the transcript at the app level, the composer cannot also use Ctrl-T for submit, because the app would catch the key first. That would feel like a broken shortcut. The file also parses readable strings such as ctrl-a, page-down, or shift-enter into concrete key objects from the terminal library. It keeps the first binding as the one shown in UI hints, while still allowing multiple keys for the same action. Several compatibility rules are included for old defaults and terminals that report shifted keys differently. The large test section documents the expected behavior: parsing, fallback, remapping, unbinding, and conflict messages.

#### Function details

##### `primary_binding`  (lines 270–272)

```
fn primary_binding(bindings: &[KeyBinding]) -> Option<KeyBinding>
```

**Purpose**: Returns the first key in a list of bindings so the UI can show one short, readable hint. The full list is still used for matching actual input.

**Data flow**: It receives a slice of key bindings → looks at the first item only → returns that key if it exists, or nothing if the action has no keys.

**Call relations**: Rendering and setup code calls this when it needs a compact label, such as status indicators, footer hints, popups, and keymap-aware builders. It does not decide whether a key was pressed; it only chooses the display shortcut.

*Call graph*: called by 9 (ensure_status_indicator, set_keymap_bindings, set_task_running, approval_footer_hint, new_with_config, set_keymap_bindings, build, standard_popup_hint_line_for_keymap, skills_toggle_hint_line); 1 external calls (first).


##### `RuntimeKeymap::defaults`  (lines 372–374)

```
fn defaults() -> Self
```

**Purpose**: Creates a runtime keymap using only the built-in shortcut defaults. This is useful before user configuration is loaded and in tests that need a known baseline.

**Data flow**: It takes no input → asks the internal default table to build every keymap section → returns a complete RuntimeKeymap.

**Call relations**: App and test setup code calls this when it needs a ready-made keymap without reading configuration. It delegates all actual default choices to RuntimeKeymap::built_in_defaults.

*Call graph*: called by 107 (make_test_app, clear_only_ui_reset_preserves_chat_session_state, make_test_app, make_test_app_with_channels, new, new, remapped_horizontal_list_keys_control_action_selection, additional_permissions_exec_options_hide_execpolicy_amendment, apply_patch_prompt_with_thread_label_omits_command_line, configured_list_cancel_aborts_exec_approval (+15 more)); 1 external calls (built_in_defaults).


##### `RuntimeKeymap::from_config`  (lines 386–902)

```
fn from_config(keymap: &TuiKeymap) -> Result<Self, String>
```

**Purpose**: Builds the real runtime keymap from the user’s TUI keymap configuration. It applies fallback rules, parses shortcut strings, handles unbound actions, preserves compatibility behavior, and rejects ambiguous shortcuts.

**Data flow**: It receives a TuiKeymap from configuration → starts from built-in defaults → resolves each action from configured value, global fallback where allowed, or default → prunes some newer fallback defaults when they would collide with user-configured older bindings → validates conflicts → returns a RuntimeKeymap or a human-readable error.

**Call relations**: Startup and keymap-changing flows call this after configuration is loaded or edited. It calls the parsing, fallback, preservation, alias-detection, and validation helpers, then hands the finished keymap to UI code for dispatch and hints.

*Call graph*: calls 4 internal fn (configured_bindings_to_preserve, configured_main_surface_alias_is_used, resolve_bindings, resolve_new_default_bindings); called by 48 (run, apply_keymap_capture, apply_keymap_clear, new_with_op_target, open_keymap_picker, dispatch_prepared_command_with_args, copy_shortcut_can_be_remapped, configured_app_bindings_prune_new_list_default_overlaps, configured_approval_bindings_prune_new_list_default_overlaps, configured_legacy_list_bindings_can_prune_all_new_default_keys (+15 more)); 3 external calls (built_in_defaults, resolve_local!, resolve_with_global!).


##### `RuntimeKeymap::built_in_defaults`  (lines 909–1153)

```
fn built_in_defaults() -> Self
```

**Purpose**: Defines the built-in keyboard shortcuts for every TUI area. This is the source of the app’s default keyboard behavior.

**Data flow**: It takes no input → constructs each keymap section with lists of KeyBinding values → returns a complete RuntimeKeymap containing only defaults.

**Call relations**: RuntimeKeymap::defaults uses it directly, and RuntimeKeymap::from_config uses it as the fallback table. The default-binding macros keep this large table readable.

*Call graph*: 1 external calls (default_bindings!).


##### `RuntimeKeymap::validate_conflicts`  (lines 1164–1688)

```
fn validate_conflicts(&self) -> Result<(), String>
```

**Purpose**: Checks that the resolved keymap will not create confusing or unreachable actions. It catches duplicate keys inside one context, keys that shadow lower-level handlers, and keys reserved for fixed behavior.

**Data flow**: It reads the finished RuntimeKeymap → compares key bindings across the places that are active together → returns success if safe, or an error message explaining which actions conflict and how the user can fix it.

**Call relations**: RuntimeKeymap::from_config calls this as the final gate before accepting a keymap. It relies on validate_unique, validate_no_shadow_with_allowed_overlaps, and validate_no_reserved for the different kinds of conflict checks.

*Call graph*: calls 5 internal fn (ctrl, plain, validate_no_reserved, validate_no_shadow_with_allowed_overlaps, validate_unique); 3 external calls (new, Char, format!).


##### `validate_unique`  (lines 1695–1713)

```
fn validate_unique(
    context: &str,
    pairs: [(&'static str, &[KeyBinding]); N],
) -> Result<(), String>
```

**Purpose**: Rejects duplicate keys within one effective shortcut context. This prevents one key from triggering two actions when the same handler is looking at both.

**Data flow**: It receives a context name and action-to-binding lists → records each key it sees → if the same key appears twice, returns an error naming both actions; otherwise returns success.

**Call relations**: RuntimeKeymap::validate_conflicts calls it for app, editor, Vim, pager, list, and approval contexts. It is the basic duplicate-checking tool used across the file.

*Call graph*: called by 1 (validate_conflicts); 2 external calls (new, format!).


##### `validate_no_shadow_with_allowed_overlaps`  (lines 1715–1749)

```
fn validate_no_shadow_with_allowed_overlaps(
    context: &str,
    primary: [(&'static str, &[KeyBinding]); N],
    shadowed: [(&'static str, &[KeyBinding]); M],
    allowed_overlaps: [(&'static str,
```

**Purpose**: Checks that higher-priority shortcuts do not silently steal keys from lower-priority shortcuts. It allows a few known safe overlaps that the app intentionally supports.

**Data flow**: It receives primary actions, shadowed actions, and explicitly allowed overlaps → stores primary keys → compares shadowed keys against them → returns an error if an unapproved overlap would make the lower action unreachable.

**Call relations**: RuntimeKeymap::validate_conflicts uses it for app versus list or approval shortcuts, request-user-input behavior, and main-surface handlers versus editor shortcuts. It models the real order in which input handlers see key presses.

*Call graph*: called by 1 (validate_conflicts); 3 external calls (new, format!, iter).


##### `validate_no_reserved`  (lines 1751–1782)

```
fn validate_no_reserved(
    context: &str,
    pairs: [(&'static str, &[KeyBinding]); N],
    reserved: &[(&'static str, KeyBinding)],
    allowed_overlaps: [(&'static str, &'static str, KeyBinding);
```

**Purpose**: Stops configurable actions from using keys that are still hard-coded for fixed behavior. This avoids letting a user configure a shortcut that the app would never deliver to that action.

**Data flow**: It receives configured action bindings, a reserved-key list, and allowed exceptions → compares each configured key with reserved keys → returns an explanatory error on forbidden overlap or success otherwise.

**Call relations**: RuntimeKeymap::validate_conflicts calls it for main-screen reserved shortcuts and transcript pager backtracking keys. It protects fixed input paths that are not part of this configurable keymap.

*Call graph*: called by 1 (validate_conflicts); 2 external calls (format!, iter).


##### `resolve_bindings_with_global_fallback`  (lines 1835–1848)

```
fn resolve_bindings_with_global_fallback(
    configured: Option<&KeybindingsSpec>,
    global: Option<&KeybindingsSpec>,
    fallback: &[KeyBinding],
    path: &str,
) -> Result<Vec<KeyBinding>, Stri
```

**Purpose**: Resolves one action whose shortcut can come from a context-specific setting, then a global setting, then built-in defaults. It treats an explicitly configured empty list as a real choice to remove the binding.

**Data flow**: It receives optional context config, optional global config, fallback bindings, and a config path → parses the first configured source that exists → otherwise copies the fallback bindings → returns the resolved list or a parse error.

**Call relations**: The resolve_with_global macro expands to this during RuntimeKeymap::from_config for actions such as composer submit, queue, and shortcut toggling. It hands parsing to parse_bindings when user text is present.

*Call graph*: calls 1 internal fn (parse_bindings); 1 external calls (to_vec).


##### `resolve_bindings`  (lines 1854–1863)

```
fn resolve_bindings(
    configured: Option<&KeybindingsSpec>,
    fallback: &[KeyBinding],
    path: &str,
) -> Result<Vec<KeyBinding>, String>
```

**Purpose**: Resolves one action that only uses its own context and the built-in default. It is the standard path for most keymap entries.

**Data flow**: It receives optional configured key specs, fallback bindings, and a config path → if configured, parses those specs; if missing, copies the fallback → returns a list of concrete bindings or an error.

**Call relations**: RuntimeKeymap::from_config calls this directly and through the resolve_local macro for most actions. It passes user-provided strings to parse_bindings.

*Call graph*: calls 1 internal fn (parse_bindings); called by 1 (from_config); 1 external calls (to_vec).


##### `configured_bindings_to_preserve`  (lines 1865–1880)

```
fn configured_bindings_to_preserve(
    pairs: [(Option<&KeybindingsSpec>, &[KeyBinding]); N],
) -> Vec<KeyBinding>
```

**Purpose**: Collects the resolved keys from actions the user explicitly configured, so newer default shortcuts can avoid taking those keys away. This helps old configurations keep working after new default actions are added.

**Data flow**: It receives pairs of optional config entries and their resolved bindings → skips actions not explicitly configured → gathers unique bindings from configured actions → returns that preservation list.

**Call relations**: RuntimeKeymap::from_config calls it before pruning compatibility defaults in Vim, list, and approval-related areas. The returned list is used by retain filters or resolve_new_default_bindings.

*Call graph*: called by 1 (from_config); 1 external calls (new).


##### `configured_main_surface_alias_is_used`  (lines 1882–1904)

```
fn configured_main_surface_alias_is_used(keymap: &TuiKeymap, alias: &str) -> bool
```

**Purpose**: Checks whether a specific shortcut text, such as shift-up, appears anywhere on the main input path. It is used to decide whether fallback reasoning-effort arrow shortcuts should step aside.

**Data flow**: It receives the whole TuiKeymap and an alias string → adjusts global fallback fields that are overridden by composer-specific entries → searches global, chat, composer, editor, and Vim config sections → returns true if that alias appears.

**Call relations**: RuntimeKeymap::from_config calls it when deciding whether to remove default shift-up or shift-down reasoning shortcuts. It delegates each section search to configured_context_alias_is_used.

*Call graph*: calls 1 internal fn (configured_context_alias_is_used); called by 1 (from_config).


##### `configured_context_alias_is_used`  (lines 1906–1911)

```
fn configured_context_alias_is_used(context: &impl Serialize, alias: &str) -> bool
```

**Purpose**: Searches one serializable keymap context for a shortcut alias string. It uses serialization so the search can work across different context struct shapes.

**Data flow**: It receives a context object and alias text → converts the context to a JSON-like value → recursively searches that value → returns true if the alias is present, or false if conversion fails or no match exists.

**Call relations**: configured_main_surface_alias_is_used calls this for each relevant keymap section. It hands the recursive walking work to keymap_value_contains_alias.

*Call graph*: calls 1 internal fn (keymap_value_contains_alias); called by 1 (configured_main_surface_alias_is_used); 1 external calls (to_value).


##### `keymap_value_contains_alias`  (lines 1913–1926)

```
fn keymap_value_contains_alias(value: &serde_json::Value, alias: &str) -> bool
```

**Purpose**: Recursively looks through a JSON-like value for one exact shortcut alias string. It is a small search helper for configuration compatibility checks.

**Data flow**: It receives a JSON value and alias text → compares strings directly, scans arrays item by item, and scans object values → returns true on the first match or false for non-string primitive values and misses.

**Call relations**: configured_context_alias_is_used calls this after converting a config section to a generic value. It does not know about keymaps specifically; it only searches nested data.

*Call graph*: called by 1 (configured_context_alias_is_used).


##### `resolve_new_default_bindings`  (lines 1928–1942)

```
fn resolve_new_default_bindings(
    configured: Option<&KeybindingsSpec>,
    fallback: &[KeyBinding],
    configured_bindings_to_preserve: &[KeyBinding],
    path: &str,
) -> Result<Vec<KeyBinding>,
```

**Purpose**: Resolves defaults for newer actions while avoiding keys the user already configured elsewhere. This lets new default shortcuts be added without breaking older customized setups.

**Data flow**: It receives optional configured specs, fallback defaults, bindings to preserve, and a config path → if configured, parses the user specs exactly → if missing, copies only fallback keys not in the preserve list → returns the resulting bindings.

**Call relations**: RuntimeKeymap::from_config calls it for newer list actions such as page and jump movement. It uses parse_bindings when the user explicitly sets the action.

*Call graph*: calls 1 internal fn (parse_bindings); called by 1 (from_config); 1 external calls (iter).


##### `parse_bindings`  (lines 1948–1964)

```
fn parse_bindings(spec: &KeybindingsSpec, path: &str) -> Result<Vec<KeyBinding>, String>
```

**Purpose**: Parses one config value that may contain one shortcut string or a list of shortcut strings. It also removes repeated entries while keeping the first occurrence for UI hints.

**Data flow**: It receives a KeybindingsSpec and config path → iterates through the raw strings → parses each one with parse_keybinding → collects unique KeyBinding values → returns them or an error that names the bad config path.

**Call relations**: The binding-resolution helpers call this whenever user configuration is present. It delegates the syntax details for each individual shortcut to parse_keybinding.

*Call graph*: calls 2 internal fn (specs, parse_keybinding); called by 3 (resolve_bindings, resolve_bindings_with_global_fallback, resolve_new_default_bindings); 1 external calls (new).


##### `parse_keybinding`  (lines 1970–2022)

```
fn parse_keybinding(spec: &str) -> Option<KeyBinding>
```

**Purpose**: Turns a normalized shortcut string like ctrl-a, shift-enter, page-down, or f12 into a concrete KeyBinding. It is strict so invalid config produces clear errors.

**Data flow**: It receives one string → reads any ctrl, alt, and shift modifiers → parses the remaining key name as a named key, character, minus alias, space, or allowed function key → returns a KeyBinding, or nothing if the string is invalid.

**Call relations**: parse_bindings calls it for every configured shortcut. Tests also call it directly to document supported syntax and rejected forms.

*Call graph*: calls 1 internal fn (new); called by 2 (parse_bindings, parses_canonical_binding); 3 external calls (Char, F, from).


##### `tests::one`  (lines 2029–2031)

```
fn one(spec: &str) -> KeybindingsSpec
```

**Purpose**: Creates a single-key KeybindingsSpec for tests. It keeps test setup short and readable.

**Data flow**: It receives a shortcut string → wraps it in the config types used by the real parser → returns a one-entry KeybindingsSpec.

**Call relations**: Many tests call this when they need to configure one shortcut. It feeds values into RuntimeKeymap::from_config through test keymaps.

*Call graph*: 2 external calls (new, One).


##### `tests::expect_conflict`  (lines 2033–2037)

```
fn expect_conflict(keymap: &TuiKeymap, first: &str, second: &str)
```

**Purpose**: Asserts that a test keymap fails validation and that the error mentions two expected action names. It avoids repeating the same error-checking code in many tests.

**Data flow**: It receives a keymap and two strings to look for → calls RuntimeKeymap::from_config expecting an error → checks that both strings appear in the message.

**Call relations**: Conflict-focused tests call this helper after setting up overlapping shortcuts. It exercises the same from_config validation path used in the real app.

*Call graph*: calls 1 internal fn (from_config); 1 external calls (assert!).


##### `tests::parses_canonical_binding`  (lines 2040–2047)

```
fn parses_canonical_binding()
```

**Purpose**: Tests that a shortcut with ctrl, alt, and shift modifiers parses correctly. It confirms combined modifiers are preserved.

**Data flow**: It provides ctrl-alt-shift-a → parses it → checks that the key is a and the modifier set contains control, alt, and shift.

**Call relations**: The test runner calls this as part of the unit suite. It directly exercises parse_keybinding.

*Call graph*: calls 1 internal fn (parse_keybinding); 1 external calls (assert_eq!).


##### `tests::rejects_shadowing_composer_binding_in_app_scope`  (lines 2050–2058)

```
fn rejects_shadowing_composer_binding_in_app_scope()
```

**Purpose**: Tests that an app-level shortcut cannot also be used for composer submit. This protects against the app catching the key before the composer sees it.

**Data flow**: It builds a default keymap → assigns ctrl-t to both open transcript and composer submit → resolves the config expecting an error mentioning both actions.

**Call relations**: The test runner calls it. It uses one and RuntimeKeymap::from_config to cover app-scope shadow validation.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_composer_queue_in_app_scope`  (lines 2061–2069)

```
fn rejects_shadowing_composer_queue_in_app_scope()
```

**Purpose**: Tests that composer queue cannot reuse a key already used by an app-level action. This avoids an unreachable queue shortcut.

**Data flow**: It creates a default keymap → sets open external editor and composer queue to ctrl-g → expects from_config to return a conflict naming both actions.

**Call relations**: The test runner calls it. It checks the validation path that compares app handlers against composer handlers.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_composer_toggle_shortcuts_in_app_scope`  (lines 2072–2080)

```
fn rejects_shadowing_composer_toggle_shortcuts_in_app_scope()
```

**Purpose**: Tests that the composer shortcut overlay key cannot be shadowed by an app-level key. This keeps the overlay shortcut usable.

**Data flow**: It configures open transcript and composer toggle shortcuts to ctrl-k → runs keymap resolution → verifies the conflict message names both actions.

**Call relations**: The test runner calls it. It relies on RuntimeKeymap::from_config and the app-scope conflict checks.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_editor_binding_in_main_scope`  (lines 2083–2091)

```
fn rejects_shadowing_editor_binding_in_main_scope()
```

**Purpose**: Tests that a main-surface composer action cannot steal a key intended for the editor inside the composer. This reflects the actual input order.

**Data flow**: It sets composer submit and editor insert-newline to ctrl-j → resolves the keymap expecting an error → checks that both action names are present.

**Call relations**: The test runner calls it. It covers the shadow check between main handlers and editor handlers.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_editor_binding_from_outer_main_handler`  (lines 2094–2102)

```
fn rejects_shadowing_editor_binding_from_outer_main_handler()
```

**Purpose**: Tests that a global app shortcut cannot reuse an editor shortcut key. This prevents editor behavior from being silently blocked.

**Data flow**: It assigns ctrl-y to global copy and editor yank → calls from_config → asserts the error mentions copy and editor.yank.

**Call relations**: The test runner calls it. It exercises main-versus-editor shadow validation.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_approval_binding_in_app_scope`  (lines 2105–2112)

```
fn rejects_shadowing_approval_binding_in_app_scope()
```

**Purpose**: Tests that app-level shortcuts cannot shadow approval dialog shortcuts. This keeps approval choices reachable when overlays are active.

**Data flow**: It sets global open transcript to y, which overlaps approval approve → resolves the keymap → expects a conflict.

**Call relations**: The test runner calls it. It checks app-versus-approval overlap validation.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_list_binding_in_app_scope`  (lines 2115–2122)

```
fn rejects_shadowing_list_binding_in_app_scope()
```

**Purpose**: Tests that app-level shortcuts cannot shadow list navigation keys. This protects popup list movement.

**Data flow**: It sets global copy to down → resolves the keymap where list move-down also uses down by default → expects an error naming both sides.

**Call relations**: The test runner calls it. It covers app-versus-list shadow detection.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::supports_string_or_array_bindings`  (lines 2125–2142)

```
fn supports_string_or_array_bindings()
```

**Purpose**: Tests that shortcut config can be a single string or a list of strings, and that bad modifiers are rejected. It documents accepted multi-binding behavior.

**Data flow**: It first configures submit with ctrl-enter and invalid meta-enter → expects a parse error → then replaces it with ctrl-enter and ctrl-shift-enter → expects two resolved bindings.

**Call relations**: The test runner calls it. It exercises RuntimeKeymap::from_config, parse_bindings, and parse_keybinding through real config objects.

*Call graph*: calls 1 internal fn (from_config); 5 external calls (assert!, assert_eq!, Many, default, vec!).


##### `tests::deduplicates_repeated_bindings_while_preserving_first_seen_order`  (lines 2145–2161)

```
fn deduplicates_repeated_bindings_while_preserving_first_seen_order()
```

**Purpose**: Tests that repeated shortcut entries do not create duplicates, while the original order is kept. This matters because the first key is used as the primary UI hint.

**Data flow**: It configures submit with ctrl-enter twice and ctrl-shift-enter once → resolves the keymap → checks the result contains each unique binding in first-seen order.

**Call relations**: The test runner calls it. It verifies parse_bindings behavior through RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 4 external calls (assert_eq!, Many, default, vec!).


##### `tests::falls_back_to_global_binding_when_context_override_is_not_set`  (lines 2164–2173)

```
fn falls_back_to_global_binding_when_context_override_is_not_set()
```

**Purpose**: Tests that composer actions with global fallback use the global shortcut when no context-specific shortcut is set.

**Data flow**: It sets global queue to ctrl-q and leaves composer queue unset → resolves the keymap → checks composer queue uses ctrl-q.

**Call relations**: The test runner calls it. It covers resolve_bindings_with_global_fallback as used by RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::invalid_global_open_transcript_binding_reports_global_path`  (lines 2176–2182)

```
fn invalid_global_open_transcript_binding_reports_global_path()
```

**Purpose**: Tests that a bad global open-transcript shortcut reports the correct config path. This helps users fix the right setting.

**Data flow**: It sets global open_transcript to invalid meta-t → resolves the keymap expecting an error → checks the error includes tui.keymap.global.open_transcript.

**Call relations**: The test runner calls it. It verifies parse errors created during RuntimeKeymap::from_config are user-facing and path-specific.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::invalid_global_open_external_editor_binding_reports_global_path`  (lines 2185–2191)

```
fn invalid_global_open_external_editor_binding_reports_global_path()
```

**Purpose**: Tests that a bad global external-editor shortcut reports the correct config path.

**Data flow**: It sets global open_external_editor to invalid meta-g → calls from_config → checks the error text points to tui.keymap.global.open_external_editor.

**Call relations**: The test runner calls it. It covers parse error reporting for global app actions.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::default_copy_binding_is_ctrl_o`  (lines 2194–2197)

```
fn default_copy_binding_is_ctrl_o()
```

**Purpose**: Tests the default copy shortcut. It locks in Ctrl-O as the built-in binding.

**Data flow**: It creates the default runtime keymap → reads app.copy → checks it equals ctrl-o.

**Call relations**: The test runner calls it. It uses RuntimeKeymap::defaults, which delegates to built_in_defaults.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::defaults_include_reassignable_main_surface_actions`  (lines 2200–2239)

```
fn defaults_include_reassignable_main_surface_actions()
```

**Purpose**: Tests several default main-surface shortcuts that users can remap. It also confirms some actions intentionally start without a default key.

**Data flow**: It builds defaults → checks clear terminal, fast mode, interrupt, reasoning effort, edit queued message, history search, and kill-whole-line defaults → succeeds only if they match expected bindings.

**Call relations**: The test runner calls it. It documents built_in_defaults for important app, chat, composer, and editor actions.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::defaults_include_list_page_and_jump_actions`  (lines 2242–2296)

```
fn defaults_include_list_page_and_jump_actions()
```

**Purpose**: Tests default navigation shortcuts for list popups. It confirms movement, paging, and top or bottom jumps use the expected keys.

**Data flow**: It builds defaults → reads list key bindings → compares each list action with the expected default key list.

**Call relations**: The test runner calls it. It documents list defaults from RuntimeKeymap::built_in_defaults.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::configured_main_surface_bindings_prune_reasoning_fallback_aliases`  (lines 2299–2319)

```
fn configured_main_surface_bindings_prune_reasoning_fallback_aliases()
```

**Purpose**: Tests that default reasoning shortcuts using shift-up or shift-down step aside when the user explicitly uses those keys elsewhere on the main input path.

**Data flow**: It configures editor and Vim text-object actions to use shift-up and shift-down → resolves the keymap → checks those configured actions keep the keys and reasoning effort loses the fallback arrow aliases.

**Call relations**: The test runner calls it. It exercises configured_main_surface_alias_is_used and the pruning logic inside RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_reasoning_binding_still_conflicts_with_editor_binding`  (lines 2322–2328)

```
fn explicit_reasoning_binding_still_conflicts_with_editor_binding()
```

**Purpose**: Tests that pruning only applies to fallback reasoning shortcuts, not explicit user choices. If the user explicitly assigns a conflict, the resolver should reject it.

**Data flow**: It sets editor move-up and chat increase reasoning effort to shift-up → expects from_config to fail with both action names.

**Call relations**: The test runner calls it. It uses expect_conflict to verify validation after explicit configuration.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_list_bindings_prune_new_default_overlaps`  (lines 2331–2351)

```
fn configured_legacy_list_bindings_prune_new_default_overlaps()
```

**Purpose**: Tests that older custom list movement bindings can keep keys that newer default page actions would otherwise use.

**Data flow**: It configures list move-up to page-up and move-down to page-down → resolves the keymap → checks page actions lose those overlapping defaults but keep other defaults.

**Call relations**: The test runner calls it. It covers configured_bindings_to_preserve and resolve_new_default_bindings.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::configured_legacy_list_bindings_can_prune_all_new_default_keys`  (lines 2354–2371)

```
fn configured_legacy_list_bindings_can_prune_all_new_default_keys()
```

**Purpose**: Tests that a new default action can end up with no keys if all of its default keys are already explicitly used by older custom bindings.

**Data flow**: It configures list move-up to page-up and ctrl-b → resolves the keymap → checks list page-up becomes empty.

**Call relations**: The test runner calls it. It verifies the preservation list can remove every fallback key from a newer action.

*Call graph*: calls 1 internal fn (from_config); 4 external calls (assert_eq!, Many, default, vec!).


##### `tests::explicit_new_list_bindings_still_conflict_with_legacy_bindings`  (lines 2374–2380)

```
fn explicit_new_list_bindings_still_conflict_with_legacy_bindings()
```

**Purpose**: Tests that explicit new list bindings are not silently pruned. If the user sets both old and new actions to the same key, it should be reported as a conflict.

**Data flow**: It sets list move-up and list page-up to page-up → expects conflict validation to fail.

**Call relations**: The test runner calls it. It uses expect_conflict to confirm validate_unique still applies after explicit configuration.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_app_bindings_prune_new_list_default_overlaps`  (lines 2383–2394)

```
fn configured_app_bindings_prune_new_list_default_overlaps()
```

**Purpose**: Tests that explicit app-level bindings can preserve their key by pruning overlapping newer list defaults.

**Data flow**: It sets global copy to page-down → resolves the keymap → checks copy keeps page-down and list page-down loses its overlapping page-down default.

**Call relations**: The test runner calls it. It exercises the preservation list built in RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::configured_approval_bindings_prune_new_list_default_overlaps`  (lines 2397–2408)

```
fn configured_approval_bindings_prune_new_list_default_overlaps()
```

**Purpose**: Tests that explicit approval bindings can also prune overlapping newer list defaults.

**Data flow**: It sets approval approve to home → resolves the keymap → checks approval approve keeps home and list jump-top becomes empty.

**Call relations**: The test runner calls it. It covers compatibility pruning across approval and list overlay shortcuts.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_list_bindings_still_conflict_with_configured_approval_bindings`  (lines 2411–2417)

```
fn explicit_new_list_bindings_still_conflict_with_configured_approval_bindings()
```

**Purpose**: Tests that if the user explicitly configures a list binding to overlap an approval binding, the resolver reports it instead of pruning it.

**Data flow**: It sets approval approve and list jump-top both to home → expects from_config to fail with a conflict.

**Call relations**: The test runner calls it. It verifies explicit settings remain authoritative and are validated.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_vim_normal_bindings_prune_new_change_operator_default`  (lines 2420–2431)

```
fn configured_legacy_vim_normal_bindings_prune_new_change_operator_default()
```

**Purpose**: Tests that an older Vim normal-mode custom binding can keep the c key by pruning the newer change-operator default.

**Data flow**: It sets vim normal move-left to c → resolves the keymap → checks move-left has c and start-change-operator has no default binding.

**Call relations**: The test runner calls it. It covers Vim normal compatibility pruning in RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_vim_normal_binding_still_conflicts_with_legacy_binding`  (lines 2434–2440)

```
fn explicit_new_vim_normal_binding_still_conflicts_with_legacy_binding()
```

**Purpose**: Tests that explicitly assigning the newer Vim change operator to a key already used by another Vim normal action is rejected.

**Data flow**: It sets move-left and start-change-operator to c → expects a conflict.

**Call relations**: The test runner calls it. It verifies validate_unique for the vim_normal context.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_vim_normal_bindings_prune_new_substitute_default`  (lines 2443–2454)

```
fn configured_legacy_vim_normal_bindings_prune_new_substitute_default()
```

**Purpose**: Tests that an older Vim normal-mode custom binding can keep the s key by pruning the newer substitute-character default.

**Data flow**: It sets vim normal move-left to s → resolves the keymap → checks substitute_char has no default binding.

**Call relations**: The test runner calls it. It exercises the compatibility pruning for substitute_char.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_vim_normal_substitute_binding_still_conflicts_with_legacy_binding`  (lines 2457–2463)

```
fn explicit_new_vim_normal_substitute_binding_still_conflicts_with_legacy_binding()
```

**Purpose**: Tests that an explicit substitute-character binding still conflicts if it duplicates another Vim normal binding.

**Data flow**: It sets move-left and substitute_char to s → expects a conflict mentioning both actions.

**Call relations**: The test runner calls it. It confirms validation is not bypassed for explicit new bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_vim_operator_bindings_prune_new_text_object_defaults`  (lines 2466–2483)

```
fn configured_legacy_vim_operator_bindings_prune_new_text_object_defaults()
```

**Purpose**: Tests that older Vim operator-mode custom bindings can keep i and a by pruning newer text-object prefix defaults.

**Data flow**: It sets operator motion-left to i and motion-right to a → resolves the keymap → checks text-object prefix bindings are empty.

**Call relations**: The test runner calls it. It covers compatibility pruning in the vim_operator section.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_vim_operator_binding_still_conflicts_with_legacy_binding`  (lines 2486–2492)

```
fn explicit_new_vim_operator_binding_still_conflicts_with_legacy_binding()
```

**Purpose**: Tests that explicitly assigning a new Vim operator text-object prefix to a key already used by another operator action is rejected.

**Data flow**: It sets operator motion-left and select-inner-text-object to i → expects conflict validation to fail.

**Call relations**: The test runner calls it. It verifies validate_unique for vim_operator.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::vim_normal_defaults_include_insert_and_arrow_aliases`  (lines 2495–2533)

```
fn vim_normal_defaults_include_insert_and_arrow_aliases()
```

**Purpose**: Tests important Vim normal-mode default aliases. It confirms both classic letter keys and arrow or insert aliases exist.

**Data flow**: It builds defaults → checks enter-insert and movement bindings → compares them with the expected key lists.

**Call relations**: The test runner calls it. It documents default Vim normal behavior from built_in_defaults.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::invalid_global_copy_binding_reports_global_path`  (lines 2536–2542)

```
fn invalid_global_copy_binding_reports_global_path()
```

**Purpose**: Tests that an invalid global copy shortcut points users to the correct config setting.

**Data flow**: It sets global copy to invalid meta-o → resolves the keymap expecting an error → checks the path appears in the message.

**Call relations**: The test runner calls it. It exercises parse error reporting through RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_conflicting_editor_bindings`  (lines 2545–2551)

```
fn rejects_conflicting_editor_bindings()
```

**Purpose**: Tests that two editor actions cannot share the same key. This keeps text editing behavior unambiguous.

**Data flow**: It sets editor move-left and move-right to ctrl-h → expects a conflict.

**Call relations**: The test runner calls it. It uses expect_conflict to cover validate_unique for the editor context.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_pager_bindings`  (lines 2554–2560)

```
fn rejects_conflicting_pager_bindings()
```

**Purpose**: Tests that pager actions cannot share the same key. This keeps transcript and help overlay navigation clear.

**Data flow**: It sets pager scroll-up and scroll-down to ctrl-u → expects from_config to report a conflict.

**Call relations**: The test runner calls it. It covers pager duplicate validation.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_list_bindings`  (lines 2563–2575)

```
fn rejects_conflicting_list_bindings()
```

**Purpose**: Tests duplicate detection for list movement keys. It covers both vertical and horizontal movement conflicts.

**Data flow**: It first sets list move-up and move-down to up and expects a conflict → then sets move-left and move-right to left and expects another conflict.

**Call relations**: The test runner calls it. It uses expect_conflict to exercise list validation.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_list_page_and_jump_bindings`  (lines 2578–2584)

```
fn rejects_conflicting_list_page_and_jump_bindings()
```

**Purpose**: Tests that list paging and jump actions cannot use the same key. This avoids ambiguous navigation in list popups.

**Data flow**: It sets list page-up and jump-top to home → expects a conflict naming both actions.

**Call relations**: The test runner calls it. It covers validate_unique within the list context.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_bindings`  (lines 2587–2593)

```
fn rejects_conflicting_approval_bindings()
```

**Purpose**: Tests that approval and decline cannot share a shortcut. This is especially important because they mean opposite decisions.

**Data flow**: It sets approval approve and decline to y → expects conflict validation to fail.

**Call relations**: The test runner calls it. It checks approval-context uniqueness.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_deny_binding`  (lines 2596–2602)

```
fn rejects_conflicting_approval_deny_binding()
```

**Purpose**: Tests that approval approve and deny cannot use the same key. This prevents dangerous ambiguity in permission dialogs.

**Data flow**: It sets approve and deny to y → expects from_config to report a conflict.

**Call relations**: The test runner calls it. It uses expect_conflict against approval validation.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_overlay_accept_binding`  (lines 2605–2610)

```
fn rejects_conflicting_approval_overlay_accept_binding()
```

**Purpose**: Tests that list accept cannot overlap approval approve in the combined approval overlay surface.

**Data flow**: It sets list accept to y while approval approve defaults to y → expects an approval overlay conflict.

**Call relations**: The test runner calls it. It covers the special combined list-plus-approval conflict check in validate_conflicts.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_overlay_cancel_binding`  (lines 2613–2618)

```
fn rejects_conflicting_approval_overlay_cancel_binding()
```

**Purpose**: Tests that list cancel cannot overlap approval cancel in the combined approval overlay surface.

**Data flow**: It sets list cancel to c while approval cancel defaults to c → expects a conflict.

**Call relations**: The test runner calls it. It verifies the approval overlay cross-context conflict check.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::reassignable_fixed_shortcuts_conflict_until_original_action_is_unbound`  (lines 2621–2630)

```
fn reassignable_fixed_shortcuts_conflict_until_original_action_is_unbound()
```

**Purpose**: Tests that a shortcut can be reused only after the original configurable action using it is unbound. This models safe remapping.

**Data flow**: It sets copy to alt-. while reasoning increase also uses alt-. by default → expects conflict → then unbinds reasoning increase → resolves successfully and checks copy uses alt-.

**Call relations**: The test runner calls it. It combines expect_conflict, explicit empty bindings, and RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 6 external calls (assert_eq!, Many, default, expect_conflict, one, vec!).


##### `tests::kill_whole_line_can_be_assigned_without_default_binding`  (lines 2633–2646)

```
fn kill_whole_line_can_be_assigned_without_default_binding()
```

**Purpose**: Tests that an action with no default shortcut can still be assigned by the user.

**Data flow**: It sets editor kill_whole_line to ctrl-shift-u → resolves the keymap → checks the binding appears exactly.

**Call relations**: The test runner calls it. It documents that empty defaults do not mean an action is unavailable.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::kill_whole_line_conflicts_until_kill_line_start_is_unbound`  (lines 2649–2661)

```
fn kill_whole_line_conflicts_until_kill_line_start_is_unbound()
```

**Purpose**: Tests that assigning kill_whole_line to an existing editor shortcut conflicts until the old action is explicitly unbound.

**Data flow**: It sets kill_whole_line to ctrl-u and expects conflict with kill_line_start → then unbinds kill_line_start → resolves successfully.

**Call relations**: The test runner calls it. It verifies unbinding and duplicate validation for editor actions.

*Call graph*: calls 1 internal fn (from_config); 6 external calls (assert_eq!, Many, default, expect_conflict, one, vec!).


##### `tests::toggle_fast_mode_can_be_assigned_without_default_binding`  (lines 2664–2677)

```
fn toggle_fast_mode_can_be_assigned_without_default_binding()
```

**Purpose**: Tests that global toggle_fast_mode, which has no default key, can be configured by the user.

**Data flow**: It assigns ctrl-shift-f to toggle_fast_mode → resolves the keymap → checks the binding is present.

**Call relations**: The test runner calls it. It covers user assignment for an empty-default app action.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::toggle_fast_mode_conflicts_with_existing_main_surface_bindings`  (lines 2680–2685)

```
fn toggle_fast_mode_conflicts_with_existing_main_surface_bindings()
```

**Purpose**: Tests that a newly assigned fast-mode shortcut still participates in conflict validation.

**Data flow**: It sets toggle_fast_mode to ctrl-l, which overlaps clear_terminal → expects a conflict.

**Call relations**: The test runner calls it. It verifies app-level uniqueness for configurable empty-default actions.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_main_bindings_that_collide_with_remaining_fixed_shortcuts`  (lines 2688–2693)

```
fn rejects_main_bindings_that_collide_with_remaining_fixed_shortcuts()
```

**Purpose**: Tests that configurable main actions cannot use keys reserved for fixed behavior such as image paste.

**Data flow**: It sets composer submit to ctrl-v → resolves the keymap expecting an error → checks the conflict mentions the fixed paste-image shortcut.

**Call relations**: The test runner calls it. It covers validate_no_reserved for main-surface bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::interrupt_turn_allows_backtrack_escape_and_can_be_remapped_or_unbound`  (lines 2696–2714)

```
fn interrupt_turn_allows_backtrack_escape_and_can_be_remapped_or_unbound()
```

**Purpose**: Tests the special treatment of the interrupt shortcut. Escape is allowed by default despite backtrack behavior, and the action can still be remapped or unbound.

**Data flow**: It checks the default interrupt key is Esc → remaps it to f12 and checks that result → then sets an empty list and checks the action has no bindings.

**Call relations**: The test runner calls it. It documents an allowed reserved-key overlap and explicit unbinding behavior.

*Call graph*: calls 1 internal fn (from_config); 6 external calls (assert!, assert_eq!, Many, default, one, vec!).


##### `tests::interrupt_turn_rejects_other_fixed_shortcuts`  (lines 2717–2722)

```
fn interrupt_turn_rejects_other_fixed_shortcuts()
```

**Purpose**: Tests that the interrupt action cannot use unrelated fixed shortcuts. Only the intended Escape overlap is allowed.

**Data flow**: It sets interrupt_turn to ctrl-v → expects conflict with fixed paste-image.

**Call relations**: The test runner calls it. It covers validate_no_reserved exceptions for the main context.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::interrupt_turn_rejects_request_user_input_question_navigation_bindings`  (lines 2725–2731)

```
fn interrupt_turn_rejects_request_user_input_question_navigation_bindings()
```

**Purpose**: Tests that interrupt-turn cannot shadow question navigation keys in the request-user-input overlay.

**Data flow**: It sets interrupt_turn and list move-right to f12 → expects a conflict between those paths.

**Call relations**: The test runner calls it. It exercises the request_user_input shadow validation in validate_conflicts.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_pager_bindings_that_collide_with_transcript_backtrack_keys`  (lines 2734–2739)

```
fn rejects_pager_bindings_that_collide_with_transcript_backtrack_keys()
```

**Purpose**: Tests that transcript pager shortcuts cannot use keys reserved for transcript edit backtracking.

**Data flow**: It sets pager close to left → expects a conflict with the fixed transcript edit-previous key.

**Call relations**: The test runner calls it. It covers validate_no_reserved for pager bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::parses_function_keys_and_rejects_out_of_range_function_keys`  (lines 2742–2752)

```
fn parses_function_keys_and_rejects_out_of_range_function_keys()
```

**Purpose**: Tests parsing of function keys like F1 and F24, and rejection of a function key outside the supported range.

**Data flow**: It parses f1, f24, and f25 → checks the first two produce function-key bindings and the last produces no binding.

**Call relations**: The test runner calls it. It directly documents parse_keybinding’s function-key limits.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_all_named_non_character_keys`  (lines 2755–2780)

```
fn parses_all_named_non_character_keys()
```

**Purpose**: Tests parsing for named non-character keys such as tab, arrows, home, page-down, space, and minus.

**Data flow**: It loops through expected name-to-key pairs → parses each name → checks the resulting key code has no modifiers and matches the expected key.

**Call relations**: The test runner calls it. It documents supported names in parse_keybinding.

*Call graph*: 2 external calls (Char, assert_eq!).


##### `tests::rejects_modifier_only_and_nonnumeric_function_key_specs`  (lines 2783–2786)

```
fn rejects_modifier_only_and_nonnumeric_function_key_specs()
```

**Purpose**: Tests that incomplete or malformed shortcut strings are rejected.

**Data flow**: It parses ctrl and ff → checks both return no binding.

**Call relations**: The test runner calls it. It directly exercises parse_keybinding’s strict failure behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_minus_alias_and_legacy_literal_minus`  (lines 2789–2802)

```
fn parses_minus_alias_and_legacy_literal_minus()
```

**Purpose**: Tests both the named minus alias and older literal minus syntax. This preserves compatibility with existing configs.

**Data flow**: It parses alt-minus, alt--, and - → checks all produce the expected minus-key bindings with the right modifiers.

**Call relations**: The test runner calls it. It documents special minus handling in parse_keybinding.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_empty_array_unbinds_action`  (lines 2805–2810)

```
fn explicit_empty_array_unbinds_action()
```

**Purpose**: Tests that an explicitly empty binding list removes an action’s shortcut rather than falling back to defaults.

**Data flow**: It sets composer toggle_shortcuts to an empty list → resolves the keymap → checks the resulting binding list is empty.

**Call relations**: The test runner calls it. It verifies the unbinding rule implemented by resolve_bindings and related helpers.

*Call graph*: calls 1 internal fn (from_config); 4 external calls (assert!, Many, default, vec!).


##### `tests::raw_output_toggle_defaults_to_alt_r`  (lines 2813–2819)

```
fn raw_output_toggle_defaults_to_alt_r()
```

**Purpose**: Tests the default shortcut for toggling raw output mode.

**Data flow**: It builds defaults → checks app.toggle_raw_output equals alt-r.

**Call relations**: The test runner calls it. It documents the built-in default for raw scrollback mode.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::raw_output_toggle_can_be_remapped`  (lines 2822–2832)

```
fn raw_output_toggle_can_be_remapped()
```

**Purpose**: Tests that the raw output toggle shortcut can be changed by user configuration.

**Data flow**: It sets global toggle_raw_output to f12 → resolves the keymap → checks the action uses F12.

**Call relations**: The test runner calls it. It covers remapping of a global app action through RuntimeKeymap::from_config.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::default_editor_insert_newline_includes_current_aliases`  (lines 2835–2847)

```
fn default_editor_insert_newline_includes_current_aliases()
```

**Purpose**: Tests all default editor shortcuts that insert a newline. Different terminals may send different key forms, so multiple aliases are expected.

**Data flow**: It builds defaults → reads editor.insert_newline → compares it with the expected list of control, plain, shift, and alt Enter variants.

**Call relations**: The test runner calls it. It documents compatibility aliases in built_in_defaults.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::default_editor_delete_forward_word_includes_alt_d`  (lines 2850–2858)

```
fn default_editor_delete_forward_word_includes_alt_d()
```

**Purpose**: Tests that Alt-D remains a default shortcut for deleting the next word.

**Data flow**: It builds defaults → checks editor.delete_forward_word contains alt-d.

**Call relations**: The test runner calls it. It guards an editor default expected by users familiar with common shell shortcuts.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::default_editor_deletion_includes_modified_backspace_delete_aliases`  (lines 2861–2906)

```
fn default_editor_deletion_includes_modified_backspace_delete_aliases()
```

**Purpose**: Tests that deletion defaults include several modified Backspace and Delete aliases. This improves behavior across terminals that report these keys differently.

**Data flow**: It builds defaults → checks delete-backward, delete-forward, delete-backward-word, and delete-forward-word contain the expected shifted and control-modified variants.

**Call relations**: The test runner calls it. It documents terminal-compatibility defaults in the editor keymap.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::default_composer_toggle_shortcuts_includes_shift_question_mark`  (lines 2909–2917)

```
fn default_composer_toggle_shortcuts_includes_shift_question_mark()
```

**Purpose**: Tests that the composer shortcut overlay can be opened with a shifted question-mark form.

**Data flow**: It builds defaults → checks composer.toggle_shortcuts contains shift-?.

**Call relations**: The test runner calls it. It guards a compatibility variant in built_in_defaults.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::default_approval_open_fullscreen_includes_ctrl_shift_a`  (lines 2920–2926)

```
fn default_approval_open_fullscreen_includes_ctrl_shift_a()
```

**Purpose**: Tests that approval details can be opened with Ctrl-Shift-A as one default shortcut.

**Data flow**: It builds defaults → checks approval.open_fullscreen contains the combined control-and-shift binding for a.

**Call relations**: The test runner calls it. It documents a multi-modifier approval default.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::primary_binding_returns_first_or_none`  (lines 2929–2939)

```
fn primary_binding_returns_first_or_none()
```

**Purpose**: Tests the small helper that chooses the display shortcut for an action.

**Data flow**: It creates a two-binding list and checks primary_binding returns the first item → then passes an empty list and checks it returns none.

**Call relations**: The test runner calls it. It directly exercises primary_binding.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::defaults_pass_conflict_validation`  (lines 2942–2946)

```
fn defaults_pass_conflict_validation()
```

**Purpose**: Tests that the built-in keymap is internally safe. If this fails, the app would ship with ambiguous default shortcuts.

**Data flow**: It builds the default runtime keymap → runs validate_conflicts → expects success.

**Call relations**: The test runner calls it. It links RuntimeKeymap::defaults with the same validation used after user config resolution.

*Call graph*: calls 1 internal fn (defaults).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-cloud-config-cache` — The cached and refreshed cloud-delivered configuration bundles that can alter settings, requirements, and available features.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-collaboration-mode-catalog` — Built-in and configured collaboration-mode presets/templates that clients can list and apply to choose model, mode, reasoning, and prompt behavior.
- `reg-launch-invocation-context` — The raw launch context, including invoked binary/arg0, selected subcommand or runtime mode, startup flags, and output/interaction mode chosen before dispatch.
- `reg-project-trust-store` — Persisted and effective trust decisions for workspaces/projects that influence onboarding, permission assembly, sandbox behavior, and session startup.
