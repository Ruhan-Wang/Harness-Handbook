# MCP runtime, resources, and session integration  `stage-14.3.1`

This stage is the bridge between Codex and MCP, the Model Context Protocol, which lets outside programs offer tools, files, and other resources to the assistant. It is mostly behind-the-scenes support used during session startup and the main work loop. The app-server and ext/mcp files register MCP as an extension, discover MCP servers from plugins, and pass extension events to the right client. The codex-mcp library defines what an MCP server is, builds usable server configs, supports hosted Codex Apps, and keeps user app-tool caches separate. Its connection manager is the switchboard: it starts servers, checks readiness, collects tools and resources, and routes calls. Resource clients and handlers let the model list templates, list resources, and read one resource in a consistent way. Tool preparation code filters and renames tools, limits what the model sees, adapts file inputs, and uploads local files when a tool expects hosted files. Tool-call code checks permissions, asks for approval, records results, and reports back. Session and skill-dependency code connect MCP servers to each user session, refresh them when needed, and handle login prompts safely.

## Files in this stage

### Extension registration
These files register MCP-backed extensions and load executor-plugin server declarations before the runtime is used elsewhere.

### `app-server/src/extensions.rs`

`orchestration` · `startup and extension event handling`

Extensions are optional pieces of capability, such as goals, guardian agents, memory, web search, image generation, MCP tools, and skills. This file is the app server's switchboard for those pieces. Without it, those extensions would not be registered with the server, and events coming from extensions would not reliably reach the user interface or the active thread stream.

The main setup function builds an extension registry. A registry is like a list of plug-ins the server knows how to use. It receives shared dependencies such as authentication, analytics, the thread manager, the environment manager, and skill providers. Some extensions are always installed. The goals extension is installed only when a state database is available, and it also checks the runtime feature flag before enabling goal behavior.

The file also defines an event sink. An event sink is a place where extensions send updates. The important supported event here is a thread goal update. If a live listener exists for that thread, the update is sent into that listener's command queue so ordering is preserved. If there is no listener, the update is sent as a normal server notification instead. Unsupported extension events are intentionally ignored, with a debug log.

Finally, the file provides a small adapter that lets the guardian extension start subagents through the thread manager.

#### Function details

##### `thread_extensions`  (lines 44–94)

