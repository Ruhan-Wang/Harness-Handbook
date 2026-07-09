# Configuration management services and editable persistence surfaces  `stage-4.1.3`

This stage is the system’s configuration “service desk.” It sits behind the main app and daemon, letting clients read settings, change them safely, import old settings, and get understandable errors when configuration loading fails. The app server request processor is the front desk: it accepts configuration requests, reports policy rules, applies changes, and refreshes running work so new settings take effect. The service layer behind it checks whether requested edits are valid, writes them to the right files, and warns when another configuration layer will override them.

The core edit code is the careful pen. It updates the user’s config.toml file, a human-editable settings file, while preserving formatting where possible and writing atomically, meaning it avoids leaving a half-written broken file. Its document helpers convert between TOML text and typed settings. Error handling turns configuration failures into clear JSON-RPC replies, with special guidance for cloud bundle sign-in problems. Migration code imports Claude-style agent settings and adds a default personality only when safe. The daemon settings file separately saves its small remote-control option as JSON.

## Files in this stage

### App-server config APIs
These files expose configuration management through app-server RPCs, translating errors and delegating validated reads and writes to the service layer.

### `app-server/src/request_processors/config_errors.rs`

`domain_logic` · `request handling during configuration load`

When the app server tries to load configuration, the failure may be a simple input/output error, or it may hide a more specific cloud configuration error inside it. This file is the small translator that looks inside that error and builds a response the JSON-RPC client can understand. JSON-RPC is a common request/response format where errors can include a message and optional structured data.

The first helper walks through the chain of underlying errors, like opening nested boxes, to see whether one of them is a CloudConfigBundleLoadError. If it finds one, the second function includes useful details in the outgoing error: the cloud error code, a readable detail string, and sometimes the HTTP-style status code. If the code says the problem is authentication, it also adds an action of "relogin", which gives the caller a practical next step instead of just saying something failed.

Without this file, configuration load failures would be flatter and less helpful. Clients might only see a generic failure message and would not know, for example, that the user needs to log in again.

#### Function details

##### `cloud_config_bundle_load_error`  (lines 3–14)

```
fn cloud_config_bundle_load_error(err: &std::io::Error) -> Option<&CloudConfigBundleLoadError>
```

**Purpose**: This function searches inside a standard input/output error to find a more specific cloud configuration bundle error, if one is hidden there. It is used so the server can report cloud-specific causes instead of treating every configuration failure as generic.

**Data flow**: It receives a std::io::Error. It looks at the error's stored underlying cause, then follows each cause to the next one. If any cause is a CloudConfigBundleLoadError, it returns a reference to that specific error. If it reaches the end of the chain without finding one, it returns nothing.

**Call relations**: config_load_error calls this first when preparing an error response. This helper does the detective work of finding the meaningful cloud error, then hands that result back so the response can include richer details.

*Call graph*: called by 1 (config_load_error); 1 external calls (get_ref).


##### `config_load_error`  (lines 16–35)

```
fn config_load_error(err: &std::io::Error) -> JSONRPCErrorError
```

**Purpose**: This function converts a configuration loading failure into a JSON-RPC error object that can be sent back to the client. When the failure is cloud-related, it adds structured information so the client can react intelligently.

**Data flow**: It receives a std::io::Error from a failed configuration load. It asks cloud_config_bundle_load_error whether there is a cloud bundle error inside. If there is, it builds JSON data containing the reason, error code, detail message, optional status code, and an optional "relogin" action for authentication failures. It then creates an "invalid request" JSON-RPC error with a readable message and attaches the extra data before returning it.

**Call relations**: This is the public helper within the request processor area for turning load failures into client-facing JSON-RPC errors. It relies on cloud_config_bundle_load_error to uncover cloud-specific details, then packages those details into the final error response.

*Call graph*: calls 1 internal fn (cloud_config_bundle_load_error); 1 external calls (format!).


### `app-server/src/request_processors/config_processor.rs`

`orchestration` · `request handling`

Configuration is one of the main ways a user or administrator changes how the app behaves: which features are on, what permissions are allowed, which model provider is used, and what hooks or network rules apply. This file sits between client requests and the lower-level ConfigManager. It is like a receptionist who understands both the client’s language and the building’s internal filing system.

The main type, ConfigRequestProcessor, receives already-authorized client requests. For read requests, it asks the config manager for stored settings, then adds live experimental feature states so the client sees what is actually active. For write requests, it saves the requested changes, clears cached plugin and skill information so old settings do not linger, and sometimes pushes a refreshed runtime config into every active thread. It also emits analytics when plugins are enabled or disabled.

The rest of the file is mostly careful translation. Config requirements are stored in TOML-oriented internal types, but the app server must return protocol types. Helper functions convert sandbox modes, hook definitions, network permissions, residency rules, and other policy settings into client-facing values. Errors are also translated so write failures become clear request errors with a machine-readable config write code.

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

**Purpose**: Builds a ConfigRequestProcessor with the shared pieces it needs: a way to send replies, access to configuration storage, access to running threads, and an analytics client. This is used when the server wires up its request-processing components.

**Data flow**: The caller gives in shared server services. The function stores them in a new processor object. The caller gets back that processor, ready to answer configuration-related client requests.

**Call relations**: This is called during setup by the surrounding construction code. After it creates the processor, later request handling can call the read, write, and feature-related methods on the same stored dependencies.

*Call graph*: called by 1 (new).


##### `ConfigRequestProcessor::read`  (lines 80–107)

```
async fn read(
        &self,
        params: ConfigReadParams,
    ) -> Result<ConfigReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads configuration for a client and adds the current on/off state of supported experimental features. This matters because some feature flags can be affected by runtime overrides, not just by what is written in the config file.

**Data flow**: It receives read parameters, including an optional current working directory used as context. It asks the config manager for the requested config, loads the latest resolved runtime config, then inserts supported feature states under a features object in the response. It returns the enriched config response or a JSON-RPC error, which is the error format used by this server protocol.

**Call relations**: When handle_initialized_client_request receives a config read request, it calls this method. This method relies on load_latest_config to see the final feature state, uses feature_for_key to recognize known feature names, and then hands the completed response back to the request flow.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (handle_initialized_client_request); 3 external calls (read, feature_for_key, json!).


##### `ConfigRequestProcessor::config_requirements_read`  (lines 109–120)

```
async fn config_requirements_read(
        &self,
    ) -> Result<ConfigRequirementsReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads policy requirements that constrain what configuration values are allowed. For example, an organization may limit sandbox modes, approval policies, hooks, or network behavior.

**Data flow**: It asks the config manager for requirements. If requirements exist, it converts them from internal TOML-shaped data into the app server protocol shape. It returns a response containing either those requirements or no requirements.

**Call relations**: The initialized client request handler calls this when a client asks what config rules apply. The method hands the raw data through map_requirements_toml_to_api so clients do not need to understand the internal config file format.

*Call graph*: called by 1 (handle_initialized_client_request); 1 external calls (read_requirements).


##### `ConfigRequestProcessor::value_write`  (lines 122–129)

```
async fn value_write(
        &self,
        params: ConfigValueWriteParams,
    ) -> Result<ClientResponsePayload, JSONRPCErrorError>
```

**Purpose**: Writes one configuration value and performs the standard cleanup needed after any successful config change. It returns the result wrapped in the client response type expected by the protocol.

**Data flow**: It receives a single key path and value. It delegates the actual save work to write_value, then passes the result through handle_config_mutation_result. If the write succeeds, caches are cleared; if it fails, the error is returned. The final output is a client response payload for a config value write.

**Call relations**: The initialized client request handler calls this for single-setting updates. This method is a small wrapper that connects the lower-level write_value operation to the common after-change behavior.

*Call graph*: calls 2 internal fn (handle_config_mutation_result, write_value); called by 1 (handle_initialized_client_request).


##### `ConfigRequestProcessor::batch_write`  (lines 131–138)

```
async fn batch_write(
        &self,
        params: ConfigBatchWriteParams,
    ) -> Result<ClientResponsePayload, JSONRPCErrorError>
```

**Purpose**: Writes several configuration edits at once and performs the standard cleanup after a successful change. It is used when a client wants multiple settings updated as one request.

**Data flow**: It receives a batch of edits. It delegates to batch_write_inner for the actual save, plugin analytics, and optional runtime reload, then uses handle_config_mutation_result to clear cached plugin and skill data on success. It returns a client response payload for the batch write.

**Call relations**: The initialized client request handler calls this for multi-edit updates. It ties together batch_write_inner and the shared mutation cleanup path used by other config writes.

*Call graph*: calls 2 internal fn (batch_write_inner, handle_config_mutation_result); called by 1 (handle_initialized_client_request).


##### `ConfigRequestProcessor::experimental_feature_enablement_set`  (lines 140–155)

```
async fn experimental_feature_enablement_set(
        &self,
        request_id: ConnectionRequestId,
        params: ExperimentalFeatureEnablementSetParams,
    ) -> Result<Option<ClientResponsePaylo
```

**Purpose**: Changes the runtime on/off state of experimental features and sends the reply itself. It returns no payload to the normal response path because it has already sent the response using the outgoing message sender.

**Data flow**: It receives a request id and a map of feature enablement choices. It updates supported feature settings through set_experimental_feature_enablement, runs the normal mutation cleanup on success, sends a protocol response to the original request id, and returns None to show that no additional response should be sent.

**Call relations**: The initialized client request handler calls this for feature enablement changes. It combines set_experimental_feature_enablement, handle_config_mutation_result, and the outgoing sender so the response is delivered under the correct request id.

*Call graph*: calls 2 internal fn (handle_config_mutation_result, set_experimental_feature_enablement); called by 1 (handle_initialized_client_request); 1 external calls (ExperimentalFeatureEnablementSet).


##### `ConfigRequestProcessor::model_provider_capabilities_read`  (lines 157–168)

```
async fn model_provider_capabilities_read(
        &self,
    ) -> Result<ModelProviderCapabilitiesReadResponse, JSONRPCErrorError>
```

**Purpose**: Reports what the currently configured model provider can do, such as namespace tools, image generation, or web search. This lets the client adjust its interface to match the selected provider.

**Data flow**: It loads the latest resolved config, creates a model provider from the configured provider settings, asks that provider for its capabilities, and returns those capabilities in the app server protocol response.

**Call relations**: The initialized client request handler calls this when a client asks about provider capabilities. It depends on load_latest_config for current settings and create_model_provider for turning those settings into a provider object.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (handle_initialized_client_request); 1 external calls (create_model_provider).


##### `ConfigRequestProcessor::handle_config_mutation`  (lines 170–173)

```
async fn handle_config_mutation(&self)
```

**Purpose**: Clears cached plugin and skill information after configuration changes. Without this, the app could keep using stale plugin or skill data after the user changed settings.

**Data flow**: It reads the thread manager stored in the processor, reaches its plugin and skill managers, and tells both to clear their caches. It does not return data; it changes in-memory cache state.

**Call relations**: handle_config_mutation_result calls this after successful config writes. It is also available to other import flows that need the same refresh behavior after changing configuration.

*Call graph*: called by 2 (handle_config_mutation_result, import).


##### `ConfigRequestProcessor::handle_config_mutation_result`  (lines 175–182)

```
async fn handle_config_mutation_result(
        &self,
        result: std::result::Result<T, JSONRPCErrorError>,
    ) -> Result<T, JSONRPCErrorError>
```

**Purpose**: Applies the standard after-change cleanup only when a config mutation succeeded. It keeps callers from accidentally clearing caches after a failed write.

**Data flow**: It receives a result from some config-changing operation. If the result is an error, it returns that error unchanged. If the result is successful, it clears config-dependent caches through handle_config_mutation and then returns the original successful value.

**Call relations**: value_write, batch_write, and experimental_feature_enablement_set all use this helper. It centralizes the rule that successful mutations must refresh plugin and skill caches.

*Call graph*: calls 1 internal fn (handle_config_mutation); called by 3 (batch_write, experimental_feature_enablement_set, value_write).


##### `ConfigRequestProcessor::load_latest_config`  (lines 184–196)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<codex_core::config::Config, JSONRPCErrorError>
```

**Purpose**: Loads the fully resolved current configuration, including precedence rules such as runtime feature overrides. It wraps lower-level errors into the JSON-RPC error format used by the server.

**Data flow**: It receives an optional fallback working directory. It passes that to the config manager’s latest-config loader. On success, it returns the resolved core config; on failure, it returns an internal server error with a clear message.

**Call relations**: read, model_provider_capabilities_read, reload_user_config, and set_experimental_feature_enablement call this whenever they need the actual current config rather than just raw stored values.

*Call graph*: calls 1 internal fn (load_latest_config); called by 4 (model_provider_capabilities_read, read, reload_user_config, set_experimental_feature_enablement).


##### `ConfigRequestProcessor::write_value`  (lines 198–212)

```
async fn write_value(
        &self,
        params: ConfigValueWriteParams,
    ) -> Result<ConfigWriteResponse, JSONRPCErrorError>
```

**Purpose**: Performs the actual single-value config write and records analytics if the write looks like it enabled or disabled a plugin. This keeps telemetry tied to successful configuration changes.

**Data flow**: It receives one config key path and value. Before writing, it notes any plugin enablement change that this edit appears to represent. It asks the config manager to save the value, maps any error, then emits plugin enabled or disabled events for the pending plugin changes. It returns the config write response.

**Call relations**: value_write calls this as its inner operation. This method uses collect_plugin_enabled_candidates to detect plugin toggles, the config manager to write, and emit_plugin_toggle_events to send analytics.

*Call graph*: calls 2 internal fn (emit_plugin_toggle_events, collect_plugin_enabled_candidates); called by 1 (value_write); 1 external calls (write_value).


##### `ConfigRequestProcessor::batch_write_inner`  (lines 214–235)

```
async fn batch_write_inner(
        &self,
        params: ConfigBatchWriteParams,
    ) -> Result<ConfigWriteResponse, JSONRPCErrorError>
```

**Purpose**: Performs the actual multi-edit config write, records plugin toggle analytics, and optionally refreshes all running threads with the new user config. It is the detailed worker behind batch writes.

**Data flow**: It receives a batch containing edits and a reload flag. It collects possible plugin enable or disable changes from the edits, asks the config manager to save the batch, emits analytics for plugin toggles, and if requested reloads runtime config for active threads. It returns the write response.

**Call relations**: batch_write calls this before applying the shared mutation cleanup. It coordinates collect_plugin_enabled_candidates, the config manager’s batch write, emit_plugin_toggle_events, and reload_user_config.

*Call graph*: calls 3 internal fn (emit_plugin_toggle_events, reload_user_config, collect_plugin_enabled_candidates); called by 1 (batch_write); 1 external calls (batch_write).


##### `ConfigRequestProcessor::set_experimental_feature_enablement`  (lines 237–272)

```
async fn set_experimental_feature_enablement(
        &self,
        params: ExperimentalFeatureEnablementSetParams,
    ) -> Result<ExperimentalFeatureEnablementSetResponse, JSONRPCErrorError>
```

**Purpose**: Updates runtime experimental feature switches, but only for feature names this server explicitly supports. Unsupported or unknown names are ignored with a warning rather than causing the whole request to fail.

**Data flow**: It receives a map of feature names to true or false. It removes invalid or unsupported names, warns about them, and if nothing valid remains returns an empty response. Otherwise it extends runtime feature enablement in the config manager, reloads the latest config to validate resolution, refreshes user config in running threads, and returns the accepted enablement map.

**Call relations**: experimental_feature_enablement_set calls this to do the actual feature update. It uses canonical feature lookup to validate names, load_latest_config to force resolution, and reload_user_config so active work sees the new feature state.

*Call graph*: calls 3 internal fn (extend_runtime_feature_enablement, load_latest_config, reload_user_config); called by 1 (experimental_feature_enablement_set); 2 external calls (new, warn!).


##### `ConfigRequestProcessor::reload_user_config`  (lines 274–292)

```
async fn reload_user_config(&self)
```

**Purpose**: Pushes the latest resolved config into every currently running thread. This is needed when a setting changes and existing conversations or tasks should see the new behavior without restarting the server.

**Data flow**: It tries to load the latest config. If loading fails, it logs a warning and stops. If loading succeeds, it asks the thread manager for all thread ids, retrieves each thread that is still available, and tells each one to refresh its runtime config with the new config copy.

**Call relations**: batch_write_inner calls this when a batch explicitly asks to reload user config, and set_experimental_feature_enablement calls it after changing runtime feature flags. It depends on load_latest_config before touching active threads.

*Call graph*: calls 1 internal fn (load_latest_config); called by 2 (batch_write_inner, set_experimental_feature_enablement); 1 external calls (warn!).


##### `ConfigRequestProcessor::emit_plugin_toggle_events`  (lines 294–313)

```
async fn emit_plugin_toggle_events(
        &self,
        pending_changes: std::collections::BTreeMap<String, bool>,
    )
