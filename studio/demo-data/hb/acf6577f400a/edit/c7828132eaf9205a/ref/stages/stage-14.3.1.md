# MCP runtime, resources, and session integration  `stage-14.3.1`

This stage is the live “switchboard” for MCP, the Model Context Protocol, which lets the system talk to outside tool and resource servers during a session. It sits in the main work loop: after startup choices are known, it keeps connections alive, exposes usable tools to the model, and routes calls, reads, approvals, and sign-in prompts.

At the edges, ext/mcp and app-server/extensions register MCP-backed extensions and adapt their events into the app-server world. The codex-mcp crate is the core MCP layer: server.rs defines what a configured server looks like, executor_plugin/provider.rs loads server definitions from plugins, codex_apps.rs adds app-specific caching and naming rules, and mcp/mod.rs builds the effective server list and snapshots. connection_manager.rs is the hub that owns active clients, refreshes them, and gathers tools and resources; resource_client.rs gives the rest of the system a stable handle even when the manager is replaced.

On the core side, session/mcp.rs ties MCP into session state, auth_elicitation.rs turns auth failures into user-facing sign-in requests, and mcp_tool_call.rs drives a full tool call from arguments to approval to result. The tool and resource handler files define what MCP tools look like, which ones are exposed, how files are uploaded when needed, and how resource listing and reading are performed. Finally, mcp_skill_dependencies.rs notices when a requested skill needs an MCP server and can help add and authorize it.

## Files in this stage

### Extension registration
These files register MCP-backed extensions and load executor-plugin server declarations before the runtime is used elsewhere.

### `app-server/src/extensions.rs`

`orchestration` · `startup wiring and runtime extension event forwarding`

This file is the integration layer between the app server and the extension ecosystem. `ThreadExtensionDependencies` bundles the concrete services extensions may need: auth, analytics, optional state DB, thread manager access, goal service, environment manager, executor skill provider, and thread-store access. `thread_extensions` consumes those dependencies and builds an `ExtensionRegistry<Config>` with a specific installation set: goals (only when a state DB is available, and gated by the `Goals` feature flag), guardian, memories, MCP plus executor plugins, web search, image generation, and skills with both executor and orchestrator providers. The resulting registry is wrapped in `Arc` for shared use.

The file also defines `AppServerExtensionEventSink`, an `ExtensionEventSink` implementation that currently understands `EventMsg::ThreadGoalUpdated`. When such an event arrives, it first tries to route it through the thread’s listener command channel using `ThreadStateManager`, preserving FIFO ordering with other listener commands like goal-cleared events. If no listener is registered or the channel is closed, it falls back to spawning an async task that sends a `ServerNotification::ThreadGoalUpdated` through `OutgoingMessageSender`. Unsupported extension events are dropped with a debug log.

Finally, `guardian_agent_spawner` closes over a weak `ThreadManager` and returns an `AgentSpawner` closure that upgrades the weak reference and calls `spawn_subagent`, failing with `CodexErr::UnsupportedOperation` if the manager has already been dropped.

#### Function details

##### `thread_extensions`  (lines 44–94)