```
fn thread_extensions(
    guardian_agent_spawner: S,
    dependencies: ThreadExtensionDependencies,
) -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Builds the app server's extension registry: the collection of plug-ins the server can use for goals, guardian agents, memory, MCP, web search, image generation, and skills. It gathers the shared services each extension needs and installs them in one place.

**Data flow**: It receives a guardian agent spawner and a bundle of dependencies, including authentication, analytics, state storage, thread access, environment access, skill providers, and an event sink. It creates a registry builder, conditionally adds the goals extension if a state database is present, then adds the other extensions and their configuration hooks. It returns a shared, finished extension registry wrapped in an Arc, meaning many parts of the server can safely hold a reference to it.

**Call relations**: This is the setup hub for extensions. During server startup, higher-level server construction code calls it to assemble the registry. It hands the registry builder to each extension's install function, so each extension can add its own behavior. The event sink supplied here is what later lets extensions report updates back into the app server.

*Call graph*: calls 2 internal fn (new, new); 11 external calls (new, with_event_sink, install_with_backend, install, install, install, install_executor_plugins, install, global, install_with_providers (+1 more)).


##### `app_server_extension_event_sink`  (lines 96–104)

```
fn app_server_extension_event_sink(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
) -> Arc<dyn ExtensionEventSink>
```

**Purpose**: Creates the app server's event sink for extensions. Extensions use this object as their mailbox for reporting events back to the server.

**Data flow**: It receives an outgoing message sender and a thread state manager. It stores both inside an AppServerExtensionEventSink and returns it as a shared ExtensionEventSink object, hiding the concrete type behind the interface extensions expect.

**Call relations**: This is called when wiring the extension system together, and the test in this file calls it directly to verify behavior. The sink it creates is later used by extensions when they emit events, which are processed by AppServerExtensionEventSink::emit.

*Call graph*: called by 1 (app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears); 1 external calls (new).


##### `AppServerExtensionEventSink::emit`  (lines 112–150)

```
fn emit(&self, event: Event)
```

**Purpose**: Receives an event from an extension and decides how the app server should deliver it. Its main job is to preserve the right order for thread goal updates when a live thread listener is active.

**Data flow**: It takes an extension event. If the event says a thread goal changed, it extracts the thread id, turn id, and goal data, then looks for the current listener command channel for that thread. If a listener exists and accepts the message, it sends a ThreadListenerCommand into that listener queue and stops. If no listener is available, or the listener channel is closed, it starts an asynchronous task that sends a ThreadGoalUpdated server notification through the outgoing message sender. If the event is not a supported kind, it logs that the event was dropped.

**Call relations**: Extensions call this method when they have something to report. For goal updates, it first tries to hand the update to ThreadStateManager's current listener queue, because that keeps the update in order with other thread-stream messages. If that route is unavailable, it falls back to OutgoingMessageSender so the client still receives a notification.

*Call graph*: calls 1 internal fn (current_listener_command_tx); 5 external calls (clone, ThreadGoalUpdated, spawn, debug!, warn!).


##### `guardian_agent_spawner`  (lines 153–169)

```
fn guardian_agent_spawner(
    thread_manager: Weak<ThreadManager>,
) -> impl AgentSpawner<StartThreadOptions, Spawned = NewThread, Error = CodexErr>
```

**Purpose**: Creates an adapter that lets the guardian extension start a subagent through the server's ThreadManager. A subagent is a new thread-like worker started from an existing thread.

**Data flow**: It receives a weak reference to the ThreadManager, which means it does not keep the manager alive by itself. The returned spawner is later given a source thread id and start options. When used, it tries to upgrade the weak reference into a live ThreadManager. If the manager is gone, it returns an error. If it is still available, it asks the manager to spawn the subagent and returns the newly created thread result.

**Call relations**: thread_extensions passes this spawner into the guardian extension during installation. Later, when the guardian extension needs to start an agent, it uses this adapter instead of knowing ThreadManager details directly. This keeps guardian code separated from the app server's thread implementation.


##### `tests::app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears`  (lines 185–229)

```
async fn app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears()
```

**Purpose**: Checks that goal update events are delivered through the live listener queue, and that their order is preserved. This matters because the user interface may receive several thread-related messages in sequence, and goal changes should not jump ahead or fall behind incorrectly.

**Data flow**: The test creates a fake outgoing sender, a fresh thread state manager, a thread id, and a listener command channel. It registers the listener channel for that thread, builds the event sink, then emits two goal update events and manually sends a goal-cleared command into the same queue. It reads three commands back from the queue and confirms they arrive as turn-1, turn-2, then cleared.

**Call relations**: This test calls app_server_extension_event_sink to build the same kind of sink used by the real server. It then drives AppServerExtensionEventSink::emit with sample goal update events made by tests::thread_goal_updated_event. The test proves that emit prefers the listener command channel over the fallback outgoing notification path.

*Call graph*: calls 5 internal fn (disabled, app_server_extension_event_sink, new, new, default); 9 external calls (new, from_secs, new, thread_goal_updated_event, assert_eq!, channel, unbounded_channel, panic!, timeout).


##### `tests::thread_goal_updated_event`  (lines 231–249)

```
fn thread_goal_updated_event(thread_id: ThreadId, turn_id: &str) -> Event
```

**Purpose**: Builds a sample thread goal update event for the test. It keeps the test readable by hiding the detailed event fields in one helper.

**Data flow**: It receives a thread id and a turn id string. It creates an Event whose message is ThreadGoalUpdated, filling in a sample active goal with objective text, token counts, timing, and timestamps. It returns that event to the caller.

**Call relations**: The ordering test calls this helper twice to create two distinct goal update events. Those events are then passed to the event sink, exercising the same branch of AppServerExtensionEventSink::emit that real extension goal updates would use.

*Call graph*: 1 external calls (ThreadGoalUpdated).


### `ext/mcp/src/lib.rs`

`orchestration` · `startup and MCP server discovery`

MCP means Model Context Protocol, a way for the app to talk to extra tool servers in a standard shape. This file is like a small switchboard: it registers pieces that can add or remove MCP servers depending on the current configuration.

The first piece, `HostedPluginRuntimeExtension`, contributes the hosted plugin runtime server. It checks the app configuration to see whether the Apps feature is turned on. If Apps are off, it tells the system to remove the MCP server with the standard Codex Apps server name. If Apps are on, it builds a server configuration using the ChatGPT base URL and an optional product SKU, then tells the registry to set that server up.

The public `install` function adds this contributor to the extension registry so the rest of the program can ask it for MCP server contributions later. The file also exposes two helper functions for executor plugins, which are plugins selected for a particular thread of work. One function registers their MCP discovery contributor, and the other seeds per-thread data so that discovery can know which executor plugins are active. Without this file, the app would not reliably add, update, or remove these MCP servers based on feature flags and selected plugins.

#### Function details

##### `HostedPluginRuntimeExtension::id`  (lines 15–17)

```
fn id(&self) -> &'static str
```

**Purpose**: This gives the hosted plugin runtime contributor a stable name. The name lets the extension system identify which contributor is speaking.

**Data flow**: Nothing is taken in beyond the contributor itself. It returns the fixed text identifier `hosted_plugin_runtime`, and it does not change any state.

**Call relations**: The extension registry can ask this contributor for its identity when organizing MCP server contributors. It is the simple name tag used before the more important contribution step happens.


##### `HostedPluginRuntimeExtension::contribute`  (lines 19–38)

```
fn contribute(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>>
```

**Purpose**: This decides what should happen to the hosted plugin runtime MCP server for the current configuration. It either removes the server when Apps are disabled, or provides the server settings when Apps are enabled.

**Data flow**: It receives a contribution context and reads the app configuration from it. It builds the standard MCP server name, checks whether the Apps feature is enabled, and then returns a future that produces a list of contributions: either a removal instruction or a set-this-server-up instruction with a generated server configuration.

**Call relations**: The extension system calls this when collecting MCP server definitions. Inside that moment, this function reads configuration, chooses the correct action, and hands back the contribution list that the registry will use to update the available MCP servers.

*Call graph*: calls 1 internal fn (config); 2 external calls (pin, vec!).


##### `install`  (lines 41–43)

```
fn install(builder: &mut ExtensionRegistryBuilder<Config>)
```

**Purpose**: This registers the hosted plugin runtime MCP contributor with the extension registry. Someone uses it during setup so the contributor is available later when MCP servers are gathered.

**Data flow**: It receives a mutable registry builder. It creates a shared pointer to `HostedPluginRuntimeExtension` and adds it to the builder, changing the builder so it now knows about this MCP server contributor.

**Call relations**: Startup code calls this while assembling the extension system. After this registration, the registry can later call `HostedPluginRuntimeExtension::id` and `HostedPluginRuntimeExtension::contribute` when it needs the MCP server list.

*Call graph*: calls 1 internal fn (mcp_server_contributor); 1 external calls (new).


##### `install_executor_plugins`  (lines 46–53)

```
fn install_executor_plugins(
    builder: &mut ExtensionRegistryBuilder<Config>,
    environment_manager: std::sync::Arc<codex_exec_server::EnvironmentManager>,
)
```

**Purpose**: This registers MCP discovery for executor plugins selected for a thread of work. It connects the extension registry to an environment manager so plugin-provided MCP servers can be found when needed.

**Data flow**: It receives a mutable registry builder and a shared environment manager. It creates a `SelectedExecutorPluginMcpContributor` using that environment manager, wraps it in a shared pointer, and adds it to the builder, changing the builder so it can discover MCP servers from selected executor plugins.

**Call relations**: Setup code calls this alongside other extension installation steps. From then on, when the registry gathers MCP server contributions, it can call into the executor-plugin contributor created here; that contributor uses the environment manager to understand the runtime environment for the selected plugins.

*Call graph*: calls 2 internal fn (mcp_server_contributor, new); 1 external calls (new).


##### `initialize_executor_plugin_thread_data`  (lines 56–60)

```
fn initialize_executor_plugin_thread_data(
    thread_init: &mut codex_extension_api::ExtensionDataInit,
)
```

**Purpose**: This prepares the per-thread data used to discover MCP servers from selected executor plugins. In plain terms, it puts the right starting information into a thread-specific snapshot before discovery happens.

**Data flow**: It receives an extension data initializer. It passes that initializer to `executor_plugin::seed_thread_state`, which fills in the thread-local starting state needed later; the function itself returns nothing.

**Call relations**: Thread setup code calls this before executor-plugin MCP discovery depends on thread-specific information. It hands off the actual seeding work to `seed_thread_state`, so the contributor installed by `install_executor_plugins` can later read a prepared snapshot instead of starting from empty data.

*Call graph*: calls 1 internal fn (seed_thread_state).


### `ext/mcp/src/executor_plugin/provider.rs`

`domain_logic` · `plugin resolution / config load`

Executor plugins can declare extra MCP servers. MCP, or Model Context Protocol, is a way for tools and services to expose capabilities to the main application. This file is the small bridge between a selected plugin and those MCP declarations.

The provider first finds the plugin's MCP config file. If the plugin manifest names a specific file, it uses that. Otherwise it looks for a default file called `.mcp.json` in the plugin root. If that default file is missing, that is treated as normal: the plugin simply has no MCP servers.

When a file is found, the provider reads it through the executor's file system, not directly from the host disk. That matters because executor plugins may live inside a controlled environment, and the executor knows how to read from that environment safely. The file contents are then parsed as plugin MCP configuration, with paths interpreted relative to the plugin root and tagged as belonging to the plugin's environment.

Invalid individual server entries are not fatal. They are logged as warnings and skipped, like ignoring one bad line in a larger address book. However, failing to read the chosen config file or failing to parse the overall JSON produces a clear error that includes the plugin id and path. Finally, the file filters the parsed servers so only stdio transports remain; HTTP MCP servers are warned about and ignored.

#### Function details

##### `ExecutorPluginMcpProvider::load`  (lines 42–49)

```
async fn load(
        &self,
        plugin: &ResolvedExecutorPlugin,
    ) -> Result<Vec<(String, McpServerConfig)>, ExecutorPluginMcpProviderError>
```

**Purpose**: Loads the MCP server declarations for one resolved executor plugin. It is the public-facing method for this provider inside the module, giving callers a list of usable server names and configurations.

**Data flow**: It receives a resolved executor plugin. From that plugin it reads the plugin location, the plugin metadata, and the executor-owned file system. It then passes those pieces to the lower-level loader. The result is either a list of stdio MCP server configurations or an error explaining why the plugin's MCP config could not be read or parsed.

**Call relations**: This function is called during snapshot resolution, when the system is gathering the plugin-provided resources that should be active. It does not do the detailed file lookup itself; after getting the plugin root and file system, it hands the real work to `load_from_file_system`.

*Call graph*: calls 3 internal fn (file_system, plugin, load_from_file_system); called by 1 (resolve_snapshot).


##### `load_from_file_system`  (lines 52–116)

```
async fn load_from_file_system(
    plugin: &ResolvedPlugin,
    plugin_root: &AbsolutePathBuf,
    file_system: &dyn ExecutorFileSystem,
) -> Result<Vec<(String, McpServerConfig)>, ExecutorPluginMcpP
```

**Purpose**: Reads, parses, and filters one plugin's MCP configuration file. It is where the file decides which MCP servers from a plugin are valid for executor use.

**Data flow**: It takes a resolved plugin, the plugin's root directory, and an executor file system. It chooses the MCP config path from the plugin manifest, or falls back to `.mcp.json` under the plugin root. It converts that path into a URI, reads the text through the executor file system, parses the JSON as plugin MCP configuration, logs and skips invalid entries, removes HTTP-based servers, and returns only the accepted stdio server configurations. If the chosen file cannot be read, or the JSON cannot be parsed, it returns an error with the plugin id and path.

**Call relations**: This helper is called by `ExecutorPluginMcpProvider::load` after that method has unpacked the resolved plugin. Inside the larger flow, it sits between plugin resolution and MCP server startup: it turns a plugin's declared config file into the concrete server configs that later code can launch or connect to.

*Call graph*: calls 7 internal fn (read_file_text, location, manifest, selected_root_id, as_path, join, from_abs_path); called by 1 (load); 3 external calls (new, parse_plugin_mcp_config, warn!).


### MCP runtime foundation
These files define the MCP crate surface, runtime server/config models, Apps-specific behavior, connection management, and the session-scoped resource client built on top of refreshed managers.

### `codex-mcp/src/lib.rs`

`other` · `cross-cutting API surface`

This file does not contain the main MCP logic itself. Instead, it acts like a reception desk or public index for the crate. MCP stands for Model Context Protocol, a way for the system to talk to external tools, resources, and servers in a structured way. The real work lives in smaller modules such as connection management, server configuration, resource reading, authentication prompts, OAuth login support, tool metadata, and Codex Apps integration.

The important job here is to re-export selected names from those internal modules. In Rust, re-exporting means making something available from this crate’s top level, so callers can write a simpler import path instead of knowing the exact internal file layout. For example, outside code can use public types like McpConnectionManager, McpConfig, ResolvedMcpServer, or McpResourceClient without caring which module defines them.

The file also declares which modules exist and which are public only inside this crate. Some modules are kept private, meaning their details can change without breaking outside users. Without this file, the rest of the project would either have to know the library’s internal structure or would be unable to access the MCP features at all. It is mainly about keeping the public API tidy and stable.


### `codex-mcp/src/server.rs`

`data_model` · `server setup and later request/tool handling`

An MCP server is an external tool server that Codex can talk to. This file is like the label and instruction card attached to each such server: it says how the server should be started, whether it is active, and what safety rules apply when its tools are used.

The central type is `EffectiveMcpServer`. It wraps the final launch plan for a server. Right now that launch plan is a configured server from the user or app configuration, but the wrapper leaves room for runtime-added kinds later.

The file also records the server's transport origin. A transport is the way Codex talks to the server. For a local process using standard input and output, the origin is simply `stdio`. For an HTTP server, the code parses the URL and stores only the origin, such as scheme, host, and port. That is useful for metrics and diagnostics without keeping unnecessary URL details.

Finally, `McpServerMetadata` stores facts that must survive after the server has been launched. This includes whether the server can affect memory, whether it supports parallel tool calls, and which tool approval policy applies. Tool approval can be set per tool, or fall back to a default, or finally to the normal default if nothing was configured.

#### Function details

##### `EffectiveMcpServer::configured`  (lines 20–24)

```
fn configured(config: McpServerConfig) -> Self
```

**Purpose**: Creates an `EffectiveMcpServer` from a server configuration. Someone uses this when a server from configuration needs to become the runtime version that the rest of the MCP system works with.

**Data flow**: It takes a `McpServerConfig`, puts it inside the `Configured` launch plan, and returns a new `EffectiveMcpServer` containing that plan. The original configuration becomes owned by the new server object.

**Call relations**: Tests call this when they need a realistic configured MCP server, such as checking behavior around local runtime failures or tool approval metadata. Later code can inspect the object through methods like `launch` or convert it into metadata.

*Call graph*: called by 2 (no_local_runtime_fails_local_stdio_but_keeps_local_http_server, server_metadata_preserves_tool_approval_policy); 2 external calls (new, Configured).


##### `EffectiveMcpServer::launch`  (lines 26–28)

```
fn launch(&self) -> &McpServerLaunch
```

**Purpose**: Gives internal code access to the server's launch plan. This is used when another part of the system needs to know how to actually start or interpret the server.

**Data flow**: It reads the `launch` field from the `EffectiveMcpServer` and returns a shared reference to it. Nothing is copied or changed.

**Call relations**: The MCP client creation path calls this when deciding how to connect to or start the server. The metadata conversion also calls it so it can copy the important long-lived facts from the launch configuration.

*Call graph*: called by 2 (make_rmcp_client, from).


##### `EffectiveMcpServer::configured_config`  (lines 30–34)

```
fn configured_config(&self) -> Option<&McpServerConfig>
```

**Purpose**: Returns the original configuration if this effective server came from configuration. This is a safe way for setup code to look back at the configured details without assuming every future server type will be configured.

**Data flow**: It checks the launch plan. If it is `Configured`, it returns a shared reference to the stored `McpServerConfig`; otherwise it would return `None`, though the current code only has the configured case.

**Call relations**: Server setup code calls this while building or registering MCP servers. It keeps callers from reaching directly into the internal launch enum.

*Call graph*: called by 1 (new).


##### `EffectiveMcpServer::enabled`  (lines 36–40)

```
fn enabled(&self) -> bool
```

**Purpose**: Answers whether this server is turned on. This lets higher-level code skip servers that exist in configuration but should not be used.

**Data flow**: It looks inside the configured server settings and returns the `enabled` flag. It does not change the server.

**Call relations**: This is a simple query method meant for orchestration code that decides which effective MCP servers should participate in a run.


##### `EffectiveMcpServer::required`  (lines 42–46)

```
fn required(&self) -> bool
```

**Purpose**: Answers whether this server is required for the run. A required server is one whose failure may need to be treated more seriously than an optional server.

**Data flow**: It looks inside the configured server settings and returns the `required` flag. It does not change anything.

**Call relations**: This supports startup and error-handling decisions elsewhere in the MCP flow, where the program may need to distinguish optional helper servers from required ones.


##### `McpServerOrigin::as_str`  (lines 57–62)

```
fn as_str(&self) -> &str
```

**Purpose**: Turns a stored server origin into plain text. This is useful for logging, metrics, or diagnostics where the origin needs to be reported.

**Data flow**: It reads the origin value. For a standard-input/output server it returns the fixed text `stdio`; for an HTTP server it returns the stored origin string.

**Call relations**: Other diagnostic or reporting code can call this after metadata has preserved the origin. It does not start servers or parse anything; it only presents the already-stored value.


##### `McpServerOrigin::from_transport`  (lines 64–72)

```
fn from_transport(transport: &McpServerTransportConfig) -> Option<Self>
```

**Purpose**: Extracts a compact origin from the server's transport configuration. In plain terms, it records where the server is reached from without keeping the whole connection description.

**Data flow**: It takes a transport configuration. If the transport is HTTP, it parses the URL and returns the URL origin, such as protocol plus host and port; if parsing fails, it returns `None`. If the transport is standard input/output, it returns the `Stdio` origin.

**Call relations**: The metadata-building function calls this while converting an effective server into long-lived metadata. It hands back just enough origin information for later metrics and diagnostics.

*Call graph*: called by 1 (from); 2 external calls (StreamableHttp, parse).


##### `McpServerMetadata::tool_approval_mode`  (lines 86–92)

```
fn tool_approval_mode(&self, tool_name: &str) -> AppToolApproval
```

**Purpose**: Finds the approval rule for a specific tool on this MCP server. This matters because some tools may need explicit user approval, while others may follow a default policy.

**Data flow**: It receives a tool name, checks whether that exact tool has its own approval mode, and returns it if found. If not, it returns the server-wide default approval mode. If neither is set, it returns the normal default approval value.

**Call relations**: Tool-calling code can use this when deciding whether a requested MCP tool call is allowed immediately or needs approval. It turns the stored policy map into a single clear answer for one tool.


##### `McpServerMetadata::from`  (lines 96–114)

```
fn from(server: &EffectiveMcpServer) -> Self
```

**Purpose**: Builds the long-lived metadata record for an effective MCP server. This copies the facts that still matter after launch, so later code does not need to keep digging through the original configuration.

**Data flow**: It receives an `EffectiveMcpServer`, reads its launch configuration, and creates a `McpServerMetadata` value. It sets memory-pollution behavior, extracts the transport origin, copies the parallel-tool-call setting, copies the default tool approval mode, and builds a map of per-tool approval modes from the configured tools.

**Call relations**: Server setup code and tests call this when they need the runtime metadata attached to a server. Inside, it calls `EffectiveMcpServer::launch` to inspect the launch plan and `McpServerOrigin::from_transport` to preserve the server's origin in a compact form.

*Call graph*: calls 2 internal fn (launch, from_transport); called by 2 (new, server_metadata_preserves_tool_approval_policy).


### `codex-mcp/src/codex_apps.rs`

`domain_logic` · `startup and MCP tool refresh`

Codex Apps are exposed to the model through MCP, the Model Context Protocol, which is a way for the host to offer tools and resources to the model. This file is the bridge for the special “Codex Apps” MCP server. Without it, the system could show stale or unsafe tools, mix one user's cached tools with another user's tools, or expose awkward connector-prefixed names to the model.

The file does three main jobs. First, it builds a cache key from the signed-in user’s identity. That key is hashed and used as part of the disk filename, like putting each user's papers into a separate labeled folder without exposing the label itself. Second, it reads and writes two JSON cache files: one for the available tools, and one for MCP server information. Each cache includes a schema version, so old cache formats can be ignored safely instead of being misread. Third, it cleans up Codex Apps tool names. Connector names and IDs can be embedded in raw tool names; the normalization functions remove those prefixes and sanitize names so they are safe and predictable for model-visible calls.

A safety check runs both when saving and loading tools: tools from connector IDs that are not allowed are removed. This means even an old disk cache cannot reintroduce a connector that policy no longer permits.

#### Function details

##### `codex_apps_tools_cache_key`  (lines 32–38)

```
fn codex_apps_tools_cache_key(auth: Option<&CodexAuth>) -> CodexAppsToolsCacheKey
```

**Purpose**: Builds the user-specific key used to separate Codex Apps tool caches. It records the account ID, ChatGPT user ID, and whether the account is a workspace account when authentication information is available.

**Data flow**: It receives optional authentication details. It pulls out the user and account identifiers it can find, plus the workspace-account flag, and returns a small cache-key object. If there is no authentication, the fields that depend on it are empty or false.

**Call relations**: Other parts of the MCP flow call this when they need a cache identity, such as while collecting server status or reading MCP resources. The returned key is later used by the cache context to decide which disk file belongs to this user.

*Call graph*: called by 2 (collect_mcp_server_status_snapshot_with_detail, read_mcp_resource).


##### `CodexAppsToolsCacheContext::tools_cache_path`  (lines 47–49)

```
fn tools_cache_path(&self) -> PathBuf
```

**Purpose**: Returns the disk path where this user's Codex Apps tool list should be cached. This keeps callers from needing to know the cache directory layout.

**Data flow**: It reads the cache context, which contains the Codex home directory and user cache key. It asks the shared path-building helper to place the file under the tools-cache directory, then returns that path.

**Call relations**: Tool cache loading and writing call this before touching the filesystem. It hands the path-building work to `CodexAppsToolsCacheContext::cache_path_in` so tools and server-info caches use the same naming scheme.

*Call graph*: calls 1 internal fn (cache_path_in); called by 2 (load_cached_codex_apps_tools, write_cached_codex_apps_tools).


##### `CodexAppsToolsCacheContext::server_info_cache_path`  (lines 51–53)

```
fn server_info_cache_path(&self) -> PathBuf
```

**Purpose**: Returns the disk path where this user's Codex Apps MCP server information should be cached. It mirrors the tool-cache path logic, but uses a separate cache directory.

**Data flow**: It reads the same cache context used for tools. It passes the server-info cache directory name to the shared helper and returns the resulting user-specific JSON file path.

**Call relations**: Server-info cache loading and writing call this before reading or writing. Like the tools path function, it delegates the shared hashing and path assembly to `CodexAppsToolsCacheContext::cache_path_in`.

*Call graph*: calls 1 internal fn (cache_path_in); called by 2 (load_cached_codex_apps_server_info, write_cached_codex_apps_server_info).


##### `CodexAppsToolsCacheContext::cache_path_in`  (lines 55–61)

```
fn cache_path_in(&self, cache_dir: &str) -> PathBuf
```

**Purpose**: Builds a stable, user-specific cache file path inside a chosen cache directory. It hides the raw user details by hashing them before using them in the filename.

**Data flow**: It takes a cache directory name, serializes the user cache key to JSON, hashes that JSON into a short hexadecimal string, and joins the Codex home directory, cache directory, and hash-based filename into one path.

**Call relations**: `tools_cache_path` and `server_info_cache_path` both call this so the two caches are scoped in exactly the same way. It calls `sha1_hex` to turn the serialized user key into the filename-safe hash.

*Call graph*: calls 1 internal fn (sha1_hex); called by 2 (server_info_cache_path, tools_cache_path); 3 external calls (join, format!, to_string).


##### `normalize_codex_apps_tool_title`  (lines 70–94)

```
fn normalize_codex_apps_tool_title(
    server_name: &str,
    connector_name: Option<&str>,
    value: &str,
) -> String
```

**Purpose**: Cleans up the human-facing title of a Codex Apps tool by removing a connector-name prefix when it is present. For non-Codex-Apps servers, it leaves the title unchanged.

**Data flow**: It receives a server name, optional connector name, and title value. If the server is the Codex Apps MCP server and the connector name is non-empty, it removes a matching `connector_` prefix from the title. It returns either the shortened title or the original value.

**Call relations**: This is used as part of presenting app tools in a clearer form. It does not call into the cache system; it is a name-cleanup step for Codex Apps metadata.

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

**Purpose**: Turns a raw Codex Apps tool name into the cleaner name the model should call. It sanitizes unsafe characters and removes connector-name or connector-ID prefixes when they are only serving as redundant labels.

**Data flow**: It receives the server name, raw tool name, optional connector ID, and optional connector name. For non-Codex-Apps servers it returns the original tool name. For Codex Apps, it sanitizes the tool name, then tries to strip a sanitized connector name prefix, then a sanitized connector ID prefix. The result is the callable name returned to the rest of the system.

**Call relations**: This function sits in the metadata-normalization path for tools from the Codex Apps MCP server. It relies on `sanitize_name` to make names safe before comparing or returning them.

*Call graph*: calls 1 internal fn (sanitize_name).


##### `normalize_codex_apps_callable_namespace`  (lines 131–142)

```
fn normalize_codex_apps_callable_namespace(
    server_name: &str,
    connector_name: Option<&str>,
) -> String
```

**Purpose**: Creates the namespace used for Codex Apps callable tools. For Codex Apps, it includes the connector name so tools from different connectors can be separated cleanly.

**Data flow**: It receives a server name and optional connector name. If the server is the Codex Apps MCP server and a connector name exists, it sanitizes that connector name and returns a combined namespace like `server__connector`. Otherwise, it returns the server name unchanged.

**Call relations**: This complements callable-name normalization. Together, the namespace and callable name give the model a safe, organized way to refer to a tool.

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

**Purpose**: Writes Codex Apps tool and server-info caches, but only when the current server is the special Codex Apps MCP server and a cache context is available. It also records how long the cache write took.

**Data flow**: It receives the server name, optional cache context, current server information, and current tools. If the server is not Codex Apps, it does nothing. If caching is possible, it writes the tool list, tries to write server information, logs a warning if that second write fails, and emits a duration metric.

**Call relations**: This is called after a Codex Apps tool refresh or during server startup flows that have fresh tool data. It hands the actual disk writes to `write_cached_codex_apps_tools` and `write_cached_codex_apps_server_info`, then reports timing through `emit_duration`.

*Call graph*: calls 3 internal fn (write_cached_codex_apps_server_info, write_cached_codex_apps_tools, emit_duration); called by 4 (hard_refresh_codex_apps_tools_cache, codex_apps_server_info_cache_survives_legacy_tools_cache_write, startup_cached_codex_apps_tools_loads_from_disk_cache, start_server_task); 2 external calls (now, warn!).


##### `load_startup_cached_codex_apps_tools_snapshot`  (lines 168–182)

```
fn load_startup_cached_codex_apps_tools_snapshot(
    server_name: &str,
    cache_context: Option<&CodexAppsToolsCacheContext>,
) -> Option<Vec<ToolInfo>>
```

**Purpose**: Loads a cached Codex Apps tool list for startup use, if it is valid and belongs to the Codex Apps server. This lets the system have a quick snapshot before or while live tool discovery happens.

**Data flow**: It receives the server name and optional cache context. If the server is not Codex Apps, or no context exists, it returns nothing. Otherwise it loads the disk cache and returns the tools only when the cache is a valid hit.

**Call relations**: Startup code calls this when creating or initializing the MCP tool view. It delegates the real cache read and validation to `load_cached_codex_apps_tools`.

*Call graph*: calls 1 internal fn (load_cached_codex_apps_tools); called by 3 (startup_cached_codex_apps_tools_loads_from_disk_cache, startup_cached_codex_apps_tools_loads_without_server_info_cache, new).


##### `load_startup_cached_codex_apps_server_info`  (lines 184–193)

```
fn load_startup_cached_codex_apps_server_info(
    server_name: &str,
    cache_context: Option<&CodexAppsToolsCacheContext>,
) -> Option<McpServerInfo>
```

**Purpose**: Loads cached MCP server information for the Codex Apps server during startup. This gives the system previously known server metadata when a valid cache exists.

**Data flow**: It receives the server name and optional cache context. It returns nothing unless the server is Codex Apps and the context is present. Then it asks the server-info cache reader for the saved data and returns that result.

**Call relations**: Startup code calls this alongside the cached tools snapshot. It hands off to `load_cached_codex_apps_server_info`, which performs the filesystem read and version check.

*Call graph*: calls 1 internal fn (load_cached_codex_apps_server_info); called by 3 (startup_cached_codex_apps_tools_loads_from_disk_cache, startup_cached_codex_apps_tools_loads_without_server_info_cache, new).


##### `read_cached_codex_apps_tools`  (lines 196–203)

```
fn read_cached_codex_apps_tools(
    cache_context: &CodexAppsToolsCacheContext,
) -> Option<Vec<ToolInfo>>
```

**Purpose**: Provides a test-only convenience wrapper that returns cached tools only when the cache is valid. It hides the more detailed hit, missing, or invalid status from tests that only care whether tools are available.

**Data flow**: It receives a cache context, calls the normal tool-cache loader, and converts a valid hit into a tool list. Missing or invalid caches become `None`.

**Call relations**: Tests call this to check cache behavior such as filtering, overwriting, and per-user scoping. It relies on `load_cached_codex_apps_tools`, so tests exercise the same read path used by real startup code.

*Call graph*: calls 1 internal fn (load_cached_codex_apps_tools); called by 3 (codex_apps_tools_cache_filters_disallowed_connectors, codex_apps_tools_cache_is_overwritten_by_last_write, codex_apps_tools_cache_is_scoped_per_user).


##### `load_cached_codex_apps_tools`  (lines 205–224)

```
fn load_cached_codex_apps_tools(
    cache_context: &CodexAppsToolsCacheContext,
) -> CachedCodexAppsToolsLoad
```

**Purpose**: Reads the Codex Apps tools cache from disk and decides whether it is usable. It distinguishes between a missing file, a broken or outdated file, and a valid cache hit.

**Data flow**: It gets the tool-cache path from the cache context, reads the JSON file, parses it, checks the schema version, filters out tools from disallowed connectors, and returns a status: hit with tools, missing, or invalid.

**Call relations**: Startup loading, test helpers, and tool-listing paths call this when they want cached tools. It uses `CodexAppsToolsCacheContext::tools_cache_path` to find the file and `filter_disallowed_codex_apps_tools` to enforce connector policy even on cached data.

*Call graph*: calls 2 internal fn (tools_cache_path, filter_disallowed_codex_apps_tools); called by 3 (load_startup_cached_codex_apps_tools_snapshot, read_cached_codex_apps_tools, listed_tools); 3 external calls (Hit, from_slice, read).


##### `write_cached_codex_apps_tools`  (lines 226–244)

```
fn write_cached_codex_apps_tools(
    cache_context: &CodexAppsToolsCacheContext,
    tools: &[ToolInfo],
)
```

**Purpose**: Saves the current Codex Apps tool list to this user's disk cache. Before saving, it removes tools from connectors that are not allowed.

**Data flow**: It receives a cache context and a list of tools. It finds the cache path, creates the parent directory if needed, filters the tools, wraps them with the current cache schema version, serializes that data as pretty JSON, and writes it to disk. If directory creation or serialization fails, it quietly gives up.

**Call relations**: `write_cached_codex_apps_tools_if_needed` calls this after fresh tools have been discovered. Tests also call it directly to verify overwrites, filtering, and per-user separation. It depends on `tools_cache_path` for the location and `filter_disallowed_codex_apps_tools` for safety.

*Call graph*: calls 2 internal fn (tools_cache_path, filter_disallowed_codex_apps_tools); called by 4 (write_cached_codex_apps_tools_if_needed, codex_apps_tools_cache_filters_disallowed_connectors, codex_apps_tools_cache_is_overwritten_by_last_write, codex_apps_tools_cache_is_scoped_per_user); 4 external calls (to_vec, to_vec_pretty, create_dir_all, write).


##### `load_cached_codex_apps_server_info`  (lines 246–253)

```
fn load_cached_codex_apps_server_info(
    cache_context: &CodexAppsToolsCacheContext,
) -> Option<McpServerInfo>
```

**Purpose**: Reads cached MCP server information for Codex Apps from disk, if it exists and matches the expected cache format. Invalid, unreadable, or outdated data is ignored.

**Data flow**: It receives a cache context, reads the server-info cache path, parses the JSON, checks the schema version, and returns the saved server information only if everything is valid. Otherwise it returns nothing.

**Call relations**: `load_startup_cached_codex_apps_server_info` calls this during startup. It uses `server_info_cache_path` to find the right per-user file.

*Call graph*: calls 1 internal fn (server_info_cache_path); called by 1 (load_startup_cached_codex_apps_server_info); 2 external calls (from_slice, read).


##### `write_cached_codex_apps_server_info`  (lines 255–280)

```
fn write_cached_codex_apps_server_info(
    cache_context: &CodexAppsToolsCacheContext,
    server_info: &McpServerInfo,
) -> anyhow::Result<()>
```

**Purpose**: Writes MCP server information for Codex Apps to this user's disk cache. Unlike the tool-cache writer, it reports detailed errors to its caller.

**Data flow**: It receives a cache context and server information. It builds the cache path, creates the parent directory, wraps a clone of the server information with the current schema version, serializes it as pretty JSON, writes it to disk, and returns success or an error explaining what failed.

**Call relations**: `write_cached_codex_apps_tools_if_needed` calls this after writing the tool cache. If this function returns an error, the caller logs a warning but keeps going, because failure to cache server info should not stop the main MCP flow.

*Call graph*: calls 1 internal fn (server_info_cache_path); called by 1 (write_cached_codex_apps_tools_if_needed); 4 external calls (clone, to_vec_pretty, create_dir_all, write).


##### `filter_disallowed_codex_apps_tools`  (lines 282–291)

```
fn filter_disallowed_codex_apps_tools(tools: Vec<ToolInfo>) -> Vec<ToolInfo>
```

**Purpose**: Removes tools whose connector ID is not allowed by the connector policy. Tools with no connector ID are kept.

**Data flow**: It receives a list of tool descriptions. It checks each tool’s optional connector ID against the allow-list rule and collects only the tools that pass. The returned list is safe to expose or save.

**Call relations**: The cache loader calls this so old cached data cannot bypass current policy. The cache writer calls it so disallowed tools are not stored. The uncached tool-listing path also uses it before returning tools to a client.

*Call graph*: called by 3 (load_cached_codex_apps_tools, write_cached_codex_apps_tools, list_tools_for_client_uncached).


##### `sha1_hex`  (lines 311–316)

```
fn sha1_hex(s: &str) -> String
```

**Purpose**: Creates a hexadecimal SHA-1 hash of a string. Here it is used to turn a serialized user cache key into a compact filename.

**Data flow**: It receives a string, feeds its bytes into a SHA-1 hasher, finalizes the hash, and returns the hash as lowercase hexadecimal text.

**Call relations**: `CodexAppsToolsCacheContext::cache_path_in` calls this while building cache paths. That lets cache filenames be stable for the same user key without placing raw account or user IDs directly in the path.

*Call graph*: called by 1 (cache_path_in); 2 external calls (new, format!).


### `codex-mcp/src/connection_manager.rs`

`orchestration` · `startup, request handling, and teardown`

MCP, or Model Context Protocol, is a way for Codex to connect to outside tool providers. This file keeps those connections in one place so the rest of Codex does not need to know how each server starts, fails, times out, or returns tools. Think of it like a reception desk in a building with many specialist offices: Codex asks the desk for available services, and the desk routes each request to the right office. The main type, McpConnectionManager, owns a map of server names to running asynchronous clients. During startup it creates a client for each enabled server, sends progress events such as starting, ready, failed, or cancelled, and later sends one final startup summary. It also remembers server metadata, such as where a server came from, whether its tools can run in parallel, and how approval should work. During normal use it can list all tools, resources, and resource templates across servers; call a specific tool; read a resource; and answer questions about server status. It also supports user elicitation, meaning a server can ask Codex to ask the user for a decision or input. Without this file, every caller would need to duplicate server startup, error reporting, routing, filtering, caching, and shutdown behavior.

#### Function details

##### `tool_is_model_visible`  (lines 88–104)

```
fn tool_is_model_visible(tool: &ToolInfo) -> bool
```

**Purpose**: Decides whether a tool should be shown to the language model. Some MCP tools include UI visibility metadata; this function hides tools from the model unless that metadata explicitly says the model may see them.

**Data flow**: It receives one ToolInfo value and reads its optional metadata. If there is no visibility list, it returns true; if there is a visibility list, it returns true only when the list contains the word "model".

**Call relations**: This is a small policy helper for filtering model-facing tool declarations. It stands apart from the manager methods and encodes the MCP apps visibility rule in one place.


##### `McpConnectionManager::new`  (lines 120–281)

```
async fn new(
        mcp_servers: &HashMap<String, EffectiveMcpServer>,
        store_mode: OAuthCredentialsStoreMode,
        keyring_backend_kind: AuthKeyringBackendKind,
        auth_entries: Hash
```

**Purpose**: Builds a fully active connection manager from the configured MCP servers. It starts every enabled server client, records metadata, and sends startup progress events so the rest of Codex can tell users what is happening.

**Data flow**: It receives server configuration, authentication settings, approval policy, event sender, runtime context, cache information, and other startup options. It creates an AsyncManagedClient for each enabled server, stores it by server name, launches background tasks that wait for startup results, emits per-server updates, and returns a manager ready for later calls.

**Call relations**: This is the main construction path used by higher-level setup flows such as server refresh, host-owned Codex Apps installation, resource reads, and status collection. Inside its startup tasks it uses emit_update to report state changes and mcp_init_error_display to turn startup failures into helpful user-facing messages.

*Call graph*: calls 6 internal fn (emit_update, mcp_init_error_display, new, new, from, value); called by 7 (no_local_runtime_fails_local_stdio_but_keeps_local_http_server, collect_mcp_server_status_snapshot_with_detail, read_mcp_resource, list_accessible_connectors_from_mcp_tools_with_mcp_manager, install_host_owned_codex_apps_manager, refresh_mcp_servers_inner, new); 15 external calls (clone, new, child_token, clone, clone, new, new, clone, clone, send (+5 more)).


##### `McpConnectionManager::validate_required_servers`  (lines 287–327)

```
async fn validate_required_servers(&self) -> Result<()>
```

**Purpose**: Waits for all servers marked as required and fails the session if any of them did not start. This protects Codex from continuing when a configured must-have tool source is missing.

**Data flow**: It reads the manager’s required server list, looks up each client, waits for its startup result, and collects failures. If there are no failures it returns success; otherwise it returns one combined error message listing every failed required server.

**Call relations**: This is meant to run after the manager has been made reachable to request handlers, because startup may need user input. It calls startup_outcome_error_message to simplify individual startup errors before combining them.

*Call graph*: calls 1 internal fn (startup_outcome_error_message); 4 external calls (new, anyhow!, format!, info_span!).


##### `McpConnectionManager::new_uninitialized_with_permission_profile`  (lines 329–348)

```
fn new_uninitialized_with_permission_profile(
        approval_policy: &Constrained<AskForApproval>,
        permission_profile: &PermissionProfile,
        prefix_mcp_tool_names: bool,
    ) -> Self
```

**Purpose**: Creates an empty manager with no MCP server connections, but with elicitation policy state already set up. This is useful in tests or sessions where MCP is not active but code still expects a manager object.

**Data flow**: It receives an approval policy, a permission profile, and the tool-name prefix setting. It builds empty maps and lists, creates a fresh elicitation request manager, creates a cancellation token, and returns a manager with no clients.

**Call relations**: This is called by test and session helper paths, and by the test-only new_uninitialized wrapper. It shares the same elicitation setup idea as the real constructor but skips all network or process startup.

*Call graph*: calls 2 internal fn (new, value); called by 3 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 6 external calls (new, new, new, new, default, clone).


##### `McpConnectionManager::has_servers`  (lines 350–352)

```
fn has_servers(&self) -> bool
```

**Purpose**: Answers whether this manager currently knows about any MCP servers. Callers can use it to skip MCP-related work when there are no configured clients.

**Data flow**: It reads the internal client map and returns true if the map is not empty, otherwise false. It does not change anything.

**Call relations**: This is a simple query used by surrounding code that needs to branch between MCP-enabled and MCP-free behavior.


##### `McpConnectionManager::contains_server`  (lines 354–356)

```
fn contains_server(&self, server_name: &str) -> bool
```

**Purpose**: Checks whether a server name is registered in this manager. It is a quick way to reject or route requests before trying to start or use a client.

**Data flow**: It receives a server name, looks for that key in the internal client map, and returns a boolean. The manager state is unchanged.

**Call relations**: This crate-private helper supports code that needs to know whether a named MCP server belongs to this manager.


##### `McpConnectionManager::shutdown`  (lines 359–364)

```
async fn shutdown(&self)
```

**Purpose**: Stops all MCP clients owned by the manager. This is the explicit cleanup path for cancelling startup work and terminating any server processes behind the clients.

**Data flow**: It cancels the startup cancellation token, then walks through every stored client and asks it to shut down. It returns after those shutdown requests complete.

**Call relations**: This is used during teardown. It mirrors the automatic cleanup in McpConnectionManager::drop, but because it is async it can wait for each client’s shutdown work.

*Call graph*: 1 external calls (cancel).


##### `McpConnectionManager::server_origin`  (lines 366–371)

```
fn server_origin(&self, server_name: &str) -> Option<&str>
```

**Purpose**: Returns a human-readable origin for a server, if one is known. The origin explains where the server came from, such as a plugin or configuration source.

**Data flow**: It receives a server name, looks up stored server metadata, and returns the origin string if present. If the server or origin is missing, it returns nothing.

**Call relations**: Other parts of Codex can use this when presenting tools or status to users, so server results can be tied back to where they came from.


##### `McpConnectionManager::server_pollutes_memory`  (lines 373–377)

```
fn server_pollutes_memory(&self, server_name: &str) -> bool
```

**Purpose**: Tells callers whether a server should be treated as affecting conversation memory. If metadata is missing, it takes the cautious default and says yes.

**Data flow**: It receives a server name, reads that server’s metadata, and returns the stored pollutes_memory flag. If there is no metadata entry, it returns true.

**Call relations**: This is a policy query for higher-level conversation logic that needs to decide how MCP server activity should affect memory.


##### `McpConnectionManager::plugin_id_for_mcp_server_name`  (lines 379–382)

```
fn plugin_id_for_mcp_server_name(&self, server_name: &str) -> Option<&str>
```

**Purpose**: Finds the plugin identifier associated with an MCP server name, if that server came from a plugin. This connects low-level server names back to plugin-level identity.

**Data flow**: It receives a server name and asks the stored ToolPluginProvenance mapping for the matching plugin ID. It returns that ID as text when available.

**Call relations**: This delegates to the provenance object created during manager setup. Callers use it when they need plugin context for an MCP server.


##### `McpConnectionManager::is_selected_plugin_mcp_server`  (lines 384–387)

```
fn is_selected_plugin_mcp_server(&self, server_name: &str) -> bool
```

**Purpose**: Checks whether a server belongs to the currently selected plugin set. This lets Codex distinguish plugin-provided MCP servers from other configured servers.

**Data flow**: It receives a server name and asks the provenance mapping whether that server is selected. It returns true or false without changing state.

**Call relations**: Like plugin_id_for_mcp_server_name, this is a small wrapper around ToolPluginProvenance so callers do not need direct access to that internal object.


##### `McpConnectionManager::tool_approval_mode`  (lines 389–398)

```
fn tool_approval_mode(
        &self,
        server_name: &str,
        tool_name: &str,
    ) -> codex_config::AppToolApproval
```

**Purpose**: Returns the approval rule for a particular tool on a particular server. Approval rules decide whether a user must approve a tool before it runs.

**Data flow**: It receives a server name and tool name, looks up the server metadata, and asks that metadata for the tool’s approval mode. If the server metadata is missing, it returns the default approval mode.

**Call relations**: This gives tool-running code a single place to ask how cautious it should be before invoking an MCP tool.


##### `McpConnectionManager::is_host_owned_codex_apps_server`  (lines 400–402)

```
fn is_host_owned_codex_apps_server(&self, server_name: &str) -> bool
```

**Purpose**: Checks whether a server is the special Codex Apps MCP server owned by the host. This matters because that server may use special authentication and cache behavior.

**Data flow**: It receives a server name and compares it with the known Codex Apps server name, while also checking whether host-owned Codex Apps support is enabled. It returns true only when both conditions match.

**Call relations**: Startup code in McpConnectionManager::new gives the Codex Apps server special treatment; this query lets later code recognize the same special case.


##### `McpConnectionManager::set_approval_policy`  (lines 404–408)

```
fn set_approval_policy(&self, approval_policy: &Constrained<AskForApproval>)
```

**Purpose**: Updates the approval policy used for future elicitation decisions. An elicitation is when an MCP server asks Codex to ask the user for input or permission.

**Data flow**: It receives a constrained approval policy, extracts its value, locks the shared policy storage, and replaces the old policy if the lock succeeds. It does not return a result.

**Call relations**: This changes the policy inside the ElicitationRequestManager that was created during construction, so later elicitation requests follow the newest approval setting.

*Call graph*: calls 1 internal fn (value).


##### `McpConnectionManager::set_permission_profile`  (lines 410–414)

```
fn set_permission_profile(&self, permission_profile: PermissionProfile)
```

**Purpose**: Updates the permission profile used when deciding whether elicitation is allowed. A permission profile describes what kinds of actions the session permits.

**Data flow**: It receives a PermissionProfile, locks the shared profile storage, and stores the new value if the lock succeeds. Nothing is returned.

**Call relations**: This supports live policy changes after the manager has been created. Later elicitation checks read the updated profile through the same shared request manager.


##### `McpConnectionManager::elicitations_auto_deny`  (lines 416–418)

```
fn elicitations_auto_deny(&self) -> bool
```

**Purpose**: Reports whether elicitation requests are currently being denied automatically. This is useful when Codex should avoid interrupting the user or when permissions disallow prompts.

**Data flow**: It reads the auto-deny flag from the elicitation request manager and returns it as a boolean. It does not change state.

**Call relations**: This delegates to ElicitationRequestManager::auto_deny, keeping elicitation state behind the manager interface.

*Call graph*: calls 1 internal fn (auto_deny).


##### `McpConnectionManager::set_elicitations_auto_deny`  (lines 420–422)

```
fn set_elicitations_auto_deny(&self, auto_deny: bool)
```

**Purpose**: Turns automatic denial of elicitation requests on or off. When enabled, server requests for user input are rejected instead of being shown for review.

**Data flow**: It receives a boolean and passes it into the elicitation request manager. The stored auto-deny setting is updated for future requests.

**Call relations**: This delegates to ElicitationRequestManager::set_auto_deny and affects future calls that flow through the elicitation system.

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

**Purpose**: Completes a pending elicitation request with the user’s or reviewer’s response. This lets a waiting MCP server continue after Codex has gathered the needed answer.

**Data flow**: It receives the server name, request ID, and response. It passes those to the elicitation request manager, which matches them to a waiting request and returns success or an error.

**Call relations**: This is the response path for elicitation requests created by MCP clients. It delegates the matching and completion work to ElicitationRequestManager::resolve.

*Call graph*: calls 1 internal fn (resolve).


##### `McpConnectionManager::wait_for_server_ready`  (lines 435–444)

```
async fn wait_for_server_ready(&self, server_name: &str, timeout: Duration) -> bool
```

**Purpose**: Waits for one named server to become ready, but only for a limited amount of time. It gives callers a simple true-or-false readiness check.

**Data flow**: It receives a server name and timeout duration. If the server is unknown it returns false; otherwise it waits for the client startup future until the timeout expires and returns true only if startup succeeds.

**Call relations**: This is a targeted readiness helper for code that needs one server before continuing. It uses Tokio’s timeout mechanism rather than waiting forever.

*Call graph*: 1 external calls (timeout).


##### `McpConnectionManager::list_all_tools`  (lines 448–485)

```
async fn list_all_tools(&self) -> Vec<ToolInfo>
```

**Purpose**: Collects tools from every MCP server and prepares their names for model use. This is how Codex builds the combined tool list it can offer to the language model.

**Data flow**: It loops over all clients, asks each one for its listed tools, attaches server metadata to each tool, and skips servers that cannot provide tools. It then normalizes tool names, optionally adding prefixes, and returns one vector of ToolInfo values.

**Call relations**: This is called by connector-listing code. Inside the flow it uses with_server_metadata to add presentation and execution details, then hands the whole collection to normalize_tools_for_model_with_prefix.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); called by 1 (list_accessible_and_enabled_connectors_from_manager); 3 external calls (new, trace!, trace_span!).


##### `McpConnectionManager::hard_refresh_codex_apps_tools_cache`  (lines 492–540)

```
async fn hard_refresh_codex_apps_tools_cache(&self) -> Result<Vec<ToolInfo>>
```

**Purpose**: Forces a fresh tool list from the special Codex Apps MCP server and updates its cache only if the refresh succeeds. This is useful when cached tools may be stale.

**Data flow**: It finds and awaits the Codex Apps client, fetches tools directly from the server without using the in-memory cache, records timing metrics, writes the refreshed cache if appropriate, filters disabled tools, adjusts their model-visible schemas, adds server metadata, normalizes names, and returns the new list.

**Call relations**: This follows the same output-shaping path as list_all_tools but bypasses normal cached listing. It calls list_tools_for_client_uncached for the fresh server request and write_cached_codex_apps_tools_if_needed to persist the result.

*Call graph*: calls 5 internal fn (write_cached_codex_apps_tools_if_needed, list_tools_for_client_uncached, emit_duration, filter_tools, normalize_tools_for_model_with_prefix); 1 external calls (now).


##### `McpConnectionManager::list_all_resources`  (lines 544–605)

```
async fn list_all_resources(&self) -> HashMap<String, Vec<Resource>>
```

**Purpose**: Asks every ready MCP server for its resources and returns them grouped by server name. Resources are items such as files, documents, or other readable context exposed by a server.

**Data flow**: It snapshots the client map, waits for each usable client, and starts parallel tasks that page through each server’s resource list using cursors. Successful results are inserted into a map; failures are logged and omitted.

**Call relations**: This is an aggregate version of list_resources. It performs many server requests at once and includes a guard against duplicate cursors so a misbehaving server cannot cause an endless pagination loop.

*Call graph*: 5 external calls (new, new, new, anyhow!, warn!).


##### `McpConnectionManager::list_all_resource_templates`  (lines 609–674)

```
async fn list_all_resource_templates(&self) -> HashMap<String, Vec<ResourceTemplate>>
```

**Purpose**: Asks every ready MCP server for resource templates and returns them grouped by server name. A resource template describes a pattern for resources that can be requested later.

**Data flow**: It walks through clients, starts parallel tasks for servers that are ready, and each task repeatedly asks for the next page of templates until there is no cursor left. It collects successes into a map and logs any server or task failures.

**Call relations**: This mirrors list_all_resources but calls the resource-template endpoint instead. It also protects against duplicate cursors to avoid looping forever on bad pagination data.

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

**Purpose**: Runs one specific tool on one specific MCP server. It enforces the server’s tool filter first, so disabled tools cannot be called through this path.

**Data flow**: It receives a server name, tool name, optional arguments, and optional metadata. It gets the matching client, checks whether the tool is allowed, sends the tool call with the configured timeout, converts the returned content into protocol-friendly JSON values, and returns a CallToolResult.

**Call relations**: This is one of the main request-handling paths. It uses client_by_name to find the right server client, then delegates the actual MCP tool call to that client.

*Call graph*: calls 1 internal fn (client_by_name); 1 external calls (anyhow!).


##### `McpConnectionManager::server_supports_sandbox_state_meta_capability`  (lines 714–722)

```
async fn server_supports_sandbox_state_meta_capability(
        &self,
        server: &str,
    ) -> Result<bool>
```

**Purpose**: Reports whether a server says it supports sandbox-state metadata. That capability lets Codex know whether sandbox-related state can be included in calls to that server.

**Data flow**: It receives a server name, gets the corresponding managed client, reads the stored capability flag, and returns it. If the server cannot be found or the client failed to start, it returns an error.

**Call relations**: This uses client_by_name just like the tool and resource request methods, but only reads a capability value from the ready client.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::list_resources`  (lines 725–738)

```
async fn list_resources(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> Result<ListResourcesResult>
```

**Purpose**: Lists resources from one chosen MCP server. This is the direct, single-server version of resource discovery.

**Data flow**: It receives a server name and optional pagination parameters. It gets the managed client, reads its timeout, sends the resources/list request, and returns either the server’s page of resources or an error with server context.

**Call relations**: This is used when callers already know which server they want. It relies on client_by_name to locate a ready client before sending the MCP request.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::list_resource_templates`  (lines 741–754)

```
async fn list_resource_templates(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> Result<ListResourceTemplatesResult>
```

**Purpose**: Lists resource templates from one chosen MCP server. Templates describe resource URI patterns or discoverable resource shapes.

**Data flow**: It receives a server name and optional pagination parameters. It gets the managed client, clones the underlying client handle, sends the resource-template list request with the configured timeout, and returns the result or a contextual error.

**Call relations**: This is the direct counterpart to list_all_resource_templates. It uses client_by_name, then hands the request to the underlying MCP client.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::read_resource`  (lines 757–771)

```
async fn read_resource(
        &self,
        server: &str,
        params: ReadResourceRequestParams,
    ) -> Result<ReadResourceResult>
```

**Purpose**: Reads one resource from one MCP server. This retrieves the actual content for a resource identified by the request parameters.

**Data flow**: It receives a server name and read-resource parameters, including a URI. It gets the managed client, sends the read request with the configured timeout, and returns the resource contents or an error that includes the server and URI.

**Call relations**: This is the read step that typically follows resource discovery. Like other single-server operations, it starts by calling client_by_name.

*Call graph*: calls 1 internal fn (client_by_name).


##### `McpConnectionManager::list_available_server_infos`  (lines 775–796)

```
async fn list_available_server_infos(&self) -> HashMap<String, McpServerInfo>
```

**Purpose**: Returns presentation information for servers without unnecessarily waiting on servers that are still starting. Cached information is used when live information is not yet available.

**Data flow**: It loops over clients. If a client has not completed startup, it inserts cached server info if present; if startup has completed, it tries to get the live managed client and uses live server info, falling back to cache on error.

**Call relations**: This is called by status snapshot collection code. It is designed for UI/status paths where showing the best available information quickly is better than blocking on a slow startup.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager); 1 external calls (new).


##### `McpConnectionManager::with_server_metadata`  (lines 798–811)

```
fn with_server_metadata(&self, mut tool: ToolInfo) -> ToolInfo
```

**Purpose**: Adds stored server metadata to a ToolInfo value. This gives each tool important context such as whether parallel calls are supported and what origin should be shown.

**Data flow**: It receives a ToolInfo, looks up metadata using the tool’s server name, and writes metadata-derived fields into the tool. If metadata is missing, it marks parallel calls unsupported and clears the origin.

**Call relations**: list_all_tools and hard_refresh_codex_apps_tools_cache use this before returning tools. It keeps metadata enrichment in one small shared step.


##### `McpConnectionManager::client_by_name`  (lines 813–820)

```
async fn client_by_name(&self, name: &str) -> Result<ManagedClient>
```

**Purpose**: Finds a ready managed client for a server name or returns a clear error. This is the common lookup gate before making single-server MCP requests.

**Data flow**: It receives a server name, checks the internal client map, waits for that AsyncManagedClient to produce a ManagedClient, and returns it. Unknown servers and failed startups become errors.

**Call relations**: call_tool, list_resources, list_resource_templates, read_resource, and server_supports_sandbox_state_meta_capability all call this so they share the same lookup and startup-error behavior.

*Call graph*: called by 5 (call_tool, list_resource_templates, list_resources, read_resource, server_supports_sandbox_state_meta_capability).


##### `McpConnectionManager::new_uninitialized`  (lines 823–833)

```
fn new_uninitialized(
        approval_policy: &Constrained<AskForApproval>,
        permission_profile: &Constrained<PermissionProfile>,
        prefix_mcp_tool_names: bool,
    ) -> Self
```

**Purpose**: Creates an empty manager for tests using a constrained permission profile. It is a test-only convenience wrapper around the more general uninitialized constructor.

**Data flow**: It receives an approval policy, a constrained permission profile, and the prefix setting. It extracts the permission profile value and passes everything to new_uninitialized_with_permission_profile, returning the resulting empty manager.

**Call relations**: Many tests call this to build a manager without starting real MCP servers. It keeps test setup short while reusing the real empty-manager construction logic.

*Call graph*: calls 1 internal fn (get); called by 9 (list_all_tools_accepts_canonical_namespaced_tool_names, list_all_tools_adds_server_metadata_to_cached_tools, list_all_tools_applies_legacy_mcp_prefix_by_default, list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot, list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending, list_available_server_infos_uses_cache_while_client_is_pending, shutdown_cancels_pending_tool_listing); 1 external calls (new_uninitialized_with_permission_profile).


##### `McpConnectionManager::drop`  (lines 837–840)

```
fn drop(&mut self)
```

**Purpose**: Performs last-resort cleanup when the manager is destroyed. It cancels startup work and removes client references.

**Data flow**: When Rust drops the manager, this method cancels the startup cancellation token and clears the client map. It does not await async shutdown work.

**Call relations**: This complements the explicit async shutdown method. If callers forget to call shutdown, drop still signals cancellation, but shutdown is the fuller cleanup path.

*Call graph*: 1 external calls (cancel).


##### `emit_update`  (lines 843–854)

```
async fn emit_update(
    submit_id: &str,
    tx_event: &Sender<Event>,
    update: McpStartupUpdateEvent,
) -> Result<(), async_channel::SendError<Event>>
```

**Purpose**: Sends one MCP startup status update through the event channel. This lets the rest of Codex report per-server progress to the user or UI.

**Data flow**: It receives a submit ID, an event sender, and an update payload. It wraps the update in an Event with the submit ID and sends it through the async channel, returning the send result.

**Call relations**: McpConnectionManager::new calls this before starting each server and again after each startup attempt finishes. It centralizes the event shape for startup updates.

*Call graph*: called by 1 (new); 2 external calls (send, McpStartupUpdate).


##### `mcp_init_error_display`  (lines 856–897)

```
fn mcp_init_error_display(
    server_name: &str,
    entry: Option<&McpAuthStatusEntry>,
    err: &StartupOutcomeError,
) -> String
```

**Purpose**: Turns a raw MCP startup error into a message a user can act on. It gives special guidance for common cases such as missing login, GitHub MCP token setup, or startup timeout.

**Data flow**: It receives the server name, optional authentication/config entry, and startup error. It checks for known patterns and returns a tailored string; if none match, it returns a general failure message containing the original error.

**Call relations**: McpConnectionManager::new uses this when a startup task fails before sending the failure update. It calls is_mcp_client_auth_required_error and is_mcp_client_startup_timeout_error to recognize common error categories.

*Call graph*: calls 2 internal fn (is_mcp_client_auth_required_error, is_mcp_client_startup_timeout_error); called by 1 (new); 1 external calls (format!).


##### `startup_outcome_error_message`  (lines 899–904)

```
fn startup_outcome_error_message(error: StartupOutcomeError) -> String
```

**Purpose**: Converts a startup outcome error into a short message for required-server validation. It separates cancellation from ordinary startup failure text.

**Data flow**: It receives a StartupOutcomeError by value. Cancelled becomes the fixed message "MCP startup cancelled"; a failed outcome returns its stored error string.

**Call relations**: validate_required_servers calls this while building its combined error message for all required servers that did not initialize.

*Call graph*: called by 1 (validate_required_servers).


##### `is_mcp_client_auth_required_error`  (lines 906–911)

```
fn is_mcp_client_auth_required_error(error: &StartupOutcomeError) -> bool
```

**Purpose**: Detects whether a startup error appears to mean authentication is required. This helps produce a login-focused message instead of a vague startup failure.

**Data flow**: It receives a startup error reference. If the error is a failed outcome whose text contains "Auth required", it returns true; otherwise it returns false.

**Call relations**: mcp_init_error_display calls this as one of its known-error checks before choosing the final user-facing startup message.

*Call graph*: called by 1 (mcp_init_error_display); 1 external calls (contains).


##### `is_mcp_client_startup_timeout_error`  (lines 913–921)

```
fn is_mcp_client_startup_timeout_error(error: &StartupOutcomeError) -> bool
```

**Purpose**: Detects whether a startup error looks like a timeout. This lets Codex suggest changing the configured startup timeout rather than reporting a generic failure.

**Data flow**: It receives a startup error reference. If the failed error text mentions a request timeout or a timed-out MCP handshake, it returns true; otherwise it returns false.

**Call relations**: mcp_init_error_display calls this after the authentication check. When it returns true, the displayed message includes the timeout value and an example config setting.

*Call graph*: called by 1 (mcp_init_error_display); 1 external calls (contains).


### `codex-mcp/src/resource_client.rs`

`io_transport` · `request handling`

MCP, or Model Context Protocol, lets Codex talk to external servers that can provide tools and resources. This file is the resource-facing doorway into those servers. A resource might be something like a file, document, or other named piece of context that an MCP server advertises.

The central type is `McpResourceClient`. It does not hold a fixed connection manager directly. Instead, it holds a shared, replaceable pointer to the current `McpConnectionManager`. That matters because the manager can be swapped during startup or refresh, and this client should automatically use the newest one. Think of it like keeping the address of the front desk, not the name of one staff member; if staffing changes, you still ask the current front desk.

The client can check whether a server name is known, list resources one page at a time, and read the contents of a specific resource URI. Pagination means a server can return a long list in chunks, with a cursor that says where to continue next time.

The file also defines plain result structs for a page of resources and for read contents. Two helper functions translate resource data from the external `rmcp` library’s shapes into Codex’s own protocol shapes, adding useful error context if conversion fails.

#### Function details

##### `McpResourceClientCacheKey::eq`  (lines 44–46)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Compares two cache keys to see whether they point to the same underlying MCP connection manager. This lets callers know whether cached resource data still belongs to the currently published manager.

**Data flow**: It receives two cache keys, each holding a weak reference to a manager. It compares the identity of those references, not the manager’s contents. It returns `true` if both keys refer to the same manager allocation, and `false` otherwise.

**Call relations**: This supports the equality behavior for `McpResourceClientCacheKey`. The key itself is produced by `McpResourceClient::cache_key`, so equality is used when outside code wants to tell whether the client’s manager identity has changed.


##### `McpResourceClient::fmt`  (lines 52–56)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a safe debug printout for `McpResourceClient`. It identifies the value as an MCP resource client without exposing internal connection-manager details.

**Data flow**: It receives a formatter from Rust’s debug-printing system. It writes a non-exhaustive debug structure named `McpResourceClient`, meaning the output is intentionally brief and may omit fields. It returns the normal formatting result.

**Call relations**: Rust calls this when someone formats the client with debug output. Inside, it hands the formatting work to the standard debug-structure builder through `debug_struct`.

*Call graph*: 1 external calls (debug_struct).


##### `McpResourceClient::new`  (lines 61–63)

```
fn new(manager: Arc<ArcSwap<McpConnectionManager>>) -> Self
```

**Purpose**: Creates a resource client that uses the session’s shared, replaceable MCP connection manager. Callers use this when they need an object that can list and read MCP resources.

**Data flow**: It receives a shared pointer to an `ArcSwap`, which is a thread-safe holder for a replaceable shared value. It stores that pointer inside a new `McpResourceClient`. The returned client will later load the current manager whenever it makes a request.

**Call relations**: This is the construction point for the client and is called by a higher-level `new` function elsewhere in the system. After construction, the other methods on `McpResourceClient` use the stored manager handle to answer resource requests.

*Call graph*: called by 1 (new).


##### `McpResourceClient::cache_key`  (lines 66–68)

```
fn cache_key(&self) -> McpResourceClientCacheKey
```

**Purpose**: Returns an identity token for the manager currently used by this client. This is useful for caches: if the token changes, cached resource information may belong to an old manager and should not be trusted blindly.

**Data flow**: It loads the currently published manager from the replaceable holder. Then it turns the strong shared pointer into a weak pointer, which remembers identity without keeping the manager alive by itself. It wraps that weak pointer in `McpResourceClientCacheKey` and returns it.

**Call relations**: Callers use this before or after resource work when they need to detect manager replacement. It relies on `downgrade` to make the weak identity reference, and `McpResourceClientCacheKey::eq` later compares these keys by pointer identity.

*Call graph*: 1 external calls (downgrade).


##### `McpResourceClient::has_server`  (lines 73–75)

```
async fn has_server(&self, server: &str) -> bool
```

**Purpose**: Checks whether the current connection manager knows about a server with the given name. It is a quick presence check, not a promise that the server has started successfully.

**Data flow**: It receives a server name as text. It loads the current manager and asks whether that manager contains the server. It returns `true` or `false` and does not wait for any server startup work.

**Call relations**: This is used by code that wants to decide whether it makes sense to ask a named MCP server for resources. It fits before calls such as `list_resources` or `read_resource`, but it does not itself perform those calls.


##### `McpResourceClient::list_resources`  (lines 78–99)

```
async fn list_resources(
        &self,
        server: &str,
        cursor: Option<String>,
    ) -> Result<McpResourcePage>
```

**Purpose**: Asks a named MCP server for one page of resources it advertises. It supports continuing through long lists by accepting an optional cursor from a previous page.

**Data flow**: It receives a server name and, optionally, a cursor string. If a cursor is present, it builds paginated request parameters with that cursor. It loads the current connection manager, asks that manager to list resources from the server, converts each returned `rmcp` resource into Codex’s `Resource` type, and returns a `McpResourcePage` containing the converted resources plus the next cursor, if the server provided one. If the server call or conversion fails, it returns an error.

**Call relations**: This is the main path for resource discovery. Higher-level code calls it when it wants to show or use available MCP resources. It delegates the actual server request to the current `McpConnectionManager`, then hands each raw resource to `resource_from_rmcp` so the rest of Codex sees the project’s own protocol type.


##### `McpResourceClient::read_resource`  (lines 102–114)

```
async fn read_resource(&self, server: &str, uri: &str) -> Result<McpResourceReadResult>
```

**Purpose**: Reads the contents of one resource from a named MCP server. Callers use it after they know the resource URI they want.

**Data flow**: It receives a server name and a resource URI. It creates read-resource request parameters from the URI, loads the current connection manager, and asks that manager to read the resource. It converts each returned content item into Codex’s `ResourceContent` type and returns them inside `McpResourceReadResult`. If the read or conversion fails, it returns an error.

**Call relations**: This is the main path for fetching actual resource data after discovery. It creates the external request parameter object with `new`, sends the request through the current `McpConnectionManager`, and then uses `resource_content_from_rmcp` to translate the reply into the type used by Codex.

*Call graph*: 1 external calls (new).


##### `resource_from_rmcp`  (lines 117–120)

```
fn resource_from_rmcp(resource: rmcp::model::Resource) -> Result<Resource>
```

**Purpose**: Converts a resource object from the external `rmcp` library into Codex’s own `Resource` type. This keeps the rest of the code from depending directly on the external library’s data shape.

**Data flow**: It receives an `rmcp` resource. It first serializes that resource into generic JSON data, then asks Codex’s `Resource::from_mcp_value` to build a `Resource` from that JSON. It returns the converted resource or an error with context explaining whether serialization or conversion failed.

**Call relations**: This helper is used by `McpResourceClient::list_resources` for every resource returned by the connection manager. It calls `to_value` to make generic JSON and `from_mcp_value` to turn that JSON into the Codex protocol model.

*Call graph*: calls 1 internal fn (from_mcp_value); 1 external calls (to_value).


##### `resource_content_from_rmcp`  (lines 122–126)

```
fn resource_content_from_rmcp(content: rmcp::model::ResourceContents) -> Result<ResourceContent>
```

**Purpose**: Converts resource content from the external `rmcp` library into Codex’s own `ResourceContent` type. This makes read results consistent with the rest of the project’s protocol objects.

**Data flow**: It receives one `rmcp` resource-content item. It serializes it into generic JSON, then deserializes that JSON into `ResourceContent`. It returns the converted content or an error that says whether serialization or conversion failed.

**Call relations**: This helper is used by `McpResourceClient::read_resource` for each content item returned by a server. It relies on standard JSON conversion helpers, `to_value` and `from_value`, to bridge between the external type and Codex’s internal protocol type.

*Call graph*: 2 external calls (from_value, to_value).


### `codex-mcp/src/mcp/mod.rs`

`orchestration` · `cross-cutting: active during MCP setup, resource reads, status snapshots, and tool discovery`

MCP, the Model Context Protocol, lets Codex talk to outside tool servers. This file is the central control panel for that feature. It gathers long-lived MCP settings into McpConfig, filters the configured servers into the servers that should actually run, and builds helper objects that explain where tools came from, such as which plugin supplied them.

A key job here is deciding whether the special ChatGPT-hosted “Codex apps” MCP server should be present. It is only kept when the config enables it and the current login uses the Codex backend. Without this check, Codex could try to use a hosted app server when the user is not authenticated for it.

The file also creates standard server configs for hosted app and plugin MCP endpoints, including URL shaping and optional product headers. It contains safety helpers too, such as cleaning tool names so they fit the Responses API naming rules, and deciding when permission prompts can be automatically approved.

For live work, it builds an McpConnectionManager, asks it to read a resource or list tools/resources, converts raw MCP library data into Codex protocol types, and then cancels the temporary manager. Think of it as a dispatcher: it does not implement every tool, but it decides which tool stations are open, connects to them, and packages their answers for the rest of Codex.

#### Function details

##### `McpSnapshotDetail::include_resources`  (lines 61–63)

```
fn include_resources(self) -> bool
```

**Purpose**: This small helper says whether a status snapshot should include MCP resources and resource templates, or only tools and authentication. It lets callers request a lighter snapshot when resources are not needed.

**Data flow**: It receives the snapshot detail setting. If the setting is Full, it returns true; if it is ToolsAndAuthOnly, it returns false. It does not change anything else.

**Call relations**: The snapshot collector uses this decision before asking the connection manager to list resources and resource templates. It keeps the heavier resource queries out of snapshots that only need tools and auth state.

*Call graph*: 1 external calls (matches!).


##### `qualified_mcp_tool_name_prefix`  (lines 66–70)

```
fn qualified_mcp_tool_name_prefix(server_name: &str) -> String
```

**Purpose**: This builds the standard prefix Codex uses when exposing a server's MCP tools to the model. The prefix includes the MCP marker and the server name, then cleans the result so it is safe for the Responses API.

**Data flow**: It takes a server name, forms a string like an MCP namespace prefix, passes that string through the tool-name sanitizer, and returns the cleaned prefix.

**Call relations**: It hands off to sanitize_responses_api_tool_name because server names can contain characters the API does not allow. Other tool-normalizing code can then use this prefix when presenting MCP tools to the model.

*Call graph*: calls 1 internal fn (sanitize_responses_api_tool_name); 1 external calls (format!).


##### `mcp_permission_prompt_is_auto_approved`  (lines 74–93)

```
fn mcp_permission_prompt_is_auto_approved(
    approval_policy: AskForApproval,
    permission_profile: &PermissionProfile,
    context: McpPermissionPromptAutoApproveContext,
) -> bool
```

**Purpose**: This decides whether Codex can skip showing a permission prompt for an MCP action and treat it as approved. It protects the user by only allowing auto-approval under specific policy and sandbox conditions.

**Data flow**: It reads the global approval policy, the current permission profile, and an extra context value for app tool approval mode. If the app explicitly says approve, it returns true. Otherwise, it only returns true when prompts are globally disabled and the permission profile is either disabled, external, or a managed profile with full disk write access.

**Call relations**: This is used by MCP approval flows to decide whether a prompt should be shown or silently accepted. It depends on policy objects rather than calling other helpers, so the decision stays clear and local.


##### `ToolPluginProvenance::plugin_display_names_for_connector_id`  (lines 159–164)

```
fn plugin_display_names_for_connector_id(&self, connector_id: &str) -> &[String]
```

**Purpose**: This looks up the human-readable plugin names associated with an app connector ID. It is used when Codex wants to explain where a connector-backed tool came from.

**Data flow**: It receives a connector ID string, checks the stored map, and returns a slice of plugin display names. If there is no match, it returns an empty slice rather than failing.

**Call relations**: The with_app_plugin_sources flow calls this when attaching plugin source information to app tools. The data it reads is prepared earlier by ToolPluginProvenance::from_config.

*Call graph*: called by 1 (with_app_plugin_sources).


##### `ToolPluginProvenance::plugin_display_names_for_mcp_server_name`  (lines 166–171)

```
fn plugin_display_names_for_mcp_server_name(&self, server_name: &str) -> &[String]
```

**Purpose**: This looks up which plugin display names are tied to a particular MCP server name. It helps user-facing views say that a tool or server was supplied by a plugin.

**Data flow**: It receives an MCP server name, reads the stored server-to-plugin-name map, and returns the matching names. If none are known, it returns an empty slice.

**Call relations**: This is part of the provenance object built from configuration. Other MCP presentation code can call it when it needs to show plugin attribution for a server.


##### `ToolPluginProvenance::plugin_id_for_mcp_server_name`  (lines 173–177)

```
fn plugin_id_for_mcp_server_name(&self, server_name: &str) -> Option<&str>
```

**Purpose**: This returns the stable plugin ID for an MCP server, when Codex knows one. The ID is useful for internal tracking, while display names are better for users.

**Data flow**: It receives a server name, looks in the stored map of server names to plugin IDs, and returns either the matching string or no value.

**Call relations**: It reads information assembled by ToolPluginProvenance::from_config. Callers use it when they need the plugin's identity rather than just its display name.


##### `ToolPluginProvenance::is_selected_plugin_mcp_server`  (lines 179–181)

```
fn is_selected_plugin_mcp_server(&self, server_name: &str) -> bool
```

**Purpose**: This tells whether a server came from a selected plugin MCP registration. That matters when Codex needs to distinguish selected plugin servers from other configured servers.

**Data flow**: It receives a server name and checks whether that name is present in the stored selected-plugin set. It returns true or false and does not modify the set.

**Call relations**: The selected set is filled by ToolPluginProvenance::from_config. This helper gives the rest of the MCP code a simple yes-or-no question to ask.


##### `ToolPluginProvenance::from_config`  (lines 183–231)

```
fn from_config(config: &McpConfig) -> Self
```

**Purpose**: This builds the lookup tables that explain which plugins contributed which connectors and MCP servers. It turns raw configuration and catalog attribution into fast, tidy provenance data.

**Data flow**: It reads plugin capability summaries and the resolved MCP server catalog from McpConfig. It fills maps for connector IDs, server names, plugin IDs, and selected plugin server names, then sorts and removes duplicate display names. It returns a completed ToolPluginProvenance value.

**Call relations**: tool_plugin_provenance calls this as the public wrapper. The resulting object is passed into McpConnectionManager creation for resource reads and snapshot collection, so later tool listings can carry source information.

*Call graph*: called by 1 (tool_plugin_provenance); 2 external calls (default, vec!).


##### `host_owned_codex_apps_enabled`  (lines 234–236)

```
fn host_owned_codex_apps_enabled(config: &McpConfig, auth: Option<&CodexAuth>) -> bool
```

**Purpose**: This decides whether the ChatGPT-hosted Codex apps MCP server should be available. It requires both configuration approval and a compatible Codex login.

**Data flow**: It reads the apps_enabled flag from McpConfig and checks whether an optional auth object exists and uses the Codex backend. It returns true only when both conditions are met.

**Call relations**: effective_mcp_servers_from_configured uses this to remove the built-in apps server when it should not run. read_mcp_resource and collect_mcp_server_status_snapshot_with_detail also pass the result into the connection manager.

*Call graph*: called by 3 (collect_mcp_server_status_snapshot_with_detail, effective_mcp_servers_from_configured, read_mcp_resource).


##### `configured_mcp_servers`  (lines 238–240)

```
fn configured_mcp_servers(config: &McpConfig) -> HashMap<String, McpServerConfig>
```

**Purpose**: This returns the MCP servers that are configured in the resolved server catalog. It is the starting list before auth-based filtering is applied.

**Data flow**: It reads the server catalog from McpConfig and asks it for configured servers. It returns a map from logical server name to server configuration.

**Call relations**: effective_mcp_servers calls this first, then hands the map to effective_mcp_servers_from_configured so the runtime view can be adjusted for authentication.

*Call graph*: called by 1 (effective_mcp_servers).


##### `effective_mcp_servers`  (lines 242–247)

```
fn effective_mcp_servers(
    config: &McpConfig,
    auth: Option<&CodexAuth>,
) -> HashMap<String, EffectiveMcpServer>
```

**Purpose**: This produces the MCP server list Codex should actually use right now. It starts with configured servers and then applies runtime checks such as whether hosted apps are allowed for the current login.

**Data flow**: It receives config and optional auth. It gets the configured server map, passes it along with config and auth to effective_mcp_servers_from_configured, and returns the filtered map of effective servers.

**Call relations**: read_mcp_resource and collect_mcp_server_status_snapshot_with_detail call this before opening MCP connections. It is the common doorway for turning configuration into a usable runtime server list.

*Call graph*: calls 2 internal fn (configured_mcp_servers, effective_mcp_servers_from_configured); called by 2 (collect_mcp_server_status_snapshot_with_detail, read_mcp_resource).


##### `effective_mcp_servers_from_configured`  (lines 253–266)

```
fn effective_mcp_servers_from_configured(
    configured_servers: HashMap<String, McpServerConfig>,
    config: &McpConfig,
    auth: Option<&CodexAuth>,
) -> HashMap<String, EffectiveMcpServer>
```

**Purpose**: This converts an already-built server map into the runtime server view. Its main special rule is to remove the host-owned Codex apps server when the current config or login does not permit it.

**Data flow**: It receives a map of configured servers, wraps each one as an EffectiveMcpServer, checks whether host-owned apps are enabled, and removes the codex_apps entry if not. It returns the resulting server map.

**Call relations**: effective_mcp_servers calls this after gathering configured servers. It calls host_owned_codex_apps_enabled to enforce the auth gate for the hosted apps server.

*Call graph*: calls 1 internal fn (host_owned_codex_apps_enabled); called by 1 (effective_mcp_servers).


##### `tool_plugin_provenance`  (lines 268–270)

```
fn tool_plugin_provenance(config: &McpConfig) -> ToolPluginProvenance
```

**Purpose**: This is a small public wrapper that builds plugin provenance information from MCP config. It gives other code one simple call for attribution data.

**Data flow**: It receives McpConfig, passes it to ToolPluginProvenance::from_config, and returns the resulting provenance object.

**Call relations**: read_mcp_resource and collect_mcp_server_status_snapshot_with_detail call this before creating an McpConnectionManager. The manager then has the plugin source information it needs while working with tools.

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

**Purpose**: This reads one resource URI from one MCP server. It creates a short-lived MCP connection manager, asks for the resource, and then shuts the manager down.

**Data flow**: It receives config, optional auth, runtime context, a server name, and a resource URI. It builds the current effective server map, keeps only the requested server, computes auth status, creates an event channel and cancellation token, starts an McpConnectionManager, asks it to read the resource, cancels the temporary manager, and returns the read result or an error.

**Call relations**: This function pulls together many helpers: effective_mcp_servers chooses available servers, host_owned_codex_apps_enabled applies hosted-app rules, compute_auth_statuses prepares login state, codex_apps_tools_cache_key supplies the apps cache key, and tool_plugin_provenance adds plugin attribution. It hands the actual network/protocol work to McpConnectionManager::new and then to the manager's read_resource method.

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

**Purpose**: This collects a snapshot of MCP server status for reporting or UI use. The snapshot can include server info, tools, auth states, and optionally resources and resource templates.

**Data flow**: It receives config, optional auth, a submit ID, runtime context, and a detail level. It builds the effective server map, returns an empty snapshot if there are no servers, computes auth statuses, creates a temporary connection manager, asks a helper to gather the snapshot data, cancels the manager, and returns the snapshot.

**Call relations**: This is the high-level snapshot flow. It uses effective_mcp_servers, host_owned_codex_apps_enabled, compute_auth_statuses, codex_apps_tools_cache_key, and tool_plugin_provenance to set up the manager, then delegates the actual listing and conversion work to collect_mcp_server_status_snapshot_from_manager.

*Call graph*: calls 8 internal fn (codex_apps_tools_cache_key, new, compute_auth_statuses, collect_mcp_server_status_snapshot_from_manager, effective_mcp_servers, host_owned_codex_apps_enabled, tool_plugin_provenance, default); 4 external calls (new, new, new, unbounded).


##### `sanitize_responses_api_tool_name`  (lines 404–419)

```
fn sanitize_responses_api_tool_name(name: &str) -> String
```

**Purpose**: This cleans a tool name so it follows the Responses API rule that names contain only letters, numbers, and underscores. It prevents user-controlled MCP server or tool names from breaking API requests.

**Data flow**: It receives a name string, walks through each character, keeps ASCII letters, digits, and underscores, and replaces everything else with an underscore. If the result would be empty, it returns a single underscore.

**Call relations**: qualified_mcp_tool_name_prefix calls this when building MCP tool prefixes. Tool-normalizing code also calls it when preparing final tool names for the model.

*Call graph*: called by 2 (qualified_mcp_tool_name_prefix, normalize_tools_for_model_with_prefix); 1 external calls (with_capacity).


##### `codex_apps_mcp_bearer_token_env_var`  (lines 421–428)

```
fn codex_apps_mcp_bearer_token_env_var() -> Option<String>
```

**Purpose**: This checks whether the environment variable for a Codex connectors bearer token should be used. A bearer token is a secret string sent with HTTP requests to prove authorization.

**Data flow**: It reads the CODEX_CONNECTORS_TOKEN environment variable. If it is present and not blank, or present but not valid Unicode, it returns the variable name so the transport can read it later. If it is missing or blank, it returns no value.

**Call relations**: mcp_server_config_for_url calls this while building HTTP transport config for hosted MCP servers. The result tells the transport where to find an optional authorization token.

*Call graph*: called by 1 (mcp_server_config_for_url); 1 external calls (var).


##### `normalize_codex_apps_base_url`  (lines 430–439)

```
fn normalize_codex_apps_base_url(base_url: &str) -> String
```

**Purpose**: This standardizes ChatGPT base URLs before MCP endpoint paths are added. It removes trailing slashes and adds the backend API path for known ChatGPT hosts when needed.

**Data flow**: It receives a base URL string, trims trailing slash characters, and, for chatgpt.com or chat.openai.com URLs without /backend-api, appends /backend-api. It returns the normalized URL.

**Call relations**: codex_apps_mcp_url_for_base_url and hosted_plugin_runtime_mcp_server_config both call this before constructing their final MCP endpoint URLs.

*Call graph*: called by 2 (codex_apps_mcp_url_for_base_url, hosted_plugin_runtime_mcp_server_config); 1 external calls (format!).


##### `codex_apps_mcp_url_for_base_url`  (lines 441–451)

```
fn codex_apps_mcp_url_for_base_url(base_url: &str) -> String
```

**Purpose**: This builds the exact HTTP URL for the ChatGPT-hosted Codex apps MCP server. It adapts to different base URL shapes so callers can provide either a root URL or an API URL.

**Data flow**: It receives a base URL, normalizes it, chooses the right default path based on whether the URL already contains /backend-api or /api/codex, and returns the final apps MCP URL.

**Call relations**: codex_apps_mcp_server_config calls this first, then uses the URL to build a full McpServerConfig.

*Call graph*: calls 1 internal fn (normalize_codex_apps_base_url); called by 1 (codex_apps_mcp_server_config); 1 external calls (format!).


##### `codex_apps_mcp_server_config`  (lines 453–461)

```
fn codex_apps_mcp_server_config(
    chatgpt_base_url: &str,
    apps_mcp_product_sku: Option<&str>,
) -> McpServerConfig
```

**Purpose**: This creates the full MCP server configuration for the ChatGPT-hosted Codex apps server. It hides the URL and transport details behind a simple function.

**Data flow**: It receives the ChatGPT base URL and an optional product SKU. It builds the apps MCP URL, passes that URL and SKU to mcp_server_config_for_url, and returns the completed server config.

**Call relations**: It uses codex_apps_mcp_url_for_base_url for the endpoint and mcp_server_config_for_url for the shared HTTP server settings.

*Call graph*: calls 2 internal fn (codex_apps_mcp_url_for_base_url, mcp_server_config_for_url).


##### `hosted_plugin_runtime_mcp_server_config`  (lines 464–475)

```
fn hosted_plugin_runtime_mcp_server_config(
    chatgpt_base_url: &str,
    apps_mcp_product_sku: Option<&str>,
) -> McpServerConfig
```

**Purpose**: This creates the full MCP server configuration for the hosted plugin runtime served by plugin-service. It is similar to the apps server config, but points at the plugin runtime path.

**Data flow**: It receives the ChatGPT base URL and optional product SKU. It normalizes the base URL, ensures it has an API base when needed, appends /ps/mcp, and passes the final URL to mcp_server_config_for_url.

**Call relations**: It shares the same lower-level config builder as the apps server. normalize_codex_apps_base_url prepares the base URL, and mcp_server_config_for_url fills in transport defaults.

*Call graph*: calls 2 internal fn (mcp_server_config_for_url, normalize_codex_apps_base_url); 1 external calls (format!).


##### `mcp_server_config_for_url`  (lines 477–504)

```
fn mcp_server_config_for_url(url: String, apps_mcp_product_sku: Option<&str>) -> McpServerConfig
```

**Purpose**: This builds a standard HTTP-based McpServerConfig for a hosted MCP endpoint. It centralizes defaults such as timeout, environment ID, enabled state, and optional product headers.

**Data flow**: It receives a URL and optional product SKU. If a SKU is provided, it creates an HTTP header for it. It also checks whether a bearer-token environment variable is available, then returns an McpServerConfig using streamable HTTP transport and default hosted-server settings.

**Call relations**: codex_apps_mcp_server_config and hosted_plugin_runtime_mcp_server_config both call this so they get the same transport behavior. It calls codex_apps_mcp_bearer_token_env_var to wire in optional token-based authorization.

*Call graph*: calls 1 internal fn (codex_apps_mcp_bearer_token_env_var); called by 2 (codex_apps_mcp_server_config, hosted_plugin_runtime_mcp_server_config); 2 external calls (from_secs, new).


##### `protocol_tool_from_rmcp_tool`  (lines 506–520)

```
fn protocol_tool_from_rmcp_tool(name: &str, tool: &rmcp::model::Tool) -> Option<Tool>
```

**Purpose**: This converts a tool object from the rmcp library's format into Codex's protocol format. If conversion fails, it logs a warning and skips that tool instead of crashing the whole snapshot.

**Data flow**: It receives a tool name and an rmcp tool. It serializes the tool to JSON, asks Codex's Tool type to read that JSON, and returns the converted tool on success. On serialization or conversion failure, it logs what went wrong and returns no tool.

**Call relations**: collect_mcp_server_status_snapshot_from_manager calls this for each listed MCP tool. This keeps the snapshot builder working even if one server returns a malformed or unsupported tool description.

*Call graph*: calls 1 internal fn (from_mcp_value); called by 1 (collect_mcp_server_status_snapshot_from_manager); 2 external calls (to_value, warn!).


##### `auth_statuses_from_entries`  (lines 522–529)

```
fn auth_statuses_from_entries(
    auth_status_entries: &HashMap<String, crate::mcp::auth::McpAuthStatusEntry>,
) -> HashMap<String, McpAuthStatus>
```

**Purpose**: This extracts the public authentication status values from richer internal auth status entries. It prepares auth data for the final snapshot shape.

**Data flow**: It receives a map from server name to auth status entry. For each entry, it copies the server name and the entry's auth_status field into a new map, then returns that map.

**Call relations**: collect_mcp_server_status_snapshot_from_manager calls this while assembling the final McpServerStatusSnapshot. It strips the data down to what the snapshot needs.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager).


##### `convert_mcp_resources`  (lines 531–568)

```
fn convert_mcp_resources(
    resources: HashMap<String, Vec<rmcp::model::Resource>>,
) -> HashMap<String, Vec<Resource>>
```

**Purpose**: This converts resource descriptions from the rmcp library into Codex protocol Resource objects. Bad individual resources are logged and left out, so one broken resource does not ruin the whole list.

**Data flow**: It receives a map of server names to rmcp resources. For each resource, it serializes it to JSON and asks Codex's Resource type to parse it. Successful resources are collected under the same server name; failed ones are skipped after a warning that tries to include the URI and name.

**Call relations**: collect_mcp_server_status_snapshot_from_manager calls this after listing resources from the connection manager. The converted map goes directly into the returned status snapshot.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager).


