# Thread and session orchestration  `stage-11`

This stage is the traffic desk for long-running conversations. It sits between startup and the main work loop: before the agent can answer, it must know which thread it belongs to, what history to load, where to run commands, and who is listening for events.

The library entry files expose the stable “front doors” to this core machinery. The thread manager and Codex thread wrapper create, resume, fork, switch, and shut down conversations. Session files then build the live workspace: model access, permissions, tools, environment, history, input queues, turn state, and background task control. Storage files create local records, keep live thread handles, trim history at safe turn boundaries, and update searchable metadata.

Server-side files attach clients to running threads, support reconnects, refresh MCP configuration, filter visible threads, and clean up unused sessions. Import files detect outside agent histories and decide whether they are safe to bring in. Extension files add goals, skills, and plugin-provided MCP servers. Tool handlers let the model request a new context window or update its plan. TUI files keep the terminal’s view, settings, side chats, goals, and active-turn display synchronized with the live thread.

## Files in this stage

### Core thread runtime
These files define the core library surface, thread manager, live thread facade, environment resolution, and the session/task machinery that constructs and runs long-lived conversation threads.

### `core/src/lib.rs`

`orchestration` · `cross-cutting`

This file is like the index and reception desk for the core library. It does not contain the main behavior itself. Instead, it names all the smaller modules that make up the core engine: configuration, threads, sessions, model clients, sandboxing, tools, skills, rollout history, web search, shell execution, and more.

Its most important job is to shape the public API, meaning the set of types, constants, and helper functions that other crates can import from `codex-core`. Many modules are kept private with `mod`, while selected items are re-exported with `pub use`. That lets the rest of the project say, for example, “give me `ThreadManager` from `codex-core`,” without needing to know the exact internal file where `ThreadManager` lives.

The file also sets one project-wide safety rule: library code is not allowed to print directly to standard output or standard error. In plain terms, core code must not casually write text to the user’s terminal. User-visible output should go through controlled channels such as the text user interface or tracing/logging system. Without this rule, background library code could unexpectedly clutter the terminal or break structured output.

There are also a few compatibility aliases marked as deprecated. These keep older names working while guiding new code toward newer terms such as “thread” instead of “conversation.”


### `core-api/src/lib.rs`

`other` · `cross-cutting API boundary`

This file does not implement new behavior itself. Its job is to act like a front desk for the rest of the Codex system. Many useful pieces live in separate internal crates: configuration, login, thread management, protocol messages, model providers, execution server support, analytics, and more. Without this file, outside users would need to know exactly which internal crate contains each item, and changes to the project’s internal organization would ripple into every caller.

The file solves that by publicly re-exporting selected items. A re-export means, “make this thing available from here too.” For example, callers can get thread-related types such as `ThreadManager`, configuration types such as `Config`, authentication support such as `AuthManager`, and protocol types such as `Op` or `EventMsg` through this API layer.

The crate-level rule `deny(private_bounds, private_interfaces, unreachable_pub)` tells the Rust compiler to reject public API mistakes, such as exposing something that depends on a private type. That matters because this file defines a boundary meant for other parts of the system, or outside consumers, to rely on. In short, it is a curated public shelf: it does not build the tools, but it decides which tools are easy and safe to reach.


### `core/src/thread_manager.rs`

`orchestration` · `cross-cutting thread lifecycle: startup, request handling, resume/fork, and shutdown`

A Codex thread is like a staffed workbench: it has a model, tools, a working directory, saved history, and live tasks in progress. This file owns the workshop registry. It knows which workbenches are currently open, how to open a new one, how to reopen one from saved history, how to copy one into a fork, and how to close them safely.

The main public type is `ThreadManager`. It is a friendly wrapper around shared `ThreadManagerState`, which holds the actual shared pieces: the live thread map, the thread store on disk or in memory, authentication, model lists, environment support, skills, plugins, extension hooks, analytics, and optional state database access. The manager also has test-only helpers so integration tests can run with temporary homes and fake providers.

A key job here is preserving history correctly. When a thread is forked, the file can either cut history before a chosen user message or snapshot a thread as if it had just been interrupted. If the saved history ends mid-turn, it can add the same “turn was interrupted” marker that a real live interrupt would have written. Without this care, copied threads could accidentally include unfinished work or replay confusing history.

This file matters because many parts of the system need a single safe place to ask: “start this agent,” “resume that saved thread,” “send an operation,” or “shut everything down.” Without it, live sessions, saved histories, subagents, and tool environments would drift out of sync.

#### Function details

##### `set_thread_manager_test_mode_for_tests`  (lines 94–96)

```
fn set_thread_manager_test_mode_for_tests(enabled: bool)
```

**Purpose**: Turns special thread-manager test behavior on or off. This is only meant for tests, so production code should leave it disabled.

**Data flow**: It receives a true-or-false value, stores that value in a shared atomic flag, and returns nothing. Afterward, constructors can read the flag and enable test-only tracking.

**Call relations**: Test setup code calls this before building managers through test helpers. The normal constructor later consults the companion reader to decide whether to keep an operation log for tests.

*Call graph*: called by 3 (set_thread_manager_test_mode, with_models_provider_for_tests, with_models_provider_home_and_state_for_tests).


##### `should_use_test_thread_manager_behavior`  (lines 98–100)

```
fn should_use_test_thread_manager_behavior() -> bool
```

**Purpose**: Checks whether the test-only thread-manager behavior is currently enabled.

**Data flow**: It reads the shared atomic flag and returns a boolean. It does not change any state.

**Call relations**: The production and test constructors call this while building manager state, mainly to decide whether submitted operations should be captured for later inspection.

*Call graph*: called by 2 (new, with_models_provider_home_and_state_for_tests).


##### `TempCodexHomeGuard::drop`  (lines 107–109)

```
fn drop(&mut self)
```

**Purpose**: Cleans up a temporary Codex home directory when a test manager is dropped. It prevents test runs from leaving behind scratch files.

**Data flow**: It reads the stored path, tries to delete that whole directory tree, and ignores any deletion error. Nothing is returned because this runs automatically during cleanup.

**Call relations**: The test constructor installs this guard after creating a temporary home. Rust calls `drop` automatically when the guard goes out of scope.

*Call graph*: 1 external calls (remove_dir_all).


##### `ForkSnapshot::from`  (lines 154–156)

```
fn from(value: usize) -> Self
```

**Purpose**: Keeps older callers working by treating a plain number as “fork before this numbered user message.”

**Data flow**: It receives a `usize` number and wraps it in the `ForkSnapshot::TruncateBeforeNthUserMessage` option. The result is a full snapshot choice.

**Call relations**: Forking functions accept anything that can become a `ForkSnapshot`, so old `fork_thread(number, ...)` style calls still feed into the newer snapshot logic.

*Call graph*: 1 external calls (TruncateBeforeNthUserMessage).


##### `build_models_manager`  (lines 225–234)

```
fn build_models_manager(
    config: &Config,
    auth_manager: Arc<AuthManager>,
) -> SharedModelsManager
```

**Purpose**: Builds the shared model manager that knows which AI model presets are available for this configuration and authentication setup.

**Data flow**: It reads model-provider settings, Codex home, optional model catalog data, and authentication. It creates a model provider and asks it for a shared models manager.

**Call relations**: `ThreadManager::new` calls this during setup so every thread created by the manager can use the same model-listing and model-refresh service.

*Call graph*: called by 1 (new); 1 external calls (create_model_provider).


##### `thread_store_from_config`  (lines 236–255)

```
fn thread_store_from_config(
    config: &Config,
    state_db: Option<StateDbHandle>,
) -> Arc<dyn ThreadStore>
```

**Purpose**: Chooses the storage backend for threads based on configuration. It can use local persistent storage or an in-memory store for temporary/test-like use.

**Data flow**: It reads the configured thread-store mode and optional state database. For local storage it may also start a background compression worker, then returns a shared thread-store object.

**Call relations**: Higher-level setup code calls this before constructing a `ThreadManager`. The returned store is later used for resuming, forking, metadata updates, and reading saved history.

*Call graph*: calls 3 internal fn (for_id, new, from_config); called by 2 (build_prompt_input, tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed); 2 external calls (new, spawn_rollout_compression_worker).


##### `ThreadManager::new`  (lines 259–312)

```
fn new(
        config: &Config,
        auth_manager: Arc<AuthManager>,
        session_source: SessionSource,
        environment_manager: Arc<EnvironmentManager>,
        extensions: Arc<ExtensionR
```

**Purpose**: Creates a normal `ThreadManager` for real use. It wires together authentication, models, environments, skills, plugins, extensions, storage, analytics, and the live thread registry.

**Data flow**: It receives configuration and shared services, builds helper managers, creates a broadcast channel for new-thread notices, stores everything in shared state, and returns a ready manager.

**Call relations**: Application setup and many tests call this as the main constructor. Later thread-start, resume, fork, and shutdown methods all work from the state assembled here.

*Call graph*: calls 5 internal fn (new_with_options, new_with_restriction_product, new_with_extensions, build_models_manager, should_use_test_thread_manager_behavior); called by 17 (build_prompt_input, explicit_installation_id_skips_codex_home_file, interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history, interrupted_fork_snapshot_preserves_explicit_turn_id, interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source, new_uses_active_provider_for_model_refresh, resume_active_thread_from_rollout_returns_running_thread, resume_and_fork_do_not_restore_thread_environments_from_rollout, resume_stopped_thread_from_rollout_preserves_thread_source, resume_stopped_thread_from_rollout_spawns_new_thread (+7 more)); 7 external calls (clone, new, new, new, bundled_skills_enabled, restriction_product, channel).


##### `ThreadManager::with_models_provider_for_tests`  (lines 316–335)

```
fn with_models_provider_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
    ) -> Self
```

**Purpose**: Builds a thread manager for integration tests using a fake or supplied model provider and a fresh temporary Codex home.

**Data flow**: It enables test mode, creates a temporary directory, delegates to the test constructor that accepts an explicit home, installs a cleanup guard, and returns the manager.

**Call relations**: Test helper code calls this when it needs a realistic manager without touching the user’s real Codex home. The cleanup guard later removes the temporary directory.

*Call graph*: calls 2 internal fn (set_thread_manager_test_mode_for_tests, default_for_tests); called by 2 (thread_manager_with_models_provider, thread_manager); 5 external calls (new, with_models_provider_and_home_for_tests, format!, temp_dir, create_dir_all).


##### `ThreadManager::with_models_provider_and_home_for_tests`  (lines 339–352)

```
fn with_models_provider_and_home_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
        codex_home: PathBuf,
        environment_manager: Arc<EnvironmentManager>,
    ) -> Se
```

**Purpose**: Builds a test manager with a supplied Codex home directory and model provider.

**Data flow**: It receives test authentication, provider information, a home path, and an environment manager. It forwards them to the fuller test constructor with no state database.

**Call relations**: Tests that need control over the filesystem location call this. It is a simpler wrapper around `with_models_provider_home_and_state_for_tests`.

*Call graph*: called by 10 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent, resume_agent_releases_slot_after_resume_failure, resume_agent_respects_max_threads_limit, spawn_agent_limit_shared_across_clones, spawn_agent_releases_slot_after_shutdown, spawn_agent_respects_max_threads_limit, thread_manager_with_models_provider_and_home, shutdown_all_threads_bounded_submits_shutdown_to_every_thread, start_thread_keeps_internal_threads_hidden_from_normal_lookups); 1 external calls (with_models_provider_home_and_state_for_tests).


##### `ThreadManager::with_models_provider_home_and_state_for_tests`  (lines 354–417)

```
fn with_models_provider_home_and_state_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
        codex_home: PathBuf,
        environment_manager: Arc<EnvironmentManager>,
```

**Purpose**: Builds the most configurable test `ThreadManager`, including an optional state database. It mimics normal setup while using test authentication and local test storage.

**Data flow**: It enables test mode, creates an auth manager from test credentials, checks the home path, builds model, plugin, MCP, skills, and local thread-store services, and returns a manager.

**Call relations**: Other test constructors delegate here. Tests that need storage-state behavior call it directly.

*Call graph*: calls 8 internal fn (new_with_options, new_with_restriction_product, new, set_thread_manager_test_mode_for_tests, should_use_test_thread_manager_behavior, from_auth_for_testing, new, from_absolute_path_checked); called by 6 (new_with_config, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_thread_subagent_restores_stored_nickname_and_role, thread_manager_with_models_provider_home_and_state, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target); 10 external calls (clone, new, new, clone, new, channel, empty_extension_registry, create_model_provider, panic!, new_v4).


##### `ThreadManager::session_source`  (lines 419–421)

```
fn session_source(&self) -> SessionSource
```

**Purpose**: Returns the default source label used for sessions started by this manager.

**Data flow**: It reads the stored session source from shared state, clones it, and returns it.

**Call relations**: Callers use this when they need to know what kind of session this manager represents, such as exec-driven or another product mode.


##### `ThreadManager::auth_manager`  (lines 423–425)

```
fn auth_manager(&self) -> Arc<AuthManager>
```

**Purpose**: Gives callers access to the shared authentication manager.

**Data flow**: It clones the shared pointer to authentication state and returns it. The authentication service itself is not copied.

**Call relations**: Other components can call this when they need the same login or API-token context used by threads.


##### `ThreadManager::skills_manager`  (lines 427–429)

```
fn skills_manager(&self) -> Arc<SkillsManager>
```

**Purpose**: Returns the shared skills manager, which supplies bundled or configured agent skills.

**Data flow**: It clones and returns the shared skills-manager pointer.

**Call relations**: Thread configuration registration calls this so thread setup can expose the same skills service used by spawned sessions.

*Call graph*: called by 1 (register_thread_config).


##### `ThreadManager::plugins_manager`  (lines 431–433)

```
fn plugins_manager(&self) -> Arc<PluginsManager>
```

**Purpose**: Returns the shared plugins manager, which knows about plugin availability and restrictions.

**Data flow**: It clones and returns the shared plugins-manager pointer.

**Call relations**: Thread configuration registration calls this when it needs plugin information for a thread.

*Call graph*: called by 1 (register_thread_config).


##### `ThreadManager::mcp_manager`  (lines 435–437)

```
fn mcp_manager(&self) -> Arc<McpManager>
```

**Purpose**: Returns the shared MCP manager. MCP means Model Context Protocol, a way for tools and external servers to provide context or actions to the agent.

**Data flow**: It clones and returns the shared MCP-manager pointer.

**Call relations**: Callers use this when they need the same MCP/tool-server coordination used by thread startup.


##### `ThreadManager::environment_manager`  (lines 439–441)

```
fn environment_manager(&self) -> Arc<EnvironmentManager>
```

**Purpose**: Returns the shared environment manager, which describes where turns can run.

**Data flow**: It clones and returns the shared environment-manager pointer.

**Call relations**: Thread configuration registration and environment-selection code call this to use the manager’s known environments.

*Call graph*: called by 1 (register_thread_config).


##### `ThreadManager::default_environment_selections`  (lines 443–448)

```
fn default_environment_selections(
        &self,
        cwd: &AbsolutePathBuf,
    ) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Computes the default environments for a new turn based on the current working directory.

**Data flow**: It receives a working directory, reads the environment manager, and returns the default list of environment selections.

**Call relations**: This is a convenience wrapper around the environment-selection helper used by thread-start paths.

*Call graph*: calls 1 internal fn (default_thread_environment_selections).


##### `ThreadManager::validate_environment_selections`  (lines 450–473)

```
fn validate_environment_selections(
        &self,
        environments: &[TurnEnvironmentSelection],
    ) -> CodexResult<()>
```

**Purpose**: Checks that a requested environment list is usable: no duplicate IDs and no unknown environment IDs.

**Data flow**: It receives a slice of environment selections, builds a set of IDs it has seen, asks the environment manager for each one, and returns success or a clear invalid-request error.

**Call relations**: Environment-resolution code calls this before a thread or turn uses caller-supplied environment choices.

*Call graph*: called by 1 (resolve_turn_environment_selections); 4 external calls (with_capacity, format!, InvalidRequest, len).


##### `ThreadManager::get_models_manager`  (lines 475–477)

```
fn get_models_manager(&self) -> SharedModelsManager
```

**Purpose**: Returns the shared models manager.

**Data flow**: It clones the shared models-manager pointer and returns it.

**Call relations**: Callers use this when they need direct access to model listing or refresh behavior rather than using the small wrapper methods here.


##### `ThreadManager::list_models`  (lines 479–484)

```
async fn list_models(&self, refresh_strategy: RefreshStrategy) -> Vec<ModelPreset>
```

**Purpose**: Lists available model presets, optionally refreshing according to the caller’s strategy.

**Data flow**: It receives a refresh strategy, asks the shared models manager for model presets, waits for the result, and returns the list.

**Call relations**: User-facing model selection or configuration code can call this through the manager.


##### `ThreadManager::list_collaboration_modes`  (lines 486–488)

```
fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

**Purpose**: Lists the collaboration modes supported by the available models.

**Data flow**: It asks the models manager for its collaboration-mode masks and returns them.

**Call relations**: Configuration or UI code can call this to know which multi-agent or collaboration options can be offered.


##### `ThreadManager::list_thread_ids`  (lines 490–492)

```
async fn list_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Lists the IDs of currently loaded, user-visible threads.

**Data flow**: It delegates to shared state, which reads the live thread map and filters out internal sessions. The returned value is a list of thread IDs.

**Call relations**: Callers use this to discover what the manager is currently tracking.


##### `ThreadManager::subscribe_thread_created`  (lines 494–496)

```
fn subscribe_thread_created(&self) -> broadcast::Receiver<ThreadId>
```

**Purpose**: Lets callers receive notifications when new threads are created.

**Data flow**: It creates a new receiver from the broadcast channel and returns it. Future sends on that channel will be visible to the receiver.

**Call relations**: Listeners subscribe here, while `ThreadManagerState::notify_thread_created` sends the actual notifications.


##### `ThreadManager::get_thread`  (lines 498–500)

```
async fn get_thread(&self, thread_id: ThreadId) -> CodexResult<Arc<CodexThread>>
```

**Purpose**: Looks up a loaded thread by ID and returns it if it is user-visible.

**Data flow**: It receives a thread ID, delegates to shared state, and returns either the shared thread object or a not-found error.

**Call relations**: Operations such as subagent spawning and metadata updates call this before acting on a live thread.

*Call graph*: called by 3 (assert_thread_not_loaded, spawn_subagent, update_thread_metadata).


##### `ThreadManager::update_thread_metadata`  (lines 507–538)

```
async fn update_thread_metadata(
        &self,
        thread_id: ThreadId,
        patch: ThreadMetadataPatch,
        include_archived: bool,
    ) -> CodexResult<StoredThread>
```

**Purpose**: Updates saved metadata, such as thread labels or archive state, whether the thread is currently loaded or only exists in storage.

**Data flow**: It receives a thread ID, metadata patch, and archive flag. If the thread is live, it routes through the live thread so writes stay ordered; otherwise it updates the store directly. It returns the updated stored thread or a mapped error.

**Call relations**: External callers use this single entry point instead of needing to know whether a thread is warm in memory or cold on disk.

*Call graph*: calls 1 internal fn (get_thread); 2 external calls (format!, InvalidRequest).


##### `ThreadManager::list_agent_subtree_thread_ids`  (lines 541–580)

```
async fn list_agent_subtree_thread_ids(
        &self,
        thread_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>>
```

**Purpose**: Finds a thread and all known descendant agent threads spawned under it.

**Data flow**: It starts with the requested thread ID, gathers persisted descendants from the state database when available, adds live descendants from agent control, removes duplicates, and returns the list.

**Call relations**: This combines stored parent-child edges and currently running agent-control knowledge so callers can reason about an agent subtree even when some parts are unloaded.

*Call graph*: calls 1 internal fn (agent_control); 2 external calls (new, new).


##### `ThreadManager::start_thread`  (lines 582–586)

```
async fn start_thread(&self, config: Config) -> CodexResult<NewThread>
```

**Purpose**: Starts a fresh thread with default settings and no extra dynamic tools.

**Data flow**: It receives a config, delegates to `start_thread_with_tools` with an empty tool list, waits for the new thread, and returns it.

**Call relations**: This is the simple public start path. It feeds into the richer start-options flow.

*Call graph*: calls 1 internal fn (start_thread_with_tools); called by 1 (start_thread); 2 external calls (pin, new).


##### `ThreadManager::start_thread_with_tools`  (lines 588–609)

```
async fn start_thread_with_tools(
        &self,
        config: Config,
        dynamic_tools: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a fresh thread and adds caller-provided dynamic tools to it.

**Data flow**: It receives config and tool specs, computes default environments from the config working directory, builds `StartThreadOptions`, and delegates to `start_thread_with_options`.

**Call relations**: The simpler `start_thread` method calls this. It prepares common defaults before the full spawn path.

*Call graph*: calls 2 internal fn (default_thread_environment_selections, start_thread_with_options); called by 1 (start_thread); 2 external calls (pin, default).


##### `ThreadManager::start_thread_with_options`  (lines 611–617)

```
async fn start_thread_with_options(
        &self,
        options: StartThreadOptions,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a thread using the full set of start options.

**Data flow**: It receives `StartThreadOptions`, adds no fork-source ID, and delegates to the internal fork-aware start helper.

**Call relations**: `start_thread_with_tools` calls this for normal new threads. Subagent creation uses the fork-aware helper directly.

*Call graph*: calls 1 internal fn (start_thread_with_options_and_fork_source); called by 1 (start_thread_with_tools).


##### `ThreadManager::start_thread_with_options_and_fork_source`  (lines 619–649)

```
async fn start_thread_with_options_and_fork_source(
        &self,
        options: StartThreadOptions,
        forked_from_thread_id: Option<ThreadId>,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a thread while optionally recording which existing thread it was forked from.

**Data flow**: It receives start options and an optional source thread ID, resolves session and thread source labels from explicit options or resumed history, and calls the shared spawn path.

**Call relations**: Normal option-based starts call it without a fork source. `spawn_subagent` calls it with the source thread ID after preparing forked history.

*Call graph*: calls 1 internal fn (agent_control); called by 2 (spawn_subagent, start_thread_with_options); 2 external calls (clone, pin).


##### `ThreadManager::spawn_subagent`  (lines 653–686)

```
async fn spawn_subagent(
        &self,
        forked_from_thread_id: ThreadId,
        mut options: StartThreadOptions,
    ) -> CodexResult<NewThread>
```

**Purpose**: Creates a subagent by copying a safe snapshot of another live thread’s saved history.

**Data flow**: It receives the source thread ID and start options, flushes the source thread’s rollout history to storage, reads that stored history, converts it to initial history, marks mid-turn history as interrupted, and starts the new thread as forked from the source.

**Call relations**: This method uses `get_thread`, `stored_thread_to_initial_history`, `fork_history_from_snapshot`, and the fork-aware start helper to turn a live parent thread into a child subagent.

*Call graph*: calls 5 internal fn (from_config_and_version, get_thread, start_thread_with_options_and_fork_source, fork_history_from_snapshot, stored_thread_to_initial_history).


##### `ThreadManager::resume_thread_from_rollout`  (lines 688–703)

```
async fn resume_thread_from_rollout(
        &self,
        config: Config,
        rollout_path: PathBuf,
        auth_manager: Arc<AuthManager>,
        parent_trace: Option<W3cTraceContext>,
    )
```

**Purpose**: Reopens a thread from a saved rollout file path. A rollout is the persisted event/history record of a thread.

**Data flow**: It receives config, a rollout path, authentication, and optional trace context. It loads initial history from the rollout path, then delegates to `resume_thread_with_history`.

**Call relations**: Conversation-resume code calls this when it only has a file path. The actual spawn logic happens in the history-based resume method.

*Call graph*: calls 2 internal fn (initial_history_from_rollout_path, resume_thread_with_history); called by 1 (resume_conversation); 1 external calls (pin).


##### `ThreadManager::resume_thread_with_history`  (lines 706–739)

```
async fn resume_thread_with_history(
        &self,
        config: Config,
        initial_history: InitialHistory,
        auth_manager: Arc<AuthManager>,
        parent_trace: Option<W3cTraceContex
```

**Purpose**: Reopens a thread from already-loaded history.

**Data flow**: It receives config, initial history, authentication, and trace context. It computes default environments, derives source labels from the history when present, and calls the shared spawn path.

**Call relations**: `resume_thread_from_rollout` calls this after reading storage. It eventually reaches `ThreadManagerState::spawn_thread_with_source`.

*Call graph*: calls 3 internal fn (default_thread_environment_selections, agent_control, get_resumed_session_sources); called by 1 (resume_thread_from_rollout); 3 external calls (pin, new, default).


##### `ThreadManager::start_thread_with_user_shell_override_for_tests`  (lines 741–766)

```
async fn start_thread_with_user_shell_override_for_tests(
        &self,
        config: Config,
        user_shell_override: crate::shell::Shell,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a new test thread while forcing a specific user shell.

**Data flow**: It receives config and a shell override, computes default environments, and calls the shared spawn path with the override included.

**Call relations**: Test support calls this to make shell-dependent behavior predictable.

*Call graph*: calls 2 internal fn (default_thread_environment_selections, agent_control); called by 1 (start_thread_with_user_shell_override); 4 external calls (clone, pin, new, default).


##### `ThreadManager::resume_thread_from_rollout_with_user_shell_override_for_tests`  (lines 768–802)

```
async fn resume_thread_from_rollout_with_user_shell_override_for_tests(
        &self,
        config: Config,
        rollout_path: PathBuf,
        auth_manager: Arc<AuthManager>,
        user_shell
```

**Purpose**: Resumes a saved rollout in tests while forcing a specific user shell.

**Data flow**: It loads initial history from the rollout path, computes environments, resolves resumed source labels, and calls the shared spawn path with the shell override.

**Call relations**: Test support uses this when it needs resume behavior plus controlled shell behavior.

*Call graph*: calls 3 internal fn (default_thread_environment_selections, agent_control, initial_history_from_rollout_path); called by 1 (resume_thread_from_rollout_with_user_shell_override); 3 external calls (pin, new, default).


##### `ThreadManager::remove_thread`  (lines 807–809)

```
async fn remove_thread(&self, thread_id: &ThreadId) -> Option<Arc<CodexThread>>
```

**Purpose**: Stops tracking a loaded thread in the manager’s in-memory map.

**Data flow**: It receives a thread ID reference, removes that entry from the map if present, and returns the shared thread object if one was removed.

**Call relations**: Callers use this when ownership or lifecycle control moves elsewhere. Other references to the same thread may still exist because threads are shared pointers.


##### `ThreadManager::shutdown_all_threads_bounded`  (lines 814–860)

```
async fn shutdown_all_threads_bounded(&self, timeout: Duration) -> ThreadShutdownReport
```

**Purpose**: Tries to shut down every tracked thread, but only waits a caller-specified amount of time for each one.

**Data flow**: It snapshots the current thread map, starts shutdown attempts concurrently, records whether each completed, failed submission, or timed out, removes completed threads from tracking, sorts the result lists, and returns a report.

**Call relations**: Shutdown or cleanup code calls this to close live sessions without hanging forever on a stuck thread.

*Call graph*: 1 external calls (default).


##### `ThreadManager::fork_thread`  (lines 866–881)

```
async fn fork_thread(
        &self,
        snapshot: S,
        config: Config,
        path: PathBuf,
        thread_source: Option<ThreadSource>,
        parent_trace: Option<W3cTraceContext>,
```

**Purpose**: Creates a new thread by reading saved history from a rollout path and applying a requested snapshot rule.

**Data flow**: It receives a snapshot choice, config, path, optional thread source, and trace context. It loads initial history from the path, then delegates to `fork_thread_from_history`.

**Call relations**: Public fork APIs call this when they know the rollout path rather than already having the history in memory.

*Call graph*: calls 2 internal fn (fork_thread_from_history, initial_history_from_rollout_path); called by 1 (fork_thread); 1 external calls (into).


##### `ThreadManager::initial_history_from_rollout_path`  (lines 883–899)

```
async fn initial_history_from_rollout_path(
        &self,
        rollout_path: PathBuf,
    ) -> CodexResult<InitialHistory>
```

**Purpose**: Loads saved thread history from storage using a rollout path and turns it into resume-ready initial history.

**Data flow**: It receives a path, asks the thread store for the matching stored thread including history, maps storage errors into Codex errors, and converts the stored thread to `InitialHistory`.

**Call relations**: Resume and fork methods call this before spawning a runtime from saved data.

*Call graph*: calls 1 internal fn (stored_thread_to_initial_history); called by 3 (fork_thread, resume_thread_from_rollout, resume_thread_from_rollout_with_user_shell_override_for_tests); 1 external calls (clone).


##### `ThreadManager::fork_thread_from_history`  (lines 902–921)

```
async fn fork_thread_from_history(
        &self,
        snapshot: S,
        config: Config,
        history: InitialHistory,
        thread_source: Option<ThreadSource>,
        parent_trace: Optio
```

**Purpose**: Creates a fork from history that the caller has already loaded.

**Data flow**: It receives a snapshot rule, config, initial history, optional source label, and trace context. It converts the snapshot input and delegates to the internal fork helper.

**Call relations**: `fork_thread` calls this after loading history from storage. Other callers can use it to avoid reading storage twice.

*Call graph*: calls 1 internal fn (fork_thread_with_initial_history); called by 1 (fork_thread); 1 external calls (into).


##### `ThreadManager::fork_thread_with_initial_history`  (lines 923–971)

```
async fn fork_thread_with_initial_history(
        &self,
        snapshot: ForkSnapshot,
        config: Config,
        history: InitialHistory,
        thread_source: Option<ThreadSource>,
```

**Purpose**: Applies the detailed fork rules to initial history, then starts the forked thread.

**Data flow**: It determines the source thread ID when possible, computes the multi-agent version to inherit or use, builds an interrupted marker if needed, rewrites history according to the snapshot mode, computes environments, and calls the shared spawn path.

**Call relations**: `fork_thread_from_history` leads here. This is where history-fork helpers connect to live thread creation.

*Call graph*: calls 5 internal fn (default_thread_environment_selections, from_config_and_version, agent_control, fork_history_from_snapshot, forked_from_id); called by 1 (fork_thread_from_history); 4 external calls (clone, pin, new, default).


##### `ThreadManager::agent_control`  (lines 973–975)

```
fn agent_control(&self) -> AgentControl
```

**Purpose**: Creates an `AgentControl` handle that can talk back to this manager’s shared state without owning it strongly.

**Data flow**: It downgrades the shared state pointer to a weak reference and wraps it in `AgentControl`.

**Call relations**: Thread spawning and subtree listing call this so agents can request manager actions without creating ownership cycles.

*Call graph*: calls 1 internal fn (new); called by 6 (fork_thread_with_initial_history, list_agent_subtree_thread_ids, resume_thread_from_rollout_with_user_shell_override_for_tests, resume_thread_with_history, start_thread_with_options_and_fork_source, start_thread_with_user_shell_override_for_tests); 1 external calls (downgrade).


##### `ThreadManager::captured_ops`  (lines 978–984)

```
fn captured_ops(&self) -> Vec<(ThreadId, Op)>
```

**Purpose**: Returns the operations captured in test mode.

**Data flow**: It checks whether an operation log exists, locks it if possible, clones its contents, and returns the copied list. If no log exists, it returns an empty list.

**Call relations**: Tests use this to verify what operations were submitted through the manager.


##### `ThreadManagerState::state_db`  (lines 988–990)

```
fn state_db(&self) -> Option<StateDbHandle>
```

**Purpose**: Returns the optional state database handle.

**Data flow**: It clones the optional database handle and returns it.

**Call relations**: Subtree-listing code uses this to look up persisted spawn relationships when a state database is available.


##### `ThreadManagerState::list_thread_ids`  (lines 992–1001)

```
async fn list_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Lists IDs for currently loaded, non-internal threads.

**Data flow**: It reads the live thread map, filters out internal session sources, collects the remaining IDs, and returns them.

**Call relations**: `ThreadManager::list_thread_ids` delegates here.


##### `ThreadManagerState::list_live_thread_spawn_edges`  (lines 1004–1022)

```
async fn list_live_thread_spawn_edges(&self) -> Vec<(ThreadId, ThreadId)>
```

**Purpose**: Lists parent-child relationships for currently loaded thread-spawn subagents.

**Data flow**: It reads the live thread map, skips internal sessions, finds subagent entries that record a parent thread ID, and returns pairs of parent and child IDs.

**Call relations**: Agent-control flows can use this to understand the live part of the agent tree.


##### `ThreadManagerState::get_thread`  (lines 1025–1031)

```
async fn get_thread(&self, thread_id: ThreadId) -> CodexResult<Arc<CodexThread>>
```

**Purpose**: Fetches a user-visible live thread by ID or reports that it was not found.

**Data flow**: It reads the live thread map, checks whether the matching thread exists and is not internal, then returns a shared pointer or a not-found error.

**Call relations**: Operation sending, instruction inheritance, version inheritance, and rollout-trace lookup call this before using a live thread.

*Call graph*: called by 4 (initial_multi_agent_version_for_spawn, parent_rollout_thread_trace_for_source, send_op, user_instructions_for_spawn); 1 external calls (ThreadNotFound).


##### `ThreadManagerState::read_stored_thread`  (lines 1033–1056)

```
async fn read_stored_thread(
        &self,
        params: ReadThreadParams,
    ) -> CodexResult<StoredThread>
```

**Purpose**: Reads a thread from persistent storage and translates storage-layer errors into higher-level Codex errors.

**Data flow**: It receives read parameters, calls the configured thread store, and returns the stored thread or a clearer not-found, invalid-request, or fatal error.

**Call relations**: Manager-adjacent code can use this when it needs cold stored thread data through the same error conventions as live manager operations.


##### `ThreadManagerState::send_op`  (lines 1059–1067)

```
async fn send_op(&self, thread_id: ThreadId, op: Op) -> CodexResult<String>
```

**Purpose**: Sends an operation to a live thread. An operation is a command-like message such as submitting input or asking the thread to stop.

**Data flow**: It receives a thread ID and operation, looks up the thread, optionally records the operation in the test log, submits it to the thread, and returns the submit ID or an error.

**Call relations**: Agent-control and other manager users call this when they need to drive a specific live thread.

*Call graph*: calls 1 internal fn (get_thread); 1 external calls (clone).


##### `ThreadManagerState::remove_thread`  (lines 1070–1072)

```
async fn remove_thread(&self, thread_id: &ThreadId) -> Option<Arc<CodexThread>>
```

**Purpose**: Removes a thread from the live thread map by ID.

**Data flow**: It receives a thread ID reference, takes a write lock on the map, removes the entry if present, and returns it.

**Call relations**: Internal lifecycle code can call this when a thread should no longer be tracked.


##### `ThreadManagerState::effective_multi_agent_version_for_spawn`  (lines 1074–1090)

```
async fn effective_multi_agent_version_for_spawn(
        &self,
        initial_history: &InitialHistory,
        session_source: Option<&SessionSource>,
        parent_thread_id: Option<ThreadId>,
```

**Purpose**: Chooses the multi-agent protocol version for a new spawn, falling back to the config if no history or parent provides one.

**Data flow**: It asks `initial_multi_agent_version_for_spawn` for an inherited or history-derived version. If none is found, it reads the version implied by feature flags in config.

**Call relations**: Fork setup uses this when it must create the right interrupted-history marker before the thread is actually spawned.

*Call graph*: calls 1 internal fn (initial_multi_agent_version_for_spawn).


##### `ThreadManagerState::initial_multi_agent_version_for_spawn`  (lines 1092–1118)

```
async fn initial_multi_agent_version_for_spawn(
        &self,
        initial_history: &InitialHistory,
        session_source: Option<&SessionSource>,
        parent_thread_id: Option<ThreadId>,
```

**Purpose**: Finds the multi-agent version that should be inherited from history, a parent thread, or a fork source.

**Data flow**: It inspects the session source and initial history to choose a likely inherited thread ID, looks up that live thread when needed, and asks the resolver to combine history and inherited values.

**Call relations**: The main spawn path and the effective-version wrapper call this so child, resumed, and forked threads stay compatible with their lineage.

*Call graph*: calls 2 internal fn (resolve_multi_agent_version, get_thread); called by 2 (effective_multi_agent_version_for_spawn, spawn_thread_with_source).


##### `ThreadManagerState::user_instructions_for_spawn`  (lines 1135–1168)

```
async fn user_instructions_for_spawn(
        &self,
        session_source: &SessionSource,
        parent_thread_id: Option<ThreadId>,
        forked_from_thread_id: Option<ThreadId>,
    ) -> Loade
```

**Purpose**: Loads or inherits user instructions for a new thread. User instructions are extra guidance supplied outside the immediate prompt.

**Data flow**: For root agents, it asks the provider to load fresh instructions and warnings. For non-root agents, it tries to inherit instructions from the parent or fork source live thread and returns no warnings if inheritance fails.

**Call relations**: `spawn_thread_with_source` calls this before creating the Codex runtime so each thread starts with the right instruction context.

*Call graph*: calls 1 internal fn (get_thread); called by 1 (spawn_thread_with_source); 2 external calls (new, is_non_root_agent).


##### `ThreadManagerState::spawn_new_thread`  (lines 1171–1189)

```
async fn spawn_new_thread(
        &self,
        config: Config,
        agent_control: AgentControl,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a brand-new thread from config using this state’s default session source.

**Data flow**: It receives config and an agent-control handle, fills in default source and empty lineage fields, and delegates to `spawn_new_thread_with_source`.

**Call relations**: Internal agent-control paths can call this as the simplest state-level way to create a fresh thread.

*Call graph*: calls 1 internal fn (spawn_new_thread_with_source); 2 external calls (pin, clone).


##### `ThreadManagerState::spawn_new_thread_with_source`  (lines 1192–1227)

```
async fn spawn_new_thread_with_source(
        &self,
        config: Config,
        agent_control: AgentControl,
        session_source: SessionSource,
        parent_thread_id: Option<ThreadId>,
```

**Purpose**: Starts a brand-new thread while allowing the caller to specify source, parent, fork, metrics, and inherited runtime details.

**Data flow**: It receives config and spawn context, computes default environments if none were supplied, sets initial history to new, and delegates to `spawn_thread_with_source`.

**Call relations**: `spawn_new_thread` calls this wrapper. It prepares a new-history spawn before the common spawn machinery.

*Call graph*: calls 1 internal fn (spawn_thread_with_source); called by 1 (spawn_new_thread); 4 external calls (clone, pin, new, default).


##### `ThreadManagerState::resume_thread_with_history_with_source`  (lines 1229–1264)

```
async fn resume_thread_with_history_with_source(
        &self,
        options: ResumeThreadWithHistoryOptions,
    ) -> CodexResult<NewThread>
```

**Purpose**: Resumes a thread from supplied history while preserving a caller-specified session source and inherited runtime details.

**Data flow**: It unpacks the options, computes default environments, extracts any thread-source information from the history, and delegates to the common spawn path.

**Call relations**: Agent-control or internal resume flows use this when resuming is tied to a parent or inherited environment policy.

*Call graph*: calls 2 internal fn (default_thread_environment_selections, spawn_thread_with_source); 4 external calls (clone, pin, new, default).


##### `ThreadManagerState::fork_thread_with_source`  (lines 1267–1302)

```
async fn fork_thread_with_source(
        &self,
        config: Config,
        initial_history: InitialHistory,
        agent_control: AgentControl,
        session_source: SessionSource,
        th
```

**Purpose**: Spawns a forked thread using caller-provided history and source information.

**Data flow**: It receives config, history, lineage IDs, optional inherited environment and execution policy, computes environments if needed, and delegates to the common spawn path.

**Call relations**: Internal fork flows use this to reach the same spawn code used by normal starts and resumes.

*Call graph*: calls 1 internal fn (spawn_thread_with_source); 4 external calls (clone, pin, new, default).


##### `ThreadManagerState::spawn_thread`  (lines 1306–1341)

```
async fn spawn_thread(
        &self,
        config: Config,
        initial_history: InitialHistory,
        auth_manager: Arc<AuthManager>,
        agent_control: AgentControl,
        parent_threa
```

**Purpose**: Spawns a thread using this state’s default session source.

**Data flow**: It receives config, history, authentication, agent control, lineage, tools, metrics, trace, environments, extension data, and optional shell override, then forwards everything to the source-aware spawn method.

**Call relations**: Higher-level manager methods call this when they do not need to override the session source.

*Call graph*: calls 1 internal fn (spawn_thread_with_source); 2 external calls (pin, clone).


##### `ThreadManagerState::spawn_thread_with_source`  (lines 1344–1441)

```
async fn spawn_thread_with_source(
        &self,
        config: Config,
        initial_history: InitialHistory,
        auth_manager: Arc<AuthManager>,
        agent_control: AgentControl,
```

**Purpose**: Creates or reuses a running Codex runtime and registers it as a managed thread. This is the central spawn path in the file.

**Data flow**: It receives the full spawn context. If resuming a thread that is already running with the same rollout path, it returns that live thread. Otherwise it gathers user instructions, trace context, and multi-agent version, calls `Codex::spawn`, then finalizes and stores the new thread.

**Call relations**: All start, resume, fork, and state-level spawn wrappers eventually call this. It hands the newly spawned runtime to `finalize_thread_spawn`.

*Call graph*: calls 5 internal fn (spawn, finalize_thread_spawn, initial_multi_agent_version_for_spawn, parent_rollout_thread_trace_for_source, user_instructions_for_spawn); called by 4 (fork_thread_with_source, resume_thread_with_history_with_source, spawn_new_thread_with_source, spawn_thread); 6 external calls (clone, pin, clone, format!, matches!, InvalidRequest).


##### `ThreadManagerState::finalize_thread_spawn`  (lines 1443–1484)

```
async fn finalize_thread_spawn(
        &self,
        codex: Codex,
        thread_id: ThreadId,
        session_source: SessionSource,
    ) -> CodexResult<NewThread>
```

**Purpose**: Turns a freshly spawned Codex runtime into a registered `CodexThread`, but only if its first event is the required session-configuration event.

**Data flow**: It receives the runtime, thread ID, and session source, reads the next event, verifies it is `SessionConfigured` with the initial submit ID, inserts the new thread into the map if the ID is vacant, and returns `NewThread`. If the ID is already in use, it shuts down the duplicate runtime and returns an error.

**Call relations**: `spawn_thread_with_source` calls this immediately after `Codex::spawn`. It is the final gate before a thread becomes visible to the manager.

*Call graph*: calls 3 internal fn (new, next_event, shutdown_and_wait); called by 1 (spawn_thread_with_source); 4 external calls (new, format!, InvalidRequest, warn!).


##### `ThreadManagerState::notify_thread_created`  (lines 1486–1488)

```
fn notify_thread_created(&self, thread_id: ThreadId)
```

**Purpose**: Broadcasts that a thread was created.

**Data flow**: It receives a thread ID, sends it on the broadcast channel, and ignores the error that happens when no one is listening.

**Call relations**: Code that completes thread creation can call this; listeners created by `ThreadManager::subscribe_thread_created` receive the ID.

*Call graph*: 1 external calls (send).


##### `ThreadManagerState::parent_rollout_thread_trace_for_source`  (lines 1490–1518)

```
async fn parent_rollout_thread_trace_for_source(
        &self,
        session_source: &SessionSource,
        initial_history: &InitialHistory,
    ) -> codex_rollout_trace::ThreadTraceContext
```

**Purpose**: Finds rollout tracing context from a parent thread for fresh thread-spawn subagents. Tracing context helps connect saved events into one replayable tree.

**Data flow**: It examines the session source and initial history. If this is not a fresh thread-spawn subagent, it returns disabled tracing. Otherwise it looks up the parent thread and returns its trace context, or disabled tracing if the parent is unavailable.

**Call relations**: `spawn_thread_with_source` calls this before spawning so child threads can write rollout trace data linked to their parent when appropriate.

*Call graph*: calls 2 internal fn (get_thread, disabled); called by 1 (spawn_thread_with_source); 1 external calls (matches!).


##### `stored_thread_to_initial_history`  (lines 1521–1536)

```
fn stored_thread_to_initial_history(
    stored_thread: StoredThread,
    rollout_path: Option<PathBuf>,
) -> CodexResult<InitialHistory>
```

**Purpose**: Converts a stored thread record into initial history suitable for resuming or forking.

**Data flow**: It receives a stored thread and optional rollout path, requires that stored history is present, and returns `InitialHistory::Resumed` with the thread ID, rollout items, and best rollout path.

**Call relations**: Rollout-path loading and subagent spawning call this after reading storage.

*Call graph*: called by 2 (initial_history_from_rollout_path, spawn_subagent); 1 external calls (Resumed).


##### `thread_store_rollout_read_error`  (lines 1538–1544)

```
fn thread_store_rollout_read_error(err: ThreadStoreError) -> CodexErr
```

**Purpose**: Translates thread-store errors from rollout-path reads into Codex-level errors.

**Data flow**: It receives a storage error and maps not-found, invalid-request, and all other failures into the appropriate public error shape.

**Call relations**: `initial_history_from_rollout_path` uses this so callers see consistent errors rather than raw storage details.

*Call graph*: 4 external calls (format!, Fatal, InvalidRequest, ThreadNotFound).


##### `thread_store_metadata_update_error`  (lines 1546–1557)

```
fn thread_store_metadata_update_error(thread_id: ThreadId, err: ThreadStoreError) -> CodexErr
```

**Purpose**: Translates storage errors from metadata updates into Codex-level errors.

**Data flow**: It receives a thread ID and storage error, maps known cases such as not found, invalid request, or unsupported operation, and wraps unexpected failures as fatal errors.

**Call relations**: `ThreadManager::update_thread_metadata` uses this for both live-thread and cold-store update failures.

*Call graph*: 5 external calls (format!, Fatal, InvalidRequest, ThreadNotFound, UnsupportedOperation).


##### `truncate_before_nth_user_message`  (lines 1565–1590)

```
fn truncate_before_nth_user_message(
    history: InitialHistory,
    n: usize,
    snapshot_state: &SnapshotTurnState,
) -> InitialHistory
```

**Purpose**: Builds fork history that stops just before a chosen user message, with special care for sources that end mid-turn.

**Data flow**: It receives initial history, a user-message index, and snapshot turn state. It extracts rollout items, finds user-message positions, cuts the item list at the requested place or before the active unfinished turn, and returns either new empty history or forked history.

**Call relations**: `fork_history_from_snapshot` calls this for `TruncateBeforeNthUserMessage` snapshots.

*Call graph*: calls 1 internal fn (get_rollout_items); called by 1 (fork_history_from_snapshot); 3 external calls (Forked, truncate_rollout_before_nth_user_message_from_start, user_message_positions_in_rollout).


##### `snapshot_turn_state`  (lines 1599–1650)

```
fn snapshot_turn_state(history: &InitialHistory) -> SnapshotTurnState
```

**Purpose**: Determines whether a saved history snapshot ends in the middle of a turn and, when possible, where that active turn began.

**Data flow**: It receives initial history, feeds its rollout items into a history builder, checks active turn status and explicit turn IDs, and returns a small state record describing whether the snapshot is mid-turn.

**Call relations**: `fork_history_from_snapshot` calls this before deciding whether to cut history or add an interrupted boundary.

*Call graph*: calls 2 internal fn (new, get_rollout_items); called by 1 (fork_history_from_snapshot); 1 external calls (user_message_positions_in_rollout).


##### `fork_history_from_snapshot`  (lines 1652–1680)

```
fn fork_history_from_snapshot(
    snapshot: ForkSnapshot,
    history: InitialHistory,
    interrupted_marker: InterruptedTurnHistoryMarker,
) -> InitialHistory
```

**Purpose**: Rewrites initial history according to the requested fork snapshot mode.

**Data flow**: It receives a snapshot mode, history, and interrupted marker. It first analyzes whether the history ends mid-turn. For truncation snapshots it cuts before a user message; for interrupted snapshots it converts resumed history to forked history and appends an interrupt boundary only when needed.

**Call relations**: Fork creation and subagent spawning call this so new threads start from a coherent copy of previous history.

*Call graph*: calls 3 internal fn (append_interrupted_boundary, snapshot_turn_state, truncate_before_nth_user_message); called by 2 (fork_thread_with_initial_history, spawn_subagent); 1 external calls (Forked).


##### `append_interrupted_boundary`  (lines 1685–1721)

```
fn append_interrupted_boundary(
    history: InitialHistory,
    turn_id: Option<String>,
    interrupted_marker: InterruptedTurnHistoryMarker,
) -> InitialHistory
```

**Purpose**: Adds the same saved “turn aborted because interrupted” boundary that the live interrupt path would write.

**Data flow**: It receives history, an optional turn ID, and marker settings. It optionally appends a response marker, appends a `TurnAborted` event, converts the result to forked history, and returns it.

**Call relations**: `fork_history_from_snapshot` calls this only after `snapshot_turn_state` has found that the source snapshot ends mid-turn.

*Call graph*: calls 1 internal fn (interrupted_turn_history_marker); called by 1 (fork_history_from_snapshot); 6 external calls (new, TurnAborted, Forked, push, EventMsg, ResponseItem).


### `core/src/environment_selection.rs`

`domain_logic` · `thread setup and environment updates`

A conversation thread may be able to run commands in more than one place. For example, it might use the user’s local computer, a remote sandbox, or both. This file is the small “switchboard” that keeps track of those choices for a thread.

The main type, `ThreadEnvironments`, stores the environment manager, the local shell, and the latest resolved snapshot. A snapshot is just the current list of usable turn environments. When new selections arrive, the file starts an asynchronous task to resolve them. “Asynchronous” means the work can continue in the background while the rest of the program keeps running. This matters because remote environments may need network calls before they are ready.

The resolver removes duplicate environment IDs, keeps the first selection as the primary one, reuses already-resolved environments when the ID and working directory have not changed, and skips selections it cannot resolve. For remote environments, it asks the remote side what shell to use. For local environments, it uses the configured local shell. It also starts building a shell snapshot, which is a saved view of shell state for later command execution.

The companion type, `TurnEnvironmentSnapshot`, offers convenient ways to ask questions like “what is the primary environment?”, “is there exactly one local environment?”, or “what filesystem should plugin warmup use?”

#### Function details

##### `default_thread_environment_selections`  (lines 20–32)

```
fn default_thread_environment_selections(
    environment_manager: &EnvironmentManager,
    cwd: &AbsolutePathBuf,
) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Builds the default list of environment choices for a thread. It asks the environment manager which environment IDs should be used by default, then pairs each one with the current working directory.

**Data flow**: It receives an environment manager and a current directory. It reads the manager’s default environment IDs, converts the directory into a URI-style path, and returns a list of turn environment selections. It does not change the manager or the filesystem.

**Call relations**: Thread creation and resume paths call this when they need a sensible starting set of environments before a turn begins. It relies on the environment manager’s `default_environment_ids` answer, then hands the resulting selections to later resolution code.

*Call graph*: calls 1 internal fn (default_environment_ids); called by 7 (default_environment_selections, fork_thread_with_initial_history, resume_thread_from_rollout_with_user_shell_override_for_tests, resume_thread_with_history, start_thread_with_tools, start_thread_with_user_shell_override_for_tests, resume_thread_with_history_with_source).


##### `ThreadEnvironments::new`  (lines 44–56)

```
fn new(
        environment_manager: Arc<EnvironmentManager>,
        local_shell: Shell,
        shell_snapshot: ShellSnapshot,
        current: TurnEnvironmentSnapshot,
    ) -> Self
```

**Purpose**: Creates the per-thread holder for environment state. It starts with an already-known snapshot, so callers can immediately ask for the current environments even before any update happens.

**Data flow**: It receives the shared environment manager, the local shell, a shell snapshot builder, and the current snapshot. It stores those pieces and wraps the current snapshot in a ready-made background task. The result is a `ThreadEnvironments` object ready to accept selection updates.

**Call relations**: Session setup code and tests call this to create the thread’s environment switchboard. Later, `update_selections` replaces the stored snapshot task when the requested environments change.

*Call graph*: called by 7 (latest_environment_update_wins_while_previous_resolution_is_pending, local_environment_uses_configured_shell, resolve_turn_environments, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resolved_environments_for_configuration); 2 external calls (from_pointee, ready).


##### `ThreadEnvironments::update_selections`  (lines 58–83)

```
fn update_selections(&self, environments: &[TurnEnvironmentSelection])
```

**Purpose**: Starts resolving a new list of selected environments in the background. This lets the thread change from one set of execution places to another without blocking the caller while remote information is fetched.

**Data flow**: It reads the most recent completed snapshot if one is available, clones the manager, local shell, and snapshot builder, and copies the requested selections. It creates a background task that resolves those selections into a new snapshot, stores that task as the latest one, and spawns the work. The visible state changes because future calls to `snapshot` will wait for this newly stored task.

**Call relations**: Callers use this after they receive or compute new environment selections. It hands the real resolving work to `ThreadEnvironments::resolve_snapshot`. Because it stores the new task before the spawned work finishes, the latest update wins if an older remote resolution is still pending.

*Call graph*: 9 external calls (clone, new, load, store, resolve_snapshot, clone, clone, to_vec, spawn).


##### `ThreadEnvironments::resolve_snapshot`  (lines 85–124)

```
async fn resolve_snapshot(
        environment_manager: Arc<EnvironmentManager>,
        local_shell: Shell,
        shell_snapshot: ShellSnapshot,
        current: TurnEnvironmentSnapshot,
        en
```

**Purpose**: Turns a list of requested environment selections into a clean snapshot of usable turn environments. It removes duplicate environment IDs, reuses existing resolved environments when possible, and skips entries that cannot be resolved.

**Data flow**: It receives the manager, local shell, shell snapshot builder, the current snapshot, and the new selections. For each selection, it checks whether that environment ID has already appeared; if so, it ignores the later duplicate. If the current snapshot already contains the same environment ID and working directory, it reuses that environment. Otherwise it calls `resolve_selection`. It returns a new `TurnEnvironmentSnapshot` containing only successfully resolved environments.

**Call relations**: `update_selections` launches this as the background resolver. When it needs to create a fresh environment, it delegates to `ThreadEnvironments::resolve_selection`; when that fails, it logs a warning and continues with the remaining selections.

*Call graph*: 4 external calls (with_capacity, resolve_selection, with_capacity, warn!).


##### `ThreadEnvironments::resolve_selection`  (lines 126–171)

```
async fn resolve_selection(
        environment_manager: &EnvironmentManager,
        local_shell: &Shell,
        shell_snapshot: &ShellSnapshot,
        selected_environment: &TurnEnvironmentSelecti
```

**Purpose**: Resolves one selected environment into a `TurnEnvironment`, which is the ready-to-use form used during a conversation turn. It finds the environment, chooses the right shell, and starts preparing a shell snapshot for it.

**Data flow**: It receives the environment manager, local shell, shell snapshot builder, and one selection. It looks up the selected environment ID. If the environment is remote, it asks that environment for shell information and converts it into the project’s `Shell` type; if the environment is local, it clones the configured local shell. It creates a `TurnEnvironment`, starts a background task to build its shell snapshot, stores that task on the environment, and returns the completed turn environment or an error.

**Call relations**: `resolve_snapshot` calls this whenever it cannot reuse an existing resolved environment. It talks to `EnvironmentManager::get_environment`, may call remote environment info APIs, creates the `TurnEnvironment`, and starts the shell snapshot builder so later command execution can use that prepared shell state.

*Call graph*: calls 3 internal fn (new, from_environment_shell_info, get_environment); 4 external calls (clone, clone, spawn, warn!).


##### `ThreadEnvironments::snapshot`  (lines 173–175)

```
async fn snapshot(&self) -> TurnEnvironmentSnapshot
```

**Purpose**: Returns the latest resolved environment snapshot, waiting if the latest update is still being prepared. This gives callers a simple way to ask, “what environments should this turn use now?”

**Data flow**: It reads the currently stored shared snapshot task and awaits its result. The output is a `TurnEnvironmentSnapshot`. It does not start new work or change the stored selection.

**Call relations**: Code that needs to execute a turn calls this after selections have been updated. It depends on whatever task was most recently stored by `new` or `update_selections`.

*Call graph*: 1 external calls (load_full).


##### `ThreadEnvironments::environment_manager`  (lines 177–179)

```
fn environment_manager(&self) -> Arc<EnvironmentManager>
```

**Purpose**: Returns a shared reference to the environment manager kept by this thread. Callers use it when they need the same environment registry that the thread uses.

**Data flow**: It reads the stored shared manager and clones the shared pointer. The returned value points to the same manager; no environment data is copied or changed.

**Call relations**: This is a small accessor for other parts of the session flow that need to reach the environment manager through `ThreadEnvironments`.

*Call graph*: 1 external calls (clone).


##### `TurnEnvironmentSnapshot::primary`  (lines 188–190)

```
fn primary(&self) -> Option<&TurnEnvironment>
```

**Purpose**: Returns the first environment in the snapshot, if there is one. The first environment is treated as the primary place for actions that need a main execution target.

**Data flow**: It reads the snapshot’s environment list and returns a reference to the first item, or nothing if the list is empty. It does not change the snapshot.

**Call relations**: Other helper methods, such as `primary_environment` and `primary_filesystem`, build on this. The ordering is set earlier by `resolve_snapshot`, which preserves the first non-duplicate selection as primary.

*Call graph*: called by 2 (primary_environment, primary_filesystem).


##### `TurnEnvironmentSnapshot::local`  (lines 192–196)

```
fn local(&self) -> Option<&TurnEnvironment>
```

**Purpose**: Finds the first local environment in the snapshot. This is useful when a caller specifically needs something running on the user’s machine rather than a remote executor.

**Data flow**: It scans the snapshot’s environment list and checks each environment to see whether it is not remote. It returns a reference to the first local match, or nothing if all environments are remote or the list is empty.

**Call relations**: This helper is available to code that needs local-environment behavior. It depends on each environment’s `is_remote` answer to separate local from remote.


##### `TurnEnvironmentSnapshot::primary_environment`  (lines 199–202)

```
fn primary_environment(&self) -> Option<Arc<codex_exec_server::Environment>>
```

**Purpose**: In tests, returns the underlying environment object for the primary turn environment. It lets tests compare or inspect the actual shared environment behind the wrapper.

**Data flow**: It asks `primary` for the first turn environment. If one exists, it clones the shared pointer to that environment and returns it. The environment itself is not duplicated or changed.

**Call relations**: This test-only helper builds directly on `TurnEnvironmentSnapshot::primary`. It exists to make assertions about the primary environment easier.

*Call graph*: calls 1 internal fn (primary).


##### `TurnEnvironmentSnapshot::to_selections`  (lines 204–209)

```
fn to_selections(&self) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Converts the resolved snapshot back into the simple selection form. This is useful for comparing, storing, or reporting what environments the snapshot represents.

**Data flow**: It reads each `TurnEnvironment` in the snapshot and asks it for its selection form. It returns a list of `TurnEnvironmentSelection` values in the same order as the snapshot.

**Call relations**: Tests use this to check that resolution kept or skipped the expected selections. It also acts as the reverse of the selection-to-snapshot flow performed by `resolve_snapshot`.


##### `TurnEnvironmentSnapshot::primary_filesystem`  (lines 211–214)

```
fn primary_filesystem(&self) -> Option<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: Returns the filesystem for the primary environment, if there is one. This lets other parts of the program read files through the correct environment, whether local or remote.

**Data flow**: It asks `primary` for the first turn environment. If found, it asks that environment for its filesystem interface and returns it as a shared object. If there is no primary environment, it returns nothing.

**Call relations**: Plugin and skill warmup code calls this during session initialization so it can read from the same filesystem as the primary execution environment.

*Call graph*: calls 1 internal fn (primary); called by 1 (warm_plugins_and_skills_for_session_init).


##### `TurnEnvironmentSnapshot::single_local_environment`  (lines 216–222)

```
fn single_local_environment(&self) -> Option<&TurnEnvironment>
```

**Purpose**: Returns the environment only when the snapshot contains exactly one environment and that environment is local. This avoids guessing when there are multiple possible places to run commands.

**Data flow**: It checks the snapshot’s list. If the list has exactly one item and that item is not remote, it returns a reference to it. Otherwise it returns nothing.

**Call relations**: `single_local_environment_cwd` calls this before converting the environment’s working directory into a local filesystem path. It protects callers from accidentally treating a remote or multi-environment setup as a simple local-only setup.

*Call graph*: called by 1 (single_local_environment_cwd).


##### `TurnEnvironmentSnapshot::single_local_environment_cwd`  (lines 224–228)

```
fn single_local_environment_cwd(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the local working directory only for the simple case of exactly one local environment. It exists as a compatibility bridge for code that still expects a normal absolute path instead of a URI-style path.

**Data flow**: It first asks `single_local_environment` for a safe local-only environment. If one exists, it converts that environment’s working directory from a path URI into an absolute path and returns it if the conversion succeeds. Otherwise it returns nothing.

**Call relations**: This builds on `single_local_environment` to avoid unsafe assumptions. The comment notes that it should eventually disappear once callers can use `PathUri` directly.

*Call graph*: calls 1 internal fn (single_local_environment).


##### `tests::resolve_turn_environments`  (lines 244–257)

```
async fn resolve_turn_environments(
        environment_manager: Arc<EnvironmentManager>,
        selections: &[TurnEnvironmentSelection],
    ) -> Arc<ThreadEnvironments>
```

**Purpose**: Test helper that creates a `ThreadEnvironments`, applies selections, waits for resolution, and returns the ready object. It keeps individual tests focused on what they are checking rather than on setup steps.

**Data flow**: It receives an environment manager and a slice of selections. It creates a thread environment holder with the default user shell, disabled shell snapshots, and an empty starting snapshot. It updates the selections, waits for the snapshot to finish resolving, and returns the shared holder.

**Call relations**: Several tests call this when they need resolved environments. It uses `ThreadEnvironments::new`, then exercises the same `update_selections` and `snapshot` path used by real code.

*Call graph*: calls 3 internal fn (new, default_user_shell, disabled); 2 external calls (new, default).


##### `tests::test_runtime_paths`  (lines 259–265)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Test helper that builds runtime path information needed by test environment managers. Runtime paths tell the execution server where the current executable is and, optionally, where sandbox tools are.

**Data flow**: It reads the path of the currently running test executable and passes it into `ExecServerRuntimePaths::new` with no Linux sandbox executable. It returns the resulting runtime path object, or fails the test if the paths cannot be built.

**Call relations**: Tests that create remote-capable environment managers call this so those managers have the path information they require.

*Call graph*: calls 1 internal fn (new); 1 external calls (current_exe).


##### `tests::default_thread_environment_selections_use_manager_default_id`  (lines 268–284)

```
async fn default_thread_environment_selections_use_manager_default_id()
```

**Purpose**: Checks that default environment selections follow the environment manager’s default ID. In this setup, the manager prefers the remote environment.

**Data flow**: The test gets the current directory, converts it to a path URI, creates a test environment manager with a remote URL, and calls `default_thread_environment_selections`. It compares the result with the expected single remote selection.

**Call relations**: This test verifies the public helper `default_thread_environment_selections` and uses `test_runtime_paths` to create the manager setup.

*Call graph*: calls 3 internal fn (create_for_tests, current_dir, from_abs_path); 2 external calls (assert_eq!, test_runtime_paths).


##### `tests::toml_default_thread_environment_selections_include_local_and_remote`  (lines 287–318)

```
async fn toml_default_thread_environment_selections_include_local_and_remote()
```

**Purpose**: Checks that a configuration file can make the default selections include both local and remote environments. This protects the behavior where configured environments expand the default list.

**Data flow**: The test creates a temporary configuration directory, writes an `environments.toml` file defining a remote environment, gets the current directory as a path URI, and loads an environment manager from that config. It then checks that the default selections are local first and remote second.

**Call relations**: This test exercises `default_thread_environment_selections` through a manager loaded from configuration, using `test_runtime_paths` for required runtime path setup.

*Call graph*: calls 3 internal fn (from_codex_home, current_dir, from_abs_path); 4 external calls (assert_eq!, test_runtime_paths, write, tempdir).


##### `tests::default_thread_environment_selections_empty_when_default_disabled`  (lines 321–329)

```
async fn default_thread_environment_selections_empty_when_default_disabled()
```

**Purpose**: Checks that no default selections are produced when the environment manager has no environments enabled. This makes sure disabled defaults stay disabled.

**Data flow**: The test gets the current directory, creates an environment manager with no environments, calls `default_thread_environment_selections`, and expects an empty list.

**Call relations**: This directly verifies the empty-default branch of `default_thread_environment_selections`.

*Call graph*: calls 2 internal fn (without_environments, current_dir); 1 external calls (assert_eq!).


##### `tests::local_environment_uses_configured_shell`  (lines 332–357)

```
async fn local_environment_uses_configured_shell()
```

**Purpose**: Checks that local environments use the shell configured for the thread. This matters because local command behavior depends on using the user’s intended shell.

**Data flow**: The test creates a custom local shell, builds `ThreadEnvironments` with that shell, selects the local environment, waits for a snapshot, and inspects the primary environment’s shell. It expects the shell to match the configured one.

**Call relations**: This test goes through `ThreadEnvironments::new`, `update_selections`, and `snapshot`, and specifically confirms the local branch inside `resolve_selection`.

*Call graph*: calls 5 internal fn (new, disabled, default_for_tests, current_dir, from_abs_path); 4 external calls (new, assert_eq!, default, from).


##### `tests::resolve_environment_selections_keeps_first_duplicate_id`  (lines 360–382)

```
async fn resolve_environment_selections_keeps_first_duplicate_id()
```

**Purpose**: Checks that if the same environment ID appears more than once, the first one wins. This avoids ambiguity when two selections name the same environment with different working directories.

**Data flow**: The test creates two selections with the same local environment ID but different working directories. It resolves them and converts the snapshot back to selections. The result should contain only the first selection.

**Call relations**: This test uses `tests::resolve_turn_environments` to exercise `resolve_snapshot`, especially its duplicate-ID filtering.

*Call graph*: calls 3 internal fn (default_for_tests, current_dir, from_abs_path); 3 external calls (new, assert_eq!, resolve_turn_environments).


##### `tests::resolved_environment_selections_use_first_selection_as_primary`  (lines 385–423)

```
async fn resolved_environment_selections_use_first_selection_as_primary()
```

**Purpose**: Checks that the first resolved selection becomes the primary environment. It also confirms that the shell for that environment is resolved from environment information.

**Data flow**: The test creates a local selection with a chosen working directory, resolves it, and then inspects the snapshot. It expects the primary environment ID and shell to match the selected local environment and the manager’s shell info.

**Call relations**: This test uses `tests::resolve_turn_environments` and verifies behavior from `resolve_snapshot`, `resolve_selection`, and `TurnEnvironmentSnapshot::primary`.

*Call graph*: calls 3 internal fn (default_for_tests, current_dir, from_abs_path); 4 external calls (clone, new, assert_eq!, resolve_turn_environments).


##### `tests::unresolved_environment_selections_are_skipped`  (lines 426–448)

```
async fn unresolved_environment_selections_are_skipped()
```

**Purpose**: Checks that missing or invalid environment selections do not stop all resolution. Instead, unresolved selections are skipped and valid later selections remain available.

**Data flow**: The test asks for a missing environment first and a valid local environment second. After resolution, it converts the snapshot back to selections and expects only the valid local selection.

**Call relations**: This test exercises the error path in `resolve_selection` and the warning-and-continue behavior in `resolve_snapshot`.

*Call graph*: calls 3 internal fn (default_for_tests, current_dir, from_abs_path); 3 external calls (new, assert_eq!, resolve_turn_environments).


##### `tests::latest_environment_update_wins_while_previous_resolution_is_pending`  (lines 451–495)

```
async fn latest_environment_update_wins_while_previous_resolution_is_pending()
```

**Purpose**: Checks that a newer environment update can replace an older one that is still waiting on remote work. This prevents the thread from getting stuck behind an outdated remote selection.

**Data flow**: The test starts a fake remote listener, creates a manager with both remote and local environments, and first selects the remote environment. It waits until remote resolution has begun, then updates the selections to local only. It waits for the snapshot and expects the local selection to be the final result.

**Call relations**: This test stresses `ThreadEnvironments::update_selections`. It confirms that storing the newest snapshot task lets `snapshot` follow the latest update rather than an older pending remote resolution.

*Call graph*: calls 6 internal fn (new, default_user_shell, disabled, create_for_tests_with_local, current_dir, from_abs_path); 9 external calls (new, assert_eq!, default, test_runtime_paths, format!, from_ref, from_secs, bind, timeout).


##### `tests::matching_environment_id_and_cwd_reuse_resolved_environment`  (lines 498–549)

```
async fn matching_environment_id_and_cwd_reuse_resolved_environment()
```

**Purpose**: Checks that an already-resolved environment is reused when both its environment ID and working directory still match. It also checks that changing the working directory forces a fresh resolution.

**Data flow**: The test resolves a remote selection, then changes the manager’s remote URL. It applies the same selection again and checks that the underlying environment pointer is the same as before. Then it applies a selection with a changed working directory and checks that the underlying environment pointer is different.

**Call relations**: This test verifies the reuse shortcut inside `resolve_snapshot`. It protects the intended behavior that stable selections keep their resolved environment, while meaningful changes are re-resolved.

*Call graph*: calls 3 internal fn (create_for_tests, current_dir, from_abs_path); 6 external calls (clone, new, assert!, resolve_turn_environments, test_runtime_paths, from_ref).


##### `tests::single_local_environment_cwd_requires_exactly_one_local_environment`  (lines 552–592)

```
async fn single_local_environment_cwd_requires_exactly_one_local_environment()
```

**Purpose**: Checks that a local working directory is returned only when the snapshot contains exactly one environment and that environment is local. This prevents remote or mixed setups from being mistaken for a simple local path.

**Data flow**: The test builds three snapshots: one with only a local environment, one with only a remote environment, and one with both. It asks each for `single_local_environment_cwd`. Only the local-only snapshot should return the current directory.

**Call relations**: This test verifies `TurnEnvironmentSnapshot::single_local_environment_cwd` and, through it, `single_local_environment`.

*Call graph*: calls 4 internal fn (create_for_tests, default_for_tests, current_dir, from_abs_path); 5 external calls (clone, new, assert_eq!, resolve_turn_environments, vec!).


### `core/src/codex_thread.rs`

`orchestration` · `cross-cutting`

A Codex thread is the living conversation between a client, the model, tools, and stored session state. This file acts like the front desk for that conversation: callers do not reach into the inner session directly; they ask `CodexThread` to submit user input, wait for events, read configuration, pause for special prompts, or load saved history. That matters because a thread has many moving parts running at once, and the system needs a narrow, predictable doorway to them.

Most methods here are thin but important bridges to the deeper `Codex` and session objects. They add thread-specific guardrails, such as checking execution capacity before accepting user input, rejecting empty injected response items, or only starting automatic idle work when no user turn is waiting. The file also defines `ThreadConfigSnapshot`, a plain snapshot of the settings that shape a thread, and `TryStartTurnIfIdleError`, which explains why extension-triggered background work could not start.

A useful analogy is a train station control booth. The trains are the model turns, tool calls, and background terminals. This file does not drive every train itself, but it decides which switches callers are allowed to touch, records important state, and routes requests to the right internal track.

#### Function details

##### `TryStartTurnIfIdleError::new`  (lines 101–103)

```
fn new(reason: TryStartTurnIfIdleRejectionReason, input: Vec<ResponseItem>) -> Self
```

**Purpose**: Builds an error value for the case where automatic idle work was not allowed to start. It keeps both the reason and the original model-visible input so the caller does not lose anything.

**Data flow**: It receives a rejection reason and the response items that someone wanted to submit. It stores both inside a new error object. The result is an error that can be returned unchanged to the caller.

**Call relations**: The idle-turn path uses this when it decides a thread is not eligible for automatic work. Later, callers can inspect the returned object to decide whether to retry, log, or discard the original input.

*Call graph*: called by 1 (try_start_turn_if_idle).


##### `TryStartTurnIfIdleError::reason`  (lines 106–108)

```
fn reason(&self) -> TryStartTurnIfIdleRejectionReason
```

**Purpose**: Returns the stable reason why an automatic idle turn was rejected. This lets callers react differently to cases like “busy” versus “plan mode.”

**Data flow**: It reads the stored reason from the error object. It does not change anything. It returns that reason to the caller.

**Call relations**: This is used after an idle-turn attempt fails, when the caller wants to understand the rejection without unpacking the whole error.


##### `TryStartTurnIfIdleError::into_input`  (lines 112–114)

```
fn into_input(self) -> Vec<ResponseItem>
```

**Purpose**: Gives back the original input that failed to start an automatic idle turn. This prevents hidden data loss when background work is rejected.

**Data flow**: It consumes the error object, takes out the saved response items, and returns them. After this, the error object itself is gone.

**Call relations**: A caller that receives this error can call this method when it wants to retry the same model-visible items later or log exactly what was not submitted.


##### `ThreadConfigSnapshot::cwd`  (lines 118–120)

```
fn cwd(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the thread’s current working directory, which is the default folder used when commands or file operations need a location. The current working directory is like the folder a terminal is “standing in.”

**Data flow**: It reads the legacy fallback current-directory field from the snapshot’s environment selections. It returns a borrowed path and does not change the snapshot.

**Call relations**: Code that rebuilds or compares thread settings calls this when it needs the thread’s directory. `ThreadConfigSnapshot::sandbox_policy` also uses it to calculate the correct sandbox behavior.

*Call graph*: called by 4 (build_thread_from_snapshot, collect_resume_override_mismatches, thread_settings_from_config_snapshot, sandbox_policy).


##### `ThreadConfigSnapshot::environment_selections`  (lines 122–124)

```
fn environment_selections(&self) -> &[TurnEnvironmentSelection]
```

**Purpose**: Returns the list of selected environments available to the thread. These selections describe where turns may run, such as different workspaces or execution contexts.

**Data flow**: It reads the environments stored in the snapshot and returns them as a borrowed list. Nothing is copied or changed.

**Call relations**: This is a simple accessor for callers that need to inspect the environment choices already captured in a thread configuration snapshot.


##### `ThreadConfigSnapshot::sandbox_policy`  (lines 126–131)

```
fn sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Calculates the sandbox policy for this snapshot. A sandbox policy is the safety rule set that limits what code or commands may touch.

**Data flow**: It reads the snapshot’s permission profile and current working directory. It passes those to the sandbox compatibility helper, which returns the policy that should be applied. The snapshot itself is unchanged.

**Call relations**: Resume and settings-comparison code calls this when it needs to see whether sandbox-related behavior matches expectations. It depends on `ThreadConfigSnapshot::cwd` to supply the folder used in that calculation.

*Call graph*: calls 1 internal fn (cwd); called by 1 (collect_resume_override_mismatches); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `CodexThread::new`  (lines 173–186)

```
fn new(
        codex: Codex,
        session_configured: SessionConfiguredEvent,
        rollout_path: Option<PathBuf>,
        session_source: SessionSource,
    ) -> Self
```

**Purpose**: Creates a new `CodexThread` wrapper around an already-created Codex session. This gives the rest of the app a thread-shaped handle instead of exposing all inner session details.

**Data flow**: It receives the inner `Codex` object, the session configuration event, an optional rollout file path, and the session source. It stores them and starts the out-of-band elicitation counter at zero. The result is a ready-to-use `CodexThread`.

**Call relations**: Thread-spawning code calls this near the end of creating a thread. After that, other parts of the system use the returned object for submissions, events, configuration reads, and lifecycle actions.

*Call graph*: called by 1 (finalize_thread_spawn); 1 external calls (new).


##### `CodexThread::submit`  (lines 188–190)

```
async fn submit(&self, op: Op) -> CodexResult<String>
```

**Purpose**: Submits a general operation to the thread. An operation is a command-like message telling the session to do something, such as accept input or update settings.

**Data flow**: It receives an operation and forwards it to the inner `Codex` object. The inner session processes or queues it and returns a submission id or an error. This method returns that result unchanged.

**Call relations**: Many app-server and turn-running paths use this as the common doorway for sending operations into the thread. It hands the work off to `Codex::submit`.

*Call graph*: calls 1 internal fn (submit); called by 8 (submit_thread_settings, close_realtime_conversation, start_realtime_conversation, capture_from_requests, submit_user_input, submit_queue_only_agent_mail, submit_user_input, run_turn).


##### `CodexThread::session_telemetry`  (lines 193–195)

```
fn session_telemetry(&self) -> SessionTelemetry
```

**Purpose**: Returns the telemetry handle for this thread. Telemetry is production measurement data, such as timing and usage signals, used to understand system behavior.

**Data flow**: It reads the telemetry handle from the session services and clones it. The clone is returned so callers can record thread-scoped measurements.

**Call relations**: Instrumentation code can call this when it needs to attach measurements to the current thread without getting broad access to the whole session.


##### `CodexThread::shutdown_and_wait`  (lines 197–199)

```
async fn shutdown_and_wait(&self) -> CodexResult<()>
```

**Purpose**: Asks the thread to shut down and waits until that shutdown work completes. This is used for clean teardown rather than abruptly dropping a running session.

**Data flow**: It forwards the shutdown request to the inner `Codex` object. The inner object stops the session loop and returns success or an error. This method returns that result.

**Call relations**: Teardown paths call this when they are done with a thread. It hands the actual shutdown sequence to `Codex::shutdown_and_wait`.

*Call graph*: calls 1 internal fn (shutdown_and_wait).


##### `CodexThread::wait_until_terminated`  (lines 202–204)

```
async fn wait_until_terminated(&self)
```

**Purpose**: Waits until the underlying session loop has fully ended. This is useful when something else has already requested shutdown and the caller only needs to wait.

**Data flow**: It waits on the stored termination signal for the session loop. It does not send any new operation and returns nothing when the signal completes.

**Call relations**: Agent-loop code calls this while monitoring a running thread, so it can stop only after the session has truly terminated.

*Call graph*: called by 1 (loop_agent).


##### `CodexThread::emit_thread_resume_lifecycle`  (lines 206–221)

```
async fn emit_thread_resume_lifecycle(&self)
```

**Purpose**: Notifies extensions that this thread has resumed. Extensions are add-on components, and this gives them a chance to restore or update their own thread-related state.

**Data flow**: It asks the extension registry for thread lifecycle contributors. For each contributor, it passes session-level and thread-level extension data stores to `on_thread_resume`. It waits for each notification to finish.

**Call relations**: Resume orchestration uses this after a thread is brought back. The method fans the event out to all registered extension lifecycle contributors.


##### `CodexThread::emit_thread_idle_lifecycle_if_idle`  (lines 223–228)

```
async fn emit_thread_idle_lifecycle_if_idle(&self)
```

**Purpose**: Triggers idle lifecycle work only if the session is actually idle. This lets extensions run background follow-up work without interrupting active user work.

**Data flow**: It asks the session to check its idle state and emit the idle lifecycle event if allowed. It returns after the session-level logic has completed.

**Call relations**: Resume-continuation code calls this after restoring goal state, so extensions can react if the resumed thread has no active work waiting.

*Call graph*: called by 1 (emit_resume_goal_snapshot_and_continue).


##### `CodexThread::ensure_rollout_materialized`  (lines 231–233)

```
async fn ensure_rollout_materialized(&self)
```

**Purpose**: Makes sure the thread’s rollout record exists on disk or in its backing storage. A rollout is the persisted log of what happened in the session.

**Data flow**: It delegates to the session to create or materialize the rollout if needed. It does not return data.

**Call relations**: Hidden internal callers can use this before operations that assume the rollout record has been created.


##### `CodexThread::flush_rollout`  (lines 236–238)

```
async fn flush_rollout(&self) -> std::io::Result<()>
```

**Purpose**: Forces pending rollout data to be written out. This reduces the chance that recent conversation state is still only in memory.

**Data flow**: It asks the session to flush its rollout data. The result is either success or an input/output error from the write operation.

**Call relations**: Internal persistence-sensitive code can call this when it needs the rollout log to be up to date before continuing.


##### `CodexThread::submit_with_trace`  (lines 240–246)

```
async fn submit_with_trace(
        &self,
        op: Op,
        trace: Option<W3cTraceContext>,
    ) -> CodexResult<String>
```

**Purpose**: Submits an operation while carrying optional tracing information. Tracing information helps connect work across services for debugging and monitoring.

**Data flow**: It receives an operation and an optional W3C trace context, then forwards both to the inner `Codex` object. The result is the submission id or an error.

**Call relations**: Core operation submission paths use this when they want normal thread submission plus cross-service trace tracking. It hands off to `Codex::submit_with_trace`.

*Call graph*: calls 1 internal fn (submit_with_trace); called by 2 (submit_core_op, submit_core_op).


##### `CodexThread::submit_user_input_with_client_user_message_id`  (lines 248–263)

```
async fn submit_user_input_with_client_user_message_id(
        &self,
        op: Op,
        trace: Option<W3cTraceContext>,
        client_user_message_id: Option<String>,
    ) -> CodexResult<Stri
```

**Purpose**: Submits user input while preserving an optional client-provided message id. Before doing so, it checks that the agent has room to accept the operation.

**Data flow**: It receives an operation, optional trace context, and optional client message id. It first asks agent control to ensure execution capacity for this thread and operation. If allowed, it forwards the submission to the inner `Codex`; otherwise it returns the capacity error.

**Call relations**: Client-facing user-input paths use this when they need both safety checks and message-id tracking. It performs the thread-level guard, then hands off to the inner submission method.

*Call graph*: calls 1 internal fn (submit_user_input_with_client_user_message_id).


##### `CodexThread::set_thread_memory_mode`  (lines 266–268)

```
async fn set_thread_memory_mode(&self, mode: ThreadMemoryMode) -> anyhow::Result<()>
```

**Purpose**: Records whether this thread may be used for future memory generation. In plain terms, it marks whether the conversation is eligible to teach the system something later.

**Data flow**: It receives the desired memory mode and passes it to the inner `Codex` object. The result is success or an error from persisting that choice.

**Call relations**: Settings or policy flows call this when the thread’s memory eligibility changes. The actual storage update is done by the lower-level Codex session.

*Call graph*: calls 1 internal fn (set_thread_memory_mode).


##### `CodexThread::steer_input`  (lines 270–287)

```
async fn steer_input(
        &self,
        input: Vec<UserInput>,
        additional_context: BTreeMap<String, AdditionalContextEntry>,
        expected_turn_id: Option<&str>,
        client_user_me
```

**Purpose**: Adds steering input to an existing turn, meaning extra user guidance or context meant to influence ongoing model work. It can also check that the input applies to the expected turn.

**Data flow**: It receives user input, additional context, an optional expected turn id, an optional client message id, and optional client metadata. It forwards these to the inner `Codex` steering logic, which returns a result id or a steering error.

**Call relations**: The user-input steering path calls this when a client wants to nudge an active turn rather than start a completely separate one.

*Call graph*: calls 1 internal fn (steer_input); called by 1 (steer_user_input).


##### `CodexThread::inject_if_running`  (lines 294–299)

```
async fn inject_if_running(
        &self,
        items: Vec<ResponseItem>,
    ) -> Result<(), Vec<ResponseItem>>
```

**Purpose**: Injects model-visible response items into the currently active turn, but only if a turn is running. If no turn is active, it gives the items back unchanged.

**Data flow**: It receives response items and passes them to the session’s running-turn injection point. On success, the items are absorbed into the active turn. On failure, the same items are returned to the caller.

**Call relations**: Callers that only hold a `CodexThread` use this as a safe bridge into active-turn injection without receiving wider session mutation powers.


##### `CodexThread::try_start_turn_if_idle`  (lines 314–319)

```
async fn try_start_turn_if_idle(
        &self,
        items: Vec<ResponseItem>,
    ) -> Result<(), TryStartTurnIfIdleError>
```

**Purpose**: Starts automatic background model work only when the thread is idle and policy allows it. This protects user-triggered work from being overtaken by extension-triggered work.

**Data flow**: It receives model-visible response items and asks the session to start a turn only if no client turn is queued, no task is active, and the thread is not in plan mode. If accepted, the items start a new turn. If rejected, an error explains why and carries the original items back.

**Call relations**: Extensions that receive an idle lifecycle callback are expected to use this entry point. The session performs the eligibility decision, and rejection errors preserve enough information for the extension to retry or drop the work deliberately.


##### `CodexThread::set_app_server_client_info`  (lines 321–334)

```
async fn set_app_server_client_info(
        &self,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
        mcp_elicitations_auto_deny: bool,
    ) -
```

**Purpose**: Stores information about the app-server client connected to the thread, including name, version, and whether certain external prompts should be automatically denied. This lets the session adapt to client capabilities and safety choices.

**Data flow**: It receives optional client name and version plus a flag for auto-denying MCP elicitations. It forwards those values to the inner `Codex` validation and storage logic, returning success or a constraint error.

**Call relations**: App-server connection setup paths call this when a client identifies itself. The deeper Codex layer applies the actual constraints.

*Call graph*: calls 1 internal fn (set_app_server_client_info); called by 2 (set_app_server_client_info, set_app_server_client_info).


##### `CodexThread::preview_thread_settings_overrides`  (lines 337–343)

```
async fn preview_thread_settings_overrides(
        &self,
        overrides: CodexThreadSettingsOverrides,
    ) -> ConstraintResult<ThreadConfigSnapshot>
```

**Purpose**: Shows what the thread configuration would look like after applying proposed settings overrides, without actually saving them. This is a dry run for settings changes.

**Data flow**: It receives override values, converts them into a session settings update, and asks the session to preview that update. The output is either a new configuration snapshot or a constraint error.

**Call relations**: Settings-building code calls this before committing changes. It relies on `CodexThread::thread_settings_update` to translate thread-level override fields into the session’s update format.

*Call graph*: calls 1 internal fn (thread_settings_update); called by 1 (build_thread_settings_overrides).


##### `CodexThread::thread_settings_update`  (lines 345–392)

```
async fn thread_settings_update(
        &self,
        overrides: CodexThreadSettingsOverrides,
    ) -> SessionSettingsUpdate
```

**Purpose**: Converts app-server thread setting overrides into the session’s internal update shape. It also fills in collaboration mode intelligently when the caller did not provide one.

**Data flow**: It receives optional override fields such as environments, workspace roots, approval policy, sandbox policy, model, effort, service tier, and personality. If collaboration mode is missing, it reads the current mode and applies model or effort changes to it. It returns a `SessionSettingsUpdate` ready for preview or application.

**Call relations**: `CodexThread::preview_thread_settings_overrides` calls this as its translation step. It is the adapter between external override requests and the session’s configuration-update format.

*Call graph*: called by 1 (preview_thread_settings_overrides); 1 external calls (default).


##### `CodexThread::submit_with_id`  (lines 395–397)

```
async fn submit_with_id(&self, sub: Submission) -> CodexResult<()>
```

**Purpose**: Submits a pre-built submission that already has its own id. The comment notes this is temporary and should be used sparingly.

**Data flow**: It receives a complete submission object and forwards it to the inner `Codex` object. The method returns success or an error from that submission.

**Call relations**: Legacy or transitional code can call this when it must preserve an existing submission id instead of letting the normal submit path create one.

*Call graph*: calls 1 internal fn (submit_with_id).


##### `CodexThread::next_event`  (lines 399–401)

```
async fn next_event(&self) -> CodexResult<Event>
```

**Purpose**: Waits for and returns the next event produced by the thread. Events are the stream of updates a client reads to learn what the session did.

**Data flow**: It asks the inner `Codex` object for the next event. The result is either the next event or an error if the event stream cannot continue.

**Call relations**: Turn-running, settings, and waiting code call this after submitting work so they can observe progress and results from the session.

*Call graph*: calls 1 internal fn (next_event); called by 4 (submit_thread_settings, wait_for_event_with_timeout, wait_for_mcp_server, run_turn).


##### `CodexThread::agent_status`  (lines 403–405)

```
async fn agent_status(&self) -> AgentStatus
```

**Purpose**: Returns the current status of the agent for this thread, such as whether it is idle, working, or otherwise occupied.

**Data flow**: It asks the inner `Codex` object for the latest agent status and returns that value. It does not mutate the thread.

**Call relations**: Agent-loop code calls this to decide what the thread is doing right now. The actual status is maintained by the underlying Codex session.

*Call graph*: calls 1 internal fn (agent_status); called by 1 (loop_agent).


##### `CodexThread::list_background_terminals`  (lines 407–409)

```
async fn list_background_terminals(&self) -> Vec<BackgroundTerminalInfo>
```

**Purpose**: Lists background terminal processes started by the thread. A background terminal is a command that keeps running while the conversation continues.

**Data flow**: It asks the session for its current background terminal records. It returns a list containing item id, process id, command, and working directory for each one.

**Call relations**: User interface or app-server code can call this when it wants to show running background commands attached to the thread.


##### `CodexThread::terminate_background_terminal`  (lines 411–416)

```
async fn terminate_background_terminal(&self, process_id: i32) -> bool
```

**Purpose**: Attempts to stop a background terminal process by process id. This gives callers a controlled way to clean up long-running commands.

**Data flow**: It receives a process id, passes it to the session’s termination logic, and returns true if a matching terminal was stopped. It returns false if no matching process was terminated.

**Call relations**: Client-facing terminal control code can use this after listing background terminals or when the user asks to stop one.


##### `CodexThread::subscribe_status`  (lines 418–420)

```
fn subscribe_status(&self) -> watch::Receiver<AgentStatus>
```

**Purpose**: Creates a live subscription to the thread’s agent status. A subscription lets a caller be notified when the status changes instead of repeatedly asking.

**Data flow**: It clones the internal watch receiver for agent status and returns it. The thread state is not changed.

**Call relations**: Internal observers use this when they need ongoing status updates tied to the same status stream used by the Codex session.


##### `CodexThread::token_usage_info`  (lines 429–431)

```
async fn token_usage_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the complete cached token-usage snapshot for the thread. Tokens are the pieces of text the model reads and writes, and usage data is important for reporting cost and context size.

**Data flow**: It asks the session for its current token usage information. The result may be absent if no usage has been recorded yet. It does not expose broader session mutation access.

**Call relations**: Connection update code calls this when it needs to send accurate token usage, including both total and last-turn information, after resume or fork.

*Call graph*: called by 1 (send_thread_token_usage_update_to_connection).


##### `CodexThread::inject_user_message_without_turn`  (lines 434–446)

```
async fn inject_user_message_without_turn(&self, message: String)
```

**Purpose**: Records a user-role message in the session without starting a new user turn. This is used for prefix or context messages that should be visible in history but not treated as a new request boundary.

**Data flow**: It receives plain text, wraps it as a user message response item, and asks the session to inject it without creating a new turn. It returns nothing.

**Call relations**: Internal setup or resume flows can use this when they need to add user-visible context to the conversation log without triggering model work.

*Call graph*: 1 external calls (vec!).


##### `CodexThread::inject_response_items`  (lines 449–469)

```
async fn inject_response_items(&self, items: Vec<ResponseItem>) -> CodexResult<()>
```

**Purpose**: Records raw Responses API items in the thread without starting a new turn. It is a controlled way to add already-formed model/API items into the session history.

**Data flow**: It receives response items and first rejects an empty list as an invalid request. For non-empty input, it creates a default turn context, records reference context if needed, injects the items without a new turn, flushes the rollout to storage, and returns success or an error.

**Call relations**: Callers that import or replay response items use this when they need persistence and context bookkeeping but do not want to trigger fresh model execution.

*Call graph*: 1 external calls (InvalidRequest).


##### `CodexThread::rollout_path`  (lines 471–473)

```
fn rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the file path or storage path for this thread’s rollout log, if one exists. The rollout log is the saved record of the session.

**Data flow**: It clones the optional path stored on the thread and returns it. The thread is not changed.

**Call relations**: Thread-loading code calls this when it needs to reconnect a live thread to its persisted rollout location.

*Call graph*: called by 1 (build_thread_from_loaded_snapshot).


##### `CodexThread::session_configured`  (lines 475–477)

```
fn session_configured(&self) -> SessionConfiguredEvent
```

**Purpose**: Returns the session configuration event captured when the thread was set up. This event includes important identity and configuration details for the running session.

**Data flow**: It clones the stored configuration event and returns the clone. No internal state changes.

**Call relations**: Resume and loaded-snapshot flows call this when they need the already-known configured-session details for building or reporting a thread.

*Call graph*: called by 2 (load_thread_from_resume_source_or_send_internal, build_thread_from_loaded_snapshot); 1 external calls (clone).


##### `CodexThread::is_running`  (lines 479–481)

```
fn is_running(&self) -> bool
```

**Purpose**: Reports whether the thread’s submission channel is still open. In plain terms, it checks whether the thread can still receive work.

**Data flow**: It looks at the internal sender channel and returns true if that channel has not been closed. It does not wait or change anything.

**Call relations**: Internal code can use this as a quick liveness check before deciding whether a thread is still usable.


##### `CodexThread::guardian_trunk_rollout_path`  (lines 483–489)

```
async fn guardian_trunk_rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the rollout path for the guardian review trunk session, if there is one. This is related to review workflows that compare or protect a main line of work.

**Data flow**: It asks the session’s guardian review session for its trunk rollout path and returns the optional path. The current thread state is unchanged.

**Call relations**: Review-related orchestration can call this when it needs to locate the persisted record for the trunk side of a guardian review.


##### `CodexThread::load_history`  (lines 491–503)

```
async fn load_history(
        &self,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThreadHistory>
```

**Purpose**: Loads the stored history for this live thread. It can include or exclude archived history depending on the caller’s request.

**Data flow**: It first asks the session for a persistence-ready live-thread handle. If that fails, it converts the problem into a thread-store internal error. Otherwise it asks that handle to load history and returns the result.

**Call relations**: Store-field application code calls this when it needs to attach saved conversation history to a thread read response.

*Call graph*: called by 1 (apply_thread_read_store_fields).


##### `CodexThread::read_thread`  (lines 505–520)

```
async fn read_thread(
        &self,
        include_archived: bool,
        include_history: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads the stored thread record, optionally including archived data and full history. This is the broader “give me the saved thread” operation.

**Data flow**: It obtains the live-thread persistence handle from the session, converting failures into thread-store errors. Then it asks that handle to read the thread with the requested archive and history options. The stored thread record is returned.

**Call relations**: Thread-store API paths use this when a caller wants the persisted representation of the current live thread.


##### `CodexThread::update_thread_metadata`  (lines 522–535)

```
async fn update_thread_metadata(
        &self,
        patch: ThreadMetadataPatch,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Applies a metadata patch to the stored thread record. Metadata is descriptive information about the thread, separate from the conversation events themselves.

**Data flow**: It receives a metadata patch and an archive-inclusion flag. It obtains the live-thread persistence handle, then asks it to update the metadata. The updated stored thread is returned, or a store error if anything fails.

**Call relations**: Thread management endpoints use this when a client edits stored thread details. This method bridges from the live session to the thread store.


##### `CodexThread::state_db`  (lines 537–539)

```
fn state_db(&self) -> Option<StateDbHandle>
```

**Purpose**: Returns the state database handle for this thread, if one is available. This database stores rollout or resume-related state outside the immediate session objects.

**Data flow**: It asks the inner `Codex` object for its optional state database handle and returns it. Nothing is mutated.

**Call relations**: Resume-goal and thread-spawn-edge persistence code call this when they need access to durable state associated with the thread.

*Call graph*: calls 1 internal fn (state_db); called by 2 (pending_resume_goal_state, persist_thread_spawn_edge_for_source).


##### `CodexThread::config_snapshot`  (lines 541–543)

```
async fn config_snapshot(&self) -> ThreadConfigSnapshot
```

**Purpose**: Returns a snapshot of the thread’s current configuration. This gives callers a stable view of settings such as model, approvals, environments, and workspace roots.

**Data flow**: It asks the inner `Codex` object to build the current thread configuration snapshot. The returned snapshot is independent data for the caller to inspect.

**Call relations**: Live-thread loading, resume, environment override, and settings override flows call this before comparing or preparing configuration changes.

*Call graph*: calls 1 internal fn (thread_config_snapshot); called by 4 (load_live_thread_view, load_thread_from_resume_source_or_send_internal, build_environment_override, build_thread_settings_overrides).


##### `CodexThread::instruction_sources`  (lines 546–548)

```
async fn instruction_sources(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the files that supplied the model instructions loaded for this thread. This helps explain where the thread’s guidance came from.

**Data flow**: It asks the inner `Codex` object for its instruction source paths and returns the list. It does not alter the loaded instructions.

**Call relations**: Diagnostics or configuration display code can call this when it wants to show the origin of the thread’s instructions.

*Call graph*: calls 1 internal fn (instruction_sources).


##### `CodexThread::config`  (lines 550–552)

```
async fn config(&self) -> Arc<crate::config::Config>
```

**Purpose**: Returns the thread’s current configuration object. This is the fuller configuration, not just a lightweight snapshot.

**Data flow**: It asks the session for its current config and returns it inside a shared pointer. The shared pointer lets multiple parts of the program read the same config safely.

**Call relations**: Refresh-config building code calls this as the starting point for calculating runtime configuration updates.

*Call graph*: called by 1 (build_refresh_config).


##### `CodexThread::runtime_mcp_config`  (lines 555–557)

```
async fn runtime_mcp_config(&self, config: &crate::config::Config) -> codex_mcp::McpConfig
```

**Purpose**: Builds the runtime MCP configuration for this thread. MCP, or Model Context Protocol, is a way for the model/session to talk to external tools and resources.

**Data flow**: It receives a base config and asks the session to resolve the MCP config using this thread’s extension data. It returns the ready-to-use MCP configuration.

**Call relations**: Refresh-config building code calls this after reading configuration so MCP tool/resource settings reflect the thread’s runtime extension state.

*Call graph*: called by 1 (build_refresh_config).


##### `CodexThread::multi_agent_version`  (lines 559–561)

```
fn multi_agent_version(&self) -> Option<MultiAgentVersion>
```

**Purpose**: Returns which multi-agent protocol version this session is using, if any. Multi-agent mode means more than one agent-like participant may coordinate work.

**Data flow**: It reads the version from the session and returns an optional value. No state changes.

**Call relations**: Input-permission and resident-thread selection logic call this when behavior depends on whether the thread is using a multi-agent version.

*Call graph*: called by 2 (ensure_direct_input_allowed, is_resident_candidate).


##### `CodexThread::refresh_runtime_config`  (lines 566–568)

```
async fn refresh_runtime_config(&self, next_config: crate::config::Config)
```

**Purpose**: Refreshes the thread’s runtime user configuration from a new config snapshot. Thread-specific layers and settings that are fixed for the session stay unchanged.

**Data flow**: It receives a new config object and passes it to the session’s refresh logic. The session updates its runtime config view; this method returns nothing.

**Call relations**: Configuration refresh orchestration uses this when external config changes need to be reflected in a live thread without rebuilding the whole session.


##### `CodexThread::environment_selections`  (lines 570–572)

```
async fn environment_selections(&self) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Returns the current environment selections for the thread. These describe the execution environments available for turns.

**Data flow**: It asks the inner `Codex` object for the thread’s environment selections and returns the resulting list. The thread is unchanged.

**Call relations**: Callers use this when they need the live environment choices rather than a previously captured configuration snapshot.

*Call graph*: calls 1 internal fn (thread_environment_selections).


##### `CodexThread::read_mcp_resource`  (lines 574–586)

```
async fn read_mcp_resource(
        &self,
        server: &str,
        uri: &str,
    ) -> anyhow::Result<serde_json::Value>
```

**Purpose**: Reads a resource from an MCP server and returns it as JSON. This is how callers fetch external resource data through the thread’s configured tool protocol.

**Data flow**: It receives a server name and resource URI, builds MCP read parameters, and asks the session to read the resource. The result is converted into JSON and returned, or an error is passed back.

**Call relations**: Client or tool-facing code calls this when it needs to access an MCP resource through the same runtime configuration and permissions as the thread.

*Call graph*: 2 external calls (new, to_value).


##### `CodexThread::call_mcp_tool`  (lines 588–599)

```
async fn call_mcp_tool(
        &self,
        server: &str,
        tool: &str,
        arguments: Option<serde_json::Value>,
        meta: Option<serde_json::Value>,
    ) -> anyhow::Result<CallTool
```

**Purpose**: Calls a tool exposed by an MCP server. It lets the thread invoke external tool functionality with optional arguments and metadata.

**Data flow**: It receives the server name, tool name, optional JSON arguments, and optional JSON metadata. It forwards them to the session’s MCP tool caller and returns the tool result or an error.

**Call relations**: Tool invocation paths use this as the thread-level bridge to MCP tool execution, keeping calls tied to this session’s configuration and extension data.


##### `CodexThread::enabled`  (lines 601–603)

```
fn enabled(&self, feature: Feature) -> bool
```

**Purpose**: Checks whether a feature flag is enabled for this thread. Feature flags let the system turn behavior on or off in a controlled way.

**Data flow**: It receives a feature identifier and asks the inner `Codex` object whether that feature is enabled. It returns true or false.

**Call relations**: Any thread-level logic that needs to branch on optional behavior can call this instead of reaching into the underlying Codex object.

*Call graph*: calls 1 internal fn (enabled).


##### `CodexThread::increment_out_of_band_elicitation_count`  (lines 605–619)

```
async fn increment_out_of_band_elicitation_count(&self) -> CodexResult<u64>
```

**Purpose**: Records that an out-of-band elicitation has started and pauses the session for that condition if this is the first one. An elicitation is a prompt for information or approval outside the normal turn flow.

**Data flow**: It locks the counter, checks whether it was zero, and safely adds one. If adding would overflow, it returns a fatal error. If this was the first active elicitation, it tells the session to enter the paused state. It returns the new count.

**Call relations**: Code that begins an external prompt uses this to make the thread aware that normal progress may need to pause. The matching decrement method clears the pause when the last such prompt finishes.


##### `CodexThread::decrement_out_of_band_elicitation_count`  (lines 621–638)

```
async fn decrement_out_of_band_elicitation_count(&self) -> CodexResult<u64>
```

**Purpose**: Records that an out-of-band elicitation has finished and unpauses the session when none remain. This keeps pause state accurate even if several prompts overlap.

**Data flow**: It locks the counter and rejects the request if the count is already zero. Otherwise it subtracts one. If the count reaches zero, it tells the session to leave the out-of-band elicitation paused state. It returns the new count.

**Call relations**: Code that completes or cancels an external prompt calls this after a previous increment. Together, the two methods act like a checkout counter: the session stays paused until the last outstanding prompt has checked back in.

*Call graph*: 1 external calls (InvalidRequest).


### `core/src/session/mod.rs`

`orchestration` · `startup, main loop, request handling, config reload, persistence, shutdown`

A Codex session is the long-running object behind a conversation thread. This file wires together many moving parts: configuration, model choice, permissions, saved history, tools, network rules, event delivery, and shutdown. Without it, the rest of the system would have pieces of a conversation, but no single place that turns them into a live thread that can receive input and produce events. The flow is much like opening a staffed help desk: setup chooses the rules, tools, model, workspace, and history; the submission channel is the inbox; the event channel is the outbox; and the session loop is the worker reading requests and sending updates. The file also protects important state with locks, because several asynchronous tasks may ask about or change the same session at the same time. It records events into rollout storage, which is the saved transcript used for resume and fork. It also refreshes runtime settings, starts or updates a managed network proxy when permissions change, and forwards child-agent completion messages back to parent agents in multi-agent runs. A session is the running “conversation desk” for Codex. This chunk is mostly about the moments when that desk has to pause, ask someone something, update its records, and then continue. It sends events to the outside client when a command, patch, permission request, user question, model reroute, token count, or stream error needs to be shown. It also keeps small waiting slots, using one-shot channels, so a later response can be matched back to the exact request that created it. Think of this like putting a numbered claim ticket on each pending approval, then redeeming that ticket when the user answers.

The same code also protects the conversation’s memory. It records model-visible items into in-memory history, persists them to the rollout transcript when one exists, emits UI turn-item events, and rebuilds or compacts context when the conversation window changes. It normalizes granted permissions so the client cannot grant more than was requested, and records those grants either for one turn or for the whole session. Finally, it tracks operational state such as token usage, rate limits, hooks, feature flags, active turn steering, interruption, and subagent analytics. The file matters because it is the bridge between long-running assistant work, user-facing events, durable history, and safety decisions.

#### Function details

##### `SteerInputError::to_error_event`  (lines 251–278)

```
fn to_error_event(&self) -> ErrorEvent
```

**Purpose**: Turns a steering-input failure into an event that can be sent to the client. This gives callers a clear user-facing message and, when possible, a structured error code.

**Data flow**: It reads the specific error variant, chooses a plain message such as “no active turn to steer” or “input must not be empty,” and returns an ErrorEvent with optional machine-readable Codex error information.

**Call relations**: It is the bridge from internal steering validation to the public event stream. When steering fails, higher-level code can use this to report the problem in the same event format as other session errors.

*Call graph*: 1 external calls (format!).


##### `resolve_multi_agent_version`  (lines 441–457)

```
fn resolve_multi_agent_version(
    conversation_history: &InitialHistory,
    inherited_multi_agent_version: Option<MultiAgentVersion>,
) -> Option<MultiAgentVersion>
```

**Purpose**: Decides which multi-agent behavior version a session should use. It preserves explicit disabling, honors saved thread metadata, and keeps older resumed or forked threads on the older behavior when no metadata exists.

**Data flow**: It takes the starting conversation history and an optional inherited version, checks them in priority order, and returns the chosen version or no version. Old resumed and forked histories default to V1 so their tool surface does not unexpectedly change.

**Call relations**: Session startup calls this while building the session configuration. A helper for spawn-time defaults also uses it so new, resumed, forked, and inherited sessions make the same compatibility decision.

*Call graph*: calls 1 internal fn (get_multi_agent_version); called by 2 (spawn_internal, initial_multi_agent_version_for_spawn).


##### `Codex::spawn`  (lines 466–488)

```
async fn spawn(args: CodexSpawnArgs) -> CodexResult<CodexSpawnOk>
```

**Purpose**: Starts a new Codex thread from caller-provided startup arguments. It also attaches tracing information, which is metadata used to connect logs and telemetry across related work.

**Data flow**: It receives spawn arguments, validates any parent trace carrier, creates a tracing span for thread creation, attaches the parent trace when valid, and then delegates the real setup to Codex::spawn_internal. It returns the live Codex handle and the thread id.

**Call relations**: This is the friendly outer startup entry used by interactive runs and thread-spawn helpers. It wraps Codex::spawn_internal with tracing so the deeper setup work appears as one connected operation in observability tools.

*Call graph*: called by 3 (run_codex_thread_interactive, guardian_subagent_does_not_inherit_parent_exec_policy_rules, spawn_thread_with_source); 5 external calls (spawn_internal, context_from_w3c_trace_context, set_parent_from_w3c_trace_context, info_span!, warn!).


##### `Codex::spawn_internal`  (lines 490–691)

```
async fn spawn_internal(args: CodexSpawnArgs) -> CodexResult<CodexSpawnOk>
```

**Purpose**: Builds the live session and starts the background loop that processes submissions. This is where configuration, model choice, permissions, history, tools, and event channels are assembled into a working Codex instance.

**Data flow**: It unpacks startup arguments, creates channels for incoming submissions and outgoing events, loads or inherits execution policy rules, chooses a model, resolves instructions and multi-agent behavior, builds a SessionConfiguration, creates a Session, and starts a background task that runs the submission loop. It returns a Codex object connected to that loop plus the session thread id.

**Call relations**: Codex::spawn calls this after trace setup. It hands the finished Session to submission_loop, then exposes the channel endpoints through Codex so later calls like submit, next_event, and shutdown_and_wait can interact with the running session.

*Call graph*: calls 9 internal fn (default, load, get_service_tier, submission_loop, resolve_multi_agent_version, new, session_loop_termination_from_handle, session_permission_profile_state_from_config, new); 11 external calls (clone, new, pin, bounded, unbounded, is_guardian_reviewer_source, info_span!, matches!, from_config, spawn (+1 more)).


##### `Codex::submit`  (lines 694–696)

```
async fn submit(&self, op: Op) -> CodexResult<String>
```

**Purpose**: Sends an operation to the running session without explicitly providing trace metadata. It is the simple path for callers that just want to ask the session to do something.

**Data flow**: It receives an Op, passes it to Codex::submit_with_trace with no trace, and returns the generated submission id. If the session loop has died, the error is returned.

**Call relations**: Approval handlers, user-input handlers, shutdown helpers, and other public-facing wrappers use this when they do not need to carry a separate trace context.

*Call graph*: calls 1 internal fn (submit_with_trace); called by 8 (handle_exec_approval, handle_patch_approval, handle_request_permissions, handle_request_user_input, shutdown_delegate, submit, interrupt_and_drain_turn, shutdown_and_wait).


##### `Codex::submit_with_trace`  (lines 698–712)

```
async fn submit_with_trace(
        &self,
        op: Op,
        trace: Option<W3cTraceContext>,
    ) -> CodexResult<String>
```

**Purpose**: Sends an operation to the session and includes optional trace metadata. It creates a unique id so the caller can connect later events back to this submission.

**Data flow**: It takes an Op and optional W3C trace context, creates a time-ordered UUID string, wraps everything in a Submission, sends it through Codex::submit_with_id, and returns the id.

**Call relations**: Codex::submit delegates here for normal submissions. It hands the finished Submission to Codex::submit_with_id, which is the final channel-send step.

*Call graph*: calls 1 internal fn (submit_with_id); called by 2 (submit_with_trace, submit); 1 external calls (now_v7).


##### `Codex::submit_user_input_with_client_user_message_id`  (lines 714–730)

```
async fn submit_user_input_with_client_user_message_id(
        &self,
        op: Op,
        trace: Option<W3cTraceContext>,
        client_user_message_id: Option<String>,
    ) -> CodexResult<Stri
```

**Purpose**: Submits user input while preserving a caller-supplied user-message id. That lets outside clients match their own message records to Codex’s internal submission id.

**Data flow**: It expects an Op::UserInput operation, creates a new submission id, attaches the optional trace and client user message id, sends the submission, and returns the new id.

**Call relations**: This is the specialized user-input version of the submission path. Like Codex::submit_with_trace, it finishes by calling Codex::submit_with_id.

*Call graph*: calls 1 internal fn (submit_with_id); called by 1 (submit_user_input_with_client_user_message_id); 2 external calls (now_v7, debug_assert!).


##### `Codex::submit_with_id`  (lines 734–743)

```
async fn submit_with_id(&self, mut sub: Submission) -> CodexResult<()>
```

**Purpose**: Places a fully formed submission onto the session’s input channel. This is the last step before the background session loop receives the work.

**Data flow**: It takes a Submission, fills in the current tracing context if the submission lacks one, sends it through the bounded submission channel, and returns success or an InternalAgentDied error if the channel is closed.

**Call relations**: The higher-level submit helpers all end here. The background submission loop created during spawn reads from the other end of this channel.

*Call graph*: called by 3 (submit_with_id, submit_user_input_with_client_user_message_id, submit_with_trace); 2 external calls (send, current_span_w3c_trace_context).


##### `Codex::set_thread_memory_mode`  (lines 749–754)

```
async fn set_thread_memory_mode(
        &self,
        mode: codex_protocol::protocol::ThreadMemoryMode,
    ) -> anyhow::Result<()>
```

**Purpose**: Changes and persists the thread’s memory mode. Memory mode controls how the thread should remember or use past information.

**Data flow**: It receives the desired ThreadMemoryMode and asks the handlers layer to persist that update for the session. It returns any persistence error.

**Call relations**: The public thread-memory API calls this when a caller changes memory behavior. It delegates the actual write to handlers::persist_thread_memory_mode_update.

*Call graph*: calls 1 internal fn (persist_thread_memory_mode_update); called by 1 (set_thread_memory_mode).


##### `Codex::shutdown_and_wait`  (lines 756–765)

```
async fn shutdown_and_wait(&self) -> CodexResult<()>
```

**Purpose**: Asks the session loop to shut down and waits until it has actually stopped. This avoids dropping a session while its background task is still running.

**Data flow**: It clones the shared termination future, submits an Op::Shutdown, ignores the special case where the agent already died, waits for the loop to end, and then returns success.

**Call relations**: Shutdown flows and thread-spawn finalization use this to perform orderly teardown. It uses Codex::submit to request shutdown and the termination handle made by session_loop_termination_from_handle to wait.

*Call graph*: calls 1 internal fn (submit); called by 3 (shutdown_and_wait, shutdown, finalize_thread_spawn); 1 external calls (clone).


##### `Codex::next_event`  (lines 767–774)

```
async fn next_event(&self) -> CodexResult<Event>
```

**Purpose**: Waits for the next event produced by the session. Events are how the outside world learns about model output, tool calls, warnings, errors, and turn completion.

**Data flow**: It waits on the event receiver channel, returns the next Event, or reports InternalAgentDied if the channel is closed.

**Call relations**: Consumers such as interactive loops and shutdown helpers call this to drain the session outbox. Session::deliver_event_raw sends events into the matching channel.

*Call graph*: calls 1 internal fn (recv); called by 4 (shutdown_delegate, next_event, interrupt_and_drain_turn, finalize_thread_spawn).


##### `Codex::steer_input`  (lines 776–793)

```
async fn steer_input(
        &self,
        input: Vec<UserInput>,
        additional_context: BTreeMap<String, AdditionalContextEntry>,
        expected_turn_id: Option<&str>,
        client_user_me
```

**Purpose**: Adds steering input to an already running turn, such as extra user guidance or context. It is separate from starting a new turn.

**Data flow**: It receives user input items, extra context, an optional expected turn id, an optional client message id, and optional Responses API metadata, then forwards them to the Session. It returns a submission-like id or a SteerInputError.

**Call relations**: The outer Codex API exposes this to callers, while Session::steer_input performs the active-turn validation and insertion work.

*Call graph*: called by 1 (steer_input).


##### `Codex::set_app_server_client_info`  (lines 795–811)

```
async fn set_app_server_client_info(
        &self,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
        mcp_elicitations_auto_deny: bool,
    ) -
```

**Purpose**: Records which app-server client is connected and configures whether MCP elicitations should be automatically denied. MCP is a tool-connection protocol; elicitations are requests for extra input.

**Data flow**: It takes optional client name and version plus a boolean auto-deny flag, updates session settings with the client details, then updates the MCP connection manager with the elicitation behavior.

**Call relations**: External API code calls this after a client identifies itself. It uses Session::update_settings for stored settings and then directly adjusts the MCP service.

*Call graph*: called by 1 (set_app_server_client_info); 1 external calls (default).


##### `Codex::agent_status`  (lines 813–815)

```
async fn agent_status(&self) -> AgentStatus
```

**Purpose**: Returns the latest known status of the agent, such as pending, running, completed, or errored.

**Data flow**: It reads the current value from a watch channel, clones it, and returns it without changing session state.

**Call relations**: Status-facing APIs call this when they need a snapshot. Session::deliver_event_raw and multi-agent completion handling update the watched status.

*Call graph*: called by 1 (agent_status); 1 external calls (borrow).


##### `Codex::thread_config_snapshot`  (lines 817–820)

```
async fn thread_config_snapshot(&self) -> ThreadConfigSnapshot
```

**Purpose**: Returns a safe snapshot of the thread’s current configuration. This lets callers inspect settings without taking ownership of the live configuration object.

**Data flow**: It locks session state, asks the SessionConfiguration to build a ThreadConfigSnapshot, and returns that snapshot.

**Call relations**: Configuration APIs call this to report current thread settings. It reads the same session configuration that Session::update_settings changes.

*Call graph*: called by 1 (config_snapshot).


##### `Codex::instruction_sources`  (lines 822–831)

```
async fn instruction_sources(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Reports the files that supplied loaded agent instructions. This helps users understand where the model’s guidance came from.

**Data flow**: It locks session state, looks for loaded AGENTS-style instruction data, collects its source paths, and returns an empty list if none are loaded.

**Call relations**: Instruction-inspection APIs use this after session setup has loaded instruction files into the session configuration.

*Call graph*: called by 1 (instruction_sources).


##### `Codex::thread_environment_selections`  (lines 833–839)

```
async fn thread_environment_selections(&self) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Returns the environments selected for this thread, such as the workspace or runtime targets used for turns.

**Data flow**: It locks session state, reads the configuration’s environment selections, copies them into a vector, and returns them.

**Call relations**: Environment-inspection APIs call this. Session::update_settings can change the stored environment selections.

*Call graph*: called by 1 (environment_selections).


##### `Codex::state_db`  (lines 841–843)

```
fn state_db(&self) -> Option<state_db::StateDbHandle>
```

**Purpose**: Exposes the optional state database handle for this session. The state database is persistent storage for session-related data when enabled.

**Data flow**: It asks the underlying Session for its state database handle and returns either a handle or None.

**Call relations**: Higher-level APIs use this Codex wrapper instead of reaching into Session directly. Session::state_db provides the actual handle.

*Call graph*: called by 1 (state_db).


##### `Codex::enabled`  (lines 845–847)

```
fn enabled(&self, feature: Feature) -> bool
```

**Purpose**: Checks whether a feature flag is enabled for this session. Feature flags are switches that turn optional behavior on or off.

**Data flow**: It receives a Feature value, asks the Session whether that feature is enabled, and returns true or false.

**Call relations**: Callers use this as the Codex-level feature query. The Session owns the feature configuration used to answer.

*Call graph*: called by 1 (enabled).


##### `get_service_tier`  (lines 850–862)

```
fn get_service_tier(
    configured_service_tier: Option<String>,
    fast_mode_enabled: bool,
    model_info: &ModelInfo,
) -> Option<String>
```

**Purpose**: Decides whether to send a service-tier hint to the model provider. The tier is only used when fast mode is enabled and the selected model supports the requested tier.

**Data flow**: It receives the configured tier, whether fast mode is enabled, and model metadata. If fast mode is off it returns None; otherwise it returns the configured tier only if it is the default request value or supported by the model.

**Call relations**: Session startup calls this while building SessionConfiguration so model requests carry a valid service-tier value.

*Call graph*: called by 1 (spawn_internal).


##### `session_permission_profile_state_from_config`  (lines 864–868)

```
fn session_permission_profile_state_from_config(
    config: &Config,
) -> CodexResult<PermissionProfileState>
```

**Purpose**: Extracts the initial permission-profile state from the configuration. The permission profile controls what the session is allowed to do.

**Data flow**: It reads config.permissions, clones its PermissionProfileState, wraps it in a successful CodexResult, and returns it.

**Call relations**: Codex::spawn_internal uses this while building the session configuration.

*Call graph*: called by 1 (spawn_internal).


##### `completed_session_loop_termination`  (lines 871–873)

```
fn completed_session_loop_termination() -> SessionLoopTermination
```

**Purpose**: Creates a termination handle that is already complete. This is useful in tests or fake sessions that do not have a real background loop.

**Data flow**: It builds a future that immediately resolves, boxes it, shares it, and returns it as a SessionLoopTermination.

**Call relations**: Tests use this instead of the real handle returned by session_loop_termination_from_handle.

*Call graph*: called by 1 (test_review_session); 1 external calls (ready).


##### `session_loop_termination_from_handle`  (lines 875–883)

```
fn session_loop_termination_from_handle(
    handle: JoinHandle<()>,
) -> SessionLoopTermination
```

**Purpose**: Turns a spawned background task handle into a shared future that completes when the session loop ends.

**Data flow**: It takes a JoinHandle, creates an async block that awaits it and ignores the join result, boxes and shares that future, and returns it.

**Call relations**: Codex::spawn_internal wraps the submission-loop task with this so Codex::shutdown_and_wait can wait for clean termination.

*Call graph*: called by 1 (spawn_internal).


##### `thread_title_from_thread_store`  (lines 885–912)

```
async fn thread_title_from_thread_store(
    live_thread: Option<&LiveThread>,
    thread_store: &Arc<dyn ThreadStore>,
    conversation_id: ThreadId,
) -> Option<String>
```

**Purpose**: Finds a useful saved title for a thread. It avoids returning empty titles or titles that are merely the same as the preview text.

**Data flow**: It reads the thread either from a live thread object or from the thread store, trims the thread name, compares it with the preview, and returns a title only if it is non-empty and distinct.

**Call relations**: This helper is available to code that needs display names for existing threads, whether the thread is currently live or only stored.


##### `Session::app_server_client_metadata`  (lines 915–924)

```
async fn app_server_client_metadata(&self) -> AppServerClientMetadata
```

**Purpose**: Returns the app-server client name and version stored on the session. This lets downstream code tailor behavior or reporting to the connected client.

**Data flow**: It locks session state, copies the optional client name and version from the session configuration, and returns them in an AppServerClientMetadata value.

**Call relations**: The data returned here is set through Codex::set_app_server_client_info and Session::update_settings.


##### `Session::managed_network_proxy_active_for_permission_profile`  (lines 926–930)

```
fn managed_network_proxy_active_for_permission_profile(
        permission_profile: &PermissionProfile,
    ) -> bool
```

**Purpose**: Answers whether the managed network proxy should be active for a permission profile. It treats the disabled profile as the only case where proxy enforcement is inactive.

**Data flow**: It receives a PermissionProfile and returns false if it is Disabled, otherwise true.

**Call relations**: This helper supports the network-permission logic used when the session starts or refreshes network proxy state.

*Call graph*: 1 external calls (matches!).


##### `Session::build_model_client_beta_features_header`  (lines 937–958)

```
fn build_model_client_beta_features_header(config: &Config) -> Option<String>
```

**Purpose**: Builds the header value that tells the model client which experimental features are enabled. This lets the model side know about selected beta behavior.

**Data flow**: It scans all known feature specs, keeps the ones meant to be advertised and enabled in config, joins their keys with commas, and returns None if there are no enabled advertised features.

**Call relations**: Session setup can use this when constructing model-client requests or clients that need feature-advertising headers.


##### `Session::start_managed_network_proxy`  (lines 960–996)

```
async fn start_managed_network_proxy(
        spec: &crate::config::NetworkProxySpec,
        exec_policy: &codex_execpolicy::Policy,
        permission_profile: &PermissionProfile,
        network_po
```

**Purpose**: Starts the session’s managed network proxy, which is a local gatekeeper for outbound network access. It combines configured network rules with execution-policy rules before launching the proxy.

**Data flow**: It receives a proxy spec, current execution policy, permission profile, optional policy hooks, requirement flags, and audit metadata. It tries to apply execution-policy network rules, starts the proxy, captures its HTTP and SOCKS addresses, and returns both the running proxy and runtime address data.

**Call relations**: Network setup and refresh flows call this when a proxy must be created. Session::refresh_managed_network_proxy_for_current_permission_profile uses it if no proxy is already running.

*Call graph*: calls 2 internal fn (start_proxy, with_exec_policy_network_rules).


##### `Session::refresh_managed_network_proxy_for_current_permission_profile`  (lines 998–1068)

```
async fn refresh_managed_network_proxy_for_current_permission_profile(&self)
```

**Purpose**: Updates the managed network proxy after the session’s permission profile changes. This keeps network enforcement aligned with the current sandbox and approval settings.

**Data flow**: It takes a refresh lock so only one refresh runs, reads current session configuration, exits if no network proxy is configured, recomputes the proxy spec for the current permission profile, applies execution-policy network rules, updates an existing proxy if present, or starts and stores a new proxy.

**Call relations**: Session::update_settings calls this when it detects a permission-profile change. It uses Session::start_managed_network_proxy for the create-new-proxy path.

*Call graph*: called by 1 (update_settings); 4 external calls (new, start_managed_network_proxy, error!, warn!).


##### `Session::codex_home`  (lines 1071–1074)

```
async fn codex_home(&self) -> AbsolutePathBuf
```

**Purpose**: Returns the session’s Codex home directory, where configuration and persistent files live.

**Data flow**: It locks session state, clones the codex_home path from the configuration, and returns it.

**Call relations**: Helpers that need to read or write files under Codex home use this instead of reaching into configuration directly.


##### `Session::subscribe_out_of_band_elicitation_pause_state`  (lines 1076–1078)

```
fn subscribe_out_of_band_elicitation_pause_state(&self) -> watch::Receiver<bool>
```

**Purpose**: Lets another task watch whether out-of-band elicitations are paused. Out-of-band means requests that happen outside the normal turn flow.

**Data flow**: It subscribes to the watch channel that stores the pause boolean and returns a receiver for future changes.

**Call relations**: Consumers that react to elicitation pause changes use this receiver. Session::set_out_of_band_elicitation_pause_state updates the watched value.


##### `Session::set_out_of_band_elicitation_pause_state`  (lines 1080–1082)

```
fn set_out_of_band_elicitation_pause_state(&self, paused: bool)
```

**Purpose**: Sets whether out-of-band elicitations are paused. This immediately notifies watchers of the new state.

**Data flow**: It receives a boolean and replaces the current value in the watch channel with that boolean.

**Call relations**: Control paths call this when elicitation behavior should pause or resume. Subscribers created by Session::subscribe_out_of_band_elicitation_pause_state see the update.


##### `Session::get_tx_event`  (lines 1084–1086)

```
fn get_tx_event(&self) -> Sender<Event>
```

**Purpose**: Returns a sender for the session’s event channel. This gives internal helpers a way to deliver events to the outside Codex handle.

**Data flow**: It clones the event Sender and returns the clone, leaving the original sender in place.

**Call relations**: Code that needs to emit events can use this sender, though most event emission goes through Session::send_event or Session::send_event_raw.


##### `Session::state_db`  (lines 1088–1090)

```
fn state_db(&self) -> Option<state_db::StateDbHandle>
```

**Purpose**: Returns the optional state database handle held by the session services.

**Data flow**: It clones the state database handle option from services and returns it.

**Call relations**: Codex::state_db calls this as its session-level implementation.


##### `Session::live_thread_for_persistence`  (lines 1092–1098)

```
fn live_thread_for_persistence(
        &self,
        operation: &str,
    ) -> anyhow::Result<&LiveThread>
```

**Purpose**: Gets the live thread object needed for persistence, or explains why it is unavailable. This prevents silent failures when code expects saved thread storage.

**Data flow**: It receives a human-readable operation name, checks whether live-thread persistence exists, and returns either the LiveThread reference or an error saying persistence is disabled for that operation.

**Call relations**: Persistence code uses this when the operation cannot safely proceed without a live thread. It builds on Session::live_thread.

*Call graph*: calls 1 internal fn (live_thread).


##### `Session::live_thread`  (lines 1100–1102)

```
fn live_thread(&self) -> Option<&LiveThread>
```

**Purpose**: Returns the optional live thread object for this session. A live thread is the file-backed or store-backed object used to persist rollout data.

**Data flow**: It reads the live_thread field from session services and returns it as an optional reference.

**Call relations**: Rollout helpers such as flush, persist, and path lookup call this to decide whether persistence is enabled.

*Call graph*: called by 5 (current_rollout_path, flush_rollout, live_thread_for_persistence, persist_rollout_items, try_ensure_rollout_materialized).


##### `Session::flush_rollout`  (lines 1106–1112)

```
async fn flush_rollout(&self) -> std::io::Result<()>
```

**Purpose**: Flushes pending rollout data to storage if this session has persistence enabled. Flushing means asking storage to write buffered data out.

**Data flow**: It checks for a live thread. If one exists, it awaits its flush and converts errors into I/O errors; if not, it succeeds without doing anything.

**Call relations**: Session::record_initial_history calls this after resume or fork setup so saved history is stable on disk or in the backing store.

*Call graph*: calls 1 internal fn (live_thread); called by 1 (record_initial_history).


##### `Session::try_ensure_rollout_materialized`  (lines 1114–1119)

```
async fn try_ensure_rollout_materialized(&self) -> std::io::Result<()>
```

**Purpose**: Ensures the rollout has a concrete persisted backing when possible. This is important for forked or resumed threads that should remain file-backed immediately.

**Data flow**: It checks for a live thread, calls persist on it if present, converts errors to I/O errors, and otherwise returns success.

**Call relations**: Session::ensure_rollout_materialized wraps this with warning-only error handling for callers that should not fail the whole turn.

*Call graph*: calls 1 internal fn (live_thread); called by 1 (ensure_rollout_materialized).


##### `Session::ensure_rollout_materialized`  (lines 1121–1125)

```
async fn ensure_rollout_materialized(&self)
```

**Purpose**: Best-effort version of ensuring rollout persistence exists. It logs a warning instead of returning an error.

**Data flow**: It calls Session::try_ensure_rollout_materialized and, if that fails, logs the failure and continues.

**Call relations**: History recording and prompt-recording code use this when persistence is desired but should not stop the session if it fails.

*Call graph*: calls 1 internal fn (try_ensure_rollout_materialized); called by 3 (hook_transcript_path, record_initial_history, record_user_prompt_and_emit_turn_item); 1 external calls (warn!).


##### `Session::next_internal_sub_id`  (lines 1127–1132)

```
fn next_internal_sub_id(&self) -> String
```

**Purpose**: Generates a unique internal submission id for automatic session work. In this chunk it is used for realtime text routed into the normal input path.

**Data flow**: It atomically increments a counter and formats the previous number as an id like auto-compact-N.

**Call relations**: Session::route_realtime_text_input calls this before creating an internal user-input operation.

*Call graph*: called by 1 (route_realtime_text_input); 1 external calls (format!).


##### `Session::route_realtime_text_input`  (lines 1134–1151)

```
async fn route_realtime_text_input(self: &Arc<Self>, text: String)
```

**Purpose**: Feeds realtime text into the same machinery as normal user input. This lets live text input become a turn input without duplicating turn-start logic.

**Data flow**: It receives text, wraps it in a UserInput::Text item inside an Op::UserInput, assigns an internal submission id, and passes it to handlers::user_input_or_turn_inner.

**Call relations**: Realtime input handling calls this on the Session. It delegates to the normal user-input handler so the rest of the turn pipeline stays consistent.

*Call graph*: calls 2 internal fn (next_internal_sub_id, user_input_or_turn_inner); 2 external calls (default, vec!).


##### `Session::get_total_token_usage`  (lines 1153–1156)

```
async fn get_total_token_usage(&self) -> i64
```

**Purpose**: Returns the total token usage as an integer count. Tokens are pieces of text counted by the model for billing and context-size limits.

**Data flow**: It locks state, asks state to compute total usage with the current reasoning-token inclusion setting, and returns the count.

**Call relations**: Usage-reporting code can call this for a simple total. More detailed methods below return structured token information.


##### `Session::auto_compact_window_snapshot`  (lines 1158–1161)

```
async fn auto_compact_window_snapshot(&self) -> AutoCompactWindowSnapshot
```

**Purpose**: Returns the current auto-compaction window state. Auto-compaction is the process of shrinking old context when a conversation grows too large.

**Data flow**: It locks session state, asks state for an AutoCompactWindowSnapshot, and returns it.

**Call relations**: Compaction and UI code use this to understand where the current context window stands.


##### `Session::estimated_tokens_after_last_model_generated_item`  (lines 1163–1168)

```
async fn estimated_tokens_after_last_model_generated_item(&self) -> i64
```

**Purpose**: Estimates how many tokens are in the history after the last item generated by the model. This helps reason about recent user or tool additions since the model last spoke.

**Data flow**: It locks state, asks the history object for the estimate, and returns the integer result.

**Call relations**: Token-budgeting and compaction logic can call this when deciding whether more model context can be added.


##### `Session::total_token_usage`  (lines 1170–1173)

```
async fn total_token_usage(&self) -> Option<TokenUsage>
```

**Purpose**: Returns detailed total token usage if token information is available. Unlike the plain integer helper, this keeps the structured TokenUsage shape.

**Data flow**: It locks state, reads optional token info, maps it to the total_token_usage field, and returns None if no token info has been recorded.

**Call relations**: UI or metrics code can use this when it wants provider-style token breakdowns.


##### `Session::token_usage_info`  (lines 1181–1184)

```
async fn token_usage_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the full token-usage information currently stored on the session.

**Data flow**: It locks state, reads token_info, and returns the optional TokenUsageInfo value.

**Call relations**: This is the broadest token-reporting accessor. Session::record_initial_history can seed this data from saved rollout events.


##### `Session::get_estimated_token_count`  (lines 1186–1192)

```
async fn get_estimated_token_count(
        &self,
        turn_context: &TurnContext,
    ) -> Option<i64>
```

**Purpose**: Estimates the token count for the current history under a given turn context. The turn context includes model and feature details that can affect counting.

**Data flow**: It receives a TurnContext, locks state, asks history to estimate the token count for that context, and returns an optional count.

**Call relations**: Turn planning, compaction, or UI code can use this before sending work to the model.


##### `Session::get_base_instructions`  (lines 1194–1199)

```
async fn get_base_instructions(&self) -> BaseInstructions
```

**Purpose**: Returns the base instructions currently used by the session. These are the core directions given to the model before conversation-specific content.

**Data flow**: It locks state, clones the base instruction text from session configuration, wraps it in BaseInstructions, and returns it.

**Call relations**: Rollout reconstruction and token-usage recomputation use this when rebuilding or counting the model-visible history.

*Call graph*: called by 2 (apply_rollout_reconstruction, recompute_token_usage).


##### `Session::merge_connector_selection`  (lines 1202–1208)

```
async fn merge_connector_selection(
        &self,
        connector_ids: HashSet<String>,
    ) -> HashSet<String>
```

**Purpose**: Adds connector ids to the session’s selected connectors and returns the merged set. Connectors are external data or service integrations.

**Data flow**: It receives a set of connector ids, locks mutable state, merges them into the existing selection, and returns the resulting set.

**Call relations**: Connector-aware request paths use this when a turn or session adds more selected connectors.


##### `Session::get_connector_selection`  (lines 1211–1214)

```
async fn get_connector_selection(&self) -> HashSet<String>
```

**Purpose**: Returns the currently selected connector ids.

**Data flow**: It locks state, reads the connector-selection set, clones or builds the returned HashSet, and returns it.

**Call relations**: Connector-aware tools and UI code call this to know which connectors are active.


##### `Session::clear_connector_selection`  (lines 1217–1220)

```
async fn clear_connector_selection(&self)
```

**Purpose**: Clears all selected connectors for the session.

**Data flow**: It locks mutable state and tells state to empty the connector-selection set. It returns no value.

**Call relations**: Code that resets connector context calls this before future turns should stop using previous connector choices.


##### `Session::record_initial_history`  (lines 1222–1308)

```
async fn record_initial_history(&self, conversation_history: InitialHistory)
```

**Purpose**: Installs the starting conversation history for a new, resumed, cleared, or forked session. This is what makes a resumed thread remember what happened before.

**Data flow**: It checks whether the session is a subagent and whether prior user turns exist, updates first-turn state, then handles each InitialHistory case. New or cleared sessions defer initial context; resumed and forked sessions reconstruct history, seed token info from rollout events, warn if the saved model differs from the current model, persist forked items when needed, materialize storage, and flush rollout data for root sessions.

**Call relations**: Session startup calls this after creating the Session. It relies on apply_rollout_reconstruction, persistence helpers, and event sending to rebuild both internal state and user-visible warnings.

*Call graph*: calls 7 internal fn (apply_rollout_reconstruction, ensure_rollout_materialized, flush_rollout, persist_rollout_items, send_event, set_previous_turn_settings, initial_history_has_prior_user_turns); 4 external calls (last_token_info_from_rollout, format!, Warning, warn!).


##### `Session::apply_rollout_reconstruction`  (lines 1318–1359)

```
async fn apply_rollout_reconstruction(
        &self,
        turn_context: &TurnContext,
        rollout_items: &[RolloutItem],
    ) -> Option<PreviousTurnSettings>
```

**Purpose**: Rebuilds in-memory conversation history from saved rollout items. This is the core step that makes resume and fork behave as though the earlier conversation is present.

**Data flow**: It reconstructs history and previous turn settings from rollout items, optionally prepares old image items for the current image-resizing feature, installs the rebuilt history and compaction window into state, and may estimate prefix tokens for body-after-prefix compaction scope. It returns the previous turn settings it found.

**Call relations**: Session::record_initial_history calls this for resumed and forked sessions. It also feeds compaction state through Session::set_auto_compact_window_estimated_prefill_for_scope.

*Call graph*: calls 4 internal fn (prepare_response_items, clone_history, get_base_instructions, set_auto_compact_window_estimated_prefill_for_scope); called by 1 (record_initial_history); 1 external calls (matches!).


##### `Session::set_auto_compact_window_estimated_prefill_for_scope`  (lines 1361–1375)

```
async fn set_auto_compact_window_estimated_prefill_for_scope(
        &self,
        turn_context: &TurnContext,
        tokens: i64,
    )
```

**Purpose**: Stores the estimated prefix token count when the current compaction mode needs it. It does nothing for compaction modes that do not use this value.

**Data flow**: It receives a TurnContext and token count, checks whether the model auto-compact scope is BodyAfterPrefix, and if so locks state and stores the count.

**Call relations**: Rollout reconstruction and token-usage recomputation call this after estimating the relevant token prefix.

*Call graph*: called by 2 (apply_rollout_reconstruction, recompute_token_usage); 1 external calls (matches!).


##### `Session::last_token_info_from_rollout`  (lines 1377–1382)

```
fn last_token_info_from_rollout(rollout_items: &[RolloutItem]) -> Option<TokenUsageInfo>
```

**Purpose**: Finds the most recent token-count information saved in a rollout. This lets resumed and forked sessions show usage immediately.

**Data flow**: It scans rollout items backward, returns the first TokenCount event’s info it finds, or None if the rollout has no token-count event.

**Call relations**: Session::record_initial_history uses this when seeding token info for resumed or forked sessions.

*Call graph*: 1 external calls (iter).


##### `Session::previous_turn_settings`  (lines 1384–1387)

```
async fn previous_turn_settings(&self) -> Option<PreviousTurnSettings>
```

**Purpose**: Returns the settings used by the previous turn, if known. These settings help build a clear context update for the next turn.

**Data flow**: It locks state, reads previous_turn_settings, and returns the optional value.

**Call relations**: Context-building helpers use this to compare past and current settings. Session::set_previous_turn_settings and rollout reconstruction update the stored value.


##### `Session::set_previous_turn_settings`  (lines 1389–1395)

```
async fn set_previous_turn_settings(
        &self,
        previous_turn_settings: Option<PreviousTurnSettings>,
    )
```

**Purpose**: Stores the settings from the previous turn. This helps later turns explain what changed in model-visible context.

**Data flow**: It receives an optional PreviousTurnSettings value, locks mutable state, and replaces the stored previous-turn settings.

**Call relations**: Session::record_initial_history calls this for new or cleared histories, while reconstruction sets it for resumed or forked histories.

*Call graph*: called by 1 (record_initial_history).


##### `Session::update_settings`  (lines 1397–1435)

```
async fn update_settings(
        &self,
        updates: SessionSettingsUpdate,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies live setting changes to the session. It validates the requested update, notifies extensions if effective config changed, updates environment selections, and refreshes the network proxy when permissions change.

**Data flow**: It receives a SessionSettingsUpdate, locks state, attempts to apply the update to SessionConfiguration, builds previous and new effective configs if extension notification is needed, detects permission-profile changes, writes the updated configuration, emits config-change callbacks, and refreshes the managed network proxy if needed.

**Call relations**: Codex::set_app_server_client_info and other live configuration paths call this. It coordinates with emit_config_changed_contributors and refresh_managed_network_proxy_for_current_permission_profile.

*Call graph*: calls 2 internal fn (emit_config_changed_contributors, refresh_managed_network_proxy_for_current_permission_profile); 1 external calls (warn!).


##### `Session::preview_settings`  (lines 1437–1446)

```
async fn preview_settings(
        &self,
        updates: &SessionSettingsUpdate,
    ) -> ConstraintResult<ThreadConfigSnapshot>
```

**Purpose**: Shows what the thread configuration would look like after a settings update, without changing the live session.

**Data flow**: It receives a reference to SessionSettingsUpdate, locks state, applies the update to a copy of the configuration, converts the result to a ThreadConfigSnapshot, and returns either the snapshot or validation error.

**Call relations**: Configuration-preview APIs use this before committing changes through Session::update_settings.


##### `Session::set_session_startup_prewarm`  (lines 1448–1454)

```
async fn set_session_startup_prewarm(
        &self,
        startup_prewarm: SessionStartupPrewarmHandle,
    )
```

**Purpose**: Stores a startup prewarm handle on the session. A prewarm handle represents startup work prepared in advance for later use.

**Data flow**: It receives a SessionStartupPrewarmHandle, locks mutable state, and stores it.

**Call relations**: Startup optimization code can set this handle so later turn-start logic can take it.


##### `Session::take_session_startup_prewarm`  (lines 1456–1459)

```
async fn take_session_startup_prewarm(&self) -> Option<SessionStartupPrewarmHandle>
```

**Purpose**: Takes and removes the stored startup prewarm handle, if one exists.

**Data flow**: It locks mutable state, removes the handle from state, and returns it as Some or returns None if nothing was stored.

**Call relations**: Code that consumes prewarmed startup work uses this so the same handle is not reused twice.


##### `Session::get_config`  (lines 1461–1467)

```
async fn get_config(&self) -> std::sync::Arc<Config>
```

**Purpose**: Returns the session’s original configuration object. The name warns that callers should be careful because this is the stored configuration snapshot, not always a freshly derived view.

**Data flow**: It locks state, clones the Arc around original_config_do_not_use, and returns that shared configuration pointer.

**Call relations**: Internal code that needs the underlying Config uses this accessor. Runtime refresh functions update this stored Arc.


##### `Session::user_instructions`  (lines 1469–1477)

```
async fn user_instructions(&self) -> Option<codex_extension_api::UserInstructions>
```

**Purpose**: Returns user instructions loaded from agent instruction files, if present.

**Data flow**: It locks state, looks inside loaded_agents_md, asks it for user instructions, clones them if found, and returns the optional value.

**Call relations**: Turn-building or extension code can use this to include user-supplied instruction text.


##### `Session::provider`  (lines 1479–1482)

```
async fn provider(&self) -> ModelProviderInfo
```

**Purpose**: Returns the model provider information for the session.

**Data flow**: It locks state, clones the provider field from session configuration, and returns it.

**Call relations**: Model-calling code uses this to know which provider configuration the session is using.


##### `Session::refresh_runtime_config`  (lines 1484–1525)

```
async fn refresh_runtime_config(&self, next_config: Config)
```

**Purpose**: Refreshes runtime pieces of configuration for an existing session from a new Config snapshot. It preserves thread-local layers while updating the user layer and rebuilding caches and hooks.

**Data flow**: It takes a new Config, locks state, copies the current session config, replaces only the user-layer portion from the new snapshot, recomputes derived tool-suggestion config, stores the new Arc, notifies config contributors if effective config changed, clears skill and plugin caches, rebuilds hooks for the current environment, and publishes those hooks only if no newer refresh won the race.

**Call relations**: Session::reload_user_config_layer calls this after reading config files. Hosts that already have a materialized config snapshot can call this path directly.

*Call graph*: calls 3 internal fn (resolve_tool_suggest_config_from_layer_stack, emit_config_changed_contributors, build_hooks_for_config); called by 1 (reload_user_config_layer); 3 external calls (clone, new, ptr_eq).


##### `Session::emit_config_changed_contributors`  (lines 1527–1546)

```
fn emit_config_changed_contributors(
        &self,
        previous_config: Option<&Config>,
        new_config: Option<&Config>,
    )
```

**Purpose**: Notifies extension contributors when the effective configuration has changed. Extensions can use this to update their own behavior.

**Data flow**: It receives optional previous and new Config references, returns early if either is missing or they are equal, then calls on_config_changed for each registered config contributor with session and thread extension data.

**Call relations**: Session::update_settings and Session::refresh_runtime_config call this after they compute old and new effective configs.

*Call graph*: called by 2 (refresh_runtime_config, update_settings).


##### `Session::reload_user_config_layer`  (lines 1548–1616)

```
async fn reload_user_config_layer(&self)
```

**Purpose**: Reloads user configuration files from disk for an already running session. This supports legacy local flows where the host does not provide a ready-made new Config snapshot.

**Data flow**: It finds the user config TOML files from the current layer stack, falls back to codex_home/config.toml if none are listed, reads and parses each file, treats missing files as empty config, overlays the reloaded user configs onto a copy of the current config, recomputes tool-suggestion config, and calls Session::refresh_runtime_config.

**Call relations**: File-watch or manual reload paths call this. It delegates the actual runtime update, cache clearing, extension notification, and hook rebuild to Session::refresh_runtime_config.

*Call graph*: calls 2 internal fn (resolve_tool_suggest_config_from_layer_stack, refresh_runtime_config); 6 external calls (default, with_capacity, read_to_string, Table, vec!, warn!).


##### `Session::build_settings_update_items`  (lines 1618–1641)

```
async fn build_settings_update_items(
        &self,
        reference_context_item: Option<&TurnContextItem>,
        current_context: &TurnContext,
    ) -> Vec<ResponseItem>
```

**Purpose**: Builds model-visible response items that explain how settings changed for the current turn. This helps the model understand changes such as shell, execution policy, or personality behavior.

**Data flow**: It receives an optional reference context item and the current TurnContext, reads previous turn settings, current shell, current execution policy, and personality feature state, then delegates to the context manager to produce ResponseItems.

**Call relations**: Context-update recording calls this before setting the reference context item. It is the session-specific adapter around the shared context_manager update builder.

*Call graph*: calls 2 internal fn (build_settings_update_items, user_shell); called by 1 (record_context_updates_and_set_reference_context_item).


##### `Session::track_turn_codex_error`  (lines 1644–1652)

```
fn track_turn_codex_error(&self, turn_context: &TurnContext, error: &CodexErr)
```

**Purpose**: Records analytics for a Codex error that happened during a turn. Analytics here means structured facts used to understand failures.

**Data flow**: It receives the TurnContext and CodexErr, converts the error into a TurnCodexErrorFact with thread id and turn id, and sends it to the analytics events client.

**Call relations**: Turn execution code can call this when reporting errors so failures are visible outside the event stream.

*Call graph*: calls 1 internal fn (from_codex_err).


##### `Session::send_event`  (lines 1655–1695)

```
async fn send_event(&self, turn_context: &TurnContext, msg: EventMsg)
```

**Purpose**: Sends a high-level event for a turn and performs all side effects tied to event delivery. These include tracing, persistence, status updates, parent-agent notification, realtime mirroring, and legacy compatibility events.

**Data flow**: It receives a TurnContext and EventMsg, records terminal error text when the event affects turn status, records trace events, wraps the message in an Event, sends it through send_event_raw, maybe notifies a parent agent, maybe mirrors text to realtime output, maybe completes realtime handoff, and then emits any legacy-format events derived from the same message.

**Call relations**: Most turn-event helpers use this instead of sending directly. It coordinates with send_event_raw, maybe_notify_parent_of_terminal_turn, maybe_mirror_event_text_to_realtime, and maybe_clear_realtime_handoff_for_event.

*Call graph*: calls 5 internal fn (maybe_clear_realtime_handoff_for_event, maybe_mirror_event_text_to_realtime, maybe_notify_parent_of_terminal_turn, send_event_raw, show_raw_agent_reasoning); called by 13 (emit_model_verification, emit_turn_item_completed, emit_turn_item_started, emit_turn_moderation_metadata, maybe_warn_on_server_model_mismatch, notify_stream_error, record_initial_history, request_command_approval, request_patch_approval, request_permissions_for_environment (+3 more)); 1 external calls (clone).


##### `Session::maybe_notify_parent_of_terminal_turn`  (lines 1698–1744)

```
async fn maybe_notify_parent_of_terminal_turn(
        &self,
        turn_context: &TurnContext,
        msg: &EventMsg,
    )
```

**Purpose**: When a V2 subagent finishes, this decides whether to tell the parent agent about the result. It only acts on final turn-complete or turn-aborted events from spawned child agents.

**Data flow**: It checks the multi-agent version, event type, and session source. It derives a final AgentStatus, using any stored terminal error if present, updates the watched agent status for errors, and if the status is final forwards completion to the parent thread.

**Call relations**: Session::send_event calls this for every event. It delegates the actual parent message delivery to Session::forward_child_completion_to_parent.

*Call graph*: calls 2 internal fn (is_final, forward_child_completion_to_parent); called by 1 (send_event); 3 external calls (agent_status_from_event, matches!, Errored).


##### `Session::forward_child_completion_to_parent`  (lines 1747–1805)

```
async fn forward_child_completion_to_parent(
        &self,
        turn_context: &TurnContext,
        parent_thread_id: ThreadId,
        child_agent_path: &codex_protocol::AgentPath,
        status
```

**Purpose**: Sends a child-agent completion message back to its parent agent. This is how multi-agent work reports that a spawned child is done.

**Data flow**: It derives the parent agent path from the child path, formats a completion message for the status, creates an InterAgentCommunication that does not trigger a new turn, sends it through agent_control to the parent thread, and records a trace payload if tracing is enabled.

**Call relations**: Session::maybe_notify_parent_of_terminal_turn calls this after deciding a child-agent turn reached a final state.

*Call graph*: calls 3 internal fn (format_inter_agent_completion_message, as_str, new); called by 1 (maybe_notify_parent_of_terminal_turn); 3 external calls (new, debug!, clone).


##### `Session::maybe_mirror_event_text_to_realtime`  (lines 1807–1817)

```
async fn maybe_mirror_event_text_to_realtime(&self, msg: &EventMsg)
```

**Purpose**: Copies suitable event text into an active realtime conversation handoff. This lets normal session events also appear in realtime output streams.

**Data flow**: It asks whether the EventMsg has text suitable for realtime, checks that a realtime conversation is running, and sends the text through handoff_out, logging only if that fails.

**Call relations**: Session::send_event calls this after raw event delivery so realtime output stays in sync with the normal event stream.

*Call graph*: calls 1 internal fn (realtime_text_for_event); called by 1 (send_event); 1 external calls (debug!).


##### `Session::maybe_clear_realtime_handoff_for_event`  (lines 1819–1827)

```
async fn maybe_clear_realtime_handoff_for_event(&self, msg: &EventMsg)
```

**Purpose**: Ends the active realtime handoff when a turn completes. This prevents later output from being attached to a finished handoff.

**Data flow**: It ignores all events except TurnComplete. On completion, it tries to mark handoff output complete and then clears the active handoff state.

**Call relations**: Session::send_event calls this for every event, but it only acts at turn completion.

*Call graph*: called by 1 (send_event); 2 external calls (debug!, matches!).


##### `Session::send_event_raw`  (lines 1829–1837)

```
async fn send_event_raw(&self, event: Event)
```

**Purpose**: Persists and delivers an already-built event without the higher-level extras done by Session::send_event. It is the lower-level event output path.

**Data flow**: It wraps the event message as a rollout item, persists it, records the protocol event in the rollout trace, and passes the event to deliver_event_raw.

**Call relations**: Session::send_event and initial-context code call this when an Event is ready. It delegates the channel send and agent-status update to Session::deliver_event_raw.

*Call graph*: calls 2 internal fn (deliver_event_raw, persist_rollout_items); called by 2 (build_initial_context, send_event); 1 external calls (vec!).


##### `Session::deliver_event_raw`  (lines 1839–1847)

```
async fn deliver_event_raw(&self, event: Event)
```

**Purpose**: Actually sends an event into the session’s outgoing event channel. It also updates the last known agent status when the event carries one.

**Data flow**: It receives an Event, derives an AgentStatus from its message if possible and stores it, then sends the event on tx_event. If the receiver is gone, it logs that the event was dropped.

**Call relations**: Session::send_event_raw calls this after persistence and tracing. Codex::next_event reads from the receiving end of the same channel.

*Call graph*: called by 1 (send_event_raw); 2 external calls (agent_status_from_event, debug!).


##### `Session::emit_turn_item_started`  (lines 1849–1860)

```
async fn emit_turn_item_started(&self, turn_context: &TurnContext, item: &TurnItem)
```

**Purpose**: Emits an event saying a turn item has started. A turn item is a visible unit of work such as user input, model output, or a tool action.

**Data flow**: It receives the TurnContext and TurnItem, clones the item, stamps the current time in milliseconds, wraps it in ItemStartedEvent, and sends it through Session::send_event.

**Call relations**: Recording code calls this when it begins tracking a user prompt or response item.

*Call graph*: calls 2 internal fn (send_event, now_unix_timestamp_ms); called by 2 (record_response_item_and_emit_turn_item, record_user_prompt_and_emit_turn_item); 2 external calls (clone, ItemStarted).


##### `Session::emit_turn_item_completed`  (lines 1862–1878)

```
async fn emit_turn_item_completed(
        &self,
        turn_context: &TurnContext,
        item: TurnItem,
    )
```

**Purpose**: Emits an event saying a turn item has completed. It also records timing-to-first-model metrics when appropriate.

**Data flow**: It receives the TurnContext and finished TurnItem, records the turn timing metric, stamps the current time in milliseconds, wraps the item in ItemCompletedEvent, and sends it through Session::send_event.

**Call relations**: Recording code calls this after a user prompt or response item is fully recorded.

*Call graph*: calls 3 internal fn (send_event, now_unix_timestamp_ms, record_turn_ttfm_metric); called by 2 (record_response_item_and_emit_turn_item, record_user_prompt_and_emit_turn_item); 1 external calls (ItemCompleted).


##### `Session::persist_execpolicy_amendment`  (lines 1882–1900)

```
async fn persist_execpolicy_amendment(
        &self,
        amendment: &ExecPolicyAmendment,
    ) -> Result<(), ExecPolicyUpdateError>
```

**Purpose**: Saves an execution-policy amendment and updates the live execution policy. Execution policy is the rule set that controls command execution permissions.

**Data flow**: It receives an ExecPolicyAmendment, reads codex_home from session configuration, asks the exec policy service to append the amendment and update its current policy, and returns any update error.

**Call relations**: Approval flows call this when a user approves a new command-rule change that should persist.


##### `Session::turn_context_for_sub_id`  (lines 1902–1909)

```
async fn turn_context_for_sub_id(&self, sub_id: &str) -> Option<Arc<TurnContext>>
```

**Purpose**: Finds the active turn context with a given submission id. This lets later approval or policy messages attach to the correct turn.

**Data flow**: It locks active_turn, checks whether an active task exists, compares its turn_context.sub_id with the requested id, and returns a cloned Arc to the TurnContext if it matches.

**Call relations**: Policy-amendment message recorders call this before injecting a message into the current turn context.

*Call graph*: called by 2 (record_execpolicy_amendment_message, record_network_policy_amendment_message).


##### `Session::active_turn_context_and_cancellation_token`  (lines 1911–1920)

```
async fn active_turn_context_and_cancellation_token(
        &self,
    ) -> Option<(Arc<TurnContext>, CancellationToken)>
```

**Purpose**: Returns the active turn context together with a child cancellation token. A cancellation token is a signal that can stop async work.

**Data flow**: It locks active_turn, gets the active task if present, clones the TurnContext Arc, creates a child token from the task’s cancellation token, and returns both as an option.

**Call relations**: Internal control paths use this when they need to operate on or cancel the currently running turn.

*Call graph*: 1 external calls (clone).


##### `Session::record_execpolicy_amendment_message`  (lines 1922–1936)

```
async fn record_execpolicy_amendment_message(
        &self,
        sub_id: &str,
        amendment: &ExecPolicyAmendment,
    )
```

**Purpose**: Adds a model-visible message saying an approved command prefix was saved. This keeps the conversation context aware that the user changed execution permissions.

**Data flow**: It receives a turn id and amendment, formats the approved command prefix, builds an ApprovedCommandPrefixSaved response item, finds the matching turn context, and injects the item without starting a new turn. If no prefix can be formatted, it logs a warning and stops.

**Call relations**: Execution-policy approval flows call this after persisting an amendment so the active conversation transcript reflects the permission change.

*Call graph*: calls 4 internal fn (into, new, turn_context_for_sub_id, format_allow_prefixes); 2 external calls (vec!, warn!).


##### `Session::persist_network_policy_amendment`  (lines 1938–1989)

```
async fn persist_network_policy_amendment(
        &self,
        amendment: &NetworkPolicyAmendment,
        network_approval_context: &NetworkApprovalContext,
    ) -> anyhow::Result<()>
```

**Purpose**: Persists a network allow or deny rule and updates the running managed proxy when present. This makes a user-approved network decision take effect immediately and survive later policy reloads.

**Data flow**: It takes a proxy-refresh lock, validates that the amendment host matches the approved host, reads codex_home, converts the amendment into an execution-policy network rule, updates the live proxy allowlist or denylist if a proxy is running, then appends the network rule to the execution policy service.

**Call relations**: Network approval flows call this when the user chooses to save a network rule. It uses Session::validated_network_policy_amendment_host to guard against saving a rule for the wrong host.

*Call graph*: calls 1 internal fn (execpolicy_network_rule_amendment); 1 external calls (validated_network_policy_amendment_host).


##### `Session::validated_network_policy_amendment_host`  (lines 1991–2005)

```
fn validated_network_policy_amendment_host(
        amendment: &NetworkPolicyAmendment,
        network_approval_context: &NetworkApprovalContext,
    ) -> anyhow::Result<String>
```

**Purpose**: Checks that a network policy amendment applies to the same host the user approved. This prevents a saved rule from silently targeting a different domain.

**Data flow**: It normalizes the approved host and amendment host, compares them, returns the normalized approved host on match, or returns an error describing the mismatch.

**Call relations**: Session::persist_network_policy_amendment calls this before changing the live proxy or persistent execution policy.

*Call graph*: 2 external calls (anyhow!, normalize_host).


##### `Session::record_network_policy_amendment_message`  (lines 2007–2016)

```
async fn record_network_policy_amendment_message(
        &self,
        sub_id: &str,
        amendment: &NetworkPolicyAmendment,
    )
```

**Purpose**: Adds a model-visible message saying a network rule was saved. This lets the ongoing turn know that network permissions changed.

**Data flow**: It receives a turn id and NetworkPolicyAmendment, builds a NetworkRuleSaved response item, finds the active turn context for the id, and injects the message without starting a new turn.

**Call relations**: Network approval flows call this after saving a rule, similar to how command-policy amendments are recorded.

*Call graph*: calls 3 internal fn (into, new, turn_context_for_sub_id); 1 external calls (vec!).


##### `Session::request_command_approval`  (lines 2033–2103)

```
async fn request_command_approval(
        &self,
        turn_context: &TurnContext,
        call_id: String,
        approval_id: Option<String>,
        command: Vec<String>,
        cwd: AbsoluteP
```

**Purpose**: Asks the client or reviewer whether a proposed shell command may run. It records a pending approval first, so the later answer can be delivered back to the task that is waiting.

**Data flow**: It receives the turn, command details, working directory, reason, optional network and permission details, and possible decisions. It stores a reply channel under the approval id, builds an approval request event with a timestamp and parsed command, sends it out, then waits for the answer; if the answer path closes, it returns Abort.

**Call relations**: This is the request side of the approval flow. Later, Session::notify_approval removes the matching pending approval and sends the ReviewDecision back through the waiting channel.

*Call graph*: calls 3 internal fn (send_event, now_unix_timestamp_ms, parse_command); 3 external calls (channel, ExecApprovalRequest, warn!).


##### `Session::request_patch_approval`  (lines 2109–2144)

```
async fn request_patch_approval(
        &self,
        turn_context: &TurnContext,
        call_id: String,
        changes: HashMap<PathBuf, FileChange>,
        reason: Option<String>,
        gran
```

**Purpose**: Asks whether a proposed file patch may be applied. It lets the assistant pause before changing files and wait for a human or reviewer decision.

**Data flow**: It receives the call id, file changes, reason, and optional grant root. It stores a reply channel in the active turn, sends an ApplyPatchApprovalRequest event, and returns the receiver so the caller can await the decision.

**Call relations**: Like command approval, this creates a pending approval entry before notifying the client. Session::notify_approval is the matching completion path that resolves the waiting receiver.

*Call graph*: calls 2 internal fn (send_event, now_unix_timestamp_ms); 3 external calls (channel, ApplyPatchApprovalRequest, warn!).


##### `Session::request_permissions_for_environment`  (lines 2150–2316)

```
async fn request_permissions_for_environment(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        call_id: String,
        args: RequestPermissionsArgs,
        environment: Tur
```

**Purpose**: Requests extra permissions for a specific turn environment, such as broader file or network access. It also enforces safety rules around when permission requests are allowed and how much can be granted.

**Data flow**: It receives the requested permissions, environment, turn, call id, and cancellation token. It may immediately return empty permissions if policy forbids asking, may route the request through Guardian review, or may send a RequestPermissions event and wait for a response; before returning, it normalizes the response and records any granted permissions.

**Call relations**: Session::request_permissions_for_cwd calls this after choosing an environment and setting its current directory. It uses Session::normalize_request_permissions_response to limit grants and Session::record_granted_request_permissions_for_turn to remember approved permissions.

*Call graph*: calls 3 internal fn (record_granted_request_permissions_for_turn, send_event, now_unix_timestamp_ms); called by 1 (request_permissions_for_cwd); 12 external calls (clone, clone, normalize_request_permissions_response, default, new_guardian_review_id, routes_approval_to_guardian, spawn_approval_request_review, channel, RequestPermissions, clone (+2 more)).


##### `Session::request_permissions_for_cwd`  (lines 2318–2351)

```
async fn request_permissions_for_cwd(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        call_id: String,
        args: RequestPermissionsArgs,
        cwd: AbsolutePathBuf,
```

**Purpose**: Convenience wrapper that asks for permissions relative to a given current working directory. It finds the right environment first, then delegates the real request.

**Data flow**: It receives permission request arguments, a directory, and a cancellation token. It selects the named environment or the primary one, replaces that environment’s current directory with the provided path, and returns the result from Session::request_permissions_for_environment; if no environment exists, it returns an empty turn-scoped grant.

**Call relations**: This is a small adapter in front of Session::request_permissions_for_environment. It exists so callers that only know a working directory do not have to build a full environment selection themselves.

*Call graph*: calls 2 internal fn (request_permissions_for_environment, from_abs_path); 1 external calls (default).


##### `Session::request_user_input`  (lines 2357–2391)

```
async fn request_user_input(
        &self,
        turn_context: &TurnContext,
        call_id: String,
        args: RequestUserInputArgs,
    ) -> Option<RequestUserInputResponse>
```

**Purpose**: Asks the user one or more questions during a turn and waits for their response. This is used when the assistant needs information before it can continue.

**Data flow**: It receives a call id and user-input request arguments. It stores a response channel keyed by the turn id, marks that user input was requested during the turn, sends a RequestUserInput event, then waits for the response and returns it if one arrives.

**Call relations**: This is paired with Session::notify_user_input_response. The request function creates the pending slot; the notify function fills it when the client replies.

*Call graph*: calls 1 internal fn (send_event); 3 external calls (channel, RequestUserInput, warn!).


##### `Session::notify_user_input_response`  (lines 2397–2420)

```
async fn notify_user_input_response(
        &self,
        sub_id: &str,
        response: RequestUserInputResponse,
    )
```

**Purpose**: Delivers a user-input answer back to the turn that asked for it. It prevents replies from being lost by looking up the waiting request by turn id.

**Data flow**: It receives a turn id and response. It removes the matching pending user-input sender from active turn state, sends the response through it, or logs a warning if nothing was waiting.

**Call relations**: This completes the flow started by Session::request_user_input. It is called when an outside client reports the user’s answer.

*Call graph*: 1 external calls (warn!).


##### `Session::notify_request_permissions_response`  (lines 2426–2477)

```
async fn notify_request_permissions_response(
        &self,
        call_id: &str,
        response: RequestPermissionsResponse,
    )
```

**Purpose**: Delivers a permission-request answer back to the waiting task. It also checks that the answer is safe before recording or returning it.

**Data flow**: It receives a call id and response. It removes the pending permission request, converts the environment directory to a local path, normalizes the response so it cannot exceed what was requested, records granted permissions, and sends the final response back through the waiting channel.

**Call relations**: This completes the non-Guardian path started by Session::request_permissions_for_environment. It uses Session::normalize_request_permissions_response and Session::record_granted_request_permissions_for_turn before waking the requester.

*Call graph*: calls 1 internal fn (record_granted_request_permissions_for_turn); 3 external calls (normalize_request_permissions_response, default, warn!).


##### `Session::normalize_request_permissions_response`  (lines 2479–2506)

```
fn normalize_request_permissions_response(
        requested_permissions: RequestPermissionProfile,
        response: RequestPermissionsResponse,
        cwd: &Path,
    ) -> RequestPermissionsRespons
```

**Purpose**: Cleans up a permission response so it follows the rules. Most importantly, it prevents granting permissions that were not actually requested.

**Data flow**: It receives the requested permissions, the proposed response, and the working directory. It rejects invalid session-wide strict auto-review grants, leaves empty grants alone, and otherwise intersects the requested and granted profiles, returning a safer response.

**Call relations**: Session::request_permissions_for_environment and Session::notify_request_permissions_response both call this before recording or returning granted permissions.

*Call graph*: calls 1 internal fn (intersect_permission_profiles); 3 external calls (default, into, matches!).


##### `Session::record_granted_request_permissions_for_turn`  (lines 2508–2537)

```
async fn record_granted_request_permissions_for_turn(
        &self,
        response: &RequestPermissionsResponse,
        environment_id: &str,
        originating_turn_state: Option<&Arc<Mutex<crat
```

**Purpose**: Stores newly granted permissions in the right place: either only for the current turn or for the whole session. This lets later tool calls know what has already been approved.

**Data flow**: It receives a permission response, environment id, and optional turn state. If the grant is empty it does nothing; turn-scoped grants go into the active turn state, while session-scoped grants go into session state.

**Call relations**: It is called after permission responses are normalized in Session::request_permissions_for_environment and Session::notify_request_permissions_response.

*Call graph*: called by 2 (notify_request_permissions_response, request_permissions_for_environment).


##### `Session::granted_turn_permissions`  (lines 2543–2551)

```
async fn granted_turn_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Looks up permissions granted only for the current turn and environment. Callers use this to decide whether a tool action is already allowed.

**Data flow**: It receives an environment id. It reads the active turn state, asks for that environment’s granted permissions, and returns them if there is an active turn and a grant exists.

**Call relations**: This is a read-side helper for the permission system. It reflects grants recorded by Session::record_granted_request_permissions_for_turn.


##### `Session::strict_auto_review_enabled_for_turn`  (lines 2557–2564)

```
async fn strict_auto_review_enabled_for_turn(&self) -> bool
```

**Purpose**: Reports whether the current turn has strict automatic review enabled. This flag affects how later actions are checked during the same turn.

**Data flow**: It reads the active turn state. If there is no active turn it returns false; otherwise it returns the turn state’s strict-auto-review flag.

**Call relations**: The flag can be enabled when Session::record_granted_request_permissions_for_turn records a turn-scoped response with strict auto-review.


##### `Session::granted_session_permissions`  (lines 2566–2572)

```
async fn granted_session_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Looks up permissions that were granted for the whole session in a given environment. These grants survive beyond a single turn.

**Data flow**: It receives an environment id, reads session state, and returns any saved permission profile for that environment.

**Call relations**: This is the read-side companion to session-scoped writes in Session::record_granted_request_permissions_for_turn.


##### `Session::notify_dynamic_tool_response`  (lines 2578–2597)

```
async fn notify_dynamic_tool_response(&self, call_id: &str, response: DynamicToolResponse)
```

**Purpose**: Delivers a response from a dynamically provided tool back to the waiting turn. It matches the response by call id.

**Data flow**: It receives a call id and tool response. It removes the pending dynamic-tool sender from active turn state, sends the response through it, or logs a warning if no matching call is pending.

**Call relations**: This is the completion path for a dynamic tool call that was earlier registered in turn state elsewhere in the session flow.

*Call graph*: 1 external calls (warn!).


##### `Session::notify_approval`  (lines 2603–2622)

```
async fn notify_approval(&self, approval_id: &str, decision: ReviewDecision)
```

**Purpose**: Delivers an approval decision, such as approve, deny, or abort, back to the command or patch request that is waiting. It is the common reply path for approval prompts.

**Data flow**: It receives an approval id and decision. It removes the matching pending approval from active turn state and sends the decision through the stored channel, or logs a warning if there is no match.

**Call relations**: This completes approvals started by Session::request_command_approval and Session::request_patch_approval.

*Call graph*: 1 external calls (warn!).


##### `Session::prepare_conversation_items_for_history`  (lines 2626–2638)

```
fn prepare_conversation_items_for_history(
        &self,
        turn_context: &TurnContext,
        items: &'a [ResponseItem],
    ) -> Cow<'a, [ResponseItem]>
```

**Purpose**: Prepares response items before they are stored in conversation history. When image resizing is enabled, it copies and adjusts items so stored history uses the prepared form.

**Data flow**: It receives a turn and a slice of response items. If the ResizeAllImages feature is off, it returns a borrowed view of the original items; if on, it clones the items, prepares them, and returns the owned copy.

**Call relations**: Session::record_conversation_items and Session::record_inter_agent_communication call this before adding items to history and persistence.

*Call graph*: calls 1 internal fn (prepare_response_items); called by 2 (record_conversation_items, record_inter_agent_communication); 3 external calls (Borrowed, Owned, to_vec).


##### `Session::response_item_from_user_input`  (lines 2640–2654)

```
fn response_item_from_user_input(
        &self,
        turn_context: &TurnContext,
        input: Vec<UserInput>,
    ) -> ResponseItem
```

**Purpose**: Converts raw user input into the model-facing response item format. It decides whether image processing happens now or is deferred, based on the image-resizing feature.

**Data flow**: It receives a turn and user input list. It chooses local image preparation mode, converts the user input into a ResponseInputItem, wraps it as a ResponseItem, and returns it.

**Call relations**: Session::record_user_prompt_and_emit_turn_item calls this before recording the user message in conversation history.

*Call graph*: calls 2 internal fn (from_user_input, from); called by 1 (record_user_prompt_and_emit_turn_item).


##### `Session::record_conversation_items`  (lines 2656–2669)

```
async fn record_conversation_items(
        &self,
        turn_context: &TurnContext,
        items: &[ResponseItem],
    )
```

**Purpose**: Adds model-visible items to the conversation record, persists them to the rollout transcript, and emits them to the client as raw response items. This keeps memory, disk, and client view aligned.

**Data flow**: It receives a turn and response items. It prepares them for history, records them in session state using the turn’s truncation policy, persists them as rollout response items, and sends each raw item event.

**Call relations**: Several higher-level flows call this, including recording user prompts, model response items, and context updates. It delegates persistence to Session::persist_rollout_response_items and event emission to Session::send_raw_response_items.

*Call graph*: calls 3 internal fn (persist_rollout_response_items, prepare_conversation_items_for_history, send_raw_response_items); called by 3 (record_context_updates_and_set_reference_context_item, record_response_item_and_emit_turn_item, record_user_prompt_and_emit_turn_item); 2 external calls (as_ref, iter).


##### `Session::record_inter_agent_communication`  (lines 2671–2689)

```
async fn record_inter_agent_communication(
        &self,
        turn_context: &TurnContext,
        communication: InterAgentCommunication,
    )
```

**Purpose**: Records a message exchanged between agents as part of the conversation. This makes inter-agent communication visible to history and durable rollout logs.

**Data flow**: It receives an InterAgentCommunication value. It converts it to a model input item, prepares it for history, records it in state, persists the communication as a rollout item, and emits the raw response item.

**Call relations**: It follows the same history path as Session::record_conversation_items, but persists a specialized InterAgentCommunication rollout item.

*Call graph*: calls 4 internal fn (persist_rollout_items, prepare_conversation_items_for_history, send_raw_response_items, to_model_input_item); 2 external calls (InterAgentCommunication, from_ref).


##### `Session::maybe_warn_on_server_model_mismatch`  (lines 2691–2728)

```
async fn maybe_warn_on_server_model_mismatch(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        server_model: String,
    ) -> bool
```

**Purpose**: Checks whether the server used a different model than the one requested and warns the client if so. This is important because model rerouting changes what the user is actually getting.

**Data flow**: It receives the server-reported model. It compares it case-insensitively with the requested model; if they match it returns false, and if not it sends a ModelReroute event plus a warning message and returns true.

**Call relations**: This is used after server model information is known. It hands off user-visible reporting through Session::send_event.

*Call graph*: calls 1 internal fn (send_event); 5 external calls (format!, info!, ModelReroute, Warning, warn!).


##### `Session::emit_model_verification`  (lines 2730–2740)

```
async fn emit_model_verification(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        verifications: Vec<ModelVerification>,
    )
```

**Purpose**: Sends model verification information to the client. This lets the UI or caller show evidence about the model used for a turn.

**Data flow**: It receives a list of model verifications, wraps them in a ModelVerification event, and sends the event for the current turn.

**Call relations**: This is a direct event-emission helper built on Session::send_event.

*Call graph*: calls 1 internal fn (send_event); 1 external calls (ModelVerification).


##### `Session::emit_turn_moderation_metadata`  (lines 2742–2749)

```
async fn emit_turn_moderation_metadata(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        metadata: TurnModerationMetadataEvent,
    )
```

**Purpose**: Sends moderation-related metadata for a turn to the client. This exposes safety or policy metadata without changing the conversation history.

**Data flow**: It receives a moderation metadata event value, wraps it as the corresponding session event, and sends it to the client.

**Call relations**: This is another focused wrapper around Session::send_event for turn metadata.

*Call graph*: calls 1 internal fn (send_event); 1 external calls (TurnModerationMetadata).


##### `Session::replace_history`  (lines 2752–2759)

```
async fn replace_history(
        &self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
    )
```

**Purpose**: Replaces the in-memory conversation history with a new list of response items. This is used when the session needs to reset its model context baseline.

**Data flow**: It receives replacement items and an optional reference context item. It locks session state and swaps the stored history and reference context.

**Call relations**: This is a low-level state update used by higher-level context reconstruction or compaction flows.


##### `Session::replace_compacted_history`  (lines 2761–2782)

```
async fn replace_compacted_history(
        &self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
        compacted_item: CompactedItem,
    )
```

**Purpose**: Replaces history after compaction and records that compaction in the rollout transcript. Compaction shrinks old context into a smaller form so the conversation can continue within the model’s limits.

**Data flow**: It receives replacement history, an optional reference context item, and the compacted item. It updates state, persists the compacted rollout item and reference context when present, then queues a session-start source that says the next start came from compaction.

**Call relations**: It uses Session::persist_rollout_items to make the compaction durable and updates state for later session-start hooks.

*Call graph*: calls 1 internal fn (persist_rollout_items); 2 external calls (Compacted, TurnContext).


##### `Session::persist_rollout_response_items`  (lines 2784–2791)

```
async fn persist_rollout_response_items(&self, items: &[ResponseItem])
```

**Purpose**: Converts regular response items into rollout items and persists them. A rollout is the durable transcript used to recover or inspect a session later.

**Data flow**: It receives response items, clones each into a RolloutItem::ResponseItem, and passes the list to Session::persist_rollout_items.

**Call relations**: Session::record_conversation_items calls this after updating in-memory history.

*Call graph*: calls 1 internal fn (persist_rollout_items); called by 1 (record_conversation_items); 1 external calls (iter).


##### `Session::enabled`  (lines 2793–2795)

```
fn enabled(&self, feature: Feature) -> bool
```

**Purpose**: Answers whether a feature flag is enabled for this session. Feature flags turn optional behavior on or off.

**Data flow**: It receives a Feature value, checks the session’s managed feature set, and returns true or false.

**Call relations**: This is a small public convenience around the session’s feature store.


##### `Session::features`  (lines 2797–2799)

```
fn features(&self) -> ManagedFeatures
```

**Purpose**: Returns the session’s managed feature set. Callers use it when they need more than a single yes-or-no feature check.

**Data flow**: It reads the session’s feature holder, clones it, and returns the clone.

**Call relations**: This exposes feature configuration to other session code without giving them direct ownership of the original field.


##### `Session::collaboration_mode`  (lines 2801–2804)

```
async fn collaboration_mode(&self) -> CollaborationMode
```

**Purpose**: Returns the current collaboration mode, which describes how the assistant should work with the user or other agents. This may affect instructions and behavior.

**Data flow**: It locks session state, reads the session configuration’s collaboration mode, clones it, and returns it.

**Call relations**: This is a read helper for code that needs the current collaboration policy.


##### `Session::multi_agent_version`  (lines 2806–2808)

```
fn multi_agent_version(&self) -> Option<MultiAgentVersion>
```

**Purpose**: Returns the multi-agent protocol version already chosen for this session, if one has been set. This keeps a session from switching versions halfway through.

**Data flow**: It reads the once-initialized multi-agent version slot and returns a copied value if present.

**Call relations**: Session::resolve_multi_agent_version_for_model calls this before deciding a new version.

*Call graph*: called by 1 (resolve_multi_agent_version_for_model).


##### `Session::set_multi_agent_version_if_unset`  (lines 2810–2815)

```
fn set_multi_agent_version_if_unset(
        &self,
        multi_agent_version: MultiAgentVersion,
    ) -> MultiAgentVersion
```

**Purpose**: Sets the session’s multi-agent version only if it has not already been chosen. If another value was already set, that existing value wins.

**Data flow**: It receives a proposed version, initializes the stored value if empty, and returns the stored version.

**Call relations**: Session::resolve_multi_agent_version_for_model calls this after selecting the best version from model or config.

*Call graph*: called by 1 (resolve_multi_agent_version_for_model).


##### `Session::resolve_multi_agent_version_for_model`  (lines 2817–2831)

```
fn resolve_multi_agent_version_for_model(
        &self,
        model_info: &ModelInfo,
        config: &Config,
    ) -> MultiAgentVersion
```

**Purpose**: Chooses the multi-agent version for the session using the model’s preference first, then configuration defaults. It also locks that choice in for future calls.

**Data flow**: It receives model info and config. If a version is already set it returns it; otherwise it selects the model-provided version or config-derived version and stores it if unset.

**Call relations**: It coordinates Session::multi_agent_version and Session::set_multi_agent_version_if_unset.

*Call graph*: calls 2 internal fn (multi_agent_version, set_multi_agent_version_if_unset).


##### `Session::send_raw_response_items`  (lines 2833–2841)

```
async fn send_raw_response_items(&self, turn_context: &TurnContext, items: &[ResponseItem])
```

**Purpose**: Sends each response item to the client as a raw event. This gives consumers a faithful stream of the model-visible conversation items.

**Data flow**: It receives a turn and response items. For each item, it clones the item, wraps it in a RawResponseItem event, and sends it.

**Call relations**: Session::record_conversation_items and Session::record_inter_agent_communication call this after recording history.

*Call graph*: calls 1 internal fn (send_event); called by 2 (record_conversation_items, record_inter_agent_communication); 1 external calls (RawResponseItem).


##### `Session::build_initial_context`  (lines 2843–3077)

```
async fn build_initial_context(
        &self,
        turn_context: &TurnContext,
    ) -> Vec<ResponseItem>
```

**Purpose**: Builds the initial set of model-visible context messages for a turn or new context window. These messages tell the model about permissions, environment, apps, skills, plugins, personality, collaboration mode, and other session facts.

**Data flow**: It reads session state, turn configuration, feature flags, connectors, skills, plugins, extension contributors, shell information, and environment data. It gathers text sections into developer and contextual-user messages, emits warnings when needed, and returns response items that should be inserted into history.

**Call relations**: Session::maybe_start_new_context_window and Session::record_context_updates_and_set_reference_context_item call this when full context needs to be injected. It is the main assembler for the session’s starting prompt material.

*Call graph*: calls 19 internal fn (list_accessible_and_enabled_connectors_from_manager, from_connectors, from_plugins, from, from_collaboration_mode, from_turn_context, new, new, build_contextual_user_message, build_developer_update_item (+9 more)); called by 2 (maybe_start_new_context_window, record_context_updates_and_set_reference_context_item); 9 external calls (new, new, with_capacity, with_capacity, build_available_skills, default_skill_metadata_budget, is_guardian_reviewer_source, Warning, vec!).


##### `Session::persist_rollout_items`  (lines 3079–3085)

```
async fn persist_rollout_items(&self, items: &[RolloutItem])
```

**Purpose**: Appends rollout items to the live thread transcript if one exists. This is the durable write path for history and session events that should survive later inspection or recovery.

**Data flow**: It receives rollout items. It asks for the live thread, appends the items when available, and logs an error if the append fails.

**Call relations**: Many history and context flows call this, including response persistence, compaction, initial history, context updates, and raw event persistence.

*Call graph*: calls 1 internal fn (live_thread); called by 7 (maybe_start_new_context_window, persist_rollout_response_items, record_context_updates_and_set_reference_context_item, record_initial_history, record_inter_agent_communication, replace_compacted_history, send_event_raw); 1 external calls (error!).


##### `Session::clone_history`  (lines 3087–3090)

```
async fn clone_history(&self) -> ContextManager
```

**Purpose**: Returns a copy of the current conversation history manager. This lets other code inspect or estimate history without holding the session lock.

**Data flow**: It locks session state, clones the history object, and returns the clone.

**Call relations**: Session::recompute_token_usage and rollout reconstruction code use this to work from a snapshot.

*Call graph*: called by 2 (apply_rollout_reconstruction, recompute_token_usage).


##### `Session::current_window_id`  (lines 3092–3097)

```
async fn current_window_id(&self) -> String
```

**Purpose**: Builds a human-readable id for the current context window. It combines the thread id with the auto-compaction window number.

**Data flow**: It reads session state for the current window number, combines it with the thread id, and returns a string like thread:window.

**Call relations**: This is a small reporting helper for code that needs to identify the active context window.

*Call graph*: 1 external calls (format!).


##### `Session::advance_auto_compact_window_id`  (lines 3099–3102)

```
async fn advance_auto_compact_window_id(&self) -> u64
```

**Purpose**: Moves the auto-compaction window counter forward. This marks that a new context window should be identified separately from the previous one.

**Data flow**: It locks mutable session state, advances the stored window id, and returns the new number.

**Call relations**: This supports the broader context-compaction lifecycle.


##### `Session::request_new_context_window`  (lines 3104–3107)

```
async fn request_new_context_window(&self)
```

**Purpose**: Marks that the session should start a fresh context window soon. It does not rebuild immediately; it sets a request flag in state.

**Data flow**: It locks session state and records that a new context window has been requested.

**Call relations**: Session::maybe_start_new_context_window later consumes this request and performs the rebuild.


##### `Session::maybe_start_new_context_window`  (lines 3109–3140)

```
async fn maybe_start_new_context_window(
        &self,
        turn_context: &TurnContext,
    ) -> Option<u64>
```

**Purpose**: Starts a new context window if one was requested. This resets model-visible history to fresh context messages and records the compaction event.

**Data flow**: It asks state whether a new window should start. If not, it returns None; if yes, it builds initial context, replaces history, persists a compacted item plus turn context, queues a compact session-start source, recomputes token usage, and returns the new window id.

**Call relations**: It consumes requests made by Session::request_new_context_window and relies on Session::build_initial_context, Session::persist_rollout_items, and Session::recompute_token_usage.

*Call graph*: calls 4 internal fn (build_initial_context, persist_rollout_items, recompute_token_usage, to_turn_context_item); 3 external calls (new, Compacted, TurnContext).


##### `Session::reference_context_item`  (lines 3142–3145)

```
async fn reference_context_item(&self) -> Option<TurnContextItem>
```

**Purpose**: Returns the current reference context item used as the baseline for context diffs. This helps decide what has changed between turns.

**Data flow**: It locks session state, clones or retrieves the stored reference context item, and returns it.

**Call relations**: This is a read helper for context-management code.


##### `Session::record_context_updates_and_set_reference_context_item`  (lines 3161–3191)

```
async fn record_context_updates_and_set_reference_context_item(
        &self,
        turn_context: &TurnContext,
    )
```

**Purpose**: Adds the right context messages for a turn and updates the stored baseline used for future diffs. On the first turn it injects full context; later it only records changes.

**Data flow**: It reads the old reference context item. If none exists it builds initial context; otherwise it builds settings-update items, records any resulting conversation items, persists the current turn context item, and updates state’s reference context item.

**Call relations**: It uses Session::build_initial_context for full setup, build_settings_update_items for steady-state diffs, Session::record_conversation_items for model-visible updates, and Session::persist_rollout_items for durable turn context.

*Call graph*: calls 5 internal fn (build_initial_context, build_settings_update_items, persist_rollout_items, record_conversation_items, to_turn_context_item); 1 external calls (TurnContext).


##### `Session::update_token_usage_info`  (lines 3193–3201)

```
async fn update_token_usage_info(
        &self,
        turn_context: &TurnContext,
        token_usage: Option<&TokenUsage>,
    )
```

**Purpose**: Updates token usage information and tells the client the latest count. Tokens are the chunks of text the model consumes and produces.

**Data flow**: It receives optional token usage from a model response. It records the usage in state, then sends a TokenCount event with current token and rate-limit data.

**Call relations**: It coordinates Session::record_token_usage_info and Session::send_token_count_event.

*Call graph*: calls 2 internal fn (record_token_usage_info, send_token_count_event).


##### `Session::record_token_usage_info`  (lines 3203–3234)

```
async fn record_token_usage_info(
        &self,
        turn_context: &TurnContext,
        token_usage: Option<&TokenUsage>,
    )
```

**Purpose**: Stores token usage from the latest model call and notifies extension contributors. This keeps internal accounting and plugin-like observers up to date.

**Data flow**: If token usage is present, it updates session token info using the turn’s model context window, may update auto-compaction prefill data, then passes the resulting token info to registered token-usage contributors.

**Call relations**: Session::update_token_usage_info calls this before sending the user-visible token-count event.

*Call graph*: calls 1 internal fn (model_context_window); called by 1 (update_token_usage_info); 1 external calls (matches!).


##### `Session::recompute_token_usage`  (lines 3236–3272)

```
async fn recompute_token_usage(&self, turn_context: &TurnContext)
```

**Purpose**: Re-estimates token usage from the current saved history when there is no fresh server count, such as after compaction. This gives the client and auto-compaction logic a reasonable updated count.

**Data flow**: It clones history, reads base instructions, estimates token count, writes a synthetic token usage record into state, updates auto-compaction prefill estimates, and sends a token-count event.

**Call relations**: Session::maybe_start_new_context_window calls this after replacing history.

*Call graph*: calls 5 internal fn (clone_history, get_base_instructions, send_token_count_event, set_auto_compact_window_estimated_prefill_for_scope, model_context_window); called by 1 (maybe_start_new_context_window); 1 external calls (default).


##### `Session::update_rate_limits`  (lines 3274–3281)

```
async fn update_rate_limits(
        &self,
        turn_context: &TurnContext,
        new_rate_limits: RateLimitSnapshot,
    )
```

**Purpose**: Stores new rate-limit information and sends an updated token-count event. Rate limits describe how much usage is still allowed by the service.

**Data flow**: It receives a rate-limit snapshot, records it in session state, then emits the combined token and rate-limit status.

**Call relations**: It coordinates Session::record_rate_limits_info and Session::send_token_count_event.

*Call graph*: calls 2 internal fn (record_rate_limits_info, send_token_count_event).


##### `Session::record_rate_limits_info`  (lines 3283–3288)

```
async fn record_rate_limits_info(&self, new_rate_limits: RateLimitSnapshot)
```

**Purpose**: Stores the latest rate-limit snapshot in session state. This separates the state write from later event emission.

**Data flow**: It receives a RateLimitSnapshot, locks mutable session state, and replaces the stored rate-limit data.

**Call relations**: Session::update_rate_limits calls this before notifying the client.

*Call graph*: called by 1 (update_rate_limits).


##### `Session::mcp_dependency_prompted`  (lines 3290–3293)

```
async fn mcp_dependency_prompted(&self) -> HashSet<String>
```

**Purpose**: Returns the set of MCP dependencies that have already prompted the user. MCP here means Model Context Protocol, a way to connect external tools or services.

**Data flow**: It locks session state, reads the recorded dependency names, and returns the set.

**Call relations**: This is a read helper paired with Session::record_mcp_dependency_prompted.


##### `Session::record_mcp_dependency_prompted`  (lines 3295–3301)

```
async fn record_mcp_dependency_prompted(&self, names: I)
```

**Purpose**: Records MCP dependency names that have already shown a prompt. This avoids prompting repeatedly for the same dependency.

**Data flow**: It receives an iterable collection of names, locks session state, and adds them to the prompted set.

**Call relations**: This is the write-side companion to Session::mcp_dependency_prompted.


##### `Session::set_server_reasoning_included`  (lines 3303–3306)

```
async fn set_server_reasoning_included(&self, included: bool)
```

**Purpose**: Records whether server-provided reasoning was included. This affects how later state or reporting understands the response stream.

**Data flow**: It receives a boolean, locks session state, and stores that boolean.

**Call relations**: This is a simple state-setting helper used by response-processing code elsewhere in the session.


##### `Session::send_token_count_event`  (lines 3308–3315)

```
async fn send_token_count_event(&self, turn_context: &TurnContext)
```

**Purpose**: Sends the current token and rate-limit status to the client. This keeps the UI informed about context usage and service limits.

**Data flow**: It reads token info and rate limits from state, wraps them in a TokenCount event, and sends it for the turn.

**Call relations**: Session::update_token_usage_info, Session::recompute_token_usage, Session::update_rate_limits, and Session::set_total_tokens_full call this after changing accounting data.

*Call graph*: calls 1 internal fn (send_event); called by 4 (recompute_token_usage, set_total_tokens_full, update_rate_limits, update_token_usage_info); 1 external calls (TokenCount).


##### `Session::set_total_tokens_full`  (lines 3317–3323)

```
async fn set_total_tokens_full(&self, turn_context: &TurnContext)
```

**Purpose**: Marks token usage as full for the model’s context window and reports that to the client. This is used when the session knows the context is at capacity.

**Data flow**: It checks the turn’s model context window. If present, it updates state to say token usage is full, then sends a token-count event.

**Call relations**: It uses Session::send_token_count_event for the reporting side.

*Call graph*: calls 2 internal fn (send_token_count_event, model_context_window).


##### `Session::record_response_item_and_emit_turn_item`  (lines 3325–3339)

```
async fn record_response_item_and_emit_turn_item(
        &self,
        turn_context: &TurnContext,
        response_item: ResponseItem,
    )
```

**Purpose**: Records one response item and emits higher-level turn-item lifecycle events when the item can be interpreted that way. This keeps history and UI activity in sync.

**Data flow**: It receives a response item, records it into conversation history, then tries to parse it into a turn item. If parsing succeeds, it emits started and completed events for that turn item.

**Call relations**: It builds on Session::record_conversation_items and the turn-item emitters elsewhere in the session.

*Call graph*: calls 3 internal fn (emit_turn_item_completed, emit_turn_item_started, record_conversation_items); 2 external calls (parse_turn_item, from_ref).


##### `Session::record_user_prompt_and_emit_turn_item`  (lines 3341–3359)

```
async fn record_user_prompt_and_emit_turn_item(
        &self,
        turn_context: &TurnContext,
        input: &[UserInput],
        client_id: Option<String>,
    )
```

**Purpose**: Records the user’s prompt and emits the corresponding user-message turn item. It preserves UI-only spans that would be lost if it emitted from the stored response item alone.

**Data flow**: It receives user input and an optional client id. It converts input to a response item for history, records it, builds a UserMessage turn item with the client id, emits started and completed events, and ensures the rollout transcript exists.

**Call relations**: It uses Session::response_item_from_user_input and Session::record_conversation_items before sending turn-item events.

*Call graph*: calls 6 internal fn (emit_turn_item_completed, emit_turn_item_started, ensure_rollout_materialized, record_conversation_items, response_item_from_user_input, new); 3 external calls (to_vec, UserMessage, from_ref).


##### `Session::notify_stream_error`  (lines 3361–3377)

```
async fn notify_stream_error(
        &self,
        turn_context: &TurnContext,
        message: impl Into<String>,
        codex_error: CodexErr,
    )
```

**Purpose**: Reports that the response stream disconnected or failed. It includes both a user-facing message and technical details from the Codex error.

**Data flow**: It receives a message and CodexErr. It extracts a status code and detail string, wraps them in a StreamError event, and sends it to the client.

**Call relations**: This is a focused error-reporting helper built on Session::send_event.

*Call graph*: calls 2 internal fn (send_event, http_status_code_value); 3 external calls (into, to_string, StreamError).


##### `Session::steer_input`  (lines 3386–3459)

```
async fn steer_input(
        &self,
        input: Vec<UserInput>,
        additional_context: BTreeMap<String, AdditionalContextEntry>,
        expected_turn_id: Option<&str>,
        client_user_me
```

**Purpose**: Adds new user steering input to an active regular turn. Steering lets a user guide an in-progress answer, but only when the current turn type supports it.

**Data flow**: It receives user input, extra context, optional expected turn id, optional client message id, and optional client metadata. It validates that a regular active turn exists and matches the expected id, rejects empty input, merges extra context into state, attaches metadata when present, queues context items plus user input, and returns the active turn id.

**Call relations**: It writes into the input queue for the active turn. It rejects review and compact turns because those flows are not steerable.

*Call graph*: 1 external calls (NoActiveTurn).


##### `Session::record_memory_citation_for_turn`  (lines 3461–3470)

```
async fn record_memory_citation_for_turn(&self, sub_id: &str)
```

**Purpose**: Marks that a turn used or cited memory. This lets later reporting know the turn involved memory content.

**Data flow**: It receives a turn id, asks the input queue for that turn’s state, and if found sets a has_memory_citation flag to true.

**Call relations**: This is a small state update tied to the active turn lookup maintained by the input queue.


##### `Session::interrupt_task`  (lines 3472–3479)

```
async fn interrupt_task(self: &Arc<Self>)
```

**Purpose**: Interrupts current work, aborting active tasks if any. If there was no active turn, it cancels MCP startup instead.

**Data flow**: It logs the interrupt, checks whether an active turn exists, aborts all tasks with an Interrupted reason, and cancels MCP startup only when there was no active turn.

**Call relations**: This is an external control path for stopping work. It calls broader abort and startup-cancel routines defined elsewhere in the session.

*Call graph*: 1 external calls (info!).


##### `Session::hooks`  (lines 3481–3483)

```
fn hooks(&self) -> Arc<Hooks>
```

**Purpose**: Returns the current hook runner configuration. Hooks are user or plugin commands that run around session events.

**Data flow**: It loads the current Hooks object from shared services and returns it in an Arc, which is a thread-safe shared pointer.

**Call relations**: This exposes hook services to code that needs to run or inspect hooks.


##### `Session::user_shell`  (lines 3485–3487)

```
fn user_shell(&self) -> Arc<shell::Shell>
```

**Purpose**: Returns the shell configuration for the user’s environment. The shell is needed when building prompts or running hook commands in a familiar way.

**Data flow**: It clones the shared shell pointer from services and returns it.

**Call relations**: Session::build_initial_context and build_settings_update_items use this when they need shell-aware environment context.

*Call graph*: called by 2 (build_initial_context, build_settings_update_items); 1 external calls (clone).


##### `Session::current_rollout_path`  (lines 3489–3494)

```
async fn current_rollout_path(&self) -> anyhow::Result<Option<PathBuf>>
```

**Purpose**: Returns the local filesystem path to the current rollout transcript, if there is one. This lets hooks or other tools know where the transcript lives.

**Data flow**: It asks for the live thread. If none exists it returns Ok(None); otherwise it asks the live thread for its local rollout path and converts any error into anyhow’s general error type.

**Call relations**: Session::hook_transcript_path calls this after ensuring the rollout has been materialized.

*Call graph*: calls 1 internal fn (live_thread); called by 1 (hook_transcript_path).


##### `Session::hook_transcript_path`  (lines 3496–3505)

```
async fn hook_transcript_path(&self) -> Option<PathBuf>
```

**Purpose**: Provides hooks with the transcript path, creating the rollout file first if needed. If the path cannot be read, it logs a warning and returns nothing.

**Data flow**: It ensures the rollout transcript is materialized, calls Session::current_rollout_path, and returns the path on success or None on error.

**Call relations**: This is the hook-facing wrapper around Session::current_rollout_path.

*Call graph*: calls 2 internal fn (current_rollout_path, ensure_rollout_materialized); 1 external calls (warn!).


##### `Session::take_pending_session_start_source`  (lines 3507–3512)

```
async fn take_pending_session_start_source(
        &self,
    ) -> Option<codex_hooks::SessionStartSource>
```

**Purpose**: Takes and clears the pending reason for a session start. This tells hook or lifecycle code why the next session start event is happening.

**Data flow**: It locks mutable session state, removes the pending SessionStartSource value, and returns it if one was queued.

**Call relations**: Compaction flows such as Session::replace_compacted_history and Session::maybe_start_new_context_window queue this value for later consumption.


##### `Session::show_raw_agent_reasoning`  (lines 3514–3516)

```
fn show_raw_agent_reasoning(&self) -> bool
```

**Purpose**: Reports whether raw agent reasoning should be shown. This controls how much internal reasoning detail is exposed in outgoing events.

**Data flow**: It reads a boolean from services and returns it.

**Call relations**: Session::send_event calls this when deciding how to format or filter outgoing reasoning-related data.

*Call graph*: called by 1 (send_event).


##### `emit_subagent_session_started`  (lines 3519–3555)

```
fn emit_subagent_session_started(
    analytics_events_client: &AnalyticsEventsClient,
    client_metadata: AppServerClientMetadata,
    session_id: SessionId,
    thread_id: ThreadId,
    parent_thre
```

**Purpose**: Sends an analytics event when a subagent thread starts. This helps the product understand when and how subagents are being used.

**Data flow**: It receives analytics client, inherited client metadata, session and thread ids, thread configuration, and subagent source. If client name or version is missing it logs a warning and stops; otherwise it builds a SubAgentThreadStartedInput with ids, model, source, time, and client details, then tracks it.

**Call relations**: run_codex_thread_interactive calls this when starting an interactive subagent thread.

*Call graph*: calls 1 internal fn (track_subagent_thread_started); called by 1 (run_codex_thread_interactive); 4 external calls (now, to_string, to_string, warn!).


##### `build_hooks_for_config`  (lines 3558–3586)

```
async fn build_hooks_for_config(
    config: &Config,
    plugins_manager: &PluginsManager,
    environment: Option<&TurnEnvironment>,
) -> Hooks
```

**Purpose**: Builds a Hooks object from the current configuration, plugins, and optional turn environment. This decides which notification commands and plugin hook sources are active.

**Data flow**: It receives config, plugin manager, and optional environment. It derives shell program and arguments when an environment shell exists, loads plugins for the config, gathers hook sources and warnings, and constructs Hooks with feature flags, trust settings, config layers, shell data, and legacy notify settings.

**Call relations**: refresh_runtime_config calls this when runtime configuration changes, so hook behavior matches the latest config and plugins.

*Call graph*: calls 2 internal fn (plugins_for_config, new); called by 1 (refresh_runtime_config); 1 external calls (plugins_config_input).


### `core/src/session/session.rs`

`orchestration` · `startup and session lifetime`

This file is the session “front desk” for the core system. When a user starts or resumes a conversation, the code here gathers all the pieces that conversation needs before any real work can happen. Without it, the agent would not know which model to use, what files it may touch, which shell and working directory are active, what external tools are available, or where to send events back to the user interface.

The main data type, `Session`, is the live object kept for the whole thread. It contains shared services, current state, the input queue, the active turn, event channels, and safety-related helpers. `SessionConfiguration` is the session’s settings bundle. It includes model choice, approval rules, sandbox rules, workspace roots, environment selections, user-facing metadata, and thread ancestry.

The biggest job is `Session::new`. It starts persistence, authentication, MCP tool configuration, environment setup, shell setup, telemetry, plugins, skills, hooks, network proxying, extension data, and initial history recording. It does many independent startup tasks in parallel to reduce wait time. It also sends the first `SessionConfigured` event so clients can render the thread before later tool or warning events arrive.

The permission code is especially important. It keeps older sandbox settings and newer permission profiles consistent, like keeping two maps of the same building aligned so every locked door still means the same thing.

#### Function details

##### `SessionConfiguration::cwd`  (lines 113–115)

```
fn cwd(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the session’s fallback current working directory. This is the directory used when a turn does not choose a more specific environment.

**Data flow**: It reads the `legacy_fallback_cwd` stored inside the session’s environment selections and returns it by reference. Nothing is changed.

**Call relations**: Startup code and configuration-building code ask this for the session’s working directory. Permission helpers also use it when turning permission settings into sandbox rules, because file access rules often depend on the current project directory.

*Call graph*: called by 4 (new, apply, sandbox_policy, build_effective_session_config).


##### `SessionConfiguration::environment_selections`  (lines 117–119)

```
fn environment_selections(&self) -> &[TurnEnvironmentSelection]
```

**Purpose**: Returns the list of environment choices attached to the thread. These selections tell the system which runtime environments, such as local shells or other configured environments, are available for turns.

**Data flow**: It reads the `environments` field and returns the stored selection list. It does not copy or modify the selections.

**Call relations**: Session startup uses this to apply the thread’s environments before resolving the actual runtime snapshot. Other environment-resolution code also uses it when it needs to rebuild what environments a configuration represents.

*Call graph*: called by 2 (new, resolved_environments_for_configuration).


##### `SessionConfiguration::codex_home`  (lines 121–123)

```
fn codex_home(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the directory where Codex stores state for this session or installation. Callers use it when they need the filesystem location for Codex-owned files.

**Data flow**: It reads the `codex_home` path from the configuration and returns a reference to it. There are no side effects.

**Call relations**: The function is a simple accessor. The provided call graph does not show a caller, but it exists so other session code can ask for the Codex state directory without reaching into the struct directly.


##### `SessionConfiguration::permission_profile_state`  (lines 125–127)

```
fn permission_profile_state(&self) -> &PermissionProfileState
```

**Purpose**: Returns the full permission-profile state for the session. This is the source of truth for which file and network permissions are active.

**Data flow**: It reads the `permission_profile_state` field and returns it by reference. It does not change any permission data.

**Call relations**: The function is an accessor for code that needs the whole permission state, not just the simplified active profile. The provided graph does not show a direct caller, but session startup uses the same permission state when reporting the configured session.


##### `SessionConfiguration::permission_profile`  (lines 129–134)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Builds the effective permission profile for the current session. It also fills in project-root placeholders using the session’s actual workspace roots, so symbolic rules become concrete enough to enforce.

**Data flow**: It reads the stored permission profile state and workspace roots. It clones the profile, replaces project-root placeholders with the runtime workspace roots, and returns the resulting permission profile.

**Call relations**: Many parts of the session ask for this when they need the real safety rules: startup reports it to the client, sandbox helpers derive runtime policies from it, and turn-building code uses it before executing tools.

*Call graph*: calls 1 internal fn (permission_profile); called by 7 (new, file_system_sandbox_policy, sandbox_policy, thread_config_snapshot, build_per_turn_config, make_turn_context, new_turn_context_from_configuration).


##### `SessionConfiguration::active_permission_profile`  (lines 136–138)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the named active permission profile, if the session is using one. This is the user- or config-selected profile rather than only the expanded runtime rules.

**Data flow**: It reads the permission profile state and returns its active profile information, or nothing if the session is in legacy permission mode.

**Call relations**: Session startup includes this in the configured-session event, and configuration snapshots include it so clients or persistence layers can see which named profile is active.

*Call graph*: calls 1 internal fn (active_permission_profile); called by 2 (new, thread_config_snapshot).


##### `SessionConfiguration::profile_workspace_roots`  (lines 140–142)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the workspace roots that came from the active permission profile. These roots are separate from thread-level workspace roots and help explain where profile-defined access applies.

**Data flow**: It reads the permission profile state and returns the stored profile workspace roots. The configuration is not changed.

**Call relations**: The thread snapshot code calls this so a snapshot contains both the general workspace roots and the roots contributed by the permission profile.

*Call graph*: calls 1 internal fn (profile_workspace_roots); called by 1 (thread_config_snapshot).


##### `SessionConfiguration::apply_permission_profile_to_permissions`  (lines 144–149)

```
fn apply_permission_profile_to_permissions(
        &self,
        permissions: &mut crate::config::Permissions,
    )
```

**Purpose**: Copies the session’s current permission-profile state into a mutable permissions object. This keeps per-turn permissions aligned with the session’s thread-level permission settings.

**Data flow**: It takes a mutable permissions structure, clones the session’s permission profile state, and stores that clone into the permissions structure. The session configuration itself is unchanged.

**Call relations**: Per-turn configuration building calls this before a turn runs. In plain terms, the session hands its current safety rules to the object that will be used for that specific turn.

*Call graph*: calls 1 internal fn (set_permission_profile_state); called by 1 (build_per_turn_config); 1 external calls (clone).


##### `SessionConfiguration::set_permission_profile_for_tests`  (lines 152–158)

```
fn set_permission_profile_for_tests(
        &mut self,
        permission_profile: PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Lets tests replace the session’s permission profile directly. This is test-only support for checking behavior under different permission setups.

**Data flow**: It takes a permission profile, asks the permission state to install it as a legacy-style profile, and returns success or a constraint error if the profile is not allowed.

**Call relations**: This exists only in test builds. It bypasses normal update flows so tests can set up a session configuration quickly and then exercise permission-related behavior.

*Call graph*: calls 1 internal fn (set_legacy_permission_profile).


##### `SessionConfiguration::sandbox_policy`  (lines 160–166)

```
fn sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Returns a legacy-style sandbox policy derived from the current permission profile. A sandbox policy is the set of limits used to keep commands from accessing things they should not.

**Data flow**: It gets the effective permission profile, reads the current working directory, and converts those into a compatibility sandbox policy. It returns that policy without changing the configuration.

**Call relations**: The update logic uses this when comparing old and new permission settings. This helper is also part of the bridge between newer permission profiles and older sandbox-based code.

*Call graph*: calls 2 internal fn (cwd, permission_profile); called by 1 (apply); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `SessionConfiguration::file_system_sandbox_policy`  (lines 168–170)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Returns the file-access part of the session’s permission rules. This says which filesystem paths can be read or written.

**Data flow**: It builds the effective permission profile and asks that profile for its filesystem sandbox policy. The result is returned as a separate policy object.

**Call relations**: The configuration update path uses this before applying changes, so it can preserve important file restrictions when settings are modified.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (apply).


##### `SessionConfiguration::network_sandbox_policy`  (lines 172–176)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Returns the network-access part of the session’s permission rules. This says what network activity is allowed or blocked.

**Data flow**: It reads the stored permission profile from the permission state and extracts its network sandbox policy. No configuration fields are changed.

**Call relations**: The update path uses this when it needs to carry forward existing network rules while changing other session settings.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (apply).


##### `SessionConfiguration::thread_config_snapshot`  (lines 178–200)

```
fn thread_config_snapshot(&self) -> ThreadConfigSnapshot
```

**Purpose**: Creates a compact snapshot of the session settings that describe the thread. This is useful when another part of the system needs a stable picture of the model, permissions, environments, and thread metadata.

**Data flow**: It reads many fields from the configuration, including model settings, approval policy, permission profile, environment selections, workspace roots, reasoning settings, personality, and thread ancestry. It packages those values into a `ThreadConfigSnapshot` and returns it.

**Call relations**: Code that needs to expose or store thread-level configuration calls this instead of picking fields one by one. The helper pulls in other accessors so the snapshot contains the effective permission profile and active profile information.

*Call graph*: calls 6 internal fn (value, active_permission_profile, permission_profile, profile_workspace_roots, model, reasoning_effort); 3 external calls (clone, clone, clone).


##### `SessionConfiguration::apply`  (lines 202–374)

```
fn apply(&self, updates: &SessionSettingsUpdate) -> ConstraintResult<Self>
```

**Purpose**: Applies a requested settings update and returns a new session configuration. It is careful to keep model settings, service tier, working directory, workspace roots, and permission rules consistent.

**Data flow**: It starts by cloning the current configuration. It reads the requested updates, changes only the fields that were supplied, normalizes service-tier values, retargets workspace roots if the working directory moved, and converts permission or sandbox updates into the internal permission-profile state. If a requested change violates constraints, it returns an error; otherwise it returns the updated configuration.

**Call relations**: This is the main update gate for session settings. It calls the permission and sandbox helpers to compare current rules with new ones, and it uses `set_permission_profile_projection` when a new profile must be translated into runtime file and network permissions.

*Call graph*: calls 10 internal fn (active, cwd, file_system_sandbox_policy, network_sandbox_policy, sandbox_policy, from_request_value, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_preserving_deny_entries, from); 2 external calls (new, with_capacity).


##### `SessionConfiguration::set_permission_profile_projection`  (lines 376–410)

```
fn set_permission_profile_projection(
        &mut self,
        permission_profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
        profile_workspace_ro
```

**Purpose**: Installs a permission profile into the session after translating it into the runtime rules the system actually enforces. It also preserves selected existing deny-read restrictions when asked to do so.

**Data flow**: It receives a permission profile, optional active-profile metadata, optional profile workspace roots, and an optional existing filesystem policy. It converts the profile into file and network rules, preserves deny-read restrictions from the old policy if provided, rebuilds an effective permission profile, wraps it in either an active-profile or legacy snapshot, and stores that snapshot in the permission state.

**Call relations**: The settings update flow uses this when the caller supplies a new permission profile. It is the narrow helper that keeps the public profile view and the lower-level enforcement rules synchronized.

*Call graph*: calls 6 internal fn (active_with_profile_workspace_roots, legacy, set_permission_profile_snapshot, enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions).


##### `warm_plugins_and_skills_for_session_init`  (lines 438–453)

```
async fn warm_plugins_and_skills_for_session_init(
    config: Arc<Config>,
    plugins_manager: Arc<PluginsManager>,
    skills_manager: Arc<SkillsManager>,
    turn_environments: &TurnEnvironmentSna
```

**Purpose**: Preloads plugin and skill information during session startup. This reduces later delay and lets startup report skill-loading problems early.

**Data flow**: It receives the global config, plugin manager, skill manager, and resolved turn environments. It chooses the primary filesystem from the environments, loads plugin configuration, derives the skill roots contributed by plugins, asks the skills manager to load skills for those roots, and returns any skill errors found.

**Call relations**: `Session::new` calls this after environments are resolved and project instructions are loaded. It hands plugin-derived skill roots to the skills system so the session starts with its available abilities warmed up.

*Call graph*: calls 1 internal fn (primary_filesystem); called by 1 (new).


##### `Session::thread_id`  (lines 457–459)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns this session’s concrete thread identifier. The thread id names this particular conversation thread.

**Data flow**: It reads the `thread_id` field from the session and returns it. No state changes.

**Call relations**: This is a basic identity accessor. The provided call graph does not show callers, but other session code can use it whenever it needs to label events, persistence records, or telemetry with the current thread.


##### `Session::session_id`  (lines 462–464)

```
fn session_id(&self) -> SessionId
```

**Purpose**: Returns the broader session identifier shared through the agent-control service. For root threads this may match the thread id, while child or sub-agent threads can share a parent session identity.

**Data flow**: It asks `agent_control` inside the session services for the current session id and returns it. It does not alter the session.

**Call relations**: The function delegates identity ownership to the agent-control service. This lets callers ask the session for its shared conversation identity without knowing how root and child agents are wired.


##### `Session::new`  (lines 468–1192)

```
async fn new(
        mut session_configuration: SessionConfiguration,
        config: Arc<Config>,
        user_instructions: Option<codex_extension_api::UserInstructions>,
        installation_id: S
```

**Purpose**: Builds a fully initialized session and returns it as a shared object. This is the startup pipeline for a new, resumed, cleared, or forked conversation thread.

**Data flow**: It takes the session configuration plus many shared services such as config, authentication, model access, persistence, environment management, plugins, skills, MCP tools, event channels, and telemetry support. It determines the thread identity, starts or resumes persistence, loads auth and MCP configuration, creates trace and telemetry data, resolves the shell and environments, loads instructions, warms plugins and skills, validates config locks, starts network proxy support if needed, builds hooks and extension data, creates `SessionServices`, constructs the `Session`, sends the initial configured event and warnings, installs the real MCP connection manager, prewarms startup work, records initial history, and finally commits persistence. On failure it discards unfinished persistence and returns the error.

**Call relations**: This is called by higher-level session creation paths, including internal agent spawning and test helpers. It calls many smaller constructors and helpers because it is the point where independent subsystems become one live session: persistence, auth, tools, environments, permissions, telemetry, network policy, and event delivery all meet here before user turns can run.

*Call graph*: calls 34 internal fn (new, new, new_uninitialized_with_permission_profile, new, new, session_id, with_session_id, new, new, new (+15 more)); called by 4 (spawn_internal, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh); 39 external calls (clone, downgrade, new, new, pin, new, default, default, default, new (+15 more)).


### `core/src/session/input_queue.rs`

`domain_logic` · `main loop and request handling`

A session can receive input from more than one place: the user may add new instructions, another agent may send mail, or a response item may need to be fed back into the turn. This file gives those inputs a shared, orderly place to wait. Without it, messages could be lost, delivered to the wrong turn, or delivered too early while a turn is not ready for them.

There are two levels of storage. TurnInputQueue belongs to one active turn and holds input meant for that turn. InputQueue belongs to the whole session and holds mailbox messages that may be delivered to the current turn or saved for the next one. A small activity signal tells listeners whether the next important work looks like mailbox delivery or user steering. Think of it like a front desk with two trays: one tray for the current meeting, and one tray for mail that may need to wait until the meeting is ready.

The file also decides when mailbox mail may be accepted. Some turns can defer mailbox delivery until the next turn, while direct user steering is treated as urgent turn input. Shared state is protected with mutexes, which are locks that stop two asynchronous tasks from changing the same data at the same time.

#### Function details

##### `InputQueue::new`  (lines 41–47)

```
fn new() -> Self
```

**Purpose**: Creates an empty session input queue. It starts with no queued mailbox messages and prepares a notification channel so other parts of the session can hear when new input arrives.

**Data flow**: Nothing comes in. The function creates a fresh activity notifier whose initial activity is mailbox-related, creates an empty first-in-first-out mailbox list, and returns a ready-to-use InputQueue.

**Call relations**: Session setup code and the tests call this when they need a new queue. After it is created, later methods add mailbox items, subscribe to activity, or drain pending input from it.

*Call graph*: called by 8 (input_queue_drains_mailbox_in_delivery_order, input_queue_notifies_mailbox_subscribers, input_queue_notifies_steer_subscribers, input_queue_reports_already_pending_steer, input_queue_tracks_pending_trigger_turn_mail, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 3 external calls (new, new, channel).


##### `InputQueue::subscribe_activity`  (lines 49–70)

```
async fn subscribe_activity(
        &self,
        turn_state: Option<&Mutex<TurnState>>,
    ) -> (
        watch::Receiver<InputQueueActivity>,
        Option<InputQueueActivity>,
    )
```

**Purpose**: Lets another task listen for future input activity, and also tells it if there is already something waiting right now. This prevents a listener from missing work that arrived just before it subscribed.

**Data flow**: It receives an optional current turn state. It creates a receiver for future activity notices, checks whether that turn already has user input waiting, otherwise checks whether the session mailbox has mail waiting, and returns both the receiver and an optional immediate activity hint.

**Call relations**: Callers use this when they begin waiting for input activity. It relies on has_pending_mailbox_items when no pending user steering is found, so the listener can be woken for either user input or mailbox mail.

*Call graph*: calls 1 internal fn (has_pending_mailbox_items); 1 external calls (subscribe).


##### `InputQueue::enqueue_mailbox_communication`  (lines 72–81)

```
async fn enqueue_mailbox_communication(
        &self,
        communication: InterAgentCommunication,
    )
```

**Purpose**: Adds a new agent-to-agent mailbox message to the session queue. It also wakes activity listeners so the session can notice that mailbox work is available.

**Data flow**: A mailbox communication comes in. The function locks the mailbox queue, appends the communication at the back to preserve arrival order, then sends a mailbox activity notice. It does not return a value, but it changes the queue and notifies watchers.

**Call relations**: This is used when mail arrives from another agent. Later, get_pending_input or drain_mailbox_input_items can pull those messages out for delivery to a turn.

*Call graph*: 1 external calls (send_replace).


##### `InputQueue::has_pending_mailbox_items`  (lines 83–85)

```
async fn has_pending_mailbox_items(&self) -> bool
```

**Purpose**: Answers the simple question: is there any mailbox mail waiting in the session queue?

**Data flow**: Nothing comes in except access to the queue itself. It locks the mailbox list, checks whether it is empty, and returns true if at least one message is waiting.

**Call relations**: subscribe_activity uses this to report already-waiting mailbox work to new listeners. has_pending_input uses it after checking the current turn, so the broader session can know whether there is any input to process.

*Call graph*: called by 2 (has_pending_input, subscribe_activity).


##### `InputQueue::has_trigger_turn_mailbox_items`  (lines 87–93)

```
async fn has_trigger_turn_mailbox_items(&self) -> bool
```

**Purpose**: Checks whether any queued mailbox message is marked as important enough to trigger a turn. This is useful because not every piece of mail necessarily needs to wake the system immediately.

**Data flow**: It reads the mailbox queue, looks through each waiting communication, and returns true if any one has its trigger_turn flag set. The queue itself is not changed.

**Call relations**: This is a query helper for higher-level session logic that needs to decide whether waiting mail should start or wake a turn. It does not hand work to another function.


##### `InputQueue::drain_mailbox_input_items`  (lines 95–102)

```
async fn drain_mailbox_input_items(&self) -> Vec<TurnInput>
```

**Purpose**: Removes all waiting mailbox messages and converts them into turn input items. This is the point where session-level mail becomes input that a turn can consume.

**Data flow**: It locks the mailbox queue, removes every message in stored order, wraps each one as TurnInput::InterAgentCommunication, and returns the resulting list. Afterward, the mailbox queue is empty.

**Call relations**: get_pending_input calls this when the current turn accepts mailbox delivery. It is also tested directly to make sure mailbox order is preserved.

*Call graph*: called by 1 (get_pending_input).


##### `InputQueue::turn_state_for_sub_id`  (lines 104–117)

```
async fn turn_state_for_sub_id(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
        sub_id: &str,
    ) -> Option<Arc<Mutex<TurnState>>>
```

**Purpose**: Finds the turn state for the active turn, but only if that active turn belongs to the requested subscription id. This protects one conversation branch from accidentally changing another branch's turn.

**Data flow**: It receives the shared active-turn slot and a subscription id string. It locks the active-turn slot, checks whether there is an active turn with a task, compares that task's subscription id, and returns a shared pointer to the turn state only on a match.

**Call relations**: defer_mailbox_delivery_to_next_turn and accept_mailbox_delivery_for_current_turn call this before changing mailbox delivery rules. If it returns nothing, those callers quietly do nothing.

*Call graph*: called by 2 (accept_mailbox_delivery_for_current_turn, defer_mailbox_delivery_to_next_turn).


##### `InputQueue::clear_pending`  (lines 120–124)

```
async fn clear_pending(&self, active_turn: &ActiveTurn)
```

**Purpose**: Clears waiters and buffered input for the current turn. This is used when the system needs to cancel or reset pending turn work cleanly.

**Data flow**: It receives the active turn. It locks that turn's state, clears any pending waiters recorded there, and empties the turn-local pending input list. It returns nothing, but the turn is left with no buffered input.

**Call relations**: Higher-level session code can call this during cancellation, reset, or turn cleanup. It works directly on the active turn state and does not call other helpers in this file.


##### `InputQueue::defer_mailbox_delivery_to_next_turn`  (lines 126–140)

```
async fn defer_mailbox_delivery_to_next_turn(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
        sub_id: &str,
    )
```

**Purpose**: Marks mailbox delivery as something that should wait for the next turn, but only for the matching active subscription and only if no input is already buffered for this turn.

**Data flow**: It receives the active-turn slot and a subscription id. It first finds the matching turn state. If there is no match, it stops. If the turn already has pending input, it leaves delivery unchanged. Otherwise it sets the turn's mailbox delivery phase to NextTurn.

**Call relations**: This function calls turn_state_for_sub_id to avoid touching the wrong active turn. It is part of the control flow that decides whether mail is delivered now or saved until a later turn.

*Call graph*: calls 1 internal fn (turn_state_for_sub_id).


##### `InputQueue::accept_mailbox_delivery_for_current_turn`  (lines 142–153)

```
async fn accept_mailbox_delivery_for_current_turn(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
        sub_id: &str,
    )
```

**Purpose**: Allows the matching active turn to receive mailbox messages during the current turn. It is a safe wrapper that first verifies the subscription id.

**Data flow**: It receives the active-turn slot and subscription id. It finds the matching turn state, and if one exists, passes that turn state to the lower-level accept function. It returns nothing.

**Call relations**: This function uses turn_state_for_sub_id for the safety check, then hands off to accept_mailbox_delivery_for_turn_state to do the actual state update.

*Call graph*: calls 2 internal fn (accept_mailbox_delivery_for_turn_state, turn_state_for_sub_id).


##### `InputQueue::accept_mailbox_delivery_for_turn_state`  (lines 155–163)

```
async fn accept_mailbox_delivery_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
    )
```

**Purpose**: Updates a specific turn state so mailbox messages may be delivered to the current turn. This is the direct version used when the caller already has the correct turn state.

**Data flow**: It receives a locked turn state. It locks it, changes its mailbox delivery setting to accept mail for the current turn, and returns nothing.

**Call relations**: accept_mailbox_delivery_for_current_turn calls this after finding the right active turn. Other code in the same module can use it when it already has a turn state and does not need the subscription-id lookup.

*Call graph*: called by 1 (accept_mailbox_delivery_for_current_turn).


##### `InputQueue::extend_pending_input_and_accept_mailbox_delivery_for_turn_state`  (lines 165–176)

```
async fn extend_pending_input_and_accept_mailbox_delivery_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
        input: Vec<TurnInput>,
    )
```

**Purpose**: Adds input to a turn and makes sure that turn is allowed to receive mailbox delivery now. It also announces steering activity so listeners wake up for the new turn input.

**Data flow**: It receives a turn state and a list of turn input items. It locks the state, appends the new items to the turn-local pending list, marks mailbox delivery as accepted for this turn, unlocks the state, and sends a steering activity notice.

**Call relations**: Tests use this to simulate user steering arriving. In normal flow, it is the helper for adding urgent turn-local input and waking anything waiting on activity updates.

*Call graph*: 1 external calls (send_replace).


##### `InputQueue::extend_pending_input_for_turn_state`  (lines 178–184)

```
async fn extend_pending_input_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
        input: Vec<TurnInput>,
    )
```

**Purpose**: Adds input items to a specific turn without changing mailbox delivery settings or sending an activity notification. It is the quieter append-only helper.

**Data flow**: It receives a turn state and a list of input items. It locks the state and appends those items to the turn's pending input list. It returns nothing.

**Call relations**: This is useful for code that already controls notification or delivery policy elsewhere. It does not call other helpers and does not wake activity subscribers.


##### `InputQueue::take_pending_input_for_turn_state`  (lines 186–191)

```
async fn take_pending_input_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
    ) -> Vec<TurnInput>
```

**Purpose**: Removes and returns all turn-local pending input from a specific turn. After this call, that turn's pending input list is empty.

**Data flow**: It receives a turn state, locks it, splits all items out of the pending input list, and returns those items as a vector. The state remains, but its pending input storage is cleared.

**Call relations**: This is a direct turn-state drain helper. It is separate from get_pending_input because it only takes turn-local input and does not also pull session mailbox messages.


##### `InputQueue::get_pending_input`  (lines 197–225)

```
async fn get_pending_input(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
    ) -> Vec<TurnInput>
```

**Purpose**: Collects the input that should be delivered right now. It first takes input already buffered for the active turn, then adds mailbox mail only if the turn currently accepts mailbox delivery.

**Data flow**: It receives the shared active-turn slot. While holding the relevant locks, it removes pending turn-local input and checks whether mailbox delivery is allowed. If delivery is not allowed, it returns only the turn-local input. If delivery is allowed, it drains mailbox mail and either returns it alone or appends it after the turn-local input.

**Call relations**: This is the main pickup point for the session loop when it is ready to feed new input into processing. It calls drain_mailbox_input_items only after confirming that mailbox mail is allowed for the current situation.

*Call graph*: calls 1 internal fn (drain_mailbox_input_items); 1 external calls (new).


##### `InputQueue::has_pending_input`  (lines 231–252)

```
async fn has_pending_input(&self, active_turn: &Mutex<Option<ActiveTurn>>) -> bool
```

**Purpose**: Checks whether there is any input ready to be processed, while respecting the current turn's mailbox delivery rules. It avoids reporting mailbox mail as ready if the active turn has deferred mailbox delivery.

**Data flow**: It receives the shared active-turn slot. It checks whether the active turn has turn-local pending input and whether that turn accepts mailbox delivery. If turn-local input exists, it returns true. If mailbox delivery is not accepted, it returns false. Otherwise it checks the session mailbox queue and returns whether mail is waiting.

**Call relations**: This is a readiness check for higher-level session code before it decides to fetch input. It calls has_pending_mailbox_items only when mailbox mail is allowed to count as ready.

*Call graph*: calls 1 internal fn (has_pending_mailbox_items).


##### `TurnInputQueue::has_user_input`  (lines 256–260)

```
fn has_user_input(&self) -> bool
```

**Purpose**: Checks whether a turn's pending input includes direct user input. This matters because user steering is treated differently from mailbox activity when deciding what kind of work is pending.

**Data flow**: It reads the turn-local list of input items, looks for any item shaped as TurnInput::UserInput, and returns true if it finds one. It does not change the list.

**Call relations**: subscribe_activity uses this through the current turn state to decide whether a new subscriber should be told that steering work is already waiting.


##### `tests::make_mail`  (lines 269–282)

```
fn make_mail(
        author: AgentPath,
        recipient: AgentPath,
        content: &str,
        trigger_turn: bool,
    ) -> InterAgentCommunication
```

**Purpose**: Builds a test mailbox message with the chosen sender, recipient, content, and trigger flag. It keeps the tests short and consistent.

**Data flow**: It receives an author path, recipient path, message text, and trigger_turn boolean. It creates an InterAgentCommunication value with no extra metadata and returns it.

**Call relations**: The mailbox-related tests call this whenever they need sample agent mail. It delegates construction to the protocol type's constructor.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::input_queue_notifies_mailbox_subscribers`  (lines 285–313)

```
async fn input_queue_notifies_mailbox_subscribers()
```

**Purpose**: Tests that adding mailbox mail wakes subscribers with mailbox activity. This protects the notification path that lets the rest of the session notice new mail.

**Data flow**: The test creates an empty queue, subscribes to activity, verifies there is no immediate pending work, enqueues two mailbox messages, waits for a change notification, and checks that the reported activity is Mailbox.

**Call relations**: It exercises InputQueue::new, subscribe_activity, enqueue_mailbox_communication, and the test mail builder. The story it verifies is: subscribe first, mail arrives later, listener wakes up.

*Call graph*: calls 3 internal fn (new, root, try_from); 2 external calls (assert_eq!, make_mail).


##### `tests::input_queue_notifies_steer_subscribers`  (lines 316–338)

```
async fn input_queue_notifies_steer_subscribers()
```

**Purpose**: Tests that adding user steering input wakes subscribers with steering activity. This makes sure direct user input is signaled differently from mailbox mail.

**Data flow**: The test creates a queue and a default turn state, subscribes to activity, confirms no work is already pending, adds a user input item through the helper that also accepts mailbox delivery, waits for the notification, and checks that the activity is Steer.

**Call relations**: It uses InputQueue::new and extend_pending_input_and_accept_mailbox_delivery_for_turn_state. The scenario proves that turn-local user input sends the steering signal expected by subscribers.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, assert_eq!, vec!).


##### `tests::input_queue_reports_already_pending_steer`  (lines 341–361)

```
async fn input_queue_reports_already_pending_steer()
```

**Purpose**: Tests that a new subscriber is told about user steering that was already waiting before it subscribed. This prevents a race where work could be missed.

**Data flow**: The test creates a queue and turn state, adds user input before subscribing, then subscribes with that turn state. It checks that the returned immediate pending activity is Steer.

**Call relations**: It uses the same input-adding helper as the steering notification test, but flips the order: input first, subscription second. This covers the immediate pending_activity part of subscribe_activity.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, assert_eq!, vec!).


##### `tests::input_queue_drains_mailbox_in_delivery_order`  (lines 364–394)

```
async fn input_queue_drains_mailbox_in_delivery_order()
```

**Purpose**: Tests that mailbox messages come back out in the same order they were queued, and that draining empties the mailbox queue. This protects message ordering.

**Data flow**: The test creates two messages, enqueues them one after the other, drains the mailbox into turn input items, and compares the result to the expected ordered list. It then checks that no mailbox items remain.

**Call relations**: It uses InputQueue::new, enqueue_mailbox_communication, drain_mailbox_input_items, and has_pending_mailbox_items. The scenario confirms the queue behaves like a proper first-in-first-out line.

*Call graph*: calls 3 internal fn (new, root, try_from); 3 external calls (assert!, assert_eq!, make_mail).


##### `tests::input_queue_tracks_pending_trigger_turn_mail`  (lines 397–419)

```
async fn input_queue_tracks_pending_trigger_turn_mail()
```

**Purpose**: Tests that the queue can tell whether any waiting mailbox message is marked to trigger a turn. This ensures important wake-up mail is not hidden among ordinary mail.

**Data flow**: The test creates a queue, enqueues a non-triggering message, and checks that no trigger-turn mail is reported. It then enqueues a triggering message and checks that the query now returns true.

**Call relations**: It uses InputQueue::new, enqueue_mailbox_communication, has_trigger_turn_mailbox_items, and the test mail builder. The scenario proves the trigger check looks across all queued mail.

*Call graph*: calls 3 internal fn (new, root, try_from); 2 external calls (assert!, make_mail).


### `core/src/session/inject.rs`

`orchestration` · `request handling and idle-work scheduling`

A session can be thought of like a help desk with one active ticket at a time. New items may arrive while the assistant is already answering, while it is idle, or while user-requested work is waiting. This file contains the rules for putting those items in the right place without interrupting higher-priority work.

The simplest path is injection into an active turn: if a turn is already running, the new response items are added to that turn’s pending input queue. If nothing is running, the items are returned so the caller can decide what to do next.

The more careful path is starting idle work. Some extensions may want to start work automatically, but this file makes sure that does not happen when the user has queued work, when another task is active, or when the session is in Plan mode, where automatic execution is not allowed. It briefly reserves an idle turn, checks again for newly arrived user work, builds the turn context, checks again, and only then starts a regular task. These repeated checks matter because asynchronous code can pause, and the world may change while it is paused.

There is also a quiet path: inject if possible, otherwise just record the items in the conversation history without starting a new turn.

#### Function details

##### `Session::inject_if_running`  (lines 19–36)

```
async fn inject_if_running(
        &self,
        input: Vec<ResponseItem>,
    ) -> Result<(), Vec<ResponseItem>>
```

**Purpose**: This tries to add new response items to the session’s currently running turn. If no turn is active, it gives the items back unchanged so the caller can choose another path.

**Data flow**: It receives a list of response items. It locks the session’s active-turn slot, like checking whether the help desk is already serving someone. If there is an active turn, it wraps each item as turn input and appends them to that turn’s pending input queue, then reports success. If there is no active turn, it returns the original items as an error value, meaning nothing was injected and nothing was lost.

**Call relations**: This is the first step used by Session::inject_no_new_turn. That caller asks, “Can these items join work already in progress?” If this function says yes, the story ends there. If it says no, Session::inject_no_new_turn records the items instead of starting new work.

*Call graph*: called by 1 (inject_no_new_turn).


##### `Session::try_start_turn_if_idle`  (lines 45–130)

```
async fn try_start_turn_if_idle(
        self: &Arc<Self>,
        input: Vec<ResponseItem>,
    ) -> Result<(), TryStartTurnIfIdleError>
```

**Purpose**: This starts a normal assistant turn for automatic idle work, but only when it is safe and polite to do so. It refuses to start if user-triggered work is waiting, if the session is busy, or if the session is in Plan mode.

**Data flow**: It receives response items that an extension wants to process. Empty input immediately becomes a successful no-op. Otherwise it checks for pending user-triggered work, checks the current collaboration mode, and reserves an active-turn slot only if nothing is already running. After reserving, it checks again for newly arrived user work, builds a fresh turn context with a new unique sub-id, checks whether that context is still allowed to run, possibly emits a model warning, checks again for queued user work, and confirms its reservation was not stolen or replaced. If all checks pass, it adds the items to the reserved turn’s input queue and starts a regular task. If any check fails, it returns an error containing the reason and the original input so the caller can keep or retry it.

**Call relations**: This function is the gatekeeper for extension-initiated idle work. During its flow it creates error values with new, creates a unique id with new_v4, clones shared turn state, and calls Session::clear_reserved_idle_turn whenever it made a temporary reservation that must be undone. After cleanup, it may let pending user work start instead of the idle work.

*Call graph*: calls 3 internal fn (new, clear_reserved_idle_turn, new); 3 external calls (clone, new, new_v4).


##### `Session::clear_reserved_idle_turn`  (lines 132–140)

```
async fn clear_reserved_idle_turn(&self, turn_state: &Arc<tokio::sync::Mutex<TurnState>>)
```

**Purpose**: This removes a temporary idle-turn reservation if it still belongs to the caller and no task has actually started. It is a safety cleanup step that prevents a failed idle-start attempt from leaving the session looking busy.

**Data flow**: It receives the shared turn state that was reserved earlier. It locks the active-turn slot and checks three things: there is an active turn, that turn has no task attached yet, and its turn state is the exact same shared object as the one passed in. If all three are true, it clears the active-turn slot. If not, it leaves the session untouched, because some other work may have started or changed the state.

**Call relations**: Session::try_start_turn_if_idle calls this whenever it has reserved an idle turn but later discovers it should not proceed, such as when user work appears or Plan mode is detected. The function uses pointer equality through ptr_eq to avoid clearing a different turn by mistake.

*Call graph*: called by 1 (try_start_turn_if_idle); 1 external calls (ptr_eq).


##### `Session::inject_no_new_turn`  (lines 143–160)

```
async fn inject_no_new_turn(
        &self,
        items: Vec<ResponseItem>,
        current_turn_context: Option<&TurnContext>,
    )
```

**Purpose**: This adds items to active work if possible, but deliberately does not start a new assistant turn. If nothing is running, it simply records the items in the conversation history.

**Data flow**: It receives response items and optionally the current turn context, which is the bundle of information describing the current assistant turn. First it passes the items to Session::inject_if_running. If that succeeds, the items have joined the active turn and the function stops. If injection fails because no turn is running, it chooses a turn context: it uses the supplied one if available, or creates a default one. It then records the items as conversation history, changing stored session history but not launching new work.

**Call relations**: This function depends on Session::inject_if_running as its fast path. It is used when callers want incoming items preserved or attached to current work, but they specifically do not want those items to wake up the assistant by creating a fresh turn.

*Call graph*: calls 1 internal fn (inject_if_running).


### `core/src/state/service.rs`

`data_model` · `session startup and cross-cutting during the session`

`SessionServices` is like the front desk for a session: when different parts of the program need an important shared service, they can find it here instead of each building its own copy. A session may need to talk to models, run commands, check security policy, record telemetry, manage plugins, store thread state, approve network access, and connect to MCP servers. MCP means “Model Context Protocol,” a way for the system to connect to external tools or servers. Without a central place like this, those services would be scattered, harder to share safely, and easier to initialize in the wrong order.

Most fields are shared handles, locks, or swap-able references. A shared handle lets many parts of the session use the same service. A mutex is a lock that stops two tasks from changing the same data at once. `ArcSwap` is used where the current service can be replaced while readers still safely hold the old one.

The one behavior in this file installs the MCP connection manager. It stores the manager first, then validates required MCP servers. That order matters because validation itself may need to use the session’s newly installed manager. In plain terms: it puts the phone system on the desk before checking whether all required phone lines work.

#### Function details

##### `SessionServices::install_mcp_connection_manager`  (lines 90–99)

```
async fn install_mcp_connection_manager(
        &self,
        manager: McpConnectionManager,
    ) -> Result<()>
```

**Purpose**: This function makes a newly created MCP connection manager the active one for the session, then checks that all required MCP servers are available. It is used during setup so MCP-related work can safely go through the session’s official manager.

**Data flow**: It receives an `McpConnectionManager`. It wraps that manager in a shared reference so other tasks can hold it safely, stores it as the current manager, then reads it back and asks it to validate required servers. If validation succeeds, it returns success. If a required server check fails, it returns an error.

**Call relations**: During session setup, once an MCP connection manager has been built, this function is the step that publishes it into `SessionServices`. Internally it calls the shared-pointer constructor, then hands control to the manager’s server validation step so startup can continue only after required MCP connections have been checked.

*Call graph*: 1 external calls (new).


### `core/src/state/session.rs`

`data_model` · `session lifetime`

A Codex session has many moving parts. It needs to remember the conversation so far, know how much of the model's context window is full, track rate-limit information from the server, remember which permissions were granted, and carry small bits of state from one user turn to the next. This file gathers that session-wide mutable state into `SessionState`.

Think of it like the clipboard at the front desk of a long-running appointment. Each step of the appointment writes down what changed, and later steps read those notes instead of guessing. The `ContextManager` inside it stores the conversation history and token accounting. The `AutoCompactWindow` tracks when the conversation should move into a new compressed context window, so old context can be summarized before it gets too large. Other fields remember things like selected connectors, pending session-start sources, startup prewarm data, and extra permission profiles granted for particular environments.

Most methods are small, deliberate gateways to that state. They either forward work to a more specialized object, return a cloned snapshot so callers cannot accidentally mutate internal data, or update one field in a controlled way. A small helper, `merge_rate_limit_fields`, preserves older rate-limit details when a newer server update leaves them out.

#### Function details

##### `SessionState::new`  (lines 47–64)

```
fn new(session_configuration: SessionConfiguration) -> Self
```

**Purpose**: Creates a fresh `SessionState` for a newly started session. It fills in empty history, empty sets and queues, no known rate limits yet, and marks the next turn as the first turn.

**Data flow**: It receives the session configuration that describes how this session should run. It builds new helper objects for history and auto-compaction, starts optional values as missing, starts collections as empty, and returns the completed state object ready for use.

**Call relations**: This is the starting point for session state. Session setup code and tests call it when they need a clean session, and later methods build on the objects and defaults created here.

*Call graph*: calls 2 internal fn (new, new); called by 12 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present, clear_connector_selection_removes_entries, merge_connector_selection_deduplicates_entries, replace_history_clears_auto_compact_window_prefill, set_rate_limits_carries_account_metadata_from_codex_to_codex_other, set_rate_limits_defaults_limit_id_to_codex_when_missing (+2 more)); 4 external calls (new, new, new, default).


##### `SessionState::record_items`  (lines 67–73)

```
fn record_items(&mut self, items: I, policy: TruncationPolicy)
```

**Purpose**: Adds response items to the stored conversation history. The truncation policy tells the history layer how to shorten oversized output when needed.

**Data flow**: It receives a group of response items plus a rule for truncating long content. It passes both to the history store, which records the items in the session's remembered context.

**Call relations**: When the session receives new conversation items, this method is the state-level doorway into `ContextManager::record_items`. It keeps callers from reaching directly into the history object for this common update.

*Call graph*: calls 1 internal fn (record_items).


##### `SessionState::previous_turn_settings`  (lines 75–77)

```
fn previous_turn_settings(&self) -> Option<PreviousTurnSettings>
```

**Purpose**: Returns the settings remembered from the latest normal user turn. These settings help later turns keep behavior such as model or realtime choices consistent.

**Data flow**: It reads the optional stored settings, clones them if present, and gives the caller its own copy. The internal stored value is not changed.

**Call relations**: Code preparing a new turn can ask this method what the previous turn used. It pairs with `SessionState::set_previous_turn_settings`, which writes the value after a turn has chosen its settings.


##### `SessionState::set_previous_turn_settings`  (lines 78–83)

```
fn set_previous_turn_settings(
        &mut self,
        previous_turn_settings: Option<PreviousTurnSettings>,
    )
```

**Purpose**: Stores or clears the settings from the latest regular user turn. This lets the next turn know what choices were used before.

**Data flow**: It receives either some previous-turn settings or `None`. It replaces the stored value with that input and returns nothing.

**Call relations**: Turn orchestration code calls this after deciding the effective settings for a turn. Later, `SessionState::previous_turn_settings` reads the value back.


##### `SessionState::set_next_turn_is_first`  (lines 85–87)

```
fn set_next_turn_is_first(&mut self, value: bool)
```

**Purpose**: Sets whether the next user turn should be treated as the first turn of the session. This is useful when session flow needs to reset or explicitly control first-turn behavior.

**Data flow**: It receives a true-or-false value and stores it in the session state. Nothing is returned.

**Call relations**: Code that prepares or resets session flow can set this flag. `SessionState::take_next_turn_is_first` later consumes it when a turn starts.


##### `SessionState::take_next_turn_is_first`  (lines 89–93)

```
fn take_next_turn_is_first(&mut self) -> bool
```

**Purpose**: Checks whether the next turn was marked as the first turn, then clears that mark. This makes the flag a one-time signal.

**Data flow**: It reads the current flag, immediately changes the stored flag to false, and returns the old value. After this call, following turns will not see the same first-turn signal unless it is set again.

**Call relations**: Turn-start code uses this when it needs to know whether special first-turn behavior should run. It works like taking a ticket from a dispenser: once taken, the same ticket is no longer there.


##### `SessionState::clone_history`  (lines 95–97)

```
fn clone_history(&self) -> ContextManager
```

**Purpose**: Returns a copy of the current conversation history manager. This lets other code inspect or work with the history without directly owning the session's internal copy.

**Data flow**: It reads the current `ContextManager`, clones it, and returns the clone. The original history inside the session remains unchanged.

**Call relations**: Callers use this when they need a snapshot-like copy of history. It relies on the history manager's own clone behavior rather than exposing mutable access.

*Call graph*: 1 external calls (clone).


##### `SessionState::replace_history`  (lines 99–108)

```
fn replace_history(
        &mut self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
    )
```

**Purpose**: Replaces the stored conversation history with a new list of response items and a new reference context item. It also clears auto-compaction prefill information because the old token assumptions may no longer match the new history.

**Data flow**: It receives replacement history items and an optional context reference. It swaps the history contents, stores the reference item, clears prefill tracking in the auto-compaction window, and returns nothing.

**Call relations**: This is used when the session history is rebuilt, such as after compaction or resume. It coordinates both the history store and the auto-compaction tracker so they do not disagree.

*Call graph*: calls 3 internal fn (replace, set_reference_context_item, clear_prefill).


##### `SessionState::set_token_info`  (lines 110–112)

```
fn set_token_info(&mut self, info: Option<TokenUsageInfo>)
```

**Purpose**: Sets the current token usage information stored with the conversation history. Token information describes how much model context has been used.

**Data flow**: It receives optional token usage information. It forwards that value to the history manager, replacing the token information held there.

**Call relations**: Code that learns or recalculates token information calls this method. The actual storage lives in the history manager, and this method is the session-level wrapper.

*Call graph*: calls 1 internal fn (set_token_info).


##### `SessionState::set_reference_context_item`  (lines 114–116)

```
fn set_reference_context_item(&mut self, item: Option<TurnContextItem>)
```

**Purpose**: Stores the context item that should be treated as the reference point for the current history. This helps later context-building know which item the current context is based on.

**Data flow**: It receives an optional reference context item and forwards it into the history manager. The session state itself returns nothing.

**Call relations**: This is called when session logic needs to update the history's context anchor. `SessionState::reference_context_item` reads the same value back later.

*Call graph*: calls 1 internal fn (set_reference_context_item).


##### `SessionState::reference_context_item`  (lines 118–120)

```
fn reference_context_item(&self) -> Option<TurnContextItem>
```

**Purpose**: Returns the current reference context item, if one is stored. This gives callers the context anchor associated with the current history.

**Data flow**: It asks the history manager for its reference context item and returns that optional value. No state is changed.

**Call relations**: Context-building code calls this when it needs to know what the stored history is anchored to. It is the read-side partner to `SessionState::set_reference_context_item`.

*Call graph*: calls 1 internal fn (reference_context_item).


##### `SessionState::update_token_info_from_usage`  (lines 123–129)

```
fn update_token_info_from_usage(
        &mut self,
        usage: &TokenUsage,
        model_context_window: Option<i64>,
    )
```

**Purpose**: Updates stored token information using a token usage report from the model or server. The optional model context window tells it the total size of the model's available context, if known.

**Data flow**: It receives raw token usage and an optional context-window size. It passes both into the history manager, which recalculates the stored token information.

**Call relations**: After a model response or usage update arrives, session code calls this to keep token accounting current. The detailed calculation is delegated to the history manager.

*Call graph*: calls 1 internal fn (update_token_info).


##### `SessionState::ensure_auto_compact_window_server_prefill_from_usage`  (lines 131–137)

```
fn ensure_auto_compact_window_server_prefill_from_usage(
        &mut self,
        usage: &TokenUsage,
    )
```

**Purpose**: Makes sure the auto-compaction tracker has a server-observed prefill value based on token usage. Prefill means tokens already present in the model context before the latest generation.

**Data flow**: It receives token usage from the server and passes it to the auto-compaction window. The window records the server-observed prefill only if it needs one.

**Call relations**: This is part of keeping auto-compaction decisions grounded in real usage data. It hands usage information to `AutoCompactWindow`, which owns that specific accounting.

*Call graph*: calls 1 internal fn (ensure_server_observed_prefill_from_usage).


##### `SessionState::set_auto_compact_window_estimated_prefill`  (lines 139–141)

```
fn set_auto_compact_window_estimated_prefill(&mut self, tokens: i64)
```

**Purpose**: Stores an estimated prefill token count for the active auto-compaction window. This is used when the system has an estimate rather than a server-measured number.

**Data flow**: It receives a token count and passes it into the auto-compaction window as the estimated prefill. Nothing is returned.

**Call relations**: Context preparation code can call this before exact server usage is known. Later auto-compaction snapshots and decisions use the value stored in `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (set_estimated_prefill).


##### `SessionState::auto_compact_window_snapshot`  (lines 143–145)

```
fn auto_compact_window_snapshot(&self) -> AutoCompactWindowSnapshot
```

**Purpose**: Returns a snapshot of the current auto-compaction window. A snapshot is a read-only picture of the window's current counters and identifiers.

**Data flow**: It asks the auto-compaction window to produce its snapshot and returns that snapshot to the caller. The live window is not changed.

**Call relations**: Other parts of the session use this when they need to report or reason about compaction state without mutating it. The underlying snapshot is produced by `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (snapshot).


##### `SessionState::auto_compact_window_id`  (lines 147–149)

```
fn auto_compact_window_id(&self) -> u64
```

**Purpose**: Returns the identifier of the active auto-compaction window. The identifier separates one context window from the next.

**Data flow**: It reads the window id from the auto-compaction tracker and returns it. No state changes.

**Call relations**: Code that tags work with the current context-window generation calls this. It delegates the actual value to `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (window_id).


##### `SessionState::set_auto_compact_window_id`  (lines 151–153)

```
fn set_auto_compact_window_id(&mut self, window_id: u64)
```

**Purpose**: Forces the auto-compaction window to use a specific identifier. This is useful when restoring or synchronizing state.

**Data flow**: It receives a window id number and stores it inside the auto-compaction tracker. Nothing is returned.

**Call relations**: Session flow can call this when the window id must match an outside source or restored state. Later reads through `SessionState::auto_compact_window_id` return the new value.

*Call graph*: calls 1 internal fn (set_window_id).


##### `SessionState::advance_auto_compact_window_id`  (lines 155–157)

```
fn advance_auto_compact_window_id(&mut self) -> u64
```

**Purpose**: Moves the auto-compaction tracker to the next window id and returns that new id. This marks the start of a new context-window generation.

**Data flow**: It asks the auto-compaction window to increment its id. The updated id is returned to the caller.

**Call relations**: Compaction or context-reset code calls this when it deliberately starts a new window. It is a direct session-level wrapper around the auto-compaction tracker.

*Call graph*: calls 1 internal fn (advance_window_id).


##### `SessionState::request_new_context_window`  (lines 159–161)

```
fn request_new_context_window(&mut self)
```

**Purpose**: Marks that a new context window should be started soon. It records the request without immediately changing the window.

**Data flow**: It sets a pending request flag inside the auto-compaction window and returns nothing. The current window id and prefill remain unchanged until the request is acted on.

**Call relations**: Code that detects the need for a fresh context calls this as a signal. `SessionState::start_new_context_window_if_requested` later consumes the signal and performs the actual switch.

*Call graph*: calls 1 internal fn (request_new_context_window).


##### `SessionState::start_new_context_window_if_requested`  (lines 163–171)

```
fn start_new_context_window_if_requested(&mut self) -> Option<u64>
```

**Purpose**: Starts a new auto-compaction context window only if one was previously requested. If no request is pending, it leaves everything alone.

**Data flow**: It asks the auto-compaction window whether a new-window request is pending. If not, it returns `None`; if yes, it advances the window id, clears prefill data, and returns the new id.

**Call relations**: This is the follow-through step after `SessionState::request_new_context_window`. It is likely called at a safe transition point, so the session only changes windows when the rest of the flow is ready.

*Call graph*: calls 3 internal fn (advance_window_id, clear_prefill, take_new_context_window_request).


##### `SessionState::token_info`  (lines 173–175)

```
fn token_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the current token usage information, if known. This tells callers how full the model context is believed to be.

**Data flow**: It asks the history manager for its stored token information and returns that optional value. It does not change the history.

**Call relations**: This is used directly by callers that only need token information and internally by `SessionState::token_info_and_rate_limits`, which bundles token information with rate-limit information.

*Call graph*: calls 1 internal fn (token_info); called by 1 (token_info_and_rate_limits).


##### `SessionState::set_rate_limits`  (lines 177–182)

```
fn set_rate_limits(&mut self, snapshot: RateLimitSnapshot)
```

**Purpose**: Stores the latest rate-limit snapshot from the server while preserving older details that the new snapshot may omit. Rate limits describe usage caps, credits, and plan information.

**Data flow**: It receives a new rate-limit snapshot and compares it with the previously stored one. It fills missing fields where appropriate, stores the merged result, and returns nothing.

**Call relations**: When fresh rate-limit data arrives, session code calls this method. It relies on `merge_rate_limit_fields` so incomplete server updates do not erase useful prior information.

*Call graph*: calls 1 internal fn (merge_rate_limit_fields).


##### `SessionState::token_info_and_rate_limits`  (lines 184–188)

```
fn token_info_and_rate_limits(
        &self,
    ) -> (Option<TokenUsageInfo>, Option<RateLimitSnapshot>)
```

**Purpose**: Returns token usage information and rate-limit information together. This is convenient for status reporting or responses that need both pieces of accounting.

**Data flow**: It reads token information through `SessionState::token_info`, clones the latest stored rate-limit snapshot if present, and returns both as a pair. No state changes.

**Call relations**: Callers use this when they need a combined view of model-context usage and account/server limits. It builds on the token-info accessor and the stored rate-limit field.

*Call graph*: calls 1 internal fn (token_info).


##### `SessionState::set_token_usage_full`  (lines 190–192)

```
fn set_token_usage_full(&mut self, context_window: i64)
```

**Purpose**: Marks token usage as full for a given context-window size. This tells the history layer that the model's available context should be considered filled.

**Data flow**: It receives a context-window size and passes it to the history manager. The history manager updates its token accounting to reflect a full context.

**Call relations**: Session logic can call this when it knows the context has reached capacity. The detailed token state is stored inside the history manager.

*Call graph*: calls 1 internal fn (set_token_usage_full).


##### `SessionState::get_total_token_usage`  (lines 194–197)

```
fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64
```

**Purpose**: Returns the total token usage currently known for the session history. The caller chooses whether server-side reasoning tokens should be included in that total.

**Data flow**: It receives a true-or-false choice about including server reasoning. It passes that choice to the history manager and returns the resulting token count.

**Call relations**: Reporting or compaction code calls this when it needs a single token total. The calculation is owned by the history manager, while this method exposes it at the session-state level.

*Call graph*: calls 1 internal fn (get_total_token_usage).


##### `SessionState::set_server_reasoning_included`  (lines 199–201)

```
fn set_server_reasoning_included(&mut self, included: bool)
```

**Purpose**: Records whether server-side reasoning tokens are included in the session's accounting. Server reasoning means internal model work that may be counted separately from visible text.

**Data flow**: It receives a true-or-false value and stores it in the session state. Nothing is returned.

**Call relations**: Code that learns how the server is reporting usage updates this flag. `SessionState::server_reasoning_included` later reads the value.


##### `SessionState::server_reasoning_included`  (lines 203–205)

```
fn server_reasoning_included(&self) -> bool
```

**Purpose**: Returns whether server-side reasoning tokens are currently considered included in usage accounting. This lets other code interpret token totals correctly.

**Data flow**: It reads the stored boolean flag and returns it. No state changes.

**Call relations**: Callers use this after `SessionState::set_server_reasoning_included` has recorded the server's behavior. It helps keep token reporting consistent.


##### `SessionState::record_mcp_dependency_prompted`  (lines 207–212)

```
fn record_mcp_dependency_prompted(&mut self, names: I)
```

**Purpose**: Remembers which MCP dependency names have already prompted the user. MCP refers to Model Context Protocol, a way external tools or services can provide context to the model.

**Data flow**: It receives a collection of dependency names and adds them to a set. Because it is a set, repeated names are kept only once.

**Call relations**: Code that prompts about MCP dependencies calls this afterward so the same dependency is not treated as new again. `SessionState::mcp_dependency_prompted` returns the remembered set.


##### `SessionState::mcp_dependency_prompted`  (lines 214–216)

```
fn mcp_dependency_prompted(&self) -> HashSet<String>
```

**Purpose**: Returns the set of MCP dependency names that have already prompted the user. This helps avoid duplicate prompts.

**Data flow**: It clones the stored set of dependency names and returns the clone. The internal set is unchanged.

**Call relations**: Prompting logic can call this before deciding whether to ask the user about a dependency. It reads the information written by `SessionState::record_mcp_dependency_prompted`.


##### `SessionState::set_session_startup_prewarm`  (lines 218–223)

```
fn set_session_startup_prewarm(
        &mut self,
        startup_prewarm: SessionStartupPrewarmHandle,
    )
```

**Purpose**: Stores a startup prewarm handle prepared during session initialization. A prewarm handle represents work done early so the session can respond faster later.

**Data flow**: It receives a prewarm handle and stores it as the current optional startup prewarm value. Any previous value is replaced.

**Call relations**: Session startup code calls this after preparing prewarm work. Later, `SessionState::take_session_startup_prewarm` removes and returns it when the session is ready to use it.


##### `SessionState::take_session_startup_prewarm`  (lines 225–227)

```
fn take_session_startup_prewarm(&mut self) -> Option<SessionStartupPrewarmHandle>
```

**Purpose**: Takes the stored startup prewarm handle out of the session state, if one exists. Taking it means it can only be consumed once.

**Data flow**: It removes the optional prewarm handle from the state and returns it. Afterward, the stored value is empty.

**Call relations**: Code that wants to use the prewarmed session calls this at the point of use. It pairs with `SessionState::set_session_startup_prewarm`, which stores the handle earlier.


##### `SessionState::merge_connector_selection`  (lines 230–236)

```
fn merge_connector_selection(&mut self, connector_ids: I) -> HashSet<String>
```

**Purpose**: Adds connector IDs to the session's active connector selection and returns the full merged selection. Connector IDs identify external integrations or data sources chosen for the session.

**Data flow**: It receives connector ID strings, adds them to the stored set, and returns a cloned set containing all active connector IDs. Duplicates naturally collapse because the storage is a set.

**Call relations**: Connector-selection code calls this when new connectors become active. `SessionState::get_connector_selection` can later read the same set, and `SessionState::clear_connector_selection` can empty it.


##### `SessionState::get_connector_selection`  (lines 239–241)

```
fn get_connector_selection(&self) -> HashSet<String>
```

**Purpose**: Returns the current active connector selection. This tells callers which connector IDs the session is tracking right now.

**Data flow**: It clones the stored connector ID set and returns the clone. The session's internal set is not changed.

**Call relations**: Code preparing connector-related work calls this after selections have been merged in through `SessionState::merge_connector_selection`.


##### `SessionState::clear_connector_selection`  (lines 244–246)

```
fn clear_connector_selection(&mut self)
```

**Purpose**: Removes all active connector selections from the session state. This resets connector tracking to empty.

**Data flow**: It clears the stored connector ID set and returns nothing. After the call, `SessionState::get_connector_selection` will return an empty set unless new IDs are merged in.

**Call relations**: Session or turn flow calls this when connector selections should no longer carry forward. It is the reset counterpart to `SessionState::merge_connector_selection`.


##### `SessionState::queue_pending_session_start_source`  (lines 248–253)

```
fn queue_pending_session_start_source(
        &mut self,
        value: codex_hooks::SessionStartSource,
    )
```

**Purpose**: Adds a session-start source to a waiting queue. A session-start source records something that should be processed as part of session-start handling.

**Data flow**: It receives one session-start source and pushes it onto the back of the queue. Nothing is returned.

**Call relations**: Startup or hook-related code calls this when it has another start source to process later. `SessionState::take_pending_session_start_source` removes them in first-in, first-out order.

*Call graph*: 1 external calls (push_back).


##### `SessionState::take_pending_session_start_source`  (lines 255–259)

```
fn take_pending_session_start_source(
        &mut self,
    ) -> Option<codex_hooks::SessionStartSource>
```

**Purpose**: Removes and returns the oldest queued session-start source, if any. This lets start sources be processed in the same order they were queued.

**Data flow**: It pops one item from the front of the queue. If the queue has an item, that item is returned; if not, it returns `None`.

**Call relations**: Session-start processing calls this repeatedly to drain queued sources. It consumes values added earlier by `SessionState::queue_pending_session_start_source`.

*Call graph*: 1 external calls (pop_front).


##### `SessionState::record_granted_permissions`  (lines 261–275)

```
fn record_granted_permissions(
        &mut self,
        environment_id: &str,
        permissions: AdditionalPermissionProfile,
    )
```

**Purpose**: Records additional permissions granted for a specific environment, merging them with any permissions already stored for that environment. An environment ID distinguishes one sandbox or execution setting from another.

**Data flow**: It receives an environment ID and a permission profile. It looks up any existing permissions for that environment, merges old and new profiles, and stores the merged result if there is one.

**Call relations**: Permission approval code calls this after extra permissions are granted. It delegates the details of combining permission profiles to `merge_permission_profiles`, then makes the result available through `SessionState::granted_permissions`.

*Call graph*: calls 1 internal fn (merge_permission_profiles).


##### `SessionState::granted_permissions`  (lines 277–284)

```
fn granted_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Returns the additional permissions remembered for a given environment, if any. This lets later work reuse permissions that were already granted.

**Data flow**: It receives an environment ID, looks for a stored permission profile under that ID, clones it if present, and returns it. The stored permission map is unchanged.

**Call relations**: Before asking for or applying permissions, session code can call this to see what has already been granted. It reads the records written by `SessionState::record_granted_permissions`.


##### `merge_rate_limit_fields`  (lines 290–307)

```
fn merge_rate_limit_fields(
    previous: Option<&RateLimitSnapshot>,
    mut snapshot: RateLimitSnapshot,
) -> RateLimitSnapshot
```

**Purpose**: Combines an older rate-limit snapshot with a newer one so missing fields in the new update do not erase useful known information. It also treats a missing limit bucket ID as the default `codex` bucket.

**Data flow**: It receives an optional previous snapshot and a new snapshot. It fills in missing limit ID, credits, individual-limit, and plan-type fields from defaults or the previous snapshot where appropriate, then returns the completed snapshot.

**Call relations**: `SessionState::set_rate_limits` calls this whenever new rate-limit data arrives. This helper keeps the merging rule in one place, so the rest of session state can simply store the corrected snapshot.

*Call graph*: called by 1 (set_rate_limits).


### `core/src/state/auto_compact_window.rs`

`domain_logic` · `cross-cutting during conversation state updates and auto-compaction`

Large language model conversations have a limited context size: only so much text can fit into one request. Auto-compaction is the system’s way of starting a fresh accounting window when old context has been compacted or reset. This file is the small state machine that remembers which window the system is in, whether a new window has been requested, and the token baseline for that window.

The main idea is like resetting a trip odometer in a car. The total mileage still exists, but the system wants to know how far it has gone since the reset. Here, the “mileage” is input tokens. The file stores a prefill token count: the amount of input context that was already present before new conversation growth should be charged against the auto-compact budget.

There are two kinds of prefill values. An estimated value can be set when the system has to guess, such as after resuming or rebuilding state. A server-observed value comes from actual token usage reported by the model server and is trusted more. Once a server-observed value is recorded, later estimates cannot overwrite it.

The file also supports one-shot requests for a new context window. Code can request a reset, and later another part of the system can “take” that request, which reads it and clears it so it is not processed twice.

#### Function details

##### `AutoCompactWindow::new`  (lines 27–33)

```
fn new() -> Self
```

**Purpose**: Creates a fresh auto-compact window tracker. It starts at window 0, with no pending request for a new window and no token baseline yet.

**Data flow**: Nothing is provided as input. The function builds a new `AutoCompactWindow` with default starting values and returns it to the caller.

**Call relations**: This is used when the surrounding state object is first created, and the test also uses it to start from a clean example. It gives the rest of the auto-compaction flow a known starting point.

*Call graph*: called by 2 (tracks_prefill_and_window_boundaries, new).


##### `AutoCompactWindow::clear_prefill`  (lines 35–37)

```
fn clear_prefill(&mut self)
```

**Purpose**: Forgets the stored prefill token baseline. This is useful when the conversation history is replaced or a new context window begins, because the old baseline no longer describes the current window.

**Data flow**: It takes the current window tracker as mutable state. It changes only the prefill field, setting it back to empty, and returns no value.

**Call relations**: The history replacement path and the new-context-window startup path call this when they need to discard old token accounting. After this, another part of the system can set a fresh estimate or wait for server-reported usage.

*Call graph*: called by 2 (replace_history, start_new_context_window_if_requested).


##### `AutoCompactWindow::window_id`  (lines 39–41)

```
fn window_id(&self) -> u64
```

**Purpose**: Returns the identifier of the current auto-compact window. Other code can use this to tell whether it is still looking at the same accounting period or a newer one.

**Data flow**: It reads the stored window number from the tracker and returns that number without changing anything.

**Call relations**: The higher-level `auto_compact_window_id` accessor calls this to expose the current window number. It is a simple read-only doorway into this piece of state.

*Call graph*: called by 1 (auto_compact_window_id).


##### `AutoCompactWindow::set_window_id`  (lines 43–45)

```
fn set_window_id(&mut self, window_id: u64)
```

**Purpose**: Sets the current window identifier to a specific value. This is useful when restoring or synchronizing state rather than simply moving to the next window.

**Data flow**: It receives a window number from the caller. It writes that number into the tracker and returns no separate result.

**Call relations**: The surrounding state API calls this through `set_auto_compact_window_id`. That lets code outside this small struct update the saved window identity in a controlled way.

*Call graph*: called by 1 (set_auto_compact_window_id).


##### `AutoCompactWindow::advance_window_id`  (lines 47–51)

```
fn advance_window_id(&mut self) -> u64
```

**Purpose**: Moves the tracker to the next auto-compact window and clears any pending request for a new window. This marks that the requested transition has actually happened.

**Data flow**: It reads the current window number, increases it by one without overflowing past the maximum integer value, clears the new-window request flag, and returns the updated window number.

**Call relations**: This is called when higher-level code advances the auto-compact window directly or when `start_new_context_window_if_requested` follows through on a pending request. It hands back the new ID so the caller can continue using the updated window identity.

*Call graph*: called by 2 (advance_auto_compact_window_id, start_new_context_window_if_requested).


##### `AutoCompactWindow::request_new_context_window`  (lines 53–55)

```
fn request_new_context_window(&mut self)
```

**Purpose**: Marks that the system should start a new context window soon. It does not perform the reset immediately; it leaves a flag for the part of the system that is responsible for doing the transition.

**Data flow**: It takes the current tracker as mutable state, changes the request flag from false to true, and returns no value.

**Call relations**: The higher-level `request_new_context_window` path calls this when something decides a fresh accounting window is needed. Later, `start_new_context_window_if_requested` checks and consumes this request.

*Call graph*: called by 1 (request_new_context_window).


##### `AutoCompactWindow::take_new_context_window_request`  (lines 57–61)

```
fn take_new_context_window_request(&mut self) -> bool
```

**Purpose**: Checks whether a new context window was requested, then clears the request. This makes the request a one-time signal, so the same request is not acted on repeatedly.

**Data flow**: It reads the request flag, stores that answer, resets the flag to false, and returns the stored answer to the caller.

**Call relations**: `start_new_context_window_if_requested` calls this when it is ready to decide whether to begin a new window. If the answer is true, that caller can continue with the reset; if false, it can leave the current window alone.

*Call graph*: called by 1 (start_new_context_window_if_requested).


##### `AutoCompactWindow::ensure_server_observed_prefill_from_usage`  (lines 66–77)

```
fn ensure_server_observed_prefill_from_usage(&mut self, usage: &TokenUsage)
```

**Purpose**: Records the input-token baseline reported by the server, but only if a server-confirmed baseline has not already been recorded. Server-reported usage is treated as more reliable than an earlier estimate.

**Data flow**: It receives token usage from the model server and reads the `input_tokens` value. If no server-observed prefill is already present, it stores the input-token count, never below zero; if a server-observed value already exists, it leaves the existing value unchanged.

**Call relations**: `ensure_auto_compact_window_server_prefill_from_usage` calls this after token usage information is available. This function then upgrades the window’s accounting from a guess to a server-confirmed baseline, and protects that confirmed value from later replacement.

*Call graph*: called by 1 (ensure_auto_compact_window_server_prefill_from_usage); 2 external calls (ServerObserved, matches!).


##### `AutoCompactWindow::set_estimated_prefill`  (lines 79–88)

```
fn set_estimated_prefill(&mut self, tokens: i64)
```

**Purpose**: Stores an estimated input-token baseline for the current window. It is a fallback for times when the system needs a baseline before it has a server-confirmed number.

**Data flow**: It receives a token count from the caller. If a server-observed baseline is already stored, it does nothing; otherwise it stores the given count, with negative values treated as zero.

**Call relations**: `set_auto_compact_window_estimated_prefill` calls this when higher-level state has to make an estimated baseline. If a later server usage sample arrives, `ensure_server_observed_prefill_from_usage` can replace this estimate with a more trustworthy value.

*Call graph*: called by 1 (set_auto_compact_window_estimated_prefill); 2 external calls (Estimated, matches!).


##### `AutoCompactWindow::snapshot`  (lines 90–99)

```
fn snapshot(&self) -> AutoCompactWindowSnapshot
```

**Purpose**: Creates a simple read-only summary of the current prefill token baseline. This lets other code inspect the accounting state without exposing the internal distinction between estimated and server-observed values.

**Data flow**: It reads the stored prefill value, whether estimated or server-observed. It returns an `AutoCompactWindowSnapshot` containing just the token number if one exists, or nothing if no baseline has been set.

**Call relations**: The higher-level `auto_compact_window_snapshot` accessor calls this when code needs a compact view of the window state. The snapshot is safe to pass around because it does not allow callers to mutate the underlying tracker.

*Call graph*: called by 1 (auto_compact_window_snapshot).


##### `tests::tracks_prefill_and_window_boundaries`  (lines 108–161)

```
fn tracks_prefill_and_window_boundaries()
```

**Purpose**: Checks that the window tracker behaves as intended across common state changes. It verifies window IDs, one-time new-window requests, estimated prefill values, and the rule that server-observed prefill wins over estimates.

**Data flow**: The test creates a fresh tracker, changes its window ID, requests and consumes new windows, sets estimated and server-observed token baselines, and compares snapshots against expected results. Its output is a pass or fail result from the test runner.

**Call relations**: This test calls the tracker’s public-in-module methods in the same kind of sequence the real state system would use. It acts as a safety net so future changes do not accidentally break token baseline accounting or window-boundary behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert!, assert_eq!).


### `core/src/tasks/mod.rs`

`orchestration` · `active during turn startup, background task execution, completion, interruption, and cleanup`

A “turn” is one round of work after the user or system gives Codex something to do. This file makes sure only the right turn is running, that old work is cancelled before new work starts, and that the rest of the system hears clear start, finish, and abort signals. Without it, two turns could overlap, interrupted work might keep running, clients might miss completion events, and telemetry would not know what happened.

The file defines a small task interface, SessionTask, so different kinds of turn work can be run in the same way. A task is like a worker hired for one job: it says what kind of job it is, runs in the background, and may clean up if it is stopped early. Session::start_task wraps that worker with shared session context, cancellation support, timing, tracing, and bookkeeping. When a task ends, Session::on_task_finished records pending input, token usage, tool-call counts, memory-use facts, and sends a TurnComplete event. When a task is interrupted, Session::handle_task_abort gives it a brief chance to stop politely, then forces it down if needed and sends a TurnAborted event.

The file also adds a model-visible marker when a turn is interrupted, so later model calls understand that the previous answer was cut off. Think of it as placing a bookmark in the conversation saying, “This page ended suddenly.”

#### Function details

##### `InterruptedTurnHistoryMarker::from_config_and_version`  (lines 76–88)

```
fn from_config_and_version(
        config: &Config,
        multi_agent_version: MultiAgentVersion,
    ) -> Self
```

**Purpose**: Chooses what kind of conversation marker should be written when a turn is interrupted. It uses configuration and the multi-agent protocol version to decide whether the marker is disabled, written as contextual user text, or written as developer guidance.

**Data flow**: It receives the session configuration and the multi-agent version. If interrupt messages are turned off in the config, it returns Disabled. Otherwise it returns Developer for version 2 and ContextualUser for older versions.

**Call relations**: The abort path calls this when a task is interrupted so it can record the right kind of marker. Forking and subagent flows also use it so snapshots and child agents describe interruptions consistently.

*Call graph*: called by 3 (handle_task_abort, fork_thread_with_initial_history, spawn_subagent).


##### `interrupted_turn_history_marker`  (lines 93–116)

```
fn interrupted_turn_history_marker(
    marker: InterruptedTurnHistoryMarker,
) -> Option<ResponseItem>
```

**Purpose**: Builds the actual conversation item that tells the model a previous turn was interrupted. This is what later model calls can read to avoid treating the cut-off response as complete.

**Data flow**: It receives a marker choice. Disabled becomes no item. ContextualUser becomes a contextual user fragment with interruption guidance. Developer becomes a developer-role message containing developer-facing interruption guidance.

**Call relations**: The abort code calls this after deciding which marker style is allowed. Other history-building paths also call it so real interrupts and copied conversation snapshots use the same marker format.

*Call graph*: calls 2 internal fn (into, new); called by 4 (handle_task_abort, append_interrupted_boundary, contextual_user_interrupted_marker, developer_interrupted_marker); 1 external calls (vec!).


##### `emit_turn_network_proxy_metric`  (lines 118–133)

```
fn emit_turn_network_proxy_metric(
    session_telemetry: &SessionTelemetry,
    network_proxy_active: bool,
    tmp_mem: (&str, &str),
)
```

**Purpose**: Records whether the managed network proxy was active during a turn. This helps operators understand how often turns run with network routing enabled.

**Data flow**: It receives telemetry, a true-or-false proxy status, and an extra temporary memory-related tag. It converts the status into the text tag "true" or "false" and increments the network proxy metric.

**Call relations**: Session::on_task_finished calls this near the end of a turn after checking the current proxy state. It hands the result to the telemetry system as one small part of the turn summary.

*Call graph*: calls 1 internal fn (counter); called by 1 (on_task_finished).


##### `emit_turn_memory_metric`  (lines 135–152)

```
fn emit_turn_memory_metric(
    session_telemetry: &SessionTelemetry,
    feature_enabled: bool,
    config_enabled: bool,
    has_citations: bool,
)
```

**Purpose**: Records whether memory reading was allowed and whether the turn actually cited memory. This helps compare feature settings with real memory use.

**Data flow**: It receives telemetry plus three booleans: whether the memory feature exists, whether config allows it, and whether citations appeared. It combines feature and config into a read_allowed value, converts booleans into metric tags, and increments the memory metric.

**Call relations**: Session::on_task_finished calls this after reading the turn state. It uses bool_tag to format values the telemetry system expects.

*Call graph*: calls 2 internal fn (bool_tag, counter); called by 1 (on_task_finished).


##### `emit_compact_metric`  (lines 154–164)

```
fn emit_compact_metric(
    session_telemetry: &SessionTelemetry,
    compact_type: &'static str,
    manual: bool,
)
```

**Purpose**: Records that conversation compaction ran. Compaction means shortening or summarizing stored context so future model calls fit within limits.

**Data flow**: It receives telemetry, the type of compaction, and whether it was started manually. It converts the manual flag into a text tag and increments the compaction metric with those labels.

**Call relations**: Automatic compaction code calls this when compaction happens. This file exposes it because compaction is one of the task types coordinated by the session task system.

*Call graph*: calls 2 internal fn (bool_tag, counter); called by 1 (run_auto_compact).


##### `bool_tag`  (lines 166–168)

```
fn bool_tag(value: bool) -> &'static str
```

**Purpose**: Converts a true-or-false value into the exact text labels used by telemetry tags. It keeps metric formatting consistent.

**Data flow**: It receives a boolean. True becomes "true" and false becomes "false".

**Call relations**: Metric helpers call this before sending data to telemetry. It is deliberately tiny so all related metrics use the same spelling.

*Call graph*: called by 2 (emit_compact_metric, emit_turn_memory_metric).


##### `SessionTaskContext::new`  (lines 178–183)

```
fn new(session: Arc<Session>, turn_extension_data: Arc<ExtensionData>) -> Self
```

**Purpose**: Creates the small shared context object that task runners receive. It gives tasks access to the session and extension data without exposing every detail directly.

**Data flow**: It receives a shared Session and shared ExtensionData. It stores both inside a SessionTaskContext and returns that context.

**Call relations**: Session::start_task uses this when launching a task. Session::handle_task_abort uses it again when giving an interrupted task a chance to clean up.

*Call graph*: called by 2 (handle_task_abort, start_task).


##### `SessionTaskContext::clone_session`  (lines 185–187)

```
fn clone_session(&self) -> Arc<Session>
```

**Purpose**: Returns another shared reference to the session for code that needs to call session methods. This avoids moving or owning the session outright.

**Data flow**: It reads the session reference stored in the context and returns a cloned shared pointer to the same session object.

**Call relations**: Task-running code can call this after receiving a SessionTaskContext. It is especially useful inside spawned background work where ownership must be shared safely.

*Call graph*: 1 external calls (clone).


##### `SessionTaskContext::turn_extension_data`  (lines 189–191)

```
fn turn_extension_data(&self) -> Arc<ExtensionData>
```

**Purpose**: Returns the extension data attached to this turn. Extensions can use this to read or write information tied to the current turn.

**Data flow**: It reads the stored ExtensionData reference and returns another shared pointer to the same data.

**Call relations**: Session tasks use this through the context when they need turn-specific extension state. The context was created by Session::start_task or the abort cleanup path.

*Call graph*: 1 external calls (clone).


##### `SessionTaskContext::auth_manager`  (lines 193–195)

```
fn auth_manager(&self) -> Arc<AuthManager>
```

**Purpose**: Gives a task access to the authentication manager, which is the component responsible for login and credentials. This lets task code perform authenticated operations when needed.

**Data flow**: It reaches through the stored session to the session services, clones the shared AuthManager pointer, and returns it.

**Call relations**: Task implementations can call this through their SessionTaskContext instead of knowing how services are stored inside Session.

*Call graph*: 1 external calls (clone).


##### `SessionTaskContext::models_manager`  (lines 197–199)

```
fn models_manager(&self) -> SharedModelsManager
```

**Purpose**: Gives a task access to the shared model manager, the component that tracks available model information. This lets tasks ask about or use models without owning that service.

**Data flow**: It reads the models manager from the session services, clones the shared pointer, and returns it.

**Call relations**: Task implementations use this when they need model-related services. It keeps task code connected to session services through a narrow wrapper.

*Call graph*: 1 external calls (clone).


##### `SessionTask::abort`  (lines 239–247)

```
fn abort(
        &self,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
    ) -> impl std::future::Future<Output = ()> + Send
```

**Purpose**: Provides the default cleanup hook for a task that is being aborted. By default it does nothing, but task types can override it when they need special shutdown work.

**Data flow**: It receives the session context and turn context, then ignores them and completes immediately. No state is changed by the default version.

**Call relations**: The generic task adapter exposes this method, and Session::handle_task_abort eventually calls it through that adapter. Specific tasks can replace this no-op behavior with real cleanup.

*Call graph*: called by 1 (abort).


##### `T::kind`  (lines 274–276)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Adapts any concrete SessionTask so it can be treated as a generic task object. It asks the concrete task what kind of work it represents.

**Data flow**: It receives a task value through the trait object adapter and forwards the request to that task’s own kind method. The TaskKind result comes back unchanged.

**Call relations**: Session::start_task stores tasks behind a common AnySessionTask interface. This adapter method lets the session ask for the task kind without knowing the concrete task type.

*Call graph*: 1 external calls (kind).


##### `T::span_name`  (lines 278–280)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Adapts any concrete SessionTask so tracing can name its background span. A tracing span is a labeled timing/logging scope used to follow work across async code.

**Data flow**: It receives the task through the adapter and forwards the call to the concrete task’s span_name method. It returns the static name supplied by that task.

**Call relations**: Session::start_task uses this through the generic task interface before spawning the background task, so logs and telemetry carry the right task name.

*Call graph*: 1 external calls (span_name).


##### `T::run`  (lines 282–296)

```
fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> BoxFutu
```

**Purpose**: Wraps a concrete task’s run method into a boxed future, which is a uniform async job value. This lets different task types be stored and launched through one shared interface.

**Data flow**: It receives the shared task, session context, turn context, input items, and cancellation token. It calls the task’s real run method and boxes the returned future so callers do not need to know its exact concrete type.

**Call relations**: Session::start_task calls run through AnySessionTask after converting a concrete SessionTask into a generic object. The adapter then hands execution to the real task implementation.

*Call graph*: 2 external calls (pin, run).


##### `T::abort`  (lines 298–304)

```
fn abort(
        &'a self,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
    ) -> BoxFuture<'a, ()>
```

**Purpose**: Wraps a concrete task’s abort cleanup method into a boxed future. This allows the session to call cleanup in the same way for every task type.

**Data flow**: It receives the task plus session and turn contexts. It calls the concrete task’s abort method and boxes the resulting async work.

**Call relations**: Session::handle_task_abort calls this through the generic AnySessionTask interface after cancelling the task. The adapter forwards cleanup to the task-specific implementation or the default no-op.

*Call graph*: calls 1 internal fn (abort); 1 external calls (pin).


##### `Session::spawn_task`  (lines 308–317)

```
async fn spawn_task(
        self: &Arc<Self>,
        turn_context: Arc<TurnContext>,
        input: Vec<TurnInput>,
        task: T,
    )
```

**Purpose**: Starts a new session task after first stopping any currently running one. This is the safe public path for replacing the active turn with new work.

**Data flow**: It receives a turn context, turn input, and a concrete task. It aborts existing tasks with the Replaced reason, clears connector selection, then passes the new task to start_task.

**Call relations**: Callers use this when a new explicit task should begin. It delegates the detailed launch work to Session::start_task after making sure the session is not already busy.

*Call graph*: calls 2 internal fn (abort_all_tasks, start_task).


##### `Session::start_task`  (lines 319–445)

```
async fn start_task(
        self: &Arc<Self>,
        turn_context: Arc<TurnContext>,
        input: Vec<TurnInput>,
        task: T,
    )
```

**Purpose**: Launches a turn task in the background and records all the state needed to track, cancel, and finish it. This is the main setup point for a running turn.

**Data flow**: It receives the turn context, input, and task. It records start time and starting token usage, prepares cancellation and notification objects, attaches pending input to turn state, builds a task context, creates a tracing span, spawns the async task, starts a duration timer, and stores a RunningTask in the active turn.

**Call relations**: Session::spawn_task calls this for normal new work, and pending-work startup calls it when mailbox input should wake an idle session. The spawned task eventually calls Session::on_task_finished unless it was cancelled.

*Call graph*: calls 1 internal fn (new); called by 2 (maybe_start_turn_for_pending_work_with_sub_id, spawn_task); 15 external calls (new, clone, new, new, now, new, kind, span_name, debug_assert!, format! (+5 more)).


##### `Session::maybe_start_turn_for_pending_work`  (lines 453–456)

```
async fn maybe_start_turn_for_pending_work(self: &Arc<Self>)
```

**Purpose**: Starts a new regular turn if the session is idle and queued input says a turn should be triggered. It creates a fresh turn id for that synthetic turn.

**Data flow**: It creates a new random sub-id, then passes that id to maybe_start_turn_for_pending_work_with_sub_id. The result is either no action or a newly started regular task.

**Call relations**: Abort paths call this after an interruption because pending mailbox work may need to resume immediately. It delegates the actual checks and task startup to the sub-id-specific helper.

*Call graph*: calls 1 internal fn (maybe_start_turn_for_pending_work_with_sub_id); called by 2 (abort_all_tasks, abort_turn_if_active); 1 external calls (new_v4).


##### `Session::maybe_start_turn_for_pending_work_with_sub_id`  (lines 463–484)

```
async fn maybe_start_turn_for_pending_work_with_sub_id(
        self: &Arc<Self>,
        sub_id: String,
    )
```

**Purpose**: Starts a regular task for queued work, but only when queued mailbox items request it and no turn is already active. This prevents background mail from being ignored while also avoiding overlapping turns.

**Data flow**: It receives the sub-id to use for the new turn. It checks whether trigger-turn mailbox items exist, checks and marks the session as active if idle, builds a default turn context with that sub-id, possibly emits an unknown-model warning, and starts a RegularTask with no direct user input.

**Call relations**: maybe_start_turn_for_pending_work calls this with a fresh id. It calls Session::start_task once it has proven that a pending turn should actually begin.

*Call graph*: calls 3 internal fn (default, start_task, new); called by 1 (maybe_start_turn_for_pending_work); 1 external calls (new).


##### `Session::abort_all_tasks`  (lines 486–514)

```
async fn abort_all_tasks(self: &Arc<Self>, reason: TurnAbortReason)
```

**Purpose**: Stops the currently active task, if there is one, and cleans up turn state afterward. This is used when new work replaces old work or when the user interrupts the session.

**Data flow**: It takes the active turn out of the session, removes its task, and if a task existed sends it to handle_task_abort with the given reason. It emits abort lifecycle events, clears pending input after the task has seen cancellation, and may start pending work again after an interruption.

**Call relations**: Session::spawn_task calls this before launching replacement work. It relies on take_active_turn to remove the active turn and handle_task_abort to perform the actual task cancellation.

*Call graph*: calls 3 internal fn (handle_task_abort, maybe_start_turn_for_pending_work, take_active_turn); called by 1 (spawn_task); 1 external calls (clone).


##### `Session::abort_turn_if_active`  (lines 516–555)

```
async fn abort_turn_if_active(
        self: &Arc<Self>,
        turn_id: &str,
        reason: TurnAbortReason,
    ) -> bool
```

**Purpose**: Stops a specific active turn only if its turn id matches the requested id. This lets callers cancel one known turn without accidentally cancelling newer work.

**Data flow**: It receives a turn id and abort reason. It checks the active task’s turn id; if it matches, it removes the active turn, aborts the task, emits lifecycle cleanup, clears pending input, possibly starts pending work, and returns true. If there is no match, it returns false.

**Call relations**: External or higher-level cancellation flows can use this targeted abort path. Like abort_all_tasks, it delegates the cancellation details to handle_task_abort.

*Call graph*: calls 2 internal fn (handle_task_abort, maybe_start_turn_for_pending_work); 1 external calls (clone).


##### `Session::on_task_finished`  (lines 557–775)

```
async fn on_task_finished(
        self: &Arc<Self>,
        turn_context: Arc<TurnContext>,
        last_agent_message: Option<String>,
    )
```

**Purpose**: Finalizes a turn that completed normally. It records useful facts, sends the TurnComplete event to the client, clears active state, and marks the thread idle if nothing else is running.

**Data flow**: It receives the turn context and optional final agent message. It detaches the task handle, gathers pending input and turn state, runs hooks for pending input, computes token usage since turn start, emits metrics and analytics, emits lifecycle stop events, sends a completion event, clears rejection state, and removes the active turn if it still matches this turn.

**Call relations**: The background task spawned by Session::start_task calls this after the task’s run method returns and the transcript is flushed. It calls helper functions for pending-input inspection and telemetry such as emit_turn_network_proxy_metric and emit_turn_memory_metric.

*Call graph*: calls 5 internal fn (inspect_pending_input, record_additional_contexts, record_pending_input, emit_turn_memory_metric, emit_turn_network_proxy_metric); 5 external calls (ptr_eq, current, try_from, TurnComplete, warn!).


##### `Session::take_active_turn`  (lines 777–780)

```
async fn take_active_turn(&self) -> Option<ActiveTurn>
```

**Purpose**: Removes and returns the current active turn from the session. This is a small helper used when the session needs to stop owning the active turn before aborting it.

**Data flow**: It locks the active-turn slot, takes out the Option value, leaves the slot empty, and returns the previous active turn if one existed.

**Call relations**: Session::abort_all_tasks calls this before aborting so the task is no longer considered active while cancellation and cleanup proceed.

*Call graph*: called by 1 (abort_all_tasks).


##### `Session::close_unified_exec_processes`  (lines 782–787)

```
async fn close_unified_exec_processes(&self)
```

**Purpose**: Terminates all background execution processes owned by the unified execution manager. This is a cleanup tool for shell or command processes that may still be running.

**Data flow**: It reads the unified execution manager from session services and asks it to terminate every process. It does not return process details.

**Call relations**: Other session control code can call this when shutting down or cleaning up execution resources. The actual process work is delegated to the unified execution manager.


##### `Session::list_background_terminals`  (lines 789–791)

```
async fn list_background_terminals(&self) -> Vec<BackgroundTerminalInfo>
```

**Purpose**: Returns information about currently running background terminal processes. This lets clients show users what background command sessions exist.

**Data flow**: It asks the unified execution manager for its process list and returns that list as BackgroundTerminalInfo values.

**Call relations**: UI or protocol code can call this when it needs to display background terminals. This method is a session-level doorway to the underlying execution manager.


##### `Session::terminate_background_terminal`  (lines 793–798)

```
async fn terminate_background_terminal(&self, process_id: i32) -> bool
```

**Purpose**: Stops one background terminal process by process id. It gives callers a focused way to kill a single running command session.

**Data flow**: It receives a numeric process id, passes it to the unified execution manager, and returns true or false depending on whether termination succeeded.

**Call relations**: Client-facing terminal controls can call this when a user chooses to stop one background process. The session delegates the actual termination to the unified execution manager.


##### `Session::handle_task_abort`  (lines 800–874)

```
async fn handle_task_abort(self: &Arc<Self>, task: RunningTask, reason: TurnAbortReason)
```

**Purpose**: Performs the detailed shutdown of one running task. It cancels the task, waits briefly for a graceful stop, forces abort if needed, lets the task clean up, records interruption history when appropriate, and sends the TurnAborted event.

**Data flow**: It receives a RunningTask and an abort reason. If the task is not already cancelled, it cancels the token, cancels git enrichment, waits up to a short timeout for the task to finish, aborts the task handle, calls task-specific cleanup, optionally writes an interruption marker to conversation history, records timing and analytics, sends the abort event, and clears guardian rejection state.

**Call relations**: Session::abort_all_tasks and Session::abort_turn_if_active call this after removing a task from active state. It uses InterruptedTurnHistoryMarker::from_config_and_version and interrupted_turn_history_marker to make interruptions visible in later conversation history.

*Call graph*: calls 3 internal fn (from_config_and_version, new, interrupted_turn_history_marker); called by 2 (abort_all_tasks, abort_turn_if_active); 7 external calls (clone, new, TurnAborted, select!, from_ref, trace!, warn!).


### `core/src/state/turn.rs`

`data_model` · `per-turn state during request handling`

A “turn” is one cycle of work after the user asks for something. During that cycle, the system may run a task, ask for approval, request extra permissions, wait for user input, call external tools, or receive messages from child tasks. This file gives all of that temporary state one home.

The main wrapper is ActiveTurn. It records the currently running task, if there is one, and points to a TurnState protected by a mutex, which is a lock that stops two async jobs from changing the same data at once. RunningTask stores the live task’s cancellation handle, completion signal, context, extension data, and timing guard.

TurnState is the practical core. It keeps maps of “pending” requests, keyed by IDs, where each entry contains a one-shot sender. A one-shot sender is like a single-use return envelope: when a response arrives, the code finds the matching sender and delivers the answer to the part of the system that is waiting.

It also tracks mailbox delivery rules. After a visible final answer, late child messages should usually wait for the next turn instead of changing an answer the user already saw. Finally, it remembers permissions granted for each environment and whether stricter automatic review is enabled for this turn.

#### Function details

##### `ActiveTurn::default`  (lines 57–62)

```
fn default() -> Self
```

**Purpose**: Creates a fresh ActiveTurn with no running task and a new, empty TurnState. This is used when a session needs a clean starting point for turn-scoped state.

**Data flow**: No input is needed. The function builds an ActiveTurn where task is empty, creates a default TurnState, wraps it in a shared pointer and mutex for safe async sharing, and returns the ready-to-use value.

**Call relations**: Tests and session flows call this when they need a blank active-turn container. It relies on the default TurnState setup so all pending request lists, mailbox rules, counters, and flags start in their normal empty state.

*Call graph*: called by 17 (handle_request_permissions_uses_tool_call_id_for_round_trip, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, prompt_mode_waits_for_approval_when_annotations_do_not_require_approval, enable_strict_auto_review_for_turn_uses_originating_turn, request_permissions_guardian_review_stops_when_cancelled, request_permissions_routes_to_guardian_when_reviewer_is_enabled, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, notify_request_permissions_response_ignores_unmatched_call_id, record_granted_request_permissions_for_turn_uses_originating_turn (+7 more)); 3 external calls (new, new, default).


##### `TurnState::insert_pending_approval`  (lines 109–115)

```
fn insert_pending_approval(
        &mut self,
        key: String,
        tx: oneshot::Sender<ReviewDecision>,
    ) -> Option<oneshot::Sender<ReviewDecision>>
```

**Purpose**: Registers that the current turn is waiting for a review or approval decision. The stored sender is the route used later to deliver that decision back to the waiting code.

**Data flow**: It takes a text key and a single-use sender for a ReviewDecision. It puts that sender into the pending approvals map under the key, and returns any older sender that was already stored for the same key.

**Call relations**: Other turn-processing code uses this before asking for an approval. A later response path is expected to use TurnState::remove_pending_approval with the same key so the answer can be sent to the original waiter.


##### `TurnState::remove_pending_approval`  (lines 117–122)

```
fn remove_pending_approval(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<ReviewDecision>>
```

**Purpose**: Finds and removes a waiting approval request. This is how an incoming approval answer is matched back to the code that asked for it.

**Data flow**: It receives a key, looks in the pending approvals map, removes the matching sender if present, and returns it. If no request with that key is waiting, it returns nothing.

**Call relations**: This is the counterpart to TurnState::insert_pending_approval. Response-handling code calls it when an approval decision arrives, then uses the returned sender to wake the original requester.


##### `TurnState::clear_pending_waiters`  (lines 124–130)

```
fn clear_pending_waiters(&mut self)
```

**Purpose**: Drops all outstanding waiters for approvals, permission requests, user input, elicitations, and dynamic tool responses. This is useful when a turn is cancelled or ended and nobody should keep waiting for old answers.

**Data flow**: It reads no outside data. It empties each pending-response map in the TurnState, which also drops the one-shot senders stored there. Afterward, those pending requests are no longer tracked.

**Call relations**: Turn cleanup or cancellation code can call this to make the state safe to discard. It does not hand work to another function; it simply clears every category of pending waiter at once.


##### `TurnState::insert_pending_request_permissions`  (lines 132–139)

```
fn insert_pending_request_permissions(
        &mut self,
        key: String,
        pending_request_permissions: PendingRequestPermissions,
    ) -> Option<PendingRequestPermissions>
```

**Purpose**: Records that the turn has asked for extra permissions and is waiting for a permissions response. It keeps not just the reply route, but also what permissions were requested and which environment they apply to.

**Data flow**: It takes a key and a PendingRequestPermissions record. It stores that record in the pending permission-request map and returns any previous record that used the same key.

**Call relations**: Permission-request code uses this before sending a request out for review or user approval. When the response comes back, the matching path should call TurnState::remove_pending_request_permissions to recover the saved request details and response sender.


##### `TurnState::remove_pending_request_permissions`  (lines 141–146)

```
fn remove_pending_request_permissions(
        &mut self,
        key: &str,
    ) -> Option<PendingRequestPermissions>
```

**Purpose**: Retrieves and removes a pending permission request. This lets the system match an incoming permissions answer to the exact request that started it.

**Data flow**: It receives a key, removes the matching PendingRequestPermissions record from the map if one exists, and returns it. If the key is unknown, it returns nothing.

**Call relations**: This pairs with TurnState::insert_pending_request_permissions. Response-handling code uses it when a permissions decision arrives so it can send the answer back and know which requested permissions and environment were involved.


##### `TurnState::insert_pending_user_input`  (lines 148–154)

```
fn insert_pending_user_input(
        &mut self,
        key: String,
        tx: oneshot::Sender<RequestUserInputResponse>,
    ) -> Option<oneshot::Sender<RequestUserInputResponse>>
```

**Purpose**: Records that the turn is waiting for direct user input. The stored sender is the channel used to return the user’s answer to the waiting task.

**Data flow**: It takes a key and a single-use sender for a RequestUserInputResponse. It stores the sender under the key and returns any older sender that had the same key.

**Call relations**: Code that asks the user a follow-up question uses this before sending the prompt. Later, when the user answers, the response path should call TurnState::remove_pending_user_input to find where to deliver that answer.


##### `TurnState::remove_pending_user_input`  (lines 156–161)

```
fn remove_pending_user_input(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<RequestUserInputResponse>>
```

**Purpose**: Finds and removes the waiting slot for a user-input request. It is the lookup step that connects a user’s answer with the task that asked the question.

**Data flow**: It receives a key, removes the matching user-input sender from the map, and returns it if present. If no matching request is waiting, it returns nothing.

**Call relations**: This is the response-side partner of TurnState::insert_pending_user_input. User-input response handling uses it to wake the task that was paused for the user’s answer.


##### `TurnState::insert_pending_elicitation`  (lines 163–171)

```
fn insert_pending_elicitation(
        &mut self,
        server_name: String,
        request_id: RequestId,
        tx: oneshot::Sender<ElicitationResponse>,
    ) -> Option<oneshot::Sender<Elicitat
```

**Purpose**: Registers that an external server has asked for more information and the turn is waiting for that elicitation response. “Elicitation” here means a tool or server prompting the user or system for extra details.

**Data flow**: It takes the server name, that server’s request ID, and a single-use sender for an ElicitationResponse. It stores the sender under the combined server-and-request key and returns any older sender for the same pair.

**Call relations**: External-tool or server integration code uses this when it starts an elicitation request. The matching answer path should later call TurnState::remove_pending_elicitation with the same server name and request ID.


##### `TurnState::remove_pending_elicitation`  (lines 173–180)

```
fn remove_pending_elicitation(
        &mut self,
        server_name: &str,
        request_id: &RequestId,
    ) -> Option<oneshot::Sender<ElicitationResponse>>
```

**Purpose**: Looks up and removes a waiting elicitation response for a specific server and request ID. This prevents responses from different servers or repeated request IDs from being mixed up.

**Data flow**: It receives a server name and request ID, builds the same combined key used for insertion, removes the sender if present, and returns it. It clones the request ID only to form the lookup key safely.

**Call relations**: This completes the flow started by TurnState::insert_pending_elicitation. When an elicitation answer arrives, response-handling code calls this to recover the correct sender and deliver the answer.

*Call graph*: 1 external calls (clone).


##### `TurnState::insert_pending_dynamic_tool`  (lines 182–188)

```
fn insert_pending_dynamic_tool(
        &mut self,
        key: String,
        tx: oneshot::Sender<DynamicToolResponse>,
    ) -> Option<oneshot::Sender<DynamicToolResponse>>
```

**Purpose**: Records that the turn is waiting for a response from a dynamic tool. A dynamic tool is a tool whose availability or behavior can be provided at runtime rather than being fixed in advance.

**Data flow**: It takes a key and a single-use sender for a DynamicToolResponse. It stores the sender in the pending dynamic-tool map and returns any previous sender for the same key.

**Call relations**: Tool-calling code uses this before waiting on a dynamic tool result. Later, when the tool response arrives, the matching path should call TurnState::remove_pending_dynamic_tool.


##### `TurnState::remove_pending_dynamic_tool`  (lines 190–195)

```
fn remove_pending_dynamic_tool(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<DynamicToolResponse>>
```

**Purpose**: Finds and removes the waiting slot for a dynamic tool response. This is how the tool’s answer is routed back to the part of the turn that requested it.

**Data flow**: It receives a key, removes the matching dynamic-tool sender from the map, and returns it if found. If there is no matching pending tool call, it returns nothing.

**Call relations**: This pairs with TurnState::insert_pending_dynamic_tool. Dynamic-tool response handling uses it to finish the waiting request and avoid leaving stale entries in the turn state.


##### `TurnState::accept_mailbox_delivery_for_current_turn`  (lines 197–199)

```
fn accept_mailbox_delivery_for_current_turn(&mut self)
```

**Purpose**: Reopens the current turn to accept queued mailbox messages. This matters when follow-up work should include messages that otherwise might have waited for the next turn.

**Data flow**: It takes no outside input. It changes the mailbox delivery phase inside TurnState to CurrentTurn, meaning mailbox messages may be folded into the current turn again.

**Call relations**: This is a convenience wrapper around TurnState::set_mailbox_delivery_phase. Code can call it when explicit same-turn work resumes and child messages should again be included in the current model request.

*Call graph*: calls 1 internal fn (set_mailbox_delivery_phase).


##### `TurnState::accepts_mailbox_delivery_for_current_turn`  (lines 201–203)

```
fn accepts_mailbox_delivery_for_current_turn(&self) -> bool
```

**Purpose**: Answers whether mailbox messages are currently allowed to join this turn. It is a small yes-or-no check used before draining queued child messages into ongoing work.

**Data flow**: It reads the mailbox delivery phase from TurnState. If the phase is CurrentTurn it returns true; if the phase is NextTurn it returns false.

**Call relations**: Turn orchestration code can call this before deciding whether to consume mailbox messages now or leave them queued. It does not call other project functions; it simply reports the current state.


##### `TurnState::set_mailbox_delivery_phase`  (lines 205–207)

```
fn set_mailbox_delivery_phase(&mut self, phase: MailboxDeliveryPhase)
```

**Purpose**: Sets the rule for whether mailbox messages belong to this turn or should wait for the next one. This is the low-level switch behind the mailbox delivery behavior.

**Data flow**: It receives a MailboxDeliveryPhase value and stores it in TurnState. The visible result is that later mailbox checks will follow the new phase.

**Call relations**: TurnState::accept_mailbox_delivery_for_current_turn calls this with CurrentTurn. Other turn logic may also set the phase directly when final output has been shown and late messages should no longer extend the current answer.

*Call graph*: called by 1 (accept_mailbox_delivery_for_current_turn).


##### `TurnState::record_granted_permissions`  (lines 209–223)

```
fn record_granted_permissions(
        &mut self,
        environment_id: &str,
        permissions: AdditionalPermissionProfile,
    )
```

**Purpose**: Remembers extra permissions granted during this turn for a specific environment. If permissions were already granted for that environment, it combines the old and new grants instead of overwriting them blindly.

**Data flow**: It receives an environment ID and a permission profile. It looks up any permissions already recorded for that environment, merges the old and new profiles, and stores the merged result if there is one.

**Call relations**: Permission-handling code calls this after a permission request succeeds. It delegates the combining rules to merge_permission_profiles, so this function only needs to know where to store the resulting grant.

*Call graph*: calls 1 internal fn (merge_permission_profiles).


##### `TurnState::granted_permissions`  (lines 225–232)

```
fn granted_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Returns the extra permissions already granted for a given environment during this turn. Callers use it to avoid asking again or to apply the current turn’s permission allowances.

**Data flow**: It receives an environment ID, looks in the granted-permissions map, clones the stored profile if one exists, and returns it. If nothing has been granted for that environment, it returns nothing.

**Call relations**: This is the read-side partner of TurnState::record_granted_permissions. Permission and tool-execution code can ask it what temporary grants are available before deciding whether more review is needed.


##### `TurnState::enable_strict_auto_review`  (lines 234–236)

```
fn enable_strict_auto_review(&mut self)
```

**Purpose**: Turns on strict automatic review for this turn. Once enabled, later policy decisions can treat the turn as needing the stricter review behavior.

**Data flow**: It takes no input. It changes the strict_auto_review_enabled flag in TurnState from false to true and returns no value.

**Call relations**: Review or permission-routing code can call this when the current turn should follow stricter automatic review rules. The state is later checked through TurnState::strict_auto_review_enabled.


##### `TurnState::strict_auto_review_enabled`  (lines 238–240)

```
fn strict_auto_review_enabled(&self) -> bool
```

**Purpose**: Reports whether strict automatic review has been enabled for this turn. This lets later decisions follow the correct review policy without guessing.

**Data flow**: It reads the strict_auto_review_enabled flag and returns true or false. It does not change the state.

**Call relations**: This is the read-side partner of TurnState::enable_strict_auto_review. Policy and tool-execution paths can call it when deciding whether to route an action through stricter review.


### `code-mode/src/service.rs`

`orchestration` · `request handling and teardown`

A Code Mode session is like a small notebook runtime: each submitted piece of code becomes a “cell,” and the caller can get early output, wait for more, or stop it. This file sits between the outside protocol and the lower-level runtime. It assigns cell IDs, starts runtimes, records live cells, forwards runtime events back to callers, and remembers stored values that should be shared across cells in the same session.

The main type, CodeModeService, owns shared session state: saved values, currently running cells, a delegate for outside callbacks, and a shutdown flag. When code starts, the service spawns a runtime and also spawns a control loop for that cell. That control loop is the traffic officer. It listens for runtime events such as output, tool calls, pending state, completion, or unexpected closure. It also listens for user commands such as wait and terminate.

The file is careful about long-running code. If a cell runs too long before producing a final result, it can yield partial output so the caller is not left waiting forever. If the runtime asks to call a tool, the service asks the delegate and sends the answer back. Shutdown and termination cancel outstanding callbacks and remove the cell from the session so future waits report a missing cell instead of hanging.

#### Function details

##### `NoopCodeModeSessionDelegate::invoke_tool`  (lines 44–53)

```
fn invoke_tool(
        &'a self,
        _invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: This is the fallback behavior when no real delegate is installed to run nested tool calls. It waits until cancellation and then reports that nested tools are unavailable.

**Data flow**: It receives a tool invocation and a cancellation token. It ignores the invocation, waits for the cancellation signal, then returns an error message saying tool calls cannot be used.

**Call relations**: The service uses this delegate when CodeModeService::new creates a session without outside integrations. Runtime tool-call events normally flow through the delegate; with this no-op version, they cannot complete successfully unless the cell is cancelled.

*Call graph*: 2 external calls (pin, cancelled).


##### `NoopCodeModeSessionDelegate::notify`  (lines 55–63)

```
fn notify(
        &'a self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        _cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a>
```

**Purpose**: This is the fallback notification hook. It accepts notifications from running code but deliberately does nothing with them.

**Data flow**: It receives a call ID, cell ID, text, and cancellation token. It ignores all of them and immediately returns success, so notification output does not fail the cell.

**Call relations**: run_cell_control calls the session delegate when the runtime emits a notification event. If the service was built with the no-op delegate, this method absorbs that notification.

*Call graph*: 1 external calls (pin).


##### `NoopCodeModeSessionDelegate::cell_closed`  (lines 65–65)

```
fn cell_closed(&self, _cell_id: &CellId)
```

**Purpose**: This is the fallback hook for when a cell has finished and been removed. It performs no cleanup because the no-op delegate owns no outside resources.

**Data flow**: It receives the ID of a closed cell and leaves all state unchanged.

**Call relations**: run_cell_control calls the delegate after removing a cell from the live-cell map. With this default delegate, that final callback has no effect.


##### `InProcessCodeModeSessionProvider::create_session`  (lines 72–81)

```
fn create_session(
        &'a self,
        delegate: Arc<dyn CodeModeSessionDelegate>,
    ) -> CodeModeSessionProviderFuture<'a>
```

**Purpose**: This creates a Code Mode session that runs inside the current process instead of connecting to another service. It lets callers obtain the session through the shared protocol interface.

**Data flow**: It receives a delegate supplied by the caller. It builds a CodeModeService using that delegate, wraps it as a shared CodeModeSession object, and returns it.

**Call relations**: Session setup code calls this provider when it wants an in-process implementation. It hands the delegate into CodeModeService::with_delegate so later runtime notifications and tool calls can be routed outward.

*Call graph*: calls 1 internal fn (with_delegate); 2 external calls (new, pin).


##### `CodeModeService::new`  (lines 105–107)

```
fn new() -> Self
```

**Purpose**: This creates a basic Code Mode service with no outside tool or notification support. It is useful for tests or simple use cases where code execution is needed but nested integrations are not.

**Data flow**: It takes no input. It creates a NoopCodeModeSessionDelegate and passes it to the shared constructor, producing a fresh service with empty cell and stored-value state.

**Call relations**: Many tests call this to get a clean session. Internally it delegates the real setup to CodeModeService::with_delegate.

*Call graph*: called by 29 (date_locale_string_formats_with_icu_data, execute_to_pending_excludes_delayed_timeout_tool_calls_until_wait, execute_to_pending_identifies_tool_calls_in_paused_frontier, execute_to_pending_returns_completed_for_synchronous_results, execute_to_pending_returns_once_the_runtime_is_quiescent, generated_image_helper_appends_image_and_output_hint, image_helper_accepts_low_detail, image_helper_accepts_raw_mcp_image_block_with_original_detail, image_helper_rejects_raw_mcp_result_container, image_helper_rejects_unsupported_detail (+15 more)); 2 external calls (new, with_delegate).


##### `CodeModeService::with_delegate`  (lines 109–119)

```
fn with_delegate(delegate: Arc<dyn CodeModeSessionDelegate>) -> Self
```

**Purpose**: This creates a Code Mode service with a caller-provided delegate for tool calls, notifications, and cell-close events. Use it when the runtime needs to talk back to the surrounding system.

**Data flow**: It receives a shared delegate. It builds the inner session state: an empty stored-value map, an empty live-cell map, a shutdown flag set to false, and a cell ID counter starting at 1.

**Call relations**: InProcessCodeModeSessionProvider::create_session and CodeModeService::new both rely on this constructor. Later, run_cell_control reads the delegate stored here whenever runtime events need outside help.

*Call graph*: called by 5 (create_session, natural_completion_cleans_up_callbacks_before_responding, repeated_termination_is_rejected_while_callback_cleanup_is_pending, termination_cancels_pending_callbacks_before_responding, new); 5 external calls (new, new, new, new, new).


##### `CodeModeService::allocate_cell_id`  (lines 121–128)

```
fn allocate_cell_id(&self) -> CellId
```

**Purpose**: This gives each new cell a unique ID within the session. The ID lets later wait or terminate requests point to the right running code.

**Data flow**: It reads and increments the session’s atomic counter, converts the number to text, and wraps it as a CellId.

**Call relations**: CodeModeService::execute and CodeModeService::execute_to_pending call this just before starting a new cell.

*Call graph*: calls 1 internal fn (new); called by 2 (execute, execute_to_pending).


##### `CodeModeService::execute_to_pending`  (lines 149–167)

```
async fn execute_to_pending(
        &self,
        request: ExecuteRequest,
    ) -> Result<ExecuteToPendingOutcome, String>
```

**Purpose**: This starts code and waits until it either finishes or reaches a quiet pending state. It is useful when the caller wants to know the current frontier of async work, such as outstanding tool calls.

**Data flow**: It receives an ExecuteRequest. It allocates a cell ID, starts the cell in pause-until-resumed mode, waits on a one-time response channel, and returns either a completed result or a pending snapshot.

**Call relations**: It uses CodeModeService::allocate_cell_id and CodeModeService::start_cell. The response it awaits is produced later by run_cell_control when the runtime completes or reports that it is pending.

*Call graph*: calls 2 internal fn (allocate_cell_id, start_cell); 2 external calls (ExecuteToPending, channel).


##### `CodeModeService::start_cell`  (lines 169–222)

```
async fn start_cell(
        &self,
        cell_id: CellId,
        request: ExecuteRequest,
        initial_response_tx: CellResponseSender,
        initial_yield_time_ms: Option<u64>,
        pendi
```

**Purpose**: This is the shared startup path for a new cell. It creates communication channels, starts the runtime, records the cell as live, and launches the cell control loop.

**Data flow**: It receives a cell ID, execution request, initial response sender, optional yield time, and pending-mode choice. It copies stored session values into the runtime, spawns the runtime, inserts a CellHandle into the live-cell map, then spawns run_cell_control to supervise the cell.

**Call relations**: CodeModeService::execute and CodeModeService::execute_to_pending both call this. It hands runtime events and control channels to run_cell_control, which owns the rest of the cell’s lifecycle.

*Call graph*: calls 2 internal fn (spawn_runtime, run_cell_control); called by 2 (execute, execute_to_pending); 8 external calls (clone, new, new, new, clone, format!, unbounded_channel, spawn).


##### `CodeModeService::begin_wait`  (lines 228–249)

```
async fn begin_wait(
        &self,
        request: WaitRequest,
    ) -> CodeModeSessionResultFuture<'static, WaitOutcome>
```

**Purpose**: This starts a wait operation for an existing live cell. It lets a caller ask for the next result or yield without blocking the service’s internal locks.

**Data flow**: It receives a WaitRequest containing a cell ID and yield time. It looks up the cell handle, sends a poll command to that cell’s control loop, and returns a future that will resolve when the cell replies.

**Call relations**: CodeModeService::wait calls this and then awaits the returned future. If the cell is missing or its control channel is closed, begin_wait routes through missing_wait instead.

*Call graph*: calls 2 internal fn (missing_wait, wait_for_response); called by 1 (wait); 1 external calls (channel).


##### `CodeModeService::wait_to_pending`  (lines 279–307)

```
async fn wait_to_pending(
        &self,
        request: WaitToPendingRequest,
    ) -> Result<WaitToPendingOutcome, String>
```

**Purpose**: This resumes or observes a pending-mode cell until it reaches pending again or completes. It is the follow-up operation for cells started with execute_to_pending.

**Data flow**: It receives a cell ID in a WaitToPendingRequest. It finds the live cell, sends a PollToPending command, waits for the one-time reply, and wraps the answer as either a live-cell outcome or a missing-cell outcome.

**Call relations**: Tests exercise this after execute_to_pending has paused a runtime. The command is handled inside run_cell_control, which resumes the runtime if needed and replies when the next pending or completed state appears.

*Call graph*: calls 1 internal fn (missing_cell_response); 3 external calls (LiveCell, MissingCell, channel).


##### `CodeModeService::default`  (lines 335–337)

```
fn default() -> Self
```

**Purpose**: This makes the service usable with Rust’s standard Default pattern. It creates the same kind of service as CodeModeService::new.

**Data flow**: It takes no input and returns a fresh service using the no-op delegate.

**Call relations**: Any generic setup code that asks for a default CodeModeService reaches CodeModeService::new through this function.

*Call graph*: 1 external calls (new).


##### `CodeModeService::drop`  (lines 341–353)

```
fn drop(&mut self)
```

**Purpose**: This is the emergency cleanup path when a service object is discarded. It tries to stop live cells so runtimes are not left running after the session is gone.

**Data flow**: When the service is dropped, it marks the session as shutting down. If it can immediately lock the live-cell map, it cancels each cell, sends a terminate command to the control loop, and sends a terminate command directly to the runtime.

**Call relations**: This runs automatically when the last CodeModeService value is destroyed. The explicit CodeModeService::shutdown path is more orderly, but drop provides a last line of defense.

*Call graph*: 1 external calls (channel).


##### `CodeModeService::is_alive`  (lines 357–359)

```
fn is_alive(&self) -> bool
```

**Purpose**: This tells callers whether the session is still accepting work. A session is alive until shutdown has begun.

**Data flow**: It reads the shutdown flag and returns true if the flag is not set.

**Call relations**: This is part of the CodeModeSession interface, so callers using the protocol trait can check session health without knowing the concrete service type.


##### `CodeModeService::execute`  (lines 361–366)

```
fn execute(
        &'a self,
        request: ExecuteRequest,
    ) -> CodeModeSessionResultFuture<'a, StartedCell>
```

**Purpose**: This is the trait-facing entry for starting a normal cell. It returns a future so callers can use the service through the CodeModeSession interface.

**Data flow**: It receives an ExecuteRequest, boxes the service’s async execute operation as a future, and eventually yields a StartedCell or an error.

**Call relations**: External callers using CodeModeSession call this method. The underlying service path allocates a cell ID, starts the cell, and packages the first response receiver into a StartedCell.

*Call graph*: calls 3 internal fn (from_result_receiver, allocate_cell_id, start_cell); called by 1 (execute); 3 external calls (pin, Runtime, channel).


##### `CodeModeService::wait`  (lines 368–370)

```
fn wait(&'a self, request: WaitRequest) -> CodeModeSessionResultFuture<'a, WaitOutcome>
```

**Purpose**: This is the trait-facing entry for waiting on a running cell. It hides the service’s concrete async method behind the shared session interface.

**Data flow**: It receives a WaitRequest, boxes CodeModeService::wait as a future, and eventually returns a WaitOutcome or an error.

**Call relations**: Callers use this after CodeModeService::execute has returned a cell ID and an initial response. Internally the wait path begins with CodeModeService::begin_wait.

*Call graph*: calls 1 internal fn (begin_wait); 1 external calls (pin).


##### `CodeModeService::terminate`  (lines 372–374)

```
fn terminate(&'a self, cell_id: CellId) -> CodeModeSessionResultFuture<'a, WaitOutcome>
```

**Purpose**: This is the trait-facing entry for stopping a cell. It lets protocol callers ask a live runtime to shut down and receive the final termination response.

**Data flow**: It receives a cell ID, boxes the service termination operation as a future, and eventually returns a live-cell or missing-cell wait outcome.

**Call relations**: The underlying termination path checks for missing cells, rejects duplicate termination requests, and sends a terminate command to run_cell_control.

*Call graph*: calls 2 internal fn (already_terminating_error, missing_cell_response); 4 external calls (pin, LiveCell, MissingCell, channel).


##### `CodeModeService::shutdown`  (lines 376–378)

```
fn shutdown(&'a self) -> CodeModeSessionResultFuture<'a, ()>
```

**Purpose**: This is the trait-facing entry for shutting down the whole session. It stops new work and asks every live cell to terminate.

**Data flow**: It boxes the async shutdown operation as a future. That operation marks the session shutting down, cancels live cells, sends terminate commands, and waits until the live-cell map is empty.

**Call relations**: Protocol callers use this during teardown. Each live cell is ultimately cleaned up by its run_cell_control task.

*Call graph*: 3 external calls (pin, channel, yield_now).


##### `missing_cell_response`  (lines 413–419)

```
fn missing_cell_response(cell_id: CellId) -> RuntimeResponse
```

**Purpose**: This builds a standard response for “that cell does not exist.” It keeps missing-cell errors shaped like normal runtime responses while still marking them separately at the outer outcome level.

**Data flow**: It receives a cell ID and returns a RuntimeResponse::Result with no content and an error message naming the missing cell.

**Call relations**: terminate, wait_to_pending, missing_wait, and wait_for_response use this whenever a requested cell cannot be found or its reply channel disappears.

*Call graph*: called by 4 (terminate, wait_to_pending, missing_wait, wait_for_response); 2 external calls (new, format!).


##### `missing_wait`  (lines 421–423)

```
fn missing_wait(cell_id: CellId) -> CodeModeSessionResultFuture<'static, WaitOutcome>
```

**Purpose**: This creates a ready-to-run wait future for a missing cell. It lets begin_wait return the same future type whether the cell exists or not.

**Data flow**: It receives a cell ID, builds a missing-cell runtime response, wraps it as WaitOutcome::MissingCell, and returns it inside a boxed async future.

**Call relations**: CodeModeService::begin_wait calls this when the live-cell map has no matching cell or sending the poll command fails.

*Call graph*: calls 1 internal fn (missing_cell_response); called by 1 (begin_wait); 2 external calls (pin, MissingCell).


##### `wait_for_response`  (lines 425–436)

```
fn wait_for_response(
    cell_id: CellId,
    response_rx: oneshot::Receiver<Result<RuntimeResponse, String>>,
) -> CodeModeSessionResultFuture<'static, WaitOutcome>
```

**Purpose**: This turns a cell control-loop reply channel into a public wait outcome. It also handles the case where the cell disappears before replying.

**Data flow**: It receives a cell ID and a one-time receiver. If the receiver delivers a successful runtime response, it returns LiveCell. If it delivers an error, it returns that error. If the sender is gone, it returns MissingCell.

**Call relations**: CodeModeService::begin_wait uses this after sending a Poll command to a live cell. The matching sender is held by run_cell_control.

*Call graph*: calls 1 internal fn (missing_cell_response); called by 1 (begin_wait); 3 external calls (pin, LiveCell, MissingCell).


##### `busy_observer_error`  (lines 438–440)

```
fn busy_observer_error(cell_id: &CellId) -> String
```

**Purpose**: This creates the error text used when two callers try to observe the same cell at the same time. The service allows only one active waiter or terminator per cell response slot.

**Data flow**: It receives a cell ID and returns a message saying the cell already has an active observer.

**Call relations**: run_cell_control uses this when it receives a Poll or PollToPending command while another response is already outstanding.

*Call graph*: 1 external calls (format!).


##### `already_terminating_error`  (lines 442–444)

```
fn already_terminating_error(cell_id: &CellId) -> String
```

**Purpose**: This creates the error text used when a cell is already in the middle of termination. It prevents duplicate stop requests from pretending they both own the final response.

**Data flow**: It receives a cell ID and returns a message saying that cell is already terminating.

**Call relations**: CodeModeService::terminate uses this when the cell handle’s termination flag was already set. run_cell_control also uses the same idea for duplicate terminate commands.

*Call graph*: called by 1 (terminate); 1 external calls (format!).


##### `pending_result_response`  (lines 446–452)

```
fn pending_result_response(cell_id: &CellId, result: PendingResult) -> RuntimeResponse
```

**Purpose**: This converts a stored completed result into the normal runtime response shape. It is used when a cell finished before a caller was waiting for the final answer.

**Data flow**: It receives a cell ID and a PendingResult containing content items and optional error text. It returns RuntimeResponse::Result with those fields attached to the cell ID.

**Call relations**: send_or_buffer_result calls this when it can immediately send a final result instead of keeping it buffered.

*Call graph*: called by 1 (send_or_buffer_result); 1 external calls (clone).


##### `send_terminal_response`  (lines 454–463)

```
fn send_terminal_response(response_tx: CellResponseSender, response: RuntimeResponse)
```

**Purpose**: This sends a final response through whichever kind of initial waiter is active. Normal execution gets a RuntimeResponse, while execute-to-pending gets a Completed outcome.

**Data flow**: It receives a CellResponseSender and a RuntimeResponse. It sends Ok(response) for normal runtime waits, or Ok(Completed(response)) for execute-to-pending waits.

**Call relations**: send_or_buffer_result and send_termination_responses call this so they do not need to duplicate the two response-channel formats.

*Call graph*: called by 2 (send_or_buffer_result, send_termination_responses); 2 external calls (Completed, send).


##### `send_termination_responses`  (lines 465–476)

```
fn send_termination_responses(
    response_tx: Option<CellResponseSender>,
    termination_response_tx: Option<oneshot::Sender<Result<RuntimeResponse, String>>>,
    response: RuntimeResponse,
)
```

**Purpose**: This sends a termination result to all callers that are waiting for it. A normal waiter and the explicit terminate caller may both need to hear the same final response.

**Data flow**: It receives optional response senders plus a RuntimeResponse. It sends the response to the regular response slot if present, then sends the same response to the termination response slot if present.

**Call relations**: run_cell_control uses this when termination finishes, especially when a cell already had an outstanding observer while a terminate command arrived.

*Call graph*: calls 1 internal fn (send_terminal_response); 1 external calls (clone).


##### `send_or_buffer_result`  (lines 478–492)

```
fn send_or_buffer_result(
    cell_id: &CellId,
    result: PendingResult,
    response_tx: &mut Option<CellResponseSender>,
    pending_result: &mut Option<PendingResult>,
) -> bool
```

**Purpose**: This either delivers a completed cell result immediately or stores it for the next wait. It prevents completed results from being lost if the caller is not currently listening.

**Data flow**: It receives the cell ID, a PendingResult, the current response slot, and the pending-result storage slot. If a response sender is waiting, it sends the result and returns true. Otherwise it stores the result and returns false.

**Call relations**: run_cell_control calls this when the runtime reports a final result or unexpectedly closes. If it returns true, the control loop can finish; if false, it keeps the result until a later Poll.

*Call graph*: calls 2 internal fn (pending_result_response, send_terminal_response).


##### `send_yield_response`  (lines 494–513)

```
fn send_yield_response(
    cell_id: &CellId,
    content_items: &mut Vec<FunctionCallOutputContentItem>,
    response_tx: &mut Option<CellResponseSender>,
)
```

**Purpose**: This sends partial output when a running cell yields. Yielding lets long-running code give the caller progress without ending the cell.

**Data flow**: It receives the cell ID, accumulated content items, and the current response slot. For normal execution, it sends RuntimeResponse::Yielded and clears the content buffer. For execute-to-pending, it keeps the response slot because that mode should wait for pending or completion, not ordinary yield.

**Call relations**: run_cell_control calls this when a yield timer expires or the runtime explicitly requests a yield.

*Call graph*: 3 external calls (clone, ExecuteToPending, take).


##### `run_cell_control`  (lines 515–834)

```
async fn run_cell_control(
    inner: Arc<Inner>,
    context: CellControlContext,
    mut event_rx: mpsc::UnboundedReceiver<RuntimeEvent>,
    mut control_rx: mpsc::UnboundedReceiver<CellControlComma
```

**Purpose**: This is the supervisor loop for one running cell. It coordinates user commands, runtime events, tool callbacks, notifications, yielding, completion, and cleanup.

**Data flow**: It receives shared session state, a context with runtime channels and cancellation tools, runtime event and control receivers, and the first response sender. It loops over incoming commands and events, accumulates output, sends responses at the right time, invokes delegate callbacks for tools and notifications, updates stored values on success, and finally terminates the runtime and removes the cell.

**Call relations**: CodeModeService::start_cell spawns this for every new cell. Tests also spawn it directly to check termination behavior. It calls helpers such as finish_callbacks, send_yield_response, send_or_buffer_result, and terminate_paused_runtime as the cell moves through its lifecycle.

*Call graph*: calls 2 internal fn (finish_callbacks, terminate_paused_runtime); called by 2 (start_cell, terminate_waits_for_runtime_shutdown_before_responding); 3 external calls (new, new, select!).


##### `finish_callbacks`  (lines 842–854)

```
async fn finish_callbacks(
    cancellation_token: &CancellationToken,
    notification_tasks: &mut JoinSet<()>,
    tool_tasks: &mut JoinSet<()>,
    completion: CallbackCompletion,
)
```

**Purpose**: This waits for notification and tool callback tasks to end, cancelling them when needed. It makes sure no background callback is left running after a cell completes or is stopped.

**Data flow**: It receives a cancellation token, task sets for notifications and tools, and a completion mode. If cancellation is requested, it cancels first; it then drains notification tasks, cancels before tools, and drains tool tasks.

**Call relations**: run_cell_control calls this before sending some final responses and during final cleanup. It delegates the actual waiting and warning behavior to drain_tasks.

*Call graph*: calls 1 internal fn (drain_tasks); called by 1 (run_cell_control); 2 external calls (cancel, matches!).


##### `drain_tasks`  (lines 856–864)

```
async fn drain_tasks(tasks: &mut JoinSet<()>, description: &str)
```

**Purpose**: This waits for every task in a task set and logs unexpected failures. It is a small cleanup helper for callback task groups.

**Data flow**: It receives a JoinSet and a description such as “notification” or “tool.” It repeatedly awaits finished tasks and warns if a task failed for a reason other than cancellation.

**Call relations**: finish_callbacks calls this once for notification callbacks and once for tool callbacks.

*Call graph*: called by 1 (finish_callbacks); 2 external calls (join_next, warn!).


##### `resume_paused_runtime`  (lines 866–873)

```
fn resume_paused_runtime(
    runtime_control_tx: &std::sync::mpsc::Sender<RuntimeControlCommand>,
    pending_mode: PendingRuntimeMode,
)
```

**Purpose**: This resumes a runtime only when it was started in pause-until-resumed mode. It avoids sending unnecessary resume commands to runtimes that run continuously.

**Data flow**: It receives a runtime-control sender and the pending mode. If the mode is PauseUntilResumed, it sends a Resume control command; otherwise it does nothing.

**Call relations**: run_cell_control uses this when Poll or PollToPending means the caller is ready for the paused runtime to continue.

*Call graph*: 1 external calls (send).


##### `terminate_paused_runtime`  (lines 875–882)

```
fn terminate_paused_runtime(
    runtime_control_tx: &std::sync::mpsc::Sender<RuntimeControlCommand>,
    pending_mode: PendingRuntimeMode,
)
```

**Purpose**: This tells a paused runtime to terminate when that runtime uses the pause-until-resumed control path. It is a companion to direct runtime termination commands.

**Data flow**: It receives a runtime-control sender and the pending mode. If the mode is PauseUntilResumed, it sends a Terminate control command; otherwise it does nothing.

**Call relations**: run_cell_control calls this during termination and final cleanup so paused runtimes do not remain stuck waiting for a resume signal.

*Call graph*: called by 1 (run_cell_control); 1 external calls (send).


##### `tests::execute_request`  (lines 921–929)

```
fn execute_request(source: &str) -> ExecuteRequest
```

**Purpose**: This test helper builds a standard ExecuteRequest with common defaults. It keeps the tests focused on the behavior being checked instead of repeated setup fields.

**Data flow**: It receives JavaScript source text and returns an ExecuteRequest with a fixed tool call ID, no enabled tools, a short yield time, and no output-token limit.

**Call relations**: Most tests call this helper and then override the fields that matter for that case.

*Call graph*: 1 external calls (new).


##### `tests::cell_id`  (lines 931–933)

```
fn cell_id(value: &str) -> CellId
```

**Purpose**: This test helper creates a CellId from a short string. It makes expected responses easier to read.

**Data flow**: It receives text such as “1” or “missing” and returns a CellId containing that value.

**Call relations**: Many assertions call this helper when comparing expected RuntimeResponse or WaitOutcome values.

*Call graph*: calls 1 internal fn (new).


##### `tests::execute`  (lines 935–943)

```
async fn execute(service: &CodeModeService, request: ExecuteRequest) -> RuntimeResponse
```

**Purpose**: This test helper runs a request and waits for the first response. It shortens tests that only care about the immediate completed or yielded answer.

**Data flow**: It receives a CodeModeService and an ExecuteRequest. It starts execution, unwraps the StartedCell, waits for its initial response, unwraps that, and returns the RuntimeResponse.

**Call relations**: Tests for output helpers, stored values, locale formatting, and synchronous execution use this instead of repeating the execute-and-await sequence.

*Call graph*: calls 1 internal fn (execute).


##### `tests::test_inner`  (lines 945–953)

```
fn test_inner() -> Arc<Inner>
```

**Purpose**: This test helper builds the shared Inner state needed to run a cell control loop directly. It is used when a test wants to bypass the public service startup path.

**Data flow**: It creates empty stored-value and cell maps, installs the no-op delegate, sets shutdown to false, starts the cell counter at 1, and returns the state in an Arc.

**Call relations**: tests::terminate_waits_for_runtime_shutdown_before_responding uses this to spawn run_cell_control manually.

*Call graph*: 5 external calls (new, new, new, new, new).


##### `tests::synchronous_exit_returns_successfully`  (lines 956–979)

```
async fn synchronous_exit_returns_successfully()
```

**Purpose**: This test proves that calling exit inside the executed code ends the cell cleanly and stops later code from running.

**Data flow**: It creates a service, runs code that writes “before,” exits, then would write “after.” It checks that the result contains only “before” and no error.

**Call relations**: The test uses CodeModeService::new, tests::execute_request, and tests::execute to exercise the normal execute path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::stored_values_are_shared_between_cells_but_not_sessions`  (lines 982–1043)

```
async fn stored_values_are_shared_between_cells_but_not_sessions()
```

**Purpose**: This test checks the intended memory boundary for stored values. Values saved in one session should be visible to later cells in that same session, but not to a different session.

**Data flow**: It creates two services. One cell stores a key in the first service, another cell in the same service loads it, and a cell in the second service tries to load it. The assertions confirm same-session sharing and cross-session isolation.

**Call relations**: The test drives the public execute path through tests::execute and uses CodeModeService::new for separate session state.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::shutdown_interrupts_cpu_bound_cells`  (lines 1046–1068)

```
async fn shutdown_interrupts_cpu_bound_cells()
```

**Purpose**: This test ensures shutdown can stop code that is stuck in a CPU loop. Without this, a runaway cell could keep the session alive forever.

**Data flow**: It starts code with an infinite loop, observes the initial yield, then calls shutdown inside a timeout. The test passes only if shutdown finishes promptly.

**Call relations**: It uses CodeModeService::new and the public execute and shutdown paths, exercising the runtime termination safeguards.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_secs, assert_eq!, execute_request, timeout).


##### `tests::start_cell_rejects_new_cell_after_shutdown_begins`  (lines 1071–1089)

```
async fn start_cell_rejects_new_cell_after_shutdown_begins()
```

**Purpose**: This test confirms that once shutdown has started, no new cells can sneak in. That protects teardown from racing with new work.

**Data flow**: It creates a service, manually marks it as shutting down, calls start_cell, and expects an error. It also checks that the live-cell map stays empty.

**Call relations**: The test calls CodeModeService::start_cell directly to cover the internal second shutdown check inside cell creation.

*Call graph*: calls 1 internal fn (new); 6 external calls (assert!, assert_eq!, Runtime, cell_id, execute_request, channel).


##### `tests::execute_to_pending_returns_completed_for_synchronous_results`  (lines 1092–1114)

```
async fn execute_to_pending_returns_completed_for_synchronous_results()
```

**Purpose**: This test verifies that execute_to_pending returns a completed result when code finishes immediately. Pending mode should not invent a pending state for synchronous code.

**Data flow**: It runs code that writes “done” and finishes. It checks that the outcome is Completed with the expected RuntimeResponse.

**Call relations**: The test uses CodeModeService::new and CodeModeService::execute_to_pending to exercise the pause-until-pending startup path.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, execute_request).


##### `tests::execute_to_pending_returns_once_the_runtime_is_quiescent`  (lines 1117–1152)

```
async fn execute_to_pending_returns_once_the_runtime_is_quiescent()
```

**Purpose**: This test checks that execute_to_pending returns when async code becomes quiet but unfinished. A never-resolving promise should produce a Pending outcome instead of hanging forever.

**Data flow**: It runs code that outputs “before” and then awaits forever. It expects a Pending result with the accumulated output, then terminates the cell and checks for a terminated response.

**Call relations**: The test uses execute_to_pending first, then CodeModeService::terminate to clean up the still-live cell.

*Call graph*: calls 1 internal fn (new); 5 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout).


##### `tests::execute_to_pending_identifies_tool_calls_in_paused_frontier`  (lines 1155–1199)

```
async fn execute_to_pending_identifies_tool_calls_in_paused_frontier()
```

**Purpose**: This test proves that pending mode reports the tool calls that are currently blocking progress. That lets the caller know which external work must be answered.

**Data flow**: It enables an echo tool and runs code that starts two tool calls. It expects a Pending outcome listing the two runtime tool-call IDs, then terminates the cell.

**Call relations**: The test drives CodeModeService::execute_to_pending and then CodeModeService::terminate. It exercises run_cell_control’s tracking of tool calls while paused.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, cell_id, execute_request, vec!).


##### `tests::execute_to_pending_excludes_delayed_timeout_tool_calls_until_wait`  (lines 1202–1281)

```
async fn execute_to_pending_excludes_delayed_timeout_tool_calls_until_wait()
```

**Purpose**: This test checks that pending tool-call IDs only include work that is actually at the current paused frontier. Delayed timer work should not appear until the runtime is resumed and the timer fires.

**Data flow**: It starts code with immediate tool calls and a delayed tool call. The first pending response lists only the immediate calls. The test then simulates the timer firing, waits to pending again, and expects only the delayed tool call.

**Call relations**: It uses execute_to_pending, reaches into the cell handle to send a RuntimeCommand::TimeoutFired, then calls wait_to_pending.

*Call graph*: calls 1 internal fn (new); 6 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout, vec!).


##### `tests::wait_to_pending_returns_after_resumed_runtime_becomes_quiescent_again`  (lines 1284–1353)

```
async fn wait_to_pending_returns_after_resumed_runtime_becomes_quiescent_again()
```

**Purpose**: This test confirms that wait_to_pending resumes a paused runtime and returns when it becomes quiet again. It covers a cell that wakes from a timer, produces output, then waits forever.

**Data flow**: It starts code that waits on a timer, writes “after,” and then awaits forever. After the first pending state, the test fires the timer command, calls wait_to_pending, and checks that the second pending response includes “after.”

**Call relations**: The test follows the execute_to_pending then wait_to_pending flow and terminates the live cell afterward.

*Call graph*: calls 1 internal fn (new); 5 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout).


##### `tests::wait_to_pending_returns_completed_after_resumed_runtime_finishes`  (lines 1356–1416)

```
async fn wait_to_pending_returns_completed_after_resumed_runtime_finishes()
```

**Purpose**: This test verifies that wait_to_pending can return a completed result, not only another pending state. A resumed cell may simply finish.

**Data flow**: It starts code that waits on a timer and then writes “done.” After the first pending response, the test fires the timer and waits again. It expects a Completed outcome with the final output.

**Call relations**: The test exercises the path where run_cell_control resumes a paused runtime and then receives a final RuntimeEvent::Result.

*Call graph*: calls 1 internal fn (new); 5 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout).


##### `tests::v8_console_is_not_exposed_on_global_this`  (lines 1419–1442)

```
async fn v8_console_is_not_exposed_on_global_this()
```

**Purpose**: This test checks that the raw V8 console object is not exposed to user code. The runtime should provide only the intended Code Mode helpers.

**Data flow**: It runs code that tests whether globalThis has a console property and writes the answer. The expected output is “false.”

**Call relations**: The test uses the public execute helper and indirectly checks how the runtime environment is configured.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::date_locale_string_formats_with_icu_data`  (lines 1445–1482)

```
async fn date_locale_string_formats_with_icu_data()
```

**Purpose**: This test confirms that locale-aware date formatting has ICU data available. ICU is the internationalization data used for language-specific formatting.

**Data flow**: It formats a fixed UTC date using French locale options and writes the result. The assertion checks the French weekday and month text.

**Call relations**: The test executes JavaScript through CodeModeService::new and tests::execute, covering runtime internationalization behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::intl_date_time_format_formats_with_icu_data`  (lines 1485–1521)

```
async fn intl_date_time_format_formats_with_icu_data()
```

**Purpose**: This test checks the Intl.DateTimeFormat API with French formatting. It is another guard that international date formatting works inside Code Mode.

**Data flow**: It constructs an Intl.DateTimeFormat for French, formats a fixed date, writes the value, and compares it to the expected French string.

**Call relations**: Like the locale-string test, it uses the normal service execution path to validate the runtime’s ICU setup.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::output_helpers_return_undefined`  (lines 1524–1564)

```
async fn output_helpers_return_undefined()
```

**Purpose**: This test verifies that helper functions used for output behave like side-effect functions in JavaScript. They should append output and return undefined.

**Data flow**: It calls text, image, and notify, records whether each returned undefined, and writes that record. The expected response includes the first text, the image item, and “[true,true,true].”

**Call relations**: The test drives the public execute path and checks output items produced by runtime helper functions.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_accepts_raw_mcp_image_block_with_original_detail`  (lines 1567–1599)

```
async fn image_helper_accepts_raw_mcp_image_block_with_original_detail()
```

**Purpose**: This test ensures the image helper accepts a raw MCP image block. MCP means Model Context Protocol, a common shape for tool content.

**Data flow**: It passes an object with image data, MIME type, and original detail metadata to image. The expected output is a data URI image item with Original detail.

**Call relations**: The test uses CodeModeService execution to validate image helper conversion inside the runtime.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::generated_image_helper_appends_image_and_output_hint`  (lines 1602–1637)

```
async fn generated_image_helper_appends_image_and_output_hint()
```

**Purpose**: This test checks that generatedImage emits both the image and a text hint about saving or using it. That gives callers the visual output plus guidance.

**Data flow**: It runs generatedImage with a data URI and output hint. The expected result contains an image content item followed by a text content item with the hint.

**Call relations**: The test uses the normal execute helper and validates the runtime helper’s output ordering.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_second_arg_overrides_explicit_object_detail`  (lines 1640–1673)

```
async fn image_helper_second_arg_overrides_explicit_object_detail()
```

**Purpose**: This test verifies that the second argument to image takes priority over a detail value inside the image object.

**Data flow**: It passes an image object with detail “high” and a second argument “original.” The expected output uses Original detail.

**Call relations**: The test exercises image helper argument precedence through the public execution path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_second_arg_overrides_raw_mcp_image_detail`  (lines 1676–1711)

```
async fn image_helper_second_arg_overrides_raw_mcp_image_detail()
```

**Purpose**: This test checks the same detail override rule for raw MCP image blocks. The explicit second argument should win over metadata in the block.

**Data flow**: It passes a raw image block whose metadata says original, plus a second argument “high.” The expected output uses High detail.

**Call relations**: The test uses tests::execute to run the helper inside the runtime and compare the produced content item.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_accepts_low_detail`  (lines 1714–1744)

```
async fn image_helper_accepts_low_detail()
```

**Purpose**: This test confirms that “low” is a supported image detail value. Detail controls how much image information downstream consumers may request.

**Data flow**: It runs image with a data URI and detail “low.” The expected response contains one image item with Low detail.

**Call relations**: The test validates accepted image-helper options through the normal CodeModeService execution path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helpers_reject_remote_urls`  (lines 1747–1780)

```
async fn image_helpers_reject_remote_urls()
```

**Purpose**: This test ensures image helpers reject ordinary remote HTTP or HTTPS URLs. Code Mode expects image outputs to be embedded as base64 data URIs instead.

**Data flow**: For both http and https URLs, it tries image and generatedImage. Each run should produce no content and an error explaining that remote image URLs are unsupported.

**Call relations**: The test repeatedly creates a fresh CodeModeService and uses tests::execute to cover both helper functions.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, execute, execute_request, format!).


##### `tests::image_helper_rejects_unsupported_detail`  (lines 1783–1812)

```
async fn image_helper_rejects_unsupported_detail()
```

**Purpose**: This test checks that invalid image detail values are rejected with a clear message. That prevents silently accepting a setting downstream code does not understand.

**Data flow**: It runs image with detail “medium.” The expected result has no content and an error listing the allowed values.

**Call relations**: The test uses the public execution helper to validate runtime-side input checking.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_rejects_raw_mcp_result_container`  (lines 1815–1851)

```
async fn image_helper_rejects_raw_mcp_result_container()
```

**Purpose**: This test makes sure image expects an actual image block, not a whole MCP result container. Passing the wrong shape should fail clearly.

**Data flow**: It passes an object with a content array containing an image block. The expected response has no content and an error explaining the accepted image input forms.

**Call relations**: The test exercises the image helper’s validation path through CodeModeService execution.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::wait_reports_missing_cell_separately_from_runtime_results`  (lines 1854–1873)

```
async fn wait_reports_missing_cell_separately_from_runtime_results()
```

**Purpose**: This test confirms that waiting on an unknown cell is reported as a missing-cell outcome, not as a live runtime result. That distinction helps callers tell lookup failure from code failure.

**Data flow**: It creates a service and waits on cell ID “missing.” The expected outcome is WaitOutcome::MissingCell containing a standard missing-cell runtime response.

**Call relations**: The test drives CodeModeService::wait, which uses begin_wait and missing_wait for this case.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, cell_id).


##### `tests::terminate_waits_for_runtime_shutdown_before_responding`  (lines 1876–1945)

```
async fn terminate_waits_for_runtime_shutdown_before_responding()
```

**Purpose**: This test verifies that termination does not reply until the runtime has actually closed. That prevents callers from thinking a cell is gone while it is still shutting down.

**Data flow**: It manually starts a runtime and cell control loop, sends start and yield events, then sends a terminate command. The terminate response is expected not to arrive until the runtime event sender is dropped, after which it returns Terminated.

**Call relations**: The test bypasses the public service path and calls spawn_runtime and run_cell_control directly so it can precisely control runtime events and timing.

*Call graph*: calls 2 internal fn (spawn_runtime, run_cell_control); 12 external calls (new, assert!, assert_eq!, Runtime, cell_id, execute_request, test_inner, unbounded_channel, channel, pin! (+2 more)).


### History and persistence bridges
These files reconstruct and persist thread history, truncate rollout state for forks and resumes, and synchronize derived metadata between storage and live runtimes.

### `core/src/thread_rollout_truncation.rs`

`domain_logic` · `conversation history processing`

A rollout is a stored stream of conversation-related items: user messages, assistant messages, internal events, and sometimes messages between agents. This file provides the rules for finding meaningful “turn” boundaries inside that stream, then cutting the stream before or after those boundaries.

The main problem it solves is that conversation history is not just a plain list of chat messages. It can include rollback markers, which mean “pretend the last N turns were removed.” If truncation ignored those markers, it might keep stale history that the thread has already rolled back from. So the scanning functions here build boundary lists while also applying rollback events, much like crossing out old entries in a notebook before deciding where to tear out pages.

There are two kinds of boundaries. A real user-message boundary is a normal user message found by parsing a response item into a turn item. A fork-turn boundary is broader: it includes user messages, inter-agent communications that explicitly start a turn, and older assistant-message envelopes that carry the same trigger flag.

The truncation helpers then use those boundary positions. One cuts everything starting at the nth user message from the beginning. Another keeps only the last N fork turns, dropping earlier startup context. This matters for keeping thread histories compact and correct while respecting the conversation’s actual shape.

#### Function details

##### `initial_history_has_prior_user_turns`  (lines 15–17)

```
fn initial_history_has_prior_user_turns(conversation_history: &InitialHistory) -> bool
```

**Purpose**: Checks whether an initial conversation history already contains at least one prior user-turn boundary. This helps later setup know whether the thread is starting fresh or continuing after earlier user input.

**Data flow**: It receives an InitialHistory value, which is a stored conversation history. It asks that history to scan its rollout items using this file’s boundary test. It returns true if any item looks like a prior user turn, and false otherwise; it does not change the history.

**Call relations**: When record_initial_history is recording or preparing initial history, it calls this function to answer the simple question: “Has a user turn already happened?” This function delegates the actual per-item decision to rollout_item_is_user_turn_boundary through the history scanner.

*Call graph*: calls 1 internal fn (scan_rollout_items); called by 1 (record_initial_history).


##### `rollout_item_is_user_turn_boundary`  (lines 19–25)

```
fn rollout_item_is_user_turn_boundary(item: &RolloutItem) -> bool
```

**Purpose**: Decides whether one rollout item counts as a user-turn boundary for initial-history checks. It treats normal response items according to the shared user-turn rule, and treats inter-agent communication as a boundary too.

**Data flow**: It receives one RolloutItem. If the item wraps a ResponseItem, it asks the context manager’s user-turn test whether that response starts a user turn. If the item is inter-agent communication, it returns true. For other item kinds, it returns false.

**Call relations**: This is the test function used by initial_history_has_prior_user_turns while scanning initial history. It relies on the broader is_user_turn_boundary rule for response messages, so this file stays consistent with the rest of the context-management code.

*Call graph*: 1 external calls (is_user_turn_boundary).


##### `user_message_positions_in_rollout`  (lines 35–56)

```
fn user_message_positions_in_rollout(items: &[RolloutItem]) -> Vec<usize>
```

**Purpose**: Finds the positions of real user messages in a rollout, after taking rollback events into account. Someone uses it when they need exact cut points based only on user messages.

**Data flow**: It receives a slice of RolloutItem values. It walks through them in order, remembering the index of each response message that parses as a UserMessage. If it sees a ThreadRolledBack event, it removes the recorded positions for the number of user turns that were rolled back. It returns the remaining list of indexes that count in the effective, post-rollback history.

**Call relations**: truncate_rollout_before_nth_user_message_from_start calls this function first so it can choose the correct place to cut. This helper does the careful scanning work, including parsing messages through event_mapping and honoring rollback events before handing back the usable positions.

*Call graph*: called by 1 (truncate_rollout_before_nth_user_message_from_start); 4 external calls (new, matches!, iter, try_from).


##### `fork_turn_positions_in_rollout`  (lines 69–109)

```
fn fork_turn_positions_in_rollout(items: &[RolloutItem]) -> Vec<usize>
```

**Purpose**: Finds the positions where a rollout can be split into fork turns, which include user messages and certain agent-to-agent turn triggers. It is broader than user-message scanning because forks can be driven by inter-agent instructions as well as by users.

**Data flow**: It receives rollout items and walks through them from start to finish. It keeps one list of turn positions used for rollback math and another list of fork-turn positions that may be used for truncation. For response items, it records rollback-relevant user-turn boundaries and fork boundaries from real user messages or legacy trigger envelopes. For direct inter-agent communication, it records a rollback boundary and, if its trigger_turn flag is true, a fork boundary. When a rollback event appears, it removes stale boundary positions from the rollback list and drops fork boundaries at or after the rolled-back start point. It returns the surviving fork-turn indexes.

**Call relations**: truncate_rollout_to_last_n_fork_turns calls this function to learn where the meaningful fork turns begin. Inside the scan, it calls is_real_user_message_boundary and is_trigger_turn_boundary for the two response-message cases, and it also uses the shared is_user_turn_boundary rule for rollback tracking.

*Call graph*: calls 2 internal fn (is_real_user_message_boundary, is_trigger_turn_boundary); called by 1 (truncate_rollout_to_last_n_fork_turns); 4 external calls (new, is_user_turn_boundary, iter, try_from).


##### `truncate_rollout_before_nth_user_message_from_start`  (lines 119–137)

```
fn truncate_rollout_before_nth_user_message_from_start(
    items: &[RolloutItem],
    n_from_start: usize,
) -> Vec<RolloutItem>
```

**Purpose**: Returns the beginning part of a rollout, stopping just before the nth user message from the start. This is useful when the system wants to discard a conversation suffix starting at a particular user turn.

**Data flow**: It receives a list of rollout items and a zero-based user-message number. If the number is usize::MAX, it treats that as “do not cut” and returns a full copy. Otherwise it asks user_message_positions_in_rollout for the effective user-message indexes. If there are not enough user messages to reach the requested one, it also returns the full rollout. If there is such a user message, it copies and returns only the items before that index, excluding the user message itself and everything after it.

**Call relations**: This function is a public helper within the crate for callers that need a prefix cut. It depends on user_message_positions_in_rollout so the cut respects rollback events instead of using the raw, possibly stale stream.

*Call graph*: calls 1 internal fn (user_message_positions_in_rollout); 1 external calls (to_vec).


##### `truncate_rollout_to_last_n_fork_turns`  (lines 143–161)

```
fn truncate_rollout_to_last_n_fork_turns(
    items: &[RolloutItem],
    n_from_end: usize,
) -> Vec<RolloutItem>
```

**Purpose**: Returns the ending part of a rollout that contains the last N fork turns. It is used to keep recent useful conversation context while dropping older startup or earlier-turn material.

**Data flow**: It receives rollout items and a count of fork turns to keep. If the count is zero, it returns an empty list. Otherwise it asks fork_turn_positions_in_rollout for the effective fork-turn boundaries. It chooses the boundary N turns from the end, or the first boundary if there are fewer than N. It then copies and returns all items from that boundary to the end. If there are no fork-turn boundaries, it returns an empty list.

**Call relations**: This is the main suffix-truncation helper in the file. It relies on fork_turn_positions_in_rollout to do the hard work of recognizing user and inter-agent turn starts and applying rollback rules before the final slice is chosen.

*Call graph*: calls 1 internal fn (fork_turn_positions_in_rollout); 1 external calls (new).


##### `is_real_user_message_boundary`  (lines 163–168)

```
fn is_real_user_message_boundary(item: &ResponseItem) -> bool
```

**Purpose**: Checks whether a response item is truly a user message. This avoids treating every user-turn-like item as a real user message when the code needs the narrower definition.

**Data flow**: It receives a ResponseItem. It parses that item into a higher-level TurnItem, if possible. It returns true only when the parsed result is a UserMessage; otherwise it returns false. It does not change the item.

**Call relations**: fork_turn_positions_in_rollout calls this while scanning response items. It provides one of the accepted reasons for adding a fork-turn boundary: the boundary is a real user message.

*Call graph*: called by 1 (fork_turn_positions_in_rollout); 1 external calls (matches!).


##### `is_trigger_turn_boundary`  (lines 170–178)

```
fn is_trigger_turn_boundary(item: &ResponseItem) -> bool
```

**Purpose**: Recognizes an older style of inter-agent turn trigger that is wrapped inside an assistant message. This keeps compatibility with rollout data that used that legacy envelope format.

**Data flow**: It receives a ResponseItem. If the item is not a message, it returns false. If it is a message, it checks that the role is assistant, then tries to read the message content as InterAgentCommunication. If that succeeds and the communication has trigger_turn set, it returns true; otherwise it returns false.

**Call relations**: fork_turn_positions_in_rollout calls this while scanning response items. Together with is_real_user_message_boundary, it lets fork truncation recognize both normal user turns and legacy assistant-wrapped agent triggers.

*Call graph*: calls 1 internal fn (from_message_content); called by 1 (fork_turn_positions_in_rollout).


### `thread-store/src/local/create_thread.rs`

`domain_logic` · `thread creation`

A “thread” here is a saved conversation or work session. This file is responsible for starting one when the storage backend is local, meaning the data is kept on this machine rather than in a remote service.

The key thing this code needs is a current working directory, or `cwd`. That is the folder the thread is associated with, like the project folder a user is working in. If the caller does not provide one, the file rejects the request with a clear error, because the local recorder cannot safely decide where the thread belongs.

Once it has the folder, it builds a `RolloutConfig`. This is the setup sheet for the recorder: where Codex’s home data lives, where SQLite database files live, which folder the thread belongs to, which model provider is being used, and whether memory generation is turned on. “Memory” here means saved information that may be reused later; it is enabled only when the request’s memory mode says so.

Finally, it creates a `RolloutRecorder` with the thread identifiers, source information, starting instructions, available dynamic tools, and multi-agent version. If recorder creation fails, the low-level error is wrapped as a thread-store internal error with a helpful message. Without this file, the local store would not have the bridge between an incoming “create thread” request and the recorder that actually persists that thread.

#### Function details

##### `create_thread`  (lines 10–45)

```
async fn create_thread(
    store: &LocalThreadStore,
    params: CreateThreadParams,
) -> ThreadStoreResult<RolloutRecorder>
```

**Purpose**: Creates the local recorder for a new thread. It checks that the request includes the working folder required by local storage, builds the recorder configuration, and returns the ready-to-use `RolloutRecorder` or a clear thread-store error.

**Data flow**: It receives a `LocalThreadStore`, which provides storage locations from its configuration, and `CreateThreadParams`, which carries the new thread’s metadata and identifiers. It reads the requested working directory, model provider, memory mode, thread IDs, source details, base instructions, dynamic tools, and multi-agent version. If the working directory is missing, it returns an invalid-request error; otherwise it builds a `RolloutConfig`, passes that plus recorder parameters into `RolloutRecorder::new`, waits for the recorder to initialize, and returns the recorder. If initialization fails, it converts that failure into a `ThreadStoreError::Internal` message.

**Call relations**: This function is used by the local thread-store create flow when a caller asks to start a new thread. Its main handoff is to `RolloutRecorder::new`: after this function has gathered and reshaped the request data into the format the recorder needs, the recorder takes over the job of preparing local persistence for the thread.

*Call graph*: calls 2 internal fn (new, new); called by 1 (create_thread); 1 external calls (matches!).


### `thread-store/src/thread_metadata_sync.rs`

`domain_logic` · `thread create, resume, and history append`

A thread store saves the full history of a conversation, but user interfaces and indexes also need quick facts about that thread: when it was created, what its first message was, what title or preview to show, which model was used, and so on. This file is the bridge between those two worlds. It reads canonical history items, called rollout items, and derives safe metadata patches from them.

The main type, ThreadMetadataSync, acts like a notebook kept beside a live thread. When a thread is created, it records initial facts such as the current working directory, source, version, memory mode, and git repository information if available. When a thread is resumed, it can scan the existing history to recover facts that may not yet be stored as metadata. When new items are appended, it decides whether they contain meaningful metadata changes or merely prove that the thread was recently active.

The file is careful about timing. It does not immediately flush creation metadata before history exists, and it waits to flush resume-derived metadata until a new append happens. It also avoids writing repeated “updated_at” timestamp changes too often, like batching small clock updates instead of saving every tick. Pending updates carry a generation number so a retry can safely keep the same update until the store confirms it was applied.

#### Function details

##### `ThreadMetadataSync::for_create`  (lines 52–91)

```
async fn for_create(params: &CreateThreadParams) -> Self
```

**Purpose**: Builds a metadata synchronizer for a brand-new thread. It prepares the first metadata patch with creation time, source details, current folder, version, memory setting, and git information when the folder is inside a git repository.

**Data flow**: It takes thread creation parameters, reads the supplied metadata and source information, checks the current folder for a git repository, and asks for git details if one exists. It returns a ThreadMetadataSync with an initial pending metadata patch, but marks that patch as waiting until some thread history has been written.

**Call relations**: The create flow calls this when a thread is first opened. It uses external time and git helpers to gather facts, then leaves the pending patch for later store code to pick up after history exists.

*Call graph*: called by 1 (create); 5 external calls (default, now, collect_git_info, get_git_repo_root, env!).


##### `ThreadMetadataSync::for_resume`  (lines 93–116)

```
fn for_resume(params: &ResumeThreadParams) -> Self
```

**Purpose**: Builds a metadata synchronizer for an existing thread being reopened. If old history is available, it scans that history to rediscover metadata such as preview text or creation time.

**Data flow**: It takes resume parameters, notes whether a current working directory is already known, and starts with no pending update. If history was provided, it observes those items, merges any discovered metadata into a pending patch, and marks that patch to wait until a new append happens.

**Call relations**: The resume flow calls this during normal operation, and several tests call it to check resume behavior. It relies on the history-observation path to derive metadata, then stores the result for later flushing.

*Call graph*: called by 6 (resume, goal_update_sets_preview_without_overriding_existing_preview, later_user_messages_do_not_emit_existing_preview_fields, metadata_irrelevant_items_coalesce_updated_at_touches, resume_history_keeps_derived_metadata_pending_until_applied, resume_history_waits_for_append_before_flushing_metadata).


##### `ThreadMetadataSync::take_pending_update`  (lines 118–125)

```
fn take_pending_update(&self) -> Option<PendingThreadMetadataPatch>
```

**Purpose**: Returns the metadata patch that is currently waiting to be saved, without clearing it. This lets callers retry saving the same patch if persistence fails.

**Data flow**: It reads the synchronizer's pending patch and generation number. If a patch exists, it returns a PendingThreadMetadataPatch containing a clone of that patch and its generation; otherwise it returns nothing.

**Call relations**: observe_appended_items uses this after merging new observations, and take_pending_update_for_existing_history uses it after checking deferral rules. The patch remains pending until mark_pending_update_applied confirms it was saved.

*Call graph*: called by 2 (observe_appended_items, take_pending_update_for_existing_history).


##### `ThreadMetadataSync::take_pending_update_for_existing_history`  (lines 127–137)

```
fn take_pending_update_for_existing_history(
        &self,
    ) -> Option<PendingThreadMetadataPatch>
```

**Purpose**: Returns a pending metadata patch only when it is safe to apply it to history that already exists. It prevents metadata from being written too early during thread creation or resume.

**Data flow**: It checks two waiting flags: one for new thread metadata that should wait until history exists, and one for resume metadata that should wait until a new append. If neither flag blocks the update, it returns the same pending patch that take_pending_update would return.

**Call relations**: Store-side code can call this at a persistence boundary for existing history. It delegates the actual patch wrapping to take_pending_update once its safety checks pass.

*Call graph*: calls 1 internal fn (take_pending_update).


##### `ThreadMetadataSync::mark_pending_update_applied`  (lines 139–146)

```
fn mark_pending_update_applied(&mut self, update: &PendingThreadMetadataPatch)
```

**Purpose**: Confirms that a pending metadata patch was successfully saved. It clears the patch only if it is still the same generation that was handed out.

**Data flow**: It receives the patch object that a caller attempted to save. If its generation matches the synchronizer's current generation, the pending patch is removed; if the patch included an updated_at timestamp, the synchronizer also records the current instant so future timestamp-only writes can be spaced out.

**Call relations**: Callers use this after persistence succeeds. It works with take_pending_update's generation number so a newer pending patch is not accidentally erased by confirmation of an older save.

*Call graph*: 1 external calls (now).


##### `ThreadMetadataSync::observe_appended_items`  (lines 148–175)

```
fn observe_appended_items(
        &mut self,
        items: &[RolloutItem],
    ) -> Option<PendingThreadMetadataPatch>
```

**Purpose**: Examines newly appended history items and produces the metadata update that should be saved because of them. It also updates the thread's activity timestamp when items do not contain richer metadata.

**Data flow**: It receives a slice of rollout items, clears the creation/resume waiting flags, and checks whether any item can affect metadata. If yes, it observes those items for detailed facts; if no, it creates a simple updated_at touch. It merges the result into pending state, may suppress frequent timestamp-only writes, and returns a pending patch when one should be flushed now.

**Call relations**: This is the main live append hook. It calls observe_items for meaningful metadata changes, thread_updated_at_touch for activity-only changes, merge_pending_update to combine the result, and take_pending_update to hand the patch back to persistence code.

*Call graph*: calls 4 internal fn (merge_pending_update, observe_items, take_pending_update, thread_updated_at_touch); 1 external calls (iter).


##### `ThreadMetadataSync::observe_items`  (lines 177–185)

```
fn observe_items(&mut self, items: &[RolloutItem]) -> Option<ThreadMetadataPatch>
```

**Purpose**: Scans appended items for metadata and includes a fresh updated_at timestamp. It is used for new history, where appending an item means the thread was active now.

**Data flow**: It takes rollout items and creates a starting metadata patch with updated_at set to the current time. It passes both to observe_items_with_update, which fills in any additional facts, and returns the resulting patch if there were items.

**Call relations**: observe_appended_items calls this when at least one appended item is known to affect metadata. It is a small wrapper around the shared observation logic.

*Call graph*: calls 1 internal fn (observe_items_with_update); called by 1 (observe_appended_items); 2 external calls (default, now).


##### `ThreadMetadataSync::observe_resume_history`  (lines 187–189)

```
fn observe_resume_history(&mut self, items: &[RolloutItem]) -> Option<ThreadMetadataPatch>
```

**Purpose**: Scans old history during resume without pretending the thread was updated now. This avoids changing the activity timestamp just because the application reopened an existing thread.

**Data flow**: It takes historical rollout items and starts with an empty metadata patch. It sends those items to observe_items_with_update, which may fill in facts like creation time, preview, title, or token usage, and returns the patch if there were items.

**Call relations**: for_resume calls this when resume parameters include history. It shares the same parsing machinery as observe_items but deliberately leaves updated_at unset.

*Call graph*: calls 1 internal fn (observe_items_with_update); 1 external calls (default).


##### `ThreadMetadataSync::observe_items_with_update`  (lines 191–280)

```
fn observe_items_with_update(
        &mut self,
        items: &[RolloutItem],
        mut update: ThreadMetadataPatch,
    ) -> Option<ThreadMetadataPatch>
```

**Purpose**: Contains the main rules for turning history items into thread metadata. It recognizes session records, turn settings, user messages, token counts, and goal updates, and copies the useful facts into a patch.

**Data flow**: It receives rollout items plus a patch that may already contain fields such as updated_at. It walks each item, updates internal “already seen” flags, extracts metadata only when appropriate, and returns the filled patch. For example, it uses the first user message as preview/title, reads model and permission settings from turn context, parses session timestamps, and converts git observations into patch form.

**Call relations**: observe_items and observe_resume_history both call this shared worker. It calls helper functions for parsing memory mode, parsing timestamps, stripping user-message prefixes, building previews, and converting git information.

*Call graph*: calls 5 internal fn (git_info_patch_from_observation, parse_memory_mode, parse_session_timestamp, strip_user_message_prefix, user_message_preview); called by 2 (observe_items, observe_resume_history); 1 external calls (is_empty).


##### `ThreadMetadataSync::merge_pending_update`  (lines 282–291)

```
fn merge_pending_update(&mut self, update: Option<ThreadMetadataPatch>)
```

**Purpose**: Combines a newly discovered metadata patch with any patch already waiting to be saved. This prevents small observations from overwriting or losing earlier pending facts.

**Data flow**: It receives an optional metadata patch. If there is no patch, it does nothing. If a pending patch already exists, it merges the new fields into it; otherwise it stores the new patch. It then advances the generation number so later save confirmations can tell which version they refer to.

**Call relations**: observe_appended_items calls this after observing appended history. for_resume also uses it when resume history produces metadata, even though that call is not listed in the graph facts.

*Call graph*: called by 1 (observe_appended_items).


##### `parse_memory_mode`  (lines 294–300)

```
fn parse_memory_mode(value: &str) -> Option<ThreadMemoryMode>
```

**Purpose**: Turns the text form of a memory setting into the program's ThreadMemoryMode value. It accepts only the known words for enabled and disabled.

**Data flow**: It takes a string. If the string is "enabled", it returns the Enabled mode; if it is "disabled", it returns the Disabled mode; for anything else, it returns nothing.

**Call relations**: observe_items_with_update calls this when it reads memory mode text from session metadata. This keeps invalid or unknown stored text from becoming a misleading metadata value.

*Call graph*: called by 1 (observe_items_with_update).


##### `parse_session_timestamp`  (lines 302–310)

```
fn parse_session_timestamp(value: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses a timestamp written in session metadata into a UTC date and time. It supports both standard RFC 3339 timestamps and an older filename-like timestamp format.

**Data flow**: It takes timestamp text. It first tries the standard date-time parser; if that fails, it tries the older pattern. If either succeeds, it returns a UTC DateTime; if both fail, it returns nothing.

**Call relations**: observe_items_with_update calls this when it sees matching session metadata. The parsed value becomes the thread's created_at metadata.

*Call graph*: called by 1 (observe_items_with_update); 1 external calls (parse_from_rfc3339).


##### `strip_user_message_prefix`  (lines 312–317)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes the stored marker that can appear before the actual user text. This lets previews and titles show what the user wrote instead of internal formatting.

**Data flow**: It takes message text. If it finds the known USER_MESSAGE_BEGIN marker, it returns the trimmed text after that marker; otherwise it returns the trimmed original text.

**Call relations**: observe_items_with_update uses this when choosing a title, and user_message_preview uses it when building preview text. It is the shared cleanup step for user-visible message snippets.

*Call graph*: called by 2 (observe_items_with_update, user_message_preview).


##### `user_message_preview`  (lines 319–333)

```
fn user_message_preview(user: &UserMessageEvent) -> Option<String>
```

**Purpose**: Builds a short display preview from a user message. If the message has text, that text is used; if it has only images, it returns a simple image placeholder.

**Data flow**: It receives a UserMessageEvent, strips any internal prefix from its text, and checks whether anything remains. Non-empty text becomes the preview string. If there is no text but attached images exist, it returns "[Image]"; otherwise it returns nothing.

**Call relations**: observe_items_with_update calls this when it sees a user message. The result can become the thread preview and first_user_message metadata.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (observe_items_with_update).


##### `thread_updated_at_touch`  (lines 335–340)

```
fn thread_updated_at_touch() -> ThreadMetadataPatch
```

**Purpose**: Creates a minimal metadata patch saying the thread was updated now. It is used when new history was appended but the items do not provide richer metadata facts.

**Data flow**: It reads the current time and returns a ThreadMetadataPatch with only updated_at filled in. All other fields stay empty.

**Call relations**: observe_appended_items calls this for metadata-irrelevant appended items. The result may be delayed or coalesced if recent timestamp-only writes already happened.

*Call graph*: called by 1 (observe_appended_items); 2 external calls (default, now).


##### `update_has_metadata_facts`  (lines 342–363)

```
fn update_has_metadata_facts(update: &ThreadMetadataPatch) -> bool
```

**Purpose**: Checks whether a metadata patch contains any meaningful field besides a simple updated_at touch. This helps decide whether it is safe to delay frequent timestamp-only writes.

**Data flow**: It receives a ThreadMetadataPatch and inspects many optional fields, such as preview, title, model, source, current folder, token usage, git info, and memory mode. It returns true if any of those fields are present, and false if none are present.

**Call relations**: observe_appended_items uses this check when considering whether to suppress a quick repeated updated_at-only write. Rich metadata is not suppressed the same way, because it may matter immediately.


##### `git_info_patch_from_observation`  (lines 365–371)

```
fn git_info_patch_from_observation(git_info: GitInfo) -> GitInfoPatch
```

**Purpose**: Converts observed git repository information into the patch shape used by thread metadata storage. This includes commit hash, branch, and repository URL.

**Data flow**: It takes a GitInfo value whose fields may or may not be present. It turns each present value into the nested optional form expected by GitInfoPatch, and returns that patch.

**Call relations**: observe_items_with_update calls this when git data appears in session metadata. for_create also uses it after collecting git information for a new thread.

*Call graph*: called by 1 (observe_items_with_update).


##### `tests::resume_history_keeps_derived_metadata_pending_until_applied`  (lines 389–422)

```
fn resume_history_keeps_derived_metadata_pending_until_applied()
```

**Purpose**: Tests that metadata discovered from resume history stays pending until the store confirms it was applied. This protects retry behavior if a save fails.

**Data flow**: It creates a thread id and fake resume history containing session metadata and a user message. It builds a synchronizer, reads the pending patch, checks created_at, preview, title, first user message, and absence of updated_at, then confirms that taking the patch does not clear it. After marking it applied, it checks that the pending patch is gone.

**Call relations**: This test calls for_resume and helper functions such as resume_params. It verifies the intended contract between take_pending_update and mark_pending_update_applied.

*Call graph*: calls 2 internal fn (new, for_resume); 4 external calls (assert!, assert_eq!, resume_params, vec!).


##### `tests::goal_update_sets_preview_without_overriding_existing_preview`  (lines 425–445)

```
fn goal_update_sets_preview_without_overriding_existing_preview()
```

**Purpose**: Tests that a thread goal can set the preview, and that a later user message still becomes the first user message and title without replacing that preview.

**Data flow**: It builds resume history with a goal update followed by a user message. After creating the synchronizer, it reads the pending patch and checks that preview comes from the goal while first_user_message and title come from the user text.

**Call relations**: This test calls for_resume with fake history made by resume_params and goal_update. It exercises the ordering rules inside observe_items_with_update.

*Call graph*: calls 2 internal fn (new, for_resume); 3 external calls (assert_eq!, resume_params, vec!).


##### `tests::later_user_messages_do_not_emit_existing_preview_fields`  (lines 448–469)

```
fn later_user_messages_do_not_emit_existing_preview_fields()
```

**Purpose**: Tests that once preview, title, and first user message have already been recorded, later user messages do not emit those same first-message fields again.

**Data flow**: It resumes a thread with an initial user message, takes and marks the resulting metadata as applied, then appends another user message. The returned patch should contain updated_at but not preview, title, or first_user_message.

**Call relations**: This test uses for_resume and then observe_appended_items. It confirms that the synchronizer's seen flags stop later messages from overwriting first-message metadata.

*Call graph*: calls 2 internal fn (new, for_resume); 7 external calls (assert!, assert_eq!, UserMessage, EventMsg, resume_params, user_message, vec!).


##### `tests::metadata_irrelevant_items_coalesce_updated_at_touches`  (lines 472–496)

```
fn metadata_irrelevant_items_coalesce_updated_at_touches()
```

**Purpose**: Tests that repeated metadata-irrelevant appends do not cause too many immediate updated_at writes. This keeps storage from being spammed by rapid timestamp-only updates.

**Data flow**: It creates a synchronizer with empty resume history and appends a compacted item that does not carry metadata facts. The first append returns an updated_at patch and is marked applied. A second append inside the coalescing window returns nothing immediately, but the pending update still remains available for a later barrier.

**Call relations**: This test calls for_resume and observe_appended_items through the public sync behavior. It checks the throttling path that uses thread_updated_at_touch and the last persisted touch time.

*Call graph*: calls 2 internal fn (new, for_resume); 5 external calls (new, assert!, Compacted, from_ref, resume_params).


##### `tests::resume_history_waits_for_append_before_flushing_metadata`  (lines 499–520)

```
fn resume_history_waits_for_append_before_flushing_metadata()
```

**Purpose**: Tests that metadata found during resume is not flushed by itself before a new append occurs. This avoids rewriting old thread metadata merely because the thread was opened.

**Data flow**: It creates resume history with session metadata and a user message, builds a synchronizer, and confirms that take_pending_update_for_existing_history returns nothing. Then it appends a new user message and confirms that a patch is returned.

**Call relations**: This test calls for_resume, take_pending_update_for_existing_history, and observe_appended_items. It verifies the defer_resume_update_until_append rule.

*Call graph*: calls 2 internal fn (new, for_resume); 3 external calls (assert!, resume_params, vec!).


##### `tests::resume_params`  (lines 522–534)

```
fn resume_params(thread_id: ThreadId, history: Vec<RolloutItem>) -> ResumeThreadParams
```

**Purpose**: Builds a small ResumeThreadParams value for tests. It saves each test from repeating the same setup details.

**Data flow**: It takes a thread id and a vector of rollout history items. It returns resume parameters with that history, no rollout path, archived threads excluded, and simple test metadata such as provider name and enabled memory mode.

**Call relations**: Several tests call this helper before passing the result to for_resume. It is only test scaffolding, not production logic.


##### `tests::user_message`  (lines 536–545)

```
fn user_message(message: &str) -> UserMessageEvent
```

**Purpose**: Builds a simple user message event for tests. It fills in the text and leaves images and other optional message details empty.

**Data flow**: It takes message text and returns a UserMessageEvent with that text, no client id, no remote images, no local images, no text elements, and default values for the remaining fields.

**Call relations**: Tests use this helper when constructing fake history or appended user-message events. Those events then feed the same preview and title extraction logic used in production.

*Call graph*: 2 external calls (default, new).


##### `tests::session_meta`  (lines 547–557)

```
fn session_meta(thread_id: ThreadId) -> SessionMetaLine
```

**Purpose**: Builds a simple session metadata line for tests. It gives the fake thread a known timestamp so assertions can check created_at exactly.

**Data flow**: It takes a thread id and returns a SessionMetaLine whose metadata uses that id, a fixed timestamp, an Exec source, and defaults for other fields. It includes no git data.

**Call relations**: Resume-related tests include this helper's output in fake history. observe_items_with_update then reads it as if it came from real stored session metadata.

*Call graph*: 1 external calls (default).


##### `tests::goal_update`  (lines 559–574)

```
fn goal_update(thread_id: ThreadId, objective: &str) -> ThreadGoalUpdatedEvent
```

**Purpose**: Builds a fake thread-goal update event for tests. It lets tests check how a goal objective affects the thread preview.

**Data flow**: It takes a thread id and objective text, then returns a ThreadGoalUpdatedEvent with that objective, active status, zeroed counters, and no turn id. The thread id is stored both on the event and inside the goal.

**Call relations**: The goal-preview test uses this helper to create a rollout item that observe_items_with_update can process. It is test-only setup for the goal update branch.


### `thread-store/src/live_thread.rs`

`orchestration` · `session startup through active thread operation and shutdown`

A “thread” here is a saved conversation or session. This file is the bridge between live session code and the storage layer. Storage might be a local rollout file or a remote service, but callers get one simple object, `LiveThread`, and do not need to care about those details.

`LiveThread` remembers the thread’s id, the `ThreadStore` that actually reads and writes data, and a small metadata tracker called `ThreadMetadataSync`. That tracker watches saved conversation items and works out when thread metadata, such as derived summary-like state, needs to be updated. The file is careful about timing: before explicit metadata changes, persistence, flush, or shutdown, it pushes any pending metadata update so stored thread information does not fall behind the saved history.

`LiveThreadInitGuard` protects the fragile startup period. If persistence has been opened but session initialization later fails, the guard discards that unfinished persistence automatically. It is like taking a shopping cart back if you leave before checkout: nothing half-finished is left behind. Once startup succeeds, `commit` tells the guard not to discard the live thread.

#### Function details

##### `LiveThreadInitGuard::new`  (lines 47–49)

```
fn new(live_thread: Option<LiveThread>) -> Self
```

**Purpose**: Creates a startup guard around an optional live thread. Code uses it during session initialization so unfinished thread persistence can be cleaned up if startup does not complete.

**Data flow**: It receives either a `LiveThread` or nothing. It stores that value inside the guard. The result is a guard object that will later either be committed, explicitly discarded, or automatically cleaned up when dropped.

**Call relations**: This is used by higher-level session creation code when it has opened thread persistence but has not yet fully taken ownership of the running session. It does not call other project logic; it just packages the live thread for safe startup handling.

*Call graph*: called by 1 (new).


##### `LiveThreadInitGuard::as_ref`  (lines 51–53)

```
fn as_ref(&self) -> Option<&LiveThread>
```

**Purpose**: Lets callers look at the guarded live thread without taking ownership of it. This is useful when startup code needs to use the live thread while still keeping the safety guard active.

**Data flow**: It reads the guard’s stored optional `LiveThread`. It returns a borrowed reference if one is present, or nothing if the guard has already been committed or discarded. It does not change the guard.

**Call relations**: This fits into initialization code that needs temporary access before deciding whether startup succeeds. It hands out only a reference, so cleanup responsibility stays with the guard.


##### `LiveThreadInitGuard::commit`  (lines 55–57)

```
fn commit(&mut self)
```

**Purpose**: Marks startup as successful. After this call, the guard will no longer discard the live thread when it goes away.

**Data flow**: It takes the optional live thread stored inside the guard and replaces it with nothing. Nothing is returned. The practical effect is that automatic cleanup is disabled because ownership has moved to normal session operation.

**Call relations**: Higher-level startup code calls this once the session fully owns the live thread. After that, later persistence work is done through `LiveThread` methods rather than the guard’s failure-cleanup path.


##### `LiveThreadInitGuard::discard`  (lines 59–66)

```
async fn discard(&mut self)
```

**Purpose**: Explicitly throws away the guarded live thread’s persistence if startup fails. It logs a warning if cleanup itself fails, because failure to clean up should be visible but cannot be fixed here.

**Data flow**: It removes the live thread from the guard if one is still present. It asks that live thread to discard its storage. It returns no value, but it changes the guard so the thread will not be discarded twice.

**Call relations**: This is the manual cleanup path during failed initialization. It delegates the real storage cleanup to `LiveThread::discard`; if that reports an error, this function records the problem with a warning.

*Call graph*: 1 external calls (warn!).


##### `LiveThreadInitGuard::drop`  (lines 70–83)

```
fn drop(&mut self)
```

**Purpose**: Provides a last-resort cleanup if the guard is forgotten or leaves scope during a failed startup. In Rust, `drop` runs automatically when an object is destroyed.

**Data flow**: It removes any still-guarded live thread. If an asynchronous Tokio runtime is available, it starts a background task to discard the thread’s persistence. If no runtime exists, or if discard later fails, it logs a warning.

**Call relations**: This is the automatic safety net behind `commit` and `discard`. Startup code should normally commit or discard deliberately, but this method prevents many accidental half-written thread records from being left behind.

*Call graph*: 2 external calls (try_current, warn!).


##### `LiveThread::create`  (lines 87–99)

```
async fn create(
        thread_store: Arc<dyn ThreadStore>,
        params: CreateThreadParams,
    ) -> ThreadStoreResult<Self>
```

**Purpose**: Creates a brand-new live thread in the backing store and returns the handle used for later saves, reads, and shutdown. It also prepares metadata tracking from the creation parameters.

**Data flow**: It receives a shared `ThreadStore` and creation details, including the thread id. It builds initial metadata sync state, asks the store to create the thread, and then returns a `LiveThread` containing the id, store, and metadata tracker protected by a mutex, which is a lock that prevents two async tasks from editing it at once.

**Call relations**: Session setup and tests call this when starting a new thread. It hands the actual creation work to the configured `ThreadStore` and uses `ThreadMetadataSync::for_create` to keep metadata behavior aligned with the new thread’s starting state.

*Call graph*: calls 1 internal fn (for_create); called by 6 (new, attach_thread_persistence, shutdown_complete_does_not_append_to_thread_store_after_shutdown, live_thread_observes_appended_items_into_sqlite_metadata, live_thread_shutdown_does_not_materialize_empty_thread_metadata, live_thread_shutdown_with_buffered_items_materializes_before_metadata_read); 2 external calls (new, new).


##### `LiveThread::resume`  (lines 101–134)

```
async fn resume(
        thread_store: Arc<dyn ThreadStore>,
        mut params: ResumeThreadParams,
    ) -> ThreadStoreResult<Self>
```

**Purpose**: Reopens an existing thread so a session can continue using it. If no history was supplied by the caller, it loads the history first so metadata tracking starts from the real saved conversation.

**Data flow**: It receives a store and resume parameters. It asks the store to resume the thread. If history is missing, it loads history from storage; if that load fails, it discards the newly opened live persistence and returns the load error. Once history is available, it builds metadata sync state and returns a ready `LiveThread`.

**Call relations**: Session setup calls this for resumed conversations. It coordinates three pieces: `ThreadStore` to reopen and maybe read history, cleanup through `discard_thread` if resume cannot be completed safely, and `ThreadMetadataSync::for_resume` to continue metadata tracking from the saved state.

*Call graph*: calls 1 internal fn (for_resume); called by 3 (new, live_thread_resume_loads_history_before_observing_metadata, live_thread_resume_loads_history_from_explicit_external_rollout_path); 4 external calls (new, new, clone, warn!).


##### `LiveThread::append_items`  (lines 136–169)

```
async fn append_items(&self, items: &[RolloutItem]) -> ThreadStoreResult<()>
```

**Purpose**: Adds new conversation items to the live thread and updates metadata if those items affect stored thread information. It keeps the saved history and the thread’s metadata moving together.

**Data flow**: It receives a slice of rollout items, which are saved conversation events. It first filters them into the canonical persisted form used for metadata observation. If there are no incoming items, it does nothing. Otherwise it appends the original items to storage. If the canonical set suggests metadata should change, it writes a metadata patch and marks that patch as applied.

**Call relations**: Active session code calls this as new conversation events are produced. It delegates item storage to `ThreadStore::append_items`, uses `ThreadMetadataSync` to decide whether metadata must change, and writes that change back through `update_thread_metadata`.

*Call graph*: 3 external calls (persisted_rollout_items, is_empty, to_vec).


##### `LiveThread::persist`  (lines 171–174)

```
async fn persist(&self) -> ThreadStoreResult<()>
```

**Purpose**: Makes the live thread durable and then applies any metadata update waiting to be written. This is used when the caller wants the current live state to become safely stored.

**Data flow**: It reads the thread id from the live handle. It asks the store to persist the thread, then flushes any pending metadata update. It returns success only if both storage persistence and metadata flushing succeed.

**Call relations**: Callers use this at important save points. It relies on the store for the main persistence action, then calls `flush_pending_metadata_update` so metadata is not left behind after the thread itself is persisted.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update).


##### `LiveThread::flush`  (lines 176–180)

```
async fn flush(&self) -> ThreadStoreResult<()>
```

**Purpose**: Pushes buffered thread data out through the store and applies pending metadata only when there is already existing history for it to describe. This avoids unnecessarily materializing metadata for an otherwise empty thread.

**Data flow**: It sends the thread id to the store’s flush operation. After that succeeds, it asks the metadata tracker for a pending update appropriate for existing history and applies it if present. It returns an error if either step fails.

**Call relations**: This is used when the system wants buffered writes to be visible without fully shutting down. It combines `ThreadStore::flush_thread` with the more conservative metadata path `flush_pending_metadata_update_for_existing_history`.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update_for_existing_history).


##### `LiveThread::shutdown`  (lines 182–186)

```
async fn shutdown(&self) -> ThreadStoreResult<()>
```

**Purpose**: Prepares the live thread for shutdown by writing any appropriate pending metadata, then tells the store to close the live thread. This keeps shutdown from losing metadata derived from already-saved history.

**Data flow**: It first checks the metadata tracker for an update that should be written for existing history and applies it. If that succeeds, it asks the store to shut down the thread. The result reports whether the shutdown sequence completed successfully.

**Call relations**: Session teardown calls this when the thread is no longer active. It deliberately flushes metadata before calling the store’s shutdown method, because after shutdown the live writer may no longer accept updates.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update_for_existing_history).


##### `LiveThread::discard`  (lines 188–190)

```
async fn discard(&self) -> ThreadStoreResult<()>
```

**Purpose**: Throws away this live thread’s persistence. This is used for failed startup or other cases where the live thread should not become a saved durable record.

**Data flow**: It reads the thread id from the handle and passes it to the store’s discard operation. It returns the store’s success or error result and does not update metadata.

**Call relations**: The initialization guard uses this during failure cleanup, and other callers can use it when abandoning a live thread. All actual deletion or rollback behavior belongs to the configured `ThreadStore`.


##### `LiveThread::load_history`  (lines 192–202)

```
async fn load_history(
        &self,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThreadHistory>
```

**Purpose**: Reads the saved conversation history for this live thread. The caller can choose whether archived data should be included.

**Data flow**: It receives the `include_archived` choice, combines it with this live thread’s id, and asks the store to load history. It returns the stored history object or an error from the store.

**Call relations**: Callers use this when they need the thread’s past conversation items. The method is a thin, thread-aware wrapper around the store’s history-loading operation.


##### `LiveThread::read_thread`  (lines 204–216)

```
async fn read_thread(
        &self,
        include_archived: bool,
        include_history: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads the stored thread record, optionally including archived data and optionally including the full history. This is the broader read operation, not just the item list.

**Data flow**: It receives two choices: whether archived data should count and whether history should be included. It packages those choices with the live thread id and asks the store to read the thread. The store returns the complete stored thread view requested.

**Call relations**: Callers use this when they need thread metadata and possibly history in one result. This method keeps callers from manually building the store request with the thread id.


##### `LiveThread::update_memory_mode`  (lines 218–235)

```
async fn update_memory_mode(
        &self,
        mode: ThreadMemoryMode,
        include_archived: bool,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Changes the thread’s memory mode, which controls how the thread should use or retain memory-related behavior. Before doing that, it writes any pending metadata update so the explicit change does not race with older derived metadata.

**Data flow**: It receives the new memory mode and whether archived threads may be updated. It first flushes pending metadata. Then it builds a metadata patch containing only the new memory mode and sends it to the store. It returns success or the first error encountered.

**Call relations**: Callers use this for a focused metadata change. It shares the safety pattern used by broader metadata updates: flush pending derived metadata first, then apply the caller’s explicit patch through `ThreadStore::update_thread_metadata`.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update); 1 external calls (default).


##### `LiveThread::update_metadata`  (lines 237–250)

```
async fn update_metadata(
        &self,
        patch: ThreadMetadataPatch,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Applies an explicit metadata patch to the thread. It first flushes any pending automatic metadata update so the caller’s requested change is applied on top of the latest stored state.

**Data flow**: It receives a metadata patch and an `include_archived` choice. It writes any pending metadata update, then sends the caller’s patch to the store. It returns the updated stored thread record from the store.

**Call relations**: This is the general metadata update entry point for live threads. It calls `flush_pending_metadata_update` before delegating to the store, preserving a clear order between automatic metadata changes and explicit caller changes.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update).


##### `LiveThread::local_rollout_path`  (lines 255–267)

```
async fn local_rollout_path(&self) -> ThreadStoreResult<Option<PathBuf>>
```

**Purpose**: Returns the live local rollout file path when the backing store is actually local. For remote stores, there may be no file path, so it returns nothing successfully.

**Data flow**: It checks whether the shared store is a `LocalThreadStore`. If not, it returns `Ok(None)`. If it is local, it asks that store for the live rollout path for this thread id and wraps the path in `Some`.

**Call relations**: This exists for older local-only callers that still need a file path. It carefully avoids assuming every store has files, so the same `LiveThread` abstraction can work with remote storage too.


##### `LiveThread::flush_pending_metadata_update`  (lines 269–272)

```
async fn flush_pending_metadata_update(&self) -> ThreadStoreResult<()>
```

**Purpose**: Takes any pending metadata update from the tracker and writes it to storage. This is the normal flush path used before durable persistence or explicit metadata changes.

**Data flow**: It locks the metadata tracker, removes any pending update, and passes that optional update to `apply_pending_metadata_update`. The output is success if there was nothing to do or if the update was written successfully.

**Call relations**: `persist`, `update_memory_mode`, and `update_metadata` call this before their main work. It separates the decision of whether an update is pending from the actual store write performed by `apply_pending_metadata_update`.

*Call graph*: calls 1 internal fn (apply_pending_metadata_update); called by 3 (persist, update_memory_mode, update_metadata).


##### `LiveThread::flush_pending_metadata_update_for_existing_history`  (lines 274–281)

```
async fn flush_pending_metadata_update_for_existing_history(&self) -> ThreadStoreResult<()>
```

**Purpose**: Writes a pending metadata update only when it makes sense for history that already exists. This protects empty or not-yet-materialized threads from getting metadata records too early.

**Data flow**: It locks the metadata tracker and asks for a pending update limited to existing-history cases. It then passes that optional update to `apply_pending_metadata_update`. If there is no suitable update, it completes without changing storage.

**Call relations**: `flush` and `shutdown` use this more cautious path. It feeds the result into the same apply helper as the normal flush path, but the tracker decides whether the update should really be written now.

*Call graph*: calls 1 internal fn (apply_pending_metadata_update); called by 2 (flush, shutdown).


##### `LiveThread::apply_pending_metadata_update`  (lines 283–302)

```
async fn apply_pending_metadata_update(
        &self,
        update: Option<crate::thread_metadata_sync::PendingThreadMetadataPatch>,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Actually writes a pending metadata patch to the store and then tells the metadata tracker that the patch is no longer pending. It is the shared final step for metadata flushing.

**Data flow**: It receives either a pending metadata patch or nothing. If there is nothing, it returns success immediately. If there is a patch, it sends that patch to the store for this thread, including archived records, then locks the tracker and marks the update as applied.

**Call relations**: Both metadata flush helpers call this after deciding what update, if any, should be written. It centralizes the store write and the bookkeeping step so callers do not accidentally write a patch without clearing its pending state.

*Call graph*: called by 2 (flush_pending_metadata_update, flush_pending_metadata_update_for_existing_history).


### `external-agent-sessions/src/lib.rs`

`orchestration` · `session import preparation`

This file brings together the smaller parts of the external-agent session importer. An “external-agent session” is a saved chat history created by some tool outside the current Codex session. Before Codex can import one, it needs to avoid duplicates, read the source file, verify that it points to a real working directory, and remember enough information to complete the import later.

The key flow starts with an ExternalAgentSessionMigration, which is a small description of a candidate session file: where it is, what directory it came from, and an optional title. prepare_validated_session_import then acts like a gatekeeper. It first asks the ledger, which is the import record book, whether this same session has already been brought in. If yes, it quietly skips it. If not, it loads the session, computes or receives a content hash, and only accepts it if the session’s working directory still exists.

The file also defines ImportedExternalAgentSession, the cleaned-up conversation data ready for Codex, and PendingSessionImport, which packages the source path, content fingerprint, and parsed session together. A few small helper functions support readable labels, safe text shortening, and timestamps. The tests check the most important promises: already-imported sessions are skipped, missing files report errors, and valid imports include the correct content hash.

#### Function details

##### `prepare_validated_session_import`  (lines 45–63)

```
fn prepare_validated_session_import(
    codex_home: &Path,
    session: ExternalAgentSessionMigration,
) -> io::Result<Option<PendingSessionImport>>
```

**Purpose**: This is the main gatekeeper for a possible external session import. It checks whether the session was already imported, then tries to load and validate it, returning either a ready-to-import package, nothing to do, or an error.

**Data flow**: It receives the Codex home directory, where import records are stored, and a candidate session description. First it asks the ledger whether the current source file has already been imported. If it has, the result is no pending import. If it has not, it loads the source session and its content hash. If loading succeeds and the session is usable, it returns a PendingSessionImport containing the source file path, the source content SHA-256 fingerprint, and the parsed session data.

**Call relations**: The test functions call this to prove the import gate behaves correctly. Inside the normal flow, it first consults has_current_session_been_imported so duplicates are not imported again, then hands the actual file loading work to load_importable_session.

*Call graph*: calls 2 internal fn (has_current_session_been_imported, load_importable_session); called by 3 (prepares_one_validated_session_import_with_content_hash, reports_session_preparation_errors, skips_session_that_was_already_imported).


##### `load_importable_session`  (lines 65–79)

```
fn load_importable_session(
    path: &Path,
) -> io::Result<Option<(PathBuf, ImportedExternalAgentSession, String)>>
```

**Purpose**: This function turns a session file path into a verified imported session, if the file can be used. It also makes the source path absolute and checks that the session’s working directory still exists.

**Data flow**: It receives a path to a session file. It converts that path into a canonical path, meaning the system’s resolved absolute path. Then it asks the export-loading code to parse the file and provide both the imported session and a SHA-256 content hash, which is a stable fingerprint of the file contents. If parsing finds nothing importable, it returns nothing. If the session’s recorded working directory is not a real directory, it also returns nothing. Otherwise it returns the resolved source path, the imported session, and the content hash.

**Call relations**: prepare_validated_session_import calls this after confirming the session has not already been imported. This function delegates the file-reading and parsing details to load_session_for_import_with_content_sha256, while it adds the extra validation needed before the session can move forward.

*Call graph*: calls 1 internal fn (load_session_for_import_with_content_sha256); called by 1 (prepare_validated_session_import); 1 external calls (canonicalize).


##### `summarize_for_label`  (lines 94–97)

```
fn summarize_for_label(text: &str) -> String
```

**Purpose**: This creates a short, readable label from a longer message. It is useful when a conversation needs a compact title or display name.

**Data flow**: It receives a text string. It takes only the first line, trims extra spaces from its ends, and then shortens it to the configured maximum title length. The result is a clean one-line summary string.

**Call relations**: This helper relies on truncate to do the safe shortening. It is part of the shared support code for turning conversation text into human-friendly labels.

*Call graph*: calls 1 internal fn (truncate).


##### `truncate`  (lines 99–108)

```
fn truncate(text: &str, max_len: usize) -> String
```

**Purpose**: This shortens text to a maximum number of characters without cutting by raw bytes. If the text is too long, it adds an ellipsis so readers can tell it was shortened.

**Data flow**: It receives some text and a maximum length. If the text already fits, it returns the text unchanged. If it is too long, it takes enough characters to leave room for three dots, builds a shortened prefix, and returns that prefix followed by “...”.

**Call relations**: summarize_for_label calls this when making labels from message text. Its job is deliberately small: keep display strings from becoming too long while preserving a clear visual sign that text was omitted.

*Call graph*: called by 1 (summarize_for_label); 1 external calls (format!).


##### `now_unix_seconds`  (lines 110–115)

```
fn now_unix_seconds() -> i64
```

**Purpose**: This returns the current time as a Unix timestamp, which is the number of seconds since January 1, 1970. It gives the importer a simple time value when it needs one.

**Data flow**: It reads the system clock. If the clock can be measured relative to the Unix epoch, it converts that duration to seconds and returns it as a whole number. If the system reports an unexpected time error, it returns zero instead of crashing.

**Call relations**: This is a small shared helper for timestamping. It calls the system time API directly and does not depend on the import flow around it.

*Call graph*: 1 external calls (now).


##### `tests::skips_session_that_was_already_imported`  (lines 126–139)

```
fn skips_session_that_was_already_imported()
```

**Purpose**: This test proves that the importer does not offer a session for import when the ledger already says it was imported. That protects users from duplicate imported conversations.

**Data flow**: The test creates a temporary Codex home and a fake session file. It records that file as already imported in the ledger. Then it asks prepare_validated_session_import to prepare the same file. The expected result is no pending import.

**Call relations**: This test sets up the ledger through record_imported_session, builds a candidate session with tests::session_migration, and then exercises prepare_validated_session_import. It checks the path where prepare_validated_session_import stops early after consulting has_current_session_been_imported.

*Call graph*: calls 3 internal fn (record_imported_session, prepare_validated_session_import, new); 4 external calls (new, assert!, session_migration, write).


##### `tests::reports_session_preparation_errors`  (lines 142–150)

```
fn reports_session_preparation_errors()
```

**Purpose**: This test proves that a missing source session file is reported as an error rather than silently ignored. That matters because a missing file is different from a valid session that simply has nothing importable.

**Data flow**: The test creates a temporary directory but deliberately points to a session file that does not exist. It passes that path into prepare_validated_session_import and expects an error. It then checks that the error kind is “not found.”

**Call relations**: This test uses tests::session_migration to build the candidate session and then calls prepare_validated_session_import. The failure comes through the loading path, where load_importable_session tries to resolve the missing file.

*Call graph*: calls 1 internal fn (prepare_validated_session_import); 3 external calls (new, assert_eq!, session_migration).


##### `tests::prepares_one_validated_session_import_with_content_hash`  (lines 153–174)

```
fn prepares_one_validated_session_import_with_content_hash()
```

**Purpose**: This test proves that a valid session is prepared for import and includes the correct SHA-256 content hash. The hash matters because it identifies the exact file contents that were imported.

**Data flow**: The test writes a small JSON session record to a temporary file. It calls prepare_validated_session_import for that file and expects a pending import. Then it independently computes the SHA-256 hash of the written contents and checks that the pending import contains the same value.

**Call relations**: This test builds its candidate with tests::session_migration and exercises the successful path through prepare_validated_session_import and load_importable_session. It confirms that the lower-level loader’s content fingerprint is preserved in the final PendingSessionImport.

*Call graph*: calls 1 internal fn (prepare_validated_session_import); 5 external calls (new, assert_eq!, session_migration, json!, write).


##### `tests::session_migration`  (lines 176–185)

```
fn session_migration(path: &Path) -> ExternalAgentSessionMigration
```

**Purpose**: This test helper builds a minimal ExternalAgentSessionMigration from a file path. It keeps the tests short and consistent.

**Data flow**: It receives a path to a source session file. It copies that path into the migration record, uses the file’s parent directory as the working directory, and leaves the title empty. The result is an ExternalAgentSessionMigration ready to pass into the preparation function.

**Call relations**: The three tests call this helper whenever they need a candidate session. It does not run production import logic itself; it simply creates the input shape that prepare_validated_session_import expects.

*Call graph*: 2 external calls (parent, to_path_buf).


### `external-agent-sessions/src/detect.rs`

`domain_logic` · `session import discovery`

This file solves a practical import problem: an external tool may have many old chat logs on disk, but Codex should only offer useful, recent sessions that have not already been imported. Without this filter, users could see stale sessions, duplicates, or sessions from projects that no longer exist.

The main function, `detect_recent_sessions`, looks under the external agent’s `projects` folder for `.jsonl` files. A JSONL file is a text file where each line is one JSON record, often used for logs. It checks each file’s modification time, keeps only files changed in the last 30 days, and limits the scan to the 50 newest candidates so a huge history does not slow things down. Think of it like sorting a stack of receipts and only keeping the newest few that still need attention.

It also reads an import ledger, which is a small record of what Codex has already imported. If a file is unchanged since its last import, it is skipped. If the file has changed, it may be offered again. For each remaining file, it asks the session summarizer to extract the project folder and title. Sessions whose project folder no longer exists are ignored. The test module builds small fake session folders and checks these behaviors, including title priority and batch-by-batch importing.

#### Function details

##### `detect_recent_sessions`  (lines 16–109)

```
fn detect_recent_sessions(
    external_agent_home: &Path,
    codex_home: &Path,
) -> io::Result<Vec<ExternalAgentSessionMigration>>
```

**Purpose**: Finds recent external-agent session files that Codex can import. It avoids old files, unchanged files already recorded in the import ledger, and sessions whose working project folder no longer exists.

**Data flow**: It receives the external agent home folder and the Codex home folder. It reads the external `projects` directory, checks `.jsonl` files, compares their modification times with the current time and the saved import ledger, keeps at most the 50 newest candidates, summarizes each candidate into a migration record, saves ledger updates when needed, and returns the list of sessions ready to import.

**Call relations**: The tests call this function with temporary fake homes and session files to prove the discovery rules. Inside the flow it asks `load_import_ledger` what has already been imported, uses `now_unix_seconds` to decide what is recent, calls `summarize_session` to turn a log file into a user-facing migration, and calls `save_import_ledger` if the ledger learned that a source file should be skipped as already current.

*Call graph*: calls 2 internal fn (load_import_ledger, save_import_ledger); called by 7 (detects_ai_title_over_first_user_message, detects_recent_sessions_with_existing_roots, detects_sessions_in_batches, prefers_custom_title_over_later_ai_title, prefers_latest_custom_title_over_first_user_message, redetects_sessions_when_source_contents_change_after_import, uses_file_modification_time_for_recency); 9 external calls (with_capacity, join, new, now_unix_seconds, summarize_session, canonicalize, read_dir, try_from, Reverse).


##### `tests::detects_recent_sessions_with_existing_roots`  (lines 124–148)

```
fn detects_recent_sessions_with_existing_roots()
```

**Purpose**: Checks the basic happy path: a recent session file with an existing project folder is detected. This proves the scanner can find a normal import candidate.

**Data flow**: It creates a temporary external home, creates a fake project folder, writes a session containing a user message and assistant reply, then runs `detect_recent_sessions`. The expected result is one migration pointing to that file, with the project folder as its working directory and the first user message as the title.

**Call relations**: This test uses `write_session` and `record` to build realistic input, then calls `detect_recent_sessions` and compares the returned migration with the expected value.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 4 external calls (new, assert_eq!, record, write_session).


##### `tests::prefers_latest_custom_title_over_first_user_message`  (lines 151–176)

```
fn prefers_latest_custom_title_over_first_user_message()
```

**Purpose**: Checks that custom titles chosen in the source app take priority over the first user message, and that the latest custom title wins. This matters because user-edited titles are usually more meaningful than raw chat text.

**Data flow**: It writes a fake session with a first user message followed by two custom-title records. After detection, it expects the returned migration title to be the final custom title, not the first message or the earlier title.

**Call relations**: This test builds records with `record` and `custom_title_record`, writes them with `write_session`, then calls `detect_recent_sessions` to verify that the summarizing path produces the preferred title.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 5 external calls (new, assert_eq!, custom_title_record, record, write_session).


##### `tests::detects_ai_title_over_first_user_message`  (lines 179–203)

```
fn detects_ai_title_over_first_user_message()
```

**Purpose**: Checks that a title generated by the source app’s AI can replace the first user message as the displayed session title. This helps imported sessions look like they did in the original app.

**Data flow**: It creates a session with a user message and an AI-title record. Detection should return one migration whose title is the AI-generated title.

**Call relations**: This test uses `record`, `ai_title_record`, and `write_session` to create the input file, then calls `detect_recent_sessions` and checks the result.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 5 external calls (new, assert_eq!, ai_title_record, record, write_session).


##### `tests::prefers_custom_title_over_later_ai_title`  (lines 206–231)

```
fn prefers_custom_title_over_later_ai_title()
```

**Purpose**: Checks that a user-provided custom title beats an AI-generated title, even if the AI title appears later in the file. This preserves the user’s explicit choice.

**Data flow**: It writes a session containing a user message, then a custom title, then an AI title. After detection, the expected migration keeps the custom title.

**Call relations**: This test creates its input with `record`, `custom_title_record`, `ai_title_record`, and `write_session`, then calls `detect_recent_sessions` to confirm the title priority rule.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 6 external calls (new, assert_eq!, ai_title_record, custom_title_record, record, write_session).


##### `tests::uses_file_modification_time_for_recency`  (lines 234–260)

```
fn uses_file_modification_time_for_recency()
```

**Purpose**: Checks that recency is based on the file’s modification time, not the timestamp inside the chat record. This lets recently changed old conversations still be considered for import.

**Data flow**: It writes a session whose message timestamp says it is from 2020, but the file itself is newly created. Detection should still return that session, using the message text as the title.

**Call relations**: This test creates an old-looking record with `record_at`, writes it with `write_session`, then calls `detect_recent_sessions` to verify the file-time rule.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 4 external calls (new, assert_eq!, record_at, write_session).


##### `tests::ignores_sessions_with_old_file_modification_time`  (lines 263–283)

```
fn ignores_sessions_with_old_file_modification_time()
```

**Purpose**: Checks that very old session files are ignored. This prevents the import screen from being cluttered with stale history.

**Data flow**: It writes a session file, manually changes the file’s modified time to near the Unix epoch, then runs detection. The expected result is an empty list.

**Call relations**: This test uses `write_session` and `record` to create a candidate, then `set_modified_at` to make it look old before exercising the detection behavior.

*Call graph*: 6 external calls (from_secs, new, assert!, record, set_modified_at, write_session).


##### `tests::detects_sessions_in_batches`  (lines 286–361)

```
fn detects_sessions_in_batches()
```

**Purpose**: Checks that detection only returns the newest batch when there are more than 50 sessions, and that older or changed sessions can appear in later passes. This protects performance while still allowing all sessions to be imported over time.

**Data flow**: It creates 51 session files with staggered modification times. The first detection returns the newest 50. After those are recorded as imported, the next detection returns the remaining oldest one. Then all files are changed and given new modification times, and the same batch behavior is checked again.

**Call relations**: This test repeatedly calls `detect_recent_sessions` and uses `record_imported_session` to simulate Codex marking sessions as imported. It relies on `write_session`, `record_at`, `record`, `jsonl`, and timestamp helpers to build and update the file set.

*Call graph*: calls 3 internal fn (detect_recent_sessions, record_imported_session, new); 13 external calls (from_secs, now, new, new, assert_eq!, now, jsonl, record, record_at, set_modified_at (+3 more)).


##### `tests::skips_already_imported_current_session_versions`  (lines 364–383)

```
fn skips_already_imported_current_session_versions()
```

**Purpose**: Checks that a session already imported in its current form is not offered again. This avoids duplicate imports.

**Data flow**: It writes a session, records that session as imported in the ledger, then runs detection. Because the source has not changed since import, the expected result is empty.

**Call relations**: This test uses `write_session` and `record` to create the source file, then calls `record_imported_session` so the ledger knows about it before the detection behavior is checked.

*Call graph*: calls 2 internal fn (record_imported_session, new); 4 external calls (new, assert!, record, write_session).


##### `tests::redetects_sessions_when_source_contents_change_after_import`  (lines 386–417)

```
fn redetects_sessions_when_source_contents_change_after_import()
```

**Purpose**: Checks that an imported session is offered again if the source file changes later. This lets Codex pick up new messages added after the first import.

**Data flow**: It writes and imports a session, then overwrites the same file with an extra assistant reply. Detection should return that session again because its current contents no longer match what was imported.

**Call relations**: This test combines `write_session`, `record_imported_session`, `jsonl`, and `record` to set up an imported-then-updated file, then calls `detect_recent_sessions` to confirm changed sources are rediscovered.

*Call graph*: calls 3 internal fn (detect_recent_sessions, record_imported_session, new); 6 external calls (new, assert_eq!, jsonl, record, write_session, write).


##### `tests::write_session`  (lines 419–431)

```
fn write_session(
        external_agent_home: &Path,
        project_root: &Path,
        file_name: &str,
        records: &[JsonValue],
    ) -> std::path::PathBuf
```

**Purpose**: Creates a fake external-agent session file for tests. It hides the folder setup and JSONL writing so each test can focus on the behavior being checked.

**Data flow**: It receives an external home folder, a project folder, a file name, and JSON records. It creates the needed project directories, writes the records as JSONL into the external session path, and returns the path to the new session file.

**Call relations**: Most tests call this helper before running `detect_recent_sessions`. It uses `jsonl` to turn test records into the line-based file format expected by the real scanner.

*Call graph*: 4 external calls (join, jsonl, create_dir_all, write).


##### `tests::set_modified_at`  (lines 433–440)

```
fn set_modified_at(path: &Path, modified_at: SystemTime)
```

**Purpose**: Changes a test file’s modification time. Tests use it to make files appear newer or older without waiting in real time.

**Data flow**: It receives a file path and a desired `SystemTime`. It opens the file for writing and sets its modified timestamp to that value; it does not return a value unless something goes wrong and the test panics.

**Call relations**: The old-file and batching tests call this helper to control which sessions `detect_recent_sessions` treats as recent or newest.

*Call graph*: 2 external calls (new, new).


##### `tests::record`  (lines 442–445)

```
fn record(role: &str, text: &str, cwd: &Path) -> JsonValue
```

**Purpose**: Builds a normal chat message record for tests using the current time. It is a convenient shortcut for creating realistic user or assistant messages.

**Data flow**: It receives a role such as `user` or `assistant`, message text, and a working directory path. It creates a current timestamp and passes everything to `record_at`, returning a JSON object.

**Call relations**: Many tests use this helper when they do not need a special timestamp. It delegates the actual JSON shape to `record_at`.

*Call graph*: 2 external calls (now, record_at).


##### `tests::record_at`  (lines 447–454)

```
fn record_at(role: &str, text: &str, cwd: &Path, timestamp: &str) -> JsonValue
```

**Purpose**: Builds a normal chat message record for tests with an explicit timestamp. This is useful when a test needs to separate the message’s internal time from the file’s modification time.

**Data flow**: It receives a role, message text, working directory path, and timestamp string. It returns a JSON object with the fields the summarizer expects: type, cwd, timestamp, and message content.

**Call relations**: Tests call this directly when they need fixed timestamps, and `record` calls it after generating the current timestamp.

*Call graph*: 1 external calls (json!).


##### `tests::custom_title_record`  (lines 456–461)

```
fn custom_title_record(title: &str) -> JsonValue
```

**Purpose**: Builds a test record representing a user-customized session title. It lets tests check that manual titles are respected.

**Data flow**: It receives a title string and returns a JSON object whose type marks it as a custom title and whose `customTitle` field carries the text.

**Call relations**: Title-priority tests call this helper before running `detect_recent_sessions`, so the detection and summary path sees the same kind of title record the external app would write.

*Call graph*: 1 external calls (json!).


##### `tests::ai_title_record`  (lines 463–468)

```
fn ai_title_record(title: &str) -> JsonValue
```

**Purpose**: Builds a test record representing an AI-generated session title. It lets tests check how generated titles compare with user messages and custom titles.

**Data flow**: It receives a title string and returns a JSON object whose type marks it as an AI title and whose `aiTitle` field carries the text.

**Call relations**: The AI-title tests call this helper to place generated title records into fake session files before running `detect_recent_sessions`.

*Call graph*: 1 external calls (json!).


##### `tests::jsonl`  (lines 470–476)

```
fn jsonl(records: &[JsonValue]) -> String
```

**Purpose**: Turns a list of JSON records into JSONL text for test files. JSONL means each JSON object is written on its own line.

**Data flow**: It receives a slice of JSON values, converts each value to a compact JSON string, joins those strings with newline characters, and returns the finished file contents.

**Call relations**: `write_session` calls this when creating session files, and update-focused tests call it when overwriting a session with new records.

*Call graph*: 1 external calls (iter).


### Server-side thread coordination
These files manage loaded-thread runtime state on the app and exec servers, including listener orchestration, filtering, refresh, and session attachment lifecycles.

### `app-server/src/filters.rs`

`domain_logic` · `request handling`

This file is a small but important translation layer between the app server’s public idea of “thread source kinds” and the core protocol’s internal “session source” values. In plain terms, it answers: “If the user only wants threads from these places, what should we ask the core system for, and do we need to double-check the results afterward?”

Some filters are simple. For example, CLI and VS Code map directly to core session sources, so the system can ask for just those sources up front. Other filters are more detailed than the first-pass source list can express. Sub-agents are the clearest example: the core source may say “SubAgent,” but the app server may need only review sub-agents, compacting sub-agents, spawned-thread sub-agents, or other sub-agent types. That is like asking a librarian first for the “science” shelf, then checking each book to find only the biology ones.

The main function, `compute_source_filters`, chooses between these two strategies. It returns an initial list of allowed core sources plus, when needed, the original filter for later checking. The second function, `source_kind_matches`, performs that later exact check against one session source. The tests document the expected behavior for defaults, empty filters, simple interactive filters, and detailed sub-agent matching.

#### Function details

##### `compute_source_filters`  (lines 6–51)

```
fn compute_source_filters(
    source_kinds: Option<Vec<ThreadSourceKind>>,
) -> (Vec<CoreSessionSource>, Option<Vec<ThreadSourceKind>>)
```

**Purpose**: This function turns a caller’s requested thread source kinds into the best first-pass filter the core system can understand. It also decides whether the app server must do a second, more exact filtering pass afterward.

**Data flow**: It receives an optional list of `ThreadSourceKind` values from the app server API. If there is no list, or the list is empty, it returns the default interactive sources, meaning normal user-facing sessions such as CLI and VS Code, and says no later filter is needed. If the list includes source kinds that cannot be fully expressed as simple core session sources, such as sub-agent variants or unknown sources, it returns an empty first-pass source list and keeps the original list for later checking. If the list only contains directly mappable interactive sources, it converts CLI and VS Code into their core equivalents and returns those along with the original list.

**Call relations**: The test functions call this function to confirm its main decisions: default behavior, empty-list behavior, simple interactive filtering, and sub-agent filtering. Inside the function, `Vec::new` is used when no useful first-pass core source list can be built, because exact filtering must happen later.

*Call graph*: called by 4 (compute_source_filters_defaults_to_interactive_sources, compute_source_filters_empty_means_interactive_sources, compute_source_filters_interactive_only_skips_post_filtering, compute_source_filters_subagent_variant_requires_post_filtering); 1 external calls (new).


##### `source_kind_matches`  (lines 53–82)

```
fn source_kind_matches(source: &CoreSessionSource, filter: &[ThreadSourceKind]) -> bool
```

**Purpose**: This function checks whether one concrete core session source matches any of the requested app-server thread source kinds. It is used for the careful second-pass filtering needed when broad source categories are not detailed enough.

**Data flow**: It receives a single core session source and a slice of requested `ThreadSourceKind` filters. It walks through the requested filters and compares each one to the source. Simple cases compare direct categories, such as CLI to CLI. More detailed cases look inside sub-agent sources to distinguish review, compact, thread-spawn, and other sub-agent variants. It returns `true` as soon as one filter matches, or `false` if none do.

**Call relations**: This function fits after `compute_source_filters` when the original filter must be kept for precise checking. It uses iteration over the filter list to ask, one by one, whether any requested kind describes the source being examined. The sub-agent variant test exercises this exact role by proving that review and thread-spawn sub-agents are not confused with each other.

*Call graph*: 1 external calls (iter).


##### `tests::compute_source_filters_defaults_to_interactive_sources`  (lines 92–97)

```
fn compute_source_filters_defaults_to_interactive_sources()
```

**Purpose**: This test verifies that leaving the source filter unspecified means “show the normal interactive sessions.” It protects the default behavior callers get when they do not ask for anything special.

**Data flow**: It passes `None` into `compute_source_filters`. The function returns the default interactive core sources and no extra post-filter. The test compares both returned values with the expected results.

**Call relations**: This test calls `compute_source_filters` directly and uses equality assertions to pin down the default path. If someone changed the default to include non-interactive sources, this test would catch it.

*Call graph*: calls 1 internal fn (compute_source_filters); 1 external calls (assert_eq!).


##### `tests::compute_source_filters_empty_means_interactive_sources`  (lines 100–105)

```
fn compute_source_filters_empty_means_interactive_sources()
```

**Purpose**: This test verifies that an explicitly empty source-kind list is treated the same as no filter at all. That keeps callers from accidentally getting no threads just because they sent an empty array.

**Data flow**: It creates an empty vector and passes it as `Some(Vec::new())` to `compute_source_filters`. The result should be the default interactive core sources and no later filter. The test checks those outputs with equality assertions.

**Call relations**: This test calls `compute_source_filters` on the empty-list branch. It complements the `None` test by confirming that two common “no specific filter” inputs behave the same way.

*Call graph*: calls 1 internal fn (compute_source_filters); 2 external calls (new, assert_eq!).


##### `tests::compute_source_filters_interactive_only_skips_post_filtering`  (lines 108–117)

```
fn compute_source_filters_interactive_only_skips_post_filtering()
```

**Purpose**: This test verifies that when the caller asks only for CLI and VS Code threads, the app server can use a simple first-pass filter and does not need detailed source inspection.

**Data flow**: It builds a list containing `ThreadSourceKind::Cli` and `ThreadSourceKind::VsCode`, then passes that list to `compute_source_filters`. The function converts those values into the core session sources `Cli` and `VSCode`, and also returns the original filter list. The test confirms both pieces match expectations.

**Call relations**: This test calls `compute_source_filters` for the straightforward mapping path. It shows the happy case where the requested filters can be expressed directly to the core layer, avoiding extra post-filter work.

*Call graph*: calls 1 internal fn (compute_source_filters); 2 external calls (assert_eq!, vec!).


##### `tests::compute_source_filters_subagent_variant_requires_post_filtering`  (lines 120–126)

```
fn compute_source_filters_subagent_variant_requires_post_filtering()
```

**Purpose**: This test verifies that a detailed sub-agent request cannot be reduced to a simple core source filter. It protects the rule that sub-agent variants must be checked more carefully after the first fetch.

**Data flow**: It builds a list containing `ThreadSourceKind::SubAgentReview` and passes it to `compute_source_filters`. The function returns an empty first-pass core source list and preserves the original requested filter. The test checks that this is exactly what happens.

**Call relations**: This test calls `compute_source_filters` on the branch where exact matching is required later. It documents why detailed categories like review sub-agents need post-filtering rather than a simple source conversion.

*Call graph*: calls 1 internal fn (compute_source_filters); 2 external calls (assert_eq!, vec!).


##### `tests::source_kind_matches_distinguishes_subagent_variants`  (lines 129–157)

```
fn source_kind_matches_distinguishes_subagent_variants()
```

**Purpose**: This test verifies that the exact matcher can tell different sub-agent kinds apart. That matters because a caller asking for review sub-agent threads should not accidentally receive thread-spawn sub-agent threads, or the other way around.

**Data flow**: It creates a valid parent thread ID using a random UUID string, then builds two core sources: one review sub-agent and one thread-spawn sub-agent. It checks that the review source matches only the review filter and not the thread-spawn filter. Then it checks that the thread-spawn source matches only the thread-spawn filter and not the review filter.

**Call relations**: This test exercises `source_kind_matches` through assertions, focusing on the detailed sub-agent matching that `compute_source_filters` cannot safely do as a simple first-pass source filter. It uses helper constructors from external crates to create realistic thread and sub-agent values for the check.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (SubAgent, new_v4, assert!).


### `app-server/src/thread_state.rs`

`orchestration` · `cross-cutting: connection setup, request handling, thread resume/listening, and shutdown`

A running app server can have many clients connected and many conversation threads active at the same time. This file is the registry that keeps those relationships straight. Think of it like a front desk logbook: it records which visitors are attached to which room, whether a room has anyone inside, and who should receive messages for that room.

The main per-thread record is `ThreadState`. It remembers things like pending interrupts, the current turn’s partial history, the last known thread settings, and the channel used to send ordered commands to the thread listener. A listener is the background task that watches one conversation and forwards updates to clients. The file is careful to cancel old listeners when a new one replaces them, so two background tasks do not talk for the same thread at once.

`ThreadStateManager` sits above that and tracks all live connections and all known threads. It can subscribe or unsubscribe a connection, remove a closed connection, remove a whole thread, and notify watchers when a thread goes from having no subscribers to having at least one. It also keeps a special synchronous map of listener command senders, so code that cannot wait asynchronously can still enqueue listener work.

Without this file, the server would lose track of who is watching each thread, could leak listeners after shutdown, or could send resume and goal updates in the wrong order.

#### Function details

##### `ThreadState::listener_matches`  (lines 92–97)

```
fn listener_matches(&self, conversation: &Arc<CodexThread>) -> bool
```

**Purpose**: Checks whether the currently recorded listener belongs to a specific conversation object. This prevents the server from accidentally treating an old or different listener as current.

**Data flow**: It receives a shared pointer to a conversation. It looks at the weak reference stored in the thread state, tries to turn it back into a live shared pointer, and compares whether both pointers refer to the exact same conversation. It returns true only when they are the same live object.

**Call relations**: This is used when listener-related code needs to decide whether the stored listener state still belongs to the conversation being worked on. It does not create or change anything; it is a safety check before other listener work proceeds.


##### `ThreadState::set_listener`  (lines 99–116)

```
fn set_listener(
        &mut self,
        cancel_tx: oneshot::Sender<()>,
        conversation: &Arc<CodexThread>,
        watch_registration: WatchRegistration,
        thread_settings_baseline: Th
```

**Purpose**: Installs a new background listener for a thread and prepares the command channel that other code will use to talk to it. If an older listener exists, it is asked to stop first.

**Data flow**: It receives a cancellation sender for the new listener, the conversation being listened to, a file-watch registration, and the baseline thread settings. It cancels any previous listener, increments a generation number, stores the new baseline settings, creates a fresh command channel, records a weak reference to the conversation, and stores the watch registration. It returns the receiving side of the command channel plus the new generation number.

**Call relations**: This is part of starting or replacing a thread listener. It hands the receiver side of the channel to the listener task, while keeping the sender side in `ThreadState` so later code can queue ordered commands for that listener.

*Call graph*: 2 external calls (downgrade, unbounded_channel).


##### `ThreadState::clear_listener`  (lines 118–126)

```
fn clear_listener(&mut self)
```

**Purpose**: Stops and forgets the current thread listener, and clears temporary turn-listening state. This is used when a thread is torn down or the server shuts down.

**Data flow**: It reads the stored cancellation sender, command channel, current turn history, listener reference, and file-watch registration. It sends a stop signal if possible, removes the command sender, resets the partial turn history, drops the listener reference, and replaces the watch registration with an empty default value. It returns nothing, but leaves the state with no active listener.

**Call relations**: This is called by broader cleanup flows such as removing a thread state or clearing all listeners. It is the per-thread cleanup step that those manager-level operations rely on.

*Call graph*: calls 2 internal fn (reset, default).


##### `ThreadState::set_experimental_raw_events`  (lines 128–130)

```
fn set_experimental_raw_events(&mut self, enabled: bool)
```

**Purpose**: Turns the experimental raw-event mode on or off for this thread. This flag controls whether lower-level event details should be exposed for clients that asked for them.

**Data flow**: It receives a boolean value. It writes that value into the thread state’s `experimental_raw_events` field. It returns nothing.

**Call relations**: This is used when a connection subscribes with the raw-events option enabled. The manager updates the thread state so later event forwarding can honor that client capability.


##### `ThreadState::listener_command_tx`  (lines 132–136)

```
fn listener_command_tx(
        &self,
    ) -> Option<mpsc::UnboundedSender<ThreadListenerCommand>>
```

**Purpose**: Returns a copy of the sender used to queue commands for the current thread listener, if one exists. This lets other parts of the server ask the listener to do ordered work.

**Data flow**: It reads the stored listener command sender. If there is one, it clones the sender handle and returns it; otherwise it returns nothing. The underlying channel is not changed.

**Call relations**: This is a small access point used before sending commands such as resolving server requests on the listener. It protects callers from directly reaching into the state fields.


##### `ThreadState::active_turn_snapshot`  (lines 138–140)

```
fn active_turn_snapshot(&self) -> Option<Turn>
```

**Purpose**: Produces a snapshot of the currently running turn, if the thread is in the middle of one. A turn is one user-assistant exchange or unit of conversation work.

**Data flow**: It asks the current turn history builder for its active-turn snapshot. If a turn is active, it returns a `Turn` summary; if not, it returns nothing. It does not change the state.

**Call relations**: Cleanup and status-reporting code uses this to know whether there is unfinished turn history when a listener is removed or inspected.

*Call graph*: calls 1 internal fn (active_turn_snapshot).


##### `ThreadState::track_current_turn_event`  (lines 142–153)

```
fn track_current_turn_event(&mut self, event_turn_id: &str, event: &EventMsg)
```

**Purpose**: Feeds a new event into the current-turn tracker so the server can build an up-to-date picture of the active turn. It also notices when a turn has ended and clears the temporary history.

**Data flow**: It receives the event’s turn id and the event message. If the event says a turn started, it records the start time in the turn summary. It passes the event into the turn history builder. If the event says the turn aborted or completed and there is no active turn left, it records the terminal turn id and resets the current turn history. It returns nothing, but updates the thread state.

**Call relations**: The thread listener calls this kind of logic while processing conversation events. It feeds the state that later resume, snapshot, and cleanup flows use to understand what is currently happening in the thread.

*Call graph*: calls 3 internal fn (handle_event, has_active_turn, reset); 1 external calls (matches!).


##### `ThreadState::note_thread_settings`  (lines 155–159)

```
fn note_thread_settings(&mut self, thread_settings: ThreadSettings) -> bool
```

**Purpose**: Records the latest thread settings and reports whether they actually changed. This avoids sending or acting on duplicate settings updates.

**Data flow**: It receives a `ThreadSettings` value. It compares it with the last stored settings, stores the new value, and returns true if the value was different or no previous value existed. It returns false when the same settings were already known.

**Call relations**: Listener or event code can call this when settings are observed. The return value tells that code whether it should treat the observation as a meaningful update.


##### `resolve_server_request_on_thread_listener`  (lines 162–192)

```
async fn resolve_server_request_on_thread_listener(
    thread_state: &Arc<Mutex<ThreadState>>,
    request_id: RequestId,
)
```

**Purpose**: Asks the thread listener to mark a server request as resolved, and waits until that ordered action is complete. This keeps the “request resolved” notification in the same sequence as the listener’s other messages.

**Data flow**: It receives shared thread state and a request id. It creates a one-time completion channel, locks the thread state to get the listener command sender, and sends a `ResolveServerRequest` command containing the request id and completion sender. Then it waits for the listener to signal completion. If there is no listener, the channel is closed, or completion fails, it logs an error.

**Call relations**: Response handlers for approval, permission, elicitation, and user-input requests call this after the client replies. Rather than removing pending request state directly, they hand the work to the listener so the final notification is ordered correctly.

*Call graph*: called by 5 (on_command_execution_request_approval_response, on_file_change_request_approval_response, on_mcp_server_elicitation_response, on_request_permissions_response, on_request_user_input_response); 2 external calls (error!, channel).


##### `tests::note_thread_settings_reports_only_effective_changes`  (lines 206–219)

```
fn note_thread_settings_reports_only_effective_changes()
```

**Purpose**: Tests that `note_thread_settings` reports true only when the settings value changes. This protects the behavior that duplicate settings should not look like new updates.

**Data flow**: It creates a default `ThreadState`, builds two settings values with different model names, and calls `note_thread_settings` four times: first value, same value again, second value, same second value again. It checks that the results are true, false, true, false.

**Call relations**: This test supports the `ThreadState::note_thread_settings` behavior. It uses the local `tests::thread_settings` helper to make complete settings objects without distracting the test with setup details.

*Call graph*: 4 external calls (default, thread_settings, assert_eq!, vec!).


##### `tests::thread_settings`  (lines 221–245)

```
fn thread_settings(model: &str) -> ThreadSettings
```

**Purpose**: Builds a complete `ThreadSettings` value for tests, using the supplied model name. It keeps the test focused on change detection rather than all the fields needed to construct settings.

**Data flow**: It receives a model name string. It fills in a settings object with a fixed working directory, approval behavior, sandbox policy, provider, collaboration mode, and other defaults, while placing the given model name in the model-related fields. It returns that settings object.

**Call relations**: The settings-change test calls this helper to create two comparable settings values. The only intended difference between those values is the model name.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `ThreadEntry::default`  (lines 255–261)

```
fn default() -> Self
```

**Purpose**: Creates an empty record for a thread in the manager. The record starts with fresh thread state, no connected clients, and a watcher that says the thread has no connections.

**Data flow**: It creates a shared, lock-protected default `ThreadState`, an empty set of connection ids, and a watch channel initialized to false. It returns a new `ThreadEntry` containing those pieces.

**Call relations**: The manager uses this whenever a thread id is first seen. It gives all later subscription, listener, and watcher code a consistent starting point.

*Call graph*: 5 external calls (new, new, new, default, channel).


##### `ThreadEntry::update_has_connections`  (lines 265–271)

```
fn update_has_connections(&self)
```

**Purpose**: Updates the boolean watcher that says whether this thread currently has any subscribed connections. Watchers can use this to react when the first client arrives or the last client leaves.

**Data flow**: It looks at the thread entry’s connection-id set. It writes true into the watch channel if the set is not empty, or false if it is empty. It only notifies watchers when the value actually changes.

**Call relations**: Subscription and unsubscription methods call this after changing the connection set. It is the bridge between internal bookkeeping and outside code waiting for subscriber changes.

*Call graph*: 1 external calls (send_if_modified).


##### `ThreadStateManager::new`  (lines 296–298)

```
fn new() -> Self
```

**Purpose**: Creates a new, empty thread state manager. This is the starting point for tracking live connections, threads, and listener command channels.

**Data flow**: It constructs the default manager state: no live connections, no thread entries, no connection-to-thread mappings, and no listener command senders. It returns the ready-to-use manager.

**Call relations**: Server setup and tests call this before using the manager. After creation, other methods add connections, attach them to threads, and start listener tracking.

*Call graph*: called by 7 (app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears, new, adding_connection_to_thread_updates_has_connections_watcher, closed_connection_cannot_be_reintroduced_by_auto_subscribe, first_attestation_capable_connection_for_thread_only_uses_thread_subscribers, removing_auto_attached_connection_preserves_listener_for_other_connections, removing_thread_state_clears_listener_and_active_turn_history); 1 external calls (default).


##### `ThreadStateManager::connection_initialized`  (lines 300–310)

```
async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        capabilities: ConnectionCapabilities,
    )
```

**Purpose**: Records that a client connection is now live and stores what that connection can do. A connection must be known here before it can be subscribed to threads.

**Data flow**: It receives a connection id and its capabilities. It locks the manager state and inserts the connection into the live-connections map. It returns nothing.

**Call relations**: Connection setup code calls this when a client connection becomes ready. Later subscription methods check this live-connections map to reject stale or unknown connections.

*Call graph*: called by 1 (connection_initialized).


##### `ThreadStateManager::first_attestation_capable_connection_for_thread`  (lines 312–330)

```
async fn first_attestation_capable_connection_for_thread(
        &self,
        thread_id: ThreadId,
    ) -> Option<ConnectionId>
```

**Purpose**: Finds the first subscribed connection for a thread that can answer an attestation request. Attestation means the client can provide some trusted proof or header value when asked.

**Data flow**: It receives a thread id. It looks up that thread’s subscribed connection ids, checks each connection’s recorded capabilities, keeps only those with `request_attestation` enabled, and returns the one with the smallest connection id. If the thread is missing or none qualify, it returns nothing.

**Call relations**: Code that needs an attestation header asks the manager this question. The manager uses both sides of its registry: thread subscriptions and live connection capabilities.

*Call graph*: called by 1 (request_attestation_header_value_with_timeout).


##### `ThreadStateManager::subscribed_connection_ids`  (lines 332–339)

```
async fn subscribed_connection_ids(&self, thread_id: ThreadId) -> Vec<ConnectionId>
```

**Purpose**: Returns the list of client connections currently subscribed to a thread. This is used when the server needs to send thread-related output to the right clients.

**Data flow**: It receives a thread id. It looks up the thread entry, copies its connection ids into a vector, and returns that list. If the thread does not exist, it returns an empty list.

**Call relations**: Flows such as resolving pending server requests and resuming a running thread use this to know which connections are currently attached to the thread.

*Call graph*: called by 2 (resolve_pending_server_request, resume_running_thread).


##### `ThreadStateManager::thread_state`  (lines 341–344)

```
async fn thread_state(&self, thread_id: ThreadId) -> Arc<Mutex<ThreadState>>
```

**Purpose**: Gets the shared state object for a thread, creating it if needed. This gives other parts of the server a stable place to read or update per-thread live state.

**Data flow**: It receives a thread id. It locks the manager, finds or creates the `ThreadEntry` for that id, clones the shared pointer to its `ThreadState`, and returns it. The manager keeps ownership of the entry.

**Call relations**: Many thread operations call this before doing detailed work: goal updates, resume, rollback, listing turns, attaching listeners, and interrupts. It is the common doorway into per-thread state.

*Call graph*: called by 8 (emit_thread_goal_snapshot, thread_goal_clear_inner, thread_goal_set_inner, resume_running_thread, thread_rollback_start, thread_turns_list_response_inner, try_attach_thread_listener, turn_interrupt_inner).


##### `ThreadStateManager::current_listener_command_tx`  (lines 346–355)

```
fn current_listener_command_tx(
        &self,
        thread_id: ThreadId,
    ) -> Option<mpsc::UnboundedSender<ThreadListenerCommand>>
```

**Purpose**: Returns the current listener command sender for a thread from a synchronous map. This is useful for code that needs to enqueue listener work without using an asynchronous lock.

**Data flow**: It receives a thread id. It locks the standard, non-async mutex around the listener-command map, looks up the sender, clones it if present, and returns it. If no sender is registered, it returns nothing.

**Call relations**: Event-sink code uses this when it needs to emit ordered listener commands from a context that cannot wait on async locks. Listener registration and unregistration keep this map current.

*Call graph*: called by 1 (emit).


##### `ThreadStateManager::register_listener_command_tx`  (lines 357–366)

```
fn register_listener_command_tx(
        &self,
        thread_id: ThreadId,
        tx: mpsc::UnboundedSender<ThreadListenerCommand>,
    )
```

**Purpose**: Registers the command sender for a thread’s active listener. This makes the listener reachable by synchronous event-producing code.

**Data flow**: It receives a thread id and a command sender. It locks the listener-command map and stores the sender under that thread id, replacing any previous sender. It returns nothing.

**Call relations**: When a listener starts, setup code can call this so later extension or event-sink code can enqueue commands to that listener. The matching unregister function removes it during cleanup.


##### `ThreadStateManager::unregister_listener_command_tx`  (lines 368–373)

```
fn unregister_listener_command_tx(&self, thread_id: ThreadId)
```

**Purpose**: Removes the registered listener command sender for a thread. This prevents later code from sending commands to a listener that is gone or being torn down.

**Data flow**: It receives a thread id. It locks the listener-command map and removes that thread’s sender if present. It returns nothing.

**Call relations**: Thread removal and full listener shutdown call this before or during cleanup. It is the manager-level counterpart to clearing the listener inside `ThreadState`.

*Call graph*: called by 2 (clear_all_listeners, remove_thread_state).


##### `ThreadStateManager::remove_thread_state`  (lines 375–401)

```
async fn remove_thread_state(&self, thread_id: ThreadId)
```

**Purpose**: Deletes all manager bookkeeping for one thread and stops its listener if it had one. This is used when a thread is unloaded or finally torn down.

**Data flow**: It receives a thread id. It removes the thread entry from the thread map, removes that thread id from every connection-to-thread set, unregisters the listener command sender, then locks the removed thread state if it existed. It logs useful cleanup details and calls `clear_listener` to cancel the listener and reset active turn history. It returns nothing.

**Call relations**: Thread unload and final teardown flows call this when a thread should no longer be tracked. It combines global registry cleanup with per-thread listener cleanup.

*Call graph*: calls 1 internal fn (unregister_listener_command_tx); called by 2 (unload_thread_without_subscribers, finalize_thread_teardown); 1 external calls (debug!).


##### `ThreadStateManager::clear_all_listeners`  (lines 403–425)

```
async fn clear_all_listeners(&self)
```

**Purpose**: Stops every active thread listener without removing the thread entries themselves. This is useful during app-server shutdown.

**Data flow**: It first collects all thread ids and their shared thread states while holding the manager lock, then releases that lock. For each thread, it unregisters the listener command sender, locks the thread state, logs what is being cleared, and calls `clear_listener`. It returns nothing.

**Call relations**: Server shutdown code calls this to quiet all background listener tasks. It uses `unregister_listener_command_tx` and each thread state’s own cleanup method to do the job safely.

*Call graph*: calls 1 internal fn (unregister_listener_command_tx); called by 1 (clear_all_thread_listeners); 1 external calls (debug!).


##### `ThreadStateManager::unsubscribe_connection_from_thread`  (lines 427–459)

```
async fn unsubscribe_connection_from_thread(
        &self,
        thread_id: ThreadId,
        connection_id: ConnectionId,
    ) -> bool
```

**Purpose**: Removes one connection’s subscription to one thread. It returns whether a real subscription was found and removed.

**Data flow**: It receives a thread id and connection id. It checks that the thread exists and that the connection is recorded as subscribed to it. If either check fails, it returns false. Otherwise it removes the thread from the connection’s thread set, removes the connection from the thread’s connection set, updates the has-connections watcher, and returns true.

**Call relations**: Thread unsubscribe request handling calls this when a client asks to stop following a thread. The watcher update lets other parts of the system notice if the thread now has no subscribers.

*Call graph*: called by 1 (thread_unsubscribe_response_inner).


##### `ThreadStateManager::has_subscribers`  (lines 462–469)

```
async fn has_subscribers(&self, thread_id: ThreadId) -> bool
```

**Purpose**: Test-only helper that reports whether a thread currently has any subscribed connections. It makes subscription behavior easy to assert in tests.

**Data flow**: It receives a thread id, locks the manager state, and checks whether that thread exists with a non-empty connection set. It returns true or false.

**Call relations**: Because it is available only in tests, this function supports verification of the manager’s bookkeeping rather than normal server behavior.


##### `ThreadStateManager::try_ensure_connection_subscribed`  (lines 471–499)

```
async fn try_ensure_connection_subscribed(
        &self,
        thread_id: ThreadId,
        connection_id: ConnectionId,
        experimental_raw_events: bool,
    ) -> Option<Arc<Mutex<ThreadState
```

**Purpose**: Subscribes a live connection to a thread, creating the thread entry if necessary, and returns the thread state. If the connection is no longer live, it refuses to subscribe it.

**Data flow**: It receives a thread id, connection id, and a flag for experimental raw events. It checks whether the connection is in the live-connections map. If not, it returns nothing. If yes, it records the thread under that connection, records the connection under that thread, updates the has-connections watcher, and clones the thread state. If raw events were requested, it turns that flag on in the thread state. It returns the shared thread state.

**Call relations**: This is the safe auto-subscribe path used when request handling needs to make sure a connection is attached before working with a thread. It protects against closed connections being reintroduced.


##### `ThreadStateManager::try_add_connection_to_thread`  (lines 501–519)

```
async fn try_add_connection_to_thread(
        &self,
        thread_id: ThreadId,
        connection_id: ConnectionId,
    ) -> bool
```

**Purpose**: Adds an already live connection to a thread and reports whether it succeeded. Unlike the richer subscribe method, it only returns a success flag.

**Data flow**: It receives a thread id and connection id. It checks that the connection is live. If not, it returns false. Otherwise it updates both maps, adds the connection to the thread entry, updates the has-connections watcher, and returns true.

**Call relations**: The pending thread-resume flow calls this when it needs to attach a connection to a thread. It shares the same core bookkeeping pattern as the main subscribe path.

*Call graph*: called by 1 (handle_pending_thread_resume_request).


##### `ThreadStateManager::remove_connection`  (lines 521–545)

```
async fn remove_connection(&self, connection_id: ConnectionId) -> Vec<ThreadId>
```

**Purpose**: Removes a closed connection from the manager and from every thread it was subscribed to. It returns the threads that are left with no subscribers afterward.

**Data flow**: It receives a connection id. It removes the connection from the live-connections map and removes its set of subscribed thread ids. For each affected thread, it removes the connection from that thread’s connection set and updates the has-connections watcher. Then it returns only the affected thread ids whose connection sets are now empty.

**Call relations**: Connection-close handling calls this when a client disconnects. The returned thread ids tell higher-level code which threads may now be candidates for unloading or listener cleanup.

*Call graph*: called by 1 (connection_closed).


##### `ThreadStateManager::subscribe_to_has_connections`  (lines 547–556)

```
async fn subscribe_to_has_connections(
        &self,
        thread_id: ThreadId,
    ) -> Option<watch::Receiver<bool>>
```

**Purpose**: Creates a watcher for whether a thread has any subscribed connections. This lets other code wait for subscriber changes without repeatedly polling the manager.

**Data flow**: It receives a thread id. It looks up the thread entry and, if it exists, returns a new receiver subscribed to that thread’s boolean watch channel. If the thread does not exist, it returns nothing.

**Call relations**: Code that cares about a thread becoming watched or unwatched can call this after the thread exists. `ThreadEntry::update_has_connections` sends the updates that this receiver observes.


### `app-server/src/request_processors/thread_lifecycle.rs`

`orchestration` · `request handling and background thread cleanup`

A conversation thread can keep running after a client opens it, leaves it, resumes it, or reconnects later. This file makes that lifecycle predictable. It starts one listener task for each loaded thread. That task watches three things at once: commands from the app server, new events from the conversation, and whether the thread has become idle with no connected clients. Think of it like a concierge assigned to one meeting room: it forwards messages to attendees, accepts special instructions, and eventually closes the room after everyone has left and the meeting is quiet.

The file also protects against awkward races. For example, a client should not attach to a thread at the same moment the server is unloading it, so the code keeps a shared “pending unloads” set protected by a mutex, which is a lock that stops two tasks changing the same data at once. When a client resumes a running thread, this file rebuilds the response from saved history plus any live in-progress turn, sends current settings, replays pending server requests, and optionally sends the current thread goal.

If this file were missing, clients could miss live events, attach to closing threads, see stale turn status, or leave idle threads loaded forever.

#### Function details

##### `UnloadingState::new`  (lines 27–52)

```
async fn new(
        listener_task_context: &ListenerTaskContext,
        thread_id: ThreadId,
        delay: Duration,
    ) -> Option<Self>
```

**Purpose**: Creates the small watcher object that decides when a thread is safe to unload. It subscribes to two live signals: whether any clients are connected and whether the thread is active.

**Data flow**: It receives the shared listener context, a thread id, and an unload delay. It asks the thread state manager for the current connection signal and the thread watch manager for the current status signal, records their current values with the current time, and returns an unloading state. If either signal cannot be subscribed to, it returns nothing, which means the thread is already going away or unavailable.

**Call relations**: When a listener task is being started, ensure_listener_task_running calls this first. The listener uses the returned state later to know when to shut the thread down after it has been both idle and without subscribers long enough.

*Call graph*: called by 1 (ensure_listener_task_running); 2 external calls (now, matches!).


##### `UnloadingState::unloading_target`  (lines 54–61)

```
fn unloading_target(&self) -> Option<Instant>
```

**Purpose**: Calculates the earliest time when the thread may be unloaded. It only gives a time if the thread has no subscribers and is not active.

**Data flow**: It reads the stored connection state and activity state. If both say “false,” it takes the later of the two times when those states began and adds the configured delay. If either clients are still connected or the thread is active, it returns no unload time.

**Call relations**: The unload checks call this as their calendar calculation. should_unload_now uses it for an immediate yes-or-no answer, and wait_for_unloading_trigger uses it to decide how long to sleep.

*Call graph*: called by 2 (should_unload_now, wait_for_unloading_trigger); 1 external calls (max).


##### `UnloadingState::sync_receiver_values`  (lines 63–73)

```
fn sync_receiver_values(&mut self)
```

**Purpose**: Refreshes the cached unloading signals from their live subscriptions. It also remembers the time when either signal changes.

**Data flow**: It reads the latest “has subscribers” value and latest thread status from the watch receivers. If either value differs from what was stored before, it updates the stored value and stamps it with the current time. It does not return anything; it updates the unloading state in place.

**Call relations**: The unload decision paths call this before trusting their cached values. It supports should_unload_now and wait_for_unloading_trigger so their decisions are based on current subscription and activity information.

*Call graph*: called by 2 (should_unload_now, wait_for_unloading_trigger); 3 external calls (now, borrow, matches!).


##### `UnloadingState::should_unload_now`  (lines 75–79)

```
fn should_unload_now(&mut self) -> bool
```

**Purpose**: Answers the direct question: is the thread ready to unload right now?

**Data flow**: It first refreshes the cached signals. Then it calculates the unload target time. If there is a target and that time has already arrived, it returns true; otherwise it returns false.

**Call relations**: The listener task uses this after an unload wake-up and again while holding the pending-unloads lock, so it does not start unloading based on stale information.

*Call graph*: calls 2 internal fn (sync_receiver_values, unloading_target).


##### `UnloadingState::note_thread_activity_observed`  (lines 81–85)

```
fn note_thread_activity_observed(&mut self)
```

**Purpose**: Resets the idle timer when the listener notices that the thread is still effectively doing work. This avoids unloading a thread that looked idle by status but is actually running.

**Data flow**: It reads the stored activity flag. If the state currently says inactive, it keeps it inactive but moves the “inactive since” time to now, delaying any future unload.

**Call relations**: The listener task calls this when the unload timer fires but the conversation reports that its agent is still running. That hands the thread more time instead of shutting it down too early.

*Call graph*: 1 external calls (now).


##### `UnloadingState::wait_for_unloading_trigger`  (lines 87–119)

```
async fn wait_for_unloading_trigger(&mut self) -> bool
```

**Purpose**: Waits until something relevant happens: the unload delay expires, the subscriber state changes, or the activity state changes. It returns whether unloading should be considered or whether the watchers closed.

**Data flow**: It repeatedly refreshes current values, computes a possible unload time, then waits. If the target time arrives, it returns true. If either watched signal changes, it refreshes and loops. If a watched signal closes, it returns false because the listener can no longer make a reliable unload decision.

**Call relations**: The main listener task waits on this alongside incoming thread events and listener commands. It is the background timer and alarm system for idle-thread cleanup.

*Call graph*: calls 2 internal fn (sync_receiver_values, unloading_target); 3 external calls (now, select!, sleep_until).


##### `ensure_conversation_listener`  (lines 137–186)

```
async fn ensure_conversation_listener(
    listener_task_context: ListenerTaskContext,
    conversation_id: ThreadId,
    connection_id: ConnectionId,
    raw_events_enabled: bool,
) -> Result<EnsureC
```

**Purpose**: Attaches a client connection to a conversation thread and makes sure a listener task exists for that thread. This is what lets the client receive live updates for the conversation.

**Data flow**: It receives the listener context, thread id, connection id, and whether the client wants raw events. It looks up the thread, checks that the thread is not already closing, subscribes the connection, then asks ensure_listener_task_running to start or reuse the background listener. If the connection has closed, it reports that quietly; if listener startup fails, it unsubscribes the connection and returns an error.

**Call relations**: Request-processing code such as thread_start_task calls this when a client needs to observe a thread. It hands the actual listener setup to ensure_listener_task_running, while it owns the safety checks around connection subscription and pending unloads.

*Call graph*: calls 1 internal fn (ensure_listener_task_running); called by 3 (ensure_conversation_listener, thread_start_task, ensure_conversation_listener); 2 external calls (clone, format!).


##### `log_listener_attach_result`  (lines 188–210)

```
fn log_listener_attach_result(
    result: Result<EnsureConversationListenerResult, JSONRPCErrorError>,
    thread_id: ThreadId,
    connection_id: ConnectionId,
    thread_kind: &'static str,
)
```

**Purpose**: Writes an appropriate log message after trying to attach a listener. It keeps normal success silent and records only useful diagnostic cases.

**Data flow**: It receives the attach result, thread id, connection id, and a label for the kind of thread. If the connection was already closed, it writes a debug message. If attaching failed, it writes a warning with the error message. It returns nothing.

**Call relations**: Callers use this after ensure_conversation_listener so attach failures and closed-connection races are visible in logs without turning expected success into noise.

*Call graph*: 2 external calls (debug!, warn!).


##### `ensure_listener_task_running`  (lines 212–396)

```
async fn ensure_listener_task_running(
    listener_task_context: ListenerTaskContext,
    conversation_id: ThreadId,
    conversation: Arc<CodexThread>,
    thread_state: Arc<Mutex<ThreadState>>,
) -
```

**Purpose**: Starts the one background listener task for a loaded conversation, unless the right listener is already running. That task is responsible for forwarding thread events, receiving listener commands, and eventually unloading the thread when it is idle.

**Data flow**: It receives the listener context, thread id, thread object, and shared thread state. It creates a cancel channel, creates an UnloadingState, registers skill-watching configuration, and stores listener details in ThreadState. Then it spawns an asynchronous task. That task waits for cancellation, listener commands, conversation events, or an unload trigger. Events are translated and sent to subscribed clients; commands are dispatched; idle threads are shut down.

**Call relations**: ensure_conversation_listener calls this after a connection has subscribed. Inside the spawned task, it hands commands to handle_thread_listener_command, sends events through bespoke event handling, and calls unload_thread_without_subscribers when the unload rules say the thread can close.

*Call graph*: calls 1 internal fn (new); called by 2 (ensure_conversation_listener, ensure_listener_task_running); 6 external calls (clone, format!, channel, select!, spawn, warn!).


##### `wait_for_thread_shutdown`  (lines 398–404)

```
async fn wait_for_thread_shutdown(thread: &Arc<CodexThread>) -> ThreadShutdownResult
```

**Purpose**: Asks a thread to shut down and waits briefly for it to finish. It turns the possible outcomes into a small, clear result type.

**Data flow**: It receives a shared thread object. It calls the thread’s shutdown-and-wait operation with a ten-second timeout. If shutdown finishes cleanly, it returns Complete. If submitting shutdown fails, it returns SubmitFailed. If the timeout expires, it returns TimedOut.

**Call relations**: unload_thread_without_subscribers uses this during background teardown. This keeps the unload logic from waiting forever on a stuck thread.

*Call graph*: called by 1 (unload_thread_without_subscribers); 2 external calls (from_secs, timeout).


##### `unload_thread_without_subscribers`  (lines 406–456)

```
async fn unload_thread_without_subscribers(
    thread_manager: Arc<ThreadManager>,
    outgoing: Arc<OutgoingMessageSender>,
    pending_thread_unloads: Arc<Mutex<HashSet<ThreadId>>>,
    thread_stat
```

**Purpose**: Begins shutdown for a thread that has no connected clients and is idle. It removes visible state, cancels unanswered server-to-client requests, and finalizes removal if shutdown succeeds.

**Data flow**: It receives the managers, outgoing message sender, pending-unload set, thread id, and thread object. First it cancels pending requests for that thread and removes the thread’s state. Then it spawns a teardown task. If shutdown completes, it removes the thread from the thread manager, removes it from the watch manager, sends a ThreadClosed notification, and clears the pending-unload marker. If shutdown fails or times out, it clears the marker and logs a warning.

**Call relations**: The listener task calls this after UnloadingState says the thread has stayed idle and unsubscribed long enough. It relies on wait_for_thread_shutdown to avoid hanging, and it notifies clients through the outgoing message sender once removal is complete.

*Call graph*: calls 3 internal fn (wait_for_thread_shutdown, remove_thread_state, remove_thread); 5 external calls (ThreadClosed, info!, to_string, spawn, warn!).


##### `handle_thread_listener_command`  (lines 459–522)

```
async fn handle_thread_listener_command(
    conversation_id: ThreadId,
    conversation: &Arc<CodexThread>,
    codex_home: &Path,
    thread_state_manager: &ThreadStateManager,
    thread_state: &Ar
```

**Purpose**: Receives special commands sent to a thread listener and performs the matching action. These commands cover resume responses, thread goal notifications, and server-request resolution.

**Data flow**: It receives the thread identity, thread object, shared state, outgoing sender, pending-unload set, and one command. It matches the command type. Some commands become immediate notifications, one asks for a full running-thread resume response, one sends a goal snapshot, and one marks a server request as resolved before signaling completion.

**Call relations**: The spawned listener task calls this whenever its command channel receives a command. It delegates heavier work to handle_pending_thread_resume_request, send_thread_goal_snapshot_notification, and resolve_pending_server_request so the command loop stays simple.

*Call graph*: calls 3 internal fn (handle_pending_thread_resume_request, resolve_pending_server_request, send_thread_goal_snapshot_notification); 3 external calls (ThreadGoalCleared, ThreadGoalUpdated, to_string).


##### `handle_pending_thread_resume_request`  (lines 529–704)

```
async fn handle_pending_thread_resume_request(
    conversation_id: ThreadId,
    conversation: &Arc<CodexThread>,
    _codex_home: &Path,
    thread_state_manager: &ThreadStateManager,
    thread_sta
```

**Purpose**: Builds and sends the response for a client that resumes a thread which is already loaded and possibly still running. It makes the live thread look like a freshly resumed thread to the client.

**Data flow**: It receives the live conversation, shared thread state, managers, outgoing sender, unload marker set, and the pending resume request. It snapshots the active turn, decides whether a live turn is in progress, optionally rebuilds turn history, gets the current loaded status, and marks stale in-progress turns as interrupted when appropriate. It may build an initial page of turns and redact payloads if requested. Before replying, it checks that the thread is not closing and adds the connection to the thread. It then sends a ThreadResumeResponse with thread metadata, settings, workspace information, sandbox policy, and optional page data. After that it may send token usage, goal state, replay pending requests, and emit an idle lifecycle signal.

**Call relations**: handle_thread_listener_command calls this for resume commands. It uses populate_thread_turns_from_history and set_thread_status_and_interrupt_stale_turns to shape the thread data, asks thread_processor to build paged turn data, may call send_thread_goal_snapshot_notification, and finally sends responses through the outgoing message sender.

*Call graph*: calls 6 internal fn (populate_thread_turns_from_history, send_thread_goal_snapshot_notification, set_thread_status_and_interrupt_stale_turns, build_thread_resume_initial_turns_page, try_add_connection_to_thread, loaded_status_for_thread); called by 1 (handle_thread_listener_command); 4 external calls (format!, matches!, debug!, warn!).


##### `send_thread_goal_snapshot_notification`  (lines 706–739)

```
async fn send_thread_goal_snapshot_notification(
    outgoing: &Arc<OutgoingMessageSender>,
    thread_id: ThreadId,
    state_db: &StateDbHandle,
)
```

**Purpose**: Sends the current goal for a thread to clients, or tells them the goal is cleared. This keeps a reconnecting or resuming client in sync with the server’s stored goal state.

**Data flow**: It receives the outgoing sender, thread id, and state database handle. It reads the stored thread goal. If a goal exists, it sends a ThreadGoalUpdated notification. If no goal exists, it sends a ThreadGoalCleared notification. If the database read fails, it logs a warning and sends nothing.

**Call relations**: handle_thread_listener_command uses this for explicit goal snapshot commands. handle_pending_thread_resume_request also uses it when a resume response should be followed by the current thread-goal state.

*Call graph*: called by 2 (handle_pending_thread_resume_request, handle_thread_listener_command); 5 external calls (ThreadGoalCleared, ThreadGoalUpdated, thread_goals, to_string, warn!).


##### `populate_thread_turns_from_history`  (lines 741–751)

```
fn populate_thread_turns_from_history(
    thread: &mut Thread,
    items: &[RolloutItem],
    active_turn: Option<&Turn>,
)
```

**Purpose**: Fills a thread response with turn history built from saved rollout items, while preserving any live active turn. A turn is one user/agent exchange or work unit shown in the conversation.

**Data flow**: It receives a mutable thread response, saved history items, and optionally the current active turn. It converts the saved items into API turns. If there is an active turn, it merges that live turn into the list. It then writes the resulting turn list back into the thread.

**Call relations**: handle_pending_thread_resume_request calls this when the resume request asks to include turns. It delegates the live-turn merge to merge_turn_history_with_active_turn.

*Call graph*: calls 1 internal fn (merge_turn_history_with_active_turn); called by 1 (handle_pending_thread_resume_request).


##### `resolve_pending_server_request`  (lines 753–776)

```
async fn resolve_pending_server_request(
    conversation_id: ThreadId,
    thread_state_manager: &ThreadStateManager,
    outgoing: &Arc<OutgoingMessageSender>,
    request_id: RequestId,
)
```

**Purpose**: Tells subscribed clients that a server request for this thread has been resolved. A server request is a request the server previously sent to clients and is now closing out.

**Data flow**: It receives the thread id, state manager, outgoing sender, and request id. It asks which connections are currently subscribed to the thread, wraps the outgoing sender so messages are scoped to those connections, and sends a ServerRequestResolved notification.

**Call relations**: handle_thread_listener_command calls this when it receives a resolve-server-request command. After the notification is sent, the command handler signals completion back to the command sender.

*Call graph*: calls 2 internal fn (new, subscribed_connection_ids); called by 1 (handle_thread_listener_command); 2 external calls (ServerRequestResolved, to_string).


##### `merge_turn_history_with_active_turn`  (lines 778–781)

```
fn merge_turn_history_with_active_turn(turns: &mut Vec<Turn>, active_turn: Turn)
```

**Purpose**: Combines saved turn history with the latest live active turn without duplicating it. The live version wins because it has the freshest status and content.

**Data flow**: It receives a mutable list of turns and an active turn. It removes any older turn with the same id from the list, then appends the active turn. The list is changed in place and nothing is returned.

**Call relations**: populate_thread_turns_from_history calls this after building turns from history. This ensures the resume response shows one current version of the active turn rather than both an old and a live copy.

*Call graph*: called by 1 (populate_thread_turns_from_history).


##### `set_thread_status_and_interrupt_stale_turns`  (lines 783–797)

```
fn set_thread_status_and_interrupt_stale_turns(
    thread: &mut Thread,
    loaded_status: ThreadStatus,
    has_live_in_progress_turn: bool,
)
```

**Purpose**: Sets the overall thread status and fixes turn statuses that would otherwise falsely appear to still be running. This prevents clients from showing stuck in-progress work after a thread is no longer active.

**Data flow**: It receives a mutable thread, the loaded thread status, and a boolean saying whether there is a real live in-progress turn. It resolves the final thread status. If that status is not active, it walks through the thread’s turns and changes any InProgress turn to Interrupted. Finally, it writes the resolved status onto the thread.

**Call relations**: handle_pending_thread_resume_request calls this while composing a running-thread resume response. It sits between reading live status from the watch manager and sending the final thread object to the client.

*Call graph*: called by 1 (handle_pending_thread_resume_request); 1 external calls (matches!).


### `app-server/src/mcp_refresh.rs`

`orchestration` · `when MCP or configuration changes need to be applied to running threads`

MCP servers are external tool servers that a Codex thread can talk to. When their configuration changes, already-running threads do not automatically know about it. This file fixes that by rebuilding the current MCP configuration for each thread and placing a refresh message into that thread’s work queue.

There are two refresh styles. The strict path is used when failure should stop the whole operation: it first reloads the latest shared configuration, then prepares refresh data for every thread, and only after all preparation succeeds does it queue the refresh messages. This avoids partly refreshing some threads if another thread’s configuration cannot be built. The best-effort path is more forgiving: it tries each thread one by one, logs a warning when one fails, and keeps going so other threads still get updated.

The key helper, build_refresh_config, combines the thread’s own saved settings with the newest global configuration. It turns the relevant MCP server list and authentication storage settings into JSON values, because the refresh operation is sent as a protocol message. Finally, queue_refresh sends that message to the thread as an Op::RefreshMcpServers command. The tests build two fake threads, one with good configuration and one with intentionally failing configuration, to prove the strict and best-effort paths behave differently.

#### Function details

##### `queue_strict_refresh`  (lines 11–31)

```
async fn queue_strict_refresh(
    thread_manager: &Arc<ThreadManager>,
    config_manager: &ConfigManager,
) -> io::Result<()>
```

**Purpose**: Refreshes MCP settings for all running threads, but treats any failure as a reason to stop. This is useful when the caller needs a clear success-or-failure answer instead of a partial update.

**Data flow**: It receives a shared ThreadManager and a ConfigManager. First it reloads the latest overall configuration. Then it asks the thread manager for every thread id, loads each thread, builds that thread’s refresh configuration, and stores the prepared work. If every thread can be prepared, it queues a refresh message for each one. It returns success if all messages were queued, or an input/output error if loading, configuration building, or queuing fails.

**Call relations**: It is called by the test that checks strict failure behavior and by mcp_server_refresh_response when a caller expects a firm result. Inside, it relies on build_refresh_config to create the per-thread refresh payload and queue_refresh to actually place the refresh command onto each thread.

*Call graph*: calls 3 internal fn (load_latest_config, build_refresh_config, queue_refresh); called by 2 (strict_refresh_reports_thread_planning_failures, mcp_server_refresh_response); 1 external calls (new).


##### `queue_best_effort_refresh`  (lines 33–56)

```
async fn queue_best_effort_refresh(
    thread_manager: &Arc<ThreadManager>,
    config_manager: &ConfigManager,
)
```

**Purpose**: Refreshes MCP settings for as many running threads as possible without letting one bad thread block the others. This is useful for background updates after plugin or configuration changes.

**Data flow**: It receives a shared ThreadManager and a ConfigManager. For each known thread id, it tries to load the thread, build the latest refresh configuration, and queue the refresh message. If any of those steps fails for one thread, it writes a warning and moves on. It does not return a result, because failures are intentionally handled by logging rather than stopping.

**Call relations**: It is called by the test that verifies all loadable threads are attempted and by spawn_effective_plugins_changed_task when plugin changes should be pushed in the background. It hands each successfully loaded thread to build_refresh_config, then hands the finished payload to queue_refresh.

*Call graph*: calls 2 internal fn (build_refresh_config, queue_refresh); called by 3 (best_effort_refresh_attempts_every_loaded_thread, spawn_effective_plugins_changed_task, spawn_effective_plugins_changed_task); 1 external calls (warn!).


##### `build_refresh_config`  (lines 58–77)

```
async fn build_refresh_config(
    thread: &CodexThread,
    config_manager: &ConfigManager,
) -> io::Result<McpServerRefreshConfig>
```

**Purpose**: Builds the exact MCP refresh message a thread needs, using the thread’s own context plus the newest available configuration. This keeps running threads from using stale MCP server or authentication settings.

**Data flow**: It receives a CodexThread and a ConfigManager. It reads the thread’s current configuration, asks the ConfigManager to load the latest configuration for that specific thread, asks the thread to compute its runtime MCP configuration, turns the configured MCP servers into JSON, and also turns the latest authentication storage settings into JSON. It returns an McpServerRefreshConfig ready to send, or an input/output error if configuration loading or JSON conversion fails.

**Call relations**: It is used by both refresh paths before any message can be queued. The auth-keyring test also calls it directly to confirm that the refresh payload uses the newest global setting, not just the older setting stored on the thread.

*Call graph*: calls 3 internal fn (load_latest_config_for_thread, config, runtime_mcp_config); called by 3 (queue_best_effort_refresh, queue_strict_refresh, refresh_config_uses_latest_auth_keyring_backend); 2 external calls (configured_mcp_servers, to_value).


##### `queue_refresh`  (lines 79–93)

```
async fn queue_refresh(
    thread_id: ThreadId,
    thread: Arc<CodexThread>,
    config: McpServerRefreshConfig,
) -> io::Result<()>
```

**Purpose**: Sends one prepared MCP refresh command to one thread. It is the final step that turns a rebuilt configuration into work the thread will process.

**Data flow**: It receives a thread id, the shared thread object, and an McpServerRefreshConfig. It submits an Op::RefreshMcpServers message to that thread. On success it returns an empty success value; on failure it returns an input/output error that includes the thread id so the caller can tell which thread could not be updated.

**Call relations**: It is called after queue_strict_refresh or queue_best_effort_refresh has already chosen a thread and built its payload. The strict caller treats an error here as a full failure, while the best-effort caller logs the error and continues with other threads.

*Call graph*: called by 2 (queue_best_effort_refresh, queue_strict_refresh).


##### `tests::strict_refresh_reports_thread_planning_failures`  (lines 126–135)

```
async fn strict_refresh_reports_thread_planning_failures() -> anyhow::Result<()>
```

**Purpose**: Checks that the strict refresh path reports a configuration-building failure instead of silently continuing. This protects callers that depend on strict refresh giving an honest success-or-failure result.

**Data flow**: It creates a test setup with one good thread and one bad thread. It calls queue_strict_refresh and expects an error. Then it compares the error text to the deliberately injected configuration-loading failure message.

**Call relations**: It uses refresh_test_state to create the fake environment, then calls queue_strict_refresh. This test proves that failures from build_refresh_config travel back through the strict refresh path to the caller.

*Call graph*: calls 1 internal fn (queue_strict_refresh); 2 external calls (refresh_test_state, assert_eq!).


##### `tests::best_effort_refresh_attempts_every_loaded_thread`  (lines 138–146)

```
async fn best_effort_refresh_attempts_every_loaded_thread() -> anyhow::Result<()>
```

**Purpose**: Checks that the best-effort refresh path still tries every thread even when one thread’s configuration fails. This protects background refreshes from being stopped by one bad workspace.

**Data flow**: It creates the same two-thread test setup, then calls queue_best_effort_refresh. Afterward it reads counters from the fake loader and confirms that both the good and bad thread configurations were attempted exactly once.

**Call relations**: It uses refresh_test_state to build the environment and queue_best_effort_refresh to run the behavior under test. The counter checks confirm that warning-and-continue behavior really happened.

*Call graph*: calls 1 internal fn (queue_best_effort_refresh); 2 external calls (refresh_test_state, assert_eq!).


##### `tests::refresh_config_uses_latest_auth_keyring_backend`  (lines 149–178)

```
async fn refresh_config_uses_latest_auth_keyring_backend() -> anyhow::Result<()>
```

**Purpose**: Checks that a refresh payload uses the newest authentication storage setting from disk, even if the thread was started with an older setting. This matters because MCP authentication may depend on where secrets are stored.

**Data flow**: It creates the test state with secret storage initially disabled, then rewrites the config file to enable secret storage. It finds the good test thread, calls build_refresh_config, decodes the auth-keyring setting from the returned JSON, and compares it with both the old thread setting and the expected new setting.

**Call relations**: It calls refresh_test_state to create a running thread, writes a new config file, then calls build_refresh_config directly. This focuses the test on the payload-building step rather than the queuing step.

*Call graph*: calls 1 internal fn (build_refresh_config); 3 external calls (refresh_test_state, assert_eq!, write).


##### `tests::refresh_test_state`  (lines 180–275)

```
async fn refresh_test_state() -> anyhow::Result<(
        TempDir,
        Arc<ThreadManager>,
        ConfigManager,
        Arc<CountingThreadConfigLoader>,
    )>
```

**Purpose**: Builds a realistic test environment for MCP refresh tests, including temporary configuration files, two work directories, a thread manager, and a fake configuration loader. It lets the tests exercise real refresh code without using a user’s actual files or services.

**Data flow**: It creates a temporary directory, makes a good workspace and a bad workspace, writes an initial config file, loads starting configs for both, builds the authentication, state database, thread store, environment manager, extensions, and thread manager needed to start threads, and then starts both threads. Finally it creates a CountingThreadConfigLoader that succeeds for the good workspace and fails for the bad one, wraps it in a ConfigManager, and returns all the pieces the tests need.

**Call relations**: The three tests call this helper before exercising strict refresh, best-effort refresh, or refresh-payload building. It supplies the controlled world in which CountingThreadConfigLoader can prove which thread configurations were attempted.

*Call graph*: calls 9 internal fn (new, without_managed_config_for_tests, default, without_managed_config_for_tests, default_for_tests, new_with_restriction_product, from_auth_for_testing, from_api_key, try_from); 12 external calls (clone, new, new_cyclic, new, new, new, default, init_state_db, thread_store_from_config, default (+2 more)).


##### `tests::CountingThreadConfigLoader::load`  (lines 305–310)

```
fn load(
            &self,
            context: ThreadConfigContext,
        ) -> codex_config::ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Acts as a fake per-thread configuration loader for tests. It counts how often each test workspace is loaded and intentionally fails for the bad workspace.

**Data flow**: It receives a ThreadConfigContext, checks the workspace path inside it, and updates either the good-load counter or the bad-load counter. If the path is the bad workspace, it returns a ThreadConfigLoadError with the message used by the strict-refresh test. Otherwise it returns an empty list of extra configuration sources.

**Call relations**: The test ConfigManager calls this loader while build_refresh_config is loading the latest configuration for a thread. Its counters let best_effort_refresh_attempts_every_loaded_thread verify that both workspaces were tried, and its forced error lets strict_refresh_reports_thread_planning_failures verify strict failure reporting.

*Call graph*: calls 1 internal fn (new); 4 external calls (fetch_add, pin, new, load).


### `exec-server/src/server/session_registry.rs`

`orchestration` · `request handling and disconnect cleanup`

A session here is like a reserved workbench in a workshop: it has a running process attached to it, and one client connection is allowed to use it at a time. If the client walks away for a moment, the workbench is not thrown away immediately. Instead, it is marked as detached and kept for a short grace period so the same session can be resumed.

SessionRegistry is the shared table of all known sessions, keyed by session ID. When a client connects, attach either creates a fresh session or tries to resume an existing one. It rejects bad requests, such as resuming an unknown session, resuming an expired session, or trying to attach to a session that another live connection is already using.

Each SessionEntry stores the session ID, the ProcessHandler that represents the running work, and a small attachment state protected by a mutex, which is a lock that stops two tasks changing the same state at the same time. SessionHandle is the safe object given to the rest of the server; it exposes the session ID, connection ID, process, and detach behavior.

The important behavior is delayed cleanup. When a connection detaches, notifications are turned off and a background task waits for the grace period. If nobody has reattached by then, the registry removes the session and shuts down its process.

#### Function details

##### `ConnectionId::fmt`  (lines 39–41)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This turns a connection ID into readable text. It is used when the server needs to show or return the ID as a string instead of as a UUID value.

**Data flow**: It receives a ConnectionId and a formatter object. It passes the inner UUID to the formatter, producing the normal UUID text form as output.

**Call relations**: SessionHandle::connection_id relies on this display behavior indirectly when it calls to_string. That lets callers get a plain string version of the connection's unique ID.


##### `SessionRegistry::new`  (lines 52–56)

```
fn new() -> Arc<Self>
```

**Purpose**: This creates a new, empty shared session registry. The server uses it when it needs a central place to remember all live and recently detached sessions.

**Data flow**: It starts with no inputs. It builds an empty hash map, wraps it in an asynchronous mutex so multiple tasks can safely share it, wraps the registry in Arc, which is a shared ownership pointer, and returns that shared registry.

**Call relations**: Startup and tests call this before any sessions exist. Later, SessionRegistry::attach uses the registry it created to add new sessions or look up sessions that clients want to resume.

*Call graph*: called by 6 (active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, new, transport_disconnect_detaches_session_during_in_flight_read); 3 external calls (new, new, new).


##### `SessionRegistry::attach`  (lines 58–117)

```
async fn attach(
        self: &Arc<Self>,
        resume_session_id: Option<String>,
        notifications: RpcNotificationSender,
    ) -> Result<SessionHandle, JSONRPCErrorError>
```

**Purpose**: This is the main doorway for connecting a client to a session. It either creates a new session or resumes an existing detached one, while preventing two active connections from using the same session at once.

**Data flow**: It receives an optional session ID to resume and a notification sender for messages back to the client. It creates a fresh connection ID, locks the session table, then either looks up the requested session or creates a new SessionEntry with a new ProcessHandler. If the requested session is missing, expired, or already attached, it returns a JSON-RPC error. If everything is valid, it updates the process notification sender, marks the session attached to this connection, and returns a SessionHandle.

**Call relations**: Other server code calls this when a client starts or resumes a session. It calls SessionEntry::new for brand-new sessions, uses SessionEntry checks such as is_expired and has_active_connection for resumed sessions, and may call ProcessHandler shutdown if it discovers that a requested detached session has already expired.

*Call graph*: calls 3 internal fn (invalid_request, new, new); 6 external calls (clone, new, Attached, new_v4, format!, now).


##### `SessionRegistry::expire_if_detached`  (lines 119–136)

```
async fn expire_if_detached(&self, session_id: String, connection_id: ConnectionId)
```

**Purpose**: This performs delayed cleanup for a detached session. It waits for the grace period, then shuts down the session only if the same detached connection is still expired and nobody has reattached.

**Data flow**: It receives a session ID and the connection ID that detached. It sleeps for the configured time-to-live period, locks the session table, checks whether that exact detached connection has expired, removes the session if so, and then shuts down its process. If the session is gone or has been reattached, it does nothing.

**Call relations**: SessionHandle::detach starts this in a background task after a connection leaves. The extra check through SessionEntry::is_detached_connection_expired is important because a client might reconnect during the waiting period, in which case cleanup must not kill the newly resumed session.

*Call graph*: 2 external calls (now, sleep).


##### `SessionRegistry::default`  (lines 140–144)

```
fn default() -> Self
```

**Purpose**: This provides the standard default value for a SessionRegistry: an empty registry. It exists so code that expects Rust's Default behavior can create one without calling the custom constructor.

**Data flow**: It receives no inputs. It creates an empty session map protected by an asynchronous mutex and returns the registry value directly, not wrapped in Arc.

**Call relations**: This mirrors the setup done by SessionRegistry::new, but without shared ownership wrapping. It is useful for generic construction paths, while normal shared server use goes through SessionRegistry::new.

*Call graph*: 2 external calls (new, new).


##### `SessionEntry::new`  (lines 148–158)

```
fn new(session_id: String, process: ProcessHandler, connection_id: ConnectionId) -> Self
```

**Purpose**: This creates the record for one session. It ties together the session ID, the running process, and the first connection that is attached to it.

**Data flow**: It receives a session ID, a ProcessHandler, and the current connection ID. It stores them and initializes the attachment state so the session is currently attached, with no detached connection and no expiry deadline.

**Call relations**: SessionRegistry::attach calls this when a client starts a brand-new session. After creation, the entry is stored in the registry's session table and later reached through a SessionHandle.

*Call graph*: called by 1 (attach); 1 external calls (new).


##### `SessionEntry::attach`  (lines 160–168)

```
fn attach(&self, connection_id: ConnectionId)
```

**Purpose**: This marks an existing session as attached to a new live connection. It is used when a detached session is successfully resumed.

**Data flow**: It receives a connection ID. It locks the attachment state, sets that connection as the current active one, and clears any old detached connection and expiry time.

**Call relations**: SessionRegistry::attach calls this after it has checked that the session exists, has not expired, and is not already in use. This step cancels the pending detached state so background cleanup will no longer remove the session.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::detach`  (lines 170–183)

```
fn detach(&self, connection_id: ConnectionId) -> bool
```

**Purpose**: This marks a session as temporarily disconnected. It only succeeds if the caller's connection is the one currently attached, which prevents an old or wrong connection from detaching someone else's session.

**Data flow**: It receives a connection ID and locks the attachment state. If that ID is not the current connection, it returns false and changes nothing. If it matches, it clears the active connection, records the detached connection ID, sets an expiry deadline, and returns true.

**Call relations**: SessionHandle::detach calls this when a client connection closes or detaches. A true result tells the handle to stop notifications and schedule delayed cleanup; a false result means this handle is no longer the active owner, so no cleanup should be started from it.

*Call graph*: 2 external calls (lock, now).


##### `SessionEntry::has_active_connection`  (lines 185–191)

```
fn has_active_connection(&self) -> bool
```

**Purpose**: This answers the question: is someone currently attached to this session? It helps enforce the rule that only one live connection can use a session at a time.

**Data flow**: It locks the attachment state and checks whether current_connection_id contains a value. It returns true if there is an active connection and false if the session is detached.

**Call relations**: SessionRegistry::attach uses this while resuming a session. If it returns true, attach rejects the resume attempt because another connection is already using that session.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::is_attached_to`  (lines 193–199)

```
fn is_attached_to(&self, connection_id: ConnectionId) -> bool
```

**Purpose**: This checks whether a session is currently attached to a specific connection. It lets a SessionHandle confirm that it still represents the live owner of the session.

**Data flow**: It receives a connection ID, locks the attachment state, compares it with the current active connection ID, and returns true only if they match.

**Call relations**: SessionHandle::is_session_attached uses this to provide a simple status check to the rest of the server. That protects callers from assuming a handle is still active after the session has been detached or resumed elsewhere.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::is_expired`  (lines 201–207)

```
fn is_expired(&self, now: tokio::time::Instant) -> bool
```

**Purpose**: This checks whether a detached session's grace period has already run out. It is used before allowing a client to resume a session.

**Data flow**: It receives the current time, locks the attachment state, and looks at the stored detached expiry deadline. It returns true if there is a deadline and the current time is at or past it; otherwise it returns false.

**Call relations**: SessionRegistry::attach calls this when a client asks to resume a session. If the session is expired, attach removes it, shuts down its process, and reports the session as unknown to the client.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::is_detached_connection_expired`  (lines 209–223)

```
fn is_detached_connection_expired(
        &self,
        connection_id: ConnectionId,
        now: tokio::time::Instant,
    ) -> bool
```

**Purpose**: This checks the exact condition needed before background cleanup is allowed to remove a session. It makes sure the session is still detached, still detached from the same connection, and past its deadline.

**Data flow**: It receives a connection ID and the current time. It locks the attachment state, then checks three things: there is no current active connection, the stored detached connection matches the given ID, and the expiry deadline has passed. It returns true only when all three are true.

**Call relations**: SessionRegistry::expire_if_detached calls this after sleeping. This protects against a race where the session was detached, then resumed, or detached again by a different connection, before the cleanup task woke up.

*Call graph*: 1 external calls (lock).


##### `SessionHandle::session_id`  (lines 227–229)

```
fn session_id(&self) -> &str
```

**Purpose**: This returns the stable session ID for the handle. Callers use it to tell the client which session can be resumed later.

**Data flow**: It reads the session_id stored inside the shared SessionEntry and returns it as a string slice. It does not change any state.

**Call relations**: Server code that receives a SessionHandle from SessionRegistry::attach can call this to include the session ID in responses or logs. It is a read-only view into the entry owned by the registry.


##### `SessionHandle::connection_id`  (lines 231–233)

```
fn connection_id(&self) -> String
```

**Purpose**: This returns the unique ID for this particular connection as text. It helps distinguish one attachment attempt from another, even when they use the same session.

**Data flow**: It reads the handle's connection ID, converts it to a string, and returns that string. It does not change the session or registry.

**Call relations**: Callers use this on the SessionHandle created by SessionRegistry::attach when they need to report or track the current connection. The string conversion uses the display behavior defined by ConnectionId::fmt.

*Call graph*: 1 external calls (to_string).


##### `SessionHandle::is_session_attached`  (lines 235–237)

```
fn is_session_attached(&self) -> bool
```

**Purpose**: This tells callers whether this handle's connection is still the active one for the session. It is a quick safety check before treating the session as live for this connection.

**Data flow**: It takes the handle's stored connection ID and asks the SessionEntry whether that exact ID is currently attached. It returns true or false and does not change anything.

**Call relations**: This is a convenience wrapper around SessionEntry::is_attached_to. Code holding a SessionHandle can use it without directly touching the entry's internal attachment state.


##### `SessionHandle::process`  (lines 239–241)

```
fn process(&self) -> &ProcessHandler
```

**Purpose**: This gives access to the ProcessHandler for the session. The rest of the server uses that process object to perform the actual work associated with the session.

**Data flow**: It reads the ProcessHandler stored in the SessionEntry and returns a reference to it. It does not create, stop, or modify the process by itself.

**Call relations**: After SessionRegistry::attach returns a SessionHandle, request-handling code can call this to interact with the running process. The registry remains responsible for session ownership and cleanup, while ProcessHandler does the session's work.


##### `SessionHandle::detach`  (lines 243–258)

```
async fn detach(&self)
```

**Purpose**: This disconnects this handle from its session and starts the countdown for possible cleanup. It is used when the transport connection goes away or the client otherwise stops being attached.

**Data flow**: It asks the SessionEntry to detach using this handle's connection ID. If that fails, it returns without changing anything else. If it succeeds, it removes the process notification sender so messages are no longer sent to a dead connection, clones the registry reference, copies the session and connection IDs, and spawns a background task that may expire the session later.

**Call relations**: Connection shutdown code calls this on the SessionHandle. It hands the delayed cleanup work to SessionRegistry::expire_if_detached, which waits for the grace period and then decides whether the process should really be shut down.

*Call graph*: 2 external calls (clone, spawn).


### Extensions and thread-scoped services
These files add thread-aware extension behavior such as goals, MCP plugin contributions, skills state, and session control tools layered on top of the core runtime.

### `ext/goal/src/extension.rs`

`orchestration` · `cross-cutting: active during thread startup, config changes, turns, tool calls, token updates, idle time, resume, and shutdown`

Think of this file as the adapter that lets the goals feature ride along with the normal life of a Codex session. A “thread” is an ongoing conversation or work session, and a “turn” is one step in that conversation. Goals need to know when a thread starts, when a turn begins or ends, when tools run, and how many tokens have been spent, because all of those affect goal progress and budget limits.

The main type, GoalExtension, holds the shared services the feature needs: persistent state storage, analytics, event sending, metrics, a weak link back to the thread manager, and the GoalService that keeps track of active goal runtimes. When a thread starts, it decides whether goals are enabled, creates or reuses a GoalRuntimeHandle, and registers it. When the thread resumes or becomes idle, it asks the runtime to restore or continue any active goal. When the thread stops, it unregisters the runtime.

During each turn, the extension records starting token usage, marks whether a goal is active, and accounts for progress when the turn ends, aborts, or errors. During tool use, it counts completed or actually-executed failed tool calls as possible goal progress. If a goal hits a budget limit, it injects a steering message so the active turn is told about that limit. It also exposes the goal tools only when they are safe and visible for that thread.

#### Function details

##### `GoalExtensionConfig::from_enabled`  (lines 54–56)

```
fn from_enabled(enabled: bool) -> Self
```

**Purpose**: Builds the small per-thread settings record that says whether goals are currently enabled. This gives the rest of the extension system a simple stored flag to read later.

**Data flow**: It receives a true-or-false enabled value, wraps it in a GoalExtensionConfig, and returns that config object. Nothing else is changed.

**Call relations**: When a thread starts or the configuration changes, the extension calls this helper before storing the current goal setting in the thread’s extension data.

*Call graph*: called by 2 (on_config_changed, on_thread_start).


##### `GoalExtension::fmt`  (lines 71–73)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a safe debug printout for GoalExtension. It deliberately avoids printing all internal services and shared handles, which could be noisy or sensitive.

**Data flow**: It receives a formatter from Rust’s debug-printing system and writes a short, non-complete description named GoalExtension. It returns the normal formatting result.

**Call relations**: This is used automatically when something tries to log or inspect a GoalExtension with debug formatting. It delegates the actual formatting shape to Rust’s debug_struct helper.

*Call graph*: 1 external calls (debug_struct).


##### `GoalExtension::new_with_host_capabilities`  (lines 77–95)

```
fn new_with_host_capabilities(
        state_dbs: Arc<codex_state::StateRuntime>,
        analytics_events_client: AnalyticsEventsClient,
        event_sink: Arc<dyn ExtensionEventSink>,
        metri
```

**Purpose**: Creates a GoalExtension with all the outside services it needs from the host application. This is the construction point where storage, analytics, events, metrics, thread access, and goal enablement are brought together.

**Data flow**: It takes shared state storage, analytics and metrics clients, an event sink, a weak thread-manager reference, the goal service, and a function that can decide whether goals are enabled for a config. It wraps or converts these into goal-specific helper objects and returns a ready-to-register GoalExtension.

**Call relations**: install_with_backend calls this when adding the goals feature to the extension registry. The constructor creates GoalAnalytics, GoalEventEmitter, and GoalMetrics helpers so later lifecycle callbacks can report what happens.

*Call graph*: calls 3 internal fn (new, new, new); called by 1 (install_with_backend); 1 external calls (new).


##### `GoalExtension::on_thread_start`  (lines 102–137)

```
fn on_thread_start(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Sets up goal tracking for a newly started thread. Without this step, later turn and tool events would have no goal runtime to talk to.

**Data flow**: It reads the new thread’s config, source, persistent-state availability, and thread store. It decides whether goals are enabled, stores that setting, creates or reuses accounting state, converts the thread’s stored level id into a ThreadId, creates or reuses a GoalRuntimeHandle, updates its enabled state, and registers it with GoalService.

**Call relations**: The extension framework calls this at thread startup. It uses GoalExtensionConfig::from_enabled to store the current setting, creates the runtime that nearly all later callbacks retrieve through goal_runtime_handle, and hands that runtime to GoalService so other parts of the goal system can find it.

*Call graph*: calls 2 internal fn (from_enabled, from_string); 2 external calls (pin, matches!).


##### `GoalExtension::on_thread_resume`  (lines 139–152)

```
fn on_thread_resume(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Restores goal state when an existing thread is resumed. This helps an active goal continue correctly after a pause or reload.

**Data flow**: It looks in the thread store for the existing GoalRuntimeHandle. If one exists, it asks the runtime to restore itself after resume; if that restore fails, it writes a warning log and otherwise leaves the thread running.

**Call relations**: The extension framework calls this when a thread resumes. It uses goal_runtime_handle to find the runtime created at thread start, then hands control to the runtime’s restore logic.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, warn!).


##### `GoalExtension::on_thread_idle`  (lines 154–167)

```
fn on_thread_idle(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Lets an active goal continue work when the thread becomes idle. This is how a goal can keep driving progress after the user or agent has finished a turn.

**Data flow**: It retrieves the goal runtime from the thread store. If present, it asks the runtime to continue the active goal if idle; if that attempt fails, it records a warning.

**Call relations**: The extension framework calls this when a thread enters an idle state. It finds the runtime through goal_runtime_handle and then delegates the decision about continuing to GoalRuntimeHandle.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, warn!).


##### `GoalExtension::on_thread_stop`  (lines 169–175)

```
fn on_thread_stop(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Cleans up the goal runtime registration when a thread stops. This prevents the GoalService from keeping a stale reference to a thread that is no longer active.

**Data flow**: It checks the thread store for a GoalRuntimeHandle. If found, it asks GoalService to unregister that runtime. It does not return any data.

**Call relations**: The extension framework calls this during thread shutdown. It uses goal_runtime_handle to find the runtime that on_thread_start registered, then removes it from GoalService.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 1 external calls (pin).


##### `GoalExtension::on_config_changed`  (lines 182–194)

```
fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &C,
        new_config: &C,
    )
```

**Purpose**: Updates the goals feature when the session configuration changes. This lets goals be turned on or off without rebuilding the whole thread.

**Data flow**: It reads the new config, runs the stored goals_enabled decision function, saves the new enabled flag into the thread store, and, if a goal runtime already exists, tells that runtime about the new enabled state.

**Call relations**: The extension framework calls this after config changes. It uses GoalExtensionConfig::from_enabled to store the new setting and goal_runtime_handle to update the live runtime if one exists.

*Call graph*: calls 3 internal fn (insert, from_enabled, goal_runtime_handle).


##### `GoalExtension::on_turn_start`  (lines 201–241)

```
fn on_turn_start(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Starts goal accounting for a new turn. It records the token baseline and notes whether the current turn should count toward an active goal.

**Data flow**: It retrieves the runtime and stops early if goals are disabled. It tells the accounting state the turn id, collaboration mode, and starting token usage. If the turn is in planning mode, it clears the current-turn goal because planning should not count as goal execution. Otherwise it reads the stored thread goal and, if that goal is active or budget-limited, marks it as active for this turn.

**Call relations**: The extension framework calls this at the beginning of a turn. It uses goal_runtime_handle to find the runtime and the state database to look up the current thread goal, then records the result in GoalAccountingState for later stop, abort, token, and tool callbacks.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, matches!).


##### `GoalExtension::on_turn_stop`  (lines 243–269)

```
fn on_turn_stop(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Finalizes goal progress when a turn finishes normally. This makes sure work done during the turn is counted before the turn is closed.

**Data flow**: It finds the runtime and exits if goals are disabled. It takes the turn id from the turn store, asks the runtime to account progress for the active goal using a turn-stop marker, and tells accounting state to finish the turn. If progress accounting fails, it logs a warning and does not mark the turn finished here.

**Call relations**: The extension framework calls this when a turn ends successfully. It uses goal_runtime_handle to find the runtime, delegates progress calculation to account_active_goal_progress, and then closes the accounting record for that turn.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 3 external calls (pin, format!, warn!).


##### `GoalExtension::on_turn_abort`  (lines 271–297)

```
fn on_turn_abort(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Finalizes goal progress when a turn is aborted. This gives the system a chance to count any completed work while also clearing the active goal marker for that turn.

**Data flow**: It retrieves the runtime and exits if goals are disabled. It gets the turn id, asks the runtime to account active-goal progress using a turn-abort marker, and then finishes the turn in the accounting state. If accounting fails, it logs a warning and returns early.

**Call relations**: The extension framework calls this when a turn is cut short. Like on_turn_stop, it uses goal_runtime_handle and account_active_goal_progress, but labels the accounting event as an abort.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 3 external calls (pin, format!, warn!).


##### `GoalExtension::on_turn_error`  (lines 299–323)

```
fn on_turn_error(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Stops an active goal after a turn ends with an error. This avoids automatic continuation loops, especially when repeated errors could waste tokens.

**Data flow**: It retrieves the runtime if one exists. It translates the error into a stop reason: usage-limit errors become UsageLimit, and all other errors become TurnError. It then asks the runtime to stop the active goal for that turn and logs a warning if stopping fails.

**Call relations**: The extension framework calls this when a turn fails. It uses goal_runtime_handle to find the runtime and then hands off to the runtime’s stop logic so goal continuation is blocked for the right reason.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, warn!).


##### `GoalExtension::on_token_usage`  (lines 330–352)

```
fn on_token_usage(
        &'a self,
        _session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
        turn_store: &'a ExtensionData,
        token_usage: &'a TokenUsageInfo,
```

**Purpose**: Records token usage during a turn so the goals feature can measure budget and progress. Tokens are the pieces of text processed by the model, so tracking them matters for cost and limits.

**Data flow**: It receives session, thread, turn, and token-usage information, but only needs the thread store, turn id, and total token usage. It finds the runtime, exits if goals are disabled, and records the latest token totals in the accounting state. It returns no user-visible result.

**Call relations**: The extension framework calls this whenever token usage is reported. It uses goal_runtime_handle to reach the runtime and updates accounting data that later turn and tool progress calculations can rely on.

*Call graph*: calls 2 internal fn (level_id, goal_runtime_handle); 1 external calls (pin).


##### `GoalExtension::on_tool_finish`  (lines 359–403)

```
fn on_tool_finish(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a>
```

**Purpose**: Counts relevant completed tool attempts as goal progress. It also notices when that progress pushes a goal into a budget-limited state and tells the active turn about it.

**Data flow**: It receives the finished tool’s name, result, call id, turn id, and thread store. It finds the runtime, checks that goals are enabled, checks whether the tool outcome should count, and ignores the goal-update tool itself so goal bookkeeping does not count as goal progress. It then asks the runtime to account progress. If the goal becomes budget-limited and that limit has not already been reported, it creates a steering item and injects it into the active turn.

**Call relations**: The extension framework calls this after any tool finishes. It uses goal_runtime_handle to find the runtime, tool_attempt_counts_for_goal_progress to filter outcomes, account_active_goal_progress to update goal progress, and budget_limit_steering_item to create the message injected back into the turn.

*Call graph*: calls 3 internal fn (goal_runtime_handle, tool_attempt_counts_for_goal_progress, budget_limit_steering_item); 2 external calls (pin, warn!).


##### `GoalExtension::tools`  (lines 410–448)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>>
```

**Purpose**: Exposes the goal-related tools for a thread when they are allowed to be visible. These tools let the agent get, create, and update thread goals.

**Data flow**: It looks up the runtime in the thread store. If there is no runtime, or if the runtime says tools should not be visible, it returns an empty list. Otherwise it builds three GoalToolExecutor objects for get, create, and update, each supplied with the thread id, storage, accounting state, analytics, event emitter, and metrics.

**Call relations**: The extension framework calls this when it asks contributors which tools are available. It uses goal_runtime_handle to check the live thread runtime and returns tool executors that later handle actual goal tool calls.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (new, vec!).


##### `install_with_backend`  (lines 451–477)

```
fn install_with_backend(
    registry: &mut ExtensionRegistryBuilder<C>,
    state_dbs: Arc<codex_state::StateRuntime>,
    analytics_events_client: AnalyticsEventsClient,
    metrics_client: Option<M
```

**Purpose**: Registers the goals extension with the host extension registry. This is the one setup function that makes all the lifecycle callbacks and tools in this file active.

**Data flow**: It receives the registry plus all backend services needed by goals. It builds a shared GoalExtension with new_with_host_capabilities, then registers that same extension as a thread lifecycle contributor, config contributor, turn lifecycle contributor, token usage contributor, tool lifecycle contributor, and tool contributor.

**Call relations**: Host setup code calls this during extension installation. It asks the registry for its event sink, constructs the GoalExtension, and wires that extension into every kind of event stream it needs to observe.

*Call graph*: calls 8 internal fn (config_contributor, event_sink, thread_lifecycle_contributor, token_usage_contributor, tool_contributor, tool_lifecycle_contributor, turn_lifecycle_contributor, new_with_host_capabilities); 2 external calls (clone, new).


##### `goal_runtime_handle`  (lines 479–481)

```
fn goal_runtime_handle(thread_store: &ExtensionData) -> Option<Arc<GoalRuntimeHandle>>
```

**Purpose**: Fetches the goal runtime stored for a thread, if one exists. This small helper keeps all the callback code from repeating the same lookup.

**Data flow**: It receives a thread’s ExtensionData store and asks for a GoalRuntimeHandle. If the handle was stored earlier, it returns it inside an Option; otherwise it returns None.

**Call relations**: Most lifecycle callbacks call this before doing goal work. It connects the setup done in on_thread_start with later events such as config changes, turn starts and stops, token updates, tool finishes, idle continuation, resume, and shutdown.

*Call graph*: called by 11 (on_config_changed, on_thread_idle, on_thread_resume, on_thread_stop, on_token_usage, on_tool_finish, on_turn_abort, on_turn_error, on_turn_start, on_turn_stop (+1 more)).


##### `tool_attempt_counts_for_goal_progress`  (lines 483–495)

```
fn tool_attempt_counts_for_goal_progress(outcome: ToolCallOutcome) -> bool
```

**Purpose**: Decides whether a finished tool attempt should count as possible goal progress. The rule is that completed tools count, and failed tools count only if their handler actually ran.

**Data flow**: It receives a ToolCallOutcome. It returns true for completed outcomes and for failures where the handler executed, and false for blocked, aborted, or never-executed failures.

**Call relations**: on_tool_finish calls this before accounting tool-based progress. This keeps blocked or skipped tool attempts from incorrectly moving a goal forward.

*Call graph*: called by 1 (on_tool_finish).


### `ext/goal/src/runtime.rs`

`domain_logic` · `cross-cutting during thread turns, goal edits, resume, and automatic continuation`

A “goal” is a longer-running objective attached to a thread. This runtime handle is the piece that watches that goal while turns happen, while outside code edits or clears the goal, and while the system resumes after being paused. It acts like a traffic controller: before a goal is changed, it records any progress already made; when a goal becomes active, it may start an automatic follow-up turn; when a turn fails or hits usage limits, it updates the goal to the right stopped state.

The file stores shared runtime parts inside GoalRuntimeInner: the thread id, the state database, analytics, metrics, event emitter, a weak link back to the thread manager, and accounting state. A weak link means this runtime can try to reach the live thread without keeping it alive forever. A semaphore is used as a simple lock, so two goal-changing paths do not step on each other.

The most important behavior is that state changes are not just database writes. They also update accounting baselines, record metrics, send analytics, and emit protocol events so other parts of the application can react. If goals are disabled, most operations quietly do nothing.

#### Function details

##### `PreviousGoalSnapshot::from`  (lines 65–71)

```
fn from(goal: &codex_state::ThreadGoal) -> Self
```

**Purpose**: Creates a small remembered copy of an existing goal before it is changed. This lets later code compare the old goal with the new one without keeping the whole database object around.

**Data flow**: It receives a stored thread goal, copies out its id, status, and objective text, and returns a PreviousGoalSnapshot containing just those fields.

**Call relations**: When set_thread_goal is about to replace or update a goal, it uses this conversion to capture the “before” picture. Later runtime code can use that snapshot to decide whether the goal was newly created, resumed, completed, or had its objective changed.

*Call graph*: called by 1 (set_thread_goal).


##### `GoalRuntimeHandle::fmt`  (lines 75–77)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a safe debug printout for GoalRuntimeHandle. It deliberately avoids printing all internal fields, which may be large, private, or noisy.

**Data flow**: It receives a formatting target from Rust’s debug-printing system, writes the struct name in a non-detailed form, and returns the formatting result.

**Call relations**: This is used automatically when code logs or debugs a GoalRuntimeHandle. It delegates to the standard debug_struct formatter to produce a compact representation.

*Call graph*: 1 external calls (debug_struct).


##### `GoalRuntimeHandle::new`  (lines 81–104)

```
fn new(
        thread_id: ThreadId,
        state_dbs: Arc<codex_state::StateRuntime>,
        event_emitter: GoalEventEmitter,
        metrics: GoalMetrics,
        thread_manager: Weak<ThreadManage
```

**Purpose**: Builds a new runtime handle for one thread’s goals. It gathers all the services the goal runtime needs, such as storage, analytics, metrics, accounting, and access to the live thread.

**Data flow**: It receives the thread id, state database runtime, event emitter, metrics recorder, thread manager link, accounting state, and configuration. It wraps them in shared ownership, initializes the enabled flag and one-at-a-time goal lock, and returns a GoalRuntimeHandle.

**Call relations**: This is the setup point for the rest of the file. All later methods work through the shared inner object created here, so they can safely be cloned and used from different async tasks.

*Call graph*: 3 external calls (new, new, new).


##### `GoalRuntimeHandle::set_enabled`  (lines 106–108)

```
fn set_enabled(&self, enabled: bool)
```

**Purpose**: Turns goal runtime behavior on or off for this handle. This is useful when configuration changes or a thread should stop exposing goal features.

**Data flow**: It receives a true-or-false value and stores it in an atomic flag, which is a thread-safe value that can be read while other tasks are running.

**Call relations**: Other methods check the flag through GoalRuntimeHandle::is_enabled before doing work. This function is the switch those checks depend on.


##### `GoalRuntimeHandle::is_enabled`  (lines 110–112)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Answers whether goal behavior is currently active. Many public operations use it as an early safety check.

**Data flow**: It reads the internal atomic enabled flag and returns true or false. It does not change anything.

**Call relations**: It is called by goal-editing, clearing, resume, stopping, and visibility paths. If it returns false, those callers usually exit without touching state, metrics, analytics, or events.

*Call graph*: called by 6 (apply_external_goal_clear, apply_external_goal_set, prepare_external_goal_mutation, restore_after_resume, stop_active_goal_for_turn, tools_visible).


##### `GoalRuntimeHandle::tools_visible`  (lines 114–116)

```
fn tools_visible(&self) -> bool
```

**Purpose**: Decides whether goal-related tools should be visible and usable for this thread. Tools are visible only when goals are enabled and the thread was configured to have goal tools available.

**Data flow**: It reads the enabled flag through GoalRuntimeHandle::is_enabled and combines that with the stored tools_available_for_thread setting. The result is a true-or-false answer.

**Call relations**: GoalRuntimeHandle::continue_if_idle calls this before trying to start automatic goal work. If tools are not visible, continuation is skipped and active accounting is cleared.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (continue_if_idle).


##### `GoalRuntimeHandle::thread_id`  (lines 118–120)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the id of the thread this goal runtime belongs to. Other methods use it whenever they read or write that thread’s goal in storage.

**Data flow**: It reads the stored ThreadId from the runtime and returns it.

**Call relations**: It is used by the accounting, continuation, resume, stop, and status-checking methods so they all operate on the correct thread.

*Call graph*: called by 6 (account_active_goal_progress, account_idle_goal_progress, continue_if_idle, current_goal_status_for_metrics, restore_after_resume, stop_active_goal_for_turn).


##### `GoalRuntimeHandle::accounting_state`  (lines 122–124)

```
fn accounting_state(&self) -> Arc<GoalAccountingState>
```

**Purpose**: Returns a shared reference to the accounting state for this goal runtime. Accounting state tracks what progress has already been counted so time or tokens are not counted twice.

**Data flow**: It clones the shared pointer to the accounting state. This gives the caller another safe handle to the same underlying accounting object.

**Call relations**: The active and idle progress accounting functions call this before taking an accounting permit and reading progress snapshots.

*Call graph*: called by 2 (account_active_goal_progress, account_idle_goal_progress); 1 external calls (clone).


##### `GoalRuntimeHandle::goal_state_permit`  (lines 126–132)

```
async fn goal_state_permit(&self) -> Result<SemaphorePermit<'_>, String>
```

**Purpose**: Waits for permission to perform a goal-state operation that must not overlap with another one. The permit acts like a single-person checkout key for goal changes.

**Data flow**: It waits on the internal semaphore, which is a lock-like counter. If it gets the permit, it returns it; if the semaphore is closed, it returns the error as text.

**Call relations**: GoalRuntimeHandle::continue_if_idle and GoalRuntimeHandle::stop_active_goal_for_turn use this to keep read-update-start sequences from interleaving with external goal changes.

*Call graph*: called by 2 (continue_if_idle, stop_active_goal_for_turn).


##### `GoalRuntimeHandle::prepare_external_goal_mutation`  (lines 134–157)

```
async fn prepare_external_goal_mutation(&self) -> Result<(), String>
```

**Purpose**: Records any goal progress before outside code changes the goal. This prevents progress made under the old goal from being lost or accidentally charged to the new goal.

**Data flow**: It first checks whether goals are enabled. If a turn is currently active, it accounts progress for that turn; otherwise it accounts idle progress. It uses a generated event id so any resulting update can be traced back to this external mutation.

**Call relations**: This function calls GoalRuntimeHandle::account_active_goal_progress or GoalRuntimeHandle::account_idle_goal_progress depending on whether there is a current turn. It is meant to run just before an external set or clear operation changes stored goal state.

*Call graph*: calls 3 internal fn (account_active_goal_progress, account_idle_goal_progress, is_enabled); 1 external calls (format!).


##### `GoalRuntimeHandle::apply_external_goal_set`  (lines 159–223)

```
async fn apply_external_goal_set(
        &self,
        goal: codex_state::ThreadGoal,
        previous_goal: Option<PreviousGoalSnapshot>,
    ) -> Result<(), String>
```

**Purpose**: Updates runtime side effects after an external caller sets or replaces a goal. It records creation, status changes, objective changes, accounting state, and possibly starts or steers work.

**Data flow**: It receives the new stored goal and an optional snapshot of the previous goal. It compares old and new ids, statuses, and objective text; records metrics and analytics; updates which goal is considered active; sends steering text into a running turn if the objective changed; and may start continuation work if the goal is active and idle.

**Call relations**: After checking GoalRuntimeHandle::is_enabled, it uses objective_updated_steering_item and protocol_goal_from_state when it needs to tell a running turn about a changed objective. It calls GoalRuntimeHandle::inject_active_turn_steering for active turns and GoalRuntimeHandle::continue_if_idle when an active goal should keep going without user input.

*Call graph*: calls 5 internal fn (continue_if_idle, inject_active_turn_steering, is_enabled, objective_updated_steering_item, protocol_goal_from_state).


##### `GoalRuntimeHandle::apply_external_goal_clear`  (lines 225–236)

```
async fn apply_external_goal_clear(
        &self,
        goal: codex_state::ThreadGoal,
    ) -> Result<(), String>
```

**Purpose**: Updates runtime side effects after an external caller clears a goal. It records that the goal was cleared and stops treating any goal as active.

**Data flow**: It receives the goal that was cleared. If goals are enabled, it sends a clear event to analytics and clears the active-goal marker in accounting state. It returns success or does nothing if disabled.

**Call relations**: This is a companion to external goal mutation paths. It relies on GoalRuntimeHandle::is_enabled to decide whether clearing should affect runtime bookkeeping.

*Call graph*: calls 1 internal fn (is_enabled).


##### `GoalRuntimeHandle::usage_limit_active_goal_for_turn`  (lines 238–241)

```
async fn usage_limit_active_goal_for_turn(&self, turn_id: &str) -> Result<(), String>
```

**Purpose**: Stops the active goal for a turn because the turn hit a usage limit. This is a convenience wrapper with a specific stop reason.

**Data flow**: It receives a turn id and passes it along with the UsageLimit reason. The result is whatever the shared stopping routine returns.

**Call relations**: It delegates to GoalRuntimeHandle::stop_active_goal_for_turn, which contains the full logic for accounting progress, changing goal status, recording analytics, and emitting an update.

*Call graph*: calls 1 internal fn (stop_active_goal_for_turn).


##### `GoalRuntimeHandle::stop_active_goal_for_turn`  (lines 244–333)

```
async fn stop_active_goal_for_turn(
        &self,
        turn_id: &str,
        reason: ActiveGoalStopReason,
    ) -> Result<(), String>
```

**Purpose**: Finishes accounting for an active goal and marks it stopped after a turn error or usage limit. This keeps the stored goal status honest when a turn cannot continue normally.

**Data flow**: It receives a turn id and a reason. If goals are enabled and that turn is still the current active goal, it locks goal state, accounts progress, reads the stored goal, decides whether it can be stopped, updates its status to Blocked or UsageLimited, records metrics and analytics, clears active accounting, converts the goal to protocol form, and emits an update event.

**Call relations**: GoalRuntimeHandle::usage_limit_active_goal_for_turn calls this for usage-limit stops. Internally it uses GoalRuntimeHandle::goal_state_permit to avoid races, GoalRuntimeHandle::account_active_goal_progress to count progress first, GoalRuntimeHandle::thread_id for storage access, and protocol_goal_from_state before notifying listeners.

*Call graph*: calls 5 internal fn (account_active_goal_progress, goal_state_permit, is_enabled, thread_id, protocol_goal_from_state); called by 1 (usage_limit_active_goal_for_turn); 2 external calls (Turn, format!).


##### `GoalRuntimeHandle::restore_after_resume`  (lines 335–357)

```
async fn restore_after_resume(&self) -> Result<(), String>
```

**Purpose**: Rebuilds in-memory goal tracking after a thread or process resumes. Stored state may still say a goal is active, so accounting needs to know that again.

**Data flow**: It checks whether goals are enabled, reads the current stored goal for this thread, and if that goal is active, marks it as an idle active goal and records a resume metric. If no active goal exists, it clears active accounting state.

**Call relations**: This function uses GoalRuntimeHandle::thread_id to read the right stored goal and GoalRuntimeHandle::is_enabled as its guard. It is part of restart or resume recovery rather than normal turn flow.

*Call graph*: calls 2 internal fn (is_enabled, thread_id).


##### `GoalRuntimeHandle::continue_if_idle`  (lines 359–415)

```
async fn continue_if_idle(&self) -> Result<(), String>
```

**Purpose**: Starts automatic goal work if the thread is idle and there is an active goal. This is how a goal can keep progressing without the user manually sending another message.

**Data flow**: It first checks whether goal tools are visible. Then it takes the goal-state permit, tries to reach the live thread through the thread manager, reads the stored goal, confirms it is active, creates a continuation steering item, and asks the thread to start a turn if it is idle. If no active goal turn actually starts, it clears active accounting.

**Call relations**: GoalRuntimeHandle::apply_external_goal_set calls this when a goal is active. This function uses GoalRuntimeHandle::tools_visible, GoalRuntimeHandle::goal_state_permit, GoalRuntimeHandle::thread_id, continuation_steering_item, and protocol_goal_from_state to safely bridge stored goal state into live thread work.

*Call graph*: calls 5 internal fn (goal_state_permit, thread_id, tools_visible, continuation_steering_item, protocol_goal_from_state); called by 1 (apply_external_goal_set); 2 external calls (debug!, vec!).


##### `GoalRuntimeHandle::inject_active_turn_steering`  (lines 417–429)

```
async fn inject_active_turn_steering(&self, item: ResponseItem)
```

**Purpose**: Sends a steering item into a currently running turn, if one exists. In plain terms, it tries to whisper updated goal guidance to work that is already in progress.

**Data flow**: It receives a ResponseItem containing the guidance. It tries to upgrade the weak thread-manager link, finds the live thread, and asks that thread to inject the item only if a turn is running. If any of those steps fail, it logs a debug message and changes nothing.

**Call relations**: GoalRuntimeHandle::apply_external_goal_set calls this when an active goal’s objective changed during a current turn. The steering item itself is prepared before this function is called.

*Call graph*: called by 1 (apply_external_goal_set); 2 external calls (debug!, vec!).


##### `GoalRuntimeHandle::account_active_goal_progress`  (lines 431–492)

```
async fn account_active_goal_progress(
        &self,
        turn_id: &str,
        event_id: &str,
        mode: codex_state::GoalAccountingMode,
        budget_limited_goal_disposition: BudgetLimit
```

**Purpose**: Counts time and token usage for a goal that is tied to an active turn. This makes budget limits and progress reporting reflect what actually happened during that turn.

**Data flow**: It receives a turn id, an event id, an accounting mode, and instructions for what to do if the goal becomes budget-limited. It takes an accounting permit, reads a progress snapshot for the turn, checks the previous goal status, writes the time and token deltas to goal storage, records metrics and analytics if the goal changed, updates accounting state, emits a thread-goal update, and returns the accounted protocol goal plus its id. If there is no snapshot or no storage change, it returns no progress.

**Call relations**: GoalRuntimeHandle::prepare_external_goal_mutation calls this before outside goal edits when a turn is active. GoalRuntimeHandle::stop_active_goal_for_turn calls it before stopping a goal. It uses GoalRuntimeHandle::accounting_state, GoalRuntimeHandle::current_goal_status_for_metrics, GoalRuntimeHandle::thread_id, and protocol_goal_from_state.

*Call graph*: calls 4 internal fn (accounting_state, current_goal_status_for_metrics, thread_id, protocol_goal_from_state); called by 2 (prepare_external_goal_mutation, stop_active_goal_for_turn); 1 external calls (Turn).


##### `GoalRuntimeHandle::account_idle_goal_progress`  (lines 494–556)

```
async fn account_idle_goal_progress(
        &self,
        event_id: &str,
        mode: codex_state::GoalAccountingMode,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
    )
```

**Purpose**: Counts elapsed time for an active goal while no turn is running. This matters because a goal can spend time in an idle active state before the next turn begins or before an external change happens.

**Data flow**: It receives an event id, an accounting mode, and instructions for budget-limited goals. It takes an accounting permit, reads the idle progress snapshot, checks the previous goal status, writes the time delta to goal storage with zero token usage, records metrics and analytics if the goal changed, updates idle accounting state, emits a thread-goal update, and returns the accounted protocol goal plus its id. If storage says nothing changed, it resets the idle baseline and clears the active goal.

**Call relations**: GoalRuntimeHandle::prepare_external_goal_mutation calls this when there is no current turn. It uses GoalRuntimeHandle::accounting_state, GoalRuntimeHandle::current_goal_status_for_metrics, GoalRuntimeHandle::thread_id, and protocol_goal_from_state to keep idle accounting consistent with stored goal state.

*Call graph*: calls 4 internal fn (accounting_state, current_goal_status_for_metrics, thread_id, protocol_goal_from_state); called by 1 (prepare_external_goal_mutation).


##### `GoalRuntimeHandle::current_goal_status_for_metrics`  (lines 558–574)

```
async fn current_goal_status_for_metrics(
        &self,
        expected_goal_id: Option<&str>,
    ) -> Result<Option<codex_state::ThreadGoalStatus>, String>
```

**Purpose**: Looks up the current stored goal status so metrics can tell whether a later operation changed it. It also protects against comparing the wrong goal by checking an expected goal id when one is provided.

**Data flow**: It receives an optional expected goal id. It reads the current stored goal for this thread and returns its status only if there is no expected id or the stored goal’s id matches that expected id. Otherwise it returns no status.

**Call relations**: Both active and idle progress accounting call this before writing usage changes. They use the returned “before” status to decide whether terminal-status metrics and status-change analytics should be recorded.

*Call graph*: calls 1 internal fn (thread_id); called by 2 (account_active_goal_progress, account_idle_goal_progress).


### `ext/goal/src/api.rs`

`domain_logic` · `request handling`

A “thread goal” is the task or objective attached to a conversation thread, along with its status and optional token budget. This file gives the rest of the system one safe place to change that goal. Without it, callers could update the database while a live runtime was still acting on old goal information, like changing a train’s destination while the driver is already leaving the station.

The main type is `GoalService`. It can fetch a goal, set or update one, clear one, and remember which live `GoalRuntimeHandle` belongs to each thread. The runtime map uses weak references, meaning it does not keep runtimes alive by itself; it only points to them if they still exist.

When setting a goal, the service first trims and validates the new objective, checks the token budget, and translates protocol-facing status values into state-database values. If a runtime is active, it takes a permit, which is a guard that prevents the runtime from starting work based on goal state that is about to change. Then it writes the new goal to the database. If this is a new objective, it may also fill in a thread preview. The returned `GoalSetOutcome` can later apply side effects to the runtime, such as telling it the externally changed goal is now in effect.

Clearing follows the same careful pattern: pause conflicting runtime work, delete the saved goal, then notify the runtime if one exists.

#### Function details

##### `GoalServiceError::fmt`  (lines 27–31)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This turns a `GoalServiceError` into a readable message. It lets errors from this service be printed or logged as plain text instead of as raw enum data.

**Data flow**: It receives an error value and a formatter to write into. It chooses the message stored inside either error kind and writes that message into the formatter. The result is standard formatting success or failure from the write operation.

**Call relations**: This is used by Rust’s normal display machinery whenever code wants to show a `GoalServiceError` to a person or log. It delegates the actual text writing to the formatter’s `write_str` method.

*Call graph*: 1 external calls (write_str).


##### `GoalSetOutcome::apply_runtime_effects`  (lines 64–72)

```
async fn apply_runtime_effects(&self, goal_service: &GoalService)
```

**Purpose**: This applies the live runtime side effects after a goal has already been saved. It is separated from the database write so the service can return the saved result while still letting the runtime react to the change.

**Data flow**: It reads the thread id and saved state goal stored in the outcome, then asks the `GoalService` for the runtime for that thread. If a runtime exists, it sends the new goal and the previous-goal snapshot to the runtime. It returns nothing; if the runtime update fails, it logs a warning instead of undoing the saved database change.

**Call relations**: After `GoalService::set_thread_goal` creates a `GoalSetOutcome`, callers can invoke this function to notify the active runtime. It uses `GoalService::runtime_for_thread` to find that runtime, clones the stored goal data so it can pass owned values onward, and warns if the runtime cannot apply the update.

*Call graph*: calls 1 internal fn (runtime_for_thread); 2 external calls (clone, warn!).


##### `GoalService::new`  (lines 81–83)

```
fn new() -> Self
```

**Purpose**: This creates an empty `GoalService`. Use it when starting the goal subsystem or tests that need a fresh service.

**Data flow**: It takes no input. It builds the default service state, which starts with an empty runtime registry. It returns the new service.

**Call relations**: Startup and tests call this when they need a service object, including the constructors and test flows shown in the call graph. Internally it simply relies on the type’s default setup.

*Call graph*: called by 4 (new, new, goal_service_sets_gets_and_clears_thread_goal, installed_tools_with_start); 1 external calls (default).


##### `GoalService::get_thread_goal`  (lines 85–96)

```
async fn get_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        thread_id: ThreadId,
    ) -> Result<Option<ThreadGoal>, GoalServiceError>
```

**Purpose**: This reads the current saved goal for one thread. It is the safe read path for callers that need to know what objective, status, or budget a thread currently has.

**Data flow**: It receives the state database and a thread id. It asks the database’s thread-goal storage for that thread’s goal. If one exists, it converts the database version into the protocol version used by API callers; if none exists, it returns `None`. Database failures become an internal service error with a readable message.

**Call relations**: This function sits at the boundary between callers and the state database. It reaches into `thread_goals` storage to read the saved value, then hands back a protocol-shaped `ThreadGoal` so callers do not need to know the database’s internal shape.

*Call graph*: calls 1 internal fn (thread_goals).


##### `GoalService::set_thread_goal`  (lines 98–237)

```
async fn set_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        request: GoalSetRequest<'_>,
    ) -> Result<GoalSetOutcome, GoalServiceError>
```

**Purpose**: This creates or updates a thread goal in a careful, validated way. It protects against bad input and against races with a live runtime that may be acting on the same goal.

**Data flow**: It receives the state database and a request containing the thread id, whether to keep or set the objective, an optional status, and whether to keep or set the token budget. It trims and validates a new objective, validates any changed budget, converts status into the database format, and looks for a live runtime. If a runtime exists, it takes a permit and asks the runtime to prepare for an outside mutation. It then either updates an existing goal, creates a replacement goal, or rejects a status/budget-only update when no goal exists. Finally, it may fill an empty thread preview and returns a `GoalSetOutcome` containing both the protocol-facing goal and the state needed for runtime follow-up.

**Call relations**: This is the main write path for goal updates. It uses `runtime_for_thread` before touching the database so runtime work does not race with the change. It calls validation helpers before writing, uses `thread_goals` storage to read and write, converts the saved goal with `protocol_goal_from_state`, and leaves runtime notification to `GoalSetOutcome::apply_runtime_effects`.

*Call graph*: calls 7 internal fn (runtime_for_thread, from, fill_empty_thread_preview_if_possible, protocol_goal_from_state, validate_goal_budget, validate_thread_goal_objective, thread_goals); 1 external calls (warn!).


##### `GoalService::clear_thread_goal`  (lines 239–280)

```
async fn clear_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        thread_id: ThreadId,
    ) -> Result<bool, GoalServiceError>
```

**Purpose**: This removes the saved goal for a thread. It also tells any live runtime that the goal was cleared, so the runtime does not keep following a goal that no longer exists.

**Data flow**: It receives the state database and a thread id. It looks up the runtime for that thread, takes a goal-state permit if possible, and asks the runtime to prepare for the external change. It deletes the goal from the database and records whether anything was actually removed. After releasing the permit and runtime reference, it looks up the runtime again and, if both a runtime and deleted goal exist, sends the clear event to the runtime. It returns `true` if a goal was deleted and `false` if there was nothing to clear.

**Call relations**: This is the clear/delete counterpart to `set_thread_goal`. It uses `runtime_for_thread` to coordinate with live work, uses `thread_goals` storage to delete the saved goal, and logs warnings if runtime preparation or runtime notification fails.

*Call graph*: calls 2 internal fn (runtime_for_thread, thread_goals); 1 external calls (warn!).


##### `GoalService::register_runtime`  (lines 282–285)

```
fn register_runtime(&self, runtime: &Arc<GoalRuntimeHandle>)
```

**Purpose**: This records that a live goal runtime exists for a thread. It lets later goal changes find that runtime and coordinate with it.

**Data flow**: It receives a shared pointer to a `GoalRuntimeHandle`. It reads the runtime’s thread id, turns it into a map key, and stores a weak reference to the runtime in the service’s registry. The registry changes from not knowing about that runtime to being able to find it while it is still alive.

**Call relations**: Runtime setup code calls this when a runtime starts or becomes available. The function uses `runtimes` to lock the registry and stores a downgraded, weak pointer so the registry does not keep the runtime alive on its own.

*Call graph*: calls 1 internal fn (runtimes); 1 external calls (downgrade).


##### `GoalService::unregister_runtime`  (lines 287–297)

```
fn unregister_runtime(&self, runtime: &Arc<GoalRuntimeHandle>)
```

**Purpose**: This removes a runtime from the service’s registry when that exact runtime is no longer the active one for its thread. It avoids accidentally removing a newer runtime that may have been registered under the same thread id.

**Data flow**: It receives the runtime that is being shut down or detached. It makes the same map key from the thread id and compares the stored weak pointer with the weak pointer for this runtime. If they point to the same runtime, it removes the entry; otherwise it leaves the registry unchanged.

**Call relations**: Runtime teardown code calls this when a runtime should no longer receive goal updates. It locks the registry through `runtimes`, uses a weak pointer comparison to make sure it is removing the right runtime, and then cleans up the map entry only when safe.

*Call graph*: calls 1 internal fn (runtimes); 1 external calls (downgrade).


##### `GoalService::runtime_for_thread`  (lines 299–307)

```
fn runtime_for_thread(&self, thread_id: ThreadId) -> Option<Arc<GoalRuntimeHandle>>
```

**Purpose**: This finds the live runtime for a thread, if one still exists. It also cleans up stale registry entries whose runtime has already gone away.

**Data flow**: It receives a thread id and converts it into the string key used in the registry. It locks the runtime map, tries to upgrade the stored weak reference into a usable shared runtime pointer, and returns that pointer if the runtime is still alive. If the weak reference can no longer be upgraded, it removes the dead entry and returns `None`.

**Call relations**: `set_thread_goal`, `clear_thread_goal`, and `GoalSetOutcome::apply_runtime_effects` call this whenever they need to coordinate saved goal changes with a live runtime. It depends on `runtimes` for safe access to the shared registry.

*Call graph*: calls 1 internal fn (runtimes); called by 3 (clear_thread_goal, set_thread_goal, apply_runtime_effects); 1 external calls (to_string).


##### `GoalService::runtimes`  (lines 309–311)

```
fn runtimes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Weak<GoalRuntimeHandle>>>
```

**Purpose**: This safely opens the service’s runtime registry. The registry is protected by a mutex, which is a lock that stops two tasks from editing the map at the same time.

**Data flow**: It takes the service itself and locks the internal map from thread ids to weak runtime references. If the lock was previously poisoned, meaning another thread panicked while holding it, it still recovers the inner map instead of crashing here. It returns a guard object that allows temporary access to the map until the guard is dropped.

**Call relations**: `register_runtime`, `unregister_runtime`, and `runtime_for_thread` all go through this helper before reading or changing the registry. This keeps the locking behavior in one place and makes the rest of the service use the same recovery rule for poisoned locks.

*Call graph*: called by 3 (register_runtime, runtime_for_thread, unregister_runtime).


### `ext/mcp/src/executor_plugin.rs`

`orchestration` · `thread setup and MCP contribution discovery`

This file is a bridge between two parts of the system: executor plugins and MCP servers. An executor plugin is an add-on that can provide extra execution behavior. MCP, or Model Context Protocol, is a way for the app to talk to external tools and services through named servers. When a user has selected certain plugin-backed capabilities, this file discovers which MCP servers those plugins declare and presents them to the central MCP setup code.

A key idea here is the “snapshot.” The file builds a frozen list of MCP server declarations for the selected plugins and stores it in a OnceCell, which is a one-time storage slot. That means the list is resolved only once for a thread. This matters because reconnecting or refreshing a concrete environment should not change the logical authority of the selected plugin servers halfway through the run.

The contributor first looks up each selected plugin, then asks a provider to load that plugin’s MCP server definitions. Later, when contributions are requested, it applies the main configuration’s plugin-specific requirements, sorts server names for stable ordering, and returns structured MCP contributions. If a plugin cannot be resolved or its MCP declarations cannot be loaded, the file logs a warning and continues with the remaining plugins instead of failing everything.

#### Function details

##### `seed_thread_state`  (lines 35–37)

```
fn seed_thread_state(thread_init: &mut ExtensionDataInit)
```

**Purpose**: This function prepares per-thread storage for selected executor plugin MCP discovery. It adds an empty state object so later code has a safe place to cache the plugin MCP snapshot.

**Data flow**: It receives mutable thread initialization data. It creates the default SelectedExecutorPluginMcpState, which contains an empty one-time snapshot slot, and inserts it into the thread data. Nothing is returned, but the thread data is changed so later MCP contribution code can find this state.

**Call relations**: It is called by initialize_executor_plugin_thread_data during thread setup. The later contribute flow depends on this state being present; if it is missing, contribution logs a warning and returns no plugin MCP servers.

*Call graph*: calls 1 internal fn (insert); called by 1 (initialize_executor_plugin_thread_data); 1 external calls (default).


##### `SelectedExecutorPluginMcpContributor::new`  (lines 45–50)

```
fn new(environment_manager: Arc<EnvironmentManager>) -> Self
```

**Purpose**: This constructor builds the object that will later contribute MCP servers from selected executor plugins. It wires together the plugin resolver and the MCP declaration loader.

**Data flow**: It receives a shared EnvironmentManager, which represents access to plugin execution environments. It clones that shared pointer for the ExecutorPluginProvider, creates an ExecutorPluginMcpProvider, and returns a ready-to-use SelectedExecutorPluginMcpContributor.

**Call relations**: It is called by install_executor_plugins when the executor plugin MCP contributor is being installed. The returned contributor is later asked for its id and for MCP server contributions.

*Call graph*: calls 1 internal fn (new); called by 1 (install_executor_plugins); 1 external calls (clone).


##### `SelectedExecutorPluginMcpContributor::resolve_snapshot`  (lines 52–89)

```
async fn resolve_snapshot(
        &self,
        selected_roots: &[SelectedCapabilityRoot],
    ) -> Vec<SelectedPluginMcpServers>
```

**Purpose**: This function builds the frozen list of MCP server declarations for the currently selected plugin roots. It is the discovery step: find each selected plugin, load its declared MCP servers, and remember enough plugin identity information to label those servers later.

**Data flow**: It receives a list of selected capability roots. For each one, it asks the plugin provider to resolve the selected root into a bound plugin. If the plugin is found, it asks the MCP provider to load that plugin’s server configurations. Successful results are collected with the plugin id, display name, selection order, and server configs. Missing plugins or load errors are skipped after logging a warning. The result is a vector of selected plugin MCP server snapshots.

**Call relations**: It is used by contribute through the thread state’s OnceCell, so it normally runs only once for a thread. It calls into the plugin provider to resolve selections and into the MCP provider to load server declarations, then hands the completed snapshot back to the contribution-building step.

*Call graph*: calls 2 internal fn (resolve_bound, load); 3 external calls (new, iter, warn!).


##### `SelectedExecutorPluginMcpContributor::id`  (lines 93–95)

```
fn id(&self) -> &'static str
```

**Purpose**: This function gives this contributor a stable internal name. The system can use that name to identify which MCP contributor produced a set of server entries.

**Data flow**: It takes the contributor instance and returns the fixed text identifier "selected_executor_plugin_mcp". It does not read configuration or change any state.

**Call relations**: It is part of the McpServerContributor interface implementation. The broader MCP extension system can call it when registering or referring to this contributor.


##### `SelectedExecutorPluginMcpContributor::contribute`  (lines 97–138)

```
fn contribute(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>>
```

**Purpose**: This function turns the selected plugins’ MCP declarations into actual MCP server contributions. It is the main handoff from plugin discovery into the MCP server setup pipeline.

**Data flow**: It receives a contribution context, which may contain thread initialization data and the current configuration. It first looks for the selected capability roots and the cached plugin MCP state. If either is missing, it returns an empty list. Otherwise it gets or creates the frozen snapshot, applies configuration requirements for each plugin’s servers, sorts servers by name for stable output, and returns a list of SelectedPlugin MCP contributions. Each contribution includes the server name, plugin id, plugin display name, selection order, and server configuration.

**Call relations**: It is called by the MCP contribution system when it is collecting server definitions. If no snapshot exists yet, it calls resolve_snapshot through the OnceCell. It then asks the main config to apply plugin MCP requirements before handing back the final contributions to the MCP setup code.

*Call graph*: calls 2 internal fn (config, thread_init); 3 external calls (pin, new, warn!).


### `ext/skills/src/state.rs`

`domain_logic` · `cross-cutting during skill listing and skill reading`

The skills extension needs to remember a few things across requests: its current configuration, which workspace roots are allowed, whether orchestrator-provided skills are enabled, and what it has already learned from the orchestrator. This file is that memory box.

The main type, `SkillsThreadState`, is shared across parts of the extension. It stores the configuration behind a mutex, which is a lock that prevents two tasks from changing the same data at the same time. It also stores selected capability roots, meaning the parts of the user’s environment the extension is allowed to use.

The important extra behavior is caching. Orchestrator skills come from an external orchestrator source, possibly through MCP, which is a protocol for talking to external tools and resources. Fetching those skills can be expensive, so this file remembers one catalog snapshot and up to 100 read resources, with an 8 MB total content limit. Think of it like a small desk drawer: useful recent papers are kept nearby, but the drawer is not allowed to grow forever.

The cache is tied to the MCP resource client’s cache key. If that external resource context changes, the old cache is replaced so stale skills are not reused. Non-orchestrator skill reads skip this cache and go straight to the normal providers.

#### Function details

##### `SkillsThreadState::new`  (lines 35–46)

```
fn new(
        config: SkillsExtensionConfig,
        selected_roots: Vec<SelectedCapabilityRoot>,
        orchestrator_skills_enabled: bool,
    ) -> Self
```

**Purpose**: Creates the shared per-thread state for the skills extension. It records the starting configuration, the allowed roots, whether orchestrator skills are enabled, and starts with no orchestrator cache yet.

**Data flow**: It receives a `SkillsExtensionConfig`, a list of selected capability roots, and a true-or-false flag for orchestrator skills. It wraps the config in a lock, stores the roots and flag, creates an empty cache slot, and returns a ready-to-share `SkillsThreadState`.

**Call relations**: This is called when a thread starts and when configuration changes create fresh state. After it builds the state object, later skill-listing and skill-reading code use the methods on that object to get configuration and cached orchestrator data.

*Call graph*: called by 2 (on_config_changed, on_thread_start); 1 external calls (new).


##### `SkillsThreadState::config`  (lines 48–53)

```
fn config(&self) -> SkillsExtensionConfig
```

**Purpose**: Returns the current skills configuration as a safe copy. Code uses this when it needs to know how the skills extension is currently configured without taking ownership of the stored configuration.

**Data flow**: It locks the stored configuration, recovers even if a previous lock holder panicked, clones the configuration, and returns that clone. The original configuration remains stored in the state.

**Call relations**: Other parts of the skills extension can call this whenever they need the latest settings. It does not call out to other project logic; it simply reads from the protected state.


##### `SkillsThreadState::set_config`  (lines 55–60)

```
fn set_config(&self, config: SkillsExtensionConfig)
```

**Purpose**: Replaces the current skills configuration. This lets the thread state stay alive while its settings are updated.

**Data flow**: It receives a new `SkillsExtensionConfig`, locks the stored configuration, and overwrites the old value with the new one. It returns nothing, but the shared state is changed for future reads.

**Call relations**: Configuration-changing code uses this to update the state. Later calls to `SkillsThreadState::config` will see the new configuration.


##### `SkillsThreadState::selected_roots`  (lines 62–64)

```
fn selected_roots(&self) -> &[SelectedCapabilityRoot]
```

**Purpose**: Returns the selected capability roots stored for this thread. These roots describe the parts of the environment the skills extension is allowed to consider.

**Data flow**: It reads the list already stored inside `SkillsThreadState` and returns a borrowed view of it. Nothing is copied or changed.

**Call relations**: Other skills code can call this when deciding what roots are available. It is a simple accessor and does not hand work to other functions.


##### `SkillsThreadState::orchestrator_skills_enabled`  (lines 66–68)

```
fn orchestrator_skills_enabled(&self) -> bool
```

**Purpose**: Tells callers whether orchestrator-provided skills are enabled for this thread. This is a simple yes-or-no policy check.

**Data flow**: It reads the stored boolean flag and returns it. It does not change any state.

**Call relations**: Other parts of the skills extension can use this before trying to list or read orchestrator skills. It does not call other code.


##### `SkillsThreadState::orchestrator_catalog_snapshot`  (lines 70–85)

```
async fn orchestrator_catalog_snapshot(
        &self,
        mcp_resources: Option<&McpResourceClient>,
        initialize: impl Future<Output = Result<SkillCatalog, SkillProviderError>> + Send,
```

**Purpose**: Returns a cached snapshot of the orchestrator skill catalog, creating it once if needed. If catalog loading fails, it turns the failure into a catalog containing a warning instead of crashing the flow.

**Data flow**: It receives an optional MCP resource client and an async initializer that can produce a `SkillCatalog`. It finds the right orchestrator cache for that MCP context, asks the cache’s one-time cell for the catalog, and runs the initializer only if the catalog is not already stored. It returns a cloned catalog snapshot.

**Call relations**: This is called by `list_skills` when skills need to be listed. It first goes through `SkillsThreadState::orchestrator_cache` to get the correct cache generation, then either reuses the existing catalog or stores the initializer’s result for future calls.

*Call graph*: calls 1 internal fn (orchestrator_cache); called by 1 (list_skills).


##### `SkillsThreadState::read_skill`  (lines 87–117)

```
async fn read_skill(
        &self,
        providers: &SkillProviders,
        request: SkillReadRequest,
    ) -> SkillProviderResult<SkillReadResult>
```

**Purpose**: Reads a skill resource, using a small cache only for orchestrator resources. This avoids repeatedly fetching the same orchestrator skill content while leaving other skill sources to the normal provider path.

**Data flow**: It receives the skill providers and a read request. If the request is not for the orchestrator, it sends the request straight to the providers. If it is for the orchestrator, it builds a cache key from the request, checks the cache, and returns the cached result if found. Otherwise it reads from the providers, verifies the returned resource matches the requested one, stores it if the cache has room, and returns the result.

**Call relations**: This is called by `read_main_prompt` when a skill’s main prompt needs to be read. It uses `SkillReadCacheKey::from` to name the requested resource, uses `SkillsThreadState::orchestrator_cache` to find the right cache, and calls the providers’ `read` method only when the answer is not already cached or when the source is not the orchestrator.

*Call graph*: calls 3 internal fn (read, from, orchestrator_cache); called by 1 (read_main_prompt).


##### `SkillsThreadState::orchestrator_cache`  (lines 119–142)

```
fn orchestrator_cache(
        &self,
        mcp_resources: Option<&McpResourceClient>,
    ) -> Arc<OrchestratorGenerationCache>
```

**Purpose**: Finds or creates the cache used for the current orchestrator resource context. It makes sure cached data is reused only when it belongs to the same MCP resource client context.

**Data flow**: It receives an optional MCP resource client. From that client it derives a cache key, then locks the stored cache slot. If the existing cache has the same key, it returns that cache. If not, it creates a fresh cache with an empty catalog cell and empty resource map, stores it, and returns it.

**Call relations**: `orchestrator_catalog_snapshot` calls this before loading or reusing a catalog, and `read_skill` calls it before reading or caching resource content. This function is the gatekeeper that decides whether old orchestrator data is still valid or a new cache generation is needed.

*Call graph*: called by 2 (orchestrator_catalog_snapshot, read_skill); 5 external calls (clone, new, new, new, default).


##### `SkillReadCacheKey::from`  (lines 159–165)

```
fn from(request: &SkillReadRequest) -> Self
```

**Purpose**: Builds the cache key that identifies one skill resource read. The key combines the authority, package, and resource so the cache can tell different skill files apart.

**Data flow**: It receives a `SkillReadRequest`, copies the authority, package id, and resource id from it, and returns a `SkillReadCacheKey`. It ignores other request details that should not define the cached resource identity.

**Call relations**: `SkillsThreadState::read_skill` calls this before checking the orchestrator resource cache. The resulting key is then used by `OrchestratorResourceCache::get` and `OrchestratorResourceCache::insert`.

*Call graph*: called by 1 (read_skill).


##### `OrchestratorResourceCache::get`  (lines 175–177)

```
fn get(&self, key: &SkillReadCacheKey) -> Option<SkillReadResult>
```

**Purpose**: Looks up a previously cached orchestrator skill read. It returns a copy so callers can use the result without holding the cache lock longer than needed.

**Data flow**: It receives a cache key, checks the internal hash map for that key, clones the stored `SkillReadResult` if one exists, and returns either that result or nothing. The cache contents are not changed.

**Call relations**: `SkillsThreadState::read_skill` uses this after it has identified an orchestrator read request. If this function finds a match, the read finishes immediately without asking the providers again.


##### `OrchestratorResourceCache::insert`  (lines 179–197)

```
fn insert(&mut self, key: SkillReadCacheKey, result: SkillReadResult) -> SkillReadResult
```

**Purpose**: Adds an orchestrator skill read result to the cache, but only if doing so keeps the cache within its size limits. It protects the process from unbounded memory growth.

**Data flow**: It receives a cache key and a read result. If the key is already cached, it returns the existing cached result. Otherwise it measures the result’s content size, checks whether adding it would exceed 100 cached resources or 8 MB of content, and skips caching if the limits would be crossed. If there is room, it updates the byte count, stores a clone of the result, and returns the result.

**Call relations**: `SkillsThreadState::read_skill` calls this after a successful provider read for an orchestrator resource. This function is the final decision point for whether the freshly read content becomes reusable cache data or is simply returned once.

*Call graph*: 1 external calls (clone).


### `core/src/tools/handlers/new_context_window.rs`

`orchestration` · `tool invocation during request handling`

Large language model conversations have a limited “context window,” meaning only so much previous conversation can fit into the model’s working memory at once. This file provides a simple tool for starting a new window without first summarizing the old conversation. In everyday terms, it is like opening a fresh notebook page instead of trying to squeeze more notes into the margins.

The central piece is `NewContextWindowHandler`, which plugs into the project’s tool system. It tells the system the tool’s name, supplies the tool’s public description, and performs the action when the tool is called. When a call arrives, the handler first checks that it is the expected kind of tool request: a function payload, meaning a structured call from the model rather than some other kind of message. If the payload is wrong, it returns an error meant to be shown back to the model.

If the call is valid, the handler asks the current session to request a new context window. It then returns a small success message: “A new context window will start without summarizing conversation history.” The important behavior is that this tool deliberately does not summarize prior conversation. It is a direct reset request, not a compression or memory-saving step.

#### Function details

##### `NewContextWindowHandler::tool_name`  (lines 19–21)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the tool registry the exact name of the new-context-window tool. The name is how the rest of the system recognizes which handler should run when the model calls this tool.

**Data flow**: It takes no outside data beyond the handler itself. It reads the shared tool-name constant, wraps it as a plain `ToolName`, and returns that name to the registry.

**Call relations**: When the tool system is collecting or matching available tools, it calls this method to identify this handler. The method hands the constant name to `ToolName::plain`, which turns the raw name text into the standard tool-name type used elsewhere.

*Call graph*: calls 1 internal fn (plain).


##### `NewContextWindowHandler::spec`  (lines 23–25)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This provides the tool’s specification, which is the description the model and tool system use to understand how the tool can be called. Without this, the tool could have a name but no clear public shape or instructions.

**Data flow**: It takes no input other than the handler. It calls the helper that builds the new-context-window tool specification, then returns that specification to whoever is registering or exposing tools.

**Call relations**: During tool setup, the registry asks this handler for its spec. This method delegates the actual spec construction to `create_new_context_window_tool`, keeping this handler focused on connecting the spec to the executor.

*Call graph*: calls 1 internal fn (create_new_context_window_tool).


##### `NewContextWindowHandler::handle`  (lines 27–42)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: This runs the tool after the model asks for a new context window. It validates that the request is the expected structured function call, asks the session to start a new window, and sends back a simple success message.

**Data flow**: It receives a `ToolInvocation`, which includes the request payload and the current session. First it checks whether the payload is a function-style payload. If not, it returns an error message for the model. If it is valid, it asks the session to request a new context window, builds a text result saying what will happen, boxes that result into the standard tool-output form, and returns it asynchronously.

**Call relations**: The tool runtime calls this method when a model invocation has been matched to `NewContextWindowHandler`. Inside the asynchronous work, it uses the payload check to reject unsupported calls, uses `RespondToModel` for the error path, and uses `FunctionToolOutput::from_text` plus `boxed_tool_output` to produce the normal response that goes back through the tool system.

*Call graph*: calls 2 internal fn (from_text, boxed_tool_output); 3 external calls (pin, matches!, RespondToModel).


### `core/src/tools/handlers/plan.rs`

`orchestration` · `request handling`

This file is the bridge between a model saying “update my plan” and the application actually recording and showing that updated plan. Think of it like a receptionist for one specific form: it checks that the request is the right kind of form, makes sure it is allowed right now, reads the fields, and passes the completed form to the right office.

The main piece is `PlanHandler`, which registers the tool under the name `update_plan`, provides the tool’s specification, and runs the tool when the model calls it. When a call arrives, the handler only accepts normal function-style arguments. It refuses unsupported payloads with a message that can be sent back to the model. It also blocks use of `update_plan` while the session is in Plan mode, because this tool is meant for an execution checklist, not for the separate planning mode.

If the call is valid, the file parses the JSON arguments into `UpdatePlanArgs`, then sends a `PlanUpdate` event through the session. That event is what lets other parts of the system react, such as updating the user interface. The output object, `PlanToolOutput`, deliberately returns a simple success message: “Plan updated.” In code mode it returns an empty JSON object, because the important result is the side effect of updating the plan, not a large data payload.

#### Function details

##### `PlanToolOutput::log_preview`  (lines 25–27)

```
fn log_preview(&self) -> String
```

**Purpose**: Provides the short text shown in logs or previews after the plan tool succeeds. It keeps the visible summary simple: “Plan updated.”

**Data flow**: It takes no outside data from the tool result. It returns the fixed message used as the human-readable preview.

**Call relations**: After `PlanHandler::handle_call` finishes successfully, the surrounding tool system can ask this output object for a preview. This function supplies that preview without doing any further work.


##### `PlanToolOutput::success_for_logging`  (lines 29–31)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Tells the logging system that this tool result should be treated as a success. This matters because updating the plan is considered complete once the event has been sent.

**Data flow**: It reads no inputs and always returns `true`. Nothing else is changed.

**Call relations**: The tool framework can call this when recording the outcome of the `update_plan` call. It complements the simple success message produced by the other `PlanToolOutput` methods.


##### `PlanToolOutput::to_response_item`  (lines 33–41)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Builds the response item that goes back into the conversation after the tool call. It marks the function call as successful and includes the text “Plan updated.”

**Data flow**: It receives the tool call ID and the original payload, though it only needs the call ID. It creates a text output payload, marks it as successful, and wraps it in a response item tied to that call ID.

**Call relations**: Once the plan update has been accepted, the tool framework uses this to report the result back to the model. It uses `from_text` to create the plain text function-call output before returning it.

*Call graph*: calls 1 internal fn (from_text).


##### `PlanToolOutput::code_mode_result`  (lines 43–45)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Provides the result shape used when tools need to return machine-readable JSON in code-oriented flows. For this tool, there is no extra data to return, so it returns an empty JSON object.

**Data flow**: It receives the original payload but does not need it. It creates and returns an empty JSON object, changing nothing else.

**Call relations**: The broader tool system can ask every tool output for a code-mode result. Here, the plan update itself has already happened through the session event, so this function hands back only an empty placeholder object.

*Call graph*: 2 external calls (Object, new).


##### `PlanHandler::tool_name`  (lines 49–51)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Gives the tool registry the exact name users and the model use to call this tool: `update_plan`. Without this, the registry would not know which incoming tool call belongs to this handler.

**Data flow**: It takes no runtime input. It creates and returns a plain tool name containing `update_plan`.

**Call relations**: During tool registration or lookup, the core tool runtime asks the handler for its name. This function supplies that name using the shared `ToolName` helper.

*Call graph*: calls 1 internal fn (plain).


##### `PlanHandler::spec`  (lines 53–55)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of the `update_plan` tool: what it is called, what arguments it expects, and how the model should use it. This is like the instruction sheet attached to the tool.

**Data flow**: It reads no invocation-specific data. It calls the plan tool specification builder and returns the resulting tool specification.

**Call relations**: When the system advertises available tools to the model, it asks this handler for its specification. This function delegates that work to `create_update_plan_tool`, keeping the handler focused on execution.

*Call graph*: calls 1 internal fn (create_update_plan_tool).


##### `PlanHandler::handle`  (lines 57–59)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling an incoming `update_plan` invocation in the asynchronous tool system. Asynchronous means the work may wait for something, such as sending an event, without blocking the whole program.

**Data flow**: It receives a `ToolInvocation`, wraps the real handling work in a future, and returns that future to the tool framework. The invocation itself is passed through to `handle_call`.

**Call relations**: This is the public entry point required by the tool executor interface. The tool framework calls it when the model invokes `update_plan`, and it hands the actual work to `PlanHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `PlanHandler::handle_call`  (lines 63–96)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the real work of the `update_plan` tool call. It checks that the call is valid, blocks it in the wrong mode, parses the requested plan update, and sends the update event to the session.

**Data flow**: It receives the full tool invocation, including the session, current turn, and payload. It extracts JSON function arguments, rejects unsupported payloads, rejects calls made during Plan mode, parses the arguments into `UpdatePlanArgs`, sends a `PlanUpdate` event through the session, and returns a boxed `PlanToolOutput` on success. If something is wrong, it returns an error message meant for the model.

**Call relations**: `PlanHandler::handle` calls this whenever the `update_plan` tool is invoked. This function relies on `parse_update_plan_arguments` to turn raw JSON text into structured data, sends that data onward as a `PlanUpdate` event, and then uses `boxed_tool_output` so the common tool framework can treat the result like any other tool output.

*Call graph*: calls 2 internal fn (boxed_tool_output, parse_update_plan_arguments); called by 1 (handle); 2 external calls (PlanUpdate, RespondToModel).


##### `parse_update_plan_arguments`  (lines 101–105)

```
fn parse_update_plan_arguments(arguments: &str) -> Result<UpdatePlanArgs, FunctionCallError>
```

**Purpose**: Turns the raw JSON argument string from the model into a structured `UpdatePlanArgs` value that the rest of the system can trust. If the JSON is malformed or does not match the expected shape, it creates a clear error for the model.

**Data flow**: It receives a string containing the tool arguments. It tries to deserialize that string as `UpdatePlanArgs`; on success it returns the parsed plan update, and on failure it returns an error saying the function arguments could not be parsed.

**Call relations**: `PlanHandler::handle_call` uses this after it has confirmed the payload is the right kind and the current mode allows the tool. This helper keeps parsing and error wording separate from the larger tool-call flow.

*Call graph*: called by 1 (handle_call).


### TUI thread session state
These files define the TUI's canonical per-thread session snapshots, event buffers, and high-level flows for starting, switching, and rendering thread-backed sessions.

### `tui/src/session_state.rs`

`data_model` · `session lifecycle and settings updates`

The terminal UI needs a compact, reliable record of the current session so different parts of the app do not each invent their own version of reality. This file provides that record. Think of it like the label and clipboard attached to a workshop job: it says which job this is, which tools are being used, what safety rules apply, and which workbench folder is currently active.

The main type, `ThreadSessionState`, stores the session’s identity, optional fork information, model choice, approval and permission settings, current working directory, workspace roots, instruction files, reasoning settings, collaboration/personality options, message history summary, network proxy addresses, and rollout path. Most of these fields are plain stored facts used by app orchestration, chat display, and status widgets.

Two smaller types support it. `SessionNetworkProxyRuntime` records HTTP and SOCKS proxy addresses when the session is routed through a proxy. `MessageHistoryMetadata` records a lightweight summary of prior messages: a log id and how many entries it contains.

The one behavior in this file protects an important invariant when the current folder changes. If the old current folder was also an automatically implied workspace root, the method swaps that root to the new folder while preserving any other workspace roots. This keeps permission and workspace display logic aligned with where the session is now working.

#### Function details

##### `ThreadSessionState::set_cwd_retargeting_implicit_runtime_workspace_root`  (lines 60–76)

```
fn set_cwd_retargeting_implicit_runtime_workspace_root(
        &mut self,
        cwd: AbsolutePathBuf,
    )
```

**Purpose**: This method changes the session’s current working directory and, when appropriate, moves the matching implicit workspace root along with it. It is used so a session retargeted to a new folder does not keep treating the old folder as its automatic main workspace.

**Data flow**: It receives a new absolute folder path. First it swaps the session’s stored `cwd` to that new path and keeps the previous folder for comparison. If the previous folder was not in the workspace root list, it stops there. If the previous folder was a workspace root, it rebuilds the root list so the new folder replaces that old root, while all other unique roots are kept. The result is the same session state, updated in place, with its current folder and implied workspace root pointing at the new location.

**Call relations**: This method is called by `apply_thread_settings_to_session` when thread settings are applied to an existing session. In that bigger flow, the settings layer decides that the session should use a different folder, then hands the actual state correction to this method. Internally it uses standard library operations to swap the old value out, temporarily take the root list apart, and clone the new path where needed.

*Call graph*: called by 1 (apply_thread_settings_to_session); 3 external calls (replace, take, clone).


### `tui/src/app/thread_events.rs`

`domain_logic` · `cross-cutting: active during thread switching, background updates, replay, and request handling`

The TUI can show more than one conversation thread over time. When a user switches away from a thread, the server may still send updates for it, such as a tool approval request, a hook result, or a turn finishing. This file is the holding area for those updates. Think of it like a small inbox per thread: it stores the most recent events, remembers which prompts are still waiting for the user, and knows which turn is currently running.

The main piece is `ThreadEventStore`. It records the thread session, completed or in-progress turns, buffered events, pending interactive prompts, and the current text input state. When new notifications or requests arrive, the store updates its replay state and trims old buffered events if it reaches its capacity. It is careful not to replay approval or input requests after they have already been answered or resolved.

The store can also make a `ThreadEventSnapshot`, which is used to rebuild the chat view when the user returns to a thread. During a session refresh, it keeps only events that still matter after the server sends fresh thread history, such as pending requests, hook messages, MCP server status messages, and feedback results.

`ThreadEventChannel` wraps this store with a message channel, so events can be sent into a thread safely while the TUI later drains and replays them.

#### Function details

##### `ThreadEventStore::event_survives_session_refresh`  (lines 53–62)

```
fn event_survives_session_refresh(event: &ThreadBufferedEvent) -> bool
```

**Purpose**: Decides whether a buffered event should remain after the app refreshes a thread from the server. This prevents duplicated ordinary history while preserving events that are not safely reconstructed from the refreshed thread snapshot.

**Data flow**: It receives one buffered event, checks what kind of event it is, and returns true only for events that should be kept: server requests, hook start or completion messages, MCP server status updates, and feedback submissions. Other notifications and history responses are treated as replaceable by the refreshed session data.

**Call relations**: The refresh flow uses this rule through `ThreadEventStore::rebase_buffer_after_session_refresh`. It is the store's filter for deciding what remains in the small per-thread inbox after newer server state arrives.

*Call graph*: 1 external calls (matches!).


##### `ThreadEventStore::new`  (lines 64–75)

```
fn new(capacity: usize) -> Self
```

**Purpose**: Creates an empty event store for one thread. It sets up the thread's inbox, replay tracking, and current-turn tracking from a clean starting point.

**Data flow**: It receives a maximum buffer size. It creates a store with no session, no turns, an empty event queue, default pending-request replay state, no active turn, no saved input, the given capacity, and an inactive flag.

**Call relations**: This is the normal constructor used by channel setup and many tests. Other setup paths, such as `ThreadEventStore::new_with_session`, start here and then add known session and turn data.

*Call graph*: called by 23 (agent_status_uses_bounded_buffered_activity, agent_status_uses_reasoning_summaries_only, request_user_input_does_not_count_as_pending_thread_approval, thread_event_snapshot_drops_answered_request_user_input_for_multi_prompt_turn, thread_event_snapshot_drops_pending_approvals_when_turn_completes, thread_event_snapshot_drops_pending_requests_when_thread_closes, thread_event_snapshot_drops_resolved_elicitation_after_outbound_resolution, thread_event_snapshot_drops_resolved_exec_approval_after_outbound_approval_id, thread_event_snapshot_drops_resolved_exec_approval_after_server_resolution, thread_event_snapshot_drops_resolved_patch_approval_after_outbound_approval (+13 more)); 3 external calls (new, new, default).


##### `ThreadEventStore::new_with_session`  (lines 78–87)

```
fn new_with_session(
        capacity: usize,
        session: ThreadSessionState,
        turns: Vec<Turn>,
    ) -> Self
```

**Purpose**: Creates an event store that already knows about a thread session and its existing turns. This is useful when restoring or opening a thread that already has history.

**Data flow**: It receives a buffer capacity, a session description, and a list of turns. It first builds an empty store, then saves the session and calls `set_turns` so the active in-progress turn can be detected.

**Call relations**: It builds on `ThreadEventStore::new` and delegates turn setup to `ThreadEventStore::set_turns`. `ThreadEventChannel::new_with_session` uses it when creating a channel for an already-known thread.

*Call graph*: called by 2 (new_with_session, thread_event_store_restores_active_turn_from_snapshot_turns); 1 external calls (new).


##### `ThreadEventStore::set_session`  (lines 89–92)

```
fn set_session(&mut self, session: ThreadSessionState, turns: Vec<Turn>)
```

**Purpose**: Replaces the store's saved session and turn list with fresh information. This is used when the app installs or refreshes a snapshot for a side thread.

**Data flow**: It receives a session object and a list of turns. It stores the session, then passes the turns to `set_turns`, which also updates the cached active turn.

**Call relations**: The side-thread snapshot installation flow calls this when the TUI learns or refreshes a thread's state. It hands turn processing to `ThreadEventStore::set_turns` so active-turn tracking stays consistent.

*Call graph*: calls 1 internal fn (set_turns); called by 1 (install_side_thread_snapshot).


##### `ThreadEventStore::rebase_buffer_after_session_refresh`  (lines 94–96)

```
fn rebase_buffer_after_session_refresh(&mut self)
```

**Purpose**: Cleans the buffered event inbox after the app receives a refreshed thread session. It keeps only events that still need to be replayed on top of the refreshed history.

**Data flow**: It reads the store's buffered events and removes every event that `event_survives_session_refresh` says is no longer needed. The buffer becomes smaller and contains only refresh-safe events.

**Call relations**: This function applies the rule from `ThreadEventStore::event_survives_session_refresh`. It is part of the refresh story: first the app gets updated session history, then this store drops buffered events that the new history already covers.

*Call graph*: 1 external calls (retain).


##### `ThreadEventStore::set_turns`  (lines 98–105)

```
fn set_turns(&mut self, turns: Vec<Turn>)
```

**Purpose**: Stores the known turns for the thread and remembers which one, if any, is still running. This lets the TUI show correct activity state after loading a snapshot.

**Data flow**: It receives a list of turns. It scans from newest to oldest for a turn marked in progress, stores that turn's id as the active turn, and then replaces the store's turn list.

**Call relations**: `ThreadEventStore::set_session` and `ThreadEventStore::new_with_session` use this so any loaded thread history immediately refreshes active-turn tracking.

*Call graph*: called by 1 (set_session).


##### `ThreadEventStore::push_notification`  (lines 107–133)

```
fn push_notification(&mut self, notification: ServerNotification)
```

**Purpose**: Adds a server notification to the thread's buffer and updates state that depends on notifications. This is how background thread updates stay available for later replay.

**Data flow**: It receives a server notification. It first tells the pending replay tracker about it, then updates the active turn id for turn start, turn completion, or thread close messages. It appends the notification to the buffer, and if the buffer is too large, removes the oldest event and tells the replay tracker if that removed event was a request.

**Call relations**: Incoming server notifications flow into this store through the thread event system. It cooperates with the pending interactive replay state so resolved requests stop appearing, and with the bounded buffer so old events do not grow without limit.

*Call graph*: calls 2 internal fn (note_evicted_server_request, note_server_notification); 4 external calls (len, pop_front, push_back, Notification).


##### `ThreadEventStore::push_request`  (lines 135–146)

```
fn push_request(&mut self, request: ServerRequest)
```

**Purpose**: Adds a server request, such as an approval or input prompt, to the thread's buffer. It also records that the prompt may need to be replayed if the user returns to this thread.

**Data flow**: It receives a server request. It tells the pending replay tracker about the request, appends the request to the buffer, and trims the oldest buffered event if capacity is exceeded. If a removed event was also a request, it tells the replay tracker that the request was evicted.

**Call relations**: This is the request-side companion to `ThreadEventStore::push_notification`. It feeds the replay tracker so `snapshot` and `pending_replay_requests` can later show only still-pending prompts.

*Call graph*: calls 2 internal fn (note_evicted_server_request, note_server_request); 4 external calls (len, pop_front, push_back, Request).


##### `ThreadEventStore::pending_replay_requests`  (lines 148–165)

```
fn pending_replay_requests(&self) -> Vec<ServerRequest>
```

**Purpose**: Returns the server requests that are still waiting and should be replayed into the UI. It avoids bringing back prompts that the user already answered or that the server already resolved.

**Data flow**: It reads the buffered events, looks only at request events, asks the pending replay tracker whether each request should still be shown, clones the ones that qualify, and returns them as a list.

**Call relations**: Code that needs to know which prompts remain pending can call this instead of inspecting the raw buffer. It relies on the state maintained by `push_request`, `push_notification`, and `note_outbound_op`.

*Call graph*: 1 external calls (iter).


##### `ThreadEventStore::file_change_changes`  (lines 167–199)

```
fn file_change_changes(
        &self,
        turn_id: &str,
        item_id: &str,
    ) -> Option<Vec<codex_app_server_protocol::FileUpdateChange>>
```

**Purpose**: Finds the recorded file changes for a particular item in a particular turn. This lets the TUI recover the details behind a file-change entry even if it came from either buffered live events or saved turn history.

**Data flow**: It receives a turn id and an item id. It first searches recent buffered item-started and item-completed notifications from newest to oldest. If it does not find matching file changes there, it searches saved turns and their items from newest to oldest. It returns the matching change list if found.

**Call relations**: This function combines the live buffer and the stored turn snapshot into one lookup path. It uses `turn_id_matches` for flexible turn matching and `file_change_item_changes` to extract changes from a thread item.

*Call graph*: 1 external calls (iter).


##### `ThreadEventStore::apply_thread_rollback`  (lines 201–206)

```
fn apply_thread_rollback(&mut self, response: &ThreadRollbackResponse)
```

**Purpose**: Resets the store after the server rolls a thread back to an earlier state. This prevents stale buffered events or old pending prompts from surviving after history has been rewritten.

**Data flow**: It receives a rollback response from the server. It replaces the store's turns with the response's thread turns, clears the event buffer, resets pending replay tracking to its default empty state, and clears the active turn id.

**Call relations**: Rollback is a strong reset point. Instead of trying to merge old buffered events with rewritten history, this function discards local replay state and trusts the rollback response as the new source of truth.

*Call graph*: 2 external calls (clear, default).


##### `ThreadEventStore::snapshot`  (lines 208–229)

```
fn snapshot(&self) -> ThreadEventSnapshot
```

**Purpose**: Builds a replayable snapshot of the thread for rebuilding the chat view. It includes saved session and turn data, but filters request events so completed prompts do not reappear.

**Data flow**: It reads the store's session, turns, buffer, and input state. It clones the session and turns, filters buffered request events through the pending replay tracker, keeps all non-request buffered events, clones the saved input state, and returns a `ThreadEventSnapshot`.

**Call relations**: Thread switching uses this when a chat widget is rebuilt for another thread. It depends on replay state maintained by request, notification, and outbound-operation tracking.

*Call graph*: 1 external calls (iter).


##### `ThreadEventStore::note_outbound_op`  (lines 231–236)

```
fn note_outbound_op(&mut self, op: T)
```

**Purpose**: Tells the replay tracker that the user or app sent an operation outward to the server. Some outbound operations answer approvals or input prompts, so they can change what should be replayed later.

**Data flow**: It receives something that can be converted into an app command. It passes that command to the pending interactive replay state, which updates its record of which requests are still pending.

**Call relations**: When the active thread sends an operation, higher-level app code can call this so the store knows that a prompt may have been answered before a server resolution notification arrives.

*Call graph*: calls 1 internal fn (note_outbound_op).


##### `ThreadEventStore::op_can_change_pending_replay_state`  (lines 238–243)

```
fn op_can_change_pending_replay_state(op: T) -> bool
```

**Purpose**: Checks whether an outbound operation is the kind that could affect pending prompt replay. This lets callers avoid extra work for commands that cannot answer or resolve interactive requests.

**Data flow**: It receives something convertible into an app command. It asks the pending interactive replay logic whether that command type can change its state, then returns the answer as a boolean.

**Call relations**: Several higher-level flows use this before recording outbound operations, including feature flag updates, active-thread operation submission, and attempts to resolve app-server requests. It is a quick gate before calling deeper replay-state logic.

*Call graph*: calls 1 internal fn (op_can_change_state); called by 5 (sync_auto_review_runtime_state_from_effective_config, update_feature_flags, note_active_thread_outbound_op, submit_thread_op, try_resolve_app_server_request).


##### `ThreadEventStore::has_pending_thread_approvals`  (lines 245–248)

```
fn has_pending_thread_approvals(&self) -> bool
```

**Purpose**: Reports whether this thread still has approval prompts waiting for the user. The TUI can use this to show badges or warnings for inactive threads.

**Data flow**: It reads the pending interactive replay state and returns whether that state contains unresolved thread approval requests.

**Call relations**: This is a simple public-facing question over the replay tracker. `side_parent_pending_status` also uses the same underlying information when choosing what status to show.

*Call graph*: calls 1 internal fn (has_pending_thread_approvals).


##### `ThreadEventStore::side_parent_pending_status`  (lines 250–264)

```
fn side_parent_pending_status(&self) -> Option<SideParentStatus>
```

**Purpose**: Summarizes what kind of user attention a side thread needs. It distinguishes between needing typed input and needing an approval decision.

**Data flow**: It checks the pending replay state for waiting user input first. If found, it returns `NeedsInput`. Otherwise it checks for waiting approvals and returns `NeedsApproval`. If neither exists, it returns nothing.

**Call relations**: This turns detailed replay state into a compact status for side-thread UI. It prefers input over approval when both could be present, because input is checked first.

*Call graph*: calls 2 internal fn (has_pending_thread_approvals, has_pending_thread_user_input).


##### `ThreadEventStore::active_turn_id`  (lines 266–268)

```
fn active_turn_id(&self) -> Option<&str>
```

**Purpose**: Returns the id of the turn currently believed to be running. This helps the UI connect live updates to the active turn.

**Data flow**: It reads the store's cached active turn id and returns it as borrowed text if one exists. It does not change the store.

**Call relations**: The cached value is set by `set_turns` and updated by `push_notification`. Tests and UI logic use this accessor instead of reading the field directly.


##### `ThreadEventStore::clear_active_turn_id`  (lines 270–272)

```
fn clear_active_turn_id(&mut self)
```

**Purpose**: Forgets the currently cached active turn. This is useful when outside logic knows the active turn is no longer valid.

**Data flow**: It takes the store in its current state and sets the active turn id to empty. It returns no value.

**Call relations**: This is a manual reset alongside automatic resets from turn completion and thread close notifications in `push_notification`.


##### `turn_id_matches`  (lines 275–277)

```
fn turn_id_matches(request_turn_id: &str, candidate_turn_id: &str) -> bool
```

**Purpose**: Compares a requested turn id with a candidate turn id, with one special case: an empty requested id means 'match any turn.'

**Data flow**: It receives two text ids. It returns true if the requested id is empty or exactly equals the candidate id; otherwise it returns false.

**Call relations**: `ThreadEventStore::file_change_changes` uses this helper when searching buffered events and saved turns for file-change details.


##### `file_change_item_changes`  (lines 279–287)

```
fn file_change_item_changes(
    item: &ThreadItem,
    item_id: &str,
) -> Option<Vec<codex_app_server_protocol::FileUpdateChange>>
```

**Purpose**: Extracts file-change details from a thread item when the item has the requested id. It is a small helper for looking up what changed in a file operation.

**Data flow**: It receives a thread item and an item id. If the item is a file-change item with that id, it clones and returns its list of changes. For any other item or id, it returns nothing.

**Call relations**: `ThreadEventStore::file_change_changes` calls this repeatedly while scanning live buffered events and stored turn history.


##### `ThreadEventChannel::new`  (lines 298–306)

```
fn new(capacity: usize) -> Self
```

**Purpose**: Creates a live event channel and an empty store for one thread. The channel lets events be sent asynchronously while the store keeps replayable thread state.

**Data flow**: It receives a channel capacity. It creates a sender and receiver with that capacity, creates a shared mutex-protected `ThreadEventStore`, marks the attachment as live, and returns the assembled channel object. A mutex is a lock that stops two tasks from changing the store at the same time.

**Call relations**: Thread setup code uses this when creating local state for a new or newly opened thread. The channel owns both the transport path for buffered events and the shared store used for replay.

*Call graph*: calls 1 internal fn (new); called by 14 (discard_closed_side_thread_removes_local_state_without_server_rpc, enqueue_thread_event_does_not_block_when_channel_full, inactive_thread_approval_badge_clears_after_turn_completion_notification, inactive_thread_approval_bubbles_into_active_view, open_agent_picker_allows_existing_agent_threads_when_feature_is_disabled, open_agent_picker_clears_completed_path_backed_agent_running_state, open_agent_picker_keeps_missing_threads_for_replay, open_agent_picker_marks_loaded_threads_open, open_agent_picker_marks_terminal_read_errors_closed, open_agent_picker_preserves_cached_metadata_for_replay_threads (+4 more)); 3 external calls (new, new, channel).


##### `ThreadEventChannel::mark_replay_only`  (lines 308–310)

```
fn mark_replay_only(&mut self)
```

**Purpose**: Marks this channel as replay-only rather than live. This tells the rest of the app that the channel is attached only for rebuilding past state, not for normal live event flow.

**Data flow**: It changes the channel's attachment flag from its current value to `ReplayOnly`. It returns no value and does not touch the sender, receiver, or store.

**Call relations**: Higher-level thread switching or replay setup can call this when a channel should not be treated as an active live connection.


##### `ThreadEventChannel::attachment`  (lines 312–314)

```
fn attachment(&self) -> ThreadEventAttachment
```

**Purpose**: Reports whether the channel is live or replay-only. Callers use this to decide how to treat the channel.

**Data flow**: It reads the channel's attachment flag and returns a copy of that value. Nothing is changed.

**Call relations**: This is the read side of the flag set by `ThreadEventChannel::mark_replay_only` and initialized by the channel constructors.


##### `ThreadEventChannel::new_with_session`  (lines 317–331)

```
fn new_with_session(
        capacity: usize,
        session: ThreadSessionState,
        turns: Vec<Turn>,
    ) -> Self
```

**Purpose**: Creates a live event channel whose store already contains a known session and turn history. This is used when opening a thread that already exists instead of starting from a blank store.

**Data flow**: It receives a capacity, session, and turns. It creates a message channel, builds a shared locked `ThreadEventStore` using `ThreadEventStore::new_with_session`, marks the attachment as live, and returns the channel.

**Call relations**: This is the channel-level companion to `ThreadEventStore::new_with_session`. Tests and thread-loading flows use it when they need both event transport and restored thread state.

*Call graph*: calls 1 internal fn (new_with_session); called by 16 (active_turn_id_for_thread_uses_snapshot_turns, feedback_submission_for_inactive_thread_replays_into_origin_thread, inactive_thread_approval_badge_clears_after_turn_completion_notification, inactive_thread_approval_bubbles_into_active_view, inactive_thread_settings_notification_updates_cached_collaboration_mode, inactive_thread_started_notification_initializes_replay_session, inactive_thread_started_notification_preserves_primary_model_when_path_missing, refreshed_snapshot_session_persists_resumed_turns, replay_thread_snapshot_restores_draft_and_queued_input, replay_thread_snapshot_restores_pending_pastes_for_submit (+6 more)); 3 external calls (new, new, channel).


##### `tests::test_thread_session`  (lines 359–382)

```
fn test_thread_session(thread_id: ThreadId, cwd: PathBuf) -> ThreadSessionState
```

**Purpose**: Builds a realistic thread session object for tests. It saves each test from repeating a long set of required session fields.

**Data flow**: It receives a thread id and working directory path. It fills in a `ThreadSessionState` with test model, provider, approval, permission, path, and history settings, then returns it.

**Call relations**: Unit tests call this when they need a session for `ThreadEventStore::new_with_session` or `set_session`. It keeps the tests focused on event behavior rather than session construction details.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (abs, new, new).


##### `tests::test_turn`  (lines 384–395)

```
fn test_turn(turn_id: &str, status: TurnStatus, items: Vec<ThreadItem>) -> Turn
```

**Purpose**: Builds a test turn with a chosen id, status, and item list. This makes tests easy to read when they need completed or in-progress turns.

**Data flow**: It receives a turn id, a turn status, and thread items. It returns a `Turn` with those values and default empty timing and error fields.

**Call relations**: The notification builders and active-turn tests use this helper to create consistent turn data.


##### `tests::turn_started_notification`  (lines 397–405)

```
fn turn_started_notification(thread_id: ThreadId, turn_id: &str) -> ServerNotification
```

**Purpose**: Creates a test server notification saying a turn has started. It is used to verify that the store notices active turns.

**Data flow**: It receives a thread id and turn id. It builds an in-progress test turn, adds a start timestamp, wraps it in a turn-started notification, and returns it as a server notification.

**Call relations**: Tests such as `tests::thread_event_store_tracks_active_turn_lifecycle` and `tests::thread_event_store_clear_active_turn_id_resets_cached_turn` feed this into `push_notification`.

*Call graph*: 4 external calls (TurnStarted, new, to_string, test_turn).


##### `tests::turn_completed_notification`  (lines 407–420)

```
fn turn_completed_notification(
        thread_id: ThreadId,
        turn_id: &str,
        status: TurnStatus,
    ) -> ServerNotification
```

**Purpose**: Creates a test server notification saying a turn has completed or otherwise ended. It is used to check that active-turn tracking clears only for the matching turn.

**Data flow**: It receives a thread id, turn id, and final status. It builds a test turn with completion timing, wraps it in a turn-completed notification, and returns it.

**Call relations**: The active-turn lifecycle test sends these notifications after a start notification to confirm that unrelated turn completions do not clear the cached active turn.

*Call graph*: 4 external calls (TurnCompleted, new, to_string, test_turn).


##### `tests::hook_started_notification`  (lines 422–443)

```
fn hook_started_notification(thread_id: ThreadId, turn_id: &str) -> ServerNotification
```

**Purpose**: Creates a test notification for a hook run starting. A hook is extra configured work the app runs around events, such as checking a prompt before submission.

**Data flow**: It receives a thread id and turn id. It builds a hook summary marked as running, fills in test metadata and path information, wraps it in a hook-started notification, and returns it.

**Call relations**: The session-refresh tests use this helper to prove that hook start notifications survive buffer rebasing.

*Call graph*: 4 external calls (HookStarted, new, test_path_buf, to_string).


##### `tests::hook_completed_notification`  (lines 445–475)

```
fn hook_completed_notification(thread_id: ThreadId, turn_id: &str) -> ServerNotification
```

**Purpose**: Creates a test notification for a hook run finishing with warning and stop output. It lets tests check that detailed hook results are preserved through refresh.

**Data flow**: It receives a thread id and turn id. It builds a completed hook summary with timing and output entries, wraps it in a hook-completed notification, and returns it.

**Call relations**: `tests::thread_event_store_rebase_preserves_hook_notifications` uses this with the hook-start helper to verify both hook lifecycle messages remain in the snapshot.

*Call graph*: 4 external calls (HookCompleted, test_path_buf, to_string, vec!).


##### `tests::exec_approval_request`  (lines 477–502)

```
fn exec_approval_request(
        thread_id: ThreadId,
        turn_id: &str,
        item_id: &str,
        approval_id: Option<&str>,
    ) -> ServerRequest
```

**Purpose**: Creates a test server request asking for approval to run a command. It represents the kind of prompt that should remain pending until resolved or answered.

**Data flow**: It receives a thread id, turn id, item id, and optional approval id. It builds a command execution approval request with test command, path, reason, and request id, then returns it.

**Call relations**: The resolved-request refresh test pushes this into the store before sending a server resolution notification, proving answered requests are not replayed.

*Call graph*: 3 external calls (Integer, test_path_buf, to_string).


##### `tests::thread_event_store_tracks_active_turn_lifecycle`  (lines 505–526)

```
fn thread_event_store_tracks_active_turn_lifecycle()
```

**Purpose**: Tests that the store records a turn as active when it starts and clears it when that same turn completes. It also checks that completing a different turn does not clear the active one.

**Data flow**: The test creates an empty store, sends a turn-started notification, checks the active id, sends a completion for another turn, checks that the active id remains, then sends a completion for the original turn and checks that it clears.

**Call relations**: This test exercises `ThreadEventStore::new`, `ThreadEventStore::push_notification`, and `ThreadEventStore::active_turn_id` through the notification helper functions.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, turn_completed_notification, turn_started_notification).


##### `tests::thread_event_store_restores_active_turn_from_snapshot_turns`  (lines 529–544)

```
fn thread_event_store_restores_active_turn_from_snapshot_turns()
```

**Purpose**: Tests that active-turn state can be restored from saved turn history. This matters when a thread is loaded from a snapshot rather than receiving a fresh start notification.

**Data flow**: The test builds a session with one completed turn and one in-progress turn. It creates a store with that session and checks the active id, then creates a blank store, sets the same session and turns, and checks again.

**Call relations**: This test covers both `ThreadEventStore::new_with_session` and `ThreadEventStore::set_session`, which both rely on `set_turns` to find the in-progress turn.

*Call graph*: calls 3 internal fn (new, new, new_with_session); 4 external calls (assert_eq!, test_path_buf, test_thread_session, vec!).


##### `tests::thread_event_store_clear_active_turn_id_resets_cached_turn`  (lines 547–555)

```
fn thread_event_store_clear_active_turn_id_resets_cached_turn()
```

**Purpose**: Tests that the manual active-turn reset works. This protects cases where outside logic needs to clear cached running-turn state.

**Data flow**: The test creates a store, sends a turn-started notification so an active id is set, calls `clear_active_turn_id`, and verifies that no active turn remains.

**Call relations**: It directly checks `ThreadEventStore::clear_active_turn_id` after active-turn state has been created by `push_notification`.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_eq!, turn_started_notification).


##### `tests::thread_event_store_rebase_preserves_resolved_request_state`  (lines 558–579)

```
fn thread_event_store_rebase_preserves_resolved_request_state()
```

**Purpose**: Tests that a request resolved by the server does not come back after a session refresh. This prevents old approval prompts from reappearing to the user.

**Data flow**: The test creates a store, pushes an approval request, then pushes a server-request-resolved notification. After rebasing the buffer and taking a snapshot, it checks that the snapshot has no events and that no pending approvals remain.

**Call relations**: This test connects `push_request`, `push_notification`, `rebase_buffer_after_session_refresh`, `snapshot`, and `has_pending_thread_approvals` in the same sequence the app uses during refresh.

*Call graph*: calls 2 internal fn (new, new); 5 external calls (Integer, ServerRequestResolved, assert!, assert_eq!, exec_approval_request).


##### `tests::thread_event_store_rebase_preserves_hook_notifications`  (lines 582–610)

```
fn thread_event_store_rebase_preserves_hook_notifications()
```

**Purpose**: Tests that hook start and completion notifications survive a session refresh. Hook messages may not be reconstructed from ordinary thread history, so losing them would hide important status from the user.

**Data flow**: The test pushes a hook-started notification and a hook-completed notification, rebases the buffer, takes a snapshot, serializes the remaining notifications, and compares them with the expected hook notifications.

**Call relations**: It verifies the preservation rule implemented by `ThreadEventStore::event_survives_session_refresh` and applied by `rebase_buffer_after_session_refresh`.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, hook_completed_notification, hook_started_notification).


##### `tests::thread_event_store_rebase_preserves_mcp_startup_notifications`  (lines 613–637)

```
fn thread_event_store_rebase_preserves_mcp_startup_notifications()
```

**Purpose**: Tests that MCP server status updates survive a session refresh. MCP, or Model Context Protocol, server status tells the user whether an external context server started successfully or failed.

**Data flow**: The test creates an MCP server status notification, pushes it into the store, rebases the buffer, snapshots the store, and checks that exactly that notification remains.

**Call relations**: Like the hook preservation test, it confirms that `event_survives_session_refresh` keeps special status notifications when the buffer is cleaned after refresh.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (McpServerStatusUpdated, assert_eq!, panic!).


### `tui/src/app/thread_session_state.rs`

`domain_logic` · `thread switching, thread read, and settings changes`

A chat thread has more than just messages. It also has settings such as the model, service tier, working folder, approval rules, and file/network permission profile. This file is the bridge between the live user interface and the cached session records the app keeps for each thread. Without it, the app could resume a thread with stale permissions, the wrong service tier, or settings accidentally copied from another thread.

The main idea is simple: when the active thread’s settings change, update only the cached session for that active thread. The file checks the active thread id, updates the primary session if it is the active one, and also updates the thread’s shared event-store copy. That shared store is protected by a lock, meaning only one task can edit it at a time.

It also handles a special case: reading an existing thread from the server. A server thread record does not contain every local UI setting, so `session_state_for_thread_read` combines server-provided facts, such as thread name, folder, provider, and saved rollout path, with current UI settings, such as permissions. It deliberately clears thread-specific fields that should not leak across threads, like collaboration mode and personality. Tests in this file protect these details, especially that side threads are not rewritten by mistake.

#### Function details

##### `App::sync_active_thread_service_tier_to_cached_session`  (lines 11–33)

```
async fn sync_active_thread_service_tier_to_cached_session(&mut self)
```

**Purpose**: Copies the currently selected service tier from the chat widget into the cached session for the active thread. A service tier is the chosen speed or quality level for model service, so this keeps resume data matching what the user last selected.

**Data flow**: It starts with the app’s active thread id. If there is no active thread, it does nothing. It reads the current service tier from the chat widget, then writes that value into the primary cached session if the active thread is the primary thread, and into the active thread’s event-store session if one exists. The result is changed in-memory session state; it does not return a value.

**Call relations**: This is called when the app needs to preserve a service-tier change for the active conversation. It works directly with the chat widget as the source of truth and with the cached session records as the destination, so later thread resume or storage code sees the updated value.


##### `App::sync_active_thread_permission_settings_to_cached_session`  (lines 35–72)

```
async fn sync_active_thread_permission_settings_to_cached_session(&mut self)
```

**Purpose**: Copies the active thread’s approval and permission settings into its cached session. This matters because permissions control what the assistant may do, such as whether it can write files or needs user approval.

**Data flow**: It begins with the active thread id. If no thread is active, it stops. It reads approval policy and reviewer settings from the app config, and reads the current permission profile from the chat widget’s config view. It then writes those values into the primary session if the active thread is primary, and into the active thread’s stored session behind a lock. The output is updated cached session data for only the active thread.

**Call relations**: This function is used after permission-related settings change so the active thread’s snapshot stays current. It uses conversion from the configured approval policy into the app-server protocol format, then updates the same two places as the service-tier sync: the primary session cache and the thread event-channel store.

*Call graph*: calls 1 internal fn (from).


##### `App::session_state_for_thread_read`  (lines 74–132)

```
async fn session_state_for_thread_read(
        &self,
        thread_id: ThreadId,
        thread: &Thread,
    ) -> ThreadSessionState
```

**Purpose**: Builds a `ThreadSessionState` for a thread that has just been read from the server. It carefully mixes server facts with current local UI settings so the app can display or resume the thread without leaking settings from the wrong thread.

**Data flow**: It receives a thread id and a server `Thread` record. It first reads the currently active permission profile and active permission profile from the chat widget. If there is already a primary configured session, it uses that as a starting template, but clears thread-scoped fields when the requested thread is different. If there is no existing session, it creates a new session from app defaults, widget choices, config values, and fields from the server thread. Then it overwrites key facts with the server thread’s actual id, name, model provider, working directory, rollout path, and workspace-root behavior. Finally, it tries to read the saved model from the session database; if that cannot be found for a thread that has a path, it clears the model rather than guessing. It returns the completed session snapshot.

**Call relations**: This is called when the app receives or processes a `thread/read` result. It delegates permission lookup to `App::current_permission_profile` and `App::current_active_permission_profile`, and asks `read_session_model` to recover the model from saved session data when possible. The returned session is then suitable for the rest of the app to treat as the current state for that read thread.

*Call graph*: calls 4 internal fn (from, current_active_permission_profile, current_permission_profile, read_session_model); 1 external calls (new).


##### `App::current_permission_profile`  (lines 134–140)

```
fn current_permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the permission profile currently active in the chat widget. A permission profile is the set of rules that says what the assistant can access, such as read-only files or workspace write access.

**Data flow**: It reads the chat widget’s current config reference, asks it for the permission profile, clones that profile, and gives the clone back to the caller. Nothing else is changed.

**Call relations**: It is a small helper used by `App::session_state_for_thread_read` so that thread-read fallback sessions use the live UI permission settings, not possibly stale app defaults.

*Call graph*: called by 1 (session_state_for_thread_read).


##### `App::current_active_permission_profile`  (lines 142–147)

```
fn current_active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the named active permission profile, if there is one. This preserves not only the raw permission rules, but also which profile the UI considers selected.

**Data flow**: It reads the chat widget’s current config reference, asks for the active permission profile, and returns that optional value. It does not modify the app.

**Call relations**: It is called by `App::session_state_for_thread_read` alongside `App::current_permission_profile`, so a reconstructed session can remember both the rules and the selected profile identity.

*Call graph*: called by 1 (session_state_for_thread_read).


##### `tests::test_thread_session`  (lines 173–196)

```
fn test_thread_session(thread_id: ThreadId, cwd: PathBuf) -> ThreadSessionState
```

**Purpose**: Creates a simple test `ThreadSessionState` with predictable values. Tests use it as a clean starting point before changing only the fields relevant to each case.

**Data flow**: It takes a thread id and a working directory path. It builds a session with a test model, test provider, read-only permissions, no service tier, no message history, and absolute paths for the working folder and workspace roots. It returns that ready-made session to the test.

**Call relations**: The test cases call this helper to avoid repeating a large session setup. It relies on small constructors and path helpers, such as making paths absolute and creating default option-like values, so each test can focus on the behavior being checked.

*Call graph*: calls 1 internal fn (read_only); 4 external calls (abs, new, new, vec!).


##### `tests::permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread`  (lines 199–287)

```
async fn permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread()
```

**Purpose**: Checks that permission syncing updates the active main thread but leaves an inactive side thread untouched. This protects against a serious bug where changing one conversation’s permissions could silently rewrite another conversation’s cached settings.

**Data flow**: The test creates an app, a main thread session, and a side thread session with different permission settings. It marks the main thread as active, installs both sessions into their event channels, changes the app and widget permission choices, then calls the permission-sync function. It compares the resulting main cached session and main store session with the expected updated values, and also verifies the side thread still has its original session.

**Call relations**: This test drives `App::sync_active_thread_permission_settings_to_cached_session` in a realistic multi-thread setup. It uses app test support, thread-channel setup, permission-profile constructors, and assertions to prove the function updates only the active thread’s snapshots.

*Call graph*: calls 8 internal fn (new, allow_any, active, workspace_write, from_string, new, make_test_app, new_with_session); 4 external calls (new, assert_eq!, test_path_buf, test_thread_session).


##### `tests::permission_settings_sync_preserves_active_profile_only_rules`  (lines 290–353)

```
async fn permission_settings_sync_preserves_active_profile_only_rules()
```

**Purpose**: Checks that syncing permissions does not accidentally simplify or replace a custom permission profile. In plain terms, if the active rules include special file and network restrictions, those exact rules must survive the sync.

**Data flow**: The test builds a managed permission profile with restricted network access and explicit file-system rules, including read access to root and denial for `.env` patterns. It places that profile into a session, marks the thread active, changes the approval policy, and runs the permission-sync function. It then expects only the approval policy to change while the detailed permission profile remains the same.

**Call relations**: This test exercises `App::sync_active_thread_permission_settings_to_cached_session` with a detailed profile rather than a simple built-in one. It uses the same thread-channel storage path the real app uses, then checks both the primary session and stored session.

*Call graph*: calls 4 internal fn (allow_any, from_string, make_test_app, new_with_session); 5 external calls (new, assert_eq!, test_path_buf, test_thread_session, vec!).


##### `tests::service_tier_sync_updates_active_cached_session`  (lines 356–397)

```
async fn service_tier_sync_updates_active_cached_session()
```

**Purpose**: Checks that changing the chat widget’s service tier is reflected in the active thread’s cached session. The tested case clears a previously selected fast tier.

**Data flow**: The test creates an active thread session whose service tier is set to a fast value. It installs that session into the app and event channel, tells the chat widget to use no service tier, then calls the service-tier sync function. It expects both the primary cached session and the event-store session to show `None` for the service tier.

**Call relations**: This test directly exercises `App::sync_active_thread_service_tier_to_cached_session`. It sets up the same primary-session and event-channel locations that the production function updates, then verifies both are changed together.

*Call graph*: calls 3 internal fn (from_string, make_test_app, new_with_session); 4 external calls (new, assert_eq!, test_path_buf, test_thread_session).


##### `tests::thread_read_fallback_uses_active_permission_settings`  (lines 400–453)

```
async fn thread_read_fallback_uses_active_permission_settings()
```

**Purpose**: Checks that a session built from a server `thread/read` response uses the chat widget’s active permission settings. This prevents old app config defaults from overriding what the user is actually using.

**Data flow**: The test creates a primary session with workspace-write permissions and gives it to the chat widget. It then creates a separate server thread record to read. After calling `session_state_for_thread_read`, it compares the returned session’s permission profile with the widget’s current permission profile and confirms it is not merely the app config’s default profile.

**Call relations**: This test drives `App::session_state_for_thread_read`, which in turn uses `App::current_permission_profile` and `App::current_active_permission_profile`. The assertions protect the intended data path: live widget permissions should flow into read-thread session state.

*Call graph*: calls 3 internal fn (workspace_write, from_string, make_test_app); 5 external calls (new, assert_eq!, assert_ne!, test_path_buf, test_thread_session).


### `tui/src/app/loaded_threads.rs`

`domain_logic` · `thread resume or thread switching`

When the text user interface (TUI) opens an existing conversation, the server can tell it which threads are loaded, but only as one flat list. That is like receiving a pile of family records with no family tree drawn. This file rebuilds the relevant part of the family tree: starting from one primary thread, it looks for subagent threads that were spawned by it, then subagents spawned by those subagents, and so on.

The main work is done by `find_loaded_subagent_threads_for_primary`. It first converts thread IDs from strings into real `ThreadId` values, skipping any thread whose ID is invalid. Then it walks outward from the primary thread by following `ThreadSpawn` records that say “my parent thread is X.” The primary thread itself is not returned; only descendants are.

For each discovered subagent thread, the file keeps just the details the TUI needs later: the thread ID, optional nickname, optional role, and optional agent path. The final list is sorted by thread ID text so tests and cached navigation data stay predictable. There is no networking, disk access, or async work here. It is deliberately pure logic, which makes it easy to test and safe to reuse when the TUI resumes or switches threads.

#### Function details

##### `find_loaded_subagent_threads_for_primary`  (lines 47–96)

```
fn find_loaded_subagent_threads_for_primary(
    threads: Vec<Thread>,
    primary_thread_id: ThreadId,
) -> Vec<LoadedSubagentThread>
```

**Purpose**: Finds every loaded subagent thread that descends from a chosen primary thread. The TUI uses this so it can rebuild navigation and display information for subagents that already exist.

**Data flow**: It receives a flat list of server `Thread` records and the primary `ThreadId`. It converts each usable thread ID into a lookup table, starts with the primary thread as the first parent to inspect, and repeatedly finds threads whose spawn metadata names that parent. Each matching child is remembered and then inspected as a possible parent for further descendants. At the end, it turns the discovered thread IDs into `LoadedSubagentThread` records containing only the display/navigation metadata, sorts them for stable output, and returns that list.

**Call relations**: The test `tests::finds_loaded_subagent_tree_for_primary_thread` calls this function to prove it finds a child and grandchild while ignoring unrelated threads. During its walk, it asks `thread_spawn_parent_thread_id` to read the parent ID from each thread’s source metadata, and it uses `thread_spawn_agent_path` when building the final lightweight records.

*Call graph*: calls 2 internal fn (from_string, thread_spawn_parent_thread_id); called by 1 (finds_loaded_subagent_tree_for_primary_thread); 3 external calls (new, new, vec!).


##### `thread_spawn_agent_path`  (lines 98–105)

```
fn thread_spawn_agent_path(source: &SessionSource) -> Option<String>
```

**Purpose**: Extracts the agent path from a thread’s source information, but only when that source says the thread was created as a spawned subagent. The path is optional, so this returns nothing when the information is absent or the thread is not a spawned subagent.

**Data flow**: It receives a `SessionSource`, which describes where a thread came from. If that source is a subagent `ThreadSpawn`, it copies out the optional `agent_path` as a string. For any other source type, it returns `None`.

**Call relations**: This helper is used by `find_loaded_subagent_threads_for_primary` while building the final `LoadedSubagentThread` entries. It keeps the main tree-walking function from needing to know the exact shape of the source metadata.


##### `thread_spawn_parent_thread_id`  (lines 107–114)

```
fn thread_spawn_parent_thread_id(source: &SessionSource) -> Option<ThreadId>
```

**Purpose**: Reads the parent thread ID from a thread’s source information when the thread was created by spawning a subagent. This is the small helper that lets the tree walk follow parent-child links.

**Data flow**: It receives a `SessionSource`. If the source is a subagent `ThreadSpawn`, it returns the stored `parent_thread_id`. If the source is anything else, such as a normal command-line thread, it returns `None`.

**Call relations**: `find_loaded_subagent_threads_for_primary` calls this for each loaded thread while searching for children of the current parent. Without this helper, the main function could not tell which threads belong under the primary thread.

*Call graph*: called by 1 (find_loaded_subagent_threads_for_primary).


##### `tests::test_thread`  (lines 128–151)

```
fn test_thread(thread_id: ThreadId, source: SessionSource) -> Thread
```

**Purpose**: Builds a complete `Thread` value for tests while letting the test choose only the thread ID and source. This avoids repeating a long list of default fields in every test case.

**Data flow**: It receives a `ThreadId` and a `SessionSource`. It fills in the many required `Thread` fields with simple test defaults, such as empty preview text, idle status, a fake CLI version, and a `/tmp` working directory. It returns a ready-to-use `Thread` test object.

**Call relations**: `tests::finds_loaded_subagent_tree_for_primary_thread` calls this helper several times to create the primary thread, child thread, grandchild thread, and unrelated thread. The helper keeps the test focused on parent-child relationships instead of setup noise.

*Call graph*: 4 external calls (new, new, test_path_buf, to_string).


##### `tests::thread_spawn_source`  (lines 153–170)

```
fn thread_spawn_source(
        parent_thread_id: ThreadId,
        depth: i32,
        agent_nickname: &str,
        agent_role: &str,
    ) -> SessionSource
```

**Purpose**: Creates test source metadata that says a thread was spawned as a subagent from a particular parent thread. This gives tests realistic `SessionSource` data without hand-building the nested enum structure directly.

**Data flow**: It receives a parent `ThreadId`, a depth number, an agent nickname, and an agent role. It builds JSON shaped like the app server’s subagent spawn metadata, converts that JSON into a `SessionSource`, and returns it. If the JSON shape were invalid, the test would fail immediately.

**Call relations**: `tests::finds_loaded_subagent_tree_for_primary_thread` uses this helper to mark some test threads as spawned children. Those sources are later read by `find_loaded_subagent_threads_for_primary` through `thread_spawn_parent_thread_id`.

*Call graph*: 2 external calls (from_value, json!).


##### `tests::finds_loaded_subagent_tree_for_primary_thread`  (lines 173–231)

```
fn finds_loaded_subagent_tree_for_primary_thread()
```

**Purpose**: Checks the main tree-walking behavior with a small example: one primary thread, one child, one grandchild, and one unrelated child. It proves the file returns only the descendants of the chosen primary thread.

**Data flow**: It creates fixed thread IDs, builds test threads with appropriate source metadata, adds nicknames and roles to the relevant subagents, and passes all threads to `find_loaded_subagent_threads_for_primary`. It then compares the returned list with the expected child and grandchild records. The unrelated thread is expected to be left out.

**Call relations**: This test drives the public logic in the file. It relies on `tests::test_thread` for complete thread objects and `tests::thread_spawn_source` for spawn metadata, then uses an equality assertion to confirm the discovered subagent list is exactly right.

*Call graph*: calls 2 internal fn (from_string, find_loaded_subagent_threads_for_primary); 4 external calls (assert_eq!, test_thread, thread_spawn_source, vec!).


### `tui/src/app/session_lifecycle.rs`

`orchestration` · `session startup, resume, thread switching, and agent picker use`

This module is the traffic controller for conversations in the TUI, which is the text-based user interface. A session can be fresh, resumed from disk or server state, forked, or one of several subagent threads. This file decides how the app moves between those states without showing the wrong transcript or losing live updates.

The main idea is that the visible chat widget is only one view of a larger set of thread state. When the user opens the agent picker, the app first asks the server what threads are known and whether they are still running. It then builds a picker list, or shows helpful messages if there are no agents or collaboration is not enabled. When the user selects another agent, the app may attach to that live thread, or fall back to replaying saved turns if the thread is closed.

The file also resets local thread state when a new primary session starts, rebuilds the chat widget after resume or switch, clears the terminal so old text does not visually bleed into the next transcript, and preserves small UI details like agent names and terminal title. Think of it like changing train tracks: it must stop listening to the old track, connect to the new one, repaint the display, and make sure future signals arrive from the right place.

#### Function details

##### `App::open_agent_picker`  (lines 10–138)

```
async fn open_agent_picker(&mut self, app_server: &mut AppServerSession)
```

**Purpose**: Shows the user a list of available agent or subagent threads. Before showing the list, it refreshes what the app knows about those threads so the picker does not offer stale or misleading choices.

**Data flow**: It starts with the app's cached navigation state, local thread event channels, and fresh information from the app server. It fills in missing subagent data, checks whether threads are live or closed, and then either adds a running-agent status preview, opens a collaboration-enable prompt, shows a no-agents message, or displays a selectable list. The visible result is a picker or informational history entry in the chat widget.

**Call relations**: This is called when the user wants to choose an agent. It relies on backfill_loaded_subagent_threads to discover server-known subagents and refresh_agent_picker_thread_liveness to verify each thread's current state. It also uses picker and preview helpers to turn that state into UI rows.

*Call graph*: calls 6 internal fn (picker_subtitle, new, empty, from_store, backfill_loaded_subagent_threads, refresh_agent_picker_thread_liveness); 2 external calls (default, new).


##### `App::is_terminal_thread_read_error`  (lines 140–143)

```
fn is_terminal_thread_read_error(err: &color_eyre::Report) -> bool
```

**Purpose**: Decides whether a thread-read failure means the thread is truly gone or unavailable, rather than just temporarily failing. This matters because a permanent error should remove or close UI entries, while a temporary one should not.

**Data flow**: It receives an error report, walks through the chain of underlying causes, and searches for the specific text that says a thread was not loaded. It returns true when that permanent-looking message is found, otherwise false.

**Call relations**: Other lifecycle code calls this before deciding whether to remove a thread from the picker or mark it closed. The tests in this file check that it distinguishes a not-loaded thread from a transport problem such as a broken pipe.

*Call graph*: 1 external calls (chain).


##### `App::closed_state_for_thread_read_error`  (lines 145–150)

```
fn closed_state_for_thread_read_error(
        err: &color_eyre::Report,
        existing_is_closed: Option<bool>,
    ) -> bool
```

**Purpose**: Turns a failed thread read into a simple closed-or-not-closed decision. It preserves an existing closed state while also treating terminal not-loaded errors as closed.

**Data flow**: It receives an error and, optionally, the thread's previous closed flag. It checks whether the error is terminal; if so, the result is closed. If not, it keeps the previous closed value when present, or treats the thread as not closed by default.

**Call relations**: refresh_agent_picker_thread_liveness uses this when the server cannot read a thread. It builds directly on is_terminal_thread_read_error so all permanent-error detection stays consistent.

*Call graph*: 1 external calls (is_terminal_thread_read_error).


##### `App::can_fallback_from_include_turns_error`  (lines 152–158)

```
fn can_fallback_from_include_turns_error(err: &color_eyre::Report) -> bool
```

**Purpose**: Recognizes server errors where asking for a thread's full turns is not possible yet, but reading basic thread information is still safe. This lets the app recover gracefully instead of failing the whole selection.

**Data flow**: It receives an error report and scans all causes for messages about includeTurns being unavailable before the first user message or unsupported for ephemeral threads. It returns true only for those known fallback cases.

**Call relations**: attach_live_thread_for_selection uses this after a full thread read fails. The related test confirms both known messages are accepted as safe fallback situations.

*Call graph*: 1 external calls (chain).


##### `App::upsert_agent_picker_thread`  (lines 164–179)

```
fn upsert_agent_picker_thread(
        &mut self,
        thread_id: ThreadId,
        agent_nickname: Option<String>,
        agent_role: Option<String>,
        is_closed: bool,
    )
```

**Purpose**: Adds or updates one thread in the agent picker cache, including its nickname, role, and closed state. It also mirrors that display information into the chat widget so messages can show the right agent label.

**Data flow**: It receives a thread id, optional nickname, optional role, and closed flag. It writes the label data into the chat widget, updates the navigation cache, and then refreshes the active footer label. The app's in-memory view of the agent list is changed.

**Call relations**: backfill_loaded_subagent_threads calls it when discovering subagents from the server. refresh_agent_picker_thread_liveness calls it when a thread read confirms or updates the thread's state.

*Call graph*: called by 2 (backfill_loaded_subagent_threads, refresh_agent_picker_thread_liveness).


##### `App::mark_agent_picker_thread_closed`  (lines 185–188)

```
fn mark_agent_picker_thread_closed(&mut self, thread_id: ThreadId)
```

**Purpose**: Marks a known agent thread as closed without deleting it. This keeps finished transcripts reachable and keeps next/previous navigation stable.

**Data flow**: It receives a thread id, marks that entry closed in the navigation cache, and refreshes the active agent label shown by the UI. No server call is made.

**Call relations**: This is a small state-update helper for parts of the app that learn a thread has ended. It keeps the picker and footer consistent after that state change.


##### `App::refresh_agent_picker_thread_liveness`  (lines 190–254)

```
async fn refresh_agent_picker_thread_liveness(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> bool
```

**Purpose**: Asks the app server whether a thread is still active, closed, or unavailable, and updates the picker accordingly. This prevents the user from selecting a thread based on stale cached state.

**Data flow**: It receives the app server connection and a thread id. It reads the thread without loading all turns, then updates nickname, role, closed state, and running state. If the read fails, it decides whether to remove the thread, mark it closed, or keep it as a non-running cached entry. It returns true if the thread should remain visible and false if it was removed.

**Call relations**: open_agent_picker calls this while preparing the picker. select_agent_thread calls it before switching. It uses upsert_agent_picker_thread to keep UI metadata synchronized and the error-classification helpers to treat permanent and temporary failures differently.

*Call graph*: calls 2 internal fn (upsert_agent_picker_thread, thread_read); called by 2 (open_agent_picker, select_agent_thread); 3 external calls (closed_state_for_thread_read_error, is_terminal_thread_read_error, matches!).


##### `App::attach_live_thread_for_selection`  (lines 262–319)

```
async fn attach_live_thread_for_selection(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> Result<bool>
```

**Purpose**: Connects the TUI to a live agent thread when the user selects it but the app does not yet have local replay state for it. If live attachment fails, it tries to seed the view from saved thread turns when that is safe.

**Data flow**: It receives the app server and a thread id. If the app already has a channel for the thread, it returns success. Otherwise it tries to resume the thread live; if that fails, it tries to read the thread with turns, or reads only metadata for known fallback errors. It creates or fills the local thread channel with session and turn data, marks it replay-only when there is no live listener, and returns whether live attachment succeeded.

**Call relations**: select_agent_thread calls this only when a selected thread needs attaching. It hands off to the server through resume_thread or thread_read, and uses can_fallback_from_include_turns_error to decide when a lighter read is acceptable.

*Call graph*: calls 2 internal fn (resume_thread, thread_read); called by 1 (select_agent_thread); 4 external calls (can_fallback_from_include_turns_error, new, eyre!, warn!).


##### `App::replace_chat_widget`  (lines 327–346)

```
fn replace_chat_widget(&mut self, mut chat_widget: ChatWidget)
```

**Purpose**: Swaps in a new chat widget while preserving important UI context. This is needed because switching or resuming threads rebuilds the visible conversation area.

**Data flow**: It receives a newly created chat widget. It carries over the last terminal title if needed, copies the remote connection marker, reloads all known agent nickname and role metadata into the new widget, installs it as the active widget, and refreshes the active agent label.

**Call relations**: replace_chat_widget_with_app_server_thread uses this after creating a fresh widget for a resumed or new primary thread. select_agent_thread uses it when switching to another agent thread. It calls set_collab_agent_metadata so replayed collaboration messages can show names immediately.

*Call graph*: calls 1 internal fn (set_collab_agent_metadata); called by 2 (replace_chat_widget_with_app_server_thread, select_agent_thread).


##### `App::select_agent_thread`  (lines 348–443)

```
async fn select_agent_thread(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Switches the visible chat from the current thread to a selected agent thread. It makes sure the destination is still valid, attaches to it if necessary, rebuilds the UI, replays its transcript, and resumes event processing.

**Data flow**: It receives the terminal UI, the app server, and the target thread id. It ignores no-op selection, refreshes liveness, possibly attaches to the live thread, saves the current receiver, activates the target replay channel, refreshes the snapshot if needed, creates a new chat widget, clears the old terminal view, replays saved state, shows a replay-only notice if appropriate, drains pending events, and refreshes pending approvals. The active thread and visible transcript change.

**Call relations**: This is the central path after a picker item is chosen. It calls refresh_agent_picker_thread_liveness, should_attach_live_thread_for_selection, attach_live_thread_for_selection, replace_chat_widget, and reset_for_thread_switch to move safely from one thread to another.

*Call graph*: calls 5 internal fn (attach_live_thread_for_selection, refresh_agent_picker_thread_liveness, replace_chat_widget, reset_for_thread_switch, should_attach_live_thread_for_selection); 2 external calls (format!, new_with_app_event).


##### `App::should_attach_live_thread_for_selection`  (lines 445–451)

```
fn should_attach_live_thread_for_selection(&self, thread_id: ThreadId) -> bool
```

**Purpose**: Answers whether selecting a thread should first create a local live attachment. It avoids unnecessary work for threads the app already knows locally and avoids trying to attach closed threads.

**Data flow**: It receives a thread id and reads local maps only. It returns true when there is no existing event channel and the navigation entry is either missing or not marked closed.

**Call relations**: select_agent_thread asks this before calling attach_live_thread_for_selection. It acts as a simple gate so selection does not accidentally replace valid local state.

*Call graph*: called by 1 (select_agent_thread).


##### `App::reset_for_thread_switch`  (lines 453–458)

```
fn reset_for_thread_switch(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Cleans the UI state before showing a different thread. This prevents the previous transcript, scrollback, or queued history lines from visually mixing with the newly selected thread.

**Data flow**: It receives the terminal UI, resets transcript-related state inside the app, clears pending history lines in the TUI, and clears the terminal display. It returns success or an error if the terminal clear fails.

**Call relations**: select_agent_thread calls this after installing a new chat widget and before replaying the selected thread. It delegates the terminal-specific clearing to clear_terminal_for_thread_switch.

*Call graph*: called by 1 (select_agent_thread); 2 external calls (clear_terminal_for_thread_switch, clear_pending_history_lines).


##### `App::clear_terminal_for_thread_switch`  (lines 460–473)

```
fn clear_terminal_for_thread_switch(
        terminal: &mut crate::custom_terminal::Terminal<B>,
    ) -> Result<()>
```

**Purpose**: Clears both the visible terminal screen and its scrollback when changing threads. This gives the next transcript a clean display area.

**Data flow**: It receives a terminal object. It sends the terminal clear operation, then adjusts the viewport area back to the top if it had been offset. It returns success or the terminal error.

**Call relations**: reset_for_thread_switch calls this as the low-level terminal cleanup step. It works with terminal methods that clear ANSI screen state and update the viewport.

*Call graph*: calls 2 internal fn (clear_scrollback_and_visible_screen_ansi, set_viewport_area).


##### `App::reset_thread_event_state`  (lines 475–490)

```
fn reset_thread_event_state(&mut self)
```

**Purpose**: Drops all local knowledge about thread event channels and agent navigation before attaching to a new primary session. This prevents old listeners and cached agent entries from leaking into a new conversation.

**Data flow**: It stops all thread event listeners, clears channel maps, navigation state, side-thread state, active and primary thread ids, pending event queues, startup flags, and pending approvals. It then refreshes the active agent label so the UI no longer points at stale thread metadata.

**Call relations**: replace_chat_widget_with_app_server_thread calls this before installing a new primary server thread. It is the reset button for thread-related runtime state.

*Call graph*: called by 1 (replace_chat_widget_with_app_server_thread); 1 external calls (new).


##### `App::handle_startup_thread_started`  (lines 492–527)

```
async fn handle_startup_thread_started(
        &mut self,
        app_server: &mut AppServerSession,
        result: Result<AppServerStartedThread, String>,
    ) -> Result<()>
```

**Purpose**: Processes the result of an asynchronous startup thread creation. It either attaches the new primary session or cleans up a stale startup result that is no longer wanted.

**Data flow**: It receives the app server and either a started thread or an error string. If no startup is pending anymore, it unsubscribes from the started thread and discards local state. If startup is still pending, it clears the pending flag, lets queued submissions proceed, enqueues the primary session on success, sends any queued input, or returns an error on failure.

**Call relations**: This fits into app startup when thread creation finishes later than the UI setup. It calls thread_unsubscribe for stale results and enqueues the primary thread through other App methods when the result is still relevant.

*Call graph*: calls 1 internal fn (thread_unsubscribe); 2 external calls (eyre!, warn!).


##### `App::start_fresh_session_with_summary_hint`  (lines 529–595)

```
async fn start_fresh_session_with_summary_hint(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        session_start_source: Option<ThreadStartSource>,
```

**Purpose**: Starts a brand-new primary session while showing the user a helpful summary of the session they just left. It also preserves the ability to resume the old session later.

**Data flow**: It refreshes configuration from disk, remembers the current model, builds a fresh config, gathers token and resume-summary information from the current chat, shuts down the current thread, unsubscribes tracked threads, and asks the app server to start a new thread. On success it replaces the chat widget and may add summary or resume-hint lines; on failure it shows an error and restores the previous model. It schedules a new frame so the UI redraws.

**Call relations**: This is used when the user chooses to start over. It calls fresh_session_config to prepare settings, uses the server start call to create the thread, and then hands the result to replace_chat_widget_with_app_server_thread.

*Call graph*: calls 4 internal fn (fresh_session_config, replace_chat_widget_with_app_server_thread, start_thread_with_session_start_source, thread_unsubscribe); 5 external calls (new, frame_requester, format!, warn!, vec!).


##### `App::replace_chat_widget_with_app_server_thread`  (lines 597–618)

```
async fn replace_chat_widget_with_app_server_thread(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        started: AppServerStartedThread,
        initial_
```

**Purpose**: Installs a newly started, resumed, or forked app-server thread as the primary visible session. It resets old thread state, creates a new chat widget, attaches the session, and discovers related subagents.

**Data flow**: It receives the terminal UI, app server, started thread data, and an optional initial user message. It clears all previous thread event state, builds initialization data for a new chat widget, replaces the widget, enqueues the primary session and saved turns, then backfills loaded subagent threads. The active UI becomes tied to the provided server thread.

**Call relations**: start_fresh_session_with_summary_hint and resume_target_session both call this after the server gives them a thread. It uses reset_thread_event_state, replace_chat_widget, and backfill_loaded_subagent_threads as the main setup sequence.

*Call graph*: calls 3 internal fn (backfill_loaded_subagent_threads, replace_chat_widget, reset_thread_event_state); called by 2 (resume_target_session, start_fresh_session_with_summary_hint); 1 external calls (new_with_app_event).


##### `App::backfill_loaded_subagent_threads`  (lines 631–691)

```
async fn backfill_loaded_subagent_threads(
        &mut self,
        app_server: &mut AppServerSession,
    ) -> bool
```

**Purpose**: Finds subagent threads that already exist on the server but were not seen by this TUI while they were created. This is important after resume, fork, or reconnect, when local memory may be missing older spawn events.

**Data flow**: It starts from the current primary thread id. It asks the server for all loaded thread ids, converts them to thread ids, skips the primary thread, reads each remaining thread without turns, and collects successful reads. It then finds which loaded threads belong under the primary thread, registers them in the picker, stores their agent paths, refreshes the label, and returns whether all reads succeeded.

**Call relations**: open_agent_picker calls it before showing the picker, replace_chat_widget_with_app_server_thread calls it after attaching a primary session, and adjacent_thread_id_with_backfill calls it when keyboard navigation needs missing neighbors. It uses upsert_agent_picker_thread to write discovered metadata into both navigation state and the chat widget.

*Call graph*: calls 4 internal fn (from_string, upsert_agent_picker_thread, thread_loaded_list, thread_read); called by 3 (adjacent_thread_id_with_backfill, open_agent_picker, replace_chat_widget_with_app_server_thread); 2 external calls (new, warn!).


##### `App::adjacent_thread_id_with_backfill`  (lines 701–724)

```
async fn adjacent_thread_id_with_backfill(
        &mut self,
        app_server: &mut AppServerSession,
        direction: AgentNavigationDirection,
    ) -> Option<ThreadId>
```

**Purpose**: Finds the next or previous agent thread for keyboard navigation, fetching missing subagent data from the server if needed. This makes resumed sessions feel complete even before the user opens the picker.

**Data flow**: It checks the local navigation cache for a neighbor of the currently displayed thread. If none is found, and it has not already tried backfilling for this primary thread, it backfills loaded subagents from the server and tries again. It returns the neighboring thread id when one is found, or nothing otherwise.

**Call relations**: Keyboard navigation paths use this helper when moving between agents. It calls backfill_loaded_subagent_threads as a fallback discovery step, but avoids repeating that server fetch for the same primary thread.

*Call graph*: calls 1 internal fn (backfill_loaded_subagent_threads).


##### `App::fresh_session_config`  (lines 726–730)

```
fn fresh_session_config(&self) -> Config
```

**Purpose**: Builds the configuration that should be used for a new session. It keeps the current app config but updates the service tier from the chat widget's current setting.

**Data flow**: It clones the current configuration, replaces its service-tier field with the value currently configured in the chat widget, and returns the new config. It does not change the app by itself.

**Call relations**: start_fresh_session_with_summary_hint calls this before asking the app server to create a fresh thread.

*Call graph*: called by 1 (start_fresh_session_with_summary_hint).


##### `App::resume_target_session`  (lines 731–840)

```
async fn resume_target_session(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        target_session: SessionTarget,
    ) -> Result<AppRunControl>
```

**Purpose**: Resumes a chosen saved session and makes it the active primary thread. It also handles workspace-directory decisions, configuration rebuilding, UI replacement, and user-facing errors.

**Data flow**: It receives the terminal UI, app server, and a target session. It ignores attempts to resume the same thread, decides which working directory to use, rebuilds configuration for that directory, applies runtime policy overrides, records a summary of the current session, and asks the server to resume the target thread. On success it shuts down the current thread, updates config-dependent UI pieces, replaces the chat widget with the resumed thread, shows resume hints, and may prompt about a paused goal. On failure it shows an error and keeps running.

**Call relations**: This is the high-level resume flow. It calls resolve_cwd_for_resume_or_fork to decide the directory, resume_thread to attach to the saved thread, and replace_chat_widget_with_app_server_thread to rebuild the UI around the resumed session.

*Call graph*: calls 4 internal fn (replace_chat_widget_with_app_server_thread, resume_thread, display_label, resolve_cwd_for_resume_or_fork); 6 external calls (new, frame_requester, set_notification_settings, format!, Exit, vec!).


##### `tests::terminal_thread_read_error_detection_matches_not_loaded_errors`  (lines 848–854)

```
fn terminal_thread_read_error_detection_matches_not_loaded_errors()
```

**Purpose**: Checks that a not-loaded thread error is treated as a terminal thread-read error. This protects the logic that removes or closes unavailable threads.

**Data flow**: It creates an error message containing the expected not-loaded text, passes it to App::is_terminal_thread_read_error, and asserts that the answer is true.

**Call relations**: This test covers the positive case for is_terminal_thread_read_error, which is used by thread liveness refresh code.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::terminal_thread_read_error_detection_ignores_transient_failures`  (lines 857–863)

```
fn terminal_thread_read_error_detection_ignores_transient_failures()
```

**Purpose**: Checks that a temporary transport failure is not mistaken for a permanently missing thread. This prevents the picker from hiding threads just because the connection hiccupped.

**Data flow**: It creates an error message about a broken pipe, passes it to App::is_terminal_thread_read_error, and asserts that the answer is false.

**Call relations**: This test covers the negative case for is_terminal_thread_read_error, supporting safer behavior in refresh_agent_picker_thread_liveness.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::closed_state_for_thread_read_error_preserves_live_state_without_cache_on_transient_error`  (lines 866–874)

```
fn closed_state_for_thread_read_error_preserves_live_state_without_cache_on_transient_error()
```

**Purpose**: Checks that a transient read error does not mark an uncached thread as closed. This keeps temporary server or network problems from changing thread state too aggressively.

**Data flow**: It creates a broken-pipe error, passes it with no previous closed state to App::closed_state_for_thread_read_error, and asserts that the result is false.

**Call relations**: This test protects the fallback decision used by refresh_agent_picker_thread_liveness when a thread read fails.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::closed_state_for_thread_read_error_marks_terminal_uncached_threads_closed`  (lines 877–885)

```
fn closed_state_for_thread_read_error_marks_terminal_uncached_threads_closed()
```

**Purpose**: Checks that a not-loaded error marks an uncached thread as closed. This helps the UI stop presenting a missing thread as live.

**Data flow**: It creates a not-loaded error, passes it with no previous closed state to App::closed_state_for_thread_read_error, and asserts that the result is true.

**Call relations**: This test verifies that closed_state_for_thread_read_error correctly builds on terminal-error detection.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::include_turns_fallback_detection_handles_unmaterialized_and_ephemeral_threads`  (lines 888–898)

```
fn include_turns_fallback_detection_handles_unmaterialized_and_ephemeral_threads()
```

**Purpose**: Checks that the app recognizes both known errors where reading full turns is unavailable but a lighter fallback may work. This prevents avoidable failures while selecting agent threads.

**Data flow**: It creates two different error messages: one for a thread that has no first user message yet, and one for an ephemeral thread. It passes both to App::can_fallback_from_include_turns_error and asserts that both return true.

**Call relations**: This test supports attach_live_thread_for_selection, which uses the helper to decide when it can retry thread_read without turns.

*Call graph*: 2 external calls (assert!, eyre!).


### `tui/src/chatwidget/session_flow.rs`

`orchestration` · `session setup and thread updates`

A chat session is more than a list of messages. It has a thread id, a working folder, permissions, a model, service tier, collaboration settings, history counts, and sometimes a parent thread it was forked from. This file is the bridge that copies that session information into `ChatWidget`, which is the terminal chat interface.

The main routine acts like a hotel front desk check-in. When a session arrives, it resets per-thread state, records the new thread id, updates the bottom input area with history details, changes the current workspace and permission rules, refreshes model and status displays, reloads skills for the current folder, and may show a session header at the top of the transcript. If the session is a fork, it can also add a short note saying which thread it came from.

There are three public-facing entry methods for different display styles: normal session setup, quiet setup, and side-conversation setup. They all feed into the same shared setup routine so the app does not accidentally configure sessions in three different ways. The file also reacts to later thread-name changes and provides a small helper for showing available skills in the bottom pane.

#### Function details

##### `ChatWidget::on_session_configured_with_display_and_fork_parent_title`  (lines 6–147)

```
fn on_session_configured_with_display_and_fork_parent_title(
        &mut self,
        session: ThreadSessionState,
        display: SessionConfiguredDisplay,
        fork_parent_title: Option<String
```

**Purpose**: This is the central session setup routine for the chat widget. It takes a newly configured thread session and updates the chat screen so the user sees and uses the right thread, workspace, permissions, model, status indicators, and header text.

**Data flow**: It receives a `ThreadSessionState`, a display mode, and an optional parent-thread title for forked sessions. It reads many fields from the session, such as thread id, history metadata, working directory, permission profile, model, service tier, collaboration mode, and fork information, then copies those values into the widget and its configuration. It may create or remove a session header cell, refresh commands and status surfaces, reload skills, prefetch connectors, submit a pending first message, emit a fork notice, and finally ask the interface to redraw unless redraws are being suppressed.

**Call relations**: The three session entry methods call this function so all session types follow one shared path. Inside that path it uses `set_skills` to clear or update the bottom pane, builds permission snapshots from session data, falls back to safer permission behavior if syncing fails, may call `initial_collaboration_mask` or set the effective collaboration mode, may build a visible session header with `new_session_info`, and calls `emit_forked_thread_event` when a normal displayed session was forked from another thread.

*Call graph*: calls 4 internal fn (allow_only, from_session_snapshot, emit_forked_thread_event, set_skills); called by 3 (handle_side_thread_session, handle_thread_session, handle_thread_session_quiet); 5 external calls (initial_collaboration_mask, new_session_info, error!, warn!, default).


##### `ChatWidget::handle_thread_session`  (lines 149–157)

```
fn handle_thread_session(&mut self, session: ThreadSessionState)
```

**Purpose**: This handles the usual case where a full thread session is ready and should be shown normally. It prepares the instruction-source information and then delegates the real setup to the shared session configuration routine.

**Data flow**: It receives a `ThreadSessionState`. Before handing it off, it copies the session's instruction-source paths into the widget and keeps the fork parent title, if there is one. It then passes the session, normal display mode, and parent title into the common setup function; the result is that the visible chat widget is updated for that thread.

**Call relations**: This is one of the simple front doors into the session setup flow. Rather than doing setup itself, it calls `ChatWidget::on_session_configured_with_display_and_fork_parent_title`, which performs the detailed state updates and screen refresh work.

*Call graph*: calls 1 internal fn (on_session_configured_with_display_and_fork_parent_title).


##### `ChatWidget::handle_thread_session_quiet`  (lines 159–166)

```
fn handle_thread_session_quiet(&mut self, session: ThreadSessionState)
```

**Purpose**: This applies a thread session without showing the normal session header or fork message. It is useful when the app needs the widget's state to match a session but should avoid noisy visible changes.

**Data flow**: It receives a `ThreadSessionState`, copies its instruction-source paths into the widget, and passes the session onward with the quiet display mode and no fork parent title. The shared setup routine still updates configuration, permissions, model state, workspace, and other internal state, but it avoids the normal display behavior.

**Call relations**: This is a quieter wrapper around the main setup function. It calls `ChatWidget::on_session_configured_with_display_and_fork_parent_title` with `SessionConfiguredDisplay::Quiet`, which tells the shared routine to configure the widget without the normal visible session announcement.

*Call graph*: calls 1 internal fn (on_session_configured_with_display_and_fork_parent_title).


##### `ChatWidget::handle_side_thread_session`  (lines 168–176)

```
fn handle_side_thread_session(&mut self, session: ThreadSessionState)
```

**Purpose**: This applies session state for a side conversation, which is related to the main chat flow but displayed differently. It keeps the same setup rules while marking the session as a side conversation.

**Data flow**: It receives a `ThreadSessionState`, copies instruction-source paths, saves the optional fork parent title, and forwards everything to the shared setup routine with side-conversation display mode. The widget is updated from the session, but the display decisions follow the side-conversation path rather than the normal header path.

**Call relations**: Like the normal and quiet handlers, this function is a small wrapper. It calls `ChatWidget::on_session_configured_with_display_and_fork_parent_title`, letting the central setup code do the actual synchronization while this function only chooses the display style.

*Call graph*: calls 1 internal fn (on_session_configured_with_display_and_fork_parent_title).


##### `ChatWidget::emit_forked_thread_event`  (lines 178–207)

```
fn emit_forked_thread_event(
        &mut self,
        forked_from_id: ThreadId,
        fork_parent_title: Option<String>,
    )
```

**Purpose**: This adds a small transcript note telling the user that the current thread was forked from another thread. If the parent thread has a readable title, it includes that title as well as the parent id.

**Data flow**: It receives the parent thread id and an optional parent title. It turns the id into text, builds one formatted line of terminal text, and wraps that line in a plain history cell. It then sends an app event asking the transcript to insert that history cell.

**Call relations**: The main session setup routine calls this only for normal displayed sessions that have a parent thread. It does not directly alter the transcript itself; instead it hands an `InsertHistoryCell` event to the app event channel, so the broader UI event system can insert the note in the right way.

*Call graph*: calls 1 internal fn (new); called by 1 (on_session_configured_with_display_and_fork_parent_title); 4 external calls (new, InsertHistoryCell, to_string, vec!).


##### `ChatWidget::on_thread_name_updated`  (lines 209–224)

```
fn on_thread_name_updated(
        &mut self,
        thread_id: ThreadId,
        thread_name: Option<String>,
    )
```

**Purpose**: This reacts when the app learns that a thread's name has changed. If the update belongs to the currently open thread, it records the new name and refreshes the visible status.

**Data flow**: It receives a thread id and an optional new thread name. It first checks whether the id matches the thread currently shown by the widget. If it matches and a non-empty name is present, it creates a rename confirmation cell and adds it to the history; then it stores the new name, refreshes status areas, asks for a redraw, and may continue any queued user input.

**Call relations**: This function is used after session setup, when a name update arrives later. It relies on `rename_confirmation_cell` to create the user-facing confirmation message, then updates the widget and nudges the rest of the chat flow by calling redraw and queued-input helpers.

*Call graph*: 2 external calls (new, rename_confirmation_cell).


##### `ChatWidget::set_skills`  (lines 226–228)

```
fn set_skills(&mut self, skills: Option<Vec<SkillMetadata>>)
```

**Purpose**: This updates the list of skills shown or available in the chat input area. A skill is a named capability or tool-like feature the user may be able to invoke.

**Data flow**: It receives either a list of skill metadata or `None`. It passes that value directly to the bottom pane, so the lower part of the chat interface either shows the given skills or clears them.

**Call relations**: The main session setup routine calls this with `None` while switching sessions, so stale skills from a previous thread are not shown. Later, session setup also triggers a skill refresh for the current working folder, which can repopulate the bottom pane with the correct skills.

*Call graph*: called by 1 (on_session_configured_with_display_and_fork_parent_title).


### `tui/src/chatwidget/turn_lifecycle.rs`

`domain_logic` · `active during chat agent turns and thread resets`

When a user asks the agent to do something, the terminal UI needs a reliable way to know that an agent turn has started, is still running, or has ended. This file provides that state in one place. Without it, the UI could show the wrong status, forget which turn was last seen, fail to clear old budget-limit flags, or allow the computer to idle-sleep while the agent is still working.

The main type, TurnLifecycleState, stores a few pieces of turn-related information. It remembers whether the core agent says a turn is running. It records when the active turn began, so other UI code can show time-based status. It keeps a set of turn IDs that hit a budget limit, so that message can be consumed once and not repeated forever. It also owns a SleepInhibitor, which is a helper that can ask the operating system not to idle-sleep while a turn is in progress, if that option is enabled.

The methods are simple state transitions. Starting a turn flips the running flag on, records the start time, and tells the sleep inhibitor that work is happening. Finishing does the reverse. Resetting a thread clears all per-thread memory. Changing the sleep-prevention setting rebuilds the inhibitor, then immediately syncs it with the current running state so it does not forget an active turn.

#### Function details

##### `TurnLifecycleState::new`  (lines 19–27)

```
fn new(prevent_idle_sleep: bool) -> Self
```

**Purpose**: Creates a fresh turn lifecycle record for a ChatWidget. It starts with no running agent turn, no remembered turn ID, no budget-limited turns, and a sleep-prevention helper configured from the user's setting.

**Data flow**: It takes a boolean saying whether idle sleep should be prevented during agent work. From that, it builds a new SleepInhibitor, sets all turn-tracking fields to empty or false, and returns a ready-to-use TurnLifecycleState.

**Call relations**: This is used when a ChatWidget is being created through new_with_op_target, and the tests use it to set up clean examples. It relies on the SleepInhibitor constructor to create the part that talks to sleep-prevention behavior.

*Call graph*: calls 1 internal fn (new); called by 3 (new_with_op_target, budget_limited_turn_ids_are_consumed, start_and_finish_update_running_state); 1 external calls (new).


##### `TurnLifecycleState::start`  (lines 29–33)

```
fn start(&mut self, now: Instant)
```

**Purpose**: Marks that an agent turn has begun. It also records when the turn started and tells the sleep-prevention helper that work is now running.

**Data flow**: It receives the current time. It changes the stored running flag from false to true, saves the time as the start of the active turn, and passes the running state to the SleepInhibitor. It does not return a value; it updates the state object in place.

**Call relations**: Other ChatWidget code calls this at the moment a new agent turn starts. It hands the key state change to SleepInhibitor::set_turn_running so the system sleep behavior matches the UI's idea of whether the agent is busy.

*Call graph*: 1 external calls (set_turn_running).


##### `TurnLifecycleState::finish`  (lines 35–40)

```
fn finish(&mut self)
```

**Purpose**: Marks that the current agent turn is over. It clears the active-start time and tells the sleep-prevention helper that there is no longer a running turn.

**Data flow**: It reads no outside input. It changes the running flag to false, removes the saved start time, and updates the SleepInhibitor to say that turn work has stopped. It returns nothing and mutates the existing state.

**Call relations**: This is called when a turn completes, and reset_thread also uses it as the first step in clearing thread state. Like start, it keeps the SleepInhibitor in sync by calling set_turn_running.

*Call graph*: called by 1 (reset_thread); 1 external calls (set_turn_running).


##### `TurnLifecycleState::restore_running`  (lines 42–46)

```
fn restore_running(&mut self, running: bool, now: Instant)
```

**Purpose**: Restores the running/not-running state from outside information, such as after rebuilding or resuming UI state. It makes the local state and sleep-prevention helper agree with that restored value.

**Data flow**: It takes a boolean saying whether a turn is running and the current time. If running is true, it saves that time as the active-turn start time; if false, it clears the start time. It then sends the same running value to the SleepInhibitor and returns nothing.

**Call relations**: This is used when the ChatWidget needs to line its local memory back up with what the rest of the system believes. It passes the restored running state onward to SleepInhibitor::set_turn_running so sleep prevention is not left stale.

*Call graph*: 1 external calls (set_turn_running).


##### `TurnLifecycleState::reset_thread`  (lines 48–52)

```
fn reset_thread(&mut self)
```

**Purpose**: Clears all turn-related memory when the chat thread is reset. This prevents old turn IDs or budget-limit markers from leaking into the next conversation thread.

**Data flow**: It takes no input. First it finishes any active turn, which clears running state and sleep prevention. Then it removes the last remembered turn ID and empties the set of budget-limited turn IDs. It returns nothing.

**Call relations**: Thread-reset code calls this when the UI starts over with a clean conversation context. It delegates the running-state cleanup to TurnLifecycleState::finish, then clears the extra per-thread bookkeeping itself.

*Call graph*: calls 1 internal fn (finish).


##### `TurnLifecycleState::set_prevent_idle_sleep`  (lines 54–58)

```
fn set_prevent_idle_sleep(&mut self, enabled: bool)
```

**Purpose**: Changes whether the app should try to stop the computer from idle-sleeping while the agent is working. It preserves the current turn-running state while swapping in the new sleep setting.

**Data flow**: It takes a boolean for the new sleep-prevention setting. It creates a new SleepInhibitor using that setting, then immediately tells it whether a turn is already running. Nothing is returned; the state object now uses the new sleep behavior.

**Call relations**: Settings or UI code can call this when the user changes the idle-sleep preference. It calls the SleepInhibitor constructor and then set_turn_running so the new inhibitor starts in the correct state instead of assuming no work is happening.

*Call graph*: calls 1 internal fn (new); 1 external calls (set_turn_running).


##### `TurnLifecycleState::mark_budget_limited`  (lines 60–62)

```
fn mark_budget_limited(&mut self, turn_id: String)
```

**Purpose**: Remembers that a particular agent turn hit a budget limit. This lets later UI code recognize that turn and show or react to the budget-limit condition once.

**Data flow**: It takes a turn ID string. It inserts that ID into the stored set of budget-limited turns. It returns nothing, but the state now remembers that this turn needs special budget-limit treatment.

**Call relations**: Code that detects a budget-limited turn calls this to leave a marker. Later, TurnLifecycleState::take_budget_limited can remove and report that marker when the UI consumes it.


##### `TurnLifecycleState::take_budget_limited`  (lines 64–66)

```
fn take_budget_limited(&mut self, turn_id: &str) -> bool
```

**Purpose**: Checks whether a turn was marked as budget-limited, and consumes that marker at the same time. This is like taking a ticket from a pile: once taken, the same ticket is no longer there.

**Data flow**: It receives a turn ID by reference. It tries to remove that ID from the set of budget-limited turns. It returns true if the ID was present and removed, or false if there was no marker for that turn.

**Call relations**: UI code uses this after mark_budget_limited has recorded a budget-limited turn. The remove-on-read behavior ensures the same budget-limit event is not processed repeatedly.


##### `tests::start_and_finish_update_running_state`  (lines 74–86)

```
fn start_and_finish_update_running_state()
```

**Purpose**: Checks that starting and finishing a turn update all the important pieces of state together. It protects against bugs where the running flag, start time, or sleep inhibitor get out of sync.

**Data flow**: It creates a fresh TurnLifecycleState with idle-sleep prevention disabled. It starts a turn using the current time, then verifies that the running flag is true, the start time exists, and the sleep inhibitor says a turn is running. It then finishes the turn and verifies that all three are cleared or false.

**Call relations**: This test exercises TurnLifecycleState::new, TurnLifecycleState::start, and TurnLifecycleState::finish as a simple start-to-end story. It uses assertions to confirm the public effects that other ChatWidget code depends on.

*Call graph*: calls 1 internal fn (new); 2 external calls (now, assert!).


##### `tests::budget_limited_turn_ids_are_consumed`  (lines 89–96)

```
fn budget_limited_turn_ids_are_consumed()
```

**Purpose**: Checks that budget-limit markers are one-time signals. Once a turn ID is taken, asking for it again should say it is no longer present.

**Data flow**: It creates a fresh TurnLifecycleState, marks the ID "turn-1" as budget-limited, then takes that marker. The first take returns true because the marker was present; the second returns false because the first call removed it.

**Call relations**: This test exercises TurnLifecycleState::new, TurnLifecycleState::mark_budget_limited, and TurnLifecycleState::take_budget_limited together. It confirms the consume-on-read behavior that prevents duplicate budget-limit handling.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


### TUI side threads and settings
These files cover side-conversation thread behavior in the UI along with synchronization of thread settings and goal actions against the app server.

### `tui/src/app/side.rs`

`orchestration` · `active during side conversation start, thread switching, request handling, and cleanup`

A side conversation is like opening a sticky note beside a longer meeting: it can refer to what has already happened, but it should not take over the meeting’s main agenda. This file is responsible for creating that sticky note, showing the user that they are inside it, and throwing it away when they return to the parent thread.

The file does three important things. First, it defines the safety instructions that are injected into a side conversation. These instructions tell the model that older history is only background material, not an active task, and that it should avoid changing files or workspace state unless the user explicitly asks inside the side conversation. Second, it tracks the parent thread’s condition while the side conversation is visible, such as whether the parent needs input, needs approval, failed, or finished. That status is shown in the side conversation label so the user is not surprised by something happening in the background. Third, it coordinates switching, cleanup, and error recovery. When a side thread starts, the app forks the parent thread, hides inherited history from the visual transcript, injects a boundary message, and switches to the new thread. When the user returns or navigates elsewhere, the app interrupts and unsubscribes from the side thread, removes local state, and restores the parent view. If cleanup fails, it keeps the side thread visible so the user is not left thinking it disappeared when it is still open.

#### Function details

##### `SideParentStatus::label`  (lines 65–80)

```
fn label(self, parent_is_main: bool) -> &'static str
```

**Purpose**: Turns a stored parent-thread status into short text that can be shown in the user interface. It chooses wording like “main needs input” or “parent failed” depending on whether the side conversation came from the main thread or another parent thread.

**Data flow**: It receives a status value and a true-or-false flag saying whether the parent is the main thread. It matches those two pieces of information and returns a fixed label string. It does not change any app state.

**Call relations**: This is used when the app refreshes the side conversation banner. The banner combines where the side conversation came from, the parent’s current condition, and the reminder that Ctrl+C returns to the parent.


##### `SideParentStatus::is_actionable`  (lines 82–87)

```
fn is_actionable(self) -> bool
```

**Purpose**: Answers whether a parent status is something the user can act on right now. In this file, needing input or approval is actionable; finished, failed, closed, or interrupted are just informational.

**Data flow**: It receives one parent status. It checks whether the status is “needs input” or “needs approval” and returns true only for those cases.

**Call relations**: This supports clearing only temporary action-needed messages. When the parent starts doing work again or a request is resolved, the app can remove “needs input” or “needs approval” without erasing more final statuses like “failed” or “closed.”

*Call graph*: 1 external calls (matches!).


##### `SideParentStatus::for_request`  (lines 89–102)

```
fn for_request(request: &ServerRequest) -> Option<Self>
```

**Purpose**: Translates a server request from a parent thread into the side-conversation status that should be shown to the user. For example, a request for user input becomes “parent needs input,” while approval requests become “parent needs approval.”

**Data flow**: It receives a server request. It looks at the request kind and returns a matching parent status when the request needs the user’s attention, or returns nothing when the request is not relevant to the side status display.

**Call relations**: The thread request queue calls this when a background parent thread asks for something while a side conversation is visible. The result is later shown in the side conversation label so the user knows the parent is waiting.

*Call graph*: called by 1 (enqueue_thread_request).


##### `tests::side_boundary_prompt_marks_inherited_history_reference_only`  (lines 111–132)

```
fn side_boundary_prompt_marks_inherited_history_reference_only()
```

**Purpose**: Checks that the hidden boundary message for a side conversation says the right safety-critical things. This protects against accidentally weakening the instructions that keep inherited history from becoming an active task.

**Data flow**: The test creates the boundary prompt item, confirms it is a hidden-style user message, reads its text, and checks that key phrases are present. It produces no app output; it passes or fails during testing.

**Call relations**: It directly exercises the function that builds the side boundary prompt. If someone edits that prompt and removes important wording about reference-only history, tools, sub-agents, or file changes, this test is meant to catch it.

*Call graph*: 4 external calls (assert!, assert_eq!, side_boundary_prompt_item, panic!).


##### `tests::side_start_error_message_explains_missing_first_prompt`  (lines 135–144)

```
fn side_start_error_message_explains_missing_first_prompt()
```

**Purpose**: Checks that a common start failure is explained in friendly user language. Specifically, it verifies that trying to open a side conversation before the first real message tells the user to send a message first.

**Data flow**: The test builds a fake error containing the server’s low-level “no rollout found” wording. It passes that error into the side-start error formatter and checks that the returned message is the clearer user-facing explanation.

**Call relations**: It protects the error translation used when starting a side conversation fails. Without this, users might see an internal server phrase that does not explain what they should do next.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::side_start_error_message_uses_generic_start_wording`  (lines 147–154)

```
fn side_start_error_message_uses_generic_start_wording()
```

**Purpose**: Checks that unexpected side-start failures still produce a useful generic error message. This ensures that unknown problems are not mistaken for the “send a message first” case.

**Data flow**: The test creates a fake “transport disconnected” error. It sends that error through the formatter and expects a message that starts with “Failed to start side conversation” and includes the original error text.

**Call relations**: It covers the fallback path of the side-start error formatter. This keeps ordinary failures honest: they are reported as start failures, not hidden behind a misleading special-case message.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::side_developer_instructions_appends_existing_policy`  (lines 157–168)

```
fn side_developer_instructions_appends_existing_policy()
```

**Purpose**: Checks that side-conversation instructions are added without throwing away existing developer policy. This matters because the side thread still needs the app’s normal rules, plus the extra rules that make it safe as a side thread.

**Data flow**: The test passes existing instruction text into the side-instruction builder. It then checks that the result contains both the original policy and the side-conversation rules.

**Call relations**: It protects the configuration-building path used when a side thread is forked. If future changes accidentally replaced existing policy instead of appending to it, this test would fail.

*Call graph*: 2 external calls (assert!, side_developer_instructions).


##### `SideParentStatusChange::for_notification`  (lines 179–200)

```
fn for_notification(notification: &ServerNotification) -> Option<Self>
```

**Purpose**: Turns server notifications from a parent thread into simple updates for the side conversation’s parent-status display. For example, a completed turn becomes “parent finished,” while a new turn start clears the old status.

**Data flow**: It receives a server notification. It inspects the notification kind and, when relevant, returns a status change: set a new status, clear all status, or clear only action-needed status. Notifications that do not affect the display return nothing.

**Call relations**: The thread notification queue calls this as parent-thread events arrive. The returned change is later applied to all side conversations that came from that parent, keeping their UI labels in sync with parent activity.

*Call graph*: called by 1 (enqueue_thread_notification); 1 external calls (Set).


##### `SideThreadState::new`  (lines 212–217)

```
fn new(parent_thread_id: ThreadId) -> Self
```

**Purpose**: Creates the small record the app keeps for each side conversation. That record remembers which parent thread to return to and starts with no known parent status.

**Data flow**: It receives the parent thread’s identifier. It builds and returns a side-thread state object containing that parent identifier and an empty parent-status field.

**Call relations**: Starting a side conversation uses this after the server successfully forks a thread. Tests also use it to set up side-thread scenarios. Other functions later read and update this state when switching, showing labels, or cleaning up.

*Call graph*: called by 14 (handle_start_side, active_side_thread_renders_live_mcp_startup_notifications, discard_closed_side_thread_removes_local_state_without_server_rpc, discard_side_thread_keeps_local_state_when_server_close_fails, discard_side_thread_removes_agent_navigation_entry, side_defers_parent_approval_overlay_until_parent_replay, side_defers_subagent_approval_overlay_until_side_exits, side_discard_selection_keeps_current_side_thread, side_parent_status_prioritizes_input_over_approval, side_parent_status_tracks_parent_turn_lifecycle (+4 more)).


##### `App::sync_side_thread_ui`  (lines 221–261)

```
fn sync_side_thread_ui(&mut self)
```

**Purpose**: Refreshes the chat interface so it accurately shows whether the current thread is a side conversation. It sets the side label, blocks renaming, suppresses the normal interrupted-turn notice, and clears all of that when the user is not in a side thread.

**Data flow**: It reads the currently displayed thread, the app’s side-thread map, the parent thread id, and any stored parent status. If the current thread is not a side thread, it clears side-specific UI settings. If it is a side thread, it builds a label such as “Side from main thread · main needs approval · Ctrl+C to return” and applies side-specific UI settings.

**Call relations**: This is called after parent status changes and when starting a side conversation is blocked. It is the bridge between the side-thread bookkeeping and what the user actually sees in the chat widget.

*Call graph*: called by 3 (clear_side_parent_action_status, handle_start_side, set_side_parent_status); 2 external calls (new, format!).


##### `App::active_side_parent_thread_id`  (lines 263–267)

```
fn active_side_parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Finds the parent thread of the side conversation currently on screen. It returns nothing if the user is not currently looking at a side conversation.

**Data flow**: It reads the currently displayed thread id and looks it up in the side-thread state map. If that thread is a side thread, it returns the saved parent thread id; otherwise it returns nothing.

**Call relations**: The return-from-side shortcut uses this to decide whether Ctrl+C-style behavior should switch back to a parent thread. It is a small lookup helper for the larger navigation flow.

*Call graph*: called by 1 (maybe_return_from_side).


##### `App::set_side_parent_status`  (lines 269–288)

```
fn set_side_parent_status(
        &mut self,
        parent_thread_id: ThreadId,
        status: Option<SideParentStatus>,
    )
```

**Purpose**: Updates the remembered status for every side conversation that belongs to a particular parent thread. This lets a side conversation show that its parent needs input, failed, finished, and so on.

**Data flow**: It receives a parent thread id and either a new status or no status. It scans all side-thread records, changes the matching ones if needed, and then refreshes the side-conversation UI if anything changed.

**Call relations**: The status-change applicator calls this when a parent notification says to set or clear the status. It then hands off to the UI sync function so the visible label stays current.

*Call graph*: calls 1 internal fn (sync_side_thread_ui); called by 1 (apply_side_parent_status_change).


##### `App::clear_side_parent_action_status`  (lines 290–308)

```
fn clear_side_parent_action_status(&mut self, parent_thread_id: ThreadId)
```

**Purpose**: Clears only parent statuses that represent something the user needed to act on, such as input or approval. It leaves final or informational statuses alone.

**Data flow**: It receives a parent thread id. It scans side-thread records for that parent and removes the status only if it is actionable. If any record changes, it refreshes the side-conversation UI.

**Call relations**: The status-change applicator calls this when server activity means a pending input or approval has likely been handled. It relies on `SideParentStatus::is_actionable` to avoid erasing statuses like “failed” or “closed.”

*Call graph*: calls 1 internal fn (sync_side_thread_ui); called by 1 (apply_side_parent_status_change).


##### `App::apply_side_parent_status_change`  (lines 310–326)

```
fn apply_side_parent_status_change(
        &mut self,
        parent_thread_id: ThreadId,
        change: SideParentStatusChange,
    )
```

**Purpose**: Applies a parent-status update in one place, whether that update means setting a status, clearing it entirely, or clearing only action-needed statuses.

**Data flow**: It receives a parent thread id and a status-change command. It dispatches that command to the appropriate helper, which updates side-thread state and refreshes the UI if needed.

**Call relations**: This sits between notification interpretation and state mutation. A notification can first be converted into a simple `SideParentStatusChange`, then this function performs the actual update on side-thread records.

*Call graph*: calls 2 internal fn (clear_side_parent_action_status, set_side_parent_status).


##### `App::maybe_return_from_side`  (lines 328–349)

```
async fn maybe_return_from_side(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
    ) -> bool
```

**Purpose**: Tries to return from a side conversation to its parent when the interface is in a safe, quiet state. It only does this if there is no overlay, no modal or popup, and the message composer is empty.

**Data flow**: It reads the current UI state and checks whether the active thread is a side thread. If returning is allowed, it switches to the parent thread and discards the side thread. It returns true if the app is no longer inside a side thread afterward, otherwise false.

**Call relations**: This is part of the user-navigation flow, such as pressing Ctrl+C to leave a side conversation. It calls the helper that both selects the parent and cleans up the side thread so the temporary fork does not linger.

*Call graph*: calls 2 internal fn (active_side_parent_thread_id, select_agent_thread_and_discard_side).


##### `App::side_thread_to_discard_after_switch`  (lines 351–361)

```
fn side_thread_to_discard_after_switch(
        &self,
        target_thread_id: ThreadId,
    ) -> Option<ThreadId>
```

**Purpose**: Decides whether the current side conversation should be thrown away after switching to another thread. A side conversation is temporary, so leaving it for a different thread usually means it should be discarded.

**Data flow**: It receives the thread id the app is about to switch to. It reads the current displayed thread and checks whether that current thread is a side thread. If the target is different and the current thread is a side thread, it returns the side thread id to discard; otherwise it returns nothing.

**Call relations**: The thread-switch-and-cleanup function calls this before switching threads. That way it remembers which temporary side thread needs cleanup after the new thread has become active.

*Call graph*: called by 1 (select_agent_thread_and_discard_side).


##### `App::discard_side_thread`  (lines 363–382)

```
async fn discard_side_thread(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> bool
```

**Purpose**: Closes a side conversation both on the server side and in the app’s local state. If either the interrupt or unsubscribe step fails, it warns the user and keeps the thread from being falsely removed.

**Data flow**: It receives a side thread id and access to the server session. It first asks the server to interrupt the side thread, then asks to unsubscribe from it, and finally removes local state if those server steps succeed. It returns true on successful cleanup and false if the side thread is still open.

**Call relations**: This is the main cleanup worker used when leaving a side conversation. Higher-level functions call it when switching away or when recovering from a failed side-start setup.

*Call graph*: calls 3 internal fn (discard_thread_local_state, interrupt_side_thread, thread_unsubscribe); called by 2 (discard_side_thread_or_keep_visible, select_agent_thread_and_discard_side); 2 external calls (format!, warn!).


##### `App::discard_closed_side_thread`  (lines 384–386)

```
async fn discard_closed_side_thread(&mut self, thread_id: ThreadId)
```

**Purpose**: Removes local app state for a side thread that the server has already closed. Because the server side is already gone, this function only needs to clean up the app’s memory and UI bookkeeping.

**Data flow**: It receives the closed thread id. It passes that id to the local-state cleanup function and waits for cleanup to finish. It does not contact the server.

**Call relations**: This is used for the path where closure has already happened elsewhere. It shares the same local cleanup routine as the full discard path, but skips interrupting or unsubscribing.

*Call graph*: calls 1 internal fn (discard_thread_local_state).


##### `App::discard_thread_local_state`  (lines 388–399)

```
async fn discard_thread_local_state(&mut self, thread_id: ThreadId)
```

**Purpose**: Erases the app’s local knowledge of a thread after it should no longer be visible or tracked. This includes event listeners, event channels, side-thread records, navigation entries, and active-thread state.

**Data flow**: It receives a thread id. It aborts the listener for that thread, removes stored channels and side-thread metadata, removes navigation state, clears the active thread if needed, otherwise refreshes pending approvals, and then updates the active-agent label.

**Call relations**: Both full side-thread discard and already-closed side-thread cleanup call this. It is the final local housekeeping step after the app is done with a side thread.

*Call graph*: called by 2 (discard_closed_side_thread, discard_side_thread).


##### `App::interrupt_side_thread`  (lines 401–415)

```
async fn interrupt_side_thread(
        &self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> std::result::Result<(), String>
```

**Purpose**: Asks the server to stop whatever a side conversation is currently doing before closing it. If there is an active turn, it interrupts that turn; otherwise it interrupts startup.

**Data flow**: It receives a server session and side thread id. It checks whether that thread has an active turn id. With a turn id, it sends a turn interrupt; without one, it sends a startup interrupt. It returns success or a user-facing error string explaining that the side conversation is still open.

**Call relations**: The full discard function calls this before unsubscribing from a side thread. This order matters because the app should not simply disconnect from a temporary conversation while the server may still be working on it.

*Call graph*: calls 2 internal fn (startup_interrupt, turn_interrupt); called by 1 (discard_side_thread).


##### `App::keep_side_thread_visible_after_cleanup_failure`  (lines 417–430)

```
async fn keep_side_thread_visible_after_cleanup_failure(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: Restores the side conversation view if cleanup failed and the app had already moved away from it. This avoids hiding a side thread that is still open on the server.

**Data flow**: It receives the side thread id plus UI and server access. If that side thread is not currently active, it tries to select it again. If restoring the view fails, it logs a warning.

**Call relations**: Cleanup wrapper functions call this after a failed discard. It is an error-recovery safety net: if the app cannot close the side conversation, it tries to keep the user looking at the still-open conversation.

*Call graph*: called by 2 (discard_side_thread_or_keep_visible, select_agent_thread_and_discard_side); 1 external calls (warn!).


##### `App::discard_side_thread_or_keep_visible`  (lines 432–445)

```
async fn discard_side_thread_or_keep_visible(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> bool
```

**Purpose**: Attempts to discard a side thread, but if that fails, tries to keep the side thread visible. It gives callers a simple true-or-false result while handling the safest recovery behavior internally.

**Data flow**: It receives the side thread id plus UI and server access. It calls the full discard function. If discard succeeds, it returns true; if discard fails, it tries to restore the side view and returns false.

**Call relations**: Side-conversation startup uses this when something goes wrong partway through setup. It prevents half-created side threads from being silently lost if the app cannot close them cleanly.

*Call graph*: calls 2 internal fn (discard_side_thread, keep_side_thread_visible_after_cleanup_failure); called by 1 (handle_start_side).


##### `App::side_developer_instructions`  (lines 447–454)

```
fn side_developer_instructions(existing_instructions: Option<&str>) -> String
```

**Purpose**: Builds the developer instructions for a side conversation. It preserves any existing developer instructions and appends side-specific rules that keep the fork separate and mostly non-mutating.

**Data flow**: It receives optional existing instruction text. If the text is present and not blank, it returns that text followed by the side-conversation instructions. If not, it returns just the side-conversation instructions.

**Call relations**: The side-fork configuration builder uses this before asking the server to fork a thread. Tests also check that it appends rather than replaces existing policy.

*Call graph*: 1 external calls (format!).


##### `App::side_boundary_prompt_item`  (lines 456–466)

```
fn side_boundary_prompt_item() -> ResponseItem
```

**Purpose**: Creates the hidden boundary message inserted into a side conversation. The message tells the model that everything before the boundary is background reference, not an active instruction.

**Data flow**: It takes no input. It returns a response item shaped as a user message containing the side-boundary text. It does not change state by itself.

**Call relations**: Starting a side conversation injects this item into the forked thread after the fork is created. A test verifies that the text contains the important safety wording.

*Call graph*: 1 external calls (vec!).


##### `App::side_fork_config`  (lines 468–481)

```
fn side_fork_config(&self) -> Config
```

**Purpose**: Builds the configuration used for the new side-conversation fork. It copies the current chat settings, marks the fork as temporary, and adds the side-conversation developer instructions.

**Data flow**: It reads the chat widget’s current configuration, model, reasoning effort, and service tier. It updates the copied configuration with those current values, sets `ephemeral` to true so the thread is temporary, appends side-specific developer instructions, and returns the finished configuration.

**Call relations**: The side-start flow calls this immediately before asking the server to fork the parent thread. It ensures the side conversation feels like the current chat while still following side-specific safety rules.

*Call graph*: called by 1 (handle_start_side); 1 external calls (side_developer_instructions).


##### `App::side_start_block_message`  (lines 483–491)

```
fn side_start_block_message(&self) -> Option<&'static str>
```

**Purpose**: Decides whether starting a side conversation should be blocked before contacting the server. It blocks when the main thread is not ready or when another side conversation is already open.

**Data flow**: It reads whether the app has a primary thread id and whether the side-thread map is empty. It returns a fixed user-facing message if starting should be blocked, or nothing if starting can proceed.

**Call relations**: The side-start handler calls this first. This keeps the app from trying impossible or confusing starts, such as nesting side conversations or starting one before the main thread exists.

*Call graph*: called by 1 (handle_start_side).


##### `App::side_start_error_message`  (lines 493–503)

```
fn side_start_error_message(err: &color_eyre::Report) -> String
```

**Purpose**: Turns a technical side-start failure into a message the user can understand. It gives special guidance when the real issue is that the current conversation has not started yet.

**Data flow**: It receives an error report and scans its chain of causes. If any cause matches known server wording for “there is no first user message yet,” it returns the friendly “send a message first” message. Otherwise it returns a generic failure message that includes the original error.

**Call relations**: The side-start handler uses this when the server refuses or fails to fork the thread. Tests cover both the special friendly message and the generic fallback.

*Call graph*: 2 external calls (chain, format!).


##### `App::restore_side_user_message`  (lines 505–513)

```
fn restore_side_user_message(
        &mut self,
        user_message: Option<crate::chatwidget::UserMessage>,
    )
```

**Purpose**: Puts the user’s typed message back into the composer if starting a side conversation fails or is blocked. This prevents the user from losing text they had already written.

**Data flow**: It receives an optional saved user message. If there is a message, it asks the chat widget to restore it to the composer. If there is no message, it does nothing.

**Call relations**: The side-start handler calls this in several failure paths. It is a small user-experience safeguard around the larger fork-and-switch process.

*Call graph*: called by 1 (handle_start_side).


##### `App::install_side_thread_snapshot`  (lines 515–524)

```
fn install_side_thread_snapshot(
        store: &mut ThreadEventStore,
        mut session: ThreadSessionState,
        _forked_turns: Vec<Turn>,
    )
```

**Purpose**: Installs the initial local event-store state for a new side conversation while making the visible transcript start at the side boundary. The inherited history still exists for the model, but it is not shown as if it were part of the side chat.

**Data flow**: It receives the thread event store, the forked session state, and the forked turns. It clears the session’s visual fork marker and stores the session with an empty visible turn list. The supplied forked turns are intentionally not displayed here.

**Call relations**: The side-start handler calls this after the server successfully creates the fork and before switching into it. It separates model context from what the user sees in the side conversation UI.

*Call graph*: calls 1 internal fn (set_session); 1 external calls (new).


##### `App::select_agent_thread_and_discard_side`  (lines 526–551)

```
async fn select_agent_thread_and_discard_side(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Switches to a requested thread and, if the user just left a side conversation, discards that side conversation afterward. It combines navigation with the cleanup rule that side conversations are temporary.

**Data flow**: It records the active thread before switching, asks whether the current side thread should be discarded, then selects the target thread. If the switch succeeds and there is a side thread to discard, it tries to close and remove it. On cleanup failure, it may restore the side conversation view.

**Call relations**: This is used both when returning from a side conversation and when switching into a newly created side conversation. It calls the discard helpers and, after successful cleanup, surfaces pending interactive requests from inactive threads.

*Call graph*: calls 3 internal fn (discard_side_thread, keep_side_thread_visible_after_cleanup_failure, side_thread_to_discard_after_switch); called by 2 (handle_start_side, maybe_return_from_side).


##### `App::handle_start_side`  (lines 553–646)

```
async fn handle_start_side(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        parent_thread_id: ThreadId,
        mut user_message: Option<crate::chatwi
```

**Purpose**: Runs the full process for the `/side` command. It checks whether starting is allowed, forks the parent thread, prepares the side thread, switches into it, optionally submits the user’s message there, and recovers carefully from failures.

**Data flow**: It receives UI access, server access, the parent thread id, and an optional user message that should become the first side-chat message. It first blocks invalid starts, records telemetry, refreshes config, builds side-fork config, asks the server to fork, installs the local snapshot, records side-thread state, injects the boundary prompt, switches into the child thread, and submits the saved user message if everything succeeded. On failure, it restores the user message when possible, reports a clear error, and tries to discard any partially created side thread.

**Call relations**: This is the main entry point for side-conversation creation from the slash command flow. It ties together nearly every helper in this file: blocking checks, configuration, boundary injection, UI syncing, thread switching, cleanup, and user-message restoration.

*Call graph*: calls 9 internal fn (discard_side_thread_or_keep_visible, restore_side_user_message, select_agent_thread_and_discard_side, side_fork_config, side_start_block_message, sync_side_thread_ui, new, fork_thread, thread_inject_items); 5 external calls (install_side_thread_snapshot, side_start_error_message, format!, warn!, vec!).


### `tui/src/chatwidget/side.rs`

`domain_logic` · `request handling`

A side conversation is a smaller, separate thread beside the main chat. This file does not own the whole life cycle of that side thread; that belongs elsewhere in the app. Instead, it owns the visible chat-widget details that must change when side mode is on.

Think of it like flipping a desk sign from “main meeting” to “side discussion.” When side mode starts, the message composer gets a different placeholder, the bottom pane is told that side mode is active, and an optional context label can be shown so the user knows what the side conversation is about. When side mode ends, the normal placeholder comes back and the bottom pane returns to its normal state.

The file also provides a safe way to submit a side-message as a plain user message. It deliberately disallows shell escapes, meaning special text that could be treated like a command to the system shell is not allowed through this path. That matters because side conversation input should behave like ordinary chat text, not like a shortcut for running commands.

#### Function details

##### `ChatWidget::submit_user_message_as_plain_user_turn`  (lines 10–15)

```
fn submit_user_message_as_plain_user_turn(
        &mut self,
        user_message: UserMessage,
    ) -> Option<AppCommand>
```

**Purpose**: Submits a user message as a normal chat turn while explicitly blocking shell escapes. Someone uses this when text from the side conversation should be treated as plain conversation, not as a special command.

**Data flow**: It receives a UserMessage from the composer. It passes that message into the chat widget’s normal submission path, together with a rule saying shell escapes are not allowed. It returns whatever app command that submission path produces, or nothing if no command is needed.

**Call relations**: This is a small safety wrapper around the broader message-submission routine. Instead of duplicating submission work, it hands the message to submit_user_message_with_shell_escape_policy and fixes the policy to Disallow so side-message submission cannot accidentally take the shell-command route.


##### `ChatWidget::set_side_conversation_active`  (lines 17–26)

```
fn set_side_conversation_active(&mut self, active: bool)
```

**Purpose**: Turns the chat widget’s side-conversation display mode on or off. It updates both the widget’s own memory of the mode and the visible bottom composer area so the user sees the right prompt.

**Data flow**: It receives a true-or-false value. That value is stored as the current side-conversation state. If the value is true, it chooses the side-conversation placeholder text; otherwise it chooses the normal placeholder text. It then sends the chosen placeholder and the active state down to the bottom pane, changing what the user sees.

**Call relations**: This function is the bridge between the app deciding that side mode has changed and the chat surface reflecting that change. It updates ChatWidget state, then delegates the visible composer changes to bottom_pane through set_placeholder_text and set_side_conversation_active.


##### `ChatWidget::side_conversation_active`  (lines 28–30)

```
fn side_conversation_active(&self) -> bool
```

**Purpose**: Reports whether the chat widget currently believes side-conversation mode is active. Other code can use this to decide which behavior or display path to follow.

**Data flow**: It reads the chat widget’s stored active_side_conversation flag and returns that true-or-false value unchanged. It does not modify anything.

**Call relations**: This is the read-only counterpart to set_side_conversation_active. After another part of the app has set the side-mode state, this function lets later code ask for the current state without touching the internal field directly.


##### `ChatWidget::set_side_conversation_context_label`  (lines 32–34)

```
fn set_side_conversation_context_label(&mut self, label: Option<String>)
```

**Purpose**: Sets or clears the label that explains the context of the current side conversation. This helps the user understand what the side thread is attached to.

**Data flow**: It receives either some text or no text. It passes that value directly to the bottom pane. If there is text, the bottom pane can show it as the side-conversation label; if there is no text, the label can be removed.

**Call relations**: This function keeps label display work inside the bottom pane while giving ChatWidget a clear method for side-conversation context updates. It does not decide what the label should be; it simply hands the chosen label to bottom_pane.set_side_conversation_context_label.


### `tui/src/app/thread_settings.rs`

`orchestration` · `cross-cutting, whenever thread settings change or are refreshed`

A chat thread has many settings that affect how it behaves: which model it uses, how much reasoning effort it should spend, what permissions it has, what folder it is working in, and more. The terminal interface keeps its own local view of these settings, while the app server has the authoritative thread state. This file is the bridge between the two.

When the user changes a setting in the terminal, this code builds a small update message for the active thread and sends it to the app server. It also avoids sending empty updates, which is like not mailing an envelope with no letter inside. If the server update fails, it logs a warning and shows an error in the chat area so the user is not left wondering why the setting did not stick.

The file also works in the opposite direction. When thread settings arrive from the app server, it applies them to the locally cached session state. That keeps the terminal’s memory of the thread aligned with the server. One important detail is collaboration mode: if the thread is using the default mode, the local model and reasoning effort are updated directly; otherwise those values are kept inside the collaboration mode settings.

#### Function details

##### `App::sync_active_thread_model_setting`  (lines 15–24)

```
async fn sync_active_thread_model_setting(
        &mut self,
        app_server: &mut AppServerSession,
        model: String,
    )
```

**Purpose**: Sends a new model choice for the currently active thread to the app server. This is used when the user changes which AI model the thread should use.

**Data flow**: It receives the new model name and reads the app’s active thread ID and current collaboration mode. If there is no active thread, it stops. Otherwise it builds an update message and sends that message to the app server.

**Call relations**: This is the public-facing step for model changes inside the App. It asks App::active_thread_model_setting_update_params to prepare the update, then hands the finished message to App::send_thread_settings_update so the server can be told.

*Call graph*: calls 2 internal fn (active_thread_model_setting_update_params, send_thread_settings_update).


##### `App::active_thread_model_setting_update_params`  (lines 26–37)

```
fn active_thread_model_setting_update_params(
        &self,
        model: String,
    ) -> Option<ThreadSettingsUpdateParams>
```

**Purpose**: Builds the server update message for a model change on the active thread. It packages the model together with the thread ID and collaboration mode so the server has enough context.

**Data flow**: It takes a model name and reads the current active thread ID from the app. If no thread is active, it returns nothing. If a thread is active, it returns a ThreadSettingsUpdateParams value containing the thread ID, the new model, and the effective collaboration mode, leaving all unrelated settings empty.

**Call relations**: App::sync_active_thread_model_setting calls this before sending anything. This function only prepares the data; App::send_thread_settings_update is responsible for actually contacting the app server.

*Call graph*: called by 1 (sync_active_thread_model_setting); 1 external calls (default).


##### `App::sync_active_thread_reasoning_setting`  (lines 39–48)

```
async fn sync_active_thread_reasoning_setting(
        &mut self,
        app_server: &mut AppServerSession,
        effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    )
```

**Purpose**: Sends a reasoning effort change for the active thread to the app server. Reasoning effort means how much extra thinking the model should be asked to do, when the chosen model supports that idea.

**Data flow**: It receives the desired reasoning effort, which may be present or absent. It asks another helper to turn that into a server update for the active thread. If that helper returns nothing because there is no active thread, it stops; otherwise it sends the update to the server.

**Call relations**: This is the main path for reasoning-effort changes. It depends on App::active_thread_reasoning_setting_update_params to build the update and then uses App::send_thread_settings_update to deliver it.

*Call graph*: calls 2 internal fn (active_thread_reasoning_setting_update_params, send_thread_settings_update).


##### `App::active_thread_reasoning_setting_update_params`  (lines 50–61)

```
fn active_thread_reasoning_setting_update_params(
        &self,
        effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    ) -> Option<ThreadSettingsUpdateParams>
```

**Purpose**: Builds the server update message for changing reasoning effort on the active thread. It includes the current collaboration mode because reasoning behavior can depend on that mode.

**Data flow**: It takes an optional reasoning effort value and reads the active thread ID and current collaboration mode from the app. If no thread is active, it returns nothing. Otherwise it returns a ThreadSettingsUpdateParams value with the thread ID, effort value, and collaboration mode filled in.

**Call relations**: App::sync_active_thread_reasoning_setting calls this as its preparation step. This function does not talk to the server itself; it simply creates the data that App::send_thread_settings_update will send.

*Call graph*: called by 1 (sync_active_thread_reasoning_setting); 1 external calls (default).


##### `App::sync_active_thread_plan_mode_reasoning_setting`  (lines 63–76)

```
async fn sync_active_thread_plan_mode_reasoning_setting(
        &mut self,
        app_server: &mut AppServerSession,
    )
```

**Purpose**: Syncs the active thread’s collaboration mode to the server when plan-mode reasoning behavior changes. It is used when the relevant setting is represented through the collaboration mode rather than a separate model or effort field.

**Data flow**: It reads the active thread ID. If there is no active thread, it does nothing. If there is one, it creates an update containing the thread ID and the effective collaboration mode, then sends that update to the app server.

**Call relations**: This function builds its update directly instead of using a separate helper. It then follows the same delivery path as the other setting changes by calling App::send_thread_settings_update.

*Call graph*: calls 1 internal fn (send_thread_settings_update); 1 external calls (default).


##### `App::sync_active_thread_personality_setting`  (lines 78–92)

```
async fn sync_active_thread_personality_setting(
        &mut self,
        app_server: &mut AppServerSession,
        personality: codex_protocol::config_types::Personality,
    )
```

**Purpose**: Sends a personality change for the active thread to the app server. Personality controls the style or behavior profile the assistant should use for that thread.

**Data flow**: It receives a personality value and checks whether there is an active thread. Without an active thread, it stops. With one, it builds an update containing the thread ID and personality, then sends it to the server.

**Call relations**: Like the other sync functions, this prepares a narrow settings update and passes it to App::send_thread_settings_update. That shared sender decides whether the update has anything meaningful and performs the server call.

*Call graph*: calls 1 internal fn (send_thread_settings_update); 1 external calls (default).


##### `App::sync_override_turn_context_settings`  (lines 94–135)

```
async fn sync_override_turn_context_settings(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        op: &AppCommand,
    )
```

**Purpose**: Converts a one-turn context override command into a thread settings update for the app server. This is used when a command temporarily or explicitly changes the environment for a thread, such as working directory, permissions, model, effort, service tier, collaboration mode, or personality.

**Data flow**: It receives a thread ID and an AppCommand. If the command is not an OverrideTurnContext command, it does nothing. If it is, it pulls out the relevant settings, converts a few values into the app-server format, builds a ThreadSettingsUpdateParams message, and sends it to the server.

**Call relations**: This function is the bridge from command processing into thread settings synchronization. After translating the AppCommand fields into server update fields, it uses App::send_thread_settings_update, the same delivery function used by the simpler setting-change paths.

*Call graph*: calls 1 internal fn (send_thread_settings_update); 2 external calls (default, to_string).


##### `App::apply_thread_settings_to_cached_session`  (lines 137–154)

```
async fn apply_thread_settings_to_cached_session(
        &mut self,
        thread_id: ThreadId,
        settings: &ThreadSettings,
    )
```

**Purpose**: Updates the terminal’s cached session state from thread settings received from the app server. This keeps the local user interface from drifting away from the server’s version of the thread.

**Data flow**: It receives a thread ID and a ThreadSettings object from the server. If the thread is the primary thread and a primary cached session exists, it applies the settings there. It also looks for an event channel for that thread, locks its stored state safely, and applies the settings to that cached session too if one exists.

**Call relations**: This is the entry point for applying server-side settings locally. It delegates the actual field-by-field copying to apply_thread_settings_to_session, so the same rules are used for both the primary cached session and the session stored in a thread event channel.

*Call graph*: calls 1 internal fn (apply_thread_settings_to_session).


##### `App::send_thread_settings_update`  (lines 156–169)

```
async fn send_thread_settings_update(
        &mut self,
        app_server: &mut AppServerSession,
        params: ThreadSettingsUpdateParams,
    )
```

**Purpose**: Sends a thread settings update to the app server, but only if the update actually changes something. If the server rejects or fails the update, it reports the problem both in logs and in the chat interface.

**Data flow**: It receives a prepared ThreadSettingsUpdateParams value. First it checks whether any meaningful field is present. If not, it returns without contacting the server. If there are changes, it calls the app server. On success, nothing else is needed; on failure, it records a warning and adds a visible error message to the chat widget.

**Call relations**: All the setting-sync functions hand their prepared updates to this function. It relies on thread_settings_update_has_changes as a guard, then calls the app server’s thread_settings_update method to perform the actual update.

*Call graph*: calls 2 internal fn (thread_settings_update_has_changes, thread_settings_update); called by 5 (sync_active_thread_model_setting, sync_active_thread_personality_setting, sync_active_thread_plan_mode_reasoning_setting, sync_active_thread_reasoning_setting, sync_override_turn_context_settings); 2 external calls (format!, warn!).


##### `apply_thread_settings_to_session`  (lines 172–195)

```
fn apply_thread_settings_to_session(session: &mut ThreadSessionState, settings: &ThreadSettings)
```

**Purpose**: Copies server-provided thread settings into one local ThreadSessionState. It is the central rulebook for how server thread settings become local session settings.

**Data flow**: It receives a mutable local session and read-only server settings. It updates model-related fields, provider, service tier, approval policy, reviewer, permission profile, working folder, personality, and collaboration mode. For default collaboration mode, it also writes the model and reasoning effort directly onto the session; otherwise those values live inside the stored collaboration mode.

**Call relations**: App::apply_thread_settings_to_cached_session calls this whenever it finds a cached session that needs updating. This helper does not decide which session should be updated; it only performs the actual conversion and copying once a session has been chosen.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, set_cwd_retargeting_implicit_runtime_workspace_root); called by 1 (apply_thread_settings_to_cached_session); 1 external calls (new).


##### `thread_settings_update_has_changes`  (lines 197–209)

```
fn thread_settings_update_has_changes(params: &ThreadSettingsUpdateParams) -> bool
```

**Purpose**: Checks whether a thread settings update contains at least one real change. This prevents unnecessary server calls with empty update messages.

**Data flow**: It receives a ThreadSettingsUpdateParams value and looks at each optional setting field. If any field is present, it returns true. If every field is empty, it returns false.

**Call relations**: App::send_thread_settings_update calls this before contacting the app server. It acts like a gatekeeper: only updates with actual content are allowed through.

*Call graph*: called by 1 (send_thread_settings_update).


### `tui/src/app/thread_goal_actions.rs`

`orchestration` · `user command handling`

A “thread goal” is an objective attached to a saved conversation thread. This file exists so the terminal interface can safely let users inspect and change that goal without losing work or showing stale information. It acts like a careful receptionist: it asks the app server for the current goal, checks that the user is still looking at the same thread, then shows the right message or prompt.

The main flows are: open a goal summary, open an editor, set a new draft goal, change only the goal’s status, or clear the goal. When setting a goal, the file is deliberately cautious. If there is already unfinished work, it asks before replacing it. If a draft goal creates files on disk and the later server update fails, it tries to clean those files back up so the system does not leave clutter behind.

It also turns one confusing server failure into a friendly explanation: temporary, unsaved sessions cannot use goals. The tests protect that message and the replace-confirmation rule. Overall, this file matters because it keeps goal actions understandable, reversible where possible, and tied to the correct visible thread.

#### Function details

##### `App::open_thread_goal_menu`  (lines 24–52)

```
async fn open_thread_goal_menu(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: Shows the current goal for a thread, if one exists. A user would trigger this when they want to see what objective is attached to the conversation.

**Data flow**: It receives the app server connection and a thread id. It asks the server for that thread’s goal, ignores the answer if the user has switched to another thread, then either shows an error, explains that no goal is set, or displays the goal summary in the chat area.

**Call relations**: This is an outward-facing TUI action. It calls the server’s goal-read operation, and if that fails it passes the error through thread_goal_error_message so the chat widget can show a helpful user-facing message.

*Call graph*: calls 2 internal fn (thread_goal_error_message, thread_goal_get).


##### `App::maybe_prompt_resume_paused_goal_after_resume`  (lines 54–82)

```
async fn maybe_prompt_resume_paused_goal_after_resume(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: After reopening a saved session, this checks whether the goal was left in a stopped or limited state and, if so, offers a prompt to continue it. It prevents a paused goal from being silently forgotten after resume.

**Data flow**: It takes the server connection and thread id, reads the goal from the server, and first confirms the same thread is still displayed. If there is no goal, or the goal is already in a normal state, nothing changes. If the goal is paused, blocked, or usage-limited, it shows a resume prompt with the goal objective.

**Call relations**: This runs after a resume flow rather than from a direct goal menu action. It calls the server to read the goal; unlike user-triggered reads, a failure is only logged as a warning because this is a convenience prompt, not the main requested action.

*Call graph*: calls 1 internal fn (thread_goal_get); 2 external calls (matches!, warn!).


##### `App::open_thread_goal_editor`  (lines 84–126)

```
async fn open_thread_goal_editor(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: Option<ThreadId>,
    )
```

**Purpose**: Opens an editing prompt for the current goal. It gives the user the full editable objective text, including text loaded from any goal files when needed.

**Data flow**: It starts with an optional thread id. If there is no thread id, or the server says there is no goal, it shows guidance about creating a goal first. If a goal exists, it finds the app’s home folder, asks the goal-files helper for the editable objective text, updates the goal with that text when possible, then shows the edit prompt as long as the user is still on the same thread.

**Call relations**: This action depends on the server for the saved goal and on goal_files::objective_text_for_edit for turning stored goal content into text suitable for editing. It uses show_no_thread_goal_to_edit for the no-goal path and thread_goal_error_message for read failures.

*Call graph*: calls 5 internal fn (show_no_thread_goal_to_edit, thread_goal_error_message, codex_home_path, thread_goal_get, objective_text_for_edit).


##### `App::set_thread_goal_draft`  (lines 128–227)

```
async fn set_thread_goal_draft(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        draft: goal_files::GoalDraft,
        mode: ThreadGoalSetMode,
    )
```

**Purpose**: Creates, updates, or replaces a thread goal from a draft the user has entered. This is the central “save this goal” path, and it is careful not to overwrite unfinished goals without confirmation.

**Data flow**: It receives a thread id, a draft objective, and a mode saying whether to confirm, replace, or update. If confirmation is required, it first reads any existing goal and may show a replace confirmation instead of continuing. Then it materializes the draft, which can mean preparing files as well as text. If replacing, it clears the old goal first. Finally it sends the new objective, status, and optional token budget to the server. On success it shows the new status and usage summary; on failure it removes any newly created files and shows an error.

**Call relations**: This is the busiest goal action in the file. It calls show_replace_thread_goal_confirmation when the user must decide, should_confirm_before_replacing_goal to decide whether that prompt is needed, cleanup_materialized_goal_files when a partially prepared draft must be undone, and thread_goal_error_message whenever a server failure must be shown clearly.

*Call graph*: calls 10 internal fn (show_replace_thread_goal_confirmation, cleanup_materialized_goal_files, should_confirm_before_replacing_goal, thread_goal_error_message, codex_home_path, thread_goal_clear, thread_goal_get, thread_goal_set, goal_usage_summary, materialize_goal_draft); 2 external calls (format!, matches!).


##### `App::set_thread_goal_status`  (lines 229–256)

```
async fn set_thread_goal_status(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        status: ThreadGoalStatus,
    )
```

**Purpose**: Changes only the status of an existing goal, such as making it active or paused, without changing the goal text. This is useful for small state changes where the objective itself stays the same.

**Data flow**: It receives the server connection, thread id, and desired status. It sends a goal update with no new objective and no new token budget. If the user is still viewing the same thread, it either shows the updated status and usage summary or shows a readable error.

**Call relations**: This is a narrower update path than App::set_thread_goal_draft. It hands the status update to the server’s set operation and uses thread_goal_error_message if that update fails.

*Call graph*: calls 3 internal fn (thread_goal_error_message, thread_goal_set, goal_usage_summary); 1 external calls (format!).


##### `App::clear_thread_goal`  (lines 258–284)

```
async fn clear_thread_goal(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: Removes the goal from a thread. It gives the user a clear result whether a goal was actually cleared or there was nothing to remove.

**Data flow**: It takes a server connection and thread id, asks the server to clear that thread’s goal, then checks that the same thread is still visible. If the server reports that a goal was cleared, it shows “Goal cleared.” If there was no goal, it explains that. If the server call fails, it shows an error message.

**Call relations**: This is the delete path for goals. It depends on the server’s clear operation and uses thread_goal_error_message to turn failures into chat-visible text.

*Call graph*: calls 2 internal fn (thread_goal_error_message, thread_goal_clear).


##### `App::show_replace_thread_goal_confirmation`  (lines 286–325)

```
fn show_replace_thread_goal_confirmation(
        &mut self,
        thread_id: ThreadId,
        draft: goal_files::GoalDraft,
    )
```

**Purpose**: Shows a popup asking whether the user really wants to replace an existing unfinished goal. It protects users from accidentally throwing away in-progress goal state.

**Data flow**: It receives the thread id and the new draft goal. It builds two choices: replace the current goal, or cancel. The replace choice sends an AppEvent::SetThreadGoalDraft event with replace mode. The popup also shows a shortened preview of the new objective so the user knows what they are about to apply.

**Call relations**: App::set_thread_goal_draft calls this when it finds an existing goal that should not be overwritten silently. If the user chooses replacement, the generated action sends the flow back through the normal goal-setting event path, this time with explicit replace permission.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); called by 1 (set_thread_goal_draft); 3 external calls (default, format!, vec!).


##### `App::show_no_thread_goal_to_edit`  (lines 327–334)

```
fn show_no_thread_goal_to_edit(&mut self)
```

**Purpose**: Tells the user that there is no current goal to edit and points them toward creating one first. It keeps the editor flow from failing silently.

**Data flow**: It reads no outside data. It writes two messages into the chat widget: an error saying no goal is set, and an informational hint with goal usage instructions.

**Call relations**: App::open_thread_goal_editor calls this whenever editing cannot continue because there is no usable thread goal. It is the shared no-goal response for that editor path.

*Call graph*: called by 1 (open_thread_goal_editor).


##### `cleanup_materialized_goal_files`  (lines 337–346)

```
async fn cleanup_materialized_goal_files(
    app_server: &mut AppServerSession,
    output_dir: Option<goal_files::GoalFilePath>,
)
```

**Purpose**: Removes goal files that were created while preparing a draft if the later goal update fails. This prevents failed operations from leaving stray files behind.

**Data flow**: It receives the server connection and an optional path to files that were produced for the goal. If there is a path, it asks the server to remove it. If removal fails, it logs a warning rather than interrupting the user with another error.

**Call relations**: App::set_thread_goal_draft calls this after a replace or set operation fails following draft materialization. It is a cleanup helper for the goal-save flow, not a user-facing command.

*Call graph*: called by 1 (set_thread_goal_draft); 2 external calls (warn!, fs_remove_path).


##### `thread_goal_error_message`  (lines 348–354)

```
fn thread_goal_error_message(action: &str, err: &color_eyre::Report) -> String
```

**Purpose**: Turns a lower-level goal error into text that makes sense to a user. In particular, it replaces a technical temporary-session failure with a practical explanation and next steps.

**Data flow**: It receives a short action word, such as “read” or “set,” and an error report. It checks whether the error means the thread is temporary and cannot support goals. If so, it returns the special friendly message; otherwise it returns a normal “Failed to … thread goal” message with the error context.

**Call relations**: All the main goal actions use this before showing server failures in the chat. It relies on is_ephemeral_thread_goal_error to recognize the temporary-session case, and its behavior is also checked by the tests.

*Call graph*: calls 1 internal fn (is_ephemeral_thread_goal_error); called by 6 (clear_thread_goal, open_thread_goal_editor, open_thread_goal_menu, set_thread_goal_draft, set_thread_goal_status, thread_goal_ephemeral_error_message_renders_snapshot); 1 external calls (format!).


##### `is_ephemeral_thread_goal_error`  (lines 356–362)

```
fn is_ephemeral_thread_goal_error(err: &color_eyre::Report) -> bool
```

**Purpose**: Detects whether an error is really saying that the current thread is temporary and therefore cannot have goals. This lets the UI show a helpful explanation instead of a server phrase.

**Data flow**: It receives an error report, walks through the chain of causes inside that report, converts each cause to text, and looks for the known messages used for ephemeral-thread goal failures. It returns true if any cause matches, otherwise false.

**Call relations**: thread_goal_error_message calls this as its special-case detector. The rest of the file does not need to know the exact server wording for this failure.

*Call graph*: called by 1 (thread_goal_error_message); 1 external calls (chain).


##### `should_confirm_before_replacing_goal`  (lines 364–375)

```
fn should_confirm_before_replacing_goal(goal: &ThreadGoal) -> bool
```

**Purpose**: Decides whether replacing an existing goal should ask the user for confirmation. Finished goals can be replaced directly, but unfinished or limited goals are protected.

**Data flow**: It receives a ThreadGoal and inspects its status. If the status is Complete, it returns false. If the goal is active, paused, blocked, usage-limited, or budget-limited, it returns true.

**Call relations**: App::set_thread_goal_draft uses this before replacing an existing goal. The tests cover both the completed-goal case and the unfinished-goal cases so the safety rule stays stable.

*Call graph*: called by 1 (set_thread_goal_draft).


##### `tests::thread_goal_error_message_explains_temporary_session`  (lines 386–396)

```
fn thread_goal_error_message_explains_temporary_session()
```

**Purpose**: Checks that the special temporary-session error becomes the friendly explanation users need. This protects the wording that tells users to start or resume a saved session.

**Data flow**: It builds an error containing the known ephemeral-thread message, passes it to thread_goal_error_message, and compares the result with the expected friendly text.

**Call relations**: This test exercises the error-formatting path used by the main goal actions. It confirms that thread_goal_error_message recognizes errors through is_ephemeral_thread_goal_error.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::thread_goal_ephemeral_error_message_renders_snapshot`  (lines 399–419)

```
fn thread_goal_ephemeral_error_message_renders_snapshot()
```

**Purpose**: Checks how the friendly temporary-session message actually appears in the terminal display. This guards against layout or rendering changes that would make the message hard to read.

**Data flow**: It creates the same kind of temporary-session error, turns it into an error history cell, renders that cell into a small test terminal, and compares the terminal output with a stored snapshot.

**Call relations**: This test uses thread_goal_error_message and then sends the result through the terminal history rendering path. It connects the message helper to what a user would actually see on screen.

*Call graph*: calls 4 internal fn (thread_goal_error_message, with_options, insert_history_lines, new); 4 external calls (new, eyre!, new_error_event, assert_snapshot!).


##### `tests::thread_goal_error_message_preserves_generic_failure_context`  (lines 422–430)

```
fn thread_goal_error_message_preserves_generic_failure_context()
```

**Purpose**: Checks that ordinary failures are not incorrectly replaced by the temporary-session explanation. Users still need the original context when the problem is something else.

**Data flow**: It builds a generic server-disappeared error, passes it to thread_goal_error_message, and verifies that the returned text says the read failed and keeps the higher-level error context.

**Call relations**: This test protects the non-special branch of thread_goal_error_message. It complements the temporary-session tests by making sure the special case is not too broad.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::completed_goal_does_not_require_replace_confirmation`  (lines 433–437)

```
fn completed_goal_does_not_require_replace_confirmation()
```

**Purpose**: Checks that a completed goal can be replaced without asking for confirmation. Once work is finished, starting a fresh goal should be smooth.

**Data flow**: It creates a sample completed goal with tests::test_goal, passes it to should_confirm_before_replacing_goal, and asserts that the answer is false.

**Call relations**: This test protects the rule used by App::set_thread_goal_draft when deciding whether to show the replacement popup.

*Call graph*: 1 external calls (assert!).


##### `tests::unfinished_goals_require_replace_confirmation`  (lines 440–450)

```
fn unfinished_goals_require_replace_confirmation()
```

**Purpose**: Checks that every unfinished or limited goal status requires confirmation before replacement. This protects users from accidentally replacing work that may still matter.

**Data flow**: It loops through active, paused, blocked, usage-limited, and budget-limited statuses. For each one, it creates a sample goal and asserts that should_confirm_before_replacing_goal returns true.

**Call relations**: This test guards the safety behavior behind App::show_replace_thread_goal_confirmation. If a new status rule changes, this test helps catch accidental silent replacement.

*Call graph*: 1 external calls (assert!).


##### `tests::test_goal`  (lines 452–463)

```
fn test_goal(status: ThreadGoalStatus) -> ThreadGoal
```

**Purpose**: Builds a simple sample ThreadGoal for the tests. It keeps the tests focused on the status being checked rather than on filling out every field each time.

**Data flow**: It receives a goal status and returns a ThreadGoal with that status plus fixed sample values for the thread id, objective, usage counters, and timestamps.

**Call relations**: The replacement-confirmation tests call this helper to create goals in different states. It is test support code, not part of the live TUI behavior.

*Call graph*: calls 1 internal fn (new).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-cloud-config-cache` — The cached and refreshed cloud-delivered configuration bundles that can alter settings, requirements, and available features.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-memory-store` — The saved long-term user memories and memory search results that can be loaded, updated, and inserted into future conversations.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-agent-registry-graph` — The live and persisted map of parent agents, child agents, thread names, statuses, and which helper agents are still open.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-goal-state` — The live and persisted user goals, goal progress, and goal-thread associations synchronized into prompts, storage, analytics, and UI indicators.
- `reg-external-import-ledger` — The persisted ledger of external-agent sessions already imported, used to avoid duplicate imports and track import provenance.
- `reg-connector-directory-cache` — Cached ChatGPT/app connector directories, workspace connector settings, local connector metadata, and fallback lookup results used when exposing connectors to sessions and prompts.
- `reg-project-trust-store` — Persisted and effective trust decisions for workspaces/projects that influence onboarding, permission assembly, sandbox behavior, and session startup.
- `reg-session-connector-selection` — Per-session selected or enabled app/ChatGPT connectors used to decide which connector context and tools are exposed to the model.
