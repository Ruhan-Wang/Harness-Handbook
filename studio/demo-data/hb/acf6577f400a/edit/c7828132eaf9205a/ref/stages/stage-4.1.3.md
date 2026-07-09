# Configuration management services and editable persistence surfaces  `stage-4.1.3`

This stage is the system’s control panel and notebook for settings. It sits in shared support work: not the main job itself, but the part that remembers choices, lets other parts read or change them, and explains when something went wrong.

At the app-server side, config_manager_service.rs is the main service for reading and writing user settings. It checks that changes are valid, avoids overwriting newer edits by accident, and reports when a saved value is being hidden by a stronger setting from somewhere else. config_processor.rs turns those abilities into RPCs, meaning remote calls other parts of the app can make, and also refreshes cached data after a change. config_errors.rs makes low-level loading failures understandable to callers, while still keeping detailed machine-readable clues.

Underneath, edit.rs and document_helpers.rs do the careful file surgery on config.toml. They turn high-level change requests into real text edits, batch them safely, and try to preserve the file’s structure and formatting.

external_agent_config.rs imports settings and related content from another agent during onboarding. personality_migration.rs performs a one-time default-setting upgrade. settings.rs stores the daemon’s own small local settings, such as whether remote control is enabled.

## Files in this stage

### App-server config APIs
These files expose configuration management through app-server RPCs, translating errors and delegating validated reads and writes to the service layer.

### `app-server/src/request_processors/config_errors.rs`

`util` · `config load`

This file is a narrow error-translation helper for request processors that load configuration. The private `cloud_config_bundle_load_error` function walks the `std::io::Error` source chain manually, starting from `err.get_ref()`, and looks for a nested `CloudConfigBundleLoadError` via `downcast_ref`. That means callers do not need the cloud-specific error to be the top-level error object; any wrapped occurrence is enough to trigger richer reporting.

`config_load_error` uses that extraction result to build a `JSONRPCErrorError` with `invalid_request(...)` and optional structured `data`. When a cloud bundle error is present, the data object includes a fixed `reason` of `cloudConfigBundle`, a stringified `errorCode`, and the human-readable `detail`. If the cloud error exposes an HTTP status code, it is added as `statusCode`. Authentication failures get an extra `action: "relogin"` hint so clients can prompt the user appropriately.

The design choice here is to keep the top-level JSON-RPC message generic (`failed to load configuration: ...`) while attaching cloud-specific metadata only when it can be proven from the wrapped error chain. Non-cloud configuration failures therefore still surface cleanly without extra schema noise.

#### Function details

##### `cloud_config_bundle_load_error`  (lines 3–14)

```
fn cloud_config_bundle_load_error(err: &std::io::Error) -> Option<&CloudConfigBundleLoadError>
```

**Purpose**: Searches an `std::io::Error` and its nested sources for an embedded `CloudConfigBundleLoadError`.

**Data flow**: Takes `&std::io::Error`, reads its inner source via `get_ref`, repeatedly follows `source()` links, attempts `downcast_ref::<CloudConfigBundleLoadError>()` at each step, and returns the first matching borrowed cloud error or `None` if no such source exists.

**Call relations**: Used only by `config_load_error` to decide whether a generic config-load failure should carry cloud-bundle-specific JSON-RPC metadata.

*Call graph*: called by 1 (config_load_error); 1 external calls (get_ref).


##### `config_load_error`  (lines 16–35)

```
fn config_load_error(err: &std::io::Error) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC invalid-request error for configuration load failures and enriches it with cloud bundle diagnostics when available.

**Data flow**: Takes `&std::io::Error`, calls `cloud_config_bundle_load_error`, optionally constructs a JSON object containing `reason`, `errorCode`, `detail`, optional `statusCode`, and optional `action`, then creates an `invalid_request` error with a formatted message and assigns the optional JSON object to `error.data`; returns the populated `JSONRPCErrorError`.

**Call relations**: Called by configuration-loading request paths when they need to surface a user-visible JSON-RPC error. It delegates cloud-specific detection to `cloud_config_bundle_load_error` and otherwise emits a plain invalid-request wrapper.

*Call graph*: calls 1 internal fn (cloud_config_bundle_load_error); 1 external calls (format!).


### `app-server/src/request_processors/config_processor.rs`

`domain_logic` · `request handling`

This file centers on `ConfigRequestProcessor`, which combines a `ConfigManager`, `ThreadManager`, analytics client, and outgoing sender to serve configuration-related requests. Read paths are split between direct config reads (`read`), requirements reads (`config_requirements_read`), and model-provider capability inspection (`model_provider_capabilities_read`). The normal config read path additionally injects a curated set of experimental feature flags into `response.config.additional["features"]`, normalizing that field into a JSON object if the stored config shape is malformed.

Mutation paths (`value_write`, `batch_write`, `experimental_feature_enablement_set`) all funnel through `handle_config_mutation_result`, which clears plugin and skills caches after successful changes. Writes also inspect edited key/value pairs with `collect_plugin_enabled_candidates` so plugin enable/disable analytics can be emitted after persistence. Batch writes optionally call `reload_user_config`, which rebuilds the latest config and pushes it into every live thread via `refresh_runtime_config`.

The file also contains a large family of pure mapping helpers that convert `codex_config::*Toml` structures into protocol types such as `ConfigRequirements`, `ManagedHooksRequirements`, `NetworkRequirements`, and enum translations for sandbox, residency, and network permissions. Notable normalization includes always adding `WebSearchMode::Disabled` to allowed web search modes if absent, and dropping unsupported `ExternalSandbox` sandbox requirements by returning `None` from the mapper.

Error handling is intentionally split: `map_error` preserves config write error codes in JSON-RPC `data` when available, while other manager failures become generic internal errors. The embedded tests focus on ensuring specific requirement fields survive the TOML-to-API mapping unchanged.

#### Function details

##### `ConfigRequestProcessor::new`  (lines 66–78)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        config_manager: ConfigManager,
        thread_manager: Arc<ThreadManager>,
        analytics_events_client: AnalyticsEventsClient,
    ) -
```

**Purpose**: Constructs the configuration request processor from its shared dependencies.

**Data flow**: Takes `Arc<OutgoingMessageSender>`, `ConfigManager`, `Arc<ThreadManager>`, and `AnalyticsEventsClient`; stores them directly in the struct and returns `ConfigRequestProcessor`.

**Call relations**: Called during server setup. It prepares the processor used later by initialized-client request dispatch.

*Call graph*: called by 1 (new).


##### `ConfigRequestProcessor::read`  (lines 80–107)

```
async fn read(
        &self,
        params: ConfigReadParams,
    ) -> Result<ConfigReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads effective configuration for a requested cwd and augments the response with supported experimental feature enablement flags.

**Data flow**: Consumes `ConfigReadParams`, derives `fallback_cwd` from `params.cwd`, awaits `self.config_manager.read(params)` and maps manager errors through `map_error`, then loads the latest resolved config via `load_latest_config`. For each key in `SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT`, it looks up the feature descriptor, ensures `response.config.additional["features"]` is a JSON object, and inserts a boolean from `config.features.enabled(feature)`. Returns the modified `ConfigReadResponse`.

**Call relations**: Invoked by `handle_initialized_client_request` for config reads. It combines direct manager output with a second config resolution pass so runtime feature precedence is reflected in the returned `additional.features` map.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (handle_initialized_client_request); 3 external calls (read, feature_for_key, json!).


##### `ConfigRequestProcessor::config_requirements_read`  (lines 109–120)

```
async fn config_requirements_read(
        &self,
    ) -> Result<ConfigRequirementsReadResponse, JSONRPCErrorError>
```

**Purpose**: Returns optional configuration requirements after translating TOML-backed requirement structures into protocol types.

**Data flow**: Reads requirements from `self.config_manager.read_requirements().await`, maps manager errors with `map_error`, transforms any returned `ConfigRequirementsToml` using `map_requirements_toml_to_api`, and wraps the result in `ConfigRequirementsReadResponse`.

**Call relations**: Called by `handle_initialized_client_request` for requirements-read RPCs. It delegates persistence/loading to `ConfigManager` and schema translation to the local mapper helpers.

*Call graph*: called by 1 (handle_initialized_client_request); 1 external calls (read_requirements).


##### `ConfigRequestProcessor::value_write`  (lines 122–129)

```
async fn value_write(
        &self,
        params: ConfigValueWriteParams,
    ) -> Result<ClientResponsePayload, JSONRPCErrorError>
```

**Purpose**: Writes a single config value, performs post-write cache invalidation, and returns the protocol write response payload.

**Data flow**: Consumes `ConfigValueWriteParams`, awaits `write_value`, passes that result through `handle_config_mutation_result` so successful writes trigger cache clearing, then wraps the `ConfigWriteResponse` in `ClientResponsePayload::ConfigValueWrite`.

**Call relations**: Reached from `handle_initialized_client_request` for single-key writes. It layers mutation side effects around the lower-level `write_value` helper.

*Call graph*: calls 2 internal fn (handle_config_mutation_result, write_value); called by 1 (handle_initialized_client_request).


##### `ConfigRequestProcessor::batch_write`  (lines 131–138)

```
async fn batch_write(
        &self,
        params: ConfigBatchWriteParams,
    ) -> Result<ClientResponsePayload, JSONRPCErrorError>
```

**Purpose**: Applies multiple config edits, performs mutation side effects, and returns the batch write response payload.

**Data flow**: Consumes `ConfigBatchWriteParams`, awaits `batch_write_inner`, runs the result through `handle_config_mutation_result`, and wraps the successful `ConfigWriteResponse` in `ClientResponsePayload::ConfigBatchWrite`.

**Call relations**: Called by `handle_initialized_client_request` for batch writes. It delegates actual persistence and optional runtime reload behavior to `batch_write_inner`.

*Call graph*: calls 2 internal fn (batch_write_inner, handle_config_mutation_result); called by 1 (handle_initialized_client_request).


##### `ConfigRequestProcessor::experimental_feature_enablement_set`  (lines 140–155)

```
async fn experimental_feature_enablement_set(
        &self,
        request_id: ConnectionRequestId,
        params: ExperimentalFeatureEnablementSetParams,
    ) -> Result<Option<ClientResponsePaylo
```

**Purpose**: Updates runtime experimental feature enablement, applies mutation side effects, and sends the response asynchronously on the outgoing channel.

**Data flow**: Consumes a `ConnectionRequestId` and `ExperimentalFeatureEnablementSetParams`, awaits `set_experimental_feature_enablement`, passes the result through `handle_config_mutation_result`, then sends `ClientResponsePayload::ExperimentalFeatureEnablementSet(response)` via `self.outgoing.send_response_as`; returns `Ok(None)` because the response has already been emitted.

**Call relations**: Invoked by `handle_initialized_client_request` for runtime feature toggle RPCs. It combines the feature-update helper with the same post-mutation cache clearing used by config writes, then uses the outgoing sender instead of returning an inline payload.

*Call graph*: calls 2 internal fn (handle_config_mutation_result, set_experimental_feature_enablement); called by 1 (handle_initialized_client_request); 1 external calls (ExperimentalFeatureEnablementSet).


##### `ConfigRequestProcessor::model_provider_capabilities_read`  (lines 157–168)

```
async fn model_provider_capabilities_read(
        &self,
    ) -> Result<ModelProviderCapabilitiesReadResponse, JSONRPCErrorError>
```

**Purpose**: Reports capabilities of the currently configured model provider, such as namespace tools, image generation, and web search support.

**Data flow**: Loads the latest config with `load_latest_config(None)`, constructs a provider via `create_model_provider(config.model_provider, None)`, reads `provider.capabilities()`, and returns a `ModelProviderCapabilitiesReadResponse` containing selected capability flags.

**Call relations**: Called by `handle_initialized_client_request` for capability queries. It depends on current config resolution and delegates provider-specific capability logic to the model-provider factory.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (handle_initialized_client_request); 1 external calls (create_model_provider).


##### `ConfigRequestProcessor::handle_config_mutation`  (lines 170–173)

```
async fn handle_config_mutation(&self)
```

**Purpose**: Clears runtime plugin and skills caches after configuration changes that may affect loaded extensions.

**Data flow**: Reads `self.thread_manager`, calls `plugins_manager().clear_cache()` and `skills_manager().clear_cache()`, and returns no value.

**Call relations**: Used by `handle_config_mutation_result` after successful writes and also directly by external-agent config import code when imported files affect runtime sources.

*Call graph*: called by 2 (handle_config_mutation_result, import).


##### `ConfigRequestProcessor::handle_config_mutation_result`  (lines 175–182)

```
async fn handle_config_mutation_result(
        &self,
        result: std::result::Result<T, JSONRPCErrorError>,
    ) -> Result<T, JSONRPCErrorError>
```

**Purpose**: Applies common post-success mutation side effects while preserving any JSON-RPC error from the underlying operation.

**Data flow**: Takes a `Result<T, JSONRPCErrorError>`, propagates errors immediately with `?`, calls `handle_config_mutation().await` on success, and returns the original successful value `T`.

**Call relations**: Shared by `value_write`, `batch_write`, and `experimental_feature_enablement_set` so those entrypoints all clear caches only after a successful mutation.

*Call graph*: calls 1 internal fn (handle_config_mutation); called by 3 (batch_write, experimental_feature_enablement_set, value_write).


##### `ConfigRequestProcessor::load_latest_config`  (lines 184–196)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<codex_core::config::Config, JSONRPCErrorError>
```

**Purpose**: Loads the latest resolved config and rewrites resolution failures into a stable internal JSON-RPC error message.

**Data flow**: Takes an optional fallback cwd, awaits `self.config_manager.load_latest_config(fallback_cwd)`, and maps any error into `internal_error("failed to resolve feature override precedence: ...")`.

**Call relations**: Called by read, capability, feature-toggle, and runtime-reload paths whenever they need the fully resolved current config rather than raw persisted values.

*Call graph*: calls 1 internal fn (load_latest_config); called by 4 (model_provider_capabilities_read, read, reload_user_config, set_experimental_feature_enablement).


##### `ConfigRequestProcessor::write_value`  (lines 198–212)

```
async fn write_value(
        &self,
        params: ConfigValueWriteParams,
    ) -> Result<ConfigWriteResponse, JSONRPCErrorError>
```

**Purpose**: Persists a single config edit and emits plugin enable/disable analytics for any affected plugin toggle keys.

**Data flow**: Consumes `ConfigValueWriteParams`, derives `pending_changes` by passing the edited key/value pair into `collect_plugin_enabled_candidates`, awaits `self.config_manager.write_value(params)` with `map_error` translation, then calls `emit_plugin_toggle_events(pending_changes)` and returns the `ConfigWriteResponse`.

**Call relations**: Used internally by `value_write`. It isolates persistence plus analytics emission from the outer mutation-side-effect wrapper.

*Call graph*: calls 2 internal fn (emit_plugin_toggle_events, collect_plugin_enabled_candidates); called by 1 (value_write); 1 external calls (write_value).


##### `ConfigRequestProcessor::batch_write_inner`  (lines 214–235)

```
async fn batch_write_inner(
        &self,
        params: ConfigBatchWriteParams,
    ) -> Result<ConfigWriteResponse, JSONRPCErrorError>
```

**Purpose**: Persists multiple config edits, emits plugin toggle analytics, and optionally refreshes live threads with rebuilt user config.

**Data flow**: Consumes `ConfigBatchWriteParams`, remembers `reload_user_config`, computes `pending_changes` from all edits, awaits `self.config_manager.batch_write(params)` with `map_error`, emits plugin toggle events, conditionally calls `reload_user_config().await`, and returns the `ConfigWriteResponse`.

**Call relations**: Called by `batch_write`. It performs the actual batch persistence and optional runtime refresh before the outer wrapper clears caches.

*Call graph*: calls 3 internal fn (emit_plugin_toggle_events, reload_user_config, collect_plugin_enabled_candidates); called by 1 (batch_write); 1 external calls (batch_write).


##### `ConfigRequestProcessor::set_experimental_feature_enablement`  (lines 237–272)

```
async fn set_experimental_feature_enablement(
        &self,
        params: ExperimentalFeatureEnablementSetParams,
    ) -> Result<ExperimentalFeatureEnablementSetResponse, JSONRPCErrorError>
```

**Purpose**: Validates a requested runtime feature enablement map against the supported allowlist, applies valid entries, and refreshes runtime config.

**Data flow**: Consumes `ExperimentalFeatureEnablementSetParams`, mutably filters `enablement` to keys that both canonicalize and appear in `SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT`, collecting invalid keys for a warning log. If nothing valid remains, it returns an empty-success response. Otherwise it calls `self.config_manager.extend_runtime_feature_enablement(...)`, reloads latest config to ensure precedence resolution succeeds, calls `reload_user_config().await`, and returns `ExperimentalFeatureEnablementSetResponse { enablement }` containing only accepted keys.

**Call relations**: Used by `experimental_feature_enablement_set`. It performs validation and runtime state update, while the caller handles cache-clearing and response emission.

*Call graph*: calls 3 internal fn (extend_runtime_feature_enablement, load_latest_config, reload_user_config); called by 1 (experimental_feature_enablement_set); 2 external calls (new, warn!).


##### `ConfigRequestProcessor::reload_user_config`  (lines 274–292)

```
async fn reload_user_config(&self)
```

**Purpose**: Rebuilds the latest config and pushes it into every currently loaded thread as a runtime refresh.

**Data flow**: Attempts `load_latest_config(None)`; on failure logs a warning and exits. On success it awaits `self.thread_manager.list_thread_ids()`, fetches each thread with `get_thread`, skips missing threads, and calls `thread.refresh_runtime_config(next_config.clone()).await` for each surviving thread.

**Call relations**: Triggered after batch writes that request reload and after runtime feature enablement changes. It depends on `load_latest_config` and the thread manager’s live-thread registry.

*Call graph*: calls 1 internal fn (load_latest_config); called by 2 (batch_write_inner, set_experimental_feature_enablement); 1 external calls (warn!).


##### `ConfigRequestProcessor::emit_plugin_toggle_events`  (lines 294–313)

```
async fn emit_plugin_toggle_events(
        &self,
        pending_changes: std::collections::BTreeMap<String, bool>,
    )
```

**Purpose**: Sends analytics events for plugin enable/disable changes inferred from config edits.

**Data flow**: Consumes a `BTreeMap<String, bool>` of plugin ids to enabled states, parses each key into `PluginId`, skips invalid ids, asynchronously loads telemetry metadata from the installed plugin location under `self.config_manager.codex_home()`, and calls either `track_plugin_enabled` or `track_plugin_disabled` on `self.analytics_events_client`.

**Call relations**: Called by both `write_value` and `batch_write_inner` after successful persistence. It is intentionally best-effort, ignoring unparseable plugin ids.

*Call graph*: calls 5 internal fn (track_plugin_disabled, track_plugin_enabled, codex_home, installed_plugin_telemetry_metadata, parse); called by 2 (batch_write_inner, write_value).


##### `map_requirements_toml_to_api`  (lines 316–380)

```
fn map_requirements_toml_to_api(requirements: ConfigRequirementsToml) -> ConfigRequirements
```

**Purpose**: Converts `ConfigRequirementsToml` into the protocol-facing `ConfigRequirements` structure, translating nested enums and optional sections.

**Data flow**: Consumes a `ConfigRequirementsToml`, maps each optional field into protocol equivalents, including approval policies/reviewers, sandbox modes, Windows sandbox implementations, permission profile allowlists/defaults, web search modes, managed hooks, appshots, remote control, computer use, feature requirements, residency, and network requirements; returns a populated `ConfigRequirements`.

**Call relations**: Used by `config_requirements_read` and directly by unit tests. It delegates nested section conversion to the helper mappers below.

*Call graph*: called by 6 (requirements_api_includes_allow_appshots, requirements_api_includes_allow_managed_hooks_only, requirements_api_includes_allow_remote_control, requirements_api_includes_allowed_windows_sandbox_implementations, requirements_api_includes_computer_use_requirements, requirements_api_includes_permission_default_and_allowlist).


##### `map_computer_use_requirements_to_api`  (lines 382–388)

```
fn map_computer_use_requirements_to_api(
    computer_use: codex_config::ComputerUseRequirementsToml,
) -> ComputerUseRequirements
```

**Purpose**: Maps TOML computer-use requirements into the protocol shape.

**Data flow**: Consumes `codex_config::ComputerUseRequirementsToml`, copies `allow_locked_computer_use` into `ComputerUseRequirements`, and returns it.

**Call relations**: Called from `map_requirements_toml_to_api` when the optional `computer_use` section is present.


##### `map_hooks_requirements_to_api`  (lines 390–423)

```
fn map_hooks_requirements_to_api(hooks: ManagedHooksRequirementsToml) -> ManagedHooksRequirements
```

**Purpose**: Transforms managed hook requirements and all event-specific matcher groups into protocol types.

**Data flow**: Consumes `ManagedHooksRequirementsToml`, destructures managed directory fields and `HookEventsToml`, maps each event vector through `map_hook_matcher_groups_to_api`, and returns `ManagedHooksRequirements`.