##### `convert_mcp_resource_templates`  (lines 570–608)

```
fn convert_mcp_resource_templates(
    resource_templates: HashMap<String, Vec<rmcp::model::ResourceTemplate>>,
) -> HashMap<String, Vec<ResourceTemplate>>
```

**Purpose**: This converts rmcp resource templates into Codex protocol ResourceTemplate objects. A resource template is a pattern for resource URIs, like a form with blanks to fill in.

**Data flow**: It receives a map of server names to rmcp resource templates. It serializes each template to JSON, parses it into Codex's ResourceTemplate type, and collects successful conversions. If a template cannot be converted, it logs a warning with the template URI and name when possible, then skips it.

**Call relations**: collect_mcp_server_status_snapshot_from_manager calls this after listing resource templates. The resulting map is placed in the final snapshot alongside tools, resources, server info, and auth status.

*Call graph*: called by 1 (collect_mcp_server_status_snapshot_from_manager).


##### `collect_mcp_server_status_snapshot_from_manager`  (lines 610–656)

```
async fn collect_mcp_server_status_snapshot_from_manager(
    mcp_connection_manager: &McpConnectionManager,
    auth_status_entries: HashMap<String, crate::mcp::auth::McpAuthStatusEntry>,
    server_
```

**Purpose**: This gathers status information from an already-created MCP connection manager and packages it into an McpServerStatusSnapshot. It is the lower-level worker behind the public snapshot function.

**Data flow**: It receives a connection manager, auth status entries, the server names to report, and a detail setting. It asks the manager for tools, and, when requested, resources and resource templates. It also asks for available server info. Then it converts raw tools and resources into Codex protocol types, builds maps by server, converts auth entries into simple statuses, and returns the final snapshot.

**Call relations**: collect_mcp_server_status_snapshot_with_detail creates the manager and calls this helper. This function calls the manager's listing methods, uses protocol_tool_from_rmcp_tool for tools, convert_mcp_resources and convert_mcp_resource_templates for resource data, and auth_statuses_from_entries for auth data.

*Call graph*: calls 5 internal fn (list_available_server_infos, auth_statuses_from_entries, convert_mcp_resource_templates, convert_mcp_resources, protocol_tool_from_rmcp_tool); called by 1 (collect_mcp_server_status_snapshot_with_detail); 2 external calls (new, join!).


### Tool exposure and invocation
These files shape MCP tools for model visibility, adapt them into the core tool runtime, and execute approved MCP tool calls including file-argument rewriting.