```

**Purpose**: Sends analytics events when configuration edits enable or disable plugins. It makes plugin usage changes visible to telemetry without blocking the write itself on malformed plugin ids.

**Data flow**: It receives a map from plugin id strings to enabled or disabled values. For each entry, it parses the plugin id; invalid ids are skipped. For valid ids, it loads installed-plugin telemetry metadata from the configured Codex home directory, then tracks either a plugin enabled or plugin disabled event.

**Call relations**: write_value and batch_write_inner call this after successful writes that may have changed plugin enablement. It works with plugin id parsing, installed plugin metadata lookup, and the analytics events client.

*Call graph*: calls 5 internal fn (track_plugin_disabled, track_plugin_enabled, codex_home, installed_plugin_telemetry_metadata, parse); called by 2 (batch_write_inner, write_value).


##### `map_requirements_toml_to_api`  (lines 316–380)

```
fn map_requirements_toml_to_api(requirements: ConfigRequirementsToml) -> ConfigRequirements
```

**Purpose**: Converts internal configuration requirement data into the public API shape returned to clients. This keeps clients from needing to know how requirements are stored in TOML config files.

**Data flow**: It receives a ConfigRequirementsToml value. It copies simple fields, converts lists of internal enum values into protocol enum values, normalizes web search modes so Disabled is always included when modes are present, and delegates nested areas such as computer use, hooks, residency, and network rules to smaller mapping helpers. It returns a ConfigRequirements value ready for the app server protocol.

**Call relations**: config_requirements_read uses this conversion when returning requirements to clients. The tests in this file also call it directly to protect important fields from being accidentally dropped.

*Call graph*: called by 6 (requirements_api_includes_allow_appshots, requirements_api_includes_allow_managed_hooks_only, requirements_api_includes_allow_remote_control, requirements_api_includes_allowed_windows_sandbox_implementations, requirements_api_includes_computer_use_requirements, requirements_api_includes_permission_default_and_allowlist).


##### `map_computer_use_requirements_to_api`  (lines 382–388)

```
fn map_computer_use_requirements_to_api(
    computer_use: codex_config::ComputerUseRequirementsToml,
) -> ComputerUseRequirements
```

**Purpose**: Converts computer-use policy requirements into the protocol type. In practice, it carries over whether using a locked computer is allowed.

**Data flow**: It receives the internal computer-use requirements object. It copies the allow_locked_computer_use setting into a protocol ComputerUseRequirements object. The result is ready to be nested inside the broader requirements response.

**Call relations**: This helper is used as part of the requirements conversion path when computer-use requirements are present. It keeps that one nested policy area separate from the larger map_requirements_toml_to_api function.


##### `map_hooks_requirements_to_api`  (lines 390–423)

```
fn map_hooks_requirements_to_api(hooks: ManagedHooksRequirementsToml) -> ManagedHooksRequirements
```

**Purpose**: Converts managed hook requirements into the client-facing protocol shape. Hooks are configured actions that can run at certain moments, such as before tool use or when a session starts.

**Data flow**: It receives internal managed hook requirements, including managed directories and groups of hook matchers for many event types. It breaks out each event’s matcher groups, converts those groups, and returns a ManagedHooksRequirements value with the same event structure in API form.

**Call relations**: This function is part of the requirements mapping flow for hook policy. It calls map_hook_matcher_groups_to_api repeatedly so each event type is translated in the same way.

*Call graph*: calls 1 internal fn (map_hook_matcher_groups_to_api).


##### `map_hook_matcher_groups_to_api`  (lines 425–432)

```
fn map_hook_matcher_groups_to_api(
    groups: Vec<CoreMatcherGroup>,
) -> Vec<ConfiguredHookMatcherGroup>
```

**Purpose**: Converts a list of hook matcher groups from internal form to API form. A matcher group says, in effect, which hook commands apply to which matching situations.

**Data flow**: It receives a list of internal matcher groups. It converts each group one by one and collects the converted groups into a new list. The output is a list of ConfiguredHookMatcherGroup values.

**Call relations**: map_hooks_requirements_to_api calls this for each hook event category. It delegates the per-group conversion to map_hook_matcher_group_to_api.

*Call graph*: called by 1 (map_hooks_requirements_to_api).


##### `map_hook_matcher_group_to_api`  (lines 434–443)

```
fn map_hook_matcher_group_to_api(group: CoreMatcherGroup) -> ConfiguredHookMatcherGroup
```

**Purpose**: Converts one hook matcher group into the protocol type. It preserves the matcher and converts each configured hook handler inside the group.

**Data flow**: It receives one internal matcher group. It copies the matcher field, converts every handler in the group, and returns a ConfiguredHookMatcherGroup with protocol handler values.

**Call relations**: This is the per-item worker used by the hook matcher group list conversion. It hands each individual handler to map_hook_handler_to_api.


##### `map_hook_handler_to_api`  (lines 445–463)

```
fn map_hook_handler_to_api(handler: CoreHookHandlerConfig) -> ConfiguredHookHandler
```

**Purpose**: Converts one hook handler definition into the protocol type. A hook handler can be a shell command, a prompt, or an agent action.

**Data flow**: It receives an internal hook handler variant. For command handlers, it copies command text, Windows-specific command text, timeout, async flag, and status message. For prompt and agent handlers, it returns the matching protocol variant. The output is a ConfiguredHookHandler.

**Call relations**: Hook group conversion uses this for each handler inside a matcher group. It is the final step that makes individual hook actions client-readable.


##### `map_sandbox_mode_requirement_to_api`  (lines 465–472)

```
fn map_sandbox_mode_requirement_to_api(mode: CoreSandboxModeRequirement) -> Option<SandboxMode>
```

**Purpose**: Converts allowed sandbox modes into protocol sandbox modes, while dropping an internal-only external sandbox option. A sandbox is a safety boundary that limits what code or tools can access.

**Data flow**: It receives one internal sandbox mode requirement. Read-only, workspace-write, and full-access modes become matching API values. The external sandbox mode becomes None because there is no corresponding client-facing SandboxMode here.

**Call relations**: This helper is used during requirements conversion for allowed sandbox modes. Its optional return lets the broader conversion filter out modes that should not be exposed through this API.


##### `map_residency_requirement_to_api`  (lines 474–480)

```
fn map_residency_requirement_to_api(
    residency: CoreResidencyRequirement,
) -> codex_app_server_protocol::ResidencyRequirement
```

**Purpose**: Converts a data residency requirement into the protocol type. Data residency means a rule about where data is allowed to be processed or stored.

**Data flow**: It receives an internal residency requirement. The current supported value, US residency, is mapped to the protocol’s US residency value. The function returns the protocol residency requirement.

**Call relations**: This is used as part of the configuration requirements translation when residency enforcement is configured. It keeps internal policy naming separate from the public protocol type.


##### `map_network_requirements_to_api`  (lines 482–530)

```
fn map_network_requirements_to_api(
    network: codex_config::NetworkRequirementsToml,
) -> NetworkRequirements
```

**Purpose**: Converts network policy requirements into the client-facing protocol shape. These settings describe whether networking is enabled, which ports or proxies are allowed, and which domains or Unix sockets are allowed or denied.

**Data flow**: It receives internal network requirements. It extracts convenience lists such as allowed domains, denied domains, and allowed Unix sockets when available; converts detailed domain and socket permission maps; and copies network flags and port settings. It returns a NetworkRequirements object for the protocol.

**Call relations**: This helper is part of the broader requirements conversion. It uses the domain and Unix socket permission mapping helpers so each allow-or-deny entry is translated consistently.


##### `map_network_domain_permission_to_api`  (lines 532–539)

```
fn map_network_domain_permission_to_api(
    permission: codex_config::NetworkDomainPermissionToml,
) -> NetworkDomainPermission
```

**Purpose**: Converts a single domain network permission from internal form to protocol form. The permission says whether a matching network domain is allowed or denied.

**Data flow**: It receives an internal domain permission value. Allow becomes the API Allow value, and Deny becomes the API Deny value. It returns the converted NetworkDomainPermission.

**Call relations**: map_network_requirements_to_api uses this while translating the domain permission map. It is the small switch that keeps internal and protocol enum types separated.


##### `map_network_unix_socket_permission_to_api`  (lines 541–548)

```
fn map_network_unix_socket_permission_to_api(
    permission: codex_config::NetworkUnixSocketPermissionToml,
) -> NetworkUnixSocketPermission
```

**Purpose**: Converts a single Unix socket permission from internal form to protocol form. A Unix socket is a local inter-process communication path, similar to a private local pipe between programs.

**Data flow**: It receives an internal Unix socket permission value. Allow becomes the API Allow value, and Deny becomes the API Deny value. It returns the converted NetworkUnixSocketPermission.

**Call relations**: map_network_requirements_to_api uses this while translating Unix socket permission entries. It mirrors the domain permission conversion for local socket rules.


##### `map_error`  (lines 550–556)

```
fn map_error(err: ConfigManagerError) -> JSONRPCErrorError
```

**Purpose**: Turns ConfigManagerError values into JSON-RPC errors suitable for client responses. It gives config write failures a more specific error shape when possible.

**Data flow**: It receives an error from the config manager. If the error carries a config write error code, it builds an invalid-request error with that code in the error data. Otherwise it turns the message into a generic internal server error. The output is a JSONRPCErrorError.

**Call relations**: Config read and write methods use this when calls into the config manager fail. It calls config_write_error for known write errors and internal_error for everything else.

*Call graph*: calls 3 internal fn (write_error_code, internal_error, config_write_error); 1 external calls (to_string).


##### `config_write_error`  (lines 558–564)

```
fn config_write_error(code: ConfigWriteErrorCode, message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a client-facing error for a failed config write and includes a machine-readable write error code. This lets clients show a useful message and also react programmatically.

**Data flow**: It receives a ConfigWriteErrorCode and an error message. It creates an invalid request error, attaches JSON data containing the config_write_error_code, and returns the completed JSON-RPC error object.

**Call relations**: map_error calls this when a ConfigManagerError identifies a specific write failure. It is the helper that adds structured error data instead of returning only text.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (map_error); 1 external calls (json!).


##### `tests::requirements_api_includes_allow_managed_hooks_only`  (lines 577–585)

```
fn requirements_api_includes_allow_managed_hooks_only()
```

**Purpose**: Checks that the allow_managed_hooks_only requirement survives conversion into the API type. This protects a policy switch that restricts hook usage.

**Data flow**: The test builds requirements with allow_managed_hooks_only set to true. It converts them with map_requirements_toml_to_api, then verifies the converted value still contains true and that unrelated hooks data remains absent.

**Call relations**: This test calls the main requirements mapper directly. It guards against future edits accidentally dropping the managed-hooks-only field.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_permission_default_and_allowlist`  (lines 588–609)

```
fn requirements_api_includes_permission_default_and_allowlist()
```

**Purpose**: Checks that permission profile allowlists and default permission profile names are preserved during requirements conversion. These fields affect which permission presets a client may offer.

**Data flow**: The test builds requirements with two allowed permission profiles and a default profile name. After conversion, it compares the API fields with the original expected map and default string.

**Call relations**: This test exercises map_requirements_toml_to_api directly. It protects the conversion of permission profile policy data.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 3 external calls (from, assert_eq!, default).


##### `tests::requirements_api_includes_allow_appshots`  (lines 612–620)

```
fn requirements_api_includes_allow_appshots()
```

**Purpose**: Checks that the allow_appshots requirement is included in the API conversion. Appshots are an optional capability controlled by policy.

**Data flow**: The test creates requirements with allow_appshots set to false. It converts them and verifies that the API value is also false, while unrelated hooks data remains absent.

**Call relations**: This test calls map_requirements_toml_to_api. It ensures that the appshots policy flag is not lost when requirements are returned to clients.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_allow_remote_control`  (lines 623–630)

```
fn requirements_api_includes_allow_remote_control()
```

**Purpose**: Checks that the allow_remote_control requirement is preserved in the API response. Remote control is sensitive enough that clients need an accurate policy answer.

**Data flow**: The test builds requirements with allow_remote_control set to false. It converts them and asserts that the converted API requirements still contain false.

**Call relations**: This test calls map_requirements_toml_to_api. It protects the remote-control policy field in the requirements translation.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_computer_use_requirements`  (lines 633–647)

```
fn requirements_api_includes_computer_use_requirements()
```

**Purpose**: Checks that nested computer-use requirements are converted correctly. In particular, it verifies the locked-computer-use policy flag.

**Data flow**: The test creates requirements containing computer-use settings with allow_locked_computer_use set to false. It converts them, looks inside the nested API computer_use field, and asserts that the false value is present.

**Call relations**: This test calls map_requirements_toml_to_api, which in turn uses the computer-use conversion path when that nested data exists. It protects nested requirement mapping.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 2 external calls (assert_eq!, default).


##### `tests::requirements_api_includes_allowed_windows_sandbox_implementations`  (lines 650–668)

```
fn requirements_api_includes_allowed_windows_sandbox_implementations()
```

**Purpose**: Checks that Windows sandbox implementation requirements are converted into the protocol values clients expect. This matters for Windows setups that may allow elevated or unelevated sandbox modes.

**Data flow**: The test builds requirements with elevated and unelevated Windows sandbox implementation values. It converts them and asserts that the API response contains the matching WindowsSandboxSetupMode values in order.

**Call relations**: This test calls map_requirements_toml_to_api directly. It protects the Windows-specific branch of the requirements conversion.

*Call graph*: calls 1 internal fn (map_requirements_toml_to_api); 3 external calls (assert_eq!, default, vec!).


### `app-server/src/config_manager_service.rs`

`config` · `request handling`

Codex configuration can come from several places: user files, project files, managed enterprise policy, command-line session flags, and older legacy sources. This file gives the server a careful way to read that stack and to edit only the user's config file. Without it, clients could see the wrong effective settings, accidentally write to protected config layers, or save invalid settings that break later startup.

The main flow is simple in human terms. For reads, it loads the relevant config layers, combines them into the final effective configuration, converts that into the API shape, and optionally returns the individual layers so a client can explain where each setting came from. For writes, it first proves the requested file is really the allowed user config file. It then loads the current layers, checks an expected version to avoid overwriting someone else's newer edit, parses each requested key path and value, applies the change to an in-memory TOML document, validates the result, and finally writes only the needed edits back to disk.

A key detail is precedence. A user may successfully write a setting, but a higher-priority layer, like managed policy, may still win. This file detects that and returns metadata explaining which layer overrides the user's edit, like a note saying, "Your sticky note is on the board, but the boss's printed rule covers it."

#### Function details

##### `ConfigManagerError::write`  (lines 77–82)

```
fn write(code: ConfigWriteErrorCode, message: impl Into<String>) -> Self
```

**Purpose**: Builds an error for a config write that failed for a user-facing reason, such as a version conflict or invalid setting. It keeps both a machine-readable error code and a readable message.

**Data flow**: It receives a write error code and a message-like value, turns the message into a plain string, and returns a ConfigManagerError::Write value. Nothing else is changed.

**Call relations**: The write path uses this helper inside ConfigManager::apply_edits whenever it needs to stop a requested change and report a clear reason back to the API client.

*Call graph*: called by 1 (apply_edits); 1 external calls (into).


##### `ConfigManagerError::io`  (lines 84–86)

```
fn io(context: &'static str, source: std::io::Error) -> Self
```

**Purpose**: Wraps a file-system error with a short explanation of what the program was trying to do. This makes low-level read or write failures understandable to callers.

**Data flow**: It receives a context label and an operating-system I/O error, combines them into a ConfigManagerError::Io value, and returns that error. The original error is kept inside for debugging.

**Call relations**: File-related helpers such as create_empty_user_layer use this when reading, creating, or resolving the user config file fails.

*Call graph*: called by 1 (create_empty_user_layer).


##### `ConfigManagerError::json`  (lines 88–90)

```
fn json(context: &'static str, source: serde_json::Error) -> Self
```

**Purpose**: Wraps a JSON conversion error with context. JSON is the data format used for API-shaped values, so this helps explain failures when converting between internal config data and API data.

**Data flow**: It receives a context label and a serde_json error, stores both in a ConfigManagerError::Json value, and returns it.

**Call relations**: ConfigManager::read uses this style of error when turning the merged TOML config into the API configuration format.


##### `ConfigManagerError::toml`  (lines 92–94)

```
fn toml(context: &'static str, source: toml::de::Error) -> Self
```

**Purpose**: Wraps a TOML parsing or decoding error with context. TOML is the human-editable config file format used by Codex.

**Data flow**: It receives a context label and a TOML decoding error, packages them into a ConfigManagerError::Toml value, and returns it.

**Call relations**: Read and file-creation paths use this when loaded config text cannot be understood as valid TOML.


##### `ConfigManagerError::anyhow`  (lines 96–98)

```
fn anyhow(context: &'static str, source: anyhow::Error) -> Self
```

**Purpose**: Wraps a general-purpose error with context when the error does not fit the more specific I/O, JSON, TOML, or write categories.

**Data flow**: It receives a context label and a broad anyhow error, stores both in a ConfigManagerError::Anyhow value, and returns it.

**Call relations**: The write path uses this for failures from helper libraries, such as building edit operations or running the persistence task.


##### `ConfigManagerError::write_error_code`  (lines 100–105)

```
fn write_error_code(&self) -> Option<ConfigWriteErrorCode>
```

**Purpose**: Extracts the API error code from a write-related error, if there is one. This lets outer layers turn internal failures into stable responses for clients.

**Data flow**: It reads the error value. If the error is a write error, it returns a copy of its ConfigWriteErrorCode; otherwise it returns nothing.

**Call relations**: The server's error mapping code calls this when it needs to decide whether a failed config request has a specific write error code to expose.

*Call graph*: called by 1 (map_error).


##### `ConfigManager::read`  (lines 109–151)

```
async fn read(
        &self,
        params: ConfigReadParams,
    ) -> Result<ConfigReadResponse, ConfigManagerError>
```

**Purpose**: Reads the current configuration as an API response. It can read with a current working directory, so project-specific config is included, or without one, so only global thread-agnostic layers are used.

**Data flow**: It receives read parameters, including an optional current directory and a flag asking for layer details. It loads the matching config layers, computes the effective combined config, converts that internal TOML data into the API Config type, and returns the config, origins, and optional layer list.

**Call relations**: This is the main read endpoint for clients. When there is no current directory, it calls ConfigManager::load_thread_agnostic_config; otherwise it loads config layers for the supplied directory before returning a ConfigReadResponse.

*Call graph*: calls 2 internal fn (load_thread_agnostic_config, try_from); 3 external calls (from, from_value, to_value).


##### `ConfigManager::read_requirements`  (lines 153–167)

```
async fn read_requirements(
        &self,
    ) -> Result<Option<ConfigRequirementsToml>, ConfigManagerError>
```

**Purpose**: Reads configuration requirements, such as feature requirements, from the global config layer stack. It returns nothing when no requirements are present.

**Data flow**: It loads the thread-agnostic configuration layers, takes the requirements TOML from them, checks whether it is empty, and returns either Some(requirements) or None.

**Call relations**: This is a smaller read endpoint beside ConfigManager::read. It relies on ConfigManager::load_thread_agnostic_config because requirements are not tied to a particular project directory here.

*Call graph*: calls 1 internal fn (load_thread_agnostic_config).


##### `ConfigManager::write_value`  (lines 169–176)

```
async fn write_value(
        &self,
        params: ConfigValueWriteParams,
    ) -> Result<ConfigWriteResponse, ConfigManagerError>
```

**Purpose**: Writes one configuration value. It is the simple single-setting version of the write API.

**Data flow**: It receives a file path, optional expected version, a key path, a JSON value, and a merge strategy. It wraps that one requested change into the common edit format and passes it to ConfigManager::apply_edits, then returns that result.

**Call relations**: API code calls this for a single config update. It does not do the heavy work itself; it hands off to ConfigManager::apply_edits so single writes and batch writes follow the same safety rules.

*Call graph*: calls 1 internal fn (apply_edits); 1 external calls (vec!).


##### `ConfigManager::batch_write`  (lines 178–190)

```
async fn batch_write(
        &self,
        params: ConfigBatchWriteParams,
    ) -> Result<ConfigWriteResponse, ConfigManagerError>
```

**Purpose**: Writes several configuration values as one request. This lets a client update related settings together with the same validation and version check.

**Data flow**: It receives batch write parameters, converts each edit into the shared internal tuple of key path, value, and merge strategy, and sends the full list to ConfigManager::apply_edits. The returned response describes the whole write.

**Call relations**: API code calls this for multi-setting updates. Like ConfigManager::write_value, it delegates the real edit, validation, and persistence flow to ConfigManager::apply_edits.

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

**Purpose**: Performs the safe write workflow for one or more config edits. It is the central gatekeeper that prevents writes to protected layers, avoids stale overwrites, validates new config, persists changes, and reports whether higher-priority config overrides the result.

**Data flow**: It receives an optional file path, an optional expected version, and a list of edits. It resolves the allowed user config path, rejects any other target path, loads current config layers, creates an empty user layer if needed, checks the version, parses each key path and JSON value, applies the requested changes to a TOML value, validates both the user layer and final effective config, writes edits to disk if anything changed, checks whether any edit is overridden by higher-priority layers, and returns a ConfigWriteResponse with status, version, file path, and optional override details.

**Call relations**: ConfigManager::write_value and ConfigManager::batch_write both call this so all writes share one safety path. During the flow it calls helpers such as parse_key_path, parse_value, apply_merge, create_empty_user_layer, validate_config, paths_match, toml_value_to_item, and first_overridden_edit.

*Call graph*: calls 14 internal fn (load_thread_agnostic_config, write, apply_merge, create_empty_user_layer, first_overridden_edit, parse_key_path, parse_value, paths_match, toml_value_to_item, validate_config (+4 more)); called by 2 (batch_write, write_value); 5 external calls (Borrowed, Owned, from, new, for_config_path).


##### `ConfigManager::load_thread_agnostic_config`  (lines 358–360)

```
async fn load_thread_agnostic_config(&self) -> std::io::Result<ConfigLayerStack>
```

**Purpose**: Loads configuration without using any project directory. In plain terms, it reads the config that applies globally, not settings from a particular repository's .codex folder.

**Data flow**: It takes the ConfigManager itself, calls the normal layer-loading method with no current directory, and returns the resulting ConfigLayerStack or an I/O error.

**Call relations**: ConfigManager::read uses this when the caller did not supply a current directory. ConfigManager::read_requirements and ConfigManager::apply_edits also use it because their work is based on the global/user configuration, not project-local context.

*Call graph*: called by 3 (apply_edits, read, read_requirements).


##### `create_empty_user_layer`  (lines 363–399)

```
async fn create_empty_user_layer(
    config_toml: &AbsolutePathBuf,
) -> Result<ConfigLayerEntry, ConfigManagerError>
```

**Purpose**: Creates a usable user config layer when no active user config layer was already loaded. It also creates an empty config file on disk if the user config file does not exist yet.

**Data flow**: It receives the expected config.toml path, resolves any symbolic-link write target, tries to read existing config text if there is a readable path, parses it as TOML when present, or writes an empty file and uses an empty TOML table when missing. It returns a new ConfigLayerEntry marked as the user layer.

**Call relations**: ConfigManager::apply_edits calls this when a write needs a user config layer but the loaded stack does not contain one. It uses write_empty_user_config for the actual creation of a missing file and ConfigManagerError::io or ConfigManagerError::toml to report failures.

*Call graph*: calls 4 internal fn (io, write_empty_user_config, new, as_path); called by 1 (apply_edits); 6 external calls (Table, resolve_symlink_write_paths, read_to_string, from_str, new, clone).


##### `write_empty_user_config`  (lines 401–406)

```
async fn write_empty_user_config(write_path: PathBuf) -> Result<(), ConfigManagerError>
```

**Purpose**: Creates an empty user config file safely. The safe write avoids leaving a half-written file if something fails partway through.

**Data flow**: It receives the path to write, runs the blocking disk write on a separate blocking task, writes empty text atomically, and returns success or a wrapped error.

**Call relations**: create_empty_user_layer calls this when the user config file is absent or there is no existing read path. It keeps the file-writing detail separate from the layer-building logic.

*Call graph*: called by 1 (create_empty_user_layer); 1 external calls (spawn_blocking).


##### `parse_value`  (lines 408–416)

```
fn parse_value(value: JsonValue) -> Result<Option<TomlValue>, String>
```

**Purpose**: Converts an API JSON value into the TOML value format used internally. A JSON null has a special meaning: clear this setting instead of setting it.

**Data flow**: It receives a JSON value. If the value is null, it returns None; otherwise it tries to decode the JSON as a TOML value and returns Some(value), or a readable validation message if conversion fails.

**Call relations**: ConfigManager::apply_edits calls this for every requested edit before applying it. The result tells apply_merge whether to set/merge a value or clear the path.

*Call graph*: called by 1 (apply_edits); 1 external calls (is_null).


##### `parse_key_path`  (lines 418–463)

```
fn parse_key_path(path: &str) -> Result<Vec<String>, String>
```

**Purpose**: Splits a user-facing key path like "tools.shell" into individual path pieces. It also supports quoted pieces so keys containing dots can still be addressed.

**Data flow**: It receives a key path string, rejects empty paths or empty segments, walks through the characters, splits on dots outside quotes, honors backslash escapes inside quotes, and returns a vector of segment strings or a validation message.

**Call relations**: ConfigManager::apply_edits calls this for each edit before looking up or changing a value. Later helpers, including value_at_path and apply_merge, use the parsed segments instead of the original string.

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

**Purpose**: Applies one parsed edit to an in-memory TOML config tree. It can set a value, merge a table into an existing table, or clear a value when the requested value is absent.

**Data flow**: It receives the root TOML value to mutate, a list of path segments, an optional new value, and a merge strategy. If the value is None, it delegates to clear_path. Otherwise it creates parent tables as needed, then either merges tables for an upsert or replaces the target value, returning whether the config actually changed.

**Call relations**: ConfigManager::apply_edits calls this after parsing each requested edit. It calls clear_path for removals and uses merge_toml_values when the upsert strategy should combine two TOML tables instead of replacing one with the other.

*Call graph*: calls 1 internal fn (clear_path); called by 1 (apply_edits); 5 external calls (Table, Validation, merge_toml_values, matches!, new).


##### `clear_path`  (lines 527–552)

```
fn clear_path(root: &mut TomlValue, segments: &[String]) -> Result<bool, MergeError>
```

**Purpose**: Removes a value from an in-memory TOML config tree. It treats missing paths as a harmless no-op rather than an error.

**Data flow**: It receives the root TOML value and path segments. It walks down through parent tables, stops with false if any parent is missing or not a table, removes the final key if possible, and returns true only when something was actually removed.

**Call relations**: apply_merge calls this when parse_value has turned a JSON null into a request to clear a setting.

*Call graph*: called by 1 (apply_merge); 1 external calls (Validation).


##### `toml_value_to_item`  (lines 554–566)

```
fn toml_value_to_item(value: &TomlValue) -> anyhow::Result<TomlItem>
```

**Purpose**: Converts a general TOML value into the editable TOML document format used for preserving and applying file edits. This is needed before saving a changed value back into config.toml.

**Data flow**: It receives a TOML value. If it is a table, it builds an editable TOML table and recursively converts each child; otherwise it converts the value into an editable TOML value item. It returns the editable item or an error.

**Call relations**: ConfigManager::apply_edits calls this when it has detected that an edit changed the user config and needs to build a ConfigEdit::SetPath. It relies on toml_value_to_value for non-table values and nested inline values.

*Call graph*: calls 1 internal fn (toml_value_to_value); called by 1 (apply_edits); 3 external calls (Table, Value, new).


##### `toml_value_to_value`  (lines 568–590)

```
fn toml_value_to_value(value: &TomlValue) -> anyhow::Result<toml_edit::Value>
```

**Purpose**: Converts TOML scalar values, arrays, and inline tables into the editable TOML value type. It is the lower-level converter used when building file edits.

**Data flow**: It receives a TOML value. Strings, numbers, booleans, and dates are copied into editable values; arrays are rebuilt item by item; tables are rebuilt as inline tables. It returns the editable value or an error.

**Call relations**: toml_value_to_item calls this for ordinary values and nested array/table contents while preparing changes that ConfigManager::apply_edits will persist.

*Call graph*: called by 1 (toml_value_to_item); 5 external calls (new, new, Array, InlineTable, from).


##### `validate_config`  (lines 592–595)

```
fn validate_config(value: &TomlValue) -> Result<(), toml::de::Error>
```

**Purpose**: Checks whether a TOML value can be understood as a valid Codex ConfigToml structure. This catches invalid setting names or wrong value shapes before anything is accepted.

**Data flow**: It receives a TOML value, clones it, tries to decode it into ConfigToml, and returns success if decoding works or a TOML decoding error if it does not.

**Call relations**: ConfigManager::apply_edits calls this after applying user edits and again after computing the final effective config, so both the saved user layer and the combined result are valid.

*Call graph*: called by 1 (apply_edits); 1 external calls (clone).


##### `paths_match`  (lines 597–599)

```
fn paths_match(expected: impl AsRef<Path>, provided: impl AsRef<Path>) -> bool
```

**Purpose**: Compares two file paths after normalizing them. This avoids false mismatches caused by harmless path spelling differences.

**Data flow**: It receives an expected path and a provided path, passes both to the shared path-normalization comparison helper, and returns true if they refer to the same allowed location.

**Call relations**: ConfigManager::apply_edits uses this before writing to make sure a client is only editing the user config path and not a managed, system, or project config file.

*Call graph*: called by 1 (apply_edits); 1 external calls (paths_match_after_normalization).


##### `value_at_path`  (lines 601–617)

```
fn value_at_path(root: &'a TomlValue, segments: &[String]) -> Option<&'a TomlValue>
```

**Purpose**: Looks up a nested value inside a TOML tree using parsed path segments. It can walk through tables by key and arrays by numeric index.

**Data flow**: It receives a root TOML value and path segments. Starting at the root, it follows each segment through tables or arrays; if any step is impossible, it returns None. If every step succeeds, it returns a reference to the found value.

**Call relations**: ConfigManager::apply_edits uses this to compare values before and after an edit. compute_override_metadata and find_effective_layer use it to decide whether a user's saved value is actually the value that wins after layer precedence is applied.

*Call graph*: called by 3 (apply_edits, compute_override_metadata, find_effective_layer); 1 external calls (try_from).


##### `override_message`  (lines 619–648)

```
fn override_message(layer: &ConfigLayerSource) -> String
```

**Purpose**: Turns the source of an overriding config layer into a human-readable explanation. This is what lets the API tell a user why their saved setting is not taking effect.

**Data flow**: It receives a ConfigLayerSource, matches the source type, includes useful identifying details such as a file path, domain, or name, and returns a message string.

**Call relations**: compute_override_metadata calls this after it has found which layer is winning over the user's edit.

*Call graph*: called by 1 (compute_override_metadata); 1 external calls (format!).


##### `compute_override_metadata`  (lines 650–679)

```
fn compute_override_metadata(
    layers: &ConfigLayerStack,
    effective: &TomlValue,
    segments: &[String],
) -> Option<OverriddenMetadata>
```

**Purpose**: Checks whether one edited setting is being overridden by another config layer and builds the explanation if so. This helps clients distinguish "write failed" from "write succeeded but a stronger rule wins."

**Data flow**: It receives the updated layer stack, the effective combined TOML value, and one edited path. It compares the value in the active user layer with the effective value, ignores cases where they match or both are missing, finds the layer that supplies the effective value, builds a message, converts the effective value to JSON, and returns OverriddenMetadata when an override exists.

**Call relations**: first_overridden_edit calls this for each edited path. It uses value_at_path to inspect config trees, find_effective_layer to locate the winning layer, and override_message to produce readable feedback.

*Call graph*: calls 4 internal fn (find_effective_layer, override_message, value_at_path, get_active_user_layer); called by 1 (first_overridden_edit).


##### `first_overridden_edit`  (lines 681–692)

```
fn first_overridden_edit(
    layers: &ConfigLayerStack,
    effective: &TomlValue,
    edits: &[Vec<String>],
) -> Option<OverriddenMetadata>
```

**Purpose**: Finds the first edit in a write request that ended up overridden by a higher-priority layer. It returns only the first override because the response has one override metadata slot.

**Data flow**: It receives the updated config layers, the effective combined config, and all edited paths. It checks each path in order with compute_override_metadata and returns the first metadata found, or None if all edits take effect normally.

**Call relations**: ConfigManager::apply_edits calls this after validating and possibly saving edits, just before building the final ConfigWriteResponse status.

*Call graph*: calls 1 internal fn (compute_override_metadata); called by 1 (apply_edits).


##### `find_effective_layer`  (lines 694–705)

```
fn find_effective_layer(
    layers: &ConfigLayerStack,
    segments: &[String],
) -> Option<ConfigLayerMetadata>
```

**Purpose**: Finds which config layer supplies a value for a given path when layers are considered from highest priority to lowest. This identifies the layer that is currently winning.

**Data flow**: It receives the config layer stack and path segments. It walks the layers from high precedence to low, checks whether each layer has a value at that path, and returns that layer's metadata for the first match, or None if no layer has it.

**Call relations**: compute_override_metadata calls this when it has detected that the user's value is not the effective value and needs to explain which layer is overriding it.

*Call graph*: calls 2 internal fn (value_at_path, layers_high_to_low); called by 1 (compute_override_metadata).


### Editable config persistence
These files implement the low-level TOML editing machinery and higher-level mutation pipeline used to persist user-editable configuration changes safely.

### `core/src/config/edit.rs`

`config` · `config update and persistence`

This file exists because many parts of the app need to change user settings: theme, model, key bindings, warning acknowledgements, server definitions, audio devices, feature flags, and more. Rather than letting every caller edit text files by hand, this file gives them a small menu of allowed changes called `ConfigEdit`. Think of it like a service desk form: callers say what they want changed, and this file knows exactly where that belongs in `config.toml`.

The main worker is `ConfigDocument`, which wraps a parsed TOML document. TOML is the human-readable config format used here. It can insert values, remove values, create missing tables, and update special structures such as MCP server entries or skill overrides. When replacing existing values, it tries to keep the user's comments and spacing, so the file does not get unnecessarily rewritten into an unfamiliar shape.

The public `apply_blocking` and `apply` functions read the config file, apply all requested edits as one batch, and write the result through an atomic write. An atomic write is like writing a new note on separate paper and swapping it in only when finished; it avoids leaving a half-written file behind. `ConfigEditsBuilder` is a convenience wrapper that lets callers chain several setting changes and save them together.

#### Function details

##### `syntax_theme_edit`  (lines 86–91)

```
fn syntax_theme_edit(name: &str) -> ConfigEdit
```

**Purpose**: Creates a config change that sets the terminal UI theme name. Callers use it when a user chooses a new syntax or display theme.

**Data flow**: It receives a theme name as text → builds a `ConfigEdit` that targets `tui.theme` in the TOML file → returns that edit without writing anything yet.

**Call relations**: The UI event handler calls this after a theme choice. The returned edit is later passed into the config persistence flow, where `ConfigDocument::apply` turns it into an actual file change.

*Call graph*: called by 1 (handle_event); 2 external calls (value, vec!).


##### `tui_pet_edit`  (lines 94–99)

```
fn tui_pet_edit(name: &str) -> ConfigEdit
```

**Purpose**: Creates a config change that sets the terminal UI pet name. It is used when the app records which pet, if any, the user selected.

**Data flow**: It receives the pet name → packages it as a TOML string at `tui.pet` → returns a `ConfigEdit` for later saving.

**Call relations**: Pet selection and pet disabling flows call this helper. It hands off a simple path-based edit that the generic config writer can apply.

*Call graph*: called by 2 (handle_pet_disabled, handle_pet_selection_loaded); 2 external calls (value, vec!).


##### `session_picker_view_edit`  (lines 102–107)

```
fn session_picker_view_edit(mode: SessionPickerViewMode) -> ConfigEdit
```

**Purpose**: Creates a config change for the session picker display mode. This lets the UI remember how the user wants sessions shown.

**Data flow**: It receives a `SessionPickerViewMode` value → converts it to text → returns an edit that writes that text to `tui.session_picker_view`.

**Call relations**: This is a small public helper for callers that want a ready-made edit. The edit is later consumed by the same path-writing logic used for other UI settings.

*Call graph*: 3 external calls (to_string, value, vec!).


##### `status_line_items_edit`  (lines 113–120)

```
fn status_line_items_edit(items: &[String]) -> ConfigEdit
```

**Purpose**: Creates a config change that replaces the ordered list of status line items. It deliberately writes even an empty list, because an empty list means “show nothing,” not “use the default.”

**Data flow**: It receives a slice of strings → copies them into a TOML array → returns an edit that writes the array to `tui.status_line`.

**Call relations**: A UI event handler calls this when the status line layout changes. The resulting edit is later applied through the generic `SetPath` path-writing branch.

*Call graph*: called by 1 (handle_event); 2 external calls (Value, vec!).


##### `status_line_use_colors_edit`  (lines 123–128)

```
fn status_line_use_colors_edit(enabled: bool) -> ConfigEdit
```

**Purpose**: Creates a config change that turns status line colors on or off. This records the user's color preference for future launches.

**Data flow**: It receives a boolean value → wraps it as a TOML value → returns an edit for `tui.status_line_use_colors`.

**Call relations**: A UI event handler calls this after the user changes the color setting. The config writer later stores the boolean in the file.

*Call graph*: called by 1 (handle_event); 2 external calls (value, vec!).


##### `terminal_title_items_edit`  (lines 134–141)

```
fn terminal_title_items_edit(items: &[String]) -> ConfigEdit
```

**Purpose**: Creates a config change that replaces the ordered list of terminal title parts. Like the status line list, an empty list is saved on purpose to mean title updates are disabled.

**Data flow**: It receives strings naming title components → copies them into a TOML array → returns an edit that writes `tui.terminal_title`.

**Call relations**: A UI event handler calls this when title settings change. The returned edit goes through the normal batched config save path.

*Call graph*: called by 1 (handle_event); 2 external calls (Value, vec!).


##### `keymap_binding_value`  (lines 143–150)

```
fn keymap_binding_value(keys: &[String]) -> TomlItem
```

**Purpose**: Converts one or more key names into the TOML shape used for a key binding. A single key is written as a string, while multiple alternatives are written as a list.

**Data flow**: It receives a list of key strings → checks whether there is exactly one key → returns either a TOML string or a TOML array.

**Call relations**: `keymap_bindings_edit` calls this before creating the larger edit. It hides the small format rule so callers do not need to know it.

*Call graph*: called by 1 (keymap_bindings_edit); 2 external calls (Value, value).


##### `keymap_bindings_edit`  (lines 153–163)

```
fn keymap_bindings_edit(context: &str, action: &str, keys: &[String]) -> ConfigEdit
```

**Purpose**: Creates a config change that replaces one key binding entry in the terminal UI keymap. It can store one key or several keys for the same action.

**Data flow**: It receives a keymap context, an action name, and key strings → builds the path `tui.keymap.<context>.<action>` → returns an edit containing the correctly shaped TOML value.

**Call relations**: `keymap_binding_edit` uses this for the one-key case, and key capture code uses it after recording a custom binding. The config writer later inserts the value at the requested path.

*Call graph*: calls 1 internal fn (keymap_binding_value); called by 2 (keymap_binding_edit, apply_keymap_capture); 1 external calls (vec!).


##### `keymap_binding_edit`  (lines 166–168)

```
fn keymap_binding_edit(context: &str, action: &str, key: &str) -> ConfigEdit
```

**Purpose**: Creates a config change for a single key binding. It is a convenience wrapper for the more general multi-key helper.

**Data flow**: It receives a context, action, and one key string → turns that key into a one-item list → returns the edit produced by `keymap_bindings_edit`.

**Call relations**: Callers use this when they only need one key. It immediately delegates to `keymap_bindings_edit` so the file format stays consistent.

*Call graph*: calls 1 internal fn (keymap_bindings_edit).


##### `keymap_binding_clear_edit`  (lines 171–180)

```
fn keymap_binding_clear_edit(context: &str, action: &str) -> ConfigEdit
```

**Purpose**: Creates a config change that removes one custom key binding. This lets the app fall back to defaults for that action.

**Data flow**: It receives a keymap context and action → builds the matching config path → returns a `ClearPath` edit that will delete that value.

**Call relations**: Keymap clearing code calls this after the user asks to remove a binding. The removal is later performed by `ConfigDocument::remove` through the generic clear path flow.

*Call graph*: called by 1 (apply_keymap_clear); 1 external calls (vec!).


##### `model_availability_nux_count_edits`  (lines 182–201)

```
fn model_availability_nux_count_edits(shown_count: &HashMap<String, u32>) -> Vec<ConfigEdit>
```

**Purpose**: Builds a set of edits that replace the stored “new user experience” display counts for model availability messages. The old table is cleared first so removed models do not leave stale counts behind.

**Data flow**: It receives a map from model slug to count → sorts the entries for stable output → returns one clear edit plus one set edit per model count.

**Call relations**: `ConfigEditsBuilder::set_model_availability_nux_count` calls this when adding these edits to a batch. The resulting list is applied in order by the persistence engine.

*Call graph*: called by 1 (set_model_availability_nux_count); 3 external calls (from, value, vec!).


##### `ConfigDocument::new`  (lines 214–216)

```
fn new(doc: DocumentMut) -> Self
```

**Purpose**: Wraps a parsed TOML document in the helper type that knows how to apply config edits. It marks the point where raw parsed data becomes an editable config document.

**Data flow**: It receives a `DocumentMut`, which is an editable TOML document → stores it inside `ConfigDocument` → returns the wrapper.

**Call relations**: `apply_blocking_to_resolved_file` calls this after reading and parsing the config file. Later, that same wrapper receives each `ConfigEdit` through `ConfigDocument::apply`.

*Call graph*: called by 1 (apply_blocking_to_resolved_file).


##### `ConfigDocument::apply`  (lines 218–337)

```
fn apply(&mut self, edit: &ConfigEdit) -> anyhow::Result<bool>
```

**Purpose**: Applies one requested config change to the in-memory TOML document. It is the central dispatcher that knows which specialized editing rule belongs to each `ConfigEdit` variant.

**Data flow**: It receives one edit → matches on the edit kind → writes, clears, replaces, or delegates to a specialized helper → returns whether the document actually changed, or an error if a delegated operation fails.

**Call relations**: The persistence loop calls this once for every edit in a batch. It hands off simple path writes to `write_value` or `insert`, removals to `clear_owned`, server updates to `replace_mcp_servers`, skill changes to `set_skill_config`, and project trust changes to existing config logic.

*Call graph*: calls 8 internal fn (add_tool_suggest_disabled_tool, clear_owned, insert, replace_mcp_servers, set_skill_config, write_optional_value, write_value, set_project_trust_level_inner); 3 external calls (Name, Path, value).


##### `ConfigDocument::write_optional_value`  (lines 339–344)

```
fn write_optional_value(&mut self, segments: &[&str], value: Option<TomlItem>) -> bool
```

**Purpose**: Writes a value if one is present, or removes the setting if it is absent. This is useful for settings where `None` means “clear the user's override.”

**Data flow**: It receives a path and an optional TOML value → if there is a value, it writes it; if not, it clears the path → returns whether anything changed.

**Call relations**: `ConfigDocument::apply` uses this for optional settings such as model, reasoning effort, service tier, and personality. It delegates the actual work to `write_value` or `clear`.

*Call graph*: calls 2 internal fn (clear, write_value); called by 1 (apply).


##### `ConfigDocument::write_value`  (lines 346–352)

```
fn write_value(&mut self, segments: &[&str], value: TomlItem) -> bool
```

**Purpose**: Writes a TOML value at a path expressed as borrowed string pieces. It is a small adapter around the document's general insert logic.

**Data flow**: It receives path segments like `notice.hide_full_access_warning` and a TOML value → converts the path into owned strings → inserts the value → returns whether the insert ran.

**Call relations**: `ConfigDocument::apply`, `write_optional_value`, and `add_tool_suggest_disabled_tool` call this when they need to store a value. It passes the real insertion to `ConfigDocument::insert`.

*Call graph*: calls 1 internal fn (insert); called by 3 (add_tool_suggest_disabled_tool, apply, write_optional_value).


##### `ConfigDocument::clear`  (lines 354–360)

```
fn clear(&mut self, segments: &[&str]) -> bool
```

**Purpose**: Removes a setting at a path expressed as borrowed string pieces. It is the counterpart to `write_value` for deletion.

**Data flow**: It receives path segments → converts them into owned strings → removes the matching value if the parent table exists → returns whether a value was removed.

**Call relations**: `write_optional_value` calls this when an optional setting should be cleared, and `replace_mcp_servers` calls it when all MCP servers are removed. It delegates to `ConfigDocument::remove`.

*Call graph*: calls 1 internal fn (remove); called by 2 (replace_mcp_servers, write_optional_value).


##### `ConfigDocument::add_tool_suggest_disabled_tool`  (lines 362–394)

```
fn add_tool_suggest_disabled_tool(&mut self, disabled_tool: &ToolSuggestDisabledTool) -> bool
```

**Purpose**: Adds one disabled tool suggestion to the config without duplicating existing entries. It also normalizes older and newer TOML shapes into one clean stored list.

**Data flow**: It reads any current `tool_suggest.disabled_tools` entries → parses entries from either array or table form → adds the new tool, normalizes and deduplicates the list → writes the cleaned list back.

**Call relations**: `ConfigDocument::apply` calls this for the `AddToolSuggestDisabledTool` edit. It uses helper functions from `document_helpers` to parse and serialize the tool entries, then writes the final value with `write_value`.

*Call graph*: calls 2 internal fn (write_value, tool_suggest_disabled_tools_value); called by 1 (apply); 4 external calls (get, new, clone, once).


##### `ConfigDocument::clear_owned`  (lines 396–398)

```
fn clear_owned(&mut self, segments: &[String]) -> bool
```

**Purpose**: Removes a setting at a path that is already stored as owned strings. It exists so `ClearPath` edits can go straight to the removal logic.

**Data flow**: It receives a vector-like slice of path segments → asks `remove` to delete that path → returns whether something was removed.

**Call relations**: `ConfigDocument::apply` calls this for generic `ClearPath` edits. It is a thin bridge to `ConfigDocument::remove`.

*Call graph*: calls 1 internal fn (remove); called by 1 (apply).


##### `ConfigDocument::replace_mcp_servers`  (lines 400–451)

```
fn replace_mcp_servers(&mut self, servers: &BTreeMap<String, McpServerConfig>) -> bool
```

**Purpose**: Replaces the whole `[mcp_servers]` section with the supplied server map. It removes servers no longer present and updates or inserts the remaining ones.

**Data flow**: It receives an ordered map of server names to server configs → clears the section if the map is empty, otherwise ensures the table exists → removes old unknown keys → serializes each supplied server into TOML → returns true when it has performed the replacement work.

**Call relations**: `ConfigDocument::apply` calls this for `ReplaceMcpServers`. It relies on `document_helpers` to create writable tables and serialize server config while preserving inline tables when possible.

*Call graph*: calls 6 internal fn (clear, ensure_table_for_write, merge_inline_table, new_implicit_table, serialize_mcp_server, serialize_mcp_server_inline); called by 1 (apply); 2 external calls (as_table_mut, Table).


##### `ConfigDocument::set_skill_config`  (lines 453–562)

```
fn set_skill_config(&mut self, selector: SkillConfigSelector, enabled: bool) -> bool
```

**Purpose**: Adds or removes a skill override under `[[skills.config]]`. In this file, `enabled = false` means the user has disabled a skill; enabling a skill removes that override so defaults can apply again.

**Data flow**: It receives a selector, either skill name or path, and a desired enabled flag → normalizes the selector → finds a matching override table if one exists → removes it for enabled skills, or creates/updates it with `enabled = false` for disabled skills → cleans up empty parent tables → returns whether it changed the document.

**Call relations**: `ConfigDocument::apply` calls this for skill config edits. It uses `normalize_skill_config_path`, `skill_config_selector_from_table`, and `write_skill_config_selector` to compare and write entries consistently.

*Call graph*: calls 4 internal fn (ensure_table_for_write, new_implicit_table, normalize_skill_config_path, write_skill_config_selector); called by 1 (apply); 10 external calls (new, as_table_mut, from, ArrayOfTables, Table, new, Name, Path, matches!, value).


##### `ConfigDocument::insert`  (lines 564–579)

```
fn insert(&mut self, segments: &[String], value: TomlItem) -> bool
```

**Purpose**: Inserts or replaces a TOML item at an exact dotted path, creating parent tables when needed. It also preserves comments and spacing from the previous value where possible.

**Data flow**: It receives path segments and a TOML item → separates the final key from its parent path → descends through or creates parent tables → copies formatting decoration from any existing value → stores the replacement → returns whether the operation could run.

**Call relations**: `ConfigDocument::apply` uses this for generic `SetPath` edits, and `write_value` uses it for many named edits. It depends on `descend` to find the parent table and on `preserve_decor` to keep human-friendly formatting.

*Call graph*: calls 1 internal fn (descend); called by 2 (apply, write_value); 1 external calls (preserve_decor).


##### `ConfigDocument::remove`  (lines 581–591)

```
fn remove(&mut self, segments: &[String]) -> bool
```

**Purpose**: Removes a TOML item at an exact dotted path, but only if the parent tables already exist. It avoids creating new tables just to delete something.

**Data flow**: It receives path segments → finds the parent table in existing-read mode → removes the final key if present → returns true only when a value was actually removed.

**Call relations**: `clear` and `clear_owned` call this for all delete operations. It relies on `descend` to safely locate the parent table.

*Call graph*: calls 1 internal fn (descend); called by 2 (clear, clear_owned).


##### `ConfigDocument::descend`  (lines 593–617)

```
fn descend(&mut self, segments: &[String], mode: TraversalMode) -> Option<&mut TomlTable>
```

**Purpose**: Walks through nested TOML tables and returns the table at the end of the path. Depending on the mode, it either creates missing tables or only follows tables that already exist.

**Data flow**: It starts at the document root → for each segment, either creates/ensures a writable table or reads an existing table → returns the final mutable table, or nothing if the path cannot be followed.

**Call relations**: `insert` calls this in create mode so new paths can be made. `remove` calls it in existing mode so deletion stays non-invasive.

*Call graph*: calls 3 internal fn (ensure_table_for_read, ensure_table_for_write, new_implicit_table); called by 2 (insert, remove); 2 external calls (as_table_mut, Table).


##### `ConfigDocument::preserve_decor`  (lines 619–648)

```
fn preserve_decor(existing: &TomlItem, replacement: &mut TomlItem)
```

**Purpose**: Copies TOML formatting decoration from an old item to a replacement item. Decoration includes things like comments, whitespace, and key styling that matter to people editing the file by hand.

**Data flow**: It receives an existing TOML item and a replacement TOML item → if their shapes match, copies formatting metadata and recursively does the same for nested table entries → mutates the replacement in place.

**Call relations**: `ConfigDocument::insert` calls this before overwriting an existing value. This keeps automatic config edits from needlessly erasing the user's file layout.

*Call graph*: 1 external calls (preserve_decor).


##### `normalize_skill_config_path`  (lines 651–656)

```
fn normalize_skill_config_path(path: &Path) -> String
```

**Purpose**: Turns a skill path into a stable text form for comparison and storage. It tries to resolve symbolic links and relative pieces, but falls back to the original path if that fails.

**Data flow**: It receives a filesystem path → attempts to canonicalize it → converts the chosen path to a string → returns that string.

**Call relations**: `ConfigDocument::set_skill_config` uses this before storing path-based skill selectors. `skill_config_selector_from_table` also uses it when reading existing table entries.

*Call graph*: called by 1 (set_skill_config); 1 external calls (canonicalize).


##### `skill_config_selector_from_table`  (lines 658–675)

```
fn skill_config_selector_from_table(table: &TomlTable) -> Option<SkillConfigSelector>
```

**Purpose**: Reads one `[[skills.config]]` table and figures out which skill it refers to. A valid entry must identify a skill by either path or name, but not both.

**Data flow**: It receives a TOML table → looks for a non-empty `name` or a `path` string → normalizes paths when present → returns a `SkillConfigSelector` only when exactly one selector is valid.

**Call relations**: `ConfigDocument::set_skill_config` uses this while scanning existing skill override tables to find the one that matches the requested skill.

*Call graph*: 1 external calls (get).


##### `write_skill_config_selector`  (lines 677–688)

```
fn write_skill_config_selector(table: &mut TomlTable, selector: &SkillConfigSelector)
```

**Purpose**: Writes the identifying part of a skill override table. It ensures the table uses either `name` or `path`, never both.

**Data flow**: It receives a mutable TOML table and a selector → removes the opposite selector key → writes the selected name or path value into the table.

**Call relations**: `ConfigDocument::set_skill_config` calls this when updating an existing disabled override or creating a new one.

*Call graph*: called by 1 (set_skill_config); 2 external calls (remove, value).


##### `apply_blocking`  (lines 691–694)

```
fn apply_blocking(codex_home: &Path, edits: &[ConfigEdit]) -> anyhow::Result<()>
```

**Purpose**: Synchronously saves a batch of config edits to the default config file under the given Codex home directory. Callers use it when they are already allowed to block the current thread.

**Data flow**: It receives the Codex home path and a list of edits → appends the standard config filename → passes the resolved target and edits to the lower-level writer → returns success or an error.

**Call relations**: Tests and blocking callers use this public entry point. It delegates all reading, editing, and writing to `apply_blocking_to_resolved_file`.

*Call graph*: calls 1 internal fn (apply_blocking_to_resolved_file); called by 13 (replace_mcp_servers_round_trips_entries, replace_mcp_servers_serializes_cwd, replace_mcp_servers_serializes_disabled_flag, replace_mcp_servers_serializes_env_sorted, replace_mcp_servers_serializes_env_vars, replace_mcp_servers_serializes_required_flag, replace_mcp_servers_serializes_sourced_env_vars, replace_mcp_servers_serializes_tool_filters, replace_mcp_servers_streamable_http_isolates_headers_between_servers, replace_mcp_servers_streamable_http_removes_optional_sections (+3 more)); 1 external calls (join).


##### `apply_blocking_to_resolved_file`  (lines 696–739)

```
fn apply_blocking_to_resolved_file(
    resolved_config_file: &Path,
    edits: &[ConfigEdit],
) -> anyhow::Result<()>
```

**Purpose**: Performs the full read-edit-write cycle for a specific config file path. This is the core persistence routine.

**Data flow**: It receives a config file path and edits → exits early if there are no edits → resolves symlink-safe read and write paths → reads existing TOML or starts with an empty document → applies each edit through `ConfigDocument::apply` → if anything changed, writes the new TOML atomically → returns success or a detailed error.

**Call relations**: `apply_blocking`, async `apply`, and both builder apply methods call this. It creates `ConfigDocument` with `ConfigDocument::new`, then drives the whole batch through `ConfigDocument::apply`.

*Call graph*: calls 1 internal fn (new); called by 2 (apply_blocking, apply_blocking); 6 external calls (new, new, is_empty, resolve_symlink_write_paths, write_atomically, read_to_string).


##### `apply`  (lines 743–749)

```
async fn apply(codex_home: &Path, edits: Vec<ConfigEdit>) -> anyhow::Result<()>
```

**Purpose**: Asynchronously saves a batch of config edits without blocking the async runtime. It is used when the caller is in async code but file writing still needs normal blocking filesystem calls.

**Data flow**: It receives the Codex home path and owned edits → builds the config path → moves the blocking work onto a dedicated blocking thread → returns the writer's result or an error if the task panicked.

**Call relations**: Async callers use this instead of `apply_blocking`. Inside the spawned blocking task, it delegates to `apply_blocking_to_resolved_file`.

*Call graph*: 3 external calls (join, to_path_buf, spawn_blocking).


##### `ConfigEditsBuilder::new`  (lines 759–761)

```
fn new(codex_home: &Path) -> Self
```

**Purpose**: Starts a new edit builder for the standard config file in a Codex home directory. It gives callers a fluent way to collect several changes before saving.

**Data flow**: It receives the Codex home path → appends the standard config filename → creates a builder for that file with an empty edit list.

**Call relations**: Callers begin a chained editing flow here when they know the home directory. It delegates construction to `ConfigEditsBuilder::for_config_path`.

*Call graph*: 2 external calls (join, for_config_path).


##### `ConfigEditsBuilder::for_config`  (lines 763–770)

```
fn for_config(config: &crate::config::Config) -> Self
```

**Purpose**: Starts a builder using the config file path chosen by an already loaded runtime config. This respects layered config setups where the user config file may not be the simple default path.

**Data flow**: It receives a loaded `Config` → asks its config layer stack for the user config file → falls back to `codex_home/config.toml` if needed → returns a builder for that path.

**Call relations**: Callers with a full `Config` use this to avoid guessing where edits should be saved. It finishes by calling `for_config_path`.

*Call graph*: 1 external calls (for_config_path).


##### `ConfigEditsBuilder::for_config_path`  (lines 772–777)

```
fn for_config_path(config_path: &Path) -> Self
```

**Purpose**: Starts a builder for an exact config file path. This is the most direct constructor.

**Data flow**: It receives a path → copies it into the builder → initializes an empty edit list → returns the builder.

**Call relations**: `ConfigEditsBuilder::new` and `for_config` both delegate here. Later builder methods add edits to the stored list.

*Call graph*: 2 external calls (to_path_buf, new).


##### `ConfigEditsBuilder::set_model`  (lines 779–785)

```
fn set_model(mut self, model: Option<&str>, effort: Option<ReasoningEffort>) -> Self
```

**Purpose**: Adds an edit that sets or clears the model and optional reasoning effort. It lets callers update both related model choices in one builder step.

**Data flow**: It receives an optional model string and optional reasoning effort → copies the model text if present → appends a `SetModel` edit → returns the builder for chaining.

**Call relations**: This is part of the fluent builder API. The saved edit is interpreted later by `ConfigDocument::apply`, which writes or clears the relevant top-level keys.


##### `ConfigEditsBuilder::set_service_tier`  (lines 787–790)

```
fn set_service_tier(mut self, service_tier: Option<String>) -> Self
```

**Purpose**: Adds an edit that sets or clears the preferred service tier. A service tier is the user's preference for how requests should be served, such as faster or flexible service.

**Data flow**: It receives an optional service tier string → appends a `SetServiceTier` edit → returns the builder.

**Call relations**: The builder stores the request until `apply` or `apply_blocking` is called. `ConfigDocument::apply` later writes the config spelling, including compatibility handling for legacy names.


##### `ConfigEditsBuilder::set_personality`  (lines 792–796)

```
fn set_personality(mut self, personality: Option<Personality>) -> Self
```

**Purpose**: Adds an edit that sets or clears the model personality. Personality is a named style or behavior preference for model responses.

**Data flow**: It receives an optional personality value → appends a `SetModelPersonality` edit → returns the builder for more chained calls.

**Call relations**: This only records the desired change. The actual TOML update happens later in `ConfigDocument::apply`.


##### `ConfigEditsBuilder::set_hide_full_access_warning`  (lines 798–802)

```
fn set_hide_full_access_warning(mut self, acknowledged: bool) -> Self
```

**Purpose**: Adds an edit recording whether the user has acknowledged the full-access warning. This prevents repeatedly showing a warning the user has already dismissed.

**Data flow**: It receives a boolean acknowledgement → appends the matching notice edit → returns the builder.

**Call relations**: When the batch is saved, `ConfigDocument::apply` writes the boolean under the `[notice]` table.

*Call graph*: 1 external calls (SetNoticeHideFullAccessWarning).


##### `ConfigEditsBuilder::set_hide_world_writable_warning`  (lines 804–808)

```
fn set_hide_world_writable_warning(mut self, acknowledged: bool) -> Self
```

**Purpose**: Adds an edit recording whether the user has acknowledged the Windows world-writable directory warning. This stores the dismissal state in config.

**Data flow**: It receives a boolean → appends a notice edit for `hide_world_writable_warning` → returns the builder.

**Call relations**: The builder later hands this edit to the persistence routine, where `ConfigDocument::apply` writes it under `[notice]`.

*Call graph*: 1 external calls (SetNoticeHideWorldWritableWarning).


##### `ConfigEditsBuilder::set_hide_rate_limit_model_nudge`  (lines 810–814)

```
fn set_hide_rate_limit_model_nudge(mut self, acknowledged: bool) -> Self
```

**Purpose**: Adds an edit recording whether the user has dismissed the rate limit model nudge. This avoids showing the same suggestion again after acknowledgement.

**Data flow**: It receives a boolean acknowledgement → stores a `SetNoticeHideRateLimitModelNudge` edit → returns the builder.

**Call relations**: The actual file write is delayed until builder application, then performed by `ConfigDocument::apply`.

*Call graph*: 1 external calls (SetNoticeHideRateLimitModelNudge).


##### `ConfigEditsBuilder::set_hide_model_migration_prompt`  (lines 816–823)

```
fn set_hide_model_migration_prompt(mut self, model: &str, acknowledged: bool) -> Self
```

**Purpose**: Adds an edit recording whether a specific model migration prompt should be hidden. This is used when the app suggests moving from one model setting to another.

**Data flow**: It receives the model or migration key and a boolean → copies the key into an edit → appends it to the builder → returns the builder.

**Call relations**: Later, `ConfigDocument::apply` writes the boolean under the `[notice]` table using that migration key.

*Call graph*: 1 external calls (SetNoticeHideModelMigrationPrompt).


##### `ConfigEditsBuilder::set_hide_external_config_migration_prompt_home`  (lines 825–831)

```
fn set_hide_external_config_migration_prompt_home(mut self, acknowledged: bool) -> Self
```

**Purpose**: Adds an edit recording whether the home-level external config migration prompt has been acknowledged. This keeps the prompt from being repeated unnecessarily.

**Data flow**: It receives a boolean → appends the home migration prompt notice edit → returns the builder.

**Call relations**: When saved, `ConfigDocument::apply` writes the value under `notice.external_config_migration_prompts.home`.

*Call graph*: 1 external calls (SetNoticeHideExternalConfigMigrationPromptHome).


##### `ConfigEditsBuilder::set_hide_external_config_migration_prompt_project`  (lines 833–845)

```
fn set_hide_external_config_migration_prompt_project(
        mut self,
        project: &str,
        acknowledged: bool,
    ) -> Self
```

**Purpose**: Adds an edit recording whether a project-specific external config migration prompt has been acknowledged. This stores the state separately for each project.

**Data flow**: It receives a project identifier and a boolean → copies the project string into the edit → appends it → returns the builder.

**Call relations**: The persistence pass later routes the edit through `ConfigDocument::apply`, which writes it under the project prompt notice section.

*Call graph*: 1 external calls (SetNoticeHideExternalConfigMigrationPromptProject).


##### `ConfigEditsBuilder::record_model_migration_seen`  (lines 847–853)

```
fn record_model_migration_seen(mut self, from: &str, to: &str) -> Self
```

**Purpose**: Adds an edit that records a seen old-model to new-model migration mapping. This lets the app remember that it has already shown or processed that migration.

**Data flow**: It receives the source model and target model strings → copies both into a `RecordModelMigrationSeen` edit → returns the builder.

**Call relations**: When applied, `ConfigDocument::apply` writes the mapping under `notice.model_migrations`.


##### `ConfigEditsBuilder::set_model_availability_nux_count`  (lines 855–859)

```
fn set_model_availability_nux_count(mut self, shown_count: &HashMap<String, u32>) -> Self
```

**Purpose**: Adds edits that replace the stored counts for model availability onboarding messages. It records how many times each model's message has been shown.

**Data flow**: It receives a map of model slugs to counts → asks `model_availability_nux_count_edits` to turn the map into clear-and-set edits → extends the builder's edit list → returns the builder.

**Call relations**: This builder method delegates the edit construction to `model_availability_nux_count_edits`. The final batch is applied in order by the persistence routine.

*Call graph*: calls 1 internal fn (model_availability_nux_count_edits).


##### `ConfigEditsBuilder::replace_mcp_servers`  (lines 861–865)

```
fn replace_mcp_servers(mut self, servers: &BTreeMap<String, McpServerConfig>) -> Self
```

**Purpose**: Adds an edit that replaces all configured MCP servers. MCP servers are external tool/context servers the app can connect to.

**Data flow**: It receives an ordered server map → clones it into a `ReplaceMcpServers` edit → appends the edit → returns the builder.

**Call relations**: When the builder is saved, `ConfigDocument::apply` delegates this edit to `ConfigDocument::replace_mcp_servers`.

*Call graph*: 1 external calls (ReplaceMcpServers).


##### `ConfigEditsBuilder::set_project_trust_level`  (lines 867–877)

```
fn set_project_trust_level(
        mut self,
        project_path: P,
        trust_level: TrustLevel,
    ) -> Self
```

**Purpose**: Adds an edit that sets the trust level for a project path. Trust level records how much the app should trust or restrict behavior for that project.

**Data flow**: It receives a project path and trust level → converts the path into a `PathBuf` → appends a `SetProjectTrustLevel` edit → returns the builder.

**Call relations**: Later, `ConfigDocument::apply` hands this to existing project trust update logic so table migration rules stay consistent with the rest of the config system.

*Call graph*: 1 external calls (into).


##### `ConfigEditsBuilder::set_feature_enabled`  (lines 884–899)

```
fn set_feature_enabled(mut self, key: &str, enabled: bool) -> Self
```

**Purpose**: Adds an edit to enable or disable a named feature flag under `[features]`. It avoids writing `false` for features that default to off, so the config does not accidentally pin a feature off after it becomes generally enabled later.

**Data flow**: It receives a feature key and enabled flag → checks the feature registry for the default value → either appends a set edit with a boolean or a clear edit for that key → returns the builder.

**Call relations**: Callers use this to change feature flags safely. The resulting `SetPath` or `ClearPath` edit is later processed by `ConfigDocument::apply`.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_windows_sandbox_mode`  (lines 901–907)

```
fn set_windows_sandbox_mode(mut self, mode: &str) -> Self
```

**Purpose**: Adds an edit that stores the Windows sandbox mode. This records how Windows sandboxing should behave on future runs.

**Data flow**: It receives a mode string → builds the path `windows.sandbox` → appends a set edit with that string → returns the builder.

**Call relations**: The builder stores this generic path edit until save time. `ConfigDocument::apply` later inserts the value.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_realtime_microphone`  (lines 909–919)

```
fn set_realtime_microphone(mut self, microphone: Option<&str>) -> Self
```

**Purpose**: Adds an edit that sets or clears the preferred realtime microphone device. Clearing means the app should stop using a saved override.

**Data flow**: It receives an optional microphone name → if present, appends a set edit for `audio.microphone`; if absent, appends a clear edit → returns the builder.

**Call relations**: The actual TOML change happens when the builder is applied, through `ConfigDocument::apply` and the generic path insert or remove logic.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_realtime_speaker`  (lines 921–931)

```
fn set_realtime_speaker(mut self, speaker: Option<&str>) -> Self
```

**Purpose**: Adds an edit that sets or clears the preferred realtime speaker device. This lets audio output device choice persist across runs.

**Data flow**: It receives an optional speaker name → turns it into either a set edit for `audio.speaker` or a clear edit → returns the builder.

**Call relations**: This method only queues the change. The save path later applies it with the same generic `SetPath` or `ClearPath` machinery used by other settings.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::set_realtime_voice`  (lines 933–943)

```
fn set_realtime_voice(mut self, voice: Option<&str>) -> Self
```

**Purpose**: Adds an edit that sets or clears the realtime voice name. This controls which voice should be used for realtime audio responses.

**Data flow**: It receives an optional voice string → appends either a set edit for `realtime.voice` or a clear edit → returns the builder.

**Call relations**: The queued edit is later consumed by `ConfigDocument::apply`, which writes or removes the path.

*Call graph*: 2 external calls (value, vec!).


##### `ConfigEditsBuilder::clear_legacy_windows_sandbox_keys`  (lines 945–955)

```
fn clear_legacy_windows_sandbox_keys(mut self) -> Self
```

**Purpose**: Adds edits that remove old Windows sandbox feature keys. This cleans up obsolete setting names after the config format has moved on.

**Data flow**: It loops over the legacy key names → for each one, appends a clear edit under `[features]` → returns the builder.

**Call relations**: Callers use this during migration or cleanup flows. The delete edits are later processed by `ConfigDocument::apply` through `ClearPath`.

*Call graph*: 1 external calls (vec!).


##### `ConfigEditsBuilder::set_session_picker_view`  (lines 957–963)

```
fn set_session_picker_view(mut self, mode: SessionPickerViewMode) -> Self
```

**Purpose**: Adds an edit that saves the preferred session picker view mode. This is the builder-style version of the standalone session picker edit helper.

**Data flow**: It receives a view mode → converts it to text → appends a set edit for `tui.session_picker_view` → returns the builder.

**Call relations**: The builder later applies this edit with the generic path-writing branch in `ConfigDocument::apply`.

*Call graph*: 3 external calls (to_string, value, vec!).


##### `ConfigEditsBuilder::with_edits`  (lines 965–971)

```
fn with_edits(mut self, edits: I) -> Self
```

**Purpose**: Adds an existing collection of config edits to the builder. It is useful when another helper already prepared edits and the caller wants to save them in the same atomic batch.

**Data flow**: It receives any iterable collection of `ConfigEdit` values → appends them to the builder's edit list → returns the builder.

**Call relations**: This connects standalone edit helpers with the fluent builder flow. The combined list is written together when `apply` or `apply_blocking` is called.


##### `ConfigEditsBuilder::apply_blocking`  (lines 974–976)

```
fn apply_blocking(self) -> anyhow::Result<()>
```

**Purpose**: Synchronously writes all edits collected in the builder. It is the builder's blocking save button.

**Data flow**: It consumes the builder → passes its stored config path and edit list to the low-level blocking writer → returns success or an error.

**Call relations**: Callers use this at the end of a builder chain when blocking is acceptable. It delegates the whole persistence process to `apply_blocking_to_resolved_file`.

*Call graph*: calls 1 internal fn (apply_blocking_to_resolved_file).


##### `ConfigEditsBuilder::apply`  (lines 979–985)

```
async fn apply(self) -> anyhow::Result<()>
```

**Purpose**: Asynchronously writes all edits collected in the builder without blocking the async runtime. It is the builder's async save button.

**Data flow**: It consumes the builder → moves the config path and edits into a blocking task → that task performs the file update → returns the result or a panic-context error.

**Call relations**: Async callers use this at the end of a builder chain. Inside the blocking task it uses the same `apply_blocking_to_resolved_file` routine as all other save paths.

*Call graph*: 1 external calls (spawn_blocking).


### `core/src/config/edit/document_helpers.rs`

`config` · `config edit`

This file is like a small toolbox for editing a structured settings document without damaging its shape. The settings file uses TOML, a human-readable configuration format with tables, arrays, and simple values. When other code wants to update a section, it may find that the section is missing, written as a compact inline table, or already written as a full table. These helpers smooth over those differences so the rest of the editor can work with normal tables.

A large part of the file is about MCP server configuration. An MCP server is an external tool server the app can talk to. The code takes a Rust configuration object and writes only the meaningful fields into TOML: commands, URLs, environment variables, timeouts, tool approval rules, OAuth settings, and per-tool overrides. It also sorts some entries so the saved file is stable and easier to read.

The file also preserves formatting where it can. For example, when replacing an inline table, it keeps existing decoration such as spacing around values. That matters because configuration files are often edited by people, and needless formatting churn makes changes harder to review. Without this file, higher-level config editing code would have to repeat many small, error-prone details about TOML shape, defaults, and conversion rules.

#### Function details

##### `ensure_table_for_write`  (lines 15–33)

```
fn ensure_table_for_write(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Makes sure a TOML item can be edited as a table. If the item is missing or is a compact inline table, it turns it into a normal table so new keys can be written into it.

**Data flow**: It receives a mutable TOML item. If that item is already a table, it returns it. If it is an inline table, it expands it into a regular table. If it is empty, it creates a new implicit table. If it is some other kind of value that cannot safely become a table, it replaces it with a new implicit table for writing. The result is either a mutable table reference or nothing if the item type is unsupported.

**Call relations**: Higher-level editing paths such as descend, replace_mcp_servers, and set_skill_config call this when they need to create or update nested configuration sections. It uses table_from_inline to expand compact tables and new_implicit_table when a fresh table is needed.

*Call graph*: calls 2 internal fn (new_implicit_table, table_from_inline); called by 3 (descend, replace_mcp_servers, set_skill_config); 2 external calls (Table, as_table_mut).


##### `ensure_table_for_read`  (lines 35–45)

```
fn ensure_table_for_read(item: &mut TomlItem) -> Option<&mut TomlTable>
```

**Purpose**: Makes sure a TOML item can be read as a table, but without inventing a table for unrelated values. It is stricter than the write version because reading should not silently reinterpret invalid data.

**Data flow**: It receives a mutable TOML item. If the item is a normal table, it returns that table. If the item is an inline table, it converts it to a regular table and returns it. If the item is missing or is not table-like, it returns nothing.

**Call relations**: The descend helper calls this when walking through a configuration path for reading. It delegates inline-table expansion to table_from_inline so later code can treat compact and full TOML tables the same way.

*Call graph*: calls 1 internal fn (table_from_inline); called by 1 (descend); 2 external calls (Table, as_table_mut).


##### `serialize_mcp_server_table`  (lines 47–163)

```
fn serialize_mcp_server_table(config: &McpServerConfig) -> TomlTable
```

**Purpose**: Turns an in-memory MCP server configuration into a full TOML table. This is the main conversion step used before saving MCP server settings back to the config file.

**Data flow**: It receives an McpServerConfig object. It checks which transport the server uses, such as a local command run through standard input/output or a streamable HTTP URL, then writes the matching fields. It also adds optional settings like enabled state, environment ID, required flag, timeouts, approval mode, tool lists, OAuth data, scopes, and per-tool settings when those fields are present or non-default. It returns a TOML table ready to place into the document.

**Call relations**: serialize_mcp_server and serialize_mcp_server_inline both call this as their shared core. Inside, it uses smaller helpers to build arrays, environment-variable arrays, sorted key-value tables, nested tool tables, and implicit parent tables.

*Call graph*: calls 6 internal fn (is_local_environment, array_from_env_vars, array_from_iter, new_implicit_table, serialize_mcp_server_tool, table_from_pairs); called by 2 (serialize_mcp_server, serialize_mcp_server_inline); 3 external calls (Table, new, value).


##### `serialize_mcp_server_tool`  (lines 165–176)

```
fn serialize_mcp_server_tool(config: &McpServerToolConfig) -> TomlItem
```

**Purpose**: Turns one per-tool MCP configuration into a TOML item. At present, this mainly records the approval rule for that tool when one is set.

**Data flow**: It receives an McpServerToolConfig. If the tool has an approval mode, it writes that mode as a string such as auto, prompt, or approve into a new TOML table. It returns that table wrapped as a TOML item.

**Call relations**: serialize_mcp_server_table calls this while writing the nested tools section of an MCP server. Each individual tool configuration is converted separately before being inserted under its tool name.

*Call graph*: called by 1 (serialize_mcp_server_table); 3 external calls (Table, new, value).


##### `serialize_mcp_server`  (lines 178–180)

```
fn serialize_mcp_server(config: &McpServerConfig) -> TomlItem
```

**Purpose**: Wraps a serialized MCP server table as a normal TOML item. This is used when the server should be written as a full table in the config document.

**Data flow**: It receives an McpServerConfig, passes it to serialize_mcp_server_table, and wraps the resulting table in a TOML item. The output can be inserted directly into the document tree.

**Call relations**: replace_mcp_servers calls this when it needs to replace or write MCP server entries as regular TOML tables. It relies on serialize_mcp_server_table for all field-by-field conversion work.

*Call graph*: calls 1 internal fn (serialize_mcp_server_table); called by 1 (replace_mcp_servers); 1 external calls (Table).


##### `serialize_mcp_server_inline`  (lines 182–184)

```
fn serialize_mcp_server_inline(config: &McpServerConfig) -> InlineTable
```

**Purpose**: Creates a compact inline TOML representation of an MCP server configuration. This is useful when an existing config entry is written on one line and the editor wants to preserve that style.

**Data flow**: It receives an McpServerConfig, builds the same table representation used for normal output, then converts that table into an inline table. The result is a compact TOML structure.

**Call relations**: replace_mcp_servers calls this when updating MCP server entries that should remain inline. It shares the same serialization rules as serialize_mcp_server through serialize_mcp_server_table.

*Call graph*: calls 1 internal fn (serialize_mcp_server_table); called by 1 (replace_mcp_servers).


##### `merge_inline_table`  (lines 186–198)

```
fn merge_inline_table(existing: &mut InlineTable, replacement: InlineTable)
```

**Purpose**: Updates an existing inline TOML table to match a replacement while keeping existing formatting decorations where possible. This avoids unnecessary visual changes in a user’s config file.

**Data flow**: It receives an existing inline table and a replacement inline table. First it removes keys that are no longer present. Then, for every replacement key, it updates the old value or inserts a new one. When updating an existing value, it copies over the old decoration, such as spacing, before replacing the content. The existing table is changed in place.

**Call relations**: replace_mcp_servers calls this when it wants to rewrite an inline MCP server entry without throwing away its formatting. It does not build the replacement itself; it applies one that was already produced elsewhere.

*Call graph*: called by 1 (replace_mcp_servers); 4 external calls (get_mut, insert, iter, retain).


##### `table_from_inline`  (lines 200–209)

```
fn table_from_inline(inline: &InlineTable) -> TomlTable
```

**Purpose**: Expands a compact inline TOML table into a normal TOML table. This lets the rest of the editor work with one table shape instead of two.

**Data flow**: It receives an inline table. It creates a new implicit table, copies each key and value into it, and clears trailing suffix decoration from the copied values so they fit cleanly in regular table form. It returns the new table.

**Call relations**: ensure_table_for_read and ensure_table_for_write call this when they encounter inline tables. It uses new_implicit_table to create the destination table before copying entries.

*Call graph*: calls 1 internal fn (new_implicit_table); called by 2 (ensure_table_for_read, ensure_table_for_write); 2 external calls (iter, Value).


##### `new_implicit_table`  (lines 211–215)

```
fn new_implicit_table() -> TomlTable
```

**Purpose**: Creates a TOML table marked as implicit. An implicit table is a supporting parent table that may not need its own visible header in the saved file.

**Data flow**: It creates a new empty TOML table, marks it as implicit, and returns it. Nothing else is read or changed.

**Call relations**: Many editing helpers call this when they need a safe empty table for nested configuration: descend, replace_mcp_servers, set_skill_config, ensure_table_for_write, serialize_mcp_server_table, and table_from_inline.

*Call graph*: called by 6 (descend, replace_mcp_servers, set_skill_config, ensure_table_for_write, serialize_mcp_server_table, table_from_inline); 1 external calls (new).


##### `parse_tool_suggest_disabled_tool`  (lines 217–231)

```
fn parse_tool_suggest_disabled_tool(
    value: &TomlValue,
) -> Option<ToolSuggestDisabledTool>
```

**Purpose**: Reads one disabled tool-suggestion entry from an inline TOML value. It recognizes entries for connectors and plugins and ignores malformed data by returning nothing.

**Data flow**: It receives a TOML value and first checks that it is an inline table. It reads the type field and accepts only connector or plugin. It then reads the id field as text. If both pieces are valid, it returns a ToolSuggestDisabledTool with the kind and id; otherwise it returns nothing.

**Call relations**: This helper is available to code that reads tool-suggestion settings from compact inline entries. It does not call project-specific helpers; it directly inspects the TOML value.

*Call graph*: 1 external calls (as_inline_table).


##### `parse_tool_suggest_disabled_tool_table`  (lines 233–246)

```
fn parse_tool_suggest_disabled_tool_table(
    table: &TomlTable,
) -> Option<ToolSuggestDisabledTool>
```

**Purpose**: Reads one disabled tool-suggestion entry from a normal TOML table. It is the full-table counterpart to parse_tool_suggest_disabled_tool.

**Data flow**: It receives a TOML table. It looks for a type field with the text connector or plugin, then looks for an id field. If both are present and valid, it returns a ToolSuggestDisabledTool. If either is missing or invalid, it returns nothing.

**Call relations**: This helper supports readers that encounter disabled tool-suggestion entries as regular tables instead of inline tables. It directly reads fields from the table and produces the typed result.

*Call graph*: 1 external calls (get).


##### `tool_suggest_disabled_tools_value`  (lines 248–266)

```
fn tool_suggest_disabled_tools_value(
    disabled_tools: &[ToolSuggestDisabledTool],
) -> TomlItem
```

**Purpose**: Writes a list of disabled tool-suggestion entries as a TOML array. Each entry records what kind of discoverable item it is and its identifier.

**Data flow**: It receives a slice of ToolSuggestDisabledTool values. For each one, it builds an inline table containing type and id, pushes that table into an array, and finally wraps the array as a TOML item. The output is ready to store in the config document.

**Call relations**: add_tool_suggest_disabled_tool calls this after updating the list of disabled suggestions. This function performs the final conversion from typed Rust data back into TOML.

*Call graph*: called by 1 (add_tool_suggest_disabled_tool); 3 external calls (new, new, Value).


##### `array_from_iter`  (lines 268–277)

```
fn array_from_iter(iter: I) -> TomlItem
```

**Purpose**: Builds a TOML array of strings from an iterator. It is a small shared helper for writing lists such as arguments, tools, or scopes.

**Data flow**: It receives an iterator that yields strings. It creates an empty TOML array, pushes each string into it, and returns the array wrapped as a TOML item.

**Call relations**: serialize_mcp_server_table calls this whenever an MCP server field is naturally a list of strings. This keeps array-building code out of the larger serializer.

*Call graph*: called by 1 (serialize_mcp_server_table); 2 external calls (new, Value).


##### `array_from_env_vars`  (lines 279–295)

```
fn array_from_env_vars(env_vars: &[McpServerEnvVar]) -> TomlItem
```

**Purpose**: Builds the TOML representation for MCP environment variable declarations. It supports both simple variable names and richer entries that include a source.

**Data flow**: It receives a list of McpServerEnvVar values. For a simple name, it pushes the name as a string. For a configured variable, it builds an inline table with name and, when present, source. It returns the completed array as a TOML item.

**Call relations**: serialize_mcp_server_table calls this when writing the env_vars field for a standard-input/output MCP server. It hides the two possible environment-variable shapes from the main serializer.

*Call graph*: called by 1 (serialize_mcp_server_table); 3 external calls (new, new, Value).


##### `table_from_pairs`  (lines 297–309)

```
fn table_from_pairs(pairs: I) -> TomlItem
```

**Purpose**: Builds a TOML table from string key-value pairs, sorted by key. Sorting makes the saved configuration stable and easier to compare across edits.

**Data flow**: It receives an iterable collection of string pairs. It collects and sorts them by key, creates a non-implicit TOML table, inserts each key with its string value, and returns that table as a TOML item.

**Call relations**: serialize_mcp_server_table calls this for map-like MCP fields such as environment variables and HTTP headers. It turns unordered in-memory maps into predictable TOML output.

*Call graph*: called by 1 (serialize_mcp_server_table); 4 external calls (into_iter, Table, new, value).


### Config migrations and imports
These files bring configuration state into Codex-managed storage by importing from external installations and applying one-time user config migrations.

### `app-server/src/config/external_agent_config.rs`

`orchestration` · `external agent migration detection and import`

This file is a migration service. It looks for an external agent directory, usually `.claude`, and checks whether there are settings, skills, commands, subagents, hooks, plugin choices, MCP servers, instruction files, or recent sessions that Codex can reuse. MCP means “Model Context Protocol,” a way for tools and servers to connect to an AI app.

The service works in two main phases. First, detection: it scans the user’s home setup and any requested project folders, compares external files with Codex’s target files, and creates a list of things worth migrating. It is careful not to overwrite existing user work. For example, it only suggests copying `CLAUDE.md` into `AGENTS.md` if the Codex target file is missing or empty.

Second, import: it takes the selected migration items and performs the copy or merge. Some imports are simple file copies. Others translate JSON settings into Codex TOML configuration, merge only missing keys, or rewrite text so references to Claude become Codex. Plugin migration is more complicated: local marketplaces can be installed directly, while remote plugin imports may be left pending for later confirmation.

Think of this file as a moving checklist plus a careful mover. It inventories what can be moved, labels each box, moves only what is safe, and records what succeeded or failed.

#### Function details

##### `ExternalAgentConfigImportItemResult::new`  (lines 116–130)

```
fn new(
        item_type: ExternalAgentConfigMigrationItemType,
        description: String,
        cwd: Option<PathBuf>,
    ) -> Self
```

**Purpose**: Creates an empty result record for one migration item. It gives the import process a place to count successes, count errors, and keep details about what happened.

**Data flow**: It receives the kind of item being migrated, a human-readable description, and an optional project folder. It stores those values, starts both counters at zero, and creates empty lists for successes and raw errors. The output is a ready-to-fill result object.

**Call relations**: The main import flow creates one of these before it tries each migration item. Later steps add successes or errors to the same record before it is returned to the caller.

*Call graph*: called by 1 (import); 1 external calls (new).


##### `ExternalAgentConfigImportItemResult::record_error`  (lines 132–135)

```
fn record_error(&mut self, raw_error: ExternalAgentConfigImportRawError)
```

**Purpose**: Adds one failure to a migration item’s result. It is used when the service wants to report that something went wrong but still keep structured details.

**Data flow**: It receives a raw error record. It increases the error count by one, using a safe add that will not overflow, and stores the error in the result’s error list. It changes the result object in place and returns nothing.

**Call relations**: The shared error helper calls this so all import errors are recorded in the same format. That keeps plugin, session, and other migration reporting consistent.

*Call graph*: called by 1 (record_import_error).


##### `ExternalAgentConfigImportItemResult::record_success`  (lines 137–145)

```
fn record_success(&mut self, source: Option<String>, target: Option<String>)
```

**Purpose**: Adds one successful migration to a result record. It captures what source item was moved and what target item it became.

**Data flow**: It receives optional source and target names. It increases the success count, then appends a success record that includes the item type and project folder already stored in the result. The result object is updated in place.

**Call relations**: Import code uses this after a config, skill, hook, command, subagent, plugin, or session is successfully migrated. It turns low-level work into a user-facing summary.

*Call graph*: called by 1 (import_sessions).


##### `ExternalAgentConfigService::new`  (lines 181–187)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Creates the migration service for a real run. The caller provides Codex’s home folder, and the service figures out where the external agent’s home folder should be.

**Data flow**: It receives a Codex home path. It calls the default external-agent-home helper, then stores both paths in the service. The output is a service object ready to detect and import migrations.

**Call relations**: Higher-level setup code constructs this service before running detection or import. It relies on `default_external_agent_home` to find the external `.claude` location.

*Call graph*: calls 1 internal fn (default_external_agent_home); called by 1 (new).


##### `ExternalAgentConfigService::new_for_test`  (lines 190–195)

```
fn new_for_test(codex_home: PathBuf, external_agent_home: PathBuf) -> Self
```

**Purpose**: Creates the service with fully controlled paths for tests. This lets tests use temporary folders instead of the real user’s home directory.

**Data flow**: It receives a Codex home path and an external agent home path. It stores exactly those paths and returns the service. Nothing is discovered from environment variables.

**Call relations**: Test helpers call this when they need predictable file locations. It mirrors `ExternalAgentConfigService::new` but avoids real machine state.

*Call graph*: called by 1 (service_for_paths).


##### `ExternalAgentConfigService::detect`  (lines 197–215)

```
async fn detect(
        &self,
        params: ExternalAgentConfigDetectOptions,
    ) -> io::Result<Vec<ExternalAgentConfigMigrationItem>>
```

**Purpose**: Finds migration opportunities in the user’s home setup and in selected project folders. It produces a checklist of items Codex could import.

**Data flow**: It receives options saying whether to include the home setup and which current working directories to inspect. It optionally scans the home setup, then finds each project root and scans it. The output is a list of migration items.

**Call relations**: This is the public detection method used by the outside API layer. It delegates the detailed scanning to `detect_migrations` and uses `find_repo_root` so project paths are interpreted consistently.

*Call graph*: calls 2 internal fn (detect_migrations, find_repo_root); called by 1 (detect); 1 external calls (new).


##### `ExternalAgentConfigService::external_agent_session_source_path`  (lines 217–235)

```
fn external_agent_session_source_path(
        &self,
        path: &Path,
    ) -> io::Result<Option<PathBuf>>
```

**Purpose**: Checks whether a session file belongs to the external agent’s session storage. This helps prevent importing arbitrary files as sessions.

**Data flow**: It receives a path. It rejects non-`.jsonl` files, resolves the path to its real filesystem location, resolves the external `projects` folder, and checks whether the file is inside that folder. It returns the canonical path if valid, otherwise `None`.

**Call relations**: Session validation code calls this before allowing a pending session import. It acts like a guard at the door: only session files from the expected external project area pass through.

*Call graph*: called by 1 (validate_pending_session_imports); 4 external calls (extension, starts_with, join, canonicalize).


##### `ExternalAgentConfigService::import`  (lines 237–427)

```
async fn import(
        &self,
        migration_items: Vec<ExternalAgentConfigMigrationItem>,
    ) -> io::Result<ExternalAgentConfigImportOutcome>
```

**Purpose**: Runs the actual migration for a list of selected items. It copies files, merges settings, installs local plugins, records results, and leaves some remote plugin imports pending.

**Data flow**: It receives migration items from detection or user selection. For each item it creates a result record, calls the matching import routine, records successes and errors, emits metrics, and collects pending plugin work when needed. It returns a complete import outcome.

**Call relations**: The external-agent import API calls this as the main execution step. It hands work to specialized helpers such as `import_config`, `import_skills`, `import_plugins`, and `import_mcp_server_config`.

*Call graph*: calls 6 internal fn (new, import_plugins, partition_plugin_migration_details, emit_migration_metric, invalid_data_error, record_import_error); called by 1 (import_external_agent_config); 1 external calls (default).


##### `ExternalAgentConfigService::detect_migrations`  (lines 429–739)

```
async fn detect_migrations(
        &self,
        repo_root: Option<&Path>,
        items: &mut Vec<ExternalAgentConfigMigrationItem>,
    ) -> io::Result<()>
```

**Purpose**: Scans one scope, either the global external-agent setup or one project, and adds every safe migration opportunity it finds. This is the core inventory step.

**Data flow**: It receives an optional repository root and a mutable list of migration items. It reads external settings, builds possible Codex config, checks target files, counts missing skills and other resources, checks plugins and sessions, and appends item records for anything worth importing. It also emits detection metrics.

**Call relations**: `detect` calls this for home and project scans. It coordinates many small helpers that read settings, compare folders, build TOML config, inspect plugin marketplaces, and name detected migration details.

*Call graph*: calls 17 internal fn (detect_plugin_migration, mcp_settings, source_root, build_config_from_external, configured_marketplace_plugins, count_missing_subdirectories, effective_external_settings, emit_migration_metric, find_repo_agents_md_source, is_empty_toml_table (+7 more)); called by 1 (detect); 16 external calls (default, as_path, clone, join, Table, build_mcp_config_from_external, count_missing_commands, count_missing_subagents, hook_migration_event_names, missing_command_names (+6 more)).


##### `ExternalAgentConfigService::home_target_skills_dir`  (lines 741–746)

```
fn home_target_skills_dir(&self) -> PathBuf
```

**Purpose**: Chooses where home-level migrated skills should be placed. It follows Codex’s expected shared `.agents/skills` layout near the Codex home folder.

**Data flow**: It reads the service’s Codex home path. If that path has a parent folder, it returns `<parent>/.agents/skills`; otherwise it returns a relative `.agents/skills` path. It does not touch the filesystem.

**Call relations**: Skill and command import helpers call this when the migration is not tied to a specific repository. It keeps all home-level skill destinations consistent.

*Call graph*: called by 2 (import_commands, import_skills); 1 external calls (parent).


##### `ExternalAgentConfigService::mcp_settings`  (lines 748–769)

```
fn mcp_settings(
        &self,
        repo_root: Option<&Path>,
        source_settings: Option<JsonValue>,
    ) -> io::Result<Option<JsonValue>>
```

**Purpose**: Chooses which external settings should be used for MCP server migration. For project migrations, it can fall back to home settings when project settings are absent.

**Data flow**: It receives an optional repository root and optional already-read settings. If scanning a project without project settings, it tries to read the home external settings and ignores invalid home settings with a warning. Otherwise it returns the settings it was given.

**Call relations**: Detection and MCP import both call this before building Codex MCP configuration. It prevents project MCP migration from failing just because the project has no settings file.

*Call graph*: calls 1 internal fn (effective_external_settings); called by 2 (detect_migrations, import_mcp_server_config); 2 external calls (join, warn!).


##### `ExternalAgentConfigService::source_root`  (lines 771–781)

```
fn source_root(&self, repo_root: Option<&Path>) -> PathBuf
```

**Purpose**: Determines the base folder used to resolve relative external paths. Relative paths need a stable starting point so they point to the same resources after migration.

**Data flow**: It receives an optional repository root. If present, it returns that project root. If not, it returns the parent of the external agent home folder, or `.` as a fallback. It only computes a path.

**Call relations**: MCP and plugin detection/import code use this when translating paths found in external settings. It keeps home-level and project-level path resolution separate.

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

**Purpose**: Builds a migration item for enabled external plugins that Codex can install and does not already have configured. It returns nothing if there is no useful plugin work.

**Data flow**: It receives the settings path, source root, optional project folder, parsed settings, and information about already configured plugins and marketplaces. It extracts installable plugin groups, emits a detection metric, and returns a plugin migration item with details.

**Call relations**: `detect_migrations` calls this after loading Codex plugin configuration. It relies on `extract_plugin_migration_details` to decide which external plugins are both enabled and relevant.

*Call graph*: calls 2 internal fn (emit_migration_metric, extract_plugin_migration_details); called by 1 (detect_migrations); 1 external calls (format!).


##### `ExternalAgentConfigService::partition_plugin_migration_details`  (lines 812–857)

```
fn partition_plugin_migration_details(
        &self,
        cwd: Option<&Path>,
        details: MigrationDetails,
    ) -> io::Result<(Option<MigrationDetails>, Option<MigrationDetails>)>
```

**Purpose**: Splits plugin migration work into local marketplace imports and remote marketplace imports. This matters because local plugins can be installed immediately, while remote ones may need a separate confirmation flow.

**Data flow**: It receives an optional project folder and plugin migration details. It rereads external marketplace sources, checks whether each source is local, and builds two new detail groups: local and remote. It returns either or both groups.

**Call relations**: The main import method calls this before importing plugins. It then sends local details to `import_plugins` and stores remote details as pending plugin imports.

*Call graph*: calls 1 internal fn (effective_external_settings); called by 1 (import); 3 external calls (default, as_path, new).


##### `ExternalAgentConfigService::import_plugins`  (lines 859–972)

```
async fn import_plugins(
        &self,
        cwd: Option<&Path>,
        details: Option<MigrationDetails>,
    ) -> io::Result<PluginImportOutcome>
```

**Purpose**: Installs plugins from external marketplace settings into Codex. It records which marketplaces and plugins succeeded or failed.

**Data flow**: It receives an optional project folder and plugin details. For each marketplace group, it finds the marketplace source, adds that marketplace to Codex, locates its manifest, and installs each requested plugin. It returns a plugin import outcome with successes, failures, and raw errors.

**Call relations**: The main import flow uses this for local plugin groups, and a later completion flow can use it for pending plugin imports. It calls marketplace and plugin manager APIs to do the actual installation.

*Call graph*: calls 7 internal fn (effective_external_settings, invalid_data_error, plugin_import_raw_error, record_plugin_import_errors, new, find_marketplace_manifest_path, add_marketplace); called by 2 (import, complete_pending_plugin_import); 5 external calls (as_path, clone, new, default, format!).


##### `ExternalAgentConfigService::import_config`  (lines 974–1027)

```
fn import_config(&self, cwd: Option<&Path>) -> io::Result<Option<(String, String)>>
```

**Purpose**: Migrates basic external settings into Codex’s `config.toml`. It only adds settings Codex is missing, so existing Codex choices are not overwritten.

**Data flow**: It receives an optional working directory. It finds the relevant repo root or home paths, reads external settings, translates them into TOML, creates the target folder if needed, and either writes a new config or merges missing values into an existing one. It returns source and target paths if anything changed.

**Call relations**: The main import method calls this for `Config` migration items. It depends on helpers that read external settings, translate JSON into TOML, merge safely, and write the final TOML file.

*Call graph*: calls 7 internal fn (build_config_from_external, effective_external_settings, find_repo_root, invalid_data_error, is_empty_toml_table, merge_missing_toml_values, write_toml_file); 5 external calls (default, join, Table, create_dir_all, read_to_string).


##### `ExternalAgentConfigService::import_mcp_server_config`  (lines 1029–1079)

```
fn import_mcp_server_config(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Migrates MCP server definitions into Codex configuration. It adds only server entries that are not already present.

**Data flow**: It receives an optional working directory. It finds source settings and target config paths, builds migrated MCP TOML, creates the target folder, writes a new config if needed, or merges missing MCP server entries into an existing config. It returns the names of servers it added.

**Call relations**: The main import flow calls this for MCP migration items. It uses `mcp_settings`, `source_root`, and merge helpers so project and home server settings are handled consistently.

*Call graph*: calls 9 internal fn (mcp_settings, source_root, effective_external_settings, find_repo_root, invalid_data_error, is_empty_toml_table, merge_missing_mcp_servers, migrated_mcp_server_names, write_toml_file); 8 external calls (default, as_path, join, Table, new, build_mcp_config_from_external, create_dir_all, read_to_string).


##### `ExternalAgentConfigService::import_subagents`  (lines 1081–1097)

```
fn import_subagents(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Imports external subagent definitions into Codex’s agents folder. Subagents are reusable helper agents stored as files.

**Data flow**: It receives an optional working directory. It chooses project-level source and target folders when inside a repository, home-level folders otherwise, and skips work for unrelated non-repo paths. It calls the external migration library and returns names of imported subagents.

**Call relations**: The main import flow calls this for `Subagents` items. It delegates the detailed file conversion/copying to `codex_external_agent_migration::import_subagents`.

*Call graph*: calls 1 internal fn (find_repo_root); 3 external calls (join, new, import_subagents).


##### `ExternalAgentConfigService::import_hooks`  (lines 1099–1121)

```
fn import_hooks(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Imports external hook settings into Codex’s `hooks.json`. Hooks are actions triggered by named events.

**Data flow**: It receives an optional working directory. It chooses the external `.claude` folder and Codex hook target, reads the hook event names that can migrate, runs the hook import, and returns the migrated event names only if the import changed the target.

**Call relations**: The main import flow calls this for hook migration items. It uses the shared external-agent migration library to understand and copy hook data.

*Call graph*: calls 1 internal fn (find_repo_root); 5 external calls (clone, join, new, hook_migration_event_names, import_hooks).


##### `ExternalAgentConfigService::import_commands`  (lines 1123–1139)

```
fn import_commands(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Imports external commands as Codex skills. This lets user-defined command shortcuts become reusable Codex skill folders.

**Data flow**: It receives an optional working directory. It chooses the source `commands` folder and target `skills` folder for either a repo or home migration, skips unrelated paths, and calls the command import helper. It returns imported command names.

**Call relations**: The main import flow calls this for command migration items. It uses `home_target_skills_dir` for home imports and delegates conversion to the external migration library.

*Call graph*: calls 2 internal fn (home_target_skills_dir, find_repo_root); 3 external calls (join, new, import_commands).


##### `ExternalAgentConfigService::import_skills`  (lines 1141–1179)

```
fn import_skills(&self, cwd: Option<&Path>) -> io::Result<Vec<String>>
```

**Purpose**: Copies external skill folders into Codex’s skills directory. It avoids replacing skills that already exist.

**Data flow**: It receives an optional working directory. It chooses source and target skill folders, returns nothing if the source folder is absent, creates the target folder, copies each missing skill directory recursively, and returns copied skill names.

**Call relations**: The main import flow calls this for skill migration items. It uses `copy_dir_recursive`, which also rewrites `SKILL.md` text so old product names become Codex-oriented.

*Call graph*: calls 3 internal fn (home_target_skills_dir, copy_dir_recursive, find_repo_root); 4 external calls (join, new, create_dir_all, read_dir).


##### `ExternalAgentConfigService::import_agents_md`  (lines 1181–1211)

```
fn import_agents_md(&self, cwd: Option<&Path>) -> io::Result<Option<(String, String)>>
```

**Purpose**: Copies external instruction text into Codex’s `AGENTS.md`. It only does this when the source has content and the target is missing or empty.

**Data flow**: It receives an optional working directory. It finds the best source instruction file, checks source and target safety conditions, creates the target folder, rewrites external-agent wording, and writes the target file. It returns source and target paths if copied.

**Call relations**: The main import flow calls this for `AgentsMd` migration items. It uses source-finding and text-rewriting helpers to preserve instructions while adapting product names.

*Call graph*: calls 6 internal fn (find_repo_agents_md_source, find_repo_root, invalid_data_error, is_missing_or_empty_text_file, is_non_empty_text_file, rewrite_and_copy_text_file); 2 external calls (join, create_dir_all).


##### `default_external_agent_home`  (lines 1214–1220)

```
fn default_external_agent_home() -> PathBuf
```

**Purpose**: Finds the usual home folder for the external agent. This is normally the user’s home directory plus `.claude`.

**Data flow**: It reads `HOME` or `USERPROFILE` from the environment. If one exists, it appends `.claude`; otherwise it returns a relative `.claude` path. It does not check whether the folder exists.

**Call relations**: `ExternalAgentConfigService::new` calls this during setup. It centralizes the default external-agent path so the service has one expected location.

*Call graph*: called by 1 (new); 2 external calls (from, var_os).


##### `read_external_settings`  (lines 1222–1231)

```
fn read_external_settings(path: &Path) -> io::Result<Option<JsonValue>>
```

**Purpose**: Reads one external settings JSON file if it exists. It treats a missing file as normal, not as an error.

**Data flow**: It receives a path. If the path is not a file, it returns `None`; otherwise it reads the text and parses it as JSON. Bad JSON becomes an invalid-data error.

**Call relations**: `effective_external_settings` calls this for both normal and local settings files. It is the low-level file reader for external settings.

*Call graph*: called by 1 (effective_external_settings); 3 external calls (is_file, read_to_string, from_str).


##### `effective_external_settings`  (lines 1233–1251)

```
fn effective_external_settings(project_settings: &Path) -> io::Result<Option<JsonValue>>
```

**Purpose**: Builds the usable external settings by combining the main settings file with `settings.local.json` when present. Local settings override or add to the main settings.

**Data flow**: It receives the path to the project or home settings file. It reads that file, then looks beside it for `settings.local.json`; if local settings are valid, it merges them into the main settings or uses them alone. It returns the combined JSON, or `None` if no settings exist.

**Call relations**: Detection, config import, MCP import, plugin import, and plugin partitioning all call this. It ensures every migration sees the same effective settings.

*Call graph*: calls 2 internal fn (merge_json_settings, read_external_settings); called by 6 (detect_migrations, import_config, import_mcp_server_config, import_plugins, mcp_settings, partition_plugin_migration_details); 1 external calls (parent).


##### `merge_json_settings`  (lines 1253–1269)

```
fn merge_json_settings(existing: &mut JsonValue, incoming: &JsonValue)
```

**Purpose**: Combines two JSON setting trees, with incoming values taking precedence. It preserves nested objects by merging their keys instead of replacing the whole object.

**Data flow**: It receives an existing JSON value to modify and an incoming JSON value. If both are objects, it merges keys recursively; otherwise it replaces the existing value with the incoming value. It changes the existing value in place.

**Call relations**: `effective_external_settings` uses this when applying `settings.local.json`. It is the JSON equivalent of placing a transparent overlay on top of the base settings.

*Call graph*: called by 1 (effective_external_settings); 3 external calls (clone, get_mut, insert).


##### `extract_plugin_migration_details`  (lines 1270–1328)

```
fn extract_plugin_migration_details(
    settings: &JsonValue,
    source_root: &Path,
    configured_plugin_ids: &HashSet<String>,
    configured_marketplace_plugins: &BTreeMap<String, HashSet<String
```

**Purpose**: Figures out which enabled external plugins should be offered for Codex migration. It filters out plugins that Codex already has or cannot install.

**Data flow**: It receives external settings, the path base for resolving sources, already configured plugin IDs, and marketplace plugin availability. It collects enabled plugins, parses their IDs, checks marketplace availability, groups them by marketplace, sorts names, and returns migration details if any remain.

**Call relations**: `detect_plugin_migration` calls this during plugin detection. It uses `collect_enabled_plugins` and `collect_marketplace_import_sources` to connect enabled plugin choices with installable marketplace sources.

*Call graph*: calls 3 internal fn (collect_enabled_plugins, collect_marketplace_import_sources, parse); called by 1 (detect_plugin_migration); 2 external calls (new, default).


##### `collect_enabled_plugins`  (lines 1330–1350)

```
fn collect_enabled_plugins(settings: &JsonValue) -> Vec<String>
```

**Purpose**: Reads the external settings and returns plugin IDs that are explicitly enabled. Disabled, malformed, or missing plugin entries are ignored.

**Data flow**: It receives the settings JSON. It looks for an `enabledPlugins` object, keeps entries whose value is true, parses each plugin key, and returns normalized plugin ID strings. If the setting is absent, it returns an empty list.

**Call relations**: Plugin migration detection calls this directly, and marketplace source collection uses it to decide whether to add the official marketplace automatically.

*Call graph*: called by 2 (extract_plugin_migration_details, has_enabled_plugin_for_marketplace); 2 external calls (as_object, new).


##### `has_enabled_plugin_for_marketplace`  (lines 1352–1360)

```
fn has_enabled_plugin_for_marketplace(settings: &JsonValue, marketplace_name: &str) -> bool
```

**Purpose**: Checks whether any enabled plugin belongs to a named marketplace. This is used to infer when an official marketplace source is needed.

**Data flow**: It receives settings and a marketplace name. It collects enabled plugins, parses each ID, and returns true if any parsed ID names that marketplace. Otherwise it returns false.

**Call relations**: `collect_marketplace_import_sources` calls this before adding the built-in official marketplace source. It keeps that default source from being added unless it is actually needed.

*Call graph*: calls 1 internal fn (collect_enabled_plugins); called by 1 (collect_marketplace_import_sources).


##### `configured_marketplace_plugins`  (lines 1362–1392)

```
fn configured_marketplace_plugins(
    config: &Config,
    plugins_manager: &PluginsManager,
) -> io::Result<BTreeMap<String, HashSet<String>>>
```

**Purpose**: Builds a map of Codex marketplaces and the plugin names that are installable from each. It excludes unavailable plugins and plugins not meant for Codex.

**Data flow**: It receives the loaded Codex config and a plugin manager. It asks the manager for configured marketplaces, filters plugins by installation policy and product restrictions, and returns a map from marketplace name to available plugin names.

**Call relations**: `detect_migrations` calls this before plugin migration detection. The resulting map helps prevent offering external plugins that Codex cannot install.

*Call graph*: calls 1 internal fn (list_marketplaces_for_config); called by 1 (detect_migrations); 2 external calls (new, plugins_config_input).


##### `collect_marketplace_import_sources`  (lines 1394–1453)

```
fn collect_marketplace_import_sources(
    settings: &JsonValue,
    source_root: &Path,
) -> BTreeMap<String, MarketplaceImportSource>
```

**Purpose**: Extracts marketplace source locations from external settings. These sources tell Codex where a plugin marketplace can be fetched from.

**Data flow**: It receives settings and a source root path. It reads `extraKnownMarketplaces`, accepts repo, URL, or local path fields, resolves relative local paths against the source root, captures optional refs, and adds the official marketplace when enabled plugins require it. It returns a map of marketplace names to sources.

**Call relations**: Plugin detail extraction and plugin import both use this. It connects external plugin IDs to the marketplace repositories or folders needed to install them.

*Call graph*: calls 1 internal fn (has_enabled_plugin_for_marketplace); called by 1 (extract_plugin_migration_details); 1 external calls (as_object).


##### `resolve_external_marketplace_source`  (lines 1461–1467)

```
fn resolve_external_marketplace_source(source: &str, source_root: &Path) -> String
```

**Purpose**: Turns a relative local marketplace path into an absolute-looking path based on the external source root. Non-relative sources, such as URLs or repository names, are left unchanged.

**Data flow**: It receives a source string and a root path. If the source looks like `./...`, `../...`, `.`, or `..`, it joins it to the root and returns that path as a string. Otherwise it returns the original source string.

**Call relations**: `collect_marketplace_import_sources` uses this while parsing marketplace settings. It prevents relative paths from changing meaning after Codex reads them from a different directory.

*Call graph*: calls 1 internal fn (looks_like_relative_local_path); 1 external calls (join).


##### `looks_like_relative_local_path`  (lines 1469–1471)

```
fn looks_like_relative_local_path(source: &str) -> bool
```

**Purpose**: Recognizes the small set of path forms that should be treated as relative local paths. This avoids mistaking repository names or URLs for filesystem paths.

**Data flow**: It receives a source string. It returns true only for strings starting with `./` or `../`, or exactly `.` or `..`. It returns false for everything else.

**Call relations**: `resolve_external_marketplace_source` calls this before joining a source to a root path. It is a tiny classifier used during plugin marketplace migration.

*Call graph*: called by 1 (resolve_external_marketplace_source).


##### `find_repo_root`  (lines 1473–1507)

```
fn find_repo_root(cwd: Option<&Path>) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds the repository root for a given path, using `.git` as the main signpost. If no `.git` folder is found, it falls back to the starting directory.

**Data flow**: It receives an optional current working path. Empty or missing input returns `None`; relative paths are made absolute; file paths are changed to their parent directory; then it walks upward looking for `.git`. It returns the found root or the fallback directory.

**Call relations**: Detection and all project-aware import helpers use this. It lets callers pass either a project folder or a file inside a project and still migrate into the correct project-level Codex files.

*Call graph*: called by 8 (detect, import_agents_md, import_commands, import_config, import_hooks, import_mcp_server_config, import_skills, import_subagents); 1 external calls (current_dir).


##### `collect_subdirectory_names`  (lines 1509–1523)

```
fn collect_subdirectory_names(path: &Path) -> io::Result<HashSet<OsString>>
```

**Purpose**: Lists the names of immediate child directories under a path. It ignores files and returns an empty set if the path is not a directory.

**Data flow**: It receives a directory path. It checks whether it is a directory, reads its entries, keeps only entries that are directories, and returns their names as a set. It does not recurse.

**Call relations**: `count_missing_subdirectories` calls this for source and target skill folders. It is the basic directory inventory helper for skill detection.

*Call graph*: called by 1 (count_missing_subdirectories); 3 external calls (new, is_dir, read_dir).


##### `count_missing_subdirectories`  (lines 1525–1532)

```
fn count_missing_subdirectories(source: &Path, target: &Path) -> io::Result<usize>
```

**Purpose**: Counts how many source directories are not present in a target directory. This tells detection whether there are skills worth copying.

**Data flow**: It receives source and target paths. It gathers immediate subdirectory names from both, compares them, and returns the number of source names missing from the target. It does not copy anything.

**Call relations**: `detect_migrations` uses this when deciding whether to create a skills migration item. It is a quick “what boxes are not already unpacked?” check.

*Call graph*: calls 1 internal fn (collect_subdirectory_names); called by 1 (detect_migrations).


##### `is_missing_or_empty_text_file`  (lines 1534–1543)

```
fn is_missing_or_empty_text_file(path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether a text file target is safe to write because it is absent or contains only whitespace. It avoids overwriting meaningful user content.

**Data flow**: It receives a path. If the path does not exist, it returns true; if it exists but is not a file, it returns false; if it is a file, it reads it and returns true only when the trimmed content is empty.

**Call relations**: Detection and `import_agents_md` use this before suggesting or performing instruction-file and hook-file migrations. It is one of the main safety checks.

*Call graph*: called by 2 (detect_migrations, import_agents_md); 3 external calls (exists, is_file, read_to_string).


##### `is_non_empty_text_file`  (lines 1545–1551)

```
fn is_non_empty_text_file(path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether a path is a real text file with non-whitespace content. This prevents migrating blank instruction files.

**Data flow**: It receives a path. If it is not a file, it returns false; otherwise it reads the text and returns true when the trimmed text is not empty.

**Call relations**: Detection, `import_agents_md`, and `find_repo_agents_md_source` use this to confirm source instruction files are worth migrating.

*Call graph*: called by 3 (detect_migrations, import_agents_md, find_repo_agents_md_source); 2 external calls (is_file, read_to_string).


##### `find_repo_agents_md_source`  (lines 1553–1566)

```
fn find_repo_agents_md_source(repo_root: &Path) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds the best external instruction file inside a repository. It checks both the repository root and the `.claude` subfolder.

**Data flow**: It receives a repository root. It tests `CLAUDE.md` at the repo root first, then `.claude/CLAUDE.md`, and returns the first non-empty file found. If neither has content, it returns `None`.

**Call relations**: Detection and `import_agents_md` call this for project-level instruction migration. It keeps source selection consistent between the preview and the actual import.

*Call graph*: calls 1 internal fn (is_non_empty_text_file); called by 2 (detect_migrations, import_agents_md); 1 external calls (join).


##### `copy_dir_recursive`  (lines 1568–1592)

```
fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Copies a directory tree from source to target. When it finds a `SKILL.md` file, it rewrites old product wording while copying.

**Data flow**: It receives source and target directory paths. It creates the target directory, walks through entries, recursively copies subdirectories, copies normal files, and rewrites `SKILL.md` text files before writing them. It returns success or a filesystem error.

**Call relations**: `import_skills` calls this for each missing skill folder. It is the low-level mover that preserves folder structure while adapting skill documentation.

*Call graph*: calls 2 internal fn (is_skill_md, rewrite_and_copy_text_file); called by 1 (import_skills); 4 external calls (join, copy, create_dir_all, read_dir).


##### `is_skill_md`  (lines 1594–1598)

```
fn is_skill_md(path: &Path) -> bool
```

**Purpose**: Checks whether a file is named `SKILL.md`, ignoring letter case. These files need text rewriting during skill migration.

**Data flow**: It receives a path, looks at its file name, and compares it case-insensitively with `SKILL.md`. It returns true for matching names and false otherwise.

**Call relations**: `copy_dir_recursive` calls this before deciding whether to rewrite a copied text file. It keeps rewriting limited to skill documentation files.

*Call graph*: called by 1 (copy_dir_recursive); 1 external calls (file_name).


##### `rewrite_and_copy_text_file`  (lines 1600–1604)

```
fn rewrite_and_copy_text_file(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Copies a text file while replacing external-agent product terms with Codex terms. This makes migrated instructions read naturally in Codex.

**Data flow**: It receives source and target paths. It reads the source text, passes it through the rewrite helper, and writes the rewritten text to the target. It returns success or a filesystem error.

**Call relations**: `import_agents_md` uses this for instruction files, and `copy_dir_recursive` uses it for `SKILL.md` files. It centralizes text adaptation during migration.

*Call graph*: calls 1 internal fn (rewrite_external_agent_terms); called by 2 (import_agents_md, copy_dir_recursive); 2 external calls (read_to_string, write).


##### `rewrite_external_agent_terms`  (lines 1606–1622)

```
fn rewrite_external_agent_terms(content: &str) -> String
```

**Purpose**: Rewrites common Claude-related names in migrated text to Codex wording. It also changes `CLAUDE.md` references to `AGENTS.md`.

**Data flow**: It receives a text string. It repeatedly applies a case-insensitive replacement helper for known terms, respecting word boundaries so it does not replace pieces inside larger words. It returns the rewritten string.

**Call relations**: `rewrite_and_copy_text_file` calls this before writing migrated text files. It is the product-language translation step.

*Call graph*: calls 1 internal fn (replace_case_insensitive_with_boundaries); called by 1 (rewrite_and_copy_text_file).


##### `replace_case_insensitive_with_boundaries`  (lines 1624–1661)

```
fn replace_case_insensitive_with_boundaries(
    input: &str,
    needle: &str,
    replacement: &str,
) -> String
```

**Purpose**: Replaces a word or phrase regardless of letter case, but only when it appears as a separate word-like unit. This avoids accidental changes inside longer identifiers.

**Data flow**: It receives input text, a search term, and a replacement. It scans a lowercase copy for matches, checks the byte before and after each match for word boundaries, emits unchanged chunks plus replacements, and returns either the rewritten text or the original text if nothing changed.

**Call relations**: `rewrite_external_agent_terms` calls this for each term it wants to replace. It uses `is_word_byte` to decide where a safe boundary is.

*Call graph*: calls 1 internal fn (is_word_byte); called by 1 (rewrite_external_agent_terms); 1 external calls (with_capacity).


##### `is_word_byte`  (lines 1663–1665)

```
fn is_word_byte(byte: u8) -> bool
```

**Purpose**: Decides whether one byte counts as part of a word for replacement-boundary checks. Letters, digits, and underscores are treated as word characters.

**Data flow**: It receives one byte. It returns true if the byte is ASCII alphanumeric or `_`, otherwise false.

**Call relations**: `replace_case_insensitive_with_boundaries` uses this while scanning text. It helps avoid replacing `claude` inside a larger word or identifier.

*Call graph*: called by 1 (replace_case_insensitive_with_boundaries).


##### `build_config_from_external`  (lines 1667–1705)

```
fn build_config_from_external(settings: &JsonValue) -> io::Result<TomlValue>
```

**Purpose**: Translates supported external JSON settings into Codex TOML configuration. It currently handles environment variables and sandbox mode.

**Data flow**: It receives parsed JSON settings. It requires the root to be an object, then builds a TOML table: external `env` values become Codex shell environment policy settings, and enabled sandbox mode becomes `workspace-write`. It returns the TOML value or an invalid-data error.

**Call relations**: Detection and `import_config` call this before comparing or writing Codex config. It is the main translator from external settings shape to Codex config shape.

*Call graph*: calls 2 internal fn (invalid_data_error, json_object_to_env_toml_table); called by 2 (detect_migrations, import_config); 4 external calls (as_object, String, Table, new).


##### `json_object_to_env_toml_table`  (lines 1707–1717)

```
fn json_object_to_env_toml_table(
    object: &serde_json::Map<String, JsonValue>,
) -> toml::map::Map<String, TomlValue>
```

**Purpose**: Converts a JSON object of environment variables into a TOML table of strings. Values that cannot sensibly become environment strings are skipped.

**Data flow**: It receives a JSON object map. For each key-value pair, it asks `json_env_value_to_string` for a string form; if one exists, it inserts that into a TOML table. It returns the finished table.

**Call relations**: `build_config_from_external` uses this when migrating external `env` settings. It keeps environment-value conversion in one place.

*Call graph*: calls 1 internal fn (json_env_value_to_string); called by 1 (build_config_from_external); 2 external calls (String, new).


##### `json_env_value_to_string`  (lines 1719–1727)

```
fn json_env_value_to_string(value: &JsonValue) -> Option<String>
```

**Purpose**: Turns simple JSON values into strings suitable for environment variables. Complex values are ignored because environment variables are plain strings.

**Data flow**: It receives one JSON value. Strings are copied, booleans and numbers are formatted as text, null returns nothing, and arrays or objects return nothing. The output is an optional string.

**Call relations**: `json_object_to_env_toml_table` calls this for each environment value. It prevents nested JSON from being written into Codex environment config incorrectly.

*Call graph*: called by 1 (json_object_to_env_toml_table); 2 external calls (clone, to_string).


##### `merge_missing_toml_values`  (lines 1729–1756)

```
fn merge_missing_toml_values(existing: &mut TomlValue, incoming: &TomlValue) -> io::Result<bool>
```

**Purpose**: Adds missing TOML settings from a migrated config into an existing config without overwriting existing values. Nested tables are merged recursively.

**Data flow**: It receives mutable existing TOML and incoming TOML. If both are tables, it walks incoming keys, inserts absent keys, and recursively merges table-with-table values. It returns whether anything changed, or an error if the shapes are not tables.

**Call relations**: Detection uses this to decide whether config migration is needed, and `import_config` uses it to perform the safe merge. It is the “fill only the blanks” rule.

*Call graph*: calls 1 internal fn (invalid_data_error); called by 2 (detect_migrations, import_config); 1 external calls (matches!).


##### `merge_missing_mcp_servers`  (lines 1758–1793)

```
fn merge_missing_mcp_servers(
    existing: &mut TomlValue,
    incoming: &TomlValue,
) -> io::Result<Vec<String>>
```

**Purpose**: Adds MCP server entries that are missing from an existing Codex config. Existing server definitions are left untouched.

**Data flow**: It receives mutable existing TOML and incoming MCP TOML. It finds the incoming `mcp_servers` table, creates the existing table if absent, inserts only server names not already present, and returns the names it added. If existing `mcp_servers` is not a table, it adds nothing.

**Call relations**: Detection uses this to know which MCP servers would be new, and `import_mcp_server_config` uses it to write those new server entries.

*Call graph*: called by 2 (detect_migrations, import_mcp_server_config); 4 external calls (Table, as_table, as_table_mut, new).


##### `write_toml_file`  (lines 1795–1799)

```
fn write_toml_file(path: &Path, value: &TomlValue) -> io::Result<()>
```

**Purpose**: Writes a TOML value to disk in a readable pretty format. It trims extra trailing whitespace and ensures the file ends cleanly.

**Data flow**: It receives a target path and a TOML value. It serializes the value, converts serialization problems into invalid-data errors, then writes the formatted string to the file. It returns success or an I/O error.

**Call relations**: `import_config` and `import_mcp_server_config` call this after creating or merging Codex configuration. It is the final disk-write step for TOML config migration.

*Call graph*: called by 2 (import_config, import_mcp_server_config); 3 external calls (format!, write, to_string_pretty).


##### `migrated_mcp_server_names`  (lines 1801–1807)

```
fn migrated_mcp_server_names(value: &TomlValue) -> Vec<String>
```

**Purpose**: Extracts the names of MCP servers from a migrated TOML config. This is used for user-facing summaries.

**Data flow**: It receives a TOML value. It looks for a table named `mcp_servers` and returns its keys as strings. If the table is absent, it returns an empty list.

**Call relations**: Detection and MCP import call this when a whole migrated MCP config is new. The names are placed into migration details or success results.

*Call graph*: called by 2 (detect_migrations, import_mcp_server_config); 1 external calls (get).


##### `named_migrations`  (lines 1809–1814)

```
fn named_migrations(names: Vec<String>) -> Vec<NamedMigration>
```

**Purpose**: Wraps plain names in `NamedMigration` records. This gives migration details a consistent structure for hooks, commands, subagents, and servers.

**Data flow**: It receives a list of strings. It turns each string into a `NamedMigration { name }` record and returns the list of records.

**Call relations**: `detect_migrations` calls this when building detailed migration items. It is a small formatting helper for detection results.

*Call graph*: called by 1 (detect_migrations).


##### `is_empty_toml_table`  (lines 1816–1826)

```
fn is_empty_toml_table(value: &TomlValue) -> bool
```

**Purpose**: Checks whether a TOML value is an empty table. This tells migration code whether a translation produced anything useful.

**Data flow**: It receives a TOML value. If the value is a table, it returns whether that table has no entries; any non-table TOML value counts as not empty. It does not modify anything.

**Call relations**: Detection, config import, and MCP import call this before offering or writing config migrations. It prevents empty config files or no-op migration items.

*Call graph*: called by 3 (detect_migrations, import_config, import_mcp_server_config).


##### `invalid_data_error`  (lines 1828–1830)

```
fn invalid_data_error(message: impl Into<String>) -> io::Error
```

**Purpose**: Creates a standard I/O error for data that exists but has the wrong format. Examples include invalid JSON, invalid TOML, or impossible config shapes.

**Data flow**: It receives a message, converts it to a string, and returns an `io::Error` with kind `InvalidData`. It does not log or throw by itself.

**Call relations**: Many import and translation helpers use this to report bad input in a consistent way. The main import flow may record these errors or return them to the caller.

*Call graph*: called by 7 (import, import_agents_md, import_config, import_mcp_server_config, import_plugins, build_config_from_external, merge_missing_toml_values); 2 external calls (into, new).


##### `migration_item_type_label`  (lines 1832–1844)

```
fn migration_item_type_label(item_type: ExternalAgentConfigMigrationItemType) -> &'static str
```

**Purpose**: Converts a migration item type into a stable short text label. These labels are used for metrics and reporting.

**Data flow**: It receives an enum value such as `Skills` or `McpServerConfig`. It returns a lowercase label string such as `skills` or `mcp_server_config`.

**Call relations**: Metric tag construction uses this so telemetry has consistent names for each migration type.


##### `record_import_error`  (lines 1846–1860)

```
fn record_import_error(
    result: &mut ExternalAgentConfigImportItemResult,
    failure_stage: &'static str,
    message: impl Into<String>,
    source: Option<String>,
)
```

**Purpose**: Adds a structured error to a migration item result. It records where the failure happened and what source item was involved, if known.

**Data flow**: It receives a mutable item result, a failure-stage label, an error message, and an optional source name. It builds a raw error record using the result’s item type and project folder, then stores it through `record_error`. The result is updated in place.

**Call relations**: The main import flow uses this when plugin migration setup fails, and session-related import code also uses it. It gives different import paths the same error shape.

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

**Purpose**: Records the same plugin-import failure for several plugin IDs at once. This is useful when an entire marketplace cannot be loaded.

**Data flow**: It receives a plugin import outcome, optional project folder, plugin IDs, a failure-stage label, and a message. It creates one raw plugin error per plugin ID and appends them to the outcome. It changes the outcome in place.

**Call relations**: `import_plugins` calls this when marketplace source lookup, marketplace installation, or manifest discovery fails. It fans one marketplace-level problem out to all affected plugins.

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

**Purpose**: Creates a raw error record specifically for plugin migration. It standardizes plugin error fields in one helper.

**Data flow**: It receives an optional project folder, failure-stage label, message, and optional source/plugin ID. It returns an `ExternalAgentConfigImportRawError` marked as a plugin error with those details.

**Call relations**: `import_plugins` uses this for individual plugin install failures, and `record_plugin_import_errors` uses it for group failures.

*Call graph*: called by 1 (import_plugins).


##### `migration_metric_tags`  (lines 1893–1910)

```
fn migration_metric_tags(
    item_type: ExternalAgentConfigMigrationItemType,
    skills_count: Option<usize>,
) -> Vec<(&'static str, String)>
```

**Purpose**: Builds telemetry tags for a migration metric. Tags are small key-value labels attached to a counter.

**Data flow**: It receives a migration item type and an optional count. It always adds the migration type label, and for skills, subagents, and commands it also adds a `skills_count` tag using the provided count or zero. It returns the tag list.

**Call relations**: `emit_migration_metric` calls this right before sending a metric. It keeps metric labeling rules separate from the metric-sending code.

*Call graph*: called by 1 (emit_migration_metric); 2 external calls (matches!, vec!).


##### `emit_migration_metric`  (lines 1912–1926)

```
fn emit_migration_metric(
    metric_name: &str,
    item_type: ExternalAgentConfigMigrationItemType,
    skills_count: Option<usize>,
)
```

**Purpose**: Sends a counter metric for migration detection or import, if telemetry is available. If telemetry is not configured, it quietly does nothing.

**Data flow**: It receives the metric name, item type, and optional count. It gets the global telemetry object, builds tags, converts them to references, and increments the named counter by one. It returns nothing and ignores metric-send errors.

**Call relations**: Detection, plugin detection, and import call this whenever they find or migrate an item. It gives maintainers visibility into which migration paths are being used.

*Call graph*: calls 1 internal fn (migration_metric_tags); called by 3 (detect_migrations, detect_plugin_migration, import); 1 external calls (global).


### `core/src/personality_migration.rs`

`orchestration` · `startup`

This file exists to make an old configuration behave like a newer one without surprising the user. A “personality” is a setting that changes the assistant’s style. When the app starts, this migration checks whether it should write a new default personality into the user’s config file.

The process is deliberately cautious. First it looks for a small marker file named `.personality_migration` in the Codex home folder. That marker is like a sticky note saying, “we already made this decision,” so the migration will not run again. If the user already has an explicit personality in their config, the code writes the marker and leaves the setting alone. If there is no explicit personality, it checks whether the user has any recorded threads, including archived ones. This matters because the migration is meant for existing users, not brand-new installations.

If past sessions exist, the file uses `ConfigEditsBuilder` to persist `Personality::Pragmatic` into the config. Then it writes the marker so the choice is not repeated on later runs. The marker creation is safe if another task already made it first: an “already exists” error is treated as success. Without this file, some existing users might miss the intended default behavior, or the app might repeatedly try to change the same setting.

#### Function details

##### `maybe_migrate_personality`  (lines 25–60)

```
async fn maybe_migrate_personality(
    codex_home: &Path,
    config_toml: &ConfigToml,
    state_db: Option<StateDbHandle>,
) -> io::Result<PersonalityMigrationStatus>
```

**Purpose**: This is the main decision-maker for the personality migration. It decides whether to skip, apply, or mark the migration as already handled, and returns a clear status saying what happened.

**Data flow**: It receives the Codex home folder path, the currently loaded TOML config, and an optional state database handle. It first checks for the marker file; if present, it returns a skipped status. If the config already names a personality, it creates the marker and returns that it skipped because the user already chose. If not, it checks for previous sessions. With no sessions, it creates the marker and skips. With sessions, it writes `Pragmatic` into the config, creates the marker, and returns that the migration was applied.

**Call relations**: This function is called during startup flows such as `migrate_personality_if_needed` and `run_main_with_transport_options`, and it is also exercised by tests that cover each migration path. Inside, it asks `has_recorded_sessions` whether this looks like an existing user, uses `ConfigEditsBuilder` to write the config change when needed, and calls `create_marker` to record that no future run should repeat the decision.

*Call graph*: calls 3 internal fn (new, create_marker, has_recorded_sessions); called by 13 (migrate_personality_if_needed, run_main_with_transport_options, applied_migration_is_idempotent_on_second_run, marker_short_circuits_migration_with_legacy_profile, migration_marker_exists_no_sessions_no_change, missing_legacy_profile_does_not_block_migration, no_marker_archived_sessions_sets_personality, no_marker_explicit_global_personality_skips_migration, no_marker_meta_only_rollout_is_treated_as_no_sessions, no_marker_no_sessions_no_change (+3 more)); 2 external calls (join, try_exists).


##### `has_recorded_sessions`  (lines 62–79)

```
async fn has_recorded_sessions(
    codex_home: &Path,
    default_provider: &str,
    state_db: Option<StateDbHandle>,
) -> io::Result<bool>
```

**Purpose**: This function answers one question: does this Codex home appear to have any saved conversations? The migration uses that answer to avoid changing settings for a fresh install with no history.

**Data flow**: It receives the Codex home path, the default model provider name, and an optional state database handle. It builds a local thread store pointed at the user’s storage locations. Then it checks for one non-archived thread first, and if none are found, checks for one archived thread. It returns `true` as soon as either check finds something; otherwise it returns `false`.

**Call relations**: It is called only by `maybe_migrate_personality`, after the code has established that there is no marker and no explicit personality setting. It delegates the actual thread lookup to `has_threads`, once for active threads and then, if needed, again for archived threads.

*Call graph*: calls 2 internal fn (has_threads, new); called by 1 (maybe_migrate_personality); 1 external calls (to_path_buf).


##### `has_threads`  (lines 81–99)

```
async fn has_threads(store: &LocalThreadStore, archived: bool) -> io::Result<bool>
```

**Purpose**: This helper checks whether the local thread store contains at least one thread in either the active or archived group. It asks for only one item, because the migration only needs to know whether any history exists, not how much.

**Data flow**: It receives a local thread store and a flag saying whether to search archived threads. It requests a single thread, sorted by creation time with the newest first, without applying search text or folder filters. If the returned page contains at least one item, it returns `true`; if the page is empty, it returns `false`. If the thread store reports an error, the error is converted into a standard input/output error.

**Call relations**: This function is used by `has_recorded_sessions` as the low-level check against stored conversation history. It hands the request to the thread store’s `list_threads` method, which performs the real storage lookup.

*Call graph*: calls 1 internal fn (list_threads); called by 1 (has_recorded_sessions); 1 external calls (new).


##### `create_marker`  (lines 101–112)

```
async fn create_marker(marker_path: &Path) -> io::Result<()>
```

**Purpose**: This function writes the small marker file that says the personality migration has already been considered. That prevents the app from repeating the same migration decision on every future run.

**Data flow**: It receives the full path where the marker file should live. It tries to create a new file there and writes `v1\n` into it. If the file already exists, it treats that as fine and returns success. If another file error happens, it returns that error to the caller.

**Call relations**: This function is called by `maybe_migrate_personality` in every path where the migration has made a final decision, whether it skipped or applied the config change. It uses asynchronous file opening and writing so startup can perform the disk work without blocking the async runtime.

*Call graph*: called by 1 (maybe_migrate_personality); 1 external calls (new).


### Daemon-local settings storage
This file defines and persists the daemon’s own local settings outside the main app-server configuration flow.

### `app-server-daemon/src/settings.rs`

`config` · `config load and save`

This file gives the app-server daemon a simple memory of one user-facing choice: whether remote control is turned on. Without it, the daemon would have no standard way to keep that choice between runs, and callers would each need to invent their own file-reading and file-writing behavior.

The central type is `DaemonSettings`, a small data object with one field: `remote_control_enabled`. The file stores and reads this object as JSON, using `remoteControlEnabled` in the saved file rather than Rust’s internal `remote_control_enabled` name. That matters because settings files are often read by tools or people outside Rust code, where camelCase is common.

Loading is forgiving when the settings file does not exist: it returns the default settings instead of treating that as a failure. This is like opening a brand-new notebook if yesterday’s notebook is not there. Other errors, such as permission problems or invalid JSON, are reported with extra context so the caller can show a useful message.

Saving creates the parent directory if needed, turns the settings into neatly formatted JSON, and writes it to the requested path. A small Unix-only test checks that the JSON field name stays in the expected camelCase form.

#### Function details

##### `DaemonSettings::load`  (lines 16–28)

```
async fn load(path: &Path) -> Result<Self>
```

**Purpose**: Reads daemon settings from a JSON file. If the file is missing, it returns default settings so a first run can proceed normally.

**Data flow**: It takes a file path as input. It tries to read the file text from disk; if the file is not found, it produces a default `DaemonSettings` value. If the file is found, it parses the JSON text into a `DaemonSettings` object, or returns an error that explains whether reading or parsing failed.

**Call relations**: This function is called by `load_settings` when the daemon needs its saved configuration. It relies on the filesystem read operation to get the raw text, then hands that text to JSON parsing so the rest of the program receives a normal Rust settings object instead of file contents.

*Call graph*: called by 1 (load_settings); 3 external calls (default, read_to_string, from_str).


##### `DaemonSettings::save`  (lines 30–44)

```
async fn save(&self, path: &Path) -> Result<()>
```

**Purpose**: Writes the current daemon settings to a JSON file. It also makes sure the destination folder exists before trying to write.

**Data flow**: It takes the current `DaemonSettings` value and a target file path. It checks the path’s parent directory, creates that directory tree if needed, converts the settings into pretty JSON bytes, and writes those bytes to disk. The output is success or an error explaining what step failed.

**Call relations**: This is used when the daemon or another part of the app wants to persist a changed setting. It first prepares the storage location, then passes the settings through JSON serialization, and finally hands the resulting bytes to the filesystem write operation.

*Call graph*: 4 external calls (parent, create_dir_all, write, to_vec_pretty).


##### `tests::daemon_settings_use_camel_case_json`  (lines 54–62)

```
fn daemon_settings_use_camel_case_json()
```

**Purpose**: Checks that saved settings use the JSON name `remoteControlEnabled`. This protects the file format expected by other code, tools, or existing user settings files.

**Data flow**: It creates a `DaemonSettings` value with remote control enabled, converts it to a JSON string, and compares that string with the exact expected JSON text. If the names or shape change, the assertion fails.

**Call relations**: This test supports the serialization behavior defined on `DaemonSettings`. It does not take part in normal daemon execution; it runs during testing to catch accidental changes to the settings file format.

*Call graph*: 1 external calls (assert_eq!).