**Call relations**: Used by `map_requirements_toml_to_api` for the optional hooks section.

*Call graph*: calls 1 internal fn (map_hook_matcher_groups_to_api).


##### `map_hook_matcher_groups_to_api`  (lines 425–432)

```
fn map_hook_matcher_groups_to_api(
    groups: Vec<CoreMatcherGroup>,
) -> Vec<ConfiguredHookMatcherGroup>
```

**Purpose**: Maps a vector of core matcher groups into protocol matcher groups.

**Data flow**: Consumes `Vec<CoreMatcherGroup>`, converts each element with `map_hook_matcher_group_to_api`, collects into a `Vec<ConfiguredHookMatcherGroup>`, and returns it.

**Call relations**: Called repeatedly by `map_hooks_requirements_to_api` for each hook event list.

*Call graph*: called by 1 (map_hooks_requirements_to_api).


##### `map_hook_matcher_group_to_api`  (lines 434–443)

```
fn map_hook_matcher_group_to_api(group: CoreMatcherGroup) -> ConfiguredHookMatcherGroup
```

**Purpose**: Converts one matcher group, preserving its matcher and translating each configured hook handler.

**Data flow**: Consumes `CoreMatcherGroup`, copies `matcher`, maps `hooks` through `map_hook_handler_to_api`, and returns `ConfiguredHookMatcherGroup`.

**Call relations**: Used by `map_hook_matcher_groups_to_api` as the per-element conversion step.


##### `map_hook_handler_to_api`  (lines 445–463)

```
fn map_hook_handler_to_api(handler: CoreHookHandlerConfig) -> ConfiguredHookHandler
```

**Purpose**: Translates a core hook handler enum variant into the protocol hook handler enum.

**Data flow**: Consumes `CoreHookHandlerConfig`, pattern matches `Command`, `Prompt`, and `Agent` variants, copies command fields where applicable, and returns the corresponding `ConfiguredHookHandler` variant.

**Call relations**: Called from `map_hook_matcher_group_to_api` for each hook handler in a matcher group.


##### `map_sandbox_mode_requirement_to_api`  (lines 465–472)

```
fn map_sandbox_mode_requirement_to_api(mode: CoreSandboxModeRequirement) -> Option<SandboxMode>
```

**Purpose**: Maps supported sandbox mode requirements into protocol values while dropping unsupported external sandbox requirements.

**Data flow**: Consumes `CoreSandboxModeRequirement`, returns `Some(SandboxMode::...)` for `ReadOnly`, `WorkspaceWrite`, and `DangerFullAccess`, and returns `None` for `ExternalSandbox`.

**Call relations**: Used by `map_requirements_toml_to_api` inside a `filter_map`, so unsupported external sandbox requirements are omitted from the API response.


##### `map_residency_requirement_to_api`  (lines 474–480)

```
fn map_residency_requirement_to_api(
    residency: CoreResidencyRequirement,
) -> codex_app_server_protocol::ResidencyRequirement
```

**Purpose**: Converts residency requirements from core config form to protocol form.

**Data flow**: Consumes `CoreResidencyRequirement`, matches the known variant `Us`, and returns `codex_app_server_protocol::ResidencyRequirement::Us`.

**Call relations**: Called by `map_requirements_toml_to_api` when residency enforcement is configured.


##### `map_network_requirements_to_api`  (lines 482–530)

```
fn map_network_requirements_to_api(
    network: codex_config::NetworkRequirementsToml,
) -> NetworkRequirements
```

**Purpose**: Converts network requirement TOML into the protocol network requirements structure, including both normalized convenience fields and explicit permission maps.

**Data flow**: Consumes `codex_config::NetworkRequirementsToml`, derives convenience allow/deny domain lists and optional unix-socket allow list from nested sections, maps domain and unix-socket permission entries through dedicated enum mappers, copies scalar flags and ports, and returns `NetworkRequirements`.

**Call relations**: Used by `map_requirements_toml_to_api` for the optional network section.


##### `map_network_domain_permission_to_api`  (lines 532–539)

```
fn map_network_domain_permission_to_api(
    permission: codex_config::NetworkDomainPermissionToml,
) -> NetworkDomainPermission
```

**Purpose**: Maps a TOML network domain permission enum into the protocol enum.

**Data flow**: Consumes `codex_config::NetworkDomainPermissionToml`, matches `Allow` or `Deny`, and returns the corresponding `NetworkDomainPermission`.

**Call relations**: Called by `map_network_requirements_to_api` while converting explicit domain permission entries.


##### `map_network_unix_socket_permission_to_api`  (lines 541–548)

```
fn map_network_unix_socket_permission_to_api(
    permission: codex_config::NetworkUnixSocketPermissionToml,
) -> NetworkUnixSocketPermission
```

**Purpose**: Maps a TOML unix-socket permission enum into the protocol enum.

**Data flow**: Consumes `codex_config::NetworkUnixSocketPermissionToml`, matches `Allow` or `Deny`, and returns the corresponding `NetworkUnixSocketPermission`.

**Call relations**: Called by `map_network_requirements_to_api` while converting explicit unix-socket permission entries.


##### `map_error`  (lines 550–556)

```
fn map_error(err: ConfigManagerError) -> JSONRPCErrorError
```

**Purpose**: Converts `ConfigManagerError` into a JSON-RPC error, preserving structured config write error codes when present.

**Data flow**: Consumes `ConfigManagerError`, checks `write_error_code()`, returns `config_write_error(code, err.to_string())` if available, otherwise returns `internal_error(err.to_string())`.

**Call relations**: Used throughout the processor’s config-manager calls so write-specific failures can be surfaced as invalid-request errors with machine-readable codes.

*Call graph*: calls 3 internal fn (write_error_code, internal_error, config_write_error); 1 external calls (to_string).


##### `config_write_error`  (lines 558–564)

```
fn config_write_error(code: ConfigWriteErrorCode, message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds an invalid-request JSON-RPC error annotated with a `config_write_error_code` payload.

**Data flow**: Takes a `ConfigWriteErrorCode` and message, creates `invalid_request(message)`, sets `error.data` to a JSON object containing the code, and returns the modified `JSONRPCErrorError`.

**Call relations**: Called only by `map_error` when the config manager reports a write-class failure.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (map_error); 1 external calls (json!).


##### `tests::requirements_api_includes_allow_managed_hooks_only`  (lines 577–585)

```
fn requirements_api_includes_allow_managed_hooks_only()
```

**Purpose**: Verifies that `allow_managed_hooks_only` is preserved by the requirements TOML-to-API mapping and does not spuriously populate hooks.

**Data flow**: Builds a `ConfigRequirementsToml` with `allow_managed_hooks_only: Some(true)`, maps it through `map_requirements_toml_to_api`, and asserts expected field values.

**Call relations**: Unit test for `map_requirements_toml_to_api`, exercising a specific optional field.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_permission_default_and_allowlist`  (lines 588–609)

```
fn requirements_api_includes_permission_default_and_allowlist()
```

**Purpose**: Checks that allowed permission profiles and default permissions survive mapping unchanged.

**Data flow**: Constructs a `ConfigRequirementsToml` with a `BTreeMap` allowlist and default permission string, maps it, and asserts both fields match the input.

**Call relations**: Unit test covering permission-profile-related branches in `map_requirements_toml_to_api`.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 3 external calls (from, assert_eq!, default).


##### `tests::requirements_api_includes_allow_appshots`  (lines 612–620)

```
fn requirements_api_includes_allow_appshots()
```

**Purpose**: Ensures the `allow_appshots` requirement is exposed in the API output.

**Data flow**: Creates a default requirements struct with `allow_appshots: Some(false)`, maps it, and asserts the mapped field and absence of hooks.

**Call relations**: Unit test for a single optional boolean field in `map_requirements_toml_to_api`.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_allow_remote_control`  (lines 623–630)

```
fn requirements_api_includes_allow_remote_control()
```

**Purpose**: Ensures the `allow_remote_control` requirement is preserved by the mapper.

**Data flow**: Builds a requirements TOML value with `allow_remote_control: Some(false)`, maps it, and asserts the resulting API field equals `Some(false)`.

**Call relations**: Unit test for remote-control requirement mapping.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_computer_use_requirements`  (lines 633–647)

```
fn requirements_api_includes_computer_use_requirements()
```

**Purpose**: Checks that nested computer-use requirements are mapped into the protocol structure.

**Data flow**: Creates `ConfigRequirementsToml` with `computer_use.allow_locked_computer_use: Some(false)`, maps it, and asserts the nested API field is present and false.