### `codex-mcp/src/tools.rs`

`domain_logic` · `tool discovery and tool listing`

MCP servers can publish tools with raw names and schemas that are valid for the server, but not always safe or clear for the model-facing API. This file is the translation desk between those two worlds. It keeps the original server and tool names so calls can still be routed back correctly, while creating clean model-visible names that fit API limits and do not collide with one another. Think of it like assigning public display names to people at a conference while keeping their legal names in the registration system.

The central data type is `ToolInfo`, which stores both the raw MCP details and the model-facing namespace and tool name. `ToolFilter` applies per-server allow and block lists, so a configuration can expose only certain tools. The schema helpers look for metadata that says a parameter is an OpenAI file input, then rewrite that part of the tool schema so the model is told to provide an absolute local file path.

The largest job here is name normalization. MCP tool names may contain invalid characters, duplicate each other after cleanup, or be too long. The code sanitizes names, optionally adds the older `mcp__` prefix, detects collisions, appends short SHA-1 hash suffixes when needed, trims names to the 64-byte limit, and sorts the result for stable output.

#### Function details

##### `ToolInfo::canonical_tool_name`  (lines 59–61)

```
fn canonical_tool_name(&self) -> ToolName
```

**Purpose**: Builds the standard full tool name from the model-visible namespace and tool name. This gives other parts of the system one consistent label to use when referring to a tool.

**Data flow**: It reads `callable_namespace` and `callable_name` from one `ToolInfo` value, combines them through `ToolName::namespaced`, and returns a `ToolName`. It does not change the tool information.

**Call relations**: When other code needs a stable tool label, such as while naming a tool, building MCP search text, or creating a tool specification, it calls this method. This method hands the two visible name parts to the shared `namespaced` constructor so the format stays consistent.

*Call graph*: calls 1 internal fn (namespaced); called by 3 (tool_name, build_mcp_search_text, create_tool_spec).


##### `declared_openai_file_input_param_names`  (lines 64–79)

```
fn declared_openai_file_input_param_names(
    meta: Option<&Map<String, JsonValue>>,
) -> Vec<String>
```

**Purpose**: Finds which tool parameters have been marked as file-input parameters. These are parameters where the model should provide a local file path rather than ordinary free-form text.

**Data flow**: It receives optional metadata from a tool. If the metadata contains an `openai/fileParams` array, it keeps the non-empty string entries and returns them as a list of parameter names. If the metadata is missing or malformed, it returns an empty list.

**Call relations**: `tool_with_model_visible_input_schema` calls this first to decide whether any schema rewriting is needed. If this function returns no names, the later masking step can be skipped.

*Call graph*: called by 1 (tool_with_model_visible_input_schema); 1 external calls (new).


##### `ToolFilter::from_config`  (lines 91–103)

```
fn from_config(cfg: &McpServerConfig) -> Self
```

**Purpose**: Turns a server configuration into a simple filter object that can answer whether each tool should be exposed. It captures both an optional allow list and a block list.

**Data flow**: It reads `enabled_tools` and `disabled_tools` from an `McpServerConfig`. Enabled tools become an optional set, disabled tools become a set or an empty set, and the function returns a `ToolFilter` containing those rules.

**Call relations**: This is the setup step for filtering. Once configuration has been converted into a `ToolFilter`, later code can call `allows` for each tool name instead of repeatedly reading the raw configuration.


##### `ToolFilter::allows`  (lines 105–113)

```
fn allows(&self, tool_name: &str) -> bool
```

**Purpose**: Answers the practical question: should this named tool be available? A tool is allowed only if it is in the allow list when one exists, and it is not in the block list.

**Data flow**: It receives a tool name. It first checks the optional enabled set; if that set exists and the name is absent, it returns `false`. Otherwise it checks the disabled set and returns `false` for blocked names or `true` for allowed names.

**Call relations**: `filter_tools` uses this rule while walking through discovered tools. This method is the small decision point that turns configuration rules into keep-or-drop choices.


##### `tool_with_model_visible_input_schema`  (lines 119–132)

```
fn tool_with_model_visible_input_schema(tool: &Tool) -> Tool
```

**Purpose**: Creates the version of a tool schema that should be shown to the model, especially for file inputs. It preserves the raw tool for execution but changes the visible schema so file parameters are described as absolute local file paths.

**Data flow**: It takes a tool definition and reads its metadata. If no file parameters are declared, it returns a clone of the tool unchanged. If file parameters exist, it clones the tool, edits the input schema for those parameters, and returns the modified clone.

**Call relations**: This is called at boundaries where tools are returned for model use, including tests that verify both unchanged and masked cases. It first asks `declared_openai_file_input_param_names` which fields matter, then passes the schema to `mask_input_schema_for_file_path_params` to rewrite those fields.

*Call graph*: calls 2 internal fn (declared_openai_file_input_param_names, mask_input_schema_for_file_path_params); called by 2 (tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged, tool_with_model_visible_input_schema_masks_file_params); 3 external calls (new, Object, clone).


##### `filter_tools`  (lines 134–139)

```
fn filter_tools(tools: Vec<ToolInfo>, filter: &ToolFilter) -> Vec<ToolInfo>
```

**Purpose**: Removes tools that are not allowed by a `ToolFilter`. This is how per-server configuration changes the actual tool list that gets exposed.

**Data flow**: It receives a list of `ToolInfo` values and a filter. It checks each tool's raw MCP name against the filter and returns a new list containing only the allowed tools.

**Call relations**: Tool listing and cache refresh paths call this before exposing tools, including server startup and listed-tool flows. It relies on `ToolFilter::allows` for the yes-or-no decision for each tool.

*Call graph*: called by 4 (hard_refresh_codex_apps_tools_cache, filter_tools_applies_per_server_filters, listed_tools, start_server_task).


##### `normalize_tools_for_model_with_prefix`  (lines 149–249)

```
fn normalize_tools_for_model_with_prefix(
    tools: I,
    prefix_mcp_tool_names: bool,
) -> Vec<ToolInfo>
```

**Purpose**: Converts raw tool records into model-safe tool records with clean, unique, length-limited visible names. This is what prevents two different MCP tools from accidentally looking identical to the model.

**Data flow**: It receives tool records and a flag saying whether to add the legacy `mcp__` prefix. For each tool, it builds raw identities, skips exact duplicates, sanitizes namespace and tool names, detects namespace and tool-name collisions, adds hash suffixes where needed, sorts the results for stable output, and finally ensures every full model name is unique and within the maximum length. It returns the normalized list.

**Call relations**: This function is used when refreshing cached tools and listing all tools, and it is heavily tested for duplicate names, invalid characters, long names, and collision cases. It coordinates the smaller helpers: sanitizing names, adding prefixes, appending hashes, and fitting names under the API limit.

*Call graph*: calls 5 internal fn (sanitize_responses_api_tool_name, append_hash_suffix, append_namespace_hash_suffix, callable_namespace_with_prefix, unique_callable_parts); called by 9 (hard_refresh_codex_apps_tools_cache, list_all_tools, test_normalize_tools_disambiguates_sanitized_namespace_collisions, test_normalize_tools_disambiguates_sanitized_tool_name_collisions, test_normalize_tools_duplicated_names_skipped, test_normalize_tools_keeps_hyphenated_mcp_tools_callable, test_normalize_tools_long_names_same_server, test_normalize_tools_sanitizes_invalid_characters, test_normalize_tools_short_non_duplicated_names); 6 external calls (new, new, new, new, format!, warn!).


##### `callable_namespace_with_prefix`  (lines 265–271)

```
fn callable_namespace_with_prefix(namespace: &str, prefix_mcp_tool_names: bool) -> String
```

**Purpose**: Adds the legacy MCP namespace prefix when requested. It avoids adding the prefix twice if the namespace already starts with it.

**Data flow**: It receives a namespace and a boolean flag. If prefixing is disabled, or the namespace already begins with `mcp__`, it returns the namespace unchanged. Otherwise it returns a new string with `mcp__` in front.

**Call relations**: `normalize_tools_for_model_with_prefix` calls this after sanitizing each namespace. It is the small compatibility step that keeps older naming behavior available without reintroducing the old full naming format.

*Call graph*: called by 1 (normalize_tools_for_model_with_prefix); 1 external calls (format!).


##### `mask_input_schema_for_file_path_params`  (lines 273–288)

```
fn mask_input_schema_for_file_path_params(input_schema: &mut JsonValue, file_params: &[String])
```

**Purpose**: Finds the schema entries for parameters that should be treated as file paths and rewrites only those entries. This makes file-related inputs clearer to the model without changing unrelated parameters.

**Data flow**: It receives a mutable JSON schema and a list of parameter names. It looks inside the schema's `properties` object, finds matching fields, and passes each matching field schema to `mask_input_property_schema`. If the schema does not have the expected shape, it leaves it unchanged.

**Call relations**: `tool_with_model_visible_input_schema` calls this after identifying file parameters. This function then delegates the actual per-field rewrite to `mask_input_property_schema`.

*Call graph*: calls 1 internal fn (mask_input_property_schema); called by 1 (tool_with_model_visible_input_schema); 1 external calls (as_object_mut).


##### `mask_input_property_schema`  (lines 290–317)

```
fn mask_input_property_schema(schema: &mut JsonValue)
```

**Purpose**: Rewrites one parameter schema so it clearly asks for an absolute local file path. It keeps the schema simple and prevents the model from thinking it should upload or construct a complex object.

**Data flow**: It receives one JSON schema value. If the value is an object, it reads or creates a description, appends file-path guidance if needed, detects whether the original looked like an array, clears the old details, and writes back either a string schema or an array-of-strings schema with the improved description.

**Call relations**: `mask_input_schema_for_file_path_params` calls this for each declared file parameter found in a tool's input schema. It is the final step that changes the visible schema text and type.

*Call graph*: called by 1 (mask_input_schema_for_file_path_params); 4 external calls (String, as_object_mut, format!, json!).


##### `sha1_hex`  (lines 319–324)

```
fn sha1_hex(s: &str) -> String
```

**Purpose**: Computes a SHA-1 hash as hexadecimal text. Here, the hash is used as a compact fingerprint for a raw tool identity when names need to be disambiguated.

**Data flow**: It receives a string, feeds its bytes into a SHA-1 hasher, finalizes the hash, and returns the hash as lowercase hexadecimal text.

**Call relations**: `callable_name_hash_suffix` calls this when it needs a stable short fingerprint. The hash then becomes part of a tool or namespace name to separate otherwise-colliding names.

*Call graph*: called by 1 (callable_name_hash_suffix); 2 external calls (new, format!).


##### `callable_name_hash_suffix`  (lines 326–329)

```
fn callable_name_hash_suffix(raw_identity: &str) -> String
```

**Purpose**: Creates the short hash suffix used in model-visible names. This gives two similar-looking tools a small, stable difference based on their raw identity.

**Data flow**: It receives a raw identity string, hashes it with `sha1_hex`, keeps the configured leading part of the hash, prefixes it with an underscore, and returns that suffix.

**Call relations**: `fit_callable_parts_with_hash` uses this when shortening names, and other hash-appending helpers depend on the same suffix format. This keeps all disambiguation suffixes consistent.

*Call graph*: calls 1 internal fn (sha1_hex); called by 1 (fit_callable_parts_with_hash); 1 external calls (format!).


##### `append_hash_suffix`  (lines 331–333)

```
fn append_hash_suffix(value: &str, raw_identity: &str) -> String
```

**Purpose**: Adds a short identity-based hash suffix to a name. This is used when a cleaned-up name would otherwise collide with another cleaned-up name.

**Data flow**: It receives a visible name and the raw identity it represents. It builds a hash suffix from the raw identity and returns the original name followed by that suffix.

**Call relations**: `normalize_tools_for_model_with_prefix` calls this for colliding tool names. `append_namespace_hash_suffix` also uses it when a namespace does not need special delimiter handling.

*Call graph*: called by 2 (append_namespace_hash_suffix, normalize_tools_for_model_with_prefix); 1 external calls (format!).


##### `append_namespace_hash_suffix`  (lines 335–346)

```
fn append_namespace_hash_suffix(namespace: &str, raw_identity: &str) -> String
```

**Purpose**: Adds a hash suffix to a namespace while preserving a trailing namespace delimiter when one is present. This keeps names readable and still separates colliding namespaces.

**Data flow**: It receives a namespace and raw namespace identity. If the namespace ends with the MCP delimiter, it inserts the hash before that delimiter. Otherwise it simply appends the hash suffix to the namespace. The result is a disambiguated namespace string.

**Call relations**: `normalize_tools_for_model_with_prefix` calls this when two different raw namespaces sanitize to the same visible namespace. It calls `append_hash_suffix` for the simpler case without a trailing delimiter.

*Call graph*: calls 1 internal fn (append_hash_suffix); called by 1 (normalize_tools_for_model_with_prefix); 1 external calls (format!).


##### `truncate_name`  (lines 348–350)

```
fn truncate_name(value: &str, max_len: usize) -> String
```

**Purpose**: Shortens a name to a maximum number of characters. It is used when a model-visible name must fit within the API length limit.

**Data flow**: It receives a string and a maximum character count. It takes characters from the start up to that count and returns the shortened string.

**Call relations**: `fit_callable_parts_with_hash` calls this when either the tool name or namespace needs to be cut down to make room for a hash suffix and the required delimiter space.

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

**Purpose**: Builds namespace and tool-name parts that fit within the maximum allowed model name length while still including a hash. This is the fallback when the original visible name is too long or already used.

**Data flow**: It receives a namespace, tool name, raw identity, and reserved length. It creates a hash suffix, calculates how much space remains, and either truncates the tool name to make room for the suffix or, if space is very tight, truncates the namespace and uses the suffix as the tool name. It returns the adjusted pair.

**Call relations**: `unique_callable_parts` calls this whenever the straightforward namespace-plus-tool-name cannot be used. This helper does the careful length budgeting so the caller can focus on uniqueness.

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

**Purpose**: Chooses final model-visible namespace and tool-name parts that are both unique and short enough. It is the last guardrail before normalized tools are returned.

**Data flow**: It receives candidate namespace and tool-name strings, the raw identity, a shared set of already-used full names, and reserved length. It first tries the plain combined name. If that is too long or already taken, it repeatedly asks `fit_callable_parts_with_hash` for a hashed version, changing the hash input on later attempts until it finds an unused name. It records the chosen full name and returns the two final parts.

**Call relations**: `normalize_tools_for_model_with_prefix` calls this for each candidate after collision detection and sorting. This function hands back the exact namespace and tool name that are written into the final `ToolInfo`.

*Call graph*: calls 1 internal fn (fit_callable_parts_with_hash); called by 1 (normalize_tools_for_model_with_prefix); 1 external calls (format!).


### `core/src/mcp_tool_exposure.rs`

`domain_logic` · `tool list preparation`

MCP tools are outside capabilities that the model can call, a bit like tools in a toolbox. If the toolbox is small, it is fine to lay every tool on the table. If it is huge, showing everything at once can confuse the model and waste space, so this file decides whether to expose tools directly or defer them so they can be found through search.

The main entry point builds a filtered list of tools that are safe and appropriate for the model to know about. It first includes normal MCP tools, but only if they are marked as visible to the model. It then separately considers tools from the special Codex apps MCP server. Those app tools get extra checks: the connected app must be one of the allowed connectors, the tool must name its connector, it must be model-visible, and a policy evaluator must say the tool is enabled under the current configuration.

After filtering, the file decides how to present the tools. If tool search is enabled and either a feature flag says to always defer MCP tools or there are at least 100 tools, the tools are placed in the deferred bucket. Otherwise, they are returned as direct tools. This protects the model from a long, noisy tool list while preserving access through search.

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

**Purpose**: This function makes the final decision about which MCP tools the model sees immediately and which ones are saved for later discovery through tool search. It is used when the system is building the model's available tool set.

**Data flow**: It receives the full MCP tool list, optional app connector information, the current configuration, and whether tool search is enabled. It filters out tools that should not be visible, adds allowed Codex app tools when connector data is available, then checks the feature settings and the number of tools. It returns a `McpToolExposure` value with either a direct tool list, a deferred tool list, or both arranged according to that decision.

**Call relations**: When `built_tools` is assembling the tools for a run, it calls this function to decide how MCP tools should be exposed. This function delegates the two filtering jobs to `filter_non_codex_apps_mcp_tools_only` and `filter_codex_apps_mcp_tools`, then combines their results and applies the deferral rule.

*Call graph*: calls 2 internal fn (filter_codex_apps_mcp_tools, filter_non_codex_apps_mcp_tools_only); called by 1 (built_tools); 1 external calls (new).


##### `filter_non_codex_apps_mcp_tools_only`  (lines 56–64)

```
fn filter_non_codex_apps_mcp_tools_only(mcp_tools: &[McpToolInfo]) -> Vec<McpToolInfo>
```

**Purpose**: This function selects ordinary MCP tools that are not from the special Codex apps server and are allowed to be shown to the model. It keeps unrelated or hidden tools out of the direct candidate list.

**Data flow**: It receives a slice of MCP tool descriptions. It looks through each tool, keeps only tools whose server is not the Codex apps MCP server and whose metadata says the model may see them, then returns cloned copies of the matching tools as a new list.

**Call relations**: `build_mcp_tool_exposure` calls this first to gather the baseline set of visible non-app MCP tools. Its output becomes part of the candidate tool list that may later be shown directly or deferred for search.

*Call graph*: called by 1 (build_mcp_tool_exposure); 1 external calls (iter).


##### `filter_codex_apps_mcp_tools`  (lines 66–105)

```
fn filter_codex_apps_mcp_tools(
    mcp_tools: &[McpToolInfo],
    connectors: &[connectors::AppInfo],
    config: &Config,
) -> Vec<McpToolInfo>
```

**Purpose**: This function selects MCP tools that come from Codex apps, but only when the connected app and the current policy allow them. It is the extra safety gate for app-provided tools.

**Data flow**: It receives all MCP tools, the list of available app connectors, and the current configuration. It builds a quick lookup of allowed connector IDs, creates a policy evaluator from the configuration layers, then checks each tool from the Codex apps server. A tool is kept only if it is model-visible, has a connector ID, belongs to an allowed connector, and passes the app tool policy check using details such as the tool name, title, and hints about destructive or open-ended behavior. It returns cloned copies of the app tools that pass all checks.

**Call relations**: `build_mcp_tool_exposure` calls this when connector information is available, so app tools can be added to the same exposure decision as other MCP tools. This function hands policy-approved app tools back to the main builder, which then decides whether they appear directly or through tool search.

*Call graph*: calls 1 internal fn (new); called by 1 (build_mcp_tool_exposure); 2 external calls (iter, iter).


### `core/src/tools/handlers/mcp.rs`

`domain_logic` · `tool registration and tool-call handling`

This file is the adapter between external MCP tools and Codex’s internal tool system. Without it, a tool exposed by an MCP server might exist, but Codex would not know how to name it, show it to the model, call it, record telemetry for it, or let pre- and post-tool hooks inspect it.

The central type is `McpHandler`. It keeps two things: the original MCP tool information and a converted `ToolSpec`, which is the shape Codex uses when telling the model what tools are available. Think of it like a travel plug adapter: the outside tool keeps its own shape, but this file makes it fit Codex’s socket.

When a tool call arrives, the handler checks that the call is a normal function-style call with JSON arguments. It then forwards the call to the MCP execution layer, measures how long it took, and wraps the result in Codex’s standard tool-output format.

The file also standardizes names for hooks. MCP hook names are given an `mcp__` prefix and combine namespace plus tool name with `__`, so they do not collide with built-in tools. It also builds searchable text from the tool’s name, description, server, connector, plugin labels, and parameter names, so tool discovery can find the right external tool. The tests lock down these naming, rewriting, post-hook, and parallel-call rules.

#### Function details

##### `McpHandler::new`  (lines 38–41)

```
fn new(tool_info: ToolInfo) -> Result<Self, serde_json::Error>
```

**Purpose**: Creates a new MCP tool handler from raw MCP tool information. It also prepares the tool description that Codex will later show to the model.

**Data flow**: It receives a `ToolInfo` record from MCP discovery. It passes that record into `create_tool_spec` to convert the MCP description into Codex’s internal tool specification. If conversion succeeds, it returns an `McpHandler` holding both the original MCP information and the converted spec; if the JSON schema cannot be converted, it returns that error.

**Call relations**: This is called when MCP runtime tools are added, and also by tests that build sample handlers. It delegates the format conversion to `create_tool_spec`, then the resulting handler is used later for naming, searching, hook payloads, and actual tool execution.

*Call graph*: calls 1 internal fn (create_tool_spec); called by 7 (mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result, mcp_pre_tool_use_payload_keeps_builtin_like_tool_names_namespaced, mcp_pre_tool_use_payload_uses_prefixed_tool_name_and_raw_args, mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp, search_info_uses_connector_name_for_output_namespace_description, search_info_uses_mcp_tool_metadata_and_parameter_names, add_mcp_runtime_tools).


##### `McpHandler::hook_tool_name`  (lines 43–45)

```
fn hook_tool_name(&self) -> HookToolName
```

**Purpose**: Builds the safe, standardized name used when this MCP tool is reported to hook code. Hooks are extension points that can inspect or modify tool activity before or after a call.

**Data flow**: It reads the handler’s canonical tool name, joins the namespace and name into one string, makes sure the string starts with `mcp__`, and wraps it as a `HookToolName`. The output is a hook-facing name such as `mcp__filesystem__read_file`.

**Call relations**: This helper is used before a tool call, after a tool call, and during the actual MCP call. It relies on `McpHandler::tool_name`, `join_tool_name`, and `ensure_mcp_prefix` so all hook-related paths use the same naming rule.

*Call graph*: calls 4 internal fn (tool_name, ensure_mcp_prefix, join_tool_name, new); called by 3 (handle_call, post_tool_use_payload, pre_tool_use_payload).


##### `join_tool_name`  (lines 48–57)

```
fn join_tool_name(tool_name: &ToolName) -> String
```

**Purpose**: Combines a tool namespace and tool name into one readable MCP-style name. This avoids ambiguity when different MCP servers or namespaces offer tools with similar names.

**Data flow**: It receives a `ToolName`. If the name has a namespace, it trims extra underscores at the boundary and returns `namespace__name`; if there is no namespace, it returns just the tool name.

**Call relations**: It is called only by `McpHandler::hook_tool_name`. It supplies the middle step in the hook-name pipeline before `ensure_mcp_prefix` adds the MCP marker if needed.

*Call graph*: called by 1 (hook_tool_name); 1 external calls (format!).


##### `ensure_mcp_prefix`  (lines 59–65)

```
fn ensure_mcp_prefix(name: &str) -> String
```

**Purpose**: Makes sure a hook tool name is clearly marked as coming from MCP. This protects against confusing an external MCP tool with a built-in Codex tool that has a similar name.

**Data flow**: It receives a name string. If the name already starts with `mcp__`, it returns it unchanged; otherwise, it adds `mcp__` to the front and returns the new string.

**Call relations**: It is called by `McpHandler::hook_tool_name` after namespace and tool name have been joined. Tests cover the important edge case where a namespace already looks like it has the MCP prefix.

*Call graph*: called by 1 (hook_tool_name); 1 external calls (format!).


##### `McpHandler::tool_name`  (lines 68–70)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical Codex name for this MCP tool. A canonical name is the normalized name used internally so the same tool is not referred to in several incompatible ways.

**Data flow**: It reads `tool_info` stored in the handler and asks it for its canonical tool name. It returns that `ToolName` value without changing other state.

**Call relations**: The tool registry calls this through the `ToolExecutor` interface when it needs to identify the tool. `McpHandler::hook_tool_name` also calls it before producing the hook-facing name.

*Call graph*: calls 1 internal fn (canonical_tool_name); called by 1 (hook_tool_name).


##### `McpHandler::spec`  (lines 72–74)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the Codex tool specification for this MCP tool. This is the description and input shape that can be advertised to the model.

**Data flow**: It reads the stored `ToolSpec`, clones it, and returns the clone. Nothing inside the handler is changed.

**Call relations**: The tool registry calls this through the `ToolExecutor` interface when building the available-tool list. `McpHandler::search_info` also uses it when constructing searchable metadata.

*Call graph*: called by 1 (search_info); 1 external calls (clone).


##### `McpHandler::supports_parallel_tool_calls`  (lines 76–87)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Decides whether this MCP tool may safely run at the same time as other tool calls. Parallel calls are allowed when the server explicitly allows them or when the tool says it is read-only.

**Data flow**: It reads two pieces of metadata: the server-level `supports_parallel_tool_calls` flag and the tool annotation called `read_only_hint`. If either says parallel use is safe, it returns `true`; otherwise it returns `false`.

**Call relations**: The tool runtime can ask this before scheduling calls concurrently. The tests check that read-only tools are allowed, writable or unannotated tools are not, and a server-level opt-in overrides that.


##### `McpHandler::search_info`  (lines 89–113)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Builds information that helps Codex find this tool during tool search. It gathers human-friendly words from the MCP tool, server, connector, and schema.

**Data flow**: It chooses a source name from the connector name if present, otherwise the server name. It optionally includes a source description, builds search text with `build_mcp_search_text`, combines that with the tool spec, and returns a `ToolSearchInfo` if the spec can support it.

**Call relations**: This is called by the tool registry or search layer when tools need to be indexed or discovered. It calls `McpHandler::spec` for the advertised shape and `build_mcp_search_text` for the bag of searchable words.

*Call graph*: calls 3 internal fn (spec, build_mcp_search_text, from_spec).


##### `McpHandler::handle`  (lines 115–117)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling one MCP tool invocation in the async tool-executor interface. It is the public entry point for running this handler’s tool.

**Data flow**: It receives a `ToolInvocation`, calls `handle_call` with it, and boxes the resulting asynchronous work so the broader tool system can store and await it uniformly.

**Call relations**: The tool registry calls this through the `ToolExecutor` interface when the model asks to run the MCP tool. It immediately hands the real work to `McpHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `McpHandler::handle_call`  (lines 121–161)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Actually runs an MCP tool call and wraps its answer in Codex’s standard output type. It also records elapsed time and carries output settings needed by later formatting.

**Data flow**: It receives a full `ToolInvocation`, pulls out the session, turn, call id, and payload, and requires the payload to be function arguments. If the payload is not supported, it returns an error message for the model. Otherwise it starts a timer, calls `handle_mcp_tool_call` with the server name, tool name, hook name, and raw arguments, waits for the MCP result, then returns a boxed `McpToolOutput` containing the result, rewritten input, elapsed time, image-detail support, and truncation policy.

**Call relations**: `McpHandler::handle` calls this whenever the tool is run. It calls into `handle_mcp_tool_call`, which is the lower layer that talks to the MCP server, and then uses `boxed_tool_output` so the rest of Codex can treat the result like any other tool output.

*Call graph*: calls 3 internal fn (handle_mcp_tool_call, boxed_tool_output, hook_tool_name); called by 1 (handle); 4 external calls (clone, now, can_request_original_image_detail, RespondToModel).


##### `McpHandler::telemetry_tags`  (lines 165–176)

```
fn telemetry_tags(
        &'a self,
        _invocation: &'a ToolInvocation,
    ) -> futures::future::BoxFuture<'a, ToolTelemetryTags>