```
fn thread_extensions(
    guardian_agent_spawner: S,
    dependencies: ThreadExtensionDependencies,
) -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Builds and returns the configured extension registry for app-server threads. It installs the supported extensions and supplies each one with the dependencies and feature/config adapters it needs.

**Data flow**: Consumes a guardian `AgentSpawner` and `ThreadExtensionDependencies`, destructures the dependency bundle, creates an `ExtensionRegistryBuilder::<Config>` with the provided event sink, conditionally installs the goal extension when `state_db` is present, installs guardian/memories/MCP/web-search/image-generation/skills extensions, constructs `SkillProviders` with executor and orchestrator providers, and returns `Arc::new(builder.build())`.

**Call relations**: Used during thread subsystem setup to assemble the extension stack once. It delegates actual extension registration to each extension crate’s `install...` function and supplies feature/config closures where required.

*Call graph*: calls 2 internal fn (new, new); 11 external calls (new, with_event_sink, install_with_backend, install, install, install, install_executor_plugins, install, global, install_with_providers (+1 more)).


##### `app_server_extension_event_sink`  (lines 96–104)

```
fn app_server_extension_event_sink(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
) -> Arc<dyn ExtensionEventSink>
```

**Purpose**: Constructs the app-server-specific implementation of `ExtensionEventSink`. It packages the outgoing notification sender and thread-state manager into a trait object suitable for the extension registry.

**Data flow**: Takes `Arc<OutgoingMessageSender>` and `ThreadStateManager`, constructs `AppServerExtensionEventSink { outgoing, thread_state_manager }`, wraps it in `Arc`, and returns it as `Arc<dyn ExtensionEventSink>`.

**Call relations**: Called during extension wiring and directly by the module test to obtain the sink implementation exercised there.

*Call graph*: called by 1 (app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears); 1 external calls (new).


##### `AppServerExtensionEventSink::emit`  (lines 112–150)

```
fn emit(&self, event: Event)
```

**Purpose**: Handles extension events by routing supported goal-update events either through the thread listener command channel or, as a fallback, as an outgoing server notification. Unsupported events are dropped with debug logging.

**Data flow**: Consumes `&self` and an `Event`. It matches on `event.msg`. For `EventMsg::ThreadGoalUpdated`, it extracts `thread_id`, `turn_id`, and converts the core goal into protocol `ThreadGoal`. It queries `thread_state_manager.current_listener_command_tx(thread_id)`; if present, it builds `ThreadListenerCommand::EmitThreadGoalUpdated` and tries to send it. On successful send it returns early. If the channel is absent or closed, it logs a warning when closed, clones `self.outgoing`, and spawns an async task that sends `ServerNotification::ThreadGoalUpdated(ThreadGoalUpdatedNotification { ... })`. For all other messages it emits a debug log and does nothing else.

**Call relations**: Invoked by extension code through the `ExtensionEventSink` trait. Its listener-channel fast path is designed to preserve ordering with other thread listener events; the spawned notification path is the fallback when no listener is active.

*Call graph*: calls 1 internal fn (current_listener_command_tx); 5 external calls (clone, ThreadGoalUpdated, spawn, debug!, warn!).


##### `guardian_agent_spawner`  (lines 153–169)

```
fn guardian_agent_spawner(
    thread_manager: Weak<ThreadManager>,
) -> impl AgentSpawner<StartThreadOptions, Spawned = NewThread, Error = CodexErr>
```

**Purpose**: Creates the closure used by the guardian extension to spawn subagents from an existing thread. The closure safely handles the case where the `ThreadManager` has already been dropped.

**Data flow**: Takes a `Weak<ThreadManager>` and returns a closure implementing `AgentSpawner<StartThreadOptions, Spawned = NewThread, Error = CodexErr>`. Each invocation clones the weak pointer, upgrades it inside an async block, returns `CodexErr::UnsupportedOperation("thread manager dropped")` if upgrade fails, otherwise awaits `thread_manager.spawn_subagent(forked_from_thread_id, options)` and returns that result.

**Call relations**: Passed into `thread_extensions`, which installs it into the guardian extension so guardian-triggered subagent creation can call back into the app server’s thread manager.


##### `tests::app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears`  (lines 185–229)

```
async fn app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears()
```

**Purpose**: Verifies that goal-update extension events are delivered through the listener command channel in FIFO order relative to other listener commands, rather than being reordered through the outgoing notification path.

**Data flow**: Creates an outgoing sender, a fresh `ThreadStateManager`, a thread ID, and an unbounded listener command channel; registers the sender with the manager; builds the sink; emits two synthetic goal-update events; manually sends `EmitThreadGoalCleared`; then receives three commands with a timeout, records observed turn IDs/clear marker, and asserts the exact order `turn-1`, `turn-2`, `cleared`.

**Call relations**: Exercises `app_server_extension_event_sink` and `AppServerExtensionEventSink::emit`, specifically the listener-channel fast path and its ordering guarantees.

*Call graph*: calls 5 internal fn (disabled, app_server_extension_event_sink, new, new, default); 9 external calls (new, from_secs, new, thread_goal_updated_event, assert_eq!, channel, unbounded_channel, panic!, timeout).


##### `tests::thread_goal_updated_event`  (lines 231–249)

```
fn thread_goal_updated_event(thread_id: ThreadId, turn_id: &str) -> Event
```

**Purpose**: Builds a synthetic core `Event` carrying a `ThreadGoalUpdatedEvent` for use in tests. It centralizes the verbose event construction needed by the sink test.

**Data flow**: Takes a `ThreadId` and `&str` turn ID, constructs `Event { id, msg: EventMsg::ThreadGoalUpdated(ThreadGoalUpdatedEvent { ... }) }` with a populated `CoreThreadGoal`, and returns it.

**Call relations**: Used only by the module test to generate realistic extension events for `AppServerExtensionEventSink::emit`.

*Call graph*: 1 external calls (ThreadGoalUpdated).


### `ext/mcp/src/lib.rs`

`orchestration` · `startup / extension registry setup`

This crate entry file is the integration layer for MCP extension behavior. It defines `HostedPluginRuntimeExtension`, an `McpServerContributor<Config>` that controls the reserved hosted Apps MCP server named by `CODEX_APPS_MCP_SERVER_NAME`. Its `contribute()` method reads the runtime `Config`: when the Apps feature flag is disabled, it emits `McpServerContribution::Remove` for that reserved name so any configured server is stripped out; when enabled, it emits `McpServerContribution::Set` with a config produced by `hosted_plugin_runtime_mcp_server_config()` using `chatgpt_base_url` and the optional `apps_mcp_product_sku`. This makes the hosted runtime an overlay supplied by extensions rather than hard-coded manager logic.

The public functions are registration hooks. `install()` adds the hosted-runtime contributor to an `ExtensionRegistryBuilder`. `install_executor_plugins()` adds the `SelectedExecutorPluginMcpContributor`, constructing it with an `Arc<EnvironmentManager>` so it can resolve selected executor plugins and discover their MCP declarations. `initialize_executor_plugin_thread_data()` seeds per-thread extension data by delegating to `executor_plugin::seed_thread_state()`. Together, these functions let the host opt into either or both MCP contribution mechanisms while keeping the actual contribution logic in dedicated modules.

#### Function details

##### `HostedPluginRuntimeExtension::id`  (lines 15–17)

```
fn id(&self) -> &'static str
```

**Purpose**: Returns the stable identifier for the hosted Apps MCP contributor.

**Data flow**: It returns the static string `"hosted_plugin_runtime"`.

**Call relations**: The extension framework uses this identifier when tracking or debugging registered MCP contributors.


##### `HostedPluginRuntimeExtension::contribute`  (lines 19–38)

```
fn contribute(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>>
```

**Purpose**: Adds or removes the reserved hosted Apps MCP server based on feature flags and current configuration.

**Data flow**: It receives an `McpServerContributionContext<Config>`, boxes an async block, reads `context.config()`, and derives the reserved server name from `CODEX_APPS_MCP_SERVER_NAME`. If `config.features.enabled(Feature::Apps)` is false, it returns a one-element vector containing `McpServerContribution::Remove { name }`. Otherwise it returns a one-element vector containing `McpServerContribution::Set { name, config: Box::new(hosted_plugin_runtime_mcp_server_config(&config.chatgpt_base_url, config.apps_mcp_product_sku.as_deref())) }`.

**Call relations**: This is invoked by the MCP manager when assembling runtime contributions. It is registered by `install()`.

*Call graph*: calls 1 internal fn (config); 2 external calls (pin, vec!).


##### `install`  (lines 41–43)

```
fn install(builder: &mut ExtensionRegistryBuilder<Config>)
```

**Purpose**: Registers the hosted Apps MCP contributor with an extension registry builder.

**Data flow**: It takes a mutable `ExtensionRegistryBuilder<Config>`, wraps `HostedPluginRuntimeExtension` in an `Arc`, and passes it to `builder.mcp_server_contributor(...)`.

**Call relations**: Hosts call this during startup when they want the extension-managed hosted Apps MCP overlay enabled.

*Call graph*: calls 1 internal fn (mcp_server_contributor); 1 external calls (new).


##### `install_executor_plugins`  (lines 46–53)

```
fn install_executor_plugins(
    builder: &mut ExtensionRegistryBuilder<Config>,
    environment_manager: std::sync::Arc<codex_exec_server::EnvironmentManager>,
)
```

**Purpose**: Registers the contributor that discovers MCP servers from thread-selected executor plugins.

**Data flow**: It takes a mutable `ExtensionRegistryBuilder<Config>` and an `Arc<EnvironmentManager>`, constructs `executor_plugin::SelectedExecutorPluginMcpContributor::new(environment_manager)`, wraps it in an `Arc`, and registers it with `builder.mcp_server_contributor(...)`.

**Call relations**: This setup hook is used by tests and runtime code that want selected executor plugins to contribute MCP servers.

*Call graph*: calls 2 internal fn (mcp_server_contributor, new); 1 external calls (new).


##### `initialize_executor_plugin_thread_data`  (lines 56–60)

```
fn initialize_executor_plugin_thread_data(
    thread_init: &mut codex_extension_api::ExtensionDataInit,
)
```

**Purpose**: Seeds the per-thread extension data required for selected-executor-plugin MCP snapshot caching.

**Data flow**: It takes a mutable `ExtensionDataInit` and forwards it to `executor_plugin::seed_thread_state(thread_init)`. It returns no value.

**Call relations**: Callers must invoke this during thread initialization before the executor-plugin contributor’s `contribute()` method runs.

*Call graph*: calls 1 internal fn (seed_thread_state).


### `ext/mcp/src/executor_plugin/provider.rs`

`io_transport` · `plugin MCP discovery`

This provider isolates the mechanics of reading `.mcp.json`-style declarations from executor plugins. `ExecutorPluginMcpProvider::load()` is a thin adapter from `ResolvedExecutorPlugin` to the lower-level loader: it extracts the plugin’s environment-root location and passes the plugin descriptor, root path, and executor file system into `load_from_file_system()`.

`load_from_file_system()` contains the real policy. It derives the plugin’s `environment_id` and selected-root ID, then chooses the config path from `manifest().paths.mcp_servers` when explicitly declared, or falls back to `<plugin_root>/.mcp.json` and marks that path as default. The file is always read through the executor’s `ExecutorFileSystem` via `PathUri`, never directly from the host file system. A missing default file is treated as “no MCP servers” and returns an empty vector; any other read failure becomes `ExecutorPluginMcpProviderError::ReadConfig` with plugin ID and path attached. Successful text is parsed by `parse_plugin_mcp_config()` with `PluginMcpServerPlacement::Environment { environment_id }`, and parse failures become `ParseConfig`.

The parsed result may contain recoverable per-server errors; those are logged and ignored. Finally, only `McpServerTransportConfig::Stdio` servers are retained. `StreamableHttp` servers are explicitly warned about and dropped, because executor plugins are only allowed to contribute environment-bound stdio MCP servers. The returned vector preserves the parsed server names and adjusted configs.

#### Function details

##### `ExecutorPluginMcpProvider::load`  (lines 42–49)

```
async fn load(
        &self,
        plugin: &ResolvedExecutorPlugin,
    ) -> Result<Vec<(String, McpServerConfig)>, ExecutorPluginMcpProviderError>
```

**Purpose**: Loads MCP server declarations for a resolved executor plugin by delegating to the file-system-based loader with the plugin’s environment root and executor file system.

**Data flow**: It takes a `&ResolvedExecutorPlugin`, pattern-matches `plugin.plugin().location()` to obtain the environment `root`, then calls `load_from_file_system(plugin.plugin(), root, plugin.file_system()).await`. It returns either the loaded `(name, McpServerConfig)` pairs or an `ExecutorPluginMcpProviderError`.

**Call relations**: This method is called by `SelectedExecutorPluginMcpContributor::resolve_snapshot()` after a selected root has been resolved to a bound executor plugin.

*Call graph*: calls 3 internal fn (file_system, plugin, load_from_file_system); called by 1 (resolve_snapshot).


##### `load_from_file_system`  (lines 52–116)

```
async fn load_from_file_system(
    plugin: &ResolvedPlugin,
    plugin_root: &AbsolutePathBuf,
    file_system: &dyn ExecutorFileSystem,
) -> Result<Vec<(String, McpServerConfig)>, ExecutorPluginMcpP
```

**Purpose**: Reads, parses, validates, and filters a plugin MCP config file using the executor’s file-system abstraction.

**Data flow**: It accepts a `ResolvedPlugin`, its root path, and a `dyn ExecutorFileSystem`. It reads the plugin location to obtain `environment_id`, reads `selected_root_id()` for error reporting and policy binding, and chooses either the manifest-declared MCP config path or `plugin_root.join(DEFAULT_MCP_CONFIG_FILE)`. That absolute path is converted to `PathUri` and read with `read_file_text(..., None).await`. If the file is missing and it was the default path, the function returns `Ok(Vec::new())`; otherwise read failures become `ExecutorPluginMcpProviderError::ReadConfig`. The text is parsed with `parse_plugin_mcp_config(plugin_root.as_path(), &contents, PluginMcpServerPlacement::Environment { environment_id })`; parse failures become `ParseConfig`. It logs each recoverable parsed error, then consumes `parsed.servers`, keeping only entries whose `transport` is `McpServerTransportConfig::Stdio` and warning away `StreamableHttp` entries. The collected stdio servers are returned.

**Call relations**: This is the core loader used by `ExecutorPluginMcpProvider::load()` and directly exercised by provider tests to verify executor-only reads, missing-default behavior, and parse-error reporting.

*Call graph*: calls 7 internal fn (read_file_text, location, manifest, selected_root_id, as_path, join, from_abs_path); called by 1 (load); 3 external calls (new, parse_plugin_mcp_config, warn!).


### MCP runtime foundation
These files define the MCP crate surface, runtime server/config models, Apps-specific behavior, connection management, and the session-scoped resource client built on top of refreshed managers.

### `codex-mcp/src/lib.rs`

`orchestration` · `cross-cutting`

This crate root defines the MCP package's external API by gathering a large set of types and helper functions from internal modules and exposing them at the top level. The exports reveal the subsystem's major responsibilities: connection lifecycle (`McpConnectionManager`), tool visibility and metadata (`tool_is_model_visible`, `ToolInfo`, `declared_openai_file_input_param_names`), elicitation and review flows (`ElicitationReviewer`, `ElicitationReviewRequest`, handles and auth-elicitation builders), resource access and caching (`McpResourceClient`, cache keys, paged reads, `read_mcp_resource`), runtime context and sandbox state, catalog construction and conflict resolution for MCP servers, plugin configuration parsing, OAuth scope discovery and auth-status computation, and effective server resolution from configured sources. It also exposes constants and provenance helpers for Codex Apps integration, plus snapshot/status types used to inspect server health and capabilities. Internally, some modules are crate-private while others remain private to the root, indicating a deliberate separation between implementation detail and supported API. This file does not implement MCP behavior itself; instead it is the compatibility boundary that lets the rest of the workspace treat the crate as a single MCP toolkit rather than importing from many submodules directly.


### `codex-mcp/src/server.rs`

`data_model` · `startup and MCP server setup; later reused during tool routing and diagnostics`

This file is a compact domain-model layer for MCP server instances. `EffectiveMcpServer` wraps the launch strategy in the internal `McpServerLaunch` enum; today the only variant is `Configured(Box<McpServerConfig>)`, which preserves the original config while allowing the runtime representation to evolve later without changing callers. The accessor methods intentionally expose only selected semantics from the underlying config: whether the server is enabled, whether it is required, and the original config when the launch mode is configuration-backed.

The second half of the file preserves metadata that remains relevant after a server process or transport has been established. `McpServerOrigin` reduces transport configuration into a stable diagnostic label: either literal `stdio` or the parsed HTTP origin string derived from a `StreamableHttp` URL. Invalid URLs are tolerated by returning `None`, so telemetry can degrade gracefully instead of failing launch.

`McpServerMetadata` captures behavior flags and tool approval policy in a launch-independent form. Its `From<&EffectiveMcpServer>` implementation extracts `supports_parallel_tool_calls`, computes origin from transport, hard-codes `pollutes_memory: true`, copies the default approval mode, and builds a per-tool approval map only for tools that explicitly override approval. `tool_approval_mode` then resolves a tool’s effective policy by checking the per-tool map first, then the server default, then `AppToolApproval`’s default value.

#### Function details

##### `EffectiveMcpServer::configured`  (lines 20–24)

```
fn configured(config: McpServerConfig) -> Self
```

**Purpose**: Constructs an `EffectiveMcpServer` whose launch strategy is the boxed `McpServerConfig` supplied by configuration loading. It is the canonical constructor for the current runtime form.

**Data flow**: Consumes an owned `McpServerConfig` argument, wraps it in `McpServerLaunch::Configured(Box<_>)`, and returns a new `EffectiveMcpServer` value. It does not mutate external state.

**Call relations**: Used by tests that need a concrete runtime server object from config input, including cases that verify launch behavior and metadata preservation. Downstream code later inspects the stored launch variant through `launch()` or config-specific accessors.

*Call graph*: called by 2 (no_local_runtime_fails_local_stdio_but_keeps_local_http_server, server_metadata_preserves_tool_approval_policy); 2 external calls (new, Configured).


##### `EffectiveMcpServer::launch`  (lines 26–28)

```
fn launch(&self) -> &McpServerLaunch
```

**Purpose**: Exposes the internal launch strategy enum by shared reference so other runtime code can branch on how this server should be contacted or started.

**Data flow**: Reads `self.launch` and returns `&McpServerLaunch` without cloning or transforming it.

**Call relations**: Called by code that needs to build an RMCP client and by `McpServerMetadata::from`, both of which pattern-match on the launch variant to derive transport or metadata details.

*Call graph*: called by 2 (make_rmcp_client, from).


##### `EffectiveMcpServer::configured_config`  (lines 30–34)

```
fn configured_config(&self) -> Option<&McpServerConfig>
```

**Purpose**: Returns the underlying `McpServerConfig` when this effective server came directly from configuration.

**Data flow**: Matches on `self.launch`; for `Configured`, it dereferences the boxed config and returns `Some(&McpServerConfig)`. With the current enum shape this always succeeds, but the `Option` leaves room for future non-configured launch modes.

**Call relations**: Used by construction logic elsewhere that wants direct access to the original config only when available, without exposing the launch enum to every caller.

*Call graph*: called by 1 (new).


##### `EffectiveMcpServer::enabled`  (lines 36–40)

```
fn enabled(&self) -> bool
```

**Purpose**: Reports whether the configured MCP server is enabled according to its source configuration.

**Data flow**: Matches on `self.launch`, reads `config.enabled` from the boxed `McpServerConfig`, and returns that boolean.

**Call relations**: This is a leaf accessor used by higher-level orchestration code to decide whether a configured server should participate in startup or tool listing.


##### `EffectiveMcpServer::required`  (lines 42–46)

```
fn required(&self) -> bool
```

**Purpose**: Reports whether the configured MCP server is marked required, which higher layers can use to decide whether startup failures are fatal.

**Data flow**: Matches on `self.launch`, reads `config.required`, and returns the boolean value.

**Call relations**: Another leaf accessor for orchestration logic that distinguishes optional from mandatory MCP integrations.


##### `McpServerOrigin::as_str`  (lines 57–62)

```
fn as_str(&self) -> &str
```

**Purpose**: Converts the origin enum into the stable string form used in metrics and diagnostics.

**Data flow**: Reads `self`; returns the literal `"stdio"` for `Stdio`, or the borrowed inner origin string for `StreamableHttp(String)`.

**Call relations**: Serves as the final formatting step after origin has been derived from transport configuration and stored in metadata.


##### `McpServerOrigin::from_transport`  (lines 64–72)

```
fn from_transport(transport: &McpServerTransportConfig) -> Option<Self>
```

**Purpose**: Derives a diagnostic origin from transport configuration, collapsing full transport details into either `stdio` or an HTTP origin string.

**Data flow**: Takes `&McpServerTransportConfig`; for `StreamableHttp`, parses the configured URL and, if parsing succeeds, returns `Some(StreamableHttp(parsed.origin().ascii_serialization()))`; for `Stdio`, returns `Some(Stdio)`. If URL parsing fails, it returns `None`.

**Call relations**: Invoked during `McpServerMetadata::from` so metadata retains a transport-origin label after launch. It delegates URL normalization to `url::Url::parse` and intentionally treats malformed HTTP URLs as missing origin metadata rather than as a hard error.

*Call graph*: called by 1 (from); 2 external calls (StreamableHttp, parse).


##### `McpServerMetadata::tool_approval_mode`  (lines 86–92)

```
fn tool_approval_mode(&self, tool_name: &str) -> AppToolApproval
```

**Purpose**: Computes the effective approval mode for a specific tool name using per-tool overrides, then server default, then the global default.

**Data flow**: Reads `self.tool_approval_modes`, `self.default_tools_approval_mode`, and the `tool_name` argument. It looks up the tool-specific mode, falls back to the optional default mode, then falls back to `AppToolApproval::default()`, returning the resolved enum value.

**Call relations**: Used wherever tool execution policy needs to be decided from persisted server metadata rather than from the original config structure.


##### `McpServerMetadata::from`  (lines 96–114)

```
fn from(server: &EffectiveMcpServer) -> Self
```

**Purpose**: Builds the semantic metadata snapshot that should remain available after an `EffectiveMcpServer` has been launched.

**Data flow**: Reads the server via `launch()`, matches the `Configured` variant, and constructs `McpServerMetadata` by copying `supports_parallel_tool_calls`, `default_tools_approval_mode`, and collecting explicit per-tool `approval_mode` values from `config.tools` into a `HashMap<String, AppToolApproval>`. It also computes `origin` through `McpServerOrigin::from_transport` and sets `pollutes_memory` to `true`.

**Call relations**: Called during manager/server setup and in tests that verify approval policy preservation. It depends on `launch()` to inspect the runtime server and delegates transport summarization to `from_transport()`.

*Call graph*: calls 2 internal fn (launch, from_transport); called by 2 (new, server_metadata_preserves_tool_approval_policy).


### `codex-mcp/src/codex_apps.rs`

`domain_logic` · `startup cache load and tool normalization`

This module contains the logic that only applies to the host-owned `codex_apps` MCP server. `CodexAppsToolsCacheKey` captures the authenticated user scope using optional account ID, optional ChatGPT user ID, and a workspace-account flag; `codex_apps_tools_cache_key` derives that key from `CodexAuth`. `CodexAppsToolsCacheContext` then turns the key into stable cache file paths by JSON-serializing the key, hashing it with SHA-1, and placing the resulting `<hash>.json` under separate tools and server-info cache directories inside `codex_home`. This isolates caches per authenticated user without exposing raw identifiers in filenames.

The normalization helpers strip connector-specific prefixes only for the host-owned apps server. `normalize_codex_apps_tool_title` removes a literal `<connector_name>_` prefix from display titles when present. `normalize_codex_apps_callable_name` sanitizes names first, then strips sanitized connector-name or connector-ID prefixes if doing so leaves a non-empty suffix. `normalize_codex_apps_callable_namespace` appends a sanitized connector name to the server namespace using `server__connector` form.

Caching is intentionally defensive. `write_cached_codex_apps_tools_if_needed` only runs for the apps server and, when a cache context exists, writes both filtered tools and server info, warning but not failing if server-info persistence breaks, and emits a cache-write duration metric. Startup loaders return `None` for non-apps servers and suppress invalid or missing caches. Tool-cache reads distinguish `Hit`, `Missing`, and `Invalid`, reject schema-version mismatches, and always filter disallowed connector IDs both on write and read. Server-info caching is versioned separately so newer server-info cache entries survive legacy or invalid tool-cache files. The file’s invariants are: cache only for the host-owned apps server, scope by user, never trust stale schema versions, and never expose blocked connectors from disk.

#### Function details

##### `codex_apps_tools_cache_key`  (lines 32–38)

```
fn codex_apps_tools_cache_key(auth: Option<&CodexAuth>) -> CodexAppsToolsCacheKey
```

**Purpose**: Derives the per-user cache key for Codex Apps from optional authentication state. It captures enough identity to isolate caches across users and workspace contexts.

**Data flow**: Takes `Option<&CodexAuth>`, reads account ID and ChatGPT user ID via `CodexAuth` accessors when present, computes `is_workspace_account` with `is_some_and`, and returns a `CodexAppsToolsCacheKey` containing those values.

**Call relations**: Called by higher-level MCP status and resource-reading flows before constructing a `CodexAppsToolsCacheContext` for startup cache access.

*Call graph*: called by 2 (collect_mcp_server_status_snapshot_with_detail, read_mcp_resource).


##### `CodexAppsToolsCacheContext::tools_cache_path`  (lines 47–49)

```
fn tools_cache_path(&self) -> PathBuf
```

**Purpose**: Returns the disk path for the current user’s cached Codex Apps tool list. It delegates path construction to the shared hashing helper.

**Data flow**: Reads `self`, passes the tools cache directory constant into `cache_path_in`, and returns the resulting `PathBuf`.

**Call relations**: Used by `load_cached_codex_apps_tools` and `write_cached_codex_apps_tools` so both read and write target the same per-user file.

*Call graph*: calls 1 internal fn (cache_path_in); called by 2 (load_cached_codex_apps_tools, write_cached_codex_apps_tools).


##### `CodexAppsToolsCacheContext::server_info_cache_path`  (lines 51–53)

```
fn server_info_cache_path(&self) -> PathBuf
```

**Purpose**: Returns the disk path for the current user’s cached Codex Apps server-info payload. It parallels the tools cache path but uses a separate directory.

**Data flow**: Reads `self`, passes the server-info cache directory constant into `cache_path_in`, and returns the resulting `PathBuf`.

**Call relations**: Used by `load_cached_codex_apps_server_info` and `write_cached_codex_apps_server_info`.

*Call graph*: calls 1 internal fn (cache_path_in); called by 2 (load_cached_codex_apps_server_info, write_cached_codex_apps_server_info).


##### `CodexAppsToolsCacheContext::cache_path_in`  (lines 55–61)

```
fn cache_path_in(&self, cache_dir: &str) -> PathBuf
```

**Purpose**: Builds a stable per-user cache filename inside a chosen cache directory by hashing the serialized user key. This avoids raw user identifiers in the filesystem path.

**Data flow**: Takes a cache directory name, serializes `self.user_key` to JSON with `serde_json::to_string`, falls back to an empty string on serialization failure, hashes that JSON with `sha1_hex`, joins `self.codex_home`, the cache directory, and `<hash>.json`, and returns the resulting `PathBuf`.

**Call relations**: This private helper underpins both cache-path accessors so tools and server-info caches share the same user-scoping scheme.

*Call graph*: calls 1 internal fn (sha1_hex); called by 2 (server_info_cache_path, tools_cache_path); 3 external calls (join, format!, to_string).


##### `normalize_codex_apps_tool_title`  (lines 70–94)

```
fn normalize_codex_apps_tool_title(
    server_name: &str,
    connector_name: Option<&str>,
    value: &str,
) -> String
```

**Purpose**: Normalizes a tool title for the host-owned apps server by removing a connector-name prefix when present. Non-apps servers and missing connector names are left untouched.

**Data flow**: Inputs are `server_name`, optional `connector_name`, and the original title `value`. If the server is not `CODEX_APPS_MCP_SERVER_NAME`, it returns `value.to_string()`. Otherwise it trims and validates `connector_name`, builds `<connector_name>_`, strips that prefix from `value` if present and non-empty after stripping, and returns either the stripped suffix or the original title.

**Call relations**: Used during Codex Apps tool normalization so model-visible titles do not redundantly repeat the connector name.

*Call graph*: 1 external calls (format!).


##### `normalize_codex_apps_callable_name`  (lines 96–129)

```
fn normalize_codex_apps_callable_name(
    server_name: &str,
    tool_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
) -> String
```

**Purpose**: Normalizes a model-callable tool name for the host-owned apps server by sanitizing it and removing connector-name or connector-ID prefixes. This produces shorter, connector-local callable names while preserving uniqueness rules elsewhere.

**Data flow**: Takes `server_name`, raw `tool_name`, optional `connector_id`, and optional `connector_name`. For non-apps servers it returns the original tool name. For apps, it sanitizes `tool_name`, then tries to sanitize and strip a non-empty connector name prefix; if that fails, it tries the sanitized connector ID prefix; if stripping would yield an empty string or no prefix matches, it returns the sanitized tool name.

**Call relations**: This helper is part of the Codex Apps naming pipeline and relies on `sanitize_name` from the plugin utility crate for consistent model-safe identifiers.

*Call graph*: calls 1 internal fn (sanitize_name).


##### `normalize_codex_apps_callable_namespace`  (lines 131–142)

```
fn normalize_codex_apps_callable_namespace(
    server_name: &str,
    connector_name: Option<&str>,
) -> String
```

**Purpose**: Builds the model-visible namespace for a Codex Apps tool, optionally extending the server namespace with a sanitized connector name. Other servers keep their original namespace.

**Data flow**: Consumes `server_name` and optional `connector_name`. If the server is the apps server and a connector name exists, it returns `format!("{}__{}", server_name, sanitize_name(connector_name))`; otherwise it returns `server_name.to_string()`.

**Call relations**: Used alongside callable-name normalization so tools from different connectors under the shared apps server can be namespaced distinctly.

*Call graph*: 1 external calls (format!).


##### `write_cached_codex_apps_tools_if_needed`  (lines 144–166)

```
fn write_cached_codex_apps_tools_if_needed(
    server_name: &str,
    cache_context: Option<&CodexAppsToolsCacheContext>,
    server_info: &McpServerInfo,
    tools: &[ToolInfo],
)
```

**Purpose**: Writes Codex Apps tools and server-info caches only when the current server is the host-owned apps server and a cache context is available. It also records cache-write latency and downgrades server-info write failures to warnings.

**Data flow**: Inputs are `server_name`, optional cache context, `&McpServerInfo`, and a slice of `ToolInfo`. If the server name is not the apps server, it returns immediately. Otherwise, when a cache context exists, it records `Instant::now()`, calls `write_cached_codex_apps_tools`, attempts `write_cached_codex_apps_server_info` and logs a warning on error, then emits `MCP_TOOLS_CACHE_WRITE_DURATION_METRIC` with the elapsed duration.

**Call relations**: Called after successful tool refreshes and server startup flows so the latest filtered tools and presentation metadata are persisted for future startup snapshots.

*Call graph*: calls 3 internal fn (write_cached_codex_apps_server_info, write_cached_codex_apps_tools, emit_duration); called by 4 (hard_refresh_codex_apps_tools_cache, codex_apps_server_info_cache_survives_legacy_tools_cache_write, startup_cached_codex_apps_tools_loads_from_disk_cache, start_server_task); 2 external calls (now, warn!).


##### `load_startup_cached_codex_apps_tools_snapshot`  (lines 168–182)

```
fn load_startup_cached_codex_apps_tools_snapshot(
    server_name: &str,
    cache_context: Option<&CodexAppsToolsCacheContext>,
) -> Option<Vec<ToolInfo>>
```

**Purpose**: Loads a startup snapshot of cached Codex Apps tools when available and valid. It hides the internal `Hit/Missing/Invalid` distinction from callers by returning `Option<Vec<ToolInfo>>`.

**Data flow**: Takes `server_name` and optional cache context. It returns `None` immediately for non-apps servers or absent context. Otherwise it calls `load_cached_codex_apps_tools` and maps `Hit(tools)` to `Some(tools)` while collapsing `Missing` and `Invalid` to `None`.

**Call relations**: Used during startup and tests to provide speculative tool listings without blocking on live server initialization.

*Call graph*: calls 1 internal fn (load_cached_codex_apps_tools); called by 3 (startup_cached_codex_apps_tools_loads_from_disk_cache, startup_cached_codex_apps_tools_loads_without_server_info_cache, new).


##### `load_startup_cached_codex_apps_server_info`  (lines 184–193)

```
fn load_startup_cached_codex_apps_server_info(
    server_name: &str,
    cache_context: Option<&CodexAppsToolsCacheContext>,
) -> Option<McpServerInfo>
```

**Purpose**: Loads cached Codex Apps server presentation metadata for startup use. It is gated to the host-owned apps server and absent cache contexts return `None`.

**Data flow**: Consumes `server_name` and optional cache context. It returns `None` for non-apps servers; otherwise it unwraps the context and delegates to `load_cached_codex_apps_server_info`, returning that `Option<McpServerInfo>`.

**Call relations**: Used during startup and tests so UI-facing server info can be shown from disk cache before live initialization completes.

*Call graph*: calls 1 internal fn (load_cached_codex_apps_server_info); called by 3 (startup_cached_codex_apps_tools_loads_from_disk_cache, startup_cached_codex_apps_tools_loads_without_server_info_cache, new).


##### `read_cached_codex_apps_tools`  (lines 196–203)

```
fn read_cached_codex_apps_tools(
    cache_context: &CodexAppsToolsCacheContext,
) -> Option<Vec<ToolInfo>>
```

**Purpose**: Test-only convenience wrapper that reads the cached tools file and returns tools only on a valid cache hit. It hides the internal invalid/missing distinction.

**Data flow**: Takes a cache context, calls `load_cached_codex_apps_tools`, and maps `Hit(tools)` to `Some(tools)` while returning `None` for `Missing` and `Invalid`.

**Call relations**: Used only by tests that inspect cache overwrite, user scoping, filtering, and invalid-cache behavior.

*Call graph*: calls 1 internal fn (load_cached_codex_apps_tools); called by 3 (codex_apps_tools_cache_filters_disallowed_connectors, codex_apps_tools_cache_is_overwritten_by_last_write, codex_apps_tools_cache_is_scoped_per_user).


##### `load_cached_codex_apps_tools`  (lines 205–224)

```
fn load_cached_codex_apps_tools(
    cache_context: &CodexAppsToolsCacheContext,
) -> CachedCodexAppsToolsLoad
```

**Purpose**: Reads and validates the on-disk Codex Apps tools cache, distinguishing missing files from invalid cache contents. Valid cache hits are filtered through the connector allow-list before being returned.

**Data flow**: Takes a cache context, computes the tools cache path, reads bytes from disk, returns `Missing` on `NotFound`, `Invalid` on other read errors, deserializes `CodexAppsToolsDiskCache` from JSON, returns `Invalid` on parse failure or schema-version mismatch, filters `cache.tools` with `filter_disallowed_codex_apps_tools`, and returns `CachedCodexAppsToolsLoad::Hit(filtered_tools)`.

**Call relations**: This is the core tools-cache reader used by startup snapshot loading, test helpers, and live tool-listing code that wants to reuse disk cache.

*Call graph*: calls 2 internal fn (tools_cache_path, filter_disallowed_codex_apps_tools); called by 3 (load_startup_cached_codex_apps_tools_snapshot, read_cached_codex_apps_tools, listed_tools); 3 external calls (Hit, from_slice, read).


##### `write_cached_codex_apps_tools`  (lines 226–244)

```
fn write_cached_codex_apps_tools(
    cache_context: &CodexAppsToolsCacheContext,
    tools: &[ToolInfo],
)
```

**Purpose**: Persists a filtered Codex Apps tool list to the per-user disk cache. Failures to create directories, serialize JSON, or write the file are silently ignored.

**Data flow**: Takes a cache context and a slice of `ToolInfo`, computes the tools cache path, creates parent directories if possible, clones and filters the tools with `filter_disallowed_codex_apps_tools`, serializes `CodexAppsToolsDiskCache { schema_version, tools }` to pretty JSON, and writes the bytes to disk. It returns unit and does not report errors.

**Call relations**: Called by `write_cached_codex_apps_tools_if_needed` and directly by tests that verify overwrite, scoping, and filtering behavior.

*Call graph*: calls 2 internal fn (tools_cache_path, filter_disallowed_codex_apps_tools); called by 4 (write_cached_codex_apps_tools_if_needed, codex_apps_tools_cache_filters_disallowed_connectors, codex_apps_tools_cache_is_overwritten_by_last_write, codex_apps_tools_cache_is_scoped_per_user); 4 external calls (to_vec, to_vec_pretty, create_dir_all, write).


##### `load_cached_codex_apps_server_info`  (lines 246–253)

```
fn load_cached_codex_apps_server_info(
    cache_context: &CodexAppsToolsCacheContext,
) -> Option<McpServerInfo>
```

**Purpose**: Reads the cached Codex Apps server-info payload from disk and validates its schema version. Invalid or missing cache files simply return `None`.

**Data flow**: Takes a cache context, reads bytes from `server_info_cache_path`, deserializes `CodexAppsServerInfoDiskCache`, checks that `schema_version` matches the current constant, and returns `Some(server_info)` only on success.

**Call relations**: Used by startup cache loading so presentation metadata can be restored independently of the tools cache.

*Call graph*: calls 1 internal fn (server_info_cache_path); called by 1 (load_startup_cached_codex_apps_server_info); 2 external calls (from_slice, read).


##### `write_cached_codex_apps_server_info`  (lines 255–280)

```
fn write_cached_codex_apps_server_info(
    cache_context: &CodexAppsToolsCacheContext,
    server_info: &McpServerInfo,
) -> anyhow::Result<()>
```

**Purpose**: Persists `McpServerInfo` for the host-owned apps server with contextual error messages. Unlike the tools-cache writer, it returns structured errors so callers can log them.

**Data flow**: Takes a cache context and `&McpServerInfo`, computes the server-info cache path, creates parent directories with `with_context` error messages, serializes `CodexAppsServerInfoDiskCache { schema_version, server_info: server_info.clone() }` to pretty JSON with contextual serialization errors, writes the bytes with a contextual path-specific error, and returns `anyhow::Result<()>`.

**Call relations**: Called only by `write_cached_codex_apps_tools_if_needed`, which intentionally logs failures as warnings instead of failing the surrounding tool-refresh flow.

*Call graph*: calls 1 internal fn (server_info_cache_path); called by 1 (write_cached_codex_apps_tools_if_needed); 4 external calls (clone, to_vec_pretty, create_dir_all, write).


##### `filter_disallowed_codex_apps_tools`  (lines 282–291)

```
fn filter_disallowed_codex_apps_tools(tools: Vec<ToolInfo>) -> Vec<ToolInfo>
```

**Purpose**: Removes tools whose `connector_id` is present but not allowed by the connector allow-list. Tools without a connector ID are retained.

**Data flow**: Consumes a `Vec<ToolInfo>`, iterates through it, checks each `tool.connector_id.as_deref()`, keeps entries with no connector ID or with IDs accepted by `is_connector_id_allowed`, collects the survivors into a new `Vec<ToolInfo>`, and returns it.

**Call relations**: Applied on both cache reads and writes, and also by uncached live listing code, so blocked connectors never leak through either fresh or persisted tool inventories.

*Call graph*: called by 3 (load_cached_codex_apps_tools, write_cached_codex_apps_tools, list_tools_for_client_uncached).


##### `sha1_hex`  (lines 311–316)

```
fn sha1_hex(s: &str) -> String
```

**Purpose**: Computes the lowercase hexadecimal SHA-1 digest of a string. It is used to derive opaque cache filenames from serialized user keys.

**Data flow**: Takes `&str`, creates a `Sha1` hasher, updates it with the string’s UTF-8 bytes, finalizes the digest, formats it as lowercase hex, and returns the resulting `String`.

**Call relations**: Called only by `CodexAppsToolsCacheContext::cache_path_in` as part of per-user cache path generation.

*Call graph*: called by 1 (cache_path_in); 2 external calls (new, format!).


### `codex-mcp/src/connection_manager.rs`

`orchestration` · `startup and request handling`

This module is the runtime coordinator for MCP connectivity. `McpConnectionManager` stores `AsyncManagedClient`s keyed by server name, per-server metadata, the list of required servers, plugin provenance, Codex Apps feature flags, and an `ElicitationRequestManager`. Its async constructor clones the effective server map, computes required enabled servers, emits a `Starting` event for each enabled server, prepares a per-user `CodexAppsToolsCacheContext` only for the host-owned apps server, chooses a runtime auth provider only when Codex-backed auth should be injected and no bearer-token env var is configured, constructs each `AsyncManagedClient`, and spawns startup tasks that await client initialization and emit `Ready`, `Cancelled`, or formatted `Failed` updates. A second task aggregates all startup outcomes into one `McpStartupComplete` event.

The manager then provides the session-facing API. `validate_required_servers` waits for all required clients and aggregates failures into one error. `list_all_tools` iterates all clients, relying on each client’s `listed_tools()` behavior to use startup snapshots when available, enriches each `ToolInfo` with server metadata, and normalizes names for model visibility. `hard_refresh_codex_apps_tools_cache` bypasses in-process caches for the apps server, records fetch/list metrics, rewrites disk caches, filters disabled tools, rewrites input schemas for model-visible file parameters, and normalizes names. Resource and template listing fan out concurrently across servers with pagination and duplicate-cursor detection, logging per-server failures instead of failing the whole aggregation. Direct per-server operations (`call_tool`, `list_resources`, `read_resource`, etc.) all resolve a ready client through `client_by_name` and attach contextual errors. The file also contains startup-error formatting helpers that special-case GitHub PAT guidance, auth-required login hints, and startup-timeout configuration hints.

#### Function details

##### `tool_is_model_visible`  (lines 88–104)

```
fn tool_is_model_visible(tool: &ToolInfo) -> bool
```

**Purpose**: Determines whether a tool should be exposed in model-facing declarations based on MCP UI visibility metadata. Tools without visibility metadata remain visible by default.

**Data flow**: Reads `tool.tool.meta`, drills into `ui.visibility` as a JSON array, and returns `true` if metadata is absent or if any array element equals the string `model`; otherwise returns `false`.

**Call relations**: This helper is part of the tool-normalization pipeline used elsewhere in the MCP subsystem to hide tools that are not explicitly model-visible.


##### `McpConnectionManager::new`  (lines 120–281)

```
async fn new(
        mcp_servers: &HashMap<String, EffectiveMcpServer>,
        store_mode: OAuthCredentialsStoreMode,
        keyring_backend_kind: AuthKeyringBackendKind,
        auth_entries: Hash
```

**Purpose**: Constructs and starts the session’s MCP connection manager, spawning initialization for every enabled server and wiring startup-status event emission, auth injection, elicitation handling, and Codex Apps cache context setup.

**Data flow**: Inputs include the effective server map, OAuth/keyring settings, auth status entries, approval policy, submit/event plumbing, cancellation token, permission profile, runtime context, Codex home path, Codex Apps cache key, feature flags, client elicitation capability, tool provenance, optional auth, and optional reviewer. It computes sorted required enabled server names, initializes maps and a `JoinSet`, creates an `ElicitationRequestManager`, wraps tool provenance in `Arc`, derives an optional Codex-backed auth provider, clones the server map, and for each enabled server stores metadata, emits a `Starting` update, optionally builds a `CodexAppsToolsCacheContext`, decides whether runtime auth should be injected, constructs an `AsyncManagedClient`, stores it, and spawns a task that awaits startup, maps the outcome to `Ready`/`Cancelled`/formatted `Failed`, emits a final per-server update, and returns `(server_name, outcome)`. After the loop it returns a manager containing the client map and shared state, and separately spawns a task that joins all startup tasks and sends one `McpStartupComplete` event summarizing ready, cancelled, and failed servers.

**Call relations**: This is the main runtime entry into the file, called by session setup and MCP refresh flows. It delegates event emission to `emit_update`, startup error wording to `mcp_init_error_display`, and client creation to `AsyncManagedClient::new`.

*Call graph*: calls 6 internal fn (emit_update, mcp_init_error_display, new, new, from, value); called by 7 (no_local_runtime_fails_local_stdio_but_keeps_local_http_server, collect_mcp_server_status_snapshot_with_detail, read_mcp_resource, list_accessible_connectors_from_mcp_tools_with_mcp_manager, install_host_owned_codex_apps_manager, refresh_mcp_servers_inner, new); 15 external calls (clone, new, child_token, clone, clone, new, new, clone, clone, send (+5 more)).


##### `McpConnectionManager::validate_required_servers`  (lines 287–327)

```
async fn validate_required_servers(&self) -> Result<()>
```

**Purpose**: Waits for all required servers to finish startup and returns a single aggregated error if any required server is missing or failed. It is intended to run after the manager has already been made reachable for elicitation handling.

**Data flow**: Reads `self.required_servers` and `self.clients`, iterates required names inside an instrumented async block, clones each async client if present, awaits `client()`, accumulates `McpStartupFailure` entries for missing clients or startup errors using `startup_outcome_error_message`, and returns `Ok(())` if none failed. Otherwise it formats all failures into one semicolon-separated string and returns `Err(anyhow!(...))`.

**Call relations**: Called by higher-level session initialization after `new`. It depends on `startup_outcome_error_message` to collapse `StartupOutcomeError` into user-facing text.

*Call graph*: calls 1 internal fn (startup_outcome_error_message); 4 external calls (new, anyhow!, format!, info_span!).


##### `McpConnectionManager::new_uninitialized_with_permission_profile`  (lines 329–348)

```
fn new_uninitialized_with_permission_profile(
        approval_policy: &Constrained<AskForApproval>,
        permission_profile: &PermissionProfile,
        prefix_mcp_tool_names: bool,
    ) -> Self
```

**Purpose**: Builds a manager with no clients but with elicitation policy state initialized. This is primarily for tests and contexts that need manager behavior without live MCP startup.

**Data flow**: Takes approval policy, permission profile, and the prefixing flag; initializes empty client and metadata maps, an empty required-server list, default tool provenance, `host_owned_codex_apps_enabled = false`, stores the prefix flag, creates an `ElicitationRequestManager` from the provided policy/profile with no reviewer, creates a fresh cancellation token, and returns the manager.

**Call relations**: Used by tests and helper constructors that need a lightweight manager shell without invoking `McpConnectionManager::new`.

*Call graph*: calls 2 internal fn (new, value); called by 3 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 6 external calls (new, new, new, new, default, clone).


##### `McpConnectionManager::has_servers`  (lines 350–352)

```
fn has_servers(&self) -> bool
```

**Purpose**: Reports whether the manager currently owns any MCP clients. It is a simple emptiness check over the client map.

**Data flow**: Reads `self.clients.is_empty()` and returns the negation as `bool`.

**Call relations**: Used by callers that need to know whether MCP functionality is present at all.


##### `McpConnectionManager::contains_server`  (lines 354–356)

```
fn contains_server(&self, server_name: &str) -> bool
```

**Purpose**: Checks whether a named server exists in the manager’s client map. It does not wait for startup or inspect readiness.

**Data flow**: Looks up `server_name` in `self.clients` and returns `bool` from `contains_key`.

**Call relations**: Used internally and by tests for presence checks distinct from readiness.


##### `McpConnectionManager::shutdown`  (lines 359–364)

```
async fn shutdown(&self)
```

**Purpose**: Cancels startup and shuts down all managed clients, including terminating stdio-backed server processes. It is the explicit teardown path for the manager.

**Data flow**: Calls `self.startup_cancellation_token.cancel()`, then iterates `self.clients.values()` and awaits each client’s `shutdown()`. It returns unit.

**Call relations**: Called during session teardown and by tests that verify pending startup/tool listing is cancelled cleanly.

*Call graph*: 1 external calls (cancel).


##### `McpConnectionManager::server_origin`  (lines 366–371)

```
fn server_origin(&self, server_name: &str) -> Option<&str>
```

**Purpose**: Returns the origin string recorded in server metadata for a named server, if any. This is presentation metadata rather than transport access.

**Data flow**: Looks up `server_name` in `self.server_metadata`, reads `metadata.origin`, converts it with `McpServerOrigin::as_str`, and returns `Option<&str>`.

**Call relations**: Used by downstream presentation and provenance consumers that need to display where a server came from.


##### `McpConnectionManager::server_pollutes_memory`  (lines 373–377)

```
fn server_pollutes_memory(&self, server_name: &str) -> bool
```

**Purpose**: Reports whether a server is considered memory-polluting according to its metadata. Missing metadata defaults to `true`.

**Data flow**: Looks up `server_name` in `self.server_metadata` and returns `metadata.pollutes_memory` when present, otherwise `true` via `is_none_or`.

**Call relations**: Used by higher-level logic that decides whether interactions with a server should be treated as polluting conversational memory.


##### `McpConnectionManager::plugin_id_for_mcp_server_name`  (lines 379–382)

```
fn plugin_id_for_mcp_server_name(&self, server_name: &str) -> Option<&str>
```

**Purpose**: Returns the plugin ID associated with a server name according to collected tool provenance. This links runtime server names back to plugin ownership.

**Data flow**: Delegates the lookup to `self.tool_plugin_provenance.plugin_id_for_mcp_server_name(server_name)` and returns `Option<&str>`.

**Call relations**: Used by callers that need plugin provenance after the manager has been constructed.


##### `McpConnectionManager::is_selected_plugin_mcp_server`  (lines 384–387)

```
fn is_selected_plugin_mcp_server(&self, server_name: &str) -> bool
```

**Purpose**: Reports whether a server name belongs to a selected-plugin MCP server rather than another source. It delegates to stored provenance.

**Data flow**: Calls `self.tool_plugin_provenance.is_selected_plugin_mcp_server(server_name)` and returns the resulting `bool`.

**Call relations**: Used by runtime logic that treats selected-plugin servers specially.


##### `McpConnectionManager::tool_approval_mode`  (lines 389–398)

```
fn tool_approval_mode(
        &self,
        server_name: &str,
        tool_name: &str,
    ) -> codex_config::AppToolApproval
```

**Purpose**: Returns the effective approval mode for a specific tool on a specific server using stored server metadata. Missing metadata falls back to the config default.

**Data flow**: Looks up `server_name` in `self.server_metadata`, calls `metadata.tool_approval_mode(tool_name)` when present, and otherwise returns `AppToolApproval::default()`.

**Call relations**: Used by higher-level approval flows when deciding how a tool invocation should be gated.


##### `McpConnectionManager::is_host_owned_codex_apps_server`  (lines 400–402)

```
fn is_host_owned_codex_apps_server(&self, server_name: &str) -> bool
```

**Purpose**: Checks whether a given server name is the special host-owned Codex Apps server and whether that feature is enabled. This gates apps-specific behavior.

**Data flow**: Reads `self.host_owned_codex_apps_enabled` and compares `server_name` to `CODEX_APPS_MCP_SERVER_NAME`, returning the conjunction.

**Call relations**: Used by callers that need to branch into Codex Apps–specific logic only when the feature is active.


##### `McpConnectionManager::set_approval_policy`  (lines 404–408)

```
fn set_approval_policy(&self, approval_policy: &Constrained<AskForApproval>)
```

**Purpose**: Updates the approval policy used by the shared elicitation request manager. The update is best-effort and ignored if the mutex is poisoned.

**Data flow**: Takes a constrained approval policy, locks `self.elicitation_requests.approval_policy`, writes `approval_policy.value()` into it on success, and returns unit.

**Call relations**: Called when session approval settings change after manager construction so future elicitation requests use the new policy.

*Call graph*: calls 1 internal fn (value).


##### `McpConnectionManager::set_permission_profile`  (lines 410–414)

```
fn set_permission_profile(&self, permission_profile: PermissionProfile)
```

**Purpose**: Updates the permission profile used by the elicitation request manager. This affects future auto-approval decisions.

**Data flow**: Locks `self.elicitation_requests.permission_profile`, writes the provided `PermissionProfile` into it on success, and returns unit.

**Call relations**: Used when the session’s permission profile changes dynamically.


##### `McpConnectionManager::elicitations_auto_deny`  (lines 416–418)

```
fn elicitations_auto_deny(&self) -> bool
```

**Purpose**: Reports whether the manager is currently configured to auto-decline all elicitation requests. It simply exposes the underlying request-manager flag.

**Data flow**: Delegates to `self.elicitation_requests.auto_deny()` and returns the resulting `bool`.

**Call relations**: Used by callers that need to inspect current elicitation behavior.

*Call graph*: calls 1 internal fn (auto_deny).


##### `McpConnectionManager::set_elicitations_auto_deny`  (lines 420–422)

```
fn set_elicitations_auto_deny(&self, auto_deny: bool)
```

**Purpose**: Enables or disables blanket auto-denial of elicitation requests. This is a runtime switch over the shared request manager.

**Data flow**: Passes the provided `bool` into `self.elicitation_requests.set_auto_deny(auto_deny)` and returns unit.

**Call relations**: Used by higher-level session controls to suppress interactive elicitation handling.

*Call graph*: calls 1 internal fn (set_auto_deny).


##### `McpConnectionManager::resolve_elicitation`  (lines 424–433)

```
async fn resolve_elicitation(
        &self,
        server_name: String,
        id: RequestId,
        response: ElicitationResponse,
    ) -> Result<()>
```

**Purpose**: Resolves a pending elicitation request for a specific server and request ID by forwarding the response to the stored responder. It is the manager-facing entry point for user decisions.

**Data flow**: Consumes `server_name`, `RequestId`, and `ElicitationResponse`, forwards them to `self.elicitation_requests.resolve(...).await`, and returns the resulting `Result<()>`.

**Call relations**: Called by external request-handling code after a user or reviewer responds to an elicitation event.

*Call graph*: calls 1 internal fn (resolve).


##### `McpConnectionManager::wait_for_server_ready`  (lines 435–444)

```
async fn wait_for_server_ready(&self, server_name: &str, timeout: Duration) -> bool
```

**Purpose**: Waits up to a timeout for a named server to finish startup successfully. Missing servers, startup failures, and timeouts all return `false`.

**Data flow**: Looks up the async client by name; if absent returns `false`. Otherwise wraps `async_managed_client.client()` in `tokio::time::timeout(timeout, ...)` and returns `true` only for `Ok(Ok(_))`, `false` for startup errors or timeout expiry.

**Call relations**: Used by tests and runtime code that need a bounded readiness probe rather than full startup validation.

*Call graph*: 1 external calls (timeout).


##### `McpConnectionManager::list_all_tools`  (lines 448–485)

```
async fn list_all_tools(&self) -> Vec<ToolInfo>
```

**Purpose**: Aggregates tools from all managed servers, enriching them with server metadata and normalizing names for model use. It relies on each async client to use cached startup snapshots when live startup is still pending or has failed.

**Data flow**: Creates an output `Vec<ToolInfo>`, iterates `self.clients`, reads each client’s cached-snapshot presence and startup-complete flag for tracing, awaits `managed_client.listed_tools()`, skips servers returning `None`, maps each returned tool through `self.with_server_metadata`, extends the aggregate vector, then passes the full list into `normalize_tools_for_model_with_prefix` using `self.prefix_mcp_tool_names` and returns the normalized vector.

**Call relations**: Called by higher-level connector/tool listing flows. It delegates actual per-client listing behavior to `AsyncManagedClient::listed_tools` and final naming to `normalize_tools_for_model_with_prefix`.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); called by 1 (list_accessible_and_enabled_connectors_from_manager); 3 external calls (new, trace!, trace_span!).


##### `McpConnectionManager::hard_refresh_codex_apps_tools_cache`  (lines 492–540)

```
async fn hard_refresh_codex_apps_tools_cache(&self) -> Result<Vec<ToolInfo>>
```

**Purpose**: Force-refreshes the host-owned Codex Apps tool list by bypassing in-process caches, then rewrites disk caches and returns the freshly normalized model-visible tools. Existing cache contents are left untouched if the refresh fails.

**Data flow**: Looks up the Codex Apps async client, awaits a ready `ManagedClient`, records list and fetch start times, calls `list_tools_for_client_uncached` with the raw RMCP client, timeout, and optional server instructions, emits uncached-fetch duration, writes tools and server info to disk via `write_cached_codex_apps_tools_if_needed`, emits overall list duration tagged as cache miss, filters the tools through the client’s `tool_filter`, rewrites each tool’s schema with `tool_with_model_visible_input_schema`, enriches each with `with_server_metadata`, normalizes names with `normalize_tools_for_model_with_prefix`, and returns the resulting `Vec<ToolInfo>`.

**Call relations**: Used by explicit refresh flows for the apps server. It composes uncached RMCP listing, disk-cache persistence, tool filtering, schema rewriting, and model-name normalization.

*Call graph*: calls 5 internal fn (write_cached_codex_apps_tools_if_needed, list_tools_for_client_uncached, emit_duration, filter_tools, normalize_tools_for_model_with_prefix); 1 external calls (now).


##### `McpConnectionManager::list_all_resources`  (lines 544–605)

```
async fn list_all_resources(&self) -> HashMap<String, Vec<Resource>>
```

**Purpose**: Lists resources from every ready server concurrently and aggregates them into a map keyed by server name. Per-server failures are logged and omitted rather than aborting the whole operation.

**Data flow**: Creates a `JoinSet`, iterates `self.clients`, awaits each ready `ManagedClient`, clones the RMCP client and timeout, and spawns a task that repeatedly calls `list_resources` with pagination params, accumulates `Resource`s, detects duplicate cursors as an error, and returns either `(server_name, Ok(resources))` or `(server_name, Err(err))`. The outer function then joins tasks, inserts successful results into a `HashMap<String, Vec<Resource>>`, logs warnings for per-server errors or task panics, and returns the aggregated map.

**Call relations**: This is the cross-server resource aggregation API. It parallels `list_all_resource_templates` but targets concrete resources.

*Call graph*: 5 external calls (new, new, new, anyhow!, warn!).


##### `McpConnectionManager::list_all_resource_templates`  (lines 609–674)

```
async fn list_all_resource_templates(&self) -> HashMap<String, Vec<ResourceTemplate>>
```

**Purpose**: Lists resource templates from every ready server concurrently and aggregates them by server name. Like resource listing, it tolerates per-server failures and logs them.

**Data flow**: Creates a `JoinSet`, iterates ready clients, clones each RMCP client and timeout, and spawns a task that repeatedly calls `list_resource_templates` with pagination, accumulates `ResourceTemplate`s, errors on duplicate cursors, and returns `(server_name, Result<Vec<ResourceTemplate>, _>)`. The outer loop joins tasks, inserts successes into a `HashMap`, logs warnings for failures or panics, and returns the map.

**Call relations**: This is the template counterpart to `list_all_resources`, sharing the same concurrency and duplicate-cursor safeguards.

*Call graph*: 5 external calls (new, new, new, anyhow!, warn!).


##### `McpConnectionManager::call_tool`  (lines 677–712)

```
async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        arguments: Option<serde_json::Value>,
        meta: Option<serde_json::Value>,
    ) -> Result<CallToolResult>
```

**Purpose**: Invokes a specific tool on a specific server after checking that the tool is enabled by the server’s filter. It converts the RMCP result into the protocol-layer `CallToolResult` shape used by Codex.

**Data flow**: Inputs are server name, tool name, optional JSON arguments, and optional JSON meta. It resolves a ready `ManagedClient` via `client_by_name`, rejects disabled tools with an `anyhow!` error if `tool_filter.allows(tool)` is false, calls the RMCP client’s `call_tool`, adds context on failure, converts each returned content item to `serde_json::Value` with a string fallback on serialization failure, preserves `structured_content` and `is_error`, converts `meta` to JSON if possible, and returns `Result<CallToolResult>`.

**Call relations**: Used by request handlers for direct tool invocation. It depends on `client_by_name` for readiness/error handling and on the per-server `ToolFilter` to enforce configured tool restrictions.

*Call graph*: calls 1 internal fn (client_by_name); 1 external calls (anyhow!).


##### `McpConnectionManager::server_supports_sandbox_state_meta_capability`  (lines 714–722)

```
async fn server_supports_sandbox_state_meta_capability(
        &self,
        server: &str,
    ) -> Result<bool>
```

**Purpose**: Reports whether a named server advertises support for sandbox-state metadata capability. It is a thin accessor over the resolved managed client.

**Data flow**: Resolves a ready `ManagedClient` with `client_by_name`, reads `server_supports_sandbox_state_meta_capability`, wraps it in `Ok`, and returns `Result<bool>`.

**Call relations**: Used by callers that need to tailor requests based on server capability support.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::list_resources`  (lines 725–738)

```
async fn list_resources(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> Result<ListResourcesResult>
```

**Purpose**: Lists resources from one specific server with optional pagination parameters. It adds contextual error text naming the server.

**Data flow**: Resolves a ready `ManagedClient` via `client_by_name`, reads its timeout, calls `managed.client.list_resources(params, timeout).await`, adds `resources/list failed for` context on error, and returns the `ListResourcesResult`.

**Call relations**: This is the single-server counterpart to `list_all_resources`.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::list_resource_templates`  (lines 741–754)

```
async fn list_resource_templates(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> Result<ListResourceTemplatesResult>
```

**Purpose**: Lists resource templates from one specific server with optional pagination parameters. It clones the underlying client handle and adds contextual errors.

**Data flow**: Resolves a ready `ManagedClient`, clones `managed.client`, reads the timeout, calls `list_resource_templates(params, timeout).await`, adds `resources/templates/list failed for` context on error, and returns the `ListResourceTemplatesResult`.

**Call relations**: This is the single-server counterpart to `list_all_resource_templates`.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::read_resource`  (lines 757–771)

```
async fn read_resource(
        &self,
        server: &str,
        params: ReadResourceRequestParams,
    ) -> Result<ReadResourceResult>
```

**Purpose**: Reads one resource from a specific server and includes the resource URI in any error context. It is the direct resource-fetch API.

**Data flow**: Resolves a ready `ManagedClient`, clones the RMCP client, reads the timeout, clones `params.uri` for error reporting, calls `read_resource(params, timeout).await`, adds `resources/read failed for` context including the URI, and returns the `ReadResourceResult`.

**Call relations**: Used by request handlers that need to fetch a concrete MCP resource from a chosen server.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::list_available_server_infos`  (lines 775–796)

```
async fn list_available_server_infos(&self) -> HashMap<String, McpServerInfo>
```

**Purpose**: Returns presentation metadata for all servers without blocking on clients that are still starting. It prefers live server info when startup is complete and falls back to cached server info otherwise.

**Data flow**: Creates an output `HashMap<String, McpServerInfo>`, iterates `self.clients`, checks each client’s `startup_complete` atomic flag, and if startup is incomplete inserts `cached_server_info` when present and continues. For completed startups it awaits `client.client()`: on success it inserts `managed_client.server_info`; on failure it falls back to `cached_server_info` if available. It returns the assembled map.

**Call relations**: Called by status-snapshot code and tested specifically for non-blocking behavior while startup is pending or failed.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager); 1 external calls (new).


##### `McpConnectionManager::with_server_metadata`  (lines 798–811)

```
fn with_server_metadata(&self, mut tool: ToolInfo) -> ToolInfo
```

**Purpose**: Copies server-level metadata onto a `ToolInfo` so aggregated tool listings carry origin and parallel-call capability. Missing metadata forces conservative defaults.

**Data flow**: Consumes a mutable `ToolInfo`. If `self.server_metadata` lacks an entry for `tool.server_name`, it sets `supports_parallel_tool_calls = false` and `server_origin = None` and returns the tool. Otherwise it copies `supports_parallel_tool_calls` and stringifies `origin` into `tool.server_origin`, then returns the modified tool.

**Call relations**: Used by `list_all_tools` and `hard_refresh_codex_apps_tools_cache` before final name normalization so every returned tool carries server metadata.


##### `McpConnectionManager::client_by_name`  (lines 813–820)

```
async fn client_by_name(&self, name: &str) -> Result<ManagedClient>
```

**Purpose**: Resolves a named server to a ready `ManagedClient` or returns a contextual error if the server is unknown or startup failed. It centralizes client lookup and readiness waiting.

**Data flow**: Looks up `name` in `self.clients`, returns an `anyhow!` unknown-server error if absent, otherwise awaits `client()` on the async client and adds `failed to get client` context on error, returning `Result<ManagedClient>`.

**Call relations**: This helper underpins direct per-server operations such as `call_tool`, `list_resources`, `list_resource_templates`, `read_resource`, and capability checks.

*Call graph*: called by 5 (call_tool, list_resource_templates, list_resources, read_resource, server_supports_sandbox_state_meta_capability).


##### `McpConnectionManager::new_uninitialized`  (lines 823–833)

```
fn new_uninitialized(
        approval_policy: &Constrained<AskForApproval>,
        permission_profile: &Constrained<PermissionProfile>,
        prefix_mcp_tool_names: bool,
    ) -> Self
```

**Purpose**: Test-only wrapper that builds an uninitialized manager from constrained approval and permission-profile values. It unwraps the constrained permission profile before delegating.

**Data flow**: Takes constrained approval policy and constrained permission profile plus the prefix flag, calls `permission_profile.get()`, forwards the values to `new_uninitialized_with_permission_profile`, and returns the manager.

**Call relations**: Used extensively by tests in `connection_manager_tests.rs` to create a manager shell with no live startup.

*Call graph*: calls 1 internal fn (get); called by 9 (list_all_tools_accepts_canonical_namespaced_tool_names, list_all_tools_adds_server_metadata_to_cached_tools, list_all_tools_applies_legacy_mcp_prefix_by_default, list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot, list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending, list_available_server_infos_uses_cache_while_client_is_pending, shutdown_cancels_pending_tool_listing); 1 external calls (new_uninitialized_with_permission_profile).


##### `McpConnectionManager::drop`  (lines 837–840)

```
fn drop(&mut self)
```

**Purpose**: Ensures startup cancellation and client-map cleanup when the manager is dropped. This is a safety net for teardown paths that do not call `shutdown` explicitly.

**Data flow**: On mutable drop, calls `self.startup_cancellation_token.cancel()` and clears `self.clients`.

**Call relations**: Runs automatically at object destruction; it complements but does not replace the explicit async `shutdown` method.

*Call graph*: 1 external calls (cancel).


##### `emit_update`  (lines 843–854)

```
async fn emit_update(
    submit_id: &str,
    tx_event: &Sender<Event>,
    update: McpStartupUpdateEvent,
) -> Result<(), async_channel::SendError<Event>>
```

**Purpose**: Sends one MCP startup-update event over the async event channel. It wraps the update in the outer `Event` envelope with the provided submit ID.

**Data flow**: Takes `submit_id`, `&Sender<Event>`, and `McpStartupUpdateEvent`, constructs `Event { id: submit_id.to_string(), msg: EventMsg::McpStartupUpdate(update) }`, sends it asynchronously, and returns the channel send result.

**Call relations**: Called by `McpConnectionManager::new` before startup begins and again when each server’s startup outcome is known.

*Call graph*: called by 1 (new); 2 external calls (send, McpStartupUpdate).


##### `mcp_init_error_display`  (lines 856–897)

```
fn mcp_init_error_display(
    server_name: &str,
    entry: Option<&McpAuthStatusEntry>,
    err: &StartupOutcomeError,
) -> String
```

**Purpose**: Formats startup failures into user-facing guidance, with special cases for GitHub PAT configuration, auth-required login prompts, and startup-timeout hints. Generic failures fall back to the formatted underlying error.

**Data flow**: Inputs are `server_name`, optional `McpAuthStatusEntry`, and `&StartupOutcomeError`. It inspects the entry’s transport config to detect the GitHub Copilot MCP URL with no bearer token or headers and returns a PAT setup message in that case. Otherwise it checks `is_mcp_client_auth_required_error` to return a `codex mcp login` hint, checks `is_mcp_client_startup_timeout_error` to compute the effective startup timeout from config or `DEFAULT_STARTUP_TIMEOUT` and return a config hint, and otherwise formats `MCP client for ... failed to start: {err:#}`.

**Call relations**: Used by `McpConnectionManager::new` when converting startup failures into `McpStartupStatus::Failed` event payloads.

*Call graph*: calls 2 internal fn (is_mcp_client_auth_required_error, is_mcp_client_startup_timeout_error); called by 1 (new); 1 external calls (format!).


##### `startup_outcome_error_message`  (lines 899–904)

```
fn startup_outcome_error_message(error: StartupOutcomeError) -> String
```

**Purpose**: Converts a `StartupOutcomeError` into a plain message string without extra context. It is used when aggregating required-server failures.

**Data flow**: Matches on the error: `Cancelled` becomes `MCP startup cancelled`, and `Failed { error }` returns the contained error string.

**Call relations**: Called by `validate_required_servers` after awaiting required clients.

*Call graph*: called by 1 (validate_required_servers).


##### `is_mcp_client_auth_required_error`  (lines 906–911)

```
fn is_mcp_client_auth_required_error(error: &StartupOutcomeError) -> bool
```

**Purpose**: Detects whether a startup failure string indicates missing authentication. The check is substring-based.

**Data flow**: Matches `StartupOutcomeError::Failed { error }`, checks whether `error.contains("Auth required")`, and returns the resulting `bool`; all other variants return `false`.

**Call relations**: Used only by `mcp_init_error_display` to choose the login-hint message.

*Call graph*: called by 1 (mcp_init_error_display); 1 external calls (contains).


##### `is_mcp_client_startup_timeout_error`  (lines 913–921)

```
fn is_mcp_client_startup_timeout_error(error: &StartupOutcomeError) -> bool
```

**Purpose**: Detects whether a startup failure string represents a timeout during request or handshake. The check is based on known substrings from underlying client errors.

**Data flow**: Matches `StartupOutcomeError::Failed { error }`, returns true if the string contains `request timed out` or `timed out handshaking with MCP server`, and false otherwise.

**Call relations**: Used only by `mcp_init_error_display` to choose the startup-timeout guidance message.

*Call graph*: called by 1 (mcp_init_error_display); 1 external calls (contains).


### `codex-mcp/src/resource_client.rs`

`orchestration` · `request handling`

This file defines a narrow resource-only facade over `McpConnectionManager`. `McpResourceClient` stores `Arc<ArcSwap<McpConnectionManager>>` rather than a fixed manager snapshot, which means every operation loads the current manager at call time and transparently follows startup or refresh replacements. The companion `McpResourceClientCacheKey` is an opaque identity built from a `Weak<McpConnectionManager>`; equality is pointer-based, so caches can cheaply detect when the published manager instance has changed.

The public API is intentionally small. `has_server` checks whether the current manager knows about a named server without waiting for startup. `list_resources` optionally wraps a caller-supplied cursor into `PaginatedRequestParams`, delegates to the manager, and converts each returned `rmcp::model::Resource` into the protocol-layer `Resource` type. `read_resource` similarly delegates a URI read and converts each `rmcp::model::ResourceContents` item into `ResourceContent`. Both conversions go through JSON serialization/deserialization with `anyhow::Context` labels, so failures carry concrete messages like "failed to serialize MCP resource" or "failed to convert MCP resource content". The custom `Debug` implementation intentionally hides the internal manager handle by emitting a non-exhaustive struct, keeping logs stable and avoiding accidental exposure of implementation details.

#### Function details

##### `McpResourceClientCacheKey::eq`  (lines 44–46)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Compares two cache keys by the identity of the underlying manager allocation. It does not inspect manager contents.

**Data flow**: Reads the inner `Weak<McpConnectionManager>` from `self` and `other` and returns the result of `ptr_eq`, indicating whether both keys point at the same published manager instance.

**Call relations**: This equality implementation supports cache invalidation logic outside this file by making manager replacement observable through pointer identity.


##### `McpResourceClient::fmt`  (lines 52–56)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats `McpResourceClient` for debugging without exposing internal state. It emits a non-exhaustive debug struct named `McpResourceClient`.

**Data flow**: Reads `self` only to satisfy the trait signature, writes a `debug_struct("McpResourceClient")` with `finish_non_exhaustive()` into the provided formatter, and returns the formatting result.

**Call relations**: This custom formatter keeps logs concise and avoids printing the internal `ArcSwap` manager handle.

*Call graph*: 1 external calls (debug_struct).


##### `McpResourceClient::new`  (lines 61–63)

```
fn new(manager: Arc<ArcSwap<McpConnectionManager>>) -> Self
```

**Purpose**: Constructs a resource client backed by a replaceable shared manager publication handle. The client will always consult the latest published manager.

**Data flow**: Consumes `Arc<ArcSwap<McpConnectionManager>>` and stores it in `Self { manager }`, returning the new `McpResourceClient`.

**Call relations**: This constructor is used by higher-level session setup code that owns the shared manager publication.

*Call graph*: called by 1 (new).


##### `McpResourceClient::cache_key`  (lines 66–68)

```
fn cache_key(&self) -> McpResourceClientCacheKey
```

**Purpose**: Returns an opaque identity for the currently published manager. The key changes when the `ArcSwap` publishes a different manager instance.

**Data flow**: Loads the current `Arc<McpConnectionManager>` from `self.manager`, downgrades it to `Weak<McpConnectionManager>`, wraps it in `McpResourceClientCacheKey`, and returns that key.

**Call relations**: This helper supports external memoization layers that need to invalidate cached resource data when the manager changes.

*Call graph*: 1 external calls (downgrade).


##### `McpResourceClient::has_server`  (lines 73–75)

```
async fn has_server(&self, server: &str) -> bool
```

**Purpose**: Checks whether the current manager contains a named server. It is a cheap existence probe and does not imply startup success.

**Data flow**: Loads the current manager from `ArcSwap`, calls `contains_server(server)`, and returns the resulting boolean.

**Call relations**: This is a direct pass-through to manager state, intended for callers that need to gate resource UI or requests on server presence.


##### `McpResourceClient::list_resources`  (lines 78–99)

```
async fn list_resources(
        &self,
        server: &str,
        cursor: Option<String>,
    ) -> Result<McpResourcePage>
```

**Purpose**: Lists one page of resources from a named MCP server and converts them into protocol-layer resource values. It preserves the server-provided pagination cursor.

**Data flow**: Reads `server` and optional `cursor`. If a cursor is present it builds `PaginatedRequestParams::default().with_cursor(Some(cursor))`; otherwise it uses `None`. It loads the current manager, awaits `list_resources(server, params)`, maps each returned RMCP resource through `resource_from_rmcp`, collects them into `Vec<Resource>`, and returns `McpResourcePage { resources, next_cursor: result.next_cursor }`.

**Call relations**: This method delegates transport and protocol interaction to `McpConnectionManager`, while this file owns the conversion into public resource types.


##### `McpResourceClient::read_resource`  (lines 102–114)

```
async fn read_resource(&self, server: &str, uri: &str) -> Result<McpResourceReadResult>
```

**Purpose**: Reads one resource URI from a named MCP server and converts the returned contents into protocol-layer `ResourceContent` values.

**Data flow**: Reads `server` and `uri`, loads the current manager, constructs `ReadResourceRequestParams::new(uri.to_string())`, awaits `read_resource`, maps each returned RMCP content item through `resource_content_from_rmcp`, collects them into `Vec<ResourceContent>`, and returns `McpResourceReadResult { contents }`.

**Call relations**: Like `list_resources`, this method is a thin facade over `McpConnectionManager` plus local type conversion.

*Call graph*: 1 external calls (new).


##### `resource_from_rmcp`  (lines 117–120)

```
fn resource_from_rmcp(resource: rmcp::model::Resource) -> Result<Resource>
```

**Purpose**: Converts one RMCP resource into the protocol-layer `Resource` type with contextual error messages. It uses JSON as the compatibility bridge between the two models.

**Data flow**: Consumes `rmcp::model::Resource`, serializes it to `serde_json::Value` with context `failed to serialize MCP resource`, then calls `Resource::from_mcp_value(value)` with context `failed to convert MCP resource`, returning the resulting `anyhow::Result<Resource>`.

**Call relations**: This helper is used by `McpResourceClient::list_resources` for per-item conversion.

*Call graph*: calls 1 internal fn (from_mcp_value); 1 external calls (to_value).


##### `resource_content_from_rmcp`  (lines 122–126)

```
fn resource_content_from_rmcp(content: rmcp::model::ResourceContents) -> Result<ResourceContent>
```

**Purpose**: Converts one RMCP resource-content payload into the protocol-layer `ResourceContent` type. It also uses JSON as the conversion boundary and annotates failures.

**Data flow**: Consumes `rmcp::model::ResourceContents`, serializes it to JSON with context `failed to serialize MCP resource content`, then deserializes that value into `ResourceContent` with context `failed to convert MCP resource content`, returning the result.

**Call relations**: This helper is used by `McpResourceClient::read_resource` for per-content conversion.

*Call graph*: 2 external calls (from_value, to_value).


### `codex-mcp/src/mcp/mod.rs`

`orchestration` · `config-derived server setup and MCP snapshot/request handling`

This module is the public MCP surface for the crate. It starts by re-exporting auth helpers from `auth.rs`, then defines core runtime-facing types: `McpSnapshotDetail` controls whether snapshots include resources, `McpConfig` carries long-lived MCP settings copied from the root application config, `ToolPluginProvenance` maps connector IDs and MCP server names back to plugin display names and IDs, and `McpServerStatusSnapshot` is the normalized aggregate returned to callers. The file also owns constants for the built-in apps server and tool-name qualification.

A major responsibility here is deriving the effective server map. `configured_mcp_servers` pulls registrations from the resolved catalog, `host_owned_codex_apps_enabled` gates the built-in apps server on both config and ChatGPT-backed auth, and `effective_mcp_servers_from_configured` removes that server when runtime auth is unavailable without synthesizing anything new. For runtime operations, `read_mcp_resource` and `collect_mcp_server_status_snapshot_with_detail` both compute auth statuses first, create an `McpConnectionManager` with approval policy, runtime context, cache key, plugin provenance, and cancellation token, then perform the requested read or snapshot and cancel the manager afterward.

The module also contains several normalization helpers that are easy to miss: tool names are sanitized to Responses API constraints without lowercasing; ChatGPT base URLs are rewritten to legacy `/backend-api/wham/apps` or `/api/codex/apps` forms depending on host/path; and RMCP tool/resource/resource-template values are serialized through JSON and converted into protocol-layer types, logging and dropping only the malformed entries rather than failing the whole snapshot.

#### Function details

##### `McpSnapshotDetail::include_resources`  (lines 61–63)

```
fn include_resources(self) -> bool
```

**Purpose**: Returns whether a snapshot request should include resources and resource templates. Only `Full` snapshots include them.

**Data flow**: Consumes `self` by value and returns a boolean computed from whether the enum variant is `Full`.

**Call relations**: This helper is used inside snapshot collection to decide whether to call the manager's resource-listing APIs or substitute empty maps.

*Call graph*: 1 external calls (matches!).


##### `qualified_mcp_tool_name_prefix`  (lines 66–70)

```
fn qualified_mcp_tool_name_prefix(server_name: &str) -> String
```

**Purpose**: Builds the model-visible prefix for tools from one MCP server. The prefix uses the legacy `mcp__{server}__` shape and sanitizes disallowed characters.

**Data flow**: Reads `server_name`, formats `mcp__{server_name}__`, passes that string through `sanitize_responses_api_tool_name`, and returns the sanitized prefix.

**Call relations**: This helper delegates the character-level cleanup to `sanitize_responses_api_tool_name` so callers get a Responses-API-safe namespace prefix.

*Call graph*: calls 1 internal fn (sanitize_responses_api_tool_name); 1 external calls (format!).


##### `mcp_permission_prompt_is_auto_approved`  (lines 74–93)

```
fn mcp_permission_prompt_is_auto_approved(
    approval_policy: AskForApproval,
    permission_profile: &PermissionProfile,
    context: McpPermissionPromptAutoApproveContext,
) -> bool
```

**Purpose**: Determines whether an MCP permission prompt should be treated as already approved instead of shown to the user. It combines per-tool approval mode, global approval policy, and the active permission profile.

**Data flow**: Reads `approval_policy`, a borrowed `PermissionProfile`, and `McpPermissionPromptAutoApproveContext`. It returns true immediately when `tool_approval_mode` is `Some(AppToolApproval::Approve)`. Otherwise it rejects all policies except `AskForApproval::Never`, then returns true for `PermissionProfile::Disabled` and `External`, and for `Managed` only when the file-system sandbox policy grants full disk write access.

**Call relations**: This is pure policy logic used by higher-level MCP prompting flows. It does not delegate further because the approval decision is encoded entirely in the passed enums and profile.


##### `ToolPluginProvenance::plugin_display_names_for_connector_id`  (lines 159–164)

```
fn plugin_display_names_for_connector_id(&self, connector_id: &str) -> &[String]
```

**Purpose**: Looks up plugin display names associated with an app connector ID. Missing connector IDs produce an empty slice rather than an allocation.

**Data flow**: Reads `self.plugin_display_names_by_connector_id`, performs a map lookup by `connector_id`, converts the stored `Vec<String>` to `&[String]` when present, and otherwise returns a shared empty slice.

**Call relations**: This accessor is used when annotating tools that carry connector metadata so the session can attribute them to plugins.

*Call graph*: called by 1 (with_app_plugin_sources).


##### `ToolPluginProvenance::plugin_display_names_for_mcp_server_name`  (lines 166–171)

```
fn plugin_display_names_for_mcp_server_name(&self, server_name: &str) -> &[String]
```

**Purpose**: Looks up plugin display names associated with an MCP server name. It is the fallback attribution path for tools without connector IDs.

**Data flow**: Reads `self.plugin_display_names_by_mcp_server_name`, returns the stored vector as a slice when present, or `&[]` when absent.

**Call relations**: This accessor is consumed by tool-annotation logic when provenance is attached at the server level rather than connector level.


##### `ToolPluginProvenance::plugin_id_for_mcp_server_name`  (lines 173–177)

```
fn plugin_id_for_mcp_server_name(&self, server_name: &str) -> Option<&str>
```

**Purpose**: Returns the plugin ID associated with an MCP server name, if one was recorded from catalog attribution. It exposes IDs as `&str` borrowed from internal `String` storage.

**Data flow**: Reads `self.plugin_ids_by_mcp_server_name`, looks up `server_name`, and maps the stored `String` to `&str` with `String::as_str`.

**Call relations**: This is a read-only accessor for callers that need stable plugin identity rather than display names.


##### `ToolPluginProvenance::is_selected_plugin_mcp_server`  (lines 179–181)

```
fn is_selected_plugin_mcp_server(&self, server_name: &str) -> bool
```

**Purpose**: Reports whether a server name belongs to the set of selected plugin MCP servers. This distinguishes selected-plugin registrations from unrelated local summaries.

**Data flow**: Checks membership of `server_name` in `self.selected_plugin_mcp_server_names` and returns the boolean result.

**Call relations**: This helper supports provenance-sensitive logic that treats selected plugin servers specially.


##### `ToolPluginProvenance::from_config`  (lines 183–231)

```
fn from_config(config: &McpConfig) -> Self
```

**Purpose**: Builds plugin provenance indexes from `McpConfig`. It merges connector-level plugin summaries with MCP-server-level catalog attributions, then sorts and deduplicates display-name lists.

**Data flow**: Reads `config.plugin_capability_summaries` to populate `plugin_display_names_by_connector_id`, then reads `config.mcp_server_catalog.plugin_attributions_by_server_name()` to populate `plugin_display_names_by_mcp_server_name` and `plugin_ids_by_mcp_server_name`. It extends `selected_plugin_mcp_server_names` from `selected_plugin_server_names()`, sorts and deduplicates every display-name vector in both maps, and returns the assembled `ToolPluginProvenance`.

**Call relations**: This constructor is wrapped by `tool_plugin_provenance`. It intentionally trusts catalog attribution for MCP server names instead of joining arbitrary local plugin summaries, which the tests in `mod_tests.rs` verify.

*Call graph*: called by 1 (tool_plugin_provenance); 2 external calls (default, vec!).


##### `host_owned_codex_apps_enabled`  (lines 234–236)

```
fn host_owned_codex_apps_enabled(config: &McpConfig, auth: Option<&CodexAuth>) -> bool
```

**Purpose**: Determines whether the built-in host-owned `codex_apps` MCP server should be active. It requires both config enablement and runtime auth that uses the Codex backend.

**Data flow**: Reads `config.apps_enabled` and the optional `CodexAuth`; returns true only when apps are enabled and `auth.is_some_and(CodexAuth::uses_codex_backend)`.

**Call relations**: This gate is consulted when deriving effective servers and when constructing managers for reads and snapshots so the built-in apps server only appears in authenticated sessions.

*Call graph*: called by 3 (collect_mcp_server_status_snapshot_with_detail, effective_mcp_servers_from_configured, read_mcp_resource).


##### `configured_mcp_servers`  (lines 238–240)

```
fn configured_mcp_servers(config: &McpConfig) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns the configured MCP server map from the resolved catalog. It is the raw, auth-agnostic server set.

**Data flow**: Reads `config.mcp_server_catalog` and returns the `HashMap<String, McpServerConfig>` produced by `configured_servers()`.

**Call relations**: This is the first step in `effective_mcp_servers`, separating catalog extraction from auth gating.

*Call graph*: called by 1 (effective_mcp_servers).


##### `effective_mcp_servers`  (lines 242–247)

```
fn effective_mcp_servers(
    config: &McpConfig,
    auth: Option<&CodexAuth>,
) -> HashMap<String, EffectiveMcpServer>
```

**Purpose**: Builds the runtime-visible MCP server map from config and optional auth. It starts from configured servers and applies auth-based filtering.

**Data flow**: Calls `configured_mcp_servers(config)` to obtain the raw map, then passes that map plus `config` and `auth` into `effective_mcp_servers_from_configured`, returning the filtered `HashMap<String, EffectiveMcpServer>`.

**Call relations**: This is the public entry point used by snapshot collection and resource reads before they create a connection manager.

*Call graph*: calls 2 internal fn (configured_mcp_servers, effective_mcp_servers_from_configured); called by 2 (collect_mcp_server_status_snapshot_with_detail, read_mcp_resource).


##### `effective_mcp_servers_from_configured`  (lines 253–266)

```
fn effective_mcp_servers_from_configured(
    configured_servers: HashMap<String, McpServerConfig>,
    config: &McpConfig,
    auth: Option<&CodexAuth>,
) -> HashMap<String, EffectiveMcpServer>
```

**Purpose**: Converts a concrete configured server map into the auth-gated runtime view. It wraps each config in `EffectiveMcpServer::configured` and removes the built-in apps server when host-owned apps are not enabled.

**Data flow**: Consumes a `HashMap<String, McpServerConfig>`, maps each `(name, server)` to `(name, EffectiveMcpServer::configured(server))`, and collects into a new `HashMap`. It then checks `host_owned_codex_apps_enabled(config, auth)` and removes `CODEX_APPS_MCP_SERVER_NAME` when false before returning the map.

**Call relations**: This function is called only by `effective_mcp_servers`. Its design explicitly avoids synthesizing missing compatibility servers; it only filters and wraps what was already materialized.

*Call graph*: calls 1 internal fn (host_owned_codex_apps_enabled); called by 1 (effective_mcp_servers).


##### `tool_plugin_provenance`  (lines 268–270)

```
fn tool_plugin_provenance(config: &McpConfig) -> ToolPluginProvenance
```

**Purpose**: Builds the session's plugin provenance lookup tables from `McpConfig`. It is a small public wrapper around the internal constructor.

**Data flow**: Reads `config` and returns `ToolPluginProvenance::from_config(config)`.

**Call relations**: This helper is used by both snapshot collection and direct resource reads when constructing an `McpConnectionManager`.

*Call graph*: calls 1 internal fn (from_config); called by 2 (collect_mcp_server_status_snapshot_with_detail, read_mcp_resource).


##### `read_mcp_resource`  (lines 272–319)

```
async fn read_mcp_resource(
    config: &McpConfig,
    auth: Option<&CodexAuth>,
    runtime_context: McpRuntimeContext,
    server: &str,
    uri: &str,
) -> anyhow::Result<ReadResourceResult>
```

**Purpose**: Reads one resource URI from one MCP server using a short-lived connection manager. It narrows the effective server set to the requested server, computes auth statuses, constructs the manager, performs the read, and cancels the manager afterward.

**Data flow**: Reads `config`, optional `auth`, `runtime_context`, `server`, and `uri`. It derives effective servers, computes whether host-owned apps are enabled, retains only the named server in the map, computes auth statuses for that reduced set, creates an unused event channel and cancellation token, then awaits `McpConnectionManager::new(...)` with approval policy, cache key, provenance, auth, and runtime context. It calls `manager.read_resource(server, ReadResourceRequestParams::new(uri))`, cancels the token, and returns the resulting `ReadResourceResult` or propagated error.

**Call relations**: This function is a direct orchestration path for one-off resource reads. It depends on `effective_mcp_servers`, `host_owned_codex_apps_enabled`, `compute_auth_statuses`, and `tool_plugin_provenance` to prepare the manager, then delegates the actual protocol operation to `McpConnectionManager`.

*Call graph*: calls 7 internal fn (codex_apps_tools_cache_key, new, compute_auth_statuses, effective_mcp_servers, host_owned_codex_apps_enabled, tool_plugin_provenance, default); 4 external calls (new, new, new, unbounded).


##### `collect_mcp_server_status_snapshot_with_detail`  (lines 331–399)

```
async fn collect_mcp_server_status_snapshot_with_detail(
    config: &McpConfig,
    auth: Option<&CodexAuth>,
    submit_id: String,
    runtime_context: McpRuntimeContext,
    detail: McpSnapshotDet
```

**Purpose**: Collects a normalized snapshot of available MCP servers, tools, optional resources, and auth statuses. It creates a short-lived connection manager over the effective server set and converts manager outputs into protocol-layer structures.

**Data flow**: Reads `config`, optional `auth`, `submit_id`, `runtime_context`, and `detail`. It derives effective servers and provenance, returns an all-empty `McpServerStatusSnapshot` immediately when no servers exist, otherwise computes auth status entries, captures server names, creates an event channel and cancellation token, constructs `McpConnectionManager::new(...)`, then awaits `collect_mcp_server_status_snapshot_from_manager(...)`. Afterward it cancels the token and returns the snapshot.

**Call relations**: This is the main snapshot orchestration entry point. It prepares all manager dependencies itself, then delegates the actual listing and conversion work to `collect_mcp_server_status_snapshot_from_manager`.

*Call graph*: calls 8 internal fn (codex_apps_tools_cache_key, new, compute_auth_statuses, collect_mcp_server_status_snapshot_from_manager, effective_mcp_servers, host_owned_codex_apps_enabled, tool_plugin_provenance, default); 4 external calls (new, new, new, unbounded).


##### `sanitize_responses_api_tool_name`  (lines 404–419)

```
fn sanitize_responses_api_tool_name(name: &str) -> String
```

**Purpose**: Rewrites a tool name so it satisfies the Responses API character restriction `^[a-zA-Z0-9_-]+$`. It preserves ASCII alphanumerics and underscores and replaces every other character with `_`.

**Data flow**: Reads `name`, allocates a `String` with matching capacity, iterates over characters, pushes the original character when it is ASCII alphanumeric or `_`, otherwise pushes `_`. If the result is empty it returns `_`; otherwise it returns the sanitized string.

**Call relations**: This helper is used by `qualified_mcp_tool_name_prefix` and other tool-normalization code to ensure model-visible names are protocol-safe without changing case.

*Call graph*: called by 2 (qualified_mcp_tool_name_prefix, normalize_tools_for_model_with_prefix); 1 external calls (with_capacity).


##### `codex_apps_mcp_bearer_token_env_var`  (lines 421–428)

```
fn codex_apps_mcp_bearer_token_env_var() -> Option<String>
```

**Purpose**: Determines whether the built-in apps server should reference the `CODEX_CONNECTORS_TOKEN` environment variable. It treats non-empty and non-Unicode values as present, but ignores missing or whitespace-only values.

**Data flow**: Reads process environment variable `CODEX_CONNECTORS_TOKEN`. It returns `Some("CODEX_CONNECTORS_TOKEN".to_string())` when the variable exists and is non-empty after trimming, or when it exists but is not valid Unicode; it returns `None` when absent or present but blank.

**Call relations**: This helper is called by `mcp_server_config_for_url` so generated built-in server configs can advertise bearer-token auth only when the ambient token variable is meaningfully present.

*Call graph*: called by 1 (mcp_server_config_for_url); 1 external calls (var).


##### `normalize_codex_apps_base_url`  (lines 430–439)

```
fn normalize_codex_apps_base_url(base_url: &str) -> String
```

**Purpose**: Normalizes a base URL for ChatGPT-hosted MCP endpoints. It strips trailing slashes and appends `/backend-api` for ChatGPT hosts that do not already include that path.

**Data flow**: Consumes `base_url` as `&str`, trims trailing `/`, then checks whether it starts with `https://chatgpt.com` or `https://chat.openai.com` and lacks `/backend-api`. In that case it returns a formatted `{base_url}/backend-api`; otherwise it returns the trimmed base URL unchanged.

**Call relations**: This helper feeds both built-in URL constructors so they can preserve explicit paths while still supporting legacy ChatGPT host defaults.

*Call graph*: called by 2 (codex_apps_mcp_url_for_base_url, hosted_plugin_runtime_mcp_server_config); 1 external calls (format!).


##### `codex_apps_mcp_url_for_base_url`  (lines 441–451)

```
fn codex_apps_mcp_url_for_base_url(base_url: &str) -> String
```

**Purpose**: Builds the default MCP endpoint URL for the host-owned apps server from a base URL. It preserves existing `/backend-api` or `/api/codex` paths and chooses the legacy `wham/apps` suffix when appropriate.

**Data flow**: Normalizes `base_url`, then branches: if it contains `/backend-api`, it uses suffix `wham/apps`; if it contains `/api/codex`, it uses suffix `apps`; otherwise it appends `/api/codex` first and then suffix `apps`. It returns the final formatted URL string.

**Call relations**: This helper is used by `codex_apps_mcp_server_config` to derive the built-in apps endpoint from the root ChatGPT base URL.

*Call graph*: calls 1 internal fn (normalize_codex_apps_base_url); called by 1 (codex_apps_mcp_server_config); 1 external calls (format!).


##### `codex_apps_mcp_server_config`  (lines 453–461)

```
fn codex_apps_mcp_server_config(
    chatgpt_base_url: &str,
    apps_mcp_product_sku: Option<&str>,
) -> McpServerConfig
```

**Purpose**: Constructs the built-in `codex_apps` MCP server configuration for the host-owned apps endpoint. It resolves the endpoint URL and delegates the common config assembly.

**Data flow**: Reads `chatgpt_base_url` and optional `apps_mcp_product_sku`, computes the endpoint with `codex_apps_mcp_url_for_base_url`, passes that URL and SKU into `mcp_server_config_for_url`, and returns the resulting `McpServerConfig`.

**Call relations**: This is the public constructor for the built-in apps server config and shares its low-level assembly logic with the hosted plugin runtime variant.

*Call graph*: calls 2 internal fn (codex_apps_mcp_url_for_base_url, mcp_server_config_for_url).


##### `hosted_plugin_runtime_mcp_server_config`  (lines 464–475)

```
fn hosted_plugin_runtime_mcp_server_config(
    chatgpt_base_url: &str,
    apps_mcp_product_sku: Option<&str>,
) -> McpServerConfig
```

**Purpose**: Constructs the ChatGPT-hosted plugin runtime MCP server configuration served by plugin-service. It normalizes the base URL and targets the `/ps/mcp` endpoint.

**Data flow**: Reads `chatgpt_base_url` and optional SKU, normalizes the base URL, ensures it contains either `/backend-api` or `/api/codex` by appending `/api/codex` when needed, formats `{base_url}/ps/mcp`, and passes that URL into `mcp_server_config_for_url`.

**Call relations**: This is a sibling of `codex_apps_mcp_server_config`, differing only in endpoint path selection before delegating to the shared config builder.

*Call graph*: calls 2 internal fn (mcp_server_config_for_url, normalize_codex_apps_base_url); 1 external calls (format!).


##### `mcp_server_config_for_url`  (lines 477–504)

```
fn mcp_server_config_for_url(url: String, apps_mcp_product_sku: Option<&str>) -> McpServerConfig
```

**Purpose**: Builds a standard enabled streamable-HTTP `McpServerConfig` for a given URL. It injects the optional product SKU header, optional bearer-token env var, default environment ID, and standard timeout/default flags.

**Data flow**: Consumes a URL string and optional SKU. It creates `http_headers` as `Some(HashMap::from([("X-OpenAI-Product-Sku", sku)]))` when a SKU is present, calls `codex_apps_mcp_bearer_token_env_var()` for `bearer_token_env_var`, and returns a fully populated `McpServerConfig` with `StreamableHttp { url, bearer_token_env_var, http_headers, env_http_headers: None }`, enabled=true, required=false, startup timeout 30 seconds, no OAuth/scopes/tool filters, and an empty `tools` map.

**Call relations**: This shared constructor is used by both built-in server config helpers so they stay structurally identical apart from URL and optional SKU header.

*Call graph*: calls 1 internal fn (codex_apps_mcp_bearer_token_env_var); called by 2 (codex_apps_mcp_server_config, hosted_plugin_runtime_mcp_server_config); 2 external calls (from_secs, new).


##### `protocol_tool_from_rmcp_tool`  (lines 506–520)

```
fn protocol_tool_from_rmcp_tool(name: &str, tool: &rmcp::model::Tool) -> Option<Tool>
```

**Purpose**: Converts an RMCP tool definition into the protocol-layer `Tool` type used by snapshots. Serialization or conversion failures are logged and dropped.

**Data flow**: Reads a tool name and borrowed `rmcp::model::Tool`, serializes the RMCP tool to `serde_json::Value`, then calls `Tool::from_mcp_value`. On success it returns `Some(Tool)`; on serialization or conversion error it logs a warning containing the tool name and returns `None`.

**Call relations**: This helper is used while assembling snapshot tool maps in `collect_mcp_server_status_snapshot_from_manager`, allowing malformed tools to be skipped without aborting the whole snapshot.

*Call graph*: calls 1 internal fn (from_mcp_value); called by 1 (collect_mcp_server_status_snapshot_from_manager); 2 external calls (to_value, warn!).


##### `auth_statuses_from_entries`  (lines 522–529)

```
fn auth_statuses_from_entries(
    auth_status_entries: &HashMap<String, crate::mcp::auth::McpAuthStatusEntry>,
) -> HashMap<String, McpAuthStatus>
```

**Purpose**: Strips `McpAuthStatusEntry` values down to the plain `McpAuthStatus` map needed in snapshots. It discards the cloned config payloads.

**Data flow**: Reads a `HashMap<String, McpAuthStatusEntry>`, iterates over entries, clones each server name, copies `entry.auth_status`, and collects the pairs into a new `HashMap<String, McpAuthStatus>`.

**Call relations**: This helper is called only by `collect_mcp_server_status_snapshot_from_manager` when finalizing the snapshot structure.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager).


##### `convert_mcp_resources`  (lines 531–568)

```
fn convert_mcp_resources(
    resources: HashMap<String, Vec<rmcp::model::Resource>>,
) -> HashMap<String, Vec<Resource>>
```

**Purpose**: Converts RMCP resource lists into protocol-layer `Resource` lists keyed by server name. Individual malformed resources are logged and omitted.

**Data flow**: Consumes `HashMap<String, Vec<rmcp::model::Resource>>`. For each server it serializes each RMCP resource to JSON, attempts `Resource::from_mcp_value`, and collects successful conversions. On conversion failure it inspects the serialized object for `uri` and `name` fields to enrich the warning log; on serialization failure it logs a generic warning. It returns a new `HashMap<String, Vec<Resource>>`.

**Call relations**: This conversion step is part of snapshot assembly in `collect_mcp_server_status_snapshot_from_manager`, isolating lossy resource normalization from the orchestration code.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager).


##### `convert_mcp_resource_templates`  (lines 570–608)

```
fn convert_mcp_resource_templates(
    resource_templates: HashMap<String, Vec<rmcp::model::ResourceTemplate>>,
) -> HashMap<String, Vec<ResourceTemplate>>
```

**Purpose**: Converts RMCP resource-template lists into protocol-layer `ResourceTemplate` lists keyed by server name. It logs and drops only the malformed templates.

**Data flow**: Consumes `HashMap<String, Vec<rmcp::model::ResourceTemplate>>`. For each template it serializes to JSON, attempts `ResourceTemplate::from_mcp_value`, and collects successes. On conversion failure it extracts `uriTemplate` or `uri_template` plus `name` from the serialized object when possible for warning context; serialization failures are also logged. It returns a new `HashMap<String, Vec<ResourceTemplate>>`.

**Call relations**: This helper mirrors `convert_mcp_resources` and is used during snapshot finalization.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager).


##### `collect_mcp_server_status_snapshot_from_manager`  (lines 610–656)

```
async fn collect_mcp_server_status_snapshot_from_manager(
    mcp_connection_manager: &McpConnectionManager,
    auth_status_entries: HashMap<String, crate::mcp::auth::McpAuthStatusEntry>,
    server_
```

**Purpose**: Queries an already constructed `McpConnectionManager` for tools, optional resources, resource templates, and server info, then converts everything into an `McpServerStatusSnapshot`. It is the low-level snapshot assembler used after manager setup is complete.

**Data flow**: Reads a borrowed manager, auth status entries, server names, and `detail`. It concurrently awaits `list_all_tools`, conditional `list_all_resources`, and conditional `list_all_resource_templates` with `tokio::join!`, then separately awaits `list_available_server_infos`. It converts each listed tool through `protocol_tool_from_rmcp_tool` and groups successful results into `HashMap<String, HashMap<String, Tool>>` by server and tool name. Finally it converts resources and templates with the dedicated helpers, derives plain auth statuses with `auth_statuses_from_entries`, and returns a populated `McpServerStatusSnapshot`.

**Call relations**: This function is called by `collect_mcp_server_status_snapshot_with_detail` after the connection manager has been created. It delegates all type conversion to helper functions so the orchestration layer stays focused on manager lifecycle.

*Call graph*: calls 5 internal fn (list_available_server_infos, auth_statuses_from_entries, convert_mcp_resource_templates, convert_mcp_resources, protocol_tool_from_rmcp_tool); called by 1 (collect_mcp_server_status_snapshot_with_detail); 2 external calls (new, join!).


### Tool exposure and invocation
These files shape MCP tools for model visibility, adapt them into the core tool runtime, and execute approved MCP tool calls including file-argument rewriting.

### `codex-mcp/src/tools.rs`

`domain_logic` · `tool discovery, cache refresh, and model-facing tool list generation`

This module sits between raw MCP protocol tool definitions and the names/schema fragments exposed to the model. `ToolInfo` preserves both worlds at once: raw routing fields such as `server_name` and `tool.name`, plus model-visible `callable_namespace` and `callable_name`, optional connector metadata, and telemetry fields like `server_origin` and `supports_parallel_tool_calls`. `canonical_tool_name` converts the visible namespace/name pair into a `codex_protocol::ToolName`.

Filtering is explicit and per-server. `ToolFilter::from_config` converts `enabled_tools` and `disabled_tools` lists from `McpServerConfig` into `HashSet`s, and `allows` implements the invariant documented above the type: an allowlist, if present, must contain the tool, and the denylist always wins.

Schema shaping is narrowly targeted. `declared_openai_file_input_param_names` reads `meta["openai/fileParams"]` as a string array. `tool_with_model_visible_input_schema` clones the tool only when such parameters exist, then rewrites matching property schemas so the model sees plain string or string-array file path inputs with appended guidance text, while the cached/raw tool remains untouched.

The largest routine, `normalize_tools_for_model_with_prefix`, sanitizes namespaces and names, optionally prepends the legacy `mcp__` prefix, drops exact duplicate raw identities with a warning, detects collisions introduced by sanitization, appends SHA-1-derived suffixes where needed, sorts deterministically by raw identity, and finally enforces the 64-byte API limit through `unique_callable_parts`. That helper repeatedly hashes/truncates namespace and tool parts until the concatenated visible name is unique and short enough.

#### Function details

##### `ToolInfo::canonical_tool_name`  (lines 59–61)

```
fn canonical_tool_name(&self) -> ToolName
```

**Purpose**: Builds the canonical namespaced tool identifier used by protocol and search/spec generation code from the model-visible namespace and name stored on `ToolInfo`.

**Data flow**: Reads `self.callable_namespace` and `self.callable_name`, clones both strings, passes them to `ToolName::namespaced`, and returns the resulting `ToolName`.

**Call relations**: Called when downstream code needs a stable combined tool identifier, including tool spec creation and search text generation. It delegates the actual identifier construction to `ToolName::namespaced`.

*Call graph*: calls 1 internal fn (namespaced); called by 3 (tool_name, build_mcp_search_text, create_tool_spec).


##### `declared_openai_file_input_param_names`  (lines 64–79)

```
fn declared_openai_file_input_param_names(
    meta: Option<&Map<String, JsonValue>>,
) -> Vec<String>
```

**Purpose**: Extracts the list of parameter names declared in tool metadata as OpenAI file-path inputs.

**Data flow**: Accepts `Option<&Map<String, JsonValue>>`. If absent, it returns an empty `Vec<String>`. Otherwise it reads the `openai/fileParams` entry, requires it to be an array, keeps only non-empty string elements, converts them to owned `String`s, and returns them.

**Call relations**: Used only by `tool_with_model_visible_input_schema` to decide whether schema masking is necessary and which properties should be rewritten.

*Call graph*: called by 1 (tool_with_model_visible_input_schema); 1 external calls (new).


##### `ToolFilter::from_config`  (lines 91–103)

```
fn from_config(cfg: &McpServerConfig) -> Self
```

**Purpose**: Builds a runtime filter from an MCP server’s configured enabled/disabled tool lists.

**Data flow**: Reads `cfg.enabled_tools` and `cfg.disabled_tools` from `&McpServerConfig`, clones listed tool names into `HashSet<String>` collections, stores the allowlist as `Option<HashSet<_>>`, defaults the denylist to empty when absent, and returns a `ToolFilter`.

**Call relations**: Provides the filter object consumed later by `filter_tools`; it is the bridge from static config to runtime filtering semantics.


##### `ToolFilter::allows`  (lines 105–113)

```
fn allows(&self, tool_name: &str) -> bool
```

**Purpose**: Evaluates whether a raw MCP tool name passes the configured allowlist/denylist rules.

**Data flow**: Reads `self.enabled`, `self.disabled`, and the `tool_name` argument. If an allowlist exists and does not contain the name, it returns `false`; otherwise it returns `true` only if the denylist does not contain the name.

**Call relations**: Called from `filter_tools` for each candidate tool. Its short-circuit structure encodes the documented precedence: allowlist gate first, denylist veto second.


##### `tool_with_model_visible_input_schema`  (lines 119–132)

```
fn tool_with_model_visible_input_schema(tool: &Tool) -> Tool
```

**Purpose**: Produces a model-facing clone of a tool whose input schema hides raw file-upload schema details behind simple file path parameters.

**Data flow**: Takes `&Tool`, reads `tool.meta` to collect file parameter names via `declared_openai_file_input_param_names`, and returns `tool.clone()` unchanged if none are declared. Otherwise it clones the tool, clones `tool.input_schema` into a mutable `JsonValue::Object`, rewrites matching properties through `mask_input_schema_for_file_path_params`, and if the result remains an object stores it back into `tool.input_schema` as a new `Arc` before returning the modified clone.

**Call relations**: Used at manager return boundaries and tested directly for both no-op and masking behavior. It delegates metadata extraction and per-property schema rewriting to helper functions so cached/raw tool definitions remain untouched.

*Call graph*: calls 2 internal fn (declared_openai_file_input_param_names, mask_input_schema_for_file_path_params); called by 2 (tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged, tool_with_model_visible_input_schema_masks_file_params); 3 external calls (new, Object, clone).


##### `filter_tools`  (lines 134–139)

```
fn filter_tools(tools: Vec<ToolInfo>, filter: &ToolFilter) -> Vec<ToolInfo>
```

**Purpose**: Applies a `ToolFilter` to a list of `ToolInfo` values using each tool’s raw MCP name.

**Data flow**: Consumes `Vec<ToolInfo>` and borrows a `ToolFilter`; iterates through the vector, keeps only entries where `filter.allows(&tool.tool.name)` is true, and returns the filtered vector.

**Call relations**: Called during cache refresh, server startup, and tool listing flows after tools have been discovered. It delegates the actual policy decision to `ToolFilter::allows`.

*Call graph*: called by 4 (hard_refresh_codex_apps_tools_cache, filter_tools_applies_per_server_filters, listed_tools, start_server_task).


##### `normalize_tools_for_model_with_prefix`  (lines 149–249)

```
fn normalize_tools_for_model_with_prefix(
    tools: I,
    prefix_mcp_tool_names: bool,
) -> Vec<ToolInfo>
```

**Purpose**: Transforms raw `ToolInfo` entries into a deterministic, sanitized, collision-free set of model-visible tool names and namespaces that satisfy API naming limits.

**Data flow**: Consumes any iterator of `ToolInfo` plus a `prefix_mcp_tool_names` flag. It first builds raw namespace/tool identity strings, drops exact duplicate raw identities while logging a warning, sanitizes namespace and tool names, and stores intermediate `CallableToolCandidate`s. It then detects namespace collisions after sanitization and appends namespace hash suffixes, detects tool-name collisions within each namespace and appends tool hash suffixes, sorts candidates by raw identity for deterministic output, and finally runs `unique_callable_parts` with a shared `used_names` set to enforce uniqueness and the 64-byte limit. The returned `Vec<ToolInfo>` contains the original tool metadata with `tool.callable_namespace` and `tool.callable_name` rewritten to the final visible values.

**Call relations**: Used by tool-listing and cache-refresh paths, and heavily exercised by normalization tests. It delegates sanitization to `sanitize_responses_api_tool_name`, prefix handling to `callable_namespace_with_prefix`, collision suffixing to `append_hash_suffix`/`append_namespace_hash_suffix`, and final length-safe uniqueness to `unique_callable_parts`.

*Call graph*: calls 5 internal fn (sanitize_responses_api_tool_name, append_hash_suffix, append_namespace_hash_suffix, callable_namespace_with_prefix, unique_callable_parts); called by 9 (hard_refresh_codex_apps_tools_cache, list_all_tools, test_normalize_tools_disambiguates_sanitized_namespace_collisions, test_normalize_tools_disambiguates_sanitized_tool_name_collisions, test_normalize_tools_duplicated_names_skipped, test_normalize_tools_keeps_hyphenated_mcp_tools_callable, test_normalize_tools_long_names_same_server, test_normalize_tools_sanitizes_invalid_characters, test_normalize_tools_short_non_duplicated_names); 6 external calls (new, new, new, new, format!, warn!).


##### `callable_namespace_with_prefix`  (lines 265–271)

```
fn callable_namespace_with_prefix(namespace: &str, prefix_mcp_tool_names: bool) -> String
```

**Purpose**: Applies the historical `mcp__` prefix to a sanitized namespace when requested, without double-prefixing names that already have it.

**Data flow**: Reads the `namespace` string and `prefix_mcp_tool_names` flag. It returns the namespace unchanged if prefixing is disabled or the namespace already starts with `mcp__`; otherwise it returns a newly formatted prefixed string.

**Call relations**: Called during normalization before collision detection so prefixed namespaces participate in the same uniqueness logic as all other visible names.

*Call graph*: called by 1 (normalize_tools_for_model_with_prefix); 1 external calls (format!).


##### `mask_input_schema_for_file_path_params`  (lines 273–288)

```
fn mask_input_schema_for_file_path_params(input_schema: &mut JsonValue, file_params: &[String])
```

**Purpose**: Rewrites selected properties inside a JSON Schema object so declared file parameters appear as simple file path inputs.

**Data flow**: Takes a mutable `JsonValue` expected to be an object schema and a slice of file parameter names. It navigates to `schema.properties`, returns early if the structure is missing or not object-shaped, then for each named field looks up the property schema and passes it to `mask_input_property_schema`.

**Call relations**: Invoked only by `tool_with_model_visible_input_schema` after that function has cloned the schema into mutable JSON. It delegates the actual property rewrite to `mask_input_property_schema`.

*Call graph*: calls 1 internal fn (mask_input_property_schema); called by 1 (tool_with_model_visible_input_schema); 1 external calls (as_object_mut).


##### `mask_input_property_schema`  (lines 290–317)

```
fn mask_input_property_schema(schema: &mut JsonValue)
```

**Purpose**: Collapses an individual property schema into either a string or array-of-strings file path parameter while preserving or augmenting human-readable description text.

**Data flow**: Accepts `&mut JsonValue`; if it is not an object, it returns immediately. Otherwise it reads any existing `description`, appends a fixed guidance sentence unless already present, detects array-ness from `type == "array"` or presence of `items`, clears the original object entirely, then writes back only `description` plus either `type: "string"` or `type: "array"` with `items: {"type":"string"}`.

**Call relations**: Called for each matching file parameter by `mask_input_schema_for_file_path_params`. Its destructive rewrite is intentional: model-visible schemas should not expose the original richer upload/file schema shape.

*Call graph*: called by 1 (mask_input_schema_for_file_path_params); 4 external calls (String, as_object_mut, format!, json!).


##### `sha1_hex`  (lines 319–324)

```
fn sha1_hex(s: &str) -> String
```

**Purpose**: Computes the lowercase hexadecimal SHA-1 digest of an input string for deterministic suffix generation.

**Data flow**: Creates a `Sha1` hasher, feeds it the UTF-8 bytes of `s`, finalizes the digest, formats it as lowercase hex, and returns the resulting `String`.

**Call relations**: Used only by `callable_name_hash_suffix` as the primitive hash function behind collision and truncation suffixes.

*Call graph*: called by 1 (callable_name_hash_suffix); 2 external calls (new, format!).


##### `callable_name_hash_suffix`  (lines 326–329)

```
fn callable_name_hash_suffix(raw_identity: &str) -> String
```

**Purpose**: Builds the standard short hash suffix appended to visible tool names and namespaces when disambiguation is required.

**Data flow**: Takes a raw identity string, computes its SHA-1 hex via `sha1_hex`, slices the first `CALLABLE_NAME_HASH_LEN` characters, prefixes them with `_`, and returns that suffix string.

**Call relations**: Called by `fit_callable_parts_with_hash`, which uses the suffix while shortening names to fit API limits.

*Call graph*: calls 1 internal fn (sha1_hex); called by 1 (fit_callable_parts_with_hash); 1 external calls (format!).


##### `append_hash_suffix`  (lines 331–333)

```
fn append_hash_suffix(value: &str, raw_identity: &str) -> String
```

**Purpose**: Appends the standard hash suffix directly to an existing visible name.

**Data flow**: Reads `value` and `raw_identity`, computes the suffix through `callable_name_hash_suffix`, concatenates them, and returns the new string.

**Call relations**: Used both for direct tool-name collision handling in normalization and as the fallback path in `append_namespace_hash_suffix`.

*Call graph*: called by 2 (append_namespace_hash_suffix, normalize_tools_for_model_with_prefix); 1 external calls (format!).


##### `append_namespace_hash_suffix`  (lines 335–346)

```
fn append_namespace_hash_suffix(namespace: &str, raw_identity: &str) -> String
```

**Purpose**: Adds a hash suffix to a namespace while preserving a trailing MCP delimiter when present.

**Data flow**: Reads `namespace` and `raw_identity`. If the namespace ends with `MCP_TOOL_NAME_DELIMITER` (`"__"`), it strips that suffix, inserts the hash suffix before it, and reattaches the delimiter; otherwise it delegates to `append_hash_suffix` and returns that result.

**Call relations**: Called during namespace collision resolution inside `normalize_tools_for_model_with_prefix` so namespaced forms that intentionally end with the delimiter keep that shape after disambiguation.

*Call graph*: calls 1 internal fn (append_hash_suffix); called by 1 (normalize_tools_for_model_with_prefix); 1 external calls (format!).


##### `truncate_name`  (lines 348–350)

```
fn truncate_name(value: &str, max_len: usize) -> String
```

**Purpose**: Truncates a string by Unicode scalar count rather than byte count.

**Data flow**: Reads `value`, takes at most `max_len` characters via `.chars().take(max_len)`, collects them into a new `String`, and returns it.

**Call relations**: Used by `fit_callable_parts_with_hash` when either the tool name or namespace must be shortened to satisfy the maximum visible-name length.

*Call graph*: called by 1 (fit_callable_parts_with_hash).


##### `fit_callable_parts_with_hash`  (lines 352–370)

```
fn fit_callable_parts_with_hash(
    namespace: &str,
    tool_name: &str,
    raw_identity: &str,
    reserved_len: usize,
) -> (String, String)
```

**Purpose**: Produces a namespace/tool-name pair that fits within the global length limit by attaching a hash suffix and truncating the tool name first, then the namespace if necessary.

**Data flow**: Accepts namespace, tool name, raw identity, and reserved length. It computes the hash suffix, calculates how much room remains under `MAX_TOOL_NAME_LENGTH`, and if the tool portion can still hold some prefix plus suffix, returns the original namespace with a truncated tool prefix plus suffix. Otherwise it truncates the namespace to the remaining space and returns that truncated namespace with the suffix alone as the tool name.

**Call relations**: Called from `unique_callable_parts` whenever the plain concatenated name is too long or already used. It encapsulates the file’s length-budget policy.

*Call graph*: calls 2 internal fn (callable_name_hash_suffix, truncate_name); called by 1 (unique_callable_parts); 1 external calls (format!).


##### `unique_callable_parts`  (lines 372–399)

```
fn unique_callable_parts(
    namespace: &str,
    tool_name: &str,
    raw_identity: &str,
    used_names: &mut HashSet<String>,
    reserved_len: usize,
) -> (String, String)
```

**Purpose**: Finds a final namespace/tool-name pair that is both unique among already-used visible names and short enough for the API limit.

**Data flow**: Reads the proposed namespace, tool name, raw identity, mutable `used_names` set, and reserved length. If the plain concatenation fits and is unused, it inserts that combined name into `used_names` and returns the original parts. Otherwise it loops with an incrementing attempt counter, deriving a hash input from `raw_identity` plus the attempt number, calling `fit_callable_parts_with_hash`, and inserting the resulting concatenation into `used_names` once a unique candidate is found; it then returns that pair.

**Call relations**: This is the final arbitration step in `normalize_tools_for_model_with_prefix`, after earlier passes have already handled obvious collisions. The retry loop ensures deterministic progress even if a hashed candidate itself collides.

*Call graph*: calls 1 internal fn (fit_callable_parts_with_hash); called by 1 (normalize_tools_for_model_with_prefix); 1 external calls (format!).


### `core/src/mcp_tool_exposure.rs`

`domain_logic` · `tool inventory construction before model tool exposure`

This file contains the production logic that turns the full discovered MCP tool inventory into an `McpToolExposure` split: `direct_tools` that are injected into the model-visible tool list immediately, and optional `deferred_tools` that remain discoverable only through search. The central function first gathers all non-Codex-Apps MCP tools that are model-visible, then optionally adds Codex Apps tools that belong to currently available connectors and are enabled by `AppToolPolicyEvaluator` against the current `ConfigLayerStack`.

The design intentionally treats Codex Apps differently from ordinary MCP servers. Non-app tools are filtered only by server name and `tool_is_model_visible`. Codex Apps tools must also have a `connector_id`, correspond to one of the supplied `connectors::AppInfo` entries, and pass per-tool policy evaluation using connector ID, tool name/title, and destructive/open-world hints from annotations. After building this effective tool set, `build_mcp_tool_exposure` decides whether to defer it wholesale: deferral happens only when search is enabled and either the `ToolSearchAlwaysDeferMcpTools` feature is on or the effective tool count reaches `DIRECT_MCP_TOOL_EXPOSURE_THRESHOLD` (100). If deferral is not needed, all effective tools are returned as `direct_tools`; otherwise `direct_tools` is emptied and `deferred_tools` is populated only when non-empty.

#### Function details

##### `build_mcp_tool_exposure`  (lines 22–54)

```
fn build_mcp_tool_exposure(
    all_mcp_tools: &[McpToolInfo],
    connectors: Option<&[connectors::AppInfo]>,
    config: &Config,
    search_tool_enabled: bool,
) -> McpToolExposure
```

**Purpose**: Builds the final direct-versus-deferred MCP tool exposure set from all discovered MCP tools, optional connector inventory, config, and search-tool availability.

**Data flow**: Reads `all_mcp_tools`, `connectors`, `config.features`, and `search_tool_enabled`. It starts with non-Codex-Apps visible tools, optionally extends that list with allowed Codex Apps tools, computes `should_defer` based on search enablement plus either the always-defer feature or the threshold count, and returns `McpToolExposure { direct_tools, deferred_tools }` accordingly.

**Call relations**: Called by the broader tool-building flow after MCP discovery. It delegates the actual filtering to `filter_non_codex_apps_mcp_tools_only` and `filter_codex_apps_mcp_tools`, then performs the final policy of whether the resulting effective set is exposed directly or deferred to search.

*Call graph*: calls 2 internal fn (filter_codex_apps_mcp_tools, filter_non_codex_apps_mcp_tools_only); called by 1 (built_tools); 1 external calls (new).


##### `filter_non_codex_apps_mcp_tools_only`  (lines 56–64)

```
fn filter_non_codex_apps_mcp_tools_only(mcp_tools: &[McpToolInfo]) -> Vec<McpToolInfo>
```

**Purpose**: Selects only model-visible MCP tools that do not belong to the special Codex Apps server.

**Data flow**: Iterates over `mcp_tools`, keeps entries whose `server_name` is not `CODEX_APPS_MCP_SERVER_NAME` and for which `tool_is_model_visible(tool)` is true, clones those `McpToolInfo` values, and returns them as a `Vec`.

**Call relations**: Used as the first stage inside `build_mcp_tool_exposure` to gather ordinary MCP tools before any connector-aware filtering is applied.

*Call graph*: called by 1 (build_mcp_tool_exposure); 1 external calls (iter).


##### `filter_codex_apps_mcp_tools`  (lines 66–105)

```
fn filter_codex_apps_mcp_tools(
    mcp_tools: &[McpToolInfo],
    connectors: &[connectors::AppInfo],
    config: &Config,
) -> Vec<McpToolInfo>
```

**Purpose**: Filters Codex Apps MCP tools down to those that are model-visible, belong to currently allowed connectors, and are enabled by app-tool policy.

**Data flow**: Builds a `HashSet<&str>` of allowed connector IDs from `connectors`, constructs an `AppToolPolicyEvaluator` from `config.config_layer_stack`, then iterates `mcp_tools`. For each tool it rejects non-Codex-Apps servers, hidden tools, tools lacking `connector_id`, and tools whose connector is absent from the allowed set. For remaining tools it evaluates policy using connector ID, tool name/title, and destructive/open-world hints from annotations; only `enabled` tools are cloned into the returned vector.

**Call relations**: Called only from `build_mcp_tool_exposure` when connector inventory is available, providing the Codex Apps-specific half of the effective exposure set.

*Call graph*: calls 1 internal fn (new); called by 1 (build_mcp_tool_exposure); 2 external calls (iter, iter).


### `core/src/tools/handlers/mcp.rs`

`io_transport` · `request handling`

The central type is `McpHandler`, which stores the original `codex_mcp::ToolInfo` plus a prebuilt `ToolSpec`. Construction uses `create_tool_spec`, converting the MCP tool schema with `mcp_tool_to_responses_api_tool` and always exposing it as a single-tool `ToolSpec::Namespace(ResponsesApiNamespace)` under `tool_info.callable_namespace`. The namespace description prefers a nonblank `namespace_description`; otherwise it falls back to `Tools for working with {connector_name}.` when a connector name exists.

Execution metadata is richer than for most handlers. `supports_parallel_tool_calls` returns true either when the server explicitly opted in or when the MCP tool annotations carry `read_only_hint: true`. `search_info` builds a source label from connector name or server name and indexes a synthesized search text from `build_mcp_search_text`, which concatenates flattened tool names, callable names, server metadata, plugin display names, and sorted input-schema property names.

For hooks, `hook_tool_name` derives a legacy-prefixed name like `mcp__filesystem__read_file` by joining namespace and tool name with `__`, trimming redundant underscores, and ensuring the `mcp__` prefix is present even for builtin-looking namespaces. `pre_tool_use_payload` parses raw JSON arguments with `mcp_hook_tool_input`, `with_updated_hook_input` rewrites function arguments by serializing updated JSON back into the invocation payload, and `post_tool_use_payload` asks the output object for normalized hook input/response values.

`handle_call` accepts only function payloads, times the call with `Instant`, delegates to `handle_mcp_tool_call`, and wraps the returned MCP result plus normalized tool input, elapsed wall time, original-image-detail capability, and truncation policy into `McpToolOutput`. The file's tests focus on hook naming, payload rewriting, and parallel-call policy.

#### Function details

##### `McpHandler::new`  (lines 38–41)

```
fn new(tool_info: ToolInfo) -> Result<Self, serde_json::Error>
```

**Purpose**: Constructs an MCP runtime handler from discovered `ToolInfo` and precomputes its advertised tool spec.

**Data flow**: Takes ownership of `ToolInfo`, calls `create_tool_spec(&tool_info)` which may fail with `serde_json::Error`, and on success returns `McpHandler { tool_info, spec }`.

**Call relations**: It is used during MCP runtime-tool registration and in tests. All later metadata and execution methods rely on the stored `tool_info` and prebuilt `spec` created here.

*Call graph*: calls 1 internal fn (create_tool_spec); called by 7 (mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result, mcp_pre_tool_use_payload_keeps_builtin_like_tool_names_namespaced, mcp_pre_tool_use_payload_uses_prefixed_tool_name_and_raw_args, mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp, search_info_uses_connector_name_for_output_namespace_description, search_info_uses_mcp_tool_metadata_and_parameter_names, add_mcp_runtime_tools).


##### `McpHandler::hook_tool_name`  (lines 43–45)

```
fn hook_tool_name(&self) -> HookToolName
```

**Purpose**: Builds the normalized hook-visible tool name for this MCP tool, preserving MCP identity even for builtin-like namespaces.

**Data flow**: Calls `self.tool_name()` to get the canonical `ToolName`, passes it through `join_tool_name`, then `ensure_mcp_prefix`, and finally wraps the resulting string in `HookToolName::new`.

**Call relations**: This helper is used by `handle_call`, `pre_tool_use_payload`, and `post_tool_use_payload` so all hook and execution paths agree on the same MCP-prefixed name.

*Call graph*: calls 4 internal fn (tool_name, ensure_mcp_prefix, join_tool_name, new); called by 3 (handle_call, post_tool_use_payload, pre_tool_use_payload).


##### `join_tool_name`  (lines 48–57)

```
fn join_tool_name(tool_name: &ToolName) -> String
```

**Purpose**: Flattens a possibly namespaced `ToolName` into a single string separated by the MCP delimiter `__`.

**Data flow**: Reads `tool_name.namespace` and `tool_name.name`; if a namespace exists it trims trailing underscores from the namespace and leading underscores from the name, formats `{namespace}__{name}`, otherwise it returns the bare tool name clone.

**Call relations**: It is an internal naming helper called by `McpHandler::hook_tool_name` before prefix normalization.

*Call graph*: called by 1 (hook_tool_name); 1 external calls (format!).


##### `ensure_mcp_prefix`  (lines 59–65)

```
fn ensure_mcp_prefix(name: &str) -> String
```

**Purpose**: Guarantees that a flattened MCP hook name starts with the legacy `mcp__` prefix.

**Data flow**: Reads `name: &str`; if it already starts with `mcp__`, returns it as an owned `String`, otherwise prepends the prefix and returns the new string.

**Call relations**: This is the second naming-normalization step inside `McpHandler::hook_tool_name`.

*Call graph*: called by 1 (hook_tool_name); 1 external calls (format!).


##### `McpHandler::tool_name`  (lines 68–70)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical namespaced tool name derived from the MCP `ToolInfo`.

**Data flow**: Calls `self.tool_info.canonical_tool_name()` and returns the resulting `ToolName`.

**Call relations**: It is part of the `ToolExecutor` interface and is also used internally by `hook_tool_name`.

*Call graph*: calls 1 internal fn (canonical_tool_name); called by 1 (hook_tool_name).


##### `McpHandler::spec`  (lines 72–74)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the precomputed MCP tool specification advertised to the model.

**Data flow**: Clones `self.spec` and returns the clone.

**Call relations**: This is consumed directly by the registry and indirectly by `search_info` when building searchable metadata.

*Call graph*: called by 1 (search_info); 1 external calls (clone).


##### `McpHandler::supports_parallel_tool_calls`  (lines 76–87)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Determines whether this MCP tool may be invoked concurrently based on server opt-in or read-only annotations.

**Data flow**: Reads `self.tool_info.supports_parallel_tool_calls`; if false, it inspects `self.tool_info.tool.annotations.read_only_hint` and returns true only when that hint is present and true. Returns the final boolean.

**Call relations**: The scheduler consults this method before parallel dispatch. Tests cover the server-opt-in and read-only-hint branches.


##### `McpHandler::search_info`  (lines 89–113)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Builds search metadata for the MCP tool, including a source label and synthesized search text from MCP metadata.

**Data flow**: Chooses `source_name` from nonblank `connector_name` or trimmed `server_name`, optionally builds `ToolSearchSourceInfo` with that name and a nonblank `namespace_description`, then calls `ToolSearchInfo::from_spec(build_mcp_search_text(&self.tool_info), self.spec(), source_info)` and returns the result.

**Call relations**: This method is used when indexing tools for search. It delegates text synthesis to `build_mcp_search_text` and uses `spec` for the structural tool description.

*Call graph*: calls 3 internal fn (spec, build_mcp_search_text, from_spec).


##### `McpHandler::handle`  (lines 115–117)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async MCP execution path into the boxed future required by the tool-executor trait.

**Data flow**: Takes a `ToolInvocation`, creates the future from `self.handle_call(invocation)`, pins it, and returns it.

**Call relations**: The registry invokes this trait method; all actual MCP execution happens in `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `McpHandler::handle_call`  (lines 121–161)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Executes one MCP tool call by validating payload shape, delegating to the MCP call helper, and packaging the result with runtime metadata.

**Data flow**: Destructures `ToolInvocation` to read `session`, `turn`, `call_id`, and `payload`. It requires `ToolPayload::Function { arguments }`, otherwise returns `FunctionCallError::RespondToModel`. It records `Instant::now()`, awaits `handle_mcp_tool_call(Arc::clone(&session), &turn, call_id.clone(), self.tool_info.server_name.clone(), self.tool_info.tool.name.to_string(), self.hook_tool_name(), arguments)`, then wraps the returned `result.result` and `result.tool_input` into `McpToolOutput` together with elapsed wall time, `can_request_original_image_detail(&turn.model_info)`, and `turn.truncation_policy`, boxes it, and returns it.

**Call relations**: It is called only by `handle`. Its main delegation is to `handle_mcp_tool_call`, which performs the actual MCP transport and normalization.

*Call graph*: calls 3 internal fn (handle_mcp_tool_call, boxed_tool_output, hook_tool_name); called by 1 (handle); 4 external calls (clone, now, can_request_original_image_detail, RespondToModel).


##### `McpHandler::telemetry_tags`  (lines 165–176)

```
fn telemetry_tags(
        &'a self,
        _invocation: &'a ToolInvocation,
    ) -> futures::future::BoxFuture<'a, ToolTelemetryTags>
```

**Purpose**: Supplies MCP-specific telemetry tags identifying the server and, when present, its origin.

**Data flow**: Builds a vector starting with `("mcp_server", self.tool_info.server_name.clone())`, conditionally pushes `("mcp_server_origin", origin.clone())` when `server_origin` exists, and returns it from a boxed async future.

**Call relations**: This `CoreToolRuntime` hook is consumed by telemetry/reporting paths around tool execution.

*Call graph*: 2 external calls (pin, vec!).


##### `McpHandler::pre_tool_use_payload`  (lines 178–187)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the hook payload emitted before an MCP tool runs, using the normalized MCP-prefixed hook name and parsed arguments.

**Data flow**: Reads `invocation.payload`; if it is not `ToolPayload::Function`, returns `None`. Otherwise it constructs `PreToolUsePayload { tool_name: self.hook_tool_name(), tool_input: mcp_hook_tool_input(arguments) }` and returns `Some(...)`.

**Call relations**: This hook is called by generic pre-tool-use machinery. It delegates argument normalization to `mcp_hook_tool_input`.

*Call graph*: calls 2 internal fn (hook_tool_name, mcp_hook_tool_input).


##### `McpHandler::with_updated_hook_input`  (lines 189–210)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies hook-driven argument rewriting to an MCP invocation by replacing its function-argument JSON string.

**Data flow**: Takes ownership of a `ToolInvocation` and `updated_input: Value`. If the payload is `ToolPayload::Function`, it serializes `updated_input` with `serde_json::to_string` and stores the resulting string back into `invocation.payload`; serialization failures become `FunctionCallError::RespondToModel`. For any non-function payload it returns a `RespondToModel` error naming the tool and unsupported payload. On success it returns the modified invocation.

**Call relations**: This `CoreToolRuntime` hook is used when pre-tool hooks rewrite MCP inputs before execution. It does not call execution itself; it prepares the invocation that `handle` will later consume.

*Call graph*: 3 external calls (format!, to_string, RespondToModel).


##### `McpHandler::post_tool_use_payload`  (lines 211–228)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the hook payload emitted after an MCP tool finishes, using normalized input and response values from the output object.

**Data flow**: Checks that `invocation.payload` is function-shaped; otherwise returns `None`. It then asks `result.post_tool_use_response(&invocation.call_id, &invocation.payload)` for the hook-visible response and `result.post_tool_use_input(&invocation.payload)` for the normalized input; if either returns `None`, this method returns `None`. Otherwise it constructs and returns `Some(PostToolUsePayload { tool_name: self.hook_tool_name(), tool_use_id: invocation.call_id.clone(), tool_input, tool_response })`.

**Call relations**: This is the post-execution counterpart to `pre_tool_use_payload`. It is called by generic hook machinery after `handle_call` has produced a `ToolOutput`.

*Call graph*: calls 3 internal fn (hook_tool_name, post_tool_use_input, post_tool_use_response).


##### `create_tool_spec`  (lines 231–255)

```
fn create_tool_spec(tool_info: &ToolInfo) -> Result<ToolSpec, serde_json::Error>
```

**Purpose**: Translates MCP `ToolInfo` into the namespaced `ToolSpec` exposed to the model.

**Data flow**: Reads `tool_info`, derives the canonical `ToolName`, converts the MCP tool schema with `mcp_tool_to_responses_api_tool`, computes a namespace description from nonblank `namespace_description` or a connector-name fallback, and returns `ToolSpec::Namespace(ResponsesApiNamespace { name: tool_info.callable_namespace.clone(), description, tools: vec![ResponsesApiNamespaceTool::Function(tool)] })`.

**Call relations**: This helper is called only by `McpHandler::new` so spec construction is centralized and testable.

*Call graph*: calls 1 internal fn (canonical_tool_name); called by 1 (new); 3 external calls (mcp_tool_to_responses_api_tool, Namespace, vec!).


##### `mcp_hook_tool_input`  (lines 257–263)

```
fn mcp_hook_tool_input(raw_arguments: &str) -> Value
```

**Purpose**: Parses raw MCP argument text into the JSON value exposed to hook handlers, with graceful fallback for empty or non-JSON input.

**Data flow**: Reads `raw_arguments: &str`; if trimming yields empty text, returns `Value::Object(Map::new())`. Otherwise it attempts `serde_json::from_str(raw_arguments)` and returns the parsed value on success; on parse failure it falls back to `Value::String(raw_arguments.to_string())`.

**Call relations**: It is used by `McpHandler::pre_tool_use_payload` so hooks see structured JSON when possible but still receive the original raw text when parsing fails.

*Call graph*: called by 1 (pre_tool_use_payload); 3 external calls (new, Object, from_str).


##### `build_mcp_search_text`  (lines 265–311)

```
fn build_mcp_search_text(info: &ToolInfo) -> String
```

**Purpose**: Synthesizes a broad search string for an MCP tool from names, descriptions, plugin labels, and input-schema property names.

**Data flow**: Reads `ToolInfo`, derives the canonical `ToolName`, extracts and sorts property names from `tool.input_schema["properties"]` when present, seeds a parts vector with flattened tool name, callable name, raw tool name, and server name, conditionally appends nonblank title, description, connector name, and namespace description, extends with trimmed nonempty `plugin_display_names`, then appends the sorted schema property names and joins everything with spaces into one `String`.

**Call relations**: This helper is called by `McpHandler::search_info` to improve discoverability beyond the raw tool spec.

*Call graph*: calls 1 internal fn (canonical_tool_name); called by 1 (search_info); 1 external calls (vec!).


##### `tests::mcp_pre_tool_use_payload_uses_prefixed_tool_name_and_raw_args`  (lines 332–366)

```
async fn mcp_pre_tool_use_payload_uses_prefixed_tool_name_and_raw_args()
```

**Purpose**: Verifies that pre-tool hook payloads for normal MCP tools use the `mcp__...` prefixed hook name and parsed JSON arguments.

**Data flow**: Builds a function payload containing JSON arguments, creates a session/turn and an `McpHandler`, constructs a `ToolInvocation`, calls `handler.pre_tool_use_payload(...)`, and asserts equality with the expected `PreToolUsePayload` containing `HookToolName::new("mcp__memory__create_entities")` and the parsed JSON object.

**Call relations**: This test exercises `McpHandler::new`, `hook_tool_name`, and `mcp_hook_tool_input` through the public pre-hook API.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 3 external calls (assert_eq!, tool_info, json!).


##### `tests::mcp_pre_tool_use_payload_keeps_builtin_like_tool_names_namespaced`  (lines 369–393)

```
async fn mcp_pre_tool_use_payload_keeps_builtin_like_tool_names_namespaced()
```

**Purpose**: Checks that namespaces already resembling built-in names still remain MCP-prefixed rather than collapsing into a built-in hook name.

**Data flow**: Creates a payload and handler for namespace `mcp__foo` and tool `exec_command`, builds an invocation, calls `pre_tool_use_payload`, and asserts the hook name is `mcp__foo__exec_command` with the parsed JSON input preserved.

**Call relations**: This test specifically covers the underscore trimming and prefix-preservation logic in `join_tool_name` and `ensure_mcp_prefix`.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 3 external calls (assert_eq!, tool_info, json!).


##### `tests::mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp`  (lines 396–424)

```
async fn mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp()
```

**Purpose**: Verifies that hook-driven input rewriting preserves function payload shape for builtin-like MCP tool names.

**Data flow**: Creates a handler and invocation for namespace `mcp__foo`, calls `with_updated_hook_input(..., json!({"message":"rewritten"}))`, unwraps the returned invocation, pattern-matches its payload as `ToolPayload::Function`, and asserts the serialized argument string matches the rewritten JSON.

**Call relations**: This test targets `McpHandler::with_updated_hook_input` and ensures MCP tools remain function-shaped after rewriting.

*Call graph*: calls 4 internal fn (make_session_and_context, new, new, namespaced); 7 external calls (new, new, assert_eq!, tool_info, json!, panic!, new).


##### `tests::mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result`  (lines 427–482)

```
async fn mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result()
```

**Purpose**: Checks that post-tool hook payloads include the normalized MCP-prefixed name, rewritten tool input, and structured MCP result.

**Data flow**: Constructs a function payload, an `McpToolOutput` containing MCP content and structured content, a session/turn, handler, and invocation, then calls `handler.post_tool_use_payload(&invocation, &output)` and asserts equality with the expected `PostToolUsePayload`.

**Call relations**: This test exercises the post-hook path, relying on `McpHandler::post_tool_use_payload` plus `McpToolOutput`'s hook serialization behavior.

*Call graph*: calls 4 internal fn (make_session_and_context, new, new, namespaced); 9 external calls (new, from_millis, new, assert_eq!, tool_info, json!, Bytes, new, vec!).


##### `tests::mcp_read_only_hint_supports_parallel_calls_without_server_opt_in`  (lines 485–494)

```
fn mcp_read_only_hint_supports_parallel_calls_without_server_opt_in()
```

**Purpose**: Verifies that a read-only MCP tool is treated as safe for parallel execution even when the server-level opt-in flag is false.

**Data flow**: Builds `ToolInfo`, sets `tool.annotations.read_only(true)`, constructs an `McpHandler`, calls `supports_parallel_tool_calls`, and asserts the result is true.

**Call relations**: This test covers the annotation-based branch of `McpHandler::supports_parallel_tool_calls`.

*Call graph*: 3 external calls (assert!, tool_info, new).


##### `tests::mcp_parallel_calls_require_read_only_hint_or_server_opt_in`  (lines 497–520)

```
fn mcp_parallel_calls_require_read_only_hint_or_server_opt_in()
```

**Purpose**: Checks the negative and positive cases for MCP parallel-call eligibility.

**Data flow**: Creates three `ToolInfo` variants: one without annotations, one explicitly writable, and one with `supports_parallel_tool_calls = true`. It constructs handlers for each and asserts the first two return false from `supports_parallel_tool_calls` while the server-opt-in case returns true.

**Call relations**: This test complements the previous one by covering the remaining branches of the parallel-call policy.

*Call graph*: 3 external calls (assert!, tool_info, new).


##### `tests::tool_info`  (lines 522–541)

```
fn tool_info(server_name: &str, callable_namespace: &str, tool_name: &str) -> ToolInfo
```

**Purpose**: Builds minimal synthetic `ToolInfo` values for MCP handler tests.

**Data flow**: Accepts `server_name`, `callable_namespace`, and `tool_name`, then returns a `ToolInfo` populated with those values, `supports_parallel_tool_calls: false`, no origin/connector metadata, empty plugin display names, and an `rmcp::model::Tool` created from a minimal raw object schema.

**Call relations**: All MCP tests in this file use this helper to avoid repeating boilerplate `ToolInfo` construction.

*Call graph*: 5 external calls (new, new, new_with_raw, object, json!).


### `core/src/mcp_tool_call.rs`

`orchestration` · `MCP tool request handling`

This is the main MCP tool-call orchestration module. `handle_mcp_tool_call` parses JSON arguments, looks up tool metadata, derives approval policy from app policy, selected-plugin catalog state, or config/plugin defaults, emits a started event, and either short-circuits blocked calls or routes through approval handling before execution. Approval is layered: auto-approval policy can bypass prompting, remembered session approvals can skip future prompts, permission hooks can allow or deny, guardian review can mediate, and otherwise the code builds either a legacy `RequestUserInput` prompt or an MCP elicitation form enriched with connector/tool metadata and display-friendly parameters.

Once approved, `handle_approved_mcp_tool_call` optionally marks thread memory as polluted for external-context servers, rewrites declared Codex Apps file arguments via `mcp_openai_file`, builds request metadata including turn metadata, Codex Apps meta, plugin ID, thread ID, and optional sandbox state, then executes the tool under a tracing span. Results are sanitized for models without image input support, optionally trigger Codex Apps auth elicitation and tool-cache refresh, and are truncated before persistence into rollout events to avoid multi-megabyte stored payloads. The module emits start/completion `TurnItem::McpToolCall` events, records metrics and span attributes, and tracks Codex App usage analytics.

The file also owns approval persistence. Session approvals are stored in-memory keyed by server/connector/tool; persistent approvals are written back into project config, user config, app connector config, or plugin config depending on where the MCP server originates. Numerous helpers normalize approval responses, derive fallback prompt text, extract metadata such as UI resource URIs and declared OpenAI file params, and decide whether tool annotations imply approval is required.

#### Function details

##### `handle_mcp_tool_call`  (lines 111–307)

```
async fn handle_mcp_tool_call(
    sess: Arc<Session>,
    turn_context: &Arc<TurnContext>,
    call_id: String,
    server: String,
    tool_name: String,
    hook_tool_name: HookToolName,
    argume
```

**Purpose**: Runs the top-level MCP tool-call state machine from raw argument string through approval and eventual execution or skip. It is the public entrypoint for handling one MCP tool invocation.

**Data flow**: Inputs are `Arc<Session>`, `Arc<TurnContext>`, `call_id`, `server`, `tool_name`, `hook_tool_name`, and raw `arguments: String`. It parses `arguments` into optional `JsonValue`, returning an immediate error `CallToolResult` on invalid JSON; builds an `McpInvocation`; looks up metadata; computes item metadata and approval mode; blocks disabled Codex Apps tools via `notify_mcp_tool_call_skip`; emits a started event; optionally requests approval; on accept delegates to `handle_approved_mcp_tool_call`; on decline/cancel emits a skipped completion and metrics; otherwise executes directly. Returns `HandledMcpToolCall { result, tool_input }`.

**Call relations**: Called by the higher-level call dispatcher `handle_call`. It delegates metadata lookup, approval routing, execution, skip notification, and metrics emission to helpers throughout this file.

*Call graph*: calls 9 internal fn (default, new, custom_mcp_tool_approval_mode, emit_mcp_call_metrics, handle_approved_mcp_tool_call, lookup_mcp_tool_metadata, maybe_request_mcp_tool_approval, notify_mcp_tool_call_skip, notify_mcp_tool_call_started); called by 1 (handle_call); 6 external calls (Object, error!, format!, from_error_text, from_result, new).


##### `handle_approved_mcp_tool_call`  (lines 320–415)

```
async fn handle_approved_mcp_tool_call(
    sess: &Session,
    turn_context: &TurnContext,
    call_id: &str,
    invocation: McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
    item_m
```

**Purpose**: Executes an already-approved MCP tool call, including argument rewriting, request-meta construction, tracing, completion notification, analytics, and metrics. It is the post-approval execution path.

**Data flow**: Accepts `Session`, `TurnContext`, `call_id`, `McpInvocation`, optional approval metadata, and item metadata. It may mark thread memory polluted, captures connector/server-origin info, starts a timer, rewrites declared OpenAI file arguments, derives `tool_input` from rewritten or original arguments, builds request metadata, executes the tool inside an instrumented span via `execute_mcp_tool_call`, records span telemetry from the result, warns on errors, computes duration, emits completion with a truncated event-safe result, tracks Codex App usage, emits metrics, and returns `HandledMcpToolCall`.

**Call relations**: Reached only from `handle_mcp_tool_call` after approval or when no approval is needed. It delegates file rewriting to `mcp_openai_file`, execution to `execute_mcp_tool_call`, event emission to notify helpers, and analytics/metrics to dedicated helpers.

*Call graph*: calls 10 internal fn (rewrite_mcp_tool_arguments_for_openai_files, build_mcp_tool_call_request_meta, emit_mcp_call_metrics, execute_mcp_tool_call, maybe_mark_thread_memory_mode_polluted, maybe_track_codex_app_used, mcp_tool_call_span, notify_mcp_tool_call_completed, record_mcp_result_span_telemetry, truncate_mcp_tool_result_for_event); called by 1 (handle_mcp_tool_call); 4 external calls (now, current, from_result, warn!).


##### `emit_mcp_call_metrics`  (lines 417–440)

```
fn emit_mcp_call_metrics(
    turn_context: &TurnContext,
    status: &str,
    tool_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    duration: Option<Duration>,
)
```

**Purpose**: Records the standard MCP call counter and optional duration metric with sanitized tags. It centralizes metric emission for both successful and skipped/error flows.

**Data flow**: Takes `turn_context`, `status`, `tool_name`, optional `connector_id`, optional `connector_name`, and optional `Duration`. It builds tag pairs with `mcp_call_metric_tags`, converts them to `(&str, &str)` references, increments `MCP_CALL_COUNT_METRIC`, and if duration is present records `MCP_CALL_DURATION_METRIC`.

**Call relations**: Called from both `handle_mcp_tool_call` and `handle_approved_mcp_tool_call` after a final status is known. It depends on `mcp_call_metric_tags` for consistent tag construction.

*Call graph*: calls 1 internal fn (mcp_call_metric_tags); called by 2 (handle_approved_mcp_tool_call, handle_mcp_tool_call).


##### `mcp_call_metric_tags`  (lines 442–460)

```
fn mcp_call_metric_tags(
    status: &str,
    tool_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
) -> Vec<(&'static str, String)>
```

**Purpose**: Builds sanitized metric tags for MCP call telemetry. It always includes status and tool name, and conditionally includes non-empty connector identifiers.

**Data flow**: Inputs are `status`, `tool_name`, optional `connector_id`, and optional `connector_name`. It sanitizes each included value with `sanitize_metric_tag_value`, pushes mandatory `status` and `tool` tags into a vector, conditionally appends `connector_id` and `connector_name`, and returns `Vec<(&'static str, String)>`.

**Call relations**: Used only by `emit_mcp_call_metrics` to keep metric tagging logic in one place.

*Call graph*: called by 1 (emit_mcp_call_metrics); 2 external calls (sanitize_metric_tag_value, vec!).


##### `mcp_tool_call_span`  (lines 462–495)

```
fn mcp_tool_call_span(
    session: &Session,
    turn_context: &TurnContext,
    fields: McpToolCallSpanFields<'_>,
) -> Span
```

**Purpose**: Creates the tracing span used around MCP tool execution, pre-populated with RPC, server, connector, tool, conversation, and telemetry fields. It standardizes observability for MCP calls.

**Data flow**: Accepts `Session`, `TurnContext`, and `McpToolCallSpanFields`. It derives a transport label from `server_origin`, creates an `info_span!` with fixed OpenTelemetry-style fields plus empty placeholders for server address/port and result telemetry, calls `record_server_fields` to fill host/port when possible, and returns the `Span`.

**Call relations**: Constructed by `handle_approved_mcp_tool_call` immediately before `execute_mcp_tool_call` is instrumented. It delegates URL parsing details to `record_server_fields`.

*Call graph*: calls 1 internal fn (record_server_fields); called by 1 (handle_approved_mcp_tool_call); 1 external calls (info_span!).


##### `record_server_fields`  (lines 506–519)

```
fn record_server_fields(span: &Span, url: Option<&str>)
```

**Purpose**: Extracts host and port from a server-origin URL and records them onto an existing tracing span. It silently ignores absent or unparsable URLs.

**Data flow**: Takes a `Span` and optional URL string. If the URL is present and `Url::parse` succeeds, it records `server.address` from `host_str()` and `server.port` from `port_or_known_default()` when available.

**Call relations**: Called only by `mcp_tool_call_span` to enrich the span with network endpoint fields.

*Call graph*: called by 1 (mcp_tool_call_span); 2 external calls (record, parse).


##### `record_mcp_result_span_telemetry`  (lines 521–553)

```
fn record_mcp_result_span_telemetry(span: &Span, result: Option<&CallToolResult>)
```

**Purpose**: Copies selected telemetry fields embedded in an MCP tool result’s `_meta` into tracing span attributes. It currently records target ID and whether a server-side user flow was triggered.

**Data flow**: Accepts a `Span` and optional `&CallToolResult`. It drills through `result.meta` → object → `codex/telemetry` → `span`, then if present records a truncated `target_id` string under `codex.mcp.target.id` and a boolean `did_trigger_server_user_flow` under `codex.mcp.server_user_flow.triggered`.

**Call relations**: Called by `handle_approved_mcp_tool_call` after execution completes but before completion notification. It uses `truncate_str_to_char_boundary` to keep target IDs bounded.

*Call graph*: calls 1 internal fn (truncate_str_to_char_boundary); called by 1 (handle_approved_mcp_tool_call); 1 external calls (record).


##### `truncate_str_to_char_boundary`  (lines 555–560)

```
fn truncate_str_to_char_boundary(value: &str, max_chars: usize) -> &str
```

**Purpose**: Returns a prefix of a string limited to a maximum number of Unicode scalar positions without cutting through a UTF-8 codepoint. It is a safe truncation helper for span attributes.

**Data flow**: Takes `value: &str` and `max_chars: usize`, finds the byte index of the `max_chars`-th character with `char_indices().nth(max_chars)`, and returns either the prefix up to that byte index or the original string if shorter.

**Call relations**: Used only by `record_mcp_result_span_telemetry` when recording bounded target IDs.

*Call graph*: called by 1 (record_mcp_result_span_telemetry).


##### `execute_mcp_tool_call`  (lines 562–610)

```
async fn execute_mcp_tool_call(
    sess: &Session,
    turn_context: &TurnContext,
    call_id: &str,
    invocation: &McpInvocation,
    rewritten_arguments: Option<JsonValue>,
    metadata: Option<
```

**Purpose**: Builds final request metadata, invokes the MCP tool through the session, sanitizes the result for model capabilities, and optionally triggers Codex Apps auth elicitation. It is the direct execution wrapper around `Session::call_tool`.

**Data flow**: Inputs are `Session`, `TurnContext`, `call_id`, `McpInvocation`, optional rewritten arguments, optional metadata, and optional request meta. It injects thread ID into meta, augments meta with sandbox state when supported, starts an MCP call trace, adds trace metadata, awaits `sess.call_tool(...)`, maps transport errors into strings, sanitizes image blocks out of the result when the model lacks image input support, then passes the result through `maybe_request_codex_apps_auth_elicitation` and returns `Result<CallToolResult, String>`.

**Call relations**: Called only by `handle_approved_mcp_tool_call`. It delegates metadata augmentation, result sanitization, and auth-elicitation follow-up to helpers in this file.

*Call graph*: calls 4 internal fn (augment_mcp_tool_request_meta_with_sandbox_state, maybe_request_codex_apps_auth_elicitation, sanitize_mcp_tool_result_for_model, with_mcp_tool_call_thread_id_meta); called by 1 (handle_approved_mcp_tool_call); 1 external calls (call_tool).


##### `maybe_request_codex_apps_auth_elicitation`  (lines 612–683)

```
async fn maybe_request_codex_apps_auth_elicitation(
    sess: &Session,
    turn_context: &TurnContext,
    call_id: &str,
    server: &str,
    metadata: Option<&McpToolApprovalMetadata>,
    result:
```

**Purpose**: Detects Codex Apps auth-failure results that should trigger a user-facing connector-auth elicitation, requests that elicitation, and rewrites the result if the user completes auth. It only applies to host-owned Codex Apps servers and when the feature/policy allow it.

**Data flow**: Accepts `Session`, `TurnContext`, `call_id`, `server`, optional metadata, and a `CallToolResult`. It returns early unless the server is a host-owned Codex Apps server, the `AuthElicitation` feature is enabled, and approval policy permits MCP elicitations. It derives connector info and install URL, asks `build_auth_elicitation_plan` whether the result warrants elicitation, sends `request_mcp_server_elicitation` if so, and if the response action is `Accept`, refreshes Codex Apps tools/connectors and returns `auth_elicitation_completed_result(&plan.auth_failure, result.meta)`; otherwise it returns the original result.

**Call relations**: Called by `execute_mcp_tool_call` after a successful raw tool call. It delegates cache refresh to `refresh_codex_apps_after_connector_auth` and plan construction to `codex_mcp` helpers.

*Call graph*: calls 1 internal fn (refresh_codex_apps_after_connector_auth); called by 1 (execute_mcp_tool_call); 4 external calls (String, auth_elicitation_completed_result, build_auth_elicitation_plan, request_mcp_server_elicitation).


##### `refresh_codex_apps_after_connector_auth`  (lines 685–704)

```
async fn refresh_codex_apps_after_connector_auth(sess: &Session, turn_context: &TurnContext)
```

**Purpose**: Refreshes the Codex Apps tools cache and connector accessibility cache after a connector-auth flow succeeds. It keeps subsequent tool metadata and connector lists in sync with the newly authenticated state.

**Data flow**: Takes `Session` and `TurnContext`, asks the MCP connection manager for a hard refresh of the Codex Apps tools cache, and on success fetches current auth and calls `connectors::refresh_accessible_connectors_cache_from_mcp_tools(&turn_context.config, auth.as_ref(), &mcp_tools)`. On failure it logs a warning.

**Call relations**: Used only by `maybe_request_codex_apps_auth_elicitation` after the user accepts and completes an auth elicitation.

*Call graph*: calls 1 internal fn (refresh_accessible_connectors_cache_from_mcp_tools); called by 1 (maybe_request_codex_apps_auth_elicitation); 1 external calls (warn!).


##### `augment_mcp_tool_request_meta_with_sandbox_state`  (lines 706–751)

```
async fn augment_mcp_tool_request_meta_with_sandbox_state(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
    mut meta: Option<serde_json::Value>,
) -> anyhow::Result<Option<ser
```

**Purpose**: Adds serialized sandbox-state metadata to an MCP tool request when the target server advertises support for that capability. It lets capable servers understand the caller’s sandbox context.

**Data flow**: Inputs are `Session`, `TurnContext`, `server`, and optional JSON `meta`. It asynchronously checks whether the server supports sandbox-state meta capability; if not, returns the original meta. Otherwise it serializes a `SandboxState` containing permission profile, sandbox policy, Linux sandbox executable, deprecated sandbox cwd, and legacy-Landlock flag. It inserts that value into an existing object meta map or creates a new object map if meta was `None`, leaving non-object meta unchanged, and returns `anyhow::Result<Option<JsonValue>>`.

**Call relations**: Called by `execute_mcp_tool_call` before the actual tool invocation. It depends on MCP connection-manager capability probing and on `TurnContext` sandbox-related state.

*Call graph*: calls 2 internal fn (permission_profile, sandbox_policy); called by 1 (execute_mcp_tool_call); 3 external calls (new, Object, to_value).


##### `maybe_mark_thread_memory_mode_polluted`  (lines 753–775)

```
async fn maybe_mark_thread_memory_mode_polluted(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
)
```

**Purpose**: Marks the thread’s memory mode as polluted when external-context MCP servers are used and config requests disabling memories in that case. It is a side-effect guard around memory safety policy.

**Data flow**: Accepts `Session`, `TurnContext`, and `server`. It checks `turn_context.config.memories.disable_on_external_context`, asks the MCP connection manager whether the server pollutes memory, and if so awaits `state_db::mark_thread_memory_mode_polluted(...)` with reason `"mcp_tool_call"`.

**Call relations**: Called at the start of `handle_approved_mcp_tool_call` before execution. It does not affect the tool result directly; it updates persistent thread state.

*Call graph*: calls 1 internal fn (mark_thread_memory_mode_polluted); called by 1 (handle_approved_mcp_tool_call).


##### `sanitize_mcp_tool_result_for_model`  (lines 777–806)

```
fn sanitize_mcp_tool_result_for_model(
    supports_image_input: bool,
    result: Result<CallToolResult, String>,
) -> Result<CallToolResult, String>
```

**Purpose**: Removes image content blocks from MCP tool results when the current model cannot accept image input. It preserves all non-image content and metadata.

**Data flow**: Takes `supports_image_input: bool` and `Result<CallToolResult, String>`. If image input is supported it returns the result unchanged. Otherwise, on `Ok(call_tool_result)` it maps each `content` block: blocks whose `type` is `"image"` become a text block with a fixed omission message, all others are cloned unchanged; `structured_content`, `is_error`, and `meta` are preserved. Errors pass through unchanged.

**Call relations**: Called by `execute_mcp_tool_call` immediately after `Session::call_tool` succeeds. It is the model-capability adaptation layer before any auth elicitation logic.

*Call graph*: called by 1 (execute_mcp_tool_call).


##### `truncate_mcp_tool_result_for_event`  (lines 808–850)

```
fn truncate_mcp_tool_result_for_event(
    result: &Result<CallToolResult, String>,
) -> Result<CallToolResult, String>
```

**Purpose**: Shrinks MCP tool results before they are persisted in turn events so rollout storage does not retain multi-megabyte payloads. It preserves a useful preview while dropping bulky structured data.

**Data flow**: Accepts `&Result<CallToolResult, String>`. For `Ok`, it serializes the whole result to JSON; if within `MCP_TOOL_CALL_EVENT_RESULT_MAX_BYTES`, it clones and returns it unchanged. If too large, it truncates the serialized string with `truncate_text(Bytes(...))` and returns a replacement `CallToolResult` containing a single text block preview, preserving `is_error` but dropping `structured_content` and `meta`. For `Err`, it truncates the error string to the same byte budget.

**Call relations**: Used by `handle_approved_mcp_tool_call` and `notify_mcp_tool_call_skip` right before emitting completion events. It affects only the event copy, not the actual returned tool result.

*Call graph*: called by 2 (handle_approved_mcp_tool_call, notify_mcp_tool_call_skip); 4 external calls (truncate_text, Bytes, to_string, vec!).


##### `notify_mcp_tool_call_started`  (lines 852–877)

```
async fn notify_mcp_tool_call_started(
    sess: &Session,
    turn_context: &TurnContext,
    call_id: &str,
    invocation: McpInvocation,
    item_metadata: McpToolCallItemMetadata,
)
```

**Purpose**: Emits the in-progress `TurnItem::McpToolCall` event for a tool invocation. It converts invocation data and item metadata into the protocol item shape expected by the session.

**Data flow**: Takes `Session`, `TurnContext`, `call_id`, `McpInvocation`, and `McpToolCallItemMetadata`. It destructures the invocation, builds `TurnItem::McpToolCall(McpToolCallItem { ... status: InProgress, result: None, error: None, duration: None })`, using `JsonValue::Null` when arguments are absent, and awaits `sess.emit_turn_item_started(turn_context, &item)`.

**Call relations**: Called by `handle_mcp_tool_call` for normal execution and by `notify_mcp_tool_call_skip` when a skipped call had not already been started.

*Call graph*: called by 2 (handle_mcp_tool_call, notify_mcp_tool_call_skip); 2 external calls (McpToolCall, emit_turn_item_started).


##### `notify_mcp_tool_call_completed`  (lines 879–917)

```
async fn notify_mcp_tool_call_completed(
    sess: &Session,
    turn_context: &TurnContext,
    call_id: &str,
    invocation: McpInvocation,
    item_metadata: McpToolCallItemMetadata,
    duration:
```

**Purpose**: Emits the terminal `TurnItem::McpToolCall` event with completed or failed status, result/error payload, and duration. It is the completion counterpart to the started-event helper.

**Data flow**: Inputs are `Session`, `TurnContext`, `call_id`, `McpInvocation`, item metadata, `duration`, and `Result<CallToolResult, String>`. It maps the result into `(status, result, error)`, treating `Ok` with `is_error == true` as `Failed`, then builds a completed `McpToolCallItem` carrying arguments, metadata, status, optional result, optional `McpToolCallError`, and duration, and emits it via `sess.emit_turn_item_completed`.

**Call relations**: Called by `handle_approved_mcp_tool_call` after execution and by `notify_mcp_tool_call_skip` for blocked/declined/cancelled calls.

*Call graph*: called by 2 (handle_approved_mcp_tool_call, notify_mcp_tool_call_skip); 2 external calls (McpToolCall, emit_turn_item_completed).


##### `maybe_track_codex_app_used`  (lines 924–961)

```
async fn maybe_track_codex_app_used(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
    tool_name: &str,
)
```

**Purpose**: Sends analytics when a Codex Apps MCP tool is used, classifying the invocation as explicit or implicit based on connector selection. Non-Codex-Apps servers are ignored.

**Data flow**: Accepts `Session`, `TurnContext`, `server`, and `tool_name`. If `server` is not `CODEX_APPS_MCP_SERVER_NAME`, it returns. Otherwise it looks up connector/app metadata, fetches the session’s selected connector IDs, derives `InvocationType::Explicit` when the connector was explicitly selected and `Implicit` otherwise, builds tracking context from model/thread/turn IDs, and calls `analytics_events_client.track_app_used(...)`.

**Call relations**: Called at the end of `handle_approved_mcp_tool_call` after completion notification. It depends on `lookup_mcp_app_usage_metadata` and session connector-selection state.

*Call graph*: calls 1 internal fn (lookup_mcp_app_usage_metadata); called by 1 (handle_approved_mcp_tool_call); 2 external calls (build_track_events_context, get_connector_selection).


##### `custom_mcp_tool_approval_mode`  (lines 990–1037)

```
async fn custom_mcp_tool_approval_mode(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
    tool_name: &str,
) -> AppToolApproval
```

**Purpose**: Resolves the approval mode for a non-Codex-Apps MCP tool from user/project config first and active plugin config second, defaulting otherwise. It is the fallback approval-policy resolver.

**Data flow**: Takes `Session`, `TurnContext`, `server`, and `tool_name`. It inspects the effective config layer stack for a deserializable `mcp_servers` table, looks up the named server and tool-specific or default approval mode, and returns it if found. Otherwise it loads active plugins for the current config input, searches for a plugin MCP server with the same name, and returns that tool-specific or default approval mode, falling back to `AppToolApproval::default()`.

**Call relations**: Called by `handle_mcp_tool_call` when the server is neither Codex Apps nor a selected-plugin registration with catalog-provided approval mode.

*Call graph*: called by 1 (handle_mcp_tool_call).


##### `build_mcp_tool_call_request_meta`  (lines 1039–1081)

```
fn build_mcp_tool_call_request_meta(
    turn_context: &TurnContext,
    server: &str,
    call_id: &str,
    metadata: Option<&McpToolApprovalMetadata>,
) -> Option<serde_json::Value>
```

**Purpose**: Builds the base JSON metadata object attached to an MCP tool request, including turn metadata, Codex Apps meta, call ID, and plugin ID. It omits the object entirely when no fields are present.

**Data flow**: Inputs are `TurnContext`, `server`, `call_id`, and optional approval metadata. It starts an empty JSON map, optionally inserts current turn metadata under `X_CODEX_TURN_METADATA_HEADER`, for Codex Apps clones `metadata.codex_apps_meta` and inserts `call_id` under `MCP_TOOL_CODEX_APPS_META_KEY`, optionally inserts `plugin_id`, and returns `Some(JsonValue::Object(map))` only if the map is non-empty.

**Call relations**: Called by `handle_approved_mcp_tool_call` before execution. Its output is further augmented by `with_mcp_tool_call_thread_id_meta` and `augment_mcp_tool_request_meta_with_sandbox_state`.

*Call graph*: calls 1 internal fn (effective_reasoning_effort); called by 1 (handle_approved_mcp_tool_call); 3 external calls (new, Object, String).


##### `with_mcp_tool_call_thread_id_meta`  (lines 1083–1105)

```
fn with_mcp_tool_call_thread_id_meta(
    meta: Option<serde_json::Value>,
    thread_id: &str,
) -> Option<serde_json::Value>
```

**Purpose**: Ensures the outgoing MCP request metadata contains the current thread ID. It can add the field to an existing object or create a new object when metadata is absent.

**Data flow**: Accepts optional JSON `meta` and `thread_id`. If `meta` is an object, it inserts `threadId`; if `meta` is `None`, it creates a new object containing only `threadId`; any other JSON type is returned unchanged.

**Call relations**: Called by `execute_mcp_tool_call` as the first metadata augmentation step before sandbox-state insertion and trace metadata.

*Call graph*: called by 1 (execute_mcp_tool_call); 3 external calls (new, Object, String).


##### `is_mcp_tool_approval_question_id`  (lines 1134–1138)

```
fn is_mcp_tool_approval_question_id(question_id: &str) -> bool
```

**Purpose**: Recognizes whether a question ID belongs to the MCP tool approval prompt namespace. It is a small identifier classifier used by approval-related flows.

**Data flow**: Takes `question_id: &str`, strips the `MCP_TOOL_APPROVAL_QUESTION_ID_PREFIX`, and returns `true` only when the remaining suffix exists and starts with an underscore.

**Call relations**: Used by external approval-handling code paths to identify MCP tool approval prompts generated by this module.


##### `mcp_tool_approval_prompt_options`  (lines 1147–1157)

```
fn mcp_tool_approval_prompt_options(
    session_approval_key: Option<&McpToolApprovalKey>,
    persistent_approval_key: Option<&McpToolApprovalKey>,
    tool_call_mcp_elicitation_enabled: bool,
) ->
```

**Purpose**: Computes which approval prompt persistence options should be offered to the user. It derives session and persistent rememberability from the presence of approval keys and feature enablement.

**Data flow**: Accepts optional session and persistent `McpToolApprovalKey` references plus a `tool_call_mcp_elicitation_enabled` flag. Returns `McpToolApprovalPromptOptions { allow_session_remember, allow_persistent_approval }`, where persistent approval additionally requires the elicitation feature to be enabled.

**Call relations**: Called by `maybe_request_mcp_tool_approval` after approval keys are computed and before building the prompt or elicitation request.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval).


##### `maybe_request_mcp_tool_approval`  (lines 1159–1341)

```
async fn maybe_request_mcp_tool_approval(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    call_id: &str,
    invocation: &McpInvocation,
    hook_tool_name: &HookToolName,
    metada
```

**Purpose**: Determines whether approval is needed for an MCP tool call and, if so, obtains a decision through remembered approvals, hooks, guardian review, MCP elicitation, or legacy user-input prompting. It is the approval engine for this module.

**Data flow**: Inputs are `Arc<Session>`, `Arc<TurnContext>`, `call_id`, `McpInvocation`, `HookToolName`, optional metadata, and `approval_mode`. It resolves the approvals reviewer, checks auto-approval policy, computes whether annotations require approval, derives session/persistent approval keys, short-circuits on remembered session approval, runs permission hooks, checks feature flags, optionally routes to guardian and converts the review result, otherwise builds prompt options, question ID, optional rendered template and display params, constructs either an MCP elicitation request or `RequestUserInputArgs`, parses and normalizes the response into `McpToolApprovalDecision`, applies persistence/session side effects, and returns `Some(decision)` or `None` when no approval was needed.

**Call relations**: Called by `handle_mcp_tool_call` after the started event is emitted. It orchestrates many helpers in this file: reviewer selection, approval-key derivation, guardian request building, prompt rendering, response parsing, and persistence application.

*Call graph*: calls 16 internal fn (run_permission_request_hooks, render_mcp_tool_approval_template, apply_mcp_tool_approval_decision, build_guardian_mcp_tool_review_request, build_mcp_tool_approval_elicitation_request, build_mcp_tool_approval_question, mcp_approvals_reviewer, mcp_tool_approval_decision_from_guardian, mcp_tool_approval_is_remembered, mcp_tool_approval_prompt_options (+6 more)); called by 1 (handle_mcp_tool_call); 8 external calls (String, mcp_permission_prompt_is_auto_approved, clone, new_guardian_review_id, review_approval_request, routes_approval_to_guardian_with_reviewer, format!, vec!).


##### `mcp_approvals_reviewer`  (lines 1343–1353)

```
fn mcp_approvals_reviewer(
    turn_context: &TurnContext,
    server_name: &str,
    metadata: Option<&McpToolApprovalMetadata>,
) -> ApprovalsReviewer
```

**Purpose**: Resolves which approvals reviewer policy applies to an MCP tool call, taking connector identity into account for Codex Apps tools. It is a thin adapter over connector approval policy logic.

**Data flow**: Accepts `TurnContext`, `server_name`, and optional metadata, then calls `connectors::mcp_approvals_reviewer(turn_context.config.as_ref(), server_name, metadata.and_then(|m| m.connector_id.as_deref()))` and returns `ApprovalsReviewer`.

**Call relations**: Used by `maybe_request_mcp_tool_approval` and other approval-related compatibility paths to decide whether approval should route through guardian.

*Call graph*: calls 1 internal fn (mcp_approvals_reviewer); called by 2 (maybe_auto_review_mcp_request_user_input, maybe_request_mcp_tool_approval).


##### `session_mcp_tool_approval_key`  (lines 1355–1374)

```
fn session_mcp_tool_approval_key(
    invocation: &McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
    approval_mode: AppToolApproval,
) -> Option<McpToolApprovalKey>
```

**Purpose**: Builds the in-memory approval key used for session-scoped remembered approvals when the tool’s approval mode allows auto-approval after first consent. Codex Apps tools without a connector ID are intentionally excluded.

**Data flow**: Takes `McpInvocation`, optional metadata, and `approval_mode`. If `approval_mode` is not `AppToolApproval::Auto`, returns `None`. Otherwise it extracts optional `connector_id`, rejects Codex Apps invocations lacking a connector ID, and returns `Some(McpToolApprovalKey { server, connector_id, tool_name })`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` and reused by `persistent_mcp_tool_approval_key`. Its output controls whether session remember options are offered and checked.

*Call graph*: called by 2 (maybe_request_mcp_tool_approval, persistent_mcp_tool_approval_key).


##### `persistent_mcp_tool_approval_key`  (lines 1376–1382)

```
fn persistent_mcp_tool_approval_key(
    invocation: &McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
    approval_mode: AppToolApproval,
) -> Option<McpToolApprovalKey>
```

**Purpose**: Builds the key used for persistent approval storage. In the current design it is identical to the session approval key.

**Data flow**: Accepts the same inputs as `session_mcp_tool_approval_key` and simply returns that function’s result.

**Call relations**: Called by `maybe_request_mcp_tool_approval` when persistent approval is allowed for the server. It exists as a separate helper so persistent-key semantics can diverge later if needed.

*Call graph*: calls 1 internal fn (session_mcp_tool_approval_key); called by 1 (maybe_request_mcp_tool_approval).


##### `build_guardian_mcp_tool_review_request`  (lines 1384–1407)

```
fn build_guardian_mcp_tool_review_request(
    call_id: &str,
    invocation: &McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
) -> GuardianApprovalRequest
```

**Purpose**: Converts an MCP invocation and its metadata into the `GuardianApprovalRequest::McpToolCall` payload expected by guardian review. It preserves connector and annotation context for policy evaluation.

**Data flow**: Inputs are `call_id`, `McpInvocation`, and optional metadata. It clones server, tool name, arguments, connector fields, tool title/description, and maps `ToolAnnotations` into `GuardianMcpAnnotations`, then returns `GuardianApprovalRequest::McpToolCall { ... }`.

**Call relations**: Used by `maybe_request_mcp_tool_approval` when approval is routed to guardian, and by compatibility paths that auto-review MCP prompts.

*Call graph*: called by 2 (maybe_auto_review_mcp_request_user_input, maybe_request_mcp_tool_approval).


##### `mcp_tool_approval_decision_from_guardian`  (lines 1409–1427)

```
async fn mcp_tool_approval_decision_from_guardian(
    sess: &Session,
    review_id: &str,
    decision: ReviewDecision,
) -> McpToolApprovalDecision
```

**Purpose**: Maps guardian `ReviewDecision` values into this module’s `McpToolApprovalDecision` enum, including user-facing rejection and timeout messages. It normalizes guardian semantics for the rest of the approval flow.

**Data flow**: Accepts `Session`, `review_id`, and `ReviewDecision`. Approved variants map to `Accept`, `ApprovedForSession` maps to `AcceptForSession`, `Denied` maps to `Decline` with `guardian_rejection_message`, `TimedOut` maps to `Decline` with `guardian_timeout_message()`, and `Abort` maps to `Decline { message: None }`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` after guardian review completes. Its output is then passed into `apply_mcp_tool_approval_decision`.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 2 external calls (guardian_rejection_message, guardian_timeout_message).


##### `lookup_mcp_tool_metadata`  (lines 1429–1489)

```
async fn lookup_mcp_tool_metadata(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
    tool_name: &str,
) -> Option<McpToolApprovalMetadata>
```

**Purpose**: Finds MCP tool metadata needed for approval prompts, analytics, UI resource linking, and OpenAI file-argument rewriting. It joins MCP tool inventory with connector metadata when the server is Codex Apps.

**Data flow**: Inputs are `Session`, `TurnContext`, `server`, and `tool_name`. It queries the MCP connection manager for plugin ID and full tool inventory, finds the matching tool entry, optionally resolves connector descriptions from cached or freshly listed accessible connectors for Codex Apps, extracts annotations, connector fields, tool title/description, UI resource URI via `get_mcp_app_resource_uri`, Codex Apps meta object, and declared OpenAI file input params via `openai_file_input_params_for_server`, then returns `Some(McpToolApprovalMetadata)` or `None` if the tool is not found.

**Call relations**: Called by `handle_mcp_tool_call` before approval/execution and by approval compatibility paths. It delegates specific metadata extraction to `get_mcp_app_resource_uri` and `openai_file_input_params_for_server`.

*Call graph*: calls 4 internal fn (list_accessible_connectors_from_mcp_tools, list_cached_accessible_connectors_from_mcp_tools, get_mcp_app_resource_uri, openai_file_input_params_for_server); called by 2 (maybe_auto_review_mcp_request_user_input, handle_mcp_tool_call).


##### `openai_file_input_params_for_server`  (lines 1491–1498)

```
fn openai_file_input_params_for_server(
    server: &str,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<Vec<String>>
```

**Purpose**: Extracts declared OpenAI file-input parameter names from tool metadata, but only for the Codex Apps MCP server. Custom MCP servers are intentionally prevented from using this upload path.

**Data flow**: Accepts `server` and optional metadata map. If `server == CODEX_APPS_MCP_SERVER_NAME`, it computes `declared_openai_file_input_param_names(meta)` and returns `Some(Vec<String>)` only when the resulting list is non-empty; otherwise returns `None`.

**Call relations**: Used by `lookup_mcp_tool_metadata` to populate `McpToolApprovalMetadata.openai_file_input_params`, which later drives argument rewriting in `handle_approved_mcp_tool_call`.

*Call graph*: called by 1 (lookup_mcp_tool_metadata); 1 external calls (declared_openai_file_input_param_names).


##### `get_mcp_app_resource_uri`  (lines 1500–1518)

```
fn get_mcp_app_resource_uri(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String>
```

**Purpose**: Extracts the best available UI/resource URI from MCP tool metadata using several legacy and compatibility keys. It supports multiple metadata layouts.

**Data flow**: Accepts optional metadata map and searches in order: `meta["ui"]["resourceUri"]`, flat `ui/resourceUri`, then `openai/outputTemplate`, returning the first string found as `Some(String)`.

**Call relations**: Called by `lookup_mcp_tool_metadata` to populate `mcp_app_resource_uri` on approval metadata and emitted turn items.

*Call graph*: called by 1 (lookup_mcp_tool_metadata).


##### `lookup_mcp_app_usage_metadata`  (lines 1520–1542)

```
async fn lookup_mcp_app_usage_metadata(
    sess: &Session,
    server: &str,
    tool_name: &str,
) -> Option<McpAppUsageMetadata>
```

**Purpose**: Finds connector/app identity for analytics tracking of Codex Apps tool usage. It is a lightweight inventory lookup separate from approval metadata.

**Data flow**: Takes `Session`, `server`, and `tool_name`, lists all tools from the MCP connection manager, finds the matching tool entry, and returns `Some(McpAppUsageMetadata { connector_id, app_name: connector_name })` or `None`.

**Call relations**: Used only by `maybe_track_codex_app_used` after a successful tool call.

*Call graph*: called by 1 (maybe_track_codex_app_used).


##### `build_mcp_tool_approval_question`  (lines 1544–1588)

```
fn build_mcp_tool_approval_question(
    question_id: String,
    server: &str,
    tool_name: &str,
    connector_name: Option<&str>,
    prompt_options: McpToolApprovalPromptOptions,
    question_ov
```

**Purpose**: Constructs the legacy `RequestUserInputQuestion` for approving an MCP tool call, including the appropriate set of allow/remember/cancel options. It also applies any rendered question override.

**Data flow**: Inputs are `question_id`, `server`, `tool_name`, optional `connector_name`, `prompt_options`, and optional `question_override`. It chooses the question text from the override or `build_mcp_tool_approval_fallback_message`, normalizes it to end with a single `?`, builds the options vector starting with Allow and conditionally adding session/persistent remember options before Cancel, and returns a populated `RequestUserInputQuestion` with fixed header `"Approve app tool call?"`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` before either legacy prompting or MCP elicitation. It delegates fallback wording to `build_mcp_tool_approval_fallback_message`.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 2 external calls (format!, vec!).


##### `build_mcp_tool_approval_fallback_message`  (lines 1590–1607)

```
fn build_mcp_tool_approval_fallback_message(
    server: &str,
    tool_name: &str,
    connector_name: Option<&str>,
) -> String
```

**Purpose**: Generates the default approval question text when no connector-specific template is available. It chooses a human-readable actor string based on connector name and server type.

**Data flow**: Accepts `server`, `tool_name`, and optional `connector_name`. It trims and uses a non-empty connector name when present; otherwise it uses `"this app"` for Codex Apps or `format!("the {server} MCP server")` for other servers. It returns `format!("Allow {actor} to run tool \"{tool_name}\"?")`.

**Call relations**: Used only by `build_mcp_tool_approval_question` as the fallback wording path.

*Call graph*: 1 external calls (format!).


##### `build_mcp_tool_approval_elicitation_request`  (lines 1609–1640)

```
fn build_mcp_tool_approval_elicitation_request(
    sess: &Session,
    turn_context: &TurnContext,
    request: McpToolApprovalElicitationRequest<'_>,
) -> McpServerElicitationRequestParams
```

**Purpose**: Builds the MCP server elicitation request payload for tool approval when the richer elicitation path is enabled. It wraps approval metadata and an empty object schema into the app-server protocol shape.

**Data flow**: Accepts `Session`, `TurnContext`, and `McpToolApprovalElicitationRequest`. It chooses the message from `message_override` or the question text, builds metadata with `build_mcp_tool_approval_elicitation_meta`, and returns `McpServerElicitationRequestParams` containing thread/turn IDs, server name, and a `Form` request with empty object schema properties.

**Call relations**: Called by `maybe_request_mcp_tool_approval` when `Feature::ToolCallMcpElicitation` is enabled. It delegates metadata assembly to `build_mcp_tool_approval_elicitation_meta`.

*Call graph*: calls 1 internal fn (build_mcp_tool_approval_elicitation_meta); called by 1 (maybe_request_mcp_tool_approval); 1 external calls (new).


##### `build_mcp_tool_approval_elicitation_meta`  (lines 1642–1738)

```
fn build_mcp_tool_approval_elicitation_meta(
    server: &str,
    metadata: Option<&McpToolApprovalMetadata>,
    tool_params: Option<&serde_json::Value>,
    tool_params_display: Option<&[RenderedMc
```

**Purpose**: Assembles the structured metadata attached to an MCP approval elicitation, including persistence options, connector/tool descriptors, and tool parameters. This metadata drives richer approval UIs.

**Data flow**: Inputs are `server`, optional approval metadata, optional `tool_params`, optional display params, and `prompt_options`. It creates a JSON map, inserts approval kind and persistence metadata according to allowed remember modes, conditionally inserts tool title/description, connector source/id/name/description for Codex Apps, raw tool params, and serialized display params when conversion succeeds. Returns `Some(JsonValue::Object(meta))` unless the map is empty.

**Call relations**: Used only by `build_mcp_tool_approval_elicitation_request`. Its output is consumed by the app-server/UI side of MCP approval elicitation.

*Call graph*: called by 1 (build_mcp_tool_approval_elicitation_request); 5 external calls (new, Object, String, json!, to_value).


##### `build_mcp_tool_approval_display_params`  (lines 1740–1756)

```
fn build_mcp_tool_approval_display_params(
    tool_params: Option<&serde_json::Value>,
) -> Option<Vec<crate::mcp_tool_approval_templates::RenderedMcpToolApprovalParam>>
```

**Purpose**: Builds a simple sorted display-parameter list from raw tool arguments when no connector-specific template supplied a richer ordering or labels. It is the generic fallback for approval UIs.

**Data flow**: Accepts optional `tool_params` JSON, requires it to be an object, maps each `(name, value)` pair into `RenderedMcpToolApprovalParam { name, value, display_name: name }`, sorts the vector by `name`, and returns `Some(Vec<...>)`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` when `render_mcp_tool_approval_template` did not provide `tool_params_display`.


##### `parse_mcp_tool_approval_elicitation_response`  (lines 1758–1794)

```
fn parse_mcp_tool_approval_elicitation_response(
    response: Option<ElicitationResponse>,
    question_id: &str,
) -> McpToolApprovalDecision
```

**Purpose**: Converts an MCP elicitation response into an `McpToolApprovalDecision`, honoring explicit persistence metadata and falling back to legacy answer parsing when needed. It bridges the elicitation protocol to the internal approval enum.

**Data flow**: Takes optional `ElicitationResponse` and `question_id`. Missing response becomes `Cancel`. `Accept` first checks response meta for `persist=session` or `persist=always`, returning `AcceptForSession` or `AcceptAndRemember` respectively; otherwise it converts elicitation content into a `RequestUserInputResponse` with `request_user_input_response_from_elicitation_content`, parses that with `parse_mcp_tool_approval_response`, and treats a parsed `Cancel` as plain `Accept`. `Decline` maps to `Decline { message: None }`, and `Cancel` maps to `Cancel`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` after `request_mcp_server_elicitation`. It delegates content conversion and legacy answer parsing to two helpers.

*Call graph*: calls 2 internal fn (parse_mcp_tool_approval_response, request_user_input_response_from_elicitation_content); called by 1 (maybe_request_mcp_tool_approval).


##### `request_user_input_response_from_elicitation_content`  (lines 1796–1821)

```
fn request_user_input_response_from_elicitation_content(
    content: Option<serde_json::Value>,
) -> Option<RequestUserInputResponse>
```

**Purpose**: Converts elicitation form content into the legacy `RequestUserInputResponse` shape so existing answer-parsing logic can be reused. It supports string and string-array answers per question.

**Data flow**: Accepts optional JSON `content`. `None` becomes an empty `RequestUserInputResponse`. Otherwise it requires an object, iterates entries, converts string values into one-element answer vectors and array values into vectors of string elements, skips unsupported value types, collects them into a `HashMap<String, RequestUserInputAnswer>`, and returns `Some(RequestUserInputResponse { answers })`.

**Call relations**: Used only by `parse_mcp_tool_approval_elicitation_response` to reuse `parse_mcp_tool_approval_response`.

*Call graph*: called by 1 (parse_mcp_tool_approval_elicitation_response); 1 external calls (new).


##### `parse_mcp_tool_approval_response`  (lines 1823–1860)

```
fn parse_mcp_tool_approval_response(
    response: Option<RequestUserInputResponse>,
    question_id: &str,
) -> McpToolApprovalDecision
```

**Purpose**: Interprets a legacy `RequestUserInputResponse` for an MCP approval question and maps it to an internal approval decision. It recognizes synthetic decline, session remember, persistent remember, plain allow, and cancel.

**Data flow**: Inputs are optional `RequestUserInputResponse` and `question_id`. Missing response, missing question entry, or no recognized answer yields `Cancel`. Otherwise it inspects the answer strings in priority order: synthetic decline token, `Allow for this session`, `Allow and don't ask me again`, `Allow`, else `Cancel`.

**Call relations**: Called directly by `maybe_request_mcp_tool_approval` for legacy prompts and indirectly by `parse_mcp_tool_approval_elicitation_response` for elicitation content fallback.

*Call graph*: called by 2 (maybe_request_mcp_tool_approval, parse_mcp_tool_approval_elicitation_response).


##### `normalize_approval_decision_for_mode`  (lines 1862–1876)

```
fn normalize_approval_decision_for_mode(
    decision: McpToolApprovalDecision,
    approval_mode: AppToolApproval,
) -> McpToolApprovalDecision
```

**Purpose**: Downgrades remembered-approval decisions to plain accept when the tool’s approval mode is `Prompt`, where persistence should not be honored. It enforces approval-mode semantics after parsing.

**Data flow**: Accepts an `McpToolApprovalDecision` and `approval_mode`. If mode is `AppToolApproval::Prompt` and the decision is `AcceptForSession` or `AcceptAndRemember`, it returns `Accept`; otherwise it returns the original decision.

**Call relations**: Applied by `maybe_request_mcp_tool_approval` after parsing either elicitation or legacy prompt responses and before persistence side effects are applied.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 1 external calls (matches!).


##### `mcp_tool_approval_is_remembered`  (lines 1878–1881)

```
async fn mcp_tool_approval_is_remembered(sess: &Session, key: &McpToolApprovalKey) -> bool
```

**Purpose**: Checks whether a session-scoped approval key has already been remembered as approved for this session. It is the in-memory approval cache lookup.

**Data flow**: Takes `Session` and `McpToolApprovalKey`, locks `sess.services.tool_approvals`, and returns `true` only when the stored decision for that key is `ReviewDecision::ApprovedForSession`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` before prompting so repeated calls can auto-accept within the session.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 1 external calls (matches!).


##### `remember_mcp_tool_approval`  (lines 1883–1886)

```
async fn remember_mcp_tool_approval(sess: &Session, key: McpToolApprovalKey)
```

**Purpose**: Stores a session-scoped remembered approval in the in-memory approval cache. It records the decision as approved-for-session.

**Data flow**: Accepts `Session` and an `McpToolApprovalKey`, locks `sess.services.tool_approvals`, and inserts `ReviewDecision::ApprovedForSession` for that key.

**Call relations**: Used by `apply_mcp_tool_approval_decision` and as a fallback in `maybe_persist_mcp_tool_approval` when persistence fails or is unavailable.

*Call graph*: called by 2 (apply_mcp_tool_approval_decision, maybe_persist_mcp_tool_approval).


##### `apply_mcp_tool_approval_decision`  (lines 1888–1912)

```
async fn apply_mcp_tool_approval_decision(
    sess: &Session,
    turn_context: &TurnContext,
    decision: &McpToolApprovalDecision,
    session_approval_key: Option<McpToolApprovalKey>,
    persist
```

**Purpose**: Applies the side effects of an approval decision, such as remembering it for the session or persisting it to config. Non-accepting decisions have no side effects.

**Data flow**: Inputs are `Session`, `TurnContext`, a decision reference, and optional session/persistent approval keys. `AcceptForSession` remembers the session key if present. `AcceptAndRemember` prefers persistent storage via `maybe_persist_mcp_tool_approval` when a persistent key exists, otherwise falls back to remembering the session key. Plain `Accept`, `Decline`, and `Cancel` do nothing.

**Call relations**: Called by `maybe_request_mcp_tool_approval` after guardian, elicitation, or legacy prompt decisions are obtained.

*Call graph*: calls 2 internal fn (maybe_persist_mcp_tool_approval, remember_mcp_tool_approval); called by 1 (maybe_request_mcp_tool_approval).


##### `maybe_persist_mcp_tool_approval`  (lines 1914–1944)

```
async fn maybe_persist_mcp_tool_approval(
    sess: &Session,
    turn_context: &TurnContext,
    key: McpToolApprovalKey,
)
```

**Purpose**: Attempts to persist an approval decision into config for future runs, then reloads user config and remembers the approval for the current session. On failure it logs and falls back to session-only memory.

**Data flow**: Accepts `Session`, `TurnContext`, and an approval `key`. It branches by server type: Codex Apps approvals persist via `persist_codex_app_tool_approval` using connector ID, while other servers use `persist_non_app_mcp_tool_approval`. If persistence fails it logs an error and remembers the approval only in-session. On success it reloads the user config layer and then remembers the approval in-session as well.

**Call relations**: Called only by `apply_mcp_tool_approval_decision` for `AcceptAndRemember`. It delegates actual config edits to the persistence helpers below.

*Call graph*: calls 3 internal fn (persist_codex_app_tool_approval, persist_non_app_mcp_tool_approval, remember_mcp_tool_approval); called by 1 (apply_mcp_tool_approval_decision); 2 external calls (reload_user_config_layer, error!).


##### `persist_codex_app_tool_approval`  (lines 1946–1964)

```
async fn persist_codex_app_tool_approval(
    config: &Config,
    connector_id: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: Writes a persistent approval for a Codex Apps connector tool into config under the `apps.<connector>.tools.<tool>.approval_mode` path. It stores the mode as `approve`.

**Data flow**: Takes `config`, `connector_id`, and `tool_name`, builds a `ConfigEditsBuilder::for_config(config)` edit setting the nested path to `value("approve")`, applies it asynchronously, and returns `anyhow::Result<()>`.

**Call relations**: Used by `maybe_persist_mcp_tool_approval` for Codex Apps approvals.

*Call graph*: called by 1 (maybe_persist_mcp_tool_approval); 3 external calls (for_config, value, vec!).


##### `persist_custom_mcp_tool_approval`  (lines 1967–1978)

```
async fn persist_custom_mcp_tool_approval(
    config: &Config,
    server: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: Test-only helper that persists approval for a custom MCP server using the same config-location resolution as production code. It errors if the server is not configured.

**Data flow**: Accepts `config`, `server`, and `tool_name`, resolves an optional builder with `custom_mcp_tool_approval_config_builder`, bails if absent, and otherwise delegates to `persist_custom_mcp_tool_approval_with`.

**Call relations**: Compiled only in tests and used by test code to exercise persistence behavior without going through the full approval flow.

*Call graph*: calls 2 internal fn (custom_mcp_tool_approval_config_builder, persist_custom_mcp_tool_approval_with); 1 external calls (bail!).


##### `persist_non_app_mcp_tool_approval`  (lines 1980–2021)

```
async fn persist_non_app_mcp_tool_approval(
    sess: &Session,
    config: &Config,
    server: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: Persists approval for a non-Codex-Apps MCP tool either into project/user MCP config or into the owning plugin’s config section. It errors when the server cannot be located in either place.

**Data flow**: Inputs are `Session`, `config`, `server`, and `tool_name`. It first asks `custom_mcp_tool_approval_config_builder` for a project/user config builder and, if present, delegates to `persist_custom_mcp_tool_approval_with`. Otherwise it loads active plugins for the current config input, finds one whose `mcp_servers` contains the server, and if found applies a config edit under `plugins.<plugin_config_name>.mcp_servers.<server>.tools.<tool>.approval_mode = "approve"`. If neither path exists it returns an error.

**Call relations**: Called by `maybe_persist_mcp_tool_approval` for non-app servers. It relies on config-location helpers and plugin discovery to choose the correct persistence target.

*Call graph*: calls 2 internal fn (custom_mcp_tool_approval_config_builder, persist_custom_mcp_tool_approval_with); called by 1 (maybe_persist_mcp_tool_approval); 5 external calls (bail!, plugins_config_input, for_config, value, vec!).


##### `custom_mcp_tool_approval_config_builder`  (lines 2023–2033)

```
fn custom_mcp_tool_approval_config_builder(
    config: &Config,
    server: &str,
) -> anyhow::Result<Option<ConfigEditsBuilder>>
```

**Purpose**: Chooses the config file location where a custom MCP server approval should be persisted, preferring project config over user config. It returns no builder when the server is not configured in either place.

**Data flow**: Accepts `config` and `server`. If `project_mcp_tool_approval_config_folder(config, server)` returns a folder, it returns `Some(ConfigEditsBuilder::new(&folder))`. Otherwise it checks `user_mcp_server_is_configured(config, server)?` and returns `Some(ConfigEditsBuilder::for_config(config))` only when true.

**Call relations**: Used by both `persist_custom_mcp_tool_approval` and `persist_non_app_mcp_tool_approval` to resolve where edits should be written.

*Call graph*: calls 3 internal fn (new, project_mcp_tool_approval_config_folder, user_mcp_server_is_configured); called by 2 (persist_custom_mcp_tool_approval, persist_non_app_mcp_tool_approval).


##### `persist_custom_mcp_tool_approval_with`  (lines 2035–2053)

```
async fn persist_custom_mcp_tool_approval_with(
    config_edits_builder: ConfigEditsBuilder,
    server: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: Applies the actual config edit that marks a custom MCP tool as approved. It writes under the standard `mcp_servers.<server>.tools.<tool>.approval_mode` path.

**Data flow**: Takes a `ConfigEditsBuilder`, `server`, and `tool_name`, adds a single `ConfigEdit::SetPath` setting the nested approval mode to `value("approve")`, applies it asynchronously, and returns `anyhow::Result<()>`.

**Call relations**: Called by both custom-server persistence helpers once the correct config builder has been chosen.

*Call graph*: called by 2 (persist_custom_mcp_tool_approval, persist_non_app_mcp_tool_approval); 3 external calls (with_edits, value, vec!).


##### `user_mcp_server_is_configured`  (lines 2055–2068)

```
fn user_mcp_server_is_configured(config: &Config, server: &str) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a named MCP server exists in the effective user config layer. It is used to decide whether user config is a valid persistence target.

**Data flow**: Accepts `config` and `server`, extracts the `mcp_servers` table from `effective_user_config`, deserializes it into `HashMap<String, codex_config::types::McpServerConfig>`, and returns whether the map contains the server name. Missing `mcp_servers` yields `Ok(false)`.

**Call relations**: Called by `custom_mcp_tool_approval_config_builder` when no project config layer contains the server.

*Call graph*: called by 1 (custom_mcp_tool_approval_config_builder); 1 external calls (deserialize).


##### `project_mcp_tool_approval_config_folder`  (lines 2070–2097)

```
fn project_mcp_tool_approval_config_folder(
    config: &Config,
    server: &str,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the highest-priority project config layer that defines the named MCP server and returns that layer’s config folder. It lets persistent approvals be written back to the project that owns the server definition.

**Data flow**: Accepts `config` and `server`, iterates `config.config_layer_stack.layers_high_to_low()`, keeps only `ConfigLayerSource::Project` layers, attempts to deserialize each layer’s `mcp_servers` table, and returns `layer.config_folder()` for the first layer whose server map contains the target server.

**Call relations**: Used by `custom_mcp_tool_approval_config_builder` to prefer project-local persistence over user-global persistence.

*Call graph*: called by 1 (custom_mcp_tool_approval_config_builder).


##### `requires_mcp_tool_approval`  (lines 2099–2116)

```
fn requires_mcp_tool_approval(annotations: Option<&ToolAnnotations>) -> bool
```

**Purpose**: Determines whether tool annotations imply that approval is required by default. Destructive or open-world tools require approval; explicitly read-only tools do not.

**Data flow**: Accepts optional `ToolAnnotations`. If `destructive_hint == Some(true)`, returns `true`. Otherwise if `read_only_hint` is true, returns `false`. In all other cases it returns `destructive_hint.unwrap_or(true) || open_world_hint.unwrap_or(true)`.

**Call relations**: Called by `maybe_request_mcp_tool_approval` before prompting logic. It combines annotation hints into the baseline approval requirement.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval).


##### `notify_mcp_tool_call_skip`  (lines 2118–2149)

```
async fn notify_mcp_tool_call_skip(
    sess: &Session,
    turn_context: &TurnContext,
    call_id: &str,
    invocation: McpInvocation,
    item_metadata: McpToolCallItemMetadata,
    message: Strin
```

**Purpose**: Emits the correct started/completed event sequence for a tool call that is blocked, declined, or cancelled, and returns the skip reason as an error result. It keeps skipped calls visible in turn history.

**Data flow**: Inputs are `Session`, `TurnContext`, `call_id`, `McpInvocation`, item metadata, skip `message`, and `already_started`. If the call was not already started it emits a started event. It then emits a completed event with zero duration and a truncated event-safe error result via `truncate_mcp_tool_result_for_event(&Err(message.clone()))`, and finally returns `Err(message)`.

**Call relations**: Called by `handle_mcp_tool_call` for app-policy blocks and for decline/cancel approval outcomes. It delegates event emission to the notify helpers and truncation to `truncate_mcp_tool_result_for_event`.

*Call graph*: calls 3 internal fn (notify_mcp_tool_call_completed, notify_mcp_tool_call_started, truncate_mcp_tool_result_for_event); called by 1 (handle_mcp_tool_call); 2 external calls (clone, clone).


### `core/src/mcp_openai_file.rs`

`domain_logic` · `MCP tool execution`

This module is narrowly focused on execution-time argument rewriting for MCP tools that declare OpenAI file inputs. The top-level `rewrite_mcp_tool_arguments_for_openai_files` is intentionally conservative: if no file-param declaration exists, if arguments are absent, or if the arguments payload is not a JSON object, it returns the original value unchanged. When declarations are present, it clones the argument object, fetches the current auth from the session, and rewrites only the named fields.

`rewrite_argument_value_for_openai_files` supports exactly two shapes for a declared field: a single string path or an array of string paths. Any other shape, or any mixed-type array, yields `Ok(None)` so the caller leaves that field untouched rather than partially rewriting it. Actual upload work happens in `build_uploaded_argument_value`. That function enforces several invariants before any upload: ChatGPT/Codex-backed auth must exist, a primary turn environment must be available, the environment cwd must resolve to an absolute native path, the target path must exist and be a file, and its size must not exceed `OPENAI_FILE_UPLOAD_LIMIT_BYTES`. It reads metadata first so oversized files are rejected before streaming contents. Successful uploads return the downstream Apps-compatible JSON object containing `download_url`, `file_id`, `mime_type`, `file_name`, `uri`, and `file_size_bytes`.

The tests use a temporary environment cwd plus `wiremock` to verify scalar and array rewrites, upload request shapes, oversized-file rejection, no-op behavior when declarations are absent, and surfaced error messages for missing files.

#### Function details

##### `rewrite_mcp_tool_arguments_for_openai_files`  (lines 22–59)

```
async fn rewrite_mcp_tool_arguments_for_openai_files(
    sess: &Session,
    turn_context: &TurnContext,
    arguments_value: Option<JsonValue>,
    openai_file_input_params: Option<&[String]>,
) ->
```

**Purpose**: Rewrites only the declared MCP tool argument fields that represent file inputs, uploading referenced files and replacing those fields with provided-file payloads. It preserves the original arguments when no rewrite is needed or possible.

**Data flow**: Accepts a `Session`, `TurnContext`, optional JSON arguments, and optional slice of declared file-input field names. If declarations are absent it returns the original `arguments_value`; if arguments are absent it returns `Ok(None)`; if arguments are not a JSON object it returns them unchanged. Otherwise it fetches auth from `sess.services.auth_manager`, clones the argument map, iterates declared field names, calls `rewrite_argument_value_for_openai_files` for each present field, inserts any rewritten values, and returns either the original JSON or a new `JsonValue::Object`.

**Call relations**: Called from MCP tool execution in `handle_approved_mcp_tool_call`, and directly by tests. It delegates per-field logic to `rewrite_argument_value_for_openai_files` and only performs object-level orchestration.

*Call graph*: calls 1 internal fn (rewrite_argument_value_for_openai_files); called by 3 (openai_file_argument_rewrite_requires_declared_file_params, rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures, handle_approved_mcp_tool_call); 1 external calls (Object).


##### `rewrite_argument_value_for_openai_files`  (lines 61–99)

```
async fn rewrite_argument_value_for_openai_files(
    turn_context: &TurnContext,
    auth: Option<&CodexAuth>,
    field_name: &str,
    value: &JsonValue,
) -> Result<Option<JsonValue>, String>
```

**Purpose**: Rewrites one declared argument value if it is a string path or an array of string paths. Unsupported shapes are treated as non-rewritable rather than hard errors.

**Data flow**: Takes `turn_context`, optional `CodexAuth`, the `field_name`, and a JSON `value`. For `JsonValue::String`, it uploads one file via `build_uploaded_argument_value` and wraps the result in `Some`. For `JsonValue::Array`, it allocates a result vector, requires every element to be a string path, uploads each with its array index for contextualized errors, and returns `Some(JsonValue::Array(...))`. For any other JSON type it returns `Ok(None)`.

**Call relations**: Invoked by the top-level rewrite function for each declared field, and directly by scalar/array rewrite tests. It delegates all filesystem and upload work to `build_uploaded_argument_value`.

*Call graph*: calls 1 internal fn (build_uploaded_argument_value); called by 3 (rewrite_mcp_tool_arguments_for_openai_files, rewrite_argument_value_for_openai_files_rewrites_array_paths, rewrite_argument_value_for_openai_files_rewrites_scalar_path); 2 external calls (Array, with_capacity).


##### `build_uploaded_argument_value`  (lines 101–179)

```
async fn build_uploaded_argument_value(
    turn_context: &TurnContext,
    auth: Option<&CodexAuth>,
    field_name: &str,
    index: Option<usize>,
    file_path: &str,
) -> Result<JsonValue, String
```

**Purpose**: Reads a file from the primary turn environment, uploads it to OpenAI file storage, and returns the Apps-compatible JSON descriptor for that uploaded file. It also produces contextualized, field-specific error messages.

**Data flow**: Inputs are `turn_context`, optional auth, `field_name`, optional array `index`, and `file_path`. It first builds an error-context closure, then rejects missing auth or non-Codex-backed auth. It fetches the primary turn environment, resolves the environment cwd to an absolute native path, joins the relative or provided file path, converts it to `PathUri`, obtains filesystem metadata, rejects non-files and files larger than `OPENAI_FILE_UPLOAD_LIMIT_BYTES`, opens a read stream, derives a filename from the resolved path, converts auth with `auth_provider_from_auth`, and calls `upload_openai_file` using the trimmed `chatgpt_base_url`. On success it returns a JSON object with `download_url`, `file_id`, `mime_type`, `file_name`, `uri`, and `file_size_bytes`.

**Call relations**: This is the heavy-lifting helper used by `rewrite_argument_value_for_openai_files` and exercised directly by upload and oversized-file tests. It bridges turn-environment filesystem access to the external OpenAI upload API.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (rewrite_argument_value_for_openai_files, build_uploaded_argument_value_rejects_oversized_file_before_reading, build_uploaded_argument_value_uploads_environment_file); 4 external calls (upload_openai_file, auth_provider_from_auth, format!, json!).


##### `tests::set_primary_environment_cwd`  (lines 193–207)

```
fn set_primary_environment_cwd(turn_context: &mut TurnContext, cwd: &Path)
```

**Purpose**: Replaces the primary turn environment’s cwd with a supplied absolute path so tests can resolve relative file arguments against a temporary directory. It also disables the permission profile for the test context.

**Data flow**: Accepts mutable `TurnContext` and `cwd: &Path`, converts the path to `AbsolutePathBuf`, sets `turn_context.permission_profile` to `PermissionProfile::Disabled`, grabs the first mutable turn environment, and overwrites it with a new `TurnEnvironment` preserving environment ID, environment handle, and shell while swapping in `PathUri::from_abs_path(&cwd)`.

**Call relations**: Used by the upload-related tests before calling the rewrite helpers. It prepares the test `TurnContext` so file lookups happen in the temporary directory created by each test.

*Call graph*: calls 3 internal fn (new, try_from, from_abs_path); 1 external calls (clone).


##### `tests::openai_file_argument_rewrite_requires_declared_file_params`  (lines 210–226)

```
async fn openai_file_argument_rewrite_requires_declared_file_params()
```

**Purpose**: Verifies that the top-level rewrite function is a no-op when no `openai/fileParams` declaration is provided. This protects ordinary MCP arguments from accidental rewriting.

**Data flow**: Creates a session and turn context, builds an arguments object containing a `file` path, calls `rewrite_mcp_tool_arguments_for_openai_files` with `openai_file_input_params` set to `None`, awaits success, and asserts the returned JSON equals the original arguments.

**Call relations**: Directly exercises the early-return branch in `rewrite_mcp_tool_arguments_for_openai_files`. It confirms the declaration gate is mandatory before any upload logic runs.

*Call graph*: calls 2 internal fn (rewrite_mcp_tool_arguments_for_openai_files, make_session_and_context); 3 external calls (new, assert_eq!, json!).


##### `tests::build_uploaded_argument_value_uploads_environment_file`  (lines 229–307)

```
async fn build_uploaded_argument_value_uploads_environment_file()
```

**Purpose**: Checks the full happy path for reading a local environment file and uploading it through the OpenAI file API. It validates both outbound HTTP interactions and the returned rewritten JSON payload.

**Data flow**: Starts a `wiremock::MockServer`, installs mocks for file creation, upload PUT, and upload completion endpoints, creates a session/turn context plus dummy ChatGPT auth, writes `file_report.csv` into a temp directory, points the primary environment cwd there, rewrites `chatgpt_base_url` to the mock server, then calls `build_uploaded_argument_value`. It asserts the returned JSON contains the expected download URL, file ID, MIME type, file name, sediment URI, and byte size.

**Call relations**: Invokes `build_uploaded_argument_value` directly to test the end-to-end upload path. The mock server stands in for the external API that the production helper delegates to via `upload_openai_file`.

*Call graph*: calls 3 internal fn (build_uploaded_argument_value, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, given, start, new, assert_eq!, set_primary_environment_cwd, format!, json!, tempdir, write).


##### `tests::build_uploaded_argument_value_rejects_oversized_file_before_reading`  (lines 310–332)

```
async fn build_uploaded_argument_value_rejects_oversized_file_before_reading()
```

**Purpose**: Ensures oversized files are rejected based on metadata before any content streaming or upload attempt occurs. It verifies the error message includes the size information.

**Data flow**: Creates a session/turn context and dummy auth, creates a sparse file larger than `OPENAI_FILE_UPLOAD_LIMIT_BYTES`, sets the primary environment cwd to the temp directory, calls `build_uploaded_argument_value`, expects an error, and asserts the error text mentions that the file is too large and includes the oversized byte count.

**Call relations**: Targets the size-check branch inside `build_uploaded_argument_value`. It demonstrates the function’s design choice to inspect metadata first and fail early.

*Call graph*: calls 3 internal fn (build_uploaded_argument_value, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, set_primary_environment_cwd, create, tempdir).


##### `tests::rewrite_argument_value_for_openai_files_rewrites_scalar_path`  (lines 335–411)

```
async fn rewrite_argument_value_for_openai_files_rewrites_scalar_path()
```

**Purpose**: Verifies that a single string file path is rewritten into one uploaded-file descriptor. It covers the scalar branch of the per-field rewrite helper.

**Data flow**: Sets up the same mock upload sequence as the direct upload test, creates a temp file and environment cwd, rewrites `chatgpt_base_url`, then calls `rewrite_argument_value_for_openai_files` with `field_name = "file"` and a JSON string path. It asserts the result is `Some(...)` containing the expected uploaded-file JSON object.

**Call relations**: Calls `rewrite_argument_value_for_openai_files` directly rather than the top-level object rewriter. It validates that the helper delegates correctly to `build_uploaded_argument_value` for scalar values.

*Call graph*: calls 3 internal fn (rewrite_argument_value_for_openai_files, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, given, start, new, assert_eq!, set_primary_environment_cwd, format!, json!, tempdir, write).


##### `tests::rewrite_argument_value_for_openai_files_rewrites_array_paths`  (lines 414–535)

```
async fn rewrite_argument_value_for_openai_files_rewrites_array_paths()
```

**Purpose**: Verifies that an array of string file paths is rewritten element-by-element into an array of uploaded-file descriptors. It covers indexed error context and repeated uploads.

**Data flow**: Creates a mock server with separate mocked create/upload/complete flows for `one.csv` and `two.csv`, writes both files into a temp directory, sets the primary environment cwd, rewrites `chatgpt_base_url`, then calls `rewrite_argument_value_for_openai_files` with `field_name = "files"` and a JSON array of two paths. It asserts the result is `Some(JsonValue::Array(...))` containing two uploaded-file descriptor objects in order.

**Call relations**: Exercises the array branch of `rewrite_argument_value_for_openai_files`. It indirectly validates repeated calls to `build_uploaded_argument_value` and preservation of array ordering.

*Call graph*: calls 3 internal fn (rewrite_argument_value_for_openai_files, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, given, start, new, assert_eq!, set_primary_environment_cwd, format!, json!, tempdir, write).


##### `tests::rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures`  (lines 538–556)

```
async fn rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures()
```

**Purpose**: Checks that the top-level rewrite function propagates upload failures instead of silently swallowing them when a declared file field cannot be processed. It ensures callers receive actionable context.

**Data flow**: Creates a session and turn context, injects dummy ChatGPT auth into the session’s auth manager, calls `rewrite_mcp_tool_arguments_for_openai_files` with an arguments object pointing to a definitely missing file and a declaration naming the `file` field, expects an error, and asserts the message contains both `failed to upload` and the field name.

**Call relations**: This test covers the error-propagation path from `build_uploaded_argument_value` through `rewrite_argument_value_for_openai_files` up to the top-level object rewrite function.

*Call graph*: calls 4 internal fn (rewrite_mcp_tool_arguments_for_openai_files, make_session_and_context, auth_manager_from_auth, create_dummy_chatgpt_auth_for_testing); 2 external calls (assert!, json!).


### Resource tool handlers
These files define the MCP resource tool specs, shared helper layer, and the concrete list/read handlers that call through the MCP resource path.

### `core/src/tools/handlers/mcp_resource_spec.rs`

`config` · `tool registration`

This file contains three pure constructor functions that build `codex_tools::ToolSpec::Function` values for MCP resource operations. Each function assembles a `BTreeMap<String, JsonSchema>` of parameter definitions, using `JsonSchema::string` with human-readable descriptions that explain how the model should supply each field.

`create_list_mcp_resources_tool` and `create_list_mcp_resource_templates_tool` both define two optional string properties: `server`, which scopes the request to one MCP server when present, and `cursor`, which carries opaque pagination state from a previous call. Both mark `strict: false`, omit `defer_loading`, use `JsonSchema::object(..., None, Some(false.into()))` so no fields are required and additional properties are disallowed, and leave `output_schema` unset.

`create_read_mcp_resource_tool` differs in two important ways: it defines `server` and `uri` as required fields by passing `Some(vec![...])` to `JsonSchema::object`, and its field descriptions explicitly tie valid values back to `list_mcp_resources` output. Across all three builders, the descriptions are intentionally rich and model-facing, emphasizing MCP resources as preferred context sources over web search. Because handlers call these functions directly from their `spec()` methods, any change here immediately changes the tool contract presented to the model.

#### Function details

##### `create_list_mcp_resources_tool`  (lines 6–31)

```
fn create_list_mcp_resources_tool() -> ToolSpec
```

**Purpose**: Builds the `ToolSpec` for the `list_mcp_resources` function tool, including its optional `server` and `cursor` parameters and descriptive guidance.

**Data flow**: It creates a `BTreeMap` with two string-schema entries, wraps that map in `JsonSchema::object` with no required fields and `additionalProperties` disabled, then embeds the schema and fixed metadata into a `ResponsesApiTool` and returns `ToolSpec::Function(...)`. It reads no external state and writes nothing.

**Call relations**: This builder is called by the `spec` method of `ListMcpResourcesHandler`. It does not invoke runtime logic; its role is to provide the declarative contract consumed during tool publication.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 2 external calls (from, Function).


##### `create_list_mcp_resource_templates_tool`  (lines 33–59)

```
fn create_list_mcp_resource_templates_tool() -> ToolSpec
```

**Purpose**: Builds the `ToolSpec` for the `list_mcp_resource_templates` function tool with optional `server` and `cursor` arguments.

**Data flow**: It constructs a `BTreeMap` of parameter schemas, creates an object schema with no required fields and no extra properties, packages that into a `ResponsesApiTool` with the fixed tool name and long-form description, and returns it as `ToolSpec::Function`. No mutable state is touched.

**Call relations**: Used by `ListMcpResourceTemplatesHandler::spec` to expose the tool interface. It is a pure schema factory and does not participate in request execution.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 2 external calls (from, Function).


##### `create_read_mcp_resource_tool`  (lines 61–93)

```
fn create_read_mcp_resource_tool() -> ToolSpec
```

**Purpose**: Builds the `ToolSpec` for reading a specific MCP resource, requiring both the server name and resource URI.

**Data flow**: It creates a `BTreeMap` for `server` and `uri`, then calls `JsonSchema::object` with an explicit required-field vector containing both names and `additionalProperties` disabled. That schema is inserted into a `ResponsesApiTool` with fixed metadata and returned as `ToolSpec::Function`.

**Call relations**: Called by `ReadMcpResourceHandler::spec`. Its required-field configuration is what makes the read tool stricter than the list tools at the schema level.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


### `core/src/tools/handlers/mcp_resource.rs`

`util` · `request handling`

This file is the support layer behind the MCP resource handlers re-exported from its submodules. It defines deserializable argument structs for listing resources (`ListResourcesArgs`), listing templates (`ListResourceTemplatesArgs`), and reading a resource (`ReadResourceArgs`). Optional `server` and `cursor` fields default to `None`, allowing empty argument payloads to mean "all servers" or "first page".

For output shaping, `ResourceWithServer` and `ResourceTemplateWithServer` flatten `rmcp::model::Resource` and `ResourceTemplate` while adding an explicit `server` field. `ListResourcesPayload` and `ListResourceTemplatesPayload` each support two construction modes: `from_single_server`, which preserves the server name and `next_cursor` from the MCP result, and `from_all_servers`, which accepts a `HashMap` keyed by server, sorts entries by server name for deterministic output, flattens all resources/templates into one vector, and clears pagination because cross-server aggregation cannot expose a single cursor. `ReadResourcePayload` similarly flattens `ReadResourceResult` alongside `server` and `uri`.

The file also standardizes MCP-style turn-item publication. `emit_tool_call_begin` emits an in-progress `TurnItem::McpToolCall`; `emit_tool_call_end` converts either a successful `CallToolResult` or an error string into a completed/failed `McpToolCallItem`, treating `CallToolResult.is_error == true` as failure even when transport succeeded. `serialize_function_output` JSON-serializes any `Serialize` payload, truncates it with `truncate_text` using the turn's `TruncationPolicy * 1.2`, and wraps it as `FunctionToolOutput`. Parsing helpers distinguish empty/null arguments from real JSON values and provide both strict (`parse_args`) and defaulting (`parse_args_with_default`) deserialization paths. String normalizers trim whitespace and turn blank required fields into `RespondToModel` errors.

#### Function details

##### `ResourceWithServer::new`  (lines 68–70)

```
fn new(server: String, resource: Resource) -> Self
```

**Purpose**: Constructs a serializable resource wrapper that records which MCP server supplied the resource.

**Data flow**: Takes ownership of a `server: String` and `resource: Resource`, stores them in `ResourceWithServer`, and returns the wrapper.

**Call relations**: It is used when building aggregated or single-server list payloads so each serialized resource carries its origin server.

*Call graph*: called by 2 (from_all_servers, resource_with_server_serializes_server_field).


##### `ResourceTemplateWithServer::new`  (lines 81–83)

```
fn new(server: String, template: ResourceTemplate) -> Self
```

**Purpose**: Constructs a serializable resource-template wrapper that records the source MCP server.

**Data flow**: Takes `server: String` and `template: ResourceTemplate`, stores them in `ResourceTemplateWithServer`, and returns the wrapper.

**Call relations**: It is used by the resource-template payload builders to annotate each template with its server.

*Call graph*: called by 2 (from_all_servers, template_with_server_serializes_server_field).


##### `ListResourcesPayload::from_single_server`  (lines 97–108)

```
fn from_single_server(server: String, result: ListResourcesResult) -> Self
```

**Purpose**: Builds the list-resources response payload for a request scoped to one server, preserving pagination.

**Data flow**: Consumes a `server: String` and `ListResourcesResult`, maps each `result.resources` entry into `ResourceWithServer::new(server.clone(), resource)`, collects them, and returns `ListResourcesPayload { server: Some(server), resources, next_cursor: result.next_cursor }`.

**Call relations**: Single-server list handlers call this when the request names a specific server and the MCP result's cursor can be forwarded directly.

*Call graph*: called by 2 (handle_call, list_resources_payload_from_single_server_copies_next_cursor).


##### `ListResourcesPayload::from_all_servers`  (lines 110–126)

```
fn from_all_servers(resources_by_server: HashMap<String, Vec<Resource>>) -> Self
```

**Purpose**: Builds a deterministic cross-server list-resources payload by flattening resources from multiple servers.

**Data flow**: Consumes `HashMap<String, Vec<Resource>>`, converts it into a vector of `(server, resources)` pairs, sorts that vector by server name, then iterates through each server and each resource to push `ResourceWithServer::new(server.clone(), resource)` into one flat `resources` vector. Returns `ListResourcesPayload { server: None, resources, next_cursor: None }`.

**Call relations**: Handlers use this branch when listing across all servers. It intentionally drops pagination because there is no single combined cursor across multiple MCP backends.

*Call graph*: calls 1 internal fn (new); called by 2 (handle_call, list_resources_payload_from_all_servers_is_sorted); 1 external calls (new).


##### `ListResourceTemplatesPayload::from_single_server`  (lines 140–151)

```
fn from_single_server(server: String, result: ListResourceTemplatesResult) -> Self
```

**Purpose**: Builds the list-resource-templates response payload for one server while preserving the server cursor.

**Data flow**: Consumes a `server: String` and `ListResourceTemplatesResult`, maps each template into `ResourceTemplateWithServer::new(server.clone(), template)`, collects them, and returns `ListResourceTemplatesPayload { server: Some(server), resource_templates, next_cursor: result.next_cursor }`.

**Call relations**: Resource-template handlers call this when the request is scoped to a single server.

*Call graph*: called by 1 (handle_call).


##### `ListResourceTemplatesPayload::from_all_servers`  (lines 153–170)

```
fn from_all_servers(templates_by_server: HashMap<String, Vec<ResourceTemplate>>) -> Self
```

**Purpose**: Builds a deterministic cross-server resource-template payload by flattening templates from all servers.

**Data flow**: Consumes `HashMap<String, Vec<ResourceTemplate>>`, converts it to a vector of entries, sorts by server name, flattens each template into `ResourceTemplateWithServer::new(server.clone(), template)`, and returns `ListResourceTemplatesPayload { server: None, resource_templates, next_cursor: None }`.

**Call relations**: Handlers use this when aggregating templates across all MCP servers, again intentionally omitting pagination.

*Call graph*: calls 1 internal fn (new); called by 1 (handle_call); 1 external calls (new).


##### `call_tool_result_from_content`  (lines 181–188)

```
fn call_tool_result_from_content(content: &str, success: Option<bool>) -> CallToolResult
```

**Purpose**: Wraps plain text content into the MCP `CallToolResult` shape expected by MCP tool-call turn items.

**Data flow**: Takes `content: &str` and `success: Option<bool>`, constructs `CallToolResult` with one text content item, `structured_content: None`, `is_error` set to the negation of `success` when provided, and `meta: None`, then returns it.

**Call relations**: This helper is used by MCP resource handlers when they need to publish a textual result through the same turn-item structure as ordinary MCP tool calls.

*Call graph*: 1 external calls (vec!).


##### `emit_tool_call_begin`  (lines 190–214)

```
async fn emit_tool_call_begin(
    session: &Arc<Session>,
    turn: &TurnContext,
    call_id: &str,
    invocation: McpInvocation,
)
```

**Purpose**: Publishes an in-progress `McpToolCall` turn item for an MCP resource operation.

**Data flow**: Accepts `&Arc<Session>`, `&TurnContext`, `call_id`, and `McpInvocation { server, tool, arguments }`. It builds `TurnItem::McpToolCall(McpToolCallItem)` with the given identifiers, `arguments.unwrap_or(Value::Null)`, no app resource URI or plugin id, `status: InProgress`, and no result/error/duration, then awaits `session.emit_turn_item_started(turn, &item)`.

**Call relations**: Resource handlers call this before contacting MCP so the UI/event stream reflects that the operation has started.

*Call graph*: 1 external calls (McpToolCall).


##### `emit_tool_call_end`  (lines 216–253)

```
async fn emit_tool_call_end(
    session: &Arc<Session>,
    turn: &TurnContext,
    call_id: &str,
    invocation: McpInvocation,
    duration: Duration,
    result: Result<CallToolResult, String>,
)
```

**Purpose**: Publishes the completed or failed `McpToolCall` turn item for an MCP resource operation.

**Data flow**: Accepts session, turn, call id, invocation metadata, elapsed `Duration`, and `Result<CallToolResult, String>`. It maps `Ok(result)` with `result.is_error == true` to failed status with embedded result, plain `Ok(result)` to completed status, and `Err(message)` to failed status with `McpToolCallError { message }`. It then reconstructs a `TurnItem::McpToolCall(McpToolCallItem)` using invocation fields, `arguments.unwrap_or(Value::Null)`, the derived status/result/error, and `duration: Some(duration)`, and emits it with `session.emit_turn_item_completed`.

**Call relations**: Handlers call this after the MCP resource operation finishes so the event stream records both success and failure uniformly.

*Call graph*: 1 external calls (McpToolCall).


##### `normalize_optional_string`  (lines 255–264)

```
fn normalize_optional_string(input: Option<String>) -> Option<String>
```

**Purpose**: Trims an optional string and treats blank values as absent.

**Data flow**: Takes `Option<String>`, and for `Some(value)` trims whitespace into a new `String`; if the trimmed string is empty it returns `None`, otherwise `Some(trimmed)`. `None` stays `None`.

**Call relations**: This helper is used by `normalize_required_string` and can also support argument normalization in resource handlers.

*Call graph*: called by 1 (normalize_required_string).


##### `normalize_required_string`  (lines 266–273)

```
fn normalize_required_string(field: &str, value: String) -> Result<String, FunctionCallError>
```

**Purpose**: Validates that a required string field is present and nonblank after trimming.

**Data flow**: Accepts a field name and raw `String`, passes `Some(value)` into `normalize_optional_string`, and returns the trimmed string on success. If normalization yields `None`, it returns `FunctionCallError::RespondToModel(format!("{field} must be provided"))`.

**Call relations**: Resource handlers use this when required MCP arguments such as server or URI must not be empty.

*Call graph*: calls 1 internal fn (normalize_optional_string); 2 external calls (format!, RespondToModel).


##### `serialize_function_output`  (lines 275–292)

```
fn serialize_function_output(
    payload: T,
    truncation_policy: TruncationPolicy,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Serializes a structured payload into the bounded text form used for function-tool outputs in MCP resource handlers.

**Data flow**: Accepts any `payload: T` where `T: Serialize` and a `TruncationPolicy`. It serializes the payload with `serde_json::to_string`, mapping failures to `FunctionCallError::RespondToModel`, truncates the resulting string with `truncate_text(&content, truncation_policy * 1.2)`, wraps it in `FunctionToolOutput::from_text(content, Some(true))`, and returns that output.

**Call relations**: Resource handlers call this after building payload structs so their responses match the bounded text behavior of regular MCP tool outputs.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (truncate_text, to_string).


##### `parse_arguments`  (lines 294–307)

```
fn parse_arguments(raw_args: &str) -> Result<Option<Value>, FunctionCallError>
```

**Purpose**: Parses raw function-argument text into an optional JSON value, treating empty or explicit null as no arguments.

**Data flow**: Reads `raw_args: &str`; if trimming yields empty text it returns `Ok(None)`. Otherwise it parses JSON with `serde_json::from_str`, mapping parse errors to `FunctionCallError::RespondToModel`. If the parsed value is `Value::Null`, it returns `Ok(None)`; otherwise `Ok(Some(value))`.

**Call relations**: Resource handlers use this as the first stage of argument processing before deserializing into typed structs.

*Call graph*: 1 external calls (from_str).


##### `parse_args`  (lines 309–321)

```
fn parse_args(arguments: Option<Value>) -> Result<T, FunctionCallError>
```

**Purpose**: Deserializes a present JSON argument value into a typed argument struct and errors when no value is available.

**Data flow**: Accepts `Option<Value>` for some `T: DeserializeOwned`. If `Some(value)`, it calls `serde_json::from_value(value)` and maps failures to `FunctionCallError::RespondToModel`; if `None`, it returns `RespondToModel("failed to parse function arguments: expected value")`.

**Call relations**: This is the strict deserialization path and is also reused by `parse_args_with_default` when arguments are present.

*Call graph*: called by 1 (parse_args_with_default); 2 external calls (from_value, RespondToModel).


##### `parse_args_with_default`  (lines 323–331)

```
fn parse_args_with_default(arguments: Option<Value>) -> Result<T, FunctionCallError>
```

**Purpose**: Deserializes typed arguments when present, but falls back to `T::default()` when the call omitted arguments entirely.

**Data flow**: Accepts `Option<Value>` for `T: DeserializeOwned + Default`; if `Some(value)` it delegates to `parse_args(Some(value))`, otherwise it returns `Ok(T::default())`.

**Call relations**: Handlers use this for argument structs like list operations where an empty payload is valid and should mean default options.

*Call graph*: calls 1 internal fn (parse_args); 1 external calls (default).


### `core/src/tools/handlers/mcp_resource/list_mcp_resource_templates.rs`

`domain_logic` · `request handling`

This file defines `ListMcpResourceTemplatesHandler`, a `ToolExecutor<ToolInvocation>` for the `list_mcp_resource_templates` function tool. The lightweight trait methods expose the stable tool name, return the JSON-schema-backed `ToolSpec`, declare that calls may run in parallel, and forward execution into the async implementation.

The core logic lives in `handle_call`. It destructures `ToolInvocation` to obtain the session, turn metadata, call id, and payload, and immediately rejects any non-`ToolPayload::Function` payload with a model-facing `FunctionCallError`. It parses the raw JSON argument string twice: first into a generic JSON value via `parse_arguments`, then into `ListResourceTemplatesArgs` via `parse_args_with_default`, allowing omitted fields while still validating shape. Both `server` and `cursor` are normalized so empty strings become absent.

The handler constructs an `McpInvocation` record for begin/end event emission, defaulting the telemetry server name to `codex` when no specific server was requested. If a server is provided, it optionally builds `PaginatedRequestParams` with the cursor and calls `session.list_resource_templates`; the result is wrapped with `ListResourceTemplatesPayload::from_single_server`. Without a server, it forbids `cursor` entirely and instead queries `session.services.mcp_connection_manager.load_full().list_all_resource_templates()` and wraps the merged map with `from_all_servers`. Afterward it serializes the payload under the turn’s truncation policy, emits a success or failure end event including elapsed time and summarized content, and returns boxed tool output. A notable invariant is that pagination cursors are only meaningful for single-server listing, never for the all-servers aggregate path.

#### Function details

##### `ListMcpResourceTemplatesHandler::tool_name`  (lines 30–32)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the externally visible tool identifier `list_mcp_resource_templates`. This is the name used for registration and dispatch.

**Data flow**: It reads no mutable state and constructs a `ToolName` from the fixed string literal via `ToolName::plain`. It returns that `ToolName` without side effects.

**Call relations**: The runtime calls this as part of tool registration and lookup. It does not branch further; it only delegates to the `ToolName` constructor so the handler can be matched to incoming tool calls.

*Call graph*: calls 1 internal fn (plain).


##### `ListMcpResourceTemplatesHandler::spec`  (lines 34–36)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Supplies the schema and descriptive metadata for the tool. The returned spec tells the model which arguments are accepted and how the tool should be described.

**Data flow**: It takes no inputs beyond `&self`, reads no handler state, and returns the `ToolSpec` produced by `create_list_mcp_resource_templates_tool()`. No state is mutated.

**Call relations**: The tool registry invokes this when exposing tool capabilities. It delegates all schema construction to the shared spec builder in `mcp_resource_spec`, keeping the handler and schema definition synchronized.

*Call graph*: calls 1 internal fn (create_list_mcp_resource_templates_tool).


##### `ListMcpResourceTemplatesHandler::supports_parallel_tool_calls`  (lines 38–40)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that multiple invocations of this handler may execute concurrently. This reflects that listing MCP templates is treated as a read-only operation.

**Data flow**: It ignores inputs and returns the constant boolean `true`. It neither reads nor writes any external state.

**Call relations**: The runtime consults this before scheduling tool calls. There are no downstream calls; it is a pure capability flag used by orchestration code.


##### `ListMcpResourceTemplatesHandler::handle`  (lines 42–44)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation into the boxed future type required by the `ToolExecutor` trait. It is the trait entrypoint for actual execution.

**Data flow**: It receives a `ToolInvocation`, moves it into `self.handle_call(invocation)`, pins the resulting future with `Box::pin`, and returns that boxed future. It does not inspect or transform the invocation itself.

**Call relations**: The tool runtime calls this when dispatching a tool invocation. Its only job is to forward control into `ListMcpResourceTemplatesHandler::handle_call` in the trait-compatible form.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListMcpResourceTemplatesHandler::handle_call`  (lines 48–166)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Executes the full list-resource-templates operation: validate payload type, parse and normalize arguments, choose single-server versus all-server listing, emit MCP telemetry, serialize the result, and surface any errors in model-facing form.

**Data flow**: Input is a `ToolInvocation` containing `session`, `turn`, `call_id`, and `payload`. It extracts the raw function argument string, parses it into JSON and then `ListResourceTemplatesArgs`, normalizes optional `server` and `cursor`, and builds an `McpInvocation` record. It writes begin/end telemetry through `emit_tool_call_begin` and `emit_tool_call_end`, reads MCP data either from `session.list_resource_templates(server, params)` or from `session.services.mcp_connection_manager.load_full().list_all_resource_templates()`, transforms those results into `ListResourceTemplatesPayload`, serializes with `serialize_function_output`, converts serialized body items to plain text for telemetry with `function_call_output_content_items_to_text`, and returns either boxed tool output or a `FunctionCallError`. It also measures elapsed time with `Instant` for end-event reporting.

**Call relations**: This function is invoked only by `ListMcpResourceTemplatesHandler::handle`. On the single-server path it delegates to the session’s MCP list API and payload constructor `from_single_server`; on the aggregate path it delegates to the connection manager and `from_all_servers`. In both success and failure cases it funnels through end-event emission so telemetry is recorded regardless of outcome.

*Call graph*: calls 4 internal fn (boxed_tool_output, from_all_servers, from_single_server, function_call_output_content_items_to_text); called by 1 (handle); 10 external calls (now, clone, call_tool_result_from_content, emit_tool_call_begin, emit_tool_call_end, normalize_optional_string, parse_args_with_default, parse_arguments, serialize_function_output, RespondToModel).


### `core/src/tools/handlers/mcp_resource/list_mcp_resources.rs`

`domain_logic` · `request handling`

This file mirrors the resource-template handler but for actual resources. `ListMcpResourcesHandler` implements `ToolExecutor<ToolInvocation>` and exposes the fixed tool name `list_mcp_resources`, the corresponding schema from `mcp_resource_spec`, and a `true` parallelism flag because the operation is read-only.

`handle_call` performs the real work. It unpacks the invocation, requires `ToolPayload::Function`, and converts the raw argument string into a parsed JSON value and then a typed `ListResourcesArgs`. The optional `server` and `cursor` fields are normalized so blank strings do not accidentally count as meaningful values. It then creates an `McpInvocation` object used solely for begin/end event reporting, defaulting the telemetry server field to `codex` when no explicit server was requested.

Execution splits into two branches. When `server` is present, the handler optionally creates `PaginatedRequestParams` carrying the cursor and calls `session.list_resources(&server_name, params)`. The returned page is wrapped by `ListResourcesPayload::from_single_server`, preserving `next_cursor` and annotating each resource with its server. When `server` is absent, the handler rejects any provided cursor because cross-server aggregation has no coherent pagination contract; otherwise it asks `session.services.mcp_connection_manager.load_full().list_all_resources().await` for all resources and wraps them with `from_all_servers`. Finally, it serializes the payload under the turn’s truncation policy, extracts text for telemetry summaries, emits a completion event with duration and success/error status, and returns boxed output or propagates the error.

#### Function details

##### `ListMcpResourcesHandler::tool_name`  (lines 30–32)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name `list_mcp_resources` used by the registry and model-facing tool calls.

**Data flow**: It constructs and returns a `ToolName` from a fixed string literal. No state is read or modified.

**Call relations**: Called by registration/dispatch code to identify this handler. It only delegates to `ToolName::plain`.

*Call graph*: calls 1 internal fn (plain).


##### `ListMcpResourcesHandler::spec`  (lines 34–36)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the JSON-schema tool specification for listing MCP resources. This defines the optional `server` and `cursor` arguments and the descriptive text shown to the model.

**Data flow**: It reads no state and returns the `ToolSpec` built by `create_list_mcp_resources_tool()`. There are no side effects.

**Call relations**: Used by the tool registry when publishing available tools. It delegates schema construction to the shared spec helper so the handler stays aligned with the declared interface.

*Call graph*: calls 1 internal fn (create_list_mcp_resources_tool).


##### `ListMcpResourcesHandler::supports_parallel_tool_calls`  (lines 38–40)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Signals that this listing tool can safely run in parallel with other tool calls.

**Data flow**: It returns the constant `true` and touches no external state.

**Call relations**: Consulted by orchestration code before scheduling execution. It has no downstream calls.


##### `ListMcpResourcesHandler::handle`  (lines 42–44)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Wraps the async resource-listing implementation in the boxed future type expected by the executor trait.

**Data flow**: It takes a `ToolInvocation`, passes it unchanged into `self.handle_call(invocation)`, pins the future, and returns it. No parsing or mutation occurs here.

**Call relations**: This is the trait-level execution entrypoint. It exists solely to route control into `ListMcpResourcesHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListMcpResourcesHandler::handle_call`  (lines 48–164)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Runs the complete list-resources workflow, including payload-type validation, argument parsing, pagination handling, MCP session access, telemetry emission, and final output packaging.

**Data flow**: It consumes a `ToolInvocation`, extracts `session`, `turn`, `call_id`, and `payload`, and requires `ToolPayload::Function { arguments }`. It parses the argument string, deserializes `ListResourcesArgs`, normalizes optional `server` and `cursor`, and builds an `McpInvocation` for telemetry. It writes a begin event, measures elapsed time, then either calls `session.list_resources` with optional `PaginatedRequestParams` and wraps the page via `ListResourcesPayload::from_single_server`, or reads all resources from `session.services.mcp_connection_manager.load_full().list_all_resources()` and wraps them via `from_all_servers`. It serializes the payload with `serialize_function_output`, derives plain text from the output body for telemetry, emits an end event with success or error details, and returns boxed tool output or a `FunctionCallError`.

**Call relations**: Invoked by `ListMcpResourcesHandler::handle`. It delegates to session MCP APIs on the single-server path and to the connection manager on the aggregate path, then to serialization and telemetry helpers on both success and failure paths so completion is always recorded.

*Call graph*: calls 4 internal fn (boxed_tool_output, from_all_servers, from_single_server, function_call_output_content_items_to_text); called by 1 (handle); 10 external calls (now, clone, call_tool_result_from_content, emit_tool_call_begin, emit_tool_call_end, normalize_optional_string, parse_args_with_default, parse_arguments, serialize_function_output, RespondToModel).


### `core/src/tools/handlers/mcp_resource/read_mcp_resource.rs`

`domain_logic` · `request handling`

This file defines `ReadMcpResourceHandler`, the executor for the `read_mcp_resource` tool. As with the list handlers, the trait implementation is thin: it publishes the fixed tool name, returns the schema from `create_read_mcp_resource_tool`, marks the tool as parallel-safe, and boxes the async execution future.

The substantive logic is in `handle_call`. After destructuring `ToolInvocation`, it insists on `ToolPayload::Function` and rejects any other payload variant with a `RespondToModel` error. It parses the raw JSON argument string using `parse_arguments`, then deserializes into `ReadResourceArgs` with `parse_args`, which expects the required fields to be present. `normalize_required_string` is applied to both `server` and `uri`, so empty strings are rejected even if the JSON field exists.

For observability, the handler constructs an `McpInvocation` containing the exact server, tool name, and original parsed arguments, emits a begin event, and starts an `Instant` timer. It then calls `session.read_resource(&server, ReadResourceRequestParams::new(uri.clone()))`. Any transport or server error is rewritten into a model-facing `FunctionCallError` with the prefix `resources/read failed`. On success it builds a `ReadResourcePayload` containing the server, URI, and raw `ReadResourceResult`. The remainder of the flow matches the list handlers: serialize under the turn’s truncation policy, derive plain text for telemetry, emit an end event with duration and success/error status, and return boxed output. The key invariant here is that both `server` and `uri` are mandatory and normalized before any MCP request is attempted.

#### Function details

##### `ReadMcpResourceHandler::tool_name`  (lines 30–32)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registered tool name `read_mcp_resource`.

**Data flow**: It creates a `ToolName` from the fixed string literal and returns it. No state is read or written.

**Call relations**: Used by the tool registry and dispatcher to identify this handler. It only delegates to `ToolName::plain`.

*Call graph*: calls 1 internal fn (plain).


##### `ReadMcpResourceHandler::spec`  (lines 34–36)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the tool specification describing the required `server` and `uri` arguments for reading a resource.

**Data flow**: It returns the `ToolSpec` produced by `create_read_mcp_resource_tool()` and has no side effects.

**Call relations**: Called during tool publication and discovery. It delegates schema construction to the shared spec module.

*Call graph*: calls 1 internal fn (create_read_mcp_resource_tool).


##### `ReadMcpResourceHandler::supports_parallel_tool_calls`  (lines 38–40)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that resource reads may execute concurrently with other tool calls.

**Data flow**: It returns `true` without consulting or mutating any state.

**Call relations**: Read by scheduling/orchestration code to determine concurrency behavior. It has no downstream calls.


##### `ReadMcpResourceHandler::handle`  (lines 42–44)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Converts the async read implementation into the boxed future form required by `ToolExecutor`.

**Data flow**: It accepts a `ToolInvocation`, forwards it unchanged to `self.handle_call(invocation)`, pins the future, and returns it.

**Call relations**: This is the trait entrypoint used by the runtime. It simply hands execution off to `ReadMcpResourceHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ReadMcpResourceHandler::handle_call`  (lines 48–147)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the end-to-end read-resource operation: validate payload type, parse and normalize required arguments, invoke the MCP read API, serialize the result, and emit begin/end telemetry.

**Data flow**: It consumes a `ToolInvocation`, extracts session context and the raw function arguments, parses them into JSON and then `ReadResourceArgs`, and normalizes `server` and `uri` as required non-empty strings. It builds an `McpInvocation`, emits a begin event, times the operation, calls `session.read_resource` with `ReadResourceRequestParams::new(uri.clone())`, wraps the successful response into `ReadResourcePayload`, serializes that payload with `serialize_function_output`, converts output body items to text for telemetry, emits an end event with duration and success/error details, and returns boxed tool output or a `FunctionCallError`.

**Call relations**: Called by `ReadMcpResourceHandler::handle`. It delegates outward to the session’s MCP read API for the actual fetch and to shared serialization/telemetry helpers for consistent reporting on both success and failure.

*Call graph*: calls 2 internal fn (boxed_tool_output, function_call_output_content_items_to_text); called by 1 (handle); 11 external calls (now, new, clone, call_tool_result_from_content, emit_tool_call_begin, emit_tool_call_end, normalize_required_string, parse_args, parse_arguments, serialize_function_output (+1 more)).


### Session integration and auth flows
These files handle auth-elicitation decoding, session-side MCP refresh and approval orchestration, and skill-driven installation of required MCP dependencies.

### `codex-mcp/src/auth_elicitation.rs`

`domain_logic` · `tool-call error handling`

This module defines the data structures and constants used to recognize Codex Apps authentication failures embedded in `CallToolResult.meta`. The central parser, `connector_auth_failure_from_tool_result`, is intentionally strict: it only accepts results marked `is_error == Some(true)`, requires nested JSON objects under `_codex_apps.connector_auth_failure`, requires `is_auth_failure: true`, requires a non-empty trusted `connector_id` argument, and rejects metadata whose connector ID disagrees with that trusted ID. It also requires an install URL from the caller rather than trusting metadata for that field. Optional string fields such as `auth_reason`, `link_id`, `error_code`, and `error_action` are normalized through `string_auth_failure_field`, which trims whitespace and drops empty strings.

Once parsed, `build_auth_elicitation_plan` pairs the validated failure with a user-facing elicitation payload. `build_auth_elicitation` serializes a nested metadata object using `CodexAppsConnectorAuthFailureMeta`, preserving optional fields only when present, and computes both a human message and a deterministic `elicitation_id`. Message text varies by `auth_reason`, distinguishing upgrade, reauthentication, missing-link, and generic sign-in cases. `auth_elicitation_completed_result` produces the follow-up `CallToolResult` that tells the caller authentication was accepted and the tool call should be retried. The inline tests document the trust boundary: connector name may be supplied by trusted caller context, but connector identity must match trusted metadata expectations.

#### Function details

##### `connector_auth_failure_from_tool_result`  (lines 63–122)

```
fn connector_auth_failure_from_tool_result(
    result: &CallToolResult,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    install_url: Option<String>,
) -> Option<CodexAppsConnect
```

**Purpose**: Extracts a validated `CodexAppsConnectorAuthFailure` from a tool result’s nested metadata when the result represents an auth failure for a trusted connector. It rejects non-errors, malformed metadata, missing trusted connector identity, mismatches, and missing install URLs.

**Data flow**: Inputs are a `&CallToolResult`, optional trusted `connector_id`, optional trusted `connector_name`, and optional `install_url`. The function reads `result.is_error` and walks `result.meta` through `_codex_apps` and `connector_auth_failure` JSON objects, checks `is_auth_failure`, normalizes optional string fields via `string_auth_failure_field`, trims and validates the trusted connector ID, compares any metadata connector ID against that trusted ID, derives a connector name from the trusted name or connector ID, and returns `Some(CodexAppsConnectorAuthFailure)` or `None`. It does not mutate external state.

**Call relations**: It is the parser used by `build_auth_elicitation_plan` and is also exercised directly by the payload-building test. The function delegates repeated optional-string extraction to `string_auth_failure_field` so all metadata fields share the same trim-and-empty-drop behavior.

*Call graph*: calls 1 internal fn (string_auth_failure_field); called by 2 (build_auth_elicitation_plan, builds_url_elicitation_payload).


##### `build_auth_elicitation_plan`  (lines 124–138)

```
fn build_auth_elicitation_plan(
    call_id: &str,
    result: &CallToolResult,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    install_url: Option<String>,
) -> Option<CodexApps
```

**Purpose**: Builds the full auth-elicitation plan only when a tool result can be parsed into a trusted auth failure. The returned plan bundles both the parsed failure details and the user-facing elicitation payload.

**Data flow**: Takes a call ID, tool result, optional trusted connector ID and name, and optional install URL. It first invokes `connector_auth_failure_from_tool_result`; on `None` it returns `None`. On success it passes the parsed failure into `build_auth_elicitation` and returns `Some(CodexAppsAuthElicitationPlan { auth_failure, elicitation })`.

**Call relations**: This is the module’s orchestration helper: callers use it when they want parsing and payload construction in one step. The test `tests::builds_auth_elicitation_plan` covers the successful path.

*Call graph*: calls 2 internal fn (build_auth_elicitation, connector_auth_failure_from_tool_result); called by 1 (builds_auth_elicitation_plan).


##### `build_auth_elicitation`  (lines 140–164)

```
fn build_auth_elicitation(
    call_id: &str,
    auth_failure: &CodexAppsConnectorAuthFailure,
) -> CodexAppsAuthElicitation
```

**Purpose**: Constructs the protocol-neutral auth-elicitation payload from a validated auth-failure record. It serializes machine-readable metadata and computes the message, URL, and elicitation identifier shown to the client.

**Data flow**: Accepts a `call_id` and `&CodexAppsConnectorAuthFailure`. It builds a JSON `meta` object under `_codex_apps.connector_auth_failure` using `CodexAppsConnectorAuthFailureMeta`, computes `message` with `auth_elicitation_message`, clones `install_url` into `url`, computes `elicitation_id` with `auth_elicitation_id`, and returns a `CodexAppsAuthElicitation`.

**Call relations**: It is called by `build_auth_elicitation_plan` after parsing succeeds. It delegates message wording and ID formatting to dedicated helpers so payload shape and wording logic remain separate.

*Call graph*: calls 2 internal fn (auth_elicitation_id, auth_elicitation_message); called by 1 (build_auth_elicitation_plan); 1 external calls (json!).


##### `auth_elicitation_completed_result`  (lines 166–182)

```
fn auth_elicitation_completed_result(
    auth_failure: &CodexAppsConnectorAuthFailure,
    meta: Option<serde_json::Value>,
) -> CallToolResult
```

**Purpose**: Creates the `CallToolResult` sent after the user accepts an authentication elicitation. The result is intentionally marked as an error so the caller knows to retry the original tool call rather than treat this as normal tool output.

**Data flow**: Takes a validated auth-failure record and optional metadata. It formats a single text content item mentioning `auth_failure.connector_name`, sets `structured_content` to `None`, `is_error` to `Some(true)`, preserves the provided `meta`, and returns the assembled `CallToolResult`.

**Call relations**: This helper is used by higher-level auth-elicitation flows after acceptance; within this file it stands alone as the completion payload counterpart to `build_auth_elicitation`.

*Call graph*: 1 external calls (vec!).


##### `auth_elicitation_id`  (lines 184–186)

```
fn auth_elicitation_id(call_id: &str) -> String
```

**Purpose**: Generates a deterministic elicitation identifier from an MCP call ID. The prefix namespaces these IDs to Codex Apps auth flows.

**Data flow**: Consumes `&str call_id`, interpolates it into `codex_apps_auth_{call_id}`, and returns the resulting `String`.

**Call relations**: It is called only by `build_auth_elicitation` so all auth elicitations use the same stable ID format.

*Call graph*: called by 1 (build_auth_elicitation); 1 external calls (format!).


##### `string_auth_failure_field`  (lines 188–198)

```
fn string_auth_failure_field(
    auth_failure: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String>
```

**Purpose**: Reads an optional string field from the auth-failure metadata map and normalizes it. Whitespace-only values are discarded.

**Data flow**: Takes a JSON object map and a key, looks up the value, converts it to `&str` if possible, trims it, filters out empty strings, clones the remaining text into a `String`, and returns `Option<String>`.

**Call relations**: This helper is called repeatedly by `connector_auth_failure_from_tool_result` to keep parsing of optional metadata fields consistent and concise.

*Call graph*: called by 1 (connector_auth_failure_from_tool_result); 1 external calls (get).


##### `auth_elicitation_message`  (lines 200–219)

```
fn auth_elicitation_message(auth_failure: &CodexAppsConnectorAuthFailure) -> String
```

**Purpose**: Chooses the user-facing auth prompt text based on the failure reason. Different reasons produce more specific reconnect or sign-in instructions.

**Data flow**: Reads `auth_failure.auth_reason` and `auth_failure.connector_name`. It matches known reasons like `oauth_upgrade_required`, `reauthentication_required`, and `missing_link`, formats the corresponding sentence, and returns the message `String`.

**Call relations**: It is called by `build_auth_elicitation` to separate wording policy from payload assembly.

*Call graph*: called by 1 (build_auth_elicitation); 1 external calls (format!).


##### `tests::auth_failure_result`  (lines 226–249)

```
fn auth_failure_result() -> CallToolResult
```

**Purpose**: Builds a representative `CallToolResult` containing nested Codex Apps auth-failure metadata for unit tests. The metadata includes both trusted and untrusted-looking fields so parsing behavior can be checked precisely.

**Data flow**: Creates and returns a `CallToolResult` with one text content item, `is_error: Some(true)`, and a nested JSON `meta` object under `_codex_apps.connector_auth_failure` containing auth reason, connector ID, connector name, link ID, error code, HTTP status, and action.

**Call relations**: This fixture is consumed by the parsing and plan-building tests to avoid duplicating the nested metadata shape.

*Call graph*: 2 external calls (json!, vec!).


##### `tests::parses_auth_failure_from_trusted_connector_metadata`  (lines 252–272)

```
fn parses_auth_failure_from_trusted_connector_metadata()
```

**Purpose**: Verifies that valid auth-failure metadata plus trusted connector context produces a fully populated `CodexAppsConnectorAuthFailure`. It also confirms that the trusted connector name overrides any untrusted metadata name.

**Data flow**: Calls `connector_auth_failure_from_tool_result` with the fixture result, trusted connector ID and name, and install URL, then compares the returned struct against an explicit expected value containing all parsed optional fields.

**Call relations**: This test exercises the parser’s successful path and documents the trust model around connector identity and display name.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_missing_or_mismatched_connector_ids`  (lines 275–294)

```
fn rejects_missing_or_mismatched_connector_ids()
```

**Purpose**: Checks that parsing fails when the caller does not supply a trusted connector ID or supplies one that disagrees with metadata. This prevents auth prompts from being generated for ambiguous or spoofed connectors.

**Data flow**: Invokes `connector_auth_failure_from_tool_result` twice with the fixture result: once with `connector_id` absent and once with a mismatched ID. It asserts that both calls return `None`.

**Call relations**: This test covers the parser’s early rejection branches that enforce trusted connector identity.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::builds_url_elicitation_payload`  (lines 297–331)

```
fn builds_url_elicitation_payload()
```

**Purpose**: Verifies the exact auth-elicitation payload built from a parsed auth failure. It checks nested metadata, reason-specific message text, URL propagation, and deterministic elicitation ID formatting.

**Data flow**: Parses the fixture result into an auth-failure struct using `connector_auth_failure_from_tool_result`, then passes that struct to `build_auth_elicitation` with `call_123` and asserts equality with a fully spelled-out `CodexAppsAuthElicitation` value.

**Call relations**: This test covers the payload-construction path after successful parsing and indirectly validates `auth_elicitation_message` and `auth_elicitation_id`.

*Call graph*: calls 1 internal fn (connector_auth_failure_from_tool_result); 2 external calls (assert_eq!, auth_failure_result).


##### `tests::builds_auth_elicitation_plan`  (lines 334–346)

```
fn builds_auth_elicitation_plan()
```

**Purpose**: Checks that the combined plan builder returns both the parsed auth failure and the elicitation payload together. It focuses on the integration between parsing and payload assembly.

**Data flow**: Calls `build_auth_elicitation_plan` with the fixture result and trusted connector context, unwraps the returned plan, and asserts selected fields on both `plan.auth_failure` and `plan.elicitation`.

**Call relations**: This test exercises the top-level helper that composes `connector_auth_failure_from_tool_result` and `build_auth_elicitation`.

*Call graph*: calls 1 internal fn (build_auth_elicitation_plan); 2 external calls (assert_eq!, auth_failure_result).


### `core/src/session/mcp.rs`

`orchestration` · `request handling`

This module extends `Session` with MCP-facing operations and defines the Guardian reviewer used for MCP elicitations. `GuardianMcpElicitationReviewer` stores a `Weak<Session>` so reviewer callbacks do not keep sessions alive; its `review` method upgrades the weak pointer and delegates to `review_guardian_mcp_elicitation`. Session methods expose runtime MCP config and server maps, create reviewer handles, proxy resource/template reads and tool calls to the current `McpConnectionManager`, and manage startup cancellation tokens. The most involved request path is `request_mcp_server_elicitation`: it short-circuits to an automatic accept when the connection manager is in auto-deny mode, otherwise converts MCP form or URL elicitation requests into protocol `ElicitationRequest` values, registers a oneshot sender in the active turn’s pending elicitation map keyed by server name and request id, emits an `EventMsg::ElicitationRequest`, records plugin-install telemetry when metadata indicates a tool-install suggestion, and waits for the response. `resolve_elicitation` first tries to satisfy a pending active-turn oneshot and falls back to the connection manager if the request is no longer tracked there. Refresh logic parses a deferred `McpServerRefreshConfig`, computes effective servers and auth statuses, derives runtime cwd from the primary turn environment when possible, rotates the startup cancellation token, constructs a fresh `McpConnectionManager`, preserves the previous auto-deny flag, and swaps it into session services. The Guardian review helpers inspect elicitation metadata for an explicit approval-request opt-in, require `mcp_tool_call` approval kind and empty form schemas, extract connector/tool metadata and JSON object arguments, build `GuardianApprovalRequest::McpToolCall`, and map Guardian `ReviewDecision` values back into MCP `ElicitationResponse` objects with standardized auto-review metadata and optional denial messages.

#### Function details

##### `GuardianMcpElicitationReviewer::new`  (lines 54–58)

```
fn new(session: &Arc<Session>) -> Self
```

**Purpose**: Creates a reviewer wrapper that holds only a weak reference to the session.

**Data flow**: Accepts `&Arc<Session>`, downgrades it with `Arc::downgrade`, stores the resulting `Weak<Session>` in `GuardianMcpElicitationReviewer`, and returns the new struct.

**Call relations**: Called by `Session::mcp_elicitation_reviewer` when a reviewer handle is needed for MCP connection-manager setup. Using a weak pointer avoids reviewer callbacks extending session lifetime.

*Call graph*: called by 1 (mcp_elicitation_reviewer); 1 external calls (downgrade).


##### `GuardianMcpElicitationReviewer::review`  (lines 62–73)

```
fn review(
        &self,
        request: ElicitationReviewRequest,
    ) -> BoxFuture<'static, anyhow::Result<Option<ElicitationResponse>>>
```

**Purpose**: Implements the `ElicitationReviewer` trait by asynchronously delegating Guardian review to the live session if it still exists.

**Data flow**: Clones the stored weak session pointer, returns a boxed future, upgrades the weak pointer inside that future, returns `Ok(None)` if the session is gone, otherwise awaits `review_guardian_mcp_elicitation(session, request)` and returns its result.

**Call relations**: This trait method is invoked by MCP infrastructure when an elicitation requires review. It is the adapter from the generic reviewer interface into this module’s session-aware Guardian logic.

*Call graph*: calls 1 internal fn (review_guardian_mcp_elicitation); 2 external calls (pin, clone).


##### `Session::runtime_mcp_config`  (lines 77–82)

```
async fn runtime_mcp_config(&self, config: &Config) -> McpConfig
```

**Purpose**: Computes the effective MCP runtime configuration for the current thread from the session’s MCP manager and initialization state.

**Data flow**: Borrows `self` and a `Config`, then awaits `self.services.mcp_manager.runtime_config_for_thread(config, &self.services.mcp_thread_init)` and returns the resulting `McpConfig`.

**Call relations**: Used by `runtime_mcp_servers` and `refresh_mcp_servers_inner` as the starting point for effective MCP server computation.

*Call graph*: called by 2 (refresh_mcp_servers_inner, runtime_mcp_servers).


##### `Session::runtime_mcp_servers`  (lines 84–89)

```
async fn runtime_mcp_servers(
        &self,
        config: &Config,
    ) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns the configured MCP servers derived from the session’s effective runtime MCP config.

**Data flow**: Awaits `self.runtime_mcp_config(config)`, passes the resulting config to `codex_mcp::configured_mcp_servers`, and returns the resulting `HashMap<String, McpServerConfig>`.

**Call relations**: This is a convenience wrapper over `runtime_mcp_config` for callers that need the server map directly.

*Call graph*: calls 1 internal fn (runtime_mcp_config); 1 external calls (configured_mcp_servers).


##### `Session::mcp_elicitation_reviewer`  (lines 91–93)

```
fn mcp_elicitation_reviewer(self: &Arc<Self>) -> ElicitationReviewerHandle
```

**Purpose**: Builds an `ElicitationReviewerHandle` backed by the session’s Guardian reviewer implementation.

**Data flow**: Creates a `GuardianMcpElicitationReviewer` with `GuardianMcpElicitationReviewer::new(self)`, wraps it in `Arc`, and returns it as the trait-object handle.

**Call relations**: Used by session handlers when refreshing MCP servers or processing turns that may need elicitation review.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `Session::request_mcp_server_elicitation`  (lines 99–211)

```
async fn request_mcp_server_elicitation(
        &self,
        turn_context: &TurnContext,
        request_id: RequestId,
        params: McpServerElicitationRequestParams,
    ) -> McpServerElicitat
```

**Purpose**: Sends an MCP elicitation request to the client for the active turn, tracks a pending response channel, and optionally records plugin-install telemetry.

**Data flow**: Reads the connection manager’s `elicitations_auto_deny` flag and, if true, returns an immediate accepted `ElicitationResponse` with empty JSON content and `sent = false`. Otherwise it clones `server_name`, converts the incoming MCP request into protocol `codex_protocol::approvals::ElicitationRequest`, serializing form schemas with `serde_json::to_value` and aborting with a warning on serialization failure. It creates a oneshot channel, inserts the sender into the active turn’s pending elicitation map under `(server_name, request_id)`, warns if an entry was overwritten, converts the RMCP request id into protocol `RequestId`, builds `EventMsg::ElicitationRequest`, derives optional plugin-install telemetry metadata from the event, marks user input requested during the turn, sends the event, records telemetry if applicable, awaits the oneshot receiver, and returns `McpServerElicitationOutcome { response, sent: true }`.

**Call relations**: Called by MCP execution flows when a server asks the client for approval or input. It coordinates active-turn state, protocol event emission, and eventual response delivery.

*Call graph*: calls 1 internal fn (plugin_install_elicitation_telemetry_metadata); 8 external calls (Integer, String, clone, channel, ElicitationRequest, json!, to_value, warn!).


##### `Session::resolve_elicitation`  (lines 217–245)

```
async fn resolve_elicitation(
        &self,
        server_name: String,
        id: RequestId,
        response: ElicitationResponse,
    ) -> anyhow::Result<()>
```

**Purpose**: Resolves a pending MCP elicitation either by satisfying the active turn’s waiting oneshot or by forwarding the response to the connection manager.

**Data flow**: Locks `active_turn`, removes any pending elicitation sender matching `(server_name, id)` from the active turn state, and if found sends the provided `ElicitationResponse` through that oneshot, mapping send failure into an `anyhow` error. If no active-turn entry exists, it delegates to `self.services.mcp_connection_manager.load_full().resolve_elicitation(server_name, id, response).await`.

**Call relations**: Called from the session handler that processes client elicitation responses. It bridges the protocol response back to whichever component is currently waiting for it.


##### `Session::list_resources`  (lines 247–257)

```
async fn list_resources(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> anyhow::Result<ListResourcesResult>
```

**Purpose**: Proxies an MCP list-resources request to the current connection manager.

**Data flow**: Accepts a server name and optional pagination params, forwards them to `mcp_connection_manager.load_full().list_resources(server, params).await`, and returns the result.

**Call relations**: This is a direct session façade over the MCP transport layer for resource enumeration.


##### `Session::list_resource_templates`  (lines 259–269)

```
async fn list_resource_templates(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> anyhow::Result<ListResourceTemplatesResult>
```

**Purpose**: Proxies an MCP list-resource-templates request to the current connection manager.

**Data flow**: Accepts a server name and optional pagination params, forwards them to `mcp_connection_manager.load_full().list_resource_templates(server, params).await`, and returns the result.

**Call relations**: Like `list_resources`, this method exposes MCP transport functionality through the session.


##### `Session::read_resource`  (lines 271–281)

```
async fn read_resource(
        &self,
        server: &str,
        params: ReadResourceRequestParams,
    ) -> anyhow::Result<ReadResourceResult>
```

**Purpose**: Proxies an MCP read-resource request to the current connection manager.

**Data flow**: Accepts a server name and `ReadResourceRequestParams`, forwards them to `mcp_connection_manager.load_full().read_resource(server, params).await`, and returns the result.

**Call relations**: Used by higher-level session or tool flows that need MCP resource contents.


##### `Session::call_tool`  (lines 283–295)

```
async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        arguments: Option<serde_json::Value>,
        meta: Option<serde_json::Value>,
    ) -> anyhow::Result<CallToolResu
```

**Purpose**: Proxies an MCP tool invocation to the current connection manager.

**Data flow**: Accepts server name, tool name, optional JSON arguments, and optional JSON metadata; forwards them to `mcp_connection_manager.load_full().call_tool(server, tool, arguments, meta).await`; and returns the call result.

**Call relations**: This is the session-level entry for MCP tool execution.


##### `Session::refresh_mcp_servers_inner`  (lines 297–368)

```
async fn refresh_mcp_servers_inner(
        &self,
        turn_context: &TurnContext,
        mcp_servers: HashMap<String, McpServerConfig>,
        store_mode: OAuthCredentialsStoreMode,
        key
```

**Purpose**: Builds and installs a fresh `McpConnectionManager` from resolved runtime config, auth state, turn context, and optional elicitation reviewer.

**Data flow**: Reads auth and config from session services, computes runtime MCP config and tool-plugin provenance, derives effective servers and host-owned app enablement, computes auth statuses, derives runtime cwd from the primary turn environment or falls back to the legacy turn cwd, creates `McpRuntimeContext`, rotates and stores a new startup `CancellationToken` after canceling the old one, constructs `McpConnectionManager::new(...)` with server/auth/approval/permission/runtime parameters, copies the previous manager’s `elicitations_auto_deny` flag into the refreshed manager, and stores the new manager in `self.services.mcp_connection_manager`.

**Call relations**: This is the shared implementation behind both deferred and immediate MCP refresh paths. It is called by `refresh_mcp_servers_if_requested` and `refresh_mcp_servers_now`.

*Call graph*: calls 4 internal fn (new, new, runtime_mcp_config, permission_profile); called by 2 (refresh_mcp_servers_if_requested, refresh_mcp_servers_now); 3 external calls (new, new, tool_plugin_provenance).


##### `Session::refresh_mcp_servers_if_requested`  (lines 370–420)

```
async fn refresh_mcp_servers_if_requested(
        &self,
        turn_context: &TurnContext,
        elicitation_reviewer: Option<ElicitationReviewerHandle>,
    )
```

**Purpose**: Consumes any pending serialized MCP refresh config from session state, parses it, and refreshes MCP servers if parsing succeeds.

**Data flow**: Takes and clears `pending_mcp_server_refresh_config`; if absent it returns. Otherwise it destructures the JSON-valued `McpServerRefreshConfig`, deserializes `mcp_servers`, `OAuthCredentialsStoreMode`, and `AuthKeyringBackendKind` from those JSON values with warning-and-return on parse failure, then calls `refresh_mcp_servers_inner(...)` with the parsed values and optional reviewer.

**Call relations**: Called during turn setup from session handlers after user input or review startup. It turns a previously queued refresh request into an actual connection-manager rebuild.

*Call graph*: calls 1 internal fn (refresh_mcp_servers_inner); 1 external calls (warn!).


##### `Session::refresh_mcp_servers_now`  (lines 422–438)

```
async fn refresh_mcp_servers_now(
        &self,
        turn_context: &TurnContext,
        mcp_servers: HashMap<String, McpServerConfig>,
        store_mode: OAuthCredentialsStoreMode,
        keyri
```

**Purpose**: Immediately refreshes MCP servers using already parsed configuration values.

**Data flow**: Accepts a turn context, concrete server map, store mode, keyring backend kind, and optional reviewer, then forwards them directly to `refresh_mcp_servers_inner(...).await`.

**Call relations**: This is the eager counterpart to `refresh_mcp_servers_if_requested`, used when the caller already has parsed refresh inputs.

*Call graph*: calls 1 internal fn (refresh_mcp_servers_inner).


##### `Session::mcp_startup_cancellation_token`  (lines 441–447)

```
async fn mcp_startup_cancellation_token(&self) -> CancellationToken
```

**Purpose**: Returns the current MCP startup cancellation token for tests.

**Data flow**: Locks `self.services.mcp_startup_cancellation_token`, clones the stored `CancellationToken`, and returns it.

**Call relations**: Compiled only in tests to let test code observe token rotation and cancellation behavior.


##### `Session::cancel_mcp_startup`  (lines 449–455)

```
async fn cancel_mcp_startup(&self)
```

**Purpose**: Cancels the current MCP startup token, signaling in-progress MCP startup work to stop.

**Data flow**: Locks `self.services.mcp_startup_cancellation_token` and calls `cancel()` on the stored token.

**Call relations**: Used by session control flows that need to abort MCP startup work, such as teardown or refresh replacement.


##### `review_guardian_mcp_elicitation`  (lines 458–507)

```
async fn review_guardian_mcp_elicitation(
    session: Arc<Session>,
    request: ElicitationReviewRequest,
) -> anyhow::Result<Option<ElicitationResponse>>
```

**Purpose**: Runs Guardian auto-review for an MCP elicitation request when the active turn and reviewer routing indicate Guardian should handle it.

**Data flow**: Fetches the active turn context and returns `Ok(None)` if there is none. It computes the effective approvals reviewer using connector-aware config, checks whether approval should route to Guardian, and if not returns `Ok(None)`. It then classifies the request with `guardian_elicitation_review_request`: `NotRequested` returns `Ok(None)`, `Decline(reason)` logs a warning and returns an immediate decline response without message, and `ApprovalRequest` triggers Guardian review by generating a review id, calling `crate::guardian::review_approval_request(...)`, then converting the resulting `ReviewDecision` into an `ElicitationResponse` with `mcp_elicitation_response_from_guardian_decision`.

**Call relations**: Called from `GuardianMcpElicitationReviewer::review`. It is the top-level policy engine that decides whether and how Guardian participates in MCP elicitation review.

*Call graph*: calls 5 internal fn (mcp_approvals_reviewer, elicitation_connector_id, guardian_elicitation_review_request, mcp_elicitation_decline_without_message, mcp_elicitation_response_from_guardian_decision); called by 1 (review); 4 external calls (new_guardian_review_id, review_approval_request, routes_approval_to_guardian_with_reviewer, warn!).


##### `guardian_elicitation_review_request`  (lines 509–586)

```
fn guardian_elicitation_review_request(
    request: &ElicitationReviewRequest,
) -> GuardianElicitationReview
```

**Purpose**: Inspects an MCP elicitation request’s metadata and schema to decide whether it requests Guardian review, should be declined as unsupported, or can be converted into a `GuardianApprovalRequest::McpToolCall`.

**Data flow**: Matches the elicitation shape: URL elicitations are declined only if they explicitly request approval review, otherwise ignored; form elicitations expose metadata and optional schema. It requires metadata to exist, `codex_request_type` to equal approval-request, `codex_approval_kind` to equal `mcp_tool_call`, and the requested schema to have no properties. It extracts a non-empty `tool_name`, validates `tool_params` as either an object or absent (defaulting absent to `{}`), and builds `GuardianElicitationReview::ApprovalRequest(Box::new(GuardianApprovalRequest::McpToolCall { ... }))` with synthesized id, server, tool metadata, connector metadata, and arguments. Any unsupported shape returns `Decline(...)`; missing opt-in returns `NotRequested`.

**Call relations**: Used only by `review_guardian_mcp_elicitation`. It encapsulates the metadata contract that MCP servers must satisfy to opt into Guardian review.

*Call graph*: calls 3 internal fn (meta_requests_approval_request, metadata_owned_string, metadata_str); called by 1 (review_guardian_mcp_elicitation); 6 external calls (new, new, Object, ApprovalRequest, Decline, format!).


##### `elicitation_connector_id`  (lines 588–595)

```
fn elicitation_connector_id(elicitation: &CreateElicitationRequestParams) -> Option<&str>
```

**Purpose**: Extracts the connector id string from either form or URL elicitation metadata.

**Data flow**: Matches the elicitation variant, accesses its optional `meta`, and if present returns the string value for `CONNECTOR_ID_KEY` via `metadata_str`; otherwise returns `None`.

**Call relations**: Called by `review_guardian_mcp_elicitation` when computing connector-aware approvals reviewer routing.

*Call graph*: called by 1 (review_guardian_mcp_elicitation).


##### `meta_requests_approval_request`  (lines 597–601)

```
fn meta_requests_approval_request(meta: &Option<Meta>) -> bool
```

**Purpose**: Checks whether elicitation metadata explicitly marks the request type as an approval request.

**Data flow**: Reads the optional `Meta`, extracts the underlying map, looks up `REQUEST_TYPE_KEY` with `metadata_str`, compares it to `REQUEST_TYPE_APPROVAL_REQUEST`, and returns the boolean result.

**Call relations**: Used by `guardian_elicitation_review_request` to distinguish unsupported opt-in URL requests from ordinary non-reviewed elicitations.

*Call graph*: called by 1 (guardian_elicitation_review_request).


##### `metadata_str`  (lines 603–605)

```
fn metadata_str(meta: &'a Map<String, Value>, key: &str) -> Option<&'a str>
```

**Purpose**: Looks up a metadata key and returns its string value if present and JSON-string typed.

**Data flow**: Reads `meta.get(key)` from the `serde_json::Map<String, Value>` and applies `Value::as_str`, returning `Option<&str>`.

**Call relations**: This is the primitive metadata accessor used throughout Guardian review parsing and plugin-install telemetry extraction.

*Call graph*: called by 3 (guardian_elicitation_review_request, metadata_owned_string, plugin_install_elicitation_telemetry_metadata); 1 external calls (get).


##### `metadata_owned_string`  (lines 607–612)

```
fn metadata_owned_string(meta: &Map<String, Value>, key: &str) -> Option<String>
```

**Purpose**: Extracts, trims, validates non-emptiness, and clones a metadata string value.

**Data flow**: Calls `metadata_str(meta, key)`, trims whitespace, filters out empty strings, converts the remaining `&str` into an owned `String`, and returns it as `Option<String>`.

**Call relations**: Used by `guardian_elicitation_review_request` and `plugin_install_elicitation_telemetry_metadata` when metadata must be preserved beyond the borrowed map.

*Call graph*: calls 1 internal fn (metadata_str); called by 2 (guardian_elicitation_review_request, plugin_install_elicitation_telemetry_metadata).


##### `plugin_install_elicitation_telemetry_metadata`  (lines 614–639)

```
fn plugin_install_elicitation_telemetry_metadata(
    event: &EventMsg,
) -> Option<PluginInstallElicitationTelemetryMetadata>
```

**Purpose**: Recognizes plugin-install tool-suggestion elicitation events and extracts telemetry fields for them.

**Data flow**: Pattern-matches the `EventMsg` as `ElicitationRequest` containing a form request with object metadata, checks that `codex_approval_kind` is `tool_suggestion` and `suggest_type` is `install`, then extracts non-empty `tool_type`, `tool_id`, and `tool_name` via `metadata_owned_string` and returns them in `PluginInstallElicitationTelemetryMetadata`; otherwise returns `None`.

**Call relations**: Called by `Session::request_mcp_server_elicitation` immediately before sending the event so plugin-install prompts can be recorded in telemetry.

*Call graph*: calls 2 internal fn (metadata_owned_string, metadata_str); called by 1 (request_mcp_server_elicitation).


##### `mcp_elicitation_request_id`  (lines 641–646)

```
fn mcp_elicitation_request_id(id: &RequestId) -> String
```

**Purpose**: Formats an RMCP request id into a plain string for logging and synthesized Guardian request ids.

**Data flow**: Matches `RequestId` as either `NumberOrString::String` or `NumberOrString::Number` and returns `to_string()` of the contained value.

**Call relations**: Used by Guardian review helpers when constructing stable identifiers and warning messages.


##### `mcp_elicitation_response_from_guardian_decision`  (lines 648–660)

```
async fn mcp_elicitation_response_from_guardian_decision(
    session: &Session,
    review_id: &str,
    decision: ReviewDecision,
) -> ElicitationResponse
```

**Purpose**: Converts a Guardian review decision into an MCP elicitation response, fetching a session-specific rejection message when needed.

**Data flow**: If the decision is `ReviewDecision::Denied`, it awaits `crate::guardian::guardian_rejection_message(session, review_id)` to obtain a denial message; otherwise it uses `None`. It then delegates to `mcp_elicitation_response_from_guardian_decision_parts(decision, denial_message)` and returns the resulting `ElicitationResponse`.

**Call relations**: Called by `review_guardian_mcp_elicitation` after Guardian review completes. It adds session-aware denial messaging on top of the pure decision mapping helper.

*Call graph*: calls 1 internal fn (mcp_elicitation_response_from_guardian_decision_parts); called by 1 (review_guardian_mcp_elicitation); 1 external calls (guardian_rejection_message).


##### `mcp_elicitation_response_from_guardian_decision_parts`  (lines 662–687)

```
fn mcp_elicitation_response_from_guardian_decision_parts(
    decision: ReviewDecision,
    denial_message: Option<String>,
) -> ElicitationResponse
```

**Purpose**: Maps each `ReviewDecision` variant to the corresponding MCP `ElicitationResponse` shape and metadata.

**Data flow**: Matches on `ReviewDecision`: approvals become `Accept` with empty JSON content and auto-review metadata; `Denied` becomes a decline with the provided or default denial message; `TimedOut` becomes a decline with `guardian_timeout_message()`; and `Abort` becomes `Cancel` with auto-review metadata. It returns the constructed `ElicitationResponse`.

**Call relations**: Used by `mcp_elicitation_response_from_guardian_decision` and tested directly in `mcp_tests.rs`. It is the pure mapping layer from Guardian outcomes to MCP protocol responses.

*Call graph*: calls 2 internal fn (mcp_elicitation_auto_meta, mcp_elicitation_decline_with_message); called by 1 (mcp_elicitation_response_from_guardian_decision); 2 external calls (guardian_timeout_message, json!).


##### `mcp_elicitation_decline_with_message`  (lines 689–698)

```
fn mcp_elicitation_decline_with_message(message: String) -> ElicitationResponse
```

**Purpose**: Builds a decline response that includes both an auto-review marker and a human-readable denial message in metadata.

**Data flow**: Constructs and returns `ElicitationResponse { action: Decline, content: None, meta: Some(json!({ "message": message, "approvals_reviewer": ApprovalsReviewer::AutoReview })) }`.

**Call relations**: Called by `mcp_elicitation_response_from_guardian_decision_parts` for denied and timed-out decisions.

*Call graph*: called by 1 (mcp_elicitation_response_from_guardian_decision_parts); 1 external calls (json!).


##### `mcp_elicitation_decline_without_message`  (lines 700–706)

```
fn mcp_elicitation_decline_without_message() -> ElicitationResponse
```

**Purpose**: Builds a decline response that carries only the standardized auto-review metadata.

**Data flow**: Returns `ElicitationResponse { action: Decline, content: None, meta: Some(mcp_elicitation_auto_meta()) }`.

**Call relations**: Used by `review_guardian_mcp_elicitation` when an elicitation opted into Guardian review but had an unsupported shape that should be declined before full review.

*Call graph*: calls 1 internal fn (mcp_elicitation_auto_meta); called by 1 (review_guardian_mcp_elicitation).


##### `mcp_elicitation_auto_meta`  (lines 708–712)

```
fn mcp_elicitation_auto_meta() -> serde_json::Value
```

**Purpose**: Constructs the standard metadata object marking an elicitation response as produced by auto-review.

**Data flow**: Returns `serde_json::json!({ "approvals_reviewer": ApprovalsReviewer::AutoReview })`.

**Call relations**: Shared by the decline-without-message helper and the decision-mapping helper to keep auto-review metadata consistent.

*Call graph*: called by 2 (mcp_elicitation_decline_without_message, mcp_elicitation_response_from_guardian_decision_parts); 1 external calls (json!).


### `core/src/mcp_skill_dependencies.rs`

`domain_logic` · `skill resolution / pre-tool setup`

This module automates MCP dependency installation for skills that declare MCP tool requirements. The top-level flow starts in `maybe_prompt_and_install_mcp_dependencies`, which first restricts the feature to first-party originators, then checks the feature flag and whether any skills were mentioned. It computes currently installed runtime MCP servers, derives missing dependencies from skill metadata, filters out dependencies already prompted about in this session, and asks the user whether to install them unless approval policy auto-approves MCP prompts.

Dependency matching is based on canonical transport-specific keys rather than display names. `canonical_mcp_server_key` and `canonical_mcp_dependency_key` normalize stdio dependencies by command and HTTP dependencies by URL, so duplicates across skills or naming differences collapse correctly. `collect_missing_mcp_dependencies` uses those keys to skip already installed servers and deduplicate repeated requirements, while logging malformed dependency declarations instead of failing the whole flow.

If installation proceeds, `maybe_install_mcp_dependencies` loads global MCP servers from disk, inserts only truly absent entries, persists the updated map with `ConfigEditsBuilder::replace_mcp_servers`, and then attempts OAuth login for each newly added server when supported. It resolves scopes, retries without scopes when discovery suggests that workaround, and logs failures without aborting the rest of installation. Finally it refreshes an in-memory config clone with the newly installed servers and asks the session to refresh active MCP connections so the current turn can use them immediately.

#### Function details

##### `maybe_prompt_and_install_mcp_dependencies`  (lines 34–79)

```
async fn maybe_prompt_and_install_mcp_dependencies(
    sess: &Session,
    turn_context: &TurnContext,
    cancellation_token: &CancellationToken,
    mentioned_skills: &[SkillMetadata],
    elicitat
```

**Purpose**: Coordinates the full prompt-before-install flow for skill-declared MCP dependencies. It exits early for unsupported clients, disabled features, no mentioned skills, no missing dependencies, or dependencies already prompted about this session.

**Data flow**: Takes `Session`, `TurnContext`, a `CancellationToken`, the slice of `mentioned_skills`, and optional `ElicitationReviewerHandle`. It reads the current originator and feature flags, clones config, fetches installed runtime MCP servers from the session, computes missing dependencies with `collect_missing_mcp_dependencies`, filters them through `filter_prompted_mcp_dependencies`, and if `should_install_mcp_dependencies` returns true, calls `maybe_install_mcp_dependencies` with the original skill list.

**Call relations**: Called from skill-building flow when skills have been identified. It delegates dependency discovery to `collect_missing_mcp_dependencies`, user prompting to `should_install_mcp_dependencies`, and actual persistence/login/refresh work to `maybe_install_mcp_dependencies`.

*Call graph*: calls 6 internal fn (collect_missing_mcp_dependencies, filter_prompted_mcp_dependencies, maybe_install_mcp_dependencies, should_install_mcp_dependencies, is_first_party_originator, originator); called by 1 (build_skills_and_plugins); 2 external calls (is_empty, runtime_mcp_servers).


##### `maybe_install_mcp_dependencies`  (lines 81–211)

```
async fn maybe_install_mcp_dependencies(
    sess: &Session,
    turn_context: &TurnContext,
    config: &crate::config::Config,
    mentioned_skills: &[SkillMetadata],
    elicitation_reviewer: Optio
```

**Purpose**: Installs missing MCP server configs for mentioned skills into global config, performs OAuth login for newly added servers when supported, and refreshes the session’s MCP server set. It is the side-effecting half of the dependency flow.

**Data flow**: Inputs are `Session`, `TurnContext`, `config`, `mentioned_skills`, and optional elicitation reviewer. It rechecks feature gating, computes installed and missing dependencies, loads global MCP servers from `codex_home`, inserts absent missing servers into that map while tracking which were newly added, persists the updated map with `ConfigEditsBuilder`, then for each added server probes `oauth_login_support`, resolves scopes, attempts `perform_oauth_login`, optionally retries without scopes, and logs failures. Afterward it clones `config`, merges the persisted servers into `refresh_config.mcp_servers`, computes refreshed runtime servers, and calls `sess.refresh_mcp_servers_now(...)`.

**Call relations**: Invoked only after prompting logic decides installation should proceed. It depends on `collect_missing_mcp_dependencies` for the desired additions, `load_global_mcp_servers` and `ConfigEditsBuilder` for persistence, and session refresh APIs to make the new servers active immediately.

*Call graph*: calls 2 internal fn (new, collect_missing_mcp_dependencies); called by 1 (maybe_prompt_and_install_mcp_dependencies); 12 external calls (new, auth_keyring_backend_kind, clone, is_empty, load_global_mcp_servers, oauth_login_support, resolve_oauth_scopes, should_retry_without_scopes, perform_oauth_login, refresh_mcp_servers_now (+2 more)).


##### `should_install_mcp_dependencies`  (lines 213–287)

```
async fn should_install_mcp_dependencies(
    sess: &Session,
    turn_context: &TurnContext,
    missing: &HashMap<String, McpServerConfig>,
    cancellation_token: &CancellationToken,
) -> bool
```

**Purpose**: Determines whether missing skill MCP dependencies should be installed now, either by auto-approval policy or by explicit user choice. It also records that the current missing set has been prompted about.

**Data flow**: Accepts `Session`, `TurnContext`, the `missing` dependency map, and a `CancellationToken`. It first checks `mcp_permission_prompt_is_auto_approved`; if true, returns `true`. Otherwise it formats the missing server names, builds a single `RequestUserInputQuestion` with Install/Continue-anyway options, sends `request_user_input`, and races that future against cancellation with `tokio::select!`. It interprets the response to decide whether Install was chosen, computes canonical keys for all missing dependencies, records them via `sess.record_mcp_dependency_prompted`, and returns the boolean install decision.

**Call relations**: Called by `maybe_prompt_and_install_mcp_dependencies` after missing dependencies are filtered. It delegates display formatting to `format_missing_mcp_dependencies` and uses session prompting APIs to obtain or synthesize a response.

*Call graph*: calls 2 internal fn (format_missing_mcp_dependencies, permission_profile); called by 1 (maybe_prompt_and_install_mcp_dependencies); 7 external calls (default, mcp_permission_prompt_is_auto_approved, record_mcp_dependency_prompted, request_user_input, format!, select!, vec!).


##### `filter_prompted_mcp_dependencies`  (lines 289–303)

```
async fn filter_prompted_mcp_dependencies(
    sess: &Session,
    missing: &HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig>
```

**Purpose**: Removes missing dependencies that the session has already prompted the user about. This prevents repeated prompts for the same canonical MCP server within one session.

**Data flow**: Takes `Session` and the `missing` map, awaits `sess.mcp_dependency_prompted()` to get the set of canonical keys, and if that set is empty returns `missing.clone()`. Otherwise it filters `missing` by recomputing each dependency’s canonical server key and collecting only entries not present in the prompted set.

**Call relations**: Used by `maybe_prompt_and_install_mcp_dependencies` between dependency discovery and prompting. It relies on the same canonicalization logic as installation and prompt recording so repeated names map consistently.

*Call graph*: called by 1 (maybe_prompt_and_install_mcp_dependencies); 1 external calls (mcp_dependency_prompted).


##### `format_missing_mcp_dependencies`  (lines 305–309)

```
fn format_missing_mcp_dependencies(missing: &HashMap<String, McpServerConfig>) -> String
```

**Purpose**: Formats the missing dependency names into a stable, human-readable comma-separated list for the prompt text. It sorts names to keep prompt wording deterministic.

**Data flow**: Accepts `&HashMap<String, McpServerConfig>`, clones the keys into a `Vec<String>`, sorts them, joins them with `", "`, and returns the resulting `String`.

**Call relations**: Called only by `should_install_mcp_dependencies` to build the user-facing prompt sentence.

*Call graph*: called by 1 (should_install_mcp_dependencies).


##### `canonical_mcp_key`  (lines 311–318)

```
fn canonical_mcp_key(transport: &str, identifier: &str, fallback: &str) -> String
```

**Purpose**: Builds a canonical key string for an MCP server or dependency from transport type and transport-specific identifier. It falls back to a provided name when the identifier is blank.

**Data flow**: Takes `transport`, `identifier`, and `fallback` strings. It trims `identifier`; if empty it returns `fallback.to_string()`, otherwise it returns `format!("mcp__{transport}__{identifier}")`.

**Call relations**: This is the shared primitive used by both `canonical_mcp_server_key` and `canonical_mcp_dependency_key` so installed servers and skill dependencies normalize to the same namespace.

*Call graph*: called by 2 (canonical_mcp_dependency_key, canonical_mcp_server_key); 1 external calls (format!).


##### `canonical_mcp_server_key`  (lines 320–329)

```
fn canonical_mcp_server_key(name: &str, config: &McpServerConfig) -> String
```

**Purpose**: Computes the canonical identity key for an installed `McpServerConfig` based on its transport details. It lets installed servers be compared against skill dependency declarations independent of display name.

**Data flow**: Accepts a server `name` and `config`. For `McpServerTransportConfig::Stdio` it uses the command string with transport `stdio`; for `StreamableHttp` it uses the URL with transport `streamable_http`; both cases delegate to `canonical_mcp_key` and return the resulting `String`.

**Call relations**: Used when building the installed-key set in `collect_missing_mcp_dependencies` and when recording prompted dependencies. It mirrors the dependency-side canonicalization logic.

*Call graph*: calls 1 internal fn (canonical_mcp_key).


##### `canonical_mcp_dependency_key`  (lines 331–348)

```
fn canonical_mcp_dependency_key(dependency: &SkillToolDependency) -> Result<String, String>
```

**Purpose**: Computes the canonical identity key for a skill-declared MCP dependency. It validates that the dependency includes the transport-specific field required for its transport.

**Data flow**: Takes a `SkillToolDependency`, reads `dependency.transport` defaulting to `streamable_http`, and branches case-insensitively. For HTTP it requires `dependency.url`; for stdio it requires `dependency.command`; each successful branch delegates to `canonical_mcp_key` using `dependency.value` as fallback. Unsupported transports or missing required fields return `Err(String)`.

**Call relations**: Called by `collect_missing_mcp_dependencies` before deduplication and installation decisions. Its output must align with `canonical_mcp_server_key` so installed and declared dependencies compare correctly.

*Call graph*: calls 1 internal fn (canonical_mcp_key); called by 1 (collect_missing_mcp_dependencies); 1 external calls (format!).


##### `mcp_dependency_to_server_config`  (lines 350–414)

```
fn mcp_dependency_to_server_config(
    dependency: &SkillToolDependency,
) -> Result<McpServerConfig, String>
```

**Purpose**: Converts a skill-declared MCP dependency into a concrete `McpServerConfig` suitable for insertion into global config. It fills in sensible defaults for all non-transport fields.

**Data flow**: Accepts a `SkillToolDependency`, defaults transport to `streamable_http`, and constructs either a `McpServerTransportConfig::StreamableHttp` using the declared URL or a `McpServerTransportConfig::Stdio` using the declared command. In both cases it returns an enabled `McpServerConfig` with default environment ID, no OAuth/scopes/tool filters, empty `tools`, and unset timeout/approval fields. Missing required URL/command or unsupported transport returns `Err(String)`.

**Call relations**: Used by `collect_missing_mcp_dependencies` after canonicalization succeeds. It translates declarative skill metadata into the persisted config objects that `maybe_install_mcp_dependencies` writes to disk.

*Call graph*: called by 1 (collect_missing_mcp_dependencies); 3 external calls (new, new, format!).


##### `collect_missing_mcp_dependencies`  (lines 416–471)

```
fn collect_missing_mcp_dependencies(
    mentioned_skills: &[SkillMetadata],
    installed: &HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig>
```

**Purpose**: Scans mentioned skills for MCP tool dependencies, removes ones already installed or duplicated, and returns the remaining dependencies as installable server configs keyed by dependency display name. It is the module’s dependency discovery engine.

**Data flow**: Inputs are `mentioned_skills` and the currently `installed` server map. It builds `installed_keys` by canonicalizing each installed server, initializes `missing` and `seen_canonical_keys`, then iterates skills, skips those without dependencies, iterates dependency tools, ignores non-`mcp` tool types, computes each dependency’s canonical key, logs and skips malformed declarations, skips already installed or already seen canonical keys, converts the dependency to `McpServerConfig`, logs and skips conversion failures, and finally inserts `tool.value.clone()` mapped to the config into `missing` while recording the canonical key as seen. Returns the `HashMap<String, McpServerConfig>`.

**Call relations**: Called by both `maybe_prompt_and_install_mcp_dependencies` and `maybe_install_mcp_dependencies`. It depends on `canonical_mcp_dependency_key` and `mcp_dependency_to_server_config` to normalize and materialize dependencies, and it is the source of truth for what counts as 'missing'.

*Call graph*: calls 2 internal fn (canonical_mcp_dependency_key, mcp_dependency_to_server_config); called by 2 (maybe_install_mcp_dependencies, maybe_prompt_and_install_mcp_dependencies); 3 external calls (new, new, warn!).