**Call relations**: Unit test covering `map_computer_use_requirements_to_api` through the top-level mapper.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_allowed_windows_sandbox_implementations`  (lines 650–668)

```
fn requirements_api_includes_allowed_windows_sandbox_implementations()
```

**Purpose**: Verifies Windows sandbox implementation allowlists are translated into protocol enum values.

**Data flow**: Constructs a requirements TOML value with elevated and unelevated Windows sandbox modes, maps it, and asserts the resulting vector contains the corresponding `WindowsSandboxSetupMode` values.

**Call relations**: Unit test for the Windows-specific branch inside `map_requirements_toml_to_api`.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 3 external calls (assert_eq!, default, vec!).


### `app-server/src/config_manager_service.rs`

`domain_logic` · `config read and config mutation requests`

This file is the concrete service layer for configuration RPCs. It wraps lower-level config loading from `ConfigManager` and translates between protocol types (`ConfigReadParams`, `ConfigWriteResponse`, `ApiConfig`, `OverriddenMetadata`) and internal TOML-based config state (`ConfigLayerStack`, `ConfigLayerEntry`, `ConfigToml`, `toml::Value`). Reads load either a cwd-aware layer stack or a thread-agnostic stack, derive the effective merged config, convert it through `ConfigToml` into JSON and then into the protocol `Config`, and optionally attach ordered layer metadata.

Writes are intentionally restricted to the active user config file. `apply_edits` resolves the allowed user path, rejects any other target as read-only, loads the current layer stack, creates an empty user layer if none exists yet, and enforces `expected_version` against the active user layer version. Each requested edit parses a dotted/quoted key path, rejects legacy `profile`/`profiles` writes, converts JSON into `toml::Value`, applies either replace/upsert semantics, and records only materially changed paths as `ConfigEdit`s for persistence. Before writing, it validates the standalone user config, deserializes it with base-path context, checks enterprise feature requirements, then validates the final effective merged config as well—so invalid user values are rejected even if a managed layer would override them. Persistence uses `ConfigEditsBuilder` to preserve existing TOML comments/order where possible. After writing, the service computes whether any edited path is overridden by a higher-precedence layer and returns `WriteStatus::OkOverridden` plus metadata naming the effective layer and value.

#### Function details

##### `ConfigManagerError::write`  (lines 77–82)

```
fn write(code: ConfigWriteErrorCode, message: impl Into<String>) -> Self
```

**Purpose**: Constructs a `ConfigManagerError::Write` carrying a protocol-facing `ConfigWriteErrorCode` and human-readable message. It is the main path for validation, conflict, and policy failures that should be surfaced as structured write errors rather than generic I/O failures.

**Data flow**: Takes a `ConfigWriteErrorCode` and any message convertible into `String`; converts the message with `Into<String>` and returns a `ConfigManagerError::Write { code, message }` value without touching external state.

**Call relations**: Used throughout `ConfigManager::apply_edits` whenever the service wants to reject a write for semantic reasons such as readonly layer access, version conflicts, invalid key paths, legacy profile writes, or validation failures.

*Call graph*: called by 1 (apply_edits); 1 external calls (into).


##### `ConfigManagerError::io`  (lines 84–86)

```
fn io(context: &'static str, source: std::io::Error) -> Self
```

**Purpose**: Wraps a `std::io::Error` with a static context string into the service’s typed error enum. This keeps filesystem/path failures distinguishable from validation and serialization failures.

**Data flow**: Consumes a `&'static str` context and an `std::io::Error`, returning `ConfigManagerError::Io { context, source }` with no side effects.

**Call relations**: Called directly by `create_empty_user_layer` and also used by higher-level methods when mapping path resolution, config loading, and file creation/read failures into service errors.

*Call graph*: called by 1 (create_empty_user_layer).


##### `ConfigManagerError::json`  (lines 88–90)

```
fn json(context: &'static str, source: serde_json::Error) -> Self
```

**Purpose**: Builds a JSON serialization/deserialization error variant with contextual text. It is used when converting between internal config structs and protocol JSON representations.

**Data flow**: Accepts a static context string and `serde_json::Error`, then returns `ConfigManagerError::Json { context, source }`.

**Call relations**: Used by `ConfigManager::read` while serializing `ConfigToml` to JSON and deserializing that JSON into the protocol `ApiConfig`.


##### `ConfigManagerError::toml`  (lines 92–94)

```
fn toml(context: &'static str, source: toml::de::Error) -> Self
```

**Purpose**: Builds a TOML decoding error variant with contextual text. It captures failures where a TOML value cannot be interpreted as the expected config schema.

**Data flow**: Accepts a static context string and `toml::de::Error`, then returns `ConfigManagerError::Toml { context, source }`.

**Call relations**: Used in `ConfigManager::read` when the effective merged TOML cannot be converted into `ConfigToml`, and in `create_empty_user_layer` when an existing user config file parses as invalid TOML.


##### `ConfigManagerError::anyhow`  (lines 96–98)

```
fn anyhow(context: &'static str, source: anyhow::Error) -> Self
```

**Purpose**: Wraps an `anyhow::Error` with context for failures coming from generic helper APIs such as edit application or blocking task joins. It preserves richer upstream error chains while fitting the service error type.

**Data flow**: Consumes a static context string and `anyhow::Error`, returning `ConfigManagerError::Anyhow { context, source }`.

**Call relations**: Used by `ConfigManager::apply_edits` for edit-builder persistence failures and by `write_empty_user_config` when the spawned blocking task panics.


##### `ConfigManagerError::write_error_code`  (lines 100–105)

```
fn write_error_code(&self) -> Option<ConfigWriteErrorCode>
```

**Purpose**: Extracts the protocol write error code only for semantic write failures. Non-write variants return `None`, allowing callers to distinguish structured write rejections from infrastructure errors.

**Data flow**: Reads `self`; if it is `Write { code, .. }`, clones and returns `Some(code)`, otherwise returns `None`.

**Call relations**: Consumed by higher-level error mapping code outside this file to populate protocol responses with specific `ConfigWriteErrorCode` values when available.

*Call graph*: called by 1 (map_error).


##### `ConfigManager::read`  (lines 109–151)

```
async fn read(
        &self,
        params: ConfigReadParams,
    ) -> Result<ConfigReadResponse, ConfigManagerError>
```

**Purpose**: Loads configuration layers, computes the effective config, and returns a protocol `ConfigReadResponse` with origins and optionally the full ordered layer list. It supports cwd-aware reads for project-local `.codex` layers and cwd-less reads for thread-agnostic contexts.

**Data flow**: Reads `params.cwd` and `params.include_layers`. If `cwd` is present, converts it into `AbsolutePathBuf` and loads cwd-specific layers; otherwise loads thread-agnostic layers. It then reads the effective merged TOML, converts it into `ConfigToml`, serializes to JSON, deserializes into `ApiConfig`, and returns `ConfigReadResponse { config, origins, layers }` where `layers` is populated only when requested.

**Call relations**: Invoked by config read RPC handling. It delegates layer loading to `load_thread_agnostic_config` or `load_config_layers`, and uses serde/TOML conversion to bridge internal config representation to the app-server protocol.

*Call graph*: calls 2 internal fn (load_thread_agnostic_config, try_from); 3 external calls (from, from_value, to_value).


##### `ConfigManager::read_requirements`  (lines 153–167)

```
async fn read_requirements(
        &self,
    ) -> Result<Option<ConfigRequirementsToml>, ConfigManagerError>
```

**Purpose**: Returns the loaded configuration requirements TOML, but only when the requirements set is non-empty. This exposes enterprise or managed requirements separately from the effective config.

**Data flow**: Loads the thread-agnostic `ConfigLayerStack`, clones `requirements_toml()`, checks `is_empty()`, and returns `Ok(None)` for empty requirements or `Ok(Some(requirements))` otherwise.

**Call relations**: Used by callers that need to inspect requirement constraints independently of normal config reads; it relies on the same thread-agnostic loading path as write operations.

*Call graph*: calls 1 internal fn (load_thread_agnostic_config).


##### `ConfigManager::write_value`  (lines 169–176)

```
async fn write_value(
        &self,
        params: ConfigValueWriteParams,
    ) -> Result<ConfigWriteResponse, ConfigManagerError>
```

**Purpose**: Adapts a single key/value write request into the shared multi-edit write pipeline. It exists as the simple RPC surface for one-path updates.

**Data flow**: Consumes `ConfigValueWriteParams`, packages `(key_path, value, merge_strategy)` into a one-element `Vec`, and forwards `file_path`, `expected_version`, and the edit list to `apply_edits`, returning its `ConfigWriteResponse` or error.

**Call relations**: Called by the single-value config write RPC path; it delegates all real validation, merging, persistence, and override detection to `ConfigManager::apply_edits`.

*Call graph*: calls 1 internal fn (apply_edits); 1 external calls (vec!).


##### `ConfigManager::batch_write`  (lines 178–190)

```
async fn batch_write(
        &self,
        params: ConfigBatchWriteParams,
    ) -> Result<ConfigWriteResponse, ConfigManagerError>
```

**Purpose**: Adapts a batch of protocol edits into the shared write pipeline so multiple config paths can be validated and persisted atomically. It preserves each edit’s key path, JSON value, and merge strategy.

**Data flow**: Consumes `ConfigBatchWriteParams`, maps each protocol edit into a tuple `(key_path, value, merge_strategy)`, collects them into a `Vec`, and passes `file_path`, `expected_version`, and the collected edits to `apply_edits`.

**Call relations**: Used by batch config write RPC handling; like `write_value`, it is a thin wrapper over `ConfigManager::apply_edits`.

*Call graph*: calls 1 internal fn (apply_edits).


##### `ConfigManager::apply_edits`  (lines 192–353)

```
async fn apply_edits(
        &self,
        file_path: Option<String>,
        expected_version: Option<String>,
        edits: Vec<(String, JsonValue, MergeStrategy)>,
    ) -> Result<ConfigWriteRes
```

**Purpose**: Performs the full config mutation workflow: authorize target path, load/create the user layer, enforce version checks, parse and merge edits, validate both user and effective config, persist only changed paths, and report whether any edited value is overridden by higher-precedence layers.

**Data flow**: Inputs are optional `file_path`, optional `expected_version`, and a vector of `(String, JsonValue, MergeStrategy)` edits. It resolves the allowed user config path from manager state, normalizes the provided path, and rejects mismatches. It loads the thread-agnostic layer stack, obtains the active user layer or synthesizes one via `create_empty_user_layer`, compares `expected_version` to `user_layer.version`, clones the user TOML config, and iterates edits. For each edit it parses the key path with `parse_key_path`, rejects writes to legacy `profile`/`profiles`, reads the original value with `value_at_path`, converts JSON to optional TOML via `parse_value`, mutates the cloned config with `apply_merge`, and if the value changed, records a `ConfigEdit::SetPath` or `ConfigEdit::ClearPath` using `toml_value_to_item`. After all edits it validates the user config schema with `validate_config`, deserializes with base paths using `deserialize_config_toml_with_base`, checks feature requirements, constructs updated layers with `with_user_config`, validates the effective merged config, and if there are recorded edits, persists them through `ConfigEditsBuilder::for_config_path(...).with_edits(...).apply().await`. Finally it computes override metadata with `first_overridden_edit`, derives `WriteStatus`, reads the updated user layer version, and returns `ConfigWriteResponse { status, version, file_path, overridden_metadata }`.

**Call relations**: This is the central write engine called by both `ConfigManager::write_value` and `ConfigManager::batch_write`. It delegates parsing to `parse_key_path`/`parse_value`, mutation to `apply_merge`, schema checks to `validate_config`, persistence conversion to `toml_value_to_item`, and override reporting to `first_overridden_edit`.

*Call graph*: calls 14 internal fn (load_thread_agnostic_config, write, apply_merge, create_empty_user_layer, first_overridden_edit, parse_key_path, parse_value, paths_match, toml_value_to_item, validate_config (+4 more)); called by 2 (batch_write, write_value); 5 external calls (Borrowed, Owned, from, new, for_config_path).


##### `ConfigManager::load_thread_agnostic_config`  (lines 358–360)

```
async fn load_thread_agnostic_config(&self) -> std::io::Result<ConfigLayerStack>
```

**Purpose**: Loads configuration layers without any cwd/project-local context. This intentionally excludes in-repo `.codex` folders so reads and writes that are not tied to a project use only global/session/managed layers.

**Data flow**: Reads `self` and forwards `None` as the cwd argument to `load_config_layers`, returning the resulting `std::io::Result<ConfigLayerStack>` unchanged.

**Call relations**: Used by `ConfigManager::read` when no cwd is supplied, by `read_requirements`, and by `apply_edits` so writes are based on the global/user stack rather than project-local overlays.

*Call graph*: called by 3 (apply_edits, read, read_requirements).


##### `create_empty_user_layer`  (lines 363–399)

```
async fn create_empty_user_layer(
    config_toml: &AbsolutePathBuf,
) -> Result<ConfigLayerEntry, ConfigManagerError>
```

**Purpose**: Synthesizes a `ConfigLayerEntry` for the user config when no active user layer exists yet, creating an empty config file on disk if necessary and respecting symlink-safe read/write paths. It also tolerates an existing symlink target that is absent by creating the writable destination.

**Data flow**: Takes the absolute user config path, resolves symlink read/write paths with `resolve_symlink_write_paths`, then either reads and parses existing TOML from the resolved read path or creates an empty file via `write_empty_user_config` and uses an empty `TomlValue::Table`. It returns `ConfigLayerEntry::new(ConfigLayerSource::User { file, profile: None }, toml_value)`.

**Call relations**: Called by `ConfigManager::apply_edits` only when the loaded layer stack has no active user layer, allowing first-write initialization without requiring a preexisting config file.

*Call graph*: calls 4 internal fn (io, write_empty_user_config, new, as_path); called by 1 (apply_edits); 6 external calls (Table, resolve_symlink_write_paths, read_to_string, from_str, new, clone).


##### `write_empty_user_config`  (lines 401–406)

```
async fn write_empty_user_config(write_path: PathBuf) -> Result<(), ConfigManagerError>
```

**Purpose**: Creates an empty user config file atomically on a blocking thread. This avoids blocking the async runtime on filesystem writes and ensures the file exists before a synthetic user layer is returned.

**Data flow**: Consumes a `PathBuf` write target, runs `write_atomically(&write_path, "")` inside `tokio::task::spawn_blocking`, maps join panics to `Anyhow` errors and I/O failures to `Io` errors, and returns `Ok(())` on success.

**Call relations**: Used only by `create_empty_user_layer` when the user config file or symlink target does not yet exist.

*Call graph*: called by 1 (create_empty_user_layer); 1 external calls (spawn_blocking).


##### `parse_value`  (lines 408–416)

```
fn parse_value(value: JsonValue) -> Result<Option<TomlValue>, String>
```

**Purpose**: Converts an incoming JSON write payload into an optional TOML value, using JSON `null` as the signal to clear a config path. It is the boundary between protocol payloads and TOML-based config editing.

**Data flow**: Takes a `serde_json::Value`; if `is_null()` returns true, returns `Ok(None)`. Otherwise it attempts `serde_json::from_value::<TomlValue>(value)` and returns `Ok(Some(toml_value))` or a formatted validation string on failure.

**Call relations**: Called by `ConfigManager::apply_edits` for every requested edit before merge logic runs.

*Call graph*: called by 1 (apply_edits); 1 external calls (is_null).


##### `parse_key_path`  (lines 418–463)

```
fn parse_key_path(path: &str) -> Result<Vec<String>, String>
```

**Purpose**: Parses dotted config key paths into path segments, supporting quoted segments and escapes so keys containing dots or punctuation can still be addressed. It rejects empty paths, empty segments, malformed quoting, and unterminated escapes.

**Data flow**: Reads a `&str` path, trims only for the initial emptiness check, then scans characters into a mutable segment buffer. Unquoted dots split segments; quoted segments begin only at segment start; backslashes inside quotes escape the next character. It returns `Vec<String>` segments or a descriptive `String` error.

**Call relations**: Used by `ConfigManager::apply_edits` before any lookup or mutation so all downstream helpers operate on normalized segment vectors.

*Call graph*: called by 1 (apply_edits); 3 external calls (new, new, take).


##### `apply_merge`  (lines 470–525)

```
fn apply_merge(
    root: &mut TomlValue,
    segments: &[String],
    value: Option<&TomlValue>,
    strategy: MergeStrategy,
) -> Result<bool, MergeError>
```

**Purpose**: Applies one edit to a mutable TOML tree, either clearing a path, replacing a value, or recursively upserting table contents when both old and new values are tables. It also creates missing parent tables along the path.

**Data flow**: Inputs are mutable root `TomlValue`, path `segments`, optional new value, and `MergeStrategy`. If the value is `None`, it delegates to `clear_path`. Otherwise it splits the path into parent segments and final key, walks/creates parent tables (replacing non-table parents with empty tables), obtains the parent table, and either merges table-to-table with `merge_toml_values` for `Upsert` or inserts/replaces the final key directly. It returns `Ok(changed)` or `MergeError::Validation` for an empty path or impossible non-table parent state.

**Call relations**: Called by `ConfigManager::apply_edits` for each parsed edit. It delegates deletion semantics to `clear_path` and is the core mutation primitive behind replace/upsert behavior.

*Call graph*: calls 1 internal fn (clear_path); called by 1 (apply_edits); 5 external calls (Table, Validation, merge_toml_values, matches!, new).


##### `clear_path`  (lines 527–552)

```
fn clear_path(root: &mut TomlValue, segments: &[String]) -> Result<bool, MergeError>
```

**Purpose**: Removes a value at a nested TOML path without creating missing parents. Missing intermediate segments or non-table parents are treated as a no-op rather than an error.

**Data flow**: Takes mutable root `TomlValue` and path segments, splits into parents and final key, walks existing parent tables only, and if the final parent is a table removes `last`. It returns `Ok(true)` if something was removed, `Ok(false)` if the path did not exist or traversal hit a non-table, and `MergeError::Validation` only for an empty path.

**Call relations**: Used exclusively by `apply_merge` when a write payload is `null`, implementing clear semantics for config paths.

*Call graph*: called by 1 (apply_merge); 1 external calls (Validation).


##### `toml_value_to_item`  (lines 554–566)

```
fn toml_value_to_item(value: &TomlValue) -> anyhow::Result<TomlItem>
```

**Purpose**: Converts a `toml::Value` subtree into a `toml_edit::Item` suitable for structured edit application while preserving explicit table structure. Nested tables become explicit `toml_edit::Table`s rather than implicit inline forms.

**Data flow**: Reads a `TomlValue`. For `Table`, it creates a new `toml_edit::Table`, marks it non-implicit, recursively inserts converted child items, and returns `TomlItem::Table`. For all other variants it delegates to `toml_value_to_value` and wraps the result in `TomlItem::Value`.

**Call relations**: Called by `ConfigManager::apply_edits` when building `ConfigEdit::SetPath` entries for changed values that need to be persisted through `ConfigEditsBuilder`.

*Call graph*: calls 1 internal fn (toml_value_to_value); called by 1 (apply_edits); 3 external calls (Table, Value, new).


##### `toml_value_to_value`  (lines 568–590)

```
fn toml_value_to_value(value: &TomlValue) -> anyhow::Result<toml_edit::Value>
```

**Purpose**: Converts scalar, array, and inline-table TOML values into `toml_edit::Value`. It is the recursive value-level companion to `toml_value_to_item`.

**Data flow**: Matches on `TomlValue`: strings, integers, floats, booleans, and datetimes are converted directly with `toml_edit::Value::from`; arrays are rebuilt element-by-element into `toml_edit::Array`; tables are rebuilt into `toml_edit::InlineTable` by recursively converting each child value. Returns `anyhow::Result<toml_edit::Value>`.

**Call relations**: Used only by `toml_value_to_item` to convert non-table values and nested table contents.

*Call graph*: called by 1 (toml_value_to_item); 5 external calls (new, new, Array, InlineTable, from).


##### `validate_config`  (lines 592–595)

```
fn validate_config(value: &TomlValue) -> Result<(), toml::de::Error>
```

**Purpose**: Checks whether a TOML value conforms to the `ConfigToml` schema. It is a lightweight schema gate used both before and after layering.

**Data flow**: Clones the input `TomlValue`, attempts `try_into::<ConfigToml>()`, discards the parsed result, and returns `Ok(())` or the `toml::de::Error` from conversion.

**Call relations**: Called by `ConfigManager::apply_edits` first on the standalone user config and later on the effective merged config to ensure both are structurally valid.

*Call graph*: called by 1 (apply_edits); 1 external calls (clone).


##### `paths_match`  (lines 597–599)

```
fn paths_match(expected: impl AsRef<Path>, provided: impl AsRef<Path>) -> bool
```

**Purpose**: Normalizes and compares two filesystem paths for equality according to the project’s path utility rules. It prevents writes to arbitrary files by ensuring the requested target is exactly the allowed user config path after normalization.

**Data flow**: Accepts two path-like inputs, forwards them to `path_utils::paths_match_after_normalization`, and returns the resulting boolean.

**Call relations**: Used by `ConfigManager::apply_edits` during authorization of the requested `file_path`.

*Call graph*: called by 1 (apply_edits); 1 external calls (paths_match_after_normalization).


##### `value_at_path`  (lines 601–617)

```
fn value_at_path(root: &'a TomlValue, segments: &[String]) -> Option<&'a TomlValue>
```

**Purpose**: Traverses a TOML tree by string segments, supporting both table keys and array indices. It is used for change detection and override analysis.

**Data flow**: Takes a root `&TomlValue` and segment slice. For each segment, if the current node is a table it looks up the key; if it is an array it parses the segment as `i64`, converts to `usize`, and indexes the array; otherwise it returns `None`. On success it returns a reference to the final `TomlValue`.

**Call relations**: Called by `ConfigManager::apply_edits` to compare original and updated values, by `compute_override_metadata` to compare user and effective values, and by `find_effective_layer` to locate the highest-precedence layer defining a path.

*Call graph*: called by 3 (apply_edits, compute_override_metadata, find_effective_layer); 1 external calls (try_from).


##### `override_message`  (lines 619–648)

```
fn override_message(layer: &ConfigLayerSource) -> String
```

**Purpose**: Formats a human-readable explanation of which config layer overrides a user edit. The message text varies by `ConfigLayerSource` so callers can distinguish MDM, system, enterprise, project, session, user, and legacy managed sources.

**Data flow**: Reads a `&ConfigLayerSource`, matches each variant, and returns a formatted `String` describing that source and any relevant file/domain/name fields.

**Call relations**: Used by `compute_override_metadata` after it identifies the effective overriding layer.

*Call graph*: called by 1 (compute_override_metadata); 1 external calls (format!).


##### `compute_override_metadata`  (lines 650–679)

```
fn compute_override_metadata(
    layers: &ConfigLayerStack,
    effective: &TomlValue,
    segments: &[String],
) -> Option<OverriddenMetadata>
```

**Purpose**: Determines whether a specific edited path is shadowed by a higher-precedence layer and, if so, builds the protocol `OverriddenMetadata` describing the winner and effective value. It suppresses metadata when the user value already matches the effective value or when neither side defines the path.

**Data flow**: Inputs are the updated `ConfigLayerStack`, the effective merged `TomlValue`, and one path segment vector. It reads the active user layer, fetches the user and effective values with `value_at_path`, returns `None` if they are equal or both absent, otherwise finds the highest-precedence defining layer via `find_effective_layer`, formats a message with `override_message`, serializes the effective value to JSON (falling back to `JsonValue::Null`), and returns `Some(OverriddenMetadata { message, overriding_layer, effective_value })`.

**Call relations**: Called by `first_overridden_edit` for each edited path after a successful write to determine whether the response should be marked `OkOverridden`.

*Call graph*: calls 4 internal fn (find_effective_layer, override_message, value_at_path, get_active_user_layer); called by 1 (first_overridden_edit).


##### `first_overridden_edit`  (lines 681–692)

```
fn first_overridden_edit(
    layers: &ConfigLayerStack,
    effective: &TomlValue,
    edits: &[Vec<String>],
) -> Option<OverriddenMetadata>
```

**Purpose**: Scans the edited paths in order and returns metadata for the first one whose user value is overridden in the effective config. This keeps the write response compact while still surfacing a concrete override example.

**Data flow**: Takes the updated layer stack, effective merged TOML, and slice of edited segment vectors; iterates in order, calling `compute_override_metadata` for each, and returns the first `Some(...)` result or `None` if no edited path is overridden.

**Call relations**: Used by `ConfigManager::apply_edits` after persistence and effective-config recomputation to derive response status and optional override metadata.

*Call graph*: calls 1 internal fn (compute_override_metadata); called by 1 (apply_edits).


##### `find_effective_layer`  (lines 694–705)

```
fn find_effective_layer(
    layers: &ConfigLayerStack,
    segments: &[String],
) -> Option<ConfigLayerMetadata>
```

**Purpose**: Finds the highest-precedence config layer that defines a given path. It does not compare values; it simply returns the first layer in precedence order containing that path.

**Data flow**: Reads the `ConfigLayerStack`, iterates `layers_high_to_low()`, checks each layer’s `config` with `value_at_path`, and returns that layer’s `metadata()` for the first match, or `None` if no layer defines the path.

**Call relations**: Called by `compute_override_metadata` to identify which layer should be named as the overriding source.

*Call graph*: calls 2 internal fn (value_at_path, layers_high_to_low); called by 1 (compute_override_metadata).


### Editable config persistence
These files implement the low-level TOML editing machinery and higher-level mutation pipeline used to persist user-editable configuration changes safely.

### `core/src/config/edit.rs`

`domain_logic` · `config load/update time; whenever the application persists user preference changes`

This file defines the editable surface of user configuration as the `ConfigEdit` enum, then applies those edits against a `toml_edit::DocumentMut` through `ConfigDocument`. The supported mutations cover model selection, service tier and personality, notice acknowledgement flags under `[notice]`, MCP server replacement, tool suggestion suppression, skill overrides in `[[skills.config]]`, project trust levels, and arbitrary dotted-path set/clear operations. Several small helper constructors produce common `SetPath` edits for TUI settings such as theme, pet, session picker view, status line, terminal title, and key bindings.

`ConfigDocument::apply` is the central dispatcher: it matches each `ConfigEdit` variant and either writes/removes scalar values, delegates to specialized routines for complex structures, or calls `crate::config::set_project_trust_level_inner` to reuse existing migration logic for project tables. The implementation is careful about TOML shape: `descend` creates implicit tables when writing, only traverses existing tables when removing, and `preserve_decor` copies comments/whitespace decoration from replaced items so edits do not unnecessarily reformat the file. Complex writers normalize and deduplicate data: disabled tool suggestions are parsed from either arrays or array-of-tables and rewritten in canonical form; skill config selectors are normalized by trimmed names or canonicalized paths; MCP server replacement updates existing entries in place, merges inline tables when possible, and removes stale keys.

Persistence happens in `apply_blocking_to_resolved_file`, which resolves symlink-safe read/write paths, reads the current file if present, parses TOML or starts from an empty document, applies all edits, and skips disk I/O if nothing changed. Writes use `write_atomically`, and async entry points simply offload the blocking work with `tokio::task::spawn_blocking`. `ConfigEditsBuilder` wraps this machinery in a chainable API that accumulates `ConfigEdit` values against a chosen config path.

#### Function details

##### `syntax_theme_edit`  (lines 86–91)

```
fn syntax_theme_edit(name: &str) -> ConfigEdit
```

**Purpose**: Builds a `ConfigEdit::SetPath` that writes the selected syntax theme to `[tui].theme`.

**Data flow**: Takes a theme name `&str`, clones it into an owned TOML string value, and returns a `ConfigEdit` with path segments `['tui', 'theme']`. It does not touch filesystem or document state itself.

**Call relations**: Used by higher-level UI event handling when a theme selection changes; it contributes a single edit object that later flows into `ConfigDocument::apply` through the persistence pipeline.

*Call graph*: called by 1 (handle_event); 2 external calls (value, vec!).


##### `tui_pet_edit`  (lines 94–99)

```
fn tui_pet_edit(name: &str) -> ConfigEdit
```

**Purpose**: Builds a `ConfigEdit::SetPath` that stores the chosen TUI pet name under `[tui].pet`.

**Data flow**: Accepts a pet name `&str`, converts it to a TOML string item, and returns a path-based edit targeting `tui.pet`.

**Call relations**: Called from pet-related handlers when the pet is disabled or selected; the returned edit is later batched and persisted by the builder or direct apply functions.

*Call graph*: called by 2 (handle_pet_disabled, handle_pet_selection_loaded); 2 external calls (value, vec!).


##### `session_picker_view_edit`  (lines 102–107)

```
fn session_picker_view_edit(mode: SessionPickerViewMode) -> ConfigEdit
```

**Purpose**: Creates an edit that persists the session picker display mode under `[tui].session_picker_view`.

**Data flow**: Consumes a `SessionPickerViewMode`, converts it with `to_string()`, wraps it as a TOML value, and returns a `SetPath` edit for the `tui.session_picker_view` key.

**Call relations**: Serves as a convenience constructor for callers that want a standalone edit rather than using the builder’s dedicated method.

*Call graph*: 3 external calls (to_string, value, vec!).


##### `status_line_items_edit`  (lines 113–120)

```
fn status_line_items_edit(items: &[String]) -> ConfigEdit
```

**Purpose**: Creates an edit that writes an explicit ordered array to `[tui].status_line`, including an empty array when the user intentionally disables the status line.

**Data flow**: Takes a slice of `String`, clones them into a `toml_edit::Array`, wraps that array as `TomlItem::Value`, and returns a `SetPath` edit for `tui.status_line`.

**Call relations**: Invoked by UI event handling for status-line customization; later interpreted by `ConfigDocument::apply` as a generic path insertion.

*Call graph*: called by 1 (handle_event); 2 external calls (Value, vec!).


##### `status_line_use_colors_edit`  (lines 123–128)

```
fn status_line_use_colors_edit(enabled: bool) -> ConfigEdit
```

**Purpose**: Builds an edit that toggles `[tui].status_line_use_colors`.

**Data flow**: Accepts a boolean, converts it to a TOML boolean item, and returns a `SetPath` edit targeting `tui.status_line_use_colors`.

**Call relations**: Used by event handlers that change status-line color behavior; persistence is deferred to the common apply path.

*Call graph*: called by 1 (handle_event); 2 external calls (value, vec!).


##### `terminal_title_items_edit`  (lines 134–141)

```
fn terminal_title_items_edit(items: &[String]) -> ConfigEdit
```

**Purpose**: Creates an edit that writes an explicit ordered array to `[tui].terminal_title`, preserving the distinction between empty and unset.

**Data flow**: Clones the provided `String` slice into a TOML array, wraps it as a value item, and returns a `SetPath` edit for `tui.terminal_title`.

**Call relations**: Called from UI code that updates terminal title configuration; the resulting edit is later applied generically.

*Call graph*: called by 1 (handle_event); 2 external calls (Value, vec!).


##### `keymap_binding_value`  (lines 143–150)

```
fn keymap_binding_value(keys: &[String]) -> TomlItem
```

**Purpose**: Normalizes a key binding payload into the TOML representation expected by the config file: a single string for one key, or an array for multiple keys.

**Data flow**: Reads a slice of key strings; if it contains exactly one element it returns a scalar TOML string item, otherwise it clones all keys into a TOML array and returns that array as a value item.

**Call relations**: This is an internal helper used only by `keymap_bindings_edit` so callers can pass a uniform `&[String]` while the file format stays compact for single-key bindings.

*Call graph*: called by 1 (keymap_bindings_edit); 2 external calls (Value, value).


##### `keymap_bindings_edit`  (lines 153–163)

```
fn keymap_bindings_edit(context: &str, action: &str, keys: &[String]) -> ConfigEdit
```

**Purpose**: Builds a `SetPath` edit that replaces one root-level TUI keymap binding entry for a given context and action.

**Data flow**: Accepts `context`, `action`, and a list of keys; it constructs path segments `tui.keymap.<context>.<action>`, converts the keys through `keymap_binding_value`, and returns the resulting `ConfigEdit`.

**Call relations**: Used directly by keymap capture flows and indirectly by `keymap_binding_edit`; the returned edit is later inserted by `ConfigDocument::apply`.

*Call graph*: calls 1 internal fn (keymap_binding_value); called by 2 (keymap_binding_edit, apply_keymap_capture); 1 external calls (vec!).


##### `keymap_binding_edit`  (lines 166–168)

```
fn keymap_binding_edit(context: &str, action: &str, key: &str) -> ConfigEdit
```

**Purpose**: Convenience wrapper for writing a single-key binding without manually constructing a one-element slice.

**Data flow**: Takes `context`, `action`, and one key string, wraps the key into a temporary one-element slice, and forwards to `keymap_bindings_edit`, returning its `ConfigEdit`.

**Call relations**: Sits above `keymap_bindings_edit` in the call flow for callers that only need one binding string.

*Call graph*: calls 1 internal fn (keymap_bindings_edit).


##### `keymap_binding_clear_edit`  (lines 171–180)

```
fn keymap_binding_clear_edit(context: &str, action: &str) -> ConfigEdit
```

**Purpose**: Builds a `ClearPath` edit that removes one TUI keymap binding entry.

**Data flow**: Accepts `context` and `action`, constructs the dotted path segments under `tui.keymap`, and returns a `ConfigEdit::ClearPath`.

**Call relations**: Used by keymap-clear flows; later consumed by `ConfigDocument::apply`, which routes it to `clear_owned` and `remove`.

*Call graph*: called by 1 (apply_keymap_clear); 1 external calls (vec!).


##### `model_availability_nux_count_edits`  (lines 182–201)

```
fn model_availability_nux_count_edits(shown_count: &HashMap<String, u32>) -> Vec<ConfigEdit>
```

**Purpose**: Expands a map of per-model NUX display counts into a deterministic sequence of edits that rewrites the entire `[tui].model_availability_nux` subtree.

**Data flow**: Reads a `HashMap<String, u32>`, sorts entries by model slug for stable output, emits an initial `ClearPath` for `tui.model_availability_nux`, then appends one `SetPath` per model with the count converted to `i64` TOML values. Returns the full `Vec<ConfigEdit>`.

**Call relations**: Called by the builder’s `set_model_availability_nux_count` method so the persisted TOML is rewritten in a canonical order rather than incrementally patched.

*Call graph*: called by 1 (set_model_availability_nux_count); 3 external calls (from, value, vec!).


##### `ConfigDocument::new`  (lines 214–216)

```
fn new(doc: DocumentMut) -> Self
```

**Purpose**: Wraps a parsed `DocumentMut` in the file’s editing façade.

**Data flow**: Consumes a `DocumentMut` and stores it in `ConfigDocument { doc }`, returning the new wrapper without modifying contents.

**Call relations**: Constructed inside `apply_blocking_to_resolved_file` after parsing or creating the TOML document.

*Call graph*: called by 1 (apply_blocking_to_resolved_file).


##### `ConfigDocument::apply`  (lines 218–337)

```
fn apply(&mut self, edit: &ConfigEdit) -> anyhow::Result<bool>
```

**Purpose**: Dispatches one `ConfigEdit` variant to the concrete TOML mutation logic and reports whether the document changed.

**Data flow**: Reads an immutable `ConfigEdit` and mutates `self.doc` according to its variant. Simple variants call `write_optional_value`, `write_value`, `insert`, or `clear_owned`; complex variants delegate to `replace_mcp_servers`, `add_tool_suggest_disabled_tool`, `set_skill_config`, or `crate::config::set_project_trust_level_inner`. It returns `anyhow::Result<bool>`, where `bool` indicates mutation and errors propagate parse/shape failures from delegated logic.

**Call relations**: This is the central per-edit executor used in the loop inside `apply_blocking_to_resolved_file`. It fans out to all specialized mutation helpers depending on the edit variant.

*Call graph*: calls 8 internal fn (add_tool_suggest_disabled_tool, clear_owned, insert, replace_mcp_servers, set_skill_config, write_optional_value, write_value, set_project_trust_level_inner); 3 external calls (Name, Path, value).


##### `ConfigDocument::write_optional_value`  (lines 339–344)

```
fn write_optional_value(&mut self, segments: &[&str], value: Option<TomlItem>) -> bool
```

**Purpose**: Implements the common pattern 'write this key if a value exists, otherwise remove it'.

**Data flow**: Takes a borrowed segment slice and an `Option<TomlItem>`; `Some` is forwarded to `write_value`, `None` to `clear`. It returns the mutation flag from the chosen operation.

**Call relations**: Used by `ConfigDocument::apply` for optional settings like model, reasoning effort, service tier, and personality.

*Call graph*: calls 2 internal fn (clear, write_value); called by 1 (apply).


##### `ConfigDocument::write_value`  (lines 346–352)

```
fn write_value(&mut self, segments: &[&str], value: TomlItem) -> bool
```

**Purpose**: Writes a TOML item at a borrowed dotted path by converting borrowed segments into owned strings and delegating to insertion logic.

**Data flow**: Reads `&[&str]` path segments and a `TomlItem`, clones the segments into `Vec<String>`, then calls `insert`. Returns whether insertion succeeded.

**Call relations**: Called from `apply`, `write_optional_value`, and `add_tool_suggest_disabled_tool` as the standard path-writing helper.

*Call graph*: calls 1 internal fn (insert); called by 3 (add_tool_suggest_disabled_tool, apply, write_optional_value).


##### `ConfigDocument::clear`  (lines 354–360)

```
fn clear(&mut self, segments: &[&str]) -> bool
```

**Purpose**: Removes a TOML item at a borrowed dotted path.

**Data flow**: Converts `&[&str]` segments into owned `Vec<String>` and delegates to `remove`, returning whether a key was actually deleted.

**Call relations**: Used by `write_optional_value` and `replace_mcp_servers` when a whole subtree should disappear if no value remains.

*Call graph*: calls 1 internal fn (remove); called by 2 (replace_mcp_servers, write_optional_value).


##### `ConfigDocument::add_tool_suggest_disabled_tool`  (lines 362–394)

```
fn add_tool_suggest_disabled_tool(&mut self, disabled_tool: &ToolSuggestDisabledTool) -> bool
```

**Purpose**: Reads existing disabled-tool suggestions from either supported TOML encoding, appends one new tool, normalizes and deduplicates the set, then rewrites `[tool_suggest].disabled_tools` in canonical form.

**Data flow**: Inspects `self.doc` under `tool_suggest.disabled_tools`, parses existing entries from either a plain array or an `ArrayOfTables` using helpers in `document_helpers`, chains in the new `ToolSuggestDisabledTool`, normalizes each entry, removes duplicates with a `HashSet`, collects the final list, serializes it back with `tool_suggest_disabled_tools_value`, and writes it via `write_value`. It mutates the document and returns whether the write changed state.

**Call relations**: Reached from `ConfigDocument::apply` for `ConfigEdit::AddToolSuggestDisabledTool`; it encapsulates the compatibility logic for old and new on-disk representations.

*Call graph*: calls 2 internal fn (write_value, tool_suggest_disabled_tools_value); called by 1 (apply); 4 external calls (get, new, clone, once).


##### `ConfigDocument::clear_owned`  (lines 396–398)

```
fn clear_owned(&mut self, segments: &[String]) -> bool
```

**Purpose**: Owned-string variant of path removal used by `ConfigEdit::ClearPath`.

**Data flow**: Accepts `&[String]` and forwards directly to `remove`, returning the deletion result.

**Call relations**: Called only from `ConfigDocument::apply` when the edit already carries owned path segments.

*Call graph*: calls 1 internal fn (remove); called by 1 (apply).


##### `ConfigDocument::replace_mcp_servers`  (lines 400–451)

```
fn replace_mcp_servers(&mut self, servers: &BTreeMap<String, McpServerConfig>) -> bool
```

**Purpose**: Replaces the entire `[mcp_servers]` table with the supplied server map while preserving compatible existing formatting where possible.

**Data flow**: Reads a `BTreeMap<String, McpServerConfig>`. If empty, it clears `mcp_servers`. Otherwise it ensures the root contains a writable table at `mcp_servers`, removes any existing server keys not present in the new map, then for each server either merges into an existing inline table using `serialize_mcp_server_inline` and `merge_inline_table` or replaces/inserts the entry with `serialize_mcp_server`. It mutates `self.doc` and returns `true` on the replacement path.

**Call relations**: Invoked from `ConfigDocument::apply` for `ReplaceMcpServers`; this is the specialized serializer for MCP server config persistence.

*Call graph*: calls 6 internal fn (clear, ensure_table_for_write, merge_inline_table, new_implicit_table, serialize_mcp_server, serialize_mcp_server_inline); called by 1 (apply); 2 external calls (as_table_mut, Table).


##### `ConfigDocument::set_skill_config`  (lines 453–562)

```
fn set_skill_config(&mut self, selector: SkillConfigSelector, enabled: bool) -> bool
```

**Purpose**: Adds, updates, or removes one `[[skills.config]]` override entry identified by normalized name or path, using `enabled = false` entries to represent disabled skills and deleting entries to represent enabled/default behavior.

**Data flow**: Accepts a `SkillConfigSelector` and target `enabled` flag. It normalizes names by trimming and paths by canonicalizing through `normalize_skill_config_path`; invalid empty names return `false`. It then ensures `[skills]` and `[[skills.config]]` exist in writable form when needed, scans existing tables with `skill_config_selector_from_table` to find a matching selector, and either removes the matching override when enabling, updates an existing table to `enabled = false`, or appends a new explicit table with `write_skill_config_selector` and `enabled = false`. If the array becomes empty it removes `config`, and if `[skills]` becomes empty it removes that table too. Returns whether any mutation occurred.

**Call relations**: Called from `ConfigDocument::apply` for both path-based and name-based skill edits; it centralizes the file-format semantics for skill overrides.

*Call graph*: calls 4 internal fn (ensure_table_for_write, new_implicit_table, normalize_skill_config_path, write_skill_config_selector); called by 1 (apply); 10 external calls (new, as_table_mut, from, ArrayOfTables, Table, new, Name, Path, matches!, value).


##### `ConfigDocument::insert`  (lines 564–579)

```
fn insert(&mut self, segments: &[String], value: TomlItem) -> bool
```

**Purpose**: Writes a TOML item at an owned dotted path, creating parent tables as needed and preserving formatting decoration from any replaced value.

**Data flow**: Splits the path into parent segments and final key; if the path is empty it returns `false`. It obtains or creates the parent table via `descend(..., TraversalMode::Create)`, copies comments/spacing from an existing item at the target key into the replacement via `preserve_decor`, assigns the new item into the table, and returns `true`.

**Call relations**: Used by generic path writes from `ConfigDocument::apply` and by `write_value`; it is the core low-level insertion primitive.

*Call graph*: calls 1 internal fn (descend); called by 2 (apply, write_value); 1 external calls (preserve_decor).


##### `ConfigDocument::remove`  (lines 581–591)

```
fn remove(&mut self, segments: &[String]) -> bool
```

**Purpose**: Deletes a TOML item at an owned dotted path, but only if all parent tables already exist and are readable as tables.

**Data flow**: Splits the path into parents and final key; empty paths return `false`. It traverses existing parents with `descend(..., TraversalMode::Existing)`, removes the final key from the resulting table, and returns whether a value was present.

**Call relations**: Called by `clear` and `clear_owned`; it is the low-level deletion primitive for path-based edits.

*Call graph*: calls 1 internal fn (descend); called by 2 (clear, clear_owned).


##### `ConfigDocument::descend`  (lines 593–617)

```
fn descend(&mut self, segments: &[String], mode: TraversalMode) -> Option<&mut TomlTable>
```

**Purpose**: Traverses nested TOML tables to reach a parent table for read or write operations, optionally creating missing implicit tables on the way.

**Data flow**: Starts from `self.doc.as_table_mut()` and iterates over path segments. In `Create` mode it inserts missing implicit tables and uses `ensure_table_for_write` to coerce/validate each segment as writable table-like data; in `Existing` mode it requires each segment to already exist and uses `ensure_table_for_read`. It returns `Option<&mut TomlTable>` for the final parent table.

**Call relations**: Shared by `insert` and `remove` so both path-writing and path-deletion use the same traversal semantics.

*Call graph*: calls 3 internal fn (ensure_table_for_read, ensure_table_for_write, new_implicit_table); called by 2 (insert, remove); 2 external calls (as_table_mut, Table).


##### `ConfigDocument::preserve_decor`  (lines 619–648)

```
fn preserve_decor(existing: &TomlItem, replacement: &mut TomlItem)
```

**Purpose**: Recursively copies TOML decoration metadata—comments, whitespace, and key formatting—from an existing item into a replacement item so edits preserve user-facing formatting.

**Data flow**: Reads an existing `TomlItem` and a mutable replacement `TomlItem`. For table-to-table replacements it clones table decor, key decor, and then recurses into matching child items; for value-to-value replacements it clones value decor; mismatched kinds are left unchanged.

**Call relations**: Called by `insert` before overwriting an existing key, ensuring generic path writes do not strip formatting from the document.

*Call graph*: 1 external calls (preserve_decor).


##### `normalize_skill_config_path`  (lines 651–656)

```
fn normalize_skill_config_path(path: &Path) -> String
```

**Purpose**: Canonicalizes a skill config path into a stable string form for matching and persistence.

**Data flow**: Accepts a `&Path`, attempts `dunce::canonicalize`, falls back to the original path on failure, converts the resulting path to a lossy string, and returns that `String`.

**Call relations**: Used by `ConfigDocument::set_skill_config` and `skill_config_selector_from_table` so both incoming selectors and existing TOML entries compare in the same normalized form.

*Call graph*: called by 1 (set_skill_config); 1 external calls (canonicalize).


##### `skill_config_selector_from_table`  (lines 658–675)

```
fn skill_config_selector_from_table(table: &TomlTable) -> Option<SkillConfigSelector>
```

**Purpose**: Parses one `[[skills.config]]` table into either a normalized path selector or a trimmed name selector, rejecting ambiguous or malformed entries.

**Data flow**: Reads `path` and `name` keys from a `TomlTable`. A `path` string is normalized through `normalize_skill_config_path`; a `name` string is trimmed and discarded if empty. It returns `Some(SkillConfigSelector)` only when exactly one of `path` or `name` is present and valid; otherwise `None`.

**Call relations**: Used during `ConfigDocument::set_skill_config` to locate an existing override entry matching the requested selector.

*Call graph*: 1 external calls (get).


##### `write_skill_config_selector`  (lines 677–688)

```
fn write_skill_config_selector(table: &mut TomlTable, selector: &SkillConfigSelector)
```

**Purpose**: Writes the identifying field for a skill override table, ensuring only one of `name` or `path` is present.

**Data flow**: Mutates a `TomlTable` in place based on a `SkillConfigSelector`: for `Name`, it removes `path` and writes `name`; for `Path`, it removes `name` and writes the path string. It returns no value.

**Call relations**: Called by `ConfigDocument::set_skill_config` both when updating an existing override and when constructing a new explicit table.

*Call graph*: called by 1 (set_skill_config); 2 external calls (remove, value).


##### `apply_blocking`  (lines 691–694)

```
fn apply_blocking(codex_home: &Path, edits: &[ConfigEdit]) -> anyhow::Result<()>
```

**Purpose**: Convenience entry point that resolves the standard config file path under a Codex home directory and applies a batch of edits synchronously.

**Data flow**: Takes `codex_home` and a slice of `ConfigEdit`, joins `CONFIG_TOML_FILE` onto the home path, and forwards to `apply_blocking_to_resolved_file`, returning its `anyhow::Result<()>`.

**Call relations**: Used by tests and synchronous callers that want to persist edits to the default user config location.

*Call graph*: calls 1 internal fn (apply_blocking_to_resolved_file); called by 13 (replace_mcp_servers_round_trips_entries, replace_mcp_servers_serializes_cwd, replace_mcp_servers_serializes_disabled_flag, replace_mcp_servers_serializes_env_sorted, replace_mcp_servers_serializes_env_vars, replace_mcp_servers_serializes_required_flag, replace_mcp_servers_serializes_sourced_env_vars, replace_mcp_servers_serializes_tool_filters, replace_mcp_servers_streamable_http_isolates_headers_between_servers, replace_mcp_servers_streamable_http_removes_optional_sections (+3 more)); 1 external calls (join).


##### `apply_blocking_to_resolved_file`  (lines 696–739)

```
fn apply_blocking_to_resolved_file(
    resolved_config_file: &Path,
    edits: &[ConfigEdit],
) -> anyhow::Result<()>
```

**Purpose**: Performs the full read-modify-write cycle for a config file on the current thread, including symlink-safe path resolution and atomic writeback.

**Data flow**: Accepts a concrete config file path and edit slice. If the slice is empty it returns immediately. Otherwise it resolves read/write paths with `resolve_symlink_write_paths`, reads existing TOML text if the read path exists (treating `NotFound` as empty), parses it into `DocumentMut` or creates a new document, wraps it in `ConfigDocument`, applies each edit while OR-ing their mutation flags, and if any edit changed the document writes `document.doc.to_string()` to the resolved write path via `write_atomically`. Errors are enriched with context naming the target path.

**Call relations**: This is the core persistence driver called by both top-level `apply_blocking` and the async wrappers in this file.

*Call graph*: calls 1 internal fn (new); called by 2 (apply_blocking, apply_blocking); 6 external calls (new, new, is_empty, resolve_symlink_write_paths, write_atomically, read_to_string).


##### `apply`  (lines 743–749)

```
async fn apply(codex_home: &Path, edits: Vec<ConfigEdit>) -> anyhow::Result<()>
```

**Purpose**: Asynchronous wrapper around blocking config persistence.

**Data flow**: Clones `codex_home` into an owned `PathBuf`, computes the config path, moves both path and owned `Vec<ConfigEdit>` into `tokio::task::spawn_blocking`, and returns the inner `apply_blocking_to_resolved_file` result, converting task panics into contextualized errors.

**Call relations**: Used by async callers that need to persist edits without blocking the runtime thread; it delegates all actual file work to `apply_blocking_to_resolved_file`.

*Call graph*: 3 external calls (join, to_path_buf, spawn_blocking).


##### `ConfigEditsBuilder::new`  (lines 759–761)

```
fn new(codex_home: &Path) -> Self
```

**Purpose**: Creates a builder targeting the default `config.toml` under a given Codex home directory.

**Data flow**: Takes `codex_home`, joins `CONFIG_TOML_FILE`, and forwards to `for_config_path`, returning a builder with that path and an empty edit list.

**Call relations**: Entry constructor for callers that know only the home directory and want to chain edit methods.

*Call graph*: 2 external calls (join, for_config_path).


##### `ConfigEditsBuilder::for_config`  (lines 763–770)

```
fn for_config(config: &crate::config::Config) -> Self
```

**Purpose**: Creates a builder using the effective user config file path from an existing runtime `Config`, falling back to `<codex_home>/config.toml` if needed.

**Data flow**: Reads `config.config_layer_stack.get_user_config_file()`, converts an `AbsolutePathBuf` to `PathBuf` when present, otherwise derives the default path from `config.codex_home`, then delegates to `for_config_path`.

**Call relations**: Used when persistence should target the same user config file selected by the loaded configuration stack rather than blindly using the home directory.

*Call graph*: 1 external calls (for_config_path).


##### `ConfigEditsBuilder::for_config_path`  (lines 772–777)

```
fn for_config_path(config_path: &Path) -> Self
```

**Purpose**: Creates a builder for an explicit config file path.

**Data flow**: Clones the provided `&Path` into `config_path`, initializes `edits` as an empty `Vec`, and returns the builder.

**Call relations**: Underlying constructor used by `new` and `for_config`.

*Call graph*: 2 external calls (to_path_buf, new).


##### `ConfigEditsBuilder::set_model`  (lines 779–785)

```
fn set_model(mut self, model: Option<&str>, effort: Option<ReasoningEffort>) -> Self
```

**Purpose**: Queues a `SetModel` edit containing an optional model slug and optional reasoning effort.

**Data flow**: Consumes the builder, converts `Option<&str>` into `Option<String>`, pushes `ConfigEdit::SetModel { model, effort }` onto `self.edits`, and returns the updated builder.

**Call relations**: One of the chainable builder methods; its queued edit is later executed by `apply_blocking` or async `apply`.


##### `ConfigEditsBuilder::set_service_tier`  (lines 787–790)

```
fn set_service_tier(mut self, service_tier: Option<String>) -> Self
```

**Purpose**: Queues a service-tier preference update.

**Data flow**: Consumes the builder, pushes `ConfigEdit::SetServiceTier { service_tier }` into the edit list, and returns the builder.

**Call relations**: Feeds `ConfigDocument::apply`, which normalizes legacy config spelling when the batch is persisted.


##### `ConfigEditsBuilder::set_personality`  (lines 792–796)

```
fn set_personality(mut self, personality: Option<Personality>) -> Self
```

**Purpose**: Queues a model personality update.

**Data flow**: Consumes the builder, appends `ConfigEdit::SetModelPersonality { personality }`, and returns the builder.

**Call relations**: Used by callers that want personality persisted alongside other edits in one atomic write.


##### `ConfigEditsBuilder::set_hide_full_access_warning`  (lines 798–802)

```
fn set_hide_full_access_warning(mut self, acknowledged: bool) -> Self
```

**Purpose**: Queues persistence of the notice acknowledgement flag for the full-access warning.

**Data flow**: Pushes `ConfigEdit::SetNoticeHideFullAccessWarning(acknowledged)` into `self.edits` and returns the builder.

**Call relations**: Later handled by `ConfigDocument::apply`, which writes `[notice].hide_full_access_warning`.

*Call graph*: 1 external calls (SetNoticeHideFullAccessWarning).


##### `ConfigEditsBuilder::set_hide_world_writable_warning`  (lines 804–808)

```
fn set_hide_world_writable_warning(mut self, acknowledged: bool) -> Self
```

**Purpose**: Queues persistence of the notice acknowledgement flag for the world-writable directories warning.

**Data flow**: Pushes `ConfigEdit::SetNoticeHideWorldWritableWarning(acknowledged)` and returns the builder.

**Call relations**: Its queued edit is translated by `ConfigDocument::apply` into a write under the `notice` table.

*Call graph*: 1 external calls (SetNoticeHideWorldWritableWarning).


##### `ConfigEditsBuilder::set_hide_rate_limit_model_nudge`  (lines 810–814)

```
fn set_hide_rate_limit_model_nudge(mut self, acknowledged: bool) -> Self
```

**Purpose**: Queues persistence of the acknowledgement flag for the rate-limit model nudge.

**Data flow**: Appends `ConfigEdit::SetNoticeHideRateLimitModelNudge(acknowledged)` to the builder’s edit list and returns `self`.

**Call relations**: Participates in the same notice-flag persistence flow as the other acknowledgement setters.

*Call graph*: 1 external calls (SetNoticeHideRateLimitModelNudge).


##### `ConfigEditsBuilder::set_hide_model_migration_prompt`  (lines 816–823)

```
fn set_hide_model_migration_prompt(mut self, model: &str, acknowledged: bool) -> Self
```

**Purpose**: Queues persistence of a per-migration acknowledgement flag for a model migration prompt.

**Data flow**: Clones the model/migration key into `String`, pushes `ConfigEdit::SetNoticeHideModelMigrationPrompt(model.to_string(), acknowledged)`, and returns the builder.

**Call relations**: Later written by `ConfigDocument::apply` under `[notice]` using the provided migration-specific key.

*Call graph*: 1 external calls (SetNoticeHideModelMigrationPrompt).


##### `ConfigEditsBuilder::set_hide_external_config_migration_prompt_home`  (lines 825–831)

```
fn set_hide_external_config_migration_prompt_home(mut self, acknowledged: bool) -> Self
```

**Purpose**: Queues the acknowledgement flag for the home external-config migration prompt.

**Data flow**: Pushes `ConfigEdit::SetNoticeHideExternalConfigMigrationPromptHome(acknowledged)` and returns the builder.

**Call relations**: Applied later as a nested write under `notice.external_config_migration_prompts.home`.

*Call graph*: 1 external calls (SetNoticeHideExternalConfigMigrationPromptHome).


##### `ConfigEditsBuilder::set_hide_external_config_migration_prompt_project`  (lines 833–845)

```
fn set_hide_external_config_migration_prompt_project(
        mut self,
        project: &str,
        acknowledged: bool,
    ) -> Self
```

**Purpose**: Queues the acknowledgement flag for a project-specific external-config migration prompt.

**Data flow**: Clones the project identifier into `String`, pushes `ConfigEdit::SetNoticeHideExternalConfigMigrationPromptProject(project.to_string(), acknowledged)`, and returns the builder.

**Call relations**: Later persisted by `ConfigDocument::apply` under the nested `projects` map inside the notice migration prompt table.

*Call graph*: 1 external calls (SetNoticeHideExternalConfigMigrationPromptProject).


##### `ConfigEditsBuilder::record_model_migration_seen`  (lines 847–853)

```
fn record_model_migration_seen(mut self, from: &str, to: &str) -> Self
```

**Purpose**: Queues a record that a specific old-model to new-model migration prompt has been shown.

**Data flow**: Clones `from` and `to` into owned strings, pushes `ConfigEdit::RecordModelMigrationSeen { from, to }`, and returns the builder.

**Call relations**: When applied, this becomes an entry under `[notice].model_migrations`.


##### `ConfigEditsBuilder::set_model_availability_nux_count`  (lines 855–859)

```
fn set_model_availability_nux_count(mut self, shown_count: &HashMap<String, u32>) -> Self
```

**Purpose**: Queues a canonical rewrite of the model-availability NUX counters.

**Data flow**: Calls `model_availability_nux_count_edits(shown_count)` to expand the map into multiple edits, extends `self.edits` with them, and returns the builder.

**Call relations**: This method sits above the helper that sorts and rewrites the subtree; persistence later uses the generic apply loop.

*Call graph*: calls 1 internal fn (model_availability_nux_count_edits).


##### `ConfigEditsBuilder::replace_mcp_servers`  (lines 861–865)

```
fn replace_mcp_servers(mut self, servers: &BTreeMap<String, McpServerConfig>) -> Self
```

**Purpose**: Queues replacement of the entire MCP server configuration table.

**Data flow**: Clones the provided `BTreeMap<String, McpServerConfig>`, wraps it in `ConfigEdit::ReplaceMcpServers`, pushes it into the edit list, and returns the builder.

**Call relations**: Delegates actual serialization and merge behavior to `ConfigDocument::replace_mcp_servers` during apply.

*Call graph*: 1 external calls (ReplaceMcpServers).


##### `ConfigEditsBuilder::set_project_trust_level`  (lines 867–877)

```
fn set_project_trust_level(
        mut self,
        project_path: P,
        trust_level: TrustLevel,
    ) -> Self
```

**Purpose**: Queues a trust-level update for one project path.

**Data flow**: Accepts any `P: Into<PathBuf>`, converts it into a `PathBuf`, pushes `ConfigEdit::SetProjectTrustLevel { path, level }`, and returns the builder.

**Call relations**: Later handled by `ConfigDocument::apply`, which delegates to the existing trust-level migration logic in `crate::config`.

*Call graph*: 1 external calls (into).


##### `ConfigEditsBuilder::set_feature_enabled`  (lines 884–899)

```
fn set_feature_enabled(mut self, key: &str, enabled: bool) -> Self
```

**Purpose**: Queues a feature-flag write under `[features]`, with special handling so disabling a default-false feature clears the key instead of pinning `false` in the file.

**Data flow**: Builds path segments `features.<key>`, looks up the feature in `FEATURES`, checks whether it is default-disabled, and then pushes either `SetPath { value: true/false }` or `ClearPath` depending on `enabled` and the feature’s default. Returns the updated builder.

**Call relations**: This method encodes a subtle persistence policy so future feature graduation does not get blocked by stale explicit `false` values.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_windows_sandbox_mode`  (lines 901–907)

```
fn set_windows_sandbox_mode(mut self, mode: &str) -> Self
```

**Purpose**: Queues a write to `[windows].sandbox`.

**Data flow**: Converts the provided mode string into a TOML value, pushes a `SetPath` edit for `windows.sandbox`, and returns the builder.

**Call relations**: Used by callers updating Windows sandbox configuration; actual insertion is generic.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_realtime_microphone`  (lines 909–919)

```
fn set_realtime_microphone(mut self, microphone: Option<&str>) -> Self
```

**Purpose**: Queues setting or clearing the configured microphone device under `[audio].microphone`.

**Data flow**: Builds path segments `audio.microphone`; if `Some`, pushes `SetPath` with the device name, otherwise pushes `ClearPath`. Returns the builder.

**Call relations**: One of several builder helpers for optional realtime/audio device settings.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_realtime_speaker`  (lines 921–931)

```
fn set_realtime_speaker(mut self, speaker: Option<&str>) -> Self
```

**Purpose**: Queues setting or clearing the configured speaker device under `[audio].speaker`.

**Data flow**: Constructs the `audio.speaker` path and pushes either a `SetPath` with the speaker name or a `ClearPath` when `None`, then returns the builder.

**Call relations**: Parallel to `set_realtime_microphone`; later executed by the generic path mutation logic.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_realtime_voice`  (lines 933–943)

```
fn set_realtime_voice(mut self, voice: Option<&str>) -> Self
```

**Purpose**: Queues setting or clearing the configured realtime voice under `[realtime].voice`.

**Data flow**: Builds path segments `realtime.voice`; pushes `SetPath` with the voice string when present or `ClearPath` when absent, then returns the builder.

**Call relations**: Another optional-setting helper that relies on generic path persistence downstream.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::clear_legacy_windows_sandbox_keys`  (lines 945–955)

```
fn clear_legacy_windows_sandbox_keys(mut self) -> Self
```

**Purpose**: Queues removal of obsolete feature keys related to older Windows sandbox experiments.

**Data flow**: Iterates over three hard-coded legacy keys under `[features]`, pushes one `ClearPath` edit per key into `self.edits`, and returns the builder.

**Call relations**: Used during migration/cleanup flows so stale legacy flags are removed in the same atomic write as newer settings.

*Call graph*: 1 external calls (vec!).


##### `ConfigEditsBuilder::set_session_picker_view`  (lines 957–963)

```
fn set_session_picker_view(mut self, mode: SessionPickerViewMode) -> Self
```

**Purpose**: Queues a write of the session picker view mode under `[tui].session_picker_view`.

**Data flow**: Converts the `SessionPickerViewMode` to string, wraps it as a TOML value, pushes a `SetPath` edit for `tui.session_picker_view`, and returns the builder.

**Call relations**: Builder equivalent of the standalone `session_picker_view_edit` helper.

*Call graph*: 3 external calls (to_string, value, vec!).


##### `ConfigEditsBuilder::with_edits`  (lines 965–971)

```
fn with_edits(mut self, edits: I) -> Self
```

**Purpose**: Extends the builder with an arbitrary iterator of preconstructed `ConfigEdit` values.

**Data flow**: Consumes any `IntoIterator<Item = ConfigEdit>`, appends all yielded edits to `self.edits`, and returns the builder.

**Call relations**: Lets callers mix specialized builder methods with standalone edit constructors such as theme, keymap, or status-line helpers.


##### `ConfigEditsBuilder::apply_blocking`  (lines 974–976)

```
fn apply_blocking(self) -> anyhow::Result<()>
```

**Purpose**: Synchronously persists the builder’s accumulated edits to its configured file path.

**Data flow**: Consumes the builder and passes `self.config_path` plus `self.edits` to `apply_blocking_to_resolved_file`, returning its result.

**Call relations**: Terminal step for synchronous builder usage; delegates all actual read/modify/write work to the shared persistence driver.

*Call graph*: calls 1 internal fn (apply_blocking_to_resolved_file).


##### `ConfigEditsBuilder::apply`  (lines 979–985)

```
async fn apply(self) -> anyhow::Result<()>
```

**Purpose**: Asynchronously persists the builder’s accumulated edits by offloading the blocking write to a worker thread.

**Data flow**: Consumes the builder, moves `config_path` and `edits` into `tokio::task::spawn_blocking`, invokes `apply_blocking_to_resolved_file` inside that closure, and returns the result with panic context attached.

**Call relations**: Async terminal step for builder usage; mirrors the top-level async `apply` function but uses the builder’s explicit target path and queued edits.

*Call graph*: 1 external calls (spawn_blocking).


### `core/src/config/edit/document_helpers.rs`

`util` · `config edit`

This file is a focused utility layer over `toml_edit` for code that rewrites configuration documents in place. Its first concern is safe table access: `ensure_table_for_write` and `ensure_table_for_read` normalize a `TomlItem` into a mutable `TomlTable`, promoting inline tables into regular tables and, for writes, creating implicit tables when the slot is empty or holds a non-table value. That behavior is important because callers such as document descent and MCP replacement logic can treat nested paths uniformly without manually checking TOML shape.

The second concern is serialization of `McpServerConfig` into TOML. `serialize_mcp_server_table` emits transport-specific fields for either `Stdio` or `StreamableHttp`, then conditionally writes only non-default or non-empty optional settings: booleans like `enabled`, `required`, and `supports_parallel_tool_calls`; durations as floating-point seconds; approval modes as string literals; arrays for enabled/disabled tools and scopes; OAuth client ID and resource; and a sorted nested `tools` table. Supporting helpers build arrays from strings or env-var variants and build deterministically ordered tables from key/value maps.

Finally, the file includes parsing/serialization helpers for `ToolSuggestDisabledTool`, representing each entry as an inline table with `type` and `id`. Several helpers deliberately sort keys or tool names before writing, producing stable output, and `merge_inline_table` preserves existing value decoration when replacing inline-table entries so edits do not unnecessarily disturb formatting.

#### Function details

##### `ensure_table_for_write`  (lines 15–33)

```
fn ensure_table_for_write(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Normalizes a mutable `TomlItem` into a writable `TomlTable`. It accepts existing tables, converts inline tables into regular tables, and creates a new implicit table when the item is empty or holds a plain value.

**Data flow**: It takes `&mut TomlItem` and pattern-matches on its current variant. If the item is already `TomlItem::Table`, it returns that table. If it is `TomlItem::Value`, it either converts an inline table via `table_from_inline` or replaces the value with `TomlItem::Table(new_implicit_table())`; if it is `TomlItem::None`, it also installs a new implicit table. For unsupported variants, it returns `None` and leaves the item unusable as a table.

**Call relations**: This is used by document traversal and mutation paths such as `descend`, `replace_mcp_servers`, and `set_skill_config` when they need to guarantee a writable table exists at some TOML path. It delegates table creation to `new_implicit_table` and inline-table expansion to `table_from_inline` so callers can proceed with insertion logic without repeating shape checks.

*Call graph*: calls 2 internal fn (new_implicit_table, table_from_inline); called by 3 (descend, replace_mcp_servers, set_skill_config); 2 external calls (Table, as_table_mut).


##### `ensure_table_for_read`  (lines 35–45)

```
fn ensure_table_for_read(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Normalizes a mutable `TomlItem` into a readable `TomlTable` without inventing missing structure. It only succeeds for an existing table or an inline table that can be promoted to a regular table.

**Data flow**: It receives `&mut TomlItem`. A `TomlItem::Table` is returned directly; a `TomlItem::Value` is accepted only if `as_inline_table()` succeeds, in which case the item is replaced with a regular table produced by `table_from_inline`. Any other variant returns `None`, and no implicit table is created.

**Call relations**: Called by `descend` when traversal wants to inspect nested table content but should not create absent nodes as a side effect. It relies on `table_from_inline` for the one allowed conversion path from inline representation to standard table form.

*Call graph*: calls 1 internal fn (table_from_inline); called by 1 (descend); 2 external calls (Table, as_table_mut).


##### `serialize_mcp_server_table`  (lines 47–163)

```
fn serialize_mcp_server_table(config: &McpServerConfig) -> TomlTable
```

**Purpose**: Builds a concrete `TomlTable` representation of an `McpServerConfig`, including transport-specific settings and optional server metadata. It emits only fields that are required or meaningfully non-default, producing compact and stable TOML.

**Data flow**: It reads an `&McpServerConfig` and starts a non-implicit `TomlTable`. For `McpServerTransportConfig::Stdio`, it writes `command`, optional `args`, optional `env`, optional `env_vars`, and optional `cwd`; for `StreamableHttp`, it writes `url`, optional `bearer_token_env_var`, optional `http_headers`, and optional `env_http_headers`. It then conditionally adds booleans, environment ID when `is_local_environment()` is false, startup/tool timeouts as `as_secs_f64()`, approval mode strings, arrays for enabled/disabled tools and scopes, an `oauth` table containing `client_id`, `oauth_resource`, and a sorted nested `tools` table whose values come from `serialize_mcp_server_tool`. The result is returned as a populated `TomlTable`.

**Call relations**: This is the core serializer used by both `serialize_mcp_server` and `serialize_mcp_server_inline`. It delegates repeated structure building to `array_from_iter`, `array_from_env_vars`, `table_from_pairs`, `new_implicit_table`, and `serialize_mcp_server_tool`, allowing higher-level replacement code to choose whether the final server entry should be a normal table or inline table.

*Call graph*: calls 6 internal fn (is_local_environment, array_from_env_vars, array_from_iter, new_implicit_table, serialize_mcp_server_tool, table_from_pairs); called by 2 (serialize_mcp_server, serialize_mcp_server_inline); 3 external calls (Table, new, value).


##### `serialize_mcp_server_tool`  (lines 165–176)

```
fn serialize_mcp_server_tool(config: &McpServerToolConfig) -> TomlItem
```

**Purpose**: Serializes one `McpServerToolConfig` into a TOML table containing only tool-level overrides. At present it writes the optional approval mode if present.

**Data flow**: It reads `&McpServerToolConfig`, creates a non-implicit `TomlTable`, and if `approval_mode` is set, maps the enum to one of the strings `auto`, `prompt`, or `approve`. It returns the table wrapped as `TomlItem::Table`.

**Call relations**: This helper is called from `serialize_mcp_server_table` while constructing the nested `tools` table for per-tool configuration. It isolates the enum-to-string mapping and table wrapping for each tool entry.

*Call graph*: called by 1 (serialize_mcp_server_table); 3 external calls (Table, new, value).


##### `serialize_mcp_server`  (lines 178–180)

```
fn serialize_mcp_server(config: &McpServerConfig) -> TomlItem
```

**Purpose**: Wraps full MCP server serialization as a standard TOML item. It is the table-form entry point used when callers want a `TomlItem` directly.

**Data flow**: It takes `&McpServerConfig`, calls `serialize_mcp_server_table`, and wraps the returned `TomlTable` in `TomlItem::Table`. It does not mutate external state.

**Call relations**: Called by `replace_mcp_servers` when that code needs to insert or replace a server entry as a regular TOML table. It is a thin adapter over `serialize_mcp_server_table`.

*Call graph*: calls 1 internal fn (serialize_mcp_server_table); called by 1 (replace_mcp_servers); 1 external calls (Table).


##### `serialize_mcp_server_inline`  (lines 182–184)

```
fn serialize_mcp_server_inline(config: &McpServerConfig) -> InlineTable
```

**Purpose**: Serializes an MCP server config into an `InlineTable` form. This gives callers an inline representation when they need to preserve or construct compact inline TOML.

**Data flow**: It reads `&McpServerConfig`, builds a normal table via `serialize_mcp_server_table`, then converts that table with `into_inline_table()`. The returned value is an `InlineTable` detached from document state.

**Call relations**: Used by `replace_mcp_servers` in code paths that update inline server definitions rather than block tables. It shares all field-selection logic with `serialize_mcp_server_table` and only changes the final representation.

*Call graph*: calls 1 internal fn (serialize_mcp_server_table); called by 1 (replace_mcp_servers).


##### `merge_inline_table`  (lines 186–198)

```
fn merge_inline_table(existing: &mut InlineTable, replacement: InlineTable)
```

**Purpose**: Updates an existing inline table in place to match a replacement inline table while preserving decoration on keys that remain. It removes stale keys, overwrites retained keys with replacement values, and inserts new keys.

**Data flow**: It takes `&mut InlineTable` plus a replacement `InlineTable`. First it calls `retain` so only keys present in the replacement survive. Then it iterates over replacement entries: if a key already exists, it clones the replacement value, copies the existing value's decor onto it, and overwrites the old value; otherwise it inserts the new key/value pair. The existing table is mutated in place and nothing is returned.

**Call relations**: This function is invoked by `replace_mcp_servers` when updating inline TOML entries without discarding formatting wholesale. It does not recurse; its role is a shallow merge that preserves per-value decoration for unchanged keys.

*Call graph*: called by 1 (replace_mcp_servers); 4 external calls (get_mut, insert, iter, retain).


##### `table_from_inline`  (lines 200–209)

```
fn table_from_inline(inline: &InlineTable) -> TomlTable
```

**Purpose**: Converts a `toml_edit::InlineTable` into an implicit regular `TomlTable`. It is used when callers need table-style mutation APIs on content that was originally inline.

**Data flow**: It accepts `&InlineTable`, creates a new implicit table via `new_implicit_table`, then clones each inline value and clears its suffix decoration before inserting it as `TomlItem::Value` under the same key. The resulting `TomlTable` is returned.

**Call relations**: This helper underpins both `ensure_table_for_read` and `ensure_table_for_write`, which promote inline tables before traversal or mutation. Its conversion step centralizes the formatting adjustment applied during promotion.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 2 (ensure_table_for_read, ensure_table_for_write); 2 external calls (iter, Value).


##### `new_implicit_table`  (lines 211–215)

```
fn new_implicit_table() -> TomlTable
```

**Purpose**: Constructs a fresh implicit TOML table. The implicit flag makes the table suitable for synthesized intermediate nodes rather than explicit user-written table headers.

**Data flow**: It creates `TomlTable::new()`, sets `implicit` to `true`, and returns the table. No external state is read or written.

**Call relations**: This is a shared constructor used by traversal and editing code such as `descend`, `replace_mcp_servers`, `set_skill_config`, `ensure_table_for_write`, `serialize_mcp_server_table`, and `table_from_inline`. It standardizes how newly created intermediate tables are marked.

*Call graph*: called by 6 (descend, replace_mcp_servers, set_skill_config, ensure_table_for_write, serialize_mcp_server_table, table_from_inline); 1 external calls (new).


##### `parse_tool_suggest_disabled_tool`  (lines 217–231)

```
fn parse_tool_suggest_disabled_tool(
    value: &TomlValue,
) -> Option<ToolSuggestDisabledTool>
```

**Purpose**: Parses a disabled-tool record from a TOML value expected to be an inline table. It recognizes only the supported `type` strings and requires an `id` string.

**Data flow**: It takes `&TomlValue`, calls `as_inline_table()`, reads `type` and `id`, maps `type` from `connector` or `plugin` into `ToolSuggestDiscoverableType`, and constructs `ToolSuggestDisabledTool { kind, id }`. If the value is not an inline table, the type is unknown, or `id` is missing/non-string, it returns `None`.

**Call relations**: This parser stands alone in this file as the inline-table counterpart to `parse_tool_suggest_disabled_tool_table`. It is intended for callers that encounter disabled-tool entries stored as TOML values rather than block tables.

*Call graph*: 1 external calls (as_inline_table).


##### `parse_tool_suggest_disabled_tool_table`  (lines 233–246)

```
fn parse_tool_suggest_disabled_tool_table(
    table: &TomlTable,
) -> Option<ToolSuggestDisabledTool>
```

**Purpose**: Parses a disabled-tool record from a regular TOML table. It extracts the same `type` and `id` fields as the inline parser but reads them through `TomlItem` accessors.

**Data flow**: It receives `&TomlTable`, looks up `type` and `id`, converts `type` from `connector` or `plugin` into `ToolSuggestDiscoverableType`, and returns a `ToolSuggestDisabledTool` with an owned `id` string. Missing fields or unsupported type values cause it to return `None`.

**Call relations**: This complements `parse_tool_suggest_disabled_tool` for callers that have already normalized content into a regular table. Together they let higher-level config editing code accept either TOML representation.

*Call graph*: 1 external calls (get).


##### `tool_suggest_disabled_tools_value`  (lines 248–266)

```
fn tool_suggest_disabled_tools_value(
    disabled_tools: &[ToolSuggestDisabledTool],
) -> TomlItem
```

**Purpose**: Serializes a slice of disabled-tool descriptors into a TOML array of inline tables. Each element contains a string `type` and `id` field.

**Data flow**: It takes `&[ToolSuggestDisabledTool]`, creates a `TomlArray`, and for each entry builds an `InlineTable` with `type` mapped from the enum (`connector` or `plugin`) and `id` copied from the struct. It pushes each inline table into the array and returns the array wrapped as `TomlItem::Value`.

**Call relations**: Called by `add_tool_suggest_disabled_tool` when writing the disabled-tools list back into the document. It is the serialization counterpart to the two parsing helpers in this file.

*Call graph*: called by 1 (add_tool_suggest_disabled_tool); 3 external calls (new, new, Value).


##### `array_from_iter`  (lines 268–277)

```
fn array_from_iter(iter: I) -> TomlItem
```

**Purpose**: Builds a TOML array value from an iterator of owned strings. It is a generic helper for string-list fields.

**Data flow**: It consumes any `Iterator<Item = String>`, pushes each string into a new `TomlArray`, and returns the array wrapped in `TomlItem::Value`. The iterator is exhausted and no external state is touched.

**Call relations**: Used by `serialize_mcp_server_table` for fields such as `args`, `enabled_tools`, `disabled_tools`, and `scopes`. It keeps repeated array-construction code out of the main serializer.

*Call graph*: called by 1 (serialize_mcp_server_table); 2 external calls (new, Value).


##### `array_from_env_vars`  (lines 279–295)

```
fn array_from_env_vars(env_vars: &[McpServerEnvVar]) -> TomlItem
```

**Purpose**: Serializes MCP server environment-variable declarations into a TOML array that can contain either plain strings or inline tables. This matches the two variants of `McpServerEnvVar`.

**Data flow**: It reads `&[McpServerEnvVar]`, creates a `TomlArray`, and for each element either pushes the variable name directly for `Name(name)` or builds an `InlineTable` with `name` and optional `source` for `Config { name, source }`. It returns the finished array as `TomlItem::Value`.

**Call relations**: This helper is called from `serialize_mcp_server_table` when serializing the `env_vars` field of stdio-based MCP servers. It encapsulates the mixed scalar/object array encoding required by that config shape.

*Call graph*: called by 1 (serialize_mcp_server_table); 3 external calls (new, new, Value).


##### `table_from_pairs`  (lines 297–309)

```
fn table_from_pairs(pairs: I) -> TomlItem
```

**Purpose**: Builds a deterministic TOML table from string key/value pairs. It sorts entries by key before insertion so serialized output is stable.

**Data flow**: It accepts any `IntoIterator<Item = (&String, &String)>`, collects the pairs into a vector, sorts by key, creates a non-implicit `TomlTable`, and inserts each key with a cloned string value via `toml_edit::value`. It returns the result wrapped as `TomlItem::Table`.

**Call relations**: Used by `serialize_mcp_server_table` for map-like fields such as `env`, `http_headers`, and `env_http_headers`. Its sorting behavior ensures those maps are emitted in a predictable order regardless of source map iteration order.

*Call graph*: called by 1 (serialize_mcp_server_table); 4 external calls (into_iter, Table, new, value).


### Config migrations and imports
These files bring configuration state into Codex-managed storage by importing from external installations and applying one-time user config migrations.

### `app-server/src/config/external_agent_config.rs`

`domain_logic` · `config load`

This file defines the migration data model and the `ExternalAgentConfigService` that discovers and imports external-agent artifacts. Detection works across the external-agent home directory and optional repository roots. `detect` resolves repo roots from supplied cwd values, then `detect_migrations` inspects settings files, `.mcp.json`, hooks, skills, commands, subagents, `CLAUDE.md`, plugin settings, and recent session files. Each detected migration becomes an `ExternalAgentConfigMigrationItem` with a concrete `item_type`, human-readable description, optional cwd, and optional `MigrationDetails` listing named MCP servers, hooks, commands, subagents, sessions, or grouped plugins.

Import is item-oriented. `ExternalAgentConfigService::import` iterates requested migration items, creates an `ExternalAgentConfigImportItemResult`, and dispatches to specialized import helpers. Most item types either copy files/directories or merge generated TOML into existing config. Plugin imports are special: `partition_plugin_migration_details` separates local marketplace sources, which can be imported immediately via `import_plugins`, from remote sources, which are returned as `pending_plugin_imports` for later asynchronous completion. Errors for plugin items are recorded into the item result instead of aborting the whole import batch; non-plugin failures abort immediately.

The helper layer is substantial. It merges `settings.json` with `settings.local.json`, rewrites external-agent terminology to Codex branding in copied markdown, resolves relative marketplace paths against the correct source root, intersects plugin detection against already configured or installable plugins, merges only missing TOML keys and MCP server entries, and emits OpenTelemetry counters tagged by migration type. Several invariants are easy to miss: repo-scoped imports return no-op when given a non-empty cwd outside a repo root; invalid local settings are ignored during effective-settings merge; existing non-empty `AGENTS.md` and existing skill directories are preserved; and migrated config only fills missing values rather than overwriting user choices.

#### Function details

##### `ExternalAgentConfigImportItemResult::new`  (lines 116–130)

```
fn new(
        item_type: ExternalAgentConfigMigrationItemType,
        description: String,
        cwd: Option<PathBuf>,
    ) -> Self
```

**Purpose**: Creates an empty per-item import result record with zero counts and no successes or raw errors. It preserves the migration item’s type, description, and cwd for later reporting.

**Data flow**: Takes an `ExternalAgentConfigMigrationItemType`, description string, and optional cwd → initializes counts to zero and vectors empty → returns `ExternalAgentConfigImportItemResult`.

**Call relations**: Used at the start of each iteration in `ExternalAgentConfigService::import`.

*Call graph*: called by 1 (import); 1 external calls (new).


##### `ExternalAgentConfigImportItemResult::record_error`  (lines 132–135)

```
fn record_error(&mut self, raw_error: ExternalAgentConfigImportRawError)
```

**Purpose**: Adds one raw error to an item result and increments the error counter with saturation. It is the low-level mutation used by higher-level error-recording helpers.

**Data flow**: Takes `&mut self` and an `ExternalAgentConfigImportRawError` → increments `error_count` with `saturating_add(1)` → pushes the raw error into `raw_errors`.

**Call relations**: Called by `record_import_error`, which packages contextual error details before recording.

*Call graph*: called by 1 (record_import_error).


##### `ExternalAgentConfigImportItemResult::record_success`  (lines 137–145)

```
fn record_success(&mut self, source: Option<String>, target: Option<String>)
```

**Purpose**: Adds one success record to an item result and increments the success counter. The success record inherits the item type and cwd from the result itself.

**Data flow**: Takes `&mut self`, optional source string, and optional target string → increments `success_count` with `saturating_add(1)` → pushes `ExternalAgentConfigImportSuccess { item_type: self.item_type, cwd: self.cwd.clone(), source, target }`.

**Call relations**: Used throughout import flows whenever a concrete artifact or plugin is successfully migrated.

*Call graph*: called by 1 (import_sessions).


##### `ExternalAgentConfigService::new`  (lines 181–187)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Constructs the migration service for a given Codex home and infers the external-agent home directory from environment variables. It is the production constructor.

**Data flow**: Takes `codex_home: PathBuf` → computes `external_agent_home` via `default_external_agent_home()` → returns `ExternalAgentConfigService { codex_home, external_agent_home }`.

**Call relations**: Used by higher-level app-server configuration code to create the migration service.

*Call graph*: calls 1 internal fn (default_external_agent_home); called by 1 (new).


##### `ExternalAgentConfigService::new_for_test`  (lines 190–195)

```
fn new_for_test(codex_home: PathBuf, external_agent_home: PathBuf) -> Self
```

**Purpose**: Constructs the migration service with explicit Codex and external-agent home paths for deterministic tests. It bypasses environment-based home discovery.

**Data flow**: Takes explicit `codex_home` and `external_agent_home` paths → returns `ExternalAgentConfigService` with those fields.

**Call relations**: Used only by test helpers such as `service_for_paths`.

*Call graph*: called by 1 (service_for_paths).


##### `ExternalAgentConfigService::detect`  (lines 197–215)

```
async fn detect(
        &self,
        params: ExternalAgentConfigDetectOptions,
    ) -> io::Result<Vec<ExternalAgentConfigMigrationItem>>
```

**Purpose**: Discovers all applicable migration items for the external-agent home and/or a set of cwd-derived repositories. It is the public detection entrypoint.

**Data flow**: Takes `ExternalAgentConfigDetectOptions { include_home, cwds }` → initializes an output vector, optionally calls `detect_migrations(None, ...)` for home scope, resolves each cwd to a repo root with `find_repo_root`, skips unresolved roots, and calls `detect_migrations(Some(&repo_root), ...)` for each → returns the collected migration items.

**Call relations**: Called by external-agent migration APIs. It delegates all actual inspection logic to `detect_migrations`.

*Call graph*: calls 2 internal fn (detect_migrations, find_repo_root); called by 1 (detect); 1 external calls (new).


##### `ExternalAgentConfigService::external_agent_session_source_path`  (lines 217–235)

```
fn external_agent_session_source_path(
        &self,
        path: &Path,
    ) -> io::Result<Option<PathBuf>>
```

**Purpose**: Validates whether a given path is a canonicalized external-agent session JSONL file under the external-agent `projects` directory. It filters out non-session paths and missing files.

**Data flow**: Takes `&Path` → rejects non-`.jsonl` extensions, canonicalizes the candidate path and the external-agent `projects` root, treating missing paths as `Ok(None)`, and returns `Some(canonical_path)` only if the file path starts with the canonical projects root.

**Call relations**: Used by session-import validation code outside this file to ensure pending session imports still point at legitimate source files.

*Call graph*: called by 1 (validate_pending_session_imports); 4 external calls (extension, starts_with, join, canonicalize).


##### `ExternalAgentConfigService::import`  (lines 237–427)

```
async fn import(
        &self,
        migration_items: Vec<ExternalAgentConfigMigrationItem>,
    ) -> io::Result<ExternalAgentConfigImportOutcome>
```

**Purpose**: Executes a batch of requested migration items, collecting per-item success/error reporting and deferring remote plugin imports when necessary. It is the public import entrypoint.

**Data flow**: Takes a vector of `ExternalAgentConfigMigrationItem` → initializes `ExternalAgentConfigImportOutcome` → for each item creates an `ExternalAgentConfigImportItemResult`, dispatches by `item_type` to the corresponding import helper, records successes into the item result, records plugin errors without aborting the batch, pushes remote plugin groups into `pending_plugin_imports`, emits migration metrics, and finally returns the accumulated outcome.

**Call relations**: Called by external-agent import APIs. It delegates concrete work to `import_config`, `import_skills`, `import_agents_md`, `partition_plugin_migration_details`, `import_plugins`, `import_mcp_server_config`, `import_subagents`, `import_hooks`, and `import_commands`.

*Call graph*: calls 6 internal fn (new, import_plugins, partition_plugin_migration_details, emit_migration_metric, invalid_data_error, record_import_error); called by 1 (import_external_agent_config); 1 external calls (default).


##### `ExternalAgentConfigService::detect_migrations`  (lines 429–739)

```
async fn detect_migrations(
        &self,
        repo_root: Option<&Path>,
        items: &mut Vec<ExternalAgentConfigMigrationItem>,
    ) -> io::Result<()>
```

**Purpose**: Inspects one scope—either home or a specific repository root—for all supported migration opportunities and appends corresponding migration items. It is the core discovery routine.

**Data flow**: Takes optional `repo_root` and mutable output vector → computes source/target paths for settings, config, hooks, skills, commands, subagents, agents markdown, plugins, and sessions; loads effective settings; builds migrated TOML for config and MCP servers; compares against existing targets using merge helpers; counts missing directories and names; detects hook events, commands, subagents, and sessions; loads current Codex config to filter plugin migrations against configured/installable plugins; appends `ExternalAgentConfigMigrationItem`s with optional `MigrationDetails`; emits per-item detection metrics.

**Call relations**: Called only by `detect`. It delegates many subproblems to helpers such as `effective_external_settings`, `build_config_from_external`, `build_mcp_config_from_external`, `merge_missing_toml_values`, `merge_missing_mcp_servers`, `count_missing_subdirectories`, `missing_command_names`, `missing_subagent_names`, `find_repo_agents_md_source`, `configured_marketplace_plugins`, and `detect_plugin_migration`.

*Call graph*: calls 17 internal fn (detect_plugin_migration, mcp_settings, source_root, build_config_from_external, configured_marketplace_plugins, count_missing_subdirectories, effective_external_settings, emit_migration_metric, find_repo_agents_md_source, is_empty_toml_table (+7 more)); called by 1 (detect); 16 external calls (default, as_path, clone, join, Table, build_mcp_config_from_external, count_missing_commands, count_missing_subagents, hook_migration_event_names, missing_command_names (+6 more)).


##### `ExternalAgentConfigService::home_target_skills_dir`  (lines 741–746)

```
fn home_target_skills_dir(&self) -> PathBuf
```

**Purpose**: Computes the default Codex home-level skills target directory, which lives in a sibling `.agents/skills` directory next to `.codex` when possible. It encapsulates that path convention.

**Data flow**: Reads `self.codex_home.parent()` → if present returns `<parent>/.agents/skills`, otherwise returns relative `.agents/skills`.

**Call relations**: Used by home-scope skills and command imports/detection.

*Call graph*: called by 2 (import_commands, import_skills); 1 external calls (parent).


##### `ExternalAgentConfigService::mcp_settings`  (lines 748–769)

```
fn mcp_settings(
        &self,
        repo_root: Option<&Path>,
        source_settings: Option<JsonValue>,
    ) -> io::Result<Option<JsonValue>>
```

**Purpose**: Determines which settings JSON should influence MCP migration for a scope, falling back from missing repo settings to home settings and ignoring invalid home settings with a warning. This preserves MCP toggles even when repo settings are absent.

**Data flow**: Takes optional `repo_root` and optional source settings JSON → if repo scope and source settings are absent, tries `effective_external_settings` on home `settings.json`, returning `Ok(None)` on invalid-data errors after logging a warning; otherwise returns the provided source settings unchanged.

**Call relations**: Used by both detection and import of MCP server config.

*Call graph*: calls 1 internal fn (effective_external_settings); called by 2 (detect_migrations, import_mcp_server_config); 2 external calls (join, warn!).


##### `ExternalAgentConfigService::source_root`  (lines 771–781)

```
fn source_root(&self, repo_root: Option<&Path>) -> PathBuf
```

**Purpose**: Computes the filesystem root against which relative external-agent marketplace paths should be resolved. Home scope uses the parent of the external-agent home; repo scope uses the repo root itself.

**Data flow**: Takes optional `repo_root` → returns `repo_root.to_path_buf()` when present, otherwise `self.external_agent_home.parent()` or `.` if no parent exists.

**Call relations**: Used by MCP migration and plugin marketplace source resolution.

*Call graph*: called by 2 (detect_migrations, import_mcp_server_config).


##### `ExternalAgentConfigService::detect_plugin_migration`  (lines 783–810)

```
fn detect_plugin_migration(
        &self,
        source_settings: &Path,
        source_root: &Path,
        cwd: Option<PathBuf>,
        settings: &JsonValue,
        configured_plugin_ids: &HashS
```

**Purpose**: Builds a plugin migration item from settings if there are enabled plugins that are both migratable and not already configured in Codex. It wraps the extracted details in a user-facing migration description.

**Data flow**: Takes source settings path, source root, optional cwd, settings JSON, configured plugin IDs, and configured marketplace plugin availability → calls `extract_plugin_migration_details`; if it returns details, emits a detection metric and returns `Some(ExternalAgentConfigMigrationItem { item_type: Plugins, description, cwd, details: Some(...) })`, otherwise returns `None`.

**Call relations**: Called from `detect_migrations` after current Codex plugin state has been loaded.

*Call graph*: calls 2 internal fn (emit_migration_metric, extract_plugin_migration_details); called by 1 (detect_migrations); 1 external calls (format!).


##### `ExternalAgentConfigService::partition_plugin_migration_details`  (lines 812–857)

```
fn partition_plugin_migration_details(
        &self,
        cwd: Option<&Path>,
        details: MigrationDetails,
    ) -> io::Result<(Option<MigrationDetails>, Option<MigrationDetails>)>
```

**Purpose**: Splits plugin migration details into local-marketplace imports that can run immediately and remote-marketplace imports that should be deferred. The classification is based on marketplace source metadata from effective settings.

**Data flow**: Takes optional cwd and `MigrationDetails` → reloads effective settings for the relevant scope, collects marketplace import sources, classifies each `PluginsMigration` as local or remote using `is_local_marketplace_source`, and returns `(Option<MigrationDetails> local, Option<MigrationDetails> remote)` containing only the corresponding plugin groups.

**Call relations**: Used by `import` before plugin import execution so local plugins can be installed synchronously while remote ones become `pending_plugin_imports`.

*Call graph*: calls 1 internal fn (effective_external_settings); called by 1 (import); 3 external calls (default, as_path, new).


##### `ExternalAgentConfigService::import_plugins`  (lines 859–972)

```
async fn import_plugins(
        &self,
        cwd: Option<&Path>,
        details: Option<MigrationDetails>,
    ) -> io::Result<PluginImportOutcome>
```

**Purpose**: Imports one or more plugin groups by adding their source marketplaces and installing each named plugin into Codex. It records marketplace-level and plugin-level successes and failures without aborting the whole batch.

**Data flow**: Takes optional cwd and optional `MigrationDetails` → errors if details are missing or contain no plugin groups → for each `PluginsMigration`, computes plugin IDs, reloads effective settings, finds the marketplace import source, calls `add_marketplace`, locates the installed marketplace manifest with `find_marketplace_manifest_path`, records marketplace success/failure, then calls `PluginsManager::install_plugin` for each plugin name and records succeeded/failed plugin IDs plus raw errors → returns `PluginImportOutcome`.

**Call relations**: Called directly from `import` for local plugin groups and from later pending-plugin completion flows elsewhere in the system.

*Call graph*: calls 7 internal fn (effective_external_settings, invalid_data_error, plugin_import_raw_error, record_plugin_import_errors, new, find_marketplace_manifest_path, add_marketplace); called by 2 (import, complete_pending_plugin_import); 5 external calls (as_path, clone, new, default, format!).


##### `ExternalAgentConfigService::import_config`  (lines 974–1027)

```
fn import_config(&self, cwd: Option<&Path>) -> io::Result<Option<(String, String)>>
```

**Purpose**: Migrates supported settings fields from external-agent settings into Codex `config.toml`, creating the file if needed or merging only missing values into an existing file. It never overwrites existing user config keys.

**Data flow**: Takes optional cwd → resolves repo root and source/target paths, returning `Ok(None)` for non-repo non-empty cwd values → loads effective settings, converts them with `build_config_from_external`, skips empty migrations, creates parent directories, writes a new TOML file if absent, otherwise parses existing TOML, merges missing values with `merge_missing_toml_values`, writes back only if changed, and returns optional `(source_path, target_path)` strings when a write occurred.

**Call relations**: Called from `import` for `Config` items and mirrors the detection logic in `detect_migrations`.

*Call graph*: calls 7 internal fn (build_config_from_external, effective_external_settings, find_repo_root, invalid_data_error, is_empty_toml_table, merge_missing_toml_values, write_toml_file); 5 external calls (default, join, Table, create_dir_all, read_to_string).


##### `ExternalAgentConfigService::import_mcp_server_config`  (lines 1029–1079)

```
fn import_mcp_server_config(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Migrates MCP server definitions into Codex `config.toml`, preserving existing same-named servers and returning the names actually added. It supports repo settings, home fallback settings, and MCP-specific toggles.

**Data flow**: Takes optional cwd → resolves repo root and source/target config paths, returning an empty vector for non-repo non-empty cwd values → loads MCP-relevant settings via `mcp_settings`, builds migrated MCP TOML with `build_mcp_config_from_external`, skips empty migrations, creates parent directories, writes a new config file if absent, otherwise parses existing TOML, merges only missing server entries with `merge_missing_mcp_servers`, writes back if any were added, and returns the added server names.

**Call relations**: Called from `import` for `McpServerConfig` items and parallels MCP detection in `detect_migrations`.

*Call graph*: calls 9 internal fn (mcp_settings, source_root, effective_external_settings, find_repo_root, invalid_data_error, is_empty_toml_table, merge_missing_mcp_servers, migrated_mcp_server_names, write_toml_file); 8 external calls (default, as_path, join, Table, new, build_mcp_config_from_external, create_dir_all, read_to_string).


##### `ExternalAgentConfigService::import_subagents`  (lines 1081–1097)

```
fn import_subagents(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Imports external-agent subagent definitions into Codex agent files for either repo or home scope. It is a thin path-selection wrapper around the migration library.

**Data flow**: Takes optional cwd → resolves source and target agent directories based on repo root or home scope, returning an empty vector for non-repo non-empty cwd values → calls external `import_subagents(&source_agents, &target_agents)` and returns the imported names.

**Call relations**: Called from `import` for `Subagents` items.

*Call graph*: calls 1 internal fn (find_repo_root); 3 external calls (join, new, import_subagents).


##### `ExternalAgentConfigService::import_hooks`  (lines 1099–1121)

```
fn import_hooks(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Imports supported external-agent hooks into Codex `hooks.json` and returns the migrated hook event names when a write occurs. Unsupported or absent hooks yield an empty result.

**Data flow**: Takes optional cwd → resolves source external-agent directory and target hooks path based on repo or home scope, returning an empty vector for non-repo non-empty cwd values → computes hook names with `hook_migration_event_names`, calls external `import_hooks`, and returns the names only if the import function reported a write.

**Call relations**: Called from `import` for `Hooks` items.

*Call graph*: calls 1 internal fn (find_repo_root); 5 external calls (clone, join, new, hook_migration_event_names, import_hooks).


##### `ExternalAgentConfigService::import_commands`  (lines 1123–1139)

```
fn import_commands(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Imports external-agent command markdown into Codex skill directories. It is a path-selection wrapper around the migration library’s command importer.

**Data flow**: Takes optional cwd → resolves source commands directory and target `.agents/skills` directory based on repo or home scope, returning an empty vector for non-repo non-empty cwd values → calls external `import_commands` and returns imported command names.

**Call relations**: Called from `import` for `Commands` items.

*Call graph*: calls 2 internal fn (home_target_skills_dir, find_repo_root); 3 external calls (join, new, import_commands).


##### `ExternalAgentConfigService::import_skills`  (lines 1141–1179)

```
fn import_skills(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Copies missing external-agent skill directories into Codex’s skills directory, rewriting `SKILL.md` contents as needed. Existing target skill directories are preserved.

**Data flow**: Takes optional cwd → resolves source and target skills directories based on repo or home scope, returning an empty vector for non-repo non-empty cwd values → if source is not a directory returns empty → creates target directory, iterates source subdirectories, skips non-directories and already-existing targets, recursively copies each missing directory with `copy_dir_recursive`, and returns the copied directory names.

**Call relations**: Called from `import` for `Skills` items and tested directly for selective copying behavior.

*Call graph*: calls 3 internal fn (home_target_skills_dir, copy_dir_recursive, find_repo_root); 4 external calls (join, new, create_dir_all, read_dir).


##### `ExternalAgentConfigService::import_agents_md`  (lines 1181–1211)

```
fn import_agents_md(&self, cwd: Option<&Path>) -> io::Result<Option<(String, String)>>
```

**Purpose**: Copies external-agent `CLAUDE.md` guidance into `AGENTS.md`, rewriting branding terms and only overwriting missing or empty targets. It supports both repo and home source selection.

**Data flow**: Takes optional cwd → resolves source and target markdown paths, using `find_repo_agents_md_source` for repos and returning `Ok(None)` for non-repo non-empty cwd values → requires a non-empty source and missing-or-empty target, creates the target parent directory, copies with `rewrite_and_copy_text_file`, and returns optional `(source_path, target_path)` strings when copied.

**Call relations**: Called from `import` for `AgentsMd` items and mirrors the detection logic in `detect_migrations`.

*Call graph*: calls 6 internal fn (find_repo_agents_md_source, find_repo_root, invalid_data_error, is_missing_or_empty_text_file, is_non_empty_text_file, rewrite_and_copy_text_file); 2 external calls (join, create_dir_all).


##### `default_external_agent_home`  (lines 1214–1220)

```
fn default_external_agent_home() -> PathBuf
```

**Purpose**: Infers the default external-agent home directory from `HOME` or `USERPROFILE`, falling back to a relative `.claude` path. It encapsulates platform-neutral home discovery.

**Data flow**: Reads `HOME` then `USERPROFILE` from the environment → if found returns `<home>/.claude`, otherwise returns `.claude`.

**Call relations**: Used only by `ExternalAgentConfigService::new`.

*Call graph*: called by 1 (new); 2 external calls (from, var_os).


##### `read_external_settings`  (lines 1222–1231)

```
fn read_external_settings(path: &Path) -> io::Result<Option<JsonValue>>
```

**Purpose**: Reads and parses one external-agent settings JSON file if it exists. Missing files are treated as absent settings rather than errors.

**Data flow**: Takes a path → returns `Ok(None)` if it is not a file → otherwise reads the file to string, parses JSON into `serde_json::Value`, maps parse failures to `io::ErrorKind::InvalidData`, and returns `Ok(Some(settings))`.

**Call relations**: Used by `effective_external_settings` for both base and local settings files.

*Call graph*: called by 1 (effective_external_settings); 3 external calls (is_file, read_to_string, from_str).


##### `effective_external_settings`  (lines 1233–1251)

```
fn effective_external_settings(project_settings: &Path) -> io::Result<Option<JsonValue>>
```

**Purpose**: Computes the effective external-agent settings by overlaying `settings.local.json` onto `settings.json`. Invalid local settings are ignored rather than failing the whole load.

**Data flow**: Takes the project settings path → reads base settings with `read_external_settings`, derives sibling `settings.local.json`, reads local settings, returns base settings unchanged on missing local file or invalid local JSON, otherwise merges local into base with `merge_json_settings` or uses local alone if base is absent → returns the effective optional JSON value.

**Call relations**: Used widely by detection and import paths whenever settings need to reflect local overrides.

*Call graph*: calls 2 internal fn (merge_json_settings, read_external_settings); called by 6 (detect_migrations, import_config, import_mcp_server_config, import_plugins, mcp_settings, partition_plugin_migration_details); 1 external calls (parent).


##### `merge_json_settings`  (lines 1253–1269)

```
fn merge_json_settings(existing: &mut JsonValue, incoming: &JsonValue)
```

**Purpose**: Recursively overlays one JSON value onto another, merging objects by key and replacing non-object values wholesale. It implements the semantics for local settings overriding base settings.

**Data flow**: Takes mutable existing `JsonValue` and incoming `JsonValue` → if both are objects, recursively merges matching keys and inserts missing keys; otherwise replaces `existing` with a clone of `incoming`.

**Call relations**: Used only by `effective_external_settings`.

*Call graph*: called by 1 (effective_external_settings); 3 external calls (clone, get_mut, insert).


##### `extract_plugin_migration_details`  (lines 1270–1328)

```
fn extract_plugin_migration_details(
    settings: &JsonValue,
    source_root: &Path,
    configured_plugin_ids: &HashSet<String>,
    configured_marketplace_plugins: &BTreeMap<String, HashSet<String
```

**Purpose**: Determines which enabled external-agent plugins should be offered for migration, grouped by marketplace. It filters out already configured plugins and plugins that are neither installable from configured marketplaces nor loadable from local marketplace sources.

**Data flow**: Takes settings JSON, source root, configured plugin IDs, and configured marketplace plugin availability → collects loadable marketplace names from `collect_marketplace_import_sources`, iterates enabled plugin IDs from `collect_enabled_plugins`, parses each with `PluginId::parse`, skips configured IDs, filters against configured marketplace plugin availability or loadable local marketplaces, groups remaining plugin names by marketplace in a `BTreeMap`, sorts names within each group, and returns `Some(MigrationDetails { plugins, .. })` or `None` if no groups remain.

**Call relations**: Used by `detect_plugin_migration` during plugin detection.

*Call graph*: calls 3 internal fn (collect_enabled_plugins, collect_marketplace_import_sources, parse); called by 1 (detect_plugin_migration); 2 external calls (new, default).


##### `collect_enabled_plugins`  (lines 1330–1350)

```
fn collect_enabled_plugins(settings: &JsonValue) -> Vec<String>
```

**Purpose**: Extracts the set of enabled plugin IDs from external-agent settings, normalizing them through `PluginId::parse`. Disabled or invalid entries are ignored.

**Data flow**: Reads `settings["enabledPlugins"]` as an object → filters entries whose value is truthy boolean → parses each key as `PluginId` and returns normalized `plugin_id.as_key()` strings in a vector.

**Call relations**: Used by plugin detection helpers and marketplace inference.

*Call graph*: called by 2 (extract_plugin_migration_details, has_enabled_plugin_for_marketplace); 2 external calls (as_object, new).


##### `has_enabled_plugin_for_marketplace`  (lines 1352–1360)

```
fn has_enabled_plugin_for_marketplace(settings: &JsonValue, marketplace_name: &str) -> bool
```

**Purpose**: Checks whether any enabled plugin in settings belongs to a given marketplace name. It is used to infer the official marketplace source when settings omit it.

**Data flow**: Calls `collect_enabled_plugins(settings)`, parses each normalized plugin ID, and returns `true` if any parsed marketplace name matches the requested one.

**Call relations**: Used by `collect_marketplace_import_sources`.

*Call graph*: calls 1 internal fn (collect_enabled_plugins); called by 1 (collect_marketplace_import_sources).


##### `configured_marketplace_plugins`  (lines 1362–1392)

```
fn configured_marketplace_plugins(
    config: &Config,
    plugins_manager: &PluginsManager,
) -> io::Result<BTreeMap<String, HashSet<String>>>
```

**Purpose**: Builds a map of currently configured Codex marketplaces to the set of plugin names that are installable and allowed for the Codex product. This lets detection suppress plugins that cannot actually be migrated.

**Data flow**: Takes a loaded `Config` and `PluginsManager` → gets plugin config input, lists marketplaces with `include_openai_curated: true`, maps listing errors to invalid-data I/O errors, filters each marketplace’s plugins to those whose installation policy is not `NotAvailable` and whose product restrictions allow Codex, and returns a `BTreeMap<String, HashSet<String>>` of marketplace name to plugin names.

**Call relations**: Used by `detect_migrations` before calling `detect_plugin_migration`.

*Call graph*: calls 1 internal fn (list_marketplaces_for_config); called by 1 (detect_migrations); 2 external calls (new, plugins_config_input).


##### `collect_marketplace_import_sources`  (lines 1394–1453)

```
fn collect_marketplace_import_sources(
    settings: &JsonValue,
    source_root: &Path,
) -> BTreeMap<String, MarketplaceImportSource>
```

**Purpose**: Extracts marketplace source definitions from external-agent settings and resolves relative local paths against the correct source root. It also infers the official external marketplace when an enabled plugin references it but settings omit an explicit source.

**Data flow**: Reads `settings["extraKnownMarketplaces"]` as an object, for each marketplace extracts source fields from either nested `source` object or the value object itself, chooses repo/url/path/source string, trims and resolves relative local paths with `resolve_external_marketplace_source`, extracts optional `ref`, and collects `MarketplaceImportSource` values into a `BTreeMap`; if the official marketplace has enabled plugins but no explicit source, inserts the hard-coded official source entry.

**Call relations**: Used by plugin detection and plugin import partitioning.

*Call graph*: calls 1 internal fn (has_enabled_plugin_for_marketplace); called by 1 (extract_plugin_migration_details); 1 external calls (as_object).


##### `resolve_external_marketplace_source`  (lines 1461–1467)

```
fn resolve_external_marketplace_source(source: &str, source_root: &Path) -> String
```

**Purpose**: Resolves a marketplace source string against a source root only when it looks like a relative local path. Non-relative sources are returned unchanged.

**Data flow**: Takes a source string and source root path → if `looks_like_relative_local_path(source)` is false, returns `source.to_string()`; otherwise joins it to `source_root` and returns the display string.

**Call relations**: Used by `collect_marketplace_import_sources`.

*Call graph*: calls 1 internal fn (looks_like_relative_local_path); 1 external calls (join).


##### `looks_like_relative_local_path`  (lines 1469–1471)

```
fn looks_like_relative_local_path(source: &str) -> bool
```

**Purpose**: Recognizes the small set of relative path spellings that should be resolved against a source root. It intentionally does not attempt full path parsing.

**Data flow**: Checks whether the input string starts with `./` or `../` or equals `.` or `..` → returns boolean.

**Call relations**: Used only by `resolve_external_marketplace_source`.

*Call graph*: called by 1 (resolve_external_marketplace_source).


##### `find_repo_root`  (lines 1473–1507)

```
fn find_repo_root(cwd: Option<&Path>) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds the nearest repository root for a cwd or file path by walking upward until a `.git` file or directory is found. If no `.git` is found, it falls back to the existing starting directory.

**Data flow**: Takes optional cwd → returns `Ok(None)` for absent or empty cwd → resolves relative paths against `current_dir`, returns `Ok(None)` if the path does not exist, converts file paths to their parent directory, then walks upward checking for `.git`; returns the first matching directory or the original existing directory as fallback.

**Call relations**: Used by detection and import methods to decide whether a cwd should be treated as repo-scoped.

*Call graph*: called by 8 (detect, import_agents_md, import_commands, import_config, import_hooks, import_mcp_server_config, import_skills, import_subagents); 1 external calls (current_dir).


##### `collect_subdirectory_names`  (lines 1509–1523)

```
fn collect_subdirectory_names(path: &Path) -> io::Result<HashSet<OsString>>
```

**Purpose**: Collects the names of immediate child directories under a path. Non-directory paths yield an empty set.

**Data flow**: Takes a path → if not a directory returns empty `HashSet<OsString>` → otherwise iterates `fs::read_dir`, keeps entries whose file type is directory, and inserts their file names into the set.

**Call relations**: Used by `count_missing_subdirectories`.

*Call graph*: called by 1 (count_missing_subdirectories); 3 external calls (new, is_dir, read_dir).


##### `count_missing_subdirectories`  (lines 1525–1532)

```
fn count_missing_subdirectories(source: &Path, target: &Path) -> io::Result<usize>
```

**Purpose**: Counts how many source subdirectories do not yet exist in the target directory. It is used for skills detection.

**Data flow**: Reads source and target subdirectory-name sets via `collect_subdirectory_names` → counts source names absent from target → returns the count.

**Call relations**: Used by `detect_migrations` for `Skills` detection.

*Call graph*: calls 1 internal fn (collect_subdirectory_names); called by 1 (detect_migrations).


##### `is_missing_or_empty_text_file`  (lines 1534–1543)

```
fn is_missing_or_empty_text_file(path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether a path is absent or is a text file whose trimmed contents are empty. Non-file existing paths are treated as not empty.

**Data flow**: Takes a path → returns `true` if it does not exist, `false` if it exists but is not a file, otherwise reads the file to string, trims it, and returns whether it is empty.

**Call relations**: Used to decide whether `AGENTS.md` or `hooks.json` targets are safe to populate.

*Call graph*: called by 2 (detect_migrations, import_agents_md); 3 external calls (exists, is_file, read_to_string).


##### `is_non_empty_text_file`  (lines 1545–1551)

```
fn is_non_empty_text_file(path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether a path is a file with non-whitespace text content. Missing or non-file paths return false.

**Data flow**: Takes a path → returns `false` unless it is a file → reads to string, trims, and returns whether the result is non-empty.

**Call relations**: Used when selecting source markdown files and detecting home/repo guidance.

*Call graph*: called by 3 (detect_migrations, import_agents_md, find_repo_agents_md_source); 2 external calls (is_file, read_to_string).


##### `find_repo_agents_md_source`  (lines 1553–1566)

```
fn find_repo_agents_md_source(repo_root: &Path) -> io::Result<Option<PathBuf>>
```

**Purpose**: Chooses the first non-empty repo guidance source between `<repo>/CLAUDE.md` and `<repo>/.claude/CLAUDE.md`. It prefers the root file when both are non-empty.

**Data flow**: Builds the two candidate paths in order, checks each with `is_non_empty_text_file`, and returns the first matching path or `None`.

**Call relations**: Used by both detection and import of repo-scoped `AgentsMd`.

*Call graph*: calls 1 internal fn (is_non_empty_text_file); called by 2 (detect_migrations, import_agents_md); 1 external calls (join).


##### `copy_dir_recursive`  (lines 1568–1592)

```
fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Recursively copies a directory tree, rewriting text for `SKILL.md` files while copying all other regular files byte-for-byte. It creates target directories as needed.

**Data flow**: Takes source and target paths → creates the target directory, iterates source entries, recurses into subdirectories, and for files either calls `rewrite_and_copy_text_file` when `is_skill_md(source_path)` is true or `fs::copy` otherwise.

**Call relations**: Used by `ExternalAgentConfigService::import_skills`.

*Call graph*: calls 2 internal fn (is_skill_md, rewrite_and_copy_text_file); called by 1 (import_skills); 4 external calls (join, copy, create_dir_all, read_dir).


##### `is_skill_md`  (lines 1594–1598)

```
fn is_skill_md(path: &Path) -> bool
```

**Purpose**: Recognizes `SKILL.md` files case-insensitively by filename. It is used to decide when markdown rewriting should occur during skill copying.

**Data flow**: Reads `path.file_name()` as UTF-8 and compares it case-insensitively to `SKILL.md` → returns boolean.

**Call relations**: Used only by `copy_dir_recursive`.

*Call graph*: called by 1 (copy_dir_recursive); 1 external calls (file_name).


##### `rewrite_and_copy_text_file`  (lines 1600–1604)

```
fn rewrite_and_copy_text_file(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Reads a text file, rewrites external-agent terminology to Codex terminology, and writes the rewritten contents to the target path. It is the common text-copy primitive for markdown migration.

**Data flow**: Reads source file to string → transforms it with `rewrite_external_agent_terms` → writes the rewritten string to the target path.

**Call relations**: Used by `import_agents_md` and `copy_dir_recursive`.

*Call graph*: calls 1 internal fn (rewrite_external_agent_terms); called by 2 (import_agents_md, copy_dir_recursive); 2 external calls (read_to_string, write).


##### `rewrite_external_agent_terms`  (lines 1606–1622)

```
fn rewrite_external_agent_terms(content: &str) -> String
```

**Purpose**: Rebrands external-agent terminology in copied text, replacing `CLAUDE.md` with `AGENTS.md` and several case-insensitive variants of the product/agent name with `Codex`. Replacements respect word boundaries.

**Data flow**: Takes input text → first replaces case-insensitive bounded occurrences of `claude.md` with `AGENTS.md`, then repeatedly replaces bounded occurrences of `claude code`, `claude-code`, `claude_code`, `claudecode`, and `claude` with `Codex` → returns the rewritten string.

**Call relations**: Used only by `rewrite_and_copy_text_file`.

*Call graph*: calls 1 internal fn (replace_case_insensitive_with_boundaries); called by 1 (rewrite_and_copy_text_file).


##### `replace_case_insensitive_with_boundaries`  (lines 1624–1661)

```
fn replace_case_insensitive_with_boundaries(
    input: &str,
    needle: &str,
    replacement: &str,
) -> String
```

**Purpose**: Performs case-insensitive substring replacement only when the match is bounded by non-word characters or string edges. This avoids rewriting embedded substrings inside larger identifiers.

**Data flow**: Takes input string, lowercase needle, and replacement → lowercases the haystack, scans for matches, checks byte-level word boundaries with `is_word_byte`, appends untouched spans and replacements into an output buffer, and returns either the original string if nothing matched or the rebuilt string.

**Call relations**: Used by `rewrite_external_agent_terms` for all branding substitutions.

*Call graph*: calls 1 internal fn (is_word_byte); called by 1 (rewrite_external_agent_terms); 1 external calls (with_capacity).


##### `is_word_byte`  (lines 1663–1665)

```
fn is_word_byte(byte: u8) -> bool
```

**Purpose**: Defines the byte-level notion of a word character for boundary-aware replacement: ASCII alphanumeric or underscore. It intentionally ignores Unicode word semantics.

**Data flow**: Takes one byte → returns whether it is ASCII alphanumeric or `_`.

**Call relations**: Used only by `replace_case_insensitive_with_boundaries`.

*Call graph*: called by 1 (replace_case_insensitive_with_boundaries).


##### `build_config_from_external`  (lines 1667–1705)

```
fn build_config_from_external(settings: &JsonValue) -> io::Result<TomlValue>
```

**Purpose**: Converts the subset of external-agent settings that Codex understands into a TOML table suitable for `config.toml`. Currently it migrates environment variables and sandbox enablement.

**Data flow**: Takes settings JSON → requires the root to be an object or returns invalid-data error → if `env` is a non-empty object, builds `[shell_environment_policy] inherit = "core"` plus a `set` table from `json_object_to_env_toml_table`; if `sandbox.enabled` is true, sets `sandbox_mode = "workspace-write"` → returns `TomlValue::Table(root)`.

**Call relations**: Used by both detection and import of `Config` items.

*Call graph*: calls 2 internal fn (invalid_data_error, json_object_to_env_toml_table); called by 2 (detect_migrations, import_config); 4 external calls (as_object, String, Table, new).


##### `json_object_to_env_toml_table`  (lines 1707–1717)

```
fn json_object_to_env_toml_table(
    object: &serde_json::Map<String, JsonValue>,
) -> toml::map::Map<String, TomlValue>
```

**Purpose**: Converts a JSON object of environment variables into a TOML table of string values, dropping entries that cannot be represented as strings. It normalizes booleans and numbers via `to_string`.

**Data flow**: Iterates key/value pairs in a JSON object → converts each value with `json_env_value_to_string` → inserts successful conversions as `TomlValue::String` into a TOML map → returns the map.

**Call relations**: Used by `build_config_from_external`.

*Call graph*: calls 1 internal fn (json_env_value_to_string); called by 1 (build_config_from_external); 2 external calls (String, new).


##### `json_env_value_to_string`  (lines 1719–1727)

```
fn json_env_value_to_string(value: &JsonValue) -> Option<String>
```

**Purpose**: Converts a JSON scalar into the string form used for migrated environment variables. Null, arrays, and objects are intentionally omitted.

**Data flow**: Matches a `JsonValue` → returns cloned strings, boolean/number `to_string()`, or `None` for null/array/object.

**Call relations**: Used by `json_object_to_env_toml_table`.

*Call graph*: called by 1 (json_object_to_env_toml_table); 2 external calls (clone, to_string).


##### `merge_missing_toml_values`  (lines 1729–1756)

```
fn merge_missing_toml_values(existing: &mut TomlValue, incoming: &TomlValue) -> io::Result<bool>
```

**Purpose**: Recursively merges only missing keys from one TOML table into another, never overwriting existing scalar or table values. It reports whether any insertion occurred.

**Data flow**: Takes mutable existing `TomlValue` and incoming `TomlValue` → if both are tables, iterates incoming keys, recursively merges nested tables when both sides are tables, inserts missing keys by cloning incoming values, tracks whether anything changed, and returns `Ok(changed)`; otherwise returns invalid-data error.

**Call relations**: Used by config detection and import to decide whether migrated config adds anything new.

*Call graph*: calls 1 internal fn (invalid_data_error); called by 2 (detect_migrations, import_config); 1 external calls (matches!).


##### `merge_missing_mcp_servers`  (lines 1758–1793)

```
fn merge_missing_mcp_servers(
    existing: &mut TomlValue,
    incoming: &TomlValue,
) -> io::Result<Vec<String>>
```

**Purpose**: Merges only missing `mcp_servers` entries from migrated TOML into existing config and returns the names actually added. Existing same-named servers are preserved untouched.

**Data flow**: Takes mutable existing TOML and incoming TOML → validates both roots are tables, extracts incoming `mcp_servers` table, inserts the whole table if existing config lacks it, otherwise if existing `mcp_servers` is a table inserts only absent server keys and collects their names → returns the added names.

**Call relations**: Used by MCP detection and import to avoid overwriting existing server definitions.

*Call graph*: called by 2 (detect_migrations, import_mcp_server_config); 4 external calls (Table, as_table, as_table_mut, new).


##### `write_toml_file`  (lines 1795–1799)

```
fn write_toml_file(path: &Path, value: &TomlValue) -> io::Result<()>
```

**Purpose**: Serializes a TOML value in pretty form and writes it with a trailing newline. It centralizes config-file output formatting.

**Data flow**: Takes a path and `TomlValue` → serializes with `toml::to_string_pretty`, trims trailing whitespace, appends one newline, writes to disk, and maps serialization failures to invalid-data I/O errors.

**Call relations**: Used by `import_config` and `import_mcp_server_config`.

*Call graph*: called by 2 (import_config, import_mcp_server_config); 3 external calls (format!, write, to_string_pretty).


##### `migrated_mcp_server_names`  (lines 1801–1807)

```
fn migrated_mcp_server_names(value: &TomlValue) -> Vec<String>
```

**Purpose**: Extracts the names of MCP servers present in a migrated TOML value. It is a convenience for reporting and detection.

**Data flow**: Reads `value.get("mcp_servers")` as a table and collects its keys into a vector, or returns an empty vector if absent.

**Call relations**: Used by MCP detection and import when a whole migrated config is being written.

*Call graph*: called by 2 (detect_migrations, import_mcp_server_config); 1 external calls (get).


##### `named_migrations`  (lines 1809–1814)

```
fn named_migrations(names: Vec<String>) -> Vec<NamedMigration>
```

**Purpose**: Wraps plain names into `NamedMigration` structs for inclusion in `MigrationDetails`. It is a small reporting helper.

**Data flow**: Takes `Vec<String>` → maps each string to `NamedMigration { name }` → returns the vector.

**Call relations**: Used by `detect_migrations` when populating details for MCP servers, hooks, commands, and subagents.

*Call graph*: called by 1 (detect_migrations).


##### `is_empty_toml_table`  (lines 1816–1826)

```
fn is_empty_toml_table(value: &TomlValue) -> bool
```

**Purpose**: Checks whether a TOML value is specifically an empty table. Non-table values are always considered non-empty.

**Data flow**: Matches on `TomlValue` → returns `table.is_empty()` for tables and `false` for all scalar/array variants.

**Call relations**: Used to skip no-op config and MCP migrations.

*Call graph*: called by 3 (detect_migrations, import_config, import_mcp_server_config).


##### `invalid_data_error`  (lines 1828–1830)

```
fn invalid_data_error(message: impl Into<String>) -> io::Error
```

**Purpose**: Creates a standardized `io::ErrorKind::InvalidData` error from any string-like message. It keeps parse/merge failures consistent.

**Data flow**: Takes any `Into<String>` message → converts it and wraps it in `io::Error::new(io::ErrorKind::InvalidData, ...)`.

**Call relations**: Used throughout parsing, merging, and import validation paths.

*Call graph*: called by 7 (import, import_agents_md, import_config, import_mcp_server_config, import_plugins, build_config_from_external, merge_missing_toml_values); 2 external calls (into, new).


##### `migration_item_type_label`  (lines 1832–1844)

```
fn migration_item_type_label(item_type: ExternalAgentConfigMigrationItemType) -> &'static str
```

**Purpose**: Maps each migration item type enum to the string label used in metrics tags. The labels are stable snake_case identifiers.

**Data flow**: Matches `ExternalAgentConfigMigrationItemType` → returns a `&'static str` label.

**Call relations**: Used by `migration_metric_tags`.


##### `record_import_error`  (lines 1846–1860)

```
fn record_import_error(
    result: &mut ExternalAgentConfigImportItemResult,
    failure_stage: &'static str,
    message: impl Into<String>,
    source: Option<String>,
)
```

**Purpose**: Packages a contextual import failure into `ExternalAgentConfigImportRawError` and records it on an item result. It preserves the item’s type and cwd automatically.

**Data flow**: Takes mutable item result, failure-stage string, message, and optional source → constructs `ExternalAgentConfigImportRawError` from the result’s item type/cwd plus provided fields → calls `result.record_error(...)`.

**Call relations**: Used by `import` and by session-related import validation code elsewhere to accumulate non-fatal item errors.

*Call graph*: calls 1 internal fn (record_error); called by 4 (import, import, validate_pending_session_imports, import_sessions); 1 external calls (into).


##### `record_plugin_import_errors`  (lines 1862–1875)

```
fn record_plugin_import_errors(
    outcome: &mut PluginImportOutcome,
    cwd: Option<&Path>,
    plugin_ids: &[String],
    failure_stage: &'static str,
    message: impl Into<String>,
)
```

**Purpose**: Adds the same plugin-import failure message for a list of plugin IDs into a `PluginImportOutcome`. It is used when a marketplace-level failure affects multiple plugins.

**Data flow**: Takes mutable plugin outcome, optional cwd, slice of plugin IDs, failure stage, and message → clones the message and extends `raw_errors` with one `plugin_import_raw_error(...)` per plugin ID.

**Call relations**: Used by `import_plugins` when marketplace source lookup or marketplace installation fails.

*Call graph*: called by 1 (import_plugins); 1 external calls (into).


##### `plugin_import_raw_error`  (lines 1877–1891)

```
fn plugin_import_raw_error(
    cwd: Option<&Path>,
    failure_stage: &'static str,
    message: String,
    source: Option<String>,
) -> ExternalAgentConfigImportRawError
```

**Purpose**: Constructs a raw error record for one plugin import failure. It fixes the item type to `Plugins` and captures cwd/source context.

**Data flow**: Takes optional cwd, failure stage, message string, and optional source/plugin ID → returns `ExternalAgentConfigImportRawError { item_type: Plugins, error_type: None, failure_stage, message, cwd: cwd.map(Path::to_path_buf), source }`.

**Call relations**: Used by `import_plugins` and `record_plugin_import_errors`.

*Call graph*: called by 1 (import_plugins).


##### `migration_metric_tags`  (lines 1893–1910)

```
fn migration_metric_tags(
    item_type: ExternalAgentConfigMigrationItemType,
    skills_count: Option<usize>,
) -> Vec<(&'static str, String)>
```

**Purpose**: Builds the OpenTelemetry tag set for migration counters. Skills-like item types also include a `skills_count` tag.

**Data flow**: Takes an item type and optional skills count → starts with `("migration_type", label)` from `migration_item_type_label`, conditionally appends `("skills_count", count)` for `Skills`, `Subagents`, and `Commands`, and returns the tag vector.

**Call relations**: Used by `emit_migration_metric`.

*Call graph*: called by 1 (emit_migration_metric); 2 external calls (matches!, vec!).


##### `emit_migration_metric`  (lines 1912–1926)

```
fn emit_migration_metric(
    metric_name: &str,
    item_type: ExternalAgentConfigMigrationItemType,
    skills_count: Option<usize>,
)
```

**Purpose**: Emits a one-count migration metric if a global metrics backend is available. It is a best-effort side effect and silently no-ops when metrics are disabled.

**Data flow**: Takes metric name, item type, and optional skills count → gets the global metrics handle, builds tags with `migration_metric_tags`, converts them to borrowed string pairs, and increments the named counter by 1.

**Call relations**: Called from detection and import paths whenever a migration item is discovered or processed.

*Call graph*: calls 1 internal fn (migration_metric_tags); called by 3 (detect_migrations, detect_plugin_migration, import); 1 external calls (global).


### `core/src/personality_migration.rs`

`domain_logic` · `startup`

This file encapsulates a startup migration guarded by the marker filename `.personality_migration`. `maybe_migrate_personality` is the coordinator: it first checks for the marker under `codex_home` and immediately skips if present. If the parsed `ConfigToml` already contains a `personality`, it creates the marker and reports `SkippedExplicitPersonality`, ensuring the migration never revisits that installation. Otherwise it determines the default model provider ID from `config_toml.model_provider` or falls back to `"openai"`, then probes for any recorded sessions. Session detection is intentionally broad: `has_recorded_sessions` constructs a `LocalThreadStore` rooted at `codex_home` for both rollout files and SQLite state, checks non-archived threads first, and only checks archived threads if needed. `has_threads` performs a minimal `list_threads` query with `page_size: 1`, descending creation time, no source/provider/cwd filters, and `use_state_db_only: false`, so the migration only needs existence, not full enumeration.

If sessions exist, the migration persists `Personality::Pragmatic` through `ConfigEditsBuilder`, wrapping persistence failures as `io::Error::other`. In every non-marker path it writes the marker afterward. `create_marker` uses `create_new(true)` and treats `AlreadyExists` as success, preserving idempotence even under races.

#### Function details

##### `maybe_migrate_personality`  (lines 25–60)

```
async fn maybe_migrate_personality(
    codex_home: &Path,
    config_toml: &ConfigToml,
    state_db: Option<StateDbHandle>,
) -> io::Result<PersonalityMigrationStatus>
```

**Purpose**: Runs the one-time personality migration decision tree and returns a precise `PersonalityMigrationStatus` describing why it applied or skipped. It is the only public entrypoint in this file.

**Data flow**: Inputs are `codex_home`, parsed `&ConfigToml`, and an optional `StateDbHandle`. It derives `marker_path`, checks filesystem existence, reads `config_toml.personality` and `config_toml.model_provider`, asks `has_recorded_sessions` whether any sessions exist, and if appropriate uses `ConfigEditsBuilder::new(codex_home).set_personality(Some(Personality::Pragmatic)).apply().await` to persist config changes. It writes the marker via `create_marker` in every path except the early marker-hit case, and returns one of `SkippedMarker`, `SkippedExplicitPersonality`, `SkippedNoSessions`, or `Applied` wrapped in `io::Result`.

**Call relations**: Startup orchestration calls this before normal operation, and tests exercise each branch. It delegates to `create_marker` for idempotence bookkeeping, to `has_recorded_sessions` for legacy-session detection, and to `ConfigEditsBuilder` only when migration should actually modify config.

*Call graph*: calls 3 internal fn (new, create_marker, has_recorded_sessions); called by 13 (migrate_personality_if_needed, run_main_with_transport_options, applied_migration_is_idempotent_on_second_run, marker_short_circuits_migration_with_legacy_profile, migration_marker_exists_no_sessions_no_change, missing_legacy_profile_does_not_block_migration, no_marker_archived_sessions_sets_personality, no_marker_explicit_global_personality_skips_migration, no_marker_meta_only_rollout_is_treated_as_no_sessions, no_marker_no_sessions_no_change (+3 more)); 2 external calls (join, try_exists).


##### `has_recorded_sessions`  (lines 62–79)

```
async fn has_recorded_sessions(
    codex_home: &Path,
    default_provider: &str,
    state_db: Option<StateDbHandle>,
) -> io::Result<bool>
```

**Purpose**: Determines whether any thread history exists under the user's Codex home, considering both active and archived sessions. It centralizes thread-store construction for the migration.

**Data flow**: It takes `codex_home`, a `default_provider` string, and optional `StateDbHandle`. It builds a `LocalThreadStore` using `LocalThreadStoreConfig` with both `codex_home` and `sqlite_home` set to the same root and `default_model_provider_id` set from the argument. It then calls `has_threads(store, false)` and returns `true` immediately if active threads exist; otherwise it calls `has_threads(store, true)` and returns that result.

**Call relations**: Only `maybe_migrate_personality` invokes this, after deciding migration is not already skipped by marker or explicit config. It delegates the actual existence probe to `has_threads` twice so archived sessions can still trigger migration.

*Call graph*: calls 2 internal fn (has_threads, new); called by 1 (maybe_migrate_personality); 1 external calls (to_path_buf).


##### `has_threads`  (lines 81–99)

```
async fn has_threads(store: &LocalThreadStore, archived: bool) -> io::Result<bool>
```

**Purpose**: Executes a minimal thread listing query and converts the result into a simple existence boolean. It avoids loading more than one thread by requesting a single-item page.

**Data flow**: Inputs are a `&LocalThreadStore` and an `archived` flag. It calls `store.list_threads` with `ListThreadsParams` configured for `page_size: 1`, descending `CreatedAt`, empty `allowed_sources`, no provider/cwd/parent/search filters, the supplied `archived` value, and `use_state_db_only: false`; then maps the returned page to `!page.items.is_empty()`. Any thread-store error is converted into `io::Error::other`.

**Call relations**: This helper is called only by `has_recorded_sessions`, once for active threads and potentially once for archived threads. It delegates all storage-format details to `LocalThreadStore::list_threads`.

*Call graph*: calls 1 internal fn (list_threads); called by 1 (has_recorded_sessions); 1 external calls (new).


##### `create_marker`  (lines 101–112)

```
async fn create_marker(marker_path: &Path) -> io::Result<()>
```

**Purpose**: Creates the migration marker file with a simple version payload, while treating an existing marker as success. This makes repeated runs and benign races harmless.

**Data flow**: It accepts a `marker_path`, opens it with `OpenOptions::new().create_new(true).write(true)`, and on success writes the bytes `b"v1\n"`. If open fails with `AlreadyExists`, it returns `Ok(())`; any other I/O error is propagated.

**Call relations**: `maybe_migrate_personality` calls this whenever it wants to permanently record that migration evaluation has happened. It does not call other local helpers; its role is purely filesystem persistence.

*Call graph*: called by 1 (maybe_migrate_personality); 1 external calls (new).


### Daemon-local settings storage
This file defines and persists the daemon’s own local settings outside the main app-server configuration flow.

### `app-server-daemon/src/settings.rs`

`config` · `config load`

This module contains a single serde-backed data model, `DaemonSettings`, with one persisted field: `remote_control_enabled: bool`. The struct derives `Default`, `Serialize`, and `Deserialize`, and uses `#[serde(rename_all = "camelCase")]`, so the on-disk JSON key is `remoteControlEnabled` rather than Rust snake_case. That naming rule is important because the file’s unit test locks the wire format to camelCase.

`DaemonSettings::load` reads a JSON file asynchronously with `tokio::fs::read_to_string`. Its control flow distinguishes a missing file from other I/O failures: `NotFound` is treated as “no settings yet” and returns `DaemonSettings::default()` instead of an error, while any other read failure is wrapped with path-specific context. If the file exists, the entire contents are parsed with `serde_json::from_str`; parse failures are also annotated with the file path.

`DaemonSettings::save` performs the inverse operation. Before writing, it checks `path.parent()` and creates the containing directory tree with `create_dir_all`, so callers can save into a not-yet-created config directory. It serializes with `serde_json::to_vec_pretty`, producing stable human-readable JSON, then writes the bytes atomically from the caller’s perspective via `tokio::fs::write`. The module keeps no global state; all state is explicit in the struct instance and filesystem path.

#### Function details

##### `DaemonSettings::load`  (lines 16–28)

```
async fn load(path: &Path) -> Result<Self>
```

**Purpose**: Loads daemon settings from a JSON file, treating a missing file as an empty/default configuration rather than an error. It also enriches read and parse failures with the path being processed.

**Data flow**: Takes `path: &Path` → asynchronously reads UTF-8 text from that path. If the file is absent, it returns `Ok(DaemonSettings::default())`; otherwise it parses the text as JSON into `Self` with serde. It returns `Result<DaemonSettings>` and does not mutate shared state.

**Call relations**: This is invoked by `load_settings` when the daemon initializes its persisted configuration. It delegates filesystem access to Tokio and JSON decoding to `serde_json::from_str`, and its special `NotFound` branch is what lets higher-level startup proceed without a preexisting settings file.

*Call graph*: called by 1 (load_settings); 3 external calls (default, read_to_string, from_str).


##### `DaemonSettings::save`  (lines 30–44)

```
async fn save(&self, path: &Path) -> Result<()>
```

**Purpose**: Persists the current settings struct as pretty-printed JSON, creating parent directories first when needed. It is the write-side counterpart to `DaemonSettings::load`.

**Data flow**: Takes `&self` plus `path: &Path` → inspects `path.parent()`, creates that directory tree if present, serializes `self` to pretty JSON bytes, then writes those bytes to `path`. Returns `Result<()>`; on success the filesystem now contains the updated settings file.

**Call relations**: This routine is used by higher-level daemon code when settings need to be flushed to disk. It delegates directory creation to `tokio::fs::create_dir_all`, serialization to `serde_json::to_vec_pretty`, and the final write to `tokio::fs::write`.

*Call graph*: 4 external calls (parent, create_dir_all, write, to_vec_pretty).


##### `tests::daemon_settings_use_camel_case_json`  (lines 54–62)

```
fn daemon_settings_use_camel_case_json()
```

**Purpose**: Verifies that `DaemonSettings` serializes with camelCase field names, specifically `remoteControlEnabled`. The test protects the persisted JSON contract from accidental serde attribute changes.

**Data flow**: Constructs an in-memory `DaemonSettings` with `remote_control_enabled: true` → serializes it to a JSON string → compares the exact string against the expected camelCase form. It returns no value and writes no external state.

**Call relations**: This test runs only in the Unix test configuration and exercises the serde derive behavior indirectly. It does not call production helpers; instead it asserts the serialization invariant that `DaemonSettings::save` relies on.

*Call graph*: 1 external calls (assert_eq!).
