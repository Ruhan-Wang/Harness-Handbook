# Configuration, feature resolution, and startup policy assembly  `stage-4`

This stage is the startup planning desk for the whole system. Before the app can do real work, it has to decide which settings, permissions, and built-in options actually apply. It gathers configuration from many places, such as managed or cloud settings, user and project files, per-thread values, and command-line arguments, then combines them by priority into one final runtime configuration.

One part loads and checks those layers, including requirement files that can restrict sensitive options. Another part resolves feature flags, which are simple on/off switches, and installs built-in assets such as skills, presets, plugin and model catalogs, and starter memory files.

Several files turn that merged input into concrete policy. They compile permission profiles into sandbox and network rules, map them to Windows-specific enforcement when needed, and decide tool behavior, service tiers, keymaps, project-root markers, and helper executable paths. The app server’s config manager is the main doorway other code uses to ask, “what is the current effective config?” Editing helpers let the UI safely update user config, while debug and lockfile support explain or record exactly what settings the session ran with.

## Sub-stages

- [Config layer ingestion and requirements composition](stage-4.1.md) `stage-4.1` — 42 files
- [Feature flags, provider catalogs, and built-in asset installation](stage-4.2.md) `stage-4.2` — 33 files

## Files in this stage

### Config sources and effective assembly
These files define shared CLI and config inputs, expose config-loading facades, and assemble the fully resolved runtime configuration used by the rest of the system.

### `utils/cli/src/shared_options.rs`

`config` · `startup`

This file centers on `SharedCliOptions`, a Clap `Args` struct containing reusable flags such as image attachments, model selection, OSS provider toggles, profile selection, sandbox controls, hook-trust bypass, working directory, and additional writable directories. The struct is intentionally broad because both interactive and non-interactive commands need the same option vocabulary.

The important behavior is in the two merge methods. `inherit_exec_root_options` mutates a child options struct by filling in unset values from a root invocation. Scalar options like `model`, `oss_provider`, `config_profile_v2`, and `cwd` are inherited only when absent; `oss` and `bypass_hook_trust` propagate as enabling booleans. Images are prepended from the root so root-specified attachments come before child attachments, while `add_dir` is similarly prefixed. Sandbox handling is more nuanced: if the child explicitly selected either a sandbox mode or the dangerous bypass flag, root sandbox settings are not allowed to override that choice.

`apply_subcommand_overrides` performs the opposite precedence direction: a subcommand value replaces the current one when explicitly present. Images replace wholesale when the subcommand supplies any, but `add_dir` extends rather than replaces. The same grouped sandbox rule applies so `sandbox_mode` and dangerous bypass are treated as one coherent selection domain.

#### Function details

##### `SharedCliOptions::inherit_exec_root_options`  (lines 66–129)

```
fn inherit_exec_root_options(&mut self, root: &Self)
```

**Purpose**: Merges root-level CLI options into a nested or derived `SharedCliOptions`, filling only gaps and preserving explicit child choices. It also treats sandbox-related flags as a coupled selection so inherited values do not partially override a child sandbox decision.

**Data flow**: It takes `&mut self` and `root: &Self`. It first computes whether `self` already selected sandbox behavior via either `sandbox_mode.is_some()` or `dangerously_bypass_approvals_and_sandbox`. It then destructures both structs into field references and values. Missing `model`, `oss_provider`, `config_profile_v2`, `sandbox_mode`, and `cwd` are cloned from `root`; `oss` and `bypass_hook_trust` are promoted to `true` if enabled in `root`. If `self` did not explicitly choose sandbox behavior, the dangerous bypass flag is inherited from `root`. For `images` and `add_dir`, non-empty root vectors are cloned, appended with the current vectors, and written back so root entries come first.

**Call relations**: This method is part of the CLI configuration assembly path, used when a child command should inherit execution-root defaults. It does not delegate to other local helpers; instead it encodes all precedence rules inline.


##### `SharedCliOptions::apply_subcommand_overrides`  (lines 131–176)

```
fn apply_subcommand_overrides(&mut self, subcommand: Self)
```

**Purpose**: Applies a subcommand's explicit CLI options on top of an existing `SharedCliOptions`, replacing or extending fields according to command precedence rules. It ensures subcommand intent wins where specified.

**Data flow**: It takes `&mut self` and consumes `subcommand: Self`. It computes whether the subcommand explicitly selected sandbox behavior using the same combined check as the inheritance method. After destructuring `subcommand`, it overwrites `self.model`, `self.oss_provider`, `self.config_profile_v2`, and `self.cwd` when the subcommand provides `Some(...)`; sets `self.oss` and `self.bypass_hook_trust` to `true` when requested; and, if sandbox behavior was explicitly selected, replaces both `self.sandbox_mode` and `self.dangerously_bypass_approvals_and_sandbox` together. Non-empty `images` replace `self.images` entirely, while non-empty `add_dir` values are appended onto `self.add_dir`.

**Call relations**: This method is used later in CLI option resolution when a parsed subcommand should override inherited or default settings. Like the inheritance method, it is self-contained and encodes the precedence policy directly.


### `app-server/src/config/mod.rs`

`config` · `config load`

This file is a minimal module declaration for the app server’s configuration area. Its only statement, `pub(crate) mod external_agent_config;`, makes the `external_agent_config` module available throughout the current crate while keeping it hidden from external crates. That visibility choice signals that external-agent configuration is an internal server concern rather than part of the server crate’s public API.

Although there is no executable logic here, the file is structurally important because it anchors the configuration namespace and determines how configuration code is organized and imported elsewhere in the server. In Rust, `mod.rs` files define module boundaries, so this file is the entry point for any code under `app-server/src/config/`. By limiting exposure to `pub(crate)`, it preserves encapsulation: other internal components can parse, validate, and consume external-agent configuration, but downstream crates cannot couple themselves to those implementation details. This kind of file is typically touched during configuration loading and validation paths, when the server assembles its runtime settings and needs access to the external-agent-specific definitions housed in the sibling module.


### `app-server/src/config_manager.rs`

`config` · `config load`

This file wraps Codex configuration loading behind a cloneable `ConfigManager`. The struct stores immutable setup (`codex_home`, `loader_overrides`, `strict_config`, `arg0_paths`) plus mutable shared state guarded by `RwLock`: current CLI overrides, runtime feature enablement flags, the cloud-config bundle loader, and the thread-config loader. That lets login/auth refresh paths swap cloud or thread loaders without rebuilding the whole server.

The loading API has several entrypoints. `load_latest_config`, `load_with_overrides`, and `load_for_cwd` all funnel into `load_with_cli_overrides`, which merges persisted CLI overrides with per-request JSON overrides (converted through `json_to_toml`) and a small set of typed overrides (`ConfigOverrides`). One special request override, `bypass_hook_trust`, is parsed as a boolean and moved into `typesafe_overrides`; invalid types become `InvalidData` errors. The actual config is built through `codex_core::config::ConfigBuilder`, using the current cloud bundle and thread loader, optional fallback cwd, and strict/loader settings.

After every successful load, `ConfigManager` applies two app-server-specific mutations: runtime feature enablement and `arg0` executable paths. Runtime feature toggles are filtered through `protected_feature_keys`, which collects feature keys already fixed by effective config or requirements TOML; protected features are never overridden at runtime. Unknown feature keys are ignored, and failed feature toggles are logged. The file also exposes lower-level `load_config_layers` helpers for callers that need raw `ConfigLayerStack`, plus convenience methods for syncing the default client residency requirement after auth refresh and for preserving session layers when refreshing a thread config.

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

**Purpose**: Constructs a configuration manager with fixed loader settings and mutable shared state for overrides, runtime feature flags, cloud bundle loader, and thread config loader. It is the primary runtime constructor.

**Data flow**: Takes `codex_home`, initial CLI overrides, `LoaderOverrides`, `strict_config`, initial `CloudConfigBundleLoader`, `Arg0DispatchPaths`, and an `Arc<dyn ThreadConfigLoader>` → wraps mutable pieces in `Arc<RwLock<_>>` and returns `ConfigManager`.

**Call relations**: Used during server startup and test setup wherever a shared config-loading facade is needed.

*Call graph*: called by 5 (start_uninitialized, refresh_test_state, build_test_processor, derive_config_from_params_uses_session_thread_config_model_provider, run_main_with_transport_options); 3 external calls (new, new, new).


##### `ConfigManager::codex_home`  (lines 62–64)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Returns the configured Codex home path as a borrowed `&Path`. It is a simple accessor used by other methods.

**Data flow**: Reads `self.codex_home` and returns `self.codex_home.as_path()`.

**Call relations**: Used internally by `user_config_path` and `load_default_config`, and externally by code that needs the manager’s home directory.

*Call graph*: called by 3 (load_default_config, user_config_path, emit_plugin_toggle_events); 1 external calls (as_path).


##### `ConfigManager::user_config_path`  (lines 66–68)

```
fn user_config_path(&self) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Computes the effective user config path using the manager’s loader overrides and Codex home. It centralizes path resolution for callers that need to read or write user config.

**Data flow**: Calls `self.loader_overrides.user_config_path(self.codex_home())` and returns the resulting `AbsolutePathBuf` or I/O error.

**Call relations**: Used by config-editing code and by `load_default_config` when preserving a selected user config profile.

*Call graph*: calls 2 internal fn (codex_home, user_config_path).


##### `ConfigManager::current_cli_overrides`  (lines 70–75)

```
fn current_cli_overrides(&self) -> Vec<(String, TomlValue)>
```

**Purpose**: Returns a snapshot clone of the currently configured CLI overrides. Lock poisoning or read failure degrades to an empty override list.

**Data flow**: Reads `self.cli_overrides` under `RwLock` → clones the vector on success or returns `Vec::new()` on lock failure.

**Call relations**: Used by all load methods that need to merge current CLI overrides into a config build.

*Call graph*: called by 6 (load_config_layers, load_default_config, load_for_cwd, load_latest_config, load_with_overrides, thread_start_task).


##### `ConfigManager::current_cloud_config_bundle`  (lines 77–82)

```
fn current_cloud_config_bundle(&self) -> CloudConfigBundleLoader
```

**Purpose**: Returns a snapshot clone of the current cloud-config bundle loader. If the lock cannot be read, it falls back to the loader type’s default.

**Data flow**: Reads `self.cloud_config_bundle` under `RwLock` → clones the loader on success or returns `CloudConfigBundleLoader::default()` on failure.

**Call relations**: Used by config-building and config-layer-loading methods.

*Call graph*: called by 2 (load_config_layers, load_with_cli_overrides).


##### `ConfigManager::extend_runtime_feature_enablement`  (lines 84–92)

```
fn extend_runtime_feature_enablement(&self, enablement: I) -> Result<(), ()>
```

**Purpose**: Adds or updates runtime feature enablement flags that should be applied after config load. It mutates the shared runtime feature map in place.

**Data flow**: Takes any iterator of `(String, bool)` pairs → acquires a write lock on `runtime_feature_enablement`, extends the map with the new entries, and returns `Ok(())` or `Err(())` on lock failure.

**Call relations**: Called by feature-toggle management code; the stored flags are later consumed by `apply_runtime_feature_enablement`.

*Call graph*: called by 1 (set_experimental_feature_enablement).


##### `ConfigManager::replace_cloud_config_bundle_loader`  (lines 94–106)

```
fn replace_cloud_config_bundle_loader(
        &self,
        auth_manager: Arc<AuthManager>,
        chatgpt_base_url: String,
    )
```

**Purpose**: Rebuilds and swaps in a new cloud-config bundle loader after auth or endpoint changes. Failure to acquire the write lock is logged and otherwise ignored.

**Data flow**: Takes `Arc<AuthManager>` and a ChatGPT base URL string → builds a new loader with `cloud_config_bundle_loader(auth_manager, chatgpt_base_url, self.codex_home.clone())` → writes it into `self.cloud_config_bundle` or logs a warning on lock failure.

**Call relations**: Used by login/auth-refresh flows so subsequent config loads use fresh cloud-config credentials.

*Call graph*: called by 2 (login_chatgpt_auth_tokens_response, send_chatgpt_login_completion_notifications); 3 external calls (clone, cloud_config_bundle_loader, warn!).


##### `ConfigManager::replace_thread_config_loader`  (lines 108–117)

```
fn replace_thread_config_loader(
        &self,
        thread_config_loader: Arc<dyn ThreadConfigLoader>,
    )
```

**Purpose**: Swaps in a new thread config loader implementation for future config loads. Lock failure is logged and ignored.

**Data flow**: Takes an `Arc<dyn ThreadConfigLoader>` → attempts to write it into `self.thread_config_loader` → logs a warning if the lock cannot be acquired.

**Call relations**: Used when the server needs to change how thread-specific config layers are loaded.

*Call graph*: 1 external calls (warn!).


##### `ConfigManager::current_thread_config_loader`  (lines 119–124)

```
fn current_thread_config_loader(&self) -> Arc<dyn ThreadConfigLoader>
```

**Purpose**: Returns a snapshot clone of the current thread config loader, falling back to `NoopThreadConfigLoader` if the lock cannot be read. This keeps config loading resilient to lock poisoning.

**Data flow**: Reads `self.thread_config_loader` under `RwLock` → clones the inner `Arc<dyn ThreadConfigLoader>` on success or returns `Arc::new(codex_config::NoopThreadConfigLoader)` on failure.

**Call relations**: Used by `load_with_cli_overrides` and `load_config_layers`.

*Call graph*: called by 2 (load_config_layers, load_with_cli_overrides).


##### `ConfigManager::sync_default_client_residency_requirement`  (lines 126–136)

```
async fn sync_default_client_residency_requirement(&self)
```

**Purpose**: Loads the latest effective config and pushes its residency requirement into the login client’s global default. It is a post-auth-refresh synchronization hook.

**Data flow**: Calls `load_latest_config(None).await` → on success reads `config.enforce_residency.value()` and passes it to `set_default_client_residency_requirement` → on failure logs a warning.

**Call relations**: Called by login completion/auth refresh flows after credentials or cloud config may have changed.

*Call graph*: calls 2 internal fn (load_latest_config, set_default_client_residency_requirement); called by 2 (login_chatgpt_auth_tokens_response, send_chatgpt_login_completion_notifications); 1 external calls (warn!).


##### `ConfigManager::load_latest_config`  (lines 138–149)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> std::io::Result<Config>
```

**Purpose**: Loads the current effective config using the manager’s current CLI overrides and no request-specific overrides. It is the common baseline load path.

**Data flow**: Reads current CLI overrides with `current_cli_overrides()` → calls `load_with_cli_overrides(..., request_overrides: None, ConfigOverrides::default(), fallback_cwd)` → returns the resulting `Config`.

**Call relations**: Used by many callers needing a fresh config snapshot, and by `load_latest_config_for_thread` and `sync_default_client_residency_requirement`.

*Call graph*: calls 2 internal fn (current_cli_overrides, load_with_cli_overrides); called by 10 (load_latest_config_for_thread, sync_default_client_residency_requirement, queue_strict_refresh, maybe_refresh_plugin_caches_for_current_config, load_latest_config, load_latest_config, load_latest_config, load_latest_config, load_latest_config, load_latest_config); 1 external calls (default).


##### `ConfigManager::load_latest_config_for_thread`  (lines 151–164)

```
async fn load_latest_config_for_thread(
        &self,
        thread_config: &Config,
    ) -> std::io::Result<Config>
```

**Purpose**: Refreshes a thread’s config while preserving its session-specific layers from an existing thread config. It then reapplies runtime feature toggles and executable paths.

**Data flow**: Takes a reference to an existing thread `Config` → loads a fresh config using the thread’s cwd as fallback → calls `thread_config.rebuild_preserving_session_layers(&refreshed_config).await?` → mutates the rebuilt config with `apply_runtime_feature_enablement` and `apply_arg0_paths` → returns it.

**Call relations**: Used when a running thread needs a refreshed config without losing session-layer state.

*Call graph*: calls 3 internal fn (apply_arg0_paths, apply_runtime_feature_enablement, load_latest_config); called by 3 (build_refresh_config, experimental_feature_list_response, list_mcp_server_status); 1 external calls (rebuild_preserving_session_layers).


##### `ConfigManager::load_default_config`  (lines 166–185)

```
async fn load_default_config(&self) -> std::io::Result<Config>
```

**Purpose**: Loads the default config for the manager’s Codex home using current CLI overrides, while preserving any selected user config path/profile from loader overrides. It then applies runtime feature toggles and executable paths.

**Data flow**: Calls `Config::load_default_with_cli_overrides_for_codex_home(self.codex_home.clone(), self.current_cli_overrides()).await?` → if loader overrides specify a user config path or profile, computes the user config path and rewrites `config.config_layer_stack` with `with_user_config_profile(...)` using an empty TOML table → applies runtime feature enablement and arg0 paths → returns the config.

**Call relations**: Used by callers that need a default config independent of request cwd or request overrides.

*Call graph*: calls 5 internal fn (apply_arg0_paths, apply_runtime_feature_enablement, codex_home, current_cli_overrides, user_config_path); 4 external calls (clone, Table, load_default_with_cli_overrides_for_codex_home, new).


##### `ConfigManager::load_with_overrides`  (lines 187–199)

```
async fn load_with_overrides(
        &self,
        request_overrides: Option<HashMap<String, serde_json::Value>>,
        typesafe_overrides: ConfigOverrides,
    ) -> std::io::Result<Config>
```

**Purpose**: Loads config with the current CLI overrides plus request-scoped JSON overrides and typed overrides, without a fallback cwd. It is the generic request-level load entrypoint.

**Data flow**: Reads current CLI overrides → forwards them, the provided request overrides, typed overrides, and `fallback_cwd: None` to `load_with_cli_overrides` → returns the resulting `Config`.

**Call relations**: Used by request handlers that need ad hoc config overrides.

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

**Purpose**: Loads config with current CLI overrides, request overrides, typed overrides, and an explicit cwd/fallback cwd. It is the cwd-aware variant of `load_with_overrides`.

**Data flow**: Reads current CLI overrides → forwards them plus provided request overrides, typed overrides, and cwd to `load_with_cli_overrides` → returns the resulting `Config`.

**Call relations**: Used by operations whose effective config depends on a specific working directory.

*Call graph*: calls 2 internal fn (current_cli_overrides, load_with_cli_overrides); called by 6 (hooks_list_response, exec_one_off_command_inner, thread_fork_inner, thread_resume_inner, build_thread_settings_overrides, windows_sandbox_setup_start_inner).


##### `ConfigManager::load_with_cli_overrides`  (lines 217–257)

```
async fn load_with_cli_overrides(
        &self,
        cli_overrides: &[(String, TomlValue)],
        request_overrides: Option<HashMap<String, serde_json::Value>>,
        mut typesafe_overrides: C
```

**Purpose**: Performs the full config build: merges CLI and request overrides, extracts typed overrides, invokes `ConfigBuilder`, and applies app-server runtime mutations. It is the central implementation behind all higher-level load methods.

**Data flow**: Takes a slice of CLI overrides, optional request override map, mutable `ConfigOverrides`, and optional fallback cwd → removes special `bypass_hook_trust` from request overrides and validates it as boolean into `typesafe_overrides`, converts remaining JSON overrides to TOML with `json_to_toml`, chains them after cloned CLI overrides, builds a `Config` via `codex_core::config::ConfigBuilder` using codex home, merged CLI overrides, loader overrides, strict flag, typed overrides, fallback cwd, current cloud bundle, and current thread config loader, then mutates the result with `apply_runtime_feature_enablement` and `apply_arg0_paths` and returns it.

**Call relations**: Called by `load_latest_config`, `load_with_overrides`, `load_for_cwd`, and other internal startup/request paths. It is the file’s main config-construction routine.

*Call graph*: calls 4 internal fn (apply_arg0_paths, apply_runtime_feature_enablement, current_cloud_config_bundle, current_thread_config_loader); called by 4 (load_for_cwd, load_latest_config, load_with_overrides, thread_start_task); 3 external calls (clone, clone, default).


##### `ConfigManager::load_config_layers_for_cwd`  (lines 259–264)

```
async fn load_config_layers_for_cwd(
        &self,
        cwd: AbsolutePathBuf,
    ) -> std::io::Result<ConfigLayerStack>
```

**Purpose**: Loads raw config layers for a specific cwd by forwarding to the more general `load_config_layers`. It is a small convenience wrapper.

**Data flow**: Takes an `AbsolutePathBuf` cwd → calls `load_config_layers(Some(cwd)).await` → returns the resulting `ConfigLayerStack`.

**Call relations**: Used by callers that already have an absolute cwd and need raw layer state.

*Call graph*: calls 1 internal fn (load_config_layers); called by 1 (resolve_cwd_config).


##### `ConfigManager::load_config_layers`  (lines 266–284)

```
async fn load_config_layers(
        &self,
        cwd: Option<AbsolutePathBuf>,
    ) -> std::io::Result<ConfigLayerStack>
```

**Purpose**: Loads the raw `ConfigLayerStack` without building a full `Config`, using current CLI overrides, cloud bundle, and thread config loader. This is useful for introspection APIs.

**Data flow**: Takes optional absolute cwd → snapshots the current thread config loader, CLI overrides, and cloud bundle → calls `load_config_layers_state(LOCAL_FS.as_ref(), &self.codex_home, cwd, &cli_overrides, ConfigLoadOptions { loader_overrides, strict_config, cloud_config_bundle }, thread_config_loader.as_ref()).await` → returns the layer stack.

**Call relations**: Used by config-inspection endpoints and by `load_config_layers_for_cwd`.

*Call graph*: calls 4 internal fn (current_cli_overrides, current_cloud_config_bundle, current_thread_config_loader, load_config_layers_state); called by 2 (load_config_layers_for_cwd, permission_profile_list_response); 1 external calls (clone).


##### `ConfigManager::apply_runtime_feature_enablement`  (lines 286–288)

```
fn apply_runtime_feature_enablement(&self, config: &mut Config)
```

**Purpose**: Applies the manager’s current runtime feature flags to a loaded config. It is the instance-method wrapper around the free helper function.

**Data flow**: Reads the current runtime feature map with `current_runtime_feature_enablement()` → passes the config and map to free `apply_runtime_feature_enablement`.

**Call relations**: Called after every successful config load in this file.

*Call graph*: calls 2 internal fn (current_runtime_feature_enablement, apply_runtime_feature_enablement); called by 3 (load_default_config, load_latest_config_for_thread, load_with_cli_overrides).


##### `ConfigManager::current_runtime_feature_enablement`  (lines 290–295)

```
fn current_runtime_feature_enablement(&self) -> BTreeMap<String, bool>
```

**Purpose**: Returns a snapshot clone of the runtime feature enablement map, defaulting to empty on lock failure. This keeps post-load mutation resilient.

**Data flow**: Reads `self.runtime_feature_enablement` under `RwLock` → clones the `BTreeMap` on success or returns an empty map on failure.

**Call relations**: Used only by the instance `apply_runtime_feature_enablement` method.

*Call graph*: called by 1 (apply_runtime_feature_enablement).


##### `ConfigManager::apply_arg0_paths`  (lines 297–301)

```
fn apply_arg0_paths(&self, config: &mut Config)
```

**Purpose**: Injects executable dispatch paths into a loaded config so downstream code knows the correct Codex binaries/wrappers to invoke. It mutates three path fields directly.

**Data flow**: Takes mutable `Config` → copies `self.arg0_paths.codex_self_exe`, `codex_linux_sandbox_exe`, and `main_execve_wrapper_exe` into the config.

**Call relations**: Called after every successful config load and refresh in this file.

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

**Purpose**: Constructs a test-oriented config manager with `strict_config` disabled, default arg0 paths, and a no-op thread config loader. It reduces boilerplate in config-manager tests.

**Data flow**: Takes `codex_home`, CLI overrides, loader overrides, and cloud bundle loader → calls `Self::new(..., strict_config: false, Arg0DispatchPaths::default(), Arc::new(codex_config::NoopThreadConfigLoader))`.

**Call relations**: Used only by tests in this crate.

*Call graph*: called by 9 (invalid_user_value_rejected_even_if_overridden_by_managed, load_default_config_preserves_selected_user_config_path_after_load_error, read_includes_origins_and_layers, read_reports_managed_overrides_user_and_session_flags, write_value_defaults_to_selected_user_config_path, write_value_rejects_feature_requirement_conflict, write_value_reports_managed_override, write_value_reports_override, write_value_succeeds_when_managed_preferences_expand_home_directory_paths); 3 external calls (new, new, default).


##### `ConfigManager::without_managed_config_for_tests`  (lines 322–329)

```
fn without_managed_config_for_tests(codex_home: PathBuf) -> Self
```

**Purpose**: Constructs a test config manager with no managed config layer and otherwise default test settings. It is a convenience for tests focused on user/session config behavior.

**Data flow**: Takes `codex_home` → calls `new_for_tests(codex_home, Vec::new(), LoaderOverrides::without_managed_config_for_tests(), CloudConfigBundleLoader::default())`.

**Call relations**: Used by many config-manager tests that do not want managed config interference.

*Call graph*: calls 2 internal fn (default, without_managed_config_for_tests); called by 12 (batch_write_rejects_legacy_profile_selector, clear_missing_nested_config_is_noop, reserved_builtin_provider_override_rejected, upsert_merges_tables_replace_overwrites, version_conflict_rejected, write_value_defaults_to_user_config_path, write_value_preserves_comments_and_order, write_value_rejects_legacy_profile_selector, write_value_rejects_legacy_profile_table, write_value_supports_custom_mcp_server_default_tool_approval_mode (+2 more)); 2 external calls (new_for_tests, new).


##### `protected_feature_keys`  (lines 332–349)

```
fn protected_feature_keys(config_layer_stack: &ConfigLayerStack) -> BTreeSet<String>
```

**Purpose**: Computes the set of feature keys that runtime feature enablement must not override because they are already protected by effective config or feature requirements. It enforces precedence rules.

**Data flow**: Takes a `ConfigLayerStack` → collects keys under `effective_config()["features"]` into a `BTreeSet`, then extends that set with keys from `requirements_toml().feature_requirements.entries` when present → returns the set.

**Call relations**: Used by free `apply_runtime_feature_enablement` to filter runtime toggles.

*Call graph*: calls 2 internal fn (effective_config, requirements_toml); called by 1 (apply_runtime_feature_enablement).


##### `apply_runtime_feature_enablement`  (lines 351–371)

```
fn apply_runtime_feature_enablement(
    config: &mut Config,
    runtime_feature_enablement: &BTreeMap<String, bool>,
)
```

**Purpose**: Applies runtime feature flags to a config only for unprotected, known features, logging but otherwise ignoring failures. It is the policy function behind runtime feature mutation.

**Data flow**: Takes mutable `Config` and a `BTreeMap<String, bool>` of runtime flags → computes protected keys with `protected_feature_keys(&config.config_layer_stack)`, skips protected names, resolves each remaining name with `feature_for_key`, and calls `config.features.set_enabled(feature, enabled)`, logging warnings on errors.

**Call relations**: Called by the instance method `ConfigManager::apply_runtime_feature_enablement` after config loads.

*Call graph*: calls 1 internal fn (protected_feature_keys); called by 1 (apply_runtime_feature_enablement); 2 external calls (feature_for_key, warn!).


### `config/src/project_root_markers.rs`

`config` · `config load`

This file is a narrow config helper around project-root detection settings. It defines the built-in default marker slice as `DEFAULT_PROJECT_ROOT_MARKERS`, currently containing only `.git`, and exposes two functions: one to read an explicit setting from a merged `toml::Value`, and one to materialize the default list as owned `String`s.

`project_root_markers_from_config` is intentionally strict about type shape while preserving the semantic distinction between omission and explicit disablement. If the top-level config is not a table or the `project_root_markers` key is absent, it returns `Ok(None)`, signaling that callers should fall back to defaults. If the key is present, it must be a TOML array of strings; an empty array is accepted and returned as `Ok(Some(Vec::new()))`, which is the explicit signal to disable root detection entirely. Any non-array value or any non-string array element produces `io::ErrorKind::InvalidData` with a fixed message. This makes the function suitable for use after config layers have already been merged, where callers need one place to interpret the final setting and preserve the difference between unspecified, explicitly empty, and invalid values.

#### Function details

##### `project_root_markers_from_config`  (lines 16–43)

```
fn project_root_markers_from_config(config: &TomlValue) -> io::Result<Option<Vec<String>>>
```

**Purpose**: Reads the final `project_root_markers` setting from a merged TOML config and distinguishes absent, explicitly empty, and invalid forms.

**Data flow**: Takes a `&TomlValue`; if it is not a table, returns `Ok(None)`; if the `project_root_markers` key is missing, also returns `Ok(None)`; if present, requires the value to be a TOML array, otherwise returns `io::Error` with `InvalidData`; if the array is empty, returns `Ok(Some(Vec::new()))`; otherwise iterates entries, requiring each to be a string, cloning them into a `Vec<String>`, and returns `Ok(Some(markers))`.

**Call relations**: Config loading calls this after layer merging to interpret the effective project-root marker setting before deciding whether to use defaults or disable detection.

*Call graph*: called by 1 (load_config_layers_state); 3 external calls (as_table, new, new).


##### `default_project_root_markers`  (lines 45–50)

```
fn default_project_root_markers() -> Vec<String>
```

**Purpose**: Returns the built-in default project-root markers as owned strings.

**Data flow**: Iterates the static `DEFAULT_PROJECT_ROOT_MARKERS` slice, converts each `&str` to `String`, collects into a `Vec<String>`, and returns it.

**Call relations**: Callers use this when `project_root_markers_from_config` returns `None`, meaning the setting was not explicitly provided.


### `core/src/config/mod.rs`

`config` · `startup and config reload; also consulted during session/runtime policy updates`

This module is the core configuration assembly pipeline for the application. It declares the large `Config` struct that holds the effective runtime state, plus supporting types such as `Permissions`, `ConfigBuilder`, `ConfigOverrides`, `GhostSnapshotConfig`, `MultiAgentV2Config`, terminal reflow settings, agent role summaries, and permission-profile selection helpers. The file’s main job is to turn layered `ConfigToml` input and `ConfigRequirements` into a validated `Config` with concrete paths, constrained values, startup warnings, and derived runtime policies.

The dominant control flow lives in `ConfigBuilder::build_inner` and `Config::load_config_with_layer_stack`. The builder resolves `codex_home` and `cwd`, loads config layers through `load_config_layers_state`, optionally replays a config lockfile, deserializes merged TOML, then delegates to the loader. The loader applies feature requirements, permission-profile selection rules, workspace-root materialization, managed filesystem/network constraints, model provider merging, MCP server filtering, OTEL sanitization, and many small compatibility shims. It explicitly rejects conflicting overrides (`sandbox_mode` vs `permission_profile` vs `default_permissions`), unsupported legacy `profile = ...`, invalid multi-agent limits, and dangerous combinations such as requirements forcing read-only while approvals are disabled.

A key design choice is preserving both canonical permission profiles and legacy sandbox projections. `Permissions` stores a `PermissionProfileState` plus runtime workspace roots and derived network proxy state, allowing callers to query effective filesystem/network policy while still tracking active named profiles. The module also contains utility entry points for partial TOML loading, profile-path resolution, project trust edits, OSS provider persistence, tool-suggestion merging across layers, and config rebuilding that preserves session-only layers.

#### Function details

##### `GhostSnapshotConfig::default`  (lines 182–188)

```
fn default() -> Self
```

**Purpose**: Constructs the compatibility-only ghost snapshot settings with legacy default thresholds for large untracked files and directories, and warnings enabled.

**Data flow**: It reads only file-level constants for default byte and directory thresholds and returns a new `GhostSnapshotConfig` with `ignore_large_untracked_files` and `ignore_large_untracked_dirs` set to `Some(...)` and `disable_warnings` set to `false`. It does not mutate external state.

**Call relations**: It is used when config loading needs a baseline ghost-snapshot value before overlaying deprecated TOML fields, and in tests/helpers that create fresh config objects.

*Call graph*: called by 2 (load_config_with_layer_stack, new_config).


##### `default_multi_agent_v2_usage_hint_text`  (lines 250–254)

```
fn default_multi_agent_v2_usage_hint_text(usage_hint_text: &str, max_concurrency: usize) -> String
```

**Purpose**: Builds the default instructional prompt text for multi-agent v2 by combining a role-specific hint, shared collaboration guidance, and the configured concurrency count.

**Data flow**: It takes a base `usage_hint_text` string slice and a `max_concurrency` count, interpolates them with the shared/no-spawn constants via `format!`, and returns the assembled `String`.

**Call relations**: It is only called from `MultiAgentV2Config::defaults_for_max_concurrency` to synthesize the default root-agent and subagent hint bodies.

*Call graph*: called by 1 (defaults_for_max_concurrency); 1 external calls (format!).


##### `resolve_sqlite_home_env`  (lines 266–278)

```
fn resolve_sqlite_home_env(resolved_cwd: &Path) -> Option<PathBuf>
```

**Purpose**: Resolves the optional SQLite state directory from the `SQLITE_HOME_ENV` environment variable, interpreting relative values against the resolved working directory.

**Data flow**: It reads the environment variable, trims whitespace, returns `None` for missing or empty values, converts non-empty values into a `PathBuf`, and if the path is relative joins it onto `resolved_cwd`; otherwise it returns the absolute path unchanged.

**Call relations**: This helper is used during full config construction when choosing `sqlite_home`, after explicit config values but before falling back to `codex_home`.

*Call graph*: 3 external calls (join, from, var).


##### `resolve_cli_auth_credentials_store_mode`  (lines 280–291)

```
fn resolve_cli_auth_credentials_store_mode(
    configured: AuthCredentialsStoreMode,
    package_version: &str,
) -> AuthCredentialsStoreMode
```

**Purpose**: Normalizes the CLI auth credential storage mode, forcing local development builds away from keyring-backed storage.

**Data flow**: It takes the configured `AuthCredentialsStoreMode` and package version string, matches on `(package_version, configured)`, and returns `File` instead of `Keyring`/`Auto` when the version is the local dev sentinel `0.0.0`; otherwise it returns the original mode.

**Call relations**: It is invoked while assembling `Config` so the final `cli_auth_credentials_store_mode` reflects build-specific behavior.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_mcp_oauth_credentials_store_mode`  (lines 293–304)

```
fn resolve_mcp_oauth_credentials_store_mode(
    configured: OAuthCredentialsStoreMode,
    package_version: &str,
) -> OAuthCredentialsStoreMode
```

**Purpose**: Normalizes MCP OAuth credential storage mode with the same local-development fallback behavior used for CLI auth credentials.

**Data flow**: It consumes a configured `OAuthCredentialsStoreMode` and package version string and returns `File` for local dev builds when the configured mode is `Keyring` or `Auto`; otherwise it returns the input mode unchanged.

**Call relations**: It is called during `Config::load_config_with_layer_stack` when populating the final MCP OAuth credential storage setting.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `test_config`  (lines 307–316)

```
async fn test_config() -> Config
```

**Purpose**: Creates a temporary default `Config` for tests without relying on user config files.

**Data flow**: It creates a temporary directory, converts it into an `AbsolutePathBuf` for `codex_home`, calls `Config::load_from_base_config_with_overrides` with `ConfigToml::default()` and `ConfigOverrides::default()`, and returns the loaded `Config` or panics on failure.

**Call relations**: This async helper is used broadly by tests that need a valid baseline config object before exercising session, guardian, or residency behavior.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 32 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent, guardian_review_session_compact_scope_change_invalidates_cached_session, guardian_review_session_config_change_invalidates_cached_session, guardian_review_session_config_disables_hooks, guardian_review_session_config_disables_skill_instructions, guardian_review_session_config_allows_pinned_disabled_feature, guardian_review_session_config_clears_legacy_notify, guardian_review_session_config_clears_parent_developer_instructions, guardian_review_session_config_disables_mcp_apps_plugins_and_memories (+15 more)); 4 external calls (load_from_base_config_with_overrides, default, default, tempdir).


##### `Permissions::from_approval_and_profile`  (lines 352–368)

```
fn from_approval_and_profile(
        approval_policy: Constrained<AskForApproval>,
        permission_profile: Constrained<PermissionProfile>,
    ) -> ConstraintResult<Self>
```

**Purpose**: Builds a minimal in-process `Permissions` value from already-constrained approval and permission-profile inputs.

**Data flow**: It takes `Constrained<AskForApproval>` and `Constrained<PermissionProfile>`, converts the profile into `PermissionProfileState::from_constrained_legacy`, and returns a `Permissions` with empty workspace roots, no network proxy, login shells allowed, default shell environment policy, and no Windows sandbox mode.

**Call relations**: It is used by lightweight config/test paths that need a `Permissions` object without running the full config loader.

*Call graph*: calls 2 internal fn (from_constrained_legacy, default); called by 3 (permission_snapshot_setter_preserves_permission_constraints, new_config, debug_config_output_filters_sandbox_modes_blocked_by_deny_read_requirements); 1 external calls (new).


##### `Permissions::permission_profile_state`  (lines 370–372)

```
fn permission_profile_state(&self) -> &PermissionProfileState
```

**Purpose**: Exposes the internal `PermissionProfileState` backing the permission configuration.

**Data flow**: It borrows `self.permission_profile_state` and returns an immutable reference without transformation.

**Call relations**: This is a low-level accessor for callers that need the richer resolved-profile state rather than just the concrete `PermissionProfile`.


##### `Permissions::set_permission_profile_state`  (lines 374–379)

```
fn set_permission_profile_state(
        &mut self,
        permission_profile_state: PermissionProfileState,
    )
```

**Purpose**: Replaces the stored resolved permission-profile state wholesale.

**Data flow**: It takes a new `PermissionProfileState` and assigns it into `self.permission_profile_state`, mutating the `Permissions` object in place and returning nothing.

**Call relations**: It is used by higher-level permission-application flows that have already computed a new resolved profile state.

*Call graph*: called by 1 (apply_permission_profile_to_permissions).


##### `Permissions::set_permission_profile_from_session_snapshot`  (lines 386–392)

```
fn set_permission_profile_from_session_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Installs a trusted session-emitted permission snapshot while preserving configured constraints.

**Data flow**: It takes a `PermissionProfileSnapshot`, forwards it to `PermissionProfileState::set_permission_profile_snapshot`, and returns the resulting `ConstraintResult<()>` indicating whether the snapshot satisfied the existing constraints.

**Call relations**: This method is part of the bridge from core session state back into local config consumers that need to mirror resolved permissions.

*Call graph*: calls 1 internal fn (set_permission_profile_snapshot).


##### `Permissions::replace_permission_profile_from_session_snapshot`  (lines 397–407)

```
fn replace_permission_profile_from_session_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Force-replaces the current permission constraints with a trusted session snapshot, even if the local constrained state would reject it.

**Data flow**: It takes a `PermissionProfileSnapshot`, extracts and clones its concrete `PermissionProfile`, wraps that in `Constrained::allow_only`, converts the snapshot into a resolved profile, rebuilds `self.permission_profile_state` with `PermissionProfileState::from_constrained_resolved`, and returns success or constraint-construction failure.

**Call relations**: This is the stronger fallback path for clients that must mirror authoritative session state after ordinary constrained installation fails.

*Call graph*: calls 4 internal fn (allow_only, into_resolved_permission_profile, permission_profile, from_constrained_resolved).


##### `Permissions::permission_profile`  (lines 411–413)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: Returns the canonical, unresolved permission profile currently stored in the permission state.

**Data flow**: It reads `self.permission_profile_state` and returns a borrowed `&PermissionProfile` from that state.

**Call relations**: Other permission queries in this file build on this accessor, especially materialization and network-policy projection.

*Call graph*: calls 1 internal fn (permission_profile); called by 2 (materialized_permission_profile, network_sandbox_policy).


##### `Permissions::can_set_permission_profile`  (lines 415–421)

```
fn can_set_permission_profile(
        &self,
        permission_profile: &PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Checks whether a candidate canonical permission profile would satisfy the current constraints.

**Data flow**: It takes a borrowed `PermissionProfile`, delegates to `PermissionProfileState::can_set_legacy_permission_profile`, and returns a `ConstraintResult<()>` without mutating state.

**Call relations**: It is used by callers that want to validate a profile change before applying it.

*Call graph*: calls 1 internal fn (can_set_legacy_permission_profile); called by 1 (sandbox_mode_is_allowed_by_permissions).


##### `Permissions::set_workspace_roots`  (lines 423–425)

```
fn set_workspace_roots(&mut self, workspace_roots: Vec<AbsolutePathBuf>)
```

**Purpose**: Updates the runtime workspace roots used to materialize symbolic project-root permissions.

**Data flow**: It takes a `Vec<AbsolutePathBuf>` and assigns it to `self.workspace_roots`, mutating the permission object in place.

**Call relations**: This setter supports runtime changes to workspace-root context independent of the canonical profile definition.


##### `Permissions::workspace_roots`  (lines 427–429)

```
fn workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the current runtime workspace roots stored on the permission object.

**Data flow**: It borrows and returns `&[AbsolutePathBuf]` from `self.workspace_roots`.

**Call relations**: It is used when syncing `Config`’s top-level workspace roots after legacy sandbox-policy updates.

*Call graph*: called by 1 (set_legacy_sandbox_policy).


##### `Permissions::user_visible_workspace_roots`  (lines 433–435)

```
fn user_visible_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the runtime workspace roots that are intended to be exposed to users.

**Data flow**: It simply returns the same slice as `workspace_roots`, with the semantic guarantee that internal Codex-only writable roots are excluded from this field.

**Call relations**: This accessor exists to distinguish user-facing roots from any internal-only runtime additions.


##### `Permissions::profile_workspace_roots`  (lines 437–439)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns workspace roots declared by the active named/built-in permission profile itself.

**Data flow**: It reads `self.permission_profile_state` and returns the borrowed slice of profile-defined roots.

**Call relations**: It feeds `Config::effective_workspace_roots`, which combines runtime roots with profile-defined roots.

*Call graph*: calls 1 internal fn (profile_workspace_roots); called by 1 (effective_workspace_roots).


##### `Permissions::materialized_permission_profile`  (lines 441–445)

```
fn materialized_permission_profile(&self) -> PermissionProfile
```

**Purpose**: Produces a concrete permission profile with symbolic `:workspace_roots` entries expanded against the current runtime workspace roots.

**Data flow**: It clones the canonical profile from `permission_profile()`, calls `materialize_project_roots_with_workspace_roots(&self.workspace_roots)`, and returns the resulting `PermissionProfile`.

**Call relations**: This internal helper underpins effective permission, filesystem policy, and legacy sandbox projections.

*Call graph*: calls 1 internal fn (permission_profile); called by 3 (effective_permission_profile, file_system_sandbox_policy, legacy_sandbox_policy).


##### `Permissions::effective_permission_profile`  (lines 449–451)

```
fn effective_permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the runtime-effective permission profile after workspace-root materialization.

**Data flow**: It calls `materialized_permission_profile` and returns the resulting concrete `PermissionProfile`.

**Call relations**: This is the public-facing effective-profile accessor for consumers that need the fully materialized runtime view.

*Call graph*: calls 1 internal fn (materialized_permission_profile).


##### `Permissions::active_permission_profile`  (lines 454–456)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the selected named or built-in profile identity, if the current permissions came from one.

**Data flow**: It reads `self.permission_profile_state` and returns an `Option<ActivePermissionProfile>` cloned from the resolved state.

**Call relations**: This preserves profile identity separately from the concrete permission rules so UI/session code can report or reselect the active profile.

*Call graph*: calls 1 internal fn (active_permission_profile).


##### `Permissions::file_system_sandbox_policy`  (lines 459–462)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Projects the effective permission profile into a filesystem sandbox policy.

**Data flow**: It materializes the permission profile against runtime workspace roots and calls `.file_system_sandbox_policy()` on the resulting profile, returning a `FileSystemSandboxPolicy`.

**Call relations**: This is used by runtime execution code and tests that need the concrete filesystem policy rather than the higher-level profile.

*Call graph*: calls 1 internal fn (materialized_permission_profile).


##### `Permissions::network_sandbox_policy`  (lines 465–467)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Projects the canonical permission profile into its network sandbox policy.

**Data flow**: It reads the canonical profile via `permission_profile()` and returns its `NetworkSandboxPolicy` without workspace-root materialization.

**Call relations**: Unlike filesystem policy, network policy does not depend on workspace-root expansion, so it reads directly from the canonical profile.

*Call graph*: calls 1 internal fn (permission_profile).


##### `Permissions::legacy_sandbox_policy`  (lines 470–473)

```
fn legacy_sandbox_policy(&self, cwd: &Path) -> SandboxPolicy
```

**Purpose**: Converts the effective canonical permission profile back into the older `SandboxPolicy` representation for compatibility paths.

**Data flow**: It materializes the permission profile, passes it and the provided `cwd` to `compatibility_sandbox_policy_for_permission_profile`, and returns the resulting `SandboxPolicy`.

**Call relations**: This is called by `Config::legacy_sandbox_policy` and exists to support older code paths that still speak the legacy sandbox enum.

*Call graph*: calls 1 internal fn (materialized_permission_profile); called by 1 (legacy_sandbox_policy); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `Permissions::can_set_legacy_sandbox_policy`  (lines 477–492)

```
fn can_set_legacy_sandbox_policy(
        &self,
        sandbox_policy: &SandboxPolicy,
        cwd: &Path,
    ) -> ConstraintResult<()>
```

**Purpose**: Validates whether a legacy `SandboxPolicy` could be projected into the canonical permission-profile model under current constraints.

**Data flow**: It takes a `SandboxPolicy` and `cwd`, derives `FileSystemSandboxPolicy`, `NetworkSandboxPolicy`, and `SandboxEnforcement` from the legacy policy, reconstructs a `PermissionProfile` with `from_runtime_permissions_with_enforcement`, and asks the internal state whether that profile is allowed.

**Call relations**: It is the preflight check used by `Permissions::set_legacy_sandbox_policy` before mutating state.

*Call graph*: calls 5 internal fn (can_set_legacy_permission_profile, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 1 (set_legacy_sandbox_policy).


##### `Permissions::set_legacy_sandbox_policy`  (lines 496–534)

```
fn set_legacy_sandbox_policy(
        &mut self,
        sandbox_policy: SandboxPolicy,
        cwd: &Path,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies a legacy sandbox policy by converting it into the canonical permission profile and synchronizing runtime workspace roots.

**Data flow**: It first validates the candidate via `can_set_legacy_sandbox_policy`, then derives filesystem/network policies and a canonical `PermissionProfile`. It computes `self.workspace_roots` from `cwd` plus any `writable_roots` in `SandboxPolicy::WorkspaceWrite`, deduplicating by linear containment checks, and finally updates `self.permission_profile_state` with the converted profile.

**Call relations**: This mutating compatibility path is called by `Config::set_legacy_sandbox_policy` so top-level config and nested permissions stay in sync.

*Call graph*: calls 6 internal fn (can_set_legacy_sandbox_policy, set_legacy_permission_profile, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 1 (set_legacy_sandbox_policy); 1 external calls (vec!).


##### `Permissions::set_permission_profile`  (lines 537–543)

```
fn set_permission_profile(
        &mut self,
        permission_profile: PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Sets the canonical permission profile directly on the resolved permission state.

**Data flow**: It takes an owned `PermissionProfile`, forwards it to `PermissionProfileState::set_legacy_permission_profile`, and returns the resulting constraint check outcome.

**Call relations**: This is the direct canonical-profile setter for callers that already operate in the new permission model.

*Call graph*: calls 1 internal fn (set_legacy_permission_profile).


##### `profile_allows_configured_network_proxy`  (lines 549–556)

```
fn profile_allows_configured_network_proxy(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Determines whether a permission profile still permits inheriting configured proxy/allowlist settings from config.

**Data flow**: It pattern-matches the `PermissionProfile`: managed and external profiles return whether their embedded network policy is enabled, while `Disabled` returns `false` because no outer sandbox should be narrowed by starting a managed proxy.

**Call relations**: It is consulted during config loading and active-profile proxy recomputation to decide whether profile-specific proxy config should be preserved.

*Call graph*: called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `build_network_proxy_spec`  (lines 558–589)

```
fn build_network_proxy_spec(
    configured_network_proxy_config: NetworkProxyConfig,
    network_requirements: Option<Sourced<codex_config::NetworkConstraints>>,
    permission_profile: &PermissionPr
```

**Purpose**: Builds an optional `NetworkProxySpec` from configured proxy settings, optional managed network constraints, and the effective permission profile.

**Data flow**: It unpacks `Option<Sourced<NetworkConstraints>>` into value/source, calls `NetworkProxySpec::from_config_and_constraints`, rewrites any error message to include the requirement source when present, and returns `Some(spec)` whenever managed requirements exist or when the resulting spec is enabled; otherwise it returns `None`.

**Call relations**: This helper is used both during initial config assembly and when recomputing proxy state for an active permission profile.

*Call graph*: calls 1 internal fn (from_config_and_constraints); called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `MultiAgentV2Config::defaults_for_max_concurrency`  (lines 1079–1099)

```
fn defaults_for_max_concurrency(max_concurrent_threads_per_session: usize) -> Self
```

**Purpose**: Constructs the default multi-agent v2 settings for a given concurrency limit, including synthesized usage-hint text.

**Data flow**: It takes `max_concurrent_threads_per_session`, fills timeout and behavior fields from module constants, generates root/subagent hint text with `default_multi_agent_v2_usage_hint_text`, and returns a fully populated `MultiAgentV2Config`.

**Call relations**: It is used by `resolve_multi_agent_v2_config` and the `Default` impl to derive defaults that depend on concurrency.

*Call graph*: calls 1 internal fn (default_multi_agent_v2_usage_hint_text); called by 1 (resolve_multi_agent_v2_config).


##### `MultiAgentV2Config::default`  (lines 1103–1107)

```
fn default() -> Self
```

**Purpose**: Returns the standard multi-agent v2 configuration using the module’s default concurrency limit.

**Data flow**: It calls `defaults_for_max_concurrency(DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION)` and returns that value.

**Call relations**: This is the baseline used when constructing default configs or tests that need a fresh multi-agent v2 config.

*Call graph*: called by 1 (new_config); 1 external calls (defaults_for_max_concurrency).


##### `Config::codex_home`  (lines 1127–1129)

```
fn codex_home(&self) -> PathBuf
```

**Purpose**: Implements `AuthManagerConfig` by exposing the configured Codex home directory as an owned `PathBuf`.

**Data flow**: It clones `self.codex_home` into a `PathBuf` and returns it.

**Call relations**: Auth/login code calls this trait method when it needs the state directory location.

*Call graph*: calls 1 internal fn (to_path_buf).


##### `Config::cli_auth_credentials_store_mode`  (lines 1131–1133)

```
fn cli_auth_credentials_store_mode(&self) -> AuthCredentialsStoreMode
```

**Purpose**: Implements `AuthManagerConfig` by returning the resolved CLI auth credential storage mode.

**Data flow**: It reads and returns `self.cli_auth_credentials_store_mode` by value.

**Call relations**: This trait method is consumed by auth-management code deciding where to persist CLI credentials.


##### `Config::auth_keyring_backend_kind`  (lines 1135–1137)

```
fn auth_keyring_backend_kind(&self) -> AuthKeyringBackendKind
```

**Purpose**: Implements `AuthManagerConfig` by resolving the concrete keyring backend kind from the config.

**Data flow**: It passes `self` to `Config::auth_keyring_backend_kind` and returns the resulting `AuthKeyringBackendKind`.

**Call relations**: It is used when building MCP config so OAuth flows know which keyring backend to use.

*Call graph*: called by 1 (to_mcp_config_with_plugin_registrations); 1 external calls (auth_keyring_backend_kind).


##### `Config::forced_chatgpt_workspace_id`  (lines 1139–1141)

```
fn forced_chatgpt_workspace_id(&self) -> Option<Vec<String>>
```

**Purpose**: Implements `AuthManagerConfig` by returning any configured ChatGPT workspace restriction list.

**Data flow**: It clones and returns `self.forced_chatgpt_workspace_id`.

**Call relations**: Auth/login flows use this to constrain workspace selection during ChatGPT authentication.


##### `Config::chatgpt_base_url`  (lines 1143–1145)

```
fn chatgpt_base_url(&self) -> String
```

**Purpose**: Implements `AuthManagerConfig` by returning the configured ChatGPT backend base URL.

**Data flow**: It clones and returns `self.chatgpt_base_url`.

**Call relations**: This trait method feeds auth and MCP code that must contact ChatGPT-owned endpoints.


##### `ConfigBuilder::codex_home`  (lines 1161–1164)

```
fn codex_home(mut self, codex_home: PathBuf) -> Self
```

**Purpose**: Sets an explicit Codex home directory on the builder.

**Data flow**: It takes ownership of a `PathBuf`, stores it in `self.codex_home`, and returns the updated builder.

**Call relations**: Callers use this fluent setter before `build` when they want to bypass environment/home-directory discovery.


##### `ConfigBuilder::cli_overrides`  (lines 1166–1169)

```
fn cli_overrides(mut self, cli_overrides: Vec<(String, TomlValue)>) -> Self
```

**Purpose**: Attaches CLI TOML-path overrides to the builder.

**Data flow**: It stores the provided `Vec<(String, TomlValue)>` in `self.cli_overrides` and returns the builder.

**Call relations**: These overrides are later passed into config-layer loading in `build_inner`.


##### `ConfigBuilder::harness_overrides`  (lines 1171–1174)

```
fn harness_overrides(mut self, harness_overrides: ConfigOverrides) -> Self
```

**Purpose**: Attaches runtime-only `ConfigOverrides` to the builder.

**Data flow**: It stores the provided `ConfigOverrides` in `self.harness_overrides` and returns the builder.

**Call relations**: These overrides are applied after TOML loading inside `Config::load_config_with_layer_stack`.


##### `ConfigBuilder::loader_overrides`  (lines 1176–1179)

```
fn loader_overrides(mut self, loader_overrides: LoaderOverrides) -> Self
```

**Purpose**: Configures low-level loader behavior such as managed-config suppression.

**Data flow**: It stores the provided `LoaderOverrides` in `self.loader_overrides` and returns the builder.

**Call relations**: These options are forwarded into `load_config_layers_state` during build.


##### `ConfigBuilder::strict_config`  (lines 1181–1184)

```
fn strict_config(mut self, strict_config: bool) -> Self
```

**Purpose**: Controls whether config loading should run in strict mode.

**Data flow**: It stores the boolean in `self.strict_config` and returns the builder.

**Call relations**: The flag is consumed by `build_inner` when constructing `ConfigLoadOptions`.


##### `ConfigBuilder::cloud_config_bundle`  (lines 1186–1189)

```
fn cloud_config_bundle(mut self, cloud_config_bundle: CloudConfigBundleLoader) -> Self
```

**Purpose**: Supplies a cloud-managed config bundle loader to the builder.

**Data flow**: It stores the provided `CloudConfigBundleLoader` in `self.cloud_config_bundle` and returns the builder.

**Call relations**: This bundle loader is passed into config-layer loading so managed cloud config can participate in the layer stack.


##### `ConfigBuilder::thread_config_loader`  (lines 1191–1197)

```
fn thread_config_loader(
        mut self,
        thread_config_loader: Arc<dyn ThreadConfigLoader>,
    ) -> Self
```

**Purpose**: Supplies a thread-scoped config loader implementation to the builder.

**Data flow**: It wraps the provided `Arc<dyn ThreadConfigLoader>` in `Some` and stores it on the builder before returning it.

**Call relations**: If present, `build_inner` passes this loader to `load_config_layers_state`; otherwise it uses the no-op loader.


##### `ConfigBuilder::fallback_cwd`  (lines 1199–1202)

```
fn fallback_cwd(mut self, fallback_cwd: Option<PathBuf>) -> Self
```

**Purpose**: Sets an optional fallback working directory to use when no explicit override is present.

**Data flow**: It stores the optional `PathBuf` in `self.fallback_cwd` and returns the builder.

**Call relations**: This value participates in cwd resolution inside `build_inner` before layer loading.


##### `ConfigBuilder::build`  (lines 1204–1207)

```
async fn build(self) -> std::io::Result<Config>
```

**Purpose**: Asynchronously builds a full `Config` from the builder state while pinning the large future off small runtime stacks.

**Data flow**: It consumes the builder, boxes and pins `self.build_inner()`, awaits it, and returns the resulting `std::io::Result<Config>`.

**Call relations**: This is the public builder entry point used by runtime startup code.

*Call graph*: calls 1 internal fn (build_inner); called by 1 (build_config_on_runtime_worker); 1 external calls (pin).


##### `ConfigBuilder::build_inner`  (lines 1209–1316)

```
async fn build_inner(self) -> std::io::Result<Config>
```

**Purpose**: Performs the actual config-layer loading, merged-TOML deserialization, optional lockfile replay, and final `Config` construction.

**Data flow**: It resolves `codex_home`, CLI overrides, harness overrides, loader overrides, and cwd; loads a `ConfigLayerStack`; deserializes the effective TOML into `ConfigToml`; checks for debug config-lock settings; if a lockfile load path is configured, reads and converts the lockfile into a synthetic layer stack and loads config from that stripped config; otherwise it calls `Config::load_config_with_layer_stack` with the merged TOML and original layer stack. It returns the final `Config` or an `io::Error` with config-source-aware diagnostics.

**Call relations**: This is called only by `ConfigBuilder::build` and is the top-level orchestration step before the heavy semantic loader runs.

*Call graph*: calls 9 internal fn (load_config_layers_state, new, find_codex_home, config_without_lock_controls, lock_layer_from_config, read_config_lock_from_path, current_dir, from_absolute_path, relative_to_current_dir); called by 1 (build); 5 external calls (new, load_config_with_layer_stack, new, io_error_from_config_error, vec!).


##### `ConfigBuilder::without_managed_config_for_tests`  (lines 1319–1321)

```
fn without_managed_config_for_tests() -> Self
```

**Purpose**: Creates a builder preconfigured to ignore managed config sources in tests.

**Data flow**: It starts from `Self::default()`, applies `LoaderOverrides::without_managed_config_for_tests()`, and returns the resulting builder.

**Call relations**: Test code uses this helper when it needs deterministic config loading without managed requirements or cloud layers.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 58 (test_config_with_cli_overrides, inline_instructions_set_base_instructions, active_profile_is_cleared_when_requirements_force_fallback, agent_role_file_metadata_overrides_config_toml_metadata, agent_role_file_name_takes_precedence_over_config_key, agent_role_file_without_developer_instructions_is_dropped_with_warning, agent_role_relative_config_file_resolves_against_config_toml, agent_role_without_description_after_merge_is_dropped_with_warning, approvals_reviewer_can_be_set_in_config_without_guardian_approval, approvals_reviewer_defaults_to_manual_only_without_guardian_feature (+15 more)); 1 external calls (default).


##### `Config::multi_agent_version_from_features`  (lines 1325–1333)

```
fn multi_agent_version_from_features(&self) -> MultiAgentVersion
```

**Purpose**: Maps the effective feature flags to the active multi-agent protocol version.

**Data flow**: It checks `self.features.enabled` for `Feature::MultiAgentV2` first, then `Feature::Collab`, and returns `MultiAgentVersion::V2`, `V1`, or `Disabled` accordingly.

**Call relations**: This helper is used by runtime code that needs to choose between old and new multi-agent tool surfaces.

*Call graph*: 1 external calls (enabled).


##### `Config::validate_multi_agent_v2_config`  (lines 1335–1344)

```
fn validate_multi_agent_v2_config(&self) -> std::io::Result<()>
```

**Purpose**: Rejects incompatible combinations of multi-agent v2 and legacy agent-thread settings.

**Data flow**: It reads feature flags and `self.agent_max_threads`; if multi-agent v2 is enabled and `agent_max_threads` is set, it returns an `InvalidInput` error, otherwise `Ok(())`.

**Call relations**: This validation is a post-load consistency check for callers that need to enforce mutually exclusive agent configuration modes.

*Call graph*: 2 external calls (new, enabled).


##### `Config::effective_agent_max_threads`  (lines 1346–1360)

```
fn effective_agent_max_threads(
        &self,
        multi_agent_version: MultiAgentVersion,
    ) -> Option<usize>
```

**Purpose**: Computes the effective maximum number of child agent threads allowed for the selected multi-agent version.

**Data flow**: It takes a `MultiAgentVersion`; for v2 it returns `Some(max_concurrent_threads_per_session.saturating_sub(1))`, reserving one slot for the current agent, and for disabled/v1 it returns `self.agent_max_threads` or the module default.

**Call relations**: Runtime scheduling code uses this to derive the actual thread cap from feature mode and config.


##### `Config::legacy_sandbox_policy`  (lines 1362–1364)

```
fn legacy_sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Returns the config’s effective permissions projected into the legacy sandbox-policy enum.

**Data flow**: It passes `self.cwd.as_path()` into `self.permissions.legacy_sandbox_policy(...)` and returns the resulting `SandboxPolicy`.

**Call relations**: This is the top-level compatibility accessor wrapping the lower-level `Permissions` projection.

*Call graph*: calls 2 internal fn (legacy_sandbox_policy, as_path).


##### `Config::set_legacy_sandbox_policy`  (lines 1366–1378)

```
fn set_legacy_sandbox_policy(
        &mut self,
        sandbox_policy: SandboxPolicy,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies a legacy sandbox policy to the config and synchronizes top-level workspace-root bookkeeping.

**Data flow**: It sets `workspace_roots_explicit` based on whether a `WorkspaceWrite` policy carries non-empty writable roots, delegates to `self.permissions.set_legacy_sandbox_policy`, then copies `self.permissions.workspace_roots()` into `self.workspace_roots`.

**Call relations**: This mutator keeps `Config`’s duplicated workspace-root fields aligned with the nested `Permissions` state.

*Call graph*: calls 3 internal fn (set_legacy_sandbox_policy, workspace_roots, as_path); 1 external calls (matches!).


##### `Config::effective_workspace_roots`  (lines 1380–1385)

```
fn effective_workspace_roots(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the union of runtime workspace roots and profile-defined workspace roots with duplicates removed.

**Data flow**: It clones `self.workspace_roots`, extends that vector with `self.permissions.profile_workspace_roots()`, deduplicates via `dedupe_absolute_paths`, and returns the resulting `Vec<AbsolutePathBuf>`.

**Call relations**: Callers use this when they need the full effective root set rather than only runtime or profile roots separately.

*Call graph*: calls 2 internal fn (profile_workspace_roots, dedupe_absolute_paths).


##### `Config::to_models_manager_config`  (lines 1387–1397)

```
fn to_models_manager_config(&self) -> ModelsManagerConfig
```

**Purpose**: Extracts the subset of config needed by the models manager subsystem.

**Data flow**: It reads model window/compaction/token-limit fields, base instructions, personality feature enablement, reasoning-summary support, and optional model catalog from `self`, and returns a `ModelsManagerConfig` value.

**Call relations**: This is an adapter from the monolithic `Config` into the narrower models-manager configuration type.

*Call graph*: 1 external calls (enabled).


##### `Config::plugins_config_input`  (lines 1400–1407)

```
fn plugins_config_input(&self) -> PluginsConfigInput
```

**Purpose**: Builds the plugin-manager input object from the effective config and feature flags.

**Data flow**: It clones `self.config_layer_stack`, reads plugin-related feature flags and `chatgpt_base_url`, and constructs a `PluginsConfigInput` with those values.

**Call relations**: It is used by MCP config assembly to ask the plugin manager which plugins are active under the current config.

*Call graph*: calls 1 internal fn (new); called by 1 (to_mcp_config_with_plugin_registrations); 2 external calls (clone, enabled).


##### `Config::apply_plugin_mcp_server_requirements`  (lines 1410–1427)

```
fn apply_plugin_mcp_server_requirements(
        &self,
        plugin_id: &str,
        mcp_servers: &mut HashMap<String, McpServerConfig>,
    )
```

**Purpose**: Applies managed plugin-specific and global MCP server requirements to a mutable plugin server map.

**Data flow**: It takes a plugin config name and mutable `HashMap<String, McpServerConfig>`, filters the map first by plugin-specific requirements from `requirements().plugins`, then by an empty global MCP allowlist if one is configured, mutating server `enabled` and `disabled_reason` fields in place.

**Call relations**: This helper is called while assembling the MCP catalog from active plugins so disallowed plugin servers are disabled before registration.

*Call graph*: calls 3 internal fn (requirements, filter_mcp_servers_by_requirements, filter_plugin_mcp_servers_by_requirements); called by 1 (to_mcp_config_with_plugin_registrations).


##### `Config::to_mcp_config`  (lines 1429–1438)

```
async fn to_mcp_config(
        &self,
        plugins_manager: &codex_core_plugins::PluginsManager,
    ) -> McpConfig
```

**Purpose**: Builds the effective `McpConfig` using the current config and plugin manager, with no extra registrations.

**Data flow**: It forwards `self`, the plugin manager, and an empty iterator of additional registrations into `to_mcp_config_with_plugin_registrations` and returns the resulting `McpConfig`.

**Call relations**: This is the public convenience wrapper around the more general MCP-config builder.

*Call graph*: calls 1 internal fn (to_mcp_config_with_plugin_registrations).


##### `Config::to_mcp_config_with_plugin_registrations`  (lines 1440–1508)

```
async fn to_mcp_config_with_plugin_registrations(
        &self,
        plugins_manager: &codex_core_plugins::PluginsManager,
        additional_plugin_registrations: impl IntoIterator<Item = McpServ
```

**Purpose**: Constructs the full MCP runtime configuration, including plugin-provided servers, config-defined servers, OAuth/keyring settings, feature-gated capabilities, and optional extra registrations.

**Data flow**: It builds plugin input, asks the plugin manager for active plugins, creates a `ResolvedMcpCatalog` builder, registers each active plugin’s MCP servers after requirement filtering and attribution tagging, adds any extra registrations, then registers config-defined servers from `self.mcp_servers`. Finally it assembles and returns an `McpConfig` containing URLs, credential-store settings, sandbox executable paths, approval policy, feature flags, elicitation capability, the built catalog, and plugin capability summaries.

**Call relations**: This is called by `to_mcp_config` and serves as the main bridge from config state into the MCP subsystem.

*Call graph*: calls 11 internal fn (new, from_config, from_plugin, builder, get, plugins_for_config, apply_plugin_mcp_server_requirements, auth_keyring_backend_kind, plugins_config_input, prefix_mcp_tool_names (+1 more)); called by 1 (to_mcp_config); 5 external calls (default, default, default, enabled, use_legacy_landlock).


##### `Config::prefix_mcp_tool_names`  (lines 1510–1512)

```
fn prefix_mcp_tool_names(&self) -> bool
```

**Purpose**: Determines whether MCP tool names should retain the legacy prefixing behavior.

**Data flow**: It returns the negation of `self.features.enabled(Feature::NonPrefixedMcpToolNames)`.

**Call relations**: The MCP config builder uses this to decide how tool names are exposed to the model.

*Call graph*: called by 1 (to_mcp_config_with_plugin_registrations); 1 external calls (enabled).


##### `Config::rebuild_preserving_session_layers`  (lines 1514–1575)

```
async fn rebuild_preserving_session_layers(
        &self,
        refreshed_config: &Config,
    ) -> std::io::Result<Self>
```

**Purpose**: Rebuilds config from a refreshed base config while preserving the current session-only layers.

**Data flow**: It collects non-session layers from `refreshed_config`, appends session layers from `self`, sorts by precedence, rebuilds a `ConfigLayerStack` with refreshed requirements and ignore flags, deserializes the effective config back into `ConfigToml`, carries forward cwd and default zsh path as overrides, and reloads via `load_config_with_layer_stack`.

**Call relations**: This is used during config refresh flows where session flags must survive a reload of user/project/system layers.

*Call graph*: calls 3 internal fn (get_layers, new, to_path_buf); 2 external calls (default, load_config_with_layer_stack).


##### `Config::load_with_cli_overrides`  (lines 1578–1585)

```
async fn load_with_cli_overrides(
        cli_overrides: Vec<(String, TomlValue)>,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads a full config using only CLI TOML overrides on top of normal layer discovery.

**Data flow**: It creates a default `ConfigBuilder`, applies `cli_overrides`, calls `build`, and returns the resulting async `io::Result<Config>`.

**Call relations**: This is the preferred high-level config-loading entry point for most callers.

*Call graph*: 1 external calls (default).


##### `Config::load_default_with_cli_overrides`  (lines 1588–1597)

```
async fn load_default_with_cli_overrides(
        cli_overrides: Vec<(String, TomlValue)>,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads a default config for the current Codex home without reading user config when normal config is invalid or unavailable.

**Data flow**: It resolves `codex_home` with `find_codex_home`, then delegates to `load_default_with_cli_overrides_for_codex_home` with the provided CLI overrides.

**Call relations**: This is a fallback startup path used when the application needs a safe default config despite broken user config.

*Call graph*: calls 1 internal fn (find_codex_home); 1 external calls (load_default_with_cli_overrides_for_codex_home).


##### `Config::load_default_with_cli_overrides_for_codex_home`  (lines 1601–1623)

```
async fn load_default_with_cli_overrides_for_codex_home(
        codex_home: PathBuf,
        cli_overrides: Vec<(String, TomlValue)>,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds a config from `ConfigToml::default()` plus CLI overrides for a specific Codex home, bypassing normal layer loading.

**Data flow**: It serializes `ConfigToml::default()` into TOML, merges a CLI override layer into it, converts the supplied home path into `AbsolutePathBuf`, deserializes the merged TOML with that base directory, and loads the result through `load_config_with_layer_stack` using an empty `ConfigLayerStack` and default overrides.

**Call relations**: This is the concrete implementation behind the default-config fallback path.

*Call graph*: calls 2 internal fn (deserialize_config_toml_with_base, from_absolute_path_checked); 7 external calls (load_config_with_layer_stack, build_cli_overrides_layer, merge_toml_values, default, default, default, try_from).


##### `Config::load_with_cli_overrides_and_harness_overrides`  (lines 1632–1641)

```
async fn load_with_cli_overrides_and_harness_overrides(
        cli_overrides: Vec<(String, TomlValue)>,
        harness_overrides: ConfigOverrides,
    ) -> std::io::Result<Self>
```

**Purpose**: Loads config with both CLI TOML overrides and runtime-only harness overrides, ignoring unsupported-in-TOML settings through the builder path.

**Data flow**: It creates a default `ConfigBuilder`, sets `cli_overrides` and `harness_overrides`, calls `build`, and returns the resulting config.

**Call relations**: This is used by harnesses/subcommands that need to force runtime-only settings such as cwd or sandbox executables.

*Call graph*: 1 external calls (default).


##### `resolve_profile_v2_config_path`  (lines 1644–1652)

```
fn resolve_profile_v2_config_path(
    codex_home: &Path,
    profile_name: &ProfileV2Name,
) -> AbsolutePathBuf
```

**Purpose**: Computes the absolute path of a profile-v2 config file under `codex_home`.

**Data flow**: It formats `<profile_name>.config.toml` and resolves that relative filename against the supplied `codex_home`, returning an `AbsolutePathBuf`.

**Call relations**: Startup/profile-selection code uses this helper when locating named profile config files.

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

**Purpose**: Deprecated helper that loads merged config as raw `ConfigToml` with CLI overrides and loader overrides.

**Data flow**: It forwards its arguments to `load_config_as_toml_with_cli_and_loader_overrides` and returns the resulting `ConfigToml`.

**Call relations**: This remains for callers that still need partially processed TOML rather than a fully constrained `Config`.

*Call graph*: calls 1 internal fn (load_config_as_toml_with_cli_and_loader_overrides).


##### `load_config_as_toml_with_cli_and_loader_overrides`  (lines 1676–1684)

```
async fn load_config_as_toml_with_cli_and_loader_overrides(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_overrides: Vec<(String, TomlValue)>,
    loader_overrides: LoaderOverrides
```

**Purpose**: Deprecated wrapper that loads merged config as `ConfigToml` using explicit loader overrides.

**Data flow**: It forwards to `load_config_as_toml_with_cli_and_load_options`, passing the loader overrides as load options, and returns the resulting `ConfigToml`.

**Call relations**: It sits between the oldest TOML-loading API and the newer load-options-based helper.

*Call graph*: calls 1 internal fn (load_config_as_toml_with_cli_and_load_options); called by 1 (load_config_as_toml_with_cli_overrides).


##### `load_config_as_toml_with_cli_and_load_options`  (lines 1690–1699)

```
async fn load_config_as_toml_with_cli_and_load_options(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_overrides: Vec<(String, TomlValue)>,
    options: impl Into<ConfigLoadOptions>
```

**Purpose**: Deprecated helper that loads merged config as `ConfigToml` while still exposing managed requirements through the underlying layer stack loader.

**Data flow**: It calls `load_config_toml_with_layer_stack`, extracts `.config_toml` from the result, and returns it.

**Call relations**: This is the last wrapper before the partial-load function that returns both TOML and layer stack.

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

**Purpose**: Loads merged config layers and returns both the deserialized `ConfigToml` and the `ConfigLayerStack` used to derive it.

**Data flow**: It calls `load_config_layers_state` with the supplied home, cwd, CLI overrides, and load options; obtains the effective merged TOML; deserializes it with `deserialize_config_toml_with_base`; and returns `ConfigTomlLoadResult { config_toml, config_layer_stack }`.

**Call relations**: Bootstrap/startup paths use this when they need to inspect raw config before constructing a full `Config`.

*Call graph*: calls 2 internal fn (load_config_layers_state, deserialize_config_toml_with_base); called by 4 (load_config_as_toml_with_cli_and_load_options, load_bootstrap_config_or_exit, load_bootstrap_config_or_exit, start_app_server_for_archive_command).


##### `deserialize_config_toml_with_base`  (lines 1741–1751)

```
fn deserialize_config_toml_with_base(
    root_value: TomlValue,
    config_base_dir: &Path,
) -> std::io::Result<ConfigToml>
```

**Purpose**: Deserializes a TOML value into `ConfigToml` while resolving any `AbsolutePathBuf` fields relative to a specified base directory.

**Data flow**: It creates an `AbsolutePathBufGuard` for `config_base_dir`, attempts `root_value.try_into::<ConfigToml>()`, and maps deserialization failures into `InvalidData` I/O errors.

**Call relations**: This helper is used by config loading, config editing, and schema-related code whenever merged TOML must be interpreted with a known base path.

*Call graph*: calls 1 internal fn (new); called by 5 (apply_edits, load_role_layer_toml, deserialize_effective_config, load_default_with_cli_overrides_for_codex_home, load_config_toml_with_layer_stack); 1 external calls (try_into).


##### `validate_feature_requirements_for_config_toml`  (lines 1754–1760)

```
fn validate_feature_requirements_for_config_toml(
    cfg: &ConfigToml,
    feature_requirements: Option<&Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<()>
```

**Purpose**: Checks user-visible feature settings in `ConfigToml` against managed feature requirements.

**Data flow**: It passes the config and optional sourced feature requirements into two validation functions in `managed_features`, returning the first error encountered or `Ok(())`.

**Call relations**: Config-editing flows call this before persisting changes so invalid feature combinations are rejected early.

*Call graph*: calls 2 internal fn (validate_explicit_feature_settings_in_config_toml, validate_feature_requirements_in_config_toml); called by 1 (apply_edits).


##### `load_catalog_json`  (lines 1762–1783)

```
fn load_catalog_json(path: &AbsolutePathBuf) -> std::io::Result<ModelsResponse>
```

**Purpose**: Reads and validates a model catalog JSON file from disk.

**Data flow**: It reads the file contents as a string, parses them into `ModelsResponse`, returns an `InvalidData` error with the path embedded if JSON parsing fails, and additionally rejects catalogs whose `models` list is empty.

**Call relations**: It is the file-reading backend for optional `model_catalog_json` support during config loading.

*Call graph*: 3 external calls (new, format!, read_to_string).


##### `load_model_catalog`  (lines 1785–1791)

```
fn load_model_catalog(
    model_catalog_json: Option<AbsolutePathBuf>,
) -> std::io::Result<Option<ModelsResponse>>
```

**Purpose**: Optionally loads a model catalog from a configured absolute path.

**Data flow**: It maps `Option<AbsolutePathBuf>` to `Option<ModelsResponse>` by calling `load_catalog_json` when a path is present and transposing the result.

**Call relations**: The full config loader uses this to populate `Config.model_catalog`.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `filter_mcp_servers_by_requirements`  (lines 1793–1816)

```
fn filter_mcp_servers_by_requirements(
    mcp_servers: &mut HashMap<String, McpServerConfig>,
    mcp_requirements: Option<&Sourced<BTreeMap<String, McpServerRequirement>>>,
)
```

**Purpose**: Disables MCP servers that are not allowed by managed global MCP requirements.

**Data flow**: It takes a mutable server map and optional sourced allowlist requirements. For each server, it checks whether a matching requirement exists and whether the server transport matches the required identity; allowed servers have `disabled_reason` cleared, while disallowed servers are marked `enabled = false` with `McpServerDisabledReason::Requirements { source }`.

**Call relations**: This is used directly by plugin MCP filtering and indirectly by constrained MCP-server construction.

*Call graph*: called by 1 (apply_plugin_mcp_server_requirements).


##### `filter_plugin_mcp_servers_by_requirements`  (lines 1818–1845)

```
fn filter_plugin_mcp_servers_by_requirements(
    plugin_config_name: &str,
    mcp_servers: &mut HashMap<String, McpServerConfig>,
    plugin_requirements: Option<&Sourced<BTreeMap<String, PluginRequ
```

**Purpose**: Disables plugin-provided MCP servers that are not allowed by plugin-specific managed requirements.

**Data flow**: It looks up the plugin’s requirement block by config name, then iterates the mutable server map and marks each server enabled or disabled based on whether a matching requirement exists and matches the server identity, attaching the requirement source on disable.

**Call relations**: It is called from `Config::apply_plugin_mcp_server_requirements` before global MCP filtering.

*Call graph*: called by 1 (apply_plugin_mcp_server_requirements).


##### `constrain_mcp_servers`  (lines 1847–1860)

```
fn constrain_mcp_servers(
    mcp_servers: HashMap<String, McpServerConfig>,
    mcp_requirements: Option<&Sourced<BTreeMap<String, McpServerRequirement>>>,
) -> ConstraintResult<Constrained<HashMap<S
```

**Purpose**: Wraps the configured MCP server map in a `Constrained` value that enforces managed MCP requirements by normalization.

**Data flow**: If no requirements are present it returns `Constrained::allow_any(mcp_servers)`. Otherwise it clones the sourced requirements and returns `Constrained::normalized(...)` with a closure that filters the server map through `filter_mcp_servers_by_requirements`.

**Call relations**: The full config loader uses this so MCP server constraints remain attached to the final `Config.mcp_servers` value.

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

**Purpose**: Attempts to apply a configured value to a requirement-constrained field, falling back to the requirement-compliant value and recording a startup warning if the configured value is disallowed.

**Data flow**: It takes a field name, configured value, mutable `ConstrainedWithSource<T>`, and mutable warning vector. It tries `set(configured_value)`; on failure it logs a warning, formats and pushes a startup warning mentioning the fallback value and error, then re-applies the current constrained value as the fallback. It returns `Ok(true)` if fallback occurred, `Ok(false)` if the configured value was accepted, or an `io::Error` if even the fallback could not be set.

**Call relations**: This helper is repeatedly used inside `Config::load_config_with_layer_stack` for approval policy, reviewer, permission profile, web search mode, and Windows sandbox mode.

*Call graph*: called by 1 (load_config_with_layer_stack); 4 external calls (get, set, format!, warn!).


##### `mcp_server_matches_requirement`  (lines 1898–1916)

```
fn mcp_server_matches_requirement(
    requirement: &McpServerRequirement,
    server: &McpServerConfig,
) -> bool
```

**Purpose**: Checks whether an MCP server config matches a managed requirement’s declared identity.

**Data flow**: It pattern-matches the requirement identity: command requirements match only `McpServerTransportConfig::Stdio` with the same command, and URL requirements match only `StreamableHttp` with the same URL. It returns a boolean.

**Call relations**: The MCP filtering helpers use this predicate when deciding whether a configured or plugin-provided server is allowed.

*Call graph*: 1 external calls (matches!).


##### `load_global_mcp_servers`  (lines 1918–1952)

```
async fn load_global_mcp_servers(
    codex_home: &Path,
) -> std::io::Result<BTreeMap<String, McpServerConfig>>
```

**Purpose**: Loads the merged global `mcp_servers` table from config layers without project cwd context and rejects deprecated inline bearer tokens.

**Data flow**: It loads config layers with no cwd and no CLI overrides, extracts the `mcp_servers` TOML table from the merged config if present, runs `ensure_no_inline_bearer_tokens`, deserializes the table into `BTreeMap<String, McpServerConfig>`, and returns an empty map if the table is absent.

**Call relations**: CLI commands that list/add/remove global MCP servers use this raw-loading helper because they need direct access to the merged TOML representation.

*Call graph*: calls 2 internal fn (load_config_layers_state, ensure_no_inline_bearer_tokens); called by 11 (run_add, run_remove, add_and_remove_server_updates_global_config, add_cant_add_command_and_url, add_streamable_http_rejects_removed_flag, add_streamable_http_with_custom_env_var, add_streamable_http_with_oauth_options, add_streamable_http_without_manual_token, add_with_env_preserves_key_order_and_values, get_disabled_server_shows_single_line (+1 more)); 3 external calls (new, new, default).


##### `ensure_no_inline_bearer_tokens`  (lines 1956–1973)

```
fn ensure_no_inline_bearer_tokens(value: &TomlValue) -> std::io::Result<()>
```

**Purpose**: Rejects MCP server configs that still use the removed plain-text `bearer_token` field.

**Data flow**: It inspects a TOML value as a table of server tables; if any server table contains `bearer_token`, it returns an `InvalidData` error instructing the user to use `bearer_token_env_var`; otherwise it returns `Ok(())`.

**Call relations**: It is called by `load_global_mcp_servers` as a temporary compatibility guard against recently removed insecure config syntax.

*Call graph*: called by 1 (load_global_mcp_servers); 3 external calls (as_table, new, format!).


##### `set_project_trust_level_inner`  (lines 1975–2042)

```
fn set_project_trust_level_inner(
    doc: &mut DocumentMut,
    project_path: &Path,
    trust_level: TrustLevel,
) -> anyhow::Result<()>
```

**Purpose**: Mutates a TOML document in memory to set a project’s trust level under the `[projects]` table using explicit nested tables rather than inline tables.

**Data flow**: It computes the project key, ensures the top-level `projects` item exists as a standard table (converting an inline table if necessary), ensures the per-project entry is also an explicit table, sets `trust_level` to the string form of the supplied `TrustLevel`, and returns `anyhow::Result<()>`.

**Call relations**: Config-edit application code calls this helper when persisting project trust changes into `config.toml`.

*Call graph*: calls 1 internal fn (project_trust_key); called by 1 (apply); 7 external calls (as_table_mut, anyhow!, to_string, Table, new, table, value).


##### `set_project_trust_level`  (lines 2046–2056)

```
fn set_project_trust_level(
    codex_home: &Path,
    project_path: &Path,
    trust_level: TrustLevel,
) -> anyhow::Result<()>
```

**Purpose**: Persists a project trust-level change into `CODEX_HOME/config.toml`.

**Data flow**: It creates a `ConfigEditsBuilder` for `codex_home`, adds a project-trust edit via `set_project_trust_level`, applies the edit synchronously with `apply_blocking`, and returns the resulting `anyhow::Result<()>`.

**Call relations**: Higher-level commands and task startup flows call this convenience wrapper instead of editing TOML directly.

*Call graph*: calls 1 internal fn (new); called by 10 (thread_start_task, config_read_includes_project_layers_for_cwd, hooks_list_uses_each_cwds_effective_feature_enablement, hooks_list_uses_root_repo_hooks_for_linked_worktrees, mcp_server_status_list_uses_thread_project_local_config, permission_profile_list_discovers_project_profiles_without_default_selection, permission_profile_list_resolves_project_profiles_and_paginates, plugin_list_uses_home_config_for_enabled_state, thread_start_respects_project_config_from_cwd, thread_start_skips_trust_write_when_project_is_already_trusted).


##### `set_default_oss_provider`  (lines 2059–2072)

```
fn set_default_oss_provider(codex_home: &Path, provider: &str) -> std::io::Result<()>
```

**Purpose**: Persists the default OSS provider selection into `config.toml` after validating the provider name.

**Data flow**: It validates the provider string with `validate_oss_provider`, builds a single `ConfigEdit::SetPath` targeting `oss_provider`, applies it through `ConfigEditsBuilder::with_edits(...).apply_blocking()`, and maps edit failures into `std::io::Error::other`.

**Call relations**: This helper is used by commands that let users save a preferred local/OSS provider.

*Call graph*: calls 2 internal fn (validate_oss_provider, new); 1 external calls (vec!).


##### `resolve_tool_suggest_config`  (lines 2091–2096)

```
fn resolve_tool_suggest_config(
    config_toml: &ConfigToml,
    config_layer_stack: &ConfigLayerStack,
) -> ToolSuggestConfig
```

**Purpose**: Resolves the effective tool-suggestion configuration from `ConfigToml` plus layer-stack semantics.

**Data flow**: It reads `config_toml.tool_suggest.as_ref()` and forwards that plus the layer stack into `resolve_tool_suggest_config_from_config`, returning the resulting `ToolSuggestConfig`.

**Call relations**: The full config loader uses this to populate `Config.tool_suggest`.

*Call graph*: calls 1 internal fn (resolve_tool_suggest_config_from_config); called by 1 (load_config_with_layer_stack).


##### `resolve_tool_suggest_config_from_layer_stack`  (lines 2098–2107)

```
fn resolve_tool_suggest_config_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
) -> ToolSuggestConfig
```

**Purpose**: Resolves tool-suggestion config directly from the effective layer stack without needing a pre-deserialized `ConfigToml` field.

**Data flow**: It extracts `tool_suggest` from `config_layer_stack.effective_config()`, attempts to deserialize it into `ToolSuggestConfig`, and forwards the optional config plus the layer stack into `resolve_tool_suggest_config_from_config`.

**Call relations**: Runtime config refresh paths use this when they already have a layer stack and need to recompute tool-suggestion settings.

*Call graph*: calls 2 internal fn (effective_config, resolve_tool_suggest_config_from_config); called by 2 (refresh_runtime_config, reload_user_config_layer).


##### `resolve_tool_suggest_config_from_config`  (lines 2109–2169)

```
fn resolve_tool_suggest_config_from_config(
    tool_suggest: Option<&ToolSuggestConfig>,
    config_layer_stack: &ConfigLayerStack,
) -> ToolSuggestConfig
```

**Purpose**: Builds the final `ToolSuggestConfig`, trimming discoverable IDs and merging disabled-tool entries across layers with deduplication.

**Data flow**: It collects non-empty trimmed discoverables from the optional config, then accumulates disabled tools into a deduplicated vector using a `HashSet` and each tool’s normalized form. If there are no active layers it uses the provided config directly; otherwise it walks active layers from lowest to highest precedence, deserializes each layer’s `tool_suggest`, and appends disabled tools in layer order. It returns a `ToolSuggestConfig { discoverables, disabled_tools }`.

**Call relations**: Both tool-suggest resolution entry points delegate here so layer-aware disabled-tool merging is centralized.

*Call graph*: calls 1 internal fn (get_layers); called by 2 (resolve_tool_suggest_config, resolve_tool_suggest_config_from_layer_stack); 2 external calls (new, new).


##### `thread_store_config`  (lines 2171–2177)

```
fn thread_store_config(thread_store: Option<ThreadStoreToml>) -> ThreadStoreConfig
```

**Purpose**: Converts optional TOML thread-store configuration into the runtime `ThreadStoreConfig` enum.

**Data flow**: It matches `Option<ThreadStoreToml>` and returns `ThreadStoreConfig::Local` for `None` or `Local {}`, and `ThreadStoreConfig::InMemory { id }` for the in-memory variant.

**Call relations**: The full config loader uses this when populating `Config.experimental_thread_store`.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `is_session_layer`  (lines 2179–2181)

```
fn is_session_layer(source: &ConfigLayerSource) -> bool
```

**Purpose**: Identifies whether a config layer source represents session flags.

**Data flow**: It pattern-matches the `ConfigLayerSource` against `ConfigLayerSource::SessionFlags` and returns a boolean.

**Call relations**: This predicate is used when rebuilding config while preserving session-only layers.

*Call graph*: 1 external calls (matches!).


##### `EffectivePermissionSelection::has_profiles`  (lines 2206–2210)

```
fn has_profiles(&self) -> bool
```

**Purpose**: Reports whether the effective permission selection includes any available profile catalog entries.

**Data flow**: It checks whether `self.profiles` is `Some` and non-empty, returning a boolean.

**Call relations**: The full config loader uses this to detect invalid states such as defining profiles without selecting one.


##### `EffectivePermissionSelection::profiles_are_active`  (lines 2212–2224)

```
fn profiles_are_active(
        &self,
        default_permissions_override: Option<&str>,
        permission_config_syntax: Option<PermissionConfigSyntax>,
    ) -> bool
```

**Purpose**: Determines whether named-profile semantics should be active for the current config/override combination.

**Data flow**: It returns true if requirements force profile selection, if a `default_permissions` override is present, if the resolved syntax is explicitly `Profiles`, or if no syntax was selected at all; otherwise false.

**Call relations**: This decision drives whether config loading compiles named profiles or falls back to legacy sandbox-mode derivation.

*Call graph*: 1 external calls (matches!).


##### `resolve_permission_config_syntax`  (lines 2227–2281)

```
fn resolve_permission_config_syntax(
    config_layer_stack: &ConfigLayerStack,
    cfg: &ConfigToml,
    sandbox_mode_override: Option<SandboxMode>,
) -> Option<PermissionConfigSyntax>
```

**Purpose**: Infers whether the effective config is using legacy `sandbox_mode` syntax or named `default_permissions` profile syntax.

**Data flow**: It first treats an explicit sandbox-mode override as legacy. It then checks the highest-precedence session-flags layer for `default_permissions`, scans active layers from low to high to see whether `sandbox_mode` or `default_permissions` appeared last, and finally falls back to the merged `ConfigToml` fields. It returns `Some(Legacy)`, `Some(Profiles)`, or `None` if neither syntax is present.

**Call relations**: The full config loader uses this inference to decide how to interpret permissions and whether legacy workspace-write settings should seed runtime roots.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (load_config_with_layer_stack).


##### `apply_managed_filesystem_constraints`  (lines 2283–2312)

```
fn apply_managed_filesystem_constraints(
    file_system_sandbox_policy: &mut FileSystemSandboxPolicy,
    filesystem_constraints: &codex_config::FilesystemConstraints,
)
```

**Purpose**: Adds managed deny-read filesystem constraints into an existing filesystem sandbox policy.

**Data flow**: It iterates `filesystem_constraints.deny_read`, converts each entry into either a glob-pattern or absolute-path `FileSystemSandboxEntry` with `Deny` access, skips entries that cannot be parsed as absolute paths, and appends only entries not already present in the policy.

**Call relations**: This is called during full config loading after the effective permission profile has been derived, so managed deny-read rules are preserved in the final runtime policy.

*Call graph*: calls 1 internal fn (try_from); called by 1 (load_config_with_layer_stack).


##### `dedupe_absolute_paths`  (lines 2346–2349)

```
fn dedupe_absolute_paths(paths: &mut Vec<AbsolutePathBuf>)
```

**Purpose**: Removes duplicate absolute paths from a vector while preserving first occurrence order.

**Data flow**: It creates a `HashSet`, retains only paths whose clone inserts successfully into the set, and mutates the input vector in place.

**Call relations**: It is used when assembling workspace-root lists from multiple sources and when computing effective workspace roots.

*Call graph*: called by 2 (effective_workspace_roots, load_config_with_layer_stack); 1 external calls (new).


##### `resolve_oss_provider`  (lines 2353–2363)

```
fn resolve_oss_provider(
    explicit_provider: Option<&str>,
    config_toml: &ConfigToml,
) -> Option<String>
```

**Purpose**: Chooses the effective OSS provider from an explicit override or the global config field.

**Data flow**: It returns `Some(explicit_provider.to_string())` when an explicit provider is supplied; otherwise it clones and returns `config_toml.oss_provider`.

**Call relations**: Startup and archive-command code use this helper when deciding which local/OSS provider to activate.

*Call graph*: called by 3 (run_main, run_main, start_app_server_for_archive_command).


##### `resolve_web_search_mode`  (lines 2366–2377)

```
fn resolve_web_search_mode(config_toml: &ConfigToml, features: &Features) -> Option<WebSearchMode>
```

**Purpose**: Derives the configured web-search mode from explicit config or feature flags.

**Data flow**: It returns `config_toml.web_search` if set; otherwise it maps `Feature::WebSearchCached` to `Cached`, `Feature::WebSearchRequest` to `Live`, and returns `None` if neither feature is enabled.

**Call relations**: The full config loader uses this before applying managed constraints to web-search mode.

*Call graph*: calls 1 internal fn (enabled); called by 1 (load_config_with_layer_stack).


##### `resolve_web_search_config`  (lines 2379–2386)

```
fn resolve_web_search_config(config_toml: &ConfigToml) -> Option<WebSearchConfig>
```

**Purpose**: Extracts optional detailed web-search tool configuration from the nested tools config.

**Data flow**: It navigates `config_toml.tools.web_search`, clones the TOML config if present, converts it into `WebSearchConfig`, and returns `Option<WebSearchConfig>`.

**Call relations**: This is called during full config loading to populate `Config.web_search_config`.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_experimental_request_user_input_enabled`  (lines 2388–2394)

```
fn resolve_experimental_request_user_input_enabled(config_toml: &ConfigToml) -> bool
```

**Purpose**: Determines whether the experimental `request_user_input` tool should be registered.

**Data flow**: It inspects `config_toml.tools.experimental_request_user_input`; if absent it returns `true`, otherwise it returns the nested `enabled` flag.

**Call relations**: The full config loader uses this to populate the corresponding boolean on `Config`.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_code_mode_config`  (lines 2396–2405)

```
fn resolve_code_mode_config(config_toml: &ConfigToml) -> CodeModeConfig
```

**Purpose**: Builds the runtime code-mode config from feature TOML, currently extracting excluded tool namespaces.

**Data flow**: It reads the optional code-mode feature config via `code_mode_toml_config`, clones `excluded_tool_namespaces` if present, and returns a `CodeModeConfig` with an empty vector otherwise.

**Call relations**: This is called during full config loading after feature parsing.

*Call graph*: calls 1 internal fn (code_mode_toml_config); called by 1 (load_config_with_layer_stack).


##### `resolve_multi_agent_v2_config`  (lines 2407–2462)

```
fn resolve_multi_agent_v2_config(config_toml: &ConfigToml) -> MultiAgentV2Config
```

**Purpose**: Builds the runtime multi-agent v2 config by overlaying optional feature TOML onto concurrency-dependent defaults.

**Data flow**: It reads the optional feature config via `multi_agent_v2_toml_config`, determines `max_concurrent_threads_per_session`, computes a default config for that concurrency, then fills each field from the TOML config when present or from the default otherwise. Prompt fields are normalized through `resolve_optional_prompt_text` so empty strings disable them.

**Call relations**: The full config loader uses this before validating timeout ranges and namespace syntax.

*Call graph*: calls 3 internal fn (defaults_for_max_concurrency, multi_agent_v2_toml_config, resolve_optional_prompt_text); called by 1 (load_config_with_layer_stack).


##### `resolve_terminal_resize_reflow_config`  (lines 2464–2476)

```
fn resolve_terminal_resize_reflow_config(config_toml: &ConfigToml) -> TerminalResizeReflowConfig
```

**Purpose**: Converts TUI resize-reflow TOML settings into the runtime enum-based representation.

**Data flow**: It reads `config_toml.tui.terminal_resize_reflow_max_rows`; `Some(0)` becomes `Disabled`, positive values become `Limit(rows)`, and absence becomes `Auto`, wrapped in `TerminalResizeReflowConfig`.

**Call relations**: This is called during full config loading to populate `Config.terminal_resize_reflow`.

*Call graph*: called by 1 (load_config_with_layer_stack); 2 external calls (default, Limit).


##### `resolve_optional_prompt_text`  (lines 2478–2487)

```
fn resolve_optional_prompt_text(
    configured: Option<&Option<String>>,
    default: Option<String>,
) -> Option<String>
```

**Purpose**: Normalizes optional prompt text fields so explicit empty strings disable the prompt instead of falling back to defaults.

**Data flow**: It takes `Option<&Option<String>>` plus a default `Option<String>`. `Some(Some(empty))` returns `None`, `Some(Some(value))` clones and returns the value, and `Some(None)` or `None` returns the provided default.

**Call relations**: It is used by multi-agent v2 config resolution for root/subagent usage-hint text.

*Call graph*: called by 1 (resolve_multi_agent_v2_config).


##### `code_mode_toml_config`  (lines 2489–2494)

```
fn code_mode_toml_config(features: Option<&FeaturesToml>) -> Option<&CodeModeConfigToml>
```

**Purpose**: Extracts the nested code-mode feature config only when the feature is configured with a config payload rather than a bare enabled flag.

**Data flow**: It navigates `features?.code_mode`, returning `None` for `FeatureToml::Enabled(_)` and `Some(config)` for `FeatureToml::Config(config)`.

**Call relations**: This helper is used solely by `resolve_code_mode_config`.

*Call graph*: called by 1 (resolve_code_mode_config).


##### `multi_agent_v2_toml_config`  (lines 2496–2501)

```
fn multi_agent_v2_toml_config(features: Option<&FeaturesToml>) -> Option<&MultiAgentV2ConfigToml>
```

**Purpose**: Extracts the nested multi-agent-v2 feature config only when present as a config payload.

**Data flow**: It navigates `features?.multi_agent_v2`, returning `None` for bare enabled flags and `Some(config)` for configured payloads.

**Call relations**: This helper is used by `resolve_multi_agent_v2_config`.

*Call graph*: called by 1 (resolve_multi_agent_v2_config).


##### `network_proxy_toml_config`  (lines 2503–2508)

```
fn network_proxy_toml_config(features: Option<&FeaturesToml>) -> Option<&NetworkProxyConfigToml>
```

**Purpose**: Extracts the nested network-proxy feature config only when present as a config payload.

**Data flow**: It navigates `features?.network_proxy`, returning `None` for bare enabled flags and `Some(config)` for configured payloads.

**Call relations**: It is used during initial config loading and active-profile proxy recomputation when feature-level proxy settings need to be overlaid.

*Call graph*: called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `resolve_web_search_mode_for_turn`  (lines 2510–2544)

```
fn resolve_web_search_mode_for_turn(
    web_search_mode: &Constrained<WebSearchMode>,
    permission_profile: &PermissionProfile,
) -> WebSearchMode
```

**Purpose**: Chooses the best allowed web-search mode for a specific turn, taking both constraints and the current permission profile into account.

**Data flow**: It reads the preferred mode from `Constrained<WebSearchMode>`. If the permission profile is `Disabled` and the preferred mode is not `Disabled`, it tries `Live`, then `Cached`, then `Disabled`, returning the first mode accepted by `can_set`. Otherwise it first tries the preferred mode, then falls back through `Cached`, `Live`, and `Disabled`. If none are allowed, it returns `Disabled`.

**Call relations**: This helper is used by turn-level runtime logic that must reconcile constrained web-search settings with the current permission mode.

*Call graph*: calls 2 internal fn (can_set, value); 1 external calls (matches!).


##### `validate_multi_agent_v2_wait_timeout`  (lines 2546–2560)

```
fn validate_multi_agent_v2_wait_timeout(label: &str, value: i64) -> std::io::Result<()>
```

**Purpose**: Validates that a multi-agent v2 timeout value lies within the hard minimum and maximum bounds.

**Data flow**: It takes a label and integer timeout, compares it against `HARD_MIN_MULTI_AGENT_V2_TIMEOUT_MS` and `HARD_MAX_MULTI_AGENT_V2_TIMEOUT_MS`, and returns `InvalidInput` errors with field-specific messages when out of range; otherwise `Ok(())`.

**Call relations**: The full config loader calls this for min, max, and default wait timeout fields before checking their relative ordering.

*Call graph*: called by 1 (load_config_with_layer_stack); 2 external calls (new, format!).


##### `validate_multi_agent_v2_tool_namespace`  (lines 2562–2623)

```
fn validate_multi_agent_v2_tool_namespace(namespace: Option<&str>) -> std::io::Result<()>
```

**Purpose**: Validates the optional multi-agent v2 tool namespace against formatting, length, whitespace, and reserved-name rules.

**Data flow**: It returns early for `None`. For a present namespace it rejects empty strings, leading/trailing whitespace, non-ASCII-alphanumeric/underscore/hyphen characters, names longer than 64 characters, and reserved namespaces such as `mcp`, `mcp__*`, and several Responses API tool namespaces. It returns `Ok(())` only for valid names.

**Call relations**: This validation runs during full config loading after multi-agent v2 config resolution.

*Call graph*: called by 1 (load_config_with_layer_stack); 2 external calls (new, format!).


##### `Config::load_from_base_config_with_overrides`  (lines 2627–2642)

```
async fn load_from_base_config_with_overrides(
        cfg: ConfigToml,
        overrides: ConfigOverrides,
        codex_home: AbsolutePathBuf,
    ) -> std::io::Result<Self>
```

**Purpose**: Test-only helper that loads a config from a supplied base `ConfigToml` and runtime overrides without applying managed requirements.

**Data flow**: It creates a default empty `ConfigLayerStack` and forwards the supplied TOML, overrides, and `codex_home` into `load_config_with_layer_stack`.

**Call relations**: Tests use this to exercise config semantics in isolation from managed config enforcement.

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

**Purpose**: Performs the full semantic config load: validating raw TOML, applying managed requirements and overrides, resolving permissions and workspace roots, deriving feature flags, model/provider settings, MCP/network policy, and constructing the final `Config` plus startup warnings.

**Data flow**: It consumes `ConfigToml`, `ConfigOverrides`, `codex_home`, and a `ConfigLayerStack`. The function validates unsupported legacy fields and model providers; clones requirement constraints; accumulates startup warnings; destructures all overrides; rejects conflicting permission overrides; resolves feature flags and managed feature warnings; computes Windows sandbox mode and cwd; resolves active project trust; infers permission syntax; merges managed permission profiles; selects and compiles the effective permission profile, workspace roots, and network proxy config; derives approval policy, reviewer, web search, code mode, multi-agent config, terminal reflow, agent roles, model providers, shell policy, history, ghost snapshot compatibility settings, service tier, prompt overrides, file-based instructions, guardian policy config, zsh path, model catalog, log/sqlite directories, constrained values, MCP server constraints, managed filesystem/network constraints, helper-readable roots, OTEL config, and many UI/runtime fields. It returns a fully populated `Config` or an `io::Error` for invalid combinations or failed reads.

**Call relations**: This is the central config-construction engine called by builder paths, default-config loaders, and test helpers.

*Call graph*: calls 47 internal fn (derive_permission_profile, get_active_project, validate_model_providers, requirements, requirements_toml, startup_warnings, default, load_agent_roles, apply_managed_filesystem_constraints, apply_requirement_constrained_value (+15 more)); 19 external calls (pin, default, try_read_non_empty_file, new, new, sandbox_mode_requirement_for_permission_profile, resolve_root_git_project_for_trust, memory_root, built_in_model_providers, merge_configured_model_providers (+9 more)).


##### `Config::try_read_non_empty_file`  (lines 3735–3764)

```
async fn try_read_non_empty_file(
        fs: &dyn ExecutorFileSystem,
        path: Option<&AbsolutePathBuf>,
        context: &str,
    ) -> std::io::Result<Option<String>>
```

**Purpose**: Reads an optional file through the executor filesystem and returns trimmed contents only if the file exists and is non-empty.

**Data flow**: It takes an optional absolute path and context label. `None` returns `Ok(None)`. For `Some(path)`, it converts the path to `PathUri`, reads text via `fs.read_file_text`, wraps read errors with context and path, trims the contents, and returns `InvalidData` if the trimmed string is empty; otherwise `Ok(Some(trimmed_string))`.

**Call relations**: The full config loader uses this for `model_instructions_file` and `experimental_compact_prompt_file`.

*Call graph*: calls 2 internal fn (read_file_text, from_abs_path); 2 external calls (new, format!).


##### `Config::set_windows_sandbox_enabled`  (lines 3766–3777)

```
fn set_windows_sandbox_enabled(&mut self, value: bool)
```

**Purpose**: Toggles the unelevated Windows sandbox mode on or off without disturbing an elevated setting.

**Data flow**: If `value` is true it sets `self.permissions.windows_sandbox_mode` to `Some(Unelevated)`. If false and the current mode is `Some(Unelevated)`, it clears it to `None`; otherwise it leaves the existing mode unchanged.

**Call relations**: Runtime code can use this mutator to flip the standard Windows sandbox setting after config load.

*Call graph*: 1 external calls (matches!).


##### `Config::set_windows_elevated_sandbox_enabled`  (lines 3779–3790)

```
fn set_windows_elevated_sandbox_enabled(&mut self, value: bool)
```

**Purpose**: Toggles the elevated Windows sandbox mode on or off without disturbing an unelevated setting.

**Data flow**: If `value` is true it sets `self.permissions.windows_sandbox_mode` to `Some(Elevated)`. If false and the current mode is `Some(Elevated)`, it clears it to `None`; otherwise it preserves the existing mode.

**Call relations**: This complements `set_windows_sandbox_enabled` for callers that specifically manage elevated sandbox mode.

*Call graph*: 1 external calls (matches!).


##### `Config::managed_network_requirements_enabled`  (lines 3792–3801)

```
fn managed_network_requirements_enabled(&self) -> bool
```

**Purpose**: Reports whether managed network requirements are active for the current config and permission profile.

**Data flow**: It returns true only when the current permission profile is not `PermissionProfile::Disabled` and `self.config_layer_stack.requirements_toml().network` is present.

**Call relations**: Runtime code can use this to decide whether managed network policy should influence behavior.

*Call graph*: calls 1 internal fn (requirements_toml); 1 external calls (matches!).


##### `Config::network_proxy_spec_for_active_permission_profile`  (lines 3803–3848)

```
fn network_proxy_spec_for_active_permission_profile(
        &self,
        active_permission_profile: &ActivePermissionProfile,
        permission_profile: &PermissionProfile,
    ) -> std::io::Resul
```

**Purpose**: Recomputes the effective network proxy spec for a specific active permission profile using the current effective config and managed requirements.

**Data flow**: It takes an `ActivePermissionProfile` and concrete `PermissionProfile`. If the profile allows configured proxy inheritance, it deserializes the effective config back into `ConfigToml`, resolves profile-specific proxy config, overlays feature-level network-proxy config when enabled and network access is allowed, and then calls `build_network_proxy_spec` with the current managed network requirements. Otherwise it uses a default proxy config. It returns `Option<NetworkProxySpec>` or an `io::Error`.

**Call relations**: This helper is used when the active permission profile changes and the managed proxy must be recomputed consistently with config-layer state.

*Call graph*: calls 8 internal fn (effective_config, requirements, build_network_proxy_spec, network_proxy_toml_config, apply_network_proxy_feature_config, network_proxy_config_for_profile_selection, profile_allows_configured_network_proxy, network_sandbox_policy); 2 external calls (enabled, default).


##### `Config::bundled_skills_enabled`  (lines 3850–3852)

```
fn bundled_skills_enabled(&self) -> bool
```

**Purpose**: Reports whether bundled skills are enabled according to the current config layer stack.

**Data flow**: It passes `&self.config_layer_stack` into `crate::manager::bundled_skills_enabled_from_stack` and returns the resulting boolean.

**Call relations**: This is a small adapter from config state into the skills manager’s enablement logic.

*Call graph*: calls 1 internal fn (bundled_skills_enabled_from_stack).


##### `guardian_policy_config_from_requirements`  (lines 3855–3859)

```
fn guardian_policy_config_from_requirements(
    requirements_toml: &ConfigRequirementsToml,
) -> Option<String>
```

**Purpose**: Extracts and normalizes guardian policy config text from managed requirements.

**Data flow**: It reads `requirements_toml.guardian_policy_config.as_deref()`, passes it to `normalize_guardian_policy_config`, and returns the resulting `Option<String>`.

**Call relations**: The full config loader uses this before falling back to user-configured guardian policy text.

*Call graph*: calls 1 internal fn (normalize_guardian_policy_config); called by 1 (load_config_with_layer_stack).


##### `merge_managed_permission_profiles`  (lines 3861–3890)

```
fn merge_managed_permission_profiles(
    configured_permissions: Option<&PermissionsToml>,
    requirements_toml: &ConfigRequirementsToml,
) -> std::io::Result<Option<PermissionsToml>>
```

**Purpose**: Merges managed permission profiles from requirements into the configured permission-profile catalog while rejecting name collisions.

**Data flow**: It clones the configured `PermissionsToml` or starts from default, iterates managed profiles from `requirements_toml.permissions.profiles`, errors if any managed profile ID already exists in configured entries, inserts the managed profiles otherwise, and returns `Option<PermissionsToml>`.

**Call relations**: This is the first step of effective permission-profile selection before validation and default-profile resolution.

*Call graph*: called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `resolve_effective_permission_selection`  (lines 3892–3916)

```
fn resolve_effective_permission_selection(
    configured_permissions: Option<&PermissionsToml>,
    default_permissions_override: Option<&'a str>,
    configured_default_permissions: Option<&'a str>,
```

**Purpose**: Builds the effective permission-profile catalog and selected profile ID after merging managed profiles and applying requirements-driven defaulting.

**Data flow**: It merges managed profiles, validates user profile names, validates that required profiles/defaults refer to known profiles, resolves the selected default profile via `resolve_default_permissions`, and returns an `EffectivePermissionSelection` containing the merged catalog, selected profile ID, and whether requirements force profile selection.

**Call relations**: The full config loader calls this before deciding whether to compile named profiles or legacy sandbox settings.

*Call graph*: calls 4 internal fn (merge_managed_permission_profiles, validate_user_permission_profile_names, resolve_default_permissions, validate_required_permission_profile_catalog); called by 1 (load_config_with_layer_stack).


##### `resolve_default_permissions`  (lines 3918–3954)

```
fn resolve_default_permissions(
    default_permissions_override: Option<&'a str>,
    configured_default_permissions: Option<&'a str>,
    requirements_toml: &'a ConfigRequirementsToml,
    startup_w
```

**Purpose**: Resolves the selected default permission profile ID, applying managed allowlists/defaults and emitting a startup warning when a configured selection is disallowed.

**Data flow**: It starts from the override or configured default. If no `allowed_permission_profiles` requirement exists, it returns that selection unchanged. Otherwise it computes a fallback from `requirements_toml.default_permissions` or `implicit_default_permissions`, errors if no fallback can be derived, and returns either the selected profile if allowed or the fallback while pushing a warning describing the forced fallback.

**Call relations**: This is called by `resolve_effective_permission_selection` as the final profile-ID selection step.

*Call graph*: calls 1 internal fn (is_permission_allowed); called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `validate_required_permission_profile_catalog`  (lines 3956–4008)

```
fn validate_required_permission_profile_catalog(
    requirements_toml: &ConfigRequirementsToml,
    available_permissions: Option<&PermissionsToml>,
) -> std::io::Result<()>
```

**Purpose**: Validates that managed permission-profile requirements refer only to known profiles and that the managed default is itself allowed.

**Data flow**: It defines a local predicate that recognizes built-in profile names and configured profile IDs. If `allowed_permission_profiles` is absent, it errors only when `default_permissions` is set without an allowlist. Otherwise it checks every allowed profile ID for existence, derives the effective default from explicit or implicit rules, and errors if that default is not allowed.

**Call relations**: This validation runs inside `resolve_effective_permission_selection` before default-profile resolution is finalized.

*Call graph*: calls 1 internal fn (is_permission_allowed); called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `implicit_default_permissions`  (lines 4010–4016)

```
fn implicit_default_permissions(
    allowed_permission_profiles: &BTreeMap<String, bool>,
) -> Option<&'static str>
```

**Purpose**: Derives the implicit managed default permission profile when requirements allow both built-in workspace and read-only profiles.

**Data flow**: It checks `is_permission_allowed` for both built-in IDs and returns `Some(BUILT_IN_WORKSPACE_PROFILE)` only when both are allowed; otherwise `None`.

**Call relations**: This helper is used by both default-resolution and requirement-validation logic.

*Call graph*: calls 1 internal fn (is_permission_allowed).


##### `is_permission_allowed`  (lines 4018–4026)

```
fn is_permission_allowed(
    allowed_permission_profiles: &BTreeMap<String, bool>,
    profile_id: &str,
) -> bool
```

**Purpose**: Checks whether a given permission profile ID is enabled in the managed allowlist map.

**Data flow**: It looks up `profile_id` in the `BTreeMap<String, bool>` and returns the stored boolean or `false` if absent.

**Call relations**: It is the shared primitive used by implicit-default, default-resolution, and requirement-validation helpers.

*Call graph*: called by 3 (implicit_default_permissions, resolve_default_permissions, validate_required_permission_profile_catalog).


##### `normalize_guardian_policy_config`  (lines 4028–4033)

```
fn normalize_guardian_policy_config(value: Option<&str>) -> Option<String>
```

**Purpose**: Normalizes optional guardian policy text by trimming whitespace and discarding empty strings.

**Data flow**: It takes `Option<&str>`, trims any present string, and returns `Some(trimmed.to_string())` only when the trimmed text is non-empty; otherwise `None`.

**Call relations**: Both requirements-derived and user-config-derived guardian policy text flow through this normalizer.

*Call graph*: called by 1 (guardian_policy_config_from_requirements).


##### `find_codex_home`  (lines 4043–4045)

```
fn find_codex_home() -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Returns the resolved Codex home directory, honoring `CODEX_HOME` and defaulting to `~/.codex`.

**Data flow**: It delegates directly to `codex_utils_home_dir::find_codex_home()` and returns the resulting `AbsolutePathBuf` or I/O error.

**Call relations**: This is the shared home-directory discovery helper used by config loading and many startup/CLI paths.

*Call graph*: called by 21 (from_listen_url, default_control_socket_path, run_main_with_transport_options, cli_main, disable_feature_in_config, fallback_state_check, enable_feature_in_config, loader_overrides_for_profile, run_add, run_remove (+11 more)); 1 external calls (find_codex_home).


##### `log_dir`  (lines 4049–4051)

```
fn log_dir(cfg: &Config) -> std::io::Result<PathBuf>
```

**Purpose**: Returns the configured log directory path from a loaded `Config`.

**Data flow**: It clones `cfg.log_dir` and wraps it in `Ok(...)`.

**Call relations**: Logging initialization code uses this small accessor when deciding where to write login logs.

*Call graph*: called by 1 (init_login_file_logging).


### `exec-server/src/runtime_paths.rs`

`config` · `startup and helper/sandbox configuration`

This file is a compact configuration/data-validation module centered on `ExecServerRuntimePaths`. The struct carries two concrete runtime locations: `codex_self_exe`, the stable absolute path to the main executable used for helper modes, and `codex_linux_sandbox_exe`, an optional absolute path to the Linux sandbox helper alias used when sandbox re-entry depends on `argv[0]`.

The constructors enforce an important invariant: every stored path is an `AbsolutePathBuf`, not an arbitrary `PathBuf`. `from_optional_paths` is the boundary used by callers that may or may not have discovered these paths yet; it rejects a missing main executable path with `std::io::ErrorKind::InvalidInput` and a clear message, then delegates to `new`. `new` performs the actual normalization by converting the required executable path and, if present, the optional sandbox alias through the private `absolute_path` helper. For the optional field it uses `Option::map(...).transpose()` so a missing alias stays `None`, while a present but invalid/non-absolute alias becomes an error.

The private helper translates the `AbsolutePathBuf::from_absolute_path` validation error into a standard `std::io::Error`, keeping the rest of the codebase on ordinary I/O-style error handling. The result is a small but critical source of trusted runtime path state used by process launching and filesystem sandbox helpers.

#### Function details

##### `ExecServerRuntimePaths::from_optional_paths`  (lines 16–27)

```
fn from_optional_paths(
        codex_self_exe: Option<PathBuf>,
        codex_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds runtime paths from optional configuration inputs, requiring that the main executable path be present.

**Data flow**: Accepts `Option<PathBuf>` for both executable paths. It extracts `codex_self_exe`, returning an `InvalidInput` `std::io::Error` if it is `None`, then forwards the concrete main path and optional sandbox alias to `Self::new` for absolute-path validation.

**Call relations**: Used by startup/configuration code that gathers paths from environment or CLI options. It exists as the forgiving outer layer before the stricter `new` constructor.

*Call graph*: called by 8 (run_main_with_transport_options, list_accessible_connectors_from_mcp_tools_with_options_and_status, build_prompt_input, run_main, run_main, run_main, run_main, start_app_server_for_archive_command); 1 external calls (new).


##### `ExecServerRuntimePaths::new`  (lines 29–37)

```
fn new(
        codex_self_exe: PathBuf,
        codex_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self>
```

**Purpose**: Validates and stores the runtime executable paths as absolute-path wrapper types.

**Data flow**: Takes a required `PathBuf` and an optional `PathBuf`, converts the required path with `absolute_path`, converts the optional path with `map(absolute_path).transpose()`, and returns `ExecServerRuntimePaths` on success or the first validation error encountered.

**Call relations**: Called directly by code that already has concrete paths and by `from_optional_paths`. It establishes the invariant that all stored runtime paths are absolute.

*Call graph*: calls 1 internal fn (absolute_path); called by 27 (runtime_start_args_forward_environment_manager, run_exec_server_command, test_runtime_paths, build_with_home_and_base_url, test_runtime_paths, helper_permissions_include_helper_read_root_without_additional_permissions, helper_permissions_include_linux_sandbox_alias_parent, helper_permissions_preserve_existing_writes, sandbox_exec_request_carries_helper_env, processor_exit_reports_closed_virtual_stream (+15 more)).


##### `absolute_path`  (lines 40–43)

```
fn absolute_path(path: PathBuf) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Converts a plain `PathBuf` into an `AbsolutePathBuf`, rejecting non-absolute inputs as invalid configuration.

**Data flow**: Takes ownership of a `PathBuf`, borrows it as a path with `as_path()`, passes it to `AbsolutePathBuf::from_absolute_path`, and maps any validation error into `std::io::ErrorKind::InvalidInput`.

**Call relations**: Private helper used only by `ExecServerRuntimePaths::new` so both required and optional path fields share identical validation and error shaping.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (new); 1 external calls (as_path).


### `tools/src/tool_config.rs`

`config` · `config load and runtime mode selection`

This module is the policy layer for tool runtime configuration. It defines several enums that capture decisions made elsewhere in the system: `ShellCommandBackendConfig` chooses between the classic shell backend and zsh-fork interception; `UnifiedExecFeatureMode` expresses whether unified exec is disabled, directly enabled, or enabled only in zsh-fork composition; `ToolUserShellType` records the user’s shell family; `UnifiedExecShellMode` refines unified exec into either direct mode or a `ZshFork` configuration carrying absolute paths; and `ToolEnvironmentMode` classifies whether zero, one, or multiple execution environments are available. The functions are mostly pure policy evaluators over `Features` and `ModelInfo`. `request_user_input_available_modes` filters `TUI_VISIBLE_COLLABORATION_MODES`, allowing modes that intrinsically support request-user-input plus optionally `ModeKind::Default` when the corresponding feature is enabled. `shell_command_backend_for_features` requires both `ShellTool` and `ShellZshFork` to select zsh-fork. `unified_exec_feature_mode_for_features` enforces a stricter composition rule: unified exec requires both `ShellTool` and `UnifiedExec`, and zsh-fork unified exec additionally requires both `ShellZshFork` and `UnifiedExecZshFork`; otherwise it falls back to disabled or direct mode. `shell_type_for_model_and_features` combines model preference, feature policy, shell backend choice, and runtime `conpty_supported()` capability to choose the final `ConfigShellToolType`, including downgrades from `UnifiedExec` to `ShellCommand` or `Disabled`. `UnifiedExecShellMode::for_session` then resolves runtime session details, selecting `ZshFork` only on Unix, only for feature mode `ZshFork`, only for a zsh user shell, and only when both provided paths convert successfully to `AbsolutePathBuf`; conversion failures are logged as warnings and cause a safe fallback to `Direct`.

#### Function details

##### `request_user_input_available_modes`  (lines 38–47)

```
fn request_user_input_available_modes(features: &Features) -> Vec<ModeKind>
```

**Purpose**: Computes which collaboration modes should expose request-user-input in the TUI based on built-in mode capabilities and one feature flag. It optionally adds `ModeKind::Default` even though that mode does not normally allow request-user-input.

**Data flow**: Reads `features: &Features` and iterates `TUI_VISIBLE_COLLABORATION_MODES`. It filters each `ModeKind` by either `mode.allows_request_user_input()` or, for `ModeKind::Default`, `features.enabled(Feature::DefaultModeRequestUserInput)`, then collects the surviving modes into a `Vec<ModeKind>` and returns it.

**Call relations**: This function is called when assembling UI-visible mode choices. It is independent of shell configuration and serves as a small policy adapter from feature flags to mode lists.


##### `shell_command_backend_for_features`  (lines 49–55)

```
fn shell_command_backend_for_features(features: &Features) -> ShellCommandBackendConfig
```

**Purpose**: Chooses whether the shell-command tool should use the classic backend or zsh-fork interception based solely on feature flags. Both `ShellTool` and `ShellZshFork` must be enabled to select zsh-fork.

**Data flow**: Reads `features.enabled(Feature::ShellTool)` and `features.enabled(Feature::ShellZshFork)`. If both are true, returns `ShellCommandBackendConfig::ZshFork`; otherwise returns `ShellCommandBackendConfig::Classic`.

**Call relations**: This helper feeds into `shell_type_for_model_and_features`, which uses its result to decide whether shell-command mode should remain as requested by the model or be forced to `ShellCommand`. It encapsulates one narrow feature-policy decision.

*Call graph*: calls 1 internal fn (enabled); called by 1 (shell_type_for_model_and_features).


##### `unified_exec_feature_mode_for_features`  (lines 67–79)

```
fn unified_exec_feature_mode_for_features(features: &Features) -> UnifiedExecFeatureMode
```

**Purpose**: Determines the unified-exec mode implied by the current feature set before considering runtime platform or session details. It enforces the composition rule that zsh-fork unified exec requires both the base unified-exec feature and the zsh-fork composition feature.

**Data flow**: Inspects `features` for `ShellTool`, `UnifiedExec`, `ShellZshFork`, and `UnifiedExecZshFork`. Returns `Disabled` if shell tools or unified exec are off; returns `ZshFork` only when shell zsh-fork and unified-exec zsh-fork are both enabled; returns `Disabled` when shell zsh-fork is enabled without the composition gate; otherwise returns `Direct`.

**Call relations**: This function is consumed by `shell_type_for_model_and_features` and by tests that validate feature interactions. It isolates the feature-only portion of unified-exec selection from later runtime checks.

*Call graph*: calls 1 internal fn (enabled); called by 1 (shell_type_for_model_and_features).


##### `shell_type_for_model_and_features`  (lines 81–116)

```
fn shell_type_for_model_and_features(
    model_info: &ModelInfo,
    features: &Features,
) -> ConfigShellToolType
```

**Purpose**: Computes the final shell tool type exposed for a model after combining model preference, feature gates, shell backend policy, and runtime PTY support. It is the main decision function for shell execution mode.

**Data flow**: Takes `model_info: &ModelInfo` and `features: &Features`. It first derives `unified_exec_feature_mode` and whether unified exec is effectively disabled. It then normalizes `model_info.shell_type`, downgrading `UnifiedExec` to `ShellCommand` when unified exec is disabled and mapping `Default`/`Local` to `ShellCommand`. Next it applies `shell_command_backend_for_features`: classic leaves the normalized type unchanged, while zsh-fork forces `ShellCommand`. Finally, if `ShellTool` is disabled it returns `Disabled`; otherwise, for unified-exec feature modes `Direct` or `ZshFork`, it returns `UnifiedExec` only when `codex_utils_pty::conpty_supported()` is true and falls back to `ShellCommand` when PTY support is unavailable.

**Call relations**: This is the top-level shell-policy function used by callers that need a concrete `ConfigShellToolType`. It delegates feature-only subdecisions to `unified_exec_feature_mode_for_features` and `shell_command_backend_for_features`, then adds model and runtime capability checks.

*Call graph*: calls 3 internal fn (enabled, shell_command_backend_for_features, unified_exec_feature_mode_for_features); 2 external calls (conpty_supported, matches!).


##### `UnifiedExecShellMode::for_session`  (lines 131–164)

```
fn for_session(
        feature_mode: UnifiedExecFeatureMode,
        user_shell_type: ToolUserShellType,
        shell_zsh_path: Option<&PathBuf>,
        main_execve_wrapper_exe: Option<&PathBuf>,
```

**Purpose**: Resolves the runtime unified-exec shell mode for a specific session, deciding whether zsh-fork can actually be used or whether execution must fall back to direct mode. It combines feature policy with platform, user shell, and path availability.

**Data flow**: Accepts a `UnifiedExecFeatureMode`, `ToolUserShellType`, and optional `PathBuf` references for `shell_zsh_path` and `main_execve_wrapper_exe`. It checks a chained condition: Unix platform, feature mode `ZshFork`, user shell `Zsh`, both paths present, and both paths convertible to `AbsolutePathBuf`. Failed conversions are logged with `tracing::warn!` via `inspect_err`. If all checks pass, it returns `UnifiedExecShellMode::ZshFork(ZshForkConfig { ... })`; otherwise it returns `UnifiedExecShellMode::Direct`.

**Call relations**: This runtime resolver is called from higher-level session setup paths such as `spawn_review_thread` and `make_turn_context`, and it is directly exercised by the corresponding unit test. It refines the broader feature-mode decision into an executable session configuration.

*Call graph*: calls 1 internal fn (try_from); called by 3 (spawn_review_thread, make_turn_context, unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match); 3 external calls (ZshFork, cfg!, matches!).


##### `ToolEnvironmentMode::from_count`  (lines 175–181)

```
fn from_count(count: usize) -> Self
```

**Purpose**: Classifies the number of available tool environments into a small enum used elsewhere in configuration and UI logic. It turns an arbitrary count into `None`, `Single`, or `Multiple`.

**Data flow**: Takes `count: usize`, matches on it, and returns `ToolEnvironmentMode::None` for `0`, `Single` for `1`, and `Multiple` for any larger value. It has no side effects.

**Call relations**: This helper is used by callers such as `tool_environment_mode` to derive a coarse environment-state summary from a raw count. It is a pure convenience mapping.

*Call graph*: called by 1 (tool_environment_mode).


##### `ToolEnvironmentMode::has_environment`  (lines 183–185)

```
fn has_environment(self) -> bool
```

**Purpose**: Reports whether the classified environment mode represents at least one available environment. It is a convenience predicate over `ToolEnvironmentMode`.

**Data flow**: Consumes `self` by value and returns `true` unless `self` matches `ToolEnvironmentMode::None`. No state is read beyond the enum value itself.

**Call relations**: This predicate is used wherever callers need a boolean check instead of matching on the enum directly. It complements `from_count` by providing the simplest derived query over the classification.

*Call graph*: 1 external calls (matches!).


### `core/src/session/config_lock.rs`

`config` · `config load`

This module converts a `SessionConfiguration` into `ConfigLockfileToml`, validates replay against an expected lock, and writes lockfiles to disk when configured. The top-level async helpers are guarded: `validate_config_lock_if_configured` skips non-root agents and sessions without an embedded expected lock, then regenerates the actual lockfile TOML from the live session and calls `validate_config_lock_replay` with an option derived from `config_lock_allow_codex_version_mismatch`. `export_config_lock_if_configured` similarly exits early unless `config_lock_export_dir` is set, then serializes the generated lockfile with `toml::to_string_pretty`, creates the export directory, and writes `<conversation_id>.config.lock.toml` asynchronously with contextual errors. The core transformation path is `SessionConfiguration::to_config_lockfile_toml`, which wraps `session_configuration_to_lock_config_toml` in `config_lockfile(...)`. That helper starts from the resolved effective layer stack converted into `ConfigToml`, optionally patches in session-only values such as chosen model, reasoning settings, prompts, personality, and approval settings, then persists additional resolved `Config` fields including feature materialization, `multi_agent_v2`, memories, agent limits, and instruction toggles. Finally `drop_lockfile_inputs` strips non-replayable inputs like profiles, debug controls, instruction files, model catalog JSON, and sandbox/permission source fields so the lock contains outcomes rather than original knobs. The tests verify prompt capture, feature materialization, compatibility with removed inputs, and codex-version mismatch behavior.

#### Function details

##### `validate_config_lock_if_configured`  (lines 20–41)

```
async fn validate_config_lock_if_configured(
    session_configuration: &SessionConfiguration,
) -> anyhow::Result<()>
```

**Purpose**: Regenerates the current session’s lockfile and compares it against an expected embedded lock when replay validation is enabled.

**Data flow**: Reads `session_configuration.session_source` to skip non-root agents, then reads `original_config_do_not_use.config_lock_toml`; if absent it returns `Ok(())`. Otherwise it computes `actual` via `to_config_lockfile_toml`, builds `ConfigLockReplayOptions` from `config_lock_allow_codex_version_mismatch`, invokes `validate_config_lock_replay(expected, &actual, options)`, adds context on failure, and returns success or the propagated error.

**Call relations**: This async helper is used during session setup or replay validation paths when a lockfile contract should be enforced. It delegates lock generation to the `SessionConfiguration` method and comparison semantics to the shared config-lock validator.

*Call graph*: calls 1 internal fn (validate_config_lock_replay); 1 external calls (to_config_lockfile_toml).


##### `export_config_lock_if_configured`  (lines 43–69)

```
async fn export_config_lock_if_configured(
    session_configuration: &SessionConfiguration,
    conversation_id: ThreadId,
) -> anyhow::Result<()>
```

**Purpose**: Serializes the resolved session lockfile and writes it to the configured export directory for the current conversation.

**Data flow**: Reads `config_lock_export_dir` from the original config and returns early if unset. Otherwise it generates the lock via `to_config_lockfile_toml`, pretty-serializes it to TOML text, builds an output path named with the `ThreadId`, creates the directory tree with `tokio::fs::create_dir_all`, writes the file with `tokio::fs::write`, and returns contextualized I/O errors if any step fails.

**Call relations**: This function runs only when export is configured, typically around session initialization or persistence checkpoints. It depends on the same lock-generation path as validation but adds filesystem side effects for debugging or reproducibility.

*Call graph*: 5 external calls (to_config_lockfile_toml, format!, create_dir_all, write, to_string_pretty).


##### `SessionConfiguration::to_config_lockfile_toml`  (lines 72–76)

```
fn to_config_lockfile_toml(&self) -> anyhow::Result<ConfigLockfileToml>
```

**Purpose**: Produces the final `ConfigLockfileToml` wrapper for a session by converting live session/config state into replayable `ConfigToml` and attaching lockfile metadata.

**Data flow**: Borrows `self`, calls `session_configuration_to_lock_config_toml(self)?` to build the inner `ConfigToml`, passes that into `config_lockfile(...)`, and returns the resulting `ConfigLockfileToml` inside `anyhow::Result`.

**Call relations**: This method is the central entry used by both validation and export. It delegates all field-level shaping to the helper below and leaves versioning/wrapper details to `config_lockfile`.

*Call graph*: calls 2 internal fn (config_lockfile, session_configuration_to_lock_config_toml).


##### `session_configuration_to_lock_config_toml`  (lines 79–100)

```
fn session_configuration_to_lock_config_toml(
    sc: &SessionConfiguration,
) -> anyhow::Result<ConfigToml>
```

**Purpose**: Builds the replayable `ConfigToml` snapshot from the resolved config layer stack plus session-only resolved values.

**Data flow**: Reads `sc.original_config_do_not_use`, converts `config_layer_stack.effective_config()` into `ConfigToml` with `try_into`, optionally calls `save_session_resolved_fields` when `config_lock_save_fields_resolved_from_model_catalog` is true, always calls `save_config_resolved_fields`, then strips non-replayable source inputs via `drop_lockfile_inputs` and returns the mutated `ConfigToml`.

**Call relations**: Called only by `SessionConfiguration::to_config_lockfile_toml`. It is the composition point that merges static resolved config with dynamic session decisions before lockfile wrapping.

*Call graph*: calls 3 internal fn (drop_lockfile_inputs, save_config_resolved_fields, save_session_resolved_fields); called by 1 (to_config_lockfile_toml).


##### `save_session_resolved_fields`  (lines 107–118)

```
fn save_session_resolved_fields(sc: &SessionConfiguration, lock_config: &mut ConfigToml)
```

**Purpose**: Copies values chosen during session construction into the lock config so the lockfile can stand alone without re-resolving model-catalog or prompt decisions.

**Data flow**: Reads fields from `SessionConfiguration` such as collaboration-mode model, reasoning effort, reasoning summary, service tier, base and developer instructions, compact prompt, personality, approval policy, and approvals reviewer; writes them into the corresponding optional fields on the mutable `ConfigToml`.

**Call relations**: This helper is invoked conditionally from `session_configuration_to_lock_config_toml` when the config says model-catalog-resolved fields should be saved. It isolates session-derived values from config-derived ones.

*Call graph*: called by 1 (session_configuration_to_lock_config_toml).


##### `save_config_resolved_fields`  (lines 125–174)

```
fn save_config_resolved_fields(
    config: &Config,
    lock_config: &mut ConfigToml,
) -> anyhow::Result<()>
```

**Purpose**: Persists normalized and materialized values from the resolved `Config` into the lockfile representation.

**Data flow**: Reads many resolved fields from `Config`—web search mode, provider ID, plan-mode reasoning effort, verbosity, instruction toggles, environment-context toggle, background terminal timeout, feature states, multi-agent v2 config, memories config, agent limits, interrupt-message flag, and skill instruction inclusion—and writes them into `lock_config`. It materializes feature aliases through `features.materialize_resolved_enabled`, converts structured resolved configs with `resolved_config_to_toml`, and conditionally clears legacy `agents.max_threads` when `Feature::MultiAgentV2` is enabled.

**Call relations**: Called from `session_configuration_to_lock_config_toml` after any session-only fields are patched in. It is responsible for ensuring replay compares against the fully resolved runtime behavior rather than raw user-authored TOML.

*Call graph*: calls 1 internal fn (resolved_config_to_toml); called by 1 (session_configuration_to_lock_config_toml); 1 external calls (Config).


##### `drop_lockfile_inputs`  (lines 176–191)

```
fn drop_lockfile_inputs(lock_config: &mut ConfigToml)
```

**Purpose**: Removes source-only or environment-specific inputs from the lock config so the lockfile records replayable outcomes instead of the knobs that produced them.

**Data flow**: Mutates `lock_config` in place by setting `profile`, `model_instructions_file`, `experimental_compact_prompt_file`, `model_catalog_json`, `sandbox_mode`, `sandbox_workspace_write`, `default_permissions`, `permissions`, and `experimental_use_unified_exec_tool` to `None`; clears `profiles`; and invokes `clear_config_lock_debug_controls` to strip debug-only controls.

**Call relations**: This cleanup step is always run at the end of `session_configuration_to_lock_config_toml`. It enforces the module’s core invariant that lockfiles should be replay contracts, not a dump of all original config inputs.

*Call graph*: calls 1 internal fn (clear_config_lock_debug_controls); called by 1 (session_configuration_to_lock_config_toml).


##### `resolved_config_to_toml`  (lines 193–201)

```
fn resolved_config_to_toml(
    value: &impl serde::Serialize,
    label: &'static str,
) -> anyhow::Result<Toml>
```

**Purpose**: Converts a resolved runtime config value into its TOML schema type by round-tripping through serialization.

**Data flow**: Accepts any serializable `value` plus a static `label`, calls `toml_round_trip(value, label)`, maps the error into `anyhow::Error`, and returns the deserialized TOML-typed value.

**Call relations**: Used by `save_config_resolved_fields` for structured subconfigs like `MultiAgentV2ConfigToml` and `MemoriesToml`. It centralizes the serialization/deserialization bridge so lockfile generation uses the same conversion semantics everywhere.

*Call graph*: calls 1 internal fn (toml_round_trip); called by 1 (save_config_resolved_fields).


##### `tests::lock_contains_prompts_and_materializes_features`  (lines 210–277)

```
async fn lock_contains_prompts_and_materializes_features()
```

**Purpose**: Verifies that generated lockfiles include resolved prompt fields, materialized feature states, memories, and the expected lockfile version while stripping profile/debug inputs.

**Data flow**: Creates a test `SessionConfiguration`, mutates prompt-related fields, generates a lockfile via `to_config_lockfile_toml`, then reads the resulting `lockfile.config` and asserts equality or presence/absence across instructions, model fields, profiles, debug controls, memories, every feature entry, the `code_mode` feature, materialized `multi_agent_v2` config, and the top-level version.

**Call relations**: This tokio test exercises the full lock-generation pipeline. It serves as a broad regression suite for both `save_session_resolved_fields` and `save_config_resolved_fields` plus `drop_lockfile_inputs`.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (assert!, assert_eq!).


##### `tests::lock_skips_session_values_when_model_catalog_fields_are_not_saved`  (lines 280–303)

```
async fn lock_skips_session_values_when_model_catalog_fields_are_not_saved()
```

**Purpose**: Checks that session-derived model and prompt fields are omitted when the config disables saving values resolved from the model catalog.

**Data flow**: Builds a test session configuration, clones and mutates the underlying `Config` to set `config_lock_save_fields_resolved_from_model_catalog = false`, updates several session fields, generates the lockfile, and asserts that model, reasoning, service tier, instructions, personality, and approval-related fields are all `None` in the lock.

**Call relations**: This test targets the conditional branch in `session_configuration_to_lock_config_toml` that skips `save_session_resolved_fields`. It ensures the lockfile contract respects that configuration flag.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (new, assert_eq!).


##### `tests::lock_validation_reports_config_diff`  (lines 306–321)

```
async fn lock_validation_reports_config_diff()
```

**Purpose**: Ensures replay validation fails with a useful diff message when the regenerated config lock differs from the expected one.

**Data flow**: Creates a test session configuration, generates an expected lockfile, clones it into `actual`, mutates `actual.config.model`, runs `validate_config_lock_replay` with default options expecting an error, converts the error to a string, and asserts the message mentions replay mismatch and the differing `model` field.

**Call relations**: This test exercises the validation path rather than generation alone. It confirms that drift is surfaced as a descriptive error suitable for debugging replay failures.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests); 2 external calls (assert!, default).


##### `tests::lock_validation_ignores_removed_apps_mcp_path_override`  (lines 324–347)

```
async fn lock_validation_ignores_removed_apps_mcp_path_override()
```

**Purpose**: Verifies backward compatibility by ensuring a removed compatibility input in the expected lock does not cause replay drift.

**Data flow**: Generates an actual lockfile from a test session, converts it to mutable `toml::Value`, inserts a synthetic `features.apps_mcp_path_override` table into the expected TOML, deserializes that modified value back into `ConfigLockfileToml`, and runs `validate_config_lock_replay` with default options expecting success.

**Call relations**: This test protects compatibility behavior in the shared validator. It demonstrates that replay comparison tolerates a legacy field that no longer exists in current generated locks.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests); 6 external calls (default, from_iter, Boolean, String, Table, try_from).


##### `tests::lock_validation_rejects_codex_version_mismatch_by_default`  (lines 350–368)

```
async fn lock_validation_rejects_codex_version_mismatch_by_default()
```

**Purpose**: Checks that a codex-version mismatch between expected and actual lockfiles is rejected unless explicitly allowed.

**Data flow**: Creates a test session configuration, generates an expected lockfile and mutates its `codex_version`, generates a fresh actual lockfile, validates with default replay options expecting an error, and asserts the error message mentions the version mismatch and the debug flag needed to allow it.

**Call relations**: This test covers the default strict-version branch of replay validation. It documents that version drift is treated specially and rejected unless the caller opts out.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests); 2 external calls (assert!, default).


##### `tests::lock_validation_can_ignore_codex_version_mismatch`  (lines 371–385)

```
async fn lock_validation_can_ignore_codex_version_mismatch()
```

**Purpose**: Verifies that replay validation can be configured to ignore codex-version drift.

**Data flow**: Builds expected and actual lockfiles from a test session, mutates the expected `codex_version`, then calls `validate_config_lock_replay` with `ConfigLockReplayOptions { allow_codex_version_mismatch: true }` and expects success.

**Call relations**: This test is the permissive counterpart to the previous one. It confirms that the option propagated by `validate_config_lock_if_configured` has the intended effect in the validator.

*Call graph*: calls 2 internal fn (validate_config_lock_replay, make_session_configuration_for_tests).


### `tui/src/debug_config.rs`

`domain_logic` · `debug command rendering / transcript generation`

This file turns the application’s merged configuration state into human-readable `ratatui::text::Line` output. `new_debug_config_output` is the entry point: it renders the config-layer stack and requirements from `Config.config_layer_stack`, filters sandbox-mode requirements through the current `Permissions`, optionally appends session runtime proxy environment variables, and wraps the result in a `PlainHistoryCell`.

The bulk of the work happens in `render_debug_config_lines`. It emits a heading, lists config layers in lowest-precedence-first order including disabled layers and their reasons, and expands non-file-backed layers with extra detail. Session flags are flattened into sorted dotted key/value pairs; MDM and enterprise-managed layers show either raw TOML or formatted TOML values with labels like `MDM value` or `Enterprise-managed config value`.

The requirements section is assembled field-by-field from `ConfigLayerStack::requirements()` and `requirements_toml()`. Each present requirement becomes a line of the form `name: value (source: ...)`, covering approval policies, reviewers, sandbox modes, web search modes, managed hooks, MCP servers, residency, experimental network constraints, filesystem deny-read patterns, and more. Several helpers normalize or format values: empty lists become `<empty>`, empty web-search mode lists are normalized to `disabled`, network constraints are serialized into compact `key=value` fragments, and managed hooks summarize directories plus handler count.

A notable design choice is that sandbox modes shown in debug output are filtered by what the current `Permissions` can actually allow, so the display reflects effective constraints rather than only raw TOML declarations.

#### Function details

##### `new_debug_config_output`  (lines 25–55)

```
fn new_debug_config_output(
    config: &Config,
    session_network_proxy: Option<&SessionNetworkProxyRuntime>,
) -> PlainHistoryCell
```

**Purpose**: Creates the final debug-config history cell, including optional session runtime proxy details.

**Data flow**: Takes `&Config` and optional `&SessionNetworkProxyRuntime`; renders base lines with `render_debug_config_lines`, passing a closure that checks sandbox-mode permissibility via `sandbox_mode_is_allowed_by_permissions`. If a proxy exists, it appends blank/header/runtime lines plus `HTTP_PROXY` and `ALL_PROXY` values, then returns `PlainHistoryCell::new(lines)`.

**Call relations**: Called by higher-level history assembly when the user requests debug-config output.

*Call graph*: calls 3 internal fn (render_debug_config_lines, session_all_proxy_url, new); called by 1 (add_debug_config_output); 1 external calls (format!).


##### `sandbox_mode_is_allowed_by_permissions`  (lines 57–73)

```
fn sandbox_mode_is_allowed_by_permissions(
    permissions: &Permissions,
    mode: SandboxModeRequirement,
) -> bool
```

**Purpose**: Determines whether a requested sandbox mode is effectively allowed by the current permission constraints.

**Data flow**: Maps `SandboxModeRequirement` to a corresponding `PermissionProfile` (`read_only`, `workspace_write`, `Disabled`, or `External { network: Restricted }`), then calls `permissions.can_set_permission_profile(...)` and returns whether it succeeded.

**Call relations**: Used as a filter callback when rendering allowed sandbox modes so the debug output reflects effective, not merely declared, options.

*Call graph*: calls 3 internal fn (can_set_permission_profile, read_only, workspace_write).


##### `session_all_proxy_url`  (lines 75–81)

```
fn session_all_proxy_url(http_addr: &str, socks_addr: &str, socks_enabled: bool) -> String
```

**Purpose**: Formats the `ALL_PROXY` URL for the session runtime based on whether SOCKS proxying is enabled.

**Data flow**: Takes HTTP and SOCKS addresses plus a boolean; returns either `socks5h://{socks_addr}` or `http://{http_addr}`.

**Call relations**: Used only by `new_debug_config_output` when appending session runtime proxy lines.

*Call graph*: called by 1 (new_debug_config_output); 1 external calls (format!).


##### `render_debug_config_lines`  (lines 83–305)

```
fn render_debug_config_lines(
    stack: &ConfigLayerStack,
    sandbox_mode_is_effectively_allowed: impl Fn(SandboxModeRequirement) -> bool,
) -> Vec<Line<'static>>
```

**Purpose**: Builds the full `/debug-config` textual report for config layers and requirements.

**Data flow**: Consumes a `ConfigLayerStack` and a sandbox-mode filter closure. It gathers layers in lowest-precedence-first order, formats each layer source and enabled/disabled status, appends non-file details and disabled reasons, then inspects `requirements()` and `requirements_toml()` to build requirement lines for every present field. It returns `Vec<Line<'static>>`.

**Call relations**: This is the main formatter used by `new_debug_config_output` and by tests through text-rendering helpers.

*Call graph*: calls 10 internal fn (get_layers, requirements, requirements_toml, format_managed_hooks_requirements, format_network_constraints, format_residency_requirement, join_or_empty, normalize_allowed_web_search_modes, render_non_file_layer_details, requirement_line); called by 2 (new_debug_config_output, render_stack_to_text_with_sandbox_mode_filter); 4 external calls (new, format_config_layer_source, format!, vec!).


##### `render_non_file_layer_details`  (lines 307–318)

```
fn render_non_file_layer_details(layer: &ConfigLayerEntry) -> Vec<Line<'static>>
```

**Purpose**: Chooses how to expand a config layer when it is not a plain file-backed layer.

**Data flow**: Matches on `layer.name`; session flags are expanded via `render_session_flag_details`, MDM/enterprise-managed variants via `render_non_file_layer_value`, and ordinary system/user/project/file-backed layers return an empty vector.

**Call relations**: Called from `render_debug_config_lines` for each listed layer.

*Call graph*: calls 2 internal fn (render_non_file_layer_value, render_session_flag_details); called by 1 (render_debug_config_lines); 1 external calls (new).


##### `render_session_flag_details`  (lines 320–332)

```
fn render_session_flag_details(config: &TomlValue) -> Vec<Line<'static>>
```

**Purpose**: Formats session-flag TOML into sorted dotted `key = value` lines.

**Data flow**: Creates a mutable `(String, String)` accumulator, recursively flattens the TOML with `flatten_toml_key_values`, and returns either a single dim `<none>` line or one formatted line per flattened pair.

**Call relations**: Used when a config layer source is `SessionFlags`.

*Call graph*: calls 1 internal fn (flatten_toml_key_values); called by 1 (render_non_file_layer_details); 2 external calls (new, vec!).


##### `format_managed_hooks_requirements`  (lines 334–349)

```
fn format_managed_hooks_requirements(hooks: &ManagedHooksRequirementsToml) -> String
```

**Purpose**: Summarizes managed-hooks requirements into a compact comma-separated string.

**Data flow**: Reads optional `managed_dir`, optional `windows_managed_dir`, and `handler_count()` from `ManagedHooksRequirementsToml`, pushes present fragments into a vector, then joins them with `join_or_empty`.

**Call relations**: Used by `render_debug_config_lines` when the requirements TOML includes managed hooks.

*Call graph*: calls 1 internal fn (join_or_empty); called by 1 (render_debug_config_lines); 2 external calls (new, format!).


##### `render_non_file_layer_value`  (lines 351–368)

```
fn render_non_file_layer_value(layer: &ConfigLayerEntry) -> Vec<Line<'static>>
```

**Purpose**: Formats the raw or synthesized TOML value for an MDM or enterprise-managed layer, including multiline indentation.

**Data flow**: Determines a label with `non_file_layer_value_label`, obtains either `layer.raw_toml()` or `format_toml_value(&layer.config)`, then returns either a dim `<empty>` line, a header plus indented multiline body, or a single inline `label: value` line.

**Call relations**: Called by `render_non_file_layer_details` for non-file managed layers.

*Call graph*: calls 2 internal fn (raw_toml, non_file_layer_value_label); called by 1 (render_non_file_layer_details); 1 external calls (vec!).


##### `non_file_layer_value_label`  (lines 370–382)

```
fn non_file_layer_value_label(source: &ConfigLayerSource) -> &'static str
```

**Purpose**: Returns the human-facing label used when printing a non-file layer’s value.

**Data flow**: Matches on `ConfigLayerSource` and returns strings such as `MDM value`, `Enterprise-managed config value`, or `Layer value`.

**Call relations**: Used only by `render_non_file_layer_value`.

*Call graph*: called by 1 (render_non_file_layer_value).


##### `flatten_toml_key_values`  (lines 384–407)

```
fn flatten_toml_key_values(
    value: &TomlValue,
    prefix: Option<&str>,
    out: &mut Vec<(String, String)>,
)
```

**Purpose**: Recursively flattens nested TOML tables into dotted keys paired with formatted scalar values.

**Data flow**: Takes a `TomlValue`, optional prefix, and mutable output vector. For tables, it sorts entries by key, extends the prefix with `.` separators, and recurses. For non-tables, it pushes `(prefix-or-<value>, format_toml_value(value))` into `out`.

**Call relations**: Used by `render_session_flag_details` to produce stable, readable session-flag output.

*Call graph*: calls 1 internal fn (format_toml_value); called by 1 (render_session_flag_details); 1 external calls (format!).


##### `format_toml_value`  (lines 409–411)

```
fn format_toml_value(value: &TomlValue) -> String
```

**Purpose**: Converts a TOML value into its string representation.

**Data flow**: Calls `to_string()` on the `TomlValue` and returns the resulting `String`.

**Call relations**: Used by TOML flattening and non-file layer formatting.

*Call graph*: called by 1 (flatten_toml_key_values); 1 external calls (to_string).


##### `requirement_line`  (lines 413–422)

```
fn requirement_line(
    name: &str,
    value: String,
    source: Option<&RequirementSource>,
) -> Line<'static>
```

**Purpose**: Formats one requirement entry with its value and source annotation.

**Data flow**: Takes a requirement name, already-formatted value string, and optional `RequirementSource`; substitutes `<unspecified>` when absent and returns a `Line` like `  - name: value (source: source)`.

**Call relations**: Used repeatedly by `render_debug_config_lines` to build the requirements section.

*Call graph*: called by 1 (render_debug_config_lines); 1 external calls (format!).


##### `join_or_empty`  (lines 424–430)

```
fn join_or_empty(values: Vec<String>) -> String
```

**Purpose**: Joins a list of strings with commas, or returns `<empty>` when the list has no entries.

**Data flow**: Consumes `Vec<String>` and returns either `"<empty>"` or `values.join(", ")`.

**Call relations**: Shared helper for requirement formatting, managed hooks summaries, and network constraint serialization.

*Call graph*: called by 3 (format_managed_hooks_requirements, format_network_constraints, render_debug_config_lines).


##### `normalize_allowed_web_search_modes`  (lines 432–444)

```
fn normalize_allowed_web_search_modes(
    modes: &[WebSearchModeRequirement],
) -> Vec<WebSearchModeRequirement>
```

**Purpose**: Normalizes allowed web-search mode requirements so `disabled` is always present, and an empty list becomes `[Disabled]`.

**Data flow**: If `modes` is empty, returns a new vector containing only `Disabled`; otherwise clones the slice and appends `Disabled` if missing.

**Call relations**: Used by `render_debug_config_lines` before formatting allowed web-search modes.

*Call graph*: called by 1 (render_debug_config_lines); 3 external calls (is_empty, to_vec, vec!).


##### `format_sandbox_mode_requirement`  (lines 446–453)

```
fn format_sandbox_mode_requirement(mode: SandboxModeRequirement) -> String
```

**Purpose**: Converts a sandbox-mode requirement enum into the kebab-case string shown in debug output.

**Data flow**: Matches the enum and returns strings like `read-only`, `workspace-write`, `danger-full-access`, or `external-sandbox`.

**Call relations**: Used while rendering allowed sandbox modes.


##### `format_residency_requirement`  (lines 455–459)

```
fn format_residency_requirement(requirement: ResidencyRequirement) -> String
```

**Purpose**: Formats residency requirements into their serialized string form.

**Data flow**: Matches `ResidencyRequirement` and currently returns `"us"` for `Us`.

**Call relations**: Used by `render_debug_config_lines` for the `enforce_residency` requirement.

*Call graph*: called by 1 (render_debug_config_lines).


##### `format_network_constraints`  (lines 461–524)

```
fn format_network_constraints(network: &NetworkConstraints) -> String
```

**Purpose**: Serializes `NetworkConstraints` into a compact comma-separated summary string.

**Data flow**: Destructures the `NetworkConstraints` fields, pushes `key=value` fragments for each present option, formats domain and unix-socket permission maps through `format_network_permission_entries`, then joins the fragments with `join_or_empty`.

**Call relations**: Used by `render_debug_config_lines` when experimental network requirements are present.

*Call graph*: calls 1 internal fn (join_or_empty); called by 1 (render_debug_config_lines); 2 external calls (new, format!).


##### `format_network_permission_entries`  (lines 526–535)

```
fn format_network_permission_entries(
    entries: &std::collections::BTreeMap<String, T>,
    format_value: impl Fn(T) -> &'static str,
) -> String
```

**Purpose**: Formats a sorted `BTreeMap<String, T>` of network permissions into `{key=value, ...}` form.

**Data flow**: Iterates the map in key order, applies the provided formatter function to each value, joins the resulting fragments with `, `, and wraps them in braces.

**Call relations**: Used by `format_network_constraints` for both domain and unix-socket permission maps.

*Call graph*: 1 external calls (format!).


##### `format_network_domain_permission`  (lines 537–542)

```
fn format_network_domain_permission(permission: NetworkDomainPermissionToml) -> &'static str
```

**Purpose**: Maps domain permission enums to `allow` or `deny` strings.

**Data flow**: Matches `NetworkDomainPermissionToml` and returns the corresponding static string.

**Call relations**: Passed into `format_network_permission_entries` for domain constraints.


##### `format_network_unix_socket_permission`  (lines 544–551)

```
fn format_network_unix_socket_permission(
    permission: NetworkUnixSocketPermissionToml,
) -> &'static str
```

**Purpose**: Maps unix-socket permission enums to `allow` or `deny` strings.

**Data flow**: Matches `NetworkUnixSocketPermissionToml` and returns the corresponding static string.

**Call relations**: Passed into `format_network_permission_entries` for unix-socket constraints.


##### `tests::empty_toml_table`  (lines 595–597)

```
fn empty_toml_table() -> TomlValue
```

**Purpose**: Creates an empty TOML table fixture for tests.

**Data flow**: Constructs `TomlValue::Table` from a new empty TOML map.

**Call relations**: Used by multiple tests that need minimal config-layer contents.

*Call graph*: 2 external calls (Table, new).


##### `tests::absolute_path`  (lines 599–601)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an `AbsolutePathBuf` fixture from a string literal.

**Data flow**: Calls `AbsolutePathBuf::from_absolute_path(path)` and unwraps the result.

**Call relations**: Used throughout tests to create platform-specific absolute paths.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `tests::render_to_text`  (lines 603–614)

```
fn render_to_text(lines: &[Line<'static>]) -> String
```

**Purpose**: Converts styled `Line` output into plain text for easier assertions and snapshots.

**Data flow**: Iterates each line and each span, concatenates span contents into strings, then joins lines with newline separators.

**Call relations**: Used by stack-rendering test helpers.

*Call graph*: 1 external calls (iter).


##### `tests::render_stack_to_text`  (lines 616–618)

```
fn render_stack_to_text(stack: &ConfigLayerStack) -> String
```

**Purpose**: Renders a config stack to plain text using a permissive sandbox-mode filter.

**Data flow**: Delegates to `render_stack_to_text_with_sandbox_mode_filter(stack, |_| true)`.

**Call relations**: Convenience helper for tests that do not care about effective sandbox filtering.

*Call graph*: 1 external calls (render_stack_to_text_with_sandbox_mode_filter).


##### `tests::render_stack_to_text_with_sandbox_mode_filter`  (lines 620–628)

```
fn render_stack_to_text_with_sandbox_mode_filter(
        stack: &ConfigLayerStack,
        sandbox_mode_is_effectively_allowed: impl Fn(SandboxModeRequirement) -> bool,
    ) -> String
```

**Purpose**: Renders a config stack to plain text with a caller-supplied sandbox-mode filter.

**Data flow**: Calls `render_debug_config_lines(stack, sandbox_mode_is_effectively_allowed)` and converts the resulting lines with `render_to_text`.

**Call relations**: Shared helper for tests that inspect the textual debug-config output.

*Call graph*: calls 1 internal fn (render_debug_config_lines); 1 external calls (render_to_text).


##### `tests::debug_config_output_lists_all_layers_including_disabled`  (lines 631–669)

```
fn debug_config_output_lists_all_layers_including_disabled()
```

**Purpose**: Verifies that enabled and disabled config layers, disabled reasons, and an empty requirements section are all shown.

**Data flow**: Builds a stack with one enabled system layer and one disabled project layer, renders it to text, and asserts the presence of enabled/disabled markers, the disabled reason, and `Requirements:` with `<none>`.

**Call relations**: Covers layer-stack formatting and disabled-layer reporting.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, assert!, cfg!, default, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_lists_requirement_sources`  (lines 672–868)

```
fn debug_config_output_lists_requirement_sources()
```

**Purpose**: Checks that many requirement types render with the correct values and source annotations.

**Data flow**: Constructs a rich `ConfigRequirements` and `ConfigRequirementsToml`, renders the stack, snapshots non-Windows output, and asserts specific requirement lines for approvals, sandbox modes, web search, hooks, MCP servers, residency, network, filesystem, and omitted rules.

**Call relations**: Exercises most branches in `render_debug_config_lines`.

*Call graph*: calls 5 internal fn (new, new, allow_any, new, read_only); 9 external calls (from, default, default, assert!, cfg!, assert_snapshot!, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_filters_sandbox_modes_blocked_by_deny_read_requirements`  (lines 871–955)

```
fn debug_config_output_filters_sandbox_modes_blocked_by_deny_read_requirements()
```

**Purpose**: Ensures the displayed allowed sandbox modes are filtered by effective permissions rather than raw TOML alone.

**Data flow**: Builds requirements that nominally allow several modes, constructs constrained permissions that reject some of them, renders with a filter closure using `sandbox_mode_is_allowed_by_permissions`, snapshots output, and asserts blocked modes are absent.

**Call relations**: Validates the effective sandbox-mode filtering behavior.

*Call graph*: calls 7 internal fn (new, new, allow_any, new, new, from_approval_and_profile, read_only); 9 external calls (new, default, assert!, cfg!, default, assert_snapshot!, absolute_path, render_stack_to_text_with_sandbox_mode_filter, vec!).


##### `tests::debug_config_output_lists_approvals_reviewer_as_requirement`  (lines 958–978)

```
fn debug_config_output_lists_approvals_reviewer_as_requirement()
```

**Purpose**: Verifies that approvals reviewer requirements appear in the requirements section and suppress the `<none>` placeholder.

**Data flow**: Builds a stack with only `allowed_approvals_reviewers`, renders it, and asserts the expected line is present and the empty marker is absent.

**Call relations**: Covers one specific requirement branch.

*Call graph*: calls 3 internal fn (new, allow_any, new); 6 external calls (new, default, assert!, default, render_stack_to_text, vec!).


##### `tests::debug_config_output_formats_unix_socket_permissions`  (lines 981–1013)

```
fn debug_config_output_formats_unix_socket_permissions()
```

**Purpose**: Checks formatting of unix-socket network permissions inside experimental network constraints.

**Data flow**: Builds requirements with two unix-socket entries, renders the stack, and asserts the serialized `unix_sockets={...}` fragment appears with the expected source.

**Call relations**: Exercises `format_network_constraints` and `format_network_unix_socket_permission`.

*Call graph*: calls 2 internal fn (new, new); 7 external calls (from, default, new, default, assert!, default, render_stack_to_text).


##### `tests::debug_config_output_lists_session_flag_key_value_pairs`  (lines 1016–1043)

```
fn debug_config_output_lists_session_flag_key_value_pairs()
```

**Purpose**: Verifies that session-flag TOML is flattened into dotted key/value lines.

**Data flow**: Parses a TOML snippet with nested keys, builds a stack containing a `SessionFlags` layer, renders it, and asserts the flattened entries appear.

**Call relations**: Covers `render_session_flag_details` and `flatten_toml_key_values`.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert!, default, render_stack_to_text, vec!).


##### `tests::debug_config_output_shows_legacy_mdm_layer_value`  (lines 1046–1077)

```
fn debug_config_output_shows_legacy_mdm_layer_value()
```

**Purpose**: Checks that legacy MDM-managed config layers display their raw TOML under the `MDM value` label.

**Data flow**: Builds a stack with `new_with_raw_toml` for a legacy MDM layer, renders it, and asserts the layer label and raw TOML lines are present.

**Call relations**: Exercises `render_non_file_layer_value` for MDM sources.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, assert!, cfg!, default, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_shows_enterprise_managed_layer_value`  (lines 1080–1115)

```
fn debug_config_output_shows_enterprise_managed_layer_value()
```

**Purpose**: Checks that enterprise-managed config layers display their raw TOML under the enterprise-specific label.

**Data flow**: Builds a stack with an `EnterpriseManaged` layer carrying raw TOML, renders it, and asserts the enterprise label appears while `MDM value:` does not.

**Call relations**: Exercises non-file layer labeling for enterprise-managed sources.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, assert!, cfg!, default, absolute_path, render_stack_to_text, vec!).


##### `tests::debug_config_output_normalizes_empty_web_search_mode_list`  (lines 1118–1160)

```
fn debug_config_output_normalizes_empty_web_search_mode_list()
```

**Purpose**: Verifies that an explicitly empty allowed-web-search-mode list renders as `disabled`.

**Data flow**: Builds requirements with `allowed_web_search_modes: Some(Vec::new())`, renders the stack, and asserts the output contains `allowed_web_search_modes: disabled` with the correct source.

**Call relations**: Covers `normalize_allowed_web_search_modes`.

*Call graph*: calls 3 internal fn (new, allow_any, new); 4 external calls (new, default, assert!, render_stack_to_text).


##### `tests::debug_config_output_lists_managed_hooks_requirement`  (lines 1163–1206)

```
fn debug_config_output_lists_managed_hooks_requirement()
```

**Purpose**: Checks that managed-hooks requirements render a summary including handler count and source.

**Data flow**: Builds requirements and TOML for managed hooks, renders the stack, and asserts the output contains `hooks:`, `handlers=1`, and the expected source annotation.

**Call relations**: Exercises `format_managed_hooks_requirements`.

*Call graph*: calls 3 internal fn (new, allow_any, new); 9 external calls (default, new, default, assert!, cfg!, default, from, render_stack_to_text, vec!).


##### `tests::session_all_proxy_url_uses_socks_when_enabled`  (lines 1209–1218)

```
fn session_all_proxy_url_uses_socks_when_enabled()
```

**Purpose**: Verifies that `session_all_proxy_url` prefers the SOCKS address when SOCKS is enabled.

**Data flow**: Calls the helper with `socks_enabled = true` and asserts the returned string is `socks5h://...`.

**Call relations**: Unit test for the runtime proxy formatting helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_all_proxy_url_uses_http_when_socks_disabled`  (lines 1221–1230)

```
fn session_all_proxy_url_uses_http_when_socks_disabled()
```

**Purpose**: Verifies that `session_all_proxy_url` falls back to the HTTP address when SOCKS is disabled.

**Data flow**: Calls the helper with `socks_enabled = false` and asserts the returned string is `http://...`.

**Call relations**: Complements the SOCKS-enabled proxy formatting test.

*Call graph*: 1 external calls (assert_eq!).


### Permission profile resolution
These files define the TOML-facing permission syntax, compile it into canonical runtime profiles, preserve resolved identities, and adapt them for compatibility and UI warnings.

### `config/src/permissions_toml.rs`

`config` · `config load and permission compilation`

This file is the typed configuration layer for permission profiles. At the top level, `PermissionsToml` stores named `PermissionProfileToml` entries in a `BTreeMap`. Profiles can inherit from one another via `extends`, and `PermissionsToml::resolve_profile` walks that chain across local entries and an externally supplied parent lookup, detecting cycles, distinguishing undefined parents from unsupported built-in parents, and merging ancestors before descendants. Merging is implemented by serializing profiles to `toml::Value`, clearing inherited metadata (`description`, `extends`) from parents, normalizing network-domain keys when both sides define them, and then using the generic TOML merge utility.

The file also defines the concrete permission submodels: workspace roots, filesystem permissions, domain and Unix-socket network permissions, and a substantial MITM configuration model. `NetworkMitmToml` performs custom deserialization so it can validate that actions are non-empty and hooks reference at least one action name; a second validation pass checks that referenced action names actually exist. Runtime conversion methods translate TOML types into `codex_network_proxy` types such as `NetworkProxyConfig`, `MitmHookConfig`, `MitmHookActionsConfig`, and `InjectedHeaderConfig`. `NetworkToml::apply_to_network_proxy_config` overlays only the fields that are present, merges domain and Unix-socket permissions into existing runtime config, computes runtime MITM hooks from named actions, and finally derives the boolean `mitm` flag from network mode or hook presence. The design keeps TOML parsing, inheritance semantics, and runtime translation in one place.

#### Function details

##### `PermissionsToml::is_empty`  (lines 29–31)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether any permission profiles are defined.

**Data flow**: Reads `self.entries` and returns `true` when the map is empty.

**Call relations**: This is a simple convenience query for callers deciding whether permissions config contributes anything.


##### `PermissionsToml::resolve_profile`  (lines 40–108)

```
fn resolve_profile(
        &self,
        profile_name: &str,
        mut parent_profile: F,
    ) -> Result<PermissionProfileToml, PermissionProfileResolutionError>
```

**Purpose**: Resolves one named permission profile by following its `extends` chain, loading ancestors, detecting invalid references, and merging the resulting profiles from parent to child.

**Data flow**: Takes `&self`, a `profile_name`, and a mutable lookup closure for parent profiles. It iteratively tracks visited profile names and cloned profile values, detects cycles by searching the accumulated names, fetches each profile from `self.entries` or the closure, emits `UndefinedProfile`, `UndefinedParent`, or `UnsupportedBuiltInParent` errors depending on context, records the inheritance chain, and once it reaches a profile without `extends`, folds the collected child profiles back onto that root using `merge_permission_profiles`. It returns the merged `PermissionProfileToml` or a `PermissionProfileResolutionError`.

**Call relations**: Higher-level permission resolution calls this as the main inheritance engine. Internally it delegates actual pairwise merging to `merge_permission_profiles` after it has validated the chain structure.

*Call graph*: called by 1 (resolve_permission_profile); 2 external calls (new, once).


##### `merge_permission_profiles`  (lines 158–191)

```
fn merge_permission_profiles(
    mut parent: PermissionProfileToml,
    mut child: PermissionProfileToml,
) -> Result<PermissionProfileToml, PermissionProfileResolutionError>
```

**Purpose**: Combines a parent and child permission profile into one profile while preserving child declaration metadata and normalizing network-domain keys before merge.

**Data flow**: Consumes `parent` and `child` profiles. It first checks whether both define `network.domains`; if so, it normalizes those domain keys in both profiles. It then clears `parent.description` and `parent.extends` so inherited metadata does not fill child gaps, serializes both profiles into `TomlValue`, merges the child TOML over the parent TOML with `merge_toml_values`, and deserializes the merged TOML back into `PermissionProfileToml`, mapping serialization/deserialization failures into typed resolution errors.

**Call relations**: This function is used by `PermissionsToml::resolve_profile` during the final fold over an inheritance chain. It relies on `normalize_profile_network_domains` and the generic TOML merge utility to preserve the same normalization semantics as layered config merging.

*Call graph*: calls 2 internal fn (merge_toml_values, normalize_profile_network_domains); 1 external calls (try_from).


##### `normalize_profile_network_domains`  (lines 193–207)

```
fn normalize_profile_network_domains(profile: &mut PermissionProfileToml)
```

**Purpose**: Canonicalizes the keys of a profile’s `network.domains` map using host normalization.

**Data flow**: Takes a mutable `PermissionProfileToml`, drills into `profile.network.domains` if present, drains the existing `entries` map, rewrites each key with `normalize_host`, and stores the rebuilt map back.

**Call relations**: It is called from `merge_permission_profiles` only when both parent and child define domain permissions, ensuring equivalent host patterns collide during merge.

*Call graph*: called by 1 (merge_permission_profiles); 1 external calls (take).


##### `WorkspaceRootsToml::enabled_roots`  (lines 216–220)

```
fn enabled_roots(&self) -> impl Iterator<Item = &String>
```

**Purpose**: Iterates only the workspace-root entries explicitly enabled in the profile.

**Data flow**: Reads `self.entries`, filters for `(path, true)` pairs, and returns an iterator of borrowed path strings.

**Call relations**: Callers use this to derive the effective set of enabled workspace roots without manually filtering the boolean map.


##### `FilesystemPermissionsToml::is_empty`  (lines 234–236)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether any filesystem permission entries are defined.

**Data flow**: Reads `self.entries` and returns whether the map is empty.

**Call relations**: This is a convenience predicate for code that conditionally emits or applies filesystem permissions.


##### `NetworkDomainPermissionsToml::is_empty`  (lines 253–255)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether any domain permission rules are present.

**Data flow**: Reads `self.entries` and returns whether the map is empty.

**Call relations**: This supports callers that need to skip empty domain-permission sections.


##### `NetworkDomainPermissionsToml::allowed_domains`  (lines 257–265)

```
fn allowed_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Extracts the list of domain patterns explicitly marked `allow`.

**Data flow**: Iterates `self.entries`, filters entries whose permission is `NetworkDomainPermissionToml::Allow`, clones their keys into a `Vec<String>`, and returns `Some(vec)` only if the result is non-empty.

**Call relations**: This provides a read-only summary view of the domain-permission map for consumers that need just the allow-list.


##### `NetworkDomainPermissionsToml::denied_domains`  (lines 267–275)

```
fn denied_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Extracts the list of domain patterns explicitly marked `deny`.

**Data flow**: Iterates `self.entries`, filters entries whose permission is `NetworkDomainPermissionToml::Deny`, clones their keys into a `Vec<String>`, and returns `Some(vec)` only if the result is non-empty.

**Call relations**: Like `allowed_domains`, this is a summary helper for consumers interested only in denied patterns.


##### `NetworkDomainPermissionToml::fmt`  (lines 288–294)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a domain permission enum as the lowercase strings used in user-facing output.

**Data flow**: Reads `self`, maps `Allow` to `allow` and `Deny` to `deny`, writes the chosen string into the formatter, and returns `fmt::Result`.

**Call relations**: This is invoked implicitly when domain permissions are rendered via `Display`.

*Call graph*: 1 external calls (write_str).


##### `NetworkUnixSocketPermissionsToml::is_empty`  (lines 304–306)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether any Unix-socket permission rules are present.

**Data flow**: Reads `self.entries` and returns whether the map is empty.

**Call relations**: This is a convenience predicate for code that conditionally applies Unix-socket permissions.


##### `NetworkUnixSocketPermissionsToml::allow_unix_sockets`  (lines 308–314)

```
fn allow_unix_sockets(&self) -> Vec<String>
```

**Purpose**: Collects the Unix socket paths explicitly marked `allow`.

**Data flow**: Iterates `self.entries`, filters for `NetworkUnixSocketPermissionToml::Allow`, clones the matching paths into a `Vec<String>`, and returns that vector.

**Call relations**: Callers use this helper when they need only the allowed socket paths rather than the full permission map.


##### `NetworkUnixSocketPermissionToml::fmt`  (lines 327–333)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a Unix-socket permission enum as `allow` or `deny` for display.

**Data flow**: Reads `self`, selects the lowercase string for the variant, writes it to the formatter, and returns `fmt::Result`.

**Call relations**: This is used implicitly by any display-oriented output involving Unix-socket permissions.

*Call graph*: 1 external calls (write_str).


##### `NetworkMitmToml::deserialize`  (lines 414–426)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Performs custom deserialization for MITM config so structural parsing is followed immediately by semantic validation of action definitions.

**Data flow**: Receives a serde deserializer, parses into the unchecked helper struct `NetworkMitmTomlUnchecked`, constructs `NetworkMitmToml` from its `hooks` and `actions`, calls `validate_action_definitions`, converts any validation error into a serde custom error, and returns the validated config.

**Call relations**: Serde invokes this whenever `NetworkMitmToml` is read from config. It ensures malformed MITM action definitions fail during deserialization rather than later runtime conversion.

*Call graph*: 1 external calls (deserialize).


##### `NetworkMitmToml::validate_action_definitions`  (lines 430–454)

```
fn validate_action_definitions(&self) -> Result<(), String>
```

**Purpose**: Checks internal MITM config consistency that does not require cross-referencing action names: actions must contain at least one operation, and hooks must list at least one action name.

**Data flow**: Reads `self.actions` and `self.hooks`; for each action, calls `NetworkMitmActionToml::is_empty` and returns an error naming `network.mitm.actions.<name>` if empty; for each hook, returns an error naming `network.mitm.hooks.<name>.action` if the hook’s action list is empty; otherwise returns `Ok(())`.

**Call relations**: This is called directly during `NetworkMitmToml::deserialize` and again at the start of `validate_action_references` so reference validation always runs on structurally valid definitions.

*Call graph*: called by 1 (validate_action_references); 1 external calls (format!).


##### `NetworkMitmToml::validate_action_references`  (lines 456–477)

```
fn validate_action_references(
        &self,
        actions_by_name: &IndexMap<String, NetworkMitmActionToml>,
    ) -> Result<(), String>
```

**Purpose**: Validates that every action name referenced by every MITM hook exists in the supplied action map.

**Data flow**: Reads `self` and an `IndexMap` of actions by name; first runs `validate_action_definitions`; if hooks exist, iterates each hook and each referenced action name, checking `contains_key`; returns a descriptive `Err(String)` for the first undefined reference or `Ok(())` if all references resolve.

**Call relations**: Callers use this when they have an action map available and need full semantic validation beyond the local checks performed during deserialization.

*Call graph*: calls 1 internal fn (validate_action_definitions); 2 external calls (contains_key, format!).


##### `NetworkMitmToml::to_runtime_hooks`  (lines 479–492)

```
fn to_runtime_hooks(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> Vec<MitmHookConfig>
```

**Purpose**: Converts configured MITM hooks into runtime proxy hook configs, optionally resolving named actions into concrete operations.

**Data flow**: Reads `self.hooks` and optional `actions_by_name`; if hooks are present, maps each `NetworkMitmHookToml` through `to_runtime(actions_by_name)` and collects the results into a `Vec<MitmHookConfig>`; otherwise returns an empty vector.

**Call relations**: This is used by `NetworkToml::apply_to_network_proxy_config` when populating runtime proxy configuration from TOML.


##### `NetworkMitmActionToml::is_empty`  (lines 496–498)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether a MITM action defines no header stripping and no header injection.

**Data flow**: Reads `self.strip_request_headers` and `self.inject_request_headers`; returns true only when both vectors are empty.

**Call relations**: It is used by `NetworkMitmToml::validate_action_definitions` to reject no-op action definitions.


##### `NetworkToml::apply_to_network_proxy_config`  (lines 502–558)

```
fn apply_to_network_proxy_config(&self, config: &mut NetworkProxyConfig)
```

**Purpose**: Overlays the optional TOML network settings onto an existing runtime `NetworkProxyConfig`, updating only fields explicitly present in the TOML.

**Data flow**: Reads each optional field of `self` and mutates the supplied `config`. Scalar options such as `enabled`, proxy URLs, SOCKS flags, upstream-proxy allowances, loopback restrictions, mode, and local binding overwrite the corresponding runtime fields when present. Domain permissions are merged via `overlay_network_domain_permissions`. Unix-socket permissions are merged into an existing or default runtime map by translating TOML allow/deny enums into proxy enums. If MITM config is present, it computes runtime hooks with `mitm.to_runtime_hooks(mitm.actions.as_ref())`. Finally it derives `config.network.mitm` as true when mode is `Limited` or any MITM hooks exist.

**Call relations**: This is the main TOML-to-runtime translation routine for network settings. It is called by `to_network_proxy_config` for standalone conversion and by higher-level network application code when layering settings onto an existing runtime config.

*Call graph*: calls 1 internal fn (overlay_network_domain_permissions); called by 2 (to_network_proxy_config, apply_network).


##### `NetworkToml::to_network_proxy_config`  (lines 560–564)

```
fn to_network_proxy_config(&self) -> NetworkProxyConfig
```

**Purpose**: Builds a fresh runtime `NetworkProxyConfig` from this TOML network section.

**Data flow**: Creates `NetworkProxyConfig::default()`, passes it by mutable reference to `apply_to_network_proxy_config`, and returns the populated config.

**Call relations**: This is a convenience wrapper around `apply_to_network_proxy_config` for callers that do not already have a runtime config to mutate.

*Call graph*: calls 1 internal fn (apply_to_network_proxy_config); 1 external calls (default).


##### `NetworkMitmHookToml::to_runtime`  (lines 568–583)

```
fn to_runtime(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> MitmHookConfig
```

**Purpose**: Converts one TOML MITM hook into the runtime hook structure expected by the network proxy.

**Data flow**: Reads the hook’s host, methods, path prefixes, query, headers, body, and action names; clones the matcher fields into a `MitmHookMatchConfig`; computes concrete actions with `selected_actions(actions_by_name)`; returns a `MitmHookConfig` containing all of that data.

**Call relations**: This is called from `NetworkMitmToml::to_runtime_hooks` for each configured hook.

*Call graph*: calls 1 internal fn (selected_actions).


##### `NetworkMitmHookToml::selected_actions`  (lines 585–608)

```
fn selected_actions(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> MitmHookActionsConfig
```

**Purpose**: Resolves the hook’s ordered list of action names into one aggregated runtime action set.

**Data flow**: Reads `self.action` and optional `actions_by_name`. If no action map is provided, returns `MitmHookActionsConfig::default()`. Otherwise it initializes an empty runtime action set, looks up each named action in order, appends its `strip_request_headers`, converts each injected header with `NetworkMitmInjectedHeaderToml::to_runtime`, extends the runtime injection list, and returns the aggregated result.

**Call relations**: This helper is used only by `to_runtime` so hook conversion can remain focused on assembling the full runtime structure.

*Call graph*: called by 1 (to_runtime); 1 external calls (default).


##### `NetworkMitmInjectedHeaderToml::to_runtime`  (lines 612–619)

```
fn to_runtime(&self) -> InjectedHeaderConfig
```

**Purpose**: Converts one TOML injected-header definition into the runtime proxy representation.

**Data flow**: Reads the TOML fields `name`, `secret_env_var`, `secret_file`, and `prefix`, clones them into an `InjectedHeaderConfig`, and returns it.

**Call relations**: It is used while aggregating selected MITM actions in `NetworkMitmHookToml::selected_actions`.


##### `overlay_network_domain_permissions`  (lines 622–635)

```
fn overlay_network_domain_permissions(
    config: &mut NetworkProxyConfig,
    domains: &NetworkDomainPermissionsToml,
)
```

**Purpose**: Merges TOML domain-permission entries into a runtime proxy config using normalized host keys.

**Data flow**: Takes mutable `NetworkProxyConfig` and `NetworkDomainPermissionsToml`; iterates each `(pattern, permission)` entry; translates TOML allow/deny enums into `ProxyNetworkDomainPermission`; calls `config.network.upsert_domain_permission(pattern.clone(), permission, normalize_host)` for each rule.

**Call relations**: This helper is used by `NetworkToml::apply_to_network_proxy_config` and other network-constraint application code so domain overlays share the same normalization and upsert behavior.

*Call graph*: called by 2 (apply_to_network_proxy_config, apply_network_constraints).


### `core/src/config/permissions.rs`

`domain_logic` · `config load and runtime permission/profile resolution`

This module contains the concrete permission semantics behind config loading. It defines built-in profile IDs (`:read-only`, `:workspace`, `:danger-full-access`), chooses the default built-in profile based on project trust and Windows sandbox availability, resolves named profile inheritance, and compiles TOML permission declarations into runtime filesystem and network policies.

The central compilation path is `compile_permission_profile` and its wrapper `compile_permission_profile_selection`. These functions resolve a `PermissionProfileToml`, start from a restricted filesystem/network baseline, warn when a profile has no recognized filesystem entries, emit platform-specific warnings for unsupported read/write glob patterns and unbounded deny-read `**` globs, compile each filesystem entry through `compile_filesystem_permission`, validate `glob_scan_max_depth`, and derive the final `NetworkSandboxPolicy`. Built-in profiles bypass TOML compilation through `builtin_permission_profile`.

Filesystem parsing is intentionally nuanced. Top-level and scoped entries can refer to absolute paths, special symbolic paths like `:workspace_roots`, or unknown future special paths that are preserved as `FileSystemSpecialPath::Unknown` and downgraded to warnings instead of hard failures. Deny globs are first-class patterns; read/write globs are only allowed as exact subtree syntax via trailing `/**`. Relative scoped subpaths must be strict descendants with no `.` or `..`. Windows path handling normalizes verbatim device prefixes before glob detection and absolute-path validation.

The module also converts profile network sections into `NetworkProxyConfig`, overlays feature-level proxy config, computes profile-defined workspace roots, and identifies helper-readable roots that must always be added for Codex runtime executables such as bundled zsh or the execve wrapper.

#### Function details

##### `default_builtin_permission_profile_name`  (lines 48–59)

```
fn default_builtin_permission_profile_name(
    active_project: &ProjectConfig,
    windows_sandbox_level: WindowsSandboxLevel,
) -> &'static str
```

**Purpose**: Chooses the implicit built-in permission profile name based on project trust and Windows sandbox availability.

**Data flow**: It reads `active_project.is_trusted()` / `is_untrusted()` and the supplied `WindowsSandboxLevel`. It returns `BUILT_IN_WORKSPACE_PROFILE` when the project has an explicit trust state and Windows is not in the unsupported disabled-sandbox case; otherwise it returns `BUILT_IN_READ_ONLY_PROFILE`.

**Call relations**: The main config loader uses this when no explicit permission profile is selected.

*Call graph*: calls 2 internal fn (is_trusted, is_untrusted); 1 external calls (cfg!).


##### `is_builtin_permission_profile_name`  (lines 61–68)

```
fn is_builtin_permission_profile_name(profile_name: &str) -> bool
```

**Purpose**: Checks whether a profile name is one of the recognized built-in permission profile IDs.

**Data flow**: It pattern-matches the input string against the three built-in constants and returns a boolean.

**Call relations**: Workspace-root and network-proxy profile resolution use this to distinguish built-in names from user-defined profiles.

*Call graph*: called by 2 (compile_permission_profile_workspace_roots, network_proxy_config_for_profile_selection); 1 external calls (matches!).


##### `builtin_permission_profile`  (lines 70–97)

```
fn builtin_permission_profile(
    profile_name: &str,
    workspace_write: Option<&SandboxWorkspaceWrite>,
) -> Option<PermissionProfile>
```

**Purpose**: Constructs the canonical `PermissionProfile` for a recognized built-in profile name, optionally incorporating legacy workspace-write settings.

**Data flow**: It matches the profile name. `:read-only` returns `PermissionProfile::read_only()`. `:workspace` returns either `workspace_write()` or `workspace_write_with(...)` using legacy `SandboxWorkspaceWrite` network/tmpdir flags. `:danger-full-access` returns `PermissionProfile::Disabled`. Unknown names return `None`.

**Call relations**: This is used by config loading and profile-selection compilation to short-circuit TOML profile resolution for built-ins.

*Call graph*: calls 3 internal fn (read_only, workspace_write, workspace_write_with); called by 2 (load_config_with_layer_stack, compile_permission_profile_selection).


##### `validate_user_permission_profile_names`  (lines 99–118)

```
fn validate_user_permission_profile_names(
    permissions: Option<&PermissionsToml>,
) -> io::Result<()>
```

**Purpose**: Rejects user-defined permission profile names that collide with the reserved built-in `:` prefix.

**Data flow**: It iterates the keys of `permissions.entries` when a permissions table is present and returns an `InvalidInput` error if any profile name starts with `:`; otherwise `Ok(())`.

**Call relations**: Effective permission-selection resolution calls this before merging and selecting profiles.

*Call graph*: called by 1 (resolve_effective_permission_selection); 2 external calls (new, format!).


##### `network_proxy_config_from_profile_network`  (lines 120–132)

```
fn network_proxy_config_from_profile_network(
    network: Option<&NetworkToml>,
) -> NetworkProxyConfig
```

**Purpose**: Converts a profile’s `[network]` section into a `NetworkProxyConfig` while forcing the managed proxy itself to remain disabled.

**Data flow**: It converts `Option<&NetworkToml>` into a `NetworkProxyConfig` using `NetworkToml::to_network_proxy_config` or default config, then explicitly sets `config.network.enabled = false` before returning it.

**Call relations**: Profile-specific proxy extraction uses this so profile network settings describe policy but do not independently start the managed proxy.

*Call graph*: called by 1 (network_proxy_config_for_profile_selection).


##### `apply_network_proxy_feature_config`  (lines 134–192)

```
fn apply_network_proxy_feature_config(
    config: &mut NetworkProxyConfig,
    feature_config: &NetworkProxyConfigToml,
)
```

**Purpose**: Overlays feature-level network-proxy TOML settings onto an existing `NetworkProxyConfig`.

**Data flow**: It maps `NetworkProxyConfigToml` fields into a temporary `NetworkToml`, translating feature-specific domain and unix-socket permission enums into the shared TOML enums, then calls `apply_to_network_proxy_config(config)` to mutate the supplied config in place.

**Call relations**: The main config loader and active-profile proxy recomputation call this when the network-proxy feature gate is enabled.

*Call graph*: called by 2 (load_config_with_layer_stack, network_proxy_spec_for_active_permission_profile).


##### `resolve_permission_profile`  (lines 194–201)

```
fn resolve_permission_profile(
    permissions: &PermissionsToml,
    profile_name: &str,
) -> io::Result<PermissionProfileToml>
```

**Purpose**: Resolves a named permission profile, including inheritance from extensible built-in parents.

**Data flow**: It calls `permissions.resolve_profile(profile_name, extensible_builtin_parent_profile)` and maps any resolution error into `io::ErrorKind::InvalidInput`.

**Call relations**: Profile compilation, workspace-root extraction, and profile-network extraction all depend on this resolver.

*Call graph*: calls 1 internal fn (resolve_profile); called by 3 (compile_permission_profile, compile_permission_profile_workspace_roots, network_proxy_config_for_profile_selection).


##### `extensible_builtin_parent_profile`  (lines 203–214)

```
fn extensible_builtin_parent_profile(profile_name: &str) -> Option<PermissionProfileToml>
```

**Purpose**: Provides synthetic TOML parent profiles for built-in read-only and workspace profiles so user profiles can extend them.

**Data flow**: It matches the built-in profile name, constructs the corresponding `FileSystemSandboxPolicy` (`read_only` or `workspace_write`), converts that policy into `PermissionProfileToml` via `permission_profile_toml_from_file_system_policy`, and returns it. Unsupported built-ins return `None`.

**Call relations**: It is passed into `PermissionsToml::resolve_profile` by `resolve_permission_profile`.

*Call graph*: calls 3 internal fn (permission_profile_toml_from_file_system_policy, read_only, workspace_write).


##### `permission_profile_toml_from_file_system_policy`  (lines 216–233)

```
fn permission_profile_toml_from_file_system_policy(
    file_system: FileSystemSandboxPolicy,
) -> PermissionProfileToml
```

**Purpose**: Converts a filesystem sandbox policy into a synthetic `PermissionProfileToml` containing equivalent filesystem entries.

**Data flow**: It creates an empty `FilesystemPermissionsToml`, copies `glob_scan_max_depth`, iterates the policy’s entries, inserts each one into the TOML map via `insert_filesystem_permission_toml`, and returns a `PermissionProfileToml` with only the filesystem section populated.

**Call relations**: This is used only when synthesizing extensible built-in parent profiles.

*Call graph*: calls 1 internal fn (insert_filesystem_permission_toml); called by 1 (extensible_builtin_parent_profile); 1 external calls (new).


##### `insert_filesystem_permission_toml`  (lines 235–253)

```
fn insert_filesystem_permission_toml(
    entries: &mut BTreeMap<String, FilesystemPermissionToml>,
    entry: FileSystemSandboxEntry,
)
```

**Purpose**: Serializes a single runtime filesystem sandbox entry into the TOML permission-entry map.

**Data flow**: It matches the entry path: absolute paths and glob patterns become direct `FilesystemPermissionToml::Access` entries keyed by string path/pattern, while special paths delegate to `insert_special_filesystem_permission_toml`.

**Call relations**: It is the per-entry helper used by `permission_profile_toml_from_file_system_policy`.

*Call graph*: calls 1 internal fn (insert_special_filesystem_permission_toml); called by 1 (permission_profile_toml_from_file_system_policy); 1 external calls (Access).


##### `insert_special_filesystem_permission_toml`  (lines 255–301)

```
fn insert_special_filesystem_permission_toml(
    entries: &mut BTreeMap<String, FilesystemPermissionToml>,
    value: FileSystemSpecialPath,
    access: FileSystemAccessMode,
)
```

**Purpose**: Serializes a special filesystem path entry into TOML, including scoped nested entries for project roots and unknown special paths with subpaths.

**Data flow**: It matches the `FileSystemSpecialPath` variant. Simple specials like `Root`, `Minimal`, `Tmpdir`, and `SlashTmp` become direct access entries. `ProjectRoots` and `Unknown` with subpaths delegate to `insert_scoped_filesystem_permission_toml`; otherwise unknown/simple specials become direct access entries.

**Call relations**: This helper is called when serializing special-path entries out of a runtime filesystem policy.

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

**Purpose**: Adds or updates a scoped TOML filesystem permission entry under a parent path key.

**Data flow**: It looks up or creates the parent entry in the map. If the existing entry is `Scoped`, it inserts the subpath/access pair. If it is `Access`, it replaces it with a `Scoped` map containing the new subpath. It mutates the map in place.

**Call relations**: Special-path serialization uses this to represent nested project-root or unknown-special-path permissions.

*Call graph*: called by 1 (insert_special_filesystem_permission_toml); 3 external calls (from, to_string_lossy, Scoped).


##### `network_proxy_config_for_profile_selection`  (lines 325–344)

```
fn network_proxy_config_for_profile_selection(
    permissions: Option<&PermissionsToml>,
    profile_name: &str,
) -> io::Result<NetworkProxyConfig>
```

**Purpose**: Returns the profile-specific proxy configuration associated with a selected permission profile name.

**Data flow**: Built-in profile names return `NetworkProxyConfig::default()`. Unknown built-in-like names are rejected via `reject_unknown_builtin_permission_profile`. For named profiles, it requires a permissions table, resolves the profile, extracts its `network` section, converts that section with `network_proxy_config_from_profile_network`, and returns the result.

**Call relations**: The main config loader and active-profile proxy recomputation use this when preserving profile-specific proxy policy.

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

**Purpose**: Compiles a resolved TOML permission profile into runtime filesystem and network sandbox policies, emitting compatibility warnings for unsupported or empty filesystem declarations.

**Data flow**: It resolves the named profile, starts from `FileSystemSandboxPolicy::restricted(Vec::new())` and `NetworkSandboxPolicy::Restricted`, warns if the filesystem section is absent or empty, emits platform-specific warnings for unsupported read/write globs and unbounded deny-read globstars, compiles each filesystem entry through `compile_filesystem_permission`, validates and applies `glob_scan_max_depth`, derives the network policy with `compile_network_sandbox_policy`, and returns the pair.

**Call relations**: This is the main named-profile compiler used by `compile_permission_profile_selection`.

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

**Purpose**: Compiles either a built-in or named permission profile selection into runtime filesystem and network policies.

**Data flow**: It first tries `builtin_permission_profile`; if successful it returns that profile’s runtime permissions. Otherwise it rejects unknown built-in-like names, requires a permissions table, and delegates to `compile_permission_profile`.

**Call relations**: The full config loader uses this after selecting the effective profile ID.

*Call graph*: calls 3 internal fn (builtin_permission_profile, compile_permission_profile, reject_unknown_builtin_permission_profile); called by 1 (load_config_with_layer_stack).


##### `compile_permission_profile_workspace_roots`  (lines 432–453)

```
fn compile_permission_profile_workspace_roots(
    permissions: Option<&PermissionsToml>,
    profile_name: &str,
    policy_cwd: &Path,
) -> io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Extracts and resolves workspace roots declared by a selected named permission profile.

**Data flow**: Built-in profile names return an empty vector. Unknown built-in-like names are rejected. For named profiles it requires a permissions table, resolves the profile, passes its optional `workspace_roots` section plus `policy_cwd` into `compile_workspace_roots`, and returns the resulting absolute roots.

**Call relations**: The main config loader uses this to keep profile-defined workspace roots distinct from runtime workspace roots.

*Call graph*: calls 4 internal fn (compile_workspace_roots, is_builtin_permission_profile_name, reject_unknown_builtin_permission_profile, resolve_permission_profile); called by 1 (load_config_with_layer_stack); 1 external calls (new).


##### `compile_workspace_roots`  (lines 455–465)

```
fn compile_workspace_roots(
    workspace_roots: Option<&WorkspaceRootsToml>,
    policy_cwd: &Path,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Resolves enabled workspace-root entries relative to the policy cwd.

**Data flow**: It maps `Option<&WorkspaceRootsToml>` to a vector by iterating `enabled_roots()`, resolving each path against `policy_cwd` with `AbsolutePathBuf::resolve_path_against_base`, and collecting the results. `None` yields an empty vector.

**Call relations**: This helper is used only by `compile_permission_profile_workspace_roots`.

*Call graph*: called by 1 (compile_permission_profile_workspace_roots).


##### `reject_unknown_builtin_permission_profile`  (lines 467–476)

```
fn reject_unknown_builtin_permission_profile(profile_name: &str) -> io::Result<()>
```

**Purpose**: Rejects profile names that look like built-ins but are not recognized.

**Data flow**: If the profile name starts with `:`, it returns an `InvalidInput` error naming the unknown built-in profile; otherwise it returns `Ok(())`.

**Call relations**: Named-profile selection helpers call this after ruling out known built-ins.

*Call graph*: called by 3 (compile_permission_profile_selection, compile_permission_profile_workspace_roots, network_proxy_config_for_profile_selection); 2 external calls (new, format!).


##### `get_readable_roots_required_for_codex_runtime`  (lines 481–507)

```
fn get_readable_roots_required_for_codex_runtime(
    codex_home: &Path,
    zsh_path: Option<&PathBuf>,
    main_execve_wrapper_exe: Option<&PathBuf>,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Computes helper executable paths that must always be readable inside the filesystem sandbox for Codex to function.

**Data flow**: It derives the `arg0` temp root under `codex_home`, optionally converts `zsh_path` and `main_execve_wrapper_exe` into `AbsolutePathBuf`, special-cases execve-wrapper paths under the `arg0` root to grant readability to the containing session directory rather than the whole root, and returns a vector of readable roots containing any discovered zsh path and wrapper root.

**Call relations**: The full config loader adds these roots to the effective filesystem sandbox policy after applying permission constraints.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (load_config_with_layer_stack); 2 external calls (join, new).


##### `compile_network_sandbox_policy`  (lines 509–522)

```
fn compile_network_sandbox_policy(
    network: Option<&NetworkToml>,
    base_network_sandbox_policy: NetworkSandboxPolicy,
) -> NetworkSandboxPolicy
```

**Purpose**: Derives the runtime network sandbox policy from an optional profile network section and a base policy.

**Data flow**: If no network section is present it returns the base policy. Otherwise `enabled = Some(true)` yields `Enabled`, `Some(false)` yields `Restricted`, and `None` preserves the base policy.

**Call relations**: This is the network half of `compile_permission_profile`.

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

**Purpose**: Compiles one TOML filesystem permission entry into one or more runtime sandbox entries, handling direct access, scoped subpaths, and deny-glob patterns.

**Data flow**: For `Access(access)`, it compiles the path through `compile_filesystem_access_path` and returns a single `FileSystemSandboxEntry`. For `Scoped(scoped_entries)`, it iterates each subpath/access pair; deny globs under project roots or ordinary paths become `GlobPattern` entries via `compile_scoped_filesystem_pattern`, while other entries normalize read/write subtree syntax with `compile_read_write_glob_path` and compile to exact/special paths via `compile_scoped_filesystem_path`. It returns the collected vector.

**Call relations**: This is the per-entry compiler used by `compile_permission_profile`.

*Call graph*: calls 6 internal fn (compile_filesystem_access_path, compile_read_write_glob_path, compile_scoped_filesystem_path, compile_scoped_filesystem_pattern, contains_glob_chars, parse_special_path); called by 1 (compile_permission_profile); 1 external calls (new).


##### `compile_filesystem_access_path`  (lines 571–592)

```
fn compile_filesystem_access_path(
    path: &str,
    access: FileSystemAccessMode,
    startup_warnings: &mut Vec<String>,
) -> io::Result<FileSystemPath>
```

**Purpose**: Compiles an unscoped filesystem path key into a runtime `FileSystemPath`, with special handling for glob syntax.

**Data flow**: If the path contains no glob characters, it delegates to `compile_filesystem_path`. For deny access with glob syntax, it parses the path as an absolute path and returns a `GlobPattern`. For read/write access with glob syntax, it first normalizes trailing `/**` subtree syntax through `compile_read_write_glob_path` and then compiles the resulting path normally.

**Call relations**: This helper is used by `compile_filesystem_permission` for top-level access entries.

*Call graph*: calls 4 internal fn (compile_filesystem_path, compile_read_write_glob_path, contains_glob_chars, parse_absolute_path); called by 1 (compile_filesystem_permission).


##### `compile_filesystem_path`  (lines 594–605)

```
fn compile_filesystem_path(
    path: &str,
    startup_warnings: &mut Vec<String>,
) -> io::Result<FileSystemPath>
```

**Purpose**: Compiles a filesystem path string into either a special-path or absolute-path runtime representation.

**Data flow**: It first checks `parse_special_path`; if a special path is recognized, it emits an unknown-special-path warning when appropriate and returns `FileSystemPath::Special`. Otherwise it parses the string as an absolute path and returns `FileSystemPath::Path`.

**Call relations**: Both top-level and scoped path compilation delegate here for non-pattern paths.

*Call graph*: calls 3 internal fn (maybe_push_unknown_special_path_warning, parse_absolute_path, parse_special_path); called by 2 (compile_filesystem_access_path, compile_scoped_filesystem_path).


##### `compile_scoped_filesystem_path`  (lines 607–640)

```
fn compile_scoped_filesystem_path(
    path: &str,
    subpath: &str,
    startup_warnings: &mut Vec<String>,
) -> io::Result<FileSystemPath>
```

**Purpose**: Compiles a parent path plus relative subpath into a runtime `FileSystemPath`, supporting nested project-root and unknown-special-path entries.

**Data flow**: If `subpath == "."`, it compiles the parent path directly. Otherwise it parses the parent as a special path or absolute path. Project roots become `FileSystemSpecialPath::project_roots(Some(subpath))`; unknown special paths become `unknown(path, Some(subpath))`; unsupported specials error; ordinary absolute paths resolve the relative subpath against the base path. Unknown specials trigger warnings.

**Call relations**: This helper is used by `compile_filesystem_permission` for scoped non-pattern entries.

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

**Purpose**: Compiles a scoped deny-glob entry into a symbolic or absolute glob pattern string.

**Data flow**: It rejects any access mode other than `Deny`, parses the relative subpath, then matches the parent path. `:workspace_roots` becomes a symbolic project-roots glob via `project_roots_glob_pattern(&subpath)`, unsupported specials error, and ordinary absolute paths become `base.join(subpath)` string patterns.

**Call relations**: This helper is used by `compile_filesystem_permission` for scoped deny-glob entries.

*Call graph*: calls 4 internal fn (parse_absolute_path, parse_relative_subpath, parse_special_path, project_roots_glob_pattern); called by 1 (compile_filesystem_permission); 2 external calls (new, format!).


##### `compile_read_write_glob_path`  (lines 677–693)

```
fn compile_read_write_glob_path(path: &str, access: FileSystemAccessMode) -> io::Result<&str>
```

**Purpose**: Allows only the restricted read/write glob syntax that represents a subtree via trailing `/**` and rejects broader glob patterns.

**Data flow**: If the path has no glob chars it returns it unchanged. Otherwise it strips a trailing `/**`; if the stripped path has no remaining glob chars, it returns that stripped subtree path. Any other glob usage returns an `InvalidInput` error mentioning the access mode.

**Call relations**: Top-level and scoped filesystem compilation use this to normalize supported read/write subtree syntax.

*Call graph*: calls 2 internal fn (contains_glob_chars, remove_trailing_glob_suffix); called by 2 (compile_filesystem_access_path, compile_filesystem_permission); 2 external calls (new, format!).


##### `unsupported_read_write_glob_paths`  (lines 695–718)

```
fn unsupported_read_write_glob_paths(filesystem: &FilesystemPermissionsToml) -> Vec<String>
```

**Purpose**: Finds read/write filesystem entries whose glob syntax is broader than the supported trailing-subtree form.

**Data flow**: It scans all top-level and scoped filesystem entries, and for any non-`Deny` access whose path or subpath still contains glob chars after removing a trailing `/**`, it records the offending pattern string in a vector and returns it.

**Call relations**: `compile_permission_profile` uses this on non-macOS platforms to emit startup warnings.

*Call graph*: calls 2 internal fn (contains_glob_chars, remove_trailing_glob_suffix); called by 1 (compile_permission_profile); 2 external calls (new, format!).


##### `unbounded_unreadable_globstar_paths`  (lines 720–744)

```
fn unbounded_unreadable_globstar_paths(filesystem: &FilesystemPermissionsToml) -> Vec<String>
```

**Purpose**: Finds deny-read glob patterns using `**` when no `glob_scan_max_depth` is configured.

**Data flow**: If `filesystem.glob_scan_max_depth` is set, it returns an empty vector. Otherwise it scans top-level and scoped deny entries for `**` in the path/subpath, formats each offending pattern, and returns the collected list.

**Call relations**: `compile_permission_profile` uses this on non-macOS platforms to warn about deny-read glob expansion limits.

*Call graph*: called by 1 (compile_permission_profile); 2 external calls (new, format!).


##### `validate_glob_scan_max_depth`  (lines 746–754)

```
fn validate_glob_scan_max_depth(max_depth: Option<usize>) -> io::Result<Option<usize>>
```

**Purpose**: Validates that `glob_scan_max_depth`, when present, is positive.

**Data flow**: It returns an `InvalidInput` error for `Some(0)` and otherwise returns the original `Option<usize>` unchanged.

**Call relations**: This validation is applied during permission-profile compilation before the depth is copied into the runtime policy.

*Call graph*: called by 1 (compile_permission_profile); 1 external calls (new).


##### `contains_glob_chars`  (lines 756–758)

```
fn contains_glob_chars(path: &str) -> bool
```

**Purpose**: Checks whether a path string contains glob syntax, using platform-aware Windows normalization when needed.

**Data flow**: It forwards the path and the compile-time Windows flag into `contains_glob_chars_for_platform` and returns the boolean result.

**Call relations**: Filesystem compilation and warning helpers use this as the standard glob detector.

*Call graph*: calls 1 internal fn (contains_glob_chars_for_platform); called by 4 (compile_filesystem_access_path, compile_filesystem_permission, compile_read_write_glob_path, unsupported_read_write_glob_paths); 1 external calls (cfg!).


##### `contains_glob_chars_for_platform`  (lines 760–768)

```
fn contains_glob_chars_for_platform(path: &str, is_windows: bool) -> bool
```

**Purpose**: Checks for glob characters after normalizing Windows verbatim device prefixes so those prefixes are not mistaken for glob syntax.

**Data flow**: On Windows it first tries `normalize_windows_device_path`; then it scans the normalized or original string for any of `*`, `?`, `[`, or `]` and returns whether any are present.

**Call relations**: This is the platform-specific implementation behind `contains_glob_chars`.

*Call graph*: calls 1 internal fn (normalize_windows_device_path); called by 1 (contains_glob_chars).


##### `remove_trailing_glob_suffix`  (lines 770–772)

```
fn remove_trailing_glob_suffix(path: &str) -> &str
```

**Purpose**: Strips a trailing `/**` subtree suffix from a path if present.

**Data flow**: It returns `path.strip_suffix("/**").unwrap_or(path)`.

**Call relations**: Read/write glob normalization and warning detection both use this helper.

*Call graph*: called by 2 (compile_read_write_glob_path, unsupported_read_write_glob_paths).


##### `parse_special_path`  (lines 779–791)

```
fn parse_special_path(path: &str) -> Option<FileSystemSpecialPath>
```

**Purpose**: Parses symbolic filesystem path keys such as `:root`, `:minimal`, and `:workspace_roots`, preserving unknown future `:` paths as `Unknown` instead of rejecting them.

**Data flow**: It matches known special strings to the corresponding `FileSystemSpecialPath` variants, maps any other `:`-prefixed string to `FileSystemSpecialPath::unknown(path, None)`, and returns `None` for ordinary paths.

**Call relations**: Filesystem compilation uses this to keep config forward-compatible across versions.

*Call graph*: called by 4 (compile_filesystem_path, compile_filesystem_permission, compile_scoped_filesystem_path, compile_scoped_filesystem_pattern); 2 external calls (project_roots, unknown).


##### `parse_absolute_path`  (lines 793–795)

```
fn parse_absolute_path(path: &str) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Parses a path string into `AbsolutePathBuf` using platform-aware absolute-path rules.

**Data flow**: It forwards the path and compile-time Windows flag into `parse_absolute_path_for_platform` and returns the result.

**Call relations**: Most filesystem path compilation helpers delegate here for ordinary absolute paths.

*Call graph*: calls 1 internal fn (parse_absolute_path_for_platform); called by 4 (compile_filesystem_access_path, compile_filesystem_path, compile_scoped_filesystem_path, compile_scoped_filesystem_pattern); 1 external calls (cfg!).


##### `parse_absolute_path_for_platform`  (lines 797–809)

```
fn parse_absolute_path_for_platform(path: &str, is_windows: bool) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Validates and parses an absolute path string, allowing `~`/`~/...` and Windows verbatim path normalization.

**Data flow**: It normalizes the path for the target platform, checks absolute-path validity with `is_absolute_path_for_platform` unless the original string is `~` or starts with `~/`, returns an `InvalidInput` error for invalid paths, and otherwise constructs `AbsolutePathBuf::from_absolute_path(...)`.

**Call relations**: This is the platform-specific implementation behind `parse_absolute_path`.

*Call graph*: calls 3 internal fn (is_absolute_path_for_platform, normalize_absolute_path_for_platform, from_absolute_path); called by 1 (parse_absolute_path); 2 external calls (new, format!).


##### `is_absolute_path_for_platform`  (lines 811–818)

```
fn is_absolute_path_for_platform(path: &str, normalized_path: &Path, is_windows: bool) -> bool
```

**Purpose**: Determines whether a path should count as absolute under Unix or Windows rules.

**Data flow**: On Windows it checks both the original and normalized strings with `is_windows_absolute_path`; on non-Windows it returns `normalized_path.is_absolute()`.

**Call relations**: Absolute-path parsing uses this after normalization.

*Call graph*: calls 1 internal fn (is_windows_absolute_path); called by 1 (parse_absolute_path_for_platform); 2 external calls (is_absolute, to_string_lossy).


##### `normalize_absolute_path_for_platform`  (lines 820–829)

```
fn normalize_absolute_path_for_platform(path: &str, is_windows: bool) -> Cow<'_, Path>
```

**Purpose**: Normalizes a path string into a `Path` view suitable for absolute-path checks, especially converting Windows verbatim device paths.

**Data flow**: On non-Windows it returns a borrowed `Path`. On Windows it tries `normalize_windows_device_path`; if successful it returns an owned normalized `PathBuf`, otherwise a borrowed `Path` of the original string.

**Call relations**: This helper feeds `parse_absolute_path_for_platform`.

*Call graph*: calls 1 internal fn (normalize_windows_device_path); called by 1 (parse_absolute_path_for_platform); 4 external calls (Borrowed, Owned, new, from).


##### `normalize_windows_device_path`  (lines 831–849)

```
fn normalize_windows_device_path(path: &str) -> Option<String>
```

**Purpose**: Converts Windows verbatim device path prefixes like `\\?\` and `\\.\` into ordinary drive or UNC paths.

**Data flow**: It strips recognized verbatim UNC and drive prefixes, validates drive-absolute suffixes where needed, and returns the normalized string form or `None` if no normalization applies.

**Call relations**: Glob detection and absolute-path normalization both use this helper on Windows.

*Call graph*: calls 1 internal fn (is_windows_drive_absolute_path); called by 2 (contains_glob_chars_for_platform, normalize_absolute_path_for_platform); 1 external calls (format!).


##### `is_windows_absolute_path`  (lines 851–853)

```
fn is_windows_absolute_path(path: &str) -> bool
```

**Purpose**: Checks whether a Windows path is absolute as either a drive path or UNC path.

**Data flow**: It returns true if `is_windows_drive_absolute_path(path)` is true or the string starts with `\\`.

**Call relations**: This is used by `is_absolute_path_for_platform`.

*Call graph*: calls 1 internal fn (is_windows_drive_absolute_path); called by 1 (is_absolute_path_for_platform).


##### `is_windows_drive_absolute_path`  (lines 855–861)

```
fn is_windows_drive_absolute_path(path: &str) -> bool
```

**Purpose**: Checks whether a string has the `C:\` or `C:/` style Windows drive-absolute prefix.

**Data flow**: It inspects the byte sequence and returns true only when the first byte is an ASCII letter, the second is `:`, and the third is `\` or `/`.

**Call relations**: Windows absolute-path and device-path normalization helpers use this predicate.

*Call graph*: called by 2 (is_windows_absolute_path, normalize_windows_device_path); 1 external calls (matches!).


##### `parse_relative_subpath`  (lines 863–880)

```
fn parse_relative_subpath(subpath: &str) -> io::Result<PathBuf>
```

**Purpose**: Validates that a scoped filesystem subpath is a strict descendant path with only normal components.

**Data flow**: It parses the string as a `Path`, accepts it only when non-empty and every component is `Component::Normal(_)`, returning a `PathBuf`; otherwise it returns an `InvalidInput` error forbidding `.` and `..` components.

**Call relations**: Scoped filesystem path and pattern compilation both rely on this validation.

*Call graph*: called by 2 (compile_scoped_filesystem_path, compile_scoped_filesystem_pattern); 3 external calls (new, new, format!).


##### `push_warning`  (lines 882–885)

```
fn push_warning(startup_warnings: &mut Vec<String>, message: String)
```

**Purpose**: Logs a warning message and records it in the startup warning list.

**Data flow**: It emits the message with `tracing::warn!` and pushes the same string into the mutable `startup_warnings` vector.

**Call relations**: Permission-profile compilation and unknown-special-path handling use this shared warning sink.

*Call graph*: called by 2 (compile_permission_profile, maybe_push_unknown_special_path_warning); 1 external calls (warn!).


##### `missing_filesystem_entries_warning`  (lines 887–891)

```
fn missing_filesystem_entries_warning(profile_name: &str) -> String
```

**Purpose**: Formats the warning shown when a permission profile defines no recognized filesystem entries for this Codex version.

**Data flow**: It interpolates the profile name into a fixed explanatory string and returns the resulting `String`.

**Call relations**: `compile_permission_profile` uses this when a profile’s filesystem section is absent or effectively empty.

*Call graph*: called by 1 (compile_permission_profile); 1 external calls (format!).


##### `maybe_push_unknown_special_path_warning`  (lines 893–912)

```
fn maybe_push_unknown_special_path_warning(
    special: &FileSystemSpecialPath,
    startup_warnings: &mut Vec<String>,
)
```

**Purpose**: Emits a startup warning when a parsed special filesystem path is an unknown forward-compatible placeholder.

**Data flow**: It pattern-matches `FileSystemSpecialPath::Unknown { path, subpath }`; for unknown paths it formats either a simple or nested-entry warning and passes it to `push_warning`, while known special paths do nothing.

**Call relations**: Filesystem path compilation calls this whenever an unknown special path is encountered so config load continues but the user is informed.

*Call graph*: calls 1 internal fn (push_warning); called by 2 (compile_filesystem_path, compile_scoped_filesystem_path); 1 external calls (format!).


### `core/src/config/resolved_permission_profile.rs`

`data_model` · `config load and session/runtime permission synchronization`

This module separates the concrete permission rules from the metadata describing how those rules were selected. `ResolvedPermissionProfile` has three variants: `Legacy`, which carries only a `PermissionProfile`; `BuiltIn`, which stores a built-in profile ID, optional `extends`, the concrete profile, and profile-defined workspace roots; and `Named`, which stores the same metadata for user-defined profiles. `BuiltInPermissionProfileId` provides the mapping between built-in string IDs and enum variants.

`PermissionProfileSnapshot` is the trusted transport type used when session state needs to hand an already-resolved permission selection back to config consumers. It can represent a legacy profile with no active ID, an active profile with or without profile workspace roots, or reconstruct itself from session snapshots. Importantly, these constructors do not resolve IDs against config; they assume the caller already paired the ID with the correct concrete profile.

`PermissionProfileState` wraps a `Constrained<ResolvedPermissionProfile>`. Its constructors take a constrained `PermissionProfile` and lift that constraint onto the richer resolved-profile representation by validating candidates against `candidate.permission_profile()`. This lets the rest of the system preserve active-profile identity and profile workspace roots while still enforcing the same permission constraints that would apply to a plain `PermissionProfile`. The mutators distinguish between setting a legacy profile directly and installing a full trusted snapshot.

#### Function details

##### `BuiltInPermissionProfileId::from_str`  (lines 18–25)

```
fn from_str(id: &str) -> Option<Self>
```

**Purpose**: Parses a built-in permission profile string ID into the internal enum.

**Data flow**: It matches the input string against the three built-in profile constants and returns `Some(enum_variant)` for recognized IDs or `None` otherwise.

**Call relations**: Resolved-profile construction uses this to decide whether an active profile ID should be represented as `BuiltIn` or `Named`.

*Call graph*: called by 1 (from_active_profile).


##### `BuiltInPermissionProfileId::as_str`  (lines 27–33)

```
fn as_str(self) -> &'static str
```

**Purpose**: Converts the internal built-in profile enum back into its canonical string ID.

**Data flow**: It matches `self` and returns the corresponding built-in profile constant as `&'static str`.

**Call relations**: Active-profile projection uses this when reconstructing `ActivePermissionProfile` from a built-in resolved profile.


##### `ResolvedPermissionProfile::from_active_profile`  (lines 78–103)

```
fn from_active_profile(
        permission_profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
        profile_workspace_roots: Vec<AbsolutePathBuf>,
    )
```

**Purpose**: Builds a resolved-profile value from a concrete permission profile plus optional active-profile metadata and profile workspace roots.

**Data flow**: If `active_permission_profile` is `None`, it returns `ResolvedPermissionProfile::legacy(permission_profile)`. Otherwise it destructures the active profile, parses the ID with `BuiltInPermissionProfileId::from_str`, and returns either `BuiltIn { ... }` or `Named { ... }` carrying the concrete profile, `extends`, and workspace roots.

**Call relations**: Snapshot construction and constrained active-profile state creation both delegate here.

*Call graph*: calls 1 internal fn (from_str); called by 2 (active_with_profile_workspace_roots, from_constrained_active_profile); 3 external calls (BuiltIn, Named, legacy).


##### `ResolvedPermissionProfile::legacy`  (lines 105–107)

```
fn legacy(permission_profile: PermissionProfile) -> Self
```

**Purpose**: Wraps a concrete permission profile as a legacy resolved profile with no active-profile identity.

**Data flow**: It takes ownership of a `PermissionProfile`, stores it in `LegacyPermissionProfile`, and returns `ResolvedPermissionProfile::Legacy(...)`.

**Call relations**: Legacy snapshot/state constructors and legacy setters use this helper.

*Call graph*: called by 4 (legacy, can_set_legacy_permission_profile, from_constrained_legacy, set_legacy_permission_profile); 1 external calls (Legacy).


##### `ResolvedPermissionProfile::permission_profile`  (lines 109–115)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: Returns the concrete `PermissionProfile` regardless of whether the resolved profile is legacy, built-in, or named.

**Data flow**: It matches `self` and returns a borrowed reference to the embedded `permission_profile` field.

**Call relations**: Snapshot and state accessors use this to expose the canonical permission rules.

*Call graph*: called by 1 (permission_profile).


##### `ResolvedPermissionProfile::active_permission_profile`  (lines 117–129)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Projects the resolved profile back into optional active-profile metadata.

**Data flow**: It returns `None` for `Legacy`. For `BuiltIn` it constructs `ActivePermissionProfile` using `id.as_str()` and cloned `extends`; for `Named` it clones the stored `id` and `extends`.

**Call relations**: Snapshot and state accessors use this when callers need to know the selected profile identity.

*Call graph*: called by 1 (active_permission_profile).


##### `ResolvedPermissionProfile::profile_workspace_roots`  (lines 131–137)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the workspace roots declared by the resolved profile itself.

**Data flow**: It matches `self`, returning an empty slice for `Legacy` and the stored root slice for `BuiltIn` and `Named`.

**Call relations**: Snapshot and state accessors use this to preserve profile-defined roots separately from runtime workspace roots.

*Call graph*: called by 1 (profile_workspace_roots).


##### `PermissionProfileSnapshot::legacy`  (lines 146–150)

```
fn legacy(permission_profile: PermissionProfile) -> Self
```

**Purpose**: Creates a trusted snapshot with only a concrete permission profile and no active-profile identity.

**Data flow**: It wraps `ResolvedPermissionProfile::legacy(permission_profile)` inside `PermissionProfileSnapshot` and returns it.

**Call relations**: Callers use this when mirroring legacy or anonymous permission state into session/config bridges.

*Call graph*: calls 1 internal fn (legacy); called by 4 (set_permission_profile_projection, side_fork_config_inherits_parent_thread_runtime_settings, update_feature_flags_disabling_guardian_clears_review_policy_and_restores_default, session_configured_syncs_widget_config_permissions_and_cwd).


##### `PermissionProfileSnapshot::active`  (lines 158–167)

```
fn active(
        permission_profile: PermissionProfile,
        active_permission_profile: ActivePermissionProfile,
    ) -> Self
```

**Purpose**: Creates a trusted snapshot for a known active profile ID without profile workspace roots.

**Data flow**: It forwards the concrete profile and `ActivePermissionProfile` into `active_with_profile_workspace_roots` with an empty root vector and returns the resulting snapshot.

**Call relations**: Many session/config synchronization paths use this convenience constructor when no profile-defined roots need to be preserved.

*Call graph*: called by 21 (permission_snapshot_setter_preserves_permission_constraints, apply, sync_auto_review_runtime_state_from_effective_config, try_set_builtin_active_permission_profile_on_config, handle_event, permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread, profile_permissions_selection_emits_active_custom_profile, profile_permissions_selection_emits_auto_review_mode_event, profile_permissions_selection_emits_named_profile_event_only, profile_permissions_selection_popup_snapshot (+11 more)); 2 external calls (active_with_profile_workspace_roots, new).


##### `PermissionProfileSnapshot::active_with_profile_workspace_roots`  (lines 175–187)

```
fn active_with_profile_workspace_roots(
        permission_profile: PermissionProfile,
        active_permission_profile: ActivePermissionProfile,
        profile_workspace_roots: Vec<AbsolutePathBuf>
```

**Purpose**: Creates a trusted snapshot for a known active profile ID together with profile-defined workspace roots.

**Data flow**: It calls `ResolvedPermissionProfile::from_active_profile(permission_profile, Some(active_permission_profile), profile_workspace_roots)`, wraps the result in `PermissionProfileSnapshot`, and returns it.

**Call relations**: This is the most complete snapshot constructor and underlies the simpler `active` constructor.

*Call graph*: calls 1 internal fn (from_active_profile); called by 2 (set_permission_profile_projection, status_permissions_workspace_roots_include_profile_defined_directories).


##### `PermissionProfileSnapshot::from_session_snapshot`  (lines 195–205)

```
fn from_session_snapshot(
        permission_profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
    ) -> Self
```

**Purpose**: Reconstructs a trusted snapshot from session-emitted concrete permission state and optional active-profile metadata.

**Data flow**: It matches on `active_permission_profile`: `Some(...)` delegates to `active`, while `None` delegates to `legacy`, returning the resulting snapshot.

**Call relations**: Session-application code uses this when converting protocol/session payloads back into local snapshot objects.

*Call graph*: called by 6 (apply_permission_profile_selection, apply_runtime_policy_overrides, update_feature_flags, on_session_configured_with_display_and_fork_parent_title, apply_thread_settings, set_permission_profile_with_active_profile); 2 external calls (active, legacy).


##### `PermissionProfileSnapshot::permission_profile`  (lines 208–210)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: Returns the concrete permission profile captured in the snapshot.

**Data flow**: It delegates to `self.resolved_permission_profile.permission_profile()` and returns the borrowed reference.

**Call relations**: Consumers use this when they need the concrete rules from a trusted snapshot.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (replace_permission_profile_from_session_snapshot).


##### `PermissionProfileSnapshot::active_permission_profile`  (lines 213–215)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the active-profile metadata captured in the snapshot, if any.

**Data flow**: It delegates to `self.resolved_permission_profile.active_permission_profile()` and returns the optional cloned metadata.

**Call relations**: This accessor is used by code that needs to preserve or inspect the selected profile identity.

*Call graph*: calls 1 internal fn (active_permission_profile).


##### `PermissionProfileSnapshot::profile_workspace_roots`  (lines 218–220)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the profile-defined workspace roots captured in the snapshot.

**Data flow**: It delegates to `self.resolved_permission_profile.profile_workspace_roots()` and returns the borrowed slice.

**Call relations**: This accessor supports round-tripping profile roots through session state.

*Call graph*: calls 1 internal fn (profile_workspace_roots).


##### `PermissionProfileSnapshot::into_resolved_permission_profile`  (lines 222–224)

```
fn into_resolved_permission_profile(self) -> ResolvedPermissionProfile
```

**Purpose**: Consumes the snapshot and returns its internal resolved-profile representation.

**Data flow**: It moves out `self.resolved_permission_profile` and returns it.

**Call relations**: State mutators use this when installing a trusted snapshot into constrained permission state.

*Call graph*: called by 2 (replace_permission_profile_from_session_snapshot, set_permission_profile_snapshot).


##### `PermissionProfileState::from_constrained_legacy`  (lines 233–239)

```
fn from_constrained_legacy(
        constrained_permission_profile: Constrained<PermissionProfile>,
    ) -> ConstraintResult<Self>
```

**Purpose**: Builds constrained resolved-profile state from a constrained concrete permission profile with no active-profile identity.

**Data flow**: It clones the current constrained profile value, wraps it as `ResolvedPermissionProfile::legacy`, and delegates to `from_constrained_resolved` to lift the constraint onto the richer representation.

**Call relations**: Minimal permission construction uses this when only a constrained legacy profile is available.

*Call graph*: calls 2 internal fn (get, legacy); called by 1 (from_approval_and_profile); 1 external calls (from_constrained_resolved).


##### `PermissionProfileState::from_constrained_active_profile`  (lines 241–252)

```
fn from_constrained_active_profile(
        constrained_permission_profile: Constrained<PermissionProfile>,
        active_permission_profile: Option<ActivePermissionProfile>,
        profile_workspac
```

**Purpose**: Builds constrained resolved-profile state from a constrained concrete profile plus active-profile metadata and profile roots.

**Data flow**: It clones the current constrained profile value, constructs a resolved profile with `ResolvedPermissionProfile::from_active_profile`, and delegates to `from_constrained_resolved`.

**Call relations**: The full config loader uses this after selecting and constraining the effective permission profile.

*Call graph*: calls 2 internal fn (get, from_active_profile); called by 1 (load_config_with_layer_stack); 1 external calls (from_constrained_resolved).


##### `PermissionProfileState::from_constrained_resolved`  (lines 254–268)

```
fn from_constrained_resolved(
        constrained_permission_profile: Constrained<PermissionProfile>,
        resolved_permission_profile: ResolvedPermissionProfile,
    ) -> ConstraintResult<Self>
```

**Purpose**: Lifts a `Constrained<PermissionProfile>` into a `Constrained<ResolvedPermissionProfile>` by validating candidates against their embedded concrete profile.

**Data flow**: It takes ownership of the constrained concrete profile and a resolved-profile candidate, creates `Constrained::new(resolved_permission_profile, move |candidate| permission_profile_constraint.can_set(candidate.permission_profile()))`, and returns `PermissionProfileState` wrapping that constrained resolved profile.

**Call relations**: All state constructors and the force-replace snapshot path rely on this lifting step.

*Call graph*: calls 1 internal fn (new); called by 1 (replace_permission_profile_from_session_snapshot).


##### `PermissionProfileState::permission_profile`  (lines 270–272)

```
fn permission_profile(&self) -> &PermissionProfile
```

**Purpose**: Returns the currently constrained concrete permission profile.

**Data flow**: It reads `self.resolved_permission_profile.get()` and returns the embedded `PermissionProfile` reference.

**Call relations**: Higher-level `Permissions` accessors delegate here for canonical profile queries.

*Call graph*: calls 1 internal fn (get); called by 3 (permission_profile, network_sandbox_policy, permission_profile).


##### `PermissionProfileState::active_permission_profile`  (lines 274–278)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the active-profile metadata from the currently constrained resolved profile.

**Data flow**: It reads `self.resolved_permission_profile.get()` and calls `.active_permission_profile()` on the resolved profile.

**Call relations**: Higher-level `Permissions` accessors use this to expose active profile identity.

*Call graph*: calls 1 internal fn (get); called by 2 (active_permission_profile, active_permission_profile).


##### `PermissionProfileState::profile_workspace_roots`  (lines 280–284)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the profile-defined workspace roots from the currently constrained resolved profile.

**Data flow**: It reads `self.resolved_permission_profile.get()` and returns the embedded root slice.

**Call relations**: Higher-level `Permissions` accessors use this when combining runtime and profile workspace roots.

*Call graph*: calls 1 internal fn (get); called by 2 (profile_workspace_roots, profile_workspace_roots).


##### `PermissionProfileState::can_set_legacy_permission_profile`  (lines 286–292)

```
fn can_set_legacy_permission_profile(
        &self,
        permission_profile: &PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Checks whether a candidate concrete permission profile would satisfy the current resolved-profile constraint when treated as a legacy profile.

**Data flow**: It clones the candidate `PermissionProfile`, wraps it with `ResolvedPermissionProfile::legacy`, and calls `self.resolved_permission_profile.can_set(&candidate)`.

**Call relations**: Permission validation paths use this before applying direct profile or legacy sandbox changes.

*Call graph*: calls 2 internal fn (can_set, legacy); called by 2 (can_set_legacy_sandbox_policy, can_set_permission_profile); 1 external calls (clone).


##### `PermissionProfileState::set_legacy_permission_profile`  (lines 294–300)

```
fn set_legacy_permission_profile(
        &mut self,
        permission_profile: PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Sets the constrained resolved profile to a legacy wrapper around a new concrete permission profile.

**Data flow**: It wraps the owned `PermissionProfile` with `ResolvedPermissionProfile::legacy` and passes it to `self.resolved_permission_profile.set(...)`, returning the constraint result.

**Call relations**: Direct profile setters and legacy sandbox-policy setters use this mutator.

*Call graph*: calls 2 internal fn (set, legacy); called by 3 (set_legacy_sandbox_policy, set_permission_profile, set_permission_profile_for_tests).


##### `PermissionProfileState::set_permission_profile_snapshot`  (lines 302–308)

```
fn set_permission_profile_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Installs a trusted permission-profile snapshot into the constrained resolved-profile state.

**Data flow**: It consumes the `PermissionProfileSnapshot`, converts it into a `ResolvedPermissionProfile`, and passes that into `self.resolved_permission_profile.set(...)`, returning the constraint result.

**Call relations**: Snapshot-based permission synchronization uses this as the ordinary constrained installation path.

*Call graph*: calls 2 internal fn (set, into_resolved_permission_profile); called by 2 (set_permission_profile_from_session_snapshot, set_permission_profile_projection).


### `tui/src/permission_compat.rs`

`domain_logic` · `permission translation during request/setup when talking to legacy or remote APIs`

This file contains a single compatibility adapter plus a regression test. The adapter first asks the incoming `codex_protocol::models::PermissionProfile` whether it already converts cleanly through `to_legacy_sandbox_policy(cwd)`; if so, it returns an unchanged clone. The interesting path is the fallback: it extracts the file-system and network sandbox policies from the canonical profile, computes the writable roots visible from the supplied working directory, and rebuilds a new profile using `PermissionProfile::workspace_write_with(...)`, which is known to be representable by legacy APIs.

The fallback intentionally filters out the current working directory from the explicit writable-root list because `workspace_write_with` implicitly grants workspace/CWD write access itself; duplicating it would be redundant and could distort the reconstructed root set. It also probes two special temporary locations—`$TMPDIR` if set and parseable as an absolute path, and `/tmp` if it exists as an absolute directory—to determine whether the original policy allowed writes there. Those booleans are inverted when passed into `workspace_write_with`, because that constructor expects flags describing whether temp locations should be excluded rather than included. The included test captures a subtle invariant: extra writable roots that cannot be bridged directly through the legacy projection must still survive in the compatibility profile alongside the workspace root.

#### Function details

##### `legacy_compatible_permission_profile`  (lines 8–42)

```
fn legacy_compatible_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &Path,
) -> PermissionProfile
```

**Purpose**: Builds a `PermissionProfile` that is guaranteed to be convertible to the legacy sandbox-policy representation for the given `cwd`. It returns the original profile unchanged when conversion already succeeds, otherwise reconstructs a workspace-write profile that preserves network policy, extra writable roots, and temp-directory write semantics as closely as the legacy shape allows.

**Data flow**: Inputs are `&PermissionProfile` and `&Path` for the current working directory. It reads legacy-conversion viability via `to_legacy_sandbox_policy`, extracts file-system and network policies, derives an optional absolute `cwd`, gathers writable roots with `get_writable_roots_with_cwd`, removes any root equal to `cwd`, probes `$TMPDIR` and `/tmp` for writability under the original policy, then returns a newly constructed `PermissionProfile` from `workspace_write_with`; it does not mutate external state beyond reading the `TMPDIR` environment variable.

**Call relations**: This adapter is invoked from permission-override processing when the TUI needs to send permissions to older interfaces, and from the regression test that verifies preservation of extra write roots. On the fast path it delegates only to the legacy conversion check and cloning; on the fallback path it delegates to policy accessors and the `workspace_write_with` constructor specifically to force a representable profile.

*Call graph*: calls 5 internal fn (file_system_sandbox_policy, network_sandbox_policy, to_legacy_sandbox_policy, workspace_write_with, from_absolute_path); called by 2 (turn_permissions_overrides, compatibility_profile_preserves_unbridgeable_write_roots); 3 external calls (new, clone, var_os).


##### `tests::compatibility_profile_preserves_unbridgeable_write_roots`  (lines 56–92)

```
fn compatibility_profile_preserves_unbridgeable_write_roots()
```

**Purpose**: Verifies that the compatibility projection keeps an additional writable root even when the original managed permission profile cannot be directly bridged to the legacy sandbox policy. The test also confirms that the workspace root is still present after reconstruction.

**Data flow**: It constructs an absolute `cwd`, an extra writable root, and a `PermissionProfile::Managed` with restricted network access plus file-system entries granting root read and extra-root write. It passes that profile into `legacy_compatible_permission_profile`, converts the result back through `to_legacy_sandbox_policy`, extracts writable roots, and asserts that the resulting vector equals `[extra_root, cwd]`.

**Call relations**: This is a focused regression test for the fallback branch of `legacy_compatible_permission_profile`. It drives the adapter with a profile shape that legacy conversion cannot represent directly, then inspects the projected legacy policy to ensure the adapter preserved the intended write access.

*Call graph*: calls 2 internal fn (legacy_compatible_permission_profile, try_from); 2 external calls (assert_eq!, vec!).


### `tui/src/additional_dirs.rs`

`domain_logic` · `startup / CLI option validation`

This file implements a narrow policy check around additional writable directories in the TUI. The exported `add_dir_warning_message` examines three inputs: the list of requested extra directories, the resolved `PermissionProfile`, and the current working directory. It returns `None` in all cases where warning would be misleading or unnecessary: when no extra directories were requested, when permissions are effectively unrestricted (`Disabled`) or delegated externally (`External`), when the filesystem sandbox already grants full disk write access, or when the sandbox can already write the current working directory. Only when extra directories were requested and the effective sandbox does not permit adding writable roots does it return a formatted warning string.

The helper `format_warning` is intentionally simple but concrete: it joins the provided `PathBuf`s using lossy string conversion and embeds them directly in a fixed explanatory sentence that tells the user which permission modes would allow the request.

The inline tests cover the important branches: permissive workspace-write, danger-full-access, external sandbox, read-only mode, a restricted profile that can write somewhere else but not the cwd, and the empty-directory case. Together they document the subtle design choice that the warning is about inability to extend writable roots relative to the effective cwd policy, not merely about whether some writable path exists somewhere in the sandbox.

#### Function details

##### `add_dir_warning_message`  (lines 7–33)

```
fn add_dir_warning_message(
    additional_dirs: &[PathBuf],
    permission_profile: &PermissionProfile,
    cwd: &std::path::Path,
) -> Option<String>
```

**Purpose**: Computes whether `--add-dir` entries should be ignored under the current permission profile and, if so, returns the exact warning text to show the user.

**Data flow**: Reads `additional_dirs`, `permission_profile`, and `cwd`. It returns early with `None` if the directory list is empty, if the profile is `Disabled` or `External`, if the derived filesystem sandbox policy has full disk write access, or if that policy can write the cwd. Otherwise it calls `format_warning(additional_dirs)` and returns `Some(String)`.

**Call relations**: This function is called from `run_main` in normal execution and from tests in this module. It delegates policy introspection to `permission_profile.file_system_sandbox_policy()` and string assembly to `format_warning`, making it the decision point while leaving presentation formatting separate.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, format_warning); called by 2 (warns_for_read_only, run_main); 2 external calls (is_empty, matches!).


##### `format_warning`  (lines 35–44)

```
fn format_warning(additional_dirs: &[PathBuf]) -> String
```

**Purpose**: Builds the human-readable warning string listing the ignored additional directories and the permission modes that would permit them.

**Data flow**: Iterates over `additional_dirs`, converts each path to a lossy string, joins them with `, `, and interpolates the result into a fixed explanatory sentence. It returns the formatted `String` without mutating any external state.

**Call relations**: This helper is only called when `add_dir_warning_message` has already determined a warning is necessary. It isolates the exact wording and path-list formatting from the permission-policy checks.

*Call graph*: called by 1 (add_dir_warning_message); 2 external calls (iter, format!).


##### `tests::returns_none_for_workspace_write`  (lines 61–68)

```
fn returns_none_for_workspace_write()
```

**Purpose**: Asserts that a workspace-write profile does not warn about additional directories.

**Data flow**: Constructs a workspace-write `PermissionProfile`, a one-element directory vector, calls `add_dir_warning_message`, and asserts the result is `None`.

**Call relations**: This test is run by the test harness and exercises the branch where the effective filesystem policy already permits the cwd, so no warning should be emitted.

*Call graph*: calls 1 internal fn (workspace_write); 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_for_danger_full_access`  (lines 71–78)

```
fn returns_none_for_danger_full_access()
```

**Purpose**: Checks that the unrestricted `Disabled` profile suppresses the warning entirely.

**Data flow**: Builds `PermissionProfile::Disabled`, passes a sample directory list and cwd into `add_dir_warning_message`, and asserts the function returns `None`.

**Call relations**: This test covers the explicit early-return branch for unrestricted permissions and documents that `Disabled` is treated as allowing additional writable roots.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_for_external_sandbox`  (lines 81–90)

```
fn returns_none_for_external_sandbox()
```

**Purpose**: Verifies that externally managed sandboxing does not produce a local warning about ignored `--add-dir` entries.

**Data flow**: Constructs `PermissionProfile::External { network: ... }`, supplies a sample directory vector and cwd, and asserts `add_dir_warning_message` returns `None`.

**Call relations**: This test covers the branch where local code declines to second-guess an external sandbox implementation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::warns_for_read_only`  (lines 93–102)

```
fn warns_for_read_only()
```

**Purpose**: Confirms that a read-only profile emits the exact warning string and includes both relative and absolute paths in the joined path list.

**Data flow**: Creates a read-only profile and two sample `PathBuf`s, calls `add_dir_warning_message`, unwraps the returned `Some(String)`, and compares it to the expected literal warning text.

**Call relations**: This test exercises the positive warning path and indirectly validates `format_warning`'s path joining and message wording.

*Call graph*: calls 2 internal fn (read_only, add_dir_warning_message); 3 external calls (new, assert_eq!, vec!).


##### `tests::warns_when_profile_can_write_elsewhere_but_not_cwd`  (lines 105–132)

```
fn warns_when_profile_can_write_elsewhere_but_not_cwd()
```

**Purpose**: Checks the subtle case where the sandbox has some writable path but still cannot extend writable roots relative to the current workspace.

**Data flow**: Builds a restricted managed profile with read access to root and write access only to `/tmp/writable`, passes `/tmp/project` as cwd and `/tmp/extra` as an added dir, and asserts the returned warning string matches the expected `Some(String)`.

**Call relations**: This test documents the file's key policy nuance: having any writable path is not enough to suppress the warning if the cwd itself is not writable under the effective sandbox.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_when_no_additional_dirs`  (lines 135–142)

```
fn returns_none_when_no_additional_dirs()
```

**Purpose**: Ensures the function stays silent when the user did not request any extra directories, regardless of restrictive permissions.

**Data flow**: Creates a read-only profile and an empty `Vec<PathBuf>`, calls `add_dir_warning_message`, and asserts the result is `None`.

**Call relations**: This test covers the first early-return guard and confirms the warning is tied to actual `--add-dir` usage rather than general permission state.

*Call graph*: calls 1 internal fn (read_only); 2 external calls (new, assert_eq!).


### Windows sandbox policy
These files translate resolved permissions into Windows-specific enforcement details and orchestrate sandbox setup and persistence.

### `windows-sandbox-rs/src/cap.rs`

`domain_logic` · `sandbox permission preparation`

This module is the persistent data and helper layer for capability SIDs. The `CapSids` struct stores a legacy/global `workspace` SID, a `readonly` SID, a `workspace_by_cwd` map keyed by canonicalized current-working-directory strings, and a `writable_root_by_path` map keyed by canonicalized writable-root paths. These maps let the sandbox issue write capabilities that are specific to the active workspace and extra roots, preventing stale ACLs from older roots from broadening future sessions.

The file format lives at `codex_home/cap_sid`. `load_or_create_cap_sids` supports both the current JSON object format and a legacy plain-string format containing only the workspace SID; when it sees the legacy form, it upgrades in place by generating a fresh readonly SID and empty maps. New SID strings are synthetic `S-1-5-21-a-b-c-d` values built from four random `u32`s. `workspace_cap_sid_for_cwd` and `writable_root_cap_sid_for_path` canonicalize their keys, lazily create missing entries, persist the updated file, and return the stable SID string. `workspace_write_cap_sid_for_root` chooses between those two namespaces depending on whether the root canonicalizes to the command CWD. The remaining helpers compare canonicalized paths to determine containment, overlap, and path specificity, which higher-level setup code uses when deciding which capability SIDs should receive grants or deny ACEs.

#### Function details

##### `cap_sid_file`  (lines 35–37)

```
fn cap_sid_file(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the filesystem path where capability SID state is stored under `codex_home`.

**Data flow**: It takes `codex_home: &Path`, appends the fixed filename `cap_sid`, and returns the resulting `PathBuf`.

**Call relations**: This path helper is used by all load/create/persist operations and by other permission-preparation code elsewhere in the crate.

*Call graph*: called by 4 (apply_capability_denies_for_world_writable_for_permissions, load_or_create_cap_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path); 1 external calls (join).


##### `make_random_cap_sid_string`  (lines 39–46)

```
fn make_random_cap_sid_string() -> String
```

**Purpose**: Generates a synthetic capability SID string in the `S-1-5-21-...` form.

**Data flow**: It seeds `SmallRng` from entropy, draws four `u32` values, formats them into a SID-like string, and returns that `String`.

**Call relations**: This helper is used whenever new capability identifiers must be created for fresh state or missing map entries.

*Call graph*: called by 3 (load_or_create_cap_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path); 2 external calls (from_entropy, format!).


##### `persist_caps`  (lines 48–55)

```
fn persist_caps(path: &Path, caps: &CapSids) -> Result<()>
```

**Purpose**: Serializes and writes the capability SID state to disk, creating parent directories if needed.

**Data flow**: It takes the destination path and a `CapSids` reference, creates the parent directory when present, serializes the struct to JSON text, writes it to the file, and returns contextualized I/O errors on failure.

**Call relations**: This persistence primitive is called after creating new capability state or lazily adding workspace/root-specific entries.

*Call graph*: called by 3 (load_or_create_cap_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path); 4 external calls (parent, create_dir_all, write, to_string).


##### `load_or_create_cap_sids`  (lines 57–86)

```
fn load_or_create_cap_sids(codex_home: &Path) -> Result<CapSids>
```

**Purpose**: Loads capability SID state from disk, upgrades the legacy single-string format, or creates fresh state when no valid file exists.

**Data flow**: It computes the cap-sid file path, reads it if present, trims the contents, attempts JSON deserialization when the text looks like an object, otherwise treats non-empty non-object text as a legacy workspace SID and upgrades it into a full `CapSids` with a new readonly SID and empty maps, persisting the upgrade. If no usable file exists, it creates a fully fresh `CapSids`, persists it, and returns it.

**Call relations**: This is the main state-loading entrypoint used by capability consumers and by the lazy per-workspace/per-root SID accessors.

*Call graph*: calls 3 internal fn (cap_sid_file, make_random_cap_sid_string, persist_caps); called by 9 (apply_capability_denies_for_world_writable_for_permissions, equivalent_cwd_spellings_share_workspace_sid_key, write_roots_get_path_scoped_sids, workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path, run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_legacy_session_security, root_capability_sids_only_include_active_roots); 2 external calls (new, read_to_string).


##### `workspace_cap_sid_for_cwd`  (lines 89–100)

```
fn workspace_cap_sid_for_cwd(codex_home: &Path, cwd: &Path) -> Result<String>
```

**Purpose**: Returns the stable workspace-specific capability SID for a canonicalized current working directory, creating and persisting it if absent.

**Data flow**: It computes the cap-sid file path, loads current state, canonicalizes `cwd` into a key string, returns the existing mapped SID if present, otherwise generates a new SID, inserts it into `workspace_by_cwd`, persists the updated state, and returns the new SID.

**Call relations**: This accessor is used when the writable root is the workspace itself and is covered by a test ensuring equivalent path spellings share one key.

*Call graph*: calls 5 internal fn (cap_sid_file, load_or_create_cap_sids, make_random_cap_sid_string, persist_caps, canonical_path_key); called by 2 (equivalent_cwd_spellings_share_workspace_sid_key, workspace_write_cap_sid_for_root).


##### `writable_root_cap_sid_for_path`  (lines 103–114)

```
fn writable_root_cap_sid_for_path(codex_home: &Path, root: &Path) -> Result<String>
```

**Purpose**: Returns the stable capability SID for an additional writable root path, creating and persisting it if absent.

**Data flow**: It computes the cap-sid file path, loads current state, canonicalizes the root path into a key string, returns the existing mapped SID if present, otherwise generates a new SID, inserts it into `writable_root_by_path`, persists the updated state, and returns the new SID.

**Call relations**: This accessor is used by `workspace_write_cap_sid_for_root` for non-workspace writable roots.

*Call graph*: calls 5 internal fn (cap_sid_file, load_or_create_cap_sids, make_random_cap_sid_string, persist_caps, canonical_path_key); called by 1 (workspace_write_cap_sid_for_root).


##### `workspace_write_cap_sid_for_root`  (lines 116–126)

```
fn workspace_write_cap_sid_for_root(
    codex_home: &Path,
    cwd: &Path,
    root: &Path,
) -> Result<String>
```

**Purpose**: Chooses the correct capability SID namespace for a writable root: workspace-specific for the CWD itself, path-specific for extra roots.

**Data flow**: It canonicalizes both `root` and `cwd`; if they match it returns `workspace_cap_sid_for_cwd(codex_home, cwd)`, otherwise it returns `writable_root_cap_sid_for_path(codex_home, root)`.

**Call relations**: This is the main public selector used by setup code and tests when deriving capability SIDs for write roots.

*Call graph*: calls 3 internal fn (workspace_cap_sid_for_cwd, writable_root_cap_sid_for_path, canonical_path_key); called by 4 (write_roots_get_path_scoped_sids, root_capability_sids, legacy_deny_path_includes_nested_active_root_sid, root_capability_sids_only_include_active_roots).


##### `workspace_write_root_contains_path`  (lines 128–130)

```
fn workspace_write_root_contains_path(root: &Path, path: &Path) -> bool
```

**Purpose**: Checks whether one canonicalized path is a prefix of another, treating that as root containment.

**Data flow**: It canonicalizes both `root` and `path`, tests whether the canonicalized `path` starts with the canonicalized `root`, and returns the boolean result.

**Call relations**: This helper feeds the overlap predicate used by higher-level deny/grant logic.

*Call graph*: calls 1 internal fn (canonicalize_path); called by 1 (workspace_write_root_overlaps_path).


##### `workspace_write_root_overlaps_path`  (lines 132–134)

```
fn workspace_write_root_overlaps_path(root: &Path, path: &Path) -> bool
```

**Purpose**: Checks whether two paths overlap by containment in either direction.

**Data flow**: It calls `workspace_write_root_contains_path(root, path)` and `workspace_write_root_contains_path(path, root)` and returns true if either is true.

**Call relations**: This overlap predicate is used by setup code when deciding which active write-root capability SIDs apply to a deny-write path.

*Call graph*: calls 1 internal fn (workspace_write_root_contains_path).


##### `workspace_write_root_specificity`  (lines 136–138)

```
fn workspace_write_root_specificity(root: &Path) -> usize
```

**Purpose**: Measures how specific a root path is by counting canonicalized path components.

**Data flow**: It canonicalizes the root path, counts its components, and returns that `usize` count.

**Call relations**: This helper supports path-ordering decisions elsewhere in the crate where more specific roots should win.

*Call graph*: calls 1 internal fn (canonicalize_path).


##### `tests::equivalent_cwd_spellings_share_workspace_sid_key`  (lines 150–175)

```
fn equivalent_cwd_spellings_share_workspace_sid_key()
```

**Purpose**: Verifies that different spellings of the same workspace path map to one canonical workspace SID entry.

**Data flow**: It creates temporary directories, derives a canonical path and an alternate uppercase/slash-normalized spelling, requests workspace SIDs for both, asserts they are equal, then reloads persisted caps and asserts only one `workspace_by_cwd` entry exists.

**Call relations**: This test validates the canonical-key behavior of `workspace_cap_sid_for_cwd`.

*Call graph*: calls 2 internal fn (load_or_create_cap_sids, workspace_cap_sid_for_cwd); 5 external calls (from, assert_eq!, canonicalize, create_dir_all, tempdir).


##### `tests::write_roots_get_path_scoped_sids`  (lines 178–202)

```
fn write_roots_get_path_scoped_sids()
```

**Purpose**: Verifies that the workspace root and an extra writable root receive distinct capability SIDs and are persisted in separate maps.

**Data flow**: It creates temporary workspace and extra-root directories, requests capability SIDs for each through `workspace_write_cap_sid_for_root`, asserts they differ, confirms the extra-root SID matches `writable_root_cap_sid_for_path`, reloads persisted caps, and asserts one workspace and one writable-root entry exist.

**Call relations**: This test covers the namespace split implemented by `workspace_write_cap_sid_for_root`.

*Call graph*: calls 2 internal fn (load_or_create_cap_sids, workspace_write_cap_sid_for_root); 4 external calls (assert_eq!, assert_ne!, create_dir_all, tempdir).


### `windows-sandbox-rs/src/deny_read_resolver.rs`

`domain_logic` · `policy resolution before ACL setup`

This file translates Codex filesystem sandbox policy into a Windows-specific list of ACL targets. Exact unreadable roots are preserved even when missing, because later ACL application can materialize those paths. Glob patterns are different: Windows ACLs cannot encode globs, so the resolver snapshots the current filesystem under a computed literal scan root and emits only existing paths that the policy matcher marks as read-denied.

`resolve_windows_deny_read_paths` first collects exact unreadable roots relative to the provided current working directory, normalizing them into `AbsolutePathBuf` values with deduplication. If unreadable globs exist, it constructs a temporary restricted `FileSystemSandboxPolicy` containing only deny glob entries and compiles a `ReadDenyMatcher`. Invalid glob syntax fails here before any scan begins.

For each glob, `glob_scan_plan` chooses the deepest literal directory prefix before the first metacharacter and computes an effective recursion bound with `effective_glob_scan_max_depth`. `collect_existing_glob_matches` then recursively walks from that root, adding paths whose lexical path matches the deny matcher. It stops on missing paths, unreadable metadata, non-directories, depth limits, and unreadable directory listings without failing the whole resolution. To avoid infinite recursion through symlink or junction cycles, it tracks canonicalized directory keys in `seen_scan_dirs`, while still preserving the original lexical matched path for ACL application. Deduplication of emitted targets is by simplified absolute path, not canonical identity, so aliased roots can each preserve their own lexical matches.

#### Function details

##### `resolve_windows_deny_read_paths`  (lines 23–69)

```
fn resolve_windows_deny_read_paths(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> Result<Vec<AbsolutePathBuf>, String>
```

**Purpose**: Converts a `FileSystemSandboxPolicy` into the concrete absolute paths that should receive deny-read ACLs on Windows. It combines exact unreadable roots with snapshot-expanded matches from unreadable glob patterns.

**Data flow**: It reads the policy and current working directory, gathers exact unreadable roots via policy helpers, and inserts them through `push_absolute_path` into a deduplicated `Vec<AbsolutePathBuf>`. If globs are present, it builds a temporary deny-only policy, compiles a `ReadDenyMatcher`, computes a `GlobScanPlan` per pattern, recursively scans existing filesystem entries with `collect_existing_glob_matches`, and returns either the accumulated path list or a `String` error from matcher/path normalization failures.

**Call relations**: This is the top-level resolver used by callers that need Windows ACL targets rather than abstract policy entries. It orchestrates the whole flow: exact-root pass-through, matcher construction, per-pattern scan planning, and recursive expansion.

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

**Purpose**: Recursively scans an existing filesystem subtree and appends paths whose lexical path is denied by the compiled matcher. It is intentionally tolerant of missing or unreadable filesystem nodes.

**Data flow**: It takes the current `&Path`, a `ReadDenyMatcher`, mutable output collections for resolved paths and dedupe sets, an additional set of canonicalized scanned directories, and depth controls. It returns early for non-existent paths, metadata failures, non-directories, repeated canonical scan keys, depth-limit hits, or unreadable directory listings; otherwise it may push the current path via `push_absolute_path` and recurse into each readable child entry, returning `Ok(())` unless path normalization fails.

**Call relations**: This function is called only from `resolve_windows_deny_read_paths` for each glob scan root. It delegates path insertion to `push_absolute_path` and uses canonicalization solely for cycle detection, preserving lexical child paths for the ACL layer.

*Call graph*: calls 2 internal fn (is_read_denied, push_absolute_path); called by 1 (resolve_windows_deny_read_paths); 5 external calls (exists, metadata, to_path_buf, canonicalize, read_dir).


##### `push_absolute_path`  (lines 125–136)

```
fn push_absolute_path(
    paths: &mut Vec<AbsolutePathBuf>,
    seen: &mut HashSet<PathBuf>,
    path: PathBuf,
) -> Result<(), String>
```

**Purpose**: Normalizes a candidate path into an `AbsolutePathBuf` and appends it only once. It is the resolver’s output deduplication boundary.

**Data flow**: It receives mutable output `Vec<AbsolutePathBuf>` and `HashSet<PathBuf>` collections plus a candidate `PathBuf`. It simplifies the path with `dunce::simplified`, validates/constructs an `AbsolutePathBuf` with `from_absolute_path`, inserts its `PathBuf` form into `seen`, and pushes the absolute wrapper if newly seen; otherwise it returns success without modifying the vector.

**Call relations**: Both exact-root collection and recursive glob scanning funnel through this helper so all emitted paths share the same absolute-path validation and duplicate suppression behavior.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (collect_existing_glob_matches, resolve_windows_deny_read_paths); 1 external calls (simplified).


##### `glob_scan_plan`  (lines 138–170)

```
fn glob_scan_plan(pattern: &str, configured_max_depth: Option<usize>) -> GlobScanPlan
```

**Purpose**: Computes where a glob expansion scan should start and how deep it should recurse. It minimizes traversal by anchoring at the deepest literal directory prefix before the first glob metacharacter.

**Data flow**: It takes a glob pattern string and an optional configured max depth, finds the first `*`, `?`, or `[` occurrence, slices out the literal prefix, determines the scan root based on the last path separator with special handling for root separators and drive roots, computes the depth bound through `effective_glob_scan_max_depth`, and returns a `GlobScanPlan { root, max_depth }`.

**Call relations**: This planner is invoked once per unreadable glob by `resolve_windows_deny_read_paths`. Its output directly controls the starting directory and recursion limit passed into `collect_existing_glob_matches`.

*Call graph*: calls 1 internal fn (effective_glob_scan_max_depth); called by 1 (resolve_windows_deny_read_paths); 1 external calls (from).


##### `effective_glob_scan_max_depth`  (lines 172–186)

```
fn effective_glob_scan_max_depth(
    pattern_suffix: &str,
    configured_max_depth: Option<usize>,
) -> Option<usize>
```

**Purpose**: Derives the recursion limit implied by the non-literal suffix of a glob pattern, optionally capped by configuration. Recursive `**` patterns preserve the configured bound, while non-recursive patterns get a finite component-count limit.

**Data flow**: It splits the pattern suffix on `/` and `\`, drops empty components, and inspects the resulting component list. If any component is exactly `"**"`, it returns the configured depth unchanged; otherwise it returns `Some(component_count)` or `Some(min(configured, component_count))` when a cap is configured.

**Call relations**: This helper is used only by `glob_scan_plan` to convert pattern structure into a practical traversal bound for filesystem scanning.

*Call graph*: called by 1 (glob_scan_plan).


##### `tests::unreadable_glob_entry`  (lines 205–210)

```
fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry
```

**Purpose**: Builds a deny-mode `FileSystemSandboxEntry` containing a glob pattern for test policies. It keeps test setup concise and explicit.

**Data flow**: It takes a `String` pattern and returns a `FileSystemSandboxEntry` with `FileSystemPath::GlobPattern { pattern }` and `FileSystemAccessMode::Deny`. It reads no external state and performs no I/O.

**Call relations**: This helper is used by multiple tests that need unreadable glob policy entries before calling the resolver.


##### `tests::unreadable_path_entry`  (lines 212–219)

```
fn unreadable_path_entry(path: PathBuf) -> FileSystemSandboxEntry
```

**Purpose**: Builds a deny-mode exact-path sandbox entry for tests from an absolute `PathBuf`. It wraps path validation into the fixture helper.

**Data flow**: It accepts a `PathBuf`, converts it to `AbsolutePathBuf` with `from_absolute_path`, and returns a `FileSystemSandboxEntry` using `FileSystemPath::Path` and deny access. It panics in tests if the supplied path is not absolute.

**Call relations**: This helper supports tests that verify exact unreadable roots are preserved without glob expansion.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `tests::scan_root_uses_literal_prefix_before_glob`  (lines 222–239)

```
fn scan_root_uses_literal_prefix_before_glob()
```

**Purpose**: Confirms that scan planning starts at the deepest literal directory prefix rather than an unnecessarily broad root. It covers Unix-style paths, nested Windows paths, and drive-root cases.

**Data flow**: It calls `glob_scan_plan` with representative patterns and asserts on the returned `.root` field. No filesystem access is required because the test checks pure string/path planning.

**Call relations**: This test targets the root-selection logic inside `glob_scan_plan`, especially separator and drive-root handling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::scan_depth_is_bounded_for_non_recursive_globs`  (lines 242–255)

```
fn scan_depth_is_bounded_for_non_recursive_globs()
```

**Purpose**: Verifies that non-recursive glob patterns produce finite scan depths matching their remaining path-component structure, while recursive `**` patterns remain unbounded when no cap is configured.

**Data flow**: It invokes `glob_scan_plan` on several patterns and asserts on the `.max_depth` field. The test is pure and does not touch the filesystem.

**Call relations**: This test exercises the interaction between `glob_scan_plan` and `effective_glob_scan_max_depth` for default depth derivation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::configured_depth_caps_recursive_glob_scans`  (lines 258–267)

```
fn configured_depth_caps_recursive_glob_scans()
```

**Purpose**: Checks that an explicit configured maximum depth limits both recursive and non-recursive scans. It ensures configuration can globally constrain traversal cost.

**Data flow**: It calls `glob_scan_plan` with patterns and `Some(max_depth)` values, then asserts the resulting `max_depth`. No external state is read or written.

**Call relations**: This test validates the capping behavior implemented by `effective_glob_scan_max_depth` and surfaced through `glob_scan_plan`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::exact_missing_paths_are_preserved`  (lines 270–287)

```
fn exact_missing_paths_are_preserved()
```

**Purpose**: Ensures that exact unreadable roots survive resolution even when the target path does not yet exist. This preserves future ACL materialization behavior.

**Data flow**: It creates a temp directory, derives an absolute cwd, constructs a missing child path, wraps it in a restricted policy via `unreadable_path_entry`, resolves paths, and asserts that the result contains the canonical tempdir joined with the missing filename as an `AbsolutePathBuf`.

**Call relations**: This test covers the exact-root branch of `resolve_windows_deny_read_paths`, demonstrating that missing exact paths are emitted without requiring a filesystem scan.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 3 external calls (new, assert_eq!, vec!).


##### `tests::glob_patterns_expand_to_existing_matches`  (lines 290–313)

```
fn glob_patterns_expand_to_existing_matches()
```

**Purpose**: Verifies that unreadable glob patterns expand only to currently existing matching files. It demonstrates recursive scanning and matcher-based filtering.

**Data flow**: It creates a temp tree with matching `.env` files and a non-matching text file, builds a deny glob policy, resolves paths, converts the result to a `HashSet<PathBuf>`, and asserts equality with the two expected `.env` paths.

**Call relations**: This test exercises the full resolver pipeline: matcher construction, scan planning, recursive traversal, and deduplicated output collection.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_windows_deny_read_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `tests::invalid_glob_patterns_fail_before_expansion`  (lines 316–330)

```
fn invalid_glob_patterns_fail_before_expansion()
```

**Purpose**: Checks that malformed glob syntax is rejected during matcher construction rather than silently ignored during scanning. This keeps policy errors visible to callers.

**Data flow**: It creates a temp cwd, builds a policy containing an invalid character range glob, calls the resolver expecting an error, and asserts that the returned message mentions both invalid deny-read glob syntax and the underlying range error.

**Call relations**: This test targets the `ReadDenyMatcher::try_new` failure path inside `resolve_windows_deny_read_paths`, before any filesystem traversal occurs.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_windows_deny_read_paths); 3 external calls (new, assert!, vec!).


##### `tests::non_recursive_globs_do_not_expand_nested_matches`  (lines 333–350)

```
fn non_recursive_globs_do_not_expand_nested_matches()
```

**Purpose**: Ensures that a single-level glob does not descend into nested directories and accidentally include deeper matches. It protects the depth-bounding semantics of non-recursive patterns.

**Data flow**: It creates a root `.env` and a nested `.env`, builds a `*.env` deny policy rooted at the temp directory, resolves paths, and asserts that only the root file is returned.

**Call relations**: This test validates that `glob_scan_plan` and `collect_existing_glob_matches` together respect the finite depth derived for non-recursive globs.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `tests::aliased_glob_roots_each_preserve_their_lexical_matches`  (lines 354–380)

```
fn aliased_glob_roots_each_preserve_their_lexical_matches()
```

**Purpose**: Verifies that two aliased roots pointing at the same target still each contribute their own lexical matched path. This distinguishes scan-cycle prevention from output canonicalization.

**Data flow**: On Unix, it creates a target directory, two symlink aliases, and a secret file under the target; then it resolves two unreadable glob patterns rooted at the aliases, collects the output into a `HashSet<PathBuf>`, and asserts that both alias-specific paths are present.

**Call relations**: This test exercises the subtle behavior in `collect_existing_glob_matches`: canonical paths are used only for `seen_scan_dirs` cycle detection, while emitted matches retain their original lexical alias.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_windows_deny_read_paths); 6 external calls (new, assert_eq!, create_dir_all, write, symlink, vec!).


### `windows-sandbox-rs/src/resolved_permissions.rs`

`domain_logic` · `permission resolution and spawn/setup planning`

This file defines `ResolvedWindowsSandboxPermissions`, a compact wrapper around `FileSystemSandboxPolicy` and `NetworkSandboxPolicy`, plus helper types for Windows enforcement decisions. The key distinction is between the protocol-level `PermissionProfile` and the concrete, cwd-bound, workspace-root-expanded permissions the Windows sandbox actually needs. `try_from_permission_profile` rejects unsupported profiles early: only managed profiles with restricted filesystem policy are accepted. `try_from_permission_profile_for_workspace_roots` then materializes symbolic `project_roots` entries against the runtime workspace roots supplied by the caller.

The file also decides which restricted-token strategy to use. `token_mode_for_permission_profile` resolves the profile, rejects full-disk write requests as unenforceable on Windows, and chooses `ReadOnlyCapability` versus `WritableRootsCapability` based on whether any writable roots remain after cwd/env resolution.

Filesystem queries expose several derived views: readable roots for a cwd, whether platform defaults should be included, and writable roots represented as `WindowsWritableRoot { root, read_only_subpaths }`. `writable_roots_for_cwd` intentionally strips `Tmpdir` and `/tmp` special entries before asking the generic policy for writable roots, then re-adds writable temp roots from Windows `TEMP`/`TMP` environment variables when the profile explicitly grants writable tmpdir access. That split is easy to miss but important: Windows temp handling is environment-driven rather than a fixed Unix-style path. The tests focus on workspace-root expansion, temp-root behavior, and token-mode selection failures.

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

**Purpose**: Determines which Windows restricted-token family is required to enforce a permission profile in the current runtime context. It distinguishes read-only capability mode from writable-root capability mode and rejects unenforceable full-disk writes.

**Data flow**: Takes a `PermissionProfile`, runtime workspace roots, current working directory, and environment map. It resolves the profile with `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`, checks `has_full_disk_write_access` on the resolved filesystem policy and bails if true, then inspects `writable_roots_for_cwd`; it returns `WindowsSandboxTokenMode::ReadOnlyCapability` when that list is empty and `WindowsSandboxTokenMode::WritableRootsCapability` otherwise.

**Call relations**: This function is used by callers that must choose token construction strategy before spawning or provisioning sandbox state. It delegates profile validation and workspace-root expansion to the resolver, then makes the final mode decision locally.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); called by 3 (token_mode_for_profile_with_writable_roots_uses_write_capabilities, token_mode_for_profile_without_writable_roots_uses_readonly_capability, token_mode_rejects_full_disk_write_entries); 1 external calls (bail!).


##### `ResolvedWindowsSandboxPermissions::try_from_permission_profile`  (lines 62–78)

```
fn try_from_permission_profile(permission_profile: &PermissionProfile) -> Result<Self>
```

**Purpose**: Validates that a permission profile is a managed, restricted filesystem profile and converts it into runtime filesystem and network policies. It is the base constructor for Windows-enforceable permissions.

**Data flow**: Takes `&PermissionProfile`, rejects non-`Managed` variants with `bail!`, calls `to_runtime_permissions` to obtain `(file_system, network)`, rejects any filesystem policy whose `kind` is not `FileSystemSandboxKind::Restricted`, and returns `ResolvedWindowsSandboxPermissions { file_system, network }` on success.

**Call relations**: This is the foundational resolver used directly in tests and indirectly by workspace-root-aware resolution. Higher-level setup and spawn code depends on it to reject unsupported profiles before any Windows-specific work begins.

*Call graph*: calls 1 internal fn (to_runtime_permissions); called by 3 (permission_profile_rejects_disabled_profiles, permission_profile_rejects_unrestricted_managed_filesystem, permission_profile_workspace_write_uses_windows_temp_env_vars); 2 external calls (bail!, matches!).


##### `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`  (lines 82–91)

```
fn try_from_permission_profile_for_workspace_roots(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Result<Self>
```

**Purpose**: Resolves a managed permission profile and expands symbolic workspace-root entries into concrete runtime paths. It binds protocol-level `project_roots` references to the actual workspace roots supplied by the caller.

**Data flow**: Takes a permission profile and a slice of `AbsolutePathBuf` workspace roots. It first constructs `Self` via `try_from_permission_profile`, then replaces `self.file_system` with the result of `materialize_project_roots_with_workspace_roots(workspace_roots)`, and returns the updated permissions object.

**Call relations**: This method is the main entry used by setup, spawn, and warning-generation code whenever runtime workspace roots matter. It builds on `try_from_permission_profile` and feeds all later cwd-based root computations.

*Call graph*: called by 19 (run_elevated_setup, spawn_world_writable_scan, world_writable_warning_details, run_elevated_setup, compute_allow_paths, run_windows_sandbox_capture_for_permission_profile, permission_profile_workspace_root_uses_runtime_workspace_roots, permission_profile_workspace_roots_expand_all_runtime_workspace_roots, token_mode_for_permission_profile, run_setup_refresh (+9 more)); 1 external calls (try_from_permission_profile).


##### `ResolvedWindowsSandboxPermissions::should_apply_network_block`  (lines 93–95)

```
fn should_apply_network_block(&self) -> bool
```

**Purpose**: Reports whether the sandbox should actively rewrite environment/network behavior to block outbound access. It is a simple inversion of the runtime network policy.

**Data flow**: Reads `self.network`, calls `is_enabled`, negates the result, and returns a `bool`.

**Call relations**: Spawn-preparation code uses this to decide whether to inject no-network environment settings. It does not delegate further beyond the policy query.

*Call graph*: calls 1 internal fn (is_enabled).


##### `ResolvedWindowsSandboxPermissions::network_policy`  (lines 97–99)

```
fn network_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Returns the resolved network policy stored in the permissions object. It exposes the policy value for setup decisions such as offline versus online sandbox identity.

**Data flow**: Reads `self.network` and returns it by value.

**Call relations**: Setup code calls this through `SandboxNetworkIdentity::from_permissions` when deciding whether firewall/proxy restrictions should be configured.

*Call graph*: called by 1 (from_permissions).


##### `ResolvedWindowsSandboxPermissions::is_enforceable_by_windows_sandbox`  (lines 101–103)

```
fn is_enforceable_by_windows_sandbox(&self) -> bool
```

**Purpose**: Checks whether the resolved filesystem policy is of the restricted kind that the Windows sandbox implementation knows how to enforce. It is a narrow capability gate.

**Data flow**: Reads `self.file_system.kind`, matches it against `FileSystemSandboxKind::Restricted`, and returns the resulting boolean.

**Call relations**: Setup code uses this as an early guard before attempting ACL or helper-based provisioning. It is a local predicate over already-resolved state.

*Call graph*: called by 1 (apply_capability_denies_for_world_writable_for_permissions); 1 external calls (matches!).


##### `ResolvedWindowsSandboxPermissions::has_full_disk_read_access`  (lines 105–107)

```
fn has_full_disk_read_access(&self) -> bool
```

**Purpose**: Exposes whether the resolved filesystem policy grants broad read access across the disk. This affects how setup computes read roots.

**Data flow**: Reads `self.file_system` and returns the result of `has_full_disk_read_access()`.

**Call relations**: Setup root-gathering code consults this to switch between restricted readable roots and the broader legacy full-read root set.

*Call graph*: calls 1 internal fn (has_full_disk_read_access); called by 1 (gather_read_roots).


##### `ResolvedWindowsSandboxPermissions::include_platform_defaults`  (lines 109–111)

```
fn include_platform_defaults(&self) -> bool
```

**Purpose**: Reports whether platform-default readable roots should be included alongside explicit readable roots. It preserves policy-level intent for setup payload construction.

**Data flow**: Reads `self.file_system` and returns `include_platform_defaults()`.

**Call relations**: Setup root gathering uses this when assembling the read-root payload for the elevated helper.

*Call graph*: calls 1 internal fn (include_platform_defaults); called by 1 (gather_read_roots).


##### `ResolvedWindowsSandboxPermissions::readable_roots_for_cwd`  (lines 113–119)

```
fn readable_roots_for_cwd(&self, cwd: &Path) -> Vec<PathBuf>
```

**Purpose**: Computes the concrete readable root paths for a specific current working directory. It converts the generic absolute-path wrapper type into ordinary `PathBuf`s for Windows setup code.

**Data flow**: Takes `cwd: &Path`, calls `self.file_system.get_readable_roots_with_cwd(cwd)`, converts each `AbsolutePathBuf` to `PathBuf` with `into_path_buf`, collects them into a vector, and returns it.

**Call relations**: Setup code calls this when building read-root ACL payloads for restricted-read profiles. It delegates cwd-sensitive resolution to the underlying filesystem policy.

*Call graph*: calls 1 internal fn (get_readable_roots_with_cwd); called by 1 (gather_read_roots).


##### `ResolvedWindowsSandboxPermissions::uses_write_capabilities_for_cwd`  (lines 121–127)

```
fn uses_write_capabilities_for_cwd(
        &self,
        cwd: &Path,
        env_map: &HashMap<String, String>,
    ) -> bool
```

**Purpose**: Answers whether the current runtime context requires writable-root capabilities rather than a single read-only capability. It is a convenience predicate over writable-root resolution.

**Data flow**: Takes `cwd` and `env_map`, calls `self.writable_roots_for_cwd(cwd, env_map)`, checks whether the returned vector is non-empty, and returns that boolean.

**Call relations**: Both setup and spawn preparation use this to choose token type, capability SID handling, and write-root filtering paths. It delegates the actual root computation to `writable_roots_for_cwd`.

*Call graph*: calls 1 internal fn (writable_roots_for_cwd); called by 3 (apply_capability_denies_for_world_writable_for_permissions, legacy_session_capability_roots, prepare_elevated_spawn_context_for_permissions).


##### `ResolvedWindowsSandboxPermissions::writable_roots_for_cwd`  (lines 129–170)

```
fn writable_roots_for_cwd(
        &self,
        cwd: &Path,
        env_map: &HashMap<String, String>,
    ) -> Vec<WindowsWritableRoot>
```

**Purpose**: Computes the concrete writable roots for a cwd and environment, including Windows temp-directory handling and read-only carveouts under writable roots. It is the main writable-filesystem resolution routine.

**Data flow**: Takes `cwd` and `env_map`, clones `self.file_system`, removes entries whose path is the special `Tmpdir` or `SlashTmp`, asks the cloned policy for `get_writable_roots_with_cwd(cwd)`, converts each returned root into `WindowsWritableRoot { root, read_only_subpaths }`, and then, if `has_writable_tmpdir_entry()` is true, extends the result with roots from `windows_temp_env_roots(env_map)` each paired with an empty `read_only_subpaths` list. It returns the assembled `Vec<WindowsWritableRoot>`.

**Call relations**: This method feeds token-mode selection, setup write-root gathering, allow/deny path computation, and capability-root derivation. It delegates generic cwd-based writable-root resolution to the protocol policy, but handles Windows temp semantics itself.

*Call graph*: calls 2 internal fn (has_writable_tmpdir_entry, windows_temp_env_roots); called by 4 (compute_allow_paths_for_permissions, uses_write_capabilities_for_cwd, gather_full_read_roots_for_permissions, gather_write_roots_for_permissions); 1 external calls (clone).


##### `ResolvedWindowsSandboxPermissions::has_writable_tmpdir_entry`  (lines 172–184)

```
fn has_writable_tmpdir_entry(&self) -> bool
```

**Purpose**: Detects whether the original filesystem policy explicitly grants write access to the special `Tmpdir` path. That flag controls whether Windows temp environment roots should be added later.

**Data flow**: Iterates over `self.file_system.entries`, matches entries whose `path` is `FileSystemPath::Special { Tmpdir }`, checks `access.can_write()`, and returns true if any such entry exists.

**Call relations**: It is only used inside `writable_roots_for_cwd` to decide whether to append `TEMP`/`TMP` roots after filtering out generic tmpdir entries.

*Call graph*: called by 1 (writable_roots_for_cwd).


##### `windows_temp_env_roots`  (lines 187–198)

```
fn windows_temp_env_roots(env_map: &HashMap<String, String>) -> Vec<PathBuf>
```

**Purpose**: Extracts absolute Windows temp directories from the runtime environment, preferring explicit values in the provided environment map and falling back to the host process environment. It supports writable tmpdir semantics on Windows.

**Data flow**: Takes `&HashMap<String, String>`, iterates over `TEMP` and `TMP`, for each key first checks `env_map.get(key)` and converts the string to `PathBuf`, otherwise falls back to `std::env::var_os(key)`, filters the resulting paths to only absolute ones, collects them, and returns `Vec<PathBuf>`.

**Call relations**: This helper is called only by `writable_roots_for_cwd` when the permission profile includes writable tmpdir access. It isolates the Windows-specific environment lookup logic from the generic permission resolver.

*Call graph*: called by 1 (writable_roots_for_cwd).


##### `tests::workspace_roots_for`  (lines 211–213)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds a one-element workspace-root vector from an absolute path for test setup. It reduces boilerplate in permission-resolution tests.

**Data flow**: Takes `root: &Path`, converts it to `AbsolutePathBuf` with `from_absolute_path`, wraps it in a `Vec`, and returns it.

**Call relations**: Multiple tests call this helper before invoking profile resolution or token-mode selection so they can supply runtime workspace roots in the expected type.

*Call graph*: 1 external calls (vec!).


##### `tests::permission_profile_workspace_write_uses_windows_temp_env_vars`  (lines 216–245)

```
fn permission_profile_workspace_write_uses_windows_temp_env_vars()
```

**Purpose**: Verifies that a writable tmpdir permission expands to the `TEMP`/`TMP` directories from the runtime environment rather than a Unix-style temp path. It also confirms the cwd workspace root remains writable.

**Data flow**: Creates temporary workspace and temp directories, populates `env_map` with `TEMP` and `TMP`, resolves `PermissionProfile::workspace_write()` via `try_from_permission_profile`, computes `writable_roots_for_cwd`, collects root paths into a set, and compares them against the expected canonical cwd and temp directory set.

**Call relations**: This test exercises `try_from_permission_profile` and `writable_roots_for_cwd` together to validate the Windows-specific temp-root branch.

*Call graph*: calls 2 internal fn (workspace_write, try_from_permission_profile); 5 external calls (new, new, assert_eq!, canonicalize, create_dir_all).


##### `tests::permission_profile_workspace_root_uses_runtime_workspace_roots`  (lines 248–284)

```
fn permission_profile_workspace_root_uses_runtime_workspace_roots()
```

**Purpose**: Checks that a symbolic `project_roots` writable entry resolves to the actual runtime workspace root supplied by the caller. It ensures cwd-relative execution does not collapse the root to the subdirectory cwd.

**Data flow**: Creates a workspace root and nested command cwd, constructs a managed restricted profile with a writable `project_roots` special path, resolves it with `try_from_permission_profile_for_workspace_roots`, computes `writable_roots_for_cwd`, extracts the root paths, and asserts they equal the canonical workspace root.

**Call relations**: This test targets the workspace-root materialization path and then validates the downstream writable-root computation.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 6 external calls (new, new, assert_eq!, create_dir_all, vec!, workspace_roots_for).


##### `tests::permission_profile_workspace_roots_expand_all_runtime_workspace_roots`  (lines 287–378)

```
fn permission_profile_workspace_roots_expand_all_runtime_workspace_roots()
```

**Purpose**: Verifies that symbolic workspace-root entries expand across every runtime workspace root, including deny subpaths and glob patterns. It checks the exact transformed `FileSystemSandboxPolicy`.

**Data flow**: Builds two absolute workspace roots and a managed restricted profile containing writable `project_roots`, denied `.git` under project roots, and a denied glob pattern. It resolves the profile with `try_from_permission_profile_for_workspace_roots` and asserts that the resulting `permissions.file_system` equals a fully expanded restricted policy containing concrete path and glob entries for both roots.

**Call relations**: This test directly validates the transformation performed by `try_from_permission_profile_for_workspace_roots`.

*Call graph*: calls 2 internal fn (from_absolute_path, try_from_permission_profile_for_workspace_roots); 3 external calls (new, assert_eq!, vec!).


##### `tests::token_mode_for_profile_without_writable_roots_uses_readonly_capability`  (lines 381–396)

```
fn token_mode_for_profile_without_writable_roots_uses_readonly_capability()
```

**Purpose**: Confirms that a read-only permission profile selects the read-only capability token mode. It covers the empty writable-root branch of token-mode selection.

**Data flow**: Creates a workspace cwd, derives workspace roots, calls `token_mode_for_permission_profile` with `PermissionProfile::read_only()`, and asserts the result is `WindowsSandboxTokenMode::ReadOnlyCapability`.

**Call relations**: This test exercises the top-level token-mode decision function in the no-write case.

*Call graph*: calls 2 internal fn (read_only, token_mode_for_permission_profile); 5 external calls (new, new, assert_eq!, create_dir_all, workspace_roots_for).


##### `tests::token_mode_for_profile_with_writable_roots_uses_write_capabilities`  (lines 399–414)

```
fn token_mode_for_profile_with_writable_roots_uses_write_capabilities()
```

**Purpose**: Confirms that a workspace-write profile selects writable-root capability mode. It covers the non-empty writable-root branch of token-mode selection.

**Data flow**: Creates a workspace cwd and workspace roots, calls `token_mode_for_permission_profile` with `PermissionProfile::workspace_write()`, and asserts the result is `WindowsSandboxTokenMode::WritableRootsCapability`.

**Call relations**: This test validates the positive writable-root path through `token_mode_for_permission_profile`.

*Call graph*: calls 2 internal fn (workspace_write, token_mode_for_permission_profile); 5 external calls (new, new, assert_eq!, create_dir_all, workspace_roots_for).


##### `tests::permission_profile_rejects_disabled_profiles`  (lines 417–427)

```
fn permission_profile_rejects_disabled_profiles()
```

**Purpose**: Ensures disabled profiles are rejected as unenforceable by the Windows sandbox resolver. It checks the managed-profile gate.

**Data flow**: Calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile` with `PermissionProfile::Disabled`, captures the error, and asserts the message contains the expected rejection text.

**Call relations**: This test targets the early validation branch in `try_from_permission_profile`.

*Call graph*: calls 1 internal fn (try_from_permission_profile); 1 external calls (assert!).


##### `tests::permission_profile_rejects_unrestricted_managed_filesystem`  (lines 430–444)

```
fn permission_profile_rejects_unrestricted_managed_filesystem()
```

**Purpose**: Ensures managed profiles with unrestricted filesystem access are rejected because the Windows sandbox only supports restricted filesystem enforcement. It checks the filesystem-kind gate.

**Data flow**: Constructs a managed profile with `ManagedFileSystemPermissions::Unrestricted`, calls `try_from_permission_profile`, captures the error, and asserts the message mentions restricted managed filesystem permissions.

**Call relations**: This test validates the second rejection branch in `try_from_permission_profile`.

*Call graph*: calls 1 internal fn (try_from_permission_profile); 1 external calls (assert!).


##### `tests::token_mode_rejects_full_disk_write_entries`  (lines 447–477)

```
fn token_mode_rejects_full_disk_write_entries()
```

**Purpose**: Verifies that token-mode selection fails when the profile requests full-disk write access. It protects against choosing a token mode for an unenforceable policy.

**Data flow**: Creates a workspace cwd and a managed restricted profile containing a writable `Root` special path, calls `token_mode_for_permission_profile`, captures the error, and asserts the message mentions full-disk writes being unenforceable.

**Call relations**: This test exercises the explicit full-disk-write rejection branch in `token_mode_for_permission_profile`.

*Call graph*: calls 1 internal fn (token_mode_for_permission_profile); 6 external calls (new, new, assert!, create_dir_all, vec!, workspace_roots_for).


### `windows-sandbox-rs/src/allow.rs`

`domain_logic` · `permission resolution and sandbox setup`

This file turns a `ResolvedWindowsSandboxPermissions` value into two concrete path sets: `allow` and `deny`. The exported `AllowDenyPaths` struct is just a pair of `HashSet<PathBuf>` collections, but the computation function encodes an important policy boundary: only existing paths are emitted, and writable roots may contain protected read-only subpaths that must be denied separately.

`compute_allow_paths_for_permissions` asks the resolved-permissions object for writable roots relative to the command working directory and environment. Each root path is canonicalized with `dunce::canonicalize` when possible, falling back to the original path if canonicalization fails; this preserves intended roots even when normalization is imperfect. The function then inserts the canonical writable root into the allow set and inserts each existing `read_only_subpath` into the deny set. Because both outputs are `HashSet`s, duplicates collapse naturally.

The tests document the intended policy in concrete scenarios: additional writable roots are included, the runtime workspace root is preferred over a nested command CWD, TEMP/TMP can be included or excluded depending on profile flags, Unix `/tmp` is ignored for Windows allow roots, and protected subpaths such as `.git`, `.codex`, and `.agents` are denied only when they actually exist. Missing protected directories are intentionally skipped rather than predeclared.

#### Function details

##### `compute_allow_paths_for_permissions`  (lines 14–42)

```
fn compute_allow_paths_for_permissions(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
) -> AllowDenyPaths
```

**Purpose**: Builds the final allow and deny path sets for a resolved Windows sandbox permission configuration.

**Data flow**: Accepts resolved permissions, the command CWD, and an environment map. It initializes empty `HashSet<PathBuf>` collections, iterates `permissions.writable_roots_for_cwd(command_cwd, env_map)`, canonicalizes each writable root path when possible, inserts existing writable roots into `allow`, inserts existing `read_only_subpaths` into `deny`, and returns an `AllowDenyPaths` containing both sets.

**Call relations**: Used by test helpers and several higher-level sandbox setup paths that need concrete filesystem roots before applying ACLs or building payloads.

*Call graph*: calls 1 internal fn (writable_roots_for_cwd); called by 5 (compute_allow_paths, build_payload_deny_write_paths, apply_legacy_session_acl_rules, legacy_session_capability_roots, prepare_elevated_spawn_context_for_permissions); 2 external calls (new, canonicalize).


##### `tests::workspace_write_profile`  (lines 53–64)

```
fn workspace_write_profile(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> PermissionProfile
```

**Purpose**: Constructs a workspace-write `PermissionProfile` with configurable temp-directory exclusions for tests.

**Data flow**: Takes writable roots plus two boolean exclusion flags and returns the result of `PermissionProfile::workspace_write_with(...)` using `NetworkSandboxPolicy::Restricted`.

**Call relations**: Serves as a fixture builder for the allow-path tests so each scenario can vary writable roots and temp handling succinctly.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `tests::workspace_roots_for`  (lines 66–68)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Wraps one absolute workspace root path into the vector shape expected by permission-resolution APIs.

**Data flow**: Accepts a `&Path`, converts it to `AbsolutePathBuf` with `from_absolute_path`, and returns a single-element `Vec`.

**Call relations**: Used by the test helper and individual tests to provide workspace roots to permission resolution.

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

**Purpose**: Resolves a `PermissionProfile` into Windows sandbox permissions and then computes allow/deny paths for tests.

**Data flow**: Accepts a permission profile, workspace roots, command CWD, and environment map. It calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`, expects success, then passes the resolved permissions into `compute_allow_paths_for_permissions` and returns the resulting `AllowDenyPaths`.

**Call relations**: Central test helper used by all scenario tests so they exercise the real permission-resolution path before allow/deny computation.

*Call graph*: calls 2 internal fn (compute_allow_paths_for_permissions, try_from_permission_profile_for_workspace_roots).


##### `tests::includes_additional_writable_roots`  (lines 86–119)

```
fn includes_additional_writable_roots()
```

**Purpose**: Verifies that explicitly configured extra writable roots are included alongside the workspace root.

**Data flow**: Creates temporary workspace and extra directories, builds a profile with the extra root, computes allow paths, and asserts both canonicalized directories are in `allow` while `deny` is empty.

**Call relations**: Exercises the main computation through the shared test helper with a profile containing additional writable roots.

*Call graph*: 8 external calls (new, new, assert!, create_dir_all, vec!, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::uses_runtime_workspace_roots_for_workspace_root`  (lines 122–153)

```
fn uses_runtime_workspace_roots_for_workspace_root()
```

**Purpose**: Checks that the computed allow set uses the declared workspace root rather than a nested command subdirectory.

**Data flow**: Creates a workspace root and nested command CWD, computes allow paths for a workspace-write profile, and asserts the canonical workspace root is allowed while the nested CWD itself is not separately present.

**Call relations**: Documents the policy that runtime workspace roots define the writable boundary even when the command starts deeper inside it.

*Call graph*: 7 external calls (new, new, assert!, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::excludes_tmp_env_vars_when_requested`  (lines 156–191)

```
fn excludes_tmp_env_vars_when_requested()
```

**Purpose**: Verifies that TEMP/TMP directories are omitted from the allow set when the profile requests exclusion.

**Data flow**: Creates workspace and temp directories, populates `env_map` with `TEMP` and `TMP`, computes allow paths under an exclusion-enabled profile, and asserts only the workspace root is allowed and no deny paths are produced.

**Call relations**: Covers the branch where resolved writable roots intentionally ignore temp environment variables.

*Call graph*: 7 external calls (new, new, assert!, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::includes_tmp_env_vars_when_requested`  (lines 194–227)

```
fn includes_tmp_env_vars_when_requested()
```

**Purpose**: Verifies that TEMP/TMP directories are included in the allow set when the profile permits them.

**Data flow**: Creates workspace and temp directories, sets `TEMP` and `TMP` in the environment map, computes allow paths, builds an expected two-element canonicalized allow set, and asserts exact equality with `paths.allow` while `deny` remains empty.

**Call relations**: Complements the exclusion test by proving the temp-root inclusion path contributes concrete writable roots.

*Call graph*: 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::ignores_unix_slash_tmp_for_windows_allow_roots`  (lines 230–254)

```
fn ignores_unix_slash_tmp_for_windows_allow_roots()
```

**Purpose**: Checks that Windows allow-root computation does not add Unix-style `/tmp` behavior implicitly.

**Data flow**: Creates a workspace directory, computes allow paths under a profile that does not exclude slash-tmp, and asserts the allow set contains only the canonical workspace root with no deny entries.

**Call relations**: Documents a Windows-specific normalization rule: slash-tmp is irrelevant here.

*Call graph*: 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::denies_git_dir_inside_writable_root`  (lines 257–285)

```
fn denies_git_dir_inside_writable_root()
```

**Purpose**: Verifies that an existing `.git` directory inside a writable root is emitted as a deny path.

**Data flow**: Creates a workspace and `.git` directory, computes allow paths, and asserts the workspace root is the sole allow entry while the canonical `.git` directory is the sole deny entry.

**Call relations**: Exercises the protected-subpath logic for a directory-form Git metadata location.

*Call graph*: 8 external calls (new, new, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::denies_git_file_inside_writable_root`  (lines 288–317)

```
fn denies_git_file_inside_writable_root()
```

**Purpose**: Verifies that an existing `.git` file inside a writable root is also emitted as a deny path.

**Data flow**: Creates a workspace, writes a `.git` file, computes allow paths, and asserts the workspace root is allowed while the canonical `.git` file path appears in `deny`.

**Call relations**: Covers the alternate Git-worktree style where `.git` is a file rather than a directory.

*Call graph*: 9 external calls (new, new, assert_eq!, canonicalize, create_dir_all, write, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::denies_codex_and_agents_inside_writable_root`  (lines 320–353)

```
fn denies_codex_and_agents_inside_writable_root()
```

**Purpose**: Verifies that existing `.codex` and `.agents` directories under a writable root are protected via deny entries.

**Data flow**: Creates a workspace plus `.codex` and `.agents` directories, computes allow paths, and asserts exact equality for one allow root and two deny paths.

**Call relations**: Documents additional protected subdirectories beyond Git metadata.

*Call graph*: 8 external calls (new, new, assert_eq!, canonicalize, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


##### `tests::skips_protected_subdirs_when_missing`  (lines 356–379)

```
fn skips_protected_subdirs_when_missing()
```

**Purpose**: Checks that protected subpaths are not added to the deny set unless they actually exist on disk.

**Data flow**: Creates only the workspace directory, computes allow paths, and asserts there is exactly one allow entry and an empty deny set.

**Call relations**: Confirms the computation is existence-sensitive rather than speculative.

*Call graph*: 8 external calls (new, new, assert!, assert_eq!, create_dir_all, compute_allow_paths, workspace_roots_for, workspace_write_profile).


### `core/src/windows_sandbox.rs`

`orchestration` · `config load and sandbox setup`

This file is the main Windows sandbox coordination layer. At configuration time, it resolves a `codex_protocol::config_types::WindowsSandboxLevel` from either explicit config (`permissions.windows_sandbox_mode`) or feature flags, with elevated mode taking precedence over restricted-token mode. It also translates legacy feature keys from TOML into the newer `WindowsSandboxModeToml` representation and exposes a defaulted `sandbox_private_desktop` flag.

At runtime, the file wraps platform-specific `codex_windows_sandbox` APIs behind `#[cfg(target_os = "windows")]` shims and non-Windows stubs that fail fast. Those wrappers cover setup completeness checks, elevated setup execution, provisioning setup, legacy preflight, refreshes with extra read roots, and extraction of structured elevated-setup failure details for metrics.

The central async path is `run_windows_sandbox_setup`. It timestamps the operation, derives an `originator` metric tag, delegates the actual work to `run_windows_sandbox_setup_and_persist`, and emits success or failure metrics with duration and mode tags. The inner function moves request data into a `spawn_blocking` closure because setup is synchronous and potentially expensive; elevated mode skips setup if `sandbox_setup_is_complete` already reports success, while unelevated mode always runs legacy preflight. After setup succeeds, it persists the selected mode into config via `ConfigEditsBuilder`, also clearing legacy sandbox keys so future loads use the canonical setting. Failure metrics distinguish elevated from unelevated flows and, on Windows, attach sanitized setup error code/message tags and choose a special metric name for user-canceled elevated launches.

#### Function details

##### `WindowsSandboxLevel::from_config`  (lines 31–37)

```
fn from_config(config: &Config) -> WindowsSandboxLevel
```

**Purpose**: Computes the effective sandbox level from the loaded runtime `Config`, preferring explicit sandbox mode settings over feature flags.

**Data flow**: Reads `config.permissions.windows_sandbox_mode`. It maps explicit `Elevated` to `WindowsSandboxLevel::Elevated`, explicit `Unelevated` to `RestrictedToken`, and when absent delegates to `Self::from_features(&config.features)`; it returns the chosen enum value without mutating state.

**Call relations**: This trait method is the core config-to-level conversion used by the public wrapper `windows_sandbox_level_from_config`. It falls through to feature-based resolution only when config does not explicitly specify a mode.

*Call graph*: 1 external calls (from_features).


##### `WindowsSandboxLevel::from_features`  (lines 39–48)

```
fn from_features(features: &Features) -> WindowsSandboxLevel
```

**Purpose**: Derives the sandbox level solely from feature flags, with elevated support taking precedence over legacy restricted-token support.

**Data flow**: Reads the provided `Features` via `enabled(Feature::WindowsSandboxElevated)` and `enabled(Feature::WindowsSandbox)`. It returns `Elevated` if the elevated feature is on, `RestrictedToken` if only the legacy sandbox feature is on, and `Disabled` otherwise.

**Call relations**: This method backs both `WindowsSandboxLevel::from_config` and the public helper `windows_sandbox_level_from_features`. Its precedence rule is validated by the companion test file.

*Call graph*: calls 1 internal fn (enabled).


##### `windows_sandbox_level_from_config`  (lines 51–53)

```
fn windows_sandbox_level_from_config(config: &Config) -> WindowsSandboxLevel
```

**Purpose**: Public convenience wrapper exposing `WindowsSandboxLevel::from_config` as a free function.

**Data flow**: Accepts `&Config`, delegates directly to `WindowsSandboxLevel::from_config`, and returns the resulting level. It performs no additional transformation or side effects.

**Call relations**: This wrapper exists for callers that prefer free functions over trait syntax. It simply forwards into the trait implementation.

*Call graph*: 1 external calls (from_config).


##### `windows_sandbox_level_from_features`  (lines 55–57)

```
fn windows_sandbox_level_from_features(features: &Features) -> WindowsSandboxLevel
```

**Purpose**: Public convenience wrapper exposing feature-only sandbox-level resolution.

**Data flow**: Accepts `&Features`, delegates to `WindowsSandboxLevel::from_features`, and returns the chosen level. No state is modified.

**Call relations**: It is the free-function counterpart to the trait method and is used where only feature flags are available.

*Call graph*: 1 external calls (from_features).


##### `resolve_windows_sandbox_mode`  (lines 59–64)

```
fn resolve_windows_sandbox_mode(cfg: &ConfigToml) -> Option<WindowsSandboxModeToml>
```

**Purpose**: Resolves the persisted/configured Windows sandbox mode from `ConfigToml`, including fallback from legacy feature keys.

**Data flow**: Reads `cfg.windows.as_ref().and_then(|windows| windows.sandbox)` first. If that is `None`, it calls `legacy_windows_sandbox_mode(cfg.features.as_ref())`; it returns an `Option<WindowsSandboxModeToml>`.

**Call relations**: It is called during `load_config_with_layer_stack` so config loading can normalize both new and legacy representations into one sandbox-mode value.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `resolve_windows_sandbox_private_desktop`  (lines 66–71)

```
fn resolve_windows_sandbox_private_desktop(cfg: &ConfigToml) -> bool
```

**Purpose**: Extracts the Windows private-desktop setting from config, defaulting to enabled when unspecified.

**Data flow**: Reads `cfg.windows.sandbox_private_desktop` through optional chaining and returns the contained boolean, or `true` if the field or section is absent.

**Call relations**: This is also used by `load_config_with_layer_stack` during config assembly so downstream code sees a concrete boolean instead of nested options.

*Call graph*: called by 1 (load_config_with_layer_stack).


##### `legacy_windows_sandbox_mode`  (lines 73–78)

```
fn legacy_windows_sandbox_mode(
    features: Option<&FeaturesToml>,
) -> Option<WindowsSandboxModeToml>
```

**Purpose**: Converts legacy feature TOML into a sandbox mode by first materializing its boolean entry map.

**Data flow**: Accepts `Option<&FeaturesToml>`, calls `FeaturesToml::entries` when present, and passes the resulting `BTreeMap<String, bool>` to `legacy_windows_sandbox_mode_from_entries`. It returns `None` if no features section exists.

**Call relations**: This helper is used by `resolve_windows_sandbox_mode` as the fallback path when the newer `windows.sandbox` config key is absent.

*Call graph*: calls 1 internal fn (legacy_windows_sandbox_mode_from_entries).


##### `legacy_windows_sandbox_mode_from_entries`  (lines 80–103)

```
fn legacy_windows_sandbox_mode_from_entries(
    entries: &BTreeMap<String, bool>,
) -> Option<WindowsSandboxModeToml>
```

**Purpose**: Implements the exact precedence rules for old feature keys that implied Windows sandbox behavior.

**Data flow**: Reads booleans from the provided `BTreeMap<String, bool>` using `Feature::WindowsSandboxElevated.key()`, `Feature::WindowsSandbox.key()`, and the alias string `enable_experimental_windows_sandbox`. It returns `Some(Elevated)` if the elevated key is true; otherwise `Some(Unelevated)` if either legacy unelevated key is true; otherwise `None`.

**Call relations**: This is the leaf logic behind `legacy_windows_sandbox_mode`. Tests exercise its precedence and alias handling directly.

*Call graph*: called by 1 (legacy_windows_sandbox_mode).


##### `sandbox_setup_is_complete`  (lines 111–113)

```
fn sandbox_setup_is_complete(_codex_home: &Path) -> bool
```

**Purpose**: Reports whether elevated sandbox setup has already been completed for a given Codex home directory.

**Data flow**: On Windows it forwards `codex_home` to `codex_windows_sandbox::sandbox_setup_is_complete` and returns that boolean. On non-Windows builds the alternate definition ignores the path and always returns `false`.

**Call relations**: The Windows implementation is consulted inside `run_windows_sandbox_setup_and_persist` to skip redundant elevated setup work. The non-Windows stub ensures callers compile everywhere but cannot accidentally report completion.

*Call graph*: 1 external calls (sandbox_setup_is_complete).


##### `elevated_setup_failure_details`  (lines 124–126)

```
fn elevated_setup_failure_details(_err: &anyhow::Error) -> Option<(String, String)>
```

**Purpose**: Extracts a sanitized error code and message from an elevated setup failure for metric tagging.

**Data flow**: On Windows it inspects an `anyhow::Error` with `codex_windows_sandbox::extract_setup_failure`, returns `None` if no structured failure is embedded, otherwise converts the failure code to `String`, sanitizes the message with `sanitize_setup_metric_tag_value`, and returns `Some((code, message))`. The non-Windows variant always returns `None`.

**Call relations**: It is called only from `emit_windows_sandbox_setup_failure_metrics` when elevated setup fails, allowing metrics to include structured failure dimensions without leaking unsanitized text.

*Call graph*: called by 1 (emit_windows_sandbox_setup_failure_metrics); 2 external calls (extract_setup_failure, sanitize_setup_metric_tag_value).


##### `elevated_setup_failure_metric_name`  (lines 143–145)

```
fn elevated_setup_failure_metric_name(_err: &anyhow::Error) -> &'static str
```

**Purpose**: Chooses the elevated-setup failure metric name, distinguishing user-canceled helper launches from generic failures.

**Data flow**: On Windows it examines the structured setup failure extracted from the `anyhow::Error`; if the code is `OrchestratorHelperLaunchCanceled` it returns `"codex.windows_sandbox.elevated_setup_canceled"`, otherwise `"codex.windows_sandbox.elevated_setup_failure"`. The non-Windows variant panics because this classification is only meaningful on Windows.

**Call relations**: This is used by `emit_windows_sandbox_setup_failure_metrics` in the elevated-failure branch so cancellation is counted separately from other setup failures.

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

**Purpose**: Performs the elevated Windows sandbox setup by first resolving permissions from the permission profile and workspace roots, then invoking the platform sandbox setup API.

**Data flow**: On Windows it takes a `PermissionProfile`, workspace roots, command cwd, environment map, and Codex home path; converts the profile into `ResolvedWindowsSandboxPermissions` with `try_from_permission_profile_for_workspace_roots`; builds a `SandboxSetupRequest` referencing those inputs with `proxy_enforced: false`; and passes it plus default root overrides to `codex_windows_sandbox::run_elevated_setup`. On non-Windows it immediately returns an error via `anyhow::bail!`.

**Call relations**: It is invoked from the elevated branch of `run_windows_sandbox_setup_and_persist` after the completeness check. The separate `run_elevated` flow elsewhere also uses related provisioning setup APIs.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 3 external calls (bail!, run_elevated_setup, default).


##### `run_elevated_provisioning_setup`  (lines 189–191)

```
fn run_elevated_provisioning_setup(_codex_home: &Path, _real_user: &str) -> anyhow::Result<()>
```

**Purpose**: Runs the elevated provisioning-only setup path for Windows sandbox support.

**Data flow**: On Windows it forwards `codex_home` and `real_user` to `codex_windows_sandbox::run_elevated_provisioning_setup` and returns that result. On non-Windows it returns a descriptive error.

**Call relations**: This function is called by `run_elevated`, not by the main setup orchestrator in this file. It exists as a narrower provisioning helper for a different elevated flow.

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

**Purpose**: Executes the legacy unelevated sandbox preflight/setup validation path.

**Data flow**: On Windows it forwards the permission profile, workspace roots, Codex home, command cwd, and environment map to `codex_windows_sandbox::run_windows_sandbox_legacy_preflight`. On non-Windows it returns an error indicating the operation is unsupported.

**Call relations**: It is called from the `Unelevated` branch of `run_windows_sandbox_setup_and_persist`, where legacy setup is always run rather than conditionally skipped.

*Call graph*: 2 external calls (bail!, run_windows_sandbox_legacy_preflight).


##### `run_setup_refresh_with_extra_read_roots`  (lines 242–251)

```
fn run_setup_refresh_with_extra_read_roots(
    _permission_profile: &PermissionProfile,
    _workspace_roots: &[AbsolutePathBuf],
    _command_cwd: &Path,
    _env_map: &HashMap<String, String>,
```

**Purpose**: Refreshes sandbox setup to include additional read-only roots in the unelevated flow.

**Data flow**: On Windows it forwards the permission profile, workspace roots, cwd, env map, Codex home, and `extra_read_roots` vector to `codex_windows_sandbox::run_setup_refresh_with_extra_read_roots` with `proxy_enforced` fixed to `false`. On non-Windows it returns an unsupported-operation error.

**Call relations**: This function is called by `grant_read_root_non_elevated` in `windows_sandbox_read_grants.rs` after that helper validates and canonicalizes the requested directory.

*Call graph*: called by 1 (grant_read_root_non_elevated); 2 external calls (bail!, run_setup_refresh_with_extra_read_roots).


##### `run_windows_sandbox_setup`  (lines 269–294)

```
async fn run_windows_sandbox_setup(request: WindowsSandboxSetupRequest) -> anyhow::Result<()>
```

**Purpose**: Top-level async orchestrator for Windows sandbox setup that measures duration, tags the request originator, and emits success or failure metrics around the actual setup work.

**Data flow**: Consumes a `WindowsSandboxSetupRequest`, records `Instant::now()`, extracts `mode`, computes a sanitized `originator_tag` from `originator().value`, and awaits `run_windows_sandbox_setup_and_persist(request)`. On success it emits success metrics with mode/originator/duration and returns `Ok(())`; on error it emits failure metrics with the same context plus the error and then returns the original error.

**Call relations**: It is called by `windows_sandbox_setup_start_inner`. It delegates the actual setup and config persistence to `run_windows_sandbox_setup_and_persist`, and delegates telemetry emission to the two metric helper functions.

*Call graph*: calls 4 internal fn (emit_windows_sandbox_setup_failure_metrics, emit_windows_sandbox_setup_success_metrics, run_windows_sandbox_setup_and_persist, originator); called by 1 (windows_sandbox_setup_start_inner); 2 external calls (now, sanitize_metric_tag_value).


##### `run_windows_sandbox_setup_and_persist`  (lines 296–343)

```
async fn run_windows_sandbox_setup_and_persist(
    request: WindowsSandboxSetupRequest,
) -> anyhow::Result<()>
```

**Purpose**: Runs the blocking setup operation for the requested sandbox mode and, if successful, persists the chosen mode into config while clearing legacy keys.

**Data flow**: Consumes `WindowsSandboxSetupRequest`, destructures and moves its fields, clones `codex_home` for use inside a blocking task, and runs mode-specific setup inside `tokio::task::spawn_blocking`. The closure checks `sandbox_setup_is_complete` before calling `run_elevated_setup` for elevated mode, or directly calls `run_legacy_setup_preflight` for unelevated mode. After awaiting and unwrapping the blocking result, it builds `ConfigEditsBuilder::new(codex_home.as_path())`, sets the persisted sandbox mode string from `windows_sandbox_setup_mode_tag(mode)`, clears legacy sandbox keys, applies the edits asynchronously, and returns `Ok(())` or a wrapped persistence error.

**Call relations**: This is the workhorse called only by `run_windows_sandbox_setup`. It delegates setup to the platform wrappers and persistence to `ConfigEditsBuilder`, while `windows_sandbox_setup_mode_tag` supplies the canonical persisted string.

*Call graph*: calls 2 internal fn (new, windows_sandbox_setup_mode_tag); called by 1 (run_windows_sandbox_setup); 1 external calls (spawn_blocking).


##### `emit_windows_sandbox_setup_success_metrics`  (lines 345–368)

```
fn emit_windows_sandbox_setup_success_metrics(
    mode: WindowsSandboxSetupMode,
    originator_tag: &str,
    duration: std::time::Duration,
)
```

**Purpose**: Records duration and success counters for a completed sandbox setup operation.

**Data flow**: Accepts setup `mode`, sanitized `originator_tag`, and elapsed `Duration`. It fetches the global metrics recorder with `codex_otel::global()`, returns early if metrics are unavailable, derives the mode tag string via `windows_sandbox_setup_mode_tag`, then records a duration metric tagged with `result=success`, `originator`, and `mode`, plus increments a success counter tagged by originator and mode.

**Call relations**: It is called from `run_windows_sandbox_setup` only on the success path, after the inner setup-and-persist function returns `Ok(())`.

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

**Purpose**: Records duration and failure counters for sandbox setup errors, with extra classification for elevated failures.

**Data flow**: Takes setup `mode`, `originator_tag`, elapsed `Duration`, and the setup error. It obtains the global metrics recorder and returns early if absent, computes the mode tag, records a failure duration metric and a generic setup-failure counter, then branches by mode. For elevated mode on Windows it builds a mutable tag vector starting with originator, optionally appends sanitized `code` and `message` from `elevated_setup_failure_details`, and increments the metric named by `elevated_setup_failure_metric_name`. For unelevated mode it increments `codex.windows_sandbox.legacy_setup_preflight_failed` with the originator tag.

**Call relations**: This is called from `run_windows_sandbox_setup` only when `run_windows_sandbox_setup_and_persist` returns an error. It delegates elevated error parsing and metric-name selection to the dedicated helpers.

*Call graph*: calls 3 internal fn (elevated_setup_failure_details, elevated_setup_failure_metric_name, windows_sandbox_setup_mode_tag); called by 1 (run_windows_sandbox_setup); 3 external calls (global, matches!, vec!).


##### `windows_sandbox_setup_mode_tag`  (lines 426–431)

```
fn windows_sandbox_setup_mode_tag(mode: WindowsSandboxSetupMode) -> &'static str
```

**Purpose**: Maps the internal setup-mode enum to the canonical metric/config tag string.

**Data flow**: Accepts `WindowsSandboxSetupMode` and returns the static string `"elevated"` or `"unelevated"` depending on the variant. It has no side effects.

**Call relations**: This helper is shared by setup persistence and both metric emitters so all external representations of the mode use the same spelling.

*Call graph*: called by 3 (emit_windows_sandbox_setup_failure_metrics, emit_windows_sandbox_setup_success_metrics, run_windows_sandbox_setup_and_persist).


### Config editing and migration utilities
These files provide targeted editors and migration helpers that import or persist user-managed configuration sections and related assets.

### `config/src/marketplace_edit.rs`

`domain_logic` · `user config editing`

This module performs in-place user-config editing for marketplace metadata. The input payload is `MarketplaceConfigUpdate`, which carries timestamps, source information, optional revision/ref fields, and sparse checkout paths. Removal uses the `RemoveMarketplaceConfigOutcome` enum to distinguish a successful deletion, a missing entry, and a name that exists only with different ASCII case.

`record_user_marketplace` is the write path: it opens or creates `${codex_home}/config.toml` as a `toml_edit::DocumentMut`, calls `upsert_marketplace`, ensures the home directory exists, and writes the modified document back. `upsert_marketplace` guarantees that the root contains a `marketplaces` table, replacing non-table junk if necessary, then writes a non-implicit table for the named marketplace with only the fields present in the update. `sparse_paths` is serialized as an array only when non-empty.

Removal is split into a boolean convenience wrapper and a richer outcome API. `remove_user_marketplace_config` reads and parses the document, returns `NotFound` if the file is absent, delegates deletion to `remove_marketplace`, and only rewrites the file when an entry was actually removed. `remove_marketplace` supports both standard tables and inline tables under `marketplaces`; if the last entry is removed, it deletes the entire `marketplaces` key. `case_mismatched_key` performs an ASCII-case-insensitive scan so callers can tell users that `Debug` did not match configured `debug` exactly.

#### Function details

##### `record_user_marketplace`  (lines 29–39)

```
fn record_user_marketplace(
    codex_home: &Path,
    marketplace_name: &str,
    update: &MarketplaceConfigUpdate<'_>,
) -> std::io::Result<()>
```

**Purpose**: Adds or updates one marketplace entry in the user's config file. It preserves existing TOML formatting as much as `toml_edit` allows by editing a parsed document rather than rebuilding the file from scratch.

**Data flow**: Inputs are `codex_home`, `marketplace_name`, and a `MarketplaceConfigUpdate`. It computes `config_path = codex_home.join(CONFIG_TOML_FILE)`, loads or creates a `DocumentMut` with `read_or_create_document`, mutates it via `upsert_marketplace`, ensures `codex_home` exists with `fs::create_dir_all`, and writes `doc.to_string()` back to disk.

**Call relations**: This function is used by marketplace-related tests and likely by higher-level marketplace management commands. It delegates document loading to `read_or_create_document` and the actual table mutation to `upsert_marketplace`.

*Call graph*: calls 2 internal fn (read_or_create_document, upsert_marketplace); called by 2 (remove_user_marketplace_config_reports_case_mismatch, remove_user_marketplace_removes_requested_entry); 3 external calls (join, create_dir_all, write).


##### `remove_user_marketplace`  (lines 41–44)

```
fn remove_user_marketplace(codex_home: &Path, marketplace_name: &str) -> std::io::Result<bool>
```

**Purpose**: Provides a simple boolean API for marketplace removal. It hides the richer mismatch/not-found distinction and reports only whether an entry was actually deleted.

**Data flow**: Inputs are `codex_home` and `marketplace_name`. It calls `remove_user_marketplace_config`, compares the returned outcome to `RemoveMarketplaceConfigOutcome::Removed`, and returns `Ok(true)` only for that case.

**Call relations**: This wrapper is called by tests and likely by callers that only need success/failure semantics. It delegates all real work to `remove_user_marketplace_config`.

*Call graph*: calls 1 internal fn (remove_user_marketplace_config); called by 2 (remove_user_marketplace_removes_requested_entry, remove_user_marketplace_returns_false_when_missing).


##### `remove_user_marketplace_config`  (lines 46–69)

```
fn remove_user_marketplace_config(
    codex_home: &Path,
    marketplace_name: &str,
) -> std::io::Result<RemoveMarketplaceConfigOutcome>
```

**Purpose**: Removes one marketplace entry from the user's config file and reports whether it was removed, missing, or present only with different case. It rewrites the file only on actual deletion.

**Data flow**: Inputs are `codex_home` and `marketplace_name`. It reads `${codex_home}/config.toml`; if missing, returns `NotFound`; if present, parses it into `DocumentMut` or returns `InvalidData` on parse failure. It then calls `remove_marketplace`; if the outcome is not `Removed`, it returns that outcome unchanged. On `Removed`, it ensures the directory exists, writes the updated document back, and returns `Removed`.

**Call relations**: This function underlies both the boolean wrapper `remove_user_marketplace` and tests that inspect detailed outcomes. It delegates the in-memory deletion logic to `remove_marketplace`.

*Call graph*: calls 1 internal fn (remove_marketplace); called by 3 (remove_user_marketplace, remove_user_marketplace_config_removes_inline_table_entry, remove_user_marketplace_config_reports_case_mismatch); 4 external calls (join, create_dir_all, read_to_string, write).


##### `read_or_create_document`  (lines 71–79)

```
fn read_or_create_document(config_path: &Path) -> std::io::Result<DocumentMut>
```

**Purpose**: Loads an editable TOML document from disk or creates an empty one when the config file does not exist. It standardizes parse error handling for config edits.

**Data flow**: Input is `config_path: &Path`. It reads the file as string; on success it parses `DocumentMut` and maps parse errors to `InvalidData`; on `NotFound` it returns `DocumentMut::new()`; other I/O errors are returned unchanged.

**Call relations**: This helper is called by `record_user_marketplace` before mutation. It isolates the common 'open existing or start empty' behavior.

*Call graph*: called by 1 (record_user_marketplace); 2 external calls (new, read_to_string).


##### `upsert_marketplace`  (lines 81–118)

```
fn upsert_marketplace(
    doc: &mut DocumentMut,
    marketplace_name: &str,
    update: &MarketplaceConfigUpdate<'_>,
)
```

**Purpose**: Creates or replaces a named marketplace entry under the root `marketplaces` table. It also repairs malformed existing `marketplaces` content by replacing non-table values with a table.

**Data flow**: Inputs are a mutable `DocumentMut`, the marketplace name, and the update payload. It gets the root table, inserts an implicit `marketplaces` table if absent, replaces a non-table `marketplaces` item with a fresh implicit table if necessary, then builds a non-implicit `TomlTable` entry containing `last_updated`, optional `last_revision`, `source_type`, `source`, optional `ref`, and optional `sparse_paths` array, and inserts that entry under the marketplace name.

**Call relations**: This function is called only by `record_user_marketplace`. It uses `new_implicit_table` to create the container table and writes concrete field values directly into the `toml_edit` structure.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 1 (record_user_marketplace); 6 external calls (as_table_mut, Table, Value, new, Array, value).


##### `remove_marketplace`  (lines 120–167)

```
fn remove_marketplace(
    doc: &mut DocumentMut,
    marketplace_name: &str,
) -> RemoveMarketplaceConfigOutcome
```

**Purpose**: Deletes a marketplace entry from an in-memory TOML document, supporting both standard and inline `marketplaces` tables. It also removes the entire `marketplaces` key when the last entry is deleted.

**Data flow**: Inputs are a mutable `DocumentMut` and the requested marketplace name. It looks up `marketplaces` in the root table; if absent, returns `NotFound`. For `TomlItem::Table` and inline-table `TomlItem::Value`, it tries exact-key removal first, otherwise checks for ASCII case-insensitive mismatches via `case_mismatched_key`, tracks whether the container became empty, and returns the corresponding `RemoveMarketplaceConfigOutcome`. If a removal succeeded and the container is now empty, it removes the root `marketplaces` key.

**Call relations**: This helper is called by `remove_user_marketplace_config` after parsing the document. It delegates mismatch detection to `case_mismatched_key`.

*Call graph*: calls 1 internal fn (case_mismatched_key); called by 1 (remove_user_marketplace_config); 1 external calls (as_table_mut).


##### `case_mismatched_key`  (lines 169–175)

```
fn case_mismatched_key(
    mut keys: impl Iterator<Item = &'a str>,
    requested_name: &str,
) -> Option<String>
```

**Purpose**: Finds an existing key that differs from the requested name only by ASCII case. It supports friendlier removal diagnostics.

**Data flow**: Inputs are an iterator of existing key strings and the requested name. It scans with `find`, selecting the first key where `key != requested_name` but `key.eq_ignore_ascii_case(requested_name)`, then returns that key as an owned `String`.

**Call relations**: This helper is used by `remove_marketplace` for both normal and inline table representations when exact removal fails.

*Call graph*: called by 1 (remove_marketplace); 1 external calls (find).


##### `new_implicit_table`  (lines 177–181)

```
fn new_implicit_table() -> TomlTable
```

**Purpose**: Creates a `toml_edit::Table` marked implicit. It is used for container tables that should not necessarily render with an explicit header immediately.

**Data flow**: It constructs `TomlTable::new()`, calls `set_implicit(true)`, and returns the table.

**Call relations**: This helper is called by `upsert_marketplace` when creating or repairing the root `marketplaces` table.

*Call graph*: called by 1 (upsert_marketplace); 1 external calls (new).


##### `tests::remove_user_marketplace_removes_requested_entry`  (lines 190–215)

```
fn remove_user_marketplace_removes_requested_entry()
```

**Purpose**: Verifies that removing one marketplace deletes only that entry and leaves other marketplace entries intact. It exercises the full write-then-remove flow against a real temp config file.

**Data flow**: The test creates a temp home, builds a `MarketplaceConfigUpdate`, records two marketplaces, calls `remove_user_marketplace` for one of them, asserts the boolean result is true, reloads the config as `toml::Value`, and checks that only the other marketplace remains.

**Call relations**: This test drives both `record_user_marketplace` and `remove_user_marketplace`, indirectly exercising `upsert_marketplace`, `remove_user_marketplace_config`, and `remove_marketplace`.

*Call graph*: calls 2 internal fn (record_user_marketplace, remove_user_marketplace); 5 external calls (new, assert!, assert_eq!, read_to_string, from_str).


##### `tests::remove_user_marketplace_returns_false_when_missing`  (lines 218–224)

```
fn remove_user_marketplace_returns_false_when_missing()
```

**Purpose**: Checks that the boolean removal API returns `false` when no config file or matching marketplace exists. It covers the missing-entry path without inspecting richer outcomes.

**Data flow**: The test creates an empty temp home, calls `remove_user_marketplace`, and asserts the returned boolean is false.

**Call relations**: This test exercises the `NotFound` path through `remove_user_marketplace` and `remove_user_marketplace_config`.

*Call graph*: calls 1 internal fn (remove_user_marketplace); 2 external calls (new, assert!).


##### `tests::remove_user_marketplace_config_reports_case_mismatch`  (lines 227–247)

```
fn remove_user_marketplace_config_reports_case_mismatch()
```

**Purpose**: Verifies that the detailed removal API reports a case mismatch instead of plain not-found when the configured marketplace name differs only by ASCII case. This supports better caller messaging.

**Data flow**: The test creates a temp home, records a marketplace named `debug`, calls `remove_user_marketplace_config` with `Debug`, and asserts that the outcome is `NameCaseMismatch { configured_name: "debug" }`.

**Call relations**: This test specifically exercises the `case_mismatched_key` branch inside `remove_marketplace`.

*Call graph*: calls 2 internal fn (record_user_marketplace, remove_user_marketplace_config); 2 external calls (new, assert_eq!).


##### `tests::remove_user_marketplace_config_removes_inline_table_entry`  (lines 250–275)

```
fn remove_user_marketplace_config_removes_inline_table_entry()
```

**Purpose**: Ensures removal works when `marketplaces` is represented as an inline table rather than a standard table. It covers the alternate TOML shape handled by `remove_marketplace`.

**Data flow**: The test writes a raw config file containing an inline `marketplaces = { ... }` table with two entries, calls `remove_user_marketplace_config("debug")`, asserts `Removed`, reloads the file as `toml::Value`, and checks that only `other` remains.

**Call relations**: This test targets the `TomlItem::Value`/inline-table branch of `remove_marketplace`.

*Call graph*: calls 1 internal fn (remove_user_marketplace_config); 6 external calls (new, assert!, assert_eq!, read_to_string, write, from_str).


### `config/src/mcp_edit.rs`

`domain_logic` · `user config editing`

This module is the config-editing surface for globally configured MCP servers. Reading is handled by `load_global_mcp_servers`, which asynchronously reads `${codex_home}/config.toml`, parses it as `toml::Value`, extracts the `mcp_servers` subtree, rejects any server table containing an inline `bearer_token`, and then deserializes the subtree into `BTreeMap<String, McpServerConfig>`. Missing files or missing `mcp_servers` simply yield an empty map.

Writing is organized around `ConfigEditsBuilder`, a small builder that currently carries `codex_home` and an optional replacement server map. `apply` offloads synchronous file editing to `spawn_blocking`; `apply_blocking` opens or creates a `toml_edit::DocumentMut`, applies requested edits, ensures the config directory exists, and writes the updated document.

Serialization is explicit and selective. `replace_mcp_servers` either removes the entire `mcp_servers` key when the map is empty or rebuilds it as an implicit table whose entries come from `serialize_mcp_server`. That serializer handles both `McpServerTransportConfig::Stdio` and `StreamableHttp`, emitting only meaningful fields: arrays are omitted when empty, optional maps become TOML tables sorted by key, durations are written as floating-point seconds, non-local `environment_id` is preserved, OAuth is emitted only when `client_id` is present and non-empty, and per-tool approval overrides are sorted by tool name for stable output. Helper functions build arrays of strings, arrays of `McpServerEnvVar` values, and sorted key/value tables.

#### Function details

##### `load_global_mcp_servers`  (lines 20–41)

```
async fn load_global_mcp_servers(
    codex_home: &Path,
) -> std::io::Result<BTreeMap<String, McpServerConfig>>
```

**Purpose**: Reads the user's global MCP server definitions from `config.toml` and deserializes them into typed configs. It treats missing config as an empty server set and rejects insecure inline bearer tokens before deserialization.

**Data flow**: Input is `codex_home: &Path`. It computes `config_path`, asynchronously reads the file text, returns `Ok(BTreeMap::new())` on `NotFound`, parses the file into `TomlValue`, extracts `parsed.get("mcp_servers")`, returns an empty map if absent, calls `ensure_no_inline_bearer_tokens` on that subtree, clones it, and `try_into()` converts it into `BTreeMap<String, McpServerConfig>`, mapping conversion failures to `InvalidData`.

**Call relations**: This function is used by MCP-related commands and tests after config edits have been written. It delegates the bearer-token policy check to `ensure_no_inline_bearer_tokens`.

*Call graph*: calls 1 internal fn (ensure_no_inline_bearer_tokens); 3 external calls (new, join, read_to_string).


##### `ensure_no_inline_bearer_tokens`  (lines 43–60)

```
fn ensure_no_inline_bearer_tokens(value: &TomlValue) -> std::io::Result<()>
```

**Purpose**: Rejects `mcp_servers` entries that still use the deprecated/unsupported inline `bearer_token` field. It enforces the safer `bearer_token_env_var` configuration style.

**Data flow**: Input is a `&TomlValue` expected to represent the `mcp_servers` table. If the value is not a table it returns `Ok(())`. Otherwise it iterates each server entry; when a server value is a table containing `bearer_token`, it returns `Err(io::Error::new(InvalidData, message))` naming the offending server. If no such field is found it returns `Ok(())`.

**Call relations**: This validator is called by `load_global_mcp_servers` before typed deserialization so unsupported secrets are rejected with a clear message.

*Call graph*: called by 1 (load_global_mcp_servers); 3 external calls (as_table, new, format!).


##### `ConfigEditsBuilder::new`  (lines 68–73)

```
fn new(codex_home: &Path) -> Self
```

**Purpose**: Creates a new MCP config edit builder rooted at a specific Codex home directory. The builder starts with no pending edits.

**Data flow**: Input is `codex_home: &Path`. It clones the path into a `PathBuf`, sets `mcp_servers: None`, and returns `ConfigEditsBuilder`.

**Call relations**: This constructor is used by many higher-level commands and tests before chaining edit methods like `replace_mcp_servers` and `apply`.

*Call graph*: called by 43 (skills_config_write_response_inner, disable_feature_in_config, enable_feature_in_config, run_add, run_remove, run_elevated, get_disabled_server_shows_single_line, list_and_get_render_expected_output, replace_mcp_servers_serializes_oauth_client_id, replace_mcp_servers_serializes_per_tool_approval_overrides (+15 more)); 1 external calls (to_path_buf).


##### `ConfigEditsBuilder::replace_mcp_servers`  (lines 75–78)

```
fn replace_mcp_servers(mut self, servers: &BTreeMap<String, McpServerConfig>) -> Self
```

**Purpose**: Stages a complete replacement of the `mcp_servers` section in the builder. It copies the provided map so the builder owns the pending edit.

**Data flow**: It takes ownership of `self` and a reference to `BTreeMap<String, McpServerConfig>`, clones the map into `self.mcp_servers`, and returns the updated builder.

**Call relations**: This method is typically chained after `ConfigEditsBuilder::new` and before `apply`. The actual file mutation happens later in `apply_blocking`.


##### `ConfigEditsBuilder::apply`  (lines 80–86)

```
async fn apply(self) -> std::io::Result<()>
```

**Purpose**: Executes the staged config edits asynchronously by moving the blocking file-edit work onto a dedicated thread. It converts task panics into ordinary I/O errors.

**Data flow**: It takes ownership of the builder, runs `self.apply_blocking()` inside `tokio::task::spawn_blocking`, awaits the join handle, maps join failures to `std::io::Error::other("config persistence task panicked: ...")`, and otherwise returns the inner `std::io::Result<()>`.

**Call relations**: This async method is called by command handlers and tests after staging edits. It delegates all actual document mutation and disk writes to `apply_blocking`.

*Call graph*: 1 external calls (spawn_blocking).


##### `ConfigEditsBuilder::apply_blocking`  (lines 88–96)

```
fn apply_blocking(self) -> std::io::Result<()>
```

**Purpose**: Performs the synchronous read-modify-write cycle for MCP config persistence. It is the blocking worker behind the async `apply` method.

**Data flow**: It computes `${codex_home}/config.toml`, loads or creates a `DocumentMut` with `read_or_create_document`, applies `replace_mcp_servers` if a replacement map was staged, ensures the Codex home directory exists, and writes the serialized document back to disk.

**Call relations**: This method is invoked only by `ConfigEditsBuilder::apply` inside `spawn_blocking`. It delegates document loading to `read_or_create_document` and section replacement to `replace_mcp_servers`.

*Call graph*: calls 2 internal fn (read_or_create_document, replace_mcp_servers); 3 external calls (join, create_dir_all, write).


##### `read_or_create_document`  (lines 99–107)

```
fn read_or_create_document(config_path: &Path) -> std::io::Result<DocumentMut>
```

**Purpose**: Loads an editable TOML document from disk or returns an empty document when the config file is absent. It is shared by blocking MCP config persistence.

**Data flow**: Input is `config_path: &Path`. It reads the file as string; on success it parses `DocumentMut` and maps parse failures to `InvalidData`; on `NotFound` it returns `DocumentMut::new()`; other I/O errors are returned unchanged.

**Call relations**: This helper is called by `ConfigEditsBuilder::apply_blocking` before any MCP section edits are applied.

*Call graph*: called by 1 (apply_blocking); 2 external calls (new, read_to_string).


##### `replace_mcp_servers`  (lines 109–122)

```
fn replace_mcp_servers(doc: &mut DocumentMut, servers: &BTreeMap<String, McpServerConfig>)
```

**Purpose**: Replaces the root `mcp_servers` section in an editable TOML document with a serialized view of the provided server map. An empty map removes the section entirely.

**Data flow**: Inputs are a mutable `DocumentMut` and a `BTreeMap<String, McpServerConfig>`. It gets the root table, removes `mcp_servers` and returns early if the map is empty, otherwise builds an implicit `TomlTable`, inserts each server name mapped to `serialize_mcp_server(config)`, and stores that table under `mcp_servers`.

**Call relations**: This function is called by `ConfigEditsBuilder::apply_blocking`. It delegates per-server serialization to `serialize_mcp_server`.

*Call graph*: calls 1 internal fn (serialize_mcp_server); called by 1 (apply_blocking); 3 external calls (as_table_mut, Table, new).


##### `serialize_mcp_server`  (lines 124–250)

```
fn serialize_mcp_server(config: &McpServerConfig) -> TomlItem
```

**Purpose**: Converts one typed `McpServerConfig` into a `toml_edit::Item` representing that server's TOML table. It emits only semantically relevant fields and keeps nested structures stable and sorted where needed.

**Data flow**: Input is `&McpServerConfig`. It creates a non-implicit `TomlTable`, matches on `config.transport`, and writes either stdio fields (`command`, optional `args`, optional `env`, optional `env_vars`, optional `cwd`) or HTTP fields (`url`, optional `bearer_token_env_var`, optional `http_headers`, optional `env_http_headers`). It then conditionally writes generic flags and metadata such as `enabled = false`, non-local `environment_id`, `required`, `supports_parallel_tool_calls`, startup/tool timeouts in seconds, default approval mode, optional enabled/disabled tools arrays, scopes, optional `[oauth] client_id`, optional `oauth_resource`, and a sorted `[tools]` table containing per-tool `approval_mode`. It returns `TomlItem::Table(entry)`.

**Call relations**: This serializer is called by `replace_mcp_servers` for each server entry. It delegates repeated structure building to `array_from_strings`, `array_from_env_vars`, and `table_from_pairs`.

*Call graph*: calls 4 internal fn (array_from_env_vars, array_from_strings, table_from_pairs, is_local_environment); called by 1 (replace_mcp_servers); 3 external calls (Table, new, value).


##### `array_from_strings`  (lines 252–258)

```
fn array_from_strings(values: &[String]) -> TomlItem
```

**Purpose**: Builds a TOML array item from a slice of strings. It is used for repeated string-valued MCP config fields.

**Data flow**: Input is `&[String]`. It creates `toml_edit::Array`, pushes a clone of each string, converts the array into a TOML value, wraps it in `TomlItem::Value`, and returns it.

**Call relations**: This helper is called by `serialize_mcp_server` for fields such as `args`, `enabled_tools`, `disabled_tools`, and `scopes`.

*Call graph*: called by 1 (serialize_mcp_server); 2 external calls (Value, new).


##### `array_from_env_vars`  (lines 260–276)

```
fn array_from_env_vars(env_vars: &[McpServerEnvVar]) -> TomlItem
```

**Purpose**: Serializes a list of `McpServerEnvVar` values into a TOML array containing either plain strings or inline tables. It preserves the two supported env-var representations.

**Data flow**: Input is `&[McpServerEnvVar]`. It creates a `toml_edit::Array`, then for each element either pushes the env var name string directly for `McpServerEnvVar::Name`, or builds an `InlineTable` with `name` and optional `source` for `McpServerEnvVar::Config`. It wraps the finished array as `TomlItem::Value` and returns it.

**Call relations**: This helper is called by `serialize_mcp_server` when serializing stdio transport `env_vars`.

*Call graph*: called by 1 (serialize_mcp_server); 3 external calls (Value, new, new).


##### `table_from_pairs`  (lines 278–290)

```
fn table_from_pairs(pairs: I) -> TomlItem
```

**Purpose**: Builds a deterministic TOML table from string key/value pairs by sorting keys first. It is used for header and environment maps so serialized output is stable.

**Data flow**: It accepts any iterator of `(&String, &String)`, collects entries into a vector, sorts by key, creates a non-implicit `TomlTable`, inserts each key with `value(value_str.clone())`, and returns `TomlItem::Table(table)`.

**Call relations**: This helper is called by `serialize_mcp_server` for `env`, `http_headers`, and `env_http_headers` maps.

*Call graph*: called by 1 (serialize_mcp_server); 4 external calls (into_iter, Table, new, value).


### `config/src/plugin_edit.rs`

`io_transport` · `user config mutation`

This file is a small persistence subsystem for mutating plugin-related user config without rewriting config semantics by hand. The public async helpers `set_user_plugin_enabled` and `clear_user_plugin` package one edit each and forward to `apply_user_plugin_config_edits`, which offloads the actual file work to `tokio::task::spawn_blocking`. The blocking worker resolves symlink-aware read/write paths for `config.toml`, parses the existing file into `toml_edit::DocumentMut` or creates a new empty document if the file is absent, applies each requested `PluginConfigEdit`, and writes the document back atomically only if something actually changed.

The edit logic is careful about TOML shape. `ensure_plugins_table` creates an implicit `[plugins]` table when needed. `ensure_table_for_write` and `ensure_table_for_read` convert inline tables into regular tables so nested plugin entries can be updated or removed consistently; unsupported item kinds cause the edit to no-op rather than corrupting unrelated config. `set_plugin_enabled` preserves existing decoration on the `enabled` value via `preserve_decor`, so comments/whitespace formatting survive simple toggles. `clear_plugin` removes a plugin entry from the `plugins` table, and because `toml_edit` omits empty implicit tables on serialization, deleting the last plugin can collapse the file to empty. The included tests cover creation, preservation of sibling fields, no-op deletion, and symlink-following writes.

#### Function details

##### `set_user_plugin_enabled`  (lines 21–34)

```
async fn set_user_plugin_enabled(
    codex_home: &Path,
    plugin_key: String,
    enabled: bool,
) -> std::io::Result<()>
```

**Purpose**: Asynchronously records a plugin `enabled` setting in the user config for one plugin key.

**Data flow**: Takes `codex_home`, a `plugin_key`, and a boolean `enabled`; wraps them in a single `PluginConfigEdit::SetEnabled`; forwards the edit list to `apply_user_plugin_config_edits`; returns the resulting `std::io::Result<()>`.

**Call relations**: This is the public convenience entrypoint used by callers and by the async tests; it delegates all actual file mutation to `apply_user_plugin_config_edits`.

*Call graph*: calls 1 internal fn (apply_user_plugin_config_edits); called by 3 (set_user_plugin_enabled_follows_config_symlink, set_user_plugin_enabled_preserves_existing_plugin_fields, set_user_plugin_enabled_writes_plugin_entry); 1 external calls (vec!).


##### `clear_user_plugin`  (lines 36–38)

```
async fn clear_user_plugin(codex_home: &Path, plugin_key: String) -> std::io::Result<()>
```

**Purpose**: Asynchronously removes one plugin entry from the user config.

**Data flow**: Takes `codex_home` and `plugin_key`; wraps them in a single `PluginConfigEdit::Clear`; forwards to `apply_user_plugin_config_edits`; returns the resulting I/O result.

**Call relations**: This is the public deletion counterpart to `set_user_plugin_enabled`, with the same async wrapper behavior.

*Call graph*: calls 1 internal fn (apply_user_plugin_config_edits); called by 2 (clear_user_plugin_missing_entry_does_not_create_config, clear_user_plugin_removes_empty_plugins_table); 1 external calls (vec!).


##### `apply_user_plugin_config_edits`  (lines 40–48)

```
async fn apply_user_plugin_config_edits(
    codex_home: &Path,
    edits: Vec<PluginConfigEdit>,
) -> std::io::Result<()>
```

**Purpose**: Runs one or more plugin config edits on a blocking thread and converts task panics into I/O errors.

**Data flow**: Clones `codex_home` into an owned `PathBuf`, moves it and the edit list into `task::spawn_blocking`, waits for the blocking result, maps a join error into `std::io::Error::other`, and otherwise returns the blocking function’s `std::io::Result<()>`.

**Call relations**: Both public async helpers call this. It exists to keep filesystem and TOML-edit work off the async runtime core threads while centralizing panic-to-I/O error conversion.

*Call graph*: called by 2 (clear_user_plugin, set_user_plugin_enabled); 2 external calls (to_path_buf, spawn_blocking).


##### `apply_user_plugin_config_edits_blocking`  (lines 50–75)

```
fn apply_user_plugin_config_edits_blocking(
    codex_home: &Path,
    edits: Vec<PluginConfigEdit>,
) -> std::io::Result<()>
```

**Purpose**: Performs the actual read-modify-write cycle for plugin config edits against `config.toml`.

**Data flow**: Takes `codex_home` and a vector of edits. If the edit list is empty, returns immediately. Otherwise it builds the config path with `join(CONFIG_TOML_FILE)`, resolves symlink-aware read/write paths, loads or creates a `DocumentMut` with `read_or_create_document`, applies each edit by dispatching to `set_plugin_enabled` or `clear_plugin` while OR-ing their mutation flags, and if any edit changed the document, writes the serialized TOML atomically to the resolved write path. Returns `Ok(())` for no-op edits or successful writes, or propagates I/O/parse errors.

**Call relations**: This is the blocking worker invoked only from `apply_user_plugin_config_edits`. It delegates document parsing to `read_or_create_document` and per-edit mutations to `set_plugin_enabled` and `clear_plugin`.

*Call graph*: calls 3 internal fn (clear_plugin, read_or_create_document, set_plugin_enabled); 3 external calls (join, resolve_symlink_write_paths, write_atomically).


##### `read_or_create_document`  (lines 77–88)

```
fn read_or_create_document(config_path: Option<&Path>) -> std::io::Result<DocumentMut>
```

**Purpose**: Loads an existing TOML document for editing or creates a new empty document when no readable config file exists.

**Data flow**: Takes an optional config path. If `None`, returns `DocumentMut::new()`. If a path is present, reads the file as a string; on success parses it into `DocumentMut`, mapping parse failures to `ErrorKind::InvalidData`; on `NotFound`, returns a new empty document; otherwise propagates the read error.

**Call relations**: This is called by `apply_user_plugin_config_edits_blocking` after symlink resolution to obtain the editable TOML document.

*Call graph*: called by 1 (apply_user_plugin_config_edits_blocking); 2 external calls (new, read_to_string).


##### `set_plugin_enabled`  (lines 90–103)

```
fn set_plugin_enabled(doc: &mut DocumentMut, plugin_key: &str, enabled: bool) -> bool
```

**Purpose**: Ensures the plugin entry exists as a table and sets its `enabled` field, preserving existing formatting on that field when possible.

**Data flow**: Takes mutable `DocumentMut`, `plugin_key`, and `enabled`. It obtains or creates the root `plugins` table via `ensure_plugins_table`; obtains or converts the specific plugin entry into a writable table via `ensure_table_for_write`; creates a TOML boolean item with `value(enabled)`; if an `enabled` item already exists, copies its decoration into the replacement via `preserve_decor`; assigns the replacement into `plugin["enabled"]`; returns `true` on mutation or `false` if the necessary tables could not be represented safely.

**Call relations**: This mutation helper is selected by `apply_user_plugin_config_edits_blocking` for `PluginConfigEdit::SetEnabled` edits.

*Call graph*: calls 3 internal fn (ensure_plugins_table, ensure_table_for_write, preserve_decor); called by 1 (apply_user_plugin_config_edits_blocking); 1 external calls (value).


##### `clear_plugin`  (lines 105–114)

```
fn clear_plugin(doc: &mut DocumentMut, plugin_key: &str) -> bool
```

**Purpose**: Removes a plugin entry from the `plugins` table if that table exists and can be read as a normal table.

**Data flow**: Takes mutable `DocumentMut` and `plugin_key`; gets the root table, looks up `plugins`, converts inline-table form to a regular table with `ensure_table_for_read` if needed, removes the keyed plugin entry, and returns whether an entry was actually removed.

**Call relations**: This mutation helper is selected by `apply_user_plugin_config_edits_blocking` for `PluginConfigEdit::Clear` edits.

*Call graph*: calls 1 internal fn (ensure_table_for_read); called by 1 (apply_user_plugin_config_edits_blocking); 1 external calls (as_table_mut).


##### `ensure_plugins_table`  (lines 116–122)

```
fn ensure_plugins_table(doc: &mut DocumentMut) -> Option<&mut TomlTable>
```

**Purpose**: Obtains the root `plugins` table, creating it as an implicit table when absent.

**Data flow**: Takes mutable `DocumentMut`, accesses the root table, inserts `plugins = <implicit table>` if missing, then passes the resulting item to `ensure_table_for_write` and returns the writable `TomlTable` reference if conversion succeeds.

**Call relations**: This is used by `set_plugin_enabled` to guarantee there is a writable container for plugin entries.

*Call graph*: calls 2 internal fn (ensure_table_for_write, new_implicit_table); called by 1 (set_plugin_enabled); 2 external calls (as_table_mut, Table).


##### `ensure_table_for_write`  (lines 124–140)

```
fn ensure_table_for_write(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Converts a TOML item into a writable regular table when possible, creating one for empty items and expanding inline tables.

**Data flow**: Takes mutable `TomlItem`. If it is already a `Table`, returns it. If it is a `Value` containing an inline table, converts that inline table with `table_from_inline`; if it is another scalar value, replaces it with a new implicit table; if it is `None`, also replaces it with a new implicit table; for unsupported item kinds such as arrays of tables, returns `None`. Successful cases return `item.as_table_mut()`.

**Call relations**: This helper is used by both `ensure_plugins_table` and `set_plugin_enabled` so writes can proceed even when the existing TOML uses inline-table syntax.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 2 (ensure_plugins_table, set_plugin_enabled); 2 external calls (Table, as_table_mut).


##### `ensure_table_for_read`  (lines 142–152)

```
fn ensure_table_for_read(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Converts an item into a readable regular table without inventing new structure.

**Data flow**: Takes mutable `TomlItem`. If it is already a table, leaves it unchanged. If it is a value containing an inline table, clones and converts that inline table with `table_from_inline` and replaces the item. For any other kind, returns `None`. Successful cases return `item.as_table_mut()`.

**Call relations**: This is used by `clear_plugin` because deletion should only operate on an existing plugin table, not create one.

*Call graph*: calls 1 internal fn (table_from_inline); called by 1 (clear_plugin); 2 external calls (Table, as_table_mut).


##### `table_from_inline`  (lines 154–162)

```
fn table_from_inline(inline: &toml_edit::InlineTable) -> TomlTable
```

**Purpose**: Expands a `toml_edit::InlineTable` into an implicit regular table while cleaning up value suffix decoration.

**Data flow**: Takes an inline table reference, creates a new implicit `TomlTable`, iterates each key/value pair, clones each value, clears its suffix decoration, inserts it into the new table as `TomlItem::Value`, and returns the resulting table.

**Call relations**: Both `ensure_table_for_read` and `ensure_table_for_write` use this when they need to convert inline-table syntax into a mutable regular table representation.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 1 (ensure_table_for_read); 2 external calls (iter, Value).


##### `new_implicit_table`  (lines 164–168)

```
fn new_implicit_table() -> TomlTable
```

**Purpose**: Constructs a TOML table marked implicit so serialization can omit unnecessary explicit headers.

**Data flow**: Creates `TomlTable::new()`, sets `implicit` to true, and returns the table.

**Call relations**: This is the common constructor used whenever plugin-edit code needs to synthesize a table, including root `plugins` creation and inline-table expansion.

*Call graph*: called by 3 (ensure_plugins_table, ensure_table_for_write, table_from_inline); 1 external calls (new).


##### `preserve_decor`  (lines 170–178)

```
fn preserve_decor(existing: &TomlItem, replacement: &mut TomlItem)
```

**Purpose**: Copies formatting decoration from an existing TOML value item to a replacement value item.

**Data flow**: Takes references to an existing `TomlItem` and mutable replacement `TomlItem`; if both are `Value` variants, clones the existing value’s decoration onto the replacement value; otherwise does nothing.

**Call relations**: This is called by `set_plugin_enabled` so toggling the `enabled` field preserves comments and whitespace attached to the previous value.

*Call graph*: called by 1 (set_plugin_enabled).


##### `tests::set_user_plugin_enabled_writes_plugin_entry`  (lines 187–207)

```
async fn set_user_plugin_enabled_writes_plugin_entry()
```

**Purpose**: Tests that enabling a plugin in an empty config creates the expected `[plugins."..."]` entry with `enabled = true`.

**Data flow**: Creates a temporary directory, calls `set_user_plugin_enabled`, reads the resulting config with `read_config`, parses an expected TOML value, and asserts equality.

**Call relations**: This async test exercises the full public write path from API call through file creation and TOML serialization.

*Call graph*: calls 1 internal fn (set_user_plugin_enabled); 4 external calls (new, assert_eq!, read_config, from_str).


##### `tests::set_user_plugin_enabled_preserves_existing_plugin_fields`  (lines 210–240)

```
async fn set_user_plugin_enabled_preserves_existing_plugin_fields()
```

**Purpose**: Tests that setting `enabled` updates only that field and leaves sibling plugin fields intact.

**Data flow**: Creates a temp config file containing an existing plugin table with `enabled` and `source`, calls `set_user_plugin_enabled`, reads the resulting config, parses the expected TOML, and asserts equality.

**Call relations**: It validates the mutation behavior of `set_plugin_enabled` within the full file-edit pipeline.

*Call graph*: calls 1 internal fn (set_user_plugin_enabled); 5 external calls (new, assert_eq!, read_config, write, from_str).


##### `tests::clear_user_plugin_removes_empty_plugins_table`  (lines 243–262)

```
async fn clear_user_plugin_removes_empty_plugins_table()
```

**Purpose**: Tests that removing the only plugin entry leaves the serialized config empty.

**Data flow**: Creates a temp config file with one plugin entry, calls `clear_user_plugin`, reads the raw file contents back, and asserts the file is now an empty string.

**Call relations**: This covers the deletion path and the serialization behavior of empty implicit tables after `clear_plugin` removes the last entry.

*Call graph*: calls 1 internal fn (clear_user_plugin); 3 external calls (new, assert_eq!, write).


##### `tests::clear_user_plugin_missing_entry_does_not_create_config`  (lines 265–273)

```
async fn clear_user_plugin_missing_entry_does_not_create_config()
```

**Purpose**: Tests that clearing a nonexistent plugin from an absent config file is a no-op that does not create `config.toml`.

**Data flow**: Creates a temporary directory with no config file, calls `clear_user_plugin`, and asserts the config path still does not exist.

**Call relations**: It exercises the no-op path where `apply_user_plugin_config_edits_blocking` detects no mutation and therefore skips writing.

*Call graph*: calls 1 internal fn (clear_user_plugin); 2 external calls (new, assert!).


##### `tests::set_user_plugin_enabled_follows_config_symlink`  (lines 277–302)

```
async fn set_user_plugin_enabled_follows_config_symlink()
```

**Purpose**: Tests that plugin edits respect a symlinked `config.toml` and write to the symlink target.

**Data flow**: On Unix, creates a temp directory, creates a symlink from `config.toml` to another file, calls `set_user_plugin_enabled`, reads and parses the target file, parses the expected TOML, and asserts equality.

**Call relations**: This validates the symlink-aware path resolution performed by `resolve_symlink_write_paths` inside the blocking edit worker.

*Call graph*: calls 1 internal fn (set_user_plugin_enabled); 4 external calls (new, assert_eq!, read_to_string, from_str).


##### `tests::read_config`  (lines 304–306)

```
fn read_config(codex_home: &Path) -> toml::Value
```

**Purpose**: Helper for tests that reads and parses the current config file from a temporary Codex home directory.

**Data flow**: Takes `codex_home`, joins it with `CONFIG_TOML_FILE`, reads the file to a string, parses it as `toml::Value`, and returns the parsed value.

**Call relations**: The plugin-edit tests use this helper to inspect the persisted config after invoking the public edit APIs.

*Call graph*: 3 external calls (join, read_to_string, from_str).


### `external-agent-migration/src/lib.rs`

`domain_logic` · `migration/import phase`

This library chunk is the core migration logic for three source artifacts: MCP server definitions, hook settings/scripts, and markdown-authored agents/commands. MCP migration starts by reading repository-local and optional home-level external-agent JSON config files, merging `mcpServers` entries into a `BTreeMap<String, JsonValue>` with explicit precedence rules: repo files overwrite earlier values, while home project entries only fill gaps. Matching project-scoped config is selected by exact or canonicalized path equality. Each candidate server is then filtered through enable/disable settings and converted into a TOML table only if it matches supported transports (`stdio` via `command`, `http`/`streamable_http` via `url`) and does not contain unresolved `${...}` placeholders in unsupported positions. Environment placeholders are selectively normalized into `env_vars`, `env_http_headers`, or `bearer_token_env_var`.

Hook migration reads `settings.json` and `settings.local.json`, aborts entirely if `disableAllHooks` is true, and extracts only a narrow subset of hook groups and command hooks. Unsupported fields, async hooks, non-command hooks, dynamic path suffixes, and Windows-style commands are intentionally skipped. When importing, it only writes `hooks.json` if the target file is missing or empty, and copies hook scripts recursively without overwriting existing target files.

Subagent and command migration both parse markdown documents with optional YAML frontmatter. Frontmatter parsing is forgiving: malformed or non-mapping frontmatter is treated as unusable metadata, and unsupported YAML value shapes become `Other`. Subagents require non-empty `name`, `description`, and body text; commands require a description, a unique slugified skill name within length limits, and a template body free of unsupported runtime-expansion syntax. Rendered outputs also rewrite source-tool terminology to Codex-specific wording. From this test chunk, the file’s core responsibility is to read external-agent settings JSON, extract only hook groups that Codex can represent, rewrite hook command strings so they point at the migrated hook directory, and copy hook scripts into that destination without clobbering user-modified files. The tests show that migration is selective rather than mechanical: unsupported event groups such as `PreToolUse` and `SubagentStart`, unsupported hook handler types such as `http` and `prompt`, and command hooks carrying unsupported per-hook conditions are omitted, while supported groups like `PermissionRequest` survive with their command paths rewritten. The migration also respects global and local disable flags: a project-level `disableAllHooks: true` suppresses migration entirely unless a local settings file explicitly overrides it back to `false`, in which case hooks from both files are merged. Command rewriting is intentionally conservative. It rewrites direct references to known source hook paths into the target `.codex` migrated hooks directory, preserving quoting when needed, but leaves complex shell constructs, variable-expanded filenames, brace expansion, escaped spaces, Windows-style paths, and plugin-root references untouched. Script copying likewise preserves existing target files. Negative hook timeouts are normalized away rather than migrated, indicating an invariant that only non-negative timeout values are emitted into the target configuration.

#### Function details

##### `build_mcp_config_from_external`  (lines 44–84)

```
fn build_mcp_config_from_external(
    source_root: &Path,
    external_agent_home: Option<&Path>,
    settings: Option<&JsonValue>,
) -> io::Result<TomlValue>
```

**Purpose**: Builds the final TOML value for migrated MCP servers from external-agent JSON config files and optional settings-based allow/deny lists. It returns an empty TOML table when no usable servers survive filtering.

**Data flow**: `source_root`, optional `external_agent_home`, and optional JSON `settings` are read to gather raw MCP server objects via `read_external_mcp_servers`. It extracts `enabledMcpjsonServers` and `disabledMcpjsonServers` into a `Vec<String>` and `BTreeSet<String>`, converts each raw server through `mcp_server_toml_table`, and assembles a TOML table under `mcp_servers`; if nothing is imported, it returns `TomlValue::Table(Default::default())`.

**Call relations**: This is the public MCP migration entry used by callers that want a ready-to-serialize TOML fragment. It depends on `read_external_mcp_servers` for merge/precedence logic and on `mcp_server_toml_table` for per-server validation and conversion.

*Call graph*: calls 2 internal fn (mcp_server_toml_table, read_external_mcp_servers); 3 external calls (default, Table, new).


##### `hooks_migration_description`  (lines 86–99)

```
fn hooks_migration_description(
    source_external_agent_dir: &Path,
    target_hooks: &Path,
) -> io::Result<Option<String>>
```

**Purpose**: Produces a human-readable summary string describing a pending hook migration, but only when at least one hook event can actually be migrated. It suppresses the description entirely when migration would be a no-op.

**Data flow**: It takes the source external-agent config directory and target hooks file path, asks `hook_migration_event_names` for migratable event names, and returns `Ok(None)` if that list is empty. Otherwise it formats a string using both paths’ display forms and returns `Ok(Some(...))`.

**Call relations**: This function is a lightweight probe for UI/planning flows that need to announce work before running it. It delegates all substantive eligibility checks to `hook_migration_event_names`.

*Call graph*: calls 1 internal fn (hook_migration_event_names); 1 external calls (format!).


##### `hook_migration_event_names`  (lines 101–107)

```
fn hook_migration_event_names(
    source_external_agent_dir: &Path,
    target_hooks: &Path,
) -> io::Result<Vec<String>>
```

**Purpose**: Computes which hook event names would be present in a migrated hooks payload. It exposes only the top-level event keys, not the full hook definitions.

**Data flow**: Given the source external-agent directory and target hooks path, it derives the target config directory from `target_hooks.parent()`, invokes `hook_migration`, then clones and collects the resulting JSON object keys into a `Vec<String>`. Errors from migration propagate unchanged.

**Call relations**: It is called by `hooks_migration_description` to decide whether a migration description should be shown. Its only delegated work is the full hook extraction performed by `hook_migration`.

*Call graph*: calls 1 internal fn (hook_migration); called by 1 (hooks_migration_description); 1 external calls (parent).


##### `import_hooks`  (lines 109–132)

```
fn import_hooks(source_external_agent_dir: &Path, target_hooks: &Path) -> io::Result<bool>
```

**Purpose**: Imports migratable hook definitions into the target `hooks.json` and copies referenced hook scripts into the migrated hooks directory. It only activates the target hooks file when that file is missing or empty.

**Data flow**: It reads `source_external_agent_dir` and `target_hooks`, first requiring that `target_hooks.parent()` exist conceptually; otherwise it returns `invalid_data_error`. It computes a migration map with `hook_migration`, creates the parent directory, conditionally copies scripts with `copy_hook_scripts`, serializes `{ "hooks": migration }` as pretty JSON, writes it to `target_hooks` with a trailing newline, and returns `true` only if it wrote the active hooks file.

**Call relations**: This is the public hook import executor. It relies on `hook_migration` to decide whether anything is convertible, `is_missing_or_empty_text_file` to avoid overwriting non-empty targets, and `copy_hook_scripts` to stage script files alongside the generated config.

*Call graph*: calls 4 internal fn (copy_hook_scripts, hook_migration, invalid_data_error, is_missing_or_empty_text_file); 7 external calls (Object, parent, format!, create_dir_all, write, new, to_string_pretty).


##### `count_missing_subagents`  (lines 134–136)

```
fn count_missing_subagents(source_agents: &Path, target_agents: &Path) -> io::Result<usize>
```

**Purpose**: Counts how many source subagent markdown files do not yet have corresponding target TOML files. It is a convenience wrapper around name discovery.

**Data flow**: It passes `source_agents` and `target_agents` to `missing_subagent_names`, takes the resulting vector length, and returns that count as `usize`.

**Call relations**: This function exists for callers that need a numeric summary rather than the actual names. All file scanning and metadata checks are delegated to `missing_subagent_names`.

*Call graph*: calls 1 internal fn (missing_subagent_names).


##### `missing_subagent_names`  (lines 138–156)

```
fn missing_subagent_names(
    source_agents: &Path,
    target_agents: &Path,
) -> io::Result<Vec<String>>
```

**Purpose**: Finds source subagents that are valid enough to migrate and whose target `.toml` files do not already exist. It reports the migrated agent names from frontmatter, not filenames.

**Data flow**: It enumerates markdown files from `agent_source_files`, parses each with `parse_document`, extracts required metadata with `agent_metadata`, derives the target path with `subagent_target_file`, and pushes `metadata.name` into the output vector when the target path does not exist. Files lacking valid metadata or a derivable target path are skipped.

**Call relations**: It is used by `count_missing_subagents` and mirrors the same eligibility rules later used by `import_subagents`. It depends on parsing and metadata extraction helpers to ensure the count reflects actual importability.

*Call graph*: calls 4 internal fn (agent_metadata, agent_source_files, parse_document, subagent_target_file); called by 1 (count_missing_subagents); 1 external calls (new).


##### `import_subagents`  (lines 158–181)

```
fn import_subagents(source_agents: &Path, target_agents: &Path) -> io::Result<Vec<String>>
```

**Purpose**: Creates TOML subagent files for source markdown agents that are valid and not already present in the target directory. It preserves existing target files by skipping them.

**Data flow**: If `source_agents` is not a directory, it returns an empty vector immediately. Otherwise it creates `target_agents`, iterates `agent_source_files`, derives each target path with `subagent_target_file`, skips existing targets, parses the markdown with `parse_document`, extracts `AgentMetadata` with `agent_metadata`, renders TOML via `render_agent_toml`, writes the file, and returns the list of imported agent names.

**Call relations**: This is the public subagent import path. It shares discovery/parsing helpers with `missing_subagent_names`, but additionally delegates final serialization to `render_agent_toml`.

*Call graph*: calls 5 internal fn (agent_metadata, agent_source_files, parse_document, render_agent_toml, subagent_target_file); 4 external calls (is_dir, new, create_dir_all, write).


##### `count_missing_commands`  (lines 183–185)

```
fn count_missing_commands(source_commands: &Path, target_skills: &Path) -> io::Result<usize>
```

**Purpose**: Counts how many supported source commands do not yet have corresponding target skill directories. It is the numeric counterpart to command-name discovery.

**Data flow**: It invokes `missing_command_names` with the source commands root and target skills directory, then returns the length of the resulting vector.

**Call relations**: This wrapper is for reporting/planning flows. The actual support checks and existence filtering happen in `missing_command_names`.

*Call graph*: calls 1 internal fn (missing_command_names).


##### `missing_command_names`  (lines 187–196)

```
fn missing_command_names(
    source_commands: &Path,
    target_skills: &Path,
) -> io::Result<Vec<String>>
```

**Purpose**: Lists supported command skill names whose target skill directories are absent. It uses the normalized skill slug, not the original source command path.

**Data flow**: It obtains `(source_file, name)` pairs from `unique_supported_command_sources`, filters out any whose `target_skills.join(name)` already exists, maps the survivors to just `name`, and returns them as a vector.

**Call relations**: It is called by `count_missing_commands` and uses `unique_supported_command_sources` so that unsupported commands and slug collisions are excluded before existence checks.

*Call graph*: calls 1 internal fn (unique_supported_command_sources); called by 1 (count_missing_commands).


##### `import_commands`  (lines 198–224)

```
fn import_commands(source_commands: &Path, target_skills: &Path) -> io::Result<Vec<String>>
```

**Purpose**: Imports supported source command templates as Codex skill directories containing `SKILL.md`. It skips commands whose target directory already exists or whose parsed document lacks a usable description.

**Data flow**: If `source_commands` is not a directory, it returns an empty vector. Otherwise it creates `target_skills`, iterates unique supported command sources, parses each markdown file, creates a per-skill target directory, derives a human-readable source name with `command_source_name`, obtains a description with `command_skill_description`, writes `SKILL.md` using `render_command_skill`, and returns the list of imported skill names.

**Call relations**: This is the public command import executor. It depends on `unique_supported_command_sources` for deduplication and support filtering, then uses parsing and rendering helpers to materialize each skill.

*Call graph*: calls 5 internal fn (command_skill_description, command_source_name, parse_document, render_command_skill, unique_supported_command_sources); 5 external calls (is_dir, join, new, create_dir_all, write).


##### `read_external_mcp_servers`  (lines 226–269)

```
fn read_external_mcp_servers(
    source_root: &Path,
    external_agent_home: Option<&Path>,
) -> io::Result<BTreeMap<String, JsonValue>>
```

**Purpose**: Reads and merges external-agent MCP server definitions from repository-local config files and optional home-level project config. It applies path-scoped project overrides and precedence rules before any TOML conversion happens.

**Data flow**: Starting from `source_root`, it checks both the fixed MCP config filename and the external-agent project config filename. For each existing file it reads JSON text, parses it into `JsonValue`, merges top-level `mcpServers` into a `BTreeMap<String, JsonValue>` with overwrite semantics, and for project config files additionally merges matching `projects[project_path]` entries when `project_path_matches_source_root` succeeds. If `external_agent_home` is provided, its parent differs from `source_root`, and a home-level project config exists, it calls `append_external_agent_project_mcp_servers` to merge matching project entries without overwriting repo-defined servers.

**Call relations**: This helper is called only by `build_mcp_config_from_external` and encapsulates all source-file discovery and merge precedence. It delegates repeated extraction logic to `append_mcp_servers_from_value` and home-project fallback handling to `append_external_agent_project_mcp_servers`.

*Call graph*: calls 4 internal fn (append_external_agent_project_mcp_servers, append_mcp_servers_from_value, external_agent_project_config_file, project_path_matches_source_root); called by 1 (build_mcp_config_from_external); 4 external calls (new, join, read_to_string, from_str).


##### `append_external_agent_project_mcp_servers`  (lines 271–295)

```
fn append_external_agent_project_mcp_servers(
    source_file: &Path,
    source_root: &Path,
    servers: &mut BTreeMap<String, JsonValue>,
) -> io::Result<()>
```

**Purpose**: Adds MCP servers from a home-level external-agent project config, but only for project entries matching the current source root and only when those server names are not already present. It is intentionally lower precedence than repo-local config.

**Data flow**: It takes a candidate JSON config file path, the current `source_root`, and a mutable server map. If the file exists, it reads and parses JSON, extracts the `projects` object, checks each project path with `project_path_matches_source_root`, and merges matching project configs’ `mcpServers` into `servers` using `McpServerMerge::PreserveExisting`.

**Call relations**: This function is invoked from `read_external_mcp_servers` only when an external-agent home directory is supplied and distinct from the repo root. It delegates the actual `mcpServers` extraction to `append_mcp_servers_from_value`.

*Call graph*: calls 2 internal fn (append_mcp_servers_from_value, project_path_matches_source_root); called by 1 (read_external_mcp_servers); 3 external calls (is_file, read_to_string, from_str).


##### `append_mcp_servers_from_value`  (lines 303–323)

```
fn append_mcp_servers_from_value(
    value: &JsonValue,
    servers: &mut BTreeMap<String, JsonValue>,
    merge: McpServerMerge,
)
```

**Purpose**: Extracts a `mcpServers` object from arbitrary JSON and merges its entries into the accumulated server map. The merge behavior is controlled by an explicit overwrite/preserve mode.

**Data flow**: It reads `value["mcpServers"]` as a JSON object; if absent or not an object, it returns immediately. For each `(server_name, server_config)`, it either clones into `servers.insert(...)` for overwrite mode or uses `entry(...).or_insert_with(...)` for preserve-existing mode.

**Call relations**: This is the low-level merge primitive used by both `read_external_mcp_servers` and `append_external_agent_project_mcp_servers`. It performs no validation beyond locating the `mcpServers` object.

*Call graph*: called by 2 (append_external_agent_project_mcp_servers, read_external_mcp_servers); 1 external calls (get).


##### `project_path_matches_source_root`  (lines 325–336)

```
fn project_path_matches_source_root(project_path: &str, source_root: &Path) -> bool
```

**Purpose**: Determines whether a project path string from config refers to the same filesystem location as the current source root. It accepts either direct path equality or canonicalized equality.

**Data flow**: It converts the string `project_path` into a `Path`, first checking raw equality against `source_root`. If that fails, it canonicalizes the project path and source root and returns true only when both canonical forms are available and equal; canonicalization failure yields false.

**Call relations**: This predicate is used during MCP project-config merging to select only the project stanza relevant to the current repository. It is called from both repo-local and home-level project config readers.

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

**Purpose**: Converts one raw MCP server JSON object into the TOML table expected by the target system, or rejects it when disabled, malformed, unsupported, or dependent on unresolved placeholders. It prefers command/stdio transport when both command and URL fields are present.

**Data flow**: It receives the server name, optional JSON object, enabled/disabled server lists, and starts with an empty TOML map. After rejecting disabled servers via `mcp_server_is_disabled`, it checks for a `command` string first: only `None`/`stdio` transport types are accepted, command and args must not contain `${...}`, args are normalized with `json_string_vec`, and env vars are appended through `append_env_config`. If no command exists, it tries a `url` string: only `None`/`http`/`streamable_http` are accepted, the URL must not contain placeholders, and headers are appended through `append_header_config`. On success it returns `Some(table)`; otherwise `None`.

**Call relations**: This converter is called by `build_mcp_config_from_external` for every merged server. It delegates disable checks and nested env/header normalization to dedicated helpers so the top-level builder only sees accepted TOML tables.

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

**Purpose**: Evaluates all disable conditions for an MCP server, combining per-server flags with global enabled/disabled lists from settings. Any one disabling condition excludes the server.

**Data flow**: It reads `enabled` and `disabled` booleans from `server_config`, checks whether a non-empty `enabled_servers` list omits `server_name`, and checks membership in `disabled_servers`. It returns `true` if the server is explicitly disabled, explicitly not enabled, or excluded by the allow/deny lists.

**Call relations**: This predicate is used only inside `mcp_server_toml_table` before any transport-specific conversion. It centralizes the filtering logic so the converter can early-return on disabled servers.

*Call graph*: called by 1 (mcp_server_toml_table); 2 external calls (contains, get).


##### `append_header_config`  (lines 416–456)

```
fn append_header_config(
    table: &mut toml::map::Map<String, TomlValue>,
    headers: &serde_json::Map<String, JsonValue>,
) -> Option<()>
```

**Purpose**: Transforms JSON HTTP headers into TOML fields, separating static headers, env-derived headers, and bearer-token shorthand. It rejects partially dynamic header values that cannot be represented safely.

**Data flow**: Given a mutable TOML table and a JSON header object, it stringifies each value with `json_string` fallback to JSON text. `Authorization: Bearer ${TOKEN...}` is converted into `bearer_token_env_var`; exact env placeholders become entries in `env_http_headers`; plain static values become `http_headers`; any value merely containing `${` without being a clean placeholder causes the function to return `None` without appending further.

**Call relations**: This helper is called from the URL branch of `mcp_server_toml_table`. It uses `parse_env_placeholder` and `contains_env_placeholder` to distinguish representable env references from unsupported interpolated strings.

*Call graph*: calls 3 internal fn (contains_env_placeholder, json_string, parse_env_placeholder); called by 1 (mcp_server_toml_table); 4 external calls (insert, String, Table, new).


##### `append_env_config`  (lines 458–483)

```
fn append_env_config(
    table: &mut toml::map::Map<String, TomlValue>,
    env: &serde_json::Map<String, JsonValue>,
) -> Option<()>
```

**Purpose**: Transforms JSON process environment settings into TOML `env_vars` and static `env` entries. It recognizes self-referential placeholders like `${NAME}` as pass-through env vars.

**Data flow**: It iterates the JSON env object, stringifies each value, and compares `parse_env_placeholder(&env_value)` to the key name. Exact self-reference adds the key to `env_vars`; any other `${...}` occurrence causes rejection with `None`; otherwise the key/value pair is inserted into a static `env` table. Non-empty collections are then inserted into the provided TOML table.

**Call relations**: This helper is called from the command/stdio branch of `mcp_server_toml_table`. It enforces a stricter migration rule than generic string copying so only safe env representations are emitted.

*Call graph*: calls 3 internal fn (contains_env_placeholder, json_string, parse_env_placeholder); called by 1 (mcp_server_toml_table); 6 external calls (insert, Array, String, Table, new, new).


##### `parse_env_placeholder`  (lines 485–499)

```
fn parse_env_placeholder(value: &str) -> Option<String>
```

**Purpose**: Parses shell-style `${VAR}` or `${VAR:-default}` placeholders and extracts a valid environment variable name. It rejects malformed names and non-placeholder strings.

**Data flow**: It strips the `${` prefix and `}` suffix, removes any `:-default` suffix, validates that the first character is `_` or ASCII alphabetic and the rest are `_` or ASCII alphanumeric, and returns `Some(name.to_string())` on success or `None` otherwise.

**Call relations**: This parser underpins both env and header migration helpers. It is used to recognize placeholders that can be represented structurally instead of copied as opaque strings.

*Call graph*: called by 2 (append_env_config, append_header_config).


##### `contains_env_placeholder`  (lines 501–503)

```
fn contains_env_placeholder(value: &str) -> bool
```

**Purpose**: Performs a coarse check for `${` in a string to detect unresolved environment interpolation syntax. It is intentionally simpler than full parsing.

**Data flow**: It reads a string slice and returns `true` if `value.contains("${")`, otherwise `false`.

**Call relations**: This helper is used as a rejection guard in `mcp_server_toml_table`, `append_header_config`, and `append_env_config` after exact placeholder cases have been handled.

*Call graph*: called by 3 (append_env_config, append_header_config, mcp_server_toml_table).


##### `hook_migration`  (lines 505–535)

```
fn hook_migration(
    source_external_agent_dir: &Path,
    target_config_dir: Option<&Path>,
) -> io::Result<serde_json::Map<String, JsonValue>>
```

**Purpose**: Builds the migrated hooks payload by reading external-agent settings files and extracting only convertible hook groups. A global `disableAllHooks` flag suppresses all migration.

**Data flow**: It looks for `settings.json` and `settings.local.json` under `source_external_agent_dir`, reads and parses each existing file as JSON, tracks the last observed `disableAllHooks` boolean, and stores the parsed settings values. If hooks are globally disabled, it returns an empty JSON map; otherwise it initializes an empty migration map and feeds each settings object into `append_convertible_hook_groups`, passing along the optional target config directory.

**Call relations**: This function is the central hook extraction routine used by both `hook_migration_event_names` and `import_hooks`. It delegates the detailed per-event/per-hook filtering and rewriting to `append_convertible_hook_groups`.

*Call graph*: calls 1 internal fn (append_convertible_hook_groups); called by 2 (hook_migration_event_names, import_hooks); 5 external calls (join, new, read_to_string, new, from_str).


##### `append_convertible_hook_groups`  (lines 537–660)

```
fn append_convertible_hook_groups(
    settings: &JsonValue,
    hooks_payload: &mut serde_json::Map<String, JsonValue>,
    target_config_dir: Option<&Path>,
)
```

**Purpose**: Scans a settings JSON object for hook groups that fit the target system’s supported subset and appends converted groups into the migration payload. It silently skips unsupported group shapes, unsupported hook types, async hooks, and hooks with unsupported fields.

**Data flow**: It reads `settings["hooks"]` as an object, iterates the fixed `HOOK_EVENT_NAMES`, and for each event iterates group arrays. Groups are accepted only when they contain no `if` and no keys beyond `matcher` and `hooks`. Within each group, only `type == "command"` hooks with allowed keys, non-async execution, and non-empty `command` strings are converted. Commands are rewritten with `rewrite_hook_command`, timeouts are normalized from `timeout` or `timeoutSec` via `json_u64`, status messages are rewritten with `rewrite_external_agent_terms`, and accepted hooks are appended under the event name in `hooks_payload`, preserving optional `matcher` only for events listed in `HOOK_EVENT_NAMES_WITH_MATCHERS`.

**Call relations**: This helper is called by `hook_migration` and is the main policy gate for hook compatibility. It delegates command-path rewriting and terminology rewriting to specialized helpers.

*Call graph*: calls 2 internal fn (rewrite_external_agent_terms, rewrite_hook_command); called by 3 (hook_migration, hook_migration_drops_negative_timeouts, hook_migration_ignores_unsupported_handlers); 9 external calls (Array, Number, Object, String, get, entry, new, new, from).


##### `rewrite_hook_command`  (lines 662–677)

```
fn rewrite_hook_command(command: &str, target_config_dir: Option<&Path>) -> String
```

**Purpose**: Rewrites shell command strings so references to source hook scripts point at the migrated hooks directory in the target config tree. It avoids rewriting commands that appear Windows-specific or when no target config directory is available.

**Data flow**: If `target_config_dir` is `None`, it returns the original command. If `looks_like_windows_hook_command` is true, it also returns the original command. Otherwise it computes the source hooks path under the external-agent config dir and the target migrated hooks dir, then applies `replace_quoted_hook_paths` for single-quoted and double-quoted segments followed by `replace_unquoted_hook_paths` for bare shell paths, returning the rewritten string.

**Call relations**: This function is called from `append_convertible_hook_groups` when converting command hooks. It orchestrates the lower-level quoted and unquoted path replacement helpers.

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

**Purpose**: Finds quoted substrings in a shell command and rewrites any embedded source hook path inside those quoted segments to a quoted target hook path. It preserves unrelated quoted content.

**Data flow**: It scans the mutable command string for matching quote pairs of the specified quote character, extracts each quoted content slice, searches that content for `source_hooks_path`, and if found computes a replacement via `target_hook_path_replacement` using the suffix after the source hooks prefix. Successful replacements replace the entire quoted segment and advance the search cursor; unsupported cases are skipped.

**Call relations**: This helper is used by `rewrite_hook_command` twice, once for single quotes and once for double quotes. It delegates safety checks and final quoting to `target_hook_path_replacement`.

*Call graph*: calls 1 internal fn (target_hook_path_replacement); called by 1 (rewrite_hook_command).


##### `replace_unquoted_hook_paths`  (lines 713–744)

```
fn replace_unquoted_hook_paths(
    command: &str,
    source_hooks_path: &str,
    target_hooks_dir: &Path,
) -> String
```

**Purpose**: Rewrites unquoted shell path tokens that reference source hook scripts into quoted target hook paths. It avoids touching assignment values and unsupported dynamic path forms.

**Data flow**: It repeatedly locates an unquoted occurrence of `source_hooks_path` with `find_unquoted_source_hook_path`, expands that occurrence to token boundaries using `shell_path_start` and `shell_path_end`, skips it if `is_assignment_value_start` says the token begins immediately after `=`, and otherwise passes the full token plus suffix into `target_hook_path_replacement`. Successful replacements update the command string in place and move the search cursor past the inserted text.

**Call relations**: This helper is the final rewrite pass in `rewrite_hook_command`, handling bare paths not enclosed in quotes. It relies on several shell-token boundary helpers to avoid rewriting inside quoted strings or shell syntax.

*Call graph*: calls 5 internal fn (find_unquoted_source_hook_path, is_assignment_value_start, shell_path_end, shell_path_start, target_hook_path_replacement); called by 1 (rewrite_hook_command).


##### `find_unquoted_source_hook_path`  (lines 746–781)

```
fn find_unquoted_source_hook_path(
    command: &str,
    source_hooks_path: &str,
    start: usize,
) -> Option<usize>
```

**Purpose**: Searches a shell command for the next occurrence of the source hooks path that is not inside single or double quotes. It also respects backslash escaping outside single quotes.

**Data flow**: Starting at `start`, it iterates character indices while tracking `in_single_quote`, `in_double_quote`, and `escaped` state. When outside both quote modes and the remaining substring starts with `source_hooks_path`, it returns that byte index; otherwise it returns `None` after scanning the rest of the string.

**Call relations**: This scanner is used by `replace_unquoted_hook_paths` to find candidate path occurrences that are safe to treat as bare shell tokens.

*Call graph*: called by 1 (replace_unquoted_hook_paths).


##### `is_pure_shell_path_content`  (lines 783–787)

```
fn is_pure_shell_path_content(content: &str, source_hooks_start: usize) -> bool
```

**Purpose**: Checks whether the portion of a candidate string before the source hooks path looks like a plain shell path prefix rather than arbitrary command text. It is a safety filter for path rewriting.

**Data flow**: It slices `content[..source_hooks_start]` as the prefix and returns true only when that prefix is empty, exactly `./`, or ends with `/`, and contains no shell path boundary characters.

**Call relations**: This predicate is used by `target_hook_path_replacement` to reject replacements where the source hooks path appears embedded in a larger token or expression.

*Call graph*: called by 1 (target_hook_path_replacement).


##### `shell_path_start`  (lines 789–795)

```
fn shell_path_start(command: &str, end: usize) -> usize
```

**Purpose**: Finds the byte index where the current shell path token begins, scanning backward from a known interior position. It treats whitespace and shell metacharacters as token boundaries.

**Data flow**: It iterates character indices in `command[..end]`, keeps the last position immediately after any boundary character recognized by `is_shell_path_boundary`, and returns that position or `0` if no boundary exists.

**Call relations**: This helper is used by `replace_unquoted_hook_paths` to expand a found source hooks substring to the full token that should be replaced.

*Call graph*: called by 1 (replace_unquoted_hook_paths).


##### `shell_path_end`  (lines 797–813)

```
fn shell_path_end(command: &str, start: usize) -> usize
```

**Purpose**: Finds the byte index where a shell path token ends, scanning forward while honoring backslash escapes. It stops at whitespace or shell metacharacters.

**Data flow**: Starting at `start`, it iterates characters, toggling an `escaped` flag on backslashes. The first unescaped character for which `is_shell_path_boundary` is true terminates the token and yields its end index; otherwise the function returns `command.len()`.

**Call relations**: This helper pairs with `shell_path_start` inside `replace_unquoted_hook_paths` to isolate the exact token containing a source hook path.

*Call graph*: calls 1 internal fn (is_shell_path_boundary); called by 1 (replace_unquoted_hook_paths).


##### `is_shell_path_boundary`  (lines 815–817)

```
fn is_shell_path_boundary(ch: char) -> bool
```

**Purpose**: Defines which characters terminate or separate shell path tokens for the rewrite logic. The set includes whitespace and common shell operators.

**Data flow**: It returns true when the character is whitespace or one of `= ; | & < > ( )`, otherwise false.

**Call relations**: This low-level predicate is used by `shell_path_end` and indirectly by `shell_path_start`/`is_pure_shell_path_content` to keep path rewriting token-aware.

*Call graph*: called by 1 (shell_path_end); 1 external calls (matches!).


##### `is_assignment_value_start`  (lines 819–824)

```
fn is_assignment_value_start(command: &str, path_start: usize) -> bool
```

**Purpose**: Detects whether a candidate unquoted path token begins immediately after `=` in shell syntax. Such tokens are skipped to avoid rewriting assignment values.

**Data flow**: It inspects the last character before `path_start` in `command[..path_start]` and returns true only if that character is `=`.

**Call relations**: This guard is used by `replace_unquoted_hook_paths` to avoid changing environment-variable assignments or similar shell constructs.

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

**Purpose**: Builds the final quoted replacement path for a migrated hook script when the source path occurrence is safe and static enough to rewrite. It rejects dynamic or ambiguous suffixes.

**Data flow**: It receives the target hooks directory, the original path/token, the byte offset where the source hooks path begins, and the suffix after that prefix. If `is_pure_shell_path_content` and `is_static_hook_path_suffix` both succeed, it joins `target_hooks_dir` with `suffix`, converts the path lossily to string, shell-quotes it with `shell_single_quote`, and returns `Some(replacement)`; otherwise `None`.

**Call relations**: This helper is called by both quoted and unquoted path replacement routines. It centralizes the safety checks that determine whether a source hook path can be rewritten mechanically.

*Call graph*: calls 3 internal fn (is_pure_shell_path_content, is_static_hook_path_suffix, shell_single_quote); called by 2 (replace_quoted_hook_paths, replace_unquoted_hook_paths); 1 external calls (join).


##### `is_static_hook_path_suffix`  (lines 841–846)

```
fn is_static_hook_path_suffix(suffix: &str) -> bool
```

**Purpose**: Checks whether the script path suffix after the source hooks directory is a literal static path segment sequence. It rejects shell metacharacters and expansion syntax.

**Data flow**: It returns true only when `suffix` is non-empty and contains none of `\`, `$`, `` ` ``, `*`, `?`, `[`, `{`, or `}`.

**Call relations**: This predicate is used by `target_hook_path_replacement` to ensure only simple script paths are rewritten.

*Call graph*: called by 1 (target_hook_path_replacement).


##### `looks_like_windows_hook_command`  (lines 848–857)

```
fn looks_like_windows_hook_command(command: &str) -> bool
```

**Purpose**: Heuristically detects hook commands that appear to use Windows path or environment-variable conventions. Such commands are left untouched by path rewriting.

**Data flow**: It constructs a backslash-based source hooks path and the uppercase project-dir env var name, then returns true if the command contains that backslash path, `%ENVVAR%`, or `$env:ENVVAR` syntax.

**Call relations**: This guard is checked at the start of `rewrite_hook_command` to avoid applying Unix-shell rewrite rules to likely Windows commands.

*Call graph*: calls 1 internal fn (external_agent_project_dir_env_var); called by 1 (rewrite_hook_command); 1 external calls (format!).


##### `shell_single_quote`  (lines 859–861)

```
fn shell_single_quote(value: &str) -> String
```

**Purpose**: Produces a shell-safe single-quoted string literal, escaping embedded single quotes using the standard shell idiom. It is used for rewritten hook paths.

**Data flow**: It takes an arbitrary string, replaces each `'` with `'\''`, wraps the result in outer single quotes, and returns the formatted string.

**Call relations**: This helper is called by `target_hook_path_replacement` and also exercised by test helpers that construct expected migrated commands.

*Call graph*: called by 1 (target_hook_path_replacement); 1 external calls (format!).


##### `copy_hook_scripts`  (lines 863–870)

```
fn copy_hook_scripts(source_external_agent_dir: &Path, target_config_dir: &Path) -> io::Result<()>
```

**Purpose**: Copies the source hooks directory into the target migrated hooks subdirectory without overwriting existing files. If the source hooks directory does not exist, it does nothing.

**Data flow**: It joins `source_external_agent_dir` with the source hooks subdir constant, returns early if that directory is absent, computes the target migrated hooks directory under `target_config_dir`, and delegates recursive copying to `copy_dir_recursive_skip_existing`.

**Call relations**: This helper is called by `import_hooks` after a non-empty migration is found and before writing `hooks.json`, ensuring referenced scripts are available.

*Call graph*: calls 1 internal fn (copy_dir_recursive_skip_existing); called by 2 (import_hooks, hook_script_copy_keeps_existing_target_scripts); 1 external calls (join).


##### `copy_dir_recursive_skip_existing`  (lines 872–886)

```
fn copy_dir_recursive_skip_existing(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Recursively copies a directory tree while preserving any files already present at the destination. It creates destination directories as needed.

**Data flow**: It creates `target`, iterates `fs::read_dir(source)`, and for each entry either recurses into subdirectories or copies regular files only when the corresponding `target_path` does not already exist. It returns `Ok(())` after traversing the tree.

**Call relations**: This is the low-level filesystem copier used by `copy_hook_scripts`. Its skip-existing behavior is part of the migration’s non-destructive design.

*Call graph*: called by 1 (copy_hook_scripts); 4 external calls (join, copy, create_dir_all, read_dir).


##### `agent_source_files`  (lines 888–909)

```
fn agent_source_files(source_agents: &Path) -> io::Result<Vec<PathBuf>>
```

**Purpose**: Lists source markdown files that are candidates for subagent migration. It excludes non-files, non-`.md` files, and `README.md`.

**Data flow**: If `source_agents` is not a directory, it returns an empty vector. Otherwise it reads the directory, filters entries to regular files with `.md` extension whose stem is not `README`, collects their paths, sorts them, and returns the sorted list.

**Call relations**: This helper is shared by `missing_subagent_names` and `import_subagents` so both operations see the same ordered candidate set.

*Call graph*: called by 2 (import_subagents, missing_subagent_names); 3 external calls (is_dir, new, read_dir).


##### `subagent_target_file`  (lines 911–913)

```
fn subagent_target_file(source_file: &Path, target_agents: &Path) -> Option<PathBuf>
```

**Purpose**: Maps a source markdown agent file to its target TOML filename in the target agents directory. It preserves dotted file stems.

**Data flow**: It extracts the source file stem as UTF-8 text, formats `<stem>.toml`, joins that name onto `target_agents`, and returns `Some(PathBuf)`; if the stem is unavailable or non-UTF-8, it returns `None`.

**Call relations**: This path-mapping helper is used by both `missing_subagent_names` and `import_subagents` to keep existence checks and writes aligned.

*Call graph*: called by 2 (import_subagents, missing_subagent_names); 2 external calls (join, format!).


##### `command_source_files`  (lines 915–920)

```
fn command_source_files(source_commands: &Path) -> io::Result<Vec<PathBuf>>
```

**Purpose**: Collects all markdown files under the source commands tree, including nested directories, in sorted order. It is the raw file discovery step for command migration.

**Data flow**: It initializes an empty vector, fills it recursively via `collect_markdown_files`, sorts the resulting paths, and returns them.

**Call relations**: This helper is used only by `unique_supported_command_sources`, which adds parsing, support checks, and deduplication on top of the raw file list.

*Call graph*: calls 1 internal fn (collect_markdown_files); called by 1 (unique_supported_command_sources); 1 external calls (new).


##### `unique_supported_command_sources`  (lines 922–942)

```
fn unique_supported_command_sources(source_commands: &Path) -> io::Result<Vec<(PathBuf, String)>>
```

**Purpose**: Finds command markdown files that are supported for migration and have a unique resulting skill slug. Any slug collision causes all sources for that slug to be dropped.

**Data flow**: It iterates sorted markdown files from `command_source_files`, parses each with `parse_document`, computes an optional supported skill name via `command_skill_name_if_supported`, and groups source paths by that name in a `BTreeMap<String, Vec<PathBuf>>`. It then keeps only entries whose grouped source list has exactly one file, returning `(source_file, name)` pairs.

**Call relations**: This helper feeds both `missing_command_names` and `import_commands`. It centralizes support filtering and collision handling so downstream code can assume each skill name is unique.

*Call graph*: calls 3 internal fn (command_skill_name_if_supported, command_source_files, parse_document); called by 2 (import_commands, missing_command_names); 1 external calls (new).


##### `collect_markdown_files`  (lines 944–961)

```
fn collect_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) -> io::Result<()>
```

**Purpose**: Recursively traverses a directory tree and appends every `.md` file path to a caller-provided vector. Missing or non-directory roots are treated as empty.

**Data flow**: If `dir` is not a directory, it returns immediately. Otherwise it reads entries, recurses into subdirectories, and pushes regular files whose extension is exactly `md` into `files`.

**Call relations**: This recursive collector is the implementation behind `command_source_files`.

*Call graph*: called by 1 (command_source_files); 2 external calls (is_dir, read_dir).


##### `parse_document`  (lines 963–966)

```
fn parse_document(source_file: &Path) -> io::Result<ParsedDocument>
```

**Purpose**: Reads a markdown file from disk and parses its optional YAML frontmatter plus body into a `ParsedDocument`. It is the file-based wrapper around content parsing.

**Data flow**: It reads the entire file as a string with `fs::read_to_string`, passes that content to `parse_document_content`, and returns the resulting `ParsedDocument`.

**Call relations**: This helper is used throughout subagent and command migration wherever a source markdown file must be interpreted.

*Call graph*: calls 1 internal fn (parse_document_content); called by 4 (import_commands, import_subagents, missing_subagent_names, unique_supported_command_sources); 1 external calls (read_to_string).


##### `parse_document_content`  (lines 968–995)

```
fn parse_document_content(content: &str) -> ParsedDocument
```

**Purpose**: Parses a markdown document that may begin with YAML frontmatter delimited by `---`. If no valid frontmatter block is found, it treats the whole content as body text.

**Data flow**: It first checks for a leading `---\n` or `---\r\n`. Without that prefix, it returns a `ParsedDocument` with empty frontmatter, the original content as body, and no frontmatter error. If the prefix exists, it locates the closing delimiter with `frontmatter_end`; failure again falls back to treating the whole content as body. On success it slices out the raw frontmatter and body, parses the frontmatter with `parse_frontmatter`, and returns a `ParsedDocument` containing the parsed map, body string, and any parse error.

**Call relations**: This parser is called by `parse_document` and directly by tests. It delegates delimiter detection and YAML conversion to `frontmatter_end` and `parse_frontmatter`.

*Call graph*: calls 2 internal fn (frontmatter_end, parse_frontmatter); called by 8 (parse_document, command_skill_names_must_fit_codex_skill_loader_limit, commands_with_provider_runtime_expansion_are_skipped, commands_without_description_are_skipped, frontmatter_accepts_crlf_delimiters, subagent_accepts_yaml_block_lists_by_ignoring_unsupported_fields, subagent_preserves_default_model_when_source_model_is_present, subagent_requires_minimum_codex_agent_fields); 1 external calls (new).


##### `frontmatter_end`  (lines 997–1009)

```
fn frontmatter_end(rest: &str) -> Option<(usize, usize)>
```

**Purpose**: Finds the earliest valid closing frontmatter delimiter after the opening `---`. It supports both LF and CRLF combinations.

**Data flow**: It searches the remaining content for several delimiter variants such as `\n---\n`, `\r\n---\r\n`, and trailing-end forms, maps each match to `(end, body_start)`, and returns the match with the smallest `end` index.

**Call relations**: This helper is used only by `parse_document_content` to split frontmatter from body while tolerating mixed newline styles.

*Call graph*: called by 1 (parse_document_content).


##### `parse_frontmatter`  (lines 1011–1034)

```
fn parse_frontmatter(
    raw_frontmatter: &str,
) -> (BTreeMap<String, FrontmatterValue>, Option<String>)
```

**Purpose**: Parses raw YAML frontmatter into a normalized `BTreeMap<String, FrontmatterValue>` and captures any parse error as a string. Only YAML mappings are accepted as valid frontmatter.

**Data flow**: It deserializes `raw_frontmatter` with `serde_yaml::from_str`; parse failure returns an empty map plus `Some(error_string)`. If the parsed YAML is not a mapping, it returns an empty map plus a fixed error message. Otherwise it iterates mapping entries, keeps only non-empty string keys, converts each value with `frontmatter_value_from_yaml`, inserts them into a `BTreeMap`, and returns that map with `None` error.

**Call relations**: This helper is called by `parse_document_content` and provides the normalized frontmatter representation consumed by metadata extraction and command description logic.

*Call graph*: calls 1 internal fn (frontmatter_value_from_yaml); called by 1 (parse_document_content); 2 external calls (new, from_str).


##### `frontmatter_value_from_yaml`  (lines 1036–1045)

```
fn frontmatter_value_from_yaml(value: &YamlValue) -> FrontmatterValue
```

**Purpose**: Converts a YAML value into the simplified frontmatter value model used by migration. Scalars become trimmed strings; complex YAML structures are marked unsupported.

**Data flow**: String, bool, and number YAML values are converted into `FrontmatterValue::Scalar` using trimmed or stringified text. Nulls, sequences, mappings, and tagged values become `FrontmatterValue::Other`.

**Call relations**: This conversion helper is used by `parse_frontmatter` so later code can uniformly query scalar frontmatter fields and ignore unsupported structured values.

*Call graph*: called by 1 (parse_frontmatter); 3 external calls (to_string, trim, Scalar).


##### `agent_metadata`  (lines 1047–1071)

```
fn agent_metadata(document: &ParsedDocument) -> Option<AgentMetadata>
```

**Purpose**: Extracts the minimum metadata required to migrate a markdown document into a subagent TOML file. Documents with frontmatter errors, empty bodies, or missing required fields are rejected.

**Data flow**: It reads a `ParsedDocument`, immediately returns `None` if `frontmatter_error` is present or the trimmed body is empty, then extracts non-empty scalar `name` and `description` from frontmatter. Optional `permissionMode` and `effort` are fetched via `frontmatter_string`, and the function returns `Some(AgentMetadata { ... })` only when required fields are present.

**Call relations**: This helper is used by both subagent discovery and import paths, ensuring they agree on what counts as a valid migratable agent.

*Call graph*: calls 1 internal fn (frontmatter_string); called by 3 (import_subagents, missing_subagent_names, subagent_preserves_default_model_when_source_model_is_present).


##### `render_agent_toml`  (lines 1073–1106)

```
fn render_agent_toml(body: &str, metadata: &AgentMetadata) -> io::Result<String>
```

**Purpose**: Renders migrated subagent metadata and instructions into the target TOML format. It rewrites source-tool terminology and maps selected source metadata into target-specific fields.

**Data flow**: It builds a TOML table containing `name`, rewritten `description`, optional `model_reasoning_effort` from `map_agent_reasoning_effort`, optional `sandbox_mode` from `map_agent_permission_mode`, and `developer_instructions` from `render_agent_body`. It serializes the table with `toml::to_string_pretty`, converts serialization failures into `invalid_data_error`, trims trailing whitespace from the serialized output, appends a final newline, and returns the string.

**Call relations**: This renderer is called by `import_subagents` after metadata extraction succeeds. It delegates body normalization and terminology rewriting to `render_agent_body` and `rewrite_external_agent_terms`.

*Call graph*: calls 3 internal fn (map_agent_reasoning_effort, render_agent_body, rewrite_external_agent_terms); called by 2 (import_subagents, subagent_preserves_default_model_when_source_model_is_present); 5 external calls (String, Table, format!, new, to_string_pretty).


##### `render_agent_body`  (lines 1108–1115)

```
fn render_agent_body(body: &str) -> String
```

**Purpose**: Normalizes the markdown body used as subagent developer instructions. Empty bodies are replaced with a fallback sentence after trimming and terminology rewriting.

**Data flow**: It trims the input body, rewrites external-agent terms via `rewrite_external_agent_terms`, and returns either the rewritten body or the fixed string `No subagent instructions were found.` when the result is empty.

**Call relations**: This helper is used only by `render_agent_toml` to populate the `developer_instructions` field.

*Call graph*: calls 1 internal fn (rewrite_external_agent_terms); called by 1 (render_agent_toml).


##### `command_skill_name`  (lines 1117–1122)

```
fn command_skill_name(source_commands: &Path, source_file: &Path) -> String
```

**Purpose**: Derives the target skill slug for a source command file from its relative path. It prefixes the source-derived name and slugifies the result.

**Data flow**: It computes a source name with `command_source_name`, prepends the command skill prefix constant, formats the combined string, passes it to `slugify_name`, and returns the slug.

**Call relations**: This helper is used by `command_skill_name_if_supported` after a command has passed basic eligibility checks.

*Call graph*: calls 1 internal fn (slugify_name); called by 1 (command_skill_name_if_supported); 1 external calls (format!).


##### `command_skill_name_if_supported`  (lines 1124–1145)

```
fn command_skill_name_if_supported(
    source_commands: &Path,
    source_file: &Path,
    document: &ParsedDocument,
) -> Option<String>
```

**Purpose**: Determines whether a parsed command document can be migrated and, if so, returns its target skill slug. It enforces README exclusion, description presence, length limits, and template-feature restrictions.

**Data flow**: It rejects files whose stem is `README`, derives a source name with `command_source_name`, extracts a description with `command_skill_description`, computes the slug with `command_skill_name`, rejects names longer than `MAX_SKILL_NAME_LEN`, descriptions longer than `MAX_SKILL_DESCRIPTION_LEN`, and bodies flagged by `has_unsupported_command_template_features`, and otherwise returns `Some(name)`.

**Call relations**: This support gate is called by `unique_supported_command_sources` for every parsed command file. It combines several lower-level checks into a single yes/no decision.

*Call graph*: calls 4 internal fn (command_skill_description, command_skill_name, command_source_name, has_unsupported_command_template_features); called by 1 (unique_supported_command_sources); 1 external calls (file_stem).


##### `command_skill_description`  (lines 1147–1154)

```
fn command_skill_description(document: &ParsedDocument, _source_name: &str) -> Option<String>
```

**Purpose**: Extracts the command description from frontmatter when it is present as a non-empty scalar string. The `_source_name` parameter is currently unused.

**Data flow**: It reads `document.frontmatter["description"]`, converts it through `FrontmatterValue::as_scalar`, filters out blank strings, clones the value, and returns it as `Option<String>`.

**Call relations**: This helper is used both during support checks in `command_skill_name_if_supported` and during actual import in `import_commands`.

*Call graph*: called by 2 (command_skill_name_if_supported, import_commands).


##### `command_source_name`  (lines 1156–1165)

```
fn command_source_name(source_commands: &Path, source_file: &Path) -> String
```

**Purpose**: Builds a stable source command identifier from the command file’s path relative to the commands root. Nested directories are flattened with `-` separators and the extension is removed.

**Data flow**: It strips `source_commands` from `source_file` when possible, removes the extension, converts each path component to UTF-8 text, joins components with `-`, and returns the resulting string.

**Call relations**: This helper feeds both skill naming and rendered documentation so migrated skills can refer back to the original command path.

*Call graph*: called by 2 (command_skill_name_if_supported, import_commands); 1 external calls (strip_prefix).


##### `render_command_skill`  (lines 1167–1179)

```
fn render_command_skill(body: &str, name: &str, description: &str, source_name: &str) -> String
```

**Purpose**: Renders a migrated command as a `SKILL.md` document with YAML frontmatter and explanatory body text. It rewrites source-tool terminology in both description and template body.

**Data flow**: It trims and rewrites the command body with `rewrite_external_agent_terms`, substitutes `No command template body was found.` when empty, YAML-quotes the skill name and rewritten description with `yaml_string`, and formats the final markdown document including a heading, usage sentence referencing `source_name`, and a `## Command Template` section.

**Call relations**: This renderer is called by `import_commands` after a command has been deemed supported and a target directory has been created.

*Call graph*: calls 1 internal fn (rewrite_external_agent_terms); called by 1 (import_commands); 1 external calls (format!).


##### `has_unsupported_command_template_features`  (lines 1181–1190)

```
fn has_unsupported_command_template_features(template: &str) -> bool
```

**Purpose**: Detects command template constructs that the migration cannot faithfully represent as a Codex skill. Any detected feature causes the command to be skipped.

**Data flow**: It checks the template string for `$ARGUMENTS`, numbered placeholders via `contains_numbered_argument_placeholder`, paired `{{` and `}}`, shell execution markers `!`` or `! ``, and any whitespace-delimited token beginning with `@` followed by non-empty text. It returns true if any such pattern is present.

**Call relations**: This predicate is used by `command_skill_name_if_supported` as part of command eligibility filtering.

*Call graph*: calls 1 internal fn (contains_numbered_argument_placeholder); called by 1 (command_skill_name_if_supported).


##### `contains_numbered_argument_placeholder`  (lines 1192–1197)

```
fn contains_numbered_argument_placeholder(template: &str) -> bool
```

**Purpose**: Detects `$1`, `$2`, and similar numbered shell argument placeholders in a template. It is a byte-level scan for a dollar sign followed by an ASCII digit.

**Data flow**: It views the template as bytes, slides a two-byte window across it, and returns true when any window matches `b'$'` followed by an ASCII digit.

**Call relations**: This helper is called only by `has_unsupported_command_template_features`.

*Call graph*: called by 1 (has_unsupported_command_template_features).


##### `frontmatter_string`  (lines 1199–1207)

```
fn frontmatter_string(
    frontmatter: &BTreeMap<String, FrontmatterValue>,
    key: &str,
) -> Option<String>
```

**Purpose**: Fetches a scalar frontmatter field by key and clones it into an owned string. Non-scalar or missing values yield `None`.

**Data flow**: It looks up `key` in the `BTreeMap<String, FrontmatterValue>`, calls `FrontmatterValue::as_scalar`, clones the string when present, and returns `Option<String>`.

**Call relations**: This helper is used by `agent_metadata` for optional fields like `permissionMode` and `effort`.

*Call graph*: called by 1 (agent_metadata).


##### `map_agent_reasoning_effort`  (lines 1209–1219)

```
fn map_agent_reasoning_effort(effort: &str) -> Option<String>
```

**Purpose**: Maps source agent reasoning-effort values into the target system’s accepted vocabulary. Unsupported values are dropped.

**Data flow**: It rewrites `max` to `xhigh`, leaves other strings unchanged, then returns `Some(mapped)` only if the result is one of `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; otherwise it returns `None`.

**Call relations**: This mapper is used by `render_agent_toml` when deciding whether to emit `model_reasoning_effort`.

*Call graph*: called by 1 (render_agent_toml); 1 external calls (matches!).


##### `map_agent_permission_mode`  (lines 1221–1227)

```
fn map_agent_permission_mode(permission_mode: &str) -> Option<&'static str>
```

**Purpose**: Maps source permission mode strings into target sandbox mode names. Unknown modes are ignored.

**Data flow**: It matches `acceptEdits` to `workspace-write`, `readOnly` to `read-only`, and returns `None` for any other input.

**Call relations**: This mapper is used by `render_agent_toml` to populate `sandbox_mode` only when the source mode has a known equivalent.


##### `json_string_vec`  (lines 1229–1234)

```
fn json_string_vec(value: &JsonValue) -> Vec<String>
```

**Purpose**: Normalizes a JSON value into a vector of strings, accepting either a scalar-like value or an array of scalar-like values. Objects and nested arrays are ignored at the element level.

**Data flow**: If the input is a `JsonValue::Array`, it iterates elements and keeps only those for which `json_string` returns `Some`. Otherwise it calls `json_string` once and collects the optional result into a one-element-or-empty vector.

**Call relations**: This helper is used when reading MCP settings lists and command args so callers can accept both scalar and array JSON forms.

*Call graph*: calls 1 internal fn (json_string); called by 1 (mcp_server_toml_table).


##### `json_string`  (lines 1236–1244)

```
fn json_string(value: &JsonValue) -> Option<String>
```

**Purpose**: Converts simple JSON scalar values into strings. Complex JSON values are treated as non-stringable for migration purposes.

**Data flow**: It returns `None` for `Null`, clones strings unchanged, stringifies booleans and numbers with `to_string`, and returns `None` for arrays and objects.

**Call relations**: This helper underlies `json_string_vec`, `append_env_config`, and `append_header_config`.

*Call graph*: called by 3 (append_env_config, append_header_config, json_string_vec); 2 external calls (clone, to_string).


##### `json_u64`  (lines 1246–1251)

```
fn json_u64(value: &JsonValue) -> Option<u64>
```

**Purpose**: Extracts an unsigned integer from JSON, accepting either a numeric value or a numeric string. Booleans and null are explicitly rejected.

**Data flow**: It first returns `None` for boolean or null values, then tries `as_u64()`, and if that fails tries parsing `as_str()?` as an integer.

**Call relations**: This helper is used by `append_convertible_hook_groups` to normalize hook timeout fields from either numeric or string JSON.

*Call graph*: 3 external calls (as_u64, is_boolean, is_null).


##### `yaml_string`  (lines 1253–1255)

```
fn yaml_string(value: &str) -> String
```

**Purpose**: Escapes a string for simple double-quoted YAML emission. It handles backslashes and double quotes.

**Data flow**: It replaces `\` with `\\`, replaces `"` with `\"`, wraps the result in double quotes, and returns the formatted string.

**Call relations**: This helper is used by `render_command_skill` when emitting YAML frontmatter fields.

*Call graph*: 1 external calls (format!).


##### `slugify_name`  (lines 1257–1276)

```
fn slugify_name(value: &str) -> String
```

**Purpose**: Converts an arbitrary string into a lowercase dash-separated slug suitable for skill names. Runs of non-alphanumeric characters collapse to a single dash.

**Data flow**: It iterates characters, appending lowercase ASCII alphanumerics directly and inserting at most one dash between non-alphanumeric runs. After trimming leading/trailing dashes, it returns the slug or the fallback `migrated` if the slug is empty.

**Call relations**: This helper is used by `command_skill_name` to derive stable target skill directory names.

*Call graph*: called by 1 (command_skill_name); 1 external calls (new).


##### `FrontmatterValue::as_scalar`  (lines 1279–1284)

```
fn as_scalar(&self) -> Option<&str>
```

**Purpose**: Returns the inner string for scalar frontmatter values and hides unsupported structured values. It is the main accessor used by metadata extraction code.

**Data flow**: It matches on `self`, returning `Some(&str)` for `FrontmatterValue::Scalar(value)` and `None` for `FrontmatterValue::Other`.

**Call relations**: This method is used throughout frontmatter consumers such as `agent_metadata`, `command_skill_description`, and `frontmatter_string`.


##### `is_missing_or_empty_text_file`  (lines 1287–1296)

```
fn is_missing_or_empty_text_file(path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether a path is absent or is a text file whose contents are blank after trimming. Non-file existing paths are treated as not empty.

**Data flow**: It returns `true` if the path does not exist, `false` if it exists but is not a file, and otherwise reads the file as UTF-8 text and returns whether `trim()` is empty.

**Call relations**: This helper is used by `import_hooks` to decide whether it is safe to create or replace the active hooks file.

*Call graph*: called by 1 (import_hooks); 3 external calls (exists, is_file, read_to_string).


##### `rewrite_external_agent_terms`  (lines 1298–1308)

```
fn rewrite_external_agent_terms(content: &str) -> String
```

**Purpose**: Rewrites source-tool terminology in free-form text to target-system terminology. It also renames the source documentation filename to `AGENTS.md`.

**Data flow**: It first replaces case-insensitive whole-word occurrences of the source doc filename with `AGENTS.md`, then iterates the variants returned by `external_agent_term_variants` and replaces each whole-word occurrence with `Codex`, returning the fully rewritten string.

**Call relations**: This text-normalization helper is used when rendering migrated agents, commands, and hook status messages so user-facing text no longer references the source tool.

*Call graph*: calls 3 internal fn (external_agent_doc_file_name, external_agent_term_variants, replace_case_insensitive_with_boundaries); called by 4 (append_convertible_hook_groups, render_agent_body, render_agent_toml, render_command_skill).


##### `replace_case_insensitive_with_boundaries`  (lines 1310–1347)

```
fn replace_case_insensitive_with_boundaries(
    input: &str,
    needle: &str,
    replacement: &str,
) -> String
```

**Purpose**: Performs case-insensitive substring replacement only when the match is bounded by non-word characters or string edges. It avoids replacing embedded fragments inside larger identifiers.

**Data flow**: It lowercases both `input` and `needle`, scans for occurrences of the lowercase needle, checks byte-level word boundaries using `is_word_byte`, appends untouched spans and `replacement` into a preallocated output string for accepted matches, and returns either the original input unchanged when no replacements were emitted or the constructed output otherwise.

**Call relations**: This helper is the engine behind `rewrite_external_agent_terms`, providing boundary-aware replacements for filenames and product-name variants.

*Call graph*: calls 1 internal fn (is_word_byte); called by 1 (rewrite_external_agent_terms); 1 external calls (with_capacity).


##### `is_word_byte`  (lines 1349–1351)

```
fn is_word_byte(byte: u8) -> bool
```

**Purpose**: Defines which ASCII bytes count as word characters for boundary-aware text replacement. Letters, digits, and underscore are considered word bytes.

**Data flow**: It returns true when the byte is ASCII alphanumeric or `_`, otherwise false.

**Call relations**: This low-level predicate is used only by `replace_case_insensitive_with_boundaries`.

*Call graph*: called by 1 (replace_case_insensitive_with_boundaries).


##### `invalid_data_error`  (lines 1353–1355)

```
fn invalid_data_error(message: impl Into<String>) -> io::Error
```

**Purpose**: Constructs an `io::Error` with kind `InvalidData` from an arbitrary message. It standardizes migration parse/serialization failures under one error kind.

**Data flow**: It converts the input message into a `String` and returns `io::Error::new(io::ErrorKind::InvalidData, ...)`.

**Call relations**: This helper is used where migration logic needs to surface malformed input or serialization failures as `io::Result` errors, such as in `import_hooks` and JSON/TOML parsing paths.

*Call graph*: called by 1 (import_hooks); 2 external calls (into, new).


##### `external_agent_config_dir`  (lines 1357–1359)

```
fn external_agent_config_dir() -> String
```

**Purpose**: Returns the dot-directory name used by the source external-agent tool inside a repository. It is derived from the source tool name constant.

**Data flow**: It formats and returns `.{SOURCE_EXTERNAL_AGENT_NAME}` as a `String`.

**Call relations**: This naming helper is used by hook path rewriting and tests that construct source paths.

*Call graph*: called by 4 (hook_script_copy_keeps_existing_target_scripts, mcp_migration_preserves_repo_servers_over_home_project_entries, mcp_migration_reads_matching_project_entries_from_home_external_project_config, source_path); 1 external calls (format!).


##### `external_agent_project_config_file`  (lines 1361–1363)

```
fn external_agent_project_config_file() -> String
```

**Purpose**: Returns the filename of the source tool’s project-level JSON config. It is used when searching for MCP project configuration.

**Data flow**: It formats and returns `.{SOURCE_EXTERNAL_AGENT_NAME}.json` as a `String`.

**Call relations**: This helper is used by MCP config readers and related tests to locate the project config file consistently.

*Call graph*: called by 4 (read_external_mcp_servers, mcp_migration_preserves_repo_servers_over_home_project_entries, mcp_migration_reads_matching_project_entries_from_home_external_project_config, mcp_migration_reads_matching_project_entries_from_repo_external_project_config); 1 external calls (format!).


##### `external_agent_project_dir_env_var`  (lines 1365–1370)

```
fn external_agent_project_dir_env_var() -> String
```

**Purpose**: Returns the uppercase environment variable name representing the source tool’s project directory. It is used mainly for Windows-command detection and tests.

**Data flow**: It uppercases `SOURCE_EXTERNAL_AGENT_NAME`, appends `_PROJECT_DIR`, and returns the resulting string.

**Call relations**: This helper is used by `looks_like_windows_hook_command` and test helpers that build source commands containing project-dir env references.

*Call graph*: called by 2 (looks_like_windows_hook_command, hook_command_paths_rewrite_to_target_hook_dir); 1 external calls (format!).


##### `external_agent_doc_file_name`  (lines 1372–1374)

```
fn external_agent_doc_file_name() -> String
```

**Purpose**: Returns the source tool’s documentation filename used in terminology rewriting. It maps the source tool name to `<name>.md`.

**Data flow**: It formats and returns `{SOURCE_EXTERNAL_AGENT_NAME}.md` as a `String`.

**Call relations**: This helper is used by `rewrite_external_agent_terms` before broader product-name replacement.

*Call graph*: called by 1 (rewrite_external_agent_terms); 1 external calls (format!).


##### `external_agent_term_variants`  (lines 1376–1384)

```
fn external_agent_term_variants() -> [String; 5]
```

**Purpose**: Enumerates textual variants of the source tool name that should be rewritten to `Codex`. The list includes spaced, dashed, underscored, concatenated, and bare forms.

**Data flow**: It constructs and returns a fixed `[String; 5]` array containing `<name> code`, `<name>-code`, `<name>_code`, `<name>code`, and `<name>`.

**Call relations**: This helper is consumed by `rewrite_external_agent_terms` to normalize user-facing text across several naming conventions.

*Call graph*: called by 1 (rewrite_external_agent_terms); 1 external calls (format!).


##### `tests::source_path`  (lines 1391–1395)

```
fn source_path(relative_path: &str) -> PathBuf
```

**Purpose**: Builds a test fixture path rooted at `/repo/<external-config-dir>/...`. It keeps test path construction consistent with production naming helpers.

**Data flow**: It joins `/repo`, `external_agent_config_dir()`, and the provided relative path into a `PathBuf` and returns it.

**Call relations**: This test helper is used by multiple tests that need canonical source file paths matching migration expectations.

*Call graph*: calls 1 internal fn (external_agent_config_dir); 1 external calls (new).


##### `tests::source_hook_command`  (lines 1397–1402)

```
fn source_hook_command(script_name: &str) -> String
```

**Purpose**: Constructs a representative source hook command string pointing at a script under the source hooks directory. It is used in hook path rewrite tests.

**Data flow**: It formats `python3 {external_agent_config_dir()}/{EXTERNAL_AGENT_HOOKS_SUBDIR}/{script_name}` and returns the resulting string.

**Call relations**: This helper supports tests that compare original and rewritten hook command strings.

*Call graph*: 1 external calls (format!).


##### `tests::source_hook_command_with_project_dir`  (lines 1404–1410)

```
fn source_hook_command_with_project_dir(script_name: &str) -> String
```

**Purpose**: Constructs a source hook command that includes the source tool’s project-dir environment variable in the path. It exercises rewrite behavior around env-based paths.

**Data flow**: It formats `python3 "${ENVVAR}"/{config-dir}/{hooks-subdir}/{script_name}` using `external_agent_project_dir_env_var()` and returns the string.

**Call relations**: This helper is used by tests covering hook command rewriting edge cases involving project-dir variables.

*Call graph*: 1 external calls (format!).


##### `tests::migrated_hook_command`  (lines 1412–1414)

```
fn migrated_hook_command(script_name: &str) -> String
```

**Purpose**: Returns the expected migrated hook command string for a given script name. It is a thin wrapper around the quoted-path variant.

**Data flow**: It forwards `script_name` to `migrated_quoted_hook_command` and returns that string unchanged.

**Call relations**: This helper simplifies tests that do not care about the distinction between quoted and generic migrated command forms.

*Call graph*: 1 external calls (migrated_quoted_hook_command).


##### `tests::migrated_quoted_hook_command`  (lines 1416–1424)

```
fn migrated_quoted_hook_command(script_name: &str) -> String
```

**Purpose**: Constructs the expected migrated hook command using the target `.codex` hooks directory and shell quoting. It mirrors the production rewrite format.

**Data flow**: It joins `/repo/.codex`, the migrated hooks subdir constant, and `script_name` into a path, shell-quotes that path with `shell_single_quote`, prefixes it with `python3 `, and returns the final string.

**Call relations**: This helper is used by hook rewrite tests to express the exact expected replacement command.

*Call graph*: 2 external calls (new, format!).


##### `tests::env_placeholder_accepts_defaults`  (lines 1427–1432)

```
fn env_placeholder_accepts_defaults()
```

**Purpose**: Verifies that environment placeholders with default syntax still parse to the variable name alone. It documents accepted `${VAR:-default}` behavior.

**Data flow**: It calls `parse_env_placeholder("${TOKEN:-fallback}")` and asserts that the result is `Some("TOKEN".to_string())`.

**Call relations**: This unit test directly exercises `parse_env_placeholder`’s handling of default-value syntax.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mcp_migration_skips_placeholder_args`  (lines 1435–1452)

```
fn mcp_migration_skips_placeholder_args()
```

**Purpose**: Checks that MCP servers whose command args contain unresolved env placeholders are omitted from the migrated TOML. The expected result is an empty table.

**Data flow**: It creates a temp directory, writes a `.mcp.json` containing a server with `args: ["${DATABASE_URL}"]`, invokes `build_mcp_config_from_external`, and asserts that the returned `TomlValue` is an empty table.

**Call relations**: This test validates the placeholder rejection path inside `mcp_server_toml_table`, reached through the public MCP builder.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::mcp_migration_prefers_command_transport_for_mixed_server_config`  (lines 1455–1495)

```
fn mcp_migration_prefers_command_transport_for_mixed_server_config()
```

**Purpose**: Verifies that when a server config contains both `command` and `url`, migration chooses the command/stdio representation. This preserves executable transport over HTTP metadata.

**Data flow**: It writes a temp `.mcp.json` with both command and URL fields, runs `build_mcp_config_from_external`, parses an expected TOML snippet containing only `command` and `args`, and asserts equality.

**Call relations**: This test exercises the branch ordering in `mcp_server_toml_table`, confirming that the command branch wins when both transport styles are present.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::mcp_migration_skips_unsupported_transports`  (lines 1498–1530)

```
fn mcp_migration_skips_unsupported_transports()
```

**Purpose**: Checks that unsupported MCP transport types are dropped while supported HTTP servers with bearer-token env placeholders are converted correctly. It specifically covers `sse` rejection and Authorization header normalization.

**Data flow**: It writes a temp `.mcp.json` containing an `sse` server and an HTTP server with `Authorization: Bearer ${VAULT_TOKEN:-dev-token}`, runs `build_mcp_config_from_external`, parses expected TOML containing only the HTTP server with `bearer_token_env_var`, and asserts equality.

**Call relations**: This test covers transport filtering in `mcp_server_toml_table` and special header handling in `append_header_config`.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::mcp_migration_reads_matching_project_entries_from_repo_external_project_config`  (lines 1533–1578)

```
fn mcp_migration_reads_matching_project_entries_from_repo_external_project_config()
```

**Purpose**: Verifies that repo-local external-agent project config contributes both top-level servers and only the project-scoped servers whose path matches the current repo. Non-matching project entries are ignored.

**Data flow**: It creates temp `repo` and `other` directories, writes a repo-local project config JSON with top-level and per-project `mcpServers`, runs `build_mcp_config_from_external` on the repo path, parses expected TOML containing `repo` and `top` servers only, and asserts equality.

**Call relations**: This test exercises `read_external_mcp_servers`, `project_path_matches_source_root`, and overwrite merging for repo-local project config.

*Call graph*: calls 1 internal fn (external_agent_project_config_file); 5 external calls (assert_eq!, create_dir_all, write, json!, new).


##### `tests::mcp_migration_reads_matching_project_entries_from_home_external_project_config`  (lines 1581–1617)

```
fn mcp_migration_reads_matching_project_entries_from_home_external_project_config()
```

**Purpose**: Checks that when an external-agent home directory is supplied, matching project entries from the home-level project config are imported. It covers the fallback path outside the repo root.

**Data flow**: It creates a temp repo and external-agent home directory, writes a home-level project config JSON at the parent of that home dir, runs `build_mcp_config_from_external` with `Some(&external_agent_home)`, parses expected TOML containing the matching project server, and asserts equality.

**Call relations**: This test specifically validates the `append_external_agent_project_mcp_servers` path triggered by `read_external_mcp_servers`.

*Call graph*: calls 2 internal fn (external_agent_config_dir, external_agent_project_config_file); 5 external calls (assert_eq!, create_dir_all, write, json!, new).


##### `tests::mcp_migration_preserves_repo_servers_over_home_project_entries`  (lines 1620–1670)

```
fn mcp_migration_preserves_repo_servers_over_home_project_entries()
```

**Purpose**: Verifies precedence when both repo-local and home-level project config define the same MCP server name. Repo-local definitions must win, while home-only names are still added.

**Data flow**: It creates a repo with `.mcp.json` defining `shared`, writes a home-level project config defining `home-only` and another `shared`, runs `build_mcp_config_from_external`, parses expected TOML containing repo `shared` plus `home-only`, and asserts equality.

**Call relations**: This test covers the `PreserveExisting` merge mode used by `append_external_agent_project_mcp_servers` after repo-local servers have already been loaded.

*Call graph*: calls 2 internal fn (external_agent_config_dir, external_agent_project_config_file); 5 external calls (assert_eq!, create_dir_all, write, json!, new).


##### `tests::mcp_migration_skips_disabled_servers`  (lines 1673–1706)

```
fn mcp_migration_skips_disabled_servers()
```

**Purpose**: Checks that MCP migration respects both per-server disabled flags and settings-based enabled/disabled lists. Only explicitly allowed servers should remain.

**Data flow**: It writes a temp `.mcp.json` with enabled, explicitly disabled, and not-enabled servers, constructs a settings JSON with `enabledMcpjsonServers` and `disabledMcpjsonServers`, runs `build_mcp_config_from_external`, parses expected TOML containing only the enabled server, and asserts equality.

**Call relations**: This test validates `mcp_server_is_disabled` as exercised through the public MCP builder.

*Call graph*: 4 external calls (assert_eq!, write, json!, new).


##### `tests::command_skill_names_include_nested_paths`  (lines 1709–1714)

```
fn command_skill_names_include_nested_paths()
```

**Purpose**: Verifies that nested command paths contribute all path segments to the generated skill slug. This prevents collisions between similarly named files in different subdirectories.

**Data flow**: It constructs a commands root and nested file path with `source_path`, calls `command_skill_name`, and asserts that the result is `source-command-pr-review`.

**Call relations**: This test exercises `command_source_name` plus `slugify_name` through `command_skill_name`.

*Call graph*: 2 external calls (assert_eq!, source_path).


##### `tests::command_skill_names_must_fit_codex_skill_loader_limit`  (lines 1717–1723)

```
fn command_skill_names_must_fit_codex_skill_loader_limit()
```

**Purpose**: Checks that commands producing overly long skill names are rejected as unsupported. It enforces the target loader’s name-length constraint.

**Data flow**: It builds a deeply nested source path, parses a minimal described document with `parse_document_content`, calls `command_skill_name_if_supported`, and asserts that the result is `None`.

**Call relations**: This test targets the length-limit branch inside `command_skill_name_if_supported`.

*Call graph*: calls 1 internal fn (parse_document_content); 2 external calls (assert!, source_path).


##### `tests::commands_with_provider_runtime_expansion_are_skipped`  (lines 1726–1734)

```
fn commands_with_provider_runtime_expansion_are_skipped()
```

**Purpose**: Verifies that command templates using unsupported runtime-expansion features are excluded from migration. The example combines `$ARGUMENTS` and `@file` syntax.

**Data flow**: It parses a document containing unsupported template syntax, calls `command_skill_name_if_supported`, and asserts that the result is `None`.

**Call relations**: This test exercises `has_unsupported_command_template_features` through the command support gate.

*Call graph*: calls 1 internal fn (parse_document_content); 2 external calls (assert!, source_path).


##### `tests::commands_without_description_are_skipped`  (lines 1737–1743)

```
fn commands_without_description_are_skipped()
```

**Purpose**: Checks that commands lacking a frontmatter description are not considered migratable. README-like markdown without frontmatter should be ignored.

**Data flow**: It parses plain markdown content without a description, calls `command_skill_name_if_supported` for a README path, and asserts that the result is `None`.

**Call relations**: This test covers early rejection in `command_skill_name_if_supported` due to missing description and README exclusion.

*Call graph*: calls 1 internal fn (parse_document_content); 2 external calls (assert!, source_path).


##### `tests::command_slug_collisions_are_skipped`  (lines 1746–1765)

```
fn command_slug_collisions_are_skipped()
```

**Purpose**: Verifies that when two different source files normalize to the same skill slug, neither is imported. Collision handling is all-or-nothing for that slug.

**Data flow**: It creates two markdown command files whose names slugify identically, calls `unique_supported_command_sources`, and asserts that the result is an empty vector.

**Call relations**: This test directly validates the grouping-and-singleton filtering logic in `unique_supported_command_sources`.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, new).


##### `tests::subagent_accepts_yaml_block_lists_by_ignoring_unsupported_fields`  (lines 1768–1774)

```
fn subagent_accepts_yaml_block_lists_by_ignoring_unsupported_fields()
```

**Purpose**: Checks that structured YAML fields like lists do not invalidate subagent migration as long as required scalar fields are present. Unsupported fields are ignored rather than treated as fatal.

**Data flow**: It parses a document whose frontmatter includes `skills`, `tools`, and `disallowedTools` lists alongside valid `name` and `description`, calls `agent_metadata`, and asserts that metadata extraction succeeds.

**Call relations**: This test demonstrates the interaction between `frontmatter_value_from_yaml` producing `Other` for complex values and `agent_metadata` only requiring specific scalar fields.

*Call graph*: calls 1 internal fn (parse_document_content); 1 external calls (assert!).


##### `tests::subagent_requires_minimum_codex_agent_fields`  (lines 1777–1785)

```
fn subagent_requires_minimum_codex_agent_fields()
```

**Purpose**: Verifies that subagent migration requires both a description and non-empty body text in addition to a name. Missing either causes metadata extraction to fail.

**Data flow**: It parses one document missing `description` and another with an empty body, calls `agent_metadata` on both, and asserts that both results are `None`.

**Call relations**: This test targets the validation rules inside `agent_metadata`.

*Call graph*: calls 1 internal fn (parse_document_content); 1 external calls (assert!).


##### `tests::subagent_preserves_default_model_when_source_model_is_present`  (lines 1788–1808)

```
fn subagent_preserves_default_model_when_source_model_is_present()
```

**Purpose**: Checks that rendering a subagent does not emit a source `model` field, while still mapping supported effort values. The target should preserve its own default model behavior.

**Data flow**: It parses a document containing `model: source-opus` and `effort: max`, extracts metadata with `agent_metadata`, renders TOML with `render_agent_toml`, parses the rendered TOML and an expected TOML snippet, and asserts equality.

**Call relations**: This test validates `render_agent_toml`’s selective field mapping and `map_agent_reasoning_effort` behavior.

*Call graph*: calls 3 internal fn (agent_metadata, parse_document_content, render_agent_toml); 2 external calls (assert_eq!, from_str).


##### `tests::subagent_target_preserves_dotted_file_stem`  (lines 1811–1819)

```
fn subagent_target_preserves_dotted_file_stem()
```

**Purpose**: Verifies that source filenames with dots in the stem keep those dots in the target `.toml` filename. Only the final extension is replaced.

**Data flow**: It constructs a target agents directory and a source file path with `source_path`, calls `subagent_target_file`, and asserts that the returned path ends with `security.audit.toml`.

**Call relations**: This test directly exercises the filename mapping logic in `subagent_target_file`.

*Call graph*: 3 external calls (new, assert_eq!, source_path).


##### `tests::frontmatter_accepts_crlf_delimiters`  (lines 1822–1845)

```
fn frontmatter_accepts_crlf_delimiters()
```

**Purpose**: Checks that frontmatter parsing works with CRLF line endings and preserves the body text after the closing delimiter. It confirms newline-style tolerance.

**Data flow**: It parses CRLF-delimited content with `parse_document_content`, extracts `name`, `description`, and `body`, and asserts that they match the expected values including the trailing CRLF in the body.

**Call relations**: This test validates `parse_document_content` and `frontmatter_end` handling of CRLF delimiter variants.

*Call graph*: calls 1 internal fn (parse_document_content); 1 external calls (assert_eq!).


##### `tests::hook_migration_ignores_unsupported_handlers`  (lines 1848–1903)

```
fn hook_migration_ignores_unsupported_handlers()
```

**Purpose**: Verifies that hook migration keeps only hook groups and hook entries that are representable in the target format, and rewrites surviving command hooks to the migrated hook location. It specifically demonstrates that unsupported event kinds, unsupported hook types, and unsupported conditional command-hook forms are dropped instead of partially translated.

**Data flow**: The test builds an in-memory `serde_json::Value` containing several hook groups under `hooks`, including `PreToolUse`, `PermissionRequest`, and `SubagentStart`. It creates an empty `serde_json::Map` named `migration`, passes the settings plus a target config directory of `/repo/.codex` into `append_convertible_hook_groups`, and then compares the mutated map against an expected JSON object containing only the rewritten `PermissionRequest` command hook.

**Call relations**: This test invokes `append_convertible_hook_groups` directly to isolate the filtering logic without going through file I/O. Its assertions document the downstream contract that callers of the migration helper should expect only supported hook groups and handlers to be appended, with command strings rewritten via the migration path logic.

*Call graph*: calls 1 internal fn (append_convertible_hook_groups); 4 external calls (new, assert_eq!, new, json!).


##### `tests::hook_migration_honors_disable_all_hooks`  (lines 1906–1926)

```
fn hook_migration_honors_disable_all_hooks()
```

**Purpose**: Checks that a settings file with `disableAllHooks: true` suppresses hook migration completely, even when hook definitions are present. The expected result is an empty migrated hook map.

**Data flow**: The test creates a temporary directory, writes a `settings.json` file containing both `disableAllHooks: true` and a `SessionStart` command hook, then calls `hook_migration` with that directory as the source root and no explicit target config directory. It unwraps the result and asserts that the returned `serde_json::Map` is empty.

**Call relations**: This test exercises the higher-level `hook_migration` entry for settings-file loading and policy evaluation. It confirms that callers reaching migration through the normal file-based path get an early no-op result when hooks are globally disabled.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::hook_migration_honors_settings_local_disable_override`  (lines 1929–1979)

```
fn hook_migration_honors_settings_local_disable_override()
```

**Purpose**: Verifies the precedence rule between project settings and local settings: a project-level `disableAllHooks: true` can be overridden by `settings.local.json` setting `disableAllHooks: false`, allowing migration to proceed. It also confirms that hooks from both files are included once migration is re-enabled.

**Data flow**: The test creates a temporary root, writes `settings.json` with hooks disabled and a `SessionStart` hook using matcher `project`, then writes `settings.local.json` with hooks re-enabled and another `SessionStart` hook using matcher `local`. It calls `hook_migration` on the root and asserts that the returned object contains both hook groups, preserving their command strings.

**Call relations**: This test drives `hook_migration` through the multi-file merge path rather than the lower-level append helper. It documents that the migration logic reads both settings files, applies local override semantics to the disable flag, and then merges hook arrays instead of discarding project hooks once local settings are present.

*Call graph*: 3 external calls (assert_eq!, write, new).


##### `tests::hook_command_paths_rewrite_to_target_hook_dir`  (lines 1982–2129)

```
fn hook_command_paths_rewrite_to_target_hook_dir()
```

**Purpose**: Exhaustively checks which shell command forms are rewritten from source hook paths to the migrated target hook directory and which are intentionally left unchanged. The test captures the parser’s conservative boundary: simple direct path references are rewritten, while complex shell expressions and non-source paths are preserved verbatim.

**Data flow**: The test derives environment-variable names and source hook path fragments using `external_agent_project_dir_env_var`, `SOURCE_EXTERNAL_AGENT_NAME`, and `external_agent_config_dir`. It then repeatedly calls `rewrite_hook_command` with different command strings and a target config directory of `/repo/.codex`, asserting either a migrated command/path result or exact preservation of the original string. Inputs cover direct helper-generated commands, quoted and unquoted project-dir expansions, plain `python3` invocations, nested shell wrappers, variable indirection, brace expansion, escaped spaces, Windows-style paths, absolute Unix paths with shell trailers, and plugin-root script references.

**Call relations**: This test targets `rewrite_hook_command` directly because path rewriting is a core transformation used by migration but has many syntax-sensitive branches. The assertions define the practical contract relied on by higher-level migration code: only confidently recognized source hook references are rewritten, and everything ambiguous is left untouched to avoid breaking user commands.

*Call graph*: calls 1 internal fn (external_agent_project_dir_env_var); 2 external calls (assert_eq!, format!).


##### `tests::hook_script_copy_keeps_existing_target_scripts`  (lines 2132–2149)

```
fn hook_script_copy_keeps_existing_target_scripts()
```

**Purpose**: Ensures that copying migrated hook scripts into the target configuration directory does not overwrite scripts that already exist there. This protects user-edited or previously migrated target hook files.

**Data flow**: The test creates a temporary directory tree containing a source external-agent hooks directory and a target `.codex` migrated hooks directory. It writes `check.py` with different contents in source (`new script`) and target (`existing script`), calls `copy_hook_scripts`, then reads the target file back and asserts that its original contents remain unchanged.

**Call relations**: This test invokes `copy_hook_scripts` directly to validate file-copy overwrite policy independently of settings parsing. It documents that callers can run script-copy migration safely against an existing target hook directory without losing preexisting files.

*Call graph*: calls 2 internal fn (copy_hook_scripts, external_agent_config_dir); 4 external calls (assert_eq!, create_dir_all, write, new).


##### `tests::hook_migration_drops_negative_timeouts`  (lines 2152–2183)

```
fn hook_migration_drops_negative_timeouts()
```

**Purpose**: Checks that invalid negative timeout values on migrated command hooks are omitted from the output rather than copied through. The migrated hook remains present, but without a `timeout` field.

**Data flow**: The test constructs an in-memory settings JSON object containing a `SessionStart` command hook with `timeout: -1`, initializes an empty `serde_json::Map`, and passes both into `append_convertible_hook_groups` with no target config directory. It then asserts that the resulting map contains the hook with only `type` and `command`, proving the timeout field was removed during transformation.

**Call relations**: This test exercises `append_convertible_hook_groups` at the transformation layer where hook objects are normalized. It establishes an output invariant for downstream consumers of migration results: emitted timeout values must be acceptable, and negative source values are silently dropped instead of causing failure.

*Call graph*: calls 1 internal fn (append_convertible_hook_groups); 3 external calls (assert_eq!, new, json!).


### `execpolicy-legacy/build.rs`

`config` · `startup`

This build script is intentionally minimal. At build time it prints a single `cargo:` directive, `cargo:rerun-if-changed=src/default.policy`, to standard output. Cargo interprets that line as dependency metadata for the build script itself, so subsequent builds will rerun the script whenever the checked-in policy file changes.

There is no code generation, file copying, or environment probing here. The script exists purely to make policy edits invalidate the build cache correctly, which is especially important for a crate whose runtime behavior depends on a bundled policy file rather than only on Rust source changes.

#### Function details

##### `main`  (lines 1–3)

```
fn main()
```

**Purpose**: Emits the Cargo rebuild hint for the legacy default policy file. It ensures changes to `src/default.policy` trigger build-script reruns.

**Data flow**: Takes no inputs and writes one formatted line to stdout via `println!`. It returns unit and does not mutate any in-process state.

**Call relations**: As the build script entrypoint, Cargo invokes this during compilation of the crate. It delegates no further work and exists solely to communicate file-change tracking back to Cargo.

*Call graph*: 1 external calls (println!).


### TUI config synchronization and runtime settings
These files keep app and chat-widget settings synchronized with persisted config, resolve service-tier behavior, and apply user-facing runtime policy inside the TUI.

### `tui/src/config_update.rs`

`orchestration` · `interactive settings changes and config persistence`

This module is the TUI-side bridge between interactive settings changes and the app server's configuration APIs. The smallest helpers build `ConfigEdit` values with consistent semantics: `replace_config_value` always uses `MergeStrategy::Replace`, `clear_config_value` writes JSON null, and `app_scoped_key_path` safely quotes app IDs by serializing them as JSON strings before embedding them under `apps.<id>.<key>`. `trusted_project_edit` similarly escapes the project trust key and writes `projects."...".trust_level = "trusted"`.

Several helpers package common UI mutations into edit batches. `build_model_selection_edits` writes `model` and either sets or clears `model_reasoning_effort`; `build_service_tier_selection_edits` normalizes request values, preserving the special default-request token and canonicalizing known tiers to `fast` or `flex`; the Windows-only sandbox helper writes `windows.sandbox` and clears legacy feature flags; `build_feature_enabled_edit` omits writes for default-false features when disabling them by clearing the key instead; and memory/OSS-provider helpers emit straightforward replacements.

The async half of the file sends these edits to the app server. `write_config_batch` and `read_effective_config` generate unique `RequestId::String` values with `Uuid::new_v4()`, call `request_typed` with `ClientRequest::ConfigBatchWrite` or `ClientRequest::ConfigRead`, and wrap failures with TUI-specific context. `write_trusted_project` and `write_skill_enabled` are specialized wrappers for common operations. The design keeps UI code from hand-assembling protocol requests or duplicating key-path conventions.

#### Function details

##### `replace_config_value`  (lines 30–36)

```
fn replace_config_value(key_path: impl Into<String>, value: JsonValue) -> ConfigEdit
```

**Purpose**: Builds a `ConfigEdit` that replaces a config key path with a specific JSON value. It is the canonical constructor for non-null config writes in this module.

**Data flow**: It takes `key_path: impl Into<String>` and `value: JsonValue`, converts the key path with `into()`, and returns `ConfigEdit { key_path, value, merge_strategy: MergeStrategy::Replace }`.

**Call relations**: This helper is the foundation for most edit builders in the file, including feature toggles, OSS provider updates, trusted project writes, and `clear_config_value`.

*Call graph*: called by 6 (update_feature_flags, handle_event, build_feature_enabled_edit, build_oss_provider_edit, clear_config_value, trusted_project_edit); 1 external calls (into).


##### `clear_config_value`  (lines 38–40)

```
fn clear_config_value(key_path: impl Into<String>) -> ConfigEdit
```

**Purpose**: Builds a `ConfigEdit` that clears a config key by replacing it with JSON null. It standardizes how the TUI removes optional settings.

**Data flow**: It takes `key_path`, passes it to `replace_config_value` with `JsonValue::Null`, and returns the resulting `ConfigEdit`.

**Call relations**: This helper is used by feature-flag updates and other edit builders whenever the desired behavior is to remove a key rather than write an explicit falsey value.

*Call graph*: calls 1 internal fn (replace_config_value); called by 3 (update_feature_flags, handle_event, build_feature_enabled_edit).


##### `app_scoped_key_path`  (lines 42–45)

```
fn app_scoped_key_path(app_id: &str, key_path: &str) -> String
```

**Purpose**: Constructs a config key path under `apps.<app_id>.<key_path>` while safely quoting app IDs that may contain dots or other special characters. It prevents malformed dotted app IDs from being interpreted as nested path segments.

**Data flow**: It takes `app_id` and `key_path`, converts `app_id` into `serde_json::Value::String(app_id.to_string()).to_string()` so it becomes a quoted JSON string literal, then formats `apps.{app_id}.{key_path}` and returns the resulting `String`.

**Call relations**: This is a standalone key-path helper used by callers that need app-scoped config writes. Its quoting behavior is validated by the dedicated test file.

*Call graph*: 2 external calls (format!, String).


##### `format_config_error`  (lines 47–49)

```
fn format_config_error(err: &impl Display) -> String
```

**Purpose**: Formats a config-related error with alternate pretty-printing so nested context is preserved in a single string. It gives the TUI a consistent way to surface app-server validation failures.

**Data flow**: It takes any `Display` implementor by reference and returns `format!("{err:#}")`, preserving chained error context in the formatted string.

**Call relations**: This helper is used by higher-level event handlers and trust-persistence flows after app-server requests fail. The test file verifies that wrapped validation messages are preserved.

*Call graph*: called by 3 (update_feature_flags, handle_event, persist_selected_trust); 1 external calls (format!).


##### `trusted_project_edit`  (lines 51–59)

```
fn trusted_project_edit(project_path: &Path) -> ConfigEdit
```

**Purpose**: Builds the specific config edit that marks a project path as trusted. It handles escaping so the project path can safely appear inside the dotted key-path syntax.

**Data flow**: It computes `project_key` by calling `project_trust_key(project_path)` and escaping backslashes and double quotes, then calls `replace_config_value` with `projects."{project_key}".trust_level` and JSON `"trusted"` derived from `TrustLevel::Trusted.to_string()`. The returned value is a single `ConfigEdit`.

**Call relations**: This helper is used by `write_trusted_project` to package the trust mutation before sending it to the app server. Its exact key-path behavior is covered by tests.

*Call graph*: calls 2 internal fn (project_trust_key, replace_config_value); 2 external calls (format!, json!).


##### `build_model_selection_edits`  (lines 61–78)

```
fn build_model_selection_edits(
    model: &str,
    effort: Option<impl ToString>,
) -> Vec<ConfigEdit>
```

**Purpose**: Builds the config edits needed to change the selected model and optionally its reasoning effort. It ensures the reasoning-effort key is cleared when no explicit effort is chosen.

**Data flow**: It takes `model: &str` and `effort: Option<impl ToString>`. It creates `effort_edit` by either calling `clear_config_value("model_reasoning_effort")` when `effort` is `None` or `replace_config_value("model_reasoning_effort", json!(effort.to_string()))` when present. It returns a two-element `Vec<ConfigEdit>` containing `model = <model>` and the effort edit.

**Call relations**: This helper is used by event-handling code that persists model selection changes. It packages the paired model/effort update so callers can send them as one batch.

*Call graph*: called by 1 (handle_event); 1 external calls (vec!).


##### `build_service_tier_selection_edits`  (lines 80–97)

```
fn build_service_tier_selection_edits(service_tier: Option<&str>) -> Vec<ConfigEdit>
```

**Purpose**: Builds the config edit for selecting or clearing the service tier, normalizing request values into the config's canonical strings. It preserves the special default-request token rather than rewriting it.

**Data flow**: It takes `service_tier: Option<&str>`. If `None`, it returns a one-element vector containing `clear_config_value("service_tier")`. If present, it computes `config_value`: the special `SERVICE_TIER_DEFAULT_REQUEST_VALUE` is preserved as-is; otherwise `ServiceTier::from_request_value(service_tier)` is used to canonicalize known values to `"fast"` or `"flex"`, falling back to the original string for unknown values. It then returns `vec![replace_config_value("service_tier", json!(config_value))]`.

**Call relations**: This helper is used by event-handling code that persists service-tier changes. It encapsulates the normalization rules so callers do not need to know protocol-specific request values.

*Call graph*: called by 1 (handle_event); 1 external calls (vec!).


##### `build_windows_sandbox_mode_edits`  (lines 100–115)

```
fn build_windows_sandbox_mode_edits(elevated_enabled: bool) -> Vec<ConfigEdit>
```

**Purpose**: Builds the Windows-specific config edits needed to enable either elevated or unelevated sandbox mode while clearing older feature-flag keys. It migrates the setting to the canonical `windows.sandbox` key.

**Data flow**: It takes `elevated_enabled: bool`, formats feature key paths under `features.<feature>`, and returns a `Vec<ConfigEdit>` containing `windows.sandbox = "elevated"` or `"unelevated"` plus `clear_config_value(...)` edits for `experimental_windows_sandbox`, `elevated_windows_sandbox`, and `enable_experimental_windows_sandbox`.

**Call relations**: This helper is used by event-handling code on Windows when the user changes sandbox mode. It packages both the new canonical setting and cleanup of legacy compatibility keys.

*Call graph*: called by 1 (handle_event); 1 external calls (vec!).


##### `build_feature_enabled_edit`  (lines 117–128)

```
fn build_feature_enabled_edit(feature_key: &str, enabled: bool) -> ConfigEdit
```

**Purpose**: Builds a feature-flag edit that either writes an explicit boolean or clears the key when disabling a feature whose default is already false. This avoids persisting redundant `false` values for default-disabled features.

**Data flow**: It formats `features.{feature_key}`, looks up the feature in `FEATURES`, and computes whether it is a default-false feature. If `enabled` is true or the feature is not default-false, it returns `replace_config_value(key_path, json!(enabled))`; otherwise it returns `clear_config_value(key_path)`.

**Call relations**: This helper is used by feature-flag update flows. It depends on the global `FEATURES` metadata to decide whether disabling should be represented as an explicit write or key removal.

*Call graph*: calls 2 internal fn (clear_config_value, replace_config_value); called by 1 (update_feature_flags); 2 external calls (format!, json!).


##### `build_memory_settings_edits`  (lines 130–141)

```
fn build_memory_settings_edits(
    use_memories: bool,
    generate_memories: bool,
) -> Vec<ConfigEdit>
```

**Purpose**: Builds the pair of config edits controlling memory usage and memory generation. It packages the two related booleans into one batch.

**Data flow**: It takes `use_memories` and `generate_memories` booleans and returns a two-element `Vec<ConfigEdit>` replacing `memories.use_memories` and `memories.generate_memories` with those JSON boolean values.

**Call relations**: This helper is used by memory-settings update code before sending a batch write through `write_config_batch`.

*Call graph*: called by 1 (update_memory_settings); 1 external calls (vec!).


##### `build_oss_provider_edit`  (lines 143–145)

```
fn build_oss_provider_edit(provider: &str) -> ConfigEdit
```

**Purpose**: Builds the config edit that selects the OSS provider. It is a thin typed wrapper around a single key replacement.

**Data flow**: It takes `provider: &str` and returns `replace_config_value("oss_provider", json!(provider))`.

**Call relations**: This helper is used by event-handling code that persists OSS provider changes.

*Call graph*: calls 1 internal fn (replace_config_value); 1 external calls (json!).


##### `write_config_batch`  (lines 147–164)

```
async fn write_config_batch(
    request_handle: AppServerRequestHandle,
    edits: Vec<ConfigEdit>,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Sends a batch of config edits to the app server and requests that user config be reloaded afterward. It is the main persistence primitive used by the TUI for config mutations.

**Data flow**: It takes an `AppServerRequestHandle` and `Vec<ConfigEdit>`, generates a unique `RequestId::String` of the form `tui-config-write-<uuid>`, and calls `request_handle.request_typed(ClientRequest::ConfigBatchWrite { request_id, params: ConfigBatchWriteParams { edits, file_path: None, expected_version: None, reload_user_config: true } })`. It awaits the typed response and wraps any error with `config/batchWrite failed in TUI`, returning `Result<ConfigWriteResponse>`.

**Call relations**: This async helper is the central write path used by feature updates, memory updates, trusted-project writes, general event handling, and app startup flows that need to persist config changes.

*Call graph*: calls 1 internal fn (request_typed); called by 5 (update_feature_flags, update_memory_settings, handle_event, write_trusted_project, run_ratatui_app); 2 external calls (String, format!).


##### `write_trusted_project`  (lines 166–171)

```
async fn write_trusted_project(
    request_handle: AppServerRequestHandle,
    project_path: &Path,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Persists a project's trusted status through the app server using the standard batch-write path. It packages the trust edit and delegates the actual request.

**Data flow**: It takes an `AppServerRequestHandle` and `project_path: &Path`, builds a one-element vector containing `trusted_project_edit(project_path)`, passes that to `write_config_batch`, awaits the result, and returns the resulting `ConfigWriteResponse` or error.

**Call relations**: This helper is used by trust-persistence flows in the TUI. It delegates edit construction to `trusted_project_edit` and transport to `write_config_batch`.

*Call graph*: calls 1 internal fn (write_config_batch); called by 1 (persist_selected_trust); 1 external calls (vec!).


##### `read_effective_config`  (lines 173–188)

```
async fn read_effective_config(
    request_handle: AppServerRequestHandle,
    cwd: String,
) -> Result<ConfigReadResponse>
```

**Purpose**: Requests the effective merged configuration for a given working directory from the app server. It is the read-side counterpart to the batch-write helper.

**Data flow**: It takes an `AppServerRequestHandle` and `cwd: String`, generates a unique `RequestId::String` of the form `tui-config-read-<uuid>`, and sends `ClientRequest::ConfigRead { request_id, params: ConfigReadParams { include_layers: false, cwd: Some(cwd) } }` via `request_typed`. It awaits the typed `ConfigReadResponse` and wraps failures with `config/read failed in TUI`.

**Call relations**: This helper is used by flows that need to refresh effective config after writes or overrides. It centralizes request construction and error context for config reads.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (read_effective_config_after_overridden_write); 2 external calls (String, format!).


##### `write_skill_enabled`  (lines 190–208)

```
async fn write_skill_enabled(
    request_handle: AppServerRequestHandle,
    path: AbsolutePathBuf,
    enabled: bool,
) -> Result<()>
```

**Purpose**: Persists the enabled/disabled state of a skill through the app server's skills config API. It is a specialized write helper separate from general config batch edits.

**Data flow**: It takes an `AppServerRequestHandle`, `path: AbsolutePathBuf`, and `enabled: bool`, generates a unique `RequestId::String` of the form `tui-skill-config-write-<uuid>`, and sends `ClientRequest::SkillsConfigWrite { request_id, params: SkillsConfigWriteParams { path: Some(path), name: None, enabled } }` via `request_typed`. It awaits a `SkillsConfigWriteResponse`, wraps failures with `skills/config/write failed in TUI`, discards the response body, and returns `Ok(())` on success.

**Call relations**: This helper is called by event-handling code when the user toggles a skill. It bypasses `write_config_batch` because skills use a dedicated app-server request type.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (handle_event); 2 external calls (String, format!).


### `tui/src/app/config_persistence.rs`

`config` · `config load`

This module centralizes all config-heavy logic that would otherwise clutter the main event loop. `build_config_on_runtime_worker` runs `ConfigBuilder::build()` on a Tokio worker task, preserving panic semantics while attaching contextual errors. `rebuild_config_for_cwd` and `rebuild_config_for_permission_profile` construct builders from the current app’s codex home, CLI overrides, harness overrides, loader overrides, and cloud config bundle, then rebuild effective config for a different cwd or default permission profile.

The most intricate paths are the runtime override and persistence flows. `apply_permission_profile_selection` rebuilds config for the selected profile, stages approval-policy and reviewer changes into a cloned `Config`, updates both `self.config` and `chat_widget`, stores runtime override snapshots, syncs cached thread permission settings, emits an `override_turn_context` op, and inserts a history info cell. `refresh_in_memory_config_from_disk` rebuilds config using the chat widget’s active cwd, reapplies runtime approval/profile overrides so transient session choices survive disk reloads, then updates plugin-mention config. `update_feature_flags` persists feature edits first, handles overridden writes by reading effective config back from the app server, and otherwise patches live runtime state—including Guardian Approval’s coupled approval-policy/reviewer/sandbox behavior, memory-tool notices, thread-context override ops, and Windows sandbox propagation. `update_memory_settings` follows the same overridden-write pattern for memory toggles, while `update_memory_settings_with_app_server` additionally updates the current thread’s memory mode through the app server.

The rest of the file provides focused helpers: approval-policy/profile setters with user-visible error reporting, theme/pet/personality synchronization, reasoning labels, effective-config extraction helpers, and Windows-only sandbox synchronization after overridden writes. Tests emphasize subtle invariants: config reload must use the active chat-widget cwd, preserve cloud requirements across thread transitions, keep current config on best-effort reload failure, and avoid applying Guardian auto-review companion settings when effective config disables the feature.

#### Function details

##### `build_config_on_runtime_worker`  (lines 17–26)

```
async fn build_config_on_runtime_worker(
    builder: ConfigBuilder,
    error_context: String,
) -> Result<Config>
```

**Purpose**: Builds a `Config` on a spawned Tokio worker and preserves panic behavior while adding contextual error messages. It isolates potentially heavy config construction from the caller’s async task.

**Data flow**: Takes a `ConfigBuilder` and an `error_context` string, spawns `builder.build().await`, awaits the join handle, and returns the built `Config` on success. If the task panicked, it resumes unwinding the panic; if the task failed otherwise, it wraps that failure with `"{error_context} task failed"`; if the build itself errored, it wraps the build error with `error_context`.

**Call relations**: Called by `App::rebuild_config_for_cwd` and `App::rebuild_config_for_permission_profile` so both rebuild paths share the same worker-thread and error-handling behavior.

*Call graph*: calls 1 internal fn (build); called by 2 (rebuild_config_for_cwd, rebuild_config_for_permission_profile); 2 external calls (resume_unwind, spawn).


##### `App::rebuild_config_for_cwd`  (lines 29–44)

```
async fn rebuild_config_for_cwd(&self, cwd: PathBuf) -> Result<Config>
```

**Purpose**: Rebuilds effective config as if the session cwd were a different path. It is used when switching threads or refreshing config against the active chat-widget cwd.

**Data flow**: Clones `self.harness_overrides`, sets `overrides.cwd = Some(cwd.clone())`, builds a `ConfigBuilder` from current codex home, CLI overrides, harness overrides, loader overrides, and cloud config bundle, then awaits `build_config_on_runtime_worker` with a cwd-specific error message. It returns the rebuilt `Config` or an error.

**Call relations**: Used by `App::refresh_in_memory_config_from_disk` and `App::rebuild_config_for_resume_or_fallback` to obtain a fresh effective config for a target cwd.

*Call graph*: calls 1 internal fn (build_config_on_runtime_worker); called by 2 (rebuild_config_for_resume_or_fallback, refresh_in_memory_config_from_disk); 4 external calls (clone, display, default, format!).


##### `App::rebuild_config_for_permission_profile`  (lines 46–66)

```
async fn rebuild_config_for_permission_profile(
        &self,
        profile_id: &str,
    ) -> Result<Config>
```

**Purpose**: Rebuilds effective config as if a different default permission profile were selected for the current chat-widget cwd. It clears runtime sandbox/profile overrides before rebuilding so the selected profile can be resolved cleanly.

**Data flow**: Clones harness overrides, sets cwd from `self.chat_widget.config_ref().cwd`, clears `sandbox_mode` and `permission_profile`, sets `default_permissions = Some(profile_id.to_string())`, constructs a `ConfigBuilder` from current app state, and awaits `build_config_on_runtime_worker` with a profile-specific error message.

**Call relations**: Called by `App::apply_permission_profile_selection` and, on Windows, by `App::windows_setup_permissions`.

*Call graph*: calls 1 internal fn (build_config_on_runtime_worker); called by 2 (apply_permission_profile_selection, windows_setup_permissions); 2 external calls (default, format!).


##### `App::windows_setup_permissions`  (lines 69–89)

```
async fn windows_setup_permissions(
        &self,
        preset: &ApprovalPreset,
        profile_selection: Option<&PermissionProfileSelection>,
    ) -> Result<WindowsSetupPermissions>
```

**Purpose**: Computes the permission profile and workspace roots that should be used for Windows sandbox setup. It either derives them from a selected permission profile or falls back to the preset/current config.

**Data flow**: On Windows, accepts an approval preset and optional `PermissionProfileSelection`. If a selection is present, it rebuilds config for that profile and returns `WindowsSetupPermissions` containing the rebuilt config’s permission profile and effective workspace roots. Otherwise it returns the preset’s permission profile and the current config’s workspace roots.

**Call relations**: Used by Windows sandbox setup flows in the event dispatcher before elevated or legacy setup is launched.

*Call graph*: calls 1 internal fn (rebuild_config_for_permission_profile).


##### `App::apply_permission_profile_selection`  (lines 91–206)

```
async fn apply_permission_profile_selection(
        &mut self,
        selection: PermissionProfileSelection,
    ) -> bool
```

**Purpose**: Applies a chosen permission profile to live app state, chat-widget state, cached thread settings, and outbound turn context. It is the runtime counterpart to selecting a `/permissions` mode.

**Data flow**: Consumes a `PermissionProfileSelection`, rebuilds config for the selected profile, extracts the resolved permission profile, active profile, and network settings, stages changes into a cloned `Config`, optionally applies approval policy and reviewer overrides, writes the updated config back to `self.config`, updates chat-widget approval policy/profile/reviewer/network, stores `runtime_approval_policy_override` and `runtime_permission_profile_override`, syncs cached thread permission settings, sends `AppEvent::CodexOp(AppCommand::override_turn_context(...))`, inserts an informational history cell announcing the new display label, and returns `true`. Any rebuild or setter failure logs a warning, shows an error message, and returns `false`.

**Call relations**: Called from the event dispatcher for `AppEvent::SelectPermissionProfile` and from the Windows sandbox enable flow when a profile selection should be applied after sandbox setup.

*Call graph*: calls 4 internal fn (from_session_snapshot, from_config, rebuild_config_for_permission_profile, try_set_approval_policy_on_config); 7 external calls (new, override_turn_context, CodexOp, InsertHistoryCell, format!, new_info_event, warn!).


##### `App::refresh_in_memory_config_from_disk`  (lines 208–216)

```
async fn refresh_in_memory_config_from_disk(&mut self) -> Result<()>
```

**Purpose**: Reloads effective config from disk for the chat widget’s active cwd and reapplies runtime-only overrides. It keeps `self.config` synchronized with persisted config without losing transient session choices.

**Data flow**: Calls `rebuild_config_for_cwd(self.chat_widget.config_ref().cwd.to_path_buf())`, mutably reapplies runtime approval/profile overrides via `apply_runtime_policy_overrides`, assigns the result to `self.config`, and calls `self.chat_widget.sync_plugin_mentions_config(&self.config)`. It returns `Ok(())` or the rebuild error.

**Call relations**: Used directly in several flows and wrapped by `refresh_in_memory_config_from_disk_best_effort` when reload failures should not abort the current action.

*Call graph*: calls 2 internal fn (apply_runtime_policy_overrides, rebuild_config_for_cwd); called by 1 (refresh_in_memory_config_from_disk_best_effort).


##### `App::refresh_in_memory_config_from_disk_best_effort`  (lines 218–226)

```
async fn refresh_in_memory_config_from_disk_best_effort(&mut self, action: &str)
```

**Purpose**: Attempts to reload config from disk but keeps the current in-memory config if reload fails. It is used around thread transitions and picker exits where continuity is more important than strict freshness.

**Data flow**: Awaits `refresh_in_memory_config_from_disk`; on error it logs a warning including the caller-provided `action` string and leaves `self.config` unchanged.

**Call relations**: Called from session-picker and thread-transition flows elsewhere in the app when config refresh should be non-fatal.

*Call graph*: calls 1 internal fn (refresh_in_memory_config_from_disk); 1 external calls (warn!).


##### `App::read_effective_config_after_overridden_write`  (lines 228–248)

```
async fn read_effective_config_after_overridden_write(
        &mut self,
        app_server: &mut AppServerSession,
        setting: &str,
    ) -> Option<ConfigReadResponse>
```

**Purpose**: Reads back effective config from the app server after a config write was accepted but overridden by a higher-priority layer. It converts that situation into either a usable `ConfigReadResponse` or a user-visible warning.

**Data flow**: Reads the active chat-widget cwd as a display string, calls `crate::config_update::read_effective_config(app_server.request_handle(), cwd).await`, and returns `Some(response)` on success. On failure it logs a warning naming the affected setting, adds an error message explaining that the setting was saved but effective config could not be refreshed, and returns `None`.

**Call relations**: Used by `update_feature_flags`, `update_memory_settings`, and Windows sandbox override handling to reconcile live state after overridden writes.

*Call graph*: calls 2 internal fn (request_handle, read_effective_config); called by 3 (sync_windows_sandbox_after_overridden_write, update_feature_flags, update_memory_settings); 2 external calls (format!, warn!).


##### `App::rebuild_config_for_resume_or_fallback`  (lines 250–271)

```
async fn rebuild_config_for_resume_or_fallback(
        &mut self,
        current_cwd: &Path,
        resume_cwd: PathBuf,
    ) -> Result<Config>
```

**Purpose**: Rebuilds config for a resumed session cwd, but falls back to the current in-memory config when the rebuild fails and the cwd did not actually change. This avoids breaking same-cwd resume flows on transient config parse errors.

**Data flow**: Attempts `rebuild_config_for_cwd(resume_cwd.clone())`. On success it returns the rebuilt config. On error it checks `crate::session_resume::cwds_differ(current_cwd, &resume_cwd)`; if the cwd changed, it returns the error, otherwise it logs a warning and returns `Ok(self.config.clone())`.

**Call relations**: Used by resume/session-switch logic to decide whether a failed rebuild is fatal or can safely reuse current config.

*Call graph*: calls 2 internal fn (rebuild_config_for_cwd, cwds_differ); 3 external calls (clone, display, warn!).


##### `App::apply_runtime_policy_overrides`  (lines 273–302)

```
fn apply_runtime_policy_overrides(&mut self, config: &mut Config)
```

**Purpose**: Reapplies transient runtime approval-policy and permission-profile overrides onto a freshly rebuilt config. It preserves live session choices across disk reloads.

**Data flow**: Mutably borrows a `Config`. If `runtime_approval_policy_override` is set, it writes that policy into `config.permissions.approval_policy`; if `runtime_permission_profile_override` is set, it restores the permission profile snapshot and network settings. Any setter failure is logged and surfaced as a chat-widget error message.

**Call relations**: Called by `refresh_in_memory_config_from_disk` immediately after rebuilding config from disk.

*Call graph*: calls 1 internal fn (from_session_snapshot); called by 1 (refresh_in_memory_config_from_disk); 2 external calls (format!, warn!).


##### `App::set_approvals_reviewer_in_app_and_widget`  (lines 304–307)

```
fn set_approvals_reviewer_in_app_and_widget(&mut self, reviewer: ApprovalsReviewer)
```

**Purpose**: Updates the approvals reviewer in both app config and chat-widget config. It is a tiny synchronization helper to keep the two copies aligned.

**Data flow**: Assigns `reviewer` to `self.config.approvals_reviewer` and calls `self.chat_widget.set_approvals_reviewer(reviewer)`. It returns no value.

**Call relations**: Used by feature-flag synchronization paths when effective config or runtime changes alter the reviewer.

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

**Purpose**: Attempts to write an approval policy into a `Config` while handling validation errors uniformly. It centralizes logging and user-facing error formatting for approval-policy updates.

**Data flow**: Calls `config.permissions.approval_policy.set(policy.to_core())`. On success it returns `true`; on failure it logs `log_message`, adds `"{user_message_prefix}: {err}"` to the chat widget, and returns `false`.

**Call relations**: Used by `apply_permission_profile_selection` and `update_feature_flags` when staging config changes before committing them to live state.

*Call graph*: calls 1 internal fn (to_core); called by 2 (apply_permission_profile_selection, update_feature_flags); 2 external calls (format!, warn!).


##### `App::try_set_builtin_active_permission_profile_on_config`  (lines 326–361)

```
fn try_set_builtin_active_permission_profile_on_config(
        &mut self,
        config: &mut Config,
        active_permission_profile: ActivePermissionProfile,
        user_message_prefix: &str,
```

**Purpose**: Resolves a built-in active permission profile into a concrete `PermissionProfile` and writes it into a `Config`. It handles unsupported profile IDs and setter failures with consistent logging and user messaging.

**Data flow**: Looks up the concrete profile via `builtin_permission_profile_for_active_permission_profile`. If unsupported, it logs and reports an error and returns `None`. Otherwise it writes a `PermissionProfileSnapshot::active(...)` into `config.permissions`, returning `Some(permission_profile)` on success or `None` after logging/reporting any setter error.

**Call relations**: Used by `update_feature_flags` and `sync_auto_review_runtime_state_from_effective_config` when Guardian Approval/auto-review needs to force a built-in permission profile.

*Call graph*: calls 1 internal fn (active); called by 2 (sync_auto_review_runtime_state_from_effective_config, update_feature_flags); 2 external calls (format!, warn!).


##### `App::update_feature_flags`  (lines 363–616)

```
async fn update_feature_flags(
        &mut self,
        app_server: &mut AppServerSession,
        updates: Vec<(Feature, bool)>,
    )
```

**Purpose**: Persists experimental feature-flag changes and synchronizes all resulting live runtime state, including coupled approval/reviewer/profile behavior for Guardian Approval and Windows sandbox propagation. It is the most comprehensive config-write orchestration path in this file.

**Data flow**: Consumes a list of `(Feature, bool)` updates, stages them into a cloned `next_config`, accumulates config edits, and applies feature-specific side effects such as reviewer persistence and auto-review approval/profile overrides. It writes the batch through `write_config_batch`; on failure it reports an error and returns. If the write is `OkOverridden`, it reads effective config back, syncs feature state and auto-review runtime state from that effective config, and propagates Windows sandbox context if needed. Otherwise it commits `next_config` to `self.config`, updates chat-widget feature flags, emits memory-enable notices, applies reviewer/approval/profile runtime updates, stores runtime overrides, syncs cached thread permission settings, submits an `override_turn_context` op when needed, refreshes pending approvals if that op can affect replay state, propagates Windows sandbox context if changed, and optionally adds a permissions-updated info message.

**Call relations**: Called from the event dispatcher for `AppEvent::UpdateFeatureFlags`. It delegates pieces of the overridden-write and runtime-sync logic to `read_effective_config_after_overridden_write`, `sync_feature_state_from_effective_config`, `sync_auto_review_runtime_state_from_effective_config`, and `propagate_windows_sandbox_turn_context`.

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

**Purpose**: Persists memory feature toggles and updates live state, with special handling for overridden writes. It keeps the chat widget and app config aligned with the effective result.

**Data flow**: Builds memory-setting edits, writes them through `write_config_batch`, and on write failure logs/reports an error and returns `false`. If the write is `OkOverridden`, it logs/reports that the changes were saved but not applied, reads effective config back via `read_effective_config_after_overridden_write`, and returns the result of `sync_memory_state_from_effective_config`. Otherwise it writes `use_memories` and `generate_memories` into `self.config.memories`, updates the chat widget, and returns `true`.

**Call relations**: Called by `update_memory_settings_with_app_server`, which adds current-thread app-server synchronization on top of this persistence step.

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

**Purpose**: Persists memory settings and, if the `generate_memories` mode changed, updates the current thread’s memory mode through the app server. It bridges config persistence and per-thread runtime behavior.

**Data flow**: Stores the previous `generate_memories` value, awaits `update_memory_settings`, and returns early on failure or no effective change. If the setting changed and there is a current displayed thread, it maps the new boolean to `ThreadMemoryMode::{Enabled, Disabled}` and awaits `app_server.thread_memory_mode_set(thread_id, mode)`, logging/reporting any failure while leaving the saved config intact.

**Call relations**: Triggered by the event dispatcher for `AppEvent::UpdateMemorySettings`.

*Call graph*: calls 2 internal fn (update_memory_settings, thread_memory_mode_set); 2 external calls (format!, error!).


##### `App::reset_memories_with_app_server`  (lines 703–716)

```
async fn reset_memories_with_app_server(
        &mut self,
        app_server: &mut AppServerSession,
    )
```

**Purpose**: Requests a memory reset from the app server and reports the outcome to the user. It does not modify config, only runtime memory state.

**Data flow**: Awaits `app_server.memory_reset()`. On success it adds the info message `Reset local memories.`; on failure it logs and adds `Failed to reset memories: {err}`.

**Call relations**: Called from the event dispatcher for `AppEvent::ResetMemories`.

*Call graph*: calls 1 internal fn (memory_reset); 2 external calls (format!, error!).


##### `App::reasoning_label`  (lines 718–723)

```
fn reasoning_label(reasoning_effort: Option<&ReasoningEffortConfig>) -> String
```

**Purpose**: Formats a reasoning-effort setting into the label shown in user-facing messages. Missing or explicit `None` effort is rendered as `default`.

**Data flow**: Matches `Option<&ReasoningEffortConfig>` and returns either `"default".to_string()` or `reasoning_effort.as_str().to_string()`.

**Call relations**: Used by `reasoning_label_for` and by UI messaging paths that need a stable textual label for reasoning effort.


##### `App::reasoning_label_for`  (lines 725–730)

```
fn reasoning_label_for(
        model: &str,
        reasoning_effort: Option<&ReasoningEffortConfig>,
    ) -> Option<String>
```

**Purpose**: Returns a reasoning-effort label only for models where that label should be shown. `codex-auto-*` models suppress the label entirely.

**Data flow**: Checks whether `model` starts with `"codex-auto-"`; if so returns `None`, otherwise returns `Some(Self::reasoning_label(reasoning_effort))`.

**Call relations**: Used by model-selection persistence messaging in the event dispatcher.


##### `App::token_usage`  (lines 732–734)

```
fn token_usage(&self) -> crate::token_usage::TokenUsage
```

**Purpose**: Exposes the chat widget’s current token-usage snapshot through `App`. It is a simple forwarding accessor.

**Data flow**: Calls `self.chat_widget.token_usage()` and returns the resulting `crate::token_usage::TokenUsage`.

**Call relations**: Used by other app code that needs token usage without reaching into the chat widget directly.


##### `App::on_update_reasoning_effort`  (lines 736–741)

```
fn on_update_reasoning_effort(&mut self, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Updates both app config and chat-widget state when the current reasoning effort changes. It treats config as a live state holder for now.

**Data flow**: Assigns `effort.clone()` to `self.config.model_reasoning_effort` and calls `self.chat_widget.set_reasoning_effort(effort)`.

**Call relations**: Called from the event dispatcher for `AppEvent::UpdateReasoningEffort` before thread-level synchronization is performed elsewhere.


##### `App::on_update_personality`  (lines 743–746)

```
fn on_update_personality(&mut self, personality: Personality)
```

**Purpose**: Updates the current personality in both app config and chat-widget state. It keeps the two runtime copies synchronized.

**Data flow**: Sets `self.config.personality = Some(personality)` and calls `self.chat_widget.set_personality(personality)`.

**Call relations**: Called from the event dispatcher for `AppEvent::UpdatePersonality`.


##### `App::sync_tui_theme_selection`  (lines 748–751)

```
fn sync_tui_theme_selection(&mut self, name: String)
```

**Purpose**: Synchronizes a chosen syntax/theme name into both app config and chat-widget config. It is used after a theme selection is successfully persisted.

**Data flow**: Stores `Some(name.clone())` in `self.config.tui_theme` and calls `self.chat_widget.set_tui_theme(Some(name))`.

**Call relations**: Used by the syntax-theme selection flow after persistence succeeds.


##### `App::sync_tui_pet_selection`  (lines 754–757)

```
fn sync_tui_pet_selection(&mut self, pet: String)
```

**Purpose**: Test-only helper that synchronizes a selected pet ID into app and widget config. It mirrors the theme sync pattern for pet selection.

**Data flow**: Stores `Some(pet.clone())` in `self.config.tui_pet` and calls `self.chat_widget.set_tui_pet(Some(pet))`.

**Call relations**: Used only by tests in this file to verify config-copy synchronization.


##### `App::sync_tui_pet_disabled`  (lines 759–763)

```
fn sync_tui_pet_disabled(&mut self)
```

**Purpose**: Marks the pet feature as disabled in both app and widget config using the canonical disabled pet ID.

**Data flow**: Builds the disabled pet string from `crate::pets::DISABLED_PET_ID`, stores it in `self.config.tui_pet`, and calls `self.chat_widget.set_tui_pet(Some(pet))`.

**Call relations**: Used by pet-selection flows and covered by a unit test in this file.


##### `App::restore_runtime_theme_from_config`  (lines 765–781)

```
fn restore_runtime_theme_from_config(&self)
```

**Purpose**: Restores the active syntax-highlighting theme from persisted config, falling back to the adaptive default if the configured theme cannot be resolved. It updates global runtime highlighting state rather than app config.

**Data flow**: Checks `self.config.tui_theme`; if present and resolvable via `resolve_theme_by_name(name, Some(&self.config.codex_home))`, it calls `set_syntax_theme(theme)` and returns. Otherwise it computes `adaptive_default_theme_name()`, resolves that theme, and applies it if found.

**Call relations**: Used when a theme persistence attempt fails so the runtime preview can be reverted to the last persisted or default theme.

*Call graph*: calls 3 internal fn (adaptive_default_theme_name, resolve_theme_by_name, set_syntax_theme).


##### `App::personality_label`  (lines 783–789)

```
fn personality_label(personality: Personality) -> &'static str
```

**Purpose**: Maps a `Personality` enum to the short label shown in UI messages. It provides stable display text for persistence confirmations.

**Data flow**: Matches `Personality::{None, Friendly, Pragmatic}` and returns the corresponding static string.

**Call relations**: Used by personality persistence messaging in the event dispatcher.


##### `App::sync_feature_state_from_effective_config`  (lines 791–839)

```
fn sync_feature_state_from_effective_config(
        &mut self,
        effective_config: &ConfigReadResponse,
        feature_updates: &[(Feature, bool)],
    )
```

**Purpose**: Reconciles live feature/reviewer/approval-policy state from an effective config read after an overridden write. It updates both app config and chat-widget state to match what actually took effect.

**Data flow**: Iterates over the requested feature updates, computes each feature’s effective enabled state via `feature_enabled_from_effective_config`, writes it into `self.config.features`, and updates the chat widget. If Guardian Approval ended up disabled, it resets reviewer to `User` and returns early. Otherwise it optionally syncs `approvals_reviewer` and `approval_policy` from effective config, logging/reporting any approval-policy setter failure.

**Call relations**: Called by `update_feature_flags` when a feature-flag write returns `OkOverridden`.

*Call graph*: calls 4 internal fn (set_approvals_reviewer_in_app_and_widget, approval_policy_from_effective_config, approvals_reviewer_from_effective_config, feature_enabled_from_effective_config); called by 1 (update_feature_flags); 3 external calls (iter, format!, warn!).


##### `App::sync_auto_review_runtime_state_from_effective_config`  (lines 841–911)

```
async fn sync_auto_review_runtime_state_from_effective_config(
        &mut self,
        effective_config: &ConfigReadResponse,
        feature_updates: &[(Feature, bool)],
    )
```

**Purpose**: Repairs the live auto-review runtime state after an overridden feature write when Guardian Approval is effectively enabled and sandbox mode is `WorkspaceWrite`. It ensures the current thread sees the same auto-review companion settings implied by effective config.

**Data flow**: Checks whether Guardian Approval was among the updated features, is effectively enabled, and the effective sandbox mode is `WorkspaceWrite`; otherwise returns. It stages the built-in auto-review active permission profile into a cloned config, commits it to `self.config`, updates the chat widget’s permission profile snapshot, stores `runtime_permission_profile_override`, syncs cached thread permission settings, builds an `AppCommand::override_turn_context` carrying approval policy, reviewer, and active permission profile, submits it, and if the op can affect replay state, notes the outbound op and refreshes pending approvals.

**Call relations**: Called by `update_feature_flags` only in the overridden-write path, after `sync_feature_state_from_effective_config` has updated the basic feature flags.

*Call graph*: calls 6 internal fn (from, active, from_config, try_set_builtin_active_permission_profile_on_config, sandbox_mode_from_effective_config, op_can_change_pending_replay_state); called by 1 (update_feature_flags); 4 external calls (override_turn_context, iter, format!, warn!).


##### `App::sync_memory_state_from_effective_config`  (lines 913–934)

```
fn sync_memory_state_from_effective_config(
        &mut self,
        effective_config: &ConfigReadResponse,
    ) -> bool
```

**Purpose**: Updates live memory settings from an effective config read after an overridden write. It tolerates partially specified memory fields by falling back to current values.

**Data flow**: Extracts `MemoriesToml` via `memories_from_effective_config`; if absent, logs a warning and returns `false`. Otherwise it computes `use_memories` and `generate_memories` by taking values from effective config when present and falling back to current config values, writes them into `self.config.memories`, updates the chat widget, and returns `true`.

**Call relations**: Used by `update_memory_settings` when a memory-settings write was overridden.

*Call graph*: calls 1 internal fn (memories_from_effective_config); called by 1 (update_memory_settings); 1 external calls (warn!).


##### `App::sync_windows_sandbox_after_overridden_write`  (lines 937–962)

```
async fn sync_windows_sandbox_after_overridden_write(
        &mut self,
        app_server: &mut AppServerSession,
        write_response: &ConfigWriteResponse,
    )
```

**Purpose**: Windows-only reconciliation path for sandbox-mode writes that were saved but overridden. It refreshes effective config, updates live sandbox mode, and propagates the resulting turn context.

**Data flow**: Formats the overridden-write message, logs and reports that the sandbox change was saved but not applied, reads effective config back via `read_effective_config_after_overridden_write`, extracts the effective Windows sandbox mode, writes it into `self.config.permissions.windows_sandbox_mode`, updates the chat widget, and calls `propagate_windows_sandbox_turn_context()`.

**Call relations**: Called from Windows sandbox enable flows in the event dispatcher when `write_config_batch` returns `WriteStatus::OkOverridden`.

*Call graph*: calls 4 internal fn (propagate_windows_sandbox_turn_context, read_effective_config_after_overridden_write, overridden_write_message, windows_sandbox_mode_from_effective_config); 2 external calls (format!, warn!).


##### `App::propagate_windows_sandbox_turn_context`  (lines 964–984)

```
fn propagate_windows_sandbox_turn_context(&self)
```

**Purpose**: Windows-only helper that emits an `override_turn_context` op carrying the current Windows sandbox level. It keeps the active thread’s runtime context aligned with config changes.

**Data flow**: Computes `windows_sandbox_level` from `self.config` via `crate::windows_sandbox::level_from_config`, then sends `AppEvent::CodexOp(AppCommand::override_turn_context(..., Some(windows_sandbox_level), ...))` through `app_event_tx`.

**Call relations**: Used after Windows sandbox config changes or overridden-write reconciliation so the active thread immediately sees the new sandbox level.

*Call graph*: calls 1 internal fn (level_from_config); called by 2 (sync_windows_sandbox_after_overridden_write, update_feature_flags); 2 external calls (override_turn_context, CodexOp).


##### `overridden_write_message`  (lines 987–993)

```
fn overridden_write_message(write_response: &ConfigWriteResponse) -> &str
```

**Purpose**: Extracts the human-readable explanation for an overridden config write. It falls back to a generic message when metadata is absent.

**Data flow**: Reads `write_response.overridden_metadata`, returns `metadata.message.as_str()` when present, otherwise returns the fixed fallback string about a higher-priority layer overriding effective config.

**Call relations**: Used by feature-flag, memory-setting, and Windows sandbox overridden-write handlers to produce consistent user-facing messaging.

*Call graph*: called by 3 (sync_windows_sandbox_after_overridden_write, update_feature_flags, update_memory_settings).


##### `feature_enabled_from_effective_config`  (lines 995–1008)

```
fn feature_enabled_from_effective_config(
    effective_config: &ConfigReadResponse,
    feature: Feature,
) -> bool
```

**Purpose**: Reads one feature flag’s effective enabled state from a `ConfigReadResponse`, falling back to the feature’s default when the field is absent or unparsable.

**Data flow**: Looks up `effective_config.config.additional["features"]`, deserializes it through `features_toml_from_json`, then reads the requested feature key from the resulting entries map. If any step fails, it returns `feature.default_enabled()`.

**Call relations**: Used by `sync_feature_state_from_effective_config` to reconcile live feature flags after overridden writes.

*Call graph*: called by 1 (sync_feature_state_from_effective_config).


##### `approvals_reviewer_from_effective_config`  (lines 1010–1017)

```
fn approvals_reviewer_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<ApprovalsReviewer>
```

**Purpose**: Extracts the effective approvals reviewer from a config read and converts it into the core enum used by the TUI.

**Data flow**: Reads `effective_config.config.approvals_reviewer` and maps it through `codex_app_server_protocol::ApprovalsReviewer::to_core`, returning `Option<ApprovalsReviewer>`.

**Call relations**: Used by `sync_feature_state_from_effective_config`.

*Call graph*: called by 1 (sync_feature_state_from_effective_config).


##### `approval_policy_from_effective_config`  (lines 1019–1023)

```
fn approval_policy_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<AskForApproval>
```

**Purpose**: Extracts the effective approval policy from a config read. It is a tiny accessor helper.

**Data flow**: Returns `effective_config.config.approval_policy` unchanged.

**Call relations**: Used by `sync_feature_state_from_effective_config`.

*Call graph*: called by 1 (sync_feature_state_from_effective_config).


##### `sandbox_mode_from_effective_config`  (lines 1025–1029)

```
fn sandbox_mode_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<AppServerSandboxMode>
```

**Purpose**: Extracts the effective sandbox mode from a config read. It supports auto-review reconciliation logic.

**Data flow**: Returns `effective_config.config.sandbox_mode` unchanged.

**Call relations**: Used by `sync_auto_review_runtime_state_from_effective_config`.

*Call graph*: called by 1 (sync_auto_review_runtime_state_from_effective_config).


##### `memories_from_effective_config`  (lines 1031–1037)

```
fn memories_from_effective_config(effective_config: &ConfigReadResponse) -> Option<MemoriesToml>
```

**Purpose**: Deserializes the `memories` section from a config read’s `additional` JSON map. It returns `None` if the section is absent or malformed.

**Data flow**: Looks up `effective_config.config.additional["memories"]`, clones the JSON value, and attempts `serde_json::from_value` into `MemoriesToml`.

**Call relations**: Used by `sync_memory_state_from_effective_config`.

*Call graph*: called by 1 (sync_memory_state_from_effective_config).


##### `features_toml_from_json`  (lines 1039–1041)

```
fn features_toml_from_json(value: &serde_json::Value) -> Option<FeaturesToml>
```

**Purpose**: Deserializes a JSON value into `FeaturesToml`. It is a small parsing helper for effective-config inspection.

**Data flow**: Clones the input `serde_json::Value` and attempts `serde_json::from_value`, returning `Option<FeaturesToml>`.

**Call relations**: Used by `feature_enabled_from_effective_config`.

*Call graph*: 2 external calls (clone, from_value).


##### `windows_sandbox_mode_from_effective_config`  (lines 1044–1053)

```
fn windows_sandbox_mode_from_effective_config(
    effective_config: &ConfigReadResponse,
) -> Option<codex_config::types::WindowsSandboxModeToml>
```

**Purpose**: Windows-only helper that extracts the effective Windows sandbox mode from the `windows` section of a config read. It returns `None` if the section is absent or malformed.

**Data flow**: Looks up `effective_config.config.additional["windows"]`, deserializes it through `windows_toml_from_json`, and returns `windows.sandbox` if present.

**Call relations**: Used by `sync_windows_sandbox_after_overridden_write`.

*Call graph*: called by 1 (sync_windows_sandbox_after_overridden_write).


##### `windows_toml_from_json`  (lines 1056–1058)

```
fn windows_toml_from_json(value: &serde_json::Value) -> Option<WindowsToml>
```

**Purpose**: Windows-only JSON-to-`WindowsToml` deserializer used when inspecting effective config. It is a small parsing helper.

**Data flow**: Clones the input JSON value and attempts `serde_json::from_value`, returning `Option<WindowsToml>`.

**Call relations**: Used by `windows_sandbox_mode_from_effective_config`.

*Call graph*: 2 external calls (clone, from_value).


##### `tests::update_reasoning_effort_updates_collaboration_mode`  (lines 1072–1087)

```
async fn update_reasoning_effort_updates_collaboration_mode()
```

**Purpose**: Verifies that updating reasoning effort changes both the chat widget’s current setting and the app config copy. It guards the current stateful use of config for reasoning effort.

**Data flow**: Creates a test app, seeds the chat widget with medium effort, calls `on_update_reasoning_effort(Some(High))`, and asserts both widget and config now report `High`.

**Call relations**: This test directly exercises `App::on_update_reasoning_effort`.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


##### `tests::refresh_in_memory_config_from_disk_loads_latest_apps_state`  (lines 1090–1126)

```
async fn refresh_in_memory_config_from_disk_loads_latest_apps_state() -> Result<()>
```

**Purpose**: Checks that reloading config from disk updates app-enabled state that was persisted after the app started. It proves `refresh_in_memory_config_from_disk` actually rebuilds from disk rather than reusing stale in-memory values.

**Data flow**: Creates a test app with a temporary codex home, persists app-specific config edits disabling a connector, asserts the current in-memory config still lacks that state, calls `refresh_in_memory_config_from_disk`, and then asserts the connector is now disabled in effective config.

**Call relations**: This test covers the disk-reload path in `refresh_in_memory_config_from_disk`.

*Call graph*: calls 1 internal fn (make_test_app); 4 external calls (assert_eq!, for_config, tempdir, vec!).


##### `tests::refresh_in_memory_config_from_disk_keeps_cloud_requirements_for_thread_transitions`  (lines 1131–1186)

```
async fn refresh_in_memory_config_from_disk_keeps_cloud_requirements_for_thread_transitions() -> Result<()>
```

**Purpose**: Regression test ensuring cloud-config requirements survive the config refresh used before thread transitions. It protects enterprise policy enforcement during `/new`, `/clear`, `/fork`, and similar flows.

**Data flow**: Builds a config with an enterprise cloud requirement restricting approval policies, writes a marker app setting to disk, asserts the requirement is present before reload, calls `refresh_in_memory_config_from_disk`, then asserts both the disk change and the cloud requirement remain effective afterward.

**Call relations**: This test exercises `refresh_in_memory_config_from_disk` with a non-default `cloud_config_bundle`, documenting that rebuilds must preserve cloud requirements.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, loader_with_enterprise_requirement, make_test_app); 5 external calls (assert_eq!, default, format!, write, tempdir).


##### `tests::refresh_in_memory_config_from_disk_best_effort_keeps_current_config_on_error`  (lines 1189–1202)

```
async fn refresh_in_memory_config_from_disk_best_effort_keeps_current_config_on_error() -> Result<()>
```

**Purpose**: Verifies that best-effort config refresh leaves the current config untouched when disk config is broken. It protects non-fatal thread-transition flows from destructive reload failures.

**Data flow**: Creates a test app with a temporary codex home, writes invalid TOML to `config.toml`, clones the original config, calls `refresh_in_memory_config_from_disk_best_effort`, and asserts `app.config` still equals the original.

**Call relations**: This test covers the error-swallowing behavior of `refresh_in_memory_config_from_disk_best_effort`.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert_eq!, write, tempdir).


##### `tests::refresh_in_memory_config_from_disk_uses_active_chat_widget_cwd`  (lines 1205–1242)

```
async fn refresh_in_memory_config_from_disk_uses_active_chat_widget_cwd() -> Result<()>
```

**Purpose**: Checks that config reload uses the chat widget’s active session cwd rather than the stale app config cwd. This matters after thread/session switches.

**Data flow**: Creates a test app, changes the chat widget’s thread session to a new cwd while leaving `app.config.cwd` unchanged, calls `refresh_in_memory_config_from_disk`, and asserts `app.config.cwd` now matches the chat widget’s cwd.

**Call relations**: This test documents the cwd source used by `refresh_in_memory_config_from_disk`.

*Call graph*: calls 3 internal fn (read_only, new, make_test_app); 4 external calls (new, new, assert_eq!, tempdir).


##### `tests::refresh_in_memory_config_from_disk_updates_resize_reflow_config`  (lines 1245–1264)

```
async fn refresh_in_memory_config_from_disk_updates_resize_reflow_config() -> Result<()>
```

**Purpose**: Verifies that a disk reload picks up TUI resize-reflow settings from config.toml. It guards a specific config field that affects transcript rendering behavior.

**Data flow**: Creates a test app with a temporary codex home, writes a `[tui] terminal_resize_reflow_max_rows = 9000` config file, calls `refresh_in_memory_config_from_disk`, and asserts the resulting config contains `TerminalResizeReflowMaxRows::Limit(9000)`.

**Call relations**: This test exercises the general rebuild path with a concrete TUI-specific setting.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert_eq!, write, tempdir).


##### `tests::overridden_disabled_guardian_does_not_apply_auto_review_companions`  (lines 1267–1304)

```
async fn overridden_disabled_guardian_does_not_apply_auto_review_companions() -> Result<()>
```

**Purpose**: Regression test ensuring that when effective config disables Guardian Approval, the app does not apply auto-review companion settings like reviewer or approval policy anyway. It protects the overridden-write reconciliation logic.

**Data flow**: Creates a test app, records the original approval policy, constructs a `ConfigReadResponse` whose effective config has `guardian_approval = false` but includes auto-review-like reviewer and sandbox values, calls `sync_feature_state_from_effective_config`, and asserts Guardian Approval is disabled in both app and widget config, reviewer is reset to `User`, and approval policy remains unchanged.

**Call relations**: This test directly covers the Guardian-specific early-return logic in `sync_feature_state_from_effective_config`.

*Call graph*: calls 1 internal fn (make_test_app); 4 external calls (assert!, assert_eq!, from_value, json!).


##### `tests::rebuild_config_for_resume_or_fallback_uses_current_config_on_same_cwd_error`  (lines 1307–1322)

```
async fn rebuild_config_for_resume_or_fallback_uses_current_config_on_same_cwd_error() -> Result<()>
```

**Purpose**: Verifies that resume config rebuild falls back to the current config when the rebuild fails but the cwd is unchanged. It protects same-cwd resume from unnecessary hard failures.

**Data flow**: Creates a test app with broken config.toml, captures current config and cwd, calls `rebuild_config_for_resume_or_fallback` with the same cwd, and asserts the returned config equals the current config.

**Call relations**: This test covers the same-cwd fallback branch in `rebuild_config_for_resume_or_fallback`.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert_eq!, write, tempdir).


##### `tests::rebuild_config_for_resume_or_fallback_errors_when_cwd_changes`  (lines 1325–1340)

```
async fn rebuild_config_for_resume_or_fallback_errors_when_cwd_changes() -> Result<()>
```

**Purpose**: Checks that resume config rebuild does not silently fall back when the target cwd differs. A changed cwd requires a real rebuild or an error.

**Data flow**: Creates a test app with broken config.toml, chooses a different temporary cwd, calls `rebuild_config_for_resume_or_fallback`, and asserts the result is an error.

**Call relations**: This test covers the changed-cwd error branch in `rebuild_config_for_resume_or_fallback`.

*Call graph*: calls 1 internal fn (make_test_app); 3 external calls (assert!, write, tempdir).


##### `tests::sync_tui_theme_selection_updates_chat_widget_config_copy`  (lines 1343–1353)

```
async fn sync_tui_theme_selection_updates_chat_widget_config_copy()
```

**Purpose**: Verifies that syncing a theme selection updates both app config and the chat widget’s config copy.

**Data flow**: Creates a test app, calls `sync_tui_theme_selection("dracula")`, and asserts both `app.config.tui_theme` and `app.chat_widget.config_ref().tui_theme` equal `Some("dracula")`.

**Call relations**: This test directly covers `App::sync_tui_theme_selection`.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


##### `tests::sync_tui_pet_selection_updates_chat_widget_config_copy`  (lines 1356–1366)

```
async fn sync_tui_pet_selection_updates_chat_widget_config_copy()
```

**Purpose**: Checks that selecting a pet updates both config copies consistently. It is the pet analogue of the theme sync test.

**Data flow**: Creates a test app, calls `sync_tui_pet_selection("chefito")`, and asserts both app and widget config copies contain that pet ID.

**Call relations**: This test covers the test-only `App::sync_tui_pet_selection` helper.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


##### `tests::sync_tui_pet_disabled_updates_chat_widget_config_copy`  (lines 1369–1382)

```
async fn sync_tui_pet_disabled_updates_chat_widget_config_copy()
```

**Purpose**: Verifies that disabling pets writes the canonical disabled pet ID into both app and widget config.

**Data flow**: Creates a test app, calls `sync_tui_pet_disabled()`, and asserts both config copies equal `Some(crate::pets::DISABLED_PET_ID)`.

**Call relations**: This test covers `App::sync_tui_pet_disabled`.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert_eq!).


### `tui/src/service_tier_resolution.rs`

`domain_logic` · `session/model configuration`

This module encapsulates the rules for deciding whether a request should carry a service-tier override such as the protocol’s default request value. The logic is gated first by `Feature::FastMode`: if that feature is disabled, all higher-level helpers return `None` and no service-tier behavior is applied.

`configured_service_tier` extracts the user’s explicit `config.service_tier` when present. If absent, it checks `config.notices.fast_default_opt_out == Some(true)` and, in that specific case, synthesizes `SERVICE_TIER_DEFAULT_REQUEST_VALUE`. That means opting out of the fast-default notice is treated as an explicit request for the protocol default tier string.

`effective_service_tier` then reconciles that configured value with the selected model’s `ModelPreset`. If the model is unknown, it simply returns the configured value. If the model is known, the protocol default request value is always allowed through unchanged, other configured tiers are kept only when `model_supports_service_tier` finds a matching tier ID in `preset.service_tiers`, and unsupported configured tiers are dropped to `None`. When nothing is configured, the function falls back to `preset.default_service_tier`, but only if that default is actually listed among the model’s supported tiers.

`service_tier_update_for_core` adapts this into the nested `Option<Option<String>>` shape expected by downstream config-update code: outer `None` means “do not touch service tier,” while `Some(Some(...))` means “set this value,” including resetting known models to the protocol default request value when no effective tier survives validation.

#### Function details

##### `configured_service_tier`  (lines 6–11)

```
fn configured_service_tier(config: &Config) -> Option<String>
```

**Purpose**: Extracts the user-requested service tier from config, including the special fast-default opt-out fallback.

**Data flow**: Reads `config.service_tier`; if present, clones and returns it. Otherwise it checks `config.notices.fast_default_opt_out == Some(true)` and returns `Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string())` in that case, else `None`.

**Call relations**: This is the first stage of service-tier resolution and is used only by `effective_service_tier`.

*Call graph*: called by 1 (effective_service_tier).


##### `effective_service_tier`  (lines 13–36)

```
fn effective_service_tier(
    config: &Config,
    model: &str,
    models: &[ModelPreset],
) -> Option<String>
```

**Purpose**: Determines the actual service tier to use for a given model after feature gating and model capability validation.

**Data flow**: Reads `config.features.enabled(Feature::FastMode)` and returns `None` immediately if disabled. Otherwise it gets the configured tier, looks up the matching `ModelPreset` by `model`, and then: returns the configured tier unchanged for unknown models; preserves the protocol default request value; preserves other configured tiers only if `model_supports_service_tier` says the preset supports them; drops unsupported configured tiers to `None`; or, when nothing is configured, clones `preset.default_service_tier` only if that default is supported.

**Call relations**: Higher-level session setup and refresh paths call this to decide what tier should be active for the current model.

*Call graph*: calls 2 internal fn (configured_service_tier, model_supports_service_tier); called by 3 (new_with_op_target, refresh_effective_service_tier, service_tier_update_for_core); 1 external calls (iter).


##### `service_tier_update_for_core`  (lines 38–57)

```
fn service_tier_update_for_core(
    config: &Config,
    model: &str,
    models: &[ModelPreset],
) -> Option<Option<String>>
```

**Purpose**: Produces the nested optional update value expected by core configuration code.

**Data flow**: Returns outer `None` when FastMode is disabled. Otherwise it computes `effective_service_tier`; if that yields `Some(service_tier)`, it returns `Some(Some(service_tier))`. If no effective tier exists and the model is unknown, it returns outer `None`. If the model is known but no effective tier survives, it returns `Some(Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string()))`.

**Call relations**: Callers that build or refresh session/core config use this helper because they need the update/no-update distinction in addition to the resolved string.

*Call graph*: calls 1 internal fn (effective_service_tier); called by 2 (session_config_with_effective_service_tier, service_tier_update_for_core); 1 external calls (iter).


##### `model_supports_service_tier`  (lines 59–64)

```
fn model_supports_service_tier(model: &ModelPreset, service_tier: &str) -> bool
```

**Purpose**: Checks whether a model preset advertises support for a specific service-tier ID.

**Data flow**: Iterates `model.service_tiers` and returns `true` if any `tier.id` equals the supplied `service_tier` string.

**Call relations**: Used by `effective_service_tier` to validate both configured tiers and preset defaults against the model’s declared capabilities.

*Call graph*: called by 1 (effective_service_tier).


### `tui/src/chatwidget/service_tiers.rs`

`domain_logic` · `cross-cutting`

This module encapsulates service-tier behavior around the current model. At the simplest level, `set_service_tier`, `current_service_tier`, and `configured_service_tier` expose and update the configured/effective tier state. Effective tier computation is delegated to `service_tier_resolution`, both for the current UI (`refresh_effective_service_tier`) and for the payload sent to core (`service_tier_update_for_core`), using the current model and the available model catalog.

Fast-mode support is treated as a feature-gated specialization of service tiers. `fast_mode_enabled` checks the `Feature::FastMode` flag, `current_model_fast_service_tier` searches the current model’s advertised service tiers for one whose name matches `SPEED_TIER_FAST`, and `can_toggle_fast_mode_from_keybinding` additionally requires no pending/running user turn and no active modal/popup. `toggle_fast_mode_from_ui` and `toggle_service_tier_from_ui` both implement the same toggle semantics: selecting the currently active tier reverts to `SERVICE_TIER_DEFAULT_REQUEST_VALUE`, otherwise it activates the chosen tier.

`current_model_service_tier_commands` converts the current model preset’s service-tier metadata into bottom-pane slash-command entries, lowercasing names and preserving descriptions. `sync_service_tier_commands` pushes those commands and the feature-enabled flag into the bottom pane. The private `set_service_tier_selection` method is the key integration point: it updates local config/UI state, sends an `AppCommand::override_turn_context` wrapped in `AppEvent::CodexOp` so future turns use the selected tier, and emits a persistence event so the choice survives restarts.

#### Function details

##### `ChatWidget::set_service_tier`  (lines 14–18)

```
fn set_service_tier(&mut self, service_tier: Option<String>)
```

**Purpose**: Stores a new configured service tier on the widget and refreshes all derived UI state that depends on it. It is the local-state half of service-tier selection.

**Data flow**: It takes `&mut self` and `service_tier: Option<String>`, writes `self.config.service_tier = service_tier`, calls `refresh_effective_service_tier()`, then `refresh_model_dependent_surfaces()`, and returns unit.

**Call relations**: This method is called by `ChatWidget::set_service_tier_selection`, which adds the app-event and persistence side effects around this local update.

*Call graph*: calls 1 internal fn (refresh_effective_service_tier); called by 1 (set_service_tier_selection).


##### `ChatWidget::current_service_tier`  (lines 20–22)

```
fn current_service_tier(&self) -> Option<&str>
```

**Purpose**: Returns the currently effective service tier as a borrowed string slice, if one is active. It exposes resolved state rather than raw config.

**Data flow**: It reads `self.effective_service_tier`, converts the inner `String` to `&str` with `as_deref()`, and returns `Option<&str>`.

**Call relations**: It is used by both `toggle_fast_mode_from_ui` and `toggle_service_tier_from_ui` to decide whether the requested tier is already active and should therefore toggle back to default.

*Call graph*: called by 2 (toggle_fast_mode_from_ui, toggle_service_tier_from_ui).


##### `ChatWidget::configured_service_tier`  (lines 24–26)

```
fn configured_service_tier(&self) -> Option<String>
```

**Purpose**: Returns the raw configured service-tier selection from widget config. Unlike `current_service_tier`, this does not resolve model defaults or compatibility.

**Data flow**: It clones `self.config.service_tier` and returns `Option<String>`.

**Call relations**: This accessor exposes persisted configuration state for callers that need the explicit stored value.


##### `ChatWidget::service_tier_update_for_core`  (lines 28–34)

```
fn service_tier_update_for_core(&self) -> Option<Option<String>>
```

**Purpose**: Computes the service-tier update payload that should be sent to core for the current model and config. It delegates compatibility and default-resolution rules to the shared resolver.

**Data flow**: It reads `self.config`, `self.current_model()`, and the model catalog list (defaulting to empty on failure), passes them to `service_tier_resolution::service_tier_update_for_core`, and returns the resulting `Option<Option<String>>`.

**Call relations**: This method is a thin adapter over the shared resolver, packaging the widget’s current config and model context.

*Call graph*: calls 1 internal fn (service_tier_update_for_core).


##### `ChatWidget::should_show_fast_status`  (lines 36–41)

```
fn should_show_fast_status(&self, model: &str, service_tier: Option<&str>) -> bool
```

**Purpose**: Determines whether the UI should display fast-mode status for a given model/tier combination. It requires the requested tier to be `fast`, the model to support it, and the user to have a ChatGPT account.

**Data flow**: Inputs are `&self`, `model: &str`, and `service_tier: Option<&str>`. It checks whether the tier equals `ServiceTier::Fast.request_value()`, whether `model_supports_service_tier(model, service_tier)` is true, and whether `self.has_chatgpt_account` is true, then returns the combined boolean.

**Call relations**: This helper encapsulates the exact conditions for surfacing fast-tier status indicators.


##### `ChatWidget::fast_mode_enabled`  (lines 43–45)

```
fn fast_mode_enabled(&self) -> bool
```

**Purpose**: Checks whether the Fast Mode feature flag is enabled in config. It is the feature gate for fast-tier UI affordances.

**Data flow**: It reads `self.config.features` and returns the result of `enabled(Feature::FastMode)`.

**Call relations**: This predicate is used by `ChatWidget::can_toggle_fast_mode_from_keybinding` and `ChatWidget::sync_service_tier_commands`.

*Call graph*: called by 2 (can_toggle_fast_mode_from_keybinding, sync_service_tier_commands).


##### `ChatWidget::can_toggle_fast_mode_from_keybinding`  (lines 47–52)

```
fn can_toggle_fast_mode_from_keybinding(&self) -> bool
```

**Purpose**: Determines whether the fast-mode keybinding should currently be active. It requires feature enablement, a fast tier on the current model, no running/pending user turn, and no active modal or popup.

**Data flow**: It reads `fast_mode_enabled()`, `current_model_fast_service_tier()`, `is_user_turn_pending_or_running()`, and `bottom_pane.no_modal_or_popup_active()`, combines them into a boolean, and returns it.

**Call relations**: This method uses `ChatWidget::fast_mode_enabled` and `ChatWidget::current_model_fast_service_tier` to gate keyboard-driven fast-tier toggling.

*Call graph*: calls 2 internal fn (current_model_fast_service_tier, fast_mode_enabled).


##### `ChatWidget::toggle_fast_mode_from_ui`  (lines 54–64)

```
fn toggle_fast_mode_from_ui(&mut self)
```

**Purpose**: Toggles the current model’s fast service tier on or off from the UI. Selecting fast when already active reverts to the default request tier.

**Data flow**: It reads `current_model_fast_service_tier()` and returns early if absent. Otherwise it compares `current_service_tier()` to the fast tier id, computes either the default request value or the fast tier id as `next_tier`, passes that to `set_service_tier_selection`, and returns unit.

**Call relations**: This UI action depends on `ChatWidget::current_model_fast_service_tier` to discover the fast tier and delegates the actual update/event emission to `ChatWidget::set_service_tier_selection`.

*Call graph*: calls 3 internal fn (current_model_fast_service_tier, current_service_tier, set_service_tier_selection).


##### `ChatWidget::toggle_service_tier_from_ui`  (lines 66–73)

```
fn toggle_service_tier_from_ui(&mut self, command: ServiceTierCommand)
```

**Purpose**: Toggles an arbitrary service tier command on or off from the UI. Re-selecting the active tier falls back to the default request tier.

**Data flow**: It takes `&mut self` and a `ServiceTierCommand`, compares `current_service_tier()` to `command.id`, computes either the default request value or `command.id` as `next_tier`, calls `set_service_tier_selection(next_tier)`, and returns unit.

**Call relations**: This is the generic counterpart to `toggle_fast_mode_from_ui`, sharing the same toggle semantics and delegating side effects to `ChatWidget::set_service_tier_selection`.

*Call graph*: calls 2 internal fn (current_service_tier, set_service_tier_selection).


##### `ChatWidget::sync_service_tier_commands`  (lines 75–80)

```
fn sync_service_tier_commands(&mut self)
```

**Purpose**: Refreshes the bottom pane’s available service-tier slash commands and whether those commands are enabled. It keeps command surfaces aligned with the current model and feature flags.

**Data flow**: It reads `fast_mode_enabled()` and `current_model_service_tier_commands()`, then writes both into `self.bottom_pane` via `set_service_tier_commands_enabled` and `set_service_tier_commands`.

**Call relations**: This method combines `ChatWidget::fast_mode_enabled` with `ChatWidget::current_model_service_tier_commands` to update the bottom-pane command UI.

*Call graph*: calls 2 internal fn (current_model_service_tier_commands, fast_mode_enabled).


##### `ChatWidget::current_model_service_tier_commands`  (lines 82–104)

```
fn current_model_service_tier_commands(&self) -> Vec<ServiceTierCommand>
```

**Purpose**: Builds the list of service-tier commands advertised by the current model preset. It converts model-catalog tier metadata into bottom-pane command objects.

**Data flow**: It reads `self.current_model()`, queries `self.model_catalog.try_list_models()`, finds the matching preset, maps each `service_tier` into a `ServiceTierCommand { id, name: lowercase, description }`, collects them into a vector, and returns an empty vector on catalog failure or missing model.

**Call relations**: This helper feeds both `ChatWidget::sync_service_tier_commands` and `ChatWidget::current_model_fast_service_tier`.

*Call graph*: called by 2 (current_model_fast_service_tier, sync_service_tier_commands).


##### `ChatWidget::set_service_tier_selection`  (lines 106–125)

```
fn set_service_tier_selection(&mut self, service_tier: Option<String>)
```

**Purpose**: Applies a service-tier selection end-to-end: update local widget state, send a turn-context override for future requests, and persist the selection. It is the central side-effecting setter behind UI toggles.

**Data flow**: It takes `&mut self` and `service_tier: Option<String>`, calls `set_service_tier(service_tier.clone())`, then sends `AppEvent::CodexOp(AppCommand::override_turn_context(..., Some(service_tier.clone()), ...))` and `AppEvent::PersistServiceTierSelection { service_tier }` through `self.app_event_tx`. It returns unit.

**Call relations**: This private method is called by both `toggle_fast_mode_from_ui` and `toggle_service_tier_from_ui`, consolidating the shared update-and-persist flow.

*Call graph*: calls 1 internal fn (set_service_tier); called by 2 (toggle_fast_mode_from_ui, toggle_service_tier_from_ui); 2 external calls (override_turn_context, CodexOp).


##### `ChatWidget::model_supports_service_tier`  (lines 127–143)

```
fn model_supports_service_tier(&self, model: &str, service_tier: &str) -> bool
```

**Purpose**: Checks whether a specific model advertises support for a given service-tier id. It is a catalog lookup helper used by status/UI decisions.

**Data flow**: Inputs are `&self`, `model: &str`, and `service_tier: &str`. It queries the model catalog, finds the matching preset, scans its `service_tiers` for a tier whose `id` matches, and returns `false` on catalog failure or missing model.

**Call relations**: This helper is used by `ChatWidget::should_show_fast_status` to avoid showing fast-tier status for unsupported models.


##### `ChatWidget::current_model_fast_service_tier`  (lines 145–149)

```
fn current_model_fast_service_tier(&self) -> Option<ServiceTierCommand>
```

**Purpose**: Finds the current model’s service-tier command whose name corresponds to the canonical fast tier. It returns the command object rather than just the id.

**Data flow**: It calls `current_model_service_tier_commands()`, iterates the resulting commands, finds the first whose `name` equals `SPEED_TIER_FAST` ignoring ASCII case, and returns it as `Option<ServiceTierCommand>`.

**Call relations**: This helper is used by `ChatWidget::can_toggle_fast_mode_from_keybinding` and `ChatWidget::toggle_fast_mode_from_ui`.

*Call graph*: calls 1 internal fn (current_model_service_tier_commands); called by 2 (can_toggle_fast_mode_from_keybinding, toggle_fast_mode_from_ui).


##### `ChatWidget::refresh_effective_service_tier`  (lines 151–157)

```
fn refresh_effective_service_tier(&mut self)
```

**Purpose**: Recomputes the widget’s effective service tier from config, current model, and model catalog. It keeps resolved tier state in sync after config/model changes.

**Data flow**: It reads `self.config`, `self.current_model()`, and the model catalog list (defaulting to empty on failure), passes them to `service_tier_resolution::effective_service_tier`, writes the result into `self.effective_service_tier`, and returns unit.

**Call relations**: This method is called by `ChatWidget::set_service_tier` whenever the configured tier changes.

*Call graph*: calls 1 internal fn (effective_service_tier); called by 1 (set_service_tier).


### `tui/src/chatwidget/settings.rs`

`domain_logic` · `cross-cutting runtime settings, thread updates, and footer/header refresh`

This file is the largest concentration of `ChatWidget` state-management logic. It exposes setters for approval policy, permission profiles, network and sandbox settings, feature flags, reviewer/personality/theme, account state, model selection, reasoning effort, and collaboration masks. Most setters do more than assign fields: they selectively refresh status surfaces, enable or disable bottom-pane commands, clear stale goal indicators, update image-paste affordances, or recompute effective service tier.

A central theme is the split between stored defaults and effective collaboration state. `current_collaboration_mode` holds the baseline model/effort/developer instructions, while `active_collaboration_mask` overlays mode-specific changes such as Plan mode. Helpers like `current_model`, `effective_reasoning_effort`, and `effective_collaboration_mode` consistently resolve the visible/runtime values from those two layers. Plan mode gets special treatment: its reasoning effort can be overridden independently, and the file contains the lexical policy for showing or dismissing the Plan-mode nudge based on draft text, task state, popup state, and thread-scoped dismissal.

The file also handles server-driven updates. `on_thread_settings_updated` validates the thread id and funnels matching notifications into `apply_thread_settings`, which synchronizes cwd, service tier, approvals, permission profile snapshots, collaboration mode, and dependent UI refreshes. Goal-status indicators are coordinated with collaboration-mode indicators so Plan mode suppresses goal badges, while normal modes can surface time-sensitive goal state in the footer.

#### Function details

##### `ChatWidget::set_approval_policy`  (lines 8–19)

```
fn set_approval_policy(&mut self, policy: AskForApproval)
```

**Purpose**: Attempts to apply a new `AskForApproval` policy to the widget’s constrained permission config and refreshes status surfaces on success. Failed constraint checks are logged rather than propagated.

**Data flow**: It takes a `policy`, converts it with `to_core()`, and calls the constrained approval-policy setter under `self.config.permissions`. On success it refreshes status surfaces; on error it emits a warning log and leaves the previous effective policy in place. It returns no value.

**Call relations**: This setter is used by `ChatWidget::apply_thread_settings` when thread settings arrive from the server. It delegates conversion to `AskForApproval::to_core` and relies on the constrained config object to enforce validity.

*Call graph*: calls 1 internal fn (to_core); called by 1 (apply_thread_settings); 1 external calls (warn!).


##### `ChatWidget::set_permission_profile_from_session_snapshot`  (lines 22–31)

```
fn set_permission_profile_from_session_snapshot(
        &mut self,
        snapshot: PermissionProfileSnapshot,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies a full `PermissionProfileSnapshot` to the widget config and refreshes status surfaces if accepted. Unlike some other setters, it propagates constraint failures to the caller.

**Data flow**: It accepts a `PermissionProfileSnapshot`, forwards it to `self.config.permissions.set_permission_profile_from_session_snapshot`, and on success refreshes status surfaces before returning `Ok(())`. If the constrained setter fails, the error is returned unchanged and no refresh occurs.

**Call relations**: This is a direct utility setter for callers that already have a session-style permission snapshot. It does not appear in the provided call graph here, but it mirrors the lower-level permission sync path used elsewhere in session/thread update handling.


##### `ChatWidget::set_permission_profile_with_active_profile`  (lines 33–48)

```
fn set_permission_profile_with_active_profile(
        &mut self,
        profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
    ) -> ConstraintResult<()>
```

**Purpose**: Builds a `PermissionProfileSnapshot` from a base `PermissionProfile` plus optional active profile and applies it to config. It is a convenience wrapper around the snapshot-based setter path.

**Data flow**: Inputs are a `PermissionProfile` and optional `ActivePermissionProfile`. It combines them via `PermissionProfileSnapshot::from_session_snapshot`, applies the snapshot through the constrained permissions setter, refreshes status surfaces on success, and returns `ConstraintResult<()>`.

**Call relations**: This helper packages raw permission-profile pieces into the same snapshot format used by session synchronization. It delegates snapshot construction to `from_session_snapshot` and then uses the config permissions API.

*Call graph*: calls 1 internal fn (from_session_snapshot).


##### `ChatWidget::set_permission_network`  (lines 50–55)

```
fn set_permission_network(
        &mut self,
        network: Option<crate::legacy_core::config::NetworkProxySpec>,
    )
```

**Purpose**: Stores the current network proxy permission setting in the widget config. It is a plain field update with no immediate UI refresh.

**Data flow**: It takes an optional `NetworkProxySpec` and assigns it to `self.config.permissions.network`. It returns nothing and performs no side effects.

**Call relations**: This is a low-level config mutator used when network permission state changes. It does not delegate further or trigger dependent refreshes in this file.


##### `ChatWidget::set_windows_sandbox_mode`  (lines 58–66)

```
fn set_windows_sandbox_mode(&mut self, mode: Option<WindowsSandboxModeToml>)
```

**Purpose**: Stores the configured Windows sandbox mode and, on Windows builds, updates the bottom pane’s degraded-sandbox indicator based on the effective sandbox level. Non-Windows builds keep the setter for API symmetry.

**Data flow**: It accepts an optional `WindowsSandboxModeToml`, writes it into `self.config.permissions.windows_sandbox_mode`, and on Windows computes `crate::windows_sandbox::level_from_config(&self.config)` to decide whether to call `bottom_pane.set_windows_degraded_sandbox_active(...)`. It returns nothing.

**Call relations**: This setter is a platform-aware bridge between config state and footer UI. Its only delegation is to the Windows sandbox-level helper and bottom-pane indicator update.

*Call graph*: 1 external calls (matches!).


##### `ChatWidget::set_feature_enabled`  (lines 69–117)

```
fn set_feature_enabled(&mut self, feature: Feature, enabled: bool) -> bool
```

**Purpose**: Attempts to toggle a constrained feature flag and then synchronizes all dependent widget/UI state for that specific feature. It also returns the actual resulting enabled state after constraints are applied.

**Data flow**: Inputs are a `Feature` and desired `enabled` boolean. It asks `self.config.features.set_enabled` to update constrained state, logs a warning if rejected, then reads back the effective enabled bit and conditionally refreshes service tier, command availability, plugin mentions, goal indicators, mentions-v2 state, idle-sleep prevention, and Windows degraded-sandbox UI. It returns the final enabled value.

**Call relations**: This is the central feature-toggle dispatcher. Depending on which feature changed, it invokes `sync_goal_command_enabled`, `sync_mentions_v2_enabled`, `sync_personality_command_enabled`, `sync_plugins_command_enabled`, and `update_collaboration_mode_indicator`; for Goals it also clears goal-related turn lifecycle state when disabling.

*Call graph*: calls 5 internal fn (sync_goal_command_enabled, sync_mentions_v2_enabled, sync_personality_command_enabled, sync_plugins_command_enabled, update_collaboration_mode_indicator); 2 external calls (matches!, warn!).


##### `ChatWidget::set_approvals_reviewer`  (lines 119–122)

```
fn set_approvals_reviewer(&mut self, policy: ApprovalsReviewer)
```

**Purpose**: Stores the approvals reviewer policy in config and refreshes status surfaces. It is the reviewer counterpart to approval-policy updates.

**Data flow**: It takes an `ApprovalsReviewer`, assigns it to `self.config.approvals_reviewer`, refreshes status surfaces, and returns nothing.

**Call relations**: This setter is invoked from `ChatWidget::apply_thread_settings` after thread settings are received. It does not delegate beyond the status refresh.

*Call graph*: called by 1 (apply_thread_settings).


##### `ChatWidget::set_full_access_warning_acknowledged`  (lines 124–126)

```
fn set_full_access_warning_acknowledged(&mut self, acknowledged: bool)
```

**Purpose**: Marks the full-access warning notice as acknowledged in config. It only updates persisted notice state.

**Data flow**: It takes a boolean `acknowledged` and stores `Some(acknowledged)` in `self.config.notices.hide_full_access_warning`. It returns nothing.

**Call relations**: This is a simple notice-state mutator with no downstream refresh logic in this file.


##### `ChatWidget::set_world_writable_warning_acknowledged`  (lines 128–130)

```
fn set_world_writable_warning_acknowledged(&mut self, acknowledged: bool)
```

**Purpose**: Marks the world-writable warning notice as acknowledged in config. It mirrors the full-access warning setter.

**Data flow**: It takes a boolean and writes `Some(acknowledged)` into `self.config.notices.hide_world_writable_warning`. It returns nothing.

**Call relations**: This is another simple notice-state setter with no delegated work.


##### `ChatWidget::world_writable_warning_hidden`  (lines 133–138)

```
fn world_writable_warning_hidden(&self) -> bool
```

**Purpose**: Reports whether the world-writable warning should currently be hidden. Missing config defaults to visible (`false`).

**Data flow**: It reads `self.config.notices.hide_world_writable_warning`, unwraps it with `false` as the default, and returns that boolean. It mutates no state.

**Call relations**: This is a pure accessor used by UI logic that needs the effective dismissal state.


##### `ChatWidget::set_plan_mode_reasoning_effort`  (lines 145–160)

```
fn set_plan_mode_reasoning_effort(&mut self, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Stores the Plan-mode-specific reasoning-effort override and immediately applies it to the active Plan mask when Plan mode is currently selected. Resetting the override restores the preset Plan default from the collaboration-mode catalog.

**Data flow**: It takes an optional `ReasoningEffortConfig`, stores a clone in `self.config.plan_mode_reasoning_effort`, conditionally mutates `self.active_collaboration_mask.reasoning_effort` when collaboration modes are enabled and the active mode is `Plan`, optionally fetching the preset via `collaboration_modes::plan_mask`, then refreshes model-dependent surfaces. It returns nothing.

**Call relations**: This setter is one of the few places with Plan-specific override semantics. It calls `ChatWidget::collaboration_modes_enabled`, may consult `collaboration_modes::plan_mask`, and always finishes with `ChatWidget::refresh_model_dependent_surfaces`.

*Call graph*: calls 3 internal fn (collaboration_modes_enabled, refresh_model_dependent_surfaces, plan_mask).


##### `ChatWidget::set_reasoning_effort`  (lines 166–181)

```
fn set_reasoning_effort(&mut self, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Updates the baseline non-Plan reasoning effort in `current_collaboration_mode` and, when appropriate, the active non-Plan mask. It intentionally leaves an active Plan mask untouched.

**Data flow**: It accepts an optional `ReasoningEffortConfig`, rewrites `self.current_collaboration_mode` via `with_updates`, conditionally updates `self.active_collaboration_mask.reasoning_effort` only when collaboration modes are enabled and the active mode is not `Plan`, then refreshes model-dependent surfaces. It returns nothing.

**Call relations**: This is the general reasoning-effort setter used outside Plan-specific overrides. It relies on `ChatWidget::collaboration_modes_enabled` to decide whether an active mask should also be updated and ends with `ChatWidget::refresh_model_dependent_surfaces`.

*Call graph*: calls 2 internal fn (collaboration_modes_enabled, refresh_model_dependent_surfaces).


##### `ChatWidget::set_personality`  (lines 184–186)

```
fn set_personality(&mut self, personality: Personality)
```

**Purpose**: Stores the selected personality in config. It does not itself trigger command syncing or redraw.

**Data flow**: It takes a `Personality` and writes `Some(personality)` into `self.config.personality`. It returns nothing.

**Call relations**: This is a plain config mutator used by higher-level personality-selection flows.


##### `ChatWidget::status_account_display`  (lines 188–190)

```
fn status_account_display(&self) -> Option<&StatusAccountDisplay>
```

**Purpose**: Returns the current optional account-display snapshot used by status surfaces. It is a borrowed accessor.

**Data flow**: It reads `self.status_account_display.as_ref()` and returns `Option<&StatusAccountDisplay>`. No state is mutated.

**Call relations**: This accessor exposes account state to other rendering or orchestration code.


##### `ChatWidget::runtime_model_provider_base_url`  (lines 192–194)

```
fn runtime_model_provider_base_url(&self) -> Option<&str>
```

**Purpose**: Returns the optional runtime model-provider base URL as a borrowed string slice. It is a read-only accessor.

**Data flow**: It reads `self.runtime_model_provider_base_url.as_deref()` and returns `Option<&str>`. It has no side effects.

**Call relations**: This helper is used by status/reporting code that needs the provider endpoint currently in effect.


##### `ChatWidget::model_catalog`  (lines 197–199)

```
fn model_catalog(&self) -> Arc<ModelCatalog>
```

**Purpose**: Clones and returns the widget’s shared `Arc<ModelCatalog>`. It provides callers with catalog access without exposing interior mutability details.

**Data flow**: It clones `self.model_catalog` and returns the new `Arc<ModelCatalog>`. No state is changed.

**Call relations**: This accessor is primarily useful in tests and helper code that need catalog queries.


##### `ChatWidget::current_plan_type`  (lines 201–203)

```
fn current_plan_type(&self) -> Option<PlanType>
```

**Purpose**: Returns the current account plan type, if known. It is a simple getter over cached account state.

**Data flow**: It reads `self.plan_type` and returns `Option<PlanType>`. No mutation occurs.

**Call relations**: This accessor feeds UI and command logic that depends on the user’s plan.


##### `ChatWidget::has_chatgpt_account`  (lines 205–207)

```
fn has_chatgpt_account(&self) -> bool
```

**Purpose**: Reports whether the current account state indicates a ChatGPT account. It is a direct boolean getter.

**Data flow**: It returns the value of `self.has_chatgpt_account`. No state is read beyond that field and nothing is mutated.

**Call relations**: This is a pure accessor for account-capability checks.


##### `ChatWidget::has_codex_backend_auth`  (lines 209–211)

```
fn has_codex_backend_auth(&self) -> bool
```

**Purpose**: Reports whether Codex backend authentication is currently available. It is used to gate commands like usage/token activity.

**Data flow**: It returns `self.has_codex_backend_auth` with no side effects.

**Call relations**: This getter supports command-availability and status logic elsewhere.


##### `ChatWidget::update_account_state`  (lines 213–235)

```
fn update_account_state(
        &mut self,
        status_account_display: Option<StatusAccountDisplay>,
        plan_type: Option<PlanType>,
        has_chatgpt_account: bool,
        has_codex_back
```

**Purpose**: Replaces cached account/plan/auth state and resets pending token/rate-limit refresh work when those capabilities change. It also updates bottom-pane command availability tied to connectors and token activity.

**Data flow**: Inputs are optional `StatusAccountDisplay`, optional `PlanType`, and two booleans for ChatGPT account and Codex backend auth. It compares them to existing fields, clears pending token activity and rate-limit refreshes if any relevant account state changed, stores the new values, then updates bottom-pane connector enablement and token-activity command enablement. It returns nothing.

**Call relations**: This method is the account-state synchronization point from higher-level app logic. It does not call other functions in this file, but it coordinates with pending-refresh queues and bottom-pane capability toggles.


##### `ChatWidget::set_tui_theme`  (lines 238–240)

```
fn set_tui_theme(&mut self, theme: Option<String>)
```

**Purpose**: Stores the selected TUI theme override in config. It does not immediately open or refresh any UI by itself.

**Data flow**: It takes an `Option<String>` and assigns it to `self.config.tui_theme`. It returns nothing.

**Call relations**: This is a plain config setter used by theme-picker flows.


##### `ChatWidget::set_model`  (lines 243–256)

```
fn set_model(&mut self, model: &str)
```

**Purpose**: Updates the baseline selected model and, if collaboration modes are active, the current mask’s model override as well. It then recomputes service-tier and model-dependent UI surfaces.

**Data flow**: It takes a model `&str`, rewrites `self.current_collaboration_mode` via `with_updates`, conditionally updates `self.active_collaboration_mask.model` when collaboration modes are enabled, refreshes effective service tier, and refreshes model-dependent surfaces. It returns nothing.

**Call relations**: This setter is the main model-selection path from UI actions. It consults `ChatWidget::collaboration_modes_enabled` to decide whether the active mask should track the new model and then calls `ChatWidget::refresh_model_dependent_surfaces`.

*Call graph*: calls 2 internal fn (collaboration_modes_enabled, refresh_model_dependent_surfaces).


##### `ChatWidget::current_model`  (lines 258–266)

```
fn current_model(&self) -> &str
```

**Purpose**: Resolves the effective model string currently in force, preferring the active collaboration mask when collaboration modes are enabled. Otherwise it falls back to the baseline collaboration-mode settings.

**Data flow**: It reads `self.current_collaboration_mode` and `self.active_collaboration_mask`. If collaboration modes are disabled it returns the baseline model; otherwise it returns `mask.model` when present, falling back to the baseline model. It returns `&str` and mutates nothing.

**Call relations**: This is a foundational resolver used by model-capability checks, display-name generation, and collaboration-mask transitions. It first checks `ChatWidget::collaboration_modes_enabled` before consulting the active mask.

*Call graph*: calls 1 internal fn (collaboration_modes_enabled); called by 4 (current_model_supports_images, current_model_supports_personality, model_display_name, set_collaboration_mask).


##### `ChatWidget::sync_personality_command_enabled`  (lines 268–271)

```
fn sync_personality_command_enabled(&mut self)
```

**Purpose**: Pushes the current Personality feature-flag state into the bottom pane’s command availability. It keeps the slash/UI command surface aligned with config.

**Data flow**: It reads `self.config.features.enabled(Feature::Personality)` and passes that boolean to `self.bottom_pane.set_personality_command_enabled`. It returns nothing.

**Call relations**: This helper is called after thread settings changes and feature toggles. It is one of several bottom-pane command-sync methods used by `set_feature_enabled` and `apply_thread_settings`.

*Call graph*: called by 2 (apply_thread_settings, set_feature_enabled).


##### `ChatWidget::sync_plugins_command_enabled`  (lines 273–276)

```
fn sync_plugins_command_enabled(&mut self)
```

**Purpose**: Pushes the Plugins feature-flag state into the bottom pane. It controls whether plugin-related commands are exposed.

**Data flow**: It reads the Plugins feature flag from config and forwards it to `bottom_pane.set_plugins_command_enabled`. It returns nothing.

**Call relations**: This helper is invoked when plugin feature state changes, especially from `set_feature_enabled`.

*Call graph*: called by 1 (set_feature_enabled).


##### `ChatWidget::sync_goal_command_enabled`  (lines 278–281)

```
fn sync_goal_command_enabled(&mut self)
```

**Purpose**: Pushes the Goals feature-flag state into the bottom pane’s command availability. It keeps goal UI affordances synchronized with config.

**Data flow**: It reads `Feature::Goals` from config and forwards the boolean to `bottom_pane.set_goal_command_enabled`. It returns nothing.

**Call relations**: This helper is called from `set_feature_enabled` and other settings-sync paths whenever goal command visibility must be updated.

*Call graph*: called by 1 (set_feature_enabled).


##### `ChatWidget::sync_mentions_v2_enabled`  (lines 283–286)

```
fn sync_mentions_v2_enabled(&mut self)
```

**Purpose**: Pushes the MentionsV2 feature state into the bottom pane so composer mention behavior matches config. It is a direct UI sync helper.

**Data flow**: It reads the MentionsV2 feature flag and calls `bottom_pane.set_mentions_v2_enabled` with that value. It returns nothing.

**Call relations**: This helper is triggered by `set_feature_enabled` when the mentions implementation changes.

*Call graph*: called by 1 (set_feature_enabled).


##### `ChatWidget::current_model_supports_personality`  (lines 288–300)

```
fn current_model_supports_personality(&self) -> bool
```

**Purpose**: Looks up the effective model in the model catalog and reports whether that preset advertises personality support. Catalog lookup failures or missing presets default to `false`.

**Data flow**: It resolves the current model via `current_model()`, calls `self.model_catalog.try_list_models()`, searches for a preset with a matching `model`, extracts `supports_personality`, and returns that boolean or `false` if lookup fails. It mutates no state.

**Call relations**: This capability check is used by personality UI flows to gate selection. It depends on `ChatWidget::current_model` for the effective model name.

*Call graph*: calls 1 internal fn (current_model).


##### `ChatWidget::current_model_supports_images`  (lines 306–318)

```
fn current_model_supports_images(&self) -> bool
```

**Purpose**: Reports whether the effective model supports image input according to catalog metadata. Unlike personality support, failures default to `true` so transient catalog issues do not block image input in the UI.

**Data flow**: It gets the effective model via `current_model()`, lists models from the catalog, finds the matching preset, checks whether `input_modalities` contains `InputModality::Image`, and returns that result or `true` on lookup failure. It mutates nothing.

**Call relations**: This helper is called by `ChatWidget::sync_image_paste_enabled` to keep composer image-paste affordances aligned with the active model.

*Call graph*: calls 1 internal fn (current_model); called by 1 (sync_image_paste_enabled).


##### `ChatWidget::sync_image_paste_enabled`  (lines 320–323)

```
fn sync_image_paste_enabled(&mut self)
```

**Purpose**: Enables or disables image paste in the bottom pane based on the current model’s image-input capability. It is the UI-facing wrapper around the capability check.

**Data flow**: It computes `enabled` by calling `current_model_supports_images()` and forwards that boolean to `bottom_pane.set_image_paste_enabled`. It returns nothing.

**Call relations**: This helper is called from `ChatWidget::refresh_model_display`, ensuring image-paste affordances update whenever the effective model changes.

*Call graph*: calls 1 internal fn (current_model_supports_images); called by 1 (refresh_model_display).


##### `ChatWidget::image_inputs_not_supported_message`  (lines 325–330)

```
fn image_inputs_not_supported_message(&self) -> String
```

**Purpose**: Formats the user-facing error message shown when the current model does not accept image inputs. The message includes the effective model name.

**Data flow**: It reads `self.current_model()` and interpolates it into a fixed string via `format!`, returning the resulting `String`. It mutates no state.

**Call relations**: This is a pure formatting helper for validation/error paths involving image attachments.

*Call graph*: 1 external calls (format!).


##### `ChatWidget::current_collaboration_mode`  (lines 333–335)

```
fn current_collaboration_mode(&self) -> &CollaborationMode
```

**Purpose**: Returns a shared reference to the baseline stored `CollaborationMode`. It exposes the unmasked mode settings rather than the effective merged mode.

**Data flow**: It returns `&self.current_collaboration_mode` and performs no mutation.

**Call relations**: This accessor is mainly useful in tests and code that needs the raw stored mode state.


##### `ChatWidget::current_reasoning_effort`  (lines 337–339)

```
fn current_reasoning_effort(&self) -> Option<ReasoningEffortConfig>
```

**Purpose**: Returns the currently effective reasoning effort after applying collaboration-mask overrides. It is a thin wrapper around the resolver.

**Data flow**: It calls `effective_reasoning_effort()` and returns the resulting `Option<ReasoningEffortConfig>`. No state is mutated.

**Call relations**: This accessor delegates entirely to `ChatWidget::effective_reasoning_effort`.

*Call graph*: calls 1 internal fn (effective_reasoning_effort).


##### `ChatWidget::on_thread_settings_updated`  (lines 341–357)

```
fn on_thread_settings_updated(
        &mut self,
        notification: ThreadSettingsUpdatedNotification,
    )
```

**Purpose**: Processes a `ThreadSettingsUpdatedNotification` from the app server, validates its thread id, ignores updates for other threads, and applies matching settings to the active widget. Invalid ids are logged and dropped.

**Data flow**: It takes a notification, parses `notification.thread_id` with `ThreadId::from_string`, warns and returns on parse failure, compares the parsed id to `self.thread_id`, and if they match forwards `notification.thread_settings` into `apply_thread_settings`. It returns nothing.

**Call relations**: This is the event-entry point for server-driven thread settings changes. It delegates the actual synchronization work to `ChatWidget::apply_thread_settings` after filtering out malformed or irrelevant notifications.

*Call graph*: calls 2 internal fn (from_string, apply_thread_settings); 1 external calls (warn!).


##### `ChatWidget::active_collaboration_mode_kind`  (lines 360–362)

```
fn active_collaboration_mode_kind(&self) -> ModeKind
```

**Purpose**: Returns the currently active collaboration mode kind for tests. It exposes the same mode resolution used by runtime UI logic.

**Data flow**: It calls `active_mode_kind()` and returns the resulting `ModeKind`. No state changes occur.

**Call relations**: This test-oriented accessor delegates to `ChatWidget::active_mode_kind`.

*Call graph*: calls 1 internal fn (active_mode_kind).


##### `ChatWidget::is_session_configured`  (lines 364–366)

```
fn is_session_configured(&self) -> bool
```

**Purpose**: Reports whether the widget has an active configured session/thread. Presence of `thread_id` is the sole criterion.

**Data flow**: It returns `self.thread_id.is_some()`. No mutation occurs.

**Call relations**: This boolean gate is used by UI flows that must wait until startup/session configuration completes.


##### `ChatWidget::collaboration_modes_enabled`  (lines 368–370)

```
fn collaboration_modes_enabled(&self) -> bool
```

**Purpose**: Reports whether collaboration-mode functionality is enabled for this widget. In the current implementation it is hard-coded to `true`.

**Data flow**: It returns `true` unconditionally and mutates no state.

**Call relations**: Many model/mode helpers branch on this method so the feature can be centrally disabled in the future without rewriting call sites.

*Call graph*: called by 11 (collaboration_mode_indicator, collaboration_mode_label, current_model, cycle_collaboration_mode, effective_collaboration_mode, effective_reasoning_effort, set_collaboration_mask, set_model, set_plan_mode_reasoning_effort, set_reasoning_effort (+1 more)).


##### `ChatWidget::plan_mode_nudge_scope`  (lines 373–376)

```
fn plan_mode_nudge_scope(&self) -> PlanModeNudgeScope
```

**Purpose**: Computes whether Plan-mode nudge dismissal should be scoped to a new-thread draft or an existing thread. The scope depends only on whether a thread id exists yet.

**Data flow**: It reads `self.thread_id` and returns `PlanModeNudgeScope::Thread` when present or `PlanModeNudgeScope::NewThread` otherwise. No state is mutated.

**Call relations**: This helper is used by nudge visibility and dismissal logic so dismissals persist only within the relevant conversation context.

*Call graph*: called by 3 (dismiss_plan_mode_nudge, set_collaboration_mask, should_show_plan_mode_nudge).


##### `ChatWidget::should_show_plan_mode_nudge`  (lines 384–399)

```
fn should_show_plan_mode_nudge(&self) -> bool
```

**Purpose**: Evaluates the full policy for whether the footer should show the Plan-mode nudge for the current draft. It combines draft text inspection with mode availability, task state, popup state, command prefixes, and dismissal scope.

**Data flow**: It reads the composer text from `bottom_pane`, trims leading whitespace, checks collaboration-mode enablement, availability of a Plan preset via `collaboration_modes::plan_mask`, current active mode, composer/task/modal state, slash/shell prefixes, keyword presence via `contains_plan_keyword`, and whether the current dismissal scope is already recorded. It returns a boolean and mutates nothing.

**Call relations**: This policy function is called by `ChatWidget::refresh_plan_mode_nudge`. It depends on `ChatWidget::active_mode_kind`, `ChatWidget::collaboration_modes_enabled`, and `ChatWidget::plan_mode_nudge_scope` to combine lexical and runtime conditions.

*Call graph*: calls 4 internal fn (active_mode_kind, collaboration_modes_enabled, plan_mode_nudge_scope, plan_mask); called by 1 (refresh_plan_mode_nudge).


##### `ChatWidget::refresh_plan_mode_nudge`  (lines 402–405)

```
fn refresh_plan_mode_nudge(&mut self)
```

**Purpose**: Pushes the current Plan-mode nudge visibility decision into the bottom pane. It is the synchronization point between policy and footer rendering.

**Data flow**: It computes visibility by calling `should_show_plan_mode_nudge()` and passes the result to `bottom_pane.set_plan_mode_nudge_visible`. It returns nothing.

**Call relations**: This helper is called after mode changes and nudge dismissals. It delegates all policy to `ChatWidget::should_show_plan_mode_nudge`.

*Call graph*: calls 1 internal fn (should_show_plan_mode_nudge); called by 3 (dismiss_plan_mode_nudge, set_collaboration_mask, set_effective_collaboration_mode).


##### `ChatWidget::dismiss_plan_mode_nudge`  (lines 408–412)

```
fn dismiss_plan_mode_nudge(&mut self)
```

**Purpose**: Marks the current thread/new-thread scope as having dismissed the Plan-mode nudge and immediately refreshes footer visibility. The dismissal lasts until conversation context changes.

**Data flow**: It computes the current scope with `plan_mode_nudge_scope()`, inserts it into `self.dismissed_plan_mode_nudge_scopes`, calls `refresh_plan_mode_nudge()`, and returns nothing.

**Call relations**: This method is the user-action sink for hiding the nudge. It relies on `ChatWidget::plan_mode_nudge_scope` and then re-syncs the footer through `ChatWidget::refresh_plan_mode_nudge`.

*Call graph*: calls 2 internal fn (plan_mode_nudge_scope, refresh_plan_mode_nudge).


##### `ChatWidget::initial_collaboration_mask`  (lines 414–424)

```
fn initial_collaboration_mask(
        _config: &Config,
        model_catalog: &ModelCatalog,
        model_override: Option<&str>,
    ) -> Option<CollaborationModeMask>
```

**Purpose**: Builds the initial active collaboration mask from the catalog default and an optional model override. It is used when a session does not provide an explicit collaboration mode.

**Data flow**: It takes a config reference, a `ModelCatalog`, and an optional model override string. It asks `collaboration_modes::default_mask(model_catalog)` for the default mask, optionally overwrites `mask.model`, and returns `Some(mask)` or `None` if no default exists.

**Call relations**: This helper is called during session configuration to synthesize an active mask when the server snapshot lacks one. It delegates mask creation to `collaboration_modes::default_mask`.

*Call graph*: calls 1 internal fn (default_mask).


##### `ChatWidget::active_mode_kind`  (lines 426–431)

```
fn active_mode_kind(&self) -> ModeKind
```

**Purpose**: Returns the currently active collaboration mode kind, defaulting to `ModeKind::Default` when no active mask exists. It is the canonical mode-kind resolver.

**Data flow**: It reads `self.active_collaboration_mask`, extracts `mask.mode` when present, and falls back to `ModeKind::Default`. It returns the `ModeKind` and mutates nothing.

**Call relations**: This resolver underpins mode labels, indicators, nudge policy, and test accessors throughout the widget.

*Call graph*: called by 5 (active_collaboration_mode_kind, collaboration_mode_indicator, collaboration_mode_label, set_collaboration_mask, should_show_plan_mode_nudge).


##### `ChatWidget::effective_reasoning_effort`  (lines 433–442)

```
fn effective_reasoning_effort(&self) -> Option<ReasoningEffortConfig>
```

**Purpose**: Resolves the reasoning effort currently in force after applying any active collaboration-mask override. If collaboration modes are disabled, it returns the baseline mode’s effort directly.

**Data flow**: It checks `collaboration_modes_enabled()`, reads the baseline effort from `self.current_collaboration_mode`, then prefers `self.active_collaboration_mask.reasoning_effort` when present. It returns `Option<ReasoningEffortConfig>` and mutates nothing.

**Call relations**: This resolver is used by status output and collaboration-mask transitions. It depends on `ChatWidget::collaboration_modes_enabled` to decide whether mask overlay logic applies.

*Call graph*: calls 1 internal fn (collaboration_modes_enabled); called by 2 (current_reasoning_effort, set_collaboration_mask).


##### `ChatWidget::effective_collaboration_mode`  (lines 444–452)

```
fn effective_collaboration_mode(&self) -> CollaborationMode
```

**Purpose**: Returns the fully effective `CollaborationMode` after applying the active mask to the stored baseline mode. If collaboration modes are disabled or no mask exists, it returns the baseline mode unchanged.

**Data flow**: It checks `collaboration_modes_enabled()`, then either clones `self.current_collaboration_mode` or applies `self.active_collaboration_mask` via `self.current_collaboration_mode.apply_mask(mask)`. It returns a new `CollaborationMode` and mutates nothing.

**Call relations**: This merged-mode resolver is used by model display refresh and by outbound thread-op submission when user actions change collaboration settings.

*Call graph*: calls 1 internal fn (collaboration_modes_enabled); called by 2 (refresh_model_display, submit_collaboration_mode_settings_update).


##### `ChatWidget::refresh_model_display`  (lines 454–461)

```
fn refresh_model_display(&mut self)
```

**Purpose**: Refreshes all UI surfaces directly tied to the effective model: the session header text, image-paste affordance, service-tier commands, and terminal title. It is the model-facing half of broader surface refreshes.

**Data flow**: It computes the effective collaboration mode, updates `self.session_header` with `set_model(effective.model())`, calls `sync_image_paste_enabled()`, `sync_service_tier_commands()`, and `refresh_terminal_title()`, then returns. It mutates header and bottom-pane/title state.

**Call relations**: This helper is called by `ChatWidget::refresh_model_dependent_surfaces`. It depends on `ChatWidget::effective_collaboration_mode` and delegates image capability syncing to `ChatWidget::sync_image_paste_enabled`.

*Call graph*: calls 2 internal fn (effective_collaboration_mode, sync_image_paste_enabled); called by 1 (refresh_model_dependent_surfaces).


##### `ChatWidget::refresh_model_dependent_surfaces`  (lines 471–474)

```
fn refresh_model_dependent_surfaces(&mut self)
```

**Purpose**: Refreshes every UI surface that depends on effective model, reasoning effort, or collaboration mode. It exists to keep header/title and footer status-line updates coupled.

**Data flow**: It calls `refresh_model_display()` and `refresh_status_line()`, then returns. Its outputs are whatever those two refresh paths mutate.

**Call relations**: This consolidator is called by setters that mutate collaboration-mode state, including model changes, reasoning-effort changes, and mask updates. It delegates to `ChatWidget::refresh_model_display` and the status-line refresh path.

*Call graph*: calls 1 internal fn (refresh_model_display); called by 5 (set_collaboration_mask, set_effective_collaboration_mode, set_model, set_plan_mode_reasoning_effort, set_reasoning_effort).


##### `ChatWidget::apply_thread_settings`  (lines 476–523)

```
fn apply_thread_settings(&mut self, mut settings: ThreadSettings)
```

**Purpose**: Applies a server-provided `ThreadSettings` snapshot to the active widget, synchronizing cwd, provider/service tier, approvals, reviewer, personality, permission profile, collaboration mode, and dependent UI state. It also refreshes skills when cwd changes.

**Data flow**: It takes mutable `ThreadSettings`, detects whether cwd changed, applies cwd via `apply_thread_settings_cwd`, copies provider id, service tier, approval policy, reviewer, and personality into config, derives a `PermissionProfile` from legacy sandbox policy and cwd, wraps it in a `PermissionProfileSnapshot::from_session_snapshot`, tries constrained permission sync with warning/error fallback to replacement, rewrites `settings.collaboration_mode.settings.model` and `.reasoning_effort` from legacy fields, applies the effective collaboration mode, refreshes service tier and status surfaces, syncs commands, optionally reloads skills for the new cwd, refreshes plugin mentions, and requests redraw. It returns nothing.

**Call relations**: This method is called only from `ChatWidget::on_thread_settings_updated` after thread-id validation. It delegates cwd handling to `ChatWidget::apply_thread_settings_cwd`, approval/reviewer updates to `ChatWidget::set_approval_policy` and `ChatWidget::set_approvals_reviewer`, collaboration-mode application to `ChatWidget::set_effective_collaboration_mode`, and command syncing to `ChatWidget::sync_personality_command_enabled`.

*Call graph*: calls 7 internal fn (from_session_snapshot, from_legacy_sandbox_policy_for_cwd, apply_thread_settings_cwd, set_approval_policy, set_approvals_reviewer, set_effective_collaboration_mode, sync_personality_command_enabled); called by 1 (on_thread_settings_updated); 2 external calls (error!, warn!).


##### `ChatWidget::apply_thread_settings_cwd`  (lines 525–544)

```
fn apply_thread_settings_cwd(&mut self, cwd: AbsolutePathBuf)
```

**Purpose**: Updates the widget’s cwd and rewrites workspace roots so the new cwd replaces the previous cwd when that previous cwd was itself a workspace root. It also keeps permission workspace roots in sync.

**Data flow**: It takes a new `AbsolutePathBuf` cwd, swaps it into `self.config.cwd`, stores `self.current_cwd`, clears the project-root-name cache, and if the previous cwd was among `workspace_roots`, rebuilds the roots vector with the new cwd first and all distinct remaining roots after it. Finally it pushes the updated roots into `self.config.permissions.set_workspace_roots(...)`. It returns nothing.

**Call relations**: This helper is called from `ChatWidget::apply_thread_settings` as the cwd-specific portion of thread-settings synchronization. It encapsulates the subtle workspace-root replacement logic so callers do not duplicate it.

*Call graph*: calls 1 internal fn (to_path_buf); called by 1 (apply_thread_settings); 3 external calls (replace, take, clone).


##### `ChatWidget::set_effective_collaboration_mode`  (lines 546–565)

```
fn set_effective_collaboration_mode(&mut self, mode: CollaborationMode)
```

**Purpose**: Installs a server-provided effective collaboration mode as the active mask and, when that mode is `Default`, also updates the stored baseline mode. It then refreshes indicators, nudge visibility, and model-dependent surfaces.

**Data flow**: It takes a `CollaborationMode`, extracts `mode_kind` and `settings`, conditionally replaces `self.current_collaboration_mode` when the mode is `Default`, constructs a new `CollaborationModeMask` from the mode’s display name and settings, stores it in `self.active_collaboration_mask`, updates indicators, refreshes the Plan nudge, refreshes model-dependent surfaces, and returns nothing.

**Call relations**: This method is called from `ChatWidget::apply_thread_settings` and session configuration paths when the server dictates the effective mode. It delegates follow-up UI synchronization to `ChatWidget::update_collaboration_mode_indicator`, `ChatWidget::refresh_plan_mode_nudge`, and `ChatWidget::refresh_model_dependent_surfaces`.

*Call graph*: calls 3 internal fn (refresh_model_dependent_surfaces, refresh_plan_mode_nudge, update_collaboration_mode_indicator); called by 1 (apply_thread_settings).


##### `ChatWidget::model_display_name`  (lines 567–574)

```
fn model_display_name(&self) -> &str
```

**Purpose**: Returns the effective model name for display, substituting `DEFAULT_MODEL_DISPLAY_NAME` when the resolved model string is empty. It is a presentation helper rather than a capability resolver.

**Data flow**: It reads the current model via `current_model()`, checks whether it is empty, and returns either that string slice or the default display constant. It mutates nothing.

**Call relations**: This helper is used by status/reporting code that wants a non-empty model label. It depends on `ChatWidget::current_model`.

*Call graph*: calls 1 internal fn (current_model).


##### `ChatWidget::collaboration_mode_label`  (lines 577–585)

```
fn collaboration_mode_label(&self) -> Option<&'static str>
```

**Purpose**: Returns the user-visible label for the current collaboration mode when that mode should be shown in the TUI. Hidden or disabled modes yield `None`.

**Data flow**: It first checks `collaboration_modes_enabled()`, then resolves `active_mode_kind()`, asks whether that mode is TUI-visible, and returns `Some(display_name)` or `None`. It mutates no state.

**Call relations**: This presentation helper is used by status output and other UI surfaces that need a textual mode label.

*Call graph*: calls 2 internal fn (active_mode_kind, collaboration_modes_enabled).


##### `ChatWidget::collaboration_mode_indicator`  (lines 587–595)

```
fn collaboration_mode_indicator(&self) -> Option<CollaborationModeIndicator>
```

**Purpose**: Maps the active collaboration mode to the footer indicator enum, currently showing only a dedicated Plan indicator and suppressing indicators for Default/PairProgramming/Execute. Disabled collaboration modes yield no indicator.

**Data flow**: It checks `collaboration_modes_enabled()`, resolves `active_mode_kind()`, and returns `Some(CollaborationModeIndicator::Plan)` only for `ModeKind::Plan`; otherwise it returns `None`. It mutates nothing.

**Call relations**: This helper is used by `ChatWidget::update_collaboration_mode_indicator` and `ChatWidget::refresh_goal_status_indicator_for_time_tick` to decide whether a mode badge should occupy the footer indicator slot.

*Call graph*: calls 2 internal fn (active_mode_kind, collaboration_modes_enabled); called by 2 (refresh_goal_status_indicator_for_time_tick, update_collaboration_mode_indicator).


##### `ChatWidget::update_collaboration_mode_indicator`  (lines 597–607)

```
fn update_collaboration_mode_indicator(&mut self)
```

**Purpose**: Synchronizes the footer’s collaboration-mode indicator and goal-status indicator, giving collaboration mode precedence over goal status. It also caches the currently displayed goal indicator.

**Data flow**: It computes `indicator` via `collaboration_mode_indicator()`. If no collaboration indicator is present, it computes a goal indicator with `goal_status_indicator(Instant::now())`; otherwise goal indicator is forced to `None`. It stores the chosen goal indicator in `self.current_goal_status_indicator`, updates the bottom pane’s collaboration and goal indicators, and returns nothing.

**Call relations**: This method is called after goal updates, collaboration-mode changes, and feature toggles. It delegates indicator selection to `ChatWidget::collaboration_mode_indicator` and `ChatWidget::goal_status_indicator`.

*Call graph*: calls 2 internal fn (collaboration_mode_indicator, goal_status_indicator); called by 4 (on_thread_goal_updated, set_collaboration_mask, set_effective_collaboration_mode, set_feature_enabled); 1 external calls (now).


##### `ChatWidget::refresh_goal_status_indicator_for_time_tick`  (lines 609–618)

```
fn refresh_goal_status_indicator_for_time_tick(&mut self)
```

**Purpose**: Recomputes the goal-status indicator on periodic time ticks, but only when no collaboration-mode indicator is currently occupying that footer slot. It avoids unnecessary bottom-pane updates when the indicator value has not changed.

**Data flow**: It first checks `collaboration_mode_indicator()` and returns early if one exists. Otherwise it computes a fresh goal indicator with `goal_status_indicator(Instant::now())`, compares it to `self.current_goal_status_indicator`, and if different updates the cache and bottom pane. It returns nothing.

**Call relations**: This is the time-driven refresh path for goal indicators. It shares the same indicator helpers as `ChatWidget::update_collaboration_mode_indicator` but only updates when the visible value changes.

*Call graph*: calls 2 internal fn (collaboration_mode_indicator, goal_status_indicator); 1 external calls (now).


##### `ChatWidget::goal_status_indicator`  (lines 620–627)

```
fn goal_status_indicator(&self, now: Instant) -> Option<GoalStatusIndicator>
```

**Purpose**: Computes the current footer goal-status indicator from `current_goal_status` and turn lifecycle timing, but only when the Goals feature is enabled. Without the feature or goal state, it returns `None`.

**Data flow**: It reads the Goals feature flag, `self.current_goal_status`, and `self.turn_lifecycle.goal_status_active_turn_started_at`. If goals are enabled and a goal state exists, it calls `state.indicator(now, started_at)` and returns that result; otherwise it returns `None`. It mutates nothing.

**Call relations**: This helper is used by both collaboration/goal indicator refresh paths to derive the goal badge that may appear in the footer.

*Call graph*: called by 2 (refresh_goal_status_indicator_for_time_tick, update_collaboration_mode_indicator).


##### `ChatWidget::on_thread_goal_updated`  (lines 629–648)

```
fn on_thread_goal_updated(&mut self, goal: AppThreadGoal, turn_id: Option<String>)
```

**Purpose**: Applies a goal update for the active thread, tracks budget-limited turns, and refreshes footer indicators. If Goals are disabled, it clears all goal state instead of storing the update.

**Data flow**: It takes an `AppThreadGoal` and optional `turn_id`, ignores the update if it targets a different active thread, checks the Goals feature flag, clears goal state and indicators when disabled, records budget-limited turns when the status is `BudgetLimited`, stores a new `GoalStatusState::new(goal, Instant::now())` in `self.current_goal_status`, and updates collaboration/goal indicators. It returns nothing.

**Call relations**: This is the event sink for goal-status updates. It delegates state-to-indicator synchronization to `ChatWidget::update_collaboration_mode_indicator` and uses `GoalStatusState::new` to timestamp the new goal state.

*Call graph*: calls 2 internal fn (new, update_collaboration_mode_indicator); 1 external calls (now).


##### `ChatWidget::cycle_collaboration_mode`  (lines 651–662)

```
fn cycle_collaboration_mode(&mut self)
```

**Purpose**: Cycles to the next available collaboration-mode preset and submits that change as a user action. If collaboration modes are disabled or no next mask exists, it does nothing.

**Data flow**: It checks `collaboration_modes_enabled()`, asks `collaboration_modes::next_mask(...)` for the next preset based on the current active mask, and if one exists passes it to `set_collaboration_mask_from_user_action`. It returns nothing.

**Call relations**: This is the high-level mode-cycling action used by UI shortcuts. It delegates actual state mutation and server submission to `ChatWidget::set_collaboration_mask_from_user_action`.

*Call graph*: calls 3 internal fn (collaboration_modes_enabled, set_collaboration_mask_from_user_action, next_mask).


##### `ChatWidget::set_collaboration_mask_from_user_action`  (lines 664–667)

```
fn set_collaboration_mask_from_user_action(&mut self, mask: CollaborationModeMask)
```

**Purpose**: Applies a new collaboration mask locally and immediately submits the resulting effective collaboration mode back to the app/server. It is the user-action wrapper around raw mask mutation.

**Data flow**: It takes a `CollaborationModeMask`, calls `set_collaboration_mask(mask)`, then calls `submit_collaboration_mode_settings_update()`. It returns nothing.

**Call relations**: This method is called by `ChatWidget::cycle_collaboration_mode` and any other user-driven mode selection path. It sequences local UI update before outbound settings submission.

*Call graph*: calls 2 internal fn (set_collaboration_mask, submit_collaboration_mode_settings_update); called by 1 (cycle_collaboration_mode).


##### `ChatWidget::set_collaboration_mask`  (lines 673–714)

```
fn set_collaboration_mask(&mut self, mut mask: CollaborationModeMask)
```

**Purpose**: Installs a new active collaboration mask, applies Plan-specific reasoning and nudge-dismissal rules, refreshes dependent UI, and emits an informational history message when the mode switch changes both mode and effective model/effort. It is the core local collaboration-mode mutation path.

**Data flow**: It takes a mutable `CollaborationModeMask`, returns early if collaboration modes are disabled, snapshots previous mode/model/effort, injects the configured Plan reasoning override when switching to Plan, records Plan nudge dismissal for the current scope, stores the mask in `self.active_collaboration_mask`, updates indicators and model-dependent surfaces, computes next mode/model/effort, optionally builds and adds an info message describing the model/effort chosen for the new mode, and requests redraw. It returns nothing.

**Call relations**: This method is called by `ChatWidget::set_collaboration_mask_from_user_action`. It relies on `ChatWidget::active_mode_kind`, `ChatWidget::current_model`, `ChatWidget::effective_reasoning_effort`, `ChatWidget::plan_mode_nudge_scope`, `ChatWidget::update_collaboration_mode_indicator`, `ChatWidget::refresh_plan_mode_nudge`, and `ChatWidget::refresh_model_dependent_surfaces` to keep all dependent state coherent.

*Call graph*: calls 8 internal fn (active_mode_kind, collaboration_modes_enabled, current_model, effective_reasoning_effort, plan_mode_nudge_scope, refresh_model_dependent_surfaces, refresh_plan_mode_nudge, update_collaboration_mode_indicator); called by 1 (set_collaboration_mask_from_user_action); 1 external calls (format!).


##### `ChatWidget::submit_collaboration_mode_settings_update`  (lines 716–737)

```
fn submit_collaboration_mode_settings_update(&self)
```

**Purpose**: Sends the current effective collaboration mode to the app layer as a thread operation override, but only when a thread id exists. It persists user-selected mode changes beyond local widget state.

**Data flow**: It reads `self.thread_id`; if absent it returns early. Otherwise it computes `self.effective_collaboration_mode()` and sends `AppEvent::SubmitThreadOp` containing `AppCommand::override_turn_context(..., Some(effective_mode), ...)` through `app_event_tx`. It returns nothing.

**Call relations**: This outbound submission helper is called by `ChatWidget::set_collaboration_mask_from_user_action` after local mask mutation. It delegates effective-mode resolution to `ChatWidget::effective_collaboration_mode` and command construction to `AppCommand::override_turn_context`.

*Call graph*: calls 1 internal fn (effective_collaboration_mode); called by 1 (set_collaboration_mask_from_user_action); 1 external calls (override_turn_context).


### `tui/src/keymap.rs`

`domain_logic` · `config load and runtime keymap refresh`

This file defines the full runtime keymap model used by the TUI: `RuntimeKeymap` contains per-surface structs (`AppKeymap`, `ChatKeymap`, `ComposerKeymap`, `EditorKeymap`, `VimNormalKeymap`, `VimOperatorKeymap`, `VimTextObjectKeymap`, `PagerKeymap`, `ListKeymap`, `ApprovalKeymap`), each storing `Vec<KeyBinding>` for every configurable action. The core path is `RuntimeKeymap::from_config`, which starts from built-in defaults, resolves each action from config using either local precedence or `context -> global -> default` fallback, then applies compatibility pruning rules for newer defaults that would otherwise collide with explicitly configured legacy bindings. That pruning is especially visible for Vim operator/text-object additions, list page/jump defaults, and reasoning-effort arrow aliases.

Parsing is strict and canonical: `parse_bindings` accepts `KeybindingsSpec` values, converts each string through `parse_keybinding`, de-duplicates while preserving first-seen order, and returns path-aware error messages. Empty configured arrays are authoritative unbinds rather than “missing” values, which is why fallback helpers distinguish `None` from `Some(Many([]))`.

Validation is multi-pass and mirrors actual event routing. `validate_conflicts` checks uniqueness within contexts, rejects collisions with reserved fixed shortcuts, and rejects shadowing where outer handlers consume keys before inner widgets ever see them. It also has a special combined approval/list overlay pass with one explicit `Esc` overlap exception. The result is a snapshot UI code can trust without re-merging or re-validating.

#### Function details

##### `primary_binding`  (lines 270–272)

```
fn primary_binding(bindings: &[KeyBinding]) -> Option<KeyBinding>
```

**Purpose**: Returns the first `KeyBinding` in a binding list so UI code can show one concise hint for an action. It intentionally does not inspect alternates beyond the first entry.

**Data flow**: Reads a borrowed slice of `KeyBinding` values, takes `bindings.first()`, copies that binding if present, and returns `Option<KeyBinding>` without mutating any state.

**Call relations**: Used by rendering and hint-building code when a single representative shortcut is needed after this module has already resolved and ordered the full binding set.

*Call graph*: called by 9 (ensure_status_indicator, set_keymap_bindings, set_task_running, approval_footer_hint, new_with_config, set_keymap_bindings, build, standard_popup_hint_line_for_keymap, skills_toggle_hint_line); 1 external calls (first).


##### `RuntimeKeymap::defaults`  (lines 372–374)

```
fn defaults() -> Self
```

**Purpose**: Exposes the built-in runtime keymap snapshot without consulting user config. It is mainly a convenience for tests and for initializing UI state before config resolution.

**Data flow**: Takes no inputs, delegates directly to the internal default table builder, and returns a fully populated `RuntimeKeymap` value.

**Call relations**: Called by tests and bootstrap paths that need a conflict-free baseline keymap before any config overrides are loaded.

*Call graph*: called by 107 (make_test_app, clear_only_ui_reset_preserves_chat_session_state, make_test_app, make_test_app_with_channels, new, new, remapped_horizontal_list_keys_control_action_selection, additional_permissions_exec_options_hide_execpolicy_amendment, apply_patch_prompt_with_thread_label_omits_command_line, configured_list_cancel_aborts_exec_approval (+15 more)); 1 external calls (built_in_defaults).


##### `RuntimeKeymap::from_config`  (lines 386–902)

```
fn from_config(keymap: &TuiKeymap) -> Result<Self, String>
```

**Purpose**: Builds a fully resolved `RuntimeKeymap` from a `TuiKeymap`, applying per-action precedence, parsing canonical key specs, preserving explicit unbinds, pruning overlapping new defaults, and validating the final result. It is the authoritative conversion from config schema to dispatch-ready runtime state.

**Data flow**: Consumes a borrowed `TuiKeymap`, reads built-in defaults, resolves each action via `resolve_bindings`, `resolve_bindings_with_global_fallback` through macros, and `resolve_new_default_bindings`, computes configured-binding preservation sets, conditionally removes fallback aliases or newly introduced defaults that would overlap configured legacy bindings, assembles the final `RuntimeKeymap`, runs `validate_conflicts`, and returns either `Ok(RuntimeKeymap)` or a user-facing `Err(String)`.

**Call relations**: Invoked by startup, config-apply flows, and `/keymap` editing paths whenever config must be turned into active bindings. It delegates parsing and precedence to the helper resolvers and relies on `validate_conflicts` to enforce the same routing assumptions the rest of the TUI uses.

*Call graph*: calls 4 internal fn (configured_bindings_to_preserve, configured_main_surface_alias_is_used, resolve_bindings, resolve_new_default_bindings); called by 48 (run, apply_keymap_capture, apply_keymap_clear, new_with_op_target, open_keymap_picker, dispatch_prepared_command_with_args, copy_shortcut_can_be_remapped, configured_app_bindings_prune_new_list_default_overlaps, configured_approval_bindings_prune_new_list_default_overlaps, configured_legacy_list_bindings_can_prune_all_new_default_keys (+15 more)); 3 external calls (built_in_defaults, resolve_local!, resolve_with_global!).


##### `RuntimeKeymap::built_in_defaults`  (lines 909–1153)

```
fn built_in_defaults() -> Self
```

**Purpose**: Constructs the canonical built-in binding table for every configurable action. The table includes compatibility aliases for terminals that report printable and shifted keys inconsistently.

**Data flow**: Creates and returns a `RuntimeKeymap` literal whose nested structs are filled with `Vec<KeyBinding>` values produced by the `default_bindings!` macro and helper constructors such as plain, ctrl, alt, shift, and raw combined-modifier bindings.

**Call relations**: Used internally by both `defaults` and `from_config` as the fallback source of truth for all actions.

*Call graph*: 1 external calls (default_bindings!).


##### `RuntimeKeymap::validate_conflicts`  (lines 1164–1688)

```
fn validate_conflicts(&self) -> Result<(), String>
```

**Purpose**: Checks that the resolved keymap is safe to dispatch given the TUI’s layered input routing. It rejects duplicate bindings within a context, collisions with reserved fixed shortcuts, and shadowing between outer and inner handlers that share the same focused path.

**Data flow**: Reads the already resolved binding vectors from `self`, feeds grouped slices into `validate_unique`, `validate_no_reserved`, and `validate_no_shadow_with_allowed_overlaps`, performs an additional combined approval/list duplicate scan with one hard-coded `Esc` exception, and returns `Ok(())` or a descriptive `Err(String)`.

**Call relations**: Called only after resolution in `from_config`; it is the final gate before a runtime keymap becomes active.

*Call graph*: calls 5 internal fn (ctrl, plain, validate_no_reserved, validate_no_shadow_with_allowed_overlaps, validate_unique); 3 external calls (new, Char, format!).


##### `validate_unique`  (lines 1695–1713)

```
fn validate_unique(
    context: &str,
    pairs: [(&'static str, &[KeyBinding]); N],
) -> Result<(), String>
```

**Purpose**: Rejects duplicate key assignments inside one effective context map. It allows the same key in unrelated contexts because only one context is evaluated at a time.

**Data flow**: Takes a context label and a fixed-size array of `(action_name, &[KeyBinding])` pairs, inserts each binding’s `(KeyCode, KeyModifiers)` tuple into a `HashMap`, and returns an error string naming the first conflicting pair if a tuple is seen twice.

**Call relations**: Used repeatedly by `RuntimeKeymap::validate_conflicts` for editor, vim, pager, list, approval, and app-scope uniqueness passes.

*Call graph*: called by 1 (validate_conflicts); 2 external calls (new, format!).


##### `validate_no_shadow_with_allowed_overlaps`  (lines 1715–1749)

```
fn validate_no_shadow_with_allowed_overlaps(
    context: &str,
    primary: [(&'static str, &[KeyBinding]); N],
    shadowed: [(&'static str, &[KeyBinding]); M],
    allowed_overlaps: [(&'static str,
```

**Purpose**: Detects cases where bindings in an outer handler layer would consume keys before an inner layer could act on them. It supports a small allowlist for intentional overlaps.

**Data flow**: Accepts a context label, arrays of primary and shadowed action bindings, and explicit allowed overlap triples; records all primary key tuples in a `HashMap`, scans shadowed bindings for matches, skips allowlisted overlaps, and otherwise returns an error naming the shadowing action pair.

**Call relations**: Called by `RuntimeKeymap::validate_conflicts` for app-vs-list/approval, request-user-input, and main-vs-editor routing checks.

*Call graph*: called by 1 (validate_conflicts); 3 external calls (new, format!, iter).


##### `validate_no_reserved`  (lines 1751–1782)

```
fn validate_no_reserved(
    context: &str,
    pairs: [(&'static str, &[KeyBinding]); N],
    reserved: &[(&'static str, KeyBinding)],
    allowed_overlaps: [(&'static str, &'static str, KeyBinding);
```

**Purpose**: Prevents configurable actions from taking keys reserved by fixed non-configurable shortcuts. It also supports narrow exceptions where a reserved overlap is intentionally tolerated.

**Data flow**: Iterates over provided action binding slices, compares each binding tuple against a reserved slice of `(reserved_action, KeyBinding)`, checks an allowlist of `(action, reserved_action, binding)` exceptions, and returns an explanatory error string on the first forbidden collision.

**Call relations**: Used by `RuntimeKeymap::validate_conflicts` for main-surface and pager reserved-key enforcement.

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

**Purpose**: Resolves one action using `context override -> global fallback -> built-in default` precedence. It preserves explicit unbinding by treating a configured empty list as authoritative.

**Data flow**: Reads optional context-local and global `KeybindingsSpec` references plus a fallback slice and config path; if the local spec exists it parses that, else if the global spec exists it parses that, else clones the fallback bindings into a new `Vec<KeyBinding>`.

**Call relations**: Used by `from_config` for actions like composer submit/queue/toggle_shortcuts that intentionally support global reuse.

*Call graph*: calls 1 internal fn (parse_bindings); 1 external calls (to_vec).


##### `resolve_bindings`  (lines 1854–1863)

```
fn resolve_bindings(
    configured: Option<&KeybindingsSpec>,
    fallback: &[KeyBinding],
    path: &str,
) -> Result<Vec<KeyBinding>, String>
```

**Purpose**: Resolves one action that does not support global fallback. Missing config inherits defaults, while any configured value—including an empty list—replaces them.

**Data flow**: Takes an optional `KeybindingsSpec`, fallback slice, and config path; returns `fallback.to_vec()` when config is absent, otherwise parses the configured spec into a new binding vector.

**Call relations**: This is the standard resolver used throughout `from_config` for most actions and contexts.

*Call graph*: calls 1 internal fn (parse_bindings); called by 1 (from_config); 1 external calls (to_vec).


##### `configured_bindings_to_preserve`  (lines 1865–1880)

```
fn configured_bindings_to_preserve(
    pairs: [(Option<&KeybindingsSpec>, &[KeyBinding]); N],
) -> Vec<KeyBinding>
```

**Purpose**: Collects the resolved bindings belonging to actions that were explicitly configured, producing a de-duplicated preservation set. That set is later used to prune newly introduced defaults that would otherwise steal configured legacy keys.

**Data flow**: Consumes an array of `(Option<&KeybindingsSpec>, &[KeyBinding])` pairs, skips entries with `None`, appends each resolved binding once into a `Vec<KeyBinding>`, and returns that vector.

**Call relations**: Called by `from_config` in several compatibility sections for vim, list, app, and approval overlap pruning.

*Call graph*: called by 1 (from_config); 1 external calls (new).


##### `configured_main_surface_alias_is_used`  (lines 1882–1904)

```
fn configured_main_surface_alias_is_used(keymap: &TuiKeymap, alias: &str) -> bool
```

**Purpose**: Checks whether a canonical alias string such as `shift-up` or `shift-down` appears anywhere on the main input path where it would conflict with fallback reasoning shortcuts. It intentionally masks global composer fallbacks when a composer-local override exists.

**Data flow**: Clones `keymap.global`, clears global submit/queue/toggle_shortcuts fallbacks when corresponding composer-local settings are present, then scans the adjusted global section plus chat, composer, editor, and vim contexts via `configured_context_alias_is_used`, returning a boolean.

**Call relations**: Used by `from_config` to decide whether default reasoning-effort arrow aliases should be removed before validation.

*Call graph*: calls 1 internal fn (configured_context_alias_is_used); called by 1 (from_config).


##### `configured_context_alias_is_used`  (lines 1906–1911)

```
fn configured_context_alias_is_used(context: &impl Serialize, alias: &str) -> bool
```

**Purpose**: Searches one serializable config context for a specific canonical key alias string. It is a generic bridge from typed config structs to recursive JSON-value scanning.

**Data flow**: Serializes the provided context with `serde_json::to_value`; on success it recursively searches the resulting `Value` for the alias string, and on serialization failure returns `false`.

**Call relations**: Called by `configured_main_surface_alias_is_used` for each relevant config subsection.

*Call graph*: calls 1 internal fn (keymap_value_contains_alias); called by 1 (configured_main_surface_alias_is_used); 1 external calls (to_value).


##### `keymap_value_contains_alias`  (lines 1913–1926)

```
fn keymap_value_contains_alias(value: &serde_json::Value, alias: &str) -> bool
```

**Purpose**: Recursively searches a `serde_json::Value` tree for an exact string alias match. It understands strings, arrays, and objects and ignores scalar non-string values.

**Data flow**: Pattern-matches on a `serde_json::Value`; compares strings directly, recursively scans arrays and object values, and returns `false` for booleans, numbers, and null.

**Call relations**: This is the recursive worker behind `configured_context_alias_is_used`.

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

**Purpose**: Resolves actions whose newer built-in defaults should disappear when they overlap explicitly configured older bindings elsewhere on the same surface. Missing config inherits only the non-preserved subset of fallback bindings.

**Data flow**: Given an optional configured spec, fallback slice, preservation slice, and path, it either parses the configured spec or filters `fallback` to exclude any binding present in `configured_bindings_to_preserve`, collecting the remainder into a new vector.

**Call relations**: Used by `from_config` for list page/jump/horizontal actions that were added after older movement bindings already existed in user configs.

*Call graph*: calls 1 internal fn (parse_bindings); called by 1 (from_config); 1 external calls (iter).


##### `parse_bindings`  (lines 1948–1964)

```
fn parse_bindings(spec: &KeybindingsSpec, path: &str) -> Result<Vec<KeyBinding>, String>
```

**Purpose**: Parses one config value—either a single string or a list of strings—into concrete `KeyBinding` values. It preserves first-seen order while removing duplicates so the first binding remains the primary hint.

**Data flow**: Iterates over `spec.specs()`, parses each raw string with `parse_keybinding`, converts parse failures into path-specific error messages, appends only unseen bindings to a `Vec<KeyBinding>`, and returns that vector.

**Call relations**: This is the shared parser used by all resolver helpers.

*Call graph*: calls 2 internal fn (specs, parse_keybinding); called by 3 (resolve_bindings, resolve_bindings_with_global_fallback, resolve_new_default_bindings); 1 external calls (new).


##### `parse_keybinding`  (lines 1970–2022)

```
fn parse_keybinding(spec: &str) -> Option<KeyBinding>
```

**Purpose**: Parses one normalized canonical key spec like `ctrl-a`, `shift-enter`, `page-down`, or `f12` into a `KeyBinding`. It is intentionally strict so runtime diagnostics stay precise.

**Data flow**: Splits the input string on `-`, accumulates supported modifiers into `KeyModifiers`, reconstructs the remaining key name, maps named keys and single ASCII characters to `KeyCode`, validates function-key ranges against `MAX_FUNCTION_KEY`, and returns `Some(KeyBinding::new(...))` or `None` for unsupported forms.

**Call relations**: Called by `parse_bindings` for runtime config parsing and directly by parser-focused tests.

*Call graph*: calls 1 internal fn (new); called by 2 (parse_bindings, parses_canonical_binding); 3 external calls (Char, F, from).


##### `tests::one`  (lines 2029–2031)

```
fn one(spec: &str) -> KeybindingsSpec
```

**Purpose**: Builds a single-entry `KeybindingsSpec` test fixture from one canonical key string. It keeps tests concise when assigning one binding.

**Data flow**: Wraps the provided `&str` in `KeybindingSpec(String)` and then in `KeybindingsSpec::One`, returning the constructed value.

**Call relations**: Used throughout the test module to populate individual config slots.

*Call graph*: 2 external calls (new, One).


##### `tests::expect_conflict`  (lines 2033–2037)

```
fn expect_conflict(keymap: &TuiKeymap, first: &str, second: &str)
```

**Purpose**: Asserts that resolving a test keymap fails and that the error mentions two expected action names. It standardizes conflict assertions across many scenarios.

**Data flow**: Calls `RuntimeKeymap::from_config`, expects an error, then checks the returned message string for both provided substrings.

**Call relations**: Shared by many conflict-oriented tests in this file.

*Call graph*: calls 1 internal fn (from_config); 1 external calls (assert!).


##### `tests::parses_canonical_binding`  (lines 2040–2047)

```
fn parses_canonical_binding()
```

**Purpose**: Verifies that a multi-modifier canonical spec parses into the expected key code and modifier bitset.

**Data flow**: Parses `ctrl-alt-shift-a`, extracts the resulting binding parts, and compares them against `KeyCode::Char('a')` and the combined modifier flags.

**Call relations**: Directly exercises `parse_keybinding` as a parser sanity check.

*Call graph*: calls 1 internal fn (parse_keybinding); 1 external calls (assert_eq!).


##### `tests::rejects_shadowing_composer_binding_in_app_scope`  (lines 2050–2058)

```
fn rejects_shadowing_composer_binding_in_app_scope()
```

**Purpose**: Checks that an app-level binding cannot reuse the same key as `composer.submit` because app handlers run first.

**Data flow**: Builds a default `TuiKeymap`, assigns `ctrl-t` to both `global.open_transcript` and `composer.submit`, resolves it, and asserts the error mentions both actions.

**Call relations**: Covers the app-vs-composer shadowing pass in `validate_conflicts`.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_composer_queue_in_app_scope`  (lines 2061–2069)

```
fn rejects_shadowing_composer_queue_in_app_scope()
```

**Purpose**: Checks that `composer.queue` cannot be shadowed by an app-level binding on the same key.

**Data flow**: Configures `global.open_external_editor` and `composer.queue` to `ctrl-g`, resolves, and asserts both action names appear in the error.

**Call relations**: Exercises the same app-scope shadowing rule for a different composer action.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_composer_toggle_shortcuts_in_app_scope`  (lines 2072–2080)

```
fn rejects_shadowing_composer_toggle_shortcuts_in_app_scope()
```

**Purpose**: Verifies that `composer.toggle_shortcuts` conflicts when it shares a key with an app-level action.

**Data flow**: Assigns `ctrl-k` to `global.open_transcript` and `composer.toggle_shortcuts`, resolves, and checks the conflict message.

**Call relations**: Another targeted test of app-before-composer dispatch ordering.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_editor_binding_in_main_scope`  (lines 2083–2091)

```
fn rejects_shadowing_editor_binding_in_main_scope()
```

**Purpose**: Ensures a main-surface action cannot steal a key from an editor action that would otherwise never receive it.

**Data flow**: Sets both `composer.submit` and `editor.insert_newline` to `ctrl-j`, resolves, and asserts the resulting error names both bindings.

**Call relations**: Covers the main-vs-editor shadowing validation pass.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_editor_binding_from_outer_main_handler`  (lines 2094–2102)

```
fn rejects_shadowing_editor_binding_from_outer_main_handler()
```

**Purpose**: Checks that outer app handlers also conflict with editor bindings on the focused composer path.

**Data flow**: Assigns `ctrl-y` to `global.copy` and `editor.yank`, resolves, and verifies the conflict message.

**Call relations**: Exercises another branch of the main-vs-editor shadowing rules.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_approval_binding_in_app_scope`  (lines 2105–2112)

```
fn rejects_shadowing_approval_binding_in_app_scope()
```

**Purpose**: Verifies that app-level bindings cannot collide with approval overlay actions evaluated on the same overlay surface.

**Data flow**: Sets `global.open_transcript` to `y`, resolves defaults plus override, and checks that the error mentions `approval.approve` and `open_transcript`.

**Call relations**: Covers the app-vs-approval/list overlap validation.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_shadowing_list_binding_in_app_scope`  (lines 2115–2122)

```
fn rejects_shadowing_list_binding_in_app_scope()
```

**Purpose**: Verifies that app-level bindings cannot collide with list navigation bindings on popup surfaces.

**Data flow**: Assigns `down` to `global.copy`, resolves, and asserts the error mentions `list.move_down` and `copy`.

**Call relations**: Exercises the app-vs-list shadowing pass.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::supports_string_or_array_bindings`  (lines 2125–2142)

```
fn supports_string_or_array_bindings()
```

**Purpose**: Checks that config accepts both single-string and array forms, and that invalid modifiers still produce path-aware errors.

**Data flow**: First sets `composer.submit` to a `Many` list containing `ctrl-enter` and invalid `meta-enter`, expects an error mentioning the config path; then replaces it with two valid entries and asserts the resolved runtime vector has length two.

**Call relations**: Exercises `parse_bindings` through `from_config` for both accepted shapes and invalid modifier rejection.

*Call graph*: calls 1 internal fn (from_config); 5 external calls (assert!, assert_eq!, Many, default, vec!).


##### `tests::deduplicates_repeated_bindings_while_preserving_first_seen_order`  (lines 2145–2161)

```
fn deduplicates_repeated_bindings_while_preserving_first_seen_order()
```

**Purpose**: Confirms repeated config entries collapse to one binding without reordering the remaining entries.

**Data flow**: Configures `composer.submit` with duplicate `ctrl-enter` plus `ctrl-shift-enter`, resolves, and compares the resulting vector against the expected two-entry ordered list.

**Call relations**: Directly validates `parse_bindings` de-duplication semantics.

*Call graph*: calls 1 internal fn (from_config); 4 external calls (assert_eq!, Many, default, vec!).


##### `tests::falls_back_to_global_binding_when_context_override_is_not_set`  (lines 2164–2173)

```
fn falls_back_to_global_binding_when_context_override_is_not_set()
```

**Purpose**: Checks that composer actions supporting global fallback inherit from `tui.keymap.global` when no local override exists.

**Data flow**: Sets `global.queue` to `ctrl-q`, resolves the runtime keymap, and asserts `runtime.composer.queue` contains that binding.

**Call relations**: Exercises `resolve_bindings_with_global_fallback` through `from_config`.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::invalid_global_open_transcript_binding_reports_global_path`  (lines 2176–2182)

```
fn invalid_global_open_transcript_binding_reports_global_path()
```

**Purpose**: Ensures parse errors for global bindings mention the exact global config path.

**Data flow**: Assigns invalid `meta-t` to `global.open_transcript`, resolves, and checks the error string for `tui.keymap.global.open_transcript`.

**Call relations**: Verifies path propagation from `resolve_bindings` into parser errors.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::invalid_global_open_external_editor_binding_reports_global_path`  (lines 2185–2191)

```
fn invalid_global_open_external_editor_binding_reports_global_path()
```

**Purpose**: Ensures parse errors for `global.open_external_editor` mention the correct config path.

**Data flow**: Sets invalid `meta-g`, resolves, and asserts the error contains `tui.keymap.global.open_external_editor`.

**Call relations**: Another path-specific parser diagnostic test.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::default_copy_binding_is_ctrl_o`  (lines 2194–2197)

```
fn default_copy_binding_is_ctrl_o()
```

**Purpose**: Checks one representative built-in default binding.

**Data flow**: Builds `RuntimeKeymap::defaults()` and compares `runtime.app.copy` to `ctrl-o`.

**Call relations**: Sanity-checks the built-in default table.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::defaults_include_reassignable_main_surface_actions`  (lines 2200–2239)

```
fn defaults_include_reassignable_main_surface_actions()
```

**Purpose**: Verifies several main-surface defaults and intentionally unbound actions are present in the built-in table.

**Data flow**: Reads multiple fields from `RuntimeKeymap::defaults()` and compares them against expected vectors or empty lists.

**Call relations**: Covers default-table contents for app, chat, composer, and editor actions.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::defaults_include_list_page_and_jump_actions`  (lines 2242–2296)

```
fn defaults_include_list_page_and_jump_actions()
```

**Purpose**: Checks that list navigation defaults include the newer page and jump actions with their expected aliases.

**Data flow**: Builds defaults and asserts the exact vectors for list movement, paging, and jump actions.

**Call relations**: Documents and guards the built-in list defaults that interact with compatibility pruning.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::configured_main_surface_bindings_prune_reasoning_fallback_aliases`  (lines 2299–2319)

```
fn configured_main_surface_bindings_prune_reasoning_fallback_aliases()
```

**Purpose**: Verifies that fallback reasoning arrow aliases are removed when those aliases are explicitly used elsewhere on the main input path.

**Data flow**: Configures `editor.move_up` as `shift-up` and `vim_text_object.word` as `shift-down`, resolves, and asserts the editor/vim bindings remain while the corresponding reasoning-effort fallback aliases are pruned from chat bindings.

**Call relations**: Exercises `configured_main_surface_alias_is_used` and the reasoning-alias pruning logic in `from_config`.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_reasoning_binding_still_conflicts_with_editor_binding`  (lines 2322–2328)

```
fn explicit_reasoning_binding_still_conflicts_with_editor_binding()
```

**Purpose**: Shows that explicit reasoning bindings remain authoritative and therefore still conflict with editor bindings on the same key.

**Data flow**: Assigns `shift-up` to both `editor.move_up` and `chat.increase_reasoning_effort`, then uses `expect_conflict` to assert failure.

**Call relations**: Distinguishes fallback alias pruning from explicit user-configured collisions.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_list_bindings_prune_new_default_overlaps`  (lines 2331–2351)

```
fn configured_legacy_list_bindings_prune_new_default_overlaps()
```

**Purpose**: Checks that explicitly configured legacy list movement keys remove overlapping newer page defaults instead of causing conflicts.

**Data flow**: Sets `list.move_up` to `page-up` and `list.move_down` to `page-down`, resolves, and asserts the movement bindings keep those keys while `list.page_up` and `list.page_down` retain only their non-overlapping defaults.

**Call relations**: Exercises `resolve_new_default_bindings` and preservation-set logic for list compatibility.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::configured_legacy_list_bindings_can_prune_all_new_default_keys`  (lines 2354–2371)

```
fn configured_legacy_list_bindings_can_prune_all_new_default_keys()
```

**Purpose**: Verifies that compatibility pruning can remove every default key from a newer action, leaving it unbound.

**Data flow**: Configures `list.move_up` with both `page-up` and `ctrl-b`, resolves, and asserts `list.page_up` becomes an empty vector.

**Call relations**: Covers the extreme case of list default pruning.

*Call graph*: calls 1 internal fn (from_config); 4 external calls (assert_eq!, Many, default, vec!).


##### `tests::explicit_new_list_bindings_still_conflict_with_legacy_bindings`  (lines 2374–2380)

```
fn explicit_new_list_bindings_still_conflict_with_legacy_bindings()
```

**Purpose**: Ensures explicit configuration of both old and new list actions to the same key still fails rather than being silently pruned.

**Data flow**: Sets both `list.move_up` and `list.page_up` to `page-up` and expects a conflict.

**Call relations**: Confirms pruning only applies to missing defaults, not explicit user assignments.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_app_bindings_prune_new_list_default_overlaps`  (lines 2383–2394)

```
fn configured_app_bindings_prune_new_list_default_overlaps()
```

**Purpose**: Checks that explicit app bindings can prune overlapping newer list defaults.

**Data flow**: Assigns `page-down` to `global.copy`, resolves, and asserts `runtime.app.copy` uses that key while `runtime.list.page_down` keeps only `ctrl-f`.

**Call relations**: Exercises cross-surface preservation logic used before resolving new list defaults.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::configured_approval_bindings_prune_new_list_default_overlaps`  (lines 2397–2408)

```
fn configured_approval_bindings_prune_new_list_default_overlaps()
```

**Purpose**: Checks that explicit approval bindings can prune overlapping newer list defaults on the shared overlay surface.

**Data flow**: Sets `approval.approve` to `home`, resolves, and asserts `approval.approve` keeps `home` while `list.jump_top` becomes empty.

**Call relations**: Covers approval/list preservation behavior.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_list_bindings_still_conflict_with_configured_approval_bindings`  (lines 2411–2417)

```
fn explicit_new_list_bindings_still_conflict_with_configured_approval_bindings()
```

**Purpose**: Ensures explicit overlap between approval and list actions still raises a conflict.

**Data flow**: Assigns `home` to both `approval.approve` and `list.jump_top` and expects a conflict.

**Call relations**: Confirms explicit user overlap is not auto-pruned.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_vim_normal_bindings_prune_new_change_operator_default`  (lines 2420–2431)

```
fn configured_legacy_vim_normal_bindings_prune_new_change_operator_default()
```

**Purpose**: Verifies that a configured legacy Vim normal binding can remove the newer default `start_change_operator` binding when they overlap.

**Data flow**: Sets `vim_normal.move_left` to `c`, resolves, and asserts `move_left` uses `c` while `start_change_operator` becomes empty.

**Call relations**: Exercises Vim normal compatibility pruning in `from_config`.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_vim_normal_binding_still_conflicts_with_legacy_binding`  (lines 2434–2440)

```
fn explicit_new_vim_normal_binding_still_conflicts_with_legacy_binding()
```

**Purpose**: Ensures explicit overlap between a legacy Vim normal action and the newer change operator still conflicts.

**Data flow**: Assigns `c` to both `vim_normal.move_left` and `vim_normal.start_change_operator` and expects a conflict.

**Call relations**: Confirms pruning only affects missing defaults.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_vim_normal_bindings_prune_new_substitute_default`  (lines 2443–2454)

```
fn configured_legacy_vim_normal_bindings_prune_new_substitute_default()
```

**Purpose**: Checks that configured legacy Vim bindings can prune the newer default `substitute_char` binding.

**Data flow**: Sets `vim_normal.move_left` to `s`, resolves, and asserts `move_left` uses `s` while `substitute_char` becomes empty.

**Call relations**: Covers the second Vim normal compatibility branch.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_vim_normal_substitute_binding_still_conflicts_with_legacy_binding`  (lines 2457–2463)

```
fn explicit_new_vim_normal_substitute_binding_still_conflicts_with_legacy_binding()
```

**Purpose**: Ensures explicit overlap with `substitute_char` still fails.

**Data flow**: Assigns `s` to both `vim_normal.move_left` and `vim_normal.substitute_char` and expects a conflict.

**Call relations**: Another explicit-overlap guard for Vim normal mode.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::configured_legacy_vim_operator_bindings_prune_new_text_object_defaults`  (lines 2466–2483)

```
fn configured_legacy_vim_operator_bindings_prune_new_text_object_defaults()
```

**Purpose**: Verifies that configured legacy Vim operator motions can prune the newer inner/around text-object defaults.

**Data flow**: Sets `vim_operator.motion_left` to `i` and `motion_right` to `a`, resolves, and asserts those motions keep the keys while `select_inner_text_object` and `select_around_text_object` become empty.

**Call relations**: Exercises Vim operator compatibility pruning.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::explicit_new_vim_operator_binding_still_conflicts_with_legacy_binding`  (lines 2486–2492)

```
fn explicit_new_vim_operator_binding_still_conflicts_with_legacy_binding()
```

**Purpose**: Ensures explicit overlap between a legacy Vim operator motion and a new text-object selector still conflicts.

**Data flow**: Assigns `i` to both `vim_operator.motion_left` and `select_inner_text_object` and expects a conflict.

**Call relations**: Confirms explicit user overlap is rejected in Vim operator mode.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::vim_normal_defaults_include_insert_and_arrow_aliases`  (lines 2495–2533)

```
fn vim_normal_defaults_include_insert_and_arrow_aliases()
```

**Purpose**: Checks representative Vim normal defaults, including insert aliases and arrow-key movement aliases.

**Data flow**: Builds defaults and compares several `vim_normal` vectors against expected bindings.

**Call relations**: Guards the built-in Vim normal default table.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::invalid_global_copy_binding_reports_global_path`  (lines 2536–2542)

```
fn invalid_global_copy_binding_reports_global_path()
```

**Purpose**: Ensures invalid `global.copy` config reports the exact path.

**Data flow**: Sets `meta-o`, resolves, and checks the error string for `tui.keymap.global.copy`.

**Call relations**: Another parser-path regression test.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert!, default, one).


##### `tests::rejects_conflicting_editor_bindings`  (lines 2545–2551)

```
fn rejects_conflicting_editor_bindings()
```

**Purpose**: Checks duplicate keys within the editor context are rejected.

**Data flow**: Assigns `ctrl-h` to both `editor.move_left` and `editor.move_right` and expects a conflict.

**Call relations**: Exercises `validate_unique` for the editor context.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_pager_bindings`  (lines 2554–2560)

```
fn rejects_conflicting_pager_bindings()
```

**Purpose**: Checks duplicate keys within the pager context are rejected.

**Data flow**: Assigns `ctrl-u` to both `pager.scroll_up` and `pager.scroll_down` and expects a conflict.

**Call relations**: Exercises `validate_unique` for pager bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_list_bindings`  (lines 2563–2575)

```
fn rejects_conflicting_list_bindings()
```

**Purpose**: Checks duplicate keys within list navigation are rejected for both vertical and horizontal movement.

**Data flow**: Runs two scenarios: `move_up` vs `move_down` on `up`, and `move_left` vs `move_right` on `left`, expecting conflicts in both.

**Call relations**: Covers `validate_unique` for list bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_list_page_and_jump_bindings`  (lines 2578–2584)

```
fn rejects_conflicting_list_page_and_jump_bindings()
```

**Purpose**: Ensures page and jump actions in the list context cannot share a key.

**Data flow**: Assigns `home` to both `list.page_up` and `list.jump_top` and expects a conflict.

**Call relations**: Another list uniqueness test.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_bindings`  (lines 2587–2593)

```
fn rejects_conflicting_approval_bindings()
```

**Purpose**: Checks duplicate keys within approval actions are rejected.

**Data flow**: Assigns `y` to both `approval.approve` and `approval.decline` and expects a conflict.

**Call relations**: Exercises `validate_unique` for approval bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_deny_binding`  (lines 2596–2602)

```
fn rejects_conflicting_approval_deny_binding()
```

**Purpose**: Checks `approval.deny` also conflicts when it reuses another approval key.

**Data flow**: Assigns `y` to both `approval.approve` and `approval.deny` and expects a conflict.

**Call relations**: Another approval uniqueness case.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_overlay_accept_binding`  (lines 2605–2610)

```
fn rejects_conflicting_approval_overlay_accept_binding()
```

**Purpose**: Ensures list accept cannot overlap approval approve on the combined overlay surface.

**Data flow**: Sets `list.accept` to `y` and expects a conflict with `approval.approve`.

**Call relations**: Covers the special combined approval/list duplicate scan.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_conflicting_approval_overlay_cancel_binding`  (lines 2613–2618)

```
fn rejects_conflicting_approval_overlay_cancel_binding()
```

**Purpose**: Ensures list cancel cannot overlap approval cancel on the combined overlay surface.

**Data flow**: Sets `list.cancel` to `c` and expects a conflict with `approval.cancel`.

**Call relations**: Another combined overlay conflict test.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::reassignable_fixed_shortcuts_conflict_until_original_action_is_unbound`  (lines 2621–2630)

```
fn reassignable_fixed_shortcuts_conflict_until_original_action_is_unbound()
```

**Purpose**: Shows that moving a configurable action onto another action’s existing key still conflicts until the original action is explicitly unbound.

**Data flow**: First assigns `alt-.` to `global.copy` and expects a conflict with default `chat.increase_reasoning_effort`; then explicitly unbinds that chat action with `Many([])`, resolves again, and asserts `copy` now uses `alt-.`.

**Call relations**: Demonstrates explicit unbinding semantics and conflict release.

*Call graph*: calls 1 internal fn (from_config); 6 external calls (assert_eq!, Many, default, expect_conflict, one, vec!).


##### `tests::kill_whole_line_can_be_assigned_without_default_binding`  (lines 2633–2646)

```
fn kill_whole_line_can_be_assigned_without_default_binding()
```

**Purpose**: Verifies an action with no built-in default can still be assigned a custom key.

**Data flow**: Sets `editor.kill_whole_line` to `ctrl-shift-u`, resolves, and compares the resulting binding vector to the expected `KeyBinding`.

**Call relations**: Covers assignment of intentionally unbound actions.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::kill_whole_line_conflicts_until_kill_line_start_is_unbound`  (lines 2649–2661)

```
fn kill_whole_line_conflicts_until_kill_line_start_is_unbound()
```

**Purpose**: Shows that assigning `kill_whole_line` to an existing default key conflicts until the original action is explicitly unbound.

**Data flow**: First sets `kill_whole_line` to `ctrl-u` and expects a conflict with `kill_line_start`; then unbinds `kill_line_start` with `Many([])` and asserts the reassignment succeeds.

**Call relations**: Another explicit-unbind conflict-release test.

*Call graph*: calls 1 internal fn (from_config); 6 external calls (assert_eq!, Many, default, expect_conflict, one, vec!).


##### `tests::toggle_fast_mode_can_be_assigned_without_default_binding`  (lines 2664–2677)

```
fn toggle_fast_mode_can_be_assigned_without_default_binding()
```

**Purpose**: Verifies `toggle_fast_mode`, which defaults to unbound, can be assigned a custom key.

**Data flow**: Sets `global.toggle_fast_mode` to `ctrl-shift-f`, resolves, and compares the resulting vector to the expected binding.

**Call relations**: Covers assignment of another intentionally unbound action.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::toggle_fast_mode_conflicts_with_existing_main_surface_bindings`  (lines 2680–2685)

```
fn toggle_fast_mode_conflicts_with_existing_main_surface_bindings()
```

**Purpose**: Ensures assigning `toggle_fast_mode` to an already-used main-surface key is rejected.

**Data flow**: Sets `global.toggle_fast_mode` to `ctrl-l` and expects a conflict with `clear_terminal`.

**Call relations**: Exercises main-surface uniqueness for a normally unbound action.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_main_bindings_that_collide_with_remaining_fixed_shortcuts`  (lines 2688–2693)

```
fn rejects_main_bindings_that_collide_with_remaining_fixed_shortcuts()
```

**Purpose**: Checks that configurable main-surface actions cannot take fixed reserved shortcuts like paste-image.

**Data flow**: Assigns `ctrl-v` to `composer.submit` and expects a conflict mentioning `fixed.paste_image`.

**Call relations**: Exercises `validate_no_reserved` for main-surface bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::interrupt_turn_allows_backtrack_escape_and_can_be_remapped_or_unbound`  (lines 2696–2714)

```
fn interrupt_turn_allows_backtrack_escape_and_can_be_remapped_or_unbound()
```

**Purpose**: Verifies the special-case allowance for `chat.interrupt_turn` on `Esc`, and confirms it can also be remapped or explicitly unbound.

**Data flow**: Resolves defaults and checks `interrupt_turn` is `Esc`; then remaps it to `f12` and checks that binding; then sets it to `Many([])` and asserts the runtime vector is empty.

**Call relations**: Covers the reserved-key exception and explicit unbinding behavior for interrupt-turn.

*Call graph*: calls 1 internal fn (from_config); 6 external calls (assert!, assert_eq!, Many, default, one, vec!).


##### `tests::interrupt_turn_rejects_other_fixed_shortcuts`  (lines 2717–2722)

```
fn interrupt_turn_rejects_other_fixed_shortcuts()
```

**Purpose**: Ensures `interrupt_turn` still cannot take unrelated fixed reserved shortcuts.

**Data flow**: Assigns `ctrl-v` to `chat.interrupt_turn` and expects a conflict with `fixed.paste_image`.

**Call relations**: Exercises reserved-key enforcement with the interrupt-turn exception excluded.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::interrupt_turn_rejects_request_user_input_question_navigation_bindings`  (lines 2725–2731)

```
fn interrupt_turn_rejects_request_user_input_question_navigation_bindings()
```

**Purpose**: Checks that interrupt-turn cannot shadow request-user-input list navigation bindings.

**Data flow**: Assigns `f12` to both `chat.interrupt_turn` and `list.move_right` and expects a conflict.

**Call relations**: Covers the dedicated request-user-input shadowing pass.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::rejects_pager_bindings_that_collide_with_transcript_backtrack_keys`  (lines 2734–2739)

```
fn rejects_pager_bindings_that_collide_with_transcript_backtrack_keys()
```

**Purpose**: Ensures pager bindings cannot reuse transcript backtrack/edit reserved keys.

**Data flow**: Assigns `left` to `pager.close` and expects a conflict with `fixed.transcript_edit_previous`.

**Call relations**: Exercises `validate_no_reserved` for pager bindings.

*Call graph*: 3 external calls (default, expect_conflict, one).


##### `tests::parses_function_keys_and_rejects_out_of_range_function_keys`  (lines 2742–2752)

```
fn parses_function_keys_and_rejects_out_of_range_function_keys()
```

**Purpose**: Checks parsing of supported function keys and rejection beyond the configured maximum.

**Data flow**: Parses `f1`, `f24`, and `f25`, comparing the first two to expected `KeyCode::F` tuples and the last to `None`.

**Call relations**: Direct parser coverage for function-key handling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_all_named_non_character_keys`  (lines 2755–2780)

```
fn parses_all_named_non_character_keys()
```

**Purpose**: Verifies all named non-character key aliases map to the expected `KeyCode` values.

**Data flow**: Iterates through a table of canonical names like `tab`, `backspace`, `page-down`, `space`, and `minus`, parses each, and compares the resulting tuple.

**Call relations**: Broad parser coverage for named keys.

*Call graph*: 2 external calls (Char, assert_eq!).


##### `tests::rejects_modifier_only_and_nonnumeric_function_key_specs`  (lines 2783–2786)

```
fn rejects_modifier_only_and_nonnumeric_function_key_specs()
```

**Purpose**: Checks that incomplete or malformed specs are rejected.

**Data flow**: Asserts `parse_keybinding("ctrl")` and `parse_keybinding("ff")` both return `None`.

**Call relations**: Parser edge-case coverage.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_minus_alias_and_legacy_literal_minus`  (lines 2789–2802)

```
fn parses_minus_alias_and_legacy_literal_minus()
```

**Purpose**: Verifies both the named `minus` alias and literal hyphen forms parse correctly.

**Data flow**: Parses `alt-minus`, `alt--`, and `-`, then compares each result to the expected `KeyCode::Char('-')` tuple.

**Call relations**: Covers the parser’s special handling for hyphen keys.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_empty_array_unbinds_action`  (lines 2805–2810)

```
fn explicit_empty_array_unbinds_action()
```

**Purpose**: Confirms that an explicit empty binding list unbinds an action instead of falling back to defaults.

**Data flow**: Sets `composer.toggle_shortcuts` to `Many([])`, resolves, and asserts the runtime binding vector is empty.

**Call relations**: Directly tests the explicit-unbind semantics implemented by the resolver helpers.

*Call graph*: calls 1 internal fn (from_config); 4 external calls (assert!, Many, default, vec!).


##### `tests::raw_output_toggle_defaults_to_alt_r`  (lines 2813–2819)

```
fn raw_output_toggle_defaults_to_alt_r()
```

**Purpose**: Checks the built-in default for raw output toggle.

**Data flow**: Builds defaults and compares `runtime.app.toggle_raw_output` to `alt-r`.

**Call relations**: Simple default-table regression test.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::raw_output_toggle_can_be_remapped`  (lines 2822–2832)

```
fn raw_output_toggle_can_be_remapped()
```

**Purpose**: Verifies raw output toggle can be reassigned to another key.

**Data flow**: Sets `global.toggle_raw_output` to `f12`, resolves, and asserts the runtime binding vector contains `F12`.

**Call relations**: Covers remapping of a global app action.

*Call graph*: calls 1 internal fn (from_config); 3 external calls (assert_eq!, default, one).


##### `tests::default_editor_insert_newline_includes_current_aliases`  (lines 2835–2847)

```
fn default_editor_insert_newline_includes_current_aliases()
```

**Purpose**: Checks the full built-in alias set for editor newline insertion.

**Data flow**: Builds defaults and compares `runtime.editor.insert_newline` to the expected five-entry vector including `ctrl-j`, `ctrl-m`, `enter`, `shift-enter`, and `alt-enter`.

**Call relations**: Guards a compatibility-heavy default binding set.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert_eq!).


##### `tests::default_editor_delete_forward_word_includes_alt_d`  (lines 2850–2858)

```
fn default_editor_delete_forward_word_includes_alt_d()
```

**Purpose**: Verifies one representative alias in the editor forward-word deletion defaults.

**Data flow**: Builds defaults and asserts `alt-d` is present in `runtime.editor.delete_forward_word`.

**Call relations**: Checks a specific editor compatibility alias.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::default_editor_deletion_includes_modified_backspace_delete_aliases`  (lines 2861–2906)

```
fn default_editor_deletion_includes_modified_backspace_delete_aliases()
```

**Purpose**: Checks several modified Backspace/Delete aliases in the editor deletion defaults.

**Data flow**: Builds defaults and asserts the presence of shift-backspace, shift-delete, ctrl-backspace, ctrl-shift-backspace, ctrl-delete, and ctrl-shift-delete in the relevant vectors.

**Call relations**: Guards terminal-compatibility aliases in the default editor keymap.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::default_composer_toggle_shortcuts_includes_shift_question_mark`  (lines 2909–2917)

```
fn default_composer_toggle_shortcuts_includes_shift_question_mark()
```

**Purpose**: Verifies the composer shortcut overlay default includes the shifted `?` variant.

**Data flow**: Builds defaults and asserts `shift-?` is present in `runtime.composer.toggle_shortcuts`.

**Call relations**: Checks a compatibility alias for printable shifted keys.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::default_approval_open_fullscreen_includes_ctrl_shift_a`  (lines 2920–2926)

```
fn default_approval_open_fullscreen_includes_ctrl_shift_a()
```

**Purpose**: Verifies the approval fullscreen action includes the combined Ctrl+Shift variant.

**Data flow**: Builds defaults and asserts the expected combined-modifier `KeyBinding` is present.

**Call relations**: Covers a raw combined-modifier default entry.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (assert!).


##### `tests::primary_binding_returns_first_or_none`  (lines 2929–2939)

```
fn primary_binding_returns_first_or_none()
```

**Purpose**: Checks that `primary_binding` returns the first binding when present and `None` for an empty slice.

**Data flow**: Builds a two-entry vector, calls `primary_binding` on it and on an empty slice, and compares the returned options.

**Call relations**: Direct unit test for the small UI helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::defaults_pass_conflict_validation`  (lines 2942–2946)

```
fn defaults_pass_conflict_validation()
```

**Purpose**: Ensures the built-in default table is internally conflict-free under the same validation rules applied to user config.

**Data flow**: Builds `RuntimeKeymap::defaults()` and calls `validate_conflicts`, expecting success.

**Call relations**: Acts as a final invariant check over the entire default keymap.

*Call graph*: calls 1 internal fn (defaults).

## 📊 State Registers Touched

- `reg-effective-config` — The merged live settings the app actually runs with after combining user, project, managed, thread, and command-line inputs.
- `reg-feature-flags` — The current set of experimental and on/off feature switches that change behavior across the app.
- `reg-startup-policy` — The resolved startup rules for permissions, service tier, keymaps, project-root behavior, and related runtime policy choices.
- `reg-install-context` — The app's understanding of where it is installed, where bundled resources live, and what kind of install this is.
- `reg-codex-home-and-paths` — The chosen home folder and other shared filesystem locations the app uses for config, caches, helpers, and data files.
- `reg-local-environment-snapshots` — Cached facts about the local machine and shells, like exported environment settings, aliases, OS details, and available tools.
- `reg-helper-binaries-and-materialized-tools` — The set of helper executables the app has located or copied into place so later stages can run them safely.
- `reg-cloud-config-cache` — The last fetched signed cloud configuration bundle that is cached locally and refreshed in the background.
- `reg-plugin-catalog-and-snapshot` — The installed and refreshable plugin inventory the app uses to decide what extensions are available.
- `reg-skills-catalog` — The loaded list of available skills and their metadata that can be selected and injected into prompts.
- `reg-user-and-project-instructions` — The loaded user, project, and AGENTS-style instructions that are reused across turns to guide the model.
- `reg-tool-catalog` — The current set of tools the model can call, including built-ins, plugins, MCP tools, web/image/memory helpers, and schemas.
- `reg-sandbox-and-exec-policy` — The active sandbox and command-execution rules that decide what commands, files, and network actions are allowed.
- `reg-proxy-and-network-policy-state` — The current proxy and network-access control setup that decides how external connections are routed or restricted.
- `reg-config-manager-state` — The live app-server configuration manager state used to serve, watch, and safely update effective/user configuration during runtime.
- `reg-plugin-and-skill-install-state` — The local installed-package state for plugins and skills, including materialized resources that survive across runs and feed runtime catalogs.
- `reg-user-config-edit-state` — The runtime state used to safely edit, migrate, import, and write user configuration while preserving layer integrity and reporting pending changes.