```

**Purpose**: Produces labels for logging and metrics about this MCP tool. Telemetry tags help operators answer questions like which MCP server a tool call came from.

**Data flow**: It reads the MCP server name and optional server origin from `tool_info`. It returns an async result containing key-value pairs such as `mcp_server` and, when available, `mcp_server_origin`.

**Call relations**: The core tool runtime calls this around tool execution when recording telemetry. It does not call the MCP server; it only reports metadata already stored in the handler.

*Call graph*: 2 external calls (pin, vec!).


##### `McpHandler::pre_tool_use_payload`  (lines 178–187)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the payload sent to pre-tool hooks before an MCP tool runs. This gives hook code a clear tool name and a parsed version of the tool input.

**Data flow**: It looks at the invocation payload. If the payload is function arguments, it converts the raw argument string into JSON using `mcp_hook_tool_input`, pairs it with the standardized MCP hook name, and returns a `PreToolUsePayload`. If the payload is not function-shaped, it returns nothing.

**Call relations**: The core runtime calls this before tool execution when hooks are enabled. It uses `McpHandler::hook_tool_name` for consistent naming and `mcp_hook_tool_input` so hooks can inspect JSON arguments as structured data when possible.

*Call graph*: calls 2 internal fn (hook_tool_name, mcp_hook_tool_input).


##### `McpHandler::with_updated_hook_input`  (lines 189–210)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies input changes made by a pre-tool hook. If a hook rewrites the MCP tool input, this function turns that rewritten JSON back into the invocation format used by the executor.

**Data flow**: It receives the original `ToolInvocation` and a new JSON value. If the original payload was function arguments, it serializes the new JSON to a string and replaces the invocation’s arguments with that string. If serialization fails, or if the payload type cannot be rewritten, it returns an error for the model.

**Call relations**: The runtime calls this after a pre-tool hook asks to modify the input. It does not run the tool itself; it returns an updated invocation that can then continue into `McpHandler::handle`.

*Call graph*: 3 external calls (format!, to_string, RespondToModel).


##### `McpHandler::post_tool_use_payload`  (lines 211–228)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the payload sent to post-tool hooks after an MCP tool finishes. This lets hook code see both what was sent and what came back.

**Data flow**: It checks that the invocation used function arguments. It then asks the tool output to produce a hook-friendly input and response for this call id and payload. If both are available, it returns a `PostToolUsePayload` with the MCP hook name, tool-use id, input, and response.

**Call relations**: The runtime calls this after tool execution. It uses `McpHandler::hook_tool_name` for stable hook naming and relies on the `ToolOutput` object to translate the actual result into the post-hook format.

*Call graph*: calls 3 internal fn (hook_tool_name, post_tool_use_input, post_tool_use_response).


##### `create_tool_spec`  (lines 231–255)

```
fn create_tool_spec(tool_info: &ToolInfo) -> Result<ToolSpec, serde_json::Error>
```

**Purpose**: Converts MCP tool metadata into the tool specification format used by Codex’s Responses API tool list. This is what makes an external MCP tool presentable to the model.

**Data flow**: It receives a `ToolInfo`, gets the canonical tool name, converts the MCP tool definition into a Responses API function tool, chooses a namespace description from the MCP namespace description or connector name, and returns a `ToolSpec::Namespace` containing that one function tool.

**Call relations**: `McpHandler::new` calls this during handler construction. It depends on `mcp_tool_to_responses_api_tool` for the detailed schema conversion, then wraps the converted tool in the namespace structure Codex expects.

*Call graph*: calls 1 internal fn (canonical_tool_name); called by 1 (new); 3 external calls (mcp_tool_to_responses_api_tool, Namespace, vec!).


##### `mcp_hook_tool_input`  (lines 257–263)

```
fn mcp_hook_tool_input(raw_arguments: &str) -> Value
```

**Purpose**: Turns raw MCP argument text into the form hooks should see. Hooks work best with structured JSON, but this function preserves non-JSON text instead of failing.

**Data flow**: It receives the raw argument string. If it is empty or only whitespace, it returns an empty JSON object. If it parses as JSON, it returns that JSON value. If parsing fails, it returns the original text as a JSON string.

**Call relations**: `McpHandler::pre_tool_use_payload` calls this before a tool runs. It keeps hook input forgiving: malformed or plain-text arguments still reach hooks as data rather than causing the hook payload to disappear.

*Call graph*: called by 1 (pre_tool_use_payload); 3 external calls (new, Object, from_str).


##### `build_mcp_search_text`  (lines 265–311)

```
fn build_mcp_search_text(info: &ToolInfo) -> String
```

**Purpose**: Collects searchable words for an MCP tool. It helps search match a user’s intent against names, descriptions, server labels, plugin names, and parameter names.

**Data flow**: It receives a `ToolInfo`, extracts the canonical and callable names, raw MCP tool name, server name, optional title, optional description, connector name, namespace description, plugin display names, and input-schema property names. It sorts the property names, filters out empty text, joins everything with spaces, and returns one search string.

**Call relations**: `McpHandler::search_info` calls this when building the tool’s search metadata. Separate search tests use it indirectly to verify that MCP metadata and parameter names make the tool discoverable.

*Call graph*: calls 1 internal fn (canonical_tool_name); called by 1 (search_info); 1 external calls (vec!).


##### `tests::mcp_pre_tool_use_payload_uses_prefixed_tool_name_and_raw_args`  (lines 332–366)

```
async fn mcp_pre_tool_use_payload_uses_prefixed_tool_name_and_raw_args()
```

**Purpose**: Checks that a normal MCP tool produces the expected pre-hook payload. It proves that the hook name gets the `mcp__` prefix and that JSON arguments stay structured.

**Data flow**: The test builds a JSON function payload, creates a fake session and turn, constructs a handler for a sample `memory.create_entities` tool, and asks for the pre-tool payload. It compares the result with the exact expected hook name and parsed JSON input.

**Call relations**: This test calls `McpHandler::new` and then exercises `pre_tool_use_payload`. It protects the naming and input-parsing behavior used by runtime pre-tool hooks.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 3 external calls (assert_eq!, tool_info, json!).


##### `tests::mcp_pre_tool_use_payload_keeps_builtin_like_tool_names_namespaced`  (lines 369–393)

```
async fn mcp_pre_tool_use_payload_keeps_builtin_like_tool_names_namespaced()
```

**Purpose**: Checks that an MCP namespace that already starts with `mcp__` is not mangled or mistaken for a built-in tool. This avoids name collisions in hook handling.

**Data flow**: The test creates a function payload and a handler whose namespace is `mcp__foo`. It asks for the pre-tool payload and expects the hook name `mcp__foo__exec_command` with the original JSON input.

**Call relations**: This test uses `McpHandler::new` and `pre_tool_use_payload`. It specifically protects the interaction between `join_tool_name` and `ensure_mcp_prefix` for names that already look MCP-prefixed.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 3 external calls (assert_eq!, tool_info, json!).


##### `tests::mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp`  (lines 396–424)

```
async fn mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp()
```

**Purpose**: Checks that hook-rewritten input works even for MCP tools with names that look like built-in tool names. The important point is that the invocation remains a function-style MCP call with updated arguments.

**Data flow**: The test creates an invocation with JSON arguments, calls `with_updated_hook_input` with replacement JSON, then inspects the returned invocation. The output should contain the rewritten JSON string as the function arguments.

**Call relations**: This test constructs a handler with `McpHandler::new` and then exercises `with_updated_hook_input`. It protects the path where pre-tool hooks change arguments before `McpHandler::handle` runs.

*Call graph*: calls 4 internal fn (make_session_and_context, new, new, namespaced); 7 external calls (new, new, assert_eq!, tool_info, json!, panic!, new).


##### `tests::mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result`  (lines 427–482)

```
async fn mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result()
```

**Purpose**: Checks that post-tool hooks receive the right MCP hook name, tool input, call id, and response after an MCP tool finishes. This makes sure hooks can audit both sides of the tool call.

**Data flow**: The test builds a sample function payload and a sample `McpToolOutput` containing text content and structured content. It creates a handler and invocation, asks for the post-tool payload, and compares it to the expected JSON input and response.

**Call relations**: This test calls `McpHandler::new` and then exercises `post_tool_use_payload`. It verifies that the handler cooperates correctly with `McpToolOutput`’s post-hook formatting methods.

*Call graph*: calls 4 internal fn (make_session_and_context, new, new, namespaced); 9 external calls (new, from_millis, new, assert_eq!, tool_info, json!, Bytes, new, vec!).


##### `tests::mcp_read_only_hint_supports_parallel_calls_without_server_opt_in`  (lines 485–494)

```
fn mcp_read_only_hint_supports_parallel_calls_without_server_opt_in()
```

**Purpose**: Checks that a tool marked read-only can run in parallel even when the MCP server did not explicitly opt in. Read-only means the tool should not change outside state, so concurrent calls are safer.

**Data flow**: The test creates sample MCP tool information, marks its annotations as read-only, builds a handler, and asserts that `supports_parallel_tool_calls` returns true.

**Call relations**: This test exercises the scheduling-safety rule in `McpHandler::supports_parallel_tool_calls`. It guards the behavior that read-only MCP annotations are trusted for parallel execution.

*Call graph*: 3 external calls (assert!, tool_info, new).


##### `tests::mcp_parallel_calls_require_read_only_hint_or_server_opt_in`  (lines 497–520)

```
fn mcp_parallel_calls_require_read_only_hint_or_server_opt_in()
```

**Purpose**: Checks the negative and positive cases for parallel MCP calls. A tool should not run in parallel unless it is read-only or the server explicitly says parallel calls are supported.

**Data flow**: The test creates three sample tools: one with no read-only hint, one marked writable, and one with server-level parallel support. It builds handlers for each and asserts that only the server-opt-in case allows parallel calls.

**Call relations**: This test focuses on `McpHandler::supports_parallel_tool_calls`. Together with the read-only test, it documents the full rule used by the runtime scheduler.

*Call graph*: 3 external calls (assert!, tool_info, new).


##### `tests::tool_info`  (lines 522–541)

```
fn tool_info(server_name: &str, callable_namespace: &str, tool_name: &str) -> ToolInfo
```

**Purpose**: Builds small fake `ToolInfo` records for the tests in this file. It saves each test from repeating the same MCP setup details.

**Data flow**: It receives a server name, callable namespace, and tool name. It returns a `ToolInfo` with those fields filled in, parallel calls disabled, no connector metadata, no plugin names, and a minimal object-shaped input schema.

**Call relations**: The tests call this helper before constructing an `McpHandler`. It is test-only scaffolding and is not used by production code.

*Call graph*: 5 external calls (new, new, new_with_raw, object, json!).


### `core/src/mcp_tool_call.rs`

`orchestration` · `request handling`

MCP, or Model Context Protocol, is the way Codex talks to outside tools and app connectors. This file is the traffic controller for one MCP tool call. Without it, a model could ask an external tool to run, but Codex would not have a consistent place to check safety rules, ask the user or guardian for permission, attach useful metadata, call the server, and show the result in the conversation.

The flow starts by turning the tool arguments into JSON and looking up details about the tool, such as its connector name, title, safety hints, and whether it can accept OpenAI file inputs. It then decides whether the tool is enabled and whether approval is needed. Approval can come from policy, remembered choices, hooks, a guardian review service, or a user prompt.

If the call is allowed, the file prepares request metadata, adds thread and sandbox information when supported, rewrites file arguments if needed, and sends the request to the MCP server. It also protects the model from unsupported image results, trims huge results before saving them as events, and emits start/completion updates so the UI can show progress. Around all of this it records metrics, tracing details, and app-usage analytics. In short, this file is the checkpoint, dispatcher, and logbook for MCP tool execution.

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

**Purpose**: This is the main entry for running one MCP tool call. It parses the requested arguments, gathers tool metadata, applies app and approval policy, and either skips, asks for approval, or runs the tool.

**Data flow**: It receives the session, current turn, call id, server name, tool name, hook name, and raw argument text. It turns the arguments into JSON, looks up metadata and policy, sends a “started” event when appropriate, asks for approval if needed, and returns both the tool result and the JSON input that was actually considered.

**Call relations**: The higher-level call handler calls this when the model asks for an MCP tool. This function then delegates to metadata lookup, approval decision logic, skip notification, metrics recording, or the approved-call path depending on what policy and user decisions say.

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

**Purpose**: This runs a tool call after it has already been approved or determined not to need approval. It prepares the request, executes it, records timing and telemetry, and emits the final conversation event.

**Data flow**: It receives the session, turn, call id, invocation details, metadata, and event metadata. It may mark memory as polluted by external context, rewrites file arguments, builds request metadata, calls the MCP server, records span telemetry, truncates the event copy of the result, tracks app usage, emits metrics, and returns the final result plus the tool input used.

**Call relations**: It is called by the main MCP tool handler once permission is settled. Inside, it hands off the actual server call to execute_mcp_tool_call and then reports completion through notify_mcp_tool_call_completed.

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

**Purpose**: This records count and duration measurements for MCP calls. These measurements help operators understand how often tools are used, which tools fail, and how long calls take.

**Data flow**: It receives the turn context, status, tool and connector labels, and optionally a duration. It builds safe metric tags, increments the call counter, and records elapsed time when provided. It does not return a value.

**Call relations**: The main handler uses it for skipped or rejected calls, and the approved-call path uses it after execution. It relies on mcp_call_metric_tags to format labels safely.

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

**Purpose**: This prepares the labels attached to MCP metrics. It cleans tool and connector names so they are safe to send to the metrics system.

**Data flow**: It receives a status, tool name, and optional connector id and name. It sanitizes each non-empty value and returns a list of metric tag name/value pairs.

**Call relations**: emit_mcp_call_metrics calls this before sending counters and durations. It is a small helper that keeps metric labeling consistent.

*Call graph*: called by 1 (emit_mcp_call_metrics); 2 external calls (sanitize_metric_tag_value, vec!).


##### `mcp_tool_call_span`  (lines 462–495)

```
fn mcp_tool_call_span(
    session: &Session,
    turn_context: &TurnContext,
    fields: McpToolCallSpanFields<'_>,
) -> Span
```

**Purpose**: This creates a tracing span, which is a timed log envelope for one MCP tool call. It gives observability tools enough information to connect a slow or failed call to a server, connector, session, and turn.

**Data flow**: It receives the session, turn context, and span fields such as server, tool, call id, origin, and connector details. It creates a span with these attributes, records server host and port when the origin is a URL, and returns the span.

**Call relations**: handle_approved_mcp_tool_call wraps the actual MCP call in this span. record_server_fields fills in network address details after the span is created.

*Call graph*: calls 1 internal fn (record_server_fields); called by 1 (handle_approved_mcp_tool_call); 1 external calls (info_span!).


##### `record_server_fields`  (lines 506–519)

```
fn record_server_fields(span: &Span, url: Option<&str>)
```

**Purpose**: This extracts a server address and port from a URL and stores them on a tracing span. That makes network-related traces easier to search and group.

**Data flow**: It receives a span and an optional URL string. If the URL parses cleanly, it records the host and known port on the span; otherwise it quietly does nothing.

**Call relations**: mcp_tool_call_span calls this while setting up tracing for an MCP request. It is intentionally forgiving because tracing should not break tool execution.

*Call graph*: called by 1 (mcp_tool_call_span); 2 external calls (record, parse).


##### `record_mcp_result_span_telemetry`  (lines 521–553)

```
fn record_mcp_result_span_telemetry(span: &Span, result: Option<&CallToolResult>)
```

**Purpose**: This copies selected telemetry hints from an MCP tool result onto the tracing span. For example, a tool can report which remote target it touched or whether it triggered a user flow on the server side.

**Data flow**: It receives a span and an optional successful tool result. It looks inside the result metadata for a known telemetry object, truncates long target ids, records supported fields on the span, and returns nothing.

**Call relations**: handle_approved_mcp_tool_call calls this right after execute_mcp_tool_call finishes. It uses truncate_str_to_char_boundary to shorten text without cutting a character in half.

*Call graph*: calls 1 internal fn (truncate_str_to_char_boundary); called by 1 (handle_approved_mcp_tool_call); 1 external calls (record).


##### `truncate_str_to_char_boundary`  (lines 555–560)

```
fn truncate_str_to_char_boundary(value: &str, max_chars: usize) -> &str
```

**Purpose**: This shortens a string to a maximum number of characters without producing invalid text. It matters for Unicode text, where one visible character may use multiple bytes.

**Data flow**: It receives a string slice and a maximum character count. If the string is longer, it returns a slice ending at a valid character boundary; otherwise it returns the original string.

**Call relations**: record_mcp_result_span_telemetry uses it before writing tool-provided target ids into tracing data.

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

**Purpose**: This performs the actual MCP server request. It adds required metadata, calls the tool, cleans the result for the current model, and may trigger an authentication prompt for Codex Apps.

**Data flow**: It receives the session, turn, call id, invocation, rewritten arguments, tool metadata, and request metadata. It adds the thread id, sandbox state, and rollout tracing metadata, calls the server, removes unsupported content such as images for text-only models, possibly asks for app authentication, and returns either a tool result or an error string.

**Call relations**: handle_approved_mcp_tool_call calls this inside the tracing span. It delegates metadata additions to helper functions and finishes by handing Codex Apps auth cases to maybe_request_codex_apps_auth_elicitation.

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

**Purpose**: This detects when a Codex Apps tool failed because the user needs to authenticate a connector, then asks the client to guide the user through that login or install flow.

**Data flow**: It receives the session, turn, call id, server name, metadata, and original tool result. If the server is a host-owned Codex Apps server, the feature is enabled, and approval policy allows prompts, it builds an authentication elicitation request. If the user accepts, it refreshes app tools and returns a special completed-auth result; otherwise it returns the original result.

**Call relations**: execute_mcp_tool_call calls this after a tool result comes back. If authentication succeeds, it calls refresh_codex_apps_after_connector_auth so connector caches reflect the newly authorized state.

*Call graph*: calls 1 internal fn (refresh_codex_apps_after_connector_auth); called by 1 (execute_mcp_tool_call); 4 external calls (String, auth_elicitation_completed_result, build_auth_elicitation_plan, request_mcp_server_elicitation).


##### `refresh_codex_apps_after_connector_auth`  (lines 685–704)

```
async fn refresh_codex_apps_after_connector_auth(sess: &Session, turn_context: &TurnContext)
```

**Purpose**: This refreshes Codex Apps tool and connector information after the user authorizes a connector. It keeps the local view of available apps in sync with the server.

**Data flow**: It receives the session and turn context. It asks the MCP connection manager for a fresh tools cache, then refreshes the accessible connectors cache using current authentication. On failure it logs a warning and leaves existing cache data in place.

**Call relations**: maybe_request_codex_apps_auth_elicitation calls this only after the user accepts an authentication flow.

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

**Purpose**: This adds sandbox information to a tool request when the MCP server says it understands that metadata. A sandbox is a restricted execution environment; sharing its state lets compatible tools respect Codex’s safety limits.

**Data flow**: It receives the session, turn context, server name, and optional request metadata. It checks whether the server supports sandbox-state metadata, serializes the current permission profile, sandbox policy, working directory, and related flags, inserts them into the metadata object, and returns the updated metadata.

**Call relations**: execute_mcp_tool_call uses this before sending the server request. If the server does not support the capability, the metadata is passed through unchanged.

*Call graph*: calls 2 internal fn (permission_profile, sandbox_policy); called by 1 (execute_mcp_tool_call); 3 external calls (new, Object, to_value).


##### `maybe_mark_thread_memory_mode_polluted`  (lines 753–775)

```
async fn maybe_mark_thread_memory_mode_polluted(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
)
```

**Purpose**: This marks a conversation thread as unsuitable for normal memory behavior if a tool brings in external context and the configuration says that should disable memories. This prevents outside data from being accidentally treated as user memory.

**Data flow**: It receives the session, turn context, and server name. It checks configuration and server metadata; if both indicate risk, it records a polluted-memory marker in the state database.

**Call relations**: handle_approved_mcp_tool_call calls this before running the external tool, so the thread state is updated as soon as risky external context is used.

*Call graph*: calls 1 internal fn (mark_thread_memory_mode_polluted); called by 1 (handle_approved_mcp_tool_call).


##### `sanitize_mcp_tool_result_for_model`  (lines 777–806)

```
fn sanitize_mcp_tool_result_for_model(
    supports_image_input: bool,
    result: Result<CallToolResult, String>,
) -> Result<CallToolResult, String>
```

**Purpose**: This removes image blocks from tool results when the current model cannot accept image input. It replaces each image with a plain text note instead of sending unsupported content onward.

**Data flow**: It receives a flag saying whether the model supports images and a tool result or error. If image input is supported, it returns the result unchanged. Otherwise, for successful results, it scans content blocks and replaces image blocks with explanatory text.

**Call relations**: execute_mcp_tool_call uses this immediately after the MCP server responds, before the result is returned to the model.

*Call graph*: called by 1 (execute_mcp_tool_call).


##### `truncate_mcp_tool_result_for_event`  (lines 808–850)

```
fn truncate_mcp_tool_result_for_event(
    result: &Result<CallToolResult, String>,
) -> Result<CallToolResult, String>
```

**Purpose**: This makes sure the event copy of an MCP result is not enormous. It preserves a useful preview while avoiding multi-megabyte conversation records.

**Data flow**: It receives either a successful tool result or an error string. If the serialized result or error fits within the byte budget, it returns it unchanged; otherwise it replaces it with a truncated text preview.

**Call relations**: handle_approved_mcp_tool_call uses it before emitting completion events, and notify_mcp_tool_call_skip uses it for skipped-call errors.

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

**Purpose**: This tells the session that an MCP tool call has begun. That allows the UI or event log to show the call as in progress.

**Data flow**: It receives the session, turn context, call id, invocation details, and item metadata. It builds a turn item with in-progress status and emits a started event. It does not return a value.

**Call relations**: handle_mcp_tool_call calls this for normal calls, and notify_mcp_tool_call_skip calls it when a skipped call had not already been announced.

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

**Purpose**: This tells the session that an MCP tool call is finished. It records whether the call completed, failed with a tool-level error, or failed with a local error message.

**Data flow**: It receives the session, turn context, call id, invocation, metadata, duration, and result. It converts that into a completed turn item with status, result or error, and elapsed time, then emits it to the session.

**Call relations**: handle_approved_mcp_tool_call calls it after real execution, and notify_mcp_tool_call_skip calls it to close out blocked, rejected, or canceled calls.

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

**Purpose**: This records analytics when a Codex Apps tool is used. It distinguishes tools the user explicitly selected from tools the model chose implicitly.

**Data flow**: It receives the session, turn context, server name, and tool name. If the server is Codex Apps, it looks up connector metadata, compares the connector to the user’s selected connectors, builds tracking context, and sends an app-used event.

**Call relations**: handle_approved_mcp_tool_call calls this after a successful or attempted approved call. It uses lookup_mcp_app_usage_metadata to find connector details.

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

**Purpose**: This finds the approval setting for a non-Codex-Apps MCP tool. It checks user configuration first, then active plugin configuration, and falls back to the default policy.

**Data flow**: It receives the session, turn context, server name, and tool name. It reads effective configuration for server-level or tool-level approval settings; if none are present, it inspects active plugins. It returns an AppToolApproval value.

**Call relations**: handle_mcp_tool_call uses this when the tool is not a Codex Apps tool and not a selected-plugin tool with catalog approval policy.

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

**Purpose**: This builds the metadata object sent alongside an MCP tool call. Metadata is extra context for the server, such as turn information, Codex Apps call id, or plugin id.

**Data flow**: It receives the turn context, server name, call id, and optional tool metadata. It adds current turn metadata when available, Codex Apps metadata for app calls, and plugin id when known. It returns a JSON object or nothing if no metadata is needed.

**Call relations**: handle_approved_mcp_tool_call calls this before execute_mcp_tool_call, which then adds thread and sandbox metadata.

*Call graph*: calls 1 internal fn (effective_reasoning_effort); called by 1 (handle_approved_mcp_tool_call); 3 external calls (new, Object, String).


##### `with_mcp_tool_call_thread_id_meta`  (lines 1083–1105)

```
fn with_mcp_tool_call_thread_id_meta(
    meta: Option<serde_json::Value>,
    thread_id: &str,
) -> Option<serde_json::Value>
```

**Purpose**: This adds the conversation thread id to MCP request metadata. That lets a server connect a tool request back to the conversation it belongs to.

**Data flow**: It receives optional JSON metadata and a thread id string. If the metadata is an object or absent, it inserts the thread id and returns the updated object. If the metadata is some other JSON type, it leaves it unchanged.

**Call relations**: execute_mcp_tool_call uses this as the first metadata augmentation step before adding sandbox and trace data.

*Call graph*: called by 1 (execute_mcp_tool_call); 3 external calls (new, Object, String).


##### `is_mcp_tool_approval_question_id`  (lines 1134–1138)

```
fn is_mcp_tool_approval_question_id(question_id: &str) -> bool
```

**Purpose**: This checks whether a question id belongs to an MCP tool approval prompt. Other parts of the system can use it to recognize these approval questions.

**Data flow**: It receives a question id string. It checks for the expected prefix followed by an underscore and returns true or false.

**Call relations**: This is a small public helper for approval-related paths that need to identify MCP approval questions without parsing the whole prompt.


##### `mcp_tool_approval_prompt_options`  (lines 1147–1157)

```
fn mcp_tool_approval_prompt_options(
    session_approval_key: Option<&McpToolApprovalKey>,
    persistent_approval_key: Option<&McpToolApprovalKey>,
    tool_call_mcp_elicitation_enabled: bool,
) ->
```

**Purpose**: This decides which “remember my choice” options should appear in an approval prompt. It keeps the prompt honest by only showing session or persistent choices when they can actually be applied.

**Data flow**: It receives optional session and persistent approval keys plus a feature flag for MCP elicitation. It returns two booleans: whether session remembering is allowed and whether permanent approval is allowed.

**Call relations**: maybe_request_mcp_tool_approval calls this before building either a user-input prompt or MCP elicitation request.

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

**Purpose**: This decides whether an MCP tool call needs permission and, if so, obtains a decision. Permission can come from policy, remembered approvals, hooks, guardian review, MCP elicitation, or a direct user prompt.

**Data flow**: It receives the session, turn, call id, invocation, hook tool name, metadata, and approval mode. It checks auto-approval policy, tool safety hints, remembered session approvals, permission hooks, guardian routing, feature flags, and user responses. It returns no decision when approval is unnecessary, or a concrete accept, decline, or cancel decision when permission was requested.

**Call relations**: handle_mcp_tool_call calls this after emitting the started event. This function coordinates many helpers: it builds approval keys, review requests, prompts, parses responses, normalizes decisions, and applies remembered or persistent approvals.

*Call graph*: calls 16 internal fn (run_permission_request_hooks, render_mcp_tool_approval_template, apply_mcp_tool_approval_decision, build_guardian_mcp_tool_review_request, build_mcp_tool_approval_elicitation_request, build_mcp_tool_approval_question, mcp_approvals_reviewer, mcp_tool_approval_decision_from_guardian, mcp_tool_approval_is_remembered, mcp_tool_approval_prompt_options (+6 more)); called by 1 (handle_mcp_tool_call); 8 external calls (String, mcp_permission_prompt_is_auto_approved, clone, new_guardian_review_id, review_approval_request, routes_approval_to_guardian_with_reviewer, format!, vec!).


##### `mcp_approvals_reviewer`  (lines 1343–1353)

```
fn mcp_approvals_reviewer(
    turn_context: &TurnContext,
    server_name: &str,
    metadata: Option<&McpToolApprovalMetadata>,
) -> ApprovalsReviewer
```

**Purpose**: This chooses who should review an MCP approval request. The reviewer may depend on configuration, server name, and connector id.

**Data flow**: It receives the turn context, server name, and optional tool metadata. It extracts the connector id when present and asks the connector approval logic for the configured reviewer.

**Call relations**: maybe_request_mcp_tool_approval uses it to decide whether to route approval through guardian review. Another auto-review path also uses it for compatibility with user-input approval prompts.

*Call graph*: calls 1 internal fn (mcp_approvals_reviewer); called by 2 (maybe_auto_review_mcp_request_user_input, maybe_request_mcp_tool_approval).


##### `session_mcp_tool_approval_key`  (lines 1355–1374)

```
fn session_mcp_tool_approval_key(
    invocation: &McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
    approval_mode: AppToolApproval,
) -> Option<McpToolApprovalKey>
```

**Purpose**: This builds the key used to remember an approval for the current session. The key identifies a server, optional connector, and tool.

**Data flow**: It receives an invocation, metadata, and approval mode. If the approval mode supports remembered automatic approvals, it returns a key; otherwise it returns nothing. For Codex Apps, it refuses to create a key when no connector id is known.

**Call relations**: maybe_request_mcp_tool_approval uses it before checking or storing session approvals. persistent_mcp_tool_approval_key reuses the same logic for permanent approvals.

*Call graph*: called by 2 (maybe_request_mcp_tool_approval, persistent_mcp_tool_approval_key).


##### `persistent_mcp_tool_approval_key`  (lines 1376–1382)

```
fn persistent_mcp_tool_approval_key(
    invocation: &McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
    approval_mode: AppToolApproval,
) -> Option<McpToolApprovalKey>
```

**Purpose**: This builds the key used for saving a tool approval into configuration. In this file it follows the same rules as the session approval key.

**Data flow**: It receives an invocation, metadata, and approval mode, then returns the same kind of key that session_mcp_tool_approval_key would return.

**Call relations**: maybe_request_mcp_tool_approval calls this when permanent remembering is allowed for the server. It delegates the key-building details to session_mcp_tool_approval_key.

*Call graph*: calls 1 internal fn (session_mcp_tool_approval_key); called by 1 (maybe_request_mcp_tool_approval).


##### `build_guardian_mcp_tool_review_request`  (lines 1384–1407)

```
fn build_guardian_mcp_tool_review_request(
    call_id: &str,
    invocation: &McpInvocation,
    metadata: Option<&McpToolApprovalMetadata>,
) -> GuardianApprovalRequest
```

**Purpose**: This packages an MCP tool call into the shape expected by the guardian review system. The guardian can then approve or deny the call with the relevant context.

**Data flow**: It receives the call id, invocation, and optional metadata. It copies server, tool, arguments, connector details, tool descriptions, and safety hints into a GuardianApprovalRequest value.

**Call relations**: maybe_request_mcp_tool_approval uses this when approval is routed to guardian. A compatibility auto-review path also uses it to produce the same review payload.

*Call graph*: called by 2 (maybe_auto_review_mcp_request_user_input, maybe_request_mcp_tool_approval).


##### `mcp_tool_approval_decision_from_guardian`  (lines 1409–1427)

```
async fn mcp_tool_approval_decision_from_guardian(
    sess: &Session,
    review_id: &str,
    decision: ReviewDecision,
) -> McpToolApprovalDecision
```

**Purpose**: This converts a guardian review result into the local MCP approval decision type. It also turns denials and timeouts into user-facing messages.

**Data flow**: It receives the session, review id, and guardian review decision. Approved decisions become accept decisions, session approval becomes accept-for-session, denials include a rejection message, timeouts include a timeout message, and abort becomes a decline without a message.

**Call relations**: maybe_request_mcp_tool_approval calls this after guardian review completes, before applying remembered approval behavior.

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

**Purpose**: This finds descriptive and policy-relevant information for one MCP tool. That metadata is used for approval prompts, analytics, app UI display, and request preparation.

**Data flow**: It receives the session, turn context, server name, and tool name. It lists known tools, finds the matching one, gathers plugin id, connector id and name, descriptions, annotations, UI resource URI, Codex Apps metadata, and allowed OpenAI file parameters. It returns a metadata object or nothing if the tool is not found.

**Call relations**: handle_mcp_tool_call calls this near the start of tool handling. A compatibility auto-review path also uses it, and this function delegates URI and file-parameter extraction to smaller helpers.

*Call graph*: calls 4 internal fn (list_accessible_connectors_from_mcp_tools, list_cached_accessible_connectors_from_mcp_tools, get_mcp_app_resource_uri, openai_file_input_params_for_server); called by 2 (maybe_auto_review_mcp_request_user_input, handle_mcp_tool_call).


##### `openai_file_input_params_for_server`  (lines 1491–1498)

```
fn openai_file_input_params_for_server(
    server: &str,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<Vec<String>>
```

**Purpose**: This decides whether a tool may accept OpenAI file inputs. It only allows this for the built-in Codex Apps MCP server, not arbitrary custom MCP servers.

**Data flow**: It receives a server name and optional tool metadata. If the server is Codex Apps, it extracts declared file-input parameter names and returns them when non-empty; otherwise it returns nothing.

**Call relations**: lookup_mcp_tool_metadata calls this while building metadata. Later, handle_approved_mcp_tool_call uses that metadata when rewriting file arguments.

*Call graph*: called by 1 (lookup_mcp_tool_metadata); 1 external calls (declared_openai_file_input_param_names).


##### `get_mcp_app_resource_uri`  (lines 1500–1518)

```
fn get_mcp_app_resource_uri(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String>
```

**Purpose**: This extracts the UI resource URI for an MCP app tool from tool metadata. The URI can point the client to an app-specific display resource or output template.

**Data flow**: It receives optional tool metadata. It checks several supported metadata locations in priority order and returns the first string URI it finds.

**Call relations**: lookup_mcp_tool_metadata calls this when preparing item metadata that will be included in MCP tool call events.

*Call graph*: called by 1 (lookup_mcp_tool_metadata).


##### `lookup_mcp_app_usage_metadata`  (lines 1520–1542)

```
async fn lookup_mcp_app_usage_metadata(
    sess: &Session,
    server: &str,
    tool_name: &str,
) -> Option<McpAppUsageMetadata>
```

**Purpose**: This finds connector information needed for Codex Apps usage analytics. It maps a server and tool name back to connector id and app name.

**Data flow**: It receives the session, server name, and tool name. It lists all known tools, finds the matching tool, and returns connector id and connector name if found.

**Call relations**: maybe_track_codex_app_used calls this before sending an app-used analytics event.

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

**Purpose**: This builds the plain user-facing approval question for an MCP tool call. It includes the allowed answer choices, such as allow, allow for session, allow permanently, or cancel.

**Data flow**: It receives the question id, server, tool, connector name, prompt options, and optional custom question text. It chooses the question wording, appends a question mark, builds answer options based on what remembering is allowed, and returns a RequestUserInputQuestion.

**Call relations**: maybe_request_mcp_tool_approval calls this before either direct user input or MCP elicitation. When no custom wording is supplied, it uses build_mcp_tool_approval_fallback_message.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 2 external calls (format!, vec!).


##### `build_mcp_tool_approval_fallback_message`  (lines 1590–1607)

```
fn build_mcp_tool_approval_fallback_message(
    server: &str,
    tool_name: &str,
    connector_name: Option<&str>,
) -> String
```

**Purpose**: This creates a default approval sentence when no template supplies one. It tries to name the actor clearly, using the connector name, “this app,” or the MCP server name.

**Data flow**: It receives the server name, tool name, and optional connector name. It picks the best readable actor label and returns a sentence asking whether that actor may run the tool.

**Call relations**: build_mcp_tool_approval_question uses this as the fallback prompt text.

*Call graph*: 1 external calls (format!).


##### `build_mcp_tool_approval_elicitation_request`  (lines 1609–1640)

```
fn build_mcp_tool_approval_elicitation_request(
    sess: &Session,
    turn_context: &TurnContext,
    request: McpToolApprovalElicitationRequest<'_>,
) -> McpServerElicitationRequestParams
```

**Purpose**: This builds an MCP elicitation request for tool approval. An elicitation is a structured request sent to the client to ask the user for input.

**Data flow**: It receives the session, turn context, and approval elicitation details. It chooses the message text, builds metadata describing the tool and approval choices, creates an empty form schema, and returns request parameters for the MCP server elicitation channel.

**Call relations**: maybe_request_mcp_tool_approval uses this when the tool-call MCP elicitation feature is enabled. It relies on build_mcp_tool_approval_elicitation_meta for the rich metadata.

*Call graph*: calls 1 internal fn (build_mcp_tool_approval_elicitation_meta); called by 1 (maybe_request_mcp_tool_approval); 1 external calls (new).


##### `build_mcp_tool_approval_elicitation_meta`  (lines 1642–1738)

```
fn build_mcp_tool_approval_elicitation_meta(
    server: &str,
    metadata: Option<&McpToolApprovalMetadata>,
    tool_params: Option<&serde_json::Value>,
    tool_params_display: Option<&[RenderedMc
```

**Purpose**: This builds the metadata attached to an MCP tool approval elicitation. The metadata tells the client what kind of approval this is, what tool and connector are involved, and which persistence choices are available.

**Data flow**: It receives server, metadata, tool parameters, display parameters, and prompt options. It fills a JSON object with approval kind, persistence choices, tool title and description, connector details for Codex Apps, raw parameters, and display-ready parameters. It returns the JSON object when non-empty.

**Call relations**: build_mcp_tool_approval_elicitation_request calls this while constructing the elicitation request that maybe_request_mcp_tool_approval sends to the client.

*Call graph*: called by 1 (build_mcp_tool_approval_elicitation_request); 5 external calls (new, Object, String, json!, to_value).


##### `build_mcp_tool_approval_display_params`  (lines 1740–1756)

```
fn build_mcp_tool_approval_display_params(
    tool_params: Option<&serde_json::Value>,
) -> Option<Vec<crate::mcp_tool_approval_templates::RenderedMcpToolApprovalParam>>
```

**Purpose**: This turns raw tool arguments into a sorted list of display rows for an approval prompt. It gives the UI a simple name, display name, and value for each argument.

**Data flow**: It receives optional JSON tool parameters. If they are a JSON object, it converts each field into a rendered approval parameter, sorts them by name, and returns the list; otherwise it returns nothing.

**Call relations**: maybe_request_mcp_tool_approval uses this when no custom approval template already provided display parameters.


##### `parse_mcp_tool_approval_elicitation_response`  (lines 1758–1794)

```
fn parse_mcp_tool_approval_elicitation_response(
    response: Option<ElicitationResponse>,
    question_id: &str,
) -> McpToolApprovalDecision
```

**Purpose**: This interprets the user’s answer from the MCP elicitation approval path. It supports accept, decline, cancel, and metadata that says whether the approval should be remembered.

**Data flow**: It receives an optional elicitation response and the question id. Missing responses become cancel. Accept responses may become session or permanent approvals based on metadata, or fall back to parsing embedded question answers. Decline and cancel map directly to local decisions.

**Call relations**: maybe_request_mcp_tool_approval calls this after requesting MCP server elicitation. It uses request_user_input_response_from_elicitation_content and parse_mcp_tool_approval_response for compatibility with older answer formats.

*Call graph*: calls 2 internal fn (parse_mcp_tool_approval_response, request_user_input_response_from_elicitation_content); called by 1 (maybe_request_mcp_tool_approval).


##### `request_user_input_response_from_elicitation_content`  (lines 1796–1821)

```
fn request_user_input_response_from_elicitation_content(
    content: Option<serde_json::Value>,
) -> Option<RequestUserInputResponse>
```

**Purpose**: This converts elicitation response content into the older RequestUserInputResponse shape. It acts like an adapter between two prompt formats.

**Data flow**: It receives optional JSON content. Missing content becomes an empty answer set; object content is read field by field, accepting string answers or arrays of string answers, and converted into a response map.

**Call relations**: parse_mcp_tool_approval_elicitation_response calls this when an accepted elicitation response carries answers in the compatibility format.

*Call graph*: called by 1 (parse_mcp_tool_approval_elicitation_response); 1 external calls (new).


##### `parse_mcp_tool_approval_response`  (lines 1823–1860)

```
fn parse_mcp_tool_approval_response(
    response: Option<RequestUserInputResponse>,
    question_id: &str,
) -> McpToolApprovalDecision
```

**Purpose**: This interprets the answer from the direct user-input approval prompt. It turns selected labels into the local approval decision enum.

**Data flow**: It receives an optional user-input response and a question id. Missing response, missing answer, or unrecognized answer becomes cancel. Known labels become decline, accept-for-session, accept-and-remember, or accept.

**Call relations**: maybe_request_mcp_tool_approval uses this for the direct prompt path. parse_mcp_tool_approval_elicitation_response also uses it for elicitation responses that contain old-style prompt answers.

*Call graph*: called by 2 (maybe_request_mcp_tool_approval, parse_mcp_tool_approval_elicitation_response).


##### `normalize_approval_decision_for_mode`  (lines 1862–1876)

```
fn normalize_approval_decision_for_mode(
    decision: McpToolApprovalDecision,
    approval_mode: AppToolApproval,
) -> McpToolApprovalDecision
```

**Purpose**: This removes remembered-approval choices when the approval mode does not allow them. In prompt-only mode, “allow for session” and “allow and remember” are treated as a plain one-time allow.

**Data flow**: It receives a decision and the configured approval mode. If the mode is prompt-only and the decision asks to remember, it returns a plain accept; otherwise it returns the original decision.

**Call relations**: maybe_request_mcp_tool_approval calls this after parsing user or elicitation responses, before applying the decision.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 1 external calls (matches!).


##### `mcp_tool_approval_is_remembered`  (lines 1878–1881)

```
async fn mcp_tool_approval_is_remembered(sess: &Session, key: &McpToolApprovalKey) -> bool
```

**Purpose**: This checks whether a matching MCP tool approval has already been remembered for the session. It avoids asking the user again for the same approved tool.

**Data flow**: It receives the session and approval key. It locks the in-memory approval store, looks up the key, and returns true only when it was approved for the session.

**Call relations**: maybe_request_mcp_tool_approval calls this before running hooks or prompts.

*Call graph*: called by 1 (maybe_request_mcp_tool_approval); 1 external calls (matches!).


##### `remember_mcp_tool_approval`  (lines 1883–1886)

```
async fn remember_mcp_tool_approval(sess: &Session, key: McpToolApprovalKey)
```

**Purpose**: This stores a session-level approval for an MCP tool. It lets future matching calls proceed without another approval prompt during the same session.

**Data flow**: It receives the session and approval key. It locks the approval store and writes an approved-for-session decision under that key.

**Call relations**: apply_mcp_tool_approval_decision calls it for session approvals, and maybe_persist_mcp_tool_approval uses it as a fallback or final session cache after persistence.

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

**Purpose**: This applies the side effects of an approval decision. In practice, that means remembering approvals for this session or saving them permanently when the user chose that.

**Data flow**: It receives the session, turn context, decision, and optional session and persistent keys. Session approvals are stored in memory. Permanent approvals are written to configuration when possible, otherwise remembered in memory. Declines, cancels, and one-time accepts do not change approval storage.

**Call relations**: maybe_request_mcp_tool_approval calls this after a guardian, elicitation, or user prompt decision is known.

*Call graph*: calls 2 internal fn (maybe_persist_mcp_tool_approval, remember_mcp_tool_approval); called by 1 (maybe_request_mcp_tool_approval).


##### `maybe_persist_mcp_tool_approval`  (lines 1914–1944)

```
async fn maybe_persist_mcp_tool_approval(
    sess: &Session,
    turn_context: &TurnContext,
    key: McpToolApprovalKey,
)
```

**Purpose**: This tries to save a permanent MCP tool approval into the user or project configuration. If saving fails, it still remembers the approval for the current session.

**Data flow**: It receives the session, turn context, and approval key. It chooses the right persistence path for Codex Apps versus other MCP servers, writes the config edit, reloads user configuration on success, and stores a session approval. On errors it logs the failure and falls back to session memory.

**Call relations**: apply_mcp_tool_approval_decision calls this for “allow and don’t ask me again.” It delegates actual config edits to app-specific or non-app persistence helpers.

*Call graph*: calls 3 internal fn (persist_codex_app_tool_approval, persist_non_app_mcp_tool_approval, remember_mcp_tool_approval); called by 1 (apply_mcp_tool_approval_decision); 2 external calls (reload_user_config_layer, error!).


##### `persist_codex_app_tool_approval`  (lines 1946–1964)

```
async fn persist_codex_app_tool_approval(
    config: &Config,
    connector_id: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: This writes a permanent approval for a Codex Apps connector tool into configuration. It sets that app tool’s approval mode to approve.

**Data flow**: It receives the config, connector id, and tool name. It builds a config edit at the apps connector tool path and applies it asynchronously, returning success or an error.

**Call relations**: maybe_persist_mcp_tool_approval calls this when the approval key belongs to the Codex Apps server.

*Call graph*: called by 1 (maybe_persist_mcp_tool_approval); 3 external calls (for_config, value, vec!).


##### `persist_custom_mcp_tool_approval`  (lines 1967–1978)

```
async fn persist_custom_mcp_tool_approval(
    config: &Config,
    server: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: This test-only helper writes approval for a custom MCP tool. It is compiled for tests and helps exercise the same config-editing path used in production.

**Data flow**: It receives config, server name, and tool name. It finds the right config editor for that server, fails if the server is not configured, and writes the tool approval setting.

**Call relations**: Test code can call this directly. It uses custom_mcp_tool_approval_config_builder and persist_custom_mcp_tool_approval_with to share production behavior.

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

**Purpose**: This writes a permanent approval for a non-Codex-Apps MCP tool. It supports servers configured directly by the user or supplied by enabled plugins.

**Data flow**: It receives the session, config, server name, and tool name. It first looks for a direct custom MCP config location; if found, it writes there. Otherwise it searches active plugins and writes the approval under the plugin’s server config. If neither exists, it returns an error.

**Call relations**: maybe_persist_mcp_tool_approval calls this for all non-app MCP servers. It uses helper functions to choose and apply the correct config edit.

*Call graph*: calls 2 internal fn (custom_mcp_tool_approval_config_builder, persist_custom_mcp_tool_approval_with); called by 1 (maybe_persist_mcp_tool_approval); 5 external calls (bail!, plugins_config_input, for_config, value, vec!).


##### `custom_mcp_tool_approval_config_builder`  (lines 2023–2033)

```
fn custom_mcp_tool_approval_config_builder(
    config: &Config,
    server: &str,
) -> anyhow::Result<Option<ConfigEditsBuilder>>
```

**Purpose**: This chooses where a custom MCP tool approval should be written. It prefers the project configuration if the server is defined there, otherwise it uses user configuration when the server is defined by the user.

**Data flow**: It receives config and server name. It checks project layers for that server, then checks user configuration, and returns a ConfigEditsBuilder for the right location or nothing if the server is not configured.

**Call relations**: persist_custom_mcp_tool_approval and persist_non_app_mcp_tool_approval call this before writing direct MCP server approval settings.

*Call graph*: calls 3 internal fn (new, project_mcp_tool_approval_config_folder, user_mcp_server_is_configured); called by 2 (persist_custom_mcp_tool_approval, persist_non_app_mcp_tool_approval).


##### `persist_custom_mcp_tool_approval_with`  (lines 2035–2053)

```
async fn persist_custom_mcp_tool_approval_with(
    config_edits_builder: ConfigEditsBuilder,
    server: &str,
    tool_name: &str,
) -> anyhow::Result<()>
```

**Purpose**: This performs the actual config edit for a custom MCP server tool approval. It sets the tool’s approval mode to approve.

**Data flow**: It receives a prepared config edit builder, server name, and tool name. It builds the path under mcp_servers, adds the approval_mode value, applies the edit, and returns success or an error.

**Call relations**: persist_custom_mcp_tool_approval and persist_non_app_mcp_tool_approval call this after deciding which config file or folder should be edited.

*Call graph*: called by 2 (persist_custom_mcp_tool_approval, persist_non_app_mcp_tool_approval); 3 external calls (with_edits, value, vec!).


##### `user_mcp_server_is_configured`  (lines 2055–2068)

```
fn user_mcp_server_is_configured(config: &Config, server: &str) -> anyhow::Result<bool>
```

**Purpose**: This checks whether a given MCP server is present in the user’s configuration. It helps decide whether permanent approval can be written to the user config.

**Data flow**: It receives config and server name. It reads the effective user config’s mcp_servers table, deserializes it into server configs, and returns whether the server is present.

**Call relations**: custom_mcp_tool_approval_config_builder calls this after checking project configuration.

*Call graph*: called by 1 (custom_mcp_tool_approval_config_builder); 1 external calls (deserialize).


##### `project_mcp_tool_approval_config_folder`  (lines 2070–2097)

```
fn project_mcp_tool_approval_config_folder(
    config: &Config,
    server: &str,
) -> Option<AbsolutePathBuf>
```

**Purpose**: This finds the project configuration folder that defines a given MCP server. Writing approval there keeps project-defined MCP settings with the project.

**Data flow**: It receives config and server name. It scans configuration layers from high to low, considers only project layers, deserializes their mcp_servers table, and returns the folder for the first layer containing the server.

**Call relations**: custom_mcp_tool_approval_config_builder calls this before falling back to user configuration.

*Call graph*: called by 1 (custom_mcp_tool_approval_config_builder).


##### `requires_mcp_tool_approval`  (lines 2099–2116)

```
fn requires_mcp_tool_approval(annotations: Option<&ToolAnnotations>) -> bool
```

**Purpose**: This decides whether a tool’s safety annotations require approval. It treats destructive or open-world tools cautiously, and lets clearly read-only tools avoid prompts.

**Data flow**: It receives optional tool annotations. A destructive hint forces approval; a read-only hint can avoid approval; missing or uncertain destructive/open-world hints default toward requiring approval.

**Call relations**: maybe_request_mcp_tool_approval calls this after checking global auto-approval policy and before deciding whether to prompt.

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

**Purpose**: This records a tool call that was not run, such as one blocked by policy, declined by the user, or canceled. It still emits lifecycle events so the conversation history shows what happened.

**Data flow**: It receives the session, turn context, call id, invocation, metadata, message, and whether a started event already happened. It emits a started event if needed, emits a completed event with zero duration and a truncated error result, and returns the error message as a failed result.

**Call relations**: handle_mcp_tool_call calls this for disabled tools, declined approvals, and canceled approvals. It uses the same start and completion notification helpers as real tool calls.

*Call graph*: calls 3 internal fn (notify_mcp_tool_call_completed, notify_mcp_tool_call_started, truncate_mcp_tool_result_for_event); called by 1 (handle_mcp_tool_call); 2 external calls (clone, clone).


### `core/src/mcp_openai_file.rs`

`domain_logic` · `tool execution`

Some Apps SDK-style MCP tools say, through metadata, that certain arguments are files. The model or caller may provide those arguments as local paths, such as "report.csv". But the downstream tool expects a richer object that points to a file already uploaded to OpenAI storage. This file is the bridge between those two worlds.

At tool execution time, it looks only at the argument names that were explicitly declared as file inputs. For each one, it checks whether the value is a single path string or a list of path strings. It then finds the file inside the primary turn environment, checks that it is really a file, rejects it if it is larger than the allowed upload size, reads its contents, uploads it to OpenAI file storage, and replaces the original path with an object containing the uploaded file ID, download URL, MIME type, name, URI, and size.

A useful analogy is a coat check: the tool should not receive the coat itself or just the coat’s location at home. This file takes the coat, checks it in, and gives the tool the claim ticket it knows how to use.

The file is careful not to rewrite undeclared arguments, malformed values, or calls with no file metadata. It also requires ChatGPT-style authentication, because uploading to OpenAI storage needs that account context.

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

**Purpose**: This is the main entry point for rewriting MCP tool arguments that contain file paths. It only acts when the tool metadata says which argument names are file inputs; otherwise it leaves the arguments untouched.

**Data flow**: It receives the current session, the current turn context, the original JSON arguments, and the list of argument names that should be treated as files. If there is no file list, no arguments, or the arguments are not a JSON object, it returns the original value. Otherwise it gets the current authentication, checks each declared file field, asks the lower-level rewrite function to upload and convert that value, and returns a new JSON object only if something changed.

**Call relations**: During an approved MCP tool call, handle_approved_mcp_tool_call calls this function before sending arguments onward to the tool. For each declared file argument, it hands the value to rewrite_argument_value_for_openai_files, which does the single-value or array-specific work. The tests call it both to confirm that undeclared file parameters are ignored and to confirm that upload failures are reported clearly.

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

**Purpose**: This function rewrites one argument value if it looks like a file path or a list of file paths. It is used so the main argument-rewriting function does not need to know the details of single-file versus multi-file inputs.

**Data flow**: It receives the turn context, optional authentication, the argument name, and the JSON value for that argument. If the value is a string, it treats it as one file path and asks build_uploaded_argument_value to upload it. If the value is an array, it requires every item to be a string path, uploads each one, and returns an array of uploaded-file objects. If the value is anything else, or if an array contains a non-string item, it returns no rewrite.

**Call relations**: rewrite_mcp_tool_arguments_for_openai_files calls this when it finds a declared file argument. This function then delegates each actual file upload to build_uploaded_argument_value. The scalar-path and array-path tests call it directly to verify both supported shapes.

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

**Purpose**: This function does the real file upload work for one path. It verifies the caller is allowed to upload, finds and checks the file in the turn environment, sends it to OpenAI file storage, and builds the JSON object that the downstream Apps tool expects.

**Data flow**: It receives the turn context, optional authentication, the argument name, an optional array index, and a file path string. It first prepares error messages that mention the exact argument, and array index if relevant. It rejects missing or non-ChatGPT authentication. Then it finds the primary turn environment, resolves the file path relative to that environment’s current directory, checks file metadata, rejects directories and oversized files, reads the file stream, uploads it using the configured ChatGPT base URL and auth, and returns a JSON object with the uploaded file’s download URL, file ID, MIME type, file name, URI, and byte size.

**Call relations**: rewrite_argument_value_for_openai_files calls this once for each path it needs to convert. Internally it relies on path conversion helpers to identify the file, the environment filesystem to inspect and read it, an auth conversion helper to prepare upload credentials, and upload_openai_file to perform the network upload. The tests call it directly to prove a normal upload works and that an oversized file is rejected before reading.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (rewrite_argument_value_for_openai_files, build_uploaded_argument_value_rejects_oversized_file_before_reading, build_uploaded_argument_value_uploads_environment_file); 4 external calls (upload_openai_file, auth_provider_from_auth, format!, json!).


##### `tests::set_primary_environment_cwd`  (lines 193–207)

```
fn set_primary_environment_cwd(turn_context: &mut TurnContext, cwd: &Path)
```

**Purpose**: This test helper changes the primary test environment’s current working directory. Tests use it so relative file paths like "file_report.csv" point at temporary files created during the test.

**Data flow**: It receives a mutable turn context and a filesystem path. It converts the path into the project’s absolute-path type, disables permission restrictions for the test context, takes the first turn environment as the primary one, and replaces it with a new environment record that has the same identity, filesystem, and shell but a different current directory.

**Call relations**: The upload-related tests call this helper after creating temporary files. It prepares the turn context so build_uploaded_argument_value can resolve relative paths through the normal environment lookup path rather than using hard-coded absolute paths.

*Call graph*: calls 3 internal fn (new, try_from, from_abs_path); 1 external calls (clone).


##### `tests::openai_file_argument_rewrite_requires_declared_file_params`  (lines 210–226)

```
async fn openai_file_argument_rewrite_requires_declared_file_params()
```

**Purpose**: This test confirms that file rewriting is opt-in. A tool argument that looks like a file path is not uploaded unless the tool metadata explicitly marks that argument as a file input.

**Data flow**: It creates a test session and turn context, builds JSON arguments containing a file-like path, and calls rewrite_mcp_tool_arguments_for_openai_files with no declared file parameters. The output is expected to be exactly the same JSON that went in.

**Call relations**: This test calls the main rewriting function directly. It protects the larger MCP tool flow from accidentally uploading or changing ordinary string arguments just because they happen to look like paths.

*Call graph*: calls 2 internal fn (rewrite_mcp_tool_arguments_for_openai_files, make_session_and_context); 3 external calls (new, assert_eq!, json!).


##### `tests::build_uploaded_argument_value_uploads_environment_file`  (lines 229–307)

```
async fn build_uploaded_argument_value_uploads_environment_file()
```

**Purpose**: This test proves that one real file in the turn environment can be uploaded and converted into the expected uploaded-file JSON shape. It uses a fake HTTP server so no real OpenAI service is contacted.

**Data flow**: It starts a mock server that expects the upload negotiation, the file upload request, and the final uploaded confirmation request. It creates a temporary CSV file, points the turn environment at that directory, changes the test configuration to use the mock server, and calls build_uploaded_argument_value. The result is compared with the exact JSON object expected from the mocked upload response.

**Call relations**: This test exercises build_uploaded_argument_value directly. The mock server stands in for upload_openai_file’s network calls, letting the test verify both local file handling and the final JSON returned to rewrite_argument_value_for_openai_files.

*Call graph*: calls 3 internal fn (build_uploaded_argument_value, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, given, start, new, assert_eq!, set_primary_environment_cwd, format!, json!, tempdir, write).


##### `tests::build_uploaded_argument_value_rejects_oversized_file_before_reading`  (lines 310–332)

```
async fn build_uploaded_argument_value_rejects_oversized_file_before_reading()
```

**Purpose**: This test checks the safety limit that prevents files larger than OpenAI’s upload limit from being read and uploaded. It matters because large files could waste memory, time, or network bandwidth.

**Data flow**: It creates a temporary sparse file whose recorded size is one byte over the upload limit, prepares a turn context that points at that directory, and calls build_uploaded_argument_value. Instead of returning uploaded-file JSON, the function must return an error that mentions the file is too large and includes the oversized byte count.

**Call relations**: This test calls build_uploaded_argument_value directly because the size check happens inside that function. It verifies an important early-exit path used by all higher-level rewriting flows.

*Call graph*: calls 3 internal fn (build_uploaded_argument_value, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, set_primary_environment_cwd, create, tempdir).


##### `tests::rewrite_argument_value_for_openai_files_rewrites_scalar_path`  (lines 335–411)

```
async fn rewrite_argument_value_for_openai_files_rewrites_scalar_path()
```

**Purpose**: This test confirms that a single string file path is rewritten into one uploaded-file object. It covers the common case where a tool argument accepts one file.

**Data flow**: It creates a mock upload server, a temporary file, a test turn context whose working directory contains that file, and a ChatGPT-style test auth value. It calls rewrite_argument_value_for_openai_files with a JSON string path. The expected output is a JSON object containing the mocked uploaded file details.

**Call relations**: This test calls rewrite_argument_value_for_openai_files directly, which then calls build_uploaded_argument_value. It proves that the middle layer correctly recognizes a scalar string as a file path and returns the uploaded result in the shape the main rewriter will insert into tool arguments.

*Call graph*: calls 3 internal fn (rewrite_argument_value_for_openai_files, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, given, start, new, assert_eq!, set_primary_environment_cwd, format!, json!, tempdir, write).


##### `tests::rewrite_argument_value_for_openai_files_rewrites_array_paths`  (lines 414–535)

```
async fn rewrite_argument_value_for_openai_files_rewrites_array_paths()
```

**Purpose**: This test confirms that an argument containing a list of file paths is rewritten into a list of uploaded-file objects. It covers tools that accept multiple files in one argument.

**Data flow**: It creates two temporary CSV files and a mock server with separate expected upload flows for each one. It points the turn context at the temporary directory, configures uploads to go to the mock server, and calls rewrite_argument_value_for_openai_files with a JSON array of two path strings. The output must be a JSON array with one uploaded-file object for each input path, in the same order.

**Call relations**: This test exercises the array branch of rewrite_argument_value_for_openai_files. That function calls build_uploaded_argument_value once per path, so the test verifies that multi-file arguments are uploaded item by item and then handed back as a single rewritten array.

*Call graph*: calls 3 internal fn (rewrite_argument_value_for_openai_files, make_session_and_context, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, given, start, new, assert_eq!, set_primary_environment_cwd, format!, json!, tempdir, write).


##### `tests::rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures`  (lines 538–556)

```
async fn rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures()
```

**Purpose**: This test ensures that upload errors are not hidden. If a declared file argument points to a missing file, the main rewrite function should fail with a useful message instead of silently passing bad arguments onward.

**Data flow**: It creates a test session and turn context, installs dummy ChatGPT-style authentication, and calls rewrite_mcp_tool_arguments_for_openai_files with a declared file parameter whose path does not exist. The function is expected to return an error, and the test checks that the message mentions both an upload failure and the affected field.

**Call relations**: This test calls the same main function used by handle_approved_mcp_tool_call. It verifies that errors from build_uploaded_argument_value travel upward through rewrite_argument_value_for_openai_files and reach the caller clearly enough to explain why the MCP tool call cannot proceed.

*Call graph*: calls 4 internal fn (rewrite_mcp_tool_arguments_for_openai_files, make_session_and_context, auth_manager_from_auth, create_dummy_chatgpt_auth_for_testing); 2 external calls (assert!, json!).


### Resource tool handlers
These files define the MCP resource tool specs, shared helper layer, and the concrete list/read handlers that call through the MCP resource path.

### `core/src/tools/handlers/mcp_resource_spec.rs`

`config` · `tool registration`

MCP, or Model Context Protocol, is a way for external servers to offer useful context to a language model, such as files, database schemas, or app-specific data. This file does not actually contact those servers. Instead, it builds the “menu entries” for three tools: one to list available resources, one to list resource templates, and one to read a chosen resource.

Each function creates a ToolSpec, which is a structured description of a tool. Think of it like a form attached to a button: it says the button’s name, explains what it does, and describes which fields the user or model may fill in. The fields are described with JSON Schema, a common way to say “this input should be a string” or “these fields are required.”

The two listing tools accept an optional server name and an optional cursor. A cursor is a paging token, like a bookmark for “continue from here” when there are too many results to return at once. The read tool is stricter in spirit: it requires both the server name and the resource URI, because reading needs an exact target.

Without this file, the broader tool system would not know how to present MCP resource operations to the model, even if the lower-level MCP support existed.

#### Function details

##### `create_list_mcp_resources_tool`  (lines 6–31)

```
fn create_list_mcp_resources_tool() -> ToolSpec
```

**Purpose**: Creates the definition for the `list_mcp_resources` tool. This tool lets the model ask which concrete resources are available from one MCP server or from all configured MCP servers.

**Data flow**: It starts with no runtime input. It builds a small input description containing two optional string fields: `server`, to narrow the search to one MCP server, and `cursor`, to continue a paged listing. It wraps those fields, along with the tool name and human-readable description, into a ToolSpec and returns it.

**Call relations**: The broader tool specification builder, `spec`, calls this when assembling the set of tools the model may use. Inside, it relies on helper constructors for string fields, object schemas, a map of properties, and the final function-style tool wrapper so the returned value fits the common tool format.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 2 external calls (from, Function).


##### `create_list_mcp_resource_templates_tool`  (lines 33–59)

```
fn create_list_mcp_resource_templates_tool() -> ToolSpec
```

**Purpose**: Creates the definition for the `list_mcp_resource_templates` tool. This tool lets the model discover parameterized resource templates, which are resources that need extra values before they can be read.

**Data flow**: It starts with no runtime input. It creates an input shape with optional `server` and `cursor` string fields, then combines that shape with the tool’s name and explanation. The result is returned as a ToolSpec that the rest of the system can advertise to the model.

**Call relations**: The `spec` builder calls this while preparing the available tool list. This function hands back a ready-made tool description, using the shared schema and tool wrapper helpers so it matches the same format as the other tools.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 2 external calls (from, Function).


##### `create_read_mcp_resource_tool`  (lines 61–93)

```
fn create_read_mcp_resource_tool() -> ToolSpec
```

**Purpose**: Creates the definition for the `read_mcp_resource` tool. This tool is used when the model already knows exactly which MCP server and resource URI it wants to read.

**Data flow**: It starts with no runtime input. It builds an input description with two string fields: `server` and `uri`. Unlike the listing tools, it marks both fields as required, because the system cannot read a resource without knowing both where to ask and what to ask for. It returns the completed ToolSpec.

**Call relations**: The `spec` builder calls this during tool setup, alongside the listing tool definitions. The intended flow is that the model first uses the listing tool to discover valid resources, then uses this read tool with the returned server name and URI.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


### `core/src/tools/handlers/mcp_resource.rs`

`domain_logic` · `request handling`

MCP, or Model Context Protocol, lets this program ask external servers for resources such as files, documents, or templates. This file is the common toolbox used by the MCP resource handlers. Without it, each handler would need to invent its own way to parse arguments, label which server a resource came from, report progress, and format results back to the model.

The file defines small input shapes for the three resource actions: list resources, list resource templates, and read a resource. It also defines output shapes that attach a server name to every returned resource. That matters because a request can ask all connected MCP servers at once; the answer must still say where each item came from, like putting return addresses on letters from several mailboxes.

For list results, it can build a payload from one server, preserving that server’s pagination cursor, or from many servers, sorting server names so the output is stable and predictable. For tool-call reporting, it creates “started” and “completed” turn items so the user interface or logs can show that an MCP action is running, succeeded, or failed. Finally, it includes helper functions to clean up string arguments, parse JSON arguments, serialize responses, and trim long output so too much resource data is not injected into the model context.

#### Function details

##### `ResourceWithServer::new`  (lines 68–70)

```
fn new(server: String, resource: Resource) -> Self
```

**Purpose**: Creates a resource record that also says which MCP server it came from. This is used when results from one or more servers need to be combined without losing their source.

**Data flow**: It receives a server name and one resource object. It stores both together in a new wrapper object. The output is the same resource information, now tagged with its server.

**Call relations**: When list results are gathered across servers, ListResourcesPayload::from_all_servers calls this to attach the server name to each resource before returning the combined list. Tests also call it to confirm the server field is serialized correctly.

*Call graph*: called by 2 (from_all_servers, resource_with_server_serializes_server_field).


##### `ResourceTemplateWithServer::new`  (lines 81–83)

```
fn new(server: String, template: ResourceTemplate) -> Self
```

**Purpose**: Creates a resource-template record that also says which MCP server supplied it. This keeps templates from different servers distinguishable after they are merged.

**Data flow**: It receives a server name and one resource template. It puts them into a wrapper object. The output is the template data plus its source server.

**Call relations**: ListResourceTemplatesPayload::from_all_servers uses this while combining template results from multiple servers. Tests also call it to make sure the server field appears in serialized output.

*Call graph*: called by 2 (from_all_servers, template_with_server_serializes_server_field).


##### `ListResourcesPayload::from_single_server`  (lines 97–108)

```
fn from_single_server(server: String, result: ListResourcesResult) -> Self
```

**Purpose**: Builds the response body for a resource-list request aimed at one MCP server. It keeps the server name and any pagination cursor returned by that server.

**Data flow**: It receives the server name and that server’s list response. It wraps every resource with the server name, copies over the next cursor if one exists, and returns a payload ready to serialize. The original list response is consumed and turned into the handbook-style output shape used by this tool.

**Call relations**: The resource-list handler’s handle_call flow calls this when the request targets a specific server. A test also calls it to verify that the next cursor is copied into the final payload.

*Call graph*: called by 2 (handle_call, list_resources_payload_from_single_server_copies_next_cursor).


##### `ListResourcesPayload::from_all_servers`  (lines 110–126)

```
fn from_all_servers(resources_by_server: HashMap<String, Vec<Resource>>) -> Self
```

**Purpose**: Builds one combined resource-list response from several MCP servers. It sorts servers by name first, so repeated runs produce a predictable order.

**Data flow**: It receives a map from server names to resource lists. It turns the map into sorted server entries, walks through each server’s resources, wraps each resource with its server name, and returns one payload with no single-server cursor. The result is a flat list where every item still carries its origin.

**Call relations**: The resource-list handler’s handle_call flow calls this when the request asks across all servers. Inside, it calls ResourceWithServer::new for each resource. A test also exercises it to confirm the combined output is sorted by server.

*Call graph*: calls 1 internal fn (new); called by 2 (handle_call, list_resources_payload_from_all_servers_is_sorted); 1 external calls (new).


##### `ListResourceTemplatesPayload::from_single_server`  (lines 140–151)

```
fn from_single_server(server: String, result: ListResourceTemplatesResult) -> Self
```

**Purpose**: Builds the response body for a resource-template listing from one MCP server. It preserves both the server name and the server’s pagination cursor.

**Data flow**: It receives a server name and that server’s template-list response. It wraps each template with the server name, copies any next cursor, and returns a payload ready to send back as tool output.

**Call relations**: The resource-template listing handler’s handle_call flow calls this when the request is for one named server.

*Call graph*: called by 1 (handle_call).


##### `ListResourceTemplatesPayload::from_all_servers`  (lines 153–170)

```
fn from_all_servers(templates_by_server: HashMap<String, Vec<ResourceTemplate>>) -> Self
```

**Purpose**: Builds one combined template-list response from multiple MCP servers. It keeps the output stable by sorting server names before flattening their template lists.

**Data flow**: It receives a map from server names to template lists. It sorts the server entries, wraps every template with its server name, and returns a single payload containing all templates. Because this is an all-server response, it does not include a pagination cursor for one particular server.

**Call relations**: The resource-template listing handler’s handle_call flow calls this for all-server requests. Inside, it calls ResourceTemplateWithServer::new for each template so no template loses its source.

*Call graph*: calls 1 internal fn (new); called by 1 (handle_call); 1 external calls (new).


##### `call_tool_result_from_content`  (lines 181–188)

```
fn call_tool_result_from_content(content: &str, success: Option<bool>) -> CallToolResult
```

**Purpose**: Turns plain text into the standard MCP tool-result shape. This is useful when an internal resource operation needs to be reported as if it were a normal MCP tool call.

**Data flow**: It receives text content and an optional success flag. It creates a result whose content is a single text item, leaves structured content empty, and sets the error marker to the opposite of success when success is known. The output is a CallToolResult object.

**Call relations**: No direct caller is shown in the provided call facts. It is a small adapter for code that needs to present resource output using the same result format as other MCP tool calls.

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

**Purpose**: Announces that an MCP resource-related tool call has started. This lets the session record or display an in-progress action instead of leaving the user guessing.

**Data flow**: It receives the current session, turn context, call id, and invocation details such as server, tool name, and arguments. It builds a turn item with status set to in progress, then sends that started item through the session. The visible side effect is that the current turn now knows this MCP call has begun.

**Call relations**: No direct caller is shown in the provided call facts. Inside, it builds a McpToolCall turn item, which is then emitted through the session as the beginning of a tool-call lifecycle.

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

**Purpose**: Announces that an MCP resource-related tool call has finished, either successfully or with a failure. It records the final result, error message, and how long the call took.

**Data flow**: It receives the session, turn context, call id, original invocation, duration, and either a tool result or an error string. It decides whether the final status is completed or failed, packages the result or error into a turn item, includes the elapsed time, and emits that completed item through the session. The session’s record of the turn changes from an unfinished action to a finished one.

**Call relations**: No direct caller is shown in the provided call facts. It completes the lifecycle started by emit_tool_call_begin by building a final McpToolCall turn item and handing it to the session.

*Call graph*: 1 external calls (McpToolCall).


##### `normalize_optional_string`  (lines 255–264)

```
fn normalize_optional_string(input: Option<String>) -> Option<String>
```

**Purpose**: Cleans up an optional text field by trimming whitespace and treating blank text as missing. This prevents values like "   " from being accepted as meaningful input.

**Data flow**: It receives either no string or a string that may contain extra spaces. If there is a string, it trims it. If the trimmed result is empty, it returns no value; otherwise it returns the cleaned string.

**Call relations**: normalize_required_string calls this when it needs the same cleanup behavior but also wants to reject missing or blank values.

*Call graph*: called by 1 (normalize_required_string).


##### `normalize_required_string`  (lines 266–273)

```
fn normalize_required_string(field: &str, value: String) -> Result<String, FunctionCallError>
```

**Purpose**: Cleans up a required text field and returns a user-facing error if it is missing or blank. This is used for arguments where the tool cannot continue without a real value.

**Data flow**: It receives the field name and the raw string value. It passes the value through normalize_optional_string. If a cleaned value remains, it returns that value; if not, it creates a FunctionCallError telling the model that the named field must be provided.

**Call relations**: It builds on normalize_optional_string so optional and required string fields follow the same whitespace rules. When validation fails, it returns a RespondToModel error, meaning the problem should be reported back in language the model can act on.

*Call graph*: calls 1 internal fn (normalize_optional_string); 2 external calls (format!, RespondToModel).


##### `serialize_function_output`  (lines 275–292)

```
fn serialize_function_output(
    payload: T,
    truncation_policy: TruncationPolicy,
) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Converts a response payload into the text output expected from a function tool, while limiting its size. This matters because resource lists or resource contents can be large, and very large output can crowd the model’s context.

**Data flow**: It receives any serializable payload and a truncation policy, which is a size limit rule. It converts the payload to JSON text, reports a model-facing error if that fails, trims the JSON text to a bounded length, and wraps the final text as a successful FunctionToolOutput.

**Call relations**: The provided call facts do not list a caller, but this is the shared final packaging step for resource handlers. It calls JSON serialization, then truncate_text to keep output under control, and finally FunctionToolOutput::from_text to produce the tool response.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (truncate_text, to_string).


##### `parse_arguments`  (lines 294–307)

```
fn parse_arguments(raw_args: &str) -> Result<Option<Value>, FunctionCallError>
```

**Purpose**: Turns a raw argument string into optional JSON. It accepts empty or JSON null input as “no arguments,” which gives callers a simple way to distinguish absent input from real input.

**Data flow**: It receives a raw string. If the string is blank, it returns no value. Otherwise it parses the string as JSON; parse errors become model-facing function-call errors. If the parsed JSON is null it returns no value, and for any other JSON it returns that value.

**Call relations**: No direct caller is shown in the provided call facts. It is the first parsing step for code that starts with raw text arguments before converting them into a specific argument structure.

*Call graph*: 1 external calls (from_str).


##### `parse_args`  (lines 309–321)

```
fn parse_args(arguments: Option<Value>) -> Result<T, FunctionCallError>
```

**Purpose**: Converts already-parsed JSON into a specific Rust argument type. It is used when arguments are required and must match the expected shape.

**Data flow**: It receives optional JSON. If JSON is present, it tries to deserialize it into the requested type; if the shape is wrong, it returns a model-facing error explaining the parse failure. If no JSON is present, it returns a model-facing error saying an argument value was expected.

**Call relations**: parse_args_with_default calls this when JSON was supplied and should be interpreted normally. It relies on JSON deserialization to do the detailed shape checking.

*Call graph*: called by 1 (parse_args_with_default); 2 external calls (from_value, RespondToModel).


##### `parse_args_with_default`  (lines 323–331)

```
fn parse_args_with_default(arguments: Option<Value>) -> Result<T, FunctionCallError>
```

**Purpose**: Converts optional JSON into a specific argument type, but uses that type’s default value when no arguments were provided. This is useful for list commands where all fields are optional.

**Data flow**: It receives optional JSON. If JSON is present, it hands it to parse_args for normal validation and conversion. If no JSON is present, it returns the default instance of the requested type.

**Call relations**: It is a softer version of parse_args for handlers that can run with empty arguments. The provided call facts show it delegates to parse_args when there is input and otherwise calls the type’s default constructor.

*Call graph*: calls 1 internal fn (parse_args); 1 external calls (default).


### `core/src/tools/handlers/mcp_resource/list_mcp_resource_templates.rs`

`orchestration` · `request handling`

This handler is the bridge between a model tool call and the MCP resource-template system. MCP means Model Context Protocol: a way for Codex to talk to external or internal services that expose tools and resources. A resource template is like a reusable address pattern for data, such as a URL shape with placeholders.

When the model calls `list_mcp_resource_templates`, this file checks that the call has normal function-style arguments, parses those arguments, and decides whether the request is for one named MCP server or for every connected server. If a server is named, it can also accept a pagination cursor, which is like a bookmark saying “continue from where the last page stopped.” If no server is named, it gathers templates from all servers, but it rejects cursors because one bookmark only makes sense for one specific server.

The handler also records the start and end of the tool call, including how long it took and whether it succeeded. Finally, it turns the result into the standard tool-output format that Codex can send back to the model. Without this file, the model could not discover available MCP resource templates through this built-in tool.

#### Function details

##### `ListMcpResourceTemplatesHandler::tool_name`  (lines 30–32)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool: `list_mcp_resource_templates`. This is the name the rest of the tool system uses to match an incoming tool call to this handler.

**Data flow**: It takes no outside data beyond the handler itself. It creates a plain tool name from the fixed text `list_mcp_resource_templates` and returns that name.

**Call relations**: The tool registry calls this when it needs to identify which handler owns a tool call. It uses `plain` to wrap the human-readable name in the project’s `ToolName` type.

*Call graph*: calls 1 internal fn (plain).


##### `ListMcpResourceTemplatesHandler::spec`  (lines 34–36)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of the tool, including what arguments it accepts. This description is what tells the model how to call the tool correctly.

**Data flow**: It takes the handler as input, asks `create_list_mcp_resource_templates_tool` to build the tool specification, and returns that specification unchanged.

**Call relations**: The tool system calls this when it advertises available tools to the model. This function hands off the actual specification-building work to `create_list_mcp_resource_templates_tool` so the handler does not duplicate schema details.

*Call graph*: calls 1 internal fn (create_list_mcp_resource_templates_tool).


##### `ListMcpResourceTemplatesHandler::supports_parallel_tool_calls`  (lines 38–40)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Says that this tool is safe to run at the same time as other tool calls. That matters because listing templates only reads information; it does not edit shared state.

**Data flow**: It receives no meaningful input besides the handler and always returns `true`. Nothing else is changed.

**Call relations**: The runtime asks this before deciding whether it may schedule this tool alongside others. By returning `true`, the handler allows the broader tool runner to do concurrent work when useful.


##### `ListMcpResourceTemplatesHandler::handle`  (lines 42–44)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the real asynchronous work for one tool invocation. It wraps the internal handler logic in the future type expected by the tool runtime.

**Data flow**: It receives a `ToolInvocation`, which contains the session, turn information, call id, and raw payload from the model. It passes that invocation into `handle_call`, pins the resulting asynchronous task so it can be safely driven by the runtime, and returns it.

**Call relations**: The tool executor calls this when the model invokes `list_mcp_resource_templates`. This function is a small adapter: it does not perform the listing itself, but hands the work to `handle_call` in the shape the runtime expects.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListMcpResourceTemplatesHandler::handle_call`  (lines 48–166)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Carries out the full `list_mcp_resource_templates` request. It parses the model’s arguments, asks one MCP server or all MCP servers for resource templates, records begin/end events, and returns a formatted tool result.

**Data flow**: It starts with a `ToolInvocation` containing the current session, turn, call id, and payload. It accepts only function-call payloads, parses the JSON-like arguments into `server` and `cursor`, cleans up empty optional strings, and builds an `McpInvocation` record for logging. If a server is supplied, it optionally turns the cursor into pagination parameters and asks that server for templates. If no server is supplied, it refuses any cursor and asks the MCP connection manager for templates from all servers. The raw template data is wrapped into a response payload, serialized into standard tool output, converted to text for logging, and returned as boxed tool output. If anything fails, it reports an error back to the model and records the failed end event.

**Call relations**: This is called by `handle` whenever the tool actually runs. At the start it calls `emit_tool_call_begin` so the session can observe that the MCP tool request began. For a single server it uses the session’s `list_resource_templates` path and wraps the answer with `from_single_server`; for all servers it goes through the MCP connection manager and wraps the answer with `from_all_servers`. At the end it calls `serialize_function_output`, uses `function_call_output_content_items_to_text` and `call_tool_result_from_content` to prepare a readable event result, emits `emit_tool_call_end`, and finally returns `boxed_tool_output` to the runtime.

*Call graph*: calls 4 internal fn (boxed_tool_output, from_all_servers, from_single_server, function_call_output_content_items_to_text); called by 1 (handle); 10 external calls (now, clone, call_tool_result_from_content, emit_tool_call_begin, emit_tool_call_end, normalize_optional_string, parse_args_with_default, parse_arguments, serialize_function_output, RespondToModel).


### `core/src/tools/handlers/mcp_resource/list_mcp_resources.rs`

`orchestration` · `request handling`

This handler is the bridge between a model tool call and the MCP resource system. MCP, or Model Context Protocol, is a way for Codex to talk to outside services that expose useful data as “resources.” Without this file, the model could have a tool definition for listing resources, but no code would actually turn that request into a query against MCP servers.

The flow is like a receptionist handling a directory request. First, the handler checks that the incoming tool call is the right kind of payload and reads its JSON arguments. The arguments may name a specific server and may include a cursor, which is a bookmark used for paginated results. Empty strings are normalized away so they do not act like real values.

If a server is provided, the handler asks the current session to list resources on that server, passing the cursor when present. If no server is provided, it asks the MCP connection manager for resources from every server, but it rejects a cursor in that case because a cursor only makes sense for one server’s paginated list. Around the actual work, it emits “tool call started” and “tool call ended” events, including timing and success or error details. Finally, it serializes the result into the standard tool output format that can be sent back to the model.

#### Function details

##### `ListMcpResourcesHandler::tool_name`  (lines 30–32)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool: `list_mcp_resources`. The tool registry uses this name to match a model’s requested tool call to this handler.

**Data flow**: It takes no outside data beyond the handler itself. It creates a plain tool name from the text `list_mcp_resources` and returns that name to the caller.

**Call relations**: When the tool system is building or checking its registry, it calls this method to identify the handler. This method delegates the small job of wrapping the text name to `plain`.

*Call graph*: calls 1 internal fn (plain).


##### `ListMcpResourcesHandler::spec`  (lines 34–36)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of the tool, including what arguments the model is allowed to provide. This is what tells the model how to call `list_mcp_resources` correctly.

**Data flow**: It takes no input other than the handler. It calls `create_list_mcp_resources_tool`, receives the tool specification, and returns it unchanged.

**Call relations**: The registry or tool advertisement flow calls this when it needs to show available tools to the model. The actual specification is built elsewhere by `create_list_mcp_resources_tool`, while this handler simply supplies it.

*Call graph*: calls 1 internal fn (create_list_mcp_resources_tool).


##### `ListMcpResourcesHandler::supports_parallel_tool_calls`  (lines 38–40)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Says that this tool may be run at the same time as other tool calls. Listing resources is treated as safe to do concurrently.

**Data flow**: It reads no input and changes no state. It simply returns `true`, meaning parallel execution is allowed.

**Call relations**: The tool runtime checks this before deciding whether multiple tool calls can run side by side. This handler does not hand off to any other function here because the answer is fixed.


##### `ListMcpResourcesHandler::handle`  (lines 42–44)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the asynchronous work for one `list_mcp_resources` request. It wraps the real handler logic in a future, which is a value representing work that will finish later.

**Data flow**: It receives a `ToolInvocation`, which contains the session, turn information, call id, and payload from the model. It passes that invocation into `handle_call`, pins the resulting future so the runtime can safely poll it, and returns that future to the tool executor.

**Call relations**: The tool runtime calls this when the model invokes `list_mcp_resources`. This method is a thin entry point: it immediately hands the real work to `handle_call` and returns the asynchronous task to the runtime.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListMcpResourcesHandler::handle_call`  (lines 48–164)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the full `list_mcp_resources` operation: read the model’s arguments, query MCP resources, report start and finish events, and return a model-readable result or error.

**Data flow**: It receives a `ToolInvocation` and pulls out the session, turn, call id, and payload. It expects a function-call payload containing argument text; if it gets another kind of payload, it returns an error meant to be shown to the model. It parses the arguments into `ListResourcesArgs`, cleans up optional `server` and `cursor` values, and records an `McpInvocation` for logging. Before querying anything, it emits a begin event and starts a timer. If a server name is present, it asks the session for that server’s resources, optionally using the cursor as a pagination bookmark. If no server is present, it asks the MCP connection manager for resources from all servers, but rejects a cursor because there is no single server list to continue. The raw resource data is wrapped into a `ListResourcesPayload`, serialized into standard tool output, converted to text for event reporting, and returned as boxed tool output. If querying or serialization fails, it emits an end event with the error and returns that error.

**Call relations**: This is called only by `handle`, after the tool runtime has chosen this handler for the request. It relies on shared helper functions to parse arguments, normalize optional strings, emit begin and end events, convert MCP results into payloads, serialize the final response, and package the output. It also calls into the session and MCP connection manager, which are the parts that actually talk to the available MCP servers.

*Call graph*: calls 4 internal fn (boxed_tool_output, from_all_servers, from_single_server, function_call_output_content_items_to_text); called by 1 (handle); 10 external calls (now, clone, call_tool_result_from_content, emit_tool_call_begin, emit_tool_call_end, normalize_optional_string, parse_args_with_default, parse_arguments, serialize_function_output, RespondToModel).


### `core/src/tools/handlers/mcp_resource/read_mcp_resource.rs`

`io_transport` · `tool invocation`

This file is the bridge between a model request like “read this MCP resource” and the actual MCP server call that fetches the resource. Without it, the tool may be advertised to the model, but there would be no code to check the request, contact the right server, and return the result in the format the rest of the system expects.

The main piece is `ReadMcpResourceHandler`. It tells the tool registry its name, describes its input shape, says it is safe to run in parallel with other tool calls, and then performs the work when invoked. The work happens in a careful sequence. First, it accepts only normal function-style tool input. Then it parses the JSON-like arguments and requires two important fields: the MCP server name and the resource URI, which is the resource’s address. Next, it emits a “tool call began” event, like writing a start line in an activity log, and records the start time.

It then asks the current session to read the resource from the named server. If that succeeds, it wraps the server response together with the server and URI, serializes it into the standard tool-output format, emits a matching “tool call ended” event, and returns the output. If anything fails, it still emits the end event with the error, so observers get a complete story of what happened.

#### Function details

##### `ReadMcpResourceHandler::tool_name`  (lines 30–32)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This function gives the handler its public tool name: `read_mcp_resource`. The tool registry uses this name to match a model’s requested tool call to this handler.

**Data flow**: It takes no outside input beyond the handler itself. It creates a plain tool name from the fixed text `read_mcp_resource` and returns that name to the caller.

**Call relations**: When the tool system is registering or looking up available tools, it asks this handler for its name. This function delegates the small job of building the `ToolName` value to `plain`.

*Call graph*: calls 1 internal fn (plain).


##### `ReadMcpResourceHandler::spec`  (lines 34–36)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This function returns the formal description of the `read_mcp_resource` tool. That description tells the model and runtime what arguments the tool expects.

**Data flow**: It takes the handler as input, calls the helper that builds the read-resource tool specification, and returns that specification. It does not read or change any runtime state.

**Call relations**: The tool registry calls this when it needs to advertise or validate the tool. It hands off the actual construction of the specification to `create_read_mcp_resource_tool`, keeping this handler focused on execution.

*Call graph*: calls 1 internal fn (create_read_mcp_resource_tool).


##### `ReadMcpResourceHandler::supports_parallel_tool_calls`  (lines 38–40)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: This function says that multiple calls to this tool may run at the same time. That matters because reading resources from MCP servers does not require this handler to hold exclusive shared state.

**Data flow**: It receives only the handler and returns `true`. Nothing else is read or changed.

**Call relations**: The runtime uses this answer when deciding whether it can run this tool alongside other tool calls. By returning true, the handler allows the broader tool executor to schedule it concurrently when appropriate.


##### `ReadMcpResourceHandler::handle`  (lines 42–44)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: This is the standard entry point the tool runtime calls when the model invokes `read_mcp_resource`. It turns the real async work into the boxed future shape expected by the shared tool interface.

**Data flow**: It receives a `ToolInvocation`, which contains the session, turn information, call ID, and raw tool arguments. It passes that invocation to `handle_call`, pins the asynchronous task so it can be safely driven by the runtime, and returns the future.

**Call relations**: The tool runtime calls `handle` after matching a tool request to this handler. `handle` immediately hands the detailed work to `handle_call`, acting like a small adapter between the common executor interface and this handler’s own logic.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ReadMcpResourceHandler::handle_call`  (lines 48–147)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: This function performs the full read-resource operation. It validates the model’s arguments, asks the chosen MCP server for the resource, records begin/end events, and returns either a clean tool result or an error the model can understand.

**Data flow**: It starts with a `ToolInvocation` containing the session, turn, call ID, and payload. It accepts only function-call payloads, parses the argument text, extracts and checks the required `server` and `uri` fields, and builds an `McpInvocation` record for logging. It emits a begin event and notes the current time. Then it calls the session’s `read_resource` method with the server name and URI. On success, it packages the result into a `ReadResourcePayload`, serializes that into the standard tool-output format, extracts readable text for logging, emits a successful end event with the elapsed time, and returns the boxed output. On failure at the server-call or serialization step, it emits an end event with the error message and returns the error.

**Call relations**: `handle` is the only listed caller of this function. Inside the larger flow, `handle_call` coordinates several helpers: argument parsers turn raw text into structured input, `emit_tool_call_begin` and `emit_tool_call_end` create observability events, the session performs the actual MCP resource read, serialization converts the response into model-facing output, and `boxed_tool_output` wraps the final result for the generic tool system.

*Call graph*: calls 2 internal fn (boxed_tool_output, function_call_output_content_items_to_text); called by 1 (handle); 11 external calls (now, new, clone, call_tool_result_from_content, emit_tool_call_begin, emit_tool_call_end, normalize_required_string, parse_args, parse_arguments, serialize_function_output (+1 more)).


### Session integration and auth flows
These files handle auth-elicitation decoding, session-side MCP refresh and approval orchestration, and skill-driven installation of required MCP dependencies.

### `codex-mcp/src/auth_elicitation.rs`

`domain_logic` · `request handling`

Some Codex tools depend on outside apps, such as calendar or drive connectors. If one of those apps needs the user to sign in again, the raw tool response contains structured metadata, not a friendly next step. This file is the translator between that raw metadata and the auth prompt Codex can show to the user.

It first checks whether a tool result is truly an authentication failure. It does not trust every field in the result blindly: the caller must provide the expected connector id, name, and install URL, and the file rejects results where the connector id is missing or does not match. That matters because the prompt may send a user to a login or install page, so the destination should come from trusted context, not only from the failing tool.

Once a failure is accepted, the file builds a small plan: the parsed failure details plus an “elicitation,” meaning a request asking the user to take action. The elicitation includes a message such as “Reconnect Google Calendar,” the URL to open, and a stable id based on the original tool call. It also has helpers for the result returned after the user accepts the auth request, telling the system to retry the original tool call.

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

**Purpose**: This function inspects a tool result and decides whether it represents a trusted connector authentication failure. It returns a clean, typed record of the failure only when the result is an error, the expected metadata is present, and the connector id matches the trusted connector id supplied by the caller.

**Data flow**: It receives the raw tool result, an optional expected connector id, an optional trusted connector name, and an optional install URL. It checks the result step by step, reads the nested metadata, trims text fields, rejects missing or mismatched connector ids, and fills in optional details such as the reason, link id, error code, HTTP status code, and suggested action. The output is either a `CodexAppsConnectorAuthFailure` ready for prompting the user, or `None` if the result should not become an auth prompt.

**Call relations**: This is the gatekeeper for the auth flow. `build_auth_elicitation_plan` calls it before creating any user-facing prompt, and the tests call it directly to prove that trusted metadata is accepted and unsafe or incomplete metadata is rejected. It uses `string_auth_failure_field` to pull optional text fields out of the metadata without accepting blank strings.

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

**Purpose**: This function builds the full plan for asking the user to authenticate a connector. It combines the parsed failure information with the prompt payload that can be shown to the user.

**Data flow**: It receives the original call id, the tool result, trusted connector details, and the install URL. First it asks `connector_auth_failure_from_tool_result` to validate and parse the failure. If that succeeds, it passes the parsed failure to `build_auth_elicitation` and returns both pieces together as a `CodexAppsAuthElicitationPlan`; if parsing fails, it returns `None`.

**Call relations**: This is the small orchestration step inside this file. It is used when the system wants one answer to the question, “Should I ask the user to reconnect, and if so, what exactly should I send?” The test `tests::builds_auth_elicitation_plan` exercises this path end to end.

*Call graph*: calls 2 internal fn (build_auth_elicitation, connector_auth_failure_from_tool_result); called by 1 (builds_auth_elicitation_plan).


##### `build_auth_elicitation`  (lines 140–164)

```
fn build_auth_elicitation(
    call_id: &str,
    auth_failure: &CodexAppsConnectorAuthFailure,
) -> CodexAppsAuthElicitation
```

**Purpose**: This function creates the actual auth prompt payload from an already validated auth failure. The payload includes machine-readable metadata, a human-readable message, the URL to open, and a unique prompt id.

**Data flow**: It receives a call id and a parsed `CodexAppsConnectorAuthFailure`. It copies the trusted connector details into a JSON metadata object, chooses the right message with `auth_elicitation_message`, copies the install URL as the link the user should visit, and creates an id with `auth_elicitation_id`. The output is a `CodexAppsAuthElicitation` that another part of the system can send to the user interface.

**Call relations**: `build_auth_elicitation_plan` calls this after the failure has passed validation. Inside, it delegates the wording to `auth_elicitation_message` and the identifier format to `auth_elicitation_id`, keeping those small choices separate and easy to test.

*Call graph*: calls 2 internal fn (auth_elicitation_id, auth_elicitation_message); called by 1 (build_auth_elicitation_plan); 1 external calls (json!).


##### `auth_elicitation_completed_result`  (lines 166–182)

```
fn auth_elicitation_completed_result(
    auth_failure: &CodexAppsConnectorAuthFailure,
    meta: Option<serde_json::Value>,
) -> CallToolResult
```

**Purpose**: This function creates the tool result used after the user accepts the authentication request. It tells the surrounding system that authentication was requested and accepted, and that the original tool call should be retried.

**Data flow**: It receives the parsed auth failure and optional metadata. It builds a `CallToolResult` containing a short text message naming the connector, marks the result as an error, leaves structured content empty, and attaches the supplied metadata. The output is a tool-style result that communicates “try again now” rather than returning normal tool data.

**Call relations**: This helper is separate from the prompt-building path. It is meant for the later part of the auth flow, after the user has responded to the elicitation. It does not call the parser because it assumes the auth failure has already been recognized.

*Call graph*: 1 external calls (vec!).


##### `auth_elicitation_id`  (lines 184–186)

```
fn auth_elicitation_id(call_id: &str) -> String
```

**Purpose**: This function turns a tool call id into the id used for the matching authentication prompt. It gives auth prompts a predictable prefix so they can be recognized as Codex app auth requests.

**Data flow**: It receives the original call id as text. It prefixes it with `codex_apps_auth_` and returns the combined string. Nothing else is read or changed.

**Call relations**: `build_auth_elicitation` calls this while assembling the prompt payload. It is a small naming helper, like putting a labeled tag on the prompt so later code can connect it back to the tool call.

*Call graph*: called by 1 (build_auth_elicitation); 1 external calls (format!).


##### `string_auth_failure_field`  (lines 188–198)

```
fn string_auth_failure_field(
    auth_failure: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String>
```

**Purpose**: This helper reads an optional text field from the auth failure metadata. It filters out missing, non-text, or blank values so the rest of the file does not have to repeat those checks.

**Data flow**: It receives the JSON object holding auth failure metadata and the key to look up. It gets the value, accepts it only if it is a string, trims surrounding whitespace, rejects it if it is empty, and returns the cleaned string. If any step fails, it returns `None`.

**Call relations**: `connector_auth_failure_from_tool_result` uses this helper for fields such as auth reason, connector id, link id, error code, and error action. This keeps the parser’s main logic focused on deciding whether the failure is trustworthy.

*Call graph*: called by 1 (connector_auth_failure_from_tool_result); 1 external calls (get).


##### `auth_elicitation_message`  (lines 200–219)

```
fn auth_elicitation_message(auth_failure: &CodexAppsConnectorAuthFailure) -> String
```

**Purpose**: This function chooses the user-facing sentence for an auth prompt. It makes the message more specific when the metadata explains why authentication is needed.

**Data flow**: It receives a parsed auth failure. It looks at `auth_reason` and the connector name, then returns a sentence such as asking the user to reconnect, restore access, sign in for a missing link, or simply sign in to continue. It does not change any data.

**Call relations**: `build_auth_elicitation` calls this while creating the prompt. This keeps the prompt-building code from being cluttered with wording rules, and it makes the user-facing behavior easy to adjust.

*Call graph*: called by 1 (build_auth_elicitation); 1 external calls (format!).


##### `tests::auth_failure_result`  (lines 226–249)

```
fn auth_failure_result() -> CallToolResult
```

**Purpose**: This test helper builds a realistic fake tool result that represents a connector authentication failure. The tests use it as their sample input instead of repeating the same JSON setup each time.

**Data flow**: It creates a `CallToolResult` with text content, marks it as an error, and fills the metadata with connector auth failure fields such as connector id, reason, link id, and error details. The output is that ready-made result for test cases to inspect or pass into the production functions.

**Call relations**: The test cases use this helper as the shared fixture, like a prepared sample form. It supports tests that parse auth failures, build prompt payloads, and build a full auth elicitation plan.

*Call graph*: 2 external calls (json!, vec!).


##### `tests::parses_auth_failure_from_trusted_connector_metadata`  (lines 252–272)

```
fn parses_auth_failure_from_trusted_connector_metadata()
```

**Purpose**: This test proves that a well-formed authentication failure is parsed correctly when the caller supplies trusted connector information. It also checks that the trusted connector name and install URL are used in the parsed result.

**Data flow**: It builds or uses the sample auth failure result, passes it with the expected connector id, trusted display name, and install URL into the parser, and compares the returned value to the exact expected `CodexAppsConnectorAuthFailure`. The visible outcome is a passing or failing assertion.

**Call relations**: This test focuses on the happy path for `connector_auth_failure_from_tool_result`. It protects the main auth flow by checking that valid metadata becomes the clean internal record that later prompt-building functions depend on.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_missing_or_mismatched_connector_ids`  (lines 275–294)

```
fn rejects_missing_or_mismatched_connector_ids()
```

**Purpose**: This test proves the parser does not create an auth prompt when the trusted connector id is absent or does not match the metadata. That protects users from being sent to the wrong connector’s authentication page.

**Data flow**: It sends the sample auth failure result through the parser twice: once without a connector id and once with a different connector id. In both cases it expects `None`, meaning the raw result is not accepted as a usable auth failure.

**Call relations**: This test exercises the safety checks inside `connector_auth_failure_from_tool_result`. It is the guardrail test for the trust boundary between untrusted tool metadata and the user-facing auth prompt.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::builds_url_elicitation_payload`  (lines 297–331)

```
fn builds_url_elicitation_payload()
```

**Purpose**: This test checks that a parsed auth failure becomes the exact prompt payload expected by the rest of the system. It verifies the metadata, message, URL, and prompt id together.

**Data flow**: It starts with the sample auth failure result, parses it with trusted connector information, then passes the parsed failure into `build_auth_elicitation`. It compares the returned `CodexAppsAuthElicitation` to an expected value containing the reconnect message, install URL, nested metadata, and generated id.

**Call relations**: This test follows the main path from raw failure to user prompt, using `connector_auth_failure_from_tool_result` first and then checking `build_auth_elicitation`. It also indirectly covers the message and id helpers because their output appears in the final payload.

*Call graph*: calls 1 internal fn (connector_auth_failure_from_tool_result); 2 external calls (assert_eq!, auth_failure_result).


##### `tests::builds_auth_elicitation_plan`  (lines 334–346)

```
fn builds_auth_elicitation_plan()
```

**Purpose**: This test checks the convenience function that produces both the parsed failure and the prompt in one step. It ensures the combined plan contains the trusted connector name and the expected prompt id.

**Data flow**: It passes the sample auth failure result, call id, connector id, connector name, and install URL into `build_auth_elicitation_plan`. It unwraps the returned plan and asserts selected fields from both halves: the parsed auth failure and the generated elicitation.

**Call relations**: This test covers the top-level flow in this file. It confirms that `build_auth_elicitation_plan` correctly calls the parser and then the prompt builder, so callers can rely on one function for the common auth-prompt path.

*Call graph*: calls 1 internal fn (build_auth_elicitation_plan); 2 external calls (assert_eq!, auth_failure_result).


### `core/src/session/mcp.rs`

`orchestration` · `startup, config refresh, and MCP request handling`

MCP, or Model Context Protocol, lets Codex talk to outside servers that expose tools, resources, and prompts. This file is the session-level bridge to those servers. Without it, a session could not refresh its MCP connections, call MCP tools, read MCP resources, or ask the user or Guardian to approve MCP requests.

The file has two main jobs. First, it offers simple session methods such as listing resources, reading a resource, calling a tool, and rebuilding the MCP connection manager when configuration changes. Think of this as replacing and reconnecting a power strip when the set of plugged-in devices changes.

Second, it deals with “elicitations,” which are questions an MCP server asks the client. Some elicitations are ordinary user prompts. Others are approval requests, such as “may I run this tool?” For those, this file can send the request to the frontend, wait for a reply, or route it through Guardian for automatic safety review. It carefully records pending requests so the answer can be matched back to the right server and request id.

A notable detail is that malformed or unsupported Guardian approval requests are declined safely instead of guessed at. The file also records telemetry for plugin-install suggestions, so the product can know when those prompts were shown.

#### Function details

##### `GuardianMcpElicitationReviewer::new`  (lines 54–58)

```
fn new(session: &Arc<Session>) -> Self
```

**Purpose**: Creates a Guardian-backed reviewer object for one session. It stores only a weak reference to the session, so the reviewer does not keep the whole session alive by accident.

**Data flow**: It receives a shared session pointer. It turns that into a weak pointer, which is like keeping an address without owning the house, and returns a reviewer containing that weak pointer.

**Call relations**: Session::mcp_elicitation_reviewer calls this when the MCP layer needs a reviewer handle. The reviewer later uses the saved weak session reference when Guardian review is requested.

*Call graph*: called by 1 (mcp_elicitation_reviewer); 1 external calls (downgrade).


##### `GuardianMcpElicitationReviewer::review`  (lines 62–73)

```
fn review(
        &self,
        request: ElicitationReviewRequest,
    ) -> BoxFuture<'static, anyhow::Result<Option<ElicitationResponse>>>
```

**Purpose**: Implements the actual review hook used by the MCP system. When an MCP server asks for approval, this tries to find the live session and, if possible, sends the request through Guardian.

**Data flow**: It receives an MCP elicitation review request. It upgrades the weak session reference into a live session if the session still exists; if not, it returns no answer. If the session is alive, it passes the request to review_guardian_mcp_elicitation and returns that result.

**Call relations**: The MCP library calls this through the ElicitationReviewer interface. It hands the real work to review_guardian_mcp_elicitation, which checks whether Guardian should review the request and builds the final MCP response.

*Call graph*: calls 1 internal fn (review_guardian_mcp_elicitation); 2 external calls (pin, clone).


##### `Session::runtime_mcp_config`  (lines 77–82)

```
async fn runtime_mcp_config(&self, config: &Config) -> McpConfig
```

**Purpose**: Builds the MCP configuration that should be used right now for this session and thread. This matters because runtime configuration can include session-specific or thread-specific additions.

**Data flow**: It receives the current Config. It asks the MCP manager to combine that config with MCP thread initialization state. It returns the resulting McpConfig.

**Call relations**: Session::runtime_mcp_servers and Session::refresh_mcp_servers_inner call this before they need the effective MCP setup. It is the first step before choosing which servers should exist.

*Call graph*: called by 2 (refresh_mcp_servers_inner, runtime_mcp_servers).


##### `Session::runtime_mcp_servers`  (lines 84–89)

```
async fn runtime_mcp_servers(
        &self,
        config: &Config,
    ) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns the MCP servers that are configured for this session at runtime. It gives callers the concrete server map rather than the broader MCP configuration.

**Data flow**: It receives the current Config. It first builds the runtime MCP config, then extracts the configured MCP servers from it, and returns them keyed by server name.

**Call relations**: This is a convenience wrapper around Session::runtime_mcp_config. It hands the resulting config to the MCP helper that extracts server definitions.

*Call graph*: calls 1 internal fn (runtime_mcp_config); 1 external calls (configured_mcp_servers).


##### `Session::mcp_elicitation_reviewer`  (lines 91–93)

```
fn mcp_elicitation_reviewer(self: &Arc<Self>) -> ElicitationReviewerHandle
```

**Purpose**: Creates a reviewer handle that the MCP connection manager can use when a server asks for approval. The reviewer connects MCP approval questions back to this session’s Guardian flow.

**Data flow**: It receives the session as a shared Arc pointer. It creates a GuardianMcpElicitationReviewer and wraps it in a shared reviewer handle. The output is something the MCP system can store and call later.

**Call relations**: This calls GuardianMcpElicitationReviewer::new. The resulting handle is passed into MCP setup so later MCP elicitation reviews can reach Guardian through GuardianMcpElicitationReviewer::review.

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

**Purpose**: Sends an MCP server’s question to the client side and waits for an answer. This is how a server can ask the user for form input, a URL action, or approval during an active turn.

**Data flow**: It receives the current turn context, a request id, and the server’s elicitation parameters. If the connection manager is set to auto-deny elicitations, it returns an automatic accept-shaped response without sending anything. Otherwise it converts the MCP request into the project’s event format, stores a one-time response channel in the active turn state, sends an event to the client, optionally records plugin-install telemetry, then waits for the response channel and returns the answer plus a flag saying the request was sent.

**Call relations**: This is called when an MCP server initiates an elicitation. It uses plugin_install_elicitation_telemetry_metadata to recognize install-suggestion prompts. Later, Session::resolve_elicitation supplies the answer by finding the stored response channel.

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

**Purpose**: Delivers a user or client answer back to the waiting MCP elicitation request. It matches the answer to the original server name and request id.

**Data flow**: It receives a server name, request id, and response. It first looks in the active turn’s pending elicitations. If it finds a waiting channel, it sends the response there. If not, it forwards the response to the MCP connection manager, which may know about a request outside the active turn state.

**Call relations**: This completes the flow started by Session::request_mcp_server_elicitation. It is the return path from the frontend or caller back to the MCP machinery.


##### `Session::list_resources`  (lines 247–257)

```
async fn list_resources(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> anyhow::Result<ListResourcesResult>
```

**Purpose**: Asks an MCP server what resources it offers. Resources are external items, such as files or data objects, that the server can expose to Codex.

**Data flow**: It receives a server name and optional pagination information. It forwards both to the current MCP connection manager. It returns either the server’s resource list or an error.

**Call relations**: This is a thin session-level doorway into the MCP connection manager. Higher-level session code can call it without needing to know how MCP connections are stored.


##### `Session::list_resource_templates`  (lines 259–269)

```
async fn list_resource_templates(
        &self,
        server: &str,
        params: Option<PaginatedRequestParams>,
    ) -> anyhow::Result<ListResourceTemplatesResult>
```

**Purpose**: Asks an MCP server for resource templates, which are patterns for resources that can be filled in later. This lets the client discover resource shapes, not just fixed resource items.

**Data flow**: It receives a server name and optional pagination information. It forwards the request to the current MCP connection manager and returns the result or error.

**Call relations**: Like the other resource methods, it keeps callers talking to Session while the connection manager does the actual MCP communication.


##### `Session::read_resource`  (lines 271–281)

```
async fn read_resource(
        &self,
        server: &str,
        params: ReadResourceRequestParams,
    ) -> anyhow::Result<ReadResourceResult>
```

**Purpose**: Reads a specific resource from an MCP server. This is the session’s public path for fetching the content behind a resource reference.

**Data flow**: It receives a server name and read parameters describing which resource to fetch. It passes them to the MCP connection manager. It returns the resource contents or an error.

**Call relations**: This method sits between session callers and the MCP connection manager. It does not interpret the resource itself; it delegates the server conversation.


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

**Purpose**: Calls a named tool on an MCP server. Tools are actions exposed by the server, and this method is the session-level entry point for invoking them.

**Data flow**: It receives the server name, tool name, optional JSON arguments, and optional metadata. It forwards these to the MCP connection manager. It returns the tool result or an error.

**Call relations**: Higher-level code calls this when it wants an MCP tool execution. The MCP connection manager performs the actual request to the external server.


##### `Session::refresh_mcp_servers_inner`  (lines 297–368)

```
async fn refresh_mcp_servers_inner(
        &self,
        turn_context: &TurnContext,
        mcp_servers: HashMap<String, McpServerConfig>,
        store_mode: OAuthCredentialsStoreMode,
        key
```

**Purpose**: Rebuilds the MCP connection manager using a fresh server configuration. This is the central routine that reconnects MCP servers after configuration, authentication, or environment details change.

**Data flow**: It receives the turn context, server definitions, credential storage settings, keyring choice, and an optional elicitation reviewer. It reads current authentication and runtime MCP config, computes effective servers and auth statuses, chooses the working directory, cancels any older MCP startup attempt, creates a new cancellation token, builds a new McpConnectionManager, preserves the old auto-deny setting, and stores the new manager in session services.

**Call relations**: Session::refresh_mcp_servers_if_requested and Session::refresh_mcp_servers_now both call this so the complicated rebuild logic lives in one place. It also calls Session::runtime_mcp_config to get the current MCP settings and provides the optional reviewer used for Guardian approval flow.

*Call graph*: calls 4 internal fn (new, new, runtime_mcp_config, permission_profile); called by 2 (refresh_mcp_servers_if_requested, refresh_mcp_servers_now); 3 external calls (new, new, tool_plugin_provenance).


##### `Session::refresh_mcp_servers_if_requested`  (lines 370–420)

```
async fn refresh_mcp_servers_if_requested(
        &self,
        turn_context: &TurnContext,
        elicitation_reviewer: Option<ElicitationReviewerHandle>,
    )
```

**Purpose**: Refreshes MCP servers only if some other part of the system has queued a refresh request. It is a safe checkpoint that turns pending JSON-like refresh data into real typed settings.

**Data flow**: It checks and removes the pending refresh config from the session. If nothing is pending, it does nothing. If data is present, it tries to parse server configs, OAuth credential storage mode, and keyring backend kind. If parsing succeeds, it calls Session::refresh_mcp_servers_inner; if parsing fails, it logs a warning and stops.

**Call relations**: This is called when the session reaches a point where it can apply queued MCP changes. It hands successful refreshes to Session::refresh_mcp_servers_inner.

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

**Purpose**: Immediately refreshes MCP servers from already-parsed configuration values. Use this when the caller already has valid server and authentication settings ready.

**Data flow**: It receives the turn context, server map, credential storage mode, keyring backend kind, and optional reviewer. It passes them directly to Session::refresh_mcp_servers_inner and waits for the rebuild to finish.

**Call relations**: This is the direct refresh path. It shares the actual rebuild work with Session::refresh_mcp_servers_if_requested by calling Session::refresh_mcp_servers_inner.

*Call graph*: calls 1 internal fn (refresh_mcp_servers_inner).


##### `Session::mcp_startup_cancellation_token`  (lines 441–447)

```
async fn mcp_startup_cancellation_token(&self) -> CancellationToken
```

**Purpose**: Returns the current cancellation token used for MCP startup work. This exists only in tests, so tests can inspect or coordinate startup cancellation behavior.

**Data flow**: It locks the session’s stored MCP startup cancellation token, clones it, and returns the clone. It does not change the token.

**Call relations**: Because it is test-only, production flow does not call it. It supports tests around Session::refresh_mcp_servers_inner and Session::cancel_mcp_startup behavior.


##### `Session::cancel_mcp_startup`  (lines 449–455)

```
async fn cancel_mcp_startup(&self)
```

**Purpose**: Cancels any MCP server startup work that is currently using the session’s startup cancellation token. This is useful when the session should stop trying to connect old MCP servers.

**Data flow**: It locks the stored cancellation token and calls cancel on it. Nothing is returned, but tasks watching that token can notice cancellation and stop.

**Call relations**: This is a manual stop signal for MCP startup. Session::refresh_mcp_servers_inner also cancels and replaces the token when it starts a new refresh, so old startup work does not race with new startup work.


##### `review_guardian_mcp_elicitation`  (lines 458–507)

```
async fn review_guardian_mcp_elicitation(
    session: Arc<Session>,
    request: ElicitationReviewRequest,
) -> anyhow::Result<Option<ElicitationResponse>>
```

**Purpose**: Decides whether an MCP elicitation should be reviewed by Guardian and, if so, runs that review. It turns Guardian’s decision into the accept, decline, or cancel response expected by MCP.

**Data flow**: It receives the session and an MCP review request. It finds the active turn, determines the configured approvals reviewer for the server and connector, checks whether this request should route to Guardian, converts valid metadata into a Guardian approval request, and either declines unsafe unsupported requests or asks Guardian for a decision. It returns an optional MCP elicitation response.

**Call relations**: GuardianMcpElicitationReviewer::review calls this. It uses elicitation_connector_id and guardian_elicitation_review_request to understand the request, then uses mcp_elicitation_response_from_guardian_decision to translate Guardian’s result back to MCP.

*Call graph*: calls 5 internal fn (mcp_approvals_reviewer, elicitation_connector_id, guardian_elicitation_review_request, mcp_elicitation_decline_without_message, mcp_elicitation_response_from_guardian_decision); called by 1 (review); 4 external calls (new_guardian_review_id, review_approval_request, routes_approval_to_guardian_with_reviewer, warn!).


##### `guardian_elicitation_review_request`  (lines 509–586)

```
fn guardian_elicitation_review_request(
    request: &ElicitationReviewRequest,
) -> GuardianElicitationReview
```

**Purpose**: Parses an MCP elicitation and decides whether it is a valid Guardian approval request. It is the gatekeeper that refuses incomplete, malformed, or unsupported approval metadata.

**Data flow**: It receives an elicitation review request. It checks whether the request is a form elicitation, whether its metadata says it is an approval request for an MCP tool call, whether the form schema is empty, and whether the needed tool fields are present and well-formed. It returns one of three outcomes: no Guardian review needed, decline immediately, or a built GuardianApprovalRequest.

**Call relations**: review_guardian_mcp_elicitation calls this before involving Guardian. It relies on meta_requests_approval_request, metadata_str, and metadata_owned_string to read metadata safely.

*Call graph*: calls 3 internal fn (meta_requests_approval_request, metadata_owned_string, metadata_str); called by 1 (review_guardian_mcp_elicitation); 6 external calls (new, new, Object, ApprovalRequest, Decline, format!).


##### `elicitation_connector_id`  (lines 588–595)

```
fn elicitation_connector_id(elicitation: &CreateElicitationRequestParams) -> Option<&str>
```

**Purpose**: Extracts the connector id from an MCP elicitation’s metadata, if one is present. The connector id helps choose the correct approval reviewer settings.

**Data flow**: It receives either a form or URL elicitation. It looks inside its optional metadata map for the connector id key and returns the string if found.

**Call relations**: review_guardian_mcp_elicitation calls this before deciding whether the request routes to Guardian. It is a small helper for the approval-routing step.

*Call graph*: called by 1 (review_guardian_mcp_elicitation).


##### `meta_requests_approval_request`  (lines 597–601)

```
fn meta_requests_approval_request(meta: &Option<Meta>) -> bool
```

**Purpose**: Checks whether a metadata block says the elicitation is an approval request. This is used to distinguish ordinary MCP prompts from permission questions.

**Data flow**: It receives optional metadata. It looks for the request-type field and compares it with the known approval-request value. It returns true only for that exact match.

**Call relations**: guardian_elicitation_review_request uses this especially for URL elicitations, where Guardian approval review is not supported and approval-looking URL requests are declined.

*Call graph*: called by 1 (guardian_elicitation_review_request).


##### `metadata_str`  (lines 603–605)

```
fn metadata_str(meta: &'a Map<String, Value>, key: &str) -> Option<&'a str>
```

**Purpose**: Reads a string value from a JSON metadata map. It avoids treating non-string values as valid text.

**Data flow**: It receives a metadata map and a key. It looks up the key and returns the value only if it is a JSON string. Otherwise it returns nothing.

**Call relations**: guardian_elicitation_review_request, metadata_owned_string, and plugin_install_elicitation_telemetry_metadata use this as their basic safe reader for metadata fields.

*Call graph*: called by 3 (guardian_elicitation_review_request, metadata_owned_string, plugin_install_elicitation_telemetry_metadata); 1 external calls (get).


##### `metadata_owned_string`  (lines 607–612)

```
fn metadata_owned_string(meta: &Map<String, Value>, key: &str) -> Option<String>
```

**Purpose**: Reads a non-empty trimmed string from metadata and returns an owned copy. This filters out missing, blank, or whitespace-only values.

**Data flow**: It receives a metadata map and key. It uses metadata_str to get a string, trims surrounding whitespace, rejects empty text, and returns a new String if valid.

**Call relations**: guardian_elicitation_review_request uses this to build a clean Guardian approval request. plugin_install_elicitation_telemetry_metadata uses it to collect telemetry fields.

*Call graph*: calls 1 internal fn (metadata_str); called by 2 (guardian_elicitation_review_request, plugin_install_elicitation_telemetry_metadata).


##### `plugin_install_elicitation_telemetry_metadata`  (lines 614–639)

```
fn plugin_install_elicitation_telemetry_metadata(
    event: &EventMsg,
) -> Option<PluginInstallElicitationTelemetryMetadata>
```

**Purpose**: Detects whether an outgoing elicitation is a plugin-install suggestion and extracts the fields needed for telemetry. This lets the session record that such a prompt was shown.

**Data flow**: It receives an event. It only continues if the event is an elicitation request with form metadata. It checks that the approval kind is a tool suggestion and the suggestion action is install. If so, it reads tool type, tool id, and tool name, and returns them together; otherwise it returns nothing.

**Call relations**: Session::request_mcp_server_elicitation calls this just before sending the event. If metadata is returned, that session method records plugin-install elicitation telemetry.

*Call graph*: calls 2 internal fn (metadata_owned_string, metadata_str); called by 1 (request_mcp_server_elicitation).


##### `mcp_elicitation_request_id`  (lines 641–646)

```
fn mcp_elicitation_request_id(id: &RequestId) -> String
```

**Purpose**: Turns an MCP request id into plain text. MCP ids may be numbers or strings, and this helper gives logging and Guardian ids one consistent format.

**Data flow**: It receives a request id that can be either a string or a number. It converts whichever form it has into a String and returns it.

**Call relations**: This helper is used inside Guardian elicitation review code to build readable ids and warning messages for MCP approval requests.


##### `mcp_elicitation_response_from_guardian_decision`  (lines 648–660)

```
async fn mcp_elicitation_response_from_guardian_decision(
    session: &Session,
    review_id: &str,
    decision: ReviewDecision,
) -> ElicitationResponse
```

**Purpose**: Converts Guardian’s review decision into an MCP elicitation response, including a detailed denial message when Guardian denied the request.

**Data flow**: It receives the session, a Guardian review id, and the Guardian decision. If the decision is denied, it asks Guardian for the rejection message. It then passes the decision and optional message to mcp_elicitation_response_from_guardian_decision_parts and returns the MCP response.

**Call relations**: review_guardian_mcp_elicitation calls this after Guardian finishes reviewing. It delegates the decision-to-response mapping to mcp_elicitation_response_from_guardian_decision_parts.

*Call graph*: calls 1 internal fn (mcp_elicitation_response_from_guardian_decision_parts); called by 1 (review_guardian_mcp_elicitation); 1 external calls (guardian_rejection_message).


##### `mcp_elicitation_response_from_guardian_decision_parts`  (lines 662–687)

```
fn mcp_elicitation_response_from_guardian_decision_parts(
    decision: ReviewDecision,
    denial_message: Option<String>,
) -> ElicitationResponse
```

**Purpose**: Maps each possible Guardian decision to the MCP action that should be sent back to the server. This is where “approved,” “denied,” “timed out,” and “aborted” become protocol responses.

**Data flow**: It receives a Guardian decision and an optional denial message. Approval-like decisions become an Accept response with empty content and automatic-review metadata. Denied and timed-out decisions become Decline responses with a message. Abort becomes a Cancel response.

**Call relations**: mcp_elicitation_response_from_guardian_decision calls this after preparing any denial text. It uses mcp_elicitation_auto_meta and mcp_elicitation_decline_with_message to build consistent response bodies.

*Call graph*: calls 2 internal fn (mcp_elicitation_auto_meta, mcp_elicitation_decline_with_message); called by 1 (mcp_elicitation_response_from_guardian_decision); 2 external calls (guardian_timeout_message, json!).


##### `mcp_elicitation_decline_with_message`  (lines 689–698)

```
fn mcp_elicitation_decline_with_message(message: String) -> ElicitationResponse
```

**Purpose**: Builds an MCP decline response that includes a human-readable reason. This is used when the server should be told why the request was refused.

**Data flow**: It receives a message string. It creates an ElicitationResponse with Decline as the action, no content, and metadata containing the message plus a note that the approvals reviewer was automatic.

**Call relations**: mcp_elicitation_response_from_guardian_decision_parts calls this for Guardian denial and timeout cases. It standardizes the shape of decline responses that include explanations.

*Call graph*: called by 1 (mcp_elicitation_response_from_guardian_decision_parts); 1 external calls (json!).


##### `mcp_elicitation_decline_without_message`  (lines 700–706)

```
fn mcp_elicitation_decline_without_message() -> ElicitationResponse
```

**Purpose**: Builds an MCP decline response without a custom explanation. This is used for safe automatic rejection when the code does not want to expose or invent a message.

**Data flow**: It creates an ElicitationResponse with Decline as the action, no content, and standard automatic-review metadata. It returns that response.

**Call relations**: review_guardian_mcp_elicitation calls this when an elicitation must be declined before Guardian review. It uses mcp_elicitation_auto_meta for the shared metadata.

*Call graph*: calls 1 internal fn (mcp_elicitation_auto_meta); called by 1 (review_guardian_mcp_elicitation).


##### `mcp_elicitation_auto_meta`  (lines 708–712)

```
fn mcp_elicitation_auto_meta() -> serde_json::Value
```

**Purpose**: Creates the standard metadata saying the MCP elicitation response came from automatic approval review. This keeps accept, decline, and cancel responses labeled consistently.

**Data flow**: It takes no input. It returns a small JSON value containing the approvals reviewer marker set to AutoReview.

**Call relations**: mcp_elicitation_decline_without_message and mcp_elicitation_response_from_guardian_decision_parts call this when building MCP responses. It is the common stamp placed on automatically reviewed elicitation replies.

*Call graph*: called by 2 (mcp_elicitation_decline_without_message, mcp_elicitation_response_from_guardian_decision_parts); 1 external calls (json!).


### `core/src/mcp_skill_dependencies.rs`

`orchestration` · `during skill setup in a conversation turn`

Some skills need outside tool servers, called MCP servers. MCP means Model Context Protocol: a standard way for Codex to talk to external tools. This file is the bridge between “the user picked a skill” and “the required tool server is actually available.” Without it, a skill could be selected but then fail later because its needed MCP server was missing.

The flow starts by checking whether this client is allowed to use the feature, whether the feature flag is enabled, and whether any mentioned skills declare MCP tool dependencies. It compares those declared dependencies with the MCP servers already known to the current session. To avoid duplicate work, it gives each dependency a stable “canonical” key based on its transport type and URL or command, much like identifying a shop by its address instead of its display name.

If something is missing, the file may ask the user whether to install it, unless the current permission settings allow automatic approval. If the user agrees, it loads the global MCP server configuration, adds only the missing servers, writes the updated config back to disk, and tries OAuth login for servers that support it. OAuth is the browser-style sign-in flow used to grant access. Finally, it refreshes the session so the newly added servers can be used right away.

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

**Purpose**: This is the top-level gatekeeper for installing missing MCP dependencies for mentioned skills. It decides whether the feature is allowed, finds missing servers, asks the user if needed, and starts installation only when appropriate.

**Data flow**: It receives the current session, turn context, cancellation token, the list of mentioned skills, and an optional reviewer used later for MCP prompts. It reads the client originator, feature settings, installed runtime MCP servers, and the set of dependencies already prompted about in this session. It turns the skill list into a map of missing MCP server configs, filters out ones the user was already asked about, asks whether to install them, and, if the answer is yes, passes control to the installer. It returns nothing; its effect is deciding whether installation happens.

**Call relations**: This function is called when skills and plugins are being built. It first uses the dependency collector to discover gaps, then the prompt filter to avoid repeated questions, then the user-permission step to get approval, and finally hands off to maybe_install_mcp_dependencies to make the actual config changes.

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

**Purpose**: This function performs the actual installation of missing MCP servers for the selected skills. It adds new server definitions to the global config, signs in to servers that need OAuth, and refreshes the session so the new servers become available.

**Data flow**: It receives the session, turn context, current config, mentioned skills, and an optional elicitation reviewer. It re-checks whether installation should run, reads the currently active MCP servers, computes what is missing, loads the global MCP server config from the user’s Codex home, inserts missing servers that are not already present, and writes the updated config back. For each newly added server, it checks whether OAuth login is supported, resolves which permission scopes to request, and tries to log in. At the end, it builds a refreshed config and asks the session to reload MCP servers. It returns nothing; it changes persisted config and the running session state.

**Call relations**: This is called after maybe_prompt_and_install_mcp_dependencies has decided installation is allowed. It uses collect_missing_mcp_dependencies to know what to add, relies on the config-editing layer to save changes, uses OAuth helpers to authenticate where needed, and then calls into the session to refresh MCP servers immediately.

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

**Purpose**: This function decides whether missing MCP servers should be installed now. It either accepts automatically under permissive settings or asks the user a clear install-or-skip question.

**Data flow**: It receives the session, turn context, a map of missing server configs, and a cancellation token. It first checks whether the current permission policy allows automatic approval. If not, it formats the missing server names into a readable list, sends a user-input request with two choices, and waits for either the answer or cancellation. It records that these dependencies were already prompted about, then returns true only if the user chose the install option.

**Call relations**: maybe_prompt_and_install_mcp_dependencies calls this after finding missing, not-yet-prompted dependencies. It uses format_missing_mcp_dependencies to make the prompt readable, sends the question through the session’s user-input path, and records prompted keys so the same question is not repeated later in the same session.

*Call graph*: calls 2 internal fn (format_missing_mcp_dependencies, permission_profile); called by 1 (maybe_prompt_and_install_mcp_dependencies); 7 external calls (default, mcp_permission_prompt_is_auto_approved, record_mcp_dependency_prompted, request_user_input, format!, select!, vec!).


##### `filter_prompted_mcp_dependencies`  (lines 289–303)

```
async fn filter_prompted_mcp_dependencies(
    sess: &Session,
    missing: &HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig>
```

**Purpose**: This function removes missing MCP dependencies that the user has already been asked about during the current session. It prevents repeated prompts for the same server after the user has chosen to skip.

**Data flow**: It receives the session and the current map of missing MCP server configs. It reads the session’s stored set of already prompted dependency keys. If none exist, it returns the original missing map. Otherwise, it builds and returns a new map containing only missing servers whose canonical key has not already been recorded.

**Call relations**: maybe_prompt_and_install_mcp_dependencies calls this before asking the user anything. It relies on the same canonical key style used elsewhere, so a server is recognized consistently even if names vary.

*Call graph*: called by 1 (maybe_prompt_and_install_mcp_dependencies); 1 external calls (mcp_dependency_prompted).


##### `format_missing_mcp_dependencies`  (lines 305–309)

```
fn format_missing_mcp_dependencies(missing: &HashMap<String, McpServerConfig>) -> String
```

**Purpose**: This function turns the missing MCP server names into a short, readable comma-separated list for the user prompt.

**Data flow**: It receives a map whose keys are MCP server names. It copies the names, sorts them so the order is stable and easy to scan, joins them with commas, and returns the resulting string.

**Call relations**: should_install_mcp_dependencies uses this when building the question shown to the user. Its output becomes the human-readable server list in the install prompt.

*Call graph*: called by 1 (should_install_mcp_dependencies).


##### `canonical_mcp_key`  (lines 311–318)

```
fn canonical_mcp_key(transport: &str, identifier: &str, fallback: &str) -> String
```

**Purpose**: This helper creates a stable identifier for an MCP server or dependency from its connection type and main address-like value. The goal is to compare servers by what they actually connect to, not just by a friendly name.

**Data flow**: It receives a transport label, an identifier such as a URL or command, and a fallback name. It trims the identifier. If the identifier is empty, it returns the fallback. Otherwise, it returns a combined key in the form that includes the transport and identifier.

**Call relations**: canonical_mcp_server_key and canonical_mcp_dependency_key both call this so installed servers and skill-declared dependencies are normalized in the same way. That shared normalization lets collect_missing_mcp_dependencies compare them reliably.

*Call graph*: called by 2 (canonical_mcp_dependency_key, canonical_mcp_server_key); 1 external calls (format!).


##### `canonical_mcp_server_key`  (lines 320–329)

```
fn canonical_mcp_server_key(name: &str, config: &McpServerConfig) -> String
```

**Purpose**: This function creates the stable comparison key for an already configured MCP server. It looks at how the server is reached: by a local command or by an HTTP URL.

**Data flow**: It receives a server name and its full MCP server config. If the server uses stdio, meaning Codex starts or talks to a local command through standard input and output, it uses the command as the identifier. If the server uses streamable HTTP, meaning Codex talks to it over a web URL, it uses the URL. It returns the canonical key produced from that information.

**Call relations**: collect_missing_mcp_dependencies uses this indirectly to build the set of installed server keys. filter_prompted_mcp_dependencies and should_install_mcp_dependencies also depend on this key style when deciding whether a dependency has already been shown to the user.

*Call graph*: calls 1 internal fn (canonical_mcp_key).


##### `canonical_mcp_dependency_key`  (lines 331–348)

```
fn canonical_mcp_dependency_key(dependency: &SkillToolDependency) -> Result<String, String>
```

**Purpose**: This function creates the stable comparison key for an MCP dependency declared by a skill. It also validates that the dependency includes the needed URL or command for its transport type.

**Data flow**: It receives one skill tool dependency. It reads the dependency transport, defaulting to streamable HTTP if none is given. For streamable HTTP, it requires a URL; for stdio, it requires a command. It returns a canonical key when the dependency is valid, or an error message when required information is missing or the transport type is unsupported.

**Call relations**: collect_missing_mcp_dependencies calls this for each MCP tool dependency found in a skill. If this function returns an error, the collector logs a warning and skips that dependency instead of trying to install something incomplete.

*Call graph*: calls 1 internal fn (canonical_mcp_key); called by 1 (collect_missing_mcp_dependencies); 1 external calls (format!).


##### `mcp_dependency_to_server_config`  (lines 350–414)

```
fn mcp_dependency_to_server_config(
    dependency: &SkillToolDependency,
) -> Result<McpServerConfig, String>
```

**Purpose**: This function converts a skill’s MCP dependency declaration into a real MCP server configuration that can be saved in the user’s global config.

**Data flow**: It receives one skill tool dependency. It checks whether the dependency is streamable HTTP or stdio. For HTTP, it requires a URL and builds an enabled server config using that URL. For stdio, it requires a command and builds an enabled server config using that command. It fills in safe default values for optional settings. It returns the completed config or an error message if the dependency is missing required information or uses an unsupported transport.

**Call relations**: collect_missing_mcp_dependencies calls this after it has decided a dependency is not already installed. The resulting config is later used by maybe_install_mcp_dependencies when adding the missing server to global configuration.

*Call graph*: called by 1 (collect_missing_mcp_dependencies); 3 external calls (new, new, format!).


##### `collect_missing_mcp_dependencies`  (lines 416–471)

```
fn collect_missing_mcp_dependencies(
    mentioned_skills: &[SkillMetadata],
    installed: &HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig>
```

**Purpose**: This function scans the mentioned skills and finds which MCP server dependencies are not currently installed. It is the main comparison step between what skills need and what the session already has.

**Data flow**: It receives the mentioned skill metadata and the map of installed MCP servers. It first turns installed servers into canonical keys. Then it walks each skill’s declared tool dependencies, ignores non-MCP tools, validates and canonicalizes each MCP dependency, skips anything already installed or already seen in this scan, converts each remaining dependency into an MCP server config, and collects those into a map keyed by the dependency’s display value. It returns that map of missing servers. Invalid dependency entries are skipped with warnings rather than stopping the whole process.

**Call relations**: maybe_prompt_and_install_mcp_dependencies uses this to decide whether there is anything worth prompting about. maybe_install_mcp_dependencies uses it again before editing config, so installation is based on the latest runtime state. It depends on the canonical key and config-conversion helpers to avoid duplicates and build installable server definitions.

*Call graph*: calls 2 internal fn (canonical_mcp_dependency_key, mcp_dependency_to_server_config); called by 2 (maybe_install_mcp_dependencies, maybe_prompt_and_install_mcp_dependencies); 3 external calls (new, new, warn!).
