# Thread and session orchestration  `stage-11`

This stage sits at the system’s long-lived runtime boundary: after requests are accepted but before individual turns execute, it decides which conversation thread or session owns the work and keeps that ownership stable across resumes, forks, shutdown, and UI switching. At its core, `thread_manager.rs` maintains the live thread registry, reconstructs threads from persisted rollout history, and bridges storage-backed threads into active `CodexThread` runtimes. `codex_thread.rs`, `session/mod.rs`, and `session/session.rs` then assemble and expose the live session object that owns turn submission, event delivery, persistence, approvals, context construction, and runtime configuration.

Supporting pieces provide the state and coordination this requires: environment resolution in `environment_selection.rs`; pending-input buffering in `session/input_queue.rs` and `session/inject.rs`; shared services and mutable session/turn state in `state/service.rs`, `state/session.rs`, `state/turn.rs`, and `state/auto_compact_window.rs`; and background turn-task lifecycle in `tasks/mod.rs`. Persistence-facing helpers in `thread-store` and rollout truncation logic rebuild effective history and synchronize metadata. Around that core, app-server, exec-server, TUI, code-mode, and extensions attach listeners, manage loaded-thread/session views, refresh per-thread integrations, and expose thread-scoped features such as goals, skills, MCP contributions, and side conversations.

## Files in this stage

### Core thread runtime
These files define the core library surface, thread manager, live thread facade, environment resolution, and the session/task machinery that constructs and runs long-lived conversation threads.

### `core/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the top-level manifest for the entire library. It begins with crate documentation and a lint policy that forbids direct `stdout`/`stderr` printing in library code, enforcing that user-visible output must flow through approved abstractions such as tracing or UI layers. The bulk of the file declares the crate's modules: session/thread orchestration, clients, prompt/context construction, execution and sandboxing, MCP integration, rollout persistence, skills/plugins, shell and spawn support, safety/guardian logic, state DB bridging, web search, review formatting, and many supporting utilities. It then carefully re-exports selected types, constants, helper functions, and subsystem entry points so external users can interact with the library without navigating its full internal layout. Several exports are intentionally crate-private to support internal coupling, while others are public stable API, including thread management types, rollout readers, model client interfaces, sandbox helpers, and prompt/debug hooks. The file also preserves backward compatibility through deprecated type aliases such as `ConversationManager` and `CodexConversation`. In effect, this module is the contract surface of codex-core: it wires together many implementation files, constrains visibility, and communicates which names are intended for downstream use.


### `core-api/src/lib.rs`

`orchestration` · `cross-cutting`

This library is a curated re-export surface over `codex-core` and many adjacent crates. It declares itself as the public facade for thread management APIs and enforces strict visibility hygiene with `#![deny(private_bounds, private_interfaces, unreachable_pub)]`, signaling that everything exposed here is intended to be a stable public contract. The file contains no implementation logic; instead it gathers the types, functions, constants, and traits that external callers need to configure Codex, start and manage threads, interact with execution infrastructure, process notifications, and work with models, features, authentication, and user instructions.

The exports are intentionally broad but structured. Core thread lifecycle items such as `ThreadManager`, `CodexThread`, `NewThread`, `StartThreadOptions`, `ThreadShutdownReport`, `StateDbHandle`, and `init_state_db` sit alongside configuration types from `codex_core::config` and `codex_config`. Execution and sandbox-related types come from `codex_exec_server`; extension and instruction-provider interfaces come from `codex_extension_api` and `codex_home`; model and feature controls come from `codex_models_manager`, `codex_model_provider_info`, and `codex_features`; protocol-facing request, event, and config types come from `codex_protocol`. The result is a single import point for embedders, reducing dependency knowledge and making `core-api` the stable boundary between internal implementation crates and external integrators.


### `core/src/thread_manager.rs`

`orchestration` · `startup, thread creation/resume/fork, request handling, shutdown`

This file is the central orchestration layer for thread lifecycles. `ThreadManager` is the public façade; `ThreadManagerState` holds the shared mutable state: a `RwLock<HashMap<ThreadId, Arc<CodexThread>>>`, a broadcast channel for thread-created notifications, auth/model/environment/plugin/MCP/skills managers, extension and user-instruction providers, the configured `ThreadStore`, optional attestation and analytics clients, optional `StateDbHandle`, and an optional captured-op log used only when test mode is forced through the global `FORCE_TEST_THREAD_MANAGER_BEHAVIOR` flag. Construction wires these dependencies together and, for tests, can synthesize a temporary codex home guarded by `TempCodexHomeGuard`.

The spawn path is layered: convenience methods build `StartThreadOptions` or resume/fork inputs, then delegate into `ThreadManagerState::spawn_thread_with_source`, which resolves session/thread source, inherited user instructions, inherited multi-agent version, optional parent rollout trace, and finally calls `Codex::spawn`. `finalize_thread_spawn` enforces a strict invariant that the first event from a new session must be `EventMsg::SessionConfigured` with `INITIAL_SUBMIT_ID`; only then is a `CodexThread` inserted into the registry. Resuming an already-running thread returns the existing `Arc<CodexThread>` if rollout-path constraints match.

Forking is history-driven. `ForkSnapshot` supports truncating before the nth user message or synthesizing an interrupted snapshot. `snapshot_turn_state`, `truncate_before_nth_user_message`, `fork_history_from_snapshot`, and `append_interrupted_boundary` inspect persisted `RolloutItem`s, detect mid-turn histories (including legacy histories without explicit turn lifecycle events), preserve explicit turn IDs when present, and avoid duplicating interrupt markers once a boundary already exists. Metadata updates route through the live thread when loaded so writes stay ordered with rollout persistence; cold threads update directly through the store. Internal threads are intentionally hidden from normal lookup/list APIs, but still participate in shutdown.

#### Function details

##### `set_thread_manager_test_mode_for_tests`  (lines 94–96)

```
fn set_thread_manager_test_mode_for_tests(enabled: bool)
```

**Purpose**: Sets the global atomic flag that enables thread-manager behaviors reserved for integration tests, such as operation capture.

**Data flow**: Takes a boolean `enabled` and writes it into `FORCE_TEST_THREAD_MANAGER_BEHAVIOR` with relaxed atomic ordering; it returns no value.

**Call relations**: Used only by test-oriented setup paths before constructing managers so later constructors can observe the flag and allocate test-only state.

*Call graph*: called by 3 (set_thread_manager_test_mode, with_models_provider_for_tests, with_models_provider_home_and_state_for_tests).


##### `should_use_test_thread_manager_behavior`  (lines 98–100)

```
fn should_use_test_thread_manager_behavior() -> bool
```

**Purpose**: Reads whether test-only thread-manager behavior is currently enabled.

**Data flow**: Reads `FORCE_TEST_THREAD_MANAGER_BEHAVIOR` with relaxed ordering and returns the resulting boolean.

**Call relations**: Consulted by constructors to decide whether to allocate the shared captured-op log.

*Call graph*: called by 2 (new, with_models_provider_home_and_state_for_tests).


##### `TempCodexHomeGuard::drop`  (lines 107–109)

```
fn drop(&mut self)
```

**Purpose**: Deletes the temporary codex-home directory created by test constructors when the guard is dropped.

**Data flow**: Reads `self.path` and calls `std::fs::remove_dir_all`; ignores any filesystem error and returns unit.

**Call relations**: Runs automatically during teardown of test-created `ThreadManager` instances that own a temporary home.

*Call graph*: 1 external calls (remove_dir_all).


##### `ForkSnapshot::from`  (lines 154–156)

```
fn from(value: usize) -> Self
```

**Purpose**: Preserves legacy `usize` fork callsites by interpreting the number as `TruncateBeforeNthUserMessage`.

**Data flow**: Consumes a `usize` and returns the corresponding `ForkSnapshot` enum variant.

**Call relations**: Used implicitly by generic `fork_thread` and `fork_thread_from_history` callers that still pass a raw integer.

*Call graph*: 1 external calls (TruncateBeforeNthUserMessage).


##### `build_models_manager`  (lines 225–234)

```
fn build_models_manager(
    config: &Config,
    auth_manager: Arc<AuthManager>,
) -> SharedModelsManager
```

**Purpose**: Builds the shared models manager from the configured model provider and auth manager.

**Data flow**: Reads `config.model_provider`, `config.codex_home`, and `config.model_catalog`, creates a provider via `create_model_provider`, then asks it for a models manager rooted at the codex home; returns `SharedModelsManager`.

**Call relations**: Called during normal `ThreadManager::new` construction to initialize model listing and collaboration-mode support.

*Call graph*: called by 1 (new); 1 external calls (create_model_provider).


##### `thread_store_from_config`  (lines 236–255)

```
fn thread_store_from_config(
    config: &Config,
    state_db: Option<StateDbHandle>,
) -> Arc<dyn ThreadStore>
```

**Purpose**: Instantiates the configured thread-store backend, either local persistent storage or an in-memory store keyed by id.

**Data flow**: Reads `config.experimental_thread_store`, feature flags, and optional `state_db`; for local storage it may spawn the rollout compression worker and constructs `LocalThreadStore` from `LocalThreadStoreConfig::from_config`, otherwise it returns `InMemoryThreadStore::for_id(id)`.

**Call relations**: Used by higher-level setup code and tests to supply the `ThreadStore` dependency consumed by `ThreadManager`.

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

**Purpose**: Constructs a production-style thread manager with all shared services and an empty live-thread registry.

**Data flow**: Consumes configuration and service dependencies, derives restriction product from `session_source`, creates the thread-created broadcast channel, initializes `PluginsManager`, `McpManager`, `SkillsManager`, and `models_manager`, then stores everything in `ThreadManagerState`; if test mode is enabled it also allocates the shared op log.

**Call relations**: This is the main constructor used by application setup and many tests; all later thread lifecycle methods operate on the state assembled here.

*Call graph*: calls 5 internal fn (new_with_options, new_with_restriction_product, new_with_extensions, build_models_manager, should_use_test_thread_manager_behavior); called by 17 (build_prompt_input, explicit_installation_id_skips_codex_home_file, interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history, interrupted_fork_snapshot_preserves_explicit_turn_id, interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source, new_uses_active_provider_for_model_refresh, resume_active_thread_from_rollout_returns_running_thread, resume_and_fork_do_not_restore_thread_environments_from_rollout, resume_stopped_thread_from_rollout_preserves_thread_source, resume_stopped_thread_from_rollout_spawns_new_thread (+7 more)); 7 external calls (clone, new, new, new, bundled_skills_enabled, restriction_product, channel).


##### `ThreadManager::with_models_provider_for_tests`  (lines 316–335)

```
fn with_models_provider_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
    ) -> Self
```

**Purpose**: Builds a test-only manager with a dummy auth manager, a supplied model provider, a temporary codex home, and default test environment manager.

**Data flow**: Enables test mode, creates a unique temp directory under `std::env::temp_dir`, ensures it exists, delegates to `with_models_provider_and_home_for_tests`, then stores a `TempCodexHomeGuard` so the directory is removed on drop.

**Call relations**: Invoked by test helpers that need a self-contained manager without manually preparing a codex home.

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

**Purpose**: Builds a test-only manager using a caller-supplied codex home and environment manager.

**Data flow**: Passes the provided auth, provider, codex-home path, and environment manager through to `with_models_provider_home_and_state_for_tests` with `state_db` set to `None`.

**Call relations**: A convenience wrapper for tests that want deterministic filesystem locations but do not need a state database.

*Call graph*: called by 10 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent, resume_agent_releases_slot_after_resume_failure, resume_agent_respects_max_threads_limit, spawn_agent_limit_shared_across_clones, spawn_agent_releases_slot_after_shutdown, spawn_agent_respects_max_threads_limit, thread_manager_with_models_provider_and_home, shutdown_all_threads_bounded_submits_shutdown_to_every_thread, start_thread_keeps_internal_threads_hidden_from_normal_lookups); 1 external calls (with_models_provider_home_and_state_for_tests).


##### `ThreadManager::with_models_provider_home_and_state_for_tests`  (lines 354–417)

```
fn with_models_provider_home_and_state_for_tests(
        auth: CodexAuth,
        provider: ModelProviderInfo,
        codex_home: PathBuf,
        environment_manager: Arc<EnvironmentManager>,
```

**Purpose**: Constructs the most configurable test-only manager, including optional state-db support and a local thread store rooted at the supplied codex home.

**Data flow**: Enables test mode, creates a dummy `AuthManager`, generates an installation id, validates that `codex_home` is absolute for skills loading, creates broadcast channel, plugin/MCP/skills managers, a `LocalThreadStore`, an empty extension registry, empty user-instructions provider, and optionally the captured-op log; returns a `ThreadManager` with no temp-home guard.

**Call relations**: Used by tests that need explicit codex-home and state-db control, including multi-agent and residency scenarios.

*Call graph*: calls 8 internal fn (new_with_options, new_with_restriction_product, new, set_thread_manager_test_mode_for_tests, should_use_test_thread_manager_behavior, from_auth_for_testing, new, from_absolute_path_checked); called by 6 (new_with_config, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_thread_subagent_restores_stored_nickname_and_role, thread_manager_with_models_provider_home_and_state, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target); 10 external calls (clone, new, new, clone, new, channel, empty_extension_registry, create_model_provider, panic!, new_v4).


##### `ThreadManager::session_source`  (lines 419–421)

```
fn session_source(&self) -> SessionSource
```

**Purpose**: Returns the manager’s default session source used for new threads when callers do not override it.

**Data flow**: Clones `self.state.session_source` and returns it.

**Call relations**: A simple accessor for callers that need to inspect manager defaults.


##### `ThreadManager::auth_manager`  (lines 423–425)

```
fn auth_manager(&self) -> Arc<AuthManager>
```

**Purpose**: Returns the shared auth manager held by the thread manager.

**Data flow**: Clones and returns `self.state.auth_manager`.

**Call relations**: Accessor used by code that needs to reuse the same auth context as thread spawning.


##### `ThreadManager::skills_manager`  (lines 427–429)

```
fn skills_manager(&self) -> Arc<SkillsManager>
```

**Purpose**: Exposes the shared skills manager used by spawned threads.

**Data flow**: Clones and returns `self.state.skills_manager`.

**Call relations**: Used by configuration-registration code that needs the same skills catalog as thread runtimes.

*Call graph*: called by 1 (register_thread_config).


##### `ThreadManager::plugins_manager`  (lines 431–433)

```
fn plugins_manager(&self) -> Arc<PluginsManager>
```

**Purpose**: Exposes the shared plugins manager.

**Data flow**: Clones and returns `self.state.plugins_manager`.

**Call relations**: Used by setup code that needs plugin information aligned with thread execution.

*Call graph*: called by 1 (register_thread_config).


##### `ThreadManager::mcp_manager`  (lines 435–437)

```
fn mcp_manager(&self) -> Arc<McpManager>
```

**Purpose**: Exposes the shared MCP manager.

**Data flow**: Clones and returns `self.state.mcp_manager`.

**Call relations**: Accessor for code that needs MCP configuration outside the spawn path.


##### `ThreadManager::environment_manager`  (lines 439–441)

```
fn environment_manager(&self) -> Arc<EnvironmentManager>
```

**Purpose**: Exposes the shared environment manager.

**Data flow**: Clones and returns `self.state.environment_manager`.

**Call relations**: Used by setup code that validates or derives environment selections.

*Call graph*: called by 1 (register_thread_config).


##### `ThreadManager::default_environment_selections`  (lines 443–448)

```
fn default_environment_selections(
        &self,
        cwd: &AbsolutePathBuf,
    ) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Computes the default per-turn environment selections for a given working directory.

**Data flow**: Reads the shared `EnvironmentManager` and the provided absolute cwd, passes both to `default_thread_environment_selections`, and returns the resulting `Vec<TurnEnvironmentSelection>`.

**Call relations**: A convenience wrapper around the shared environment-selection helper.

*Call graph*: calls 1 internal fn (default_thread_environment_selections).


##### `ThreadManager::validate_environment_selections`  (lines 450–473)

```
fn validate_environment_selections(
        &self,
        environments: &[TurnEnvironmentSelection],
    ) -> CodexResult<()>
```

**Purpose**: Validates that requested turn environments are unique and refer to known environment ids.

**Data flow**: Iterates over the provided slice, tracks seen ids in a `HashSet`, rejects duplicates with `CodexErr::InvalidRequest`, and checks each id against `environment_manager.get_environment`; returns `Ok(())` only if all selections are unique and resolvable.

**Call relations**: Called by higher-level request validation before thread startup or turn execution uses the selections.

*Call graph*: called by 1 (resolve_turn_environment_selections); 4 external calls (with_capacity, format!, InvalidRequest, len).


##### `ThreadManager::get_models_manager`  (lines 475–477)

```
fn get_models_manager(&self) -> SharedModelsManager
```

**Purpose**: Returns the shared models manager.

**Data flow**: Clones and returns `self.state.models_manager`.

**Call relations**: Accessor for callers that need direct model-manager operations.


##### `ThreadManager::list_models`  (lines 479–484)

```
async fn list_models(&self, refresh_strategy: RefreshStrategy) -> Vec<ModelPreset>
```

**Purpose**: Lists available model presets using the configured refresh strategy.

**Data flow**: Passes `refresh_strategy` through to `models_manager.list_models().await` and returns the resulting `Vec<ModelPreset>`.

**Call relations**: Thin async wrapper over the shared models manager.


##### `ThreadManager::list_collaboration_modes`  (lines 486–488)

```
fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

**Purpose**: Lists collaboration-mode masks supported by the current model manager.

**Data flow**: Reads `self.state.models_manager` and returns `list_collaboration_modes()`.

**Call relations**: Used by callers that need capability discovery without spawning a thread.


##### `ThreadManager::list_thread_ids`  (lines 490–492)

```
async fn list_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Lists ids of currently loaded non-internal threads.

**Data flow**: Delegates to `ThreadManagerState::list_thread_ids` and returns its collected `Vec<ThreadId>`.

**Call relations**: Public wrapper over the state-level registry scan.


##### `ThreadManager::subscribe_thread_created`  (lines 494–496)

```
fn subscribe_thread_created(&self) -> broadcast::Receiver<ThreadId>
```

**Purpose**: Subscribes to notifications emitted when new threads are created.

**Data flow**: Calls `broadcast::Sender::subscribe` on `thread_created_tx` and returns a receiver.

**Call relations**: Lets external orchestration observe thread creation events without polling.


##### `ThreadManager::get_thread`  (lines 498–500)

```
async fn get_thread(&self, thread_id: ThreadId) -> CodexResult<Arc<CodexThread>>
```

**Purpose**: Fetches a loaded thread by id, excluding internal threads from visibility.

**Data flow**: Delegates to `ThreadManagerState::get_thread` and returns either `Arc<CodexThread>` or `CodexErr::ThreadNotFound`.

**Call relations**: Used by metadata updates, subagent spawning, and external callers that need a live thread handle.

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

**Purpose**: Updates thread metadata through a single API that preserves ordering for loaded threads and still supports unloaded threads.

**Data flow**: Takes `thread_id`, a `ThreadMetadataPatch`, and `include_archived`. If the thread is loaded, it rejects ephemeral threads, then calls `CodexThread::update_thread_metadata`; otherwise it calls `thread_store.update_thread_metadata(UpdateThreadMetadataParams { ... })`. Store errors are translated into `CodexErr` variants, especially `ThreadNotFound`, invalid requests, unsupported operations, and fatal failures.

**Call relations**: This is the public metadata mutation entrypoint; it chooses the live-thread path when possible so metadata writes stay serialized with rollout persistence.

*Call graph*: calls 1 internal fn (get_thread); 2 external calls (format!, InvalidRequest).


##### `ThreadManager::list_agent_subtree_thread_ids`  (lines 541–580)

```
async fn list_agent_subtree_thread_ids(
        &self,
        thread_id: ThreadId,
    ) -> CodexResult<Vec<ThreadId>>
```

**Purpose**: Returns a root thread id plus all known descendants in its agent-spawn subtree, combining persisted and live sources.

**Data flow**: Starts with the requested `thread_id`, deduplicates with a `HashSet`, optionally queries `state_db` for descendants in both `Open` and `Closed` statuses, then asks `agent_control().list_live_agent_subtree_thread_ids(thread_id)` for currently loaded descendants; returns the accumulated vector.

**Call relations**: Used when callers need a complete subtree view that spans unloaded persisted descendants and live in-memory descendants.

*Call graph*: calls 1 internal fn (agent_control); 2 external calls (new, new).


##### `ThreadManager::start_thread`  (lines 582–586)

```
async fn start_thread(&self, config: Config) -> CodexResult<NewThread>
```

**Purpose**: Starts a new thread with default empty dynamic-tool configuration.

**Data flow**: Consumes a `Config`, boxes the future to avoid async-state bloat, and delegates to `start_thread_with_tools(config, Vec::new())`.

**Call relations**: Top-level convenience entrypoint for ordinary thread creation.

*Call graph*: calls 1 internal fn (start_thread_with_tools); called by 1 (start_thread); 2 external calls (pin, new).


##### `ThreadManager::start_thread_with_tools`  (lines 588–609)

```
async fn start_thread_with_tools(
        &self,
        config: Config,
        dynamic_tools: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a new thread with caller-supplied dynamic tools and default environment selections.

**Data flow**: Computes default environments from `config.cwd`, builds `StartThreadOptions` with `InitialHistory::New`, no explicit session/thread source, no metrics service name or parent trace, and default extension init, then delegates to `start_thread_with_options`.

**Call relations**: Convenience wrapper used by `start_thread` and callers that need dynamic tools but not full option control.

*Call graph*: calls 2 internal fn (default_thread_environment_selections, start_thread_with_options); called by 1 (start_thread); 2 external calls (pin, default).


##### `ThreadManager::start_thread_with_options`  (lines 611–617)

```
async fn start_thread_with_options(
        &self,
        options: StartThreadOptions,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a thread from fully specified startup options.

**Data flow**: Passes the provided `StartThreadOptions` to `start_thread_with_options_and_fork_source` with no fork source id and returns the resulting `NewThread`.

**Call relations**: Public option-rich entrypoint used by tests and higher-level orchestration.

*Call graph*: calls 1 internal fn (start_thread_with_options_and_fork_source); called by 1 (start_thread_with_tools).


##### `ThreadManager::start_thread_with_options_and_fork_source`  (lines 619–649)

```
async fn start_thread_with_options_and_fork_source(
        &self,
        options: StartThreadOptions,
        forked_from_thread_id: Option<ThreadId>,
    ) -> CodexResult<NewThread>
```

**Purpose**: Normalizes session/thread source from the initial history and starts a thread, optionally recording which thread it was forked from.

**Data flow**: Reads resumed session/thread source from `options.initial_history` when present, applies explicit overrides from `options`, constructs `AgentControl`, and delegates to `ThreadManagerState::spawn_thread_with_source` with the resolved sources, dynamic tools, environments, extension init, and optional `forked_from_thread_id`.

**Call relations**: Shared implementation behind ordinary starts and subagent starts after fork history has been prepared.

*Call graph*: calls 1 internal fn (agent_control); called by 2 (spawn_subagent, start_thread_with_options); 2 external calls (clone, pin).


##### `ThreadManager::spawn_subagent`  (lines 653–686)

```
async fn spawn_subagent(
        &self,
        forked_from_thread_id: ThreadId,
        mut options: StartThreadOptions,
    ) -> CodexResult<NewThread>
```

**Purpose**: Creates a subagent thread by snapshotting persisted history from an existing live thread and forcing an interrupted fork snapshot.

**Data flow**: Loads the source thread with `get_thread`, materializes and flushes its rollout, reads the stored thread including history, converts it to `InitialHistory`, derives inherited multi-agent version from the source thread, rewrites `options.initial_history` using `fork_history_from_snapshot(ForkSnapshot::Interrupted, ...)` with the correct interrupted marker, then starts the child thread while recording `forked_from_thread_id`.

**Call relations**: Used for thread-spawn subagents; it ensures the child forks from persisted history rather than transient in-memory state.

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

**Purpose**: Resumes a thread by loading persisted history from a rollout path and spawning or reusing the corresponding runtime.

**Data flow**: Reads `InitialHistory` from the rollout path via `initial_history_from_rollout_path`, then delegates to `resume_thread_with_history` with the supplied config, auth manager, and optional parent trace.

**Call relations**: Called by higher-level resume flows that identify threads by rollout file path.

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

**Purpose**: Resumes a thread from already available initial history, preserving resumed session/thread source when encoded in that history.

**Data flow**: Computes default environments from `config.cwd`, extracts resumed session/thread source from `initial_history` or falls back to the manager default, constructs `AgentControl`, and delegates to `ThreadManagerState::spawn_thread_with_source` with no parent/fork source and default extension init.

**Call relations**: Shared resume path used after rollout-path loading and by tests that inject synthetic histories.

*Call graph*: calls 3 internal fn (default_thread_environment_selections, agent_control, get_resumed_session_sources); called by 1 (resume_thread_from_rollout); 3 external calls (pin, new, default).


##### `ThreadManager::start_thread_with_user_shell_override_for_tests`  (lines 741–766)

```
async fn start_thread_with_user_shell_override_for_tests(
        &self,
        config: Config,
        user_shell_override: crate::shell::Shell,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a new thread while forcing a specific shell implementation for test scenarios.

**Data flow**: Computes default environments, clones the auth manager, constructs `AgentControl`, and delegates to `ThreadManagerState::spawn_thread` with `InitialHistory::New`, no parent/fork source, no dynamic tools, and `Some(user_shell_override)`.

**Call relations**: Test-only helper for shell-sensitive integration tests.

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

**Purpose**: Resumes a thread from a rollout path while forcing a specific shell implementation for tests.

**Data flow**: Loads `InitialHistory` from the rollout path, computes default environments, resolves resumed session/thread source from the history, and delegates to `spawn_thread_with_source` with the supplied auth manager and shell override.

**Call relations**: Test-only counterpart to rollout-path resume for shell-sensitive cases.

*Call graph*: calls 3 internal fn (default_thread_environment_selections, agent_control, initial_history_from_rollout_path); called by 1 (resume_thread_from_rollout_with_user_shell_override); 3 external calls (pin, new, default).


##### `ThreadManager::remove_thread`  (lines 807–809)

```
async fn remove_thread(&self, thread_id: &ThreadId) -> Option<Arc<CodexThread>>
```

**Purpose**: Removes a thread from the manager’s live registry without affecting any other `Arc` holders.

**Data flow**: Acquires the write lock on `state.threads`, removes the entry for the given `ThreadId`, and returns the removed `Arc<CodexThread>` if present.

**Call relations**: Used by tests and cleanup paths after shutdown or when intentionally unloading a thread.


##### `ThreadManager::shutdown_all_threads_bounded`  (lines 814–860)

```
async fn shutdown_all_threads_bounded(&self, timeout: Duration) -> ThreadShutdownReport
```

**Purpose**: Attempts to shut down every tracked thread concurrently within a per-thread timeout and reports which ones completed, failed submission, or timed out.

**Data flow**: Snapshots the current thread map into a vector, launches one timeout-wrapped `shutdown_and_wait()` future per thread in a `FuturesUnordered`, classifies each result into `ShutdownOutcome`, removes only successfully completed threads from the registry, sorts each report list by stringified thread id, and returns `ThreadShutdownReport`.

**Call relations**: Used during teardown and tests to drain all live threads while preserving incomplete ones for later inspection or retry.

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

**Purpose**: Forks a thread identified by rollout path using either a legacy numeric snapshot or an explicit `ForkSnapshot` mode.

**Data flow**: Converts `snapshot` via `Into<ForkSnapshot>`, loads `InitialHistory` from the rollout path, then delegates to `fork_thread_from_history` with the supplied config, optional thread source, and optional parent trace.

**Call relations**: Public path-based fork entrypoint used by callers that only know the persisted rollout location.

*Call graph*: calls 2 internal fn (fork_thread_from_history, initial_history_from_rollout_path); called by 1 (fork_thread); 1 external calls (into).


##### `ThreadManager::initial_history_from_rollout_path`  (lines 883–899)

```
async fn initial_history_from_rollout_path(
        &self,
        rollout_path: PathBuf,
    ) -> CodexResult<InitialHistory>
```

**Purpose**: Loads persisted thread history from the thread store using a rollout path and converts it into `InitialHistory::Resumed`.

**Data flow**: Calls `thread_store.read_thread_by_rollout_path` with `include_archived` and `include_history` enabled, maps store errors through `thread_store_rollout_read_error`, then passes the resulting `StoredThread` plus the originally requested path to `stored_thread_to_initial_history`.

**Call relations**: Shared helper for resume and fork operations that begin from a rollout path.

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

**Purpose**: Forks a thread from already loaded history rather than reading from the store itself.

**Data flow**: Converts the generic snapshot argument into `ForkSnapshot` and delegates to `fork_thread_with_initial_history`.

**Call relations**: Used by `fork_thread` after loading history and by callers that already have `InitialHistory` in memory.

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

**Purpose**: Builds the actual fork history, computes inherited multi-agent behavior, and spawns the forked thread.

**Data flow**: Determines `forked_from_thread_id` from the incoming `InitialHistory`, computes the effective multi-agent version for the spawn, derives the appropriate `InterruptedTurnHistoryMarker`, rewrites the history with `fork_history_from_snapshot`, computes default environments from `config.cwd`, then delegates to `ThreadManagerState::spawn_thread` with the manager auth, `AgentControl`, and optional thread source/trace.

**Call relations**: Core implementation behind all fork APIs; it is where snapshot semantics and inherited multi-agent behavior are applied.

*Call graph*: calls 5 internal fn (default_thread_environment_selections, from_config_and_version, agent_control, fork_history_from_snapshot, forked_from_id); called by 1 (fork_thread_from_history); 4 external calls (clone, pin, new, default).


##### `ThreadManager::agent_control`  (lines 973–975)

```
fn agent_control(&self) -> AgentControl
```

**Purpose**: Creates an `AgentControl` handle backed by a weak reference to the shared manager state.

**Data flow**: Downgrades `Arc<ThreadManagerState>` to `Weak` and constructs `AgentControl::new` from it.

**Call relations**: Used whenever spawn or subtree operations need a control handle without creating strong reference cycles.

*Call graph*: calls 1 internal fn (new); called by 6 (fork_thread_with_initial_history, list_agent_subtree_thread_ids, resume_thread_from_rollout_with_user_shell_override_for_tests, resume_thread_with_history, start_thread_with_options_and_fork_source, start_thread_with_user_shell_override_for_tests); 1 external calls (downgrade).


##### `ThreadManager::captured_ops`  (lines 978–984)

```
fn captured_ops(&self) -> Vec<(ThreadId, Op)>
```

**Purpose**: Returns the test-only log of submitted operations captured by the manager.

**Data flow**: Reads `state.ops_log`, locks the mutex if present, clones the stored `(ThreadId, Op)` vector, and falls back to an empty vector if logging is disabled or poisoned.

**Call relations**: Available only in tests to assert what operations were sent through `send_op`.


##### `ThreadManagerState::state_db`  (lines 988–990)

```
fn state_db(&self) -> Option<StateDbHandle>
```

**Purpose**: Returns the optional state database handle associated with the manager.

**Data flow**: Clones and returns `self.state_db`.

**Call relations**: Used by subtree enumeration and other state-db-aware logic.


##### `ThreadManagerState::list_thread_ids`  (lines 992–1001)

```
async fn list_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Collects ids of loaded threads that are not marked as internal sessions.

**Data flow**: Reads the thread map under the read lock, filters out entries whose `thread.session_source.is_internal()` is true, and returns the remaining ids.

**Call relations**: Backs the public `ThreadManager::list_thread_ids` API.


##### `ThreadManagerState::list_live_thread_spawn_edges`  (lines 1004–1022)

```
async fn list_live_thread_spawn_edges(&self) -> Vec<(ThreadId, ThreadId)>
```

**Purpose**: Lists currently loaded parent-child edges for thread-spawn subagents, excluding internal sessions.

**Data flow**: Scans the live thread map, skips internal threads, pattern-matches `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, .. })`, and returns `(parent_thread_id, child_thread_id)` pairs.

**Call relations**: Supports live topology inspection for agent-thread trees.


##### `ThreadManagerState::get_thread`  (lines 1025–1031)

```
async fn get_thread(&self, thread_id: ThreadId) -> CodexResult<Arc<CodexThread>>
```

**Purpose**: Fetches a loaded non-internal thread by id or returns `ThreadNotFound`.

**Data flow**: Reads the thread map, returns a cloned `Arc<CodexThread>` only if the entry exists and its session source is not internal; otherwise returns `CodexErr::ThreadNotFound(thread_id)`.

**Call relations**: Used internally by send-op, inheritance logic, rollout-trace inheritance, and user-instruction inheritance.

*Call graph*: called by 4 (initial_multi_agent_version_for_spawn, parent_rollout_thread_trace_for_source, send_op, user_instructions_for_spawn); 1 external calls (ThreadNotFound).


##### `ThreadManagerState::read_stored_thread`  (lines 1033–1056)

```
async fn read_stored_thread(
        &self,
        params: ReadThreadParams,
    ) -> CodexResult<StoredThread>
```

**Purpose**: Reads a persisted thread from the thread store and normalizes store-specific errors into `CodexErr`.

**Data flow**: Passes `ReadThreadParams` to `thread_store.read_thread().await`; maps `ThreadStoreError::ThreadNotFound` to `CodexErr::ThreadNotFound`, certain invalid-request messages about missing rollouts to the same not-found error, other invalid requests to fatal errors with context, and all remaining errors to fatal errors.

**Call relations**: Provides a consistent error surface for callers that need persisted thread data.


##### `ThreadManagerState::send_op`  (lines 1059–1067)

```
async fn send_op(&self, thread_id: ThreadId, op: Op) -> CodexResult<String>
```

**Purpose**: Submits an operation to a live thread and optionally records it in the test op log.

**Data flow**: Looks up the thread with `get_thread`, clones and appends the `Op` into `ops_log` if enabled and lockable, then calls `thread.submit(op).await` and returns the submission id/string from the thread.

**Call relations**: This is the state-level dispatch path used by `AgentControl` and tests that inspect submitted operations.

*Call graph*: calls 1 internal fn (get_thread); 1 external calls (clone).


##### `ThreadManagerState::remove_thread`  (lines 1070–1072)

```
async fn remove_thread(&self, thread_id: &ThreadId) -> Option<Arc<CodexThread>>
```

**Purpose**: Removes a thread from the live registry by id.

**Data flow**: Acquires the write lock on `threads`, removes the entry, and returns the removed `Arc<CodexThread>` if any.

**Call relations**: Internal counterpart to the public removal helper.


##### `ThreadManagerState::effective_multi_agent_version_for_spawn`  (lines 1074–1090)

```
async fn effective_multi_agent_version_for_spawn(
        &self,
        initial_history: &InitialHistory,
        session_source: Option<&SessionSource>,
        parent_thread_id: Option<ThreadId>,
```

**Purpose**: Computes the multi-agent version a new runtime should use, falling back to config defaults when no inherited or history-derived version exists.

**Data flow**: Calls `initial_multi_agent_version_for_spawn`; if it returns `None`, computes `config.multi_agent_version_from_features()` and returns that version.

**Call relations**: Used by forking logic when the caller needs a concrete version before rewriting history.

*Call graph*: calls 1 internal fn (initial_multi_agent_version_for_spawn).


##### `ThreadManagerState::initial_multi_agent_version_for_spawn`  (lines 1092–1118)

```
async fn initial_multi_agent_version_for_spawn(
        &self,
        initial_history: &InitialHistory,
        session_source: Option<&SessionSource>,
        parent_thread_id: Option<ThreadId>,
```

**Purpose**: Determines the inherited or history-resolved multi-agent version for a spawn without applying config fallback.

**Data flow**: Derives an `inherited_thread_id` from `session_source`, `initial_history`, `parent_thread_id`, and `forked_from_thread_id`; if present, tries to load the live parent thread and read `thread.multi_agent_version()`. It then calls `resolve_multi_agent_version(initial_history, inherited_multi_agent_version)` and returns the optional result.

**Call relations**: Called both by `effective_multi_agent_version_for_spawn` and directly during spawn setup to pass inherited version into `Codex::spawn`.

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

**Purpose**: Resolves which user instructions a new runtime should start with, either freshly loaded for root agents or inherited from a live parent for non-root agents.

**Data flow**: Checks whether `session_source` is a non-root agent. Root agents call `user_instructions_provider.load_user_instructions().await`. Non-root agents derive an inherited thread id from the session source or parent/fork ids, attempt to reload that live thread, and read `thread.codex.session.user_instructions().await`; they return `LoadedUserInstructions { instructions, warnings: Vec::new() }`, with no fallback provider load if the parent is unavailable.

**Call relations**: Used only during spawn preparation so child agents inherit the exact live instructions context instead of independently reloading provider state.

*Call graph*: calls 1 internal fn (get_thread); called by 1 (spawn_thread_with_source); 2 external calls (new, is_non_root_agent).


##### `ThreadManagerState::spawn_new_thread`  (lines 1171–1189)

```
async fn spawn_new_thread(
        &self,
        config: Config,
        agent_control: AgentControl,
    ) -> CodexResult<NewThread>
```

**Purpose**: Starts a brand-new thread using the manager’s default session source and no history.

**Data flow**: Boxes the future and delegates to `spawn_new_thread_with_source` with `InitialHistory::New`, no parent/fork source, no thread source, no inherited environments or exec policy, and no explicit environments.

**Call relations**: Convenience state-level entrypoint for callers that only need a fresh thread.

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

**Purpose**: Starts a new thread with explicit session-source and inheritance controls while still using empty history.

**Data flow**: Uses caller-provided environments or computes defaults from `config.cwd`, then delegates to `spawn_thread_with_source` with `InitialHistory::New`, cloned auth manager, empty dynamic tools, optional metrics service name, inherited environments/policy, and default extension init.

**Call relations**: Shared helper for fresh-thread creation in contexts that need explicit source metadata.

*Call graph*: calls 1 internal fn (spawn_thread_with_source); called by 1 (spawn_new_thread); 4 external calls (clone, pin, new, default).


##### `ThreadManagerState::resume_thread_with_history_with_source`  (lines 1229–1264)

```
async fn resume_thread_with_history_with_source(
        &self,
        options: ResumeThreadWithHistoryOptions,
    ) -> CodexResult<NewThread>
```

**Purpose**: Resumes a thread from supplied history while allowing explicit session source and inherited environment/policy overrides.

**Data flow**: Destructures `ResumeThreadWithHistoryOptions`, computes default environments from `config.cwd`, derives `thread_source` from `initial_history.get_resumed_thread_source()`, and delegates to `spawn_thread_with_source` with cloned auth manager and no fork source.

**Call relations**: Used by internal resume flows that need more control than the public `ThreadManager` wrappers expose.

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

**Purpose**: Spawns a forked thread with explicit source metadata and optional inherited environment/policy state.

**Data flow**: Uses caller-provided environments or computes defaults, then delegates to `spawn_thread_with_source` with cloned auth manager, the supplied `initial_history`, session source, parent/fork ids, and default extension init.

**Call relations**: Internal helper for fork-like flows that already prepared the history and source metadata.

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

**Purpose**: Starts a thread using the manager’s default session source while allowing arbitrary initial history and startup options.

**Data flow**: Boxes the future and forwards all arguments to `spawn_thread_with_source`, supplying `self.session_source.clone()` and no inherited environments or exec policy.

**Call relations**: Shared wrapper used by public `ThreadManager` methods once they have normalized their inputs.

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

**Purpose**: Implements the full thread spawn/resume path, including duplicate-resume handling, inheritance resolution, `Codex::spawn`, and final registration.

**Data flow**: First checks whether `initial_history` is `Resumed`; if so, it looks for an existing live thread with the same conversation id. A running matching thread is returned directly, while a stopped one is removed from the registry. It then loads user instructions, derives parent rollout trace, computes inherited multi-agent version, and calls `Codex::spawn(CodexSpawnArgs { ... })` with config, auth, managers, history, source metadata, dynamic tools, inherited environments/policy, extension init, analytics, thread store, attestation provider, and inherited version. The resulting `Codex` and `thread_id` are passed to `finalize_thread_spawn`; if this was a resumed thread, it emits the resume lifecycle event before returning `NewThread`.

**Call relations**: This is the core lifecycle engine behind fresh starts, resumes, forks, and subagent spawns.

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

**Purpose**: Consumes the first event from a newly spawned `Codex`, verifies it is the required session-configuration event, and inserts the resulting `CodexThread` into the registry.

**Data flow**: Awaits `codex.next_event()`, requires `EventMsg::SessionConfigured` with `id == INITIAL_SUBMIT_ID`, then acquires the thread-map write lock. If the thread id is vacant, it constructs `CodexThread::new(codex, session_configured.clone(), rollout_path, session_source)`, inserts it, and returns `NewThread`. If the id is already occupied, it shuts down the duplicate `Codex` best-effort and returns `CodexErr::InvalidRequest`.

**Call relations**: Called only from `spawn_thread_with_source`; it enforces the first-event invariant and prevents duplicate live registrations.

*Call graph*: calls 3 internal fn (new, next_event, shutdown_and_wait); called by 1 (spawn_thread_with_source); 4 external calls (new, format!, InvalidRequest, warn!).


##### `ThreadManagerState::notify_thread_created`  (lines 1486–1488)

```
fn notify_thread_created(&self, thread_id: ThreadId)
```

**Purpose**: Broadcasts that a thread id has been created.

**Data flow**: Sends `thread_id` on `thread_created_tx` and ignores send errors such as no active subscribers.

**Call relations**: Used by thread startup code elsewhere in the subsystem to notify observers.

*Call graph*: 1 external calls (send).


##### `ThreadManagerState::parent_rollout_thread_trace_for_source`  (lines 1490–1518)

```
async fn parent_rollout_thread_trace_for_source(
        &self,
        session_source: &SessionSource,
        initial_history: &InitialHistory,
    ) -> codex_rollout_trace::ThreadTraceContext
```

**Purpose**: Determines whether a child thread should inherit a parent rollout trace context for tracing.

**Data flow**: If `session_source` is not `SubAgent::ThreadSpawn`, or if `initial_history` is `Resumed`, it returns `ThreadTraceContext::disabled()`. Otherwise it tries to load the live parent thread and clone `thread.codex.session.services.rollout_thread_trace`; if lookup fails, it also returns a disabled trace context.

**Call relations**: Called during spawn setup so fresh v2 child threads can join the parent rollout tree without duplicating start events on resume.

*Call graph*: calls 2 internal fn (get_thread, disabled); called by 1 (spawn_thread_with_source); 1 external calls (matches!).


##### `stored_thread_to_initial_history`  (lines 1521–1536)

```
fn stored_thread_to_initial_history(
    stored_thread: StoredThread,
    rollout_path: Option<PathBuf>,
) -> CodexResult<InitialHistory>
```

**Purpose**: Converts a `StoredThread` with loaded history into `InitialHistory::Resumed`.

**Data flow**: Reads `stored_thread.thread_id`, requires `stored_thread.history` to be present or returns a fatal error, then builds `ResumedHistory { conversation_id, history: history.items, rollout_path: rollout_path.or(stored_thread.rollout_path) }` and wraps it in `InitialHistory::Resumed`.

**Call relations**: Used after thread-store reads in rollout-path resume/fork flows and subagent snapshotting.

*Call graph*: called by 2 (initial_history_from_rollout_path, spawn_subagent); 1 external calls (Resumed).


##### `thread_store_rollout_read_error`  (lines 1538–1544)

```
fn thread_store_rollout_read_error(err: ThreadStoreError) -> CodexErr
```

**Purpose**: Maps thread-store errors from rollout-path reads into public `CodexErr` variants.

**Data flow**: Pattern-matches `ThreadStoreError`, converting not-found to `CodexErr::ThreadNotFound`, invalid requests to `CodexErr::InvalidRequest`, and all other errors to `CodexErr::Fatal` with context.

**Call relations**: Used by `initial_history_from_rollout_path` to normalize store failures.

*Call graph*: 4 external calls (format!, Fatal, InvalidRequest, ThreadNotFound).


##### `thread_store_metadata_update_error`  (lines 1546–1557)

```
fn thread_store_metadata_update_error(thread_id: ThreadId, err: ThreadStoreError) -> CodexErr
```

**Purpose**: Maps thread-store metadata-update failures into public `CodexErr` variants with thread-specific context.

**Data flow**: Pattern-matches `ThreadStoreError`, converting not-found, invalid-request, and unsupported-operation cases into corresponding `CodexErr` variants; all other errors become fatal errors mentioning the target thread id.

**Call relations**: Used by `update_thread_metadata` for both live-thread and cold-store update paths.

*Call graph*: 5 external calls (format!, Fatal, InvalidRequest, ThreadNotFound, UnsupportedOperation).


##### `truncate_before_nth_user_message`  (lines 1565–1590)

```
fn truncate_before_nth_user_message(
    history: InitialHistory,
    n: usize,
    snapshot_state: &SnapshotTurnState,
) -> InitialHistory
```

**Purpose**: Builds a fork snapshot that cuts strictly before the nth user message, with special handling for out-of-range requests on mid-turn histories.

**Data flow**: Extracts rollout items from `InitialHistory`, computes user-message positions, and either truncates with `truncate_rollout_before_nth_user_message_from_start` or, when the snapshot ends mid-turn and `n` is out of range, cuts before `active_turn_start_index` or the last user position to drop the unfinished suffix. It returns `InitialHistory::New` if the result is empty, otherwise `InitialHistory::Forked(rolled)`.

**Call relations**: Called only from `fork_history_from_snapshot` for `ForkSnapshot::TruncateBeforeNthUserMessage`.

*Call graph*: calls 1 internal fn (get_rollout_items); called by 1 (fork_history_from_snapshot); 3 external calls (Forked, truncate_rollout_before_nth_user_message_from_start, user_message_positions_in_rollout).


##### `snapshot_turn_state`  (lines 1599–1650)

```
fn snapshot_turn_state(history: &InitialHistory) -> SnapshotTurnState
```

**Purpose**: Inspects rollout history to determine whether the persisted snapshot ends mid-turn and, when possible, which explicit turn id and start index are active.

**Data flow**: Builds a `ThreadHistoryBuilder`, feeds it every rollout item, and checks for an active explicit turn. If an explicit active turn exists and is still in progress, it returns `SnapshotTurnState { ends_mid_turn: true, active_turn_id, active_turn_start_index }`; if the active turn snapshot is already complete/aborted, it reports not mid-turn. For histories without explicit turn lifecycle events, it falls back to locating the last user-message boundary and checking whether any later item is `TurnComplete` or `TurnAborted`; absence of such a boundary marks the history as mid-turn.

**Call relations**: Used by `fork_history_from_snapshot` to decide whether truncation should drop an unfinished suffix or whether interrupted snapshots should synthesize an abort boundary.

*Call graph*: calls 2 internal fn (new, get_rollout_items); called by 1 (fork_history_from_snapshot); 1 external calls (user_message_positions_in_rollout).


##### `fork_history_from_snapshot`  (lines 1652–1680)

```
fn fork_history_from_snapshot(
    snapshot: ForkSnapshot,
    history: InitialHistory,
    interrupted_marker: InterruptedTurnHistoryMarker,
) -> InitialHistory
```

**Purpose**: Transforms an `InitialHistory` into the exact history a forked thread should start from according to the requested snapshot mode.

**Data flow**: Computes `snapshot_turn_state(&history)`, then either truncates before the nth user message or converts resumed history into forked history and, if the snapshot ends mid-turn, appends an interrupted boundary via `append_interrupted_boundary`. If the history is already at a turn boundary, interrupted snapshots leave it unchanged.

**Call relations**: Used by ordinary forking and subagent spawning after the caller has chosen snapshot semantics and interrupted-marker policy.

*Call graph*: calls 3 internal fn (append_interrupted_boundary, snapshot_turn_state, truncate_before_nth_user_message); called by 2 (fork_thread_with_initial_history, spawn_subagent); 1 external calls (Forked).


##### `append_interrupted_boundary`  (lines 1685–1721)

```
fn append_interrupted_boundary(
    history: InitialHistory,
    turn_id: Option<String>,
    interrupted_marker: InterruptedTurnHistoryMarker,
) -> InitialHistory
```

**Purpose**: Appends the persisted interrupt marker and `TurnAborted` event that represent an interrupted turn in fork snapshots.

**Data flow**: Builds a `RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent { turn_id, reason: Interrupted, completed_at: None, duration_ms: None }))`. Depending on the incoming `InitialHistory`, it creates or mutates a history vector, optionally inserts the response-item marker returned by `interrupted_turn_history_marker(interrupted_marker)`, then appends the abort event and returns `InitialHistory::Forked(...)`.

**Call relations**: Called only from `fork_history_from_snapshot` when an interrupted snapshot is requested for a history that ends mid-turn.

*Call graph*: calls 1 internal fn (interrupted_turn_history_marker); called by 1 (fork_history_from_snapshot); 6 external calls (new, TurnAborted, Forked, push, EventMsg, ResponseItem).


### `core/src/environment_selection.rs`

`orchestration` · `startup`

This file manages the mapping from user- or config-selected `TurnEnvironmentSelection` values to concrete `TurnEnvironment` objects. `default_thread_environment_selections` asks `EnvironmentManager` for its default environment IDs and pairs each one with the current cwd converted to `PathUri`. The main runtime type is `ThreadEnvironments`, which stores the shared `EnvironmentManager`, the configured local `Shell`, a `ShellSnapshot` builder, and an `ArcSwap` holding a shared future (`SnapshotTask`) for the latest asynchronously resolved `TurnEnvironmentSnapshot`.

`update_selections` is intentionally non-blocking. It peeks the previously resolved snapshot if available, clones the dependencies, spawns a new async resolution task, and atomically swaps `snapshot_task` so later callers await the newest resolution rather than any older in-flight one. `resolve_snapshot` deduplicates selections by `environment_id`, preserves order, reuses an existing `TurnEnvironment` only when both `environment_id` and cwd match, and otherwise calls `resolve_selection`. Failed resolutions are logged and skipped rather than aborting the whole snapshot.

`resolve_selection` looks up the environment by ID, errors with `CodexErr::InvalidRequest` if missing, resolves a shell from remote environment info when needed (logging and falling back to `None` on shell-info failures), constructs a `TurnEnvironment`, and kicks off an asynchronous shell snapshot build whose shared future is stored back into the environment. `TurnEnvironmentSnapshot` is a lightweight wrapper around `Vec<TurnEnvironment>` with helpers for primary selection, locating the local environment, converting back to selections, exposing the primary filesystem, and compatibility access to a single local cwd only when exactly one non-remote environment is present. The embedded tests cover default selection derivation, duplicate suppression, latest-update-wins behavior, reuse by matching `(environment_id, cwd)`, and local/remote snapshot accessors.

#### Function details

##### `default_thread_environment_selections`  (lines 20–32)

```
fn default_thread_environment_selections(
    environment_manager: &EnvironmentManager,
    cwd: &AbsolutePathBuf,
) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Builds the initial per-thread environment selection list from the manager’s configured default environment IDs.

**Data flow**: Reads `environment_manager.default_environment_ids()`, maps each ID into `TurnEnvironmentSelection { environment_id, cwd: PathUri::from_abs_path(cwd) }`, and returns the collected vector.

**Call relations**: Used during thread/session startup to seed environment selections before any user overrides.

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

**Purpose**: Constructs the environment-selection manager with an initial resolved snapshot.

**Data flow**: Takes shared `EnvironmentManager`, local `Shell`, `ShellSnapshot`, and a current `TurnEnvironmentSnapshot`. It stores the dependencies and wraps the current snapshot in a ready boxed shared future inside `ArcSwap`.

**Call relations**: Called by session setup and tests to create the long-lived environment resolver.

*Call graph*: called by 7 (latest_environment_update_wins_while_previous_resolution_is_pending, local_environment_uses_configured_shell, resolve_turn_environments, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resolved_environments_for_configuration); 2 external calls (from_pointee, ready).


##### `ThreadEnvironments::update_selections`  (lines 58–83)

```
fn update_selections(&self, environments: &[TurnEnvironmentSelection])
```

**Purpose**: Starts asynchronous resolution of a new selection list and atomically makes that future the current snapshot task.

**Data flow**: Reads the previously resolved snapshot from `snapshot_task.peek().cloned().unwrap_or_default()`, clones manager/shell dependencies, clones the incoming selections into a `Vec`, creates a future that awaits `Self::resolve_snapshot(...)`, stores the shared boxed future into `snapshot_task`, and spawns the remote handle.

**Call relations**: Invoked whenever thread environment selections change; later `snapshot()` calls await the newest stored task, so stale in-flight resolutions are superseded.

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

**Purpose**: Resolves a selection list into a deduplicated ordered `TurnEnvironmentSnapshot`, reusing matching existing environments when possible.

**Data flow**: Consumes manager/shell dependencies, the current snapshot, and a vector of selections. It tracks seen environment IDs in a `HashSet`, skips duplicate IDs after the first, reuses an existing `TurnEnvironment` when both ID and cwd match, otherwise awaits `resolve_selection`, logs and skips failures, and returns `TurnEnvironmentSnapshot { turn_environments }`.

**Call relations**: Called only from `update_selections`' spawned task; it is the core reconciliation algorithm.

*Call graph*: 4 external calls (with_capacity, resolve_selection, with_capacity, warn!).


##### `ThreadEnvironments::resolve_selection`  (lines 126–171)

```
async fn resolve_selection(
        environment_manager: &EnvironmentManager,
        local_shell: &Shell,
        shell_snapshot: &ShellSnapshot,
        selected_environment: &TurnEnvironmentSelecti
```

**Purpose**: Turns one `TurnEnvironmentSelection` into a concrete `TurnEnvironment` with optional shell metadata and an asynchronously built shell snapshot.

**Data flow**: Looks up the environment by ID from `EnvironmentManager`; missing IDs become `CodexErr::InvalidRequest`. For remote environments it awaits `environment.info()`, tries `Shell::from_environment_shell_info`, and logs failures while falling back to `None`; local environments reuse `local_shell.clone()`. It then constructs `TurnEnvironment::new(...)`, starts `shell_snapshot.build(turn_environment.clone())` as a shared spawned task, stores that future into `turn_environment.shell_snapshot`, and returns the environment.

**Call relations**: Used by `resolve_snapshot` whenever a selection cannot be reused from the previous snapshot.

*Call graph*: calls 3 internal fn (new, from_environment_shell_info, get_environment); 4 external calls (clone, clone, spawn, warn!).


##### `ThreadEnvironments::snapshot`  (lines 173–175)

```
async fn snapshot(&self) -> TurnEnvironmentSnapshot
```

**Purpose**: Awaits and returns the latest resolved environment snapshot.

**Data flow**: Loads the full shared future from `snapshot_task`, clones it, awaits it, and returns the resulting `TurnEnvironmentSnapshot`.

**Call relations**: Called by consumers that need the current resolved environments after any pending update.

*Call graph*: 1 external calls (load_full).


##### `ThreadEnvironments::environment_manager`  (lines 177–179)

```
fn environment_manager(&self) -> Arc<EnvironmentManager>
```

**Purpose**: Returns a cloned `Arc` to the underlying `EnvironmentManager`.

**Data flow**: Clones `self.environment_manager` and returns it.

**Call relations**: Provides access to the manager for callers that need environment metadata beyond the resolved snapshot.

*Call graph*: 1 external calls (clone).


##### `TurnEnvironmentSnapshot::primary`  (lines 188–190)

```
fn primary(&self) -> Option<&TurnEnvironment>
```

**Purpose**: Returns the first resolved environment, which defines the primary environment for the turn.

**Data flow**: Reads `self.turn_environments.first()` and returns `Option<&TurnEnvironment>`.

**Call relations**: Used by other snapshot accessors and by callers that treat the first selection as authoritative.

*Call graph*: called by 2 (primary_environment, primary_filesystem).


##### `TurnEnvironmentSnapshot::local`  (lines 192–196)

```
fn local(&self) -> Option<&TurnEnvironment>
```

**Purpose**: Finds the first resolved non-remote environment in the snapshot.

**Data flow**: Iterates `self.turn_environments` and returns the first environment whose underlying `environment.is_remote()` is false.

**Call relations**: Used when callers specifically need a local execution environment if one exists.


##### `TurnEnvironmentSnapshot::primary_environment`  (lines 199–202)

```
fn primary_environment(&self) -> Option<Arc<codex_exec_server::Environment>>
```

**Purpose**: Test-only helper that clones the underlying `Environment` of the primary turn environment.

**Data flow**: Calls `self.primary()`, clones `environment.environment`, and returns `Option<Arc<Environment>>`.

**Call relations**: Used only in tests to compare environment object identity.

*Call graph*: calls 1 internal fn (primary).


##### `TurnEnvironmentSnapshot::to_selections`  (lines 204–209)

```
fn to_selections(&self) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Converts the resolved snapshot back into serializable `TurnEnvironmentSelection` values.

**Data flow**: Iterates `self.turn_environments`, maps each through `TurnEnvironment::selection`, and collects the results.

**Call relations**: Used by tests and any code that needs to persist or compare the resolved selection set.


##### `TurnEnvironmentSnapshot::primary_filesystem`  (lines 211–214)

```
fn primary_filesystem(&self) -> Option<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: Returns the executor filesystem of the primary environment.

**Data flow**: Calls `self.primary()`, then `environment.environment.get_filesystem()`, and returns `Option<Arc<dyn ExecutorFileSystem>>`.

**Call relations**: Used by plugin/skill warmup code that needs filesystem access rooted in the primary environment.

*Call graph*: calls 1 internal fn (primary); called by 1 (warm_plugins_and_skills_for_session_init).


##### `TurnEnvironmentSnapshot::single_local_environment`  (lines 216–222)

```
fn single_local_environment(&self) -> Option<&TurnEnvironment>
```

**Purpose**: Returns the sole environment only when the snapshot contains exactly one non-remote environment.

**Data flow**: Pattern-matches `self.turn_environments.as_slice()` against a single-element slice and returns that element only if `environment.environment.is_remote()` is false.

**Call relations**: Supports compatibility helpers that only make sense for a single local environment.

*Call graph*: called by 1 (single_local_environment_cwd).


##### `TurnEnvironmentSnapshot::single_local_environment_cwd`  (lines 224–228)

```
fn single_local_environment_cwd(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns an absolute cwd path only when the snapshot contains exactly one local environment.

**Data flow**: Calls `single_local_environment()`, converts its `cwd()` `PathUri` to an absolute path with `to_abs_path().ok()`, and returns `Option<AbsolutePathBuf>`.

**Call relations**: Compatibility helper for older local-environment consumers that still expect absolute paths.

*Call graph*: calls 1 internal fn (single_local_environment).


##### `tests::resolve_turn_environments`  (lines 244–257)

```
async fn resolve_turn_environments(
        environment_manager: Arc<EnvironmentManager>,
        selections: &[TurnEnvironmentSelection],
    ) -> Arc<ThreadEnvironments>
```

**Purpose**: Test helper that constructs `ThreadEnvironments`, updates selections, awaits resolution, and returns the manager.

**Data flow**: Takes an `Arc<EnvironmentManager>` and selection slice, creates `ThreadEnvironments::new(...)` with default user shell and disabled shell snapshots, calls `update_selections`, awaits `snapshot()`, and returns the `Arc<ThreadEnvironments>`.

**Call relations**: Shared async fixture used by many tests in this module.

*Call graph*: calls 3 internal fn (new, default_user_shell, disabled); 2 external calls (new, default).


##### `tests::test_runtime_paths`  (lines 259–265)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Builds `ExecServerRuntimePaths` for tests from the current executable path.

**Data flow**: Calls `std::env::current_exe()`, passes it to `ExecServerRuntimePaths::new(..., None)`, and returns the result.

**Call relations**: Used by tests that create real `EnvironmentManager` instances with runtime-path requirements.

*Call graph*: calls 1 internal fn (new); 1 external calls (current_exe).


##### `tests::default_thread_environment_selections_use_manager_default_id`  (lines 268–284)

```
async fn default_thread_environment_selections_use_manager_default_id()
```

**Purpose**: Verifies that default selections mirror the manager’s default environment IDs.

**Data flow**: Creates a test manager with a remote environment, computes cwd and cwd URI, calls `default_thread_environment_selections`, and asserts the returned vector contains the expected remote selection.

**Call relations**: Tests the basic default-selection helper.

*Call graph*: calls 3 internal fn (create_for_tests, current_dir, from_abs_path); 2 external calls (assert_eq!, test_runtime_paths).


##### `tests::toml_default_thread_environment_selections_include_local_and_remote`  (lines 287–318)

```
async fn toml_default_thread_environment_selections_include_local_and_remote()
```

**Purpose**: Verifies that TOML-configured environments produce both local and remote default selections in order.

**Data flow**: Writes an `environments.toml`, loads an `EnvironmentManager` from that codex home, computes cwd URI, calls `default_thread_environment_selections`, and asserts both local and remote selections are returned.

**Call relations**: Covers configuration-driven default environment discovery.

*Call graph*: calls 3 internal fn (from_codex_home, current_dir, from_abs_path); 4 external calls (assert_eq!, test_runtime_paths, write, tempdir).


##### `tests::default_thread_environment_selections_empty_when_default_disabled`  (lines 321–329)

```
async fn default_thread_environment_selections_empty_when_default_disabled()
```

**Purpose**: Checks that no default selections are produced when the manager has no environments.

**Data flow**: Creates `EnvironmentManager::without_environments()`, computes cwd, calls `default_thread_environment_selections`, and asserts an empty vector.

**Call relations**: Covers the empty-manager case.

*Call graph*: calls 2 internal fn (without_environments, current_dir); 1 external calls (assert_eq!).


##### `tests::local_environment_uses_configured_shell`  (lines 332–357)

```
async fn local_environment_uses_configured_shell()
```

**Purpose**: Verifies that local environment resolution preserves the configured local shell rather than re-deriving one.

**Data flow**: Creates `ThreadEnvironments` with a custom `Shell`, updates selections to the local environment, awaits the snapshot, and asserts the primary environment’s `shell` equals the configured shell.

**Call relations**: Exercises the local branch in `resolve_selection`.

*Call graph*: calls 5 internal fn (new, disabled, default_for_tests, current_dir, from_abs_path); 4 external calls (new, assert_eq!, default, from).


##### `tests::resolve_environment_selections_keeps_first_duplicate_id`  (lines 360–382)

```
async fn resolve_environment_selections_keeps_first_duplicate_id()
```

**Purpose**: Checks that duplicate environment IDs are deduplicated by keeping only the first selection.

**Data flow**: Builds two selections with the same environment ID but different cwd values, resolves them, and asserts the resulting selections contain only the first one.

**Call relations**: Tests the `seen_environment_ids` logic in `resolve_snapshot`.

*Call graph*: calls 3 internal fn (default_for_tests, current_dir, from_abs_path); 3 external calls (new, assert_eq!, resolve_turn_environments).


##### `tests::resolved_environment_selections_use_first_selection_as_primary`  (lines 385–423)

```
async fn resolved_environment_selections_use_first_selection_as_primary()
```

**Purpose**: Verifies that the first resolved selection becomes the primary environment and that its shell matches environment info.

**Data flow**: Resolves a single local selection, awaits the snapshot, asserts the primary environment ID is `local`, and compares its shell to one derived from `manager.get_environment("local").info().await`.

**Call relations**: Covers primary ordering and remote-info-based shell derivation.

*Call graph*: calls 3 internal fn (default_for_tests, current_dir, from_abs_path); 4 external calls (clone, new, assert_eq!, resolve_turn_environments).


##### `tests::unresolved_environment_selections_are_skipped`  (lines 426–448)

```
async fn unresolved_environment_selections_are_skipped()
```

**Purpose**: Checks that missing environment IDs are logged/skipped without preventing valid later selections from resolving.

**Data flow**: Resolves a selection list containing one missing ID and one valid local ID, then asserts the final selections contain only the valid local one.

**Call relations**: Exercises the error-skipping branch in `resolve_snapshot`.

*Call graph*: calls 3 internal fn (default_for_tests, current_dir, from_abs_path); 3 external calls (new, assert_eq!, resolve_turn_environments).


##### `tests::latest_environment_update_wins_while_previous_resolution_is_pending`  (lines 451–495)

```
async fn latest_environment_update_wins_while_previous_resolution_is_pending()
```

**Purpose**: Verifies that a newer `update_selections` call supersedes an older still-pending resolution task.

**Data flow**: Starts resolving a remote environment that blocks on an accepted websocket connection, then issues a second update selecting the local environment, awaits `snapshot()` with a timeout, and asserts the final snapshot reflects only the local selection.

**Call relations**: Tests the `ArcSwap` latest-task-wins design of `update_selections`.

*Call graph*: calls 6 internal fn (new, default_user_shell, disabled, create_for_tests_with_local, current_dir, from_abs_path); 9 external calls (new, assert_eq!, default, test_runtime_paths, format!, from_ref, from_secs, bind, timeout).


##### `tests::matching_environment_id_and_cwd_reuse_resolved_environment`  (lines 498–549)

```
async fn matching_environment_id_and_cwd_reuse_resolved_environment()
```

**Purpose**: Checks that reselecting the same `(environment_id, cwd)` reuses the existing resolved environment object, while changing cwd forces a new one.

**Data flow**: Resolves an initial remote selection, mutates the manager’s remote environment entry, updates selections with the same selection and then with a changed cwd, and uses `Arc::ptr_eq` to assert reuse in the first case and replacement in the second.

**Call relations**: Exercises the reuse branch in `resolve_snapshot`.

*Call graph*: calls 3 internal fn (create_for_tests, current_dir, from_abs_path); 6 external calls (clone, new, assert!, resolve_turn_environments, test_runtime_paths, from_ref).


##### `tests::single_local_environment_cwd_requires_exactly_one_local_environment`  (lines 552–592)

```
async fn single_local_environment_cwd_requires_exactly_one_local_environment()
```

**Purpose**: Verifies that `single_local_environment_cwd` returns a path only for snapshots containing exactly one local environment.

**Data flow**: Builds three snapshots—single local, single remote, and mixed local+remote—and asserts the helper returns `Some(cwd)` only for the single-local case.

**Call relations**: Tests the compatibility accessor logic in `TurnEnvironmentSnapshot`.

*Call graph*: calls 4 internal fn (create_for_tests, default_for_tests, current_dir, from_abs_path); 5 external calls (clone, new, assert_eq!, resolve_turn_environments, vec!).


### `core/src/codex_thread.rs`

`orchestration` · `request handling and thread lifecycle`

This file packages a running session into `CodexThread`, the main thread-level API surface used outside the lower-level session internals. It also defines `ThreadConfigSnapshot`, a concrete snapshot of effective thread configuration including model/provider identifiers, approval and permission settings, environment selections, workspace roots, reasoning/personality knobs, collaboration mode, and lineage fields such as fork/parent thread IDs. `ThreadConfigSnapshot` includes convenience accessors for the legacy fallback cwd, selected environments, and a derived `SandboxPolicy` computed from the active `PermissionProfile` and cwd.

`CodexThread` itself is intentionally thin: most methods delegate directly into `Codex` or `Session`, but the file is where thread-specific policy boundaries are enforced. Examples include checking execution capacity before accepting user input, converting app-server override structs into `SessionSettingsUpdate`, rejecting empty raw item injection, and wrapping persistence access failures into `ThreadStoreError::Internal`. The idle-turn path is especially important: `try_start_turn_if_idle` is the sanctioned extension entry point for model-visible idle work, and `TryStartTurnIfIdleError` preserves both a stable rejection reason and the original `Vec<ResponseItem>` so callers can retry or log without reconstructing input. The file also tracks `out_of_band_elicitation_count` behind a `tokio::sync::Mutex<u64>`; transitions between zero and nonzero toggle a session pause state, with explicit overflow and underflow protection.

#### Function details

##### `TryStartTurnIfIdleError::new`  (lines 101–103)

```
fn new(reason: TryStartTurnIfIdleRejectionReason, input: Vec<ResponseItem>) -> Self
```

**Purpose**: Constructs the rejection object returned when automatic idle work cannot start. It stores both the stable rejection reason and the untouched model-visible input items.

**Data flow**: Takes a `TryStartTurnIfIdleRejectionReason` and `Vec<ResponseItem>` → packages them into `Self { reason, input }` → returns the new error value without side effects.

**Call relations**: This constructor is used by the lower idle-turn start path when `try_start_turn_if_idle` rejects extension-initiated work, so callers higher up receive a structured error instead of losing the original items.

*Call graph*: called by 1 (try_start_turn_if_idle).


##### `TryStartTurnIfIdleError::reason`  (lines 106–108)

```
fn reason(&self) -> TryStartTurnIfIdleRejectionReason
```

**Purpose**: Returns the stable enum reason explaining why the idle turn was rejected. It is the non-consuming accessor for callers that only need classification.

**Data flow**: Reads `self.reason` from the stored error state → returns the copied `TryStartTurnIfIdleRejectionReason`.

**Call relations**: Used by consumers of `TryStartTurnIfIdleError` after a failed idle-turn attempt to branch on `PendingTriggerTurn`, `PlanMode`, or `Busy` without consuming the error.


##### `TryStartTurnIfIdleError::into_input`  (lines 112–114)

```
fn into_input(self) -> Vec<ResponseItem>
```

**Purpose**: Consumes the rejection and gives the original `ResponseItem` input back unchanged. This preserves retryability and explicit caller control over dropped work.

**Data flow**: Consumes `self` → moves out `self.input` → returns `Vec<ResponseItem>` with no mutation elsewhere.

**Call relations**: Called by code that wants to retry or log rejected idle-turn input after inspecting or ignoring the rejection reason.


##### `ThreadConfigSnapshot::cwd`  (lines 118–120)

```
fn cwd(&self) -> &AbsolutePathBuf
```

**Purpose**: Exposes the thread’s effective working directory from the environment selection bundle. It standardizes access to the legacy fallback cwd field.

**Data flow**: Reads `self.environments.legacy_fallback_cwd` → returns it by shared reference as `&AbsolutePathBuf`.

**Call relations**: Used by snapshot consumers that need a canonical cwd, including snapshot reconstruction and mismatch detection, and it feeds `sandbox_policy` when deriving compatibility sandbox settings.

*Call graph*: called by 4 (build_thread_from_snapshot, collect_resume_override_mismatches, thread_settings_from_config_snapshot, sandbox_policy).


##### `ThreadConfigSnapshot::environment_selections`  (lines 122–124)

```
fn environment_selections(&self) -> &[TurnEnvironmentSelection]
```

**Purpose**: Returns the explicit per-turn environment selections stored in the snapshot. It provides read-only access to the normalized environment list.

**Data flow**: Reads `self.environments.environments` → returns it as a slice `&[TurnEnvironmentSelection]`.

**Call relations**: Serves callers that need the selected environments without exposing the full `TurnEnvironmentSelections` wrapper.


##### `ThreadConfigSnapshot::sandbox_policy`  (lines 126–131)

```
fn sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Derives the effective sandbox policy implied by the snapshot’s permission profile and cwd. It bridges newer permission-profile configuration to the older `SandboxPolicy` representation.

**Data flow**: Reads `self.permission_profile` and the cwd via `cwd()` → passes them to `codex_sandboxing::compatibility_sandbox_policy_for_permission_profile` → returns the computed `SandboxPolicy`.

**Call relations**: Used when comparing resume-time overrides against persisted configuration, so callers can reason about sandbox compatibility from a snapshot alone.

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

**Purpose**: Builds a new thread façade around an already-created `Codex` session and its startup metadata. It initializes thread-local bookkeeping for rollout location and out-of-band elicitation tracking.

**Data flow**: Takes `Codex`, `SessionConfiguredEvent`, optional rollout `PathBuf`, and `SessionSource` → stores them in a new `CodexThread` and initializes `out_of_band_elicitation_count` to `Mutex::new(0)` → returns the thread wrapper.

**Call relations**: Called during thread spawn finalization after the underlying session exists, creating the object that the rest of the system passes around.

*Call graph*: called by 1 (finalize_thread_spawn); 1 external calls (new).


##### `CodexThread::submit`  (lines 188–190)

```
async fn submit(&self, op: Op) -> CodexResult<String>
```

**Purpose**: Submits a protocol `Op` into the thread’s command stream. It is the basic thread-level write path for operations that do not need explicit trace context.

**Data flow**: Accepts an `Op` → forwards it to `self.codex.submit(op).await` → returns the resulting submission ID or `CodexErr`.

**Call relations**: Used by multiple higher-level flows that enqueue protocol operations, including realtime conversation setup/teardown and turn-driving paths.

*Call graph*: calls 1 internal fn (submit); called by 8 (submit_thread_settings, close_realtime_conversation, start_realtime_conversation, capture_from_requests, submit_user_input, submit_queue_only_agent_mail, submit_user_input, run_turn).


##### `CodexThread::session_telemetry`  (lines 193–195)

```
fn session_telemetry(&self) -> SessionTelemetry
```

**Purpose**: Returns the thread-scoped production telemetry handle. It gives callers instrumentation access without exposing broader session internals.

**Data flow**: Reads `self.codex.session.services.session_telemetry` → clones and returns the `SessionTelemetry` handle.

**Call relations**: Standalone accessor for code that needs to annotate work with the same telemetry context as the thread.


##### `CodexThread::shutdown_and_wait`  (lines 197–199)

```
async fn shutdown_and_wait(&self) -> CodexResult<()>
```

**Purpose**: Requests shutdown of the underlying session loop and waits for completion. It is the synchronous teardown entry point for a thread owner.

**Data flow**: Reads `self.codex` → awaits `shutdown_and_wait()` on it → returns `CodexResult<()>`.

**Call relations**: Delegates directly to the lower-level session shutdown machinery when a caller wants orderly termination.

*Call graph*: calls 1 internal fn (shutdown_and_wait).


##### `CodexThread::wait_until_terminated`  (lines 202–204)

```
async fn wait_until_terminated(&self)
```

**Purpose**: Waits until the session loop termination future resolves. Unlike shutdown, it only observes termination rather than initiating it.

**Data flow**: Clones `self.codex.session_loop_termination` and awaits it → returns `()` once the loop has ended.

**Call relations**: Used by agent-loop code that needs to block until the thread is fully dead after some other path initiated shutdown.

*Call graph*: called by 1 (loop_agent).


##### `CodexThread::emit_thread_resume_lifecycle`  (lines 206–221)

```
async fn emit_thread_resume_lifecycle(&self)
```

**Purpose**: Invokes all registered extension lifecycle contributors for a thread-resume event. It gives extensions access to session- and thread-scoped extension stores during resume.

**Data flow**: Reads the extension contributor list from `self.codex.session.services.extensions` → iterates contributors → awaits each `on_thread_resume` call with `ThreadResumeInput` containing references to session and thread extension data → returns `()`.

**Call relations**: Runs as part of resume handling after a thread is restored, fanning out to extension hooks rather than performing resume logic itself.


##### `CodexThread::emit_thread_idle_lifecycle_if_idle`  (lines 223–228)

```
async fn emit_thread_idle_lifecycle_if_idle(&self)
```

**Purpose**: Triggers idle lifecycle emission only if the session is currently idle. It exposes the session’s idle-hook gate at thread scope.

**Data flow**: Delegates to `self.codex.session.emit_thread_idle_lifecycle_if_idle().await` → returns `()`.

**Call relations**: Called from resume/goal continuation flow so extensions can react to an idle thread without bypassing the session’s own eligibility checks.

*Call graph*: called by 1 (emit_resume_goal_snapshot_and_continue).


##### `CodexThread::ensure_rollout_materialized`  (lines 231–233)

```
async fn ensure_rollout_materialized(&self)
```

**Purpose**: Forces rollout artifacts for the session to exist on disk if they have not yet been materialized. It is a hidden maintenance hook.

**Data flow**: Delegates to `self.codex.session.ensure_rollout_materialized().await` → returns `()`.

**Call relations**: Used by internal callers that need rollout persistence available before reading or exporting it.


##### `CodexThread::flush_rollout`  (lines 236–238)

```
async fn flush_rollout(&self) -> std::io::Result<()>
```

**Purpose**: Flushes pending rollout data to storage. It exposes the session’s rollout persistence boundary at thread scope.

**Data flow**: Delegates to `self.codex.session.flush_rollout().await` → returns `std::io::Result<()>`.

**Call relations**: Used by internal paths that need durable rollout state after injecting or mutating thread history.


##### `CodexThread::submit_with_trace`  (lines 240–246)

```
async fn submit_with_trace(
        &self,
        op: Op,
        trace: Option<W3cTraceContext>,
    ) -> CodexResult<String>
```

**Purpose**: Submits an operation together with optional W3C trace context. It preserves distributed tracing metadata across the thread boundary.

**Data flow**: Takes `Op` and `Option<W3cTraceContext>` → forwards both to `self.codex.submit_with_trace(...).await` → returns submission ID or error.

**Call relations**: Used by core operation submission paths that already carry trace context and need it attached to the queued op.

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

**Purpose**: Submits user input while first reserving execution capacity and optionally preserving a client-supplied user message ID. This is the guarded user-input ingress path.

**Data flow**: Accepts `Op`, optional trace, and optional client message ID → asks `agent_control.ensure_execution_capacity_for_op` for the configured thread ID and op → on success forwards to `self.codex.submit_user_input_with_client_user_message_id(...)` → returns submission ID or propagates capacity/submission errors.

**Call relations**: Used when app-server or similar callers submit user-originated work and must avoid overcommitting execution resources before enqueueing.

*Call graph*: calls 1 internal fn (submit_user_input_with_client_user_message_id).


##### `CodexThread::set_thread_memory_mode`  (lines 266–268)

```
async fn set_thread_memory_mode(&self, mode: ThreadMemoryMode) -> anyhow::Result<()>
```

**Purpose**: Persists whether the thread remains eligible for future memory generation. It is a narrow thread-level setter for memory policy.

**Data flow**: Takes a `ThreadMemoryMode` → forwards to `self.codex.set_thread_memory_mode(mode).await` → returns `anyhow::Result<()>`.

**Call relations**: Called by management paths that update long-lived thread memory behavior without touching other settings.

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

**Purpose**: Injects steering input into an expected active turn, along with additional context and optional metadata. It is the thread façade for turn steering rather than new-turn submission.

**Data flow**: Accepts `Vec<UserInput>`, `BTreeMap<String, AdditionalContextEntry>`, optional expected turn ID, optional client user message ID, and optional response API metadata map → forwards all fields to `self.codex.steer_input(...).await` → returns a turn/submission identifier or `SteerInputError`.

**Call relations**: Used by steering-specific request handlers when they need to target an existing turn instead of starting a fresh one.

*Call graph*: calls 1 internal fn (steer_input); called by 1 (steer_user_input).


##### `CodexThread::inject_if_running`  (lines 294–299)

```
async fn inject_if_running(
        &self,
        items: Vec<ResponseItem>,
    ) -> Result<(), Vec<ResponseItem>>
```

**Purpose**: Attempts to inject model-visible items into the currently active turn only if one exists. It avoids silently dropping items by returning them unchanged when no turn is running.

**Data flow**: Takes `Vec<ResponseItem>` → delegates to `self.codex.session.inject_if_running(items).await` → returns `Ok(())` on successful injection or `Err(original_items)` if there is no active turn.

**Call relations**: Used by callers that only hold a `CodexThread` but need the session’s conditional injection behavior.


##### `CodexThread::try_start_turn_if_idle`  (lines 314–319)

```
async fn try_start_turn_if_idle(
        &self,
        items: Vec<ResponseItem>,
    ) -> Result<(), TryStartTurnIfIdleError>
```

**Purpose**: Starts an automatic regular turn from model-visible items only when the thread is idle and eligible for extension-initiated work. It enforces priority for queued user/client work and blocks automatic turns in Plan mode or while another task is active.

**Data flow**: Accepts `Vec<ResponseItem>` → delegates to `self.codex.session.try_start_turn_if_idle(items).await` → returns `Ok(())` if the turn starts or `TryStartTurnIfIdleError` containing both rejection reason and original items.

**Call relations**: This is the required extension entry point from idle lifecycle hooks; it centralizes the eligibility checks instead of letting extensions start turns directly.


##### `CodexThread::set_app_server_client_info`  (lines 321–334)

```
async fn set_app_server_client_info(
        &self,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
        mcp_elicitations_auto_deny: bool,
    ) -
```

**Purpose**: Stores app-server client identity and whether MCP elicitations should auto-deny. It updates session-side client metadata subject to configuration constraints.

**Data flow**: Takes optional client name/version and a `bool` auto-deny flag → forwards to `self.codex.set_app_server_client_info(...).await` → returns `ConstraintResult<()>`.

**Call relations**: Used by app-server setup paths to stamp client metadata onto the thread before later requests rely on it.

*Call graph*: calls 1 internal fn (set_app_server_client_info); called by 2 (set_app_server_client_info, set_app_server_client_info).


##### `CodexThread::preview_thread_settings_overrides`  (lines 337–343)

```
async fn preview_thread_settings_overrides(
        &self,
        overrides: CodexThreadSettingsOverrides,
    ) -> ConstraintResult<ThreadConfigSnapshot>
```

**Purpose**: Computes the effective thread configuration that would result from a set of validated overrides without committing them. It is a dry-run path for settings changes.

**Data flow**: Accepts `CodexThreadSettingsOverrides` → converts them with `thread_settings_update(...).await` into `SessionSettingsUpdate` → passes that to `self.codex.session.preview_settings(&updates).await` → returns a `ThreadConfigSnapshot` or constraint error.

**Call relations**: Used by override-building flows that need to show or validate the resulting configuration before applying it.

*Call graph*: calls 1 internal fn (thread_settings_update); called by 1 (build_thread_settings_overrides).


##### `CodexThread::thread_settings_update`  (lines 345–392)

```
async fn thread_settings_update(
        &self,
        overrides: CodexThreadSettingsOverrides,
    ) -> SessionSettingsUpdate
```

**Purpose**: Transforms thread-level override fields into a `SessionSettingsUpdate`, filling in collaboration mode when omitted. It is the normalization step between app-server override shape and session update shape.

**Data flow**: Consumes `CodexThreadSettingsOverrides`, destructuring all optional fields → if `collaboration_mode` is absent, reads current session collaboration mode and derives an updated mode using optional `model` and `effort` → constructs `SessionSettingsUpdate` with the provided environment/workspace/approval/permission/model-adjacent fields, explicit `collaboration_mode`, `reasoning_summary`, `service_tier`, and `personality`, leaving other fields at `Default::default()`.

**Call relations**: Only used by `preview_thread_settings_overrides`, encapsulating the policy that collaboration mode must always be concretized even when not explicitly overridden.

*Call graph*: called by 1 (preview_thread_settings_overrides); 1 external calls (default).


##### `CodexThread::submit_with_id`  (lines 395–397)

```
async fn submit_with_id(&self, sub: Submission) -> CodexResult<()>
```

**Purpose**: Submits a preconstructed `Submission` carrying its own identifier. The comment marks it as transitional and slated for removal.

**Data flow**: Takes `Submission` → forwards to `self.codex.submit_with_id(sub).await` → returns `CodexResult<()>`.

**Call relations**: Used sparingly by legacy or compatibility paths that still need explicit submission IDs.

*Call graph*: calls 1 internal fn (submit_with_id).


##### `CodexThread::next_event`  (lines 399–401)

```
async fn next_event(&self) -> CodexResult<Event>
```

**Purpose**: Receives the next protocol event emitted by the thread. It is the basic event-consumption API for external drivers.

**Data flow**: Delegates to `self.codex.next_event().await` → returns `CodexResult<Event>`.

**Call relations**: Used by event-waiting and turn-running flows that consume the thread’s outbound event stream.

*Call graph*: calls 1 internal fn (next_event); called by 4 (submit_thread_settings, wait_for_event_with_timeout, wait_for_mcp_server, run_turn).


##### `CodexThread::agent_status`  (lines 403–405)

```
async fn agent_status(&self) -> AgentStatus
```

**Purpose**: Fetches the current high-level agent status for the thread. It is an async snapshot accessor rather than a subscription.

**Data flow**: Delegates to `self.codex.agent_status().await` → returns `AgentStatus`.

**Call relations**: Used by loop/monitoring code that periodically polls thread status.

*Call graph*: calls 1 internal fn (agent_status); called by 1 (loop_agent).


##### `CodexThread::list_background_terminals`  (lines 407–409)

```
async fn list_background_terminals(&self) -> Vec<BackgroundTerminalInfo>
```

**Purpose**: Lists currently tracked background terminal processes associated with the session. It exposes process metadata suitable for UI or management surfaces.

**Data flow**: Delegates to `self.codex.session.list_background_terminals().await` → returns `Vec<BackgroundTerminalInfo>`.

**Call relations**: Standalone management accessor for background terminal inspection.


##### `CodexThread::terminate_background_terminal`  (lines 411–416)

```
async fn terminate_background_terminal(&self, process_id: i32) -> bool
```

**Purpose**: Requests termination of a background terminal process by PID. It returns whether a matching process was found and terminated.

**Data flow**: Takes `i32 process_id` → forwards to `self.codex.session.terminate_background_terminal(process_id).await` → returns `bool`.

**Call relations**: Used by management/UI actions that stop background terminal work from outside the session internals.


##### `CodexThread::subscribe_status`  (lines 418–420)

```
fn subscribe_status(&self) -> watch::Receiver<AgentStatus>
```

**Purpose**: Returns a watch receiver for live agent status updates. It is the streaming counterpart to `agent_status`.

**Data flow**: Clones `self.codex.agent_status` watch channel receiver → returns `watch::Receiver<AgentStatus>`.

**Call relations**: Used by callers that need push-style status observation instead of polling.


##### `CodexThread::token_usage_info`  (lines 429–431)

```
async fn token_usage_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the cached full token-usage snapshot for the thread, including more than just aggregate totals. It is intentionally narrower than exposing the whole session.

**Data flow**: Delegates to `self.codex.session.token_usage_info().await` → returns `Option<TokenUsageInfo>`.

**Call relations**: Used when replaying or forwarding token-usage updates so callers can emit complete payloads after resume or fork.

*Call graph*: called by 1 (send_thread_token_usage_update_to_connection).


##### `CodexThread::inject_user_message_without_turn`  (lines 434–446)

```
async fn inject_user_message_without_turn(&self, message: String)
```

**Purpose**: Records a user-role message into history without creating a new turn boundary. It is used for session-prefix style user-visible context.

**Data flow**: Takes a `String` message → wraps it into `ResponseItem::Message { role: "user", content: [ContentItem::InputText { text: message }], ... }` → calls `self.codex.session.inject_no_new_turn(vec![item], None).await` → returns `()`.

**Call relations**: Internal helper for paths that need to append user-role context directly into history while preserving the current turn structure.

*Call graph*: 1 external calls (vec!).


##### `CodexThread::inject_response_items`  (lines 449–469)

```
async fn inject_response_items(&self, items: Vec<ResponseItem>) -> CodexResult<()>
```

**Purpose**: Records raw Responses API items into thread history without starting a new turn. It also ensures a reference context item exists before injection and flushes rollout state afterward.

**Data flow**: Accepts `Vec<ResponseItem>` → rejects empty input with `CodexErr::InvalidRequest` → creates a default turn context via `new_default_turn()` → if no reference context item exists, records context updates and sets one from that turn context → injects items with `inject_no_new_turn(items, Some(turn_context))` → flushes rollout → returns `Ok(())` or propagates flush/session errors.

**Call relations**: Used by callers that need to import already-formed response items into history while keeping turn boundaries unchanged.

*Call graph*: 1 external calls (InvalidRequest).


##### `CodexThread::rollout_path`  (lines 471–473)

```
fn rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the optional filesystem path where this thread’s rollout is stored. It is a simple accessor over startup metadata.

**Data flow**: Clones `self.rollout_path` → returns `Option<PathBuf>`.

**Call relations**: Used when reconstructing thread views from loaded snapshots that need to expose rollout location.

*Call graph*: called by 1 (build_thread_from_loaded_snapshot).


##### `CodexThread::session_configured`  (lines 475–477)

```
fn session_configured(&self) -> SessionConfiguredEvent
```

**Purpose**: Returns the cached `SessionConfiguredEvent` captured when the thread was created. This gives callers thread identity and initial configuration metadata without re-querying the session.

**Data flow**: Clones `self.session_configured` → returns `SessionConfiguredEvent`.

**Call relations**: Used by resume/load flows that need the original configured event while rebuilding thread-facing state.

*Call graph*: called by 2 (load_thread_from_resume_source_or_send_internal, build_thread_from_loaded_snapshot); 1 external calls (clone).


##### `CodexThread::is_running`  (lines 479–481)

```
fn is_running(&self) -> bool
```

**Purpose**: Reports whether the thread’s submission channel is still open. It is a lightweight liveness check.

**Data flow**: Reads `self.codex.tx_sub.is_closed()` → negates it → returns `bool`.

**Call relations**: Used by callers that need a cheap running/dead distinction without awaiting status or termination.


##### `CodexThread::guardian_trunk_rollout_path`  (lines 483–489)

```
async fn guardian_trunk_rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the rollout path for the guardian review trunk session, if present. It exposes a specialized review-session artifact location.

**Data flow**: Delegates to `self.codex.session.guardian_review_session.trunk_rollout_path().await` → returns `Option<PathBuf>`.

**Call relations**: Used by review/guardian-aware code that needs to locate the trunk rollout separate from the main thread rollout.


##### `CodexThread::load_history`  (lines 491–503)

```
async fn load_history(
        &self,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThreadHistory>
```

**Purpose**: Loads persisted thread history from the thread store, optionally including archived items. It first resolves the live persistence handle from the running session.

**Data flow**: Takes `include_archived: bool` → calls `live_thread_for_persistence("load history")` on the session → maps any failure into `ThreadStoreError::Internal { message }` → awaits `live_thread.load_history(include_archived)` → returns `ThreadStoreResult<StoredThreadHistory>`.

**Call relations**: Used by thread-read APIs that need history specifically, while preserving a consistent error shape when persistence access is unavailable.

*Call graph*: called by 1 (apply_thread_read_store_fields).


##### `CodexThread::read_thread`  (lines 505–520)

```
async fn read_thread(
        &self,
        include_archived: bool,
        include_history: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads the persisted thread record, with optional archived content and optional embedded history. It is the broader persistence read path beyond history-only access.

**Data flow**: Accepts `include_archived` and `include_history` → resolves `live_thread_for_persistence("read thread")`, mapping failures to `ThreadStoreError::Internal` → awaits `live_thread.read_thread(include_archived, include_history)` → returns `StoredThread` or store error.

**Call relations**: Used by callers that need the full stored thread representation rather than just the history list.


##### `CodexThread::update_thread_metadata`  (lines 522–535)

```
async fn update_thread_metadata(
        &self,
        patch: ThreadMetadataPatch,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Applies a metadata patch to the persisted thread record and returns the updated stored thread. It is the thread-level persistence mutation API.

**Data flow**: Takes `ThreadMetadataPatch` and `include_archived` → resolves `live_thread_for_persistence("update thread metadata")`, mapping failures to `ThreadStoreError::Internal` → awaits `live_thread.update_metadata(patch, include_archived)` → returns updated `StoredThread`.

**Call relations**: Used by metadata-editing flows that need to patch persisted thread attributes through the live session.


##### `CodexThread::state_db`  (lines 537–539)

```
fn state_db(&self) -> Option<StateDbHandle>
```

**Purpose**: Returns the optional rollout/state database handle associated with the thread. It exposes state persistence without exposing the whole session.

**Data flow**: Delegates to `self.codex.state_db()` → returns `Option<StateDbHandle>`.

**Call relations**: Used by resume-goal and spawn-edge persistence paths that need direct access to the state DB handle.

*Call graph*: calls 1 internal fn (state_db); called by 2 (pending_resume_goal_state, persist_thread_spawn_edge_for_source).


##### `CodexThread::config_snapshot`  (lines 541–543)

```
async fn config_snapshot(&self) -> ThreadConfigSnapshot
```

**Purpose**: Fetches the current effective thread configuration snapshot. It is the runtime counterpart to the stored `ThreadConfigSnapshot` type defined in this file.

**Data flow**: Delegates to `self.codex.thread_config_snapshot().await` → returns `ThreadConfigSnapshot`.

**Call relations**: Used by thread-view loading and override-building code that needs a concrete snapshot of current settings.

*Call graph*: calls 1 internal fn (thread_config_snapshot); called by 4 (load_live_thread_view, load_thread_from_resume_source_or_send_internal, build_environment_override, build_thread_settings_overrides).


##### `CodexThread::instruction_sources`  (lines 546–548)

```
async fn instruction_sources(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the files that contributed model instructions for this thread. It exposes provenance for loaded instruction content.

**Data flow**: Delegates to `self.codex.instruction_sources().await` → returns `Vec<AbsolutePathBuf>`.

**Call relations**: Used by callers that need to explain or inspect where current instructions came from.

*Call graph*: calls 1 internal fn (instruction_sources).


##### `CodexThread::config`  (lines 550–552)

```
async fn config(&self) -> Arc<crate::config::Config>
```

**Purpose**: Returns the current runtime `Config` object for the session. It provides shared ownership of the loaded configuration snapshot.

**Data flow**: Delegates to `self.codex.session.get_config().await` → returns `Arc<crate::config::Config>`.

**Call relations**: Used by config-refresh builders that need the current config before deriving runtime MCP settings or updates.

*Call graph*: called by 1 (build_refresh_config).


##### `CodexThread::runtime_mcp_config`  (lines 555–557)

```
async fn runtime_mcp_config(&self, config: &crate::config::Config) -> codex_mcp::McpConfig
```

**Purpose**: Resolves the effective MCP runtime configuration using this thread’s extension data and a supplied base config. It computes the thread-specific MCP view rather than returning static config.

**Data flow**: Takes `&crate::config::Config` → delegates to `self.codex.session.runtime_mcp_config(config).await` → returns `codex_mcp::McpConfig`.

**Call relations**: Used alongside `config()` when building refreshed runtime configuration for MCP-aware callers.

*Call graph*: called by 1 (build_refresh_config).


##### `CodexThread::multi_agent_version`  (lines 559–561)

```
fn multi_agent_version(&self) -> Option<MultiAgentVersion>
```

**Purpose**: Returns the thread’s configured multi-agent protocol/version, if any. It is a synchronous accessor over session state.

**Data flow**: Reads `self.codex.session.multi_agent_version()` → returns `Option<MultiAgentVersion>`.

**Call relations**: Used by gating logic that decides whether direct input is allowed or whether a thread is a resident candidate.

*Call graph*: called by 2 (ensure_direct_input_allowed, is_resident_candidate).


##### `CodexThread::refresh_runtime_config`  (lines 566–568)

```
async fn refresh_runtime_config(&self, next_config: crate::config::Config)
```

**Purpose**: Refreshes layer-backed user config state from a caller-supplied config snapshot while leaving thread-scoped layers and session-static settings intact. It is a targeted runtime config reload hook.

**Data flow**: Takes owned `crate::config::Config` → forwards to `self.codex.session.refresh_runtime_config(next_config).await` → returns `()`.

**Call relations**: Used when external config changes should update runtime behavior without rebuilding the thread.


##### `CodexThread::environment_selections`  (lines 570–572)

```
async fn environment_selections(&self) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Returns the thread’s current environment selections as a concrete vector. It is the async runtime accessor corresponding to the snapshot helper.

**Data flow**: Delegates to `self.codex.thread_environment_selections().await` → returns `Vec<TurnEnvironmentSelection>`.

**Call relations**: Used by callers that need the live environment selection list rather than a full config snapshot.

*Call graph*: calls 1 internal fn (thread_environment_selections).


##### `CodexThread::read_mcp_resource`  (lines 574–586)

```
async fn read_mcp_resource(
        &self,
        server: &str,
        uri: &str,
    ) -> anyhow::Result<serde_json::Value>
```

**Purpose**: Reads an MCP resource from a named server and converts the result into generic JSON. It is a thread-level convenience wrapper around MCP resource access.

**Data flow**: Takes `server` and `uri` strings → builds `ReadResourceRequestParams::new(uri)` → awaits `self.codex.session.read_resource(server, params)` → serializes the typed result with `serde_json::to_value` → returns `serde_json::Value` or `anyhow` error.

**Call relations**: Used by callers that want a simple JSON result from MCP resource reads without depending on the typed MCP response shape.

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

**Purpose**: Invokes an MCP tool on a named server with optional arguments and metadata. It exposes tool execution at thread scope.

**Data flow**: Accepts server/tool names plus optional JSON `arguments` and `meta` → delegates to `self.codex.session.call_tool(server, tool, arguments, meta).await` → returns `CallToolResult` or error.

**Call relations**: Used by external management or integration paths that need direct MCP tool invocation through the thread.


##### `CodexThread::enabled`  (lines 601–603)

```
fn enabled(&self, feature: Feature) -> bool
```

**Purpose**: Checks whether a given feature flag is enabled for this thread/session. It is a synchronous feature-gating helper.

**Data flow**: Takes `Feature` → delegates to `self.codex.enabled(feature)` → returns `bool`.

**Call relations**: Used by callers that need to branch on feature rollout state without reaching into `Codex` directly.

*Call graph*: calls 1 internal fn (enabled).


##### `CodexThread::increment_out_of_band_elicitation_count`  (lines 605–619)

```
async fn increment_out_of_band_elicitation_count(&self) -> CodexResult<u64>
```

**Purpose**: Increments the count of active out-of-band elicitations and pauses the session when transitioning from zero to one. It protects the counter against overflow.

**Data flow**: Locks `self.out_of_band_elicitation_count` → checks whether the prior value was zero → increments with `checked_add`, returning `CodexErr::Fatal` on overflow → if this was the first active elicitation, calls `self.codex.session.set_out_of_band_elicitation_pause_state(true)` → returns the new count.

**Call relations**: Used by elicitation lifecycle code to bracket periods where normal thread progress should be paused because external elicitation is in flight.


##### `CodexThread::decrement_out_of_band_elicitation_count`  (lines 621–638)

```
async fn decrement_out_of_band_elicitation_count(&self) -> CodexResult<u64>
```

**Purpose**: Decrements the active out-of-band elicitation count and unpauses the session when the count reaches zero. It rejects underflow explicitly.

**Data flow**: Locks `self.out_of_band_elicitation_count` → if already zero, returns `CodexErr::InvalidRequest` → otherwise decrements by one → if the new value is zero, calls `self.codex.session.set_out_of_band_elicitation_pause_state(false)` → returns the new count.

**Call relations**: Used when an out-of-band elicitation completes or is dismissed, restoring normal session progress once the last outstanding elicitation is gone.

*Call graph*: 1 external calls (InvalidRequest).


### `core/src/session/mod.rs`

`orchestration` · `startup, request handling, turn execution, persistence, shutdown`

This module is the top-level session hub for the Codex runtime. It exposes `Codex`, a queue-pair interface with a submission sender and event receiver, and extends `Session` with the bulk of the runtime behaviors that are shared across turn handlers. Startup begins in `Codex::spawn`/`spawn_internal`, which validates inherited tracing, resolves model and multi-agent defaults, derives base instructions and service tier, loads or inherits exec policy, constructs `SessionConfiguration`, creates the `Session`, and launches the background `submission_loop` task. The file also defines `SteerInputError` for mid-turn user steering failures and `PreviousTurnSettings`, which preserves prior-turn model/compaction/realtime state so later context diffs can be generated correctly.

A large portion of the file manages durable thread state. It reconstructs history from resumed or forked rollouts, persists `RolloutItem`s and raw protocol events to `LiveThread`, materializes rollout files when needed, and maintains a reference `TurnContextItem` baseline so later turns can emit either full initial context or compact settings diffs. It also computes and updates token usage snapshots, rate limits, auto-compact window metadata, and context-window rollover.

The module is also where interactive runtime coordination lives: approval requests are registered in active turn state and resolved through oneshot channels; request-permissions responses are normalized against the originally requested profile and cwd; dynamic tool responses and user-input prompts are routed back into the active turn; and `steer_input` appends additional `TurnInput`s into the active turn mailbox only for regular turns. Event emission is carefully layered: `send_event` persists the event, updates analytics and agent status, mirrors text into realtime handoff when applicable, forwards terminal child-thread completion to a parent in MultiAgent V2, and emits legacy event variants for compatibility. Finally, the file assembles model-visible initial context from permissions, collaboration mode, personality, apps/connectors, skills, plugins, extension contributors, environment metadata, and user instructions, making it the main bridge between session configuration/state and the prompt seen by the model.

#### Function details

##### `SteerInputError::to_error_event`  (lines 251–278)

```
fn to_error_event(&self) -> ErrorEvent
```

**Purpose**: Converts each steering failure variant into a concrete protocol `ErrorEvent` with a user-facing message and the appropriate `CodexErrorInfo`. It preserves the distinction between bad requests and non-steerable active turns.

**Data flow**: Reads `self` as one of `NoActiveTurn`, `ExpectedTurnMismatch`, `ActiveTurnNotSteerable`, or `EmptyInput` → matches the variant and builds an `ErrorEvent` string, including interpolated expected/actual turn ids or a turn-kind label for review/compact turns → returns the constructed `ErrorEvent` without mutating session state.

**Call relations**: Used when steering failures need to be surfaced as protocol errors rather than internal Rust errors; it is the formatting boundary between `Session::steer_input` validation and client-visible event payloads.

*Call graph*: 1 external calls (format!).


##### `resolve_multi_agent_version`  (lines 441–457)

```
fn resolve_multi_agent_version(
    conversation_history: &InitialHistory,
    inherited_multi_agent_version: Option<MultiAgentVersion>,
) -> Option<MultiAgentVersion>
```

**Purpose**: Chooses the effective `MultiAgentVersion` for a new session from conversation history, inherited parent settings, and legacy fallback rules. It preserves an explicit inherited `Disabled` setting above all other sources.

**Data flow**: Consumes `conversation_history` and `inherited_multi_agent_version` → first short-circuits if inheritance explicitly disables multi-agent mode, otherwise checks rollout metadata via `get_multi_agent_version`, then inherited value, then falls back to `None` for new/cleared threads or `V1` for resumed/forked legacy threads → returns `Option<MultiAgentVersion>`.

**Call relations**: Called during session creation to seed `SessionConfiguration`, and also by other spawn-time helpers that need the same precedence rules before a `Session` exists.

*Call graph*: calls 1 internal fn (get_multi_agent_version); called by 2 (spawn_internal, initial_multi_agent_version_for_spawn).


##### `Codex::spawn`  (lines 466–488)

```
async fn spawn(args: CodexSpawnArgs) -> CodexResult<CodexSpawnOk>
```

**Purpose**: Public async constructor for a `Codex` session that validates an optional parent W3C trace carrier and wraps session startup in a `thread_spawn` tracing span. It ensures invalid inherited trace context is ignored rather than poisoning the new thread.

**Data flow**: Takes `CodexSpawnArgs` → validates `args.parent_trace` with `context_from_w3c_trace_context`, optionally attaches it to a new `info_span!`, rewrites the args with the sanitized trace, and awaits `spawn_internal` instrumented by that span → returns `CodexSpawnOk` or a `CodexErr`.

**Call relations**: This is the external entry into session startup, used by interactive thread runners and thread-spawn flows. It delegates all substantive initialization to `Codex::spawn_internal` after trace setup.

*Call graph*: called by 3 (run_codex_thread_interactive, guardian_subagent_does_not_inherit_parent_exec_policy_rules, spawn_thread_with_source); 5 external calls (spawn_internal, context_from_w3c_trace_context, set_parent_from_w3c_trace_context, info_span!, warn!).


##### `Codex::spawn_internal`  (lines 490–691)

```
async fn spawn_internal(args: CodexSpawnArgs) -> CodexResult<CodexSpawnOk>
```

**Purpose**: Builds the full session runtime: channels, exec policy, model selection, base instructions, session configuration, `Session` object, and the background submission loop task. It is the real constructor behind `Codex::spawn`.

**Data flow**: Consumes `CodexSpawnArgs` fields including config, managers, history, source metadata, inherited state, and extension data → creates submission/event channels; merges user-instruction warnings into config; chooses exec policy (guardian default, inherited, or loaded from config layers); prewarms model listing and resolves default model/model info; computes multi-agent version, base instructions, dynamic tools, collaboration mode, service tier, and permission profile state; constructs `SessionConfiguration`; creates watch channel for `AgentStatus`; awaits `Session::new`; spawns `submission_loop` with the session and config; wraps the join handle with `session_loop_termination_from_handle` → returns `CodexSpawnOk { codex, thread_id }`.

**Call relations**: Invoked only by `Codex::spawn`. It delegates to config/model helpers, `Session::new`, and the background `submission_loop`, and it is the point where startup errors are mapped into user-facing `CodexErr`s.

*Call graph*: calls 9 internal fn (default, load, get_service_tier, submission_loop, resolve_multi_agent_version, new, session_loop_termination_from_handle, session_permission_profile_state_from_config, new); 11 external calls (clone, new, pin, bounded, unbounded, is_guardian_reviewer_source, info_span!, matches!, from_config, spawn (+1 more)).


##### `Codex::submit`  (lines 694–696)

```
async fn submit(&self, op: Op) -> CodexResult<String>
```

**Purpose**: Convenience wrapper that submits an `Op` without an explicit trace carrier. It lets the session generate a submission id and inherit trace context automatically.

**Data flow**: Takes an `Op` → forwards it to `submit_with_trace` with `None` trace → returns the generated submission id string or a `CodexErr`.

**Call relations**: Used by approval handlers, shutdown paths, and generic callers that do not need to override tracing. It is a thin front door over `submit_with_trace`.

*Call graph*: calls 1 internal fn (submit_with_trace); called by 8 (handle_exec_approval, handle_patch_approval, handle_request_permissions, handle_request_user_input, shutdown_delegate, submit, interrupt_and_drain_turn, shutdown_and_wait).


##### `Codex::submit_with_trace`  (lines 698–712)

```
async fn submit_with_trace(
        &self,
        op: Op,
        trace: Option<W3cTraceContext>,
    ) -> CodexResult<String>
```

**Purpose**: Packages an operation into a `Submission` with a fresh UUID and optional explicit trace context, then enqueues it. It is the normal path for externally initiated work.

**Data flow**: Accepts `op` and optional `W3cTraceContext` → generates a v7 UUID string, builds `Submission { id, op, client_user_message_id: None, trace }`, sends it through `submit_with_id`, and returns the id on success → writes to the submission channel indirectly.

**Call relations**: Called by `Codex::submit` and external traced submission paths. It delegates actual channel send and trace backfill to `submit_with_id`.

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

**Purpose**: Specialized submission helper for `Op::UserInput` that preserves a client-supplied user message id alongside the generated submission id. This keeps UI-originated message identity attached to the turn.

**Data flow**: Takes a user-input `Op`, optional trace, and optional `client_user_message_id` → asserts the op is `Op::UserInput`, generates a UUID, builds a `Submission` carrying the client id, and forwards it to `submit_with_id` → returns the generated submission id.

**Call relations**: Used by user-input specific API surfaces that need to preserve client message identity. It shares the same enqueue path as generic submissions.

*Call graph*: calls 1 internal fn (submit_with_id); called by 1 (submit_user_input_with_client_user_message_id); 2 external calls (now_v7, debug_assert!).


##### `Codex::submit_with_id`  (lines 734–743)

```
async fn submit_with_id(&self, mut sub: Submission) -> CodexResult<()>
```

**Purpose**: Lowest-level submission enqueue method that sends a fully formed `Submission` into the bounded submission channel. If no trace is present, it snapshots the current tracing span context first.

**Data flow**: Takes mutable `Submission` → fills `sub.trace` from `current_span_w3c_trace_context()` when absent, awaits `tx_sub.send(sub)`, and maps channel closure to `CodexErr::InternalAgentDied` → returns `()` on success.

**Call relations**: Called by the higher-level submit helpers. It is the final handoff into the background `submission_loop`.

*Call graph*: called by 3 (submit_with_id, submit_user_input_with_client_user_message_id, submit_with_trace); 2 external calls (send, current_span_w3c_trace_context).


##### `Codex::set_thread_memory_mode`  (lines 749–754)

```
async fn set_thread_memory_mode(
        &self,
        mode: codex_protocol::protocol::ThreadMemoryMode,
    ) -> anyhow::Result<()>
```

**Purpose**: Persists a thread-level memory mode change directly into rollout metadata without involving the model. It is explicitly a local metadata update.

**Data flow**: Accepts a `ThreadMemoryMode` → calls `handlers::persist_thread_memory_mode_update(&self.session, mode)` → returns `anyhow::Result<()>` from that persistence operation.

**Call relations**: Used by host APIs that change thread memory behavior out of band. It delegates all actual persistence logic to the handlers module.

*Call graph*: calls 1 internal fn (persist_thread_memory_mode_update); called by 1 (set_thread_memory_mode).


##### `Codex::shutdown_and_wait`  (lines 756–765)

```
async fn shutdown_and_wait(&self) -> CodexResult<()>
```

**Purpose**: Requests orderly shutdown of the session loop and waits for the background task to terminate. It tolerates the loop already being dead.

**Data flow**: Clones the shared `session_loop_termination` future → submits `Op::Shutdown`; ignores `InternalAgentDied` but propagates other submission errors; awaits the shared termination future → returns `CodexResult<()>`.

**Call relations**: Used by shutdown/finalization flows. It combines the normal submission path with the join-handle wrapper created at startup.

*Call graph*: calls 1 internal fn (submit); called by 3 (shutdown_and_wait, shutdown, finalize_thread_spawn); 1 external calls (clone).


##### `Codex::next_event`  (lines 767–774)

```
async fn next_event(&self) -> CodexResult<Event>
```

**Purpose**: Receives the next protocol `Event` from the session's unbounded event channel. It is the consumer-facing half of the queue-pair API.

**Data flow**: Awaits `rx_event.recv()` → maps channel closure to `CodexErr::InternalAgentDied` → returns the received `Event`.

**Call relations**: Called by app-server and shutdown-drain loops that stream session output. It consumes events produced by `Session::deliver_event_raw`.

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

**Purpose**: Public wrapper that injects additional user input into the currently active turn. It forwards all validation and queue mutation to the underlying `Session`.

**Data flow**: Accepts `Vec<UserInput>`, additional context map, optional expected turn id, optional client message id, and optional Responses API metadata → awaits `self.session.steer_input(...)` → returns the accepted active turn id or `SteerInputError`.

**Call relations**: Used by external steering APIs. It is a direct pass-through to `Session::steer_input`, which performs the active-turn checks and mailbox insertion.

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

**Purpose**: Stores app-server client name/version into session settings and configures whether MCP elicitations should auto-deny. This ties host metadata to both prompt/session state and MCP runtime behavior.

**Data flow**: Takes optional client name/version and a boolean `mcp_elicitations_auto_deny` → calls `session.update_settings` with a `SessionSettingsUpdate` carrying the metadata, then loads the current MCP connection manager and sets its elicitation auto-deny flag → returns `ConstraintResult<()>`.

**Call relations**: Invoked by host integration code after session creation. It bridges session configuration updates with live MCP transport configuration.

*Call graph*: called by 1 (set_app_server_client_info); 1 external calls (default).


##### `Codex::agent_status`  (lines 813–815)

```
async fn agent_status(&self) -> AgentStatus
```

**Purpose**: Returns the latest known `AgentStatus` snapshot from the watch channel. It is a cheap read-only status accessor.

**Data flow**: Borrows the current value from `self.agent_status` and clones it → returns `AgentStatus` without mutating state.

**Call relations**: Used by status-query APIs. The watch channel is updated by `Session::deliver_event_raw` and terminal-child forwarding logic.

*Call graph*: called by 1 (agent_status); 1 external calls (borrow).


##### `Codex::thread_config_snapshot`  (lines 817–820)

```
async fn thread_config_snapshot(&self) -> ThreadConfigSnapshot
```

**Purpose**: Extracts the current thread configuration snapshot from session state. This is the persisted/configurable view of the thread rather than transient turn state.

**Data flow**: Locks `session.state`, reads `state.session_configuration.thread_config_snapshot()`, and returns that snapshot → no writes.

**Call relations**: Used by config-inspection APIs and analytics/reporting paths that need the current thread-level configuration.

*Call graph*: called by 1 (config_snapshot).


##### `Codex::instruction_sources`  (lines 822–831)

```
async fn instruction_sources(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the filesystem sources that contributed loaded agent instructions for the session. It exposes where instruction content came from, if any.

**Data flow**: Locks session state, reads `loaded_agents_md`, collects its `sources()` into a `Vec<AbsolutePathBuf>`, or returns an empty vector when no loaded instructions exist → no writes.

**Call relations**: Used by host APIs that surface instruction provenance. It depends on `LoadedAgentsMd` having been attached during session setup.

*Call graph*: called by 1 (instruction_sources).


##### `Codex::thread_environment_selections`  (lines 833–839)

```
async fn thread_environment_selections(&self) -> Vec<TurnEnvironmentSelection>
```

**Purpose**: Returns the current per-thread environment selections configured for the session. This exposes the thread's environment routing state.

**Data flow**: Locks session state, reads `session_configuration.environment_selections()`, clones it into a `Vec<TurnEnvironmentSelection>`, and returns it.

**Call relations**: Used by environment-inspection APIs. It reflects updates applied through session settings changes.

*Call graph*: called by 1 (environment_selections).


##### `Codex::state_db`  (lines 841–843)

```
fn state_db(&self) -> Option<state_db::StateDbHandle>
```

**Purpose**: Exposes the optional rollout state database handle associated with the session. It is a simple accessor for persistence integrations.

**Data flow**: Delegates to `self.session.state_db()` → returns `Option<state_db::StateDbHandle>`.

**Call relations**: Used by callers that need direct access to state-db-backed rollout facilities.

*Call graph*: called by 1 (state_db).


##### `Codex::enabled`  (lines 845–847)

```
fn enabled(&self, feature: Feature) -> bool
```

**Purpose**: Checks whether a given feature flag is enabled for this session. It forwards to the session's managed feature set.

**Data flow**: Accepts a `Feature` → delegates to `self.session.enabled(feature)` → returns `bool`.

**Call relations**: Used by host code that needs to branch on session feature gates without locking session state directly.

*Call graph*: called by 1 (enabled).


##### `get_service_tier`  (lines 850–862)

```
fn get_service_tier(
    configured_service_tier: Option<String>,
    fast_mode_enabled: bool,
    model_info: &ModelInfo,
) -> Option<String>
```

**Purpose**: Determines the request service tier string to send for the selected model, but only when fast mode is enabled and the model supports the configured tier. Unsupported custom tiers are dropped.

**Data flow**: Reads `configured_service_tier`, `fast_mode_enabled`, and `model_info` → returns `None` immediately if fast mode is off; otherwise filters the configured tier to either the default request value or one supported by `model_info.supports_service_tier` → returns `Option<String>`.

**Call relations**: Called during `Codex::spawn_internal` while building `SessionConfiguration` so the model client gets a valid tier setting.

*Call graph*: called by 1 (spawn_internal).


##### `session_permission_profile_state_from_config`  (lines 864–868)

```
fn session_permission_profile_state_from_config(
    config: &Config,
) -> CodexResult<PermissionProfileState>
```

**Purpose**: Extracts the initial `PermissionProfileState` from the session config. It currently just clones the config-derived state into a `CodexResult`.

**Data flow**: Reads `config.permissions.permission_profile_state()` → clones it and wraps it in `Ok(...)` → returns `CodexResult<PermissionProfileState>`.

**Call relations**: Used during session startup when constructing `SessionConfiguration`.

*Call graph*: called by 1 (spawn_internal).


##### `completed_session_loop_termination`  (lines 871–873)

```
fn completed_session_loop_termination() -> SessionLoopTermination
```

**Purpose**: Test helper that returns an already-completed shared termination future. It lets tests construct a `Codex` without a real background task.

**Data flow**: Creates `futures::future::ready(())`, boxes it, and shares it → returns `SessionLoopTermination`.

**Call relations**: Only compiled in tests and used by test fixtures that need a no-op session loop completion handle.

*Call graph*: called by 1 (test_review_session); 1 external calls (ready).


##### `session_loop_termination_from_handle`  (lines 875–883)

```
fn session_loop_termination_from_handle(
    handle: JoinHandle<()>,
) -> SessionLoopTermination
```

**Purpose**: Wraps a spawned Tokio task handle into the shared `SessionLoopTermination` future type used by `Codex`. It intentionally discards the task result.

**Data flow**: Takes `JoinHandle<()>` → builds an async block awaiting the handle and ignoring its result, boxes it, and shares it → returns `SessionLoopTermination`.

**Call relations**: Called by `Codex::spawn_internal` immediately after spawning the background `submission_loop`.

*Call graph*: called by 1 (spawn_internal).


##### `thread_title_from_thread_store`  (lines 885–912)

```
async fn thread_title_from_thread_store(
    live_thread: Option<&LiveThread>,
    thread_store: &Arc<dyn ThreadStore>,
    conversation_id: ThreadId,
) -> Option<String>
```

**Purpose**: Looks up a thread title from either an existing `LiveThread` or the generic `ThreadStore`, and suppresses empty titles or titles identical to the preview. This avoids surfacing redundant thread names.

**Data flow**: Accepts optional `live_thread`, `thread_store`, and `conversation_id` → reads thread metadata via `read_thread`, extracts `thread.name`, trims it, compares it against `thread.preview`, and returns `Some(title)` only when non-empty and distinct from the preview → otherwise returns `None`.

**Call relations**: A utility for thread metadata reconstruction and display paths that need a human title without forcing callers to know whether persistence is live or store-backed.


##### `Session::app_server_client_metadata`  (lines 915–924)

```
async fn app_server_client_metadata(&self) -> AppServerClientMetadata
```

**Purpose**: Returns the app-server client name/version currently stored in session configuration. This packages host metadata for analytics and child-thread inheritance.

**Data flow**: Locks session state, clones `app_server_client_name` and `app_server_client_version` from `session_configuration`, and returns them in `AppServerClientMetadata`.

**Call relations**: Used by analytics and thread-spawn code that needs inherited client identity.


##### `Session::managed_network_proxy_active_for_permission_profile`  (lines 926–930)

```
fn managed_network_proxy_active_for_permission_profile(
        permission_profile: &PermissionProfile,
    ) -> bool
```

**Purpose**: Determines whether the managed network proxy should be considered active for a given permission profile. Only the fully disabled profile turns it off.

**Data flow**: Reads a `PermissionProfile` reference → returns `false` only when it matches `PermissionProfile::Disabled`, otherwise `true`.

**Call relations**: A small policy helper used by network-proxy setup logic to align proxy activation with sandbox permissions.

*Call graph*: 1 external calls (matches!).


##### `Session::build_model_client_beta_features_header`  (lines 937–958)

```
fn build_model_client_beta_features_header(config: &Config) -> Option<String>
```

**Purpose**: Precomputes the `x-codex-beta-features` header value for the session-scoped model client. It advertises enabled experimental features that should be visible to the backend.

**Data flow**: Iterates global `FEATURES`, filters to specs that should be advertised in the model-client header and are enabled in `config.features`, collects their `key`s, joins them with commas, and returns `Some(header)` unless the result is empty.

**Call relations**: Used during session/model-client construction so the client can carry feature metadata without depending on the full `Config` later.


##### `Session::start_managed_network_proxy`  (lines 960–996)

```
async fn start_managed_network_proxy(
        spec: &crate::config::NetworkProxySpec,
        exec_policy: &codex_execpolicy::Policy,
        permission_profile: &PermissionProfile,
        network_po
```

**Purpose**: Starts a managed network proxy instance from config, merging exec-policy network rules into the proxy spec when possible and returning both the running proxy handle and runtime addresses. It is the creation path for session-managed proxying.

**Data flow**: Takes a `NetworkProxySpec`, exec policy, permission profile, optional policy decider and blocked-request observer, a requirements flag, and audit metadata → tries `with_exec_policy_network_rules`, falls back to the original spec on merge failure, awaits `spec.start_proxy(...)`, extracts HTTP/SOCKS addresses into `SessionNetworkProxyRuntime`, and returns `(StartedNetworkProxy, SessionNetworkProxyRuntime)` or an error.

**Call relations**: Called by proxy refresh/startup paths when a session needs a managed proxy instance. `refresh_managed_network_proxy_for_current_permission_profile` uses it when no proxy is already running.

*Call graph*: calls 2 internal fn (start_proxy, with_exec_policy_network_rules).


##### `Session::refresh_managed_network_proxy_for_current_permission_profile`  (lines 998–1068)

```
async fn refresh_managed_network_proxy_for_current_permission_profile(&self)
```

**Purpose**: Rebuilds or updates the managed network proxy to match the session's current permission profile and exec-policy network rules. It serializes refreshes with a semaphore and handles both in-place updates and cold starts.

**Data flow**: Acquires `managed_network_proxy_refresh_lock` → clones current `session_configuration`; if no network proxy spec exists in config, clears `services.network_proxy` and returns; otherwise recomputes the spec for the current permission profile, merges current exec-policy rules, and either applies the new spec to an existing started proxy or starts a new proxy via `start_managed_network_proxy`; on success stores the new proxy in `services.network_proxy`, on failures logs warnings.

**Call relations**: Triggered by `Session::update_settings` when the effective permission profile changes. It delegates proxy creation to `start_managed_network_proxy` and uses live service state to decide whether to mutate or replace the proxy.

*Call graph*: called by 1 (update_settings); 4 external calls (new, start_managed_network_proxy, error!, warn!).


##### `Session::codex_home`  (lines 1071–1074)

```
async fn codex_home(&self) -> AbsolutePathBuf
```

**Purpose**: Test-only accessor for the session's configured Codex home directory. It exposes the path from session configuration.

**Data flow**: Locks session state, clones `session_configuration.codex_home()`, and returns it.

**Call relations**: Used only in tests that need to inspect persistence/config paths.


##### `Session::subscribe_out_of_band_elicitation_pause_state`  (lines 1076–1078)

```
fn subscribe_out_of_band_elicitation_pause_state(&self) -> watch::Receiver<bool>
```

**Purpose**: Returns a watch receiver for the session's out-of-band elicitation pause flag. Consumers can observe pause/resume transitions without polling.

**Data flow**: Clones a subscription from `self.out_of_band_elicitation_paused` → returns `watch::Receiver<bool>`.

**Call relations**: Used by components coordinating MCP or elicitation behavior with session-level pause state.


##### `Session::set_out_of_band_elicitation_pause_state`  (lines 1080–1082)

```
fn set_out_of_band_elicitation_pause_state(&self, paused: bool)
```

**Purpose**: Updates the out-of-band elicitation pause flag for all watchers. It is the write side of the pause-state watch channel.

**Data flow**: Takes `paused: bool` → calls `send_replace` on `out_of_band_elicitation_paused` → updates the watched state in place.

**Call relations**: Used by runtime control paths that need to pause or resume external elicitation handling.


##### `Session::get_tx_event`  (lines 1084–1086)

```
fn get_tx_event(&self) -> Sender<Event>
```

**Purpose**: Returns a clone of the session's event sender channel. This allows internal helpers to emit protocol events without borrowing the whole session.

**Data flow**: Clones `self.tx_event` → returns `Sender<Event>`.

**Call relations**: Used by internal subsystems that need direct event-channel access.


##### `Session::state_db`  (lines 1088–1090)

```
fn state_db(&self) -> Option<state_db::StateDbHandle>
```

**Purpose**: Returns the optional state database handle from session services. It is a direct accessor for persistence infrastructure.

**Data flow**: Clones `self.services.state_db` → returns `Option<state_db::StateDbHandle>`.

**Call relations**: Used by callers that need state-db access from a `Session` rather than a `Codex` wrapper.


##### `Session::live_thread_for_persistence`  (lines 1092–1098)

```
fn live_thread_for_persistence(
        &self,
        operation: &str,
    ) -> anyhow::Result<&LiveThread>
```

**Purpose**: Returns the active `LiveThread` or produces an operation-specific error if persistence is disabled. It centralizes the guard for persistence-required operations.

**Data flow**: Reads `self.live_thread()` → if present returns `&LiveThread`, otherwise constructs an `anyhow!` error mentioning the requested `operation`.

**Call relations**: Called by persistence-sensitive code paths that cannot proceed without file-backed rollout storage.

*Call graph*: calls 1 internal fn (live_thread).


##### `Session::live_thread`  (lines 1100–1102)

```
fn live_thread(&self) -> Option<&LiveThread>
```

**Purpose**: Returns the optional live rollout thread handle stored in session services. This is the canonical check for whether persistence is enabled.

**Data flow**: Reads `self.services.live_thread.as_ref()` → returns `Option<&LiveThread>`.

**Call relations**: Used by rollout flush/materialization/path helpers and by `persist_rollout_items`.

*Call graph*: called by 5 (current_rollout_path, flush_rollout, live_thread_for_persistence, persist_rollout_items, try_ensure_rollout_materialized).


##### `Session::flush_rollout`  (lines 1106–1112)

```
async fn flush_rollout(&self) -> std::io::Result<()>
```

**Purpose**: Flushes pending rollout writes to durable storage and returns the final durability result. If persistence is disabled, it succeeds as a no-op.

**Data flow**: Checks `live_thread()` → if present awaits `live_thread.flush()` and maps its error into `std::io::Error`, otherwise returns `Ok(())`.

**Call relations**: Called after initial-history reconstruction for non-subagent sessions to ensure startup persistence reaches disk.

*Call graph*: calls 1 internal fn (live_thread); called by 1 (record_initial_history).


##### `Session::try_ensure_rollout_materialized`  (lines 1114–1119)

```
async fn try_ensure_rollout_materialized(&self) -> std::io::Result<()>
```

**Purpose**: Forces the live thread to persist itself to disk if persistence is enabled. Unlike `flush_rollout`, this ensures the rollout file exists at all.

**Data flow**: Checks `live_thread()` → if present awaits `live_thread.persist()` and maps errors to `std::io::Error`, otherwise returns `Ok(())`.

**Call relations**: Used by `ensure_rollout_materialized`, which logs rather than returning errors.

*Call graph*: calls 1 internal fn (live_thread); called by 1 (ensure_rollout_materialized).


##### `Session::ensure_rollout_materialized`  (lines 1121–1125)

```
async fn ensure_rollout_materialized(&self)
```

**Purpose**: Best-effort wrapper around rollout materialization that logs failures instead of propagating them. It is used when persistence is desirable but not fatal.

**Data flow**: Awaits `try_ensure_rollout_materialized()` → on error logs a warning and otherwise does nothing.

**Call relations**: Called after fork startup, after recording user prompts, and before exposing transcript paths.

*Call graph*: calls 1 internal fn (try_ensure_rollout_materialized); called by 3 (hook_transcript_path, record_initial_history, record_user_prompt_and_emit_turn_item); 1 external calls (warn!).


##### `Session::next_internal_sub_id`  (lines 1127–1132)

```
fn next_internal_sub_id(&self) -> String
```

**Purpose**: Generates a unique internal submission id for synthetic session-generated turns such as realtime text handoff. The ids are prefixed `auto-compact-` and backed by an atomic counter.

**Data flow**: Atomically increments `next_internal_sub_id` with `SeqCst` ordering → formats the previous value into `auto-compact-{id}` → returns the string.

**Call relations**: Used by `route_realtime_text_input` to create synthetic submission ids without colliding with external UUID-based submissions.

*Call graph*: called by 1 (route_realtime_text_input); 1 external calls (format!).


##### `Session::route_realtime_text_input`  (lines 1134–1151)

```
async fn route_realtime_text_input(self: &Arc<Self>, text: String)
```

**Purpose**: Injects a realtime text fragment into the normal user-input turn handling path as a synthetic `Op::UserInput`. This lets realtime handoff reuse the standard turn machinery.

**Data flow**: Takes `text: String` → generates an internal sub id via `next_internal_sub_id`, constructs `Op::UserInput` with a single `UserInput::Text`, empty additional context and default thread settings, and calls `handlers::user_input_or_turn_inner` with no client message id.

**Call relations**: Used by realtime conversation integration when text should be routed into the active session as if the user had submitted it.

*Call graph*: calls 2 internal fn (next_internal_sub_id, user_input_or_turn_inner); 2 external calls (default, vec!).


##### `Session::get_total_token_usage`  (lines 1153–1156)

```
async fn get_total_token_usage(&self) -> i64
```

**Purpose**: Returns the session's total token usage count as a signed integer, respecting whether server reasoning tokens are included. It is a convenience view over cached token state.

**Data flow**: Locks session state, reads `state.server_reasoning_included()` and `state.get_total_token_usage(...)` → returns `i64`.

**Call relations**: Used by token/accounting consumers that only need the aggregate count rather than the full `TokenUsageInfo`.


##### `Session::auto_compact_window_snapshot`  (lines 1158–1161)

```
async fn auto_compact_window_snapshot(&self) -> AutoCompactWindowSnapshot
```

**Purpose**: Returns the current auto-compaction window snapshot from session state. This exposes compaction bookkeeping for diagnostics or UI.

**Data flow**: Locks session state and returns `state.auto_compact_window_snapshot()`.

**Call relations**: Used by callers inspecting compaction state.


##### `Session::estimated_tokens_after_last_model_generated_item`  (lines 1163–1168)

```
async fn estimated_tokens_after_last_model_generated_item(&self) -> i64
```

**Purpose**: Reports the estimated token count immediately after the last model-generated history item. This is a history-derived estimate rather than server-reported usage.

**Data flow**: Locks session state and reads `state.history.estimated_tokens_after_last_model_generated_item()` → returns `i64`.

**Call relations**: Used by compaction and token-budget logic that needs a history-based estimate.


##### `Session::total_token_usage`  (lines 1170–1173)

```
async fn total_token_usage(&self) -> Option<TokenUsage>
```

**Purpose**: Returns the cached total `TokenUsage` snapshot if one exists. It is a narrower accessor than `token_usage_info`.

**Data flow**: Locks session state, reads `state.token_info()`, maps it to `info.total_token_usage`, and returns `Option<TokenUsage>`.

**Call relations**: Used by callers that only need total usage and not last-turn usage or context-window metadata.


##### `Session::token_usage_info`  (lines 1181–1184)

```
async fn token_usage_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the full cached `TokenUsageInfo`, including total usage, last-turn usage, and model context window. This is the accessor intended for replaying restored usage to clients.

**Data flow**: Locks session state and returns `state.token_info()`.

**Call relations**: Used by resume/fork and UI notification paths that need the complete token-count snapshot.


##### `Session::get_estimated_token_count`  (lines 1186–1192)

```
async fn get_estimated_token_count(
        &self,
        turn_context: &TurnContext,
    ) -> Option<i64>
```

**Purpose**: Estimates token count for the current history under a specific `TurnContext`. It delegates to the history manager's estimator.

**Data flow**: Locks session state and calls `state.history.estimate_token_count(turn_context)` → returns `Option<i64>`.

**Call relations**: Used by token-budget and compaction logic that needs a turn-specific estimate.


##### `Session::get_base_instructions`  (lines 1194–1199)

```
async fn get_base_instructions(&self) -> BaseInstructions
```

**Purpose**: Returns the session's current base instructions wrapped in the protocol `BaseInstructions` type. This is the canonical accessor for prompt-prefix text.

**Data flow**: Locks session state, clones `session_configuration.base_instructions`, wraps it in `BaseInstructions { text }`, and returns it.

**Call relations**: Used by rollout reconstruction and token recomputation when estimating history size with the prompt prefix included.

*Call graph*: called by 2 (apply_rollout_reconstruction, recompute_token_usage).


##### `Session::merge_connector_selection`  (lines 1202–1208)

```
async fn merge_connector_selection(
        &self,
        connector_ids: HashSet<String>,
    ) -> HashSet<String>
```

**Purpose**: Merges a set of connector ids into the session's explicit connector selection and returns the resulting set. This accumulates user- or turn-driven connector choices.

**Data flow**: Locks session state mutably, passes `connector_ids` into `state.merge_connector_selection`, and returns the merged `HashSet<String>`.

**Call relations**: Used by connector/app selection flows that need to persist explicit connector choices across turns.


##### `Session::get_connector_selection`  (lines 1211–1214)

```
async fn get_connector_selection(&self) -> HashSet<String>
```

**Purpose**: Returns the current explicit connector selection for the session. It exposes the accumulated connector ids without modifying them.

**Data flow**: Locks session state and returns `state.get_connector_selection()`.

**Call relations**: Used by connector-aware prompt/context builders and host inspection APIs.


##### `Session::clear_connector_selection`  (lines 1217–1220)

```
async fn clear_connector_selection(&self)
```

**Purpose**: Clears any accumulated explicit connector selection from session state. This resets connector choice back to implicit/default behavior.

**Data flow**: Locks session state mutably and calls `state.clear_connector_selection()`.

**Call relations**: Used when connector selection should not carry forward into later turns.


##### `Session::record_initial_history`  (lines 1222–1308)

```
async fn record_initial_history(&self, conversation_history: InitialHistory)
```

**Purpose**: Seeds session state from `InitialHistory` at startup, including reconstructed conversation history, previous-turn settings, token usage, and persistence behavior for resumed or forked threads. It also marks whether the next turn is the first real user turn.

**Data flow**: Reads whether the session source is a subagent and whether the initial history contains prior user turns → updates `state.set_next_turn_is_first`; for `New`/`Cleared`, clears previous-turn settings; for `Resumed`, reconstructs history via `apply_rollout_reconstruction`, warns and emits a `WarningEvent` if the resumed model differs from the current model, seeds token info from the last rollout token-count event, and flushes rollout for non-subagents; for `Forked`, reconstructs history, seeds token info, persists copied rollout items when non-empty, ensures the rollout is materialized immediately, and flushes for non-subagents.

**Call relations**: Called during session initialization after `Session::new` has enough state to rebuild history. It delegates reconstruction to `apply_rollout_reconstruction` and persistence to rollout helpers.

*Call graph*: calls 7 internal fn (apply_rollout_reconstruction, ensure_rollout_materialized, flush_rollout, persist_rollout_items, send_event, set_previous_turn_settings, initial_history_has_prior_user_turns); 4 external calls (last_token_info_from_rollout, format!, Warning, warn!).


##### `Session::apply_rollout_reconstruction`  (lines 1318–1359)

```
async fn apply_rollout_reconstruction(
        &self,
        turn_context: &TurnContext,
        rollout_items: &[RolloutItem],
    ) -> Option<PreviousTurnSettings>
```

**Purpose**: Reconstructs in-memory conversation history and previous-turn metadata from persisted rollout items, then installs that reconstructed state into the session. It also restores auto-compact window bookkeeping and optional prefix-token estimates.

**Data flow**: Takes a `TurnContext` and rollout slice → calls `reconstruct_history_from_rollout`, optionally runs `prepare_response_items` on reconstructed history when image resizing is enabled, replaces session history and reference context item, restores auto-compact window id and previous-turn settings, optionally estimates prefix tokens with base instructions when the token-limit scope is `BodyAfterPrefix`, and stores that estimate via `set_auto_compact_window_estimated_prefill_for_scope` → returns `Option<PreviousTurnSettings>`.

**Call relations**: Used only by `record_initial_history` during resume/fork startup. It bridges persisted rollout data into live session state.

*Call graph*: calls 4 internal fn (prepare_response_items, clone_history, get_base_instructions, set_auto_compact_window_estimated_prefill_for_scope); called by 1 (record_initial_history); 1 external calls (matches!).


##### `Session::set_auto_compact_window_estimated_prefill_for_scope`  (lines 1361–1375)

```
async fn set_auto_compact_window_estimated_prefill_for_scope(
        &self,
        turn_context: &TurnContext,
        tokens: i64,
    )
```

**Purpose**: Stores an estimated prefix-token prefill count for the current auto-compact window, but only when the configured token-limit scope is `BodyAfterPrefix`. Other scopes intentionally ignore the value.

**Data flow**: Reads `turn_context.config.model_auto_compact_token_limit_scope` → returns early unless it is `BodyAfterPrefix`; otherwise locks session state and writes `state.set_auto_compact_window_estimated_prefill(tokens)`.

**Call relations**: Called after rollout reconstruction and token recomputation to keep compaction heuristics aligned with the configured token-limit scope.

*Call graph*: called by 2 (apply_rollout_reconstruction, recompute_token_usage); 1 external calls (matches!).


##### `Session::last_token_info_from_rollout`  (lines 1377–1382)

```
fn last_token_info_from_rollout(rollout_items: &[RolloutItem]) -> Option<TokenUsageInfo>
```

**Purpose**: Finds the most recent persisted `TokenUsageInfo` embedded in a rollout. It scans backward so the latest token-count event wins.

**Data flow**: Iterates `rollout_items` in reverse → returns the first `EventMsg::TokenCount` whose `info` is present, otherwise `None`.

**Call relations**: Used by `record_initial_history` to seed token usage immediately on resume or fork.

*Call graph*: 1 external calls (iter).


##### `Session::previous_turn_settings`  (lines 1384–1387)

```
async fn previous_turn_settings(&self) -> Option<PreviousTurnSettings>
```

**Purpose**: Returns the cached `PreviousTurnSettings` from session state. This is the in-memory bridge to prior-turn model/realtime/compaction metadata.

**Data flow**: Locks session state and returns `state.previous_turn_settings()`.

**Call relations**: Used by context-diff builders and startup reconstruction logic.


##### `Session::set_previous_turn_settings`  (lines 1389–1395)

```
async fn set_previous_turn_settings(
        &self,
        previous_turn_settings: Option<PreviousTurnSettings>,
    )
```

**Purpose**: Stores or clears the cached `PreviousTurnSettings` in session state. This updates the baseline used for later context diffs.

**Data flow**: Locks session state mutably and calls `state.set_previous_turn_settings(previous_turn_settings)`.

**Call relations**: Called during initial-history handling when startup should clear or seed prior-turn metadata.

*Call graph*: called by 1 (record_initial_history).


##### `Session::update_settings`  (lines 1397–1435)

```
async fn update_settings(
        &self,
        updates: SessionSettingsUpdate,
    ) -> ConstraintResult<()>
```

**Purpose**: Applies a `SessionSettingsUpdate` to the current session configuration, notifies extension config contributors when the effective config changes, and refreshes the managed network proxy if the permission profile changed. It is the main live settings mutation path.

**Data flow**: Checks whether any config contributors exist → locks session state, applies the update to `session_configuration`, optionally snapshots previous/new effective configs, detects permission-profile changes, updates turn-environment selections service when environments changed, and installs the updated configuration; after unlocking, emits contributor notifications and, if needed, awaits `refresh_managed_network_proxy_for_current_permission_profile` → returns `ConstraintResult<()>` or the rejected constraint error.

**Call relations**: Used by host APIs such as app-server client metadata updates. It delegates config-change callbacks to `emit_config_changed_contributors` and network side effects to the proxy refresh helper.

*Call graph*: calls 2 internal fn (emit_config_changed_contributors, refresh_managed_network_proxy_for_current_permission_profile); 1 external calls (warn!).


##### `Session::preview_settings`  (lines 1437–1446)

```
async fn preview_settings(
        &self,
        updates: &SessionSettingsUpdate,
    ) -> ConstraintResult<ThreadConfigSnapshot>
```

**Purpose**: Validates and previews a settings update without mutating session state. It returns the resulting `ThreadConfigSnapshot` if the update would be accepted.

**Data flow**: Locks session state, applies `updates` to the current `session_configuration`, and maps the resulting configuration to `thread_config_snapshot()` → returns `ConstraintResult<ThreadConfigSnapshot>`.

**Call relations**: Used by preview/validation APIs that need to show the effect of a settings change before committing it.


##### `Session::set_session_startup_prewarm`  (lines 1448–1454)

```
async fn set_session_startup_prewarm(
        &self,
        startup_prewarm: SessionStartupPrewarmHandle,
    )
```

**Purpose**: Stores a startup prewarm handle in session state for later consumption. This lets startup work be handed off across phases.

**Data flow**: Locks session state mutably and calls `state.set_session_startup_prewarm(startup_prewarm)`.

**Call relations**: Used by startup orchestration that prepares resources before the first turn.


##### `Session::take_session_startup_prewarm`  (lines 1456–1459)

```
async fn take_session_startup_prewarm(&self) -> Option<SessionStartupPrewarmHandle>
```

**Purpose**: Removes and returns any stored startup prewarm handle from session state. It is a one-shot retrieval API.

**Data flow**: Locks session state mutably and returns `state.take_session_startup_prewarm()`.

**Call relations**: Used by later startup phases that consume prewarmed resources.


##### `Session::get_config`  (lines 1461–1467)

```
async fn get_config(&self) -> std::sync::Arc<Config>
```

**Purpose**: Returns the current original config snapshot backing the session configuration. This exposes the session's config layers as an `Arc<Config>`.

**Data flow**: Locks session state and clones `session_configuration.original_config_do_not_use` → returns `Arc<Config>`.

**Call relations**: Used by runtime reload and inspection paths that need the current config snapshot.


##### `Session::user_instructions`  (lines 1469–1477)

```
async fn user_instructions(&self) -> Option<codex_extension_api::UserInstructions>
```

**Purpose**: Returns loaded user instructions from `LoadedAgentsMd`, if present. It exposes the instruction payload that was attached to the session.

**Data flow**: Locks session state, reads `loaded_agents_md`, extracts `user_instructions()`, clones it, and returns `Option<UserInstructions>`.

**Call relations**: Used by prompt/context and inspection paths that need the loaded user instruction block.


##### `Session::provider`  (lines 1479–1482)

```
async fn provider(&self) -> ModelProviderInfo
```

**Purpose**: Returns the current model provider info from session configuration. This is a simple accessor for provider identity.

**Data flow**: Locks session state and clones `session_configuration.provider` → returns `ModelProviderInfo`.

**Call relations**: Used by provider-aware runtime logic and host inspection APIs.


##### `Session::refresh_runtime_config`  (lines 1484–1525)

```
async fn refresh_runtime_config(&self, next_config: Config)
```

**Purpose**: Refreshes the session's runtime config from a new config snapshot while preserving thread-local layers, then rebuilds hooks and clears plugin/skill caches. It is the in-memory config reload path for an existing session.

**Data flow**: Determines whether config contributors should be notified → locks session state, snapshots previous effective config, clones the current config, replaces only the user layer from `next_config.config_layer_stack`, recomputes `tool_suggest`, stores the new `Arc<Config>`, snapshots the new effective config, and unlocks; emits contributor notifications; clears skills and plugins caches; snapshots current environments; asynchronously builds new hooks with `build_hooks_for_config`; re-locks state and publishes the hooks only if the config pointer still matches the snapshot used to build them.

**Call relations**: Called by `reload_user_config_layer` after reading config files. It delegates hook construction to `build_hooks_for_config` and contributor callbacks to `emit_config_changed_contributors`.

*Call graph*: calls 3 internal fn (resolve_tool_suggest_config_from_layer_stack, emit_config_changed_contributors, build_hooks_for_config); called by 1 (reload_user_config_layer); 3 external calls (clone, new, ptr_eq).


##### `Session::emit_config_changed_contributors`  (lines 1527–1546)

```
fn emit_config_changed_contributors(
        &self,
        previous_config: Option<&Config>,
        new_config: Option<&Config>,
    )
```

**Purpose**: Invokes extension config contributors when the effective session config actually changed. It suppresses notifications when either snapshot is missing or unchanged.

**Data flow**: Takes optional previous/new `Config` references → returns early unless both exist and differ; otherwise iterates `services.extensions.config_contributors()` and calls each contributor's `on_config_changed` with session/thread extension data and both configs.

**Call relations**: Used by both `update_settings` and `refresh_runtime_config` to fan out config-change notifications after state mutation.

*Call graph*: called by 2 (refresh_runtime_config, update_settings).


##### `Session::reload_user_config_layer`  (lines 1548–1616)

```
async fn reload_user_config_layer(&self)
```

**Purpose**: Reloads user config TOML files from disk into the session's config layer stack, then applies the refreshed runtime config. This is the legacy file-based reload path.

**Data flow**: Locks session state to discover user-layer file paths from `config_layer_stack`, defaulting to `<codex_home>/config.toml` when none are explicit → reads each file from disk, parsing TOML or substituting an empty table on not-found, aborting with warnings on read/parse errors → clones the current config, replaces each user layer with the reloaded TOML, recomputes `tool_suggest`, and passes the resulting config to `refresh_runtime_config`.

**Call relations**: Used by local reload flows when the host cannot provide a materialized config snapshot directly. It delegates the actual in-memory update to `refresh_runtime_config`.

*Call graph*: calls 2 internal fn (resolve_tool_suggest_config_from_layer_stack, refresh_runtime_config); 6 external calls (default, with_capacity, read_to_string, Table, vec!, warn!).


##### `Session::build_settings_update_items`  (lines 1618–1641)

```
async fn build_settings_update_items(
        &self,
        reference_context_item: Option<&TurnContextItem>,
        current_context: &TurnContext,
    ) -> Vec<ResponseItem>
```

**Purpose**: Builds model-visible context diff items representing settings changes relative to a reference context item. It threads in previous-turn settings, shell, exec policy, and personality feature gating.

**Data flow**: Reads `previous_turn_settings` from session state, gets the current user shell and exec policy, and calls `context_manager::updates::build_settings_update_items(reference_context_item, previous_turn_settings, current_context, shell, exec_policy, personality_feature_enabled)` → returns `Vec<ResponseItem>`.

**Call relations**: Called by `record_context_updates_and_set_reference_context_item` on steady-state turns when full initial context does not need to be reinjected.

*Call graph*: calls 2 internal fn (build_settings_update_items, user_shell); called by 1 (record_context_updates_and_set_reference_context_item).


##### `Session::track_turn_codex_error`  (lines 1644–1652)

```
fn track_turn_codex_error(&self, turn_context: &TurnContext, error: &CodexErr)
```

**Purpose**: Records a terminal `CodexErr` into analytics before completion notifications are reduced. It preserves structured error facts for the current turn.

**Data flow**: Takes `turn_context` and `error` → converts them into `TurnCodexErrorFact::from_codex_err(thread_id, sub_id, error)` and passes that fact to `analytics_events_client.track_turn_codex_error`.

**Call relations**: Used by turn execution paths when a terminal Codex error occurs and analytics should capture it before the turn fully unwinds.

*Call graph*: calls 1 internal fn (from_codex_err).


##### `Session::send_event`  (lines 1655–1695)

```
async fn send_event(&self, turn_context: &TurnContext, msg: EventMsg)
```

**Purpose**: Primary event emission path that persists an event, updates tracing and terminal-error state, forwards child completion to parents when needed, mirrors text to realtime handoff, clears realtime handoff on completion, and emits legacy compatibility events. It is the central protocol fan-out function.

**Data flow**: Takes `turn_context` and `EventMsg` → clones the message as `legacy_source`; if it is an `Error` whose `CodexErrorInfo` affects turn status, stores the error message in `turn_context.terminal_error`; records the event in rollout thread tracing; wraps it in `Event { id: sub_id, msg }` and sends it via `send_event_raw`; then calls `maybe_notify_parent_of_terminal_turn`, `maybe_mirror_event_text_to_realtime`, and `maybe_clear_realtime_handoff_for_event`; finally expands legacy event variants via `as_legacy_events(show_raw_agent_reasoning)` and sends each through `send_event_raw` as well.

**Call relations**: Called throughout the session runtime by approval requests, token updates, moderation/model events, turn-item lifecycle emission, and warning/error paths. It delegates persistence to `send_event_raw` and side-channel behaviors to the `maybe_*` helpers.

*Call graph*: calls 5 internal fn (maybe_clear_realtime_handoff_for_event, maybe_mirror_event_text_to_realtime, maybe_notify_parent_of_terminal_turn, send_event_raw, show_raw_agent_reasoning); called by 13 (emit_model_verification, emit_turn_item_completed, emit_turn_item_started, emit_turn_moderation_metadata, maybe_warn_on_server_model_mismatch, notify_stream_error, record_initial_history, request_command_approval, request_patch_approval, request_permissions_for_environment (+3 more)); 1 external calls (clone).


##### `Session::maybe_notify_parent_of_terminal_turn`  (lines 1698–1744)

```
async fn maybe_notify_parent_of_terminal_turn(
        &self,
        turn_context: &TurnContext,
        msg: &EventMsg,
    )
```

**Purpose**: For MultiAgent V2 spawned child threads, forwards terminal completion status to the direct parent thread once the child turn reaches a final state. It also upgrades terminal errors into `AgentStatus::Errored` when needed.

**Data flow**: Reads `turn_context.multi_agent_version` and `msg` → returns unless this is a V2 child and the event is `TurnComplete` or `TurnAborted`; extracts `parent_thread_id` and `child_agent_path` from `SessionSource::SubAgent(ThreadSpawn)`; derives final `AgentStatus` either from `turn_context.terminal_error` or `agent_status_from_event(msg)`; updates the session watch status if using an error-derived status; returns unless the status is final; then calls `forward_child_completion_to_parent`.

**Call relations**: Invoked only from `send_event` after the main event has been persisted and delivered. It delegates actual parent notification to `forward_child_completion_to_parent`.

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

**Purpose**: Builds and sends the standard inter-agent completion envelope from a spawned child thread to its parent thread, and records rollout trace metadata for that interaction when tracing is enabled. It is the concrete parent-notification implementation for MultiAgent V2.

**Data flow**: Takes `turn_context`, `parent_thread_id`, `child_agent_path`, and final `AgentStatus` → derives the parent agent path by trimming the last path segment, formats a completion message with `format_inter_agent_completion_message`, optionally clones it for tracing, constructs `InterAgentCommunication::new(child, parent, Vec::new(), message, false)`, sends it through `agent_control.send_inter_agent_communication`, and if successful records `AgentResultTracePayload` in `rollout_thread_trace`.

**Call relations**: Called by `maybe_notify_parent_of_terminal_turn` once a child turn is known to be terminal and final. It depends on `AgentControl` for delivery and rollout tracing for observability.

*Call graph*: calls 3 internal fn (format_inter_agent_completion_message, as_str, new); called by 1 (maybe_notify_parent_of_terminal_turn); 3 external calls (new, debug!, clone).


##### `Session::maybe_mirror_event_text_to_realtime`  (lines 1807–1817)

```
async fn maybe_mirror_event_text_to_realtime(&self, msg: &EventMsg)
```

**Purpose**: Mirrors textual content from selected protocol events into the realtime conversation handoff channel when a realtime conversation is active. This keeps the realtime side synchronized with normal event output.

**Data flow**: Extracts optional text via `realtime_text_for_event(msg)` → returns if no text or if `conversation.running_state()` is `None`; otherwise awaits `conversation.handoff_out(text)` and logs debug on failure.

**Call relations**: Called from `send_event` for every emitted event, but only acts on events that can be rendered as realtime text.

*Call graph*: calls 1 internal fn (realtime_text_for_event); called by 1 (send_event); 1 external calls (debug!).


##### `Session::maybe_clear_realtime_handoff_for_event`  (lines 1819–1827)

```
async fn maybe_clear_realtime_handoff_for_event(&self, msg: &EventMsg)
```

**Purpose**: Finalizes and clears the active realtime handoff when a turn completes. It ensures the realtime side sees completion boundaries.

**Data flow**: Checks whether `msg` is `EventMsg::TurnComplete` → if so, awaits `conversation.handoff_complete()`, logs debug on failure, and then calls `conversation.clear_active_handoff()`.

**Call relations**: Called from `send_event` after the main event is delivered. It only runs on turn-complete events.

*Call graph*: called by 1 (send_event); 2 external calls (debug!, matches!).


##### `Session::send_event_raw`  (lines 1829–1837)

```
async fn send_event_raw(&self, event: Event)
```

**Purpose**: Persists a single protocol event to rollout storage, records it in rollout tracing, and delivers it to the live event channel. Unlike `send_event`, it does not perform legacy expansion or side-channel behaviors.

**Data flow**: Wraps `event.msg.clone()` into a one-element `Vec<RolloutItem::EventMsg>`, persists it with `persist_rollout_items`, records the protocol event in `rollout_thread_trace`, and forwards the original `Event` to `deliver_event_raw`.

**Call relations**: Used by `send_event` for primary and legacy events, and directly by `build_initial_context` when emitting startup warnings outside a turn id.

*Call graph*: calls 2 internal fn (deliver_event_raw, persist_rollout_items); called by 2 (build_initial_context, send_event); 1 external calls (vec!).


##### `Session::deliver_event_raw`  (lines 1839–1847)

```
async fn deliver_event_raw(&self, event: Event)
```

**Purpose**: Sends an already-built `Event` to the external event channel and updates the session's last-known `AgentStatus` if the event implies one. It is the final in-memory delivery step.

**Data flow**: Reads `agent_status_from_event(&event.msg)` and updates the watch channel when present → awaits `tx_event.send(event)` and logs debug if the receiver side is closed.

**Call relations**: Called only by `send_event_raw` after persistence and tracing have already happened.

*Call graph*: called by 1 (send_event_raw); 2 external calls (agent_status_from_event, debug!).


##### `Session::emit_turn_item_started`  (lines 1849–1860)

```
async fn emit_turn_item_started(&self, turn_context: &TurnContext, item: &TurnItem)
```

**Purpose**: Emits an `ItemStartedEvent` for a parsed `TurnItem` with thread id, turn id, and current timestamp. It marks the beginning of a user-visible turn item lifecycle.

**Data flow**: Clones the provided `TurnItem`, builds `ItemStartedEvent { thread_id, turn_id, item, started_at_ms }` using `now_unix_timestamp_ms()`, wraps it in `EventMsg::ItemStarted`, and sends it via `send_event`.

**Call relations**: Called by response-item and user-prompt recording helpers whenever a `TurnItem` should be surfaced to clients.

*Call graph*: calls 2 internal fn (send_event, now_unix_timestamp_ms); called by 2 (record_response_item_and_emit_turn_item, record_user_prompt_and_emit_turn_item); 2 external calls (clone, ItemStarted).


##### `Session::emit_turn_item_completed`  (lines 1862–1878)

```
async fn emit_turn_item_completed(
        &self,
        turn_context: &TurnContext,
        item: TurnItem,
    )
```

**Purpose**: Emits an `ItemCompletedEvent` for a `TurnItem` and records time-to-first-meaningful-output metrics before doing so. It marks the end of a turn item lifecycle.

**Data flow**: Takes ownership of `item`, awaits `record_turn_ttfm_metric(turn_context, &item)`, builds `ItemCompletedEvent { thread_id, turn_id, item, completed_at_ms }`, wraps it in `EventMsg::ItemCompleted`, and sends it via `send_event`.

**Call relations**: Paired with `emit_turn_item_started`; called by the same recording helpers after the item has been persisted.

*Call graph*: calls 3 internal fn (send_event, now_unix_timestamp_ms, record_turn_ttfm_metric); called by 2 (record_response_item_and_emit_turn_item, record_user_prompt_and_emit_turn_item); 1 external calls (ItemCompleted).


##### `Session::persist_execpolicy_amendment`  (lines 1882–1900)

```
async fn persist_execpolicy_amendment(
        &self,
        amendment: &ExecPolicyAmendment,
    ) -> Result<(), ExecPolicyUpdateError>
```

**Purpose**: Appends an approved exec-policy amendment to both in-memory and on-disk exec policy so future commands can use the newly approved prefix. It is the durable write path for command approval expansions.

**Data flow**: Locks session state to clone `codex_home`, then awaits `services.exec_policy.append_amendment_and_update(&codex_home, amendment)` → returns `Result<(), ExecPolicyUpdateError>`.

**Call relations**: Used after approval decisions that grant a reusable command prefix. It delegates actual policy mutation to `ExecPolicyManager`.


##### `Session::turn_context_for_sub_id`  (lines 1902–1909)

```
async fn turn_context_for_sub_id(&self, sub_id: &str) -> Option<Arc<TurnContext>>
```

**Purpose**: Looks up the active turn context by submission id if that turn is currently running. It only searches the current active turn, not historical turns.

**Data flow**: Locks `active_turn`, inspects `active.task`, filters it by matching `task.turn_context.sub_id == sub_id`, and returns a cloned `Arc<TurnContext>` when matched.

**Call relations**: Used by amendment-recording helpers that need to inject contextual messages into the currently active turn associated with a given submission id.

*Call graph*: called by 2 (record_execpolicy_amendment_message, record_network_policy_amendment_message).


##### `Session::active_turn_context_and_cancellation_token`  (lines 1911–1920)

```
async fn active_turn_context_and_cancellation_token(
        &self,
    ) -> Option<(Arc<TurnContext>, CancellationToken)>
```

**Purpose**: Returns the active turn context together with a child cancellation token derived from the active task. This packages the two pieces of state commonly needed by interruptible helpers.

**Data flow**: Locks `active_turn`, extracts `task.turn_context` and `task.cancellation_token.child_token()`, clones the context arc, and returns them as `Option<(Arc<TurnContext>, CancellationToken)>`.

**Call relations**: Used by internal turn-control flows that need both the current context and a cancellation handle tied to the active task.

*Call graph*: 1 external calls (clone).


##### `Session::record_execpolicy_amendment_message`  (lines 1922–1936)

```
async fn record_execpolicy_amendment_message(
        &self,
        sub_id: &str,
        amendment: &ExecPolicyAmendment,
    )
```

**Purpose**: Injects a contextual user-fragment message into history noting that an approved command prefix was saved. This makes exec-policy amendments visible in the conversation record.

**Data flow**: Formats the amendment command into allow-prefix text with `format_allow_prefixes`; if formatting fails logs a warning and returns; otherwise wraps `ApprovedCommandPrefixSaved::new(prefixes)` into a `ResponseItem`, looks up the active turn context for `sub_id`, and calls `inject_no_new_turn` with that message.

**Call relations**: Used after persisting an exec-policy amendment so the saved approval is reflected in model-visible/session-visible history.

*Call graph*: calls 4 internal fn (into, new, turn_context_for_sub_id, format_allow_prefixes); 2 external calls (vec!, warn!).


##### `Session::persist_network_policy_amendment`  (lines 1938–1989)

```
async fn persist_network_policy_amendment(
        &self,
        amendment: &NetworkPolicyAmendment,
        network_approval_context: &NetworkApprovalContext,
    ) -> anyhow::Result<()>
```

**Purpose**: Applies an approved network policy amendment to the live managed proxy when present and persists the corresponding network rule into exec policy on disk. It serializes updates with the proxy refresh semaphore and validates the approved host.

**Data flow**: Acquires `managed_network_proxy_refresh_lock` → validates that `amendment.host` matches the approved host from `network_approval_context` via `validated_network_policy_amendment_host`; clones `codex_home`; derives an exec-policy amendment with `execpolicy_network_rule_amendment`; if a managed proxy is running, updates its runtime allow/deny list for the normalized host; then appends the network rule to exec policy via `append_network_rule_and_update` → returns `anyhow::Result<()>`.

**Call relations**: Used after network approval decisions that should persist beyond the immediate request. It depends on host validation and may mutate both runtime proxy state and durable exec policy.

*Call graph*: calls 1 internal fn (execpolicy_network_rule_amendment); 1 external calls (validated_network_policy_amendment_host).


##### `Session::validated_network_policy_amendment_host`  (lines 1991–2005)

```
fn validated_network_policy_amendment_host(
        amendment: &NetworkPolicyAmendment,
        network_approval_context: &NetworkApprovalContext,
    ) -> anyhow::Result<String>
```

**Purpose**: Ensures a network policy amendment only targets the exact host that was approved in the original network approval context. It normalizes both host strings before comparing them.

**Data flow**: Normalizes `network_approval_context.host` and `amendment.host` with `normalize_host` → if they differ, returns an `anyhow!` error naming both values; otherwise returns the normalized approved host string.

**Call relations**: Called by `persist_network_policy_amendment` before any runtime or durable policy mutation occurs.

*Call graph*: 2 external calls (anyhow!, normalize_host).


##### `Session::record_network_policy_amendment_message`  (lines 2007–2016)

```
async fn record_network_policy_amendment_message(
        &self,
        sub_id: &str,
        amendment: &NetworkPolicyAmendment,
    )
```

**Purpose**: Injects a contextual user-fragment message into history noting that a network rule was saved. This records the amendment in the conversation timeline.

**Data flow**: Wraps `NetworkRuleSaved::new(amendment)` into a `ResponseItem`, looks up the active turn context for `sub_id`, and calls `inject_no_new_turn` with that single message.

**Call relations**: Used after persisting a network policy amendment so the saved rule appears in session history.

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

**Purpose**: Registers a pending command approval for the active turn, emits an `ExecApprovalRequestEvent`, and waits for the user's review decision. It supports both top-level command approvals and subcommand callback approvals via `approval_id`.

**Data flow**: Takes turn context, call/approval ids, command argv, cwd, optional reason/network context/execpolicy amendment/additional permissions/available decisions → chooses an effective approval id, creates a oneshot channel, inserts the sender into active turn state under that id, warns if replacing an existing entry, parses the command, derives proposed network policy amendments from network context, computes default available decisions when absent, emits `EventMsg::ExecApprovalRequest`, and awaits the oneshot receiver, defaulting to `ReviewDecision::Abort` if the sender disappears.

**Call relations**: Called by tool execution paths when a command needs user review. It relies on later `notify_approval` calls to resolve the oneshot entry.

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

**Purpose**: Registers a pending patch approval for the active turn, emits an `ApplyPatchApprovalRequestEvent`, and returns the receiver that will yield the review decision. Unlike command approval, the caller awaits the receiver itself.

**Data flow**: Takes turn context, call id, file changes map, optional reason, and optional grant root → creates a oneshot channel, inserts the sender into active turn state keyed by `call_id`, warns on overwrite, emits `EventMsg::ApplyPatchApprovalRequest`, and returns the receiver.

**Call relations**: Used by patch-application flows that need asynchronous approval handling. The matching response arrives through `notify_approval`.

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

**Purpose**: Requests additional permissions for a specific environment, either by auto-granting under permissive approval policy, routing through Guardian review, or emitting a `RequestPermissionsEvent` and awaiting a host response. It also records granted permissions into turn or session state after normalization.

**Data flow**: Accepts session arc, turn context arc, call id, `RequestPermissionsArgs`, target `TurnEnvironmentSelection`, and cancellation token → first short-circuits to an empty/default response when approval policy forbids prompting or request-permissions is disabled; converts environment cwd to a native absolute path, falling back to an empty/default response if impossible; if approvals are routed to Guardian, spawns a guardian review request, waits for cancellation or decision, maps the decision into a `RequestPermissionsResponse`, normalizes it against the originally requested permissions and cwd, records granted permissions, and returns it; otherwise creates a oneshot channel, inserts a `PendingRequestPermissions` entry into active turn state, emits `EventMsg::RequestPermissions`, and waits on either cancellation (removing the pending entry) or the response receiver.

**Call relations**: Called by `request_permissions_for_cwd` after selecting an environment. It is resolved later by `notify_request_permissions_response`, or internally by Guardian review when that path is active.

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

**Purpose**: Convenience wrapper that resolves a target environment from `RequestPermissionsArgs` or the primary turn environment, overrides its cwd with a supplied native path, and delegates to environment-based permission requesting. It bridges cwd-based callers into the environment-aware API.

**Data flow**: Reads `args.environment_id` to find the matching turn environment or falls back to `turn_context.environments.primary()`; if none exists returns an empty/default `RequestPermissionsResponse`; otherwise clones the selection, replaces `environment.cwd` with `PathUri::from_abs_path(&cwd)`, and awaits `request_permissions_for_environment`.

**Call relations**: Used by callers that naturally operate on a cwd rather than a full environment selection.

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

**Purpose**: Registers a pending user-input request for the active turn, emits a `RequestUserInputEvent`, and waits for the user's answers. It also marks turn metadata to note that user input was requested mid-turn.

**Data flow**: Takes turn context, call id, and `RequestUserInputArgs` → creates a oneshot channel, inserts the sender into active turn state keyed by the turn's `sub_id`, warns on overwrite, builds and sends `EventMsg::RequestUserInput`, marks `turn_metadata_state.mark_user_input_requested_during_turn()`, and awaits the receiver, returning `Option<RequestUserInputResponse>`.

**Call relations**: Used by tools or model flows that need structured user answers during a turn. The response is delivered later through `notify_user_input_response`.

*Call graph*: calls 1 internal fn (send_event); 3 external calls (channel, RequestUserInput, warn!).


##### `Session::notify_user_input_response`  (lines 2397–2420)

```
async fn notify_user_input_response(
        &self,
        sub_id: &str,
        response: RequestUserInputResponse,
    )
```

**Purpose**: Delivers a `RequestUserInputResponse` to the pending user-input waiter for a given turn id. If no pending request exists, it logs a warning.

**Data flow**: Locks active turn state, removes the pending user-input sender for `sub_id`, and if found sends `response` through the oneshot channel; otherwise logs a warning.

**Call relations**: Called by host/app-server code when the user answers a previously emitted `RequestUserInputEvent`.

*Call graph*: 1 external calls (warn!).


##### `Session::notify_request_permissions_response`  (lines 2426–2477)

```
async fn notify_request_permissions_response(
        &self,
        call_id: &str,
        response: RequestPermissionsResponse,
    )
```

**Purpose**: Delivers a host-provided `RequestPermissionsResponse` to the pending permission request, normalizes it against the original request and cwd, and records any granted permissions into turn or session state. Missing pending entries are treated as stale responses and only logged.

**Data flow**: Locks active turn state, removes the `PendingRequestPermissions` entry for `call_id`, and captures the originating turn-state arc if present → if found, converts the stored environment cwd to a native path, normalizes the response with `normalize_request_permissions_response`, records granted permissions via `record_granted_request_permissions_for_turn`, and sends the normalized response through the oneshot sender; if cwd conversion fails, substitutes an empty/default response; if no entry exists, logs a warning.

**Call relations**: This is the completion path for non-Guardian `request_permissions_for_environment` requests.

*Call graph*: calls 1 internal fn (record_granted_request_permissions_for_turn); 3 external calls (normalize_request_permissions_response, default, warn!).


##### `Session::normalize_request_permissions_response`  (lines 2479–2506)

```
fn normalize_request_permissions_response(
        requested_permissions: RequestPermissionProfile,
        response: RequestPermissionsResponse,
        cwd: &Path,
    ) -> RequestPermissionsRespons
```

**Purpose**: Constrains a permission-grant response so it cannot exceed the originally requested permissions and cannot combine strict auto-review with session scope. It is the safety filter for externally supplied permission responses.

**Data flow**: Takes the originally requested `RequestPermissionProfile`, a proposed `RequestPermissionsResponse`, and the native cwd → if `strict_auto_review` is true with `Session` scope, downgrades to an empty turn-scoped response; if the response permissions are empty, returns it unchanged; otherwise intersects requested and granted permissions with `intersect_permission_profiles(..., cwd)` and returns a response carrying only the intersection plus the original scope/strict flag.

**Call relations**: Used by both Guardian and host-response permission flows before granted permissions are recorded or returned to the caller.

*Call graph*: calls 1 internal fn (intersect_permission_profiles); 3 external calls (default, into, matches!).


##### `Session::record_granted_request_permissions_for_turn`  (lines 2508–2537)

```
async fn record_granted_request_permissions_for_turn(
        &self,
        response: &RequestPermissionsResponse,
        environment_id: &str,
        originating_turn_state: Option<&Arc<Mutex<crat
```

**Purpose**: Stores granted additional permissions either in the active turn state or in session state depending on the grant scope, and enables strict auto-review on the turn when requested. Empty grants are ignored.

**Data flow**: Reads `response.permissions` and `response.scope` → returns early if permissions are empty; for `Turn` scope, locks the originating turn state (when provided), converts permissions into `AdditionalPermissionProfile`, records them under `environment_id`, and enables strict auto-review if requested; for `Session` scope, locks session state and records the granted permissions there.

**Call relations**: Called after permission responses are normalized in both `request_permissions_for_environment` and `notify_request_permissions_response`.

*Call graph*: called by 2 (notify_request_permissions_response, request_permissions_for_environment).


##### `Session::granted_turn_permissions`  (lines 2543–2551)

```
async fn granted_turn_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Returns any additional permissions granted for the current active turn in a specific environment. It reads from active turn state only.

**Data flow**: Locks `active_turn`, then the active turn's `turn_state`, and returns `ts.granted_permissions(environment_id)` as `Option<AdditionalPermissionProfile>`.

**Call relations**: Used by execution/review logic that needs to know what extra permissions were granted during the current turn.


##### `Session::strict_auto_review_enabled_for_turn`  (lines 2557–2564)

```
async fn strict_auto_review_enabled_for_turn(&self) -> bool
```

**Purpose**: Reports whether strict auto-review has been enabled for the current active turn. If there is no active turn, it returns false.

**Data flow**: Locks `active_turn`; if absent returns `false`; otherwise locks the turn state and returns `ts.strict_auto_review_enabled()`.

**Call relations**: Used by review/execution logic that needs to tighten behavior after a strict permission grant.


##### `Session::granted_session_permissions`  (lines 2566–2572)

```
async fn granted_session_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Returns any additional permissions granted at session scope for a specific environment. This reads from persistent session state rather than active turn state.

**Data flow**: Locks session state and returns `state.granted_permissions(environment_id)`.

**Call relations**: Used when later turns or tools need to inherit session-scoped permission grants.


##### `Session::notify_dynamic_tool_response`  (lines 2578–2597)

```
async fn notify_dynamic_tool_response(&self, call_id: &str, response: DynamicToolResponse)
```

**Purpose**: Delivers a `DynamicToolResponse` to the pending dynamic tool call waiting on the active turn. Missing entries are logged as stale or mismatched responses.

**Data flow**: Locks active turn state, removes the pending dynamic-tool sender for `call_id`, and if found sends `response` through it; otherwise logs a warning.

**Call relations**: Called by host/runtime code when a dynamic tool invocation completes.

*Call graph*: 1 external calls (warn!).


##### `Session::notify_approval`  (lines 2603–2622)

```
async fn notify_approval(&self, approval_id: &str, decision: ReviewDecision)
```

**Purpose**: Delivers a `ReviewDecision` to a pending approval request identified by approval id. If no pending approval exists, it logs a warning.

**Data flow**: Locks active turn state, removes the pending approval sender for `approval_id`, and if found sends `decision` through the oneshot channel; otherwise logs a warning.

**Call relations**: Completes approvals initiated by `request_command_approval` or `request_patch_approval`.

*Call graph*: 1 external calls (warn!).


##### `Session::prepare_conversation_items_for_history`  (lines 2626–2638)

```
fn prepare_conversation_items_for_history(
        &self,
        turn_context: &TurnContext,
        items: &'a [ResponseItem],
    ) -> Cow<'a, [ResponseItem]>
```

**Purpose**: Optionally preprocesses response items before they are recorded into history, currently to resize/process images when the `ResizeAllImages` feature is enabled. It avoids copying when no preparation is needed.

**Data flow**: Reads `turn_context.features` → if image resizing is disabled, returns `Cow::Borrowed(items)`; otherwise clones `items` into a mutable vector, runs `prepare_response_items`, and returns `Cow::Owned(prepared_items)`.

**Call relations**: Used by both `record_conversation_items` and `record_inter_agent_communication` so history and rollout receive the prepared form of items.

*Call graph*: calls 1 internal fn (prepare_response_items); called by 2 (record_conversation_items, record_inter_agent_communication); 3 external calls (Borrowed, Owned, to_vec).


##### `Session::response_item_from_user_input`  (lines 2640–2654)

```
fn response_item_from_user_input(
        &self,
        turn_context: &TurnContext,
        input: Vec<UserInput>,
    ) -> ResponseItem
```

**Purpose**: Converts raw `UserInput` into a `ResponseItem` suitable for history persistence, choosing whether local image preparation should be deferred or processed immediately based on feature flags. It is the canonical user-input-to-history conversion.

**Data flow**: Reads `turn_context.features` to choose `LocalImagePreparation::Defer` or `Process`, converts the input vector into `ResponseInputItem::from_user_input`, then into `ResponseItem`, and returns it.

**Call relations**: Used by `record_user_prompt_and_emit_turn_item` so persisted history matches the model input representation.

*Call graph*: calls 2 internal fn (from_user_input, from); called by 1 (record_user_prompt_and_emit_turn_item).


##### `Session::record_conversation_items`  (lines 2656–2669)

```
async fn record_conversation_items(
        &self,
        turn_context: &TurnContext,
        items: &[ResponseItem],
    )
```

**Purpose**: Appends response items to in-memory history, persists them to rollout storage, and emits raw response-item events to clients. It is the standard path for recording model-visible conversation content.

**Data flow**: Prepares items with `prepare_conversation_items_for_history`, locks session state to `record_items(items.iter(), turn_context.truncation_policy)`, persists them via `persist_rollout_response_items`, and emits `RawResponseItem` events through `send_raw_response_items`.

**Call relations**: Called when recording context updates, user prompts, and parsed response items. It is the shared history/persistence/event fan-out for conversation content.

*Call graph*: calls 3 internal fn (persist_rollout_response_items, prepare_conversation_items_for_history, send_raw_response_items); called by 3 (record_context_updates_and_set_reference_context_item, record_response_item_and_emit_turn_item, record_user_prompt_and_emit_turn_item); 2 external calls (as_ref, iter).


##### `Session::record_inter_agent_communication`  (lines 2671–2689)

```
async fn record_inter_agent_communication(
        &self,
        turn_context: &TurnContext,
        communication: InterAgentCommunication,
    )
```

**Purpose**: Records an `InterAgentCommunication` both as model input history and as a dedicated rollout item, then emits raw response-item events. This preserves both the semantic communication object and the model-visible message form.

**Data flow**: Converts `communication` into a model input `ResponseItem`, prepares it for history, records it into session history, persists the original communication as `RolloutItem::InterAgentCommunication`, and emits raw response-item events for the prepared item.

**Call relations**: Used by multi-agent flows when one agent sends a message to another and the interaction must be visible in both history and rollout.

*Call graph*: calls 4 internal fn (persist_rollout_items, prepare_conversation_items_for_history, send_raw_response_items, to_model_input_item); 2 external calls (InterAgentCommunication, from_ref).


##### `Session::maybe_warn_on_server_model_mismatch`  (lines 2691–2728)

```
async fn maybe_warn_on_server_model_mismatch(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        server_model: String,
    ) -> bool
```

**Purpose**: Detects when the backend served a different model than the one requested and emits a reroute event plus a specific cyber-risk warning message. It currently treats mismatches as a high-risk-cyber fallback to `gpt-5.2` messaging.

**Data flow**: Compares normalized `server_model` against `turn_context.model_info.slug` → if equal logs info and returns `false`; otherwise logs a warning, builds a fixed warning message referencing trusted-access URLs, emits `EventMsg::ModelReroute` and `EventMsg::Warning` via `send_event`, and returns `true`.

**Call relations**: Used by model-response handling when the server reports the actual model used. It delegates user-visible notification to `send_event`.

*Call graph*: calls 1 internal fn (send_event); 5 external calls (format!, info!, ModelReroute, Warning, warn!).


##### `Session::emit_model_verification`  (lines 2730–2740)

```
async fn emit_model_verification(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        verifications: Vec<ModelVerification>,
    )
```

**Purpose**: Emits a `ModelVerificationEvent` containing model verification results for the current turn. It is a thin typed wrapper over `send_event`.

**Data flow**: Takes `verifications: Vec<ModelVerification>` → wraps them in `ModelVerificationEvent` and `EventMsg::ModelVerification` → sends via `send_event`.

**Call relations**: Called by model-response handling when verification metadata should be surfaced to clients.

*Call graph*: calls 1 internal fn (send_event); 1 external calls (ModelVerification).


##### `Session::emit_turn_moderation_metadata`  (lines 2742–2749)

```
async fn emit_turn_moderation_metadata(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
        metadata: TurnModerationMetadataEvent,
    )
```

**Purpose**: Emits moderation metadata for the current turn as a protocol event. It is a typed convenience wrapper.

**Data flow**: Takes `TurnModerationMetadataEvent` and sends it as `EventMsg::TurnModerationMetadata` via `send_event`.

**Call relations**: Used by moderation-aware turn execution paths.

*Call graph*: calls 1 internal fn (send_event); 1 external calls (TurnModerationMetadata).


##### `Session::replace_history`  (lines 2752–2759)

```
async fn replace_history(
        &self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
    )
```

**Purpose**: Test-only helper that replaces the entire in-memory conversation history and reference context item. It bypasses rollout persistence.

**Data flow**: Locks session state mutably and calls `state.replace_history(items, reference_context_item)`.

**Call relations**: Used only in tests to seed or rewrite session history directly.


##### `Session::replace_compacted_history`  (lines 2761–2782)

```
async fn replace_compacted_history(
        &self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
        compacted_item: CompactedItem,
    )
```

**Purpose**: Replaces in-memory history after compaction, persists the corresponding `Compacted` and optional `TurnContext` rollout items, and queues a compact-origin session-start hook source. It is the durable history-rewrite path for compaction.

**Data flow**: Locks session state to replace history and reference context item → persists `RolloutItem::Compacted(compacted_item)` and, when present, `RolloutItem::TurnContext(turn_context_item)` → re-locks state and queues `SessionStartSource::Compact`.

**Call relations**: Used by compaction flows that rewrite history mid-session and need both in-memory and persisted state to reflect the new compacted baseline.

*Call graph*: calls 1 internal fn (persist_rollout_items); 2 external calls (Compacted, TurnContext).


##### `Session::persist_rollout_response_items`  (lines 2784–2791)

```
async fn persist_rollout_response_items(&self, items: &[ResponseItem])
```

**Purpose**: Converts response items into rollout items and appends them to rollout storage. It is the response-item-specific persistence helper.

**Data flow**: Clones each `ResponseItem` into `RolloutItem::ResponseItem`, collects them into a vector, and passes that vector to `persist_rollout_items`.

**Call relations**: Called by `record_conversation_items` after history has been updated.

*Call graph*: calls 1 internal fn (persist_rollout_items); called by 1 (record_conversation_items); 1 external calls (iter).


##### `Session::enabled`  (lines 2793–2795)

```
fn enabled(&self, feature: Feature) -> bool
```

**Purpose**: Checks whether a feature is enabled in the session's managed feature set. It is the `Session`-level counterpart to `Codex::enabled`.

**Data flow**: Reads `self.features.enabled(feature)` → returns `bool`.

**Call relations**: Used throughout this module to gate prompt construction, image preparation, token-budget behavior, and other runtime features.


##### `Session::features`  (lines 2797–2799)

```
fn features(&self) -> ManagedFeatures
```

**Purpose**: Returns a clone of the session's `ManagedFeatures`. This exposes the full feature set rather than a single boolean check.

**Data flow**: Clones `self.features` and returns it.

**Call relations**: Used by callers that need to pass the feature set onward rather than query one feature at a time.


##### `Session::collaboration_mode`  (lines 2801–2804)

```
async fn collaboration_mode(&self) -> CollaborationMode
```

**Purpose**: Returns the current collaboration mode from session configuration. This is the thread-level collaboration setting visible to prompt builders and host APIs.

**Data flow**: Locks session state and clones `state.session_configuration.collaboration_mode`.

**Call relations**: Used by callers that need the current collaboration mode outside direct state access.


##### `Session::multi_agent_version`  (lines 2806–2808)

```
fn multi_agent_version(&self) -> Option<MultiAgentVersion>
```

**Purpose**: Returns the session's resolved multi-agent version if it has already been initialized. It reads from the once-initialized cell without forcing a default.

**Data flow**: Reads `self.multi_agent_version.get().copied()` → returns `Option<MultiAgentVersion>`.

**Call relations**: Used by `resolve_multi_agent_version_for_model` and other logic that wants to know whether the version has already been fixed.

*Call graph*: called by 1 (resolve_multi_agent_version_for_model).


##### `Session::set_multi_agent_version_if_unset`  (lines 2810–2815)

```
fn set_multi_agent_version_if_unset(
        &self,
        multi_agent_version: MultiAgentVersion,
    ) -> MultiAgentVersion
```

**Purpose**: Initializes the session's multi-agent version once and returns the stored value. Repeated calls preserve the first chosen version.

**Data flow**: Calls `self.multi_agent_version.get_or_init(|| multi_agent_version)` and dereferences the stored value → returns `MultiAgentVersion`.

**Call relations**: Used by `resolve_multi_agent_version_for_model` to freeze the chosen version the first time model/config data is consulted.

*Call graph*: called by 1 (resolve_multi_agent_version_for_model).


##### `Session::resolve_multi_agent_version_for_model`  (lines 2817–2831)

```
fn resolve_multi_agent_version_for_model(
        &self,
        model_info: &ModelInfo,
        config: &Config,
    ) -> MultiAgentVersion
```

**Purpose**: Determines the effective multi-agent version for the session using an already-fixed value if present, otherwise the model's preferred version or the config-derived default. It also stores the chosen value for future calls.

**Data flow**: Checks `self.multi_agent_version()` → if set returns it; otherwise reads `model_info.multi_agent_version` or falls back to `config.multi_agent_version_from_features()`, stores it with `set_multi_agent_version_if_unset`, and returns it.

**Call relations**: Used when model selection influences multi-agent behavior and the session needs a stable resolved version.

*Call graph*: calls 2 internal fn (multi_agent_version, set_multi_agent_version_if_unset).


##### `Session::send_raw_response_items`  (lines 2833–2841)

```
async fn send_raw_response_items(&self, turn_context: &TurnContext, items: &[ResponseItem])
```

**Purpose**: Emits each response item as a `RawResponseItemEvent` for clients observing low-level conversation content. It does not mutate history or rollout itself.

**Data flow**: Iterates `items`, clones each into `RawResponseItemEvent { item }`, wraps it in `EventMsg::RawResponseItem`, and sends it via `send_event`.

**Call relations**: Called after conversation items or inter-agent communications have already been recorded and persisted.

*Call graph*: calls 1 internal fn (send_event); called by 2 (record_conversation_items, record_inter_agent_communication); 1 external calls (RawResponseItem).


##### `Session::build_initial_context`  (lines 2843–3077)

```
async fn build_initial_context(
        &self,
        turn_context: &TurnContext,
    ) -> Vec<ResponseItem>
```

**Purpose**: Constructs the full set of model-visible initial context messages for a turn, combining developer and contextual-user sections from permissions, collaboration mode, realtime state, personality, apps/connectors, skills, plugins, extension contributors, user instructions, token-budget metadata, environment context, and guardian/multi-agent special cases. It is the main prompt assembly function for session context.

**Data flow**: Reads from session state the reference context item, previous-turn settings, collaboration mode, base instructions, session source, and auto-compact window id → incrementally builds `developer_sections`, `contextual_user_sections`, and `separate_developer_sections` using helpers such as model-switch updates, `PermissionsInstructions`, collaboration-mode instructions, realtime updates, personality instructions, connector/app instructions from the MCP connection manager, available skills rendering, plugin capability summaries, extension context contributors, user instructions, token-budget context, and environment context with subagent info → optionally emits a warning event immediately if skill rendering produced a warning → converts the accumulated sections into `ResponseItem`s using context-manager update builders, preserving guardian policy as a separate developer message when required, and returns the resulting vector.

**Call relations**: Called when a turn needs full context injection: at first real turn, after context-window rollover, and when rebuilding replacement history. Steady-state turns use `build_settings_update_items` instead.

*Call graph*: calls 19 internal fn (list_accessible_and_enabled_connectors_from_manager, from_connectors, from_plugins, from, from_collaboration_mode, from_turn_context, new, new, build_contextual_user_message, build_developer_update_item (+9 more)); called by 2 (maybe_start_new_context_window, record_context_updates_and_set_reference_context_item); 9 external calls (new, new, with_capacity, with_capacity, build_available_skills, default_skill_metadata_budget, is_guardian_reviewer_source, Warning, vec!).


##### `Session::persist_rollout_items`  (lines 3079–3085)

```
async fn persist_rollout_items(&self, items: &[RolloutItem])
```

**Purpose**: Appends rollout items to the live thread if persistence is enabled, logging any append failure. It is the common low-level persistence sink for events, response items, compaction markers, and context snapshots.

**Data flow**: Checks `live_thread()` → if present awaits `live_thread.append_items(items)` and logs an error on failure; if absent does nothing.

**Call relations**: Called by many higher-level helpers including event emission, conversation recording, compaction, initial-history seeding, and context snapshot persistence.

*Call graph*: calls 1 internal fn (live_thread); called by 7 (maybe_start_new_context_window, persist_rollout_response_items, record_context_updates_and_set_reference_context_item, record_initial_history, record_inter_agent_communication, replace_compacted_history, send_event_raw); 1 external calls (error!).


##### `Session::clone_history`  (lines 3087–3090)

```
async fn clone_history(&self) -> ContextManager
```

**Purpose**: Returns a cloned `ContextManager` representing the current in-memory conversation history. This allows token estimation and reconstruction work without holding the state lock.

**Data flow**: Locks session state and returns `state.clone_history()`.

**Call relations**: Used by rollout reconstruction and token recomputation.

*Call graph*: called by 2 (apply_rollout_reconstruction, recompute_token_usage).


##### `Session::current_window_id`  (lines 3092–3097)

```
async fn current_window_id(&self) -> String
```

**Purpose**: Formats the current auto-compact window identifier as `<thread_id>:<window_id>`. This produces a stable external identifier for the active context window.

**Data flow**: Locks session state to read `auto_compact_window_id`, combines it with `self.thread_id`, formats the string, and returns it.

**Call relations**: Used by token-budget/context metadata and diagnostics that need a globally unique window id.

*Call graph*: 1 external calls (format!).


##### `Session::advance_auto_compact_window_id`  (lines 3099–3102)

```
async fn advance_auto_compact_window_id(&self) -> u64
```

**Purpose**: Advances and returns the session's auto-compact window counter. This mutates the compaction window state in memory.

**Data flow**: Locks session state mutably and returns `state.advance_auto_compact_window_id()`.

**Call relations**: Used by compaction/window-management logic when a new context window should be created.


##### `Session::request_new_context_window`  (lines 3104–3107)

```
async fn request_new_context_window(&self)
```

**Purpose**: Marks in session state that a new context window should be started at the next appropriate opportunity. It does not itself rebuild history.

**Data flow**: Locks session state mutably and calls `state.request_new_context_window()`.

**Call relations**: Used by compaction heuristics or token-budget logic that decide a rollover is needed.


##### `Session::maybe_start_new_context_window`  (lines 3109–3140)

```
async fn maybe_start_new_context_window(
        &self,
        turn_context: &TurnContext,
    ) -> Option<u64>
```

**Purpose**: If a new context window has been requested, rebuilds history to contain only fresh initial context, persists a `Compacted` marker and new `TurnContext`, queues compact-origin hooks, and recomputes token usage. If no rollover was requested, it does nothing.

**Data flow**: Locks session state to `start_new_context_window_if_requested()` and returns `None` if absent → otherwise builds fresh initial context with `build_initial_context`, converts the current turn context into a `TurnContextItem`, replaces in-memory history with the new context items and reference context, persists `RolloutItem::Compacted` with the replacement history and window id plus `RolloutItem::TurnContext`, queues `SessionStartSource::Compact`, recomputes token usage, and returns `Some(window_id)`.

**Call relations**: Called by turn execution paths when compaction/window rollover should happen before continuing.

*Call graph*: calls 4 internal fn (build_initial_context, persist_rollout_items, recompute_token_usage, to_turn_context_item); 3 external calls (new, Compacted, TurnContext).


##### `Session::reference_context_item`  (lines 3142–3145)

```
async fn reference_context_item(&self) -> Option<TurnContextItem>
```

**Purpose**: Returns the current reference `TurnContextItem` baseline used for context diffing. This is the durable/in-memory snapshot of the last full context state.

**Data flow**: Locks session state and returns `state.reference_context_item()`.

**Call relations**: Used by context update logic and resume/reconstruction paths.


##### `Session::record_context_updates_and_set_reference_context_item`  (lines 3161–3191)

```
async fn record_context_updates_and_set_reference_context_item(
        &self,
        turn_context: &TurnContext,
    )
```

**Purpose**: Persists the latest turn context snapshot and emits either full initial context or incremental settings-diff items depending on whether a reference context baseline already exists. It then advances the in-memory reference baseline to the current turn.

**Data flow**: Reads the current `reference_context_item` from state → if absent, builds full initial context with `build_initial_context`; otherwise builds diff items with `build_settings_update_items`; converts the current turn into a `TurnContextItem`; records any non-empty context items via `record_conversation_items`; persists the `TurnContextItem` as a rollout item even if no visible context items were emitted; finally locks state and sets the new reference context item.

**Call relations**: This is the normal per-turn context persistence path. It is called on real user turns to keep resume/lazy replay and future diffing aligned.

*Call graph*: calls 5 internal fn (build_initial_context, build_settings_update_items, persist_rollout_items, record_conversation_items, to_turn_context_item); 1 external calls (TurnContext).


##### `Session::update_token_usage_info`  (lines 3193–3201)

```
async fn update_token_usage_info(
        &self,
        turn_context: &TurnContext,
        token_usage: Option<&TokenUsage>,
    )
```

**Purpose**: Updates cached token usage information from a new usage snapshot and immediately emits a `TokenCount` event. It is the high-level token-update entry point.

**Data flow**: Takes optional `TokenUsage` → awaits `record_token_usage_info(turn_context, token_usage)` and then `send_token_count_event(turn_context)`.

**Call relations**: Used by model-response handling when fresh token usage arrives from the backend.

*Call graph*: calls 2 internal fn (record_token_usage_info, send_token_count_event).


##### `Session::record_token_usage_info`  (lines 3203–3234)

```
async fn record_token_usage_info(
        &self,
        turn_context: &TurnContext,
        token_usage: Option<&TokenUsage>,
    )
```

**Purpose**: Merges a new token-usage snapshot into session state, updates auto-compact prefill bookkeeping when needed, and notifies extension token-usage contributors. It does not emit protocol events itself.

**Data flow**: If `token_usage` is `Some`, locks session state and calls `update_token_info_from_usage(token_usage, turn_context.model_context_window())`; when the token-limit scope is `BodyAfterPrefix`, ensures server-prefill bookkeeping from usage; reads back `state.token_info()`; then for each extension token-usage contributor, asynchronously calls `on_token_usage` with session/thread/turn extension data and the updated token info.

**Call relations**: Called by `update_token_usage_info` before the outward-facing token-count event is sent.

*Call graph*: calls 1 internal fn (model_context_window); called by 1 (update_token_usage_info); 1 external calls (matches!).


##### `Session::recompute_token_usage`  (lines 3236–3272)

```
async fn recompute_token_usage(&self, turn_context: &TurnContext)
```

**Purpose**: Re-estimates token usage from the current in-memory history and base instructions, stores the estimate as the last-token-usage total, updates auto-compact prefill bookkeeping, and emits a token-count event. This is used when no fresh server usage exists after history rewrites.

**Data flow**: Clones history and base instructions, estimates total tokens with `estimate_token_count_with_base_instructions`, returns early if unavailable; otherwise locks session state, creates or updates `TokenUsageInfo` so `last_token_usage.total_tokens` equals the estimate and `model_context_window` is refreshed from the turn context, stores it, updates auto-compact prefill via `set_auto_compact_window_estimated_prefill_for_scope`, and sends a token-count event.

**Call relations**: Called after starting a new context window so token displays remain coherent after compaction-driven history replacement.

*Call graph*: calls 5 internal fn (clone_history, get_base_instructions, send_token_count_event, set_auto_compact_window_estimated_prefill_for_scope, model_context_window); called by 1 (maybe_start_new_context_window); 1 external calls (default).


##### `Session::update_rate_limits`  (lines 3274–3281)

```
async fn update_rate_limits(
        &self,
        turn_context: &TurnContext,
        new_rate_limits: RateLimitSnapshot,
    )
```

**Purpose**: Stores a new rate-limit snapshot and emits an updated token-count event carrying both token and rate-limit info. It is the high-level rate-limit update path.

**Data flow**: Takes `new_rate_limits`, awaits `record_rate_limits_info(new_rate_limits)`, then `send_token_count_event(turn_context)`.

**Call relations**: Used by model/network response handling when backend rate-limit metadata changes.

*Call graph*: calls 2 internal fn (record_rate_limits_info, send_token_count_event).


##### `Session::record_rate_limits_info`  (lines 3283–3288)

```
async fn record_rate_limits_info(&self, new_rate_limits: RateLimitSnapshot)
```

**Purpose**: Writes the latest rate-limit snapshot into session state. It is the storage half of rate-limit updates.

**Data flow**: Locks session state mutably and calls `state.set_rate_limits(new_rate_limits)`.

**Call relations**: Called by `update_rate_limits` before the outward-facing event is emitted.

*Call graph*: called by 1 (update_rate_limits).


##### `Session::mcp_dependency_prompted`  (lines 3290–3293)

```
async fn mcp_dependency_prompted(&self) -> HashSet<String>
```

**Purpose**: Returns the set of MCP dependency names that have already been prompted to the user. This prevents duplicate prompting.

**Data flow**: Locks session state and returns `state.mcp_dependency_prompted()`.

**Call relations**: Used by MCP setup flows that need to know whether a dependency prompt has already been shown.


##### `Session::record_mcp_dependency_prompted`  (lines 3295–3301)

```
async fn record_mcp_dependency_prompted(&self, names: I)
```

**Purpose**: Adds one or more MCP dependency names to the set of already-prompted dependencies. This updates duplicate-prompt suppression state.

**Data flow**: Locks session state mutably and passes the provided iterator into `state.record_mcp_dependency_prompted(names)`.

**Call relations**: Used after prompting the user about MCP dependencies.


##### `Session::set_server_reasoning_included`  (lines 3303–3306)

```
async fn set_server_reasoning_included(&self, included: bool)
```

**Purpose**: Stores whether server reasoning tokens should be included in token accounting. This toggles how aggregate token usage is interpreted.

**Data flow**: Locks session state mutably and calls `state.set_server_reasoning_included(included)`.

**Call relations**: Used by response handling when the backend indicates whether reasoning tokens are included.


##### `Session::send_token_count_event`  (lines 3308–3315)

```
async fn send_token_count_event(&self, turn_context: &TurnContext)
```

**Purpose**: Emits the current combined token-usage and rate-limit snapshot as a `TokenCountEvent`. It is the outward-facing notification step for token/rate-limit changes.

**Data flow**: Locks session state to read `(info, rate_limits) = state.token_info_and_rate_limits()`, wraps them in `TokenCountEvent`, and sends `EventMsg::TokenCount` via `send_event`.

**Call relations**: Called after token usage updates, rate-limit updates, recomputation, and full-context-window saturation.

*Call graph*: calls 1 internal fn (send_event); called by 4 (recompute_token_usage, set_total_tokens_full, update_rate_limits, update_token_usage_info); 1 external calls (TokenCount).


##### `Session::set_total_tokens_full`  (lines 3317–3323)

```
async fn set_total_tokens_full(&self, turn_context: &TurnContext)
```

**Purpose**: Marks token usage as full for the current model context window and emits an updated token-count event. This is used when the context window is known to be saturated.

**Data flow**: If `turn_context.model_context_window()` is present, locks session state and calls `state.set_token_usage_full(context_window)`; then sends a token-count event.

**Call relations**: Used by compaction/token-budget logic when the session should be treated as having filled the available context.

*Call graph*: calls 2 internal fn (send_token_count_event, model_context_window).


##### `Session::record_response_item_and_emit_turn_item`  (lines 3325–3339)

```
async fn record_response_item_and_emit_turn_item(
        &self,
        turn_context: &TurnContext,
        response_item: ResponseItem,
    )
```

**Purpose**: Records a single response item into history/rollout and, if it can be parsed into a `TurnItem`, emits started/completed lifecycle events for that item. It bridges low-level response items to higher-level turn-item notifications.

**Data flow**: Takes ownership of `response_item`, records it via `record_conversation_items`, parses it with `parse_turn_item`, and when parsing succeeds emits `ItemStarted` then `ItemCompleted` for the derived `TurnItem`.

**Call relations**: Used by turn execution paths when a model/tool output item should both persist in history and appear as a structured turn item to clients.

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

**Purpose**: Records user input into history while preserving UI-only `text_elements` in the emitted `TurnItem::UserMessage`, then ensures the rollout file is materialized. It separates persisted model input from richer UI event payloads.

**Data flow**: Converts `input` into a persisted `ResponseItem` with `response_item_from_user_input`, records it via `record_conversation_items`, constructs `UserMessageItem::new(input)` and sets its `client_id`, wraps it as `TurnItem::UserMessage`, emits started/completed events for that turn item, and calls `ensure_rollout_materialized()`.

**Call relations**: Used when a real user prompt enters the session so both history and UI-facing turn-item streams stay accurate.

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

**Purpose**: Emits a `StreamErrorEvent` describing a response-stream failure, including structured `CodexErrorInfo` and the original error string. It is the protocol-facing wrapper for stream disconnects.

**Data flow**: Takes a user-facing message and `CodexErr` → derives `additional_details` from `codex_error.to_string()` and `CodexErrorInfo::ResponseStreamDisconnected { http_status_code }` from `http_status_code_value()`, builds `EventMsg::StreamError`, and sends it via `send_event`.

**Call relations**: Used by streaming response handlers when the backend stream fails mid-turn.

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

**Purpose**: Validates and injects additional user input into the currently active regular turn, optionally enforcing an expected turn id and merging additional context into session state. It rejects steering when there is no active turn, the wrong turn is active, the active task is review/compact, or the input is empty.

**Data flow**: Locks `active_turn` and checks that an active task exists; compares `expected_turn_id` against the active turn's `sub_id` when provided; rejects non-regular task kinds with `SteerInputError::ActiveTurnNotSteerable`; rejects empty input; merges `additional_context` into `state.additional_context`, optionally stores `responsesapi_client_metadata` into `turn_metadata_state`, converts merged additional-context entries into `TurnInput::ResponseItem`s, appends a final `TurnInput::UserInput { content, client_id }`, and passes the batch to `input_queue.extend_pending_input_and_accept_mailbox_delivery_for_turn_state(...)` → returns the active turn id.

**Call relations**: Called by `Codex::steer_input`. It is the core mid-turn steering implementation and interacts directly with active turn state and the input queue.

*Call graph*: 1 external calls (NoActiveTurn).


##### `Session::record_memory_citation_for_turn`  (lines 3461–3470)

```
async fn record_memory_citation_for_turn(&self, sub_id: &str)
```

**Purpose**: Marks the active turn state as having produced a memory citation for a given submission id. This is a small per-turn bookkeeping update.

**Data flow**: Uses `input_queue.turn_state_for_sub_id(&self.active_turn, sub_id)` to find the matching turn state; if found, locks it and sets `has_memory_citation = true`.

**Call relations**: Used by memory/citation handling paths that need to annotate the active turn after a citation is emitted.


##### `Session::interrupt_task`  (lines 3472–3479)

```
async fn interrupt_task(self: &Arc<Self>)
```

**Purpose**: Interrupts the current active task, aborting all running turn work with `TurnAbortReason::Interrupted`, and cancels MCP startup if there was no active turn to abort. It is the session-level interrupt handler.

**Data flow**: Logs receipt of interrupt, checks whether `active_turn` is present, awaits `abort_all_tasks(TurnAbortReason::Interrupted)`, and if there had been no active turn awaits `cancel_mcp_startup()`.

**Call relations**: Used by external interrupt flows. It coordinates task abortion and startup cancellation depending on current session activity.

*Call graph*: 1 external calls (info!).


##### `Session::hooks`  (lines 3481–3483)

```
fn hooks(&self) -> Arc<Hooks>
```

**Purpose**: Returns the current hook engine for the session. This exposes the live `Hooks` object built from config and plugins.

**Data flow**: Loads and clones the full `Arc<Hooks>` from `services.hooks`.

**Call relations**: Used by hook execution paths that need the current hook configuration.


##### `Session::user_shell`  (lines 3485–3487)

```
fn user_shell(&self) -> Arc<shell::Shell>
```

**Purpose**: Returns the session's configured user shell object. This shell is used when building environment context and settings diffs.

**Data flow**: Clones `Arc<shell::Shell>` from `services.user_shell` and returns it.

**Call relations**: Called by `build_initial_context` and `build_settings_update_items`, and by other shell-aware runtime logic.

*Call graph*: called by 2 (build_initial_context, build_settings_update_items); 1 external calls (clone).


##### `Session::current_rollout_path`  (lines 3489–3494)

```
async fn current_rollout_path(&self) -> anyhow::Result<Option<PathBuf>>
```

**Purpose**: Returns the local filesystem path of the live rollout file when persistence is enabled. If there is no live thread, it returns `Ok(None)`.

**Data flow**: Checks `live_thread()` → if absent returns `Ok(None)`; otherwise awaits `live_thread.local_rollout_path()` and maps its error into `anyhow::Error`.

**Call relations**: Used by `hook_transcript_path` and other diagnostics that need the actual rollout file path.

*Call graph*: calls 1 internal fn (live_thread); called by 1 (hook_transcript_path).


##### `Session::hook_transcript_path`  (lines 3496–3505)

```
async fn hook_transcript_path(&self) -> Option<PathBuf>
```

**Purpose**: Best-effort accessor for the rollout transcript path suitable for hooks, ensuring the rollout is materialized first. Errors are logged and converted to `None`.

**Data flow**: Awaits `ensure_rollout_materialized()`, then `current_rollout_path()`; returns the path on success or logs a warning and returns `None` on error.

**Call relations**: Used by hook-related code that wants a transcript path but should not fail the session if persistence lookup fails.

*Call graph*: calls 2 internal fn (current_rollout_path, ensure_rollout_materialized); 1 external calls (warn!).


##### `Session::take_pending_session_start_source`  (lines 3507–3512)

```
async fn take_pending_session_start_source(
        &self,
    ) -> Option<codex_hooks::SessionStartSource>
```

**Purpose**: Removes and returns any queued session-start hook source from session state. This is a one-shot consumption API for hook triggering.

**Data flow**: Locks session state mutably and returns `state.take_pending_session_start_source()`.

**Call relations**: Used by hook orchestration to determine why a session-start-like hook should run next.


##### `Session::show_raw_agent_reasoning`  (lines 3514–3516)

```
fn show_raw_agent_reasoning(&self) -> bool
```

**Purpose**: Returns whether raw agent reasoning should be exposed in legacy event expansion. It is a simple session-level flag accessor.

**Data flow**: Reads `self.services.show_raw_agent_reasoning` and returns the boolean.

**Call relations**: Used by `send_event` when deciding how to expand modern events into legacy compatibility events.

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

**Purpose**: Emits analytics for a newly started subagent thread, including inherited app-server client metadata, thread lineage, model, and creation timestamp. It skips emission when client metadata is missing.

**Data flow**: Takes analytics client, `AppServerClientMetadata`, session/thread ids, optional parent thread id, `ThreadConfigSnapshot`, and `SubAgentSource` → extracts client name/version, warns and returns if either is missing, computes `created_at` from system time, builds `SubAgentThreadStartedInput` with lineage and config fields, and calls `track_subagent_thread_started`.

**Call relations**: Called by interactive thread startup code after a subagent session has been created and inherited metadata is available.

*Call graph*: calls 1 internal fn (track_subagent_thread_started); called by 1 (run_codex_thread_interactive); 4 external calls (now, to_string, to_string, warn!).


##### `build_hooks_for_config`  (lines 3558–3586)

```
async fn build_hooks_for_config(
    config: &Config,
    plugins_manager: &PluginsManager,
    environment: Option<&TurnEnvironment>,
) -> Hooks
```

**Purpose**: Builds a `Hooks` engine for a specific config snapshot, including shell execution settings and plugin-provided hook sources/warnings. It is the hook-construction helper used during runtime config refresh.

**Data flow**: Takes `config`, `plugins_manager`, and optional `TurnEnvironment` → derives `shell_program` and `shell_args` from the environment shell when present, loads plugins for `config.plugins_config_input()`, extracts effective plugin hook sources and warnings, and constructs `Hooks::new(HooksConfig { legacy_notify_argv, feature_enabled, bypass_hook_trust, config_layer_stack, plugin_hook_sources, plugin_hook_load_warnings, shell_program, shell_args })`.

**Call relations**: Called by `Session::refresh_runtime_config` after config reload so the live hook engine matches the refreshed config and plugin set.

*Call graph*: calls 2 internal fn (plugins_for_config, new); called by 1 (refresh_runtime_config); 1 external calls (plugins_config_input).


### `core/src/session/session.rs`

`orchestration` · `startup, then referenced throughout request/turn handling as the live session container`

This file centers on two concrete types: `Session`, the live runtime container for a single thread, and `SessionConfiguration`, the cloned-and-updated configuration snapshot that feeds both startup and later turn execution. `Session` stores identity (`thread_id`, installation id), event channels, watched agent status, guarded mutable state, active turn tracking, input queuing, feature flags, service bundle, and synchronization primitives such as the managed network proxy refresh semaphore and `OnceLock<MultiAgentVersion>`. `SessionConfiguration` carries model/provider choices, instruction text, approval and permission settings, environment selections, workspace roots, thread lineage metadata, dynamic tools, and client metadata.

The configuration methods are intentionally narrow accessors plus two important transformers: `thread_config_snapshot`, which exports a stable thread-level snapshot, and `apply`, which merges a `SessionSettingsUpdate` while preserving permission invariants. The update path is careful about legacy sandbox-policy compatibility, semantic equivalence of filesystem policies, rebinding project-root write permissions when cwd changes, and keeping active permission-profile metadata synchronized with the underlying runtime permissions.

`Session::new` is the orchestration-heavy constructor. It derives fork/parent lineage from history, starts independent async setup tasks in parallel (thread persistence, local state DB lookup, auth+MCP config), then builds telemetry, shell/environment state, AGENTS.md instructions, plugin/skill warmup, config-lock validation, optional managed network proxying, hooks, analytics, extension stores, MCP connection management, and the `SessionServices` bundle. Only after the `Session` exists does it wire weak references for network-policy callbacks, emit `SessionConfigured` plus startup warnings/deprecations, initialize MCP connections, prewarm startup resources, and record initial history. A `LiveThreadInitGuard` ensures persistence is committed only on successful construction and discarded on failure.

#### Function details

##### `SessionConfiguration::cwd`  (lines 113–115)

```
fn cwd(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the session thread's legacy fallback working directory from the stored environment selections. This is the canonical cwd used when no per-turn environment overrides are selected.

**Data flow**: Reads `self.environments.legacy_fallback_cwd` and returns it by shared reference as `&AbsolutePathBuf`; it does not clone or mutate state.

**Call relations**: Used by startup and configuration-building paths whenever code needs a stable thread cwd, including session initialization, sandbox derivation, and configuration projection logic.

*Call graph*: called by 4 (new, apply, sandbox_policy, build_effective_session_config).


##### `SessionConfiguration::environment_selections`  (lines 117–119)

```
fn environment_selections(&self) -> &[TurnEnvironmentSelection]
```

**Purpose**: Exposes the configured sticky thread-level environment selections as a slice. It gives callers the exact list that should be applied to `ThreadEnvironments` or inspected for environment resolution.

**Data flow**: Reads `self.environments.environments` and returns `&[TurnEnvironmentSelection]` without allocation or mutation.

**Call relations**: Called during session startup when `Session::new` applies environment selections to the runtime environment manager, and by environment-resolution helpers that need the thread's selected environments.

*Call graph*: called by 2 (new, resolved_environments_for_configuration).


##### `SessionConfiguration::codex_home`  (lines 121–123)

```
fn codex_home(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the configured Codex state directory for the session. This is the thread/session-scoped home used by downstream startup components.

**Data flow**: Reads `self.codex_home` and returns a shared reference to the `AbsolutePathBuf`.

**Call relations**: A simple accessor for callers that need the session's state root; it does not participate in internal control flow beyond exposing stored configuration.


##### `SessionConfiguration::permission_profile_state`  (lines 125–127)

```
fn permission_profile_state(&self) -> &PermissionProfileState
```

**Purpose**: Provides read-only access to the full permission-profile state object, including constrained profile data and active-profile metadata. It exists so callers can inspect the synchronized permission state without reaching into fields directly.

**Data flow**: Returns `&PermissionProfileState` from `self.permission_profile_state` with no transformation.

**Call relations**: Used by startup code that needs the raw permission-profile state rather than the materialized runtime profile.


##### `SessionConfiguration::permission_profile`  (lines 129–134)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Builds the effective runtime `PermissionProfile` for the session by cloning the stored profile and materializing symbolic project-root permissions against the current `workspace_roots`. This is the profile most runtime consumers should use.

**Data flow**: Reads `self.permission_profile_state.permission_profile()`, clones that profile, then applies `materialize_project_roots_with_workspace_roots(&self.workspace_roots)` to produce a concrete `PermissionProfile` value.

**Call relations**: This is a central adapter used by startup, turn-context construction, sandbox-policy derivation, and thread snapshot export whenever code needs concrete runtime permissions instead of the raw stored snapshot.

*Call graph*: calls 1 internal fn (permission_profile); called by 7 (new, file_system_sandbox_policy, sandbox_policy, thread_config_snapshot, build_per_turn_config, make_turn_context, new_turn_context_from_configuration).


##### `SessionConfiguration::active_permission_profile`  (lines 136–138)

```
fn active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the optional active named permission-profile selection associated with the session. It distinguishes legacy inline permissions from a selected configured profile.

**Data flow**: Reads `self.permission_profile_state.active_permission_profile()` and returns the resulting `Option<ActivePermissionProfile>`.

**Call relations**: Consulted when exporting thread snapshots and when session startup emits the configured session metadata to clients.

*Call graph*: calls 1 internal fn (active_permission_profile); called by 2 (new, thread_config_snapshot).


##### `SessionConfiguration::profile_workspace_roots`  (lines 140–142)

```
fn profile_workspace_roots(&self) -> &[AbsolutePathBuf]
```

**Purpose**: Returns the workspace roots that came from the selected permission profile snapshot rather than the runtime thread workspace roots. This preserves the distinction between profile-defined roots and thread-scoped materialization roots.

**Data flow**: Reads `self.permission_profile_state.profile_workspace_roots()` and returns the borrowed slice.

**Call relations**: Used when constructing `ThreadConfigSnapshot` so persisted/exported thread config includes both runtime workspace roots and profile-origin workspace roots.

*Call graph*: calls 1 internal fn (profile_workspace_roots); called by 1 (thread_config_snapshot).


##### `SessionConfiguration::apply_permission_profile_to_permissions`  (lines 144–149)

```
fn apply_permission_profile_to_permissions(
        &self,
        permissions: &mut crate::config::Permissions,
    )
```

**Purpose**: Copies the session's synchronized permission-profile state into a mutable `Permissions` config object. It is the bridge from session configuration back into lower-level config structures used elsewhere.

**Data flow**: Takes `&mut crate::config::Permissions`, clones `self.permission_profile_state`, and writes it into the target via `set_permission_profile_state`.

**Call relations**: Invoked by per-turn config builders that need a `Permissions` object aligned with the session's current permission-profile snapshot.

*Call graph*: calls 1 internal fn (set_permission_profile_state); called by 1 (build_per_turn_config); 1 external calls (clone).


##### `SessionConfiguration::set_permission_profile_for_tests`  (lines 152–158)

```
fn set_permission_profile_for_tests(
        &mut self,
        permission_profile: PermissionProfile,
    ) -> ConstraintResult<()>
```

**Purpose**: Test-only helper that replaces the legacy permission profile inside the session configuration. It exists to let tests inject a profile without going through the full update machinery.

**Data flow**: Consumes a `PermissionProfile`, forwards it to `self.permission_profile_state.set_legacy_permission_profile`, and returns the resulting `ConstraintResult<()>`.

**Call relations**: Compiled only in tests and used by test setup paths to mutate permission state directly.

*Call graph*: calls 1 internal fn (set_legacy_permission_profile).


##### `SessionConfiguration::sandbox_policy`  (lines 160–166)

```
fn sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Derives the legacy-compatible aggregate `SandboxPolicy` from the effective permission profile and current cwd. This preserves compatibility with code paths that still consume the older sandbox abstraction.

**Data flow**: Reads the materialized permission profile via `permission_profile()`, reads cwd via `cwd()`, and passes both into `codex_sandboxing::compatibility_sandbox_policy_for_permission_profile`, returning the computed `SandboxPolicy`.

**Call relations**: Used primarily by configuration-update logic to compare old and new sandbox semantics and by startup metadata emission that reports the session sandbox policy.

*Call graph*: calls 2 internal fn (cwd, permission_profile); called by 1 (apply); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `SessionConfiguration::file_system_sandbox_policy`  (lines 168–170)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Extracts the filesystem-specific sandbox policy from the effective permission profile. It gives callers the richer split filesystem policy rather than the legacy combined sandbox view.

**Data flow**: Calls `permission_profile()` and returns `permission_profile.file_system_sandbox_policy()`.

**Call relations**: Consumed by `SessionConfiguration::apply` when deciding how to preserve deny rules and how cwd changes should affect filesystem permissions.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (apply).


##### `SessionConfiguration::network_sandbox_policy`  (lines 172–176)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Extracts the network-specific sandbox policy from the stored permission profile state. Unlike filesystem policy, this reads from the underlying profile snapshot directly.

**Data flow**: Reads `self.permission_profile_state.permission_profile()` and returns its `network_sandbox_policy()`.

**Call relations**: Used by `SessionConfiguration::apply` to preserve or rebuild network permissions while processing settings updates.

*Call graph*: calls 1 internal fn (permission_profile); called by 1 (apply).


##### `SessionConfiguration::thread_config_snapshot`  (lines 178–200)

```
fn thread_config_snapshot(&self) -> ThreadConfigSnapshot
```

**Purpose**: Builds a `ThreadConfigSnapshot` capturing the thread-level configuration that should be persisted or exposed externally. The snapshot includes model/provider identity, approval and permission settings, environment selections, workspace roots, reasoning settings, and thread lineage/source metadata.

**Data flow**: Reads many fields from `self`, including collaboration mode, original config provider id, service tier, approval settings, materialized permission profile, active profile, environment selections, workspace roots, profile workspace roots, ephemeral flag, reasoning settings, personality, and thread source/parent/fork metadata; it packages them into a new `ThreadConfigSnapshot` value.

**Call relations**: Acts as the export point from mutable session configuration into a stable thread snapshot consumed by persistence or higher-level orchestration.

*Call graph*: calls 6 internal fn (value, active_permission_profile, permission_profile, profile_workspace_roots, model, reasoning_effort); 3 external calls (clone, clone, clone).


##### `SessionConfiguration::apply`  (lines 202–374)

```
fn apply(&self, updates: &SessionSettingsUpdate) -> ConstraintResult<Self>
```

**Purpose**: Merges a `SessionSettingsUpdate` into a cloned configuration while enforcing permission/profile consistency and preserving important sandbox semantics across cwd and profile changes. It is the main mutation engine for thread settings updates.

**Data flow**: Starts from `self.clone()` as `next_configuration`, computes current legacy, filesystem, and network sandbox policies, and derives compatibility facts such as whether the filesystem policy matches the legacy projection and whether project-root write permissions are rebindable. It then conditionally applies updates for collaboration mode, reasoning summary, service tier normalization, personality, approval settings, Windows sandbox level, environments, and workspace roots. For permission changes, it either projects a new `PermissionProfile` plus optional active profile through `set_permission_profile_projection`, translates a legacy `sandbox_policy` into a legacy permission profile, or, on cwd-only changes, rebinds legacy-compatible project-root filesystem permissions. If an active permission profile is selected, it also clones and rewrites `original_config_do_not_use.permissions` so network proxy config matches the active profile. Finally it updates app-server client metadata and returns the new configuration or a `ConstraintError` on invalid constrained values.

**Call relations**: This function is the core of runtime settings reconfiguration. It is called by higher-level session update flows, and internally delegates permission-profile snapshot construction to `set_permission_profile_projection` and several sandbox conversion helpers to preserve backward compatibility.

*Call graph*: calls 10 internal fn (active, cwd, file_system_sandbox_policy, network_sandbox_policy, sandbox_policy, from_request_value, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_preserving_deny_entries, from); 2 external calls (new, with_capacity).


##### `SessionConfiguration::set_permission_profile_projection`  (lines 376–410)

```
fn set_permission_profile_projection(
        &mut self,
        permission_profile: PermissionProfile,
        active_permission_profile: Option<ActivePermissionProfile>,
        profile_workspace_ro
```

**Purpose**: Installs a permission profile into `permission_profile_state` by converting it to runtime permissions, optionally preserving deny-read restrictions from an existing filesystem policy, and wrapping it as either an active-profile or legacy snapshot. This keeps the stored snapshot aligned with the effective runtime permissions.

**Data flow**: Takes a `PermissionProfile`, optional `ActivePermissionProfile`, profile workspace roots, and an optional existing `FileSystemSandboxPolicy`. It reads the profile's enforcement mode, converts the profile to runtime filesystem and network policies, optionally merges deny-read restrictions from the existing filesystem policy, reconstructs an effective `PermissionProfile` from those runtime permissions, wraps it in either `PermissionProfileSnapshot::active_with_profile_workspace_roots` or `PermissionProfileSnapshot::legacy`, and writes it into `self.permission_profile_state` via `set_permission_profile_snapshot`.

**Call relations**: Used exclusively by `SessionConfiguration::apply` when a caller supplies a new permission profile. It encapsulates the tricky snapshot/projection logic so the update path can preserve deny rules and active-profile metadata consistently.

*Call graph*: calls 6 internal fn (active_with_profile_workspace_roots, legacy, set_permission_profile_snapshot, enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions).


##### `warm_plugins_and_skills_for_session_init`  (lines 438–453)

```
async fn warm_plugins_and_skills_for_session_init(
    config: Arc<Config>,
    plugins_manager: Arc<PluginsManager>,
    skills_manager: Arc<SkillsManager>,
    turn_environments: &TurnEnvironmentSna
```

**Purpose**: Preloads plugin-derived skill roots and then loads skills for the session's primary filesystem, returning any skill-loading errors. It is a startup latency optimization and validation step rather than a persistent runtime service.

**Data flow**: Accepts shared `Config`, `PluginsManager`, `SkillsManager`, and a `TurnEnvironmentSnapshot`. It reads the primary filesystem from the environment snapshot, derives plugin config input from `Config`, awaits `plugins_for_config`, extracts effective plugin skill roots, builds a skills load input from config plus those roots, awaits `skills_for_config`, and returns the resulting `errors` vector.

**Call relations**: Called during `Session::new` after environments and project instructions are resolved. Its output is logged as startup errors but does not abort session creation.

*Call graph*: calls 1 internal fn (primary_filesystem); called by 1 (new).


##### `Session::thread_id`  (lines 457–459)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the concrete thread identifier for this live session. This is the per-thread identity, not the root session lineage id.

**Data flow**: Reads `self.thread_id` and returns it by value.

**Call relations**: A simple accessor used by callers that need the thread's concrete identity from an already-initialized `Session`.


##### `Session::session_id`  (lines 462–464)

```
fn session_id(&self) -> SessionId
```

**Purpose**: Returns the root/shared session identifier used across the root thread and descendant threads. It delegates to the installed agent-control service rather than deriving from `thread_id` directly.

**Data flow**: Reads `self.services.agent_control` and returns `agent_control.session_id()`.

**Call relations**: Used by callers that need the lineage-wide session id; this accessor reflects the session id chosen during `Session::new`, including sub-agent inheritance.


##### `Session::new`  (lines 468–1192)

```
async fn new(
        mut session_configuration: SessionConfiguration,
        config: Arc<Config>,
        user_instructions: Option<codex_extension_api::UserInstructions>,
        installation_id: S
```

**Purpose**: Constructs a fully initialized `Arc<Session>` by combining configuration, history, persistence, auth, telemetry, environments, permissions, hooks, MCP, network proxying, extensions, and startup event emission. It is the master startup routine for a live thread.

**Data flow**: Consumes a large set of startup inputs: mutable `SessionConfiguration`, shared `Config`, optional user instructions, installation/auth/model/exec managers, event channels, initial history, source metadata, plugin/skill/MCP/environment managers, extension init data, agent control, analytics client, thread store, trace context, attestation provider, and optional multi-agent version. It first derives fork/parent thread ids from history, chooses or resumes `thread_id`, creates extension data stores, and launches three independent async tasks in parallel: thread persistence initialization, local state DB lookup, and auth+MCP runtime config/auth-status computation. After joining them, it wraps persistence in `LiveThreadInitGuard` and performs the main initialization sequence: trace metadata creation; startup warning/deprecation event collection; telemetry and network-proxy audit metadata setup; shell selection and optional `ShellSnapshot`; `ThreadEnvironments` creation and selection application; AGENTS.md loading; plugin/skill warmup; thread-name lookup; config-lock validation/export; `SessionState` creation; optional managed-network approval/proxy setup; hook construction; analytics client fallback; session-id selection and agent-control rebinding; MCP connection-manager placeholder creation; extension lifecycle callbacks; `SessionServices` assembly; `Session` allocation; weak-session wiring for network policy callbacks; emission of `SessionConfigured` and queued startup events; full MCP connection-manager initialization and installation; startup prewarm scheduling; initial-history recording; and queuing of session-start source in state. On success it commits thread persistence; on failure it discards it and returns the error.

**Call relations**: This is invoked by higher-level session creation paths such as internal spawning and test helpers. Internally it orchestrates nearly every startup subsystem, delegating specialized work to persistence constructors, telemetry builders, environment loaders, plugin/skill warmup, network proxy startup, hook builders, MCP manager creation, and history recording in a carefully ordered sequence where `SessionConfigured` is emitted before later startup side effects that may themselves emit events.

*Call graph*: calls 34 internal fn (new, new, new_uninitialized_with_permission_profile, new, new, session_id, with_session_id, new, new, new (+15 more)); called by 4 (spawn_internal, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh); 39 external calls (clone, downgrade, new, new, pin, new, default, default, default, new (+15 more)).


### `core/src/session/input_queue.rs`

`data_model` · `request handling`

This module introduces two core enums and two queue structs. `TurnInput` is the normalized pending-input type used by turn execution, with variants for direct user input, arbitrary `ResponseItem`s, and `InterAgentCommunication`. `InputQueueActivity` is a small watch-channel signal used to wake listeners for either mailbox or steer activity. `TurnInputQueue` is a simple per-turn `Vec<TurnInput>` wrapper, while `InputQueue` owns a `watch::Sender<InputQueueActivity>` and a mutex-protected `VecDeque<InterAgentCommunication>` for session-wide mailbox messages. `InputQueue::new` initializes the watch channel with `Mailbox` as the baseline state. `subscribe_activity` returns a receiver plus an immediate pending-activity hint by checking whether the provided turn state already contains user input and, if not, whether mailbox items are queued. Mailbox methods enqueue, inspect, and drain communications in FIFO order, with a separate predicate for whether any queued mail has `trigger_turn = true`. Several helpers locate the active turn state by submission id and then mutate mailbox-delivery phase: delivery can be deferred to the next turn, explicitly accepted for the current turn, or accepted while extending pending input and notifying watchers of steer activity. `get_pending_input` atomically extracts turn-local pending input and consults the turn’s mailbox-delivery flag before optionally draining mailbox items and appending them after existing turn input. `has_pending_input` mirrors that logic without consuming anything. The tests verify watch notifications, pending-activity detection, FIFO mailbox draining, and trigger-turn tracking.

#### Function details

##### `InputQueue::new`  (lines 41–47)

```
fn new() -> Self
```

**Purpose**: Constructs an empty input queue with mailbox activity as the initial watch-channel state.

**Data flow**: Creates a `watch::channel(InputQueueActivity::Mailbox)`, discards the initial receiver, initializes `mailbox_pending_mails` with an empty `VecDeque`, and returns the new `InputQueue`.

**Call relations**: Used by session construction and tests. It establishes the queue’s internal synchronization primitives and default activity signal.

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

**Purpose**: Returns a watch receiver for future queue activity plus an immediate hint about already pending steer or mailbox work.

**Data flow**: Subscribes to `activity_tx`, optionally locks the provided `TurnState` to check `pending_input.has_user_input()`, otherwise treats steer as absent, then checks `has_pending_mailbox_items()`. It returns the receiver and `Some(InputQueueActivity::Steer)`, `Some(InputQueueActivity::Mailbox)`, or `None` depending on current buffered state.

**Call relations**: Called by consumers that need to wait for new work while also handling already-buffered input. It combines turn-local and session-global queue state into one wakeup hint.

*Call graph*: calls 1 internal fn (has_pending_mailbox_items); 1 external calls (subscribe).


##### `InputQueue::enqueue_mailbox_communication`  (lines 72–81)

```
async fn enqueue_mailbox_communication(
        &self,
        communication: InterAgentCommunication,
    )
```

**Purpose**: Appends an inter-agent message to the session mailbox queue and notifies activity subscribers.

**Data flow**: Locks `mailbox_pending_mails`, pushes the `InterAgentCommunication` to the back of the deque, then updates the watch channel with `InputQueueActivity::Mailbox` via `send_replace`.

**Call relations**: Used by mailbox-producing paths such as inter-agent communication handlers and tests. It is the write-side entry point for session-scoped mailbox traffic.

*Call graph*: 1 external calls (send_replace).


##### `InputQueue::has_pending_mailbox_items`  (lines 83–85)

```
async fn has_pending_mailbox_items(&self) -> bool
```

**Purpose**: Reports whether any mailbox communications are currently queued.

**Data flow**: Locks `mailbox_pending_mails`, checks whether the deque is empty, negates that result, and returns the boolean.

**Call relations**: Queried by `subscribe_activity` and `has_pending_input` to decide whether mailbox work should wake or block turn processing.

*Call graph*: called by 2 (has_pending_input, subscribe_activity).


##### `InputQueue::has_trigger_turn_mailbox_items`  (lines 87–93)

```
async fn has_trigger_turn_mailbox_items(&self) -> bool
```

**Purpose**: Reports whether any queued mailbox message requests that a turn be triggered.

**Data flow**: Locks `mailbox_pending_mails`, iterates over queued mails, tests `mail.trigger_turn`, and returns true if any entry matches.

**Call relations**: Used by idle-turn startup logic outside this file to avoid starting extension work when mailbox-triggered work should take precedence.


##### `InputQueue::drain_mailbox_input_items`  (lines 95–102)

```
async fn drain_mailbox_input_items(&self) -> Vec<TurnInput>
```

**Purpose**: Consumes all queued mailbox messages in FIFO order and converts them into `TurnInput` values.

**Data flow**: Locks `mailbox_pending_mails`, drains the entire deque, maps each `InterAgentCommunication` into `TurnInput::InterAgentCommunication`, collects into a `Vec<TurnInput>`, and returns it.

**Call relations**: Called by `get_pending_input` when the current turn is allowed to receive mailbox delivery. It is the only mailbox-consuming path in this module.

*Call graph*: called by 1 (get_pending_input).


##### `InputQueue::turn_state_for_sub_id`  (lines 104–117)

```
async fn turn_state_for_sub_id(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
        sub_id: &str,
    ) -> Option<Arc<Mutex<TurnState>>>
```

**Purpose**: Finds the active turn state associated with a specific submission id, if the active task belongs to that submission.

**Data flow**: Locks `active_turn`, inspects the optional `ActiveTurn`, checks whether its `task.turn_context.sub_id` equals the provided `sub_id`, and if so clones and returns the `Arc<Mutex<TurnState>>`; otherwise returns `None`.

**Call relations**: Used by mailbox-delivery control helpers that need to target the currently active turn corresponding to a client submission.

*Call graph*: called by 2 (accept_mailbox_delivery_for_current_turn, defer_mailbox_delivery_to_next_turn).


##### `InputQueue::clear_pending`  (lines 120–124)

```
async fn clear_pending(&self, active_turn: &ActiveTurn)
```

**Purpose**: Clears all pending waiters and buffered input for the given active turn.

**Data flow**: Locks `active_turn.turn_state`, calls `turn_state.clear_pending_waiters()`, and empties `turn_state.pending_input.items`.

**Call relations**: This is a low-level cleanup helper used by turn-management code elsewhere when abandoning or resetting pending input state.


##### `InputQueue::defer_mailbox_delivery_to_next_turn`  (lines 126–140)

```
async fn defer_mailbox_delivery_to_next_turn(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
        sub_id: &str,
    )
```

**Purpose**: Marks the current turn so mailbox items will be held until the next turn, but only if no turn-local input is already buffered.

**Data flow**: Looks up the turn state for the given `sub_id`; if absent it returns. Otherwise it locks the turn state, returns early if `pending_input.items` is non-empty, and sets `MailboxDeliveryPhase::NextTurn`.

**Call relations**: Used by higher-level turn control when a current turn should not consume mailbox traffic. It relies on `turn_state_for_sub_id` to avoid affecting unrelated turns.

*Call graph*: calls 1 internal fn (turn_state_for_sub_id).


##### `InputQueue::accept_mailbox_delivery_for_current_turn`  (lines 142–153)

```
async fn accept_mailbox_delivery_for_current_turn(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
        sub_id: &str,
    )
```

**Purpose**: Enables mailbox delivery for the active turn associated with the given submission id.

**Data flow**: Finds the matching turn state with `turn_state_for_sub_id`; if found, delegates to `accept_mailbox_delivery_for_turn_state(turn_state.as_ref())`.

**Call relations**: Called by higher-level session logic when a specific active turn should begin receiving mailbox items. It is a sub-id-targeted wrapper around the turn-state helper.

*Call graph*: calls 2 internal fn (accept_mailbox_delivery_for_turn_state, turn_state_for_sub_id).


##### `InputQueue::accept_mailbox_delivery_for_turn_state`  (lines 155–163)

```
async fn accept_mailbox_delivery_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
    )
```

**Purpose**: Marks a turn state as accepting mailbox delivery for the current turn.

**Data flow**: Locks the provided `TurnState` and calls `accept_mailbox_delivery_for_current_turn()` on it.

**Call relations**: Used by `accept_mailbox_delivery_for_current_turn` and potentially other internal queue flows that already have direct access to the turn state.

*Call graph*: called by 1 (accept_mailbox_delivery_for_current_turn).


##### `InputQueue::extend_pending_input_and_accept_mailbox_delivery_for_turn_state`  (lines 165–176)

```
async fn extend_pending_input_and_accept_mailbox_delivery_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
        input: Vec<TurnInput>,
    )
```

**Purpose**: Appends pending input to a turn, enables mailbox delivery for that turn, and notifies subscribers that steer activity is available.

**Data flow**: Locks the provided `TurnState`, extends `pending_input.items` with the supplied `Vec<TurnInput>`, calls `accept_mailbox_delivery_for_current_turn()`, then updates the watch channel to `InputQueueActivity::Steer` with `send_replace`.

**Call relations**: Used by steering-related code and tests when new turn-local input should both wake listeners and allow mailbox delivery to proceed.

*Call graph*: 1 external calls (send_replace).


##### `InputQueue::extend_pending_input_for_turn_state`  (lines 178–184)

```
async fn extend_pending_input_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
        input: Vec<TurnInput>,
    )
```

**Purpose**: Appends additional pending input items to a turn without changing mailbox-delivery state or notifying watchers.

**Data flow**: Locks the provided `TurnState` and extends `pending_input.items` with the supplied `Vec<TurnInput>`.

**Call relations**: Used by injection and other internal paths that only need to buffer more turn-local input.


##### `InputQueue::take_pending_input_for_turn_state`  (lines 186–191)

```
async fn take_pending_input_for_turn_state(
        &self,
        turn_state: &Mutex<TurnState>,
    ) -> Vec<TurnInput>
```

**Purpose**: Removes and returns all currently buffered pending input for a specific turn state.

**Data flow**: Locks the provided `TurnState`, performs `split_off(0)` on `pending_input.items`, and returns the extracted vector.

**Call relations**: This helper is used by turn-processing code elsewhere when it wants turn-local pending input only, without mailbox merging.


##### `InputQueue::get_pending_input`  (lines 197–225)

```
async fn get_pending_input(
        &self,
        active_turn: &Mutex<Option<ActiveTurn>>,
    ) -> Vec<TurnInput>
```

**Purpose**: Atomically extracts pending turn-local input and, if mailbox delivery is currently allowed, appends all queued mailbox messages.

**Data flow**: Locks `active_turn`; if an active turn exists, locks its `turn_state`, splits off all `pending_input.items`, and reads whether the turn accepts mailbox delivery; otherwise uses empty input and `true`. If mailbox delivery is disabled it returns only the turn-local input. If enabled, it drains mailbox items and either returns them alone when turn-local input was empty or extends the turn-local vector with mailbox items before returning it.

**Call relations**: Used by turn execution code to fetch the next batch of work. It is the main consumer-side merge point between turn-local steering input and session-global mailbox traffic.

*Call graph*: calls 1 internal fn (drain_mailbox_input_items); 1 external calls (new).


##### `InputQueue::has_pending_input`  (lines 231–252)

```
async fn has_pending_input(&self, active_turn: &Mutex<Option<ActiveTurn>>) -> bool
```

**Purpose**: Checks whether any turn-local or deliverable mailbox input is waiting without consuming it.

**Data flow**: Locks `active_turn`; if an active turn exists, locks its `turn_state` to determine whether `pending_input.items` is non-empty and whether mailbox delivery is accepted; otherwise assumes no turn-local input and mailbox delivery allowed. It returns true immediately for turn-local input, false when mailbox delivery is disabled and no turn-local input exists, or otherwise delegates to `has_pending_mailbox_items()`.

**Call relations**: Queried by scheduling logic to decide whether a turn should continue or start processing. It mirrors the delivery rules of `get_pending_input` without mutating queue state.

*Call graph*: calls 1 internal fn (has_pending_mailbox_items).


##### `TurnInputQueue::has_user_input`  (lines 256–260)

```
fn has_user_input(&self) -> bool
```

**Purpose**: Reports whether a turn’s buffered input contains any direct user-input item.

**Data flow**: Iterates over `self.items`, matches each entry against `TurnInput::UserInput { .. }`, and returns true if any such item is present.

**Call relations**: Used by `subscribe_activity` to prioritize `Steer` as the immediate pending activity when user input is already buffered for a turn.


##### `tests::make_mail`  (lines 269–282)

```
fn make_mail(
        author: AgentPath,
        recipient: AgentPath,
        content: &str,
        trigger_turn: bool,
    ) -> InterAgentCommunication
```

**Purpose**: Builds a test `InterAgentCommunication` with the supplied author, recipient, content, and trigger-turn flag.

**Data flow**: Consumes `AgentPath` author and recipient, a content string slice, and a boolean; calls `InterAgentCommunication::new(author, recipient, Vec::new(), content.to_string(), trigger_turn)` and returns the resulting message.

**Call relations**: Shared helper for the mailbox-related tests in this module, keeping test setup concise and consistent.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::input_queue_notifies_mailbox_subscribers`  (lines 285–313)

```
async fn input_queue_notifies_mailbox_subscribers()
```

**Purpose**: Verifies that mailbox enqueue operations wake activity subscribers with `InputQueueActivity::Mailbox`.

**Data flow**: Creates a new `InputQueue`, subscribes without a turn state and asserts no pending activity, enqueues two mailbox messages via `make_mail`, waits for `activity_rx.changed()`, and asserts the borrowed activity value is `Mailbox`.

**Call relations**: This test exercises the watch-channel notification path of `enqueue_mailbox_communication` and the initial-state behavior of `subscribe_activity`.

*Call graph*: calls 3 internal fn (new, root, try_from); 2 external calls (assert_eq!, make_mail).


##### `tests::input_queue_notifies_steer_subscribers`  (lines 316–338)

```
async fn input_queue_notifies_steer_subscribers()
```

**Purpose**: Checks that adding turn-local user input and accepting mailbox delivery wakes subscribers with `InputQueueActivity::Steer`.

**Data flow**: Creates an `InputQueue` and default `TurnState`, subscribes with that turn state and asserts no pending activity, extends pending input with a `TurnInput::UserInput` through `extend_pending_input_and_accept_mailbox_delivery_for_turn_state`, waits for a watch change, and asserts the activity is `Steer`.

**Call relations**: This test covers the steer-notification branch and confirms that turn-local user input is surfaced distinctly from mailbox activity.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, assert_eq!, vec!).


##### `tests::input_queue_reports_already_pending_steer`  (lines 341–361)

```
async fn input_queue_reports_already_pending_steer()
```

**Purpose**: Ensures `subscribe_activity` immediately reports `Steer` when user input was already buffered before subscription.

**Data flow**: Creates an `InputQueue` and default `TurnState`, preloads a `TurnInput::UserInput` using `extend_pending_input_and_accept_mailbox_delivery_for_turn_state`, then subscribes and asserts the returned pending-activity hint is `Some(InputQueueActivity::Steer)`.

**Call relations**: This test validates the immediate pending-state computation in `subscribe_activity`, not just future watch notifications.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, assert_eq!, vec!).


##### `tests::input_queue_drains_mailbox_in_delivery_order`  (lines 364–394)

```
async fn input_queue_drains_mailbox_in_delivery_order()
```

**Purpose**: Verifies that mailbox messages are drained in FIFO order and removed from the queue.

**Data flow**: Creates an `InputQueue`, builds two mailbox messages with `make_mail`, enqueues them in order, calls `drain_mailbox_input_items()`, asserts the returned vector contains matching `TurnInput::InterAgentCommunication` entries in the same order, and finally asserts `has_pending_mailbox_items()` is false.

**Call relations**: This test exercises the mailbox storage semantics of `enqueue_mailbox_communication` and `drain_mailbox_input_items`.

*Call graph*: calls 3 internal fn (new, root, try_from); 3 external calls (assert!, assert_eq!, make_mail).


##### `tests::input_queue_tracks_pending_trigger_turn_mail`  (lines 397–419)

```
async fn input_queue_tracks_pending_trigger_turn_mail()
```

**Purpose**: Checks that the queue distinguishes ordinary mailbox messages from those marked `trigger_turn`.

**Data flow**: Creates an `InputQueue`, enqueues one non-triggering mail and asserts `has_trigger_turn_mailbox_items()` is false, then enqueues a triggering mail and asserts the predicate becomes true.

**Call relations**: This test protects the scheduling-related invariant used by idle-turn startup logic outside this module.

*Call graph*: calls 3 internal fn (new, root, try_from); 2 external calls (assert!, make_mail).


### `core/src/session/inject.rs`

`orchestration` · `cross-cutting`

This extension impl on `Session` provides the mechanics for feeding `ResponseItem` values into the session without going through the normal user-input protocol path. `inject_if_running` is the simplest case: it locks `active_turn`, and if a turn exists it converts each `ResponseItem` into `TurnInput::ResponseItem` and appends them to that turn’s pending input queue; otherwise it returns the original items unchanged so the caller can decide what to do next. `try_start_turn_if_idle` is more involved and intentionally keeps several checks serialized under locks. It refuses to start work for empty input, when the mailbox contains any `trigger_turn` communications, when the current collaboration mode is `ModeKind::Plan`, or when an active turn already exists. If those checks pass, it reserves an idle turn by inserting a default `ActiveTurn`, then rechecks mailbox-triggered work and plan mode after creating a default turn context with a generated UUID sub-id. If any condition changed, it clears the reservation and asks the scheduler to start pending work instead. Before launching, it verifies the reservation still belongs to this idle-start attempt by pointer-comparing the stored `turn_state`. Only then does it append the injected items and start a `RegularTask`. `clear_reserved_idle_turn` removes a reservation only when it still points at the same taskless `turn_state`. Finally, `inject_no_new_turn` first tries active-turn injection and, if that fails, records the items into conversation history using either the provided turn context or a newly created default one, explicitly avoiding automatic turn startup.

#### Function details

##### `Session::inject_if_running`  (lines 19–36)

```
async fn inject_if_running(
        &self,
        input: Vec<ResponseItem>,
    ) -> Result<(), Vec<ResponseItem>>
```

**Purpose**: Attempts to append response items to the currently active turn and returns them unchanged if no turn is running.

**Data flow**: Locks `self.active_turn`; if `Some(active_turn)`, maps the input `Vec<ResponseItem>` into `Vec<TurnInput::ResponseItem>` and appends it to `active_turn.turn_state.pending_input` through `input_queue.extend_pending_input_for_turn_state`, then returns `Ok(())`. If there is no active turn, it returns `Err(input)` containing the original items.

**Call relations**: Used by `inject_no_new_turn` as the fast path for in-flight work. Its atomic lock scope ensures the active-turn check and queue append happen consistently.

*Call graph*: called by 1 (inject_no_new_turn).


##### `Session::try_start_turn_if_idle`  (lines 45–130)

```
async fn try_start_turn_if_idle(
        self: &Arc<Self>,
        input: Vec<ResponseItem>,
    ) -> Result<(), TryStartTurnIfIdleError>
```

**Purpose**: Starts a new regular turn for injected items only when the session is truly idle and no higher-priority trigger-turn work is pending.

**Data flow**: Consumes `Vec<ResponseItem>` and returns early success for empty input. It checks `input_queue.has_trigger_turn_mailbox_items()` and current `collaboration_mode().mode` to reject pending-trigger-turn or plan-mode cases. It then locks `active_turn`, rejects if busy, otherwise reserves a default `ActiveTurn` and clones its `turn_state`. After reservation it rechecks trigger-turn mailbox state, creates a default turn context with a random UUID sub-id, rechecks plan mode from that context and mailbox state again, verifies the reservation still points to the same taskless `turn_state` via `Arc::ptr_eq`, appends the items as `TurnInput::ResponseItem`, starts `RegularTask::new()`, and returns `Ok(())`; any failed check clears the reservation and returns `TryStartTurnIfIdleError` with the original input and a specific rejection reason.

**Call relations**: This helper is used by extension-initiated idle work paths. It coordinates with `clear_reserved_idle_turn` and `maybe_start_turn_for_pending_work` to avoid stealing execution from queued user or mailbox-triggered work.

*Call graph*: calls 3 internal fn (new, clear_reserved_idle_turn, new); 3 external calls (clone, new, new_v4).


##### `Session::clear_reserved_idle_turn`  (lines 132–140)

```
async fn clear_reserved_idle_turn(&self, turn_state: &Arc<tokio::sync::Mutex<TurnState>>)
```

**Purpose**: Removes a previously reserved idle `ActiveTurn` only if it is still taskless and still refers to the same turn state.

**Data flow**: Locks `self.active_turn`, checks whether the current active turn exists, has `task.is_none()`, and its `turn_state` pointer matches the provided `Arc<Mutex<TurnState>>` via `Arc::ptr_eq`; if so, it sets the active turn slot to `None`.

**Call relations**: Called from multiple rejection branches inside `try_start_turn_if_idle`. It prevents stale cleanup from deleting a turn reservation that has already been claimed by some other path.

*Call graph*: called by 1 (try_start_turn_if_idle); 1 external calls (ptr_eq).


##### `Session::inject_no_new_turn`  (lines 143–160)

```
async fn inject_no_new_turn(
        &self,
        items: Vec<ResponseItem>,
        current_turn_context: Option<&TurnContext>,
    )
```

**Purpose**: Injects items into active work when possible, otherwise records them into conversation history without launching a new turn.

**Data flow**: Calls `inject_if_running(items).await`; if that succeeds it returns immediately. If it gets the items back, it chooses a turn context from `current_turn_context` or creates a new default turn, then calls `record_conversation_items(turn_context, &items).await` to persist them as conversation state.

**Call relations**: Used by flows such as Guardian denied-action approval injection that need to add context but must not automatically start model work. It builds directly on `inject_if_running` for the active-turn fast path.

*Call graph*: calls 1 internal fn (inject_if_running).


### `core/src/state/service.rs`

`orchestration` · `session setup and cross-cutting runtime access`

This file is the structural hub for runtime dependencies attached to a session. `SessionServices` aggregates a large set of concrete facilities: MCP connectivity (`ArcSwap<McpConnectionManager>`, `McpManager`, startup cancellation token), execution infrastructure (`UnifiedExecProcessManager`, shell wrapper paths, `ExecPolicyManager`), telemetry and analytics (`AnalyticsEventsClient`, `SessionTelemetry`, rollout trace context), auth/model/plugin systems (`AuthManager`, `SharedModelsManager`, `PluginsManager`, `SkillsManager`), extension state (`ExtensionRegistry`, session/thread `ExtensionData`, MCP thread init data), approval and guardian state (`ApprovalStore`, guardian rejection maps and circuit breaker, `NetworkApprovalService`), persistence/thread state (`StateDbHandle`, `LiveThread`, `ThreadStore`), and per-session behavior flags such as raw reasoning visibility and managed-network configuration. Most fields are plain storage; mutability is isolated with `Mutex`, `ArcSwap`, or `ArcSwapOption` depending on whether callers need atomic replacement or async interior mutation.

The notable design choice is the MCP manager installation path: the manager is stored before validation runs. That ordering allows startup-time elicitation and other session code to resolve through the newly installed manager while `validate_required_servers()` is still awaiting. The field comment reinforces the ownership model: callers should clone an owned `Arc` from the swap before performing MCP I/O so replacement does not invalidate in-flight work.

#### Function details

##### `SessionServices::install_mcp_connection_manager`  (lines 90–99)

```
async fn install_mcp_connection_manager(
        &self,
        manager: McpConnectionManager,
    ) -> Result<()>
```

**Purpose**: Atomically replaces the session's current `McpConnectionManager` with a newly constructed one, then asynchronously validates that all required MCP servers are available. The method intentionally publishes the manager before validation completes.

**Data flow**: It takes `&self` and an owned `McpConnectionManager`. The function wraps the manager in `Arc`, stores it into `self.mcp_connection_manager` via `ArcSwap::store`, then reloads the just-installed manager with `load_full()` and awaits `validate_required_servers()`. It returns `Result<()>`, propagating any validation failure while leaving the new manager installed.

**Call relations**: This method is used when session startup or reconfiguration has produced a fresh MCP connection manager. Its internal flow first makes the manager visible to the rest of the session, then delegates validation to the manager itself so any startup-time elicitation or dependent code can already resolve through the session-wide handle while validation is pending.

*Call graph*: 1 external calls (new).


### `core/src/state/session.rs`

`data_model` · `entire session lifetime; updated on each turn and during session bookkeeping`

This file defines `SessionState`, the persistent state layer for a running session. Its fields combine transcript/history state (`ContextManager` plus optional reference context item and token info), protocol/accounting state (`latest_rate_limits`, `server_reasoning_included`), startup and connector bookkeeping (`startup_prewarm`, active connector IDs, queued `SessionStartSource`s), turn-to-turn carryover (`previous_turn_settings`, `next_turn_is_first`), MCP prompting memory, additional context storage, and permission grants keyed by environment ID. It also embeds `AutoCompactWindow`, which tracks context-window lifecycle and prefill estimates/observations for automatic compaction.

Most methods are thin, explicit state transitions rather than business logic: they forward to `ContextManager` or `AutoCompactWindow`, clone small snapshots for callers, or mutate sets/maps/queues. Two behaviors are easy to miss. First, `replace_history()` not only swaps transcript items and reference context but also clears auto-compact prefill, preventing stale token estimates from surviving a history reset such as resume or `/compact`. Second, `set_rate_limits()` merges partial snapshots instead of replacing wholesale: missing `credits`, `individual_limit`, and `plan_type` are preserved from the previous snapshot, while a missing `limit_id` is normalized to `"codex"` rather than inherited. Permission recording also merges profiles per environment using `merge_permission_profiles`, so repeated grants accumulate instead of overwrite destructively.

#### Function details

##### `SessionState::new`  (lines 47–64)

```
fn new(session_configuration: SessionConfiguration) -> Self
```

**Purpose**: Constructs a fresh `SessionState` with empty history-adjacent bookkeeping and default session flags. It mirrors the prior default session semantics while requiring an explicit `SessionConfiguration`.

**Data flow**: It consumes a `SessionConfiguration`, creates a new `ContextManager`, a new `AutoCompactWindow`, empty `HashSet`/`HashMap`/`VecDeque` collections, and initializes optional fields like `latest_rate_limits`, `previous_turn_settings`, and `startup_prewarm` to `None`. It returns the fully populated `SessionState` with `next_turn_is_first` set to `true`.

**Call relations**: This is the constructor used by session creation paths and tests. It delegates initialization of nested state to `ContextManager::new`, `AutoCompactWindow::new`, and default constructors so later helper methods can assume all collections and sub-objects are present.

*Call graph*: calls 2 internal fn (new, new); called by 12 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present, clear_connector_selection_removes_entries, merge_connector_selection_deduplicates_entries, replace_history_clears_auto_compact_window_prefill, set_rate_limits_carries_account_metadata_from_codex_to_codex_other, set_rate_limits_defaults_limit_id_to_codex_when_missing (+2 more)); 4 external calls (new, new, new, default).


##### `SessionState::record_items`  (lines 67–73)

```
fn record_items(&mut self, items: I, policy: TruncationPolicy)
```

**Purpose**: Appends response items into the session history using the supplied truncation policy. It is the main write-through wrapper around `ContextManager` transcript recording.

**Data flow**: It takes a mutable session state, an arbitrary iterator of items dereferencing to `ResponseItem`, and a `TruncationPolicy`. The items are forwarded unchanged to `self.history.record_items`, which updates stored conversation history and any truncation side effects; this method itself returns `()`.

**Call relations**: Called by higher-level session logic when completed model or tool outputs should become part of persistent history. It delegates all actual transcript mutation to `ContextManager`.

*Call graph*: calls 1 internal fn (record_items).


##### `SessionState::previous_turn_settings`  (lines 75–77)

```
fn previous_turn_settings(&self) -> Option<PreviousTurnSettings>
```

**Purpose**: Returns the last saved regular-turn settings snapshot for reuse on later turns. The method exposes a cloned value so callers cannot mutate internal state directly.

**Data flow**: It reads `self.previous_turn_settings`, clones the `Option<PreviousTurnSettings>`, and returns that clone without modifying session state.

**Call relations**: Used by turn orchestration that needs to carry model/realtime settings across turns, especially after resume or compaction. It is a pure accessor with no downstream delegation.


##### `SessionState::set_previous_turn_settings`  (lines 78–83)

```
fn set_previous_turn_settings(
        &mut self,
        previous_turn_settings: Option<PreviousTurnSettings>,
    )
```

**Purpose**: Stores or clears the session's remembered settings from the latest regular user turn. This is the write side of turn-to-turn settings carryover.

**Data flow**: It takes `Option<PreviousTurnSettings>` and assigns it directly into `self.previous_turn_settings`, replacing any prior value. It returns `()`.

**Call relations**: Invoked after a turn finishes or when state restoration changes what should be remembered for subsequent turns. It does not delegate further.


##### `SessionState::set_next_turn_is_first`  (lines 85–87)

```
fn set_next_turn_is_first(&mut self, value: bool)
```

**Purpose**: Explicitly sets the flag that marks whether the next turn should be treated as the first turn in the session. This supports resume/reset flows that need to override the normal one-way transition.

**Data flow**: It takes a `bool` and writes it into `self.next_turn_is_first`, replacing the previous flag value. No value is returned.

**Call relations**: Used by orchestration code that needs to force first-turn semantics on the next turn. It is a direct state setter.


##### `SessionState::take_next_turn_is_first`  (lines 89–93)

```
fn take_next_turn_is_first(&mut self) -> bool
```

**Purpose**: Consumes the current first-turn flag and clears it for future calls. This gives callers a one-shot answer to whether the upcoming turn is the first.

**Data flow**: It reads `self.next_turn_is_first` into a local, then sets the field to `false`, and returns the original boolean. The mutation guarantees subsequent calls return `false` unless reset elsewhere.

**Call relations**: Called at turn start when orchestration needs first-turn behavior exactly once. It encapsulates the read-and-clear transition so callers do not duplicate that logic.


##### `SessionState::clone_history`  (lines 95–97)

```
fn clone_history(&self) -> ContextManager
```

**Purpose**: Produces a clone of the current `ContextManager` history object. This allows callers to inspect or work from a snapshot without borrowing the session state.

**Data flow**: It reads `self.history`, clones it, and returns the cloned `ContextManager`. No internal state changes occur.

**Call relations**: Used when downstream logic needs a history snapshot detached from the mutable session state. It relies on `ContextManager`'s clone implementation.

*Call graph*: 1 external calls (clone).


##### `SessionState::replace_history`  (lines 99–108)

```
fn replace_history(
        &mut self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
    )
```

**Purpose**: Replaces the entire stored conversation history and optional reference context item, then resets auto-compaction prefill bookkeeping. It is the reset path for transcript replacement operations.

**Data flow**: It takes a `Vec<ResponseItem>` and an optional `TurnContextItem`. The method forwards the items to `self.history.replace`, writes the reference item via `self.history.set_reference_context_item`, then calls `self.auto_compact_window.clear_prefill()` so any prior prefill estimate/observation is discarded. It returns `()`.

**Call relations**: Used by flows such as compaction or resume that rebuild the transcript wholesale. It coordinates `ContextManager` and `AutoCompactWindow` so token-prefill state stays consistent with the new history.

*Call graph*: calls 3 internal fn (replace, set_reference_context_item, clear_prefill).


##### `SessionState::set_token_info`  (lines 110–112)

```
fn set_token_info(&mut self, info: Option<TokenUsageInfo>)
```

**Purpose**: Stores explicit token usage information on the history object. This is a direct setter for externally computed token accounting.

**Data flow**: It takes `Option<TokenUsageInfo>` and forwards it to `self.history.set_token_info`, updating the history's token metadata. No value is returned.

**Call relations**: Called when token info arrives from the model/provider layer and should replace the current history metadata. It delegates the actual storage to `ContextManager`.

*Call graph*: calls 1 internal fn (set_token_info).


##### `SessionState::set_reference_context_item`  (lines 114–116)

```
fn set_reference_context_item(&mut self, item: Option<TurnContextItem>)
```

**Purpose**: Updates the history's reference context item without replacing the rest of the transcript. This lets callers adjust the anchor context independently.

**Data flow**: It takes `Option<TurnContextItem>` and passes it to `self.history.set_reference_context_item`, mutating only that piece of history state. It returns `()`.

**Call relations**: Used by session logic that changes the reference context after transcript creation. It is a thin wrapper over `ContextManager`.

*Call graph*: calls 1 internal fn (set_reference_context_item).


##### `SessionState::reference_context_item`  (lines 118–120)

```
fn reference_context_item(&self) -> Option<TurnContextItem>
```

**Purpose**: Fetches the currently stored reference context item from history. It exposes the optional anchor item as a cloned value.

**Data flow**: It reads from `self.history.reference_context_item()` and returns the resulting `Option<TurnContextItem>`. No mutation occurs.

**Call relations**: Called by code that needs to reconstruct or inspect the current context anchor. It delegates to `ContextManager` for retrieval.

*Call graph*: calls 1 internal fn (reference_context_item).


##### `SessionState::update_token_info_from_usage`  (lines 123–129)

```
fn update_token_info_from_usage(
        &mut self,
        usage: &TokenUsage,
        model_context_window: Option<i64>,
    )
```

**Purpose**: Updates history token accounting from a raw `TokenUsage` report and optional model context window size. This is the incremental token-accounting path.

**Data flow**: It takes a borrowed `TokenUsage` and `Option<i64>` for the model context window, then forwards both to `self.history.update_token_info`. The history object derives or updates `TokenUsageInfo`; this wrapper returns `()`.

**Call relations**: Invoked when a provider reports usage after a turn or response item. It delegates token-info derivation to `ContextManager`.

*Call graph*: calls 1 internal fn (update_token_info).


##### `SessionState::ensure_auto_compact_window_server_prefill_from_usage`  (lines 131–137)

```
fn ensure_auto_compact_window_server_prefill_from_usage(
        &mut self,
        usage: &TokenUsage,
    )
```

**Purpose**: Seeds the auto-compaction window with server-observed prefill token data if that information has not already been recorded. It preserves the first authoritative prefill observation.

**Data flow**: It takes a borrowed `TokenUsage` and passes it to `self.auto_compact_window.ensure_server_observed_prefill_from_usage`. The auto-compact window may update its internal prefill state; no value is returned.

**Call relations**: Used during token accounting when server usage reports can refine compaction heuristics. It delegates to `AutoCompactWindow` to enforce the 'ensure once' behavior.

*Call graph*: calls 1 internal fn (ensure_server_observed_prefill_from_usage).


##### `SessionState::set_auto_compact_window_estimated_prefill`  (lines 139–141)

```
fn set_auto_compact_window_estimated_prefill(&mut self, tokens: i64)
```

**Purpose**: Stores an estimated prefill token count for the active auto-compaction window. This supports local estimation before server-observed values arrive.

**Data flow**: It takes an `i64` token count and forwards it to `self.auto_compact_window.set_estimated_prefill`, mutating the window's prefill state. It returns `()`.

**Call relations**: Called by compaction-related logic that computes a prefill estimate. It is a direct wrapper around `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (set_estimated_prefill).


##### `SessionState::auto_compact_window_snapshot`  (lines 143–145)

```
fn auto_compact_window_snapshot(&self) -> AutoCompactWindowSnapshot
```

**Purpose**: Returns a snapshot of the current auto-compaction window state. This gives callers a stable view of prefill-related bookkeeping.

**Data flow**: It reads `self.auto_compact_window.snapshot()` and returns the resulting `AutoCompactWindowSnapshot`. No mutation occurs.

**Call relations**: Used by diagnostics, tests, or orchestration that needs to inspect current compaction-window metadata. It delegates snapshot creation to `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (snapshot).


##### `SessionState::auto_compact_window_id`  (lines 147–149)

```
fn auto_compact_window_id(&self) -> u64
```

**Purpose**: Reads the current auto-compaction window identifier. The ID distinguishes successive context windows across compaction boundaries.

**Data flow**: It calls `self.auto_compact_window.window_id()` and returns the `u64` result. No state changes occur.

**Call relations**: Called by code that tags work or metrics with the current context-window identity. It is a pure accessor.

*Call graph*: calls 1 internal fn (window_id).


##### `SessionState::set_auto_compact_window_id`  (lines 151–153)

```
fn set_auto_compact_window_id(&mut self, window_id: u64)
```

**Purpose**: Forces the auto-compaction window identifier to a specific value. This supports restoration or synchronization with externally known window IDs.

**Data flow**: It takes a `u64` and forwards it to `self.auto_compact_window.set_window_id`, mutating the embedded window state. It returns `()`.

**Call relations**: Used when restoring session state or aligning compaction bookkeeping with another source of truth. It delegates to `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (set_window_id).


##### `SessionState::advance_auto_compact_window_id`  (lines 155–157)

```
fn advance_auto_compact_window_id(&mut self) -> u64
```

**Purpose**: Increments the auto-compaction window identifier and returns the new value. This marks the start of a fresh context window.

**Data flow**: It calls `self.auto_compact_window.advance_window_id()`, which mutates internal state and yields the updated `u64`. That value is returned directly.

**Call relations**: Called when compaction or context rollover explicitly starts a new window. It centralizes the increment operation in `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (advance_window_id).


##### `SessionState::request_new_context_window`  (lines 159–161)

```
fn request_new_context_window(&mut self)
```

**Purpose**: Marks that a new context window should be started later. It records intent without immediately advancing the window ID.

**Data flow**: It mutably borrows the state and calls `self.auto_compact_window.request_new_context_window()`, setting an internal request flag. No value is returned.

**Call relations**: Used by code that detects the need for a new context window but defers the actual transition until a safer point. It delegates flag storage to `AutoCompactWindow`.

*Call graph*: calls 1 internal fn (request_new_context_window).


##### `SessionState::start_new_context_window_if_requested`  (lines 163–171)

```
fn start_new_context_window_if_requested(&mut self) -> Option<u64>
```

**Purpose**: Consumes a pending new-window request, advances the window ID, clears prefill state, and returns the new ID. If no request is pending, it leaves state unchanged and returns `None`.

**Data flow**: It first calls `self.auto_compact_window.take_new_context_window_request()`. If that returns `false`, the function returns `None`. Otherwise it advances the window ID with `advance_window_id()`, clears prefill via `clear_prefill()`, and returns `Some(window_id)`.

**Call relations**: This is the deferred execution counterpart to `request_new_context_window`. Turn/session orchestration calls it at a boundary where a context-window rollover can safely occur.

*Call graph*: calls 3 internal fn (advance_window_id, clear_prefill, take_new_context_window_request).


##### `SessionState::token_info`  (lines 173–175)

```
fn token_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the current token usage summary stored in history. It is the canonical accessor for session-level token info.

**Data flow**: It reads `self.history.token_info()` and returns the resulting `Option<TokenUsageInfo>`. No mutation occurs.

**Call relations**: Used directly by callers and internally by `token_info_and_rate_limits` to package token and rate-limit state together. It delegates retrieval to `ContextManager`.

*Call graph*: calls 1 internal fn (token_info); called by 1 (token_info_and_rate_limits).


##### `SessionState::set_rate_limits`  (lines 177–182)

```
fn set_rate_limits(&mut self, snapshot: RateLimitSnapshot)
```

**Purpose**: Updates the latest rate-limit snapshot while preserving account metadata that providers sometimes omit. It normalizes missing `limit_id` values to the default `codex` bucket.

**Data flow**: It takes an owned `RateLimitSnapshot`, passes the previous snapshot reference and the new snapshot into `merge_rate_limit_fields`, and stores the merged result in `self.latest_rate_limits`. It returns `()`.

**Call relations**: Called when fresh rate-limit data arrives from the backend. It delegates the field-level merge policy to the private helper so callers always get consistent preservation/defaulting behavior.

*Call graph*: calls 1 internal fn (merge_rate_limit_fields).


##### `SessionState::token_info_and_rate_limits`  (lines 184–188)

```
fn token_info_and_rate_limits(
        &self,
    ) -> (Option<TokenUsageInfo>, Option<RateLimitSnapshot>)
```

**Purpose**: Returns the current token usage info and latest rate-limit snapshot as a pair. This is a convenience accessor for UI/protocol code that needs both pieces together.

**Data flow**: It calls `self.token_info()` and clones `self.latest_rate_limits`, then returns `(Option<TokenUsageInfo>, Option<RateLimitSnapshot>)`. No state changes occur.

**Call relations**: Used by higher-level reporting paths that need a combined accounting snapshot. It reuses `token_info()` rather than reading history directly.

*Call graph*: calls 1 internal fn (token_info).


##### `SessionState::set_token_usage_full`  (lines 190–192)

```
fn set_token_usage_full(&mut self, context_window: i64)
```

**Purpose**: Marks token usage as fully consuming the given context window size. This is a direct way to indicate the context window is saturated.

**Data flow**: It takes an `i64` context-window size and forwards it to `self.history.set_token_usage_full`, mutating token accounting in history. It returns `()`.

**Call relations**: Called when the system determines the context window is full and wants history accounting to reflect that state. It delegates to `ContextManager`.

*Call graph*: calls 1 internal fn (set_token_usage_full).


##### `SessionState::get_total_token_usage`  (lines 194–197)

```
fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64
```

**Purpose**: Computes total token usage from history, optionally including server reasoning tokens. It exposes the same aggregation logic used by the history manager.

**Data flow**: It takes a `bool` indicating whether server reasoning should be included, forwards that flag to `self.history.get_total_token_usage`, and returns the resulting `i64` total. No mutation occurs.

**Call relations**: Used by accounting and compaction logic that needs a single token total. It delegates the actual summation rules to `ContextManager`.

*Call graph*: calls 1 internal fn (get_total_token_usage).


##### `SessionState::set_server_reasoning_included`  (lines 199–201)

```
fn set_server_reasoning_included(&mut self, included: bool)
```

**Purpose**: Stores whether server reasoning tokens are included in token accounting for this session. This flag influences later interpretation of usage totals.

**Data flow**: It takes a `bool` and writes it into `self.server_reasoning_included`. No value is returned.

**Call relations**: Set by provider/session logic when it learns how token usage should be interpreted. It is a simple field setter.


##### `SessionState::server_reasoning_included`  (lines 203–205)

```
fn server_reasoning_included(&self) -> bool
```

**Purpose**: Returns the current server-reasoning inclusion flag. This lets callers interpret token totals consistently.

**Data flow**: It reads `self.server_reasoning_included` and returns the boolean. No mutation occurs.

**Call relations**: Used by accounting/reporting code that needs to know whether reasoning tokens are already counted. It is a pure accessor.


##### `SessionState::record_mcp_dependency_prompted`  (lines 207–212)

```
fn record_mcp_dependency_prompted(&mut self, names: I)
```

**Purpose**: Adds one or more MCP dependency names to the set of dependencies already prompted to the user. This prevents repeated prompting for the same dependency.

**Data flow**: It takes any iterator of `String` names and extends `self.mcp_dependency_prompted` with them. Duplicate names are naturally deduplicated by the `HashSet`; the method returns `()`.

**Call relations**: Called after dependency-prompt UI has been shown so later turns can suppress repeats. It performs direct set mutation without delegation.


##### `SessionState::mcp_dependency_prompted`  (lines 214–216)

```
fn mcp_dependency_prompted(&self) -> HashSet<String>
```

**Purpose**: Returns a clone of the set of MCP dependency names already prompted in this session. The clone avoids exposing internal mutable state.

**Data flow**: It clones `self.mcp_dependency_prompted` and returns the resulting `HashSet<String>`. No mutation occurs.

**Call relations**: Used by prompting logic that needs to check or serialize prior MCP dependency prompts. It is a pure accessor.


##### `SessionState::set_session_startup_prewarm`  (lines 218–223)

```
fn set_session_startup_prewarm(
        &mut self,
        startup_prewarm: SessionStartupPrewarmHandle,
    )
```

**Purpose**: Stores a startup-prewarmed session handle for later consumption. This preserves initialization work done ahead of the first turn.

**Data flow**: It takes a `SessionStartupPrewarmHandle` and wraps it in `Some`, assigning it to `self.startup_prewarm`. It returns `()`.

**Call relations**: Called during session initialization when prewarm work completes successfully. It is paired with `take_session_startup_prewarm` for one-time consumption.


##### `SessionState::take_session_startup_prewarm`  (lines 225–227)

```
fn take_session_startup_prewarm(&mut self) -> Option<SessionStartupPrewarmHandle>
```

**Purpose**: Removes and returns the stored startup prewarm handle, if any. This is a one-shot transfer of ownership.

**Data flow**: It calls `self.startup_prewarm.take()`, replacing the field with `None` and returning the previous `Option<SessionStartupPrewarmHandle>`. This mutates state by consuming the stored handle.

**Call relations**: Used when the first turn or another startup path wants to claim the prewarmed session resources. It encapsulates the consume-once pattern.


##### `SessionState::merge_connector_selection`  (lines 230–236)

```
fn merge_connector_selection(&mut self, connector_ids: I) -> HashSet<String>
```

**Purpose**: Adds connector IDs into the active connector-selection set and returns the merged result. Duplicate IDs are collapsed automatically.

**Data flow**: It takes any iterator of `String` connector IDs, extends `self.active_connector_selection`, then clones and returns the full `HashSet<String>`. The internal set is updated in place.

**Call relations**: Called when user or system actions activate additional connectors for the session. Tests verify its deduplication behavior and returned merged view.


##### `SessionState::get_connector_selection`  (lines 239–241)

```
fn get_connector_selection(&self) -> HashSet<String>
```

**Purpose**: Returns the currently tracked connector selection set. The clone gives callers a snapshot without exposing internal mutability.

**Data flow**: It clones `self.active_connector_selection` and returns the `HashSet<String>`. No mutation occurs.

**Call relations**: Used by code that needs to inspect active connectors after prior merges or before clearing. It is a pure accessor.


##### `SessionState::clear_connector_selection`  (lines 244–246)

```
fn clear_connector_selection(&mut self)
```

**Purpose**: Removes all tracked connector selections from the session state. This resets connector activation to empty.

**Data flow**: It mutably borrows the state and calls `self.active_connector_selection.clear()`, emptying the set. It returns `()`.

**Call relations**: Invoked when connector selection should be reset wholesale, such as after explicit user action or session transitions. Tests verify that subsequent reads return an empty set.


##### `SessionState::queue_pending_session_start_source`  (lines 248–253)

```
fn queue_pending_session_start_source(
        &mut self,
        value: codex_hooks::SessionStartSource,
    )
```

**Purpose**: Appends a `SessionStartSource` value to the FIFO queue of pending session-start sources. This preserves arrival order for later consumption.

**Data flow**: It takes a `codex_hooks::SessionStartSource` and pushes it onto `self.pending_session_start_sources` with `push_back`. No value is returned.

**Call relations**: Used by hook/session-start orchestration to enqueue multiple sources before they are processed. It pairs with `take_pending_session_start_source` for ordered draining.

*Call graph*: 1 external calls (push_back).


##### `SessionState::take_pending_session_start_source`  (lines 255–259)

```
fn take_pending_session_start_source(
        &mut self,
    ) -> Option<codex_hooks::SessionStartSource>
```

**Purpose**: Pops and returns the oldest queued pending session-start source, if one exists. This gives FIFO consumption semantics.

**Data flow**: It calls `self.pending_session_start_sources.pop_front()` and returns the resulting `Option<SessionStartSource>`, mutating the queue by removing the front element when present.

**Call relations**: Called by startup processing code that drains queued session-start sources in insertion order. It is the dequeue side of the queue API.

*Call graph*: 1 external calls (pop_front).


##### `SessionState::record_granted_permissions`  (lines 261–275)

```
fn record_granted_permissions(
        &mut self,
        environment_id: &str,
        permissions: AdditionalPermissionProfile,
    )
```

**Purpose**: Merges newly granted additional permissions into the session's sticky permission profile for a specific environment. Repeated grants accumulate rather than overwrite blindly.

**Data flow**: It takes an `environment_id` string slice and an `AdditionalPermissionProfile`. The method looks up any existing profile in `granted_permissions_by_environment_id`, passes the old and new profiles to `merge_permission_profiles`, and if the merge returns `Some`, inserts the merged profile back under `environment_id.to_string()`. It returns `()`.

**Call relations**: Used when permission approvals should persist across turns at the session scope. It delegates merge semantics to the sandboxing policy helper so profile combination stays consistent with other permission code.

*Call graph*: calls 1 internal fn (merge_permission_profiles).


##### `SessionState::granted_permissions`  (lines 277–284)

```
fn granted_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Returns the stored granted-permissions profile for a given environment, if any. The returned profile is cloned from internal state.

**Data flow**: It takes an `environment_id` string slice, looks up that key in `granted_permissions_by_environment_id`, clones the `AdditionalPermissionProfile` if present, and returns `Option<AdditionalPermissionProfile>`. No mutation occurs.

**Call relations**: Called by permission-checking or turn-setup code that wants to reuse sticky grants from prior approvals. It is a pure map lookup.


##### `merge_rate_limit_fields`  (lines 290–307)

```
fn merge_rate_limit_fields(
    previous: Option<&RateLimitSnapshot>,
    mut snapshot: RateLimitSnapshot,
) -> RateLimitSnapshot
```

**Purpose**: Combines a new `RateLimitSnapshot` with selected metadata from the previous snapshot when the new one omits those fields. It also normalizes a missing `limit_id` to `"codex"` instead of inheriting the prior bucket.

**Data flow**: It takes an optional reference to the previous snapshot and a mutable new snapshot. If `snapshot.limit_id` is `None`, it sets it to `Some("codex".to_string())`; if `credits`, `individual_limit`, or `plan_type` are missing, it copies those values from `previous` when available. It returns the modified `RateLimitSnapshot`.

**Call relations**: This helper is only used by `SessionState::set_rate_limits` to enforce consistent merge/default behavior whenever rate-limit updates arrive. Tests in the companion test file exercise the edge cases around missing IDs and preserved account metadata.

*Call graph*: called by 1 (set_rate_limits).


### `core/src/state/auto_compact_window.rs`

`data_model` · `cross-cutting session state during context growth and compaction`

This file defines the internal state for auto-compaction accounting. `AutoCompactWindow` stores a monotonically advancing `window_id`, a boolean flag indicating that a new context window has been requested, and an optional `prefill_input_tokens` baseline. That baseline is represented by the private enum `AutoCompactWindowPrefill`, which distinguishes server-observed values from estimated ones so that authoritative usage samples can override estimates but not vice versa. `AutoCompactWindowSnapshot` exposes only the normalized token count, hiding whether it came from an estimate or the server.

The methods form a small state machine. `new` initializes window 0 with no pending rollover and no prefill. `request_new_context_window` sets the rollover flag, `take_new_context_window_request` returns and clears it, and `advance_window_id` increments the id with `saturating_add(1)` while also clearing any pending request. `clear_prefill` resets the baseline entirely. For token accounting, `set_estimated_prefill` records a non-negative estimate unless a server-observed baseline already exists, while `ensure_server_observed_prefill_from_usage` records the first non-negative `usage.input_tokens` sample and then becomes sticky against later updates. `snapshot` flattens either enum variant into `Option<i64>`. The included test demonstrates the intended invariant: server-observed prefill wins permanently over estimates and later server samples within the same window.

#### Function details

##### `AutoCompactWindow::new`  (lines 27–33)

```
fn new() -> Self
```

**Purpose**: Creates a fresh auto-compaction window state with id 0, no pending rollover request, and no prefill baseline.

**Data flow**: Returns `AutoCompactWindow { window_id: 0, new_context_window_requested: false, prefill_input_tokens: None }`.

**Call relations**: Called when initializing the owning state object and by the unit test that exercises window transitions.

*Call graph*: called by 2 (tracks_prefill_and_window_boundaries, new).


##### `AutoCompactWindow::clear_prefill`  (lines 35–37)

```
fn clear_prefill(&mut self)
```

**Purpose**: Removes any stored prefill token baseline for the current window.

**Data flow**: Mutably sets `self.prefill_input_tokens = None`; returns `()`.

**Call relations**: Used when history is replaced or a new context window starts and prior baseline accounting should be discarded.

*Call graph*: called by 2 (replace_history, start_new_context_window_if_requested).


##### `AutoCompactWindow::window_id`  (lines 39–41)

```
fn window_id(&self) -> u64
```

**Purpose**: Returns the current auto-compaction window identifier.

**Data flow**: Reads `self.window_id` and returns it as `u64`.

**Call relations**: Queried by higher-level state accessors that expose the current window id.

*Call graph*: called by 1 (auto_compact_window_id).


##### `AutoCompactWindow::set_window_id`  (lines 43–45)

```
fn set_window_id(&mut self, window_id: u64)
```

**Purpose**: Overwrites the current window identifier with a caller-supplied value.

**Data flow**: Consumes `window_id: u64` and assigns it to `self.window_id`; returns `()`.

**Call relations**: Used by state restoration or synchronization code that needs to set the window id explicitly.

*Call graph*: called by 1 (set_auto_compact_window_id).


##### `AutoCompactWindow::advance_window_id`  (lines 47–51)

```
fn advance_window_id(&mut self) -> u64
```

**Purpose**: Moves to the next window id and clears any pending new-window request.

**Data flow**: Mutably updates `self.window_id = self.window_id.saturating_add(1)`, sets `self.new_context_window_requested = false`, and returns the new id.

**Call relations**: Called when a new context window is actually started, either directly or after a pending request is consumed.

*Call graph*: called by 2 (advance_auto_compact_window_id, start_new_context_window_if_requested).


##### `AutoCompactWindow::request_new_context_window`  (lines 53–55)

```
fn request_new_context_window(&mut self)
```

**Purpose**: Marks that the current flow wants to start a new context window at the next appropriate boundary.

**Data flow**: Sets `self.new_context_window_requested = true`; returns `()`.

**Call relations**: Invoked by higher-level logic that decides compaction should roll over into a fresh window.

*Call graph*: called by 1 (request_new_context_window).


##### `AutoCompactWindow::take_new_context_window_request`  (lines 57–61)

```
fn take_new_context_window_request(&mut self) -> bool
```

**Purpose**: Returns whether a new-window request was pending and clears the request flag.

**Data flow**: Reads `self.new_context_window_requested` into a local, resets the field to `false`, and returns the saved boolean.

**Call relations**: Used by the code that conditionally starts a new context window so the request is consumed exactly once.

*Call graph*: called by 1 (start_new_context_window_if_requested).


##### `AutoCompactWindow::ensure_server_observed_prefill_from_usage`  (lines 66–77)

```
fn ensure_server_observed_prefill_from_usage(&mut self, usage: &TokenUsage)
```

**Purpose**: Stores the first authoritative request-input token baseline observed from server usage, ignoring later attempts once such a baseline exists.

**Data flow**: Reads `self.prefill_input_tokens`; if it is already `Some(ServerObserved(_))`, returns early. Otherwise reads `usage.input_tokens`, clamps it to non-negative with `.max(0)`, wraps it in `AutoCompactWindowPrefill::ServerObserved`, and stores it.

**Call relations**: Called when server token usage arrives so estimated baselines can be replaced by authoritative data exactly once.

*Call graph*: called by 1 (ensure_auto_compact_window_server_prefill_from_usage); 2 external calls (ServerObserved, matches!).


##### `AutoCompactWindow::set_estimated_prefill`  (lines 79–88)

```
fn set_estimated_prefill(&mut self, tokens: i64)
```

**Purpose**: Stores a non-negative estimated prefill baseline unless an authoritative server-observed baseline is already present.

**Data flow**: Reads `self.prefill_input_tokens`; if it is already `Some(ServerObserved(_))`, returns early. Otherwise clamps `tokens` to non-negative with `.max(0)`, wraps it in `AutoCompactWindowPrefill::Estimated`, and stores it.

**Call relations**: Used by resume/recompute paths that can estimate the baseline before server usage is available.

*Call graph*: called by 1 (set_auto_compact_window_estimated_prefill); 2 external calls (Estimated, matches!).


##### `AutoCompactWindow::snapshot`  (lines 90–99)

```
fn snapshot(&self) -> AutoCompactWindowSnapshot
```

**Purpose**: Produces a public snapshot of the current prefill baseline without exposing whether it was estimated or server-observed.

**Data flow**: Reads `self.prefill_input_tokens`, maps either enum variant to `Some(tokens)` or `None`, and returns `AutoCompactWindowSnapshot { prefill_input_tokens }`.

**Call relations**: Called by higher-level state accessors that need a serializable/read-only view of the current window accounting state.

*Call graph*: called by 1 (auto_compact_window_snapshot).


##### `tests::tracks_prefill_and_window_boundaries`  (lines 108–161)

```
fn tracks_prefill_and_window_boundaries()
```

**Purpose**: Verifies the intended state transitions for window ids, pending rollover requests, and prefill precedence between estimated and server-observed values.

**Data flow**: Creates a new window, mutates it through `set_window_id`, request/take/advance operations, `set_estimated_prefill`, and `ensure_server_observed_prefill_from_usage` with synthetic `TokenUsage` values, then asserts the resulting ids, flags, and snapshots at each step.

**Call relations**: Unit test covering the core invariants of the `AutoCompactWindow` state machine.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert!, assert_eq!).


### `core/src/tasks/mod.rs`

`orchestration` · `cross-cutting task startup, execution, completion, interruption, and idle wakeups`

This module is the hub for all session task execution. It declares the task submodules, exports concrete task types, defines `SessionTask` as the typed async trait implemented by workflows like regular chat, review, and shell commands, and erases that trait behind `AnySessionTask` so heterogeneous tasks can be stored in `RunningTask`. `SessionTaskContext` is a narrow wrapper exposing only the `Arc<Session>`, per-turn `ExtensionData`, auth manager, and models manager that task runners need.

The `Session` impl contains the full task lifecycle. `spawn_task` first aborts any existing task with `TurnAbortReason::Replaced`, clears connector selection, then delegates to `start_task`. `start_task` stamps timing metadata, snapshots token usage at turn start, clears guardian rejection state for the turn id, moves pending input into the active turn state, emits turn-start lifecycle hooks, creates cancellation and completion primitives, opens a tracing span with token-usage fields, and spawns the Tokio task that runs the workflow, flushes rollout state, and calls `on_task_finished` if not cancelled.

Completion logic in `on_task_finished` is dense: it detaches the task handle, drains pending input and routes each item through hook inspection/recording, computes per-turn token deltas from the start snapshot, records tracing fields, telemetry histograms/counters, and analytics facts, emits turn-stop lifecycle hooks, sends `TurnComplete`, clears guardian state, and finally clears `active_turn` only if the stored turn state still matches by `Arc::ptr_eq`. Abort logic mirrors this carefully: `handle_task_abort` cancels, waits briefly for graceful shutdown, force-aborts, runs task-specific cleanup, optionally records an interrupted-history marker based on config and multi-agent version, flushes rollout before `TurnAborted`, and emits analytics/profile data. The module also includes small helpers for compact/memory/network metrics, interrupted-turn marker generation, idle wakeup turns for mailbox-triggered work, and wrappers around unified exec process management.

#### Function details

##### `InterruptedTurnHistoryMarker::from_config_and_version`  (lines 76–88)

```
fn from_config_and_version(
        config: &Config,
        multi_agent_version: MultiAgentVersion,
    ) -> Self
```

**Purpose**: Chooses whether interrupted turns should leave no marker, a contextual-user marker, or a developer-role marker based on config and multi-agent protocol version.

**Data flow**: Reads `config.agent_interrupt_message_enabled` and the `multi_agent_version` enum. It returns `Disabled` when the feature flag is off, `Developer` for `MultiAgentVersion::V2`, and `ContextualUser` otherwise. No state is mutated.

**Call relations**: Abort handling and subagent/fork snapshot code call this to keep interruption markers consistent across real aborts and synthetic history construction. It feeds directly into `interrupted_turn_history_marker`.

*Call graph*: called by 3 (handle_task_abort, fork_thread_with_initial_history, spawn_subagent).


##### `interrupted_turn_history_marker`  (lines 93–116)

```
fn interrupted_turn_history_marker(
    marker: InterruptedTurnHistoryMarker,
) -> Option<ResponseItem>
```

**Purpose**: Builds the actual model-visible `ResponseItem` inserted into history when an interrupted turn should be represented explicitly.

**Data flow**: Consumes an `InterruptedTurnHistoryMarker` enum and matches it. It returns `None` for `Disabled`; for `ContextualUser` it constructs a contextual-user fragment from `crate::context::TurnAborted`; for `Developer` it creates a `ResponseItem::Message` with role `developer` and a single `ContentItem::InputText` containing rendered interruption guidance.

**Call relations**: This helper is used by abort handling and other history-building paths so all interruption markers share the same content and role semantics. It delegates to context constructors/rendering rather than embedding raw strings inline everywhere.

*Call graph*: calls 2 internal fn (into, new); called by 4 (handle_task_abort, append_interrupted_boundary, contextual_user_interrupted_marker, developer_interrupted_marker); 1 external calls (vec!).


##### `emit_turn_network_proxy_metric`  (lines 118–133)

```
fn emit_turn_network_proxy_metric(
    session_telemetry: &SessionTelemetry,
    network_proxy_active: bool,
    tmp_mem: (&str, &str),
)
```

**Purpose**: Records a per-turn counter indicating whether the managed network proxy was active.

**Data flow**: Takes `SessionTelemetry`, a boolean `network_proxy_active`, and an extra tag tuple `tmp_mem`. It converts the boolean to the string tag `"true"` or `"false"`, then increments `TURN_NETWORK_PROXY_METRIC` with `active` and the supplied extra tag. It returns `()`.

**Call relations**: Only `Session::on_task_finished` calls this after reading current proxy configuration. It is a leaf telemetry helper used to keep metric tag formatting centralized.

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

**Purpose**: Records whether memory reads were allowed for the turn and whether the turn actually cited memories.

**Data flow**: Consumes booleans for feature enablement, config enablement, and citation presence. It computes `read_allowed` as the conjunction of feature and config flags, converts all booleans through `bool_tag`, and increments `TURN_MEMORY_METRIC` with four tags. It returns `()`.

**Call relations**: This is called from `Session::on_task_finished` once turn state reveals whether memory citations occurred. It delegates only to telemetry and `bool_tag`.

*Call graph*: calls 2 internal fn (bool_tag, counter); called by 1 (on_task_finished).


##### `emit_compact_metric`  (lines 154–164)

```
fn emit_compact_metric(
    session_telemetry: &SessionTelemetry,
    compact_type: &'static str,
    manual: bool,
)
```

**Purpose**: Emits a counter for compaction runs, tagged by compaction type and whether the run was manual.

**Data flow**: Reads `compact_type` and `manual`, converts `manual` with `bool_tag`, and increments `TASK_COMPACT_METRIC` on the provided `SessionTelemetry`. It returns `()`.

**Call relations**: Compaction task code calls this when auto or manual compaction runs. It exists as a shared helper so tests can validate exact metric tags.

*Call graph*: calls 2 internal fn (bool_tag, counter); called by 1 (run_auto_compact).


##### `bool_tag`  (lines 166–168)

```
fn bool_tag(value: bool) -> &'static str
```

**Purpose**: Converts a boolean into the exact telemetry tag strings used throughout this module.

**Data flow**: Consumes `value: bool` and returns the static string slice `"true"` or `"false"`.

**Call relations**: Metric helpers call this to avoid duplicating tag formatting logic and to keep tag values stable across metrics.

*Call graph*: called by 2 (emit_compact_metric, emit_turn_memory_metric).


##### `SessionTaskContext::new`  (lines 178–183)

```
fn new(session: Arc<Session>, turn_extension_data: Arc<ExtensionData>) -> Self
```

**Purpose**: Constructs the lightweight task-facing context object from a session and per-turn extension data handle.

**Data flow**: Consumes `Arc<Session>` and `Arc<ExtensionData>` and stores them in a new `SessionTaskContext`, returning that struct by value.

**Call relations**: Task startup and abort cleanup both create this wrapper before invoking task methods. It narrows what task implementations can access without passing the entire internal session state structure around.

*Call graph*: called by 2 (handle_task_abort, start_task).


##### `SessionTaskContext::clone_session`  (lines 185–187)

```
fn clone_session(&self) -> Arc<Session>
```

**Purpose**: Returns a cloned `Arc<Session>` for task code that needs full session methods.

**Data flow**: Reads `self.session`, clones the `Arc`, and returns it. No other state changes.

**Call relations**: Concrete task implementations call this when they need to send events, record rollout items, or inspect queues. It is a simple accessor on the task context.

*Call graph*: 1 external calls (clone).


##### `SessionTaskContext::turn_extension_data`  (lines 189–191)

```
fn turn_extension_data(&self) -> Arc<ExtensionData>
```

**Purpose**: Returns the per-turn extension data handle associated with the running task.

**Data flow**: Reads `self.turn_extension_data`, clones the `Arc`, and returns it.

**Call relations**: Tasks that need to pass turn-scoped extension storage into lower-level turn execution use this accessor. It keeps ownership cheap via `Arc` cloning.

*Call graph*: 1 external calls (clone).


##### `SessionTaskContext::auth_manager`  (lines 193–195)

```
fn auth_manager(&self) -> Arc<AuthManager>
```

**Purpose**: Exposes the session's shared `AuthManager` to task implementations.

**Data flow**: Reads `self.session.services.auth_manager`, clones the `Arc`, and returns it.

**Call relations**: Subagent-spawning tasks such as review use this to authenticate delegated model calls. It is part of the intentionally small task-facing surface.

*Call graph*: 1 external calls (clone).


##### `SessionTaskContext::models_manager`  (lines 197–199)

```
fn models_manager(&self) -> SharedModelsManager
```

**Purpose**: Exposes the shared models manager used to resolve and run model backends.

**Data flow**: Reads `self.session.services.models_manager`, clones the `Arc` alias `SharedModelsManager`, and returns it.

**Call relations**: Tasks that launch delegated Codex threads or otherwise need model resolution call this accessor. It complements `auth_manager` in the task context.

*Call graph*: 1 external calls (clone).


##### `SessionTask::abort`  (lines 239–247)

```
fn abort(
        &self,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
    ) -> impl std::future::Future<Output = ()> + Send
```

**Purpose**: Provides the default no-op abort hook for task implementations that do not need extra cleanup after cancellation.

**Data flow**: Consumes task references plus `session` and `ctx`, binds them to `_` to suppress warnings, performs no work, and resolves to `()`. It does not read or mutate session state.

**Call relations**: The erased `AnySessionTask::abort` adapter and `Session::handle_task_abort` invoke this when a task is cancelled. Concrete tasks override it only when they need explicit teardown behavior.

*Call graph*: called by 1 (abort).


##### `T::kind`  (lines 274–276)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Implements `AnySessionTask::kind` by forwarding to the concrete `SessionTask` implementation.

**Data flow**: Reads `self` and returns the `TaskKind` produced by `SessionTask::kind(self)`.

**Call relations**: This adapter is used after tasks are type-erased into `Arc<dyn AnySessionTask>` so session orchestration can still inspect task kind for state and telemetry.

*Call graph*: 1 external calls (kind).


##### `T::span_name`  (lines 278–280)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Implements `AnySessionTask::span_name` by forwarding to the concrete task's tracing span name.

**Data flow**: Reads `self` and returns the static span name from `SessionTask::span_name(self)`.

**Call relations**: Task startup uses this through the erased trait object to name the outer tracing span around the spawned task.

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

**Purpose**: Boxes the concrete task's async `run` future so heterogeneous tasks can be stored behind `AnySessionTask`.

**Data flow**: Consumes `Arc<Self>`, task context, turn context, input vector, and cancellation token; forwards them to `SessionTask::run`; wraps the resulting future in `Box::pin`; and returns `BoxFuture<'static, Option<String>>`.

**Call relations**: The spawned background task in `Session::start_task` invokes this erased method on the stored trait object. It is the key bridge from generic task implementations to runtime polymorphism.

*Call graph*: 2 external calls (pin, run).


##### `T::abort`  (lines 298–304)

```
fn abort(
        &'a self,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
    ) -> BoxFuture<'a, ()>
```

**Purpose**: Boxes the concrete task's abort future for use through the erased task trait.

**Data flow**: Borrows `self`, consumes task/session context arguments, forwards them to `SessionTask::abort`, pins the future, and returns `BoxFuture<'a, ()>`.

**Call relations**: Abort orchestration calls this on the erased task object after cancellation and forced handle abort. It preserves task-specific cleanup behavior across type erasure.

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

**Purpose**: Starts a new task as the active turn after first replacing any currently running task.

**Data flow**: Consumes the session `Arc`, turn context, input, and a concrete task. It first awaits `abort_all_tasks(TurnAbortReason::Replaced)`, then clears connector selection, then forwards the same turn context, input, and task into `start_task`. It returns `()`.

**Call relations**: Higher-level request handlers call this when explicit user work should supersede any current turn. It sequences replacement semantics before delegating to the common startup path.

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

**Purpose**: Initializes active-turn state, lifecycle hooks, tracing, cancellation, and the spawned Tokio future for a concrete session task.

**Data flow**: Consumes the session `Arc`, `Arc<TurnContext>`, input vector, and concrete task. It type-erases the task, reads its kind/span name, timestamps the turn start, stores start time in turn metadata, snapshots total token usage, creates a `CancellationToken` and `Notify`, clears guardian rejection state for the turn id, moves pending input from the queue into the active turn state, stores `token_usage_at_turn_start`, emits turn-start lifecycle hooks, creates a task-owned tracing span, spawns an async block that runs the task, flushes rollout, optionally calls `on_task_finished`, and notifies completion waiters. Finally it stores a `RunningTask` with handle, cancellation token, timer, guard, contexts, and extension data into `active_turn.task`.

**Call relations**: This is the common startup path used by explicit `spawn_task` and synthetic wakeup turns. It delegates to task trait methods for actual workflow execution, to lifecycle emission for extension hooks, and later to `on_task_finished` for uniform completion handling.

*Call graph*: calls 1 internal fn (new); called by 2 (maybe_start_turn_for_pending_work_with_sub_id, spawn_task); 15 external calls (new, clone, new, new, now, new, kind, span_name, debug_assert!, format! (+5 more)).


##### `Session::maybe_start_turn_for_pending_work`  (lines 453–456)

```
async fn maybe_start_turn_for_pending_work(self: &Arc<Self>)
```

**Purpose**: Creates a fresh synthetic sub-id and attempts to start a regular turn if queued mailbox work should wake an idle session.

**Data flow**: Generates a UUID string and passes it to `maybe_start_turn_for_pending_work_with_sub_id`. It returns `()`.

**Call relations**: Abort paths call this after interrupted turns so trigger-turn mailbox items can resume processing. It is just a convenience wrapper around the explicit-sub-id variant.

*Call graph*: calls 1 internal fn (maybe_start_turn_for_pending_work_with_sub_id); called by 2 (abort_all_tasks, abort_turn_if_active); 1 external calls (new_v4).


##### `Session::maybe_start_turn_for_pending_work_with_sub_id`  (lines 463–484)

```
async fn maybe_start_turn_for_pending_work_with_sub_id(
        self: &Arc<Self>,
        sub_id: String,
    )
```

**Purpose**: Starts an idle-session regular task only when trigger-turn mailbox items exist and no active turn is already present.

**Data flow**: Reads `self.input_queue.has_trigger_turn_mailbox_items()`, then locks `self.active_turn`. If no trigger items exist or an active turn already exists, it returns early. Otherwise it installs `Some(ActiveTurn::default())`, creates a default turn context with the supplied `sub_id`, emits any unknown-model warning for that turn, and starts `RegularTask::new()` with empty input via `start_task`.

**Call relations**: This is used by the UUID wrapper and by interruption recovery. It gates synthetic wakeups carefully so mailbox-triggered work does not race with already-running turns.

*Call graph*: calls 3 internal fn (default, start_task, new); called by 1 (maybe_start_turn_for_pending_work); 1 external calls (new).


##### `Session::abort_all_tasks`  (lines 486–514)

```
async fn abort_all_tasks(self: &Arc<Self>, reason: TurnAbortReason)
```

**Purpose**: Cancels and cleans up the current active task, emits abort lifecycle hooks, clears pending approvals/input, and optionally wakes queued work after interruptions.

**Data flow**: Consumes an abort `reason`. It removes the current `ActiveTurn` via `take_active_turn`, extracts any `RunningTask`, remembers whether a task existed and its `TurnContext`, and if present delegates to `handle_task_abort`. Afterward it emits turn-abort lifecycle hooks using the turn extension data, clears pending input from the removed active turn when a task was actually aborted, and if the reason is `Interrupted` starts pending mailbox work. It returns `()`.

**Call relations**: Replacement startup calls this first, and it is the broad 'cancel whatever is running' path. It delegates the detailed cancellation mechanics to `handle_task_abort` and then performs session-level cleanup and wakeup decisions.

*Call graph*: calls 3 internal fn (handle_task_abort, maybe_start_turn_for_pending_work, take_active_turn); called by 1 (spawn_task); 1 external calls (clone).


##### `Session::abort_turn_if_active`  (lines 516–555)

```
async fn abort_turn_if_active(
        self: &Arc<Self>,
        turn_id: &str,
        reason: TurnAbortReason,
    ) -> bool
```

**Purpose**: Cancels a specific active turn only if its current task's sub-id matches the requested turn id.

**Data flow**: Locks `self.active_turn`, checks whether the stored running task exists and its `turn_context.sub_id` equals `turn_id`, and if so removes that `ActiveTurn`; otherwise returns `false`. For a matched turn it extracts the task, delegates to `handle_task_abort`, emits turn-abort lifecycle hooks, clears pending input, optionally wakes pending work on interruption, and returns `true`.

**Call relations**: This is the targeted abort path used when callers know which turn should be cancelled. Its flow mirrors `abort_all_tasks` but adds turn-id matching before taking ownership of the active turn.

*Call graph*: calls 2 internal fn (handle_task_abort, maybe_start_turn_for_pending_work); 1 external calls (clone).


##### `Session::on_task_finished`  (lines 557–775)

```
async fn on_task_finished(
        self: &Arc<Self>,
        turn_context: Arc<TurnContext>,
        last_agent_message: Option<String>,
    )
```

**Purpose**: Finalizes a successfully completed task: drains pending input, records metrics and analytics, emits stop lifecycle hooks and `TurnComplete`, clears active-turn state, and possibly emits thread-idle lifecycle.

**Data flow**: Consumes the session `Arc`, completed `TurnContext`, and optional final agent message. It cancels git enrichment, removes the running task from `active_turn` and detaches its handle, obtains the shared `turn_state`, drains pending input for that state, reads memory-citation/tool-call/token-start fields from the turn state, and routes each pending input item through `inspect_pending_input` followed by either `record_additional_contexts` or `record_pending_input`. It then reads network proxy state, emits proxy/tool/token telemetry, computes per-turn token deltas from current total usage minus the start snapshot with floor-at-zero semantics, records those values into the current tracing span and analytics, emits memory telemetry, computes completion timing/profile data, emits turn-stop lifecycle hooks, sends `EventMsg::TurnComplete`, clears guardian rejection state, and finally clears `active_turn` only if the stored turn state pointer still matches. If clearing succeeds, it calls `emit_thread_idle_lifecycle_if_idle`.

**Call relations**: The spawned task body in `start_task` calls this only when the task was not cancelled. It is the uniform completion sink for all task types and delegates to hook-runtime helpers, telemetry helpers, lifecycle emission, analytics clients, and event sending.

*Call graph*: calls 5 internal fn (inspect_pending_input, record_additional_contexts, record_pending_input, emit_turn_memory_metric, emit_turn_network_proxy_metric); 5 external calls (ptr_eq, current, try_from, TurnComplete, warn!).


##### `Session::take_active_turn`  (lines 777–780)

```
async fn take_active_turn(&self) -> Option<ActiveTurn>
```

**Purpose**: Atomically removes and returns the current `ActiveTurn` from session state.

**Data flow**: Locks `self.active_turn`, calls `take()` on the `Option<ActiveTurn>`, and returns the removed value if any.

**Call relations**: Only `abort_all_tasks` uses this helper to gain ownership of the active turn before cancellation. It centralizes the mutex-and-take pattern.

*Call graph*: called by 1 (abort_all_tasks).


##### `Session::close_unified_exec_processes`  (lines 782–787)

```
async fn close_unified_exec_processes(&self)
```

**Purpose**: Terminates all background processes managed by the unified exec manager for this session.

**Data flow**: Reads `self.services.unified_exec_manager` and awaits `terminate_all_processes()`. It returns `()`.

**Call relations**: This is a session utility invoked by higher-level shutdown or cleanup flows outside this file. It delegates directly to the exec manager.


##### `Session::list_background_terminals`  (lines 789–791)

```
async fn list_background_terminals(&self) -> Vec<BackgroundTerminalInfo>
```

**Purpose**: Returns the current list of managed background terminal processes.

**Data flow**: Reads `self.services.unified_exec_manager`, awaits `list_processes()`, and returns `Vec<BackgroundTerminalInfo>`.

**Call relations**: External session APIs use this to surface background terminal state. It is a thin pass-through to the exec manager.


##### `Session::terminate_background_terminal`  (lines 793–798)

```
async fn terminate_background_terminal(&self, process_id: i32) -> bool
```

**Purpose**: Requests termination of one managed background terminal by process id.

**Data flow**: Consumes `process_id: i32`, forwards it to `self.services.unified_exec_manager.terminate_process(process_id)`, awaits the result, and returns the resulting `bool`.

**Call relations**: This supports user- or API-driven process termination and delegates entirely to the unified exec manager.


##### `Session::handle_task_abort`  (lines 800–874)

```
async fn handle_task_abort(self: &Arc<Self>, task: RunningTask, reason: TurnAbortReason)
```

**Purpose**: Performs the detailed cancellation sequence for a running task, including graceful wait, forced abort, task-specific cleanup, interrupted-history persistence, analytics, and `TurnAborted` emission.

**Data flow**: Consumes the session `Arc`, a `RunningTask`, and an abort `reason`. It reads the task sub-id, returns early if the cancellation token is already cancelled, otherwise cancels the token, cancels git enrichment, waits either for `task.done` notification or a short timeout, force-aborts the Tokio handle, constructs a `SessionTaskContext`, and awaits the task's `abort` hook. If the reason is `Interrupted`, it computes an interruption marker from config/version, records that marker into conversation history, and flushes rollout so clients can re-read it before seeing `TurnAborted`. It then computes completion timing/profile data, tracks analytics, sends `EventMsg::TurnAborted` with reason and duration, and clears guardian rejection state for the turn.

**Call relations**: Both broad and targeted abort paths delegate here once they have extracted a `RunningTask`. It is the core abort engine, coordinating cancellation primitives, task cleanup hooks, optional history mutation, analytics, and final client-visible abort events.

*Call graph*: calls 3 internal fn (from_config_and_version, new, interrupted_turn_history_marker); called by 2 (abort_all_tasks, abort_turn_if_active); 7 external calls (clone, new, TurnAborted, select!, from_ref, trace!, warn!).


### `core/src/state/turn.rs`

`data_model` · `active turn execution and turn-local async coordination`

This file introduces the state structures that exist only for the lifetime of a turn. `ActiveTurn` wraps optional `RunningTask` metadata together with an `Arc<Mutex<TurnState>>`, giving the rest of the session a synchronized handle to mutable turn state. `RunningTask` captures the live task's completion notifier, task kind (`Regular`, `Review`, or `Compact`), cancellation token, abort handle, `TurnContext`, extension data, optional `AgentExecutionGuard`, and an optional telemetry timer. `MailboxDeliveryPhase` is a small but important state machine: turns begin in `CurrentTurn`, switch to `NextTurn` after visible terminal output so late child mail stays queued, and can be reopened to `CurrentTurn` if same-turn follow-up work arrives.

`TurnState` itself is a collection of maps keyed by request IDs or call IDs, each storing a `oneshot::Sender` for a pending asynchronous interaction: review approvals, permission requests, user input, MCP elicitations keyed by `(server_name, RequestId)`, and dynamic tool responses. It also tracks queued turn input, mailbox phase, per-environment granted permissions merged with `merge_permission_profiles`, a strict-auto-review boolean, tool-call count, memory-citation presence, and token usage at turn start. The methods are intentionally narrow insert/remove/clear accessors so higher-level orchestration can coordinate asynchronous round trips without exposing the maps directly.

#### Function details

##### `ActiveTurn::default`  (lines 57–62)

```
fn default() -> Self
```

**Purpose**: Creates an empty active-turn container with no running task and a fresh default `TurnState` behind an async mutex. This is the baseline state before any turn starts.

**Data flow**: It constructs `Self { task: None, turn_state: Arc::new(Mutex::new(TurnState::default())) }` and returns it. The nested `TurnState` starts with empty pending-waiter maps and default flags/counters.

**Call relations**: Used by session initialization and many tests that need a clean active-turn scaffold. It delegates turn-state initialization to `TurnState`'s derived `Default` implementation.

*Call graph*: called by 17 (handle_request_permissions_uses_tool_call_id_for_round_trip, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, prompt_mode_waits_for_approval_when_annotations_do_not_require_approval, enable_strict_auto_review_for_turn_uses_originating_turn, request_permissions_guardian_review_stops_when_cancelled, request_permissions_routes_to_guardian_when_reviewer_is_enabled, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, notify_request_permissions_response_ignores_unmatched_call_id, record_granted_request_permissions_for_turn_uses_originating_turn (+7 more)); 3 external calls (new, new, default).


##### `TurnState::insert_pending_approval`  (lines 109–115)

```
fn insert_pending_approval(
        &mut self,
        key: String,
        tx: oneshot::Sender<ReviewDecision>,
    ) -> Option<oneshot::Sender<ReviewDecision>>
```

**Purpose**: Registers a pending review approval waiter under a string key. If a waiter already exists for that key, it returns the replaced sender.

**Data flow**: It takes an owned key and a `oneshot::Sender<ReviewDecision>`, inserts them into `pending_approvals`, and returns `Option<oneshot::Sender<ReviewDecision>>` containing any previous sender for the same key.

**Call relations**: Called when the system sends an approval request and needs to remember how to deliver the eventual decision. It is paired with `remove_pending_approval` when the response arrives or is cancelled.


##### `TurnState::remove_pending_approval`  (lines 117–122)

```
fn remove_pending_approval(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<ReviewDecision>>
```

**Purpose**: Removes and returns the pending approval sender for a given key. This is how a completed or cancelled approval round trip is resolved.

**Data flow**: It takes a string slice key, removes that entry from `pending_approvals`, and returns the removed `oneshot::Sender<ReviewDecision>` if present. The map is mutated by deletion.

**Call relations**: Used when an approval response comes back or cleanup needs to drop the waiter. It complements `insert_pending_approval`.


##### `TurnState::clear_pending_waiters`  (lines 124–130)

```
fn clear_pending_waiters(&mut self)
```

**Purpose**: Drops all pending asynchronous waiters associated with the turn. This is the bulk-cleanup path when a turn ends or is aborted.

**Data flow**: It clears `pending_approvals`, `pending_request_permissions`, `pending_user_input`, `pending_elicitations`, and `pending_dynamic_tools`. It returns `()` after emptying all five maps.

**Call relations**: Invoked during teardown/cancellation so no stale senders remain registered for a finished turn. It centralizes cleanup across all waiter categories.


##### `TurnState::insert_pending_request_permissions`  (lines 132–139)

```
fn insert_pending_request_permissions(
        &mut self,
        key: String,
        pending_request_permissions: PendingRequestPermissions,
    ) -> Option<PendingRequestPermissions>
```

**Purpose**: Registers a pending permission-request round trip under a key, storing both the response sender and the requested permission context. It returns any previous pending request for that key.

**Data flow**: It takes an owned key and a `PendingRequestPermissions` struct, inserts them into `pending_request_permissions`, and returns `Option<PendingRequestPermissions>` for any replaced entry.

**Call relations**: Called when the turn asks for additional permissions and must await a user or guardian response. It pairs with `remove_pending_request_permissions` on completion.


##### `TurnState::remove_pending_request_permissions`  (lines 141–146)

```
fn remove_pending_request_permissions(
        &mut self,
        key: &str,
    ) -> Option<PendingRequestPermissions>
```

**Purpose**: Removes and returns the pending permission-request record for a key. This resolves the stored request context once a response is available or the request is cancelled.

**Data flow**: It takes a string slice key, removes the corresponding `PendingRequestPermissions` from `pending_request_permissions`, and returns it as an `Option`.

**Call relations**: Used by permission-response handling and cleanup paths. It is the inverse of `insert_pending_request_permissions`.


##### `TurnState::insert_pending_user_input`  (lines 148–154)

```
fn insert_pending_user_input(
        &mut self,
        key: String,
        tx: oneshot::Sender<RequestUserInputResponse>,
    ) -> Option<oneshot::Sender<RequestUserInputResponse>>
```

**Purpose**: Stores a pending user-input response sender under a key. It supports asynchronous prompts that need to be answered later.

**Data flow**: It takes an owned key and a `oneshot::Sender<RequestUserInputResponse>`, inserts them into `pending_user_input`, and returns any previous sender for that key.

**Call relations**: Called when the turn emits a user-input request and needs to await the reply. It pairs with `remove_pending_user_input`.


##### `TurnState::remove_pending_user_input`  (lines 156–161)

```
fn remove_pending_user_input(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<RequestUserInputResponse>>
```

**Purpose**: Removes and returns the pending user-input sender for a key. This resolves or cancels the outstanding prompt.

**Data flow**: It takes a string slice key, removes the entry from `pending_user_input`, and returns the removed sender if present.

**Call relations**: Used when user input arrives or when turn cleanup must discard pending prompts. It complements `insert_pending_user_input`.


##### `TurnState::insert_pending_elicitation`  (lines 163–171)

```
fn insert_pending_elicitation(
        &mut self,
        server_name: String,
        request_id: RequestId,
        tx: oneshot::Sender<ElicitationResponse>,
    ) -> Option<oneshot::Sender<Elicitat
```

**Purpose**: Registers a pending MCP elicitation response sender keyed by both server name and request ID. This avoids collisions across servers issuing the same request ID.

**Data flow**: It takes an owned `server_name`, a `RequestId`, and a `oneshot::Sender<ElicitationResponse>`, inserts them into `pending_elicitations` under the tuple key `(server_name, request_id)`, and returns any previous sender for that exact tuple.

**Call relations**: Called when an MCP server asks for elicitation and the turn must await the answer asynchronously. It pairs with `remove_pending_elicitation` for response delivery.


##### `TurnState::remove_pending_elicitation`  (lines 173–180)

```
fn remove_pending_elicitation(
        &mut self,
        server_name: &str,
        request_id: &RequestId,
    ) -> Option<oneshot::Sender<ElicitationResponse>>
```

**Purpose**: Removes and returns the pending elicitation sender for a given server/request pair. It reconstructs the tuple key from borrowed inputs.

**Data flow**: It takes `&str server_name` and `&RequestId`, clones them into an owned tuple key, removes that key from `pending_elicitations`, and returns the removed `oneshot::Sender<ElicitationResponse>` if present.

**Call relations**: Used when an elicitation response arrives or cleanup needs to cancel it. It is the inverse of `insert_pending_elicitation`, with cloning needed because the map key is owned.

*Call graph*: 1 external calls (clone).


##### `TurnState::insert_pending_dynamic_tool`  (lines 182–188)

```
fn insert_pending_dynamic_tool(
        &mut self,
        key: String,
        tx: oneshot::Sender<DynamicToolResponse>,
    ) -> Option<oneshot::Sender<DynamicToolResponse>>
```

**Purpose**: Stores a pending dynamic-tool response sender under a key. This supports asynchronous completion of dynamically discovered tool calls.

**Data flow**: It takes an owned key and a `oneshot::Sender<DynamicToolResponse>`, inserts them into `pending_dynamic_tools`, and returns any previous sender for that key.

**Call relations**: Called when a dynamic tool invocation is issued and the turn must await its result. It pairs with `remove_pending_dynamic_tool`.


##### `TurnState::remove_pending_dynamic_tool`  (lines 190–195)

```
fn remove_pending_dynamic_tool(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<DynamicToolResponse>>
```

**Purpose**: Removes and returns the pending dynamic-tool sender for a key. This resolves the outstanding dynamic tool request.

**Data flow**: It takes a string slice key, removes the corresponding sender from `pending_dynamic_tools`, and returns it as an `Option`.

**Call relations**: Used by dynamic-tool response handling and turn cleanup. It complements `insert_pending_dynamic_tool`.


##### `TurnState::accept_mailbox_delivery_for_current_turn`  (lines 197–199)

```
fn accept_mailbox_delivery_for_current_turn(&mut self)
```

**Purpose**: Reopens mailbox delivery so queued child mail may still be folded into the current turn. It is a convenience wrapper for setting the mailbox phase back to `CurrentTurn`.

**Data flow**: It mutably borrows the turn state and calls `set_mailbox_delivery_phase(MailboxDeliveryPhase::CurrentTurn)`, updating the internal phase. It returns `()`.

**Call relations**: Called when same-turn follow-up work means mailbox messages should again join the current turn. It delegates the actual assignment to `set_mailbox_delivery_phase`.

*Call graph*: calls 1 internal fn (set_mailbox_delivery_phase).


##### `TurnState::accepts_mailbox_delivery_for_current_turn`  (lines 201–203)

```
fn accepts_mailbox_delivery_for_current_turn(&self) -> bool
```

**Purpose**: Reports whether mailbox deliveries are currently allowed to join the active turn. This is the read side of the mailbox-phase state machine.

**Data flow**: It compares `self.mailbox_delivery_phase` to `MailboxDeliveryPhase::CurrentTurn` and returns the resulting boolean. No mutation occurs.

**Call relations**: Used by input-queue/session logic to decide whether to drain queued child mail into the current turn or leave it for the next one. It is a pure accessor.


##### `TurnState::set_mailbox_delivery_phase`  (lines 205–207)

```
fn set_mailbox_delivery_phase(&mut self, phase: MailboxDeliveryPhase)
```

**Purpose**: Sets the mailbox-delivery phase explicitly to either `CurrentTurn` or `NextTurn`. This is the primitive state transition for mailbox behavior.

**Data flow**: It takes a `MailboxDeliveryPhase` and assigns it to `self.mailbox_delivery_phase`. No value is returned.

**Call relations**: Used directly by higher-level turn logic and indirectly by `accept_mailbox_delivery_for_current_turn`. It centralizes mailbox-phase mutation.

*Call graph*: called by 1 (accept_mailbox_delivery_for_current_turn).


##### `TurnState::record_granted_permissions`  (lines 209–223)

```
fn record_granted_permissions(
        &mut self,
        environment_id: &str,
        permissions: AdditionalPermissionProfile,
    )
```

**Purpose**: Merges newly granted permissions into the turn-local sticky permission profile for a specific environment. This lets approvals persist for the remainder of the turn.

**Data flow**: It takes an environment ID and an `AdditionalPermissionProfile`, looks up any existing profile in `granted_permissions_by_environment_id`, merges old and new via `merge_permission_profiles`, and if the merge yields `Some`, stores the merged profile back under the environment ID string.

**Call relations**: Called when a permission approval should affect subsequent tool calls within the same turn. It mirrors the session-level permission merge logic but keeps the scope turn-local.

*Call graph*: calls 1 internal fn (merge_permission_profiles).


##### `TurnState::granted_permissions`  (lines 225–232)

```
fn granted_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Returns the turn-local granted-permissions profile for a given environment, if one exists. The profile is cloned out of internal storage.

**Data flow**: It takes an environment ID string slice, looks up that key in `granted_permissions_by_environment_id`, clones the stored `AdditionalPermissionProfile` if present, and returns it as an `Option`.

**Call relations**: Used by permission-checking logic during the active turn to reuse previously granted permissions. It is a pure lookup.


##### `TurnState::enable_strict_auto_review`  (lines 234–236)

```
fn enable_strict_auto_review(&mut self)
```

**Purpose**: Turns on strict auto-review mode for the current turn. Once enabled, later checks can force more conservative review routing.

**Data flow**: It mutably borrows the turn state and sets `strict_auto_review_enabled` to `true`. It returns `()`.

**Call relations**: Called by turn setup or policy logic when the originating context requires stricter review behavior. It is paired with the boolean accessor.


##### `TurnState::strict_auto_review_enabled`  (lines 238–240)

```
fn strict_auto_review_enabled(&self) -> bool
```

**Purpose**: Returns whether strict auto-review mode is enabled for this turn. This exposes the turn-local review policy flag to callers.

**Data flow**: It reads `self.strict_auto_review_enabled` and returns the boolean. No mutation occurs.

**Call relations**: Used by review/permission routing logic to decide whether to escalate or constrain automatic approvals. It is a pure accessor.


### `code-mode/src/service.rs`

`orchestration` · `request handling, cell lifecycle management, and shutdown`

This file is the top-level service layer above the raw runtime thread. `CodeModeService` owns shared session state in `Inner`: session-scoped stored values, the live-cell map, the delegate used for nested tool calls and notifications, a shutdown flag, and an atomic cell-id counter. `InProcessCodeModeSessionProvider` exposes the service through the protocol trait, while `NoopCodeModeSessionDelegate` provides a default delegate that never executes nested tools and silently accepts notifications.

Starting execution goes through `CodeModeService::execute` or `execute_to_pending`, both of which allocate a fresh `CellId`, create a oneshot for the initial response, and call `start_cell`. `start_cell` snapshots current stored values, spawns a runtime via `spawn_runtime`, records a `CellHandle` containing control/runtime senders plus cancellation state, and launches `run_cell_control` as a Tokio task. `run_cell_control` is the heart of the file: it multiplexes runtime events, observer commands (`Poll`, `PollToPending`, `Terminate`), yield timers, and spawned delegate tasks. It buffers `FunctionCallOutputContentItem`s, tracks pending tool-call ids in paused mode, forwards `Notify` and `ToolCall` events to delegate tasks, resumes or terminates paused runtimes through `RuntimeControlCommand`, and only responds to termination after the runtime has actually closed and callback tasks have been drained or cancelled.

The helper functions around it encode protocol details: missing-cell responses are distinct from runtime-produced errors, only one active observer is allowed per cell, completed results may be buffered until a waiter arrives, and stored-value writes are committed back into the session only after successful callback cleanup on natural completion. `shutdown` and `Drop` both aggressively cancel all cells and wait for the live-cell map to empty, ensuring session teardown propagates into running runtimes.

#### Function details

##### `NoopCodeModeSessionDelegate::invoke_tool`  (lines 44–53)

```
fn invoke_tool(
        &'a self,
        _invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Implements the default nested-tool delegate by waiting for cancellation and then returning a fixed error indicating nested tools are unavailable.

**Data flow**: Ignores the `CodeModeNestedToolCall`, awaits `cancellation_token.cancelled()`, and then returns `Err("code mode nested tools are unavailable".to_string())` from the boxed future.

**Call relations**: Used when `CodeModeService::new` constructs a service without a custom delegate. `run_cell_control` may spawn this future in response to `RuntimeEvent::ToolCall`, but it will only complete once the cell is cancelled.

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

**Purpose**: Implements the default notification delegate as a no-op that always succeeds.

**Data flow**: Ignores call id, cell id, text, and cancellation token, and returns a boxed future that resolves to `Ok(())` immediately.

**Call relations**: Used by default services when `run_cell_control` spawns notification tasks for `RuntimeEvent::Notify`.

*Call graph*: 1 external calls (pin).


##### `NoopCodeModeSessionDelegate::cell_closed`  (lines 65–65)

```
fn cell_closed(&self, _cell_id: &CellId)
```

**Purpose**: Provides a no-op hook for cell closure in the default delegate.

**Data flow**: Accepts a `&CellId` and performs no reads, writes, or return-value computation.

**Call relations**: Called by `run_cell_control` during final cleanup after removing the cell from the live-cell map.


##### `InProcessCodeModeSessionProvider::create_session`  (lines 72–81)

```
fn create_session(
        &'a self,
        delegate: Arc<dyn CodeModeSessionDelegate>,
    ) -> CodeModeSessionProviderFuture<'a>
```

**Purpose**: Creates a new in-process `CodeModeService` wrapped as a trait object session using the supplied delegate.

**Data flow**: Accepts an `Arc<dyn CodeModeSessionDelegate>`, constructs `CodeModeService::with_delegate(delegate)`, wraps it in `Arc<dyn CodeModeSession>`, and returns it from a boxed async future as `Ok(session)`.

**Call relations**: Invoked through the `CodeModeSessionProvider` trait by higher-level code that needs a session instance. It is a thin factory over `CodeModeService::with_delegate`.

*Call graph*: calls 1 internal fn (with_delegate); 2 external calls (new, pin).


##### `CodeModeService::new`  (lines 105–107)

```
fn new() -> Self
```

**Purpose**: Constructs a service with the built-in no-op delegate.

**Data flow**: Allocates `Arc::new(NoopCodeModeSessionDelegate)` and forwards it to `CodeModeService::with_delegate`, returning the resulting service.

**Call relations**: Used by many tests and by `Default::default`. It is the convenience constructor for standalone in-process sessions.

*Call graph*: called by 29 (date_locale_string_formats_with_icu_data, execute_to_pending_excludes_delayed_timeout_tool_calls_until_wait, execute_to_pending_identifies_tool_calls_in_paused_frontier, execute_to_pending_returns_completed_for_synchronous_results, execute_to_pending_returns_once_the_runtime_is_quiescent, generated_image_helper_appends_image_and_output_hint, image_helper_accepts_low_detail, image_helper_accepts_raw_mcp_image_block_with_original_detail, image_helper_rejects_raw_mcp_result_container, image_helper_rejects_unsupported_detail (+15 more)); 2 external calls (new, with_delegate).


##### `CodeModeService::with_delegate`  (lines 109–119)

```
fn with_delegate(delegate: Arc<dyn CodeModeSessionDelegate>) -> Self
```

**Purpose**: Constructs a service around a caller-provided delegate and initializes all shared session state.

**Data flow**: Builds an `Inner` containing empty `stored_values` and `cells` mutex-protected maps, the provided delegate, `shutting_down = false`, and `next_cell_id = 1`, wraps it in `Arc`, and returns `CodeModeService { inner }`.

**Call relations**: Called by `CodeModeService::new` and `InProcessCodeModeSessionProvider::create_session`, and used directly in tests that need custom delegate behavior.

*Call graph*: called by 5 (create_session, natural_completion_cleans_up_callbacks_before_responding, repeated_termination_is_rejected_while_callback_cleanup_is_pending, termination_cancels_pending_callbacks_before_responding, new); 5 external calls (new, new, new, new, new).


##### `CodeModeService::allocate_cell_id`  (lines 121–128)

```
fn allocate_cell_id(&self) -> CellId
```

**Purpose**: Generates a fresh `CellId` string from the session’s atomic counter.

**Data flow**: Fetches and increments `inner.next_cell_id` with `Ordering::Relaxed`, converts the previous numeric value to a string, and wraps it in `CellId::new`.

**Call relations**: Called by both `CodeModeService::execute` and `CodeModeService::execute_to_pending` before starting a new cell.

*Call graph*: calls 1 internal fn (new); called by 2 (execute, execute_to_pending).


##### `CodeModeService::execute_to_pending`  (lines 149–167)

```
async fn execute_to_pending(
        &self,
        request: ExecuteRequest,
    ) -> Result<ExecuteToPendingOutcome, String>
```

**Purpose**: Starts a cell in pause-until-resumed mode and waits for either immediate completion or the first quiescent frontier.

**Data flow**: Creates a oneshot response channel, allocates a cell id, calls `start_cell` with `CellResponseSender::ExecuteToPending`, no initial yield timer, and `PendingRuntimeMode::PauseUntilResumed`, then awaits the oneshot and maps channel closure to `"exec runtime ended unexpectedly"`.

**Call relations**: Public API used when callers want a pending frontier instead of a timed yield. It delegates startup to `start_cell`; the actual frontier detection happens later inside `run_cell_control` in response to `RuntimeEvent::Pending`.

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

**Purpose**: Creates all channels and bookkeeping for a new cell, spawns the runtime thread, records the live cell handle, and launches the async cell-control task.

**Data flow**: Accepts a chosen `CellId`, `ExecuteRequest`, initial response sender, optional initial yield time, and pending mode. It creates unbounded Tokio channels for runtime events and cell-control commands, clones the current session `stored_values`, creates a `CancellationToken`, then locks `inner.cells` to reject startup during shutdown or duplicate cell ids. Inside that lock it calls `spawn_runtime`, inserts a `CellHandle { control_tx, runtime_tx, cancellation_token, termination_requested }` into the map, and captures the runtime control sender and isolate handle. Finally it `tokio::spawn`s `run_cell_control(...)` with a `CellControlContext` and returns `Ok(())`.

**Call relations**: Called by `CodeModeService::execute` and `CodeModeService::execute_to_pending`. It is the handoff point between synchronous session bookkeeping and the long-lived `run_cell_control` task.

*Call graph*: calls 2 internal fn (spawn_runtime, run_cell_control); called by 2 (execute, execute_to_pending); 8 external calls (clone, new, new, new, clone, format!, unbounded_channel, spawn).


##### `CodeModeService::begin_wait`  (lines 228–249)

```
async fn begin_wait(
        &self,
        request: WaitRequest,
    ) -> CodeModeSessionResultFuture<'static, WaitOutcome>
```

**Purpose**: Starts an asynchronous wait operation for an existing cell by sending a poll command to its control task and returning a future for the eventual response.

**Data flow**: Destructures `WaitRequest` into `cell_id` and `yield_time_ms`, looks up and clones the `CellHandle` from `inner.cells`, and returns `missing_wait(cell_id)` if absent. Otherwise it creates a oneshot channel, sends `CellControlCommand::Poll { yield_time_ms, response_tx }` over `handle.control_tx`, falling back to `missing_wait(cell_id)` if the control task is gone, and returns `wait_for_response(cell_id, response_rx)`.

**Call relations**: Called by `CodeModeService::wait`. It does not await the result itself; instead it packages the control-task interaction into a protocol future.

*Call graph*: calls 2 internal fn (missing_wait, wait_for_response); called by 1 (wait); 1 external calls (channel).


##### `CodeModeService::wait_to_pending`  (lines 279–307)

```
async fn wait_to_pending(
        &self,
        request: WaitToPendingRequest,
    ) -> Result<WaitToPendingOutcome, String>
```

**Purpose**: Requests that an existing paused cell resume until it reaches the next quiescent frontier or completion, then returns that outcome.

**Data flow**: Looks up the `CellHandle` for `request.cell_id`; if absent, returns `WaitToPendingOutcome::MissingCell(missing_cell_response(cell_id))`. Otherwise creates a oneshot, sends `CellControlCommand::PollToPending { response_tx }`, and awaits the response. It maps `Ok(Ok(response))` to `LiveCell(response)`, `Ok(Err(error_text))` to `Err(error_text)`, and channel closure to `MissingCell(missing_cell_response(cell_id))`.

**Call relations**: Public API for continuing a previously paused runtime. It relies on `run_cell_control` to resume the runtime and decide whether the next response is another pending frontier or a completed result.

*Call graph*: calls 1 internal fn (missing_cell_response); 3 external calls (LiveCell, MissingCell, channel).


##### `CodeModeService::default`  (lines 335–337)

```
fn default() -> Self
```

**Purpose**: Implements `Default` by constructing a new service with the no-op delegate.

**Data flow**: Calls `CodeModeService::new()` and returns the resulting service.

**Call relations**: Used wherever a default service instance is desired without explicitly naming the constructor.

*Call graph*: 1 external calls (new).


##### `CodeModeService::drop`  (lines 341–353)

```
fn drop(&mut self)
```

**Purpose**: Best-effort emergency teardown that marks the session as shutting down and signals all currently tracked cells to terminate.

**Data flow**: Sets `inner.shutting_down = true`, attempts a non-blocking `try_lock()` on `inner.cells`, and for each live handle cancels its token, creates and discards a oneshot sender for `CellControlCommand::Terminate`, sends that terminate command, and sends `RuntimeCommand::Terminate` directly to the runtime thread.

**Call relations**: Runs automatically when the service is dropped. It mirrors `shutdown` but cannot await completion, so it performs only fire-and-forget signalling.

*Call graph*: 1 external calls (channel).


##### `CodeModeService::is_alive`  (lines 357–359)

```
fn is_alive(&self) -> bool
```

**Purpose**: Reports whether the session has not yet begun shutdown.

**Data flow**: Reads `inner.shutting_down` with `Ordering::Acquire` and returns its negation.

**Call relations**: Implements the `CodeModeSession` trait’s liveness check for callers holding the service as a trait object.


##### `CodeModeService::execute`  (lines 361–366)

```
fn execute(
        &'a self,
        request: ExecuteRequest,
    ) -> CodeModeSessionResultFuture<'a, StartedCell>
```

**Purpose**: Starts a cell in normal continue mode and returns a `StartedCell` whose initial response resolves to the first yield or final result.

**Data flow**: Checks `inner.shutting_down` and returns an error if shutdown has begun. Computes `initial_yield_time_ms` from `request.yield_time_ms` or `DEFAULT_EXEC_YIELD_TIME_MS`, creates a oneshot channel, allocates a cell id, calls `start_cell` with `CellResponseSender::Runtime`, that initial yield time, and `PendingRuntimeMode::Continue`, then wraps the receiver in `StartedCell::from_result_receiver(cell_id, response_rx)`.

**Call relations**: This is both the service’s inherent async method and the implementation target for the trait method below. It delegates all runtime startup to `start_cell`; the returned `StartedCell` is later awaited by callers.

*Call graph*: calls 3 internal fn (from_result_receiver, allocate_cell_id, start_cell); called by 1 (execute); 3 external calls (pin, Runtime, channel).


##### `CodeModeService::wait`  (lines 368–370)

```
fn wait(&'a self, request: WaitRequest) -> CodeModeSessionResultFuture<'a, WaitOutcome>
```

**Purpose**: Implements the trait-level wait API by delegating to `begin_wait` and awaiting the returned future.

**Data flow**: Accepts a `WaitRequest`, calls `self.begin_wait(request).await` to obtain a boxed future, then awaits that future and returns its `Result<WaitOutcome, String>`.

**Call relations**: Public wait API and trait implementation entrypoint. It exists mainly to bridge the two-stage `begin_wait` helper into a single async method.

*Call graph*: calls 1 internal fn (begin_wait); 1 external calls (pin).


##### `CodeModeService::terminate`  (lines 372–374)

```
fn terminate(&'a self, cell_id: CellId) -> CodeModeSessionResultFuture<'a, WaitOutcome>
```

**Purpose**: Requests termination of a live cell, ensuring only one termination is in flight and waiting for the control task’s final response.

**Data flow**: Looks up the `CellHandle` by `cell_id`; if absent, returns `WaitOutcome::MissingCell(missing_cell_response(cell_id))`. Uses `termination_requested.compare_exchange(false, true, ...)` to reject repeated termination attempts with `already_terminating_error`. Creates a oneshot, sends `CellControlCommand::Terminate { response_tx }`, resetting the atomic flag and returning missing-cell if the control task is already gone. Then awaits the oneshot and maps success to `WaitOutcome::LiveCell`, explicit error text to `Err`, and channel closure to missing-cell.

**Call relations**: Public termination API and trait implementation entrypoint. It relies on `run_cell_control` to actually cancel callbacks, stop the runtime, and decide when it is safe to respond.

*Call graph*: calls 2 internal fn (already_terminating_error, missing_cell_response); 4 external calls (pin, LiveCell, MissingCell, channel).


##### `CodeModeService::shutdown`  (lines 376–378)

```
fn shutdown(&'a self) -> CodeModeSessionResultFuture<'a, ()>
```

**Purpose**: Begins session shutdown, signals every live cell to terminate, and waits until the live-cell map becomes empty.

**Data flow**: Sets `inner.shutting_down = true`, clones all current `CellHandle`s from `inner.cells`, and for each one cancels its token, sends `CellControlCommand::Terminate` with a throwaway oneshot sender, and sends `RuntimeCommand::Terminate` directly. It then loops, yielding with `tokio::task::yield_now()` until `inner.cells` is empty, and returns `Ok(())`.

**Call relations**: Public shutdown API and trait implementation entrypoint. It coordinates with `run_cell_control`, which removes cells from the map during final cleanup.

*Call graph*: 3 external calls (pin, channel, yield_now).


##### `missing_cell_response`  (lines 413–419)

```
fn missing_cell_response(cell_id: CellId) -> RuntimeResponse
```

**Purpose**: Builds the standardized `RuntimeResponse::Result` payload used when a requested cell id does not exist.

**Data flow**: Accepts a `CellId` and returns `RuntimeResponse::Result { error_text: Some(format!("exec cell {cell_id} not found")), cell_id, content_items: Vec::new() }`.

**Call relations**: Used by `terminate`, `wait_to_pending`, `missing_wait`, and `wait_for_response` so missing-cell handling is distinct from runtime-generated failures.

*Call graph*: called by 4 (terminate, wait_to_pending, missing_wait, wait_for_response); 2 external calls (new, format!).


##### `missing_wait`  (lines 421–423)

```
fn missing_wait(cell_id: CellId) -> CodeModeSessionResultFuture<'static, WaitOutcome>
```

**Purpose**: Produces an already-resolved wait future representing a missing cell.

**Data flow**: Captures `cell_id` into a boxed async block that returns `Ok(WaitOutcome::MissingCell(missing_cell_response(cell_id)))`.

**Call relations**: Returned by `begin_wait` when the cell is absent or its control task can no longer receive commands.

*Call graph*: calls 1 internal fn (missing_cell_response); called by 1 (begin_wait); 2 external calls (pin, MissingCell).


##### `wait_for_response`  (lines 425–436)

```
fn wait_for_response(
    cell_id: CellId,
    response_rx: oneshot::Receiver<Result<RuntimeResponse, String>>,
) -> CodeModeSessionResultFuture<'static, WaitOutcome>
```

**Purpose**: Wraps a oneshot receiver from the control task into the protocol’s boxed wait future shape.

**Data flow**: Captures `cell_id` and `response_rx` into a boxed async block. When awaited, it maps `Ok(Ok(response))` to `WaitOutcome::LiveCell(response)`, `Ok(Err(error_text))` to `Err(error_text)`, and receiver closure to `WaitOutcome::MissingCell(missing_cell_response(cell_id))`.

**Call relations**: Returned by `begin_wait` after a `Poll` command is successfully sent to `run_cell_control`.

*Call graph*: calls 1 internal fn (missing_cell_response); called by 1 (begin_wait); 3 external calls (pin, LiveCell, MissingCell).


##### `busy_observer_error`  (lines 438–440)

```
fn busy_observer_error(cell_id: &CellId) -> String
```

**Purpose**: Formats the error returned when a cell already has an active waiter or termination observer.

**Data flow**: Accepts `&CellId` and returns `format!("exec cell {cell_id} already has an active observer")`.

**Call relations**: Used inside `run_cell_control` when a new `Poll` or `PollToPending` arrives while another response channel is still active.

*Call graph*: 1 external calls (format!).


##### `already_terminating_error`  (lines 442–444)

```
fn already_terminating_error(cell_id: &CellId) -> String
```

**Purpose**: Formats the error returned when termination has already been requested for a cell.

**Data flow**: Accepts `&CellId` and returns `format!("exec cell {cell_id} is already terminating")`.

**Call relations**: Used by `CodeModeService::terminate` and also by `run_cell_control` when a second terminate command arrives while one is already pending.

*Call graph*: called by 1 (terminate); 1 external calls (format!).


##### `pending_result_response`  (lines 446–452)

```
fn pending_result_response(cell_id: &CellId, result: PendingResult) -> RuntimeResponse
```

**Purpose**: Converts an internally buffered `PendingResult` into the protocol `RuntimeResponse::Result` for a specific cell.

**Data flow**: Accepts `&CellId` and `PendingResult { content_items, error_text }`, clones the cell id, and returns `RuntimeResponse::Result { cell_id, content_items, error_text }`.

**Call relations**: Used by `send_or_buffer_result` and by control-command handling in `run_cell_control` when a completed result was buffered before an observer arrived.

*Call graph*: called by 1 (send_or_buffer_result); 1 external calls (clone).


##### `send_terminal_response`  (lines 454–463)

```
fn send_terminal_response(response_tx: CellResponseSender, response: RuntimeResponse)
```

**Purpose**: Sends a completed runtime response through either the normal execute/wait channel or the execute-to-pending channel.

**Data flow**: Matches on `CellResponseSender`. For `Runtime`, sends `Ok(response)` directly on the oneshot. For `ExecuteToPending`, wraps the response as `Ok(ExecuteToPendingOutcome::Completed(response))` and sends that.

**Call relations**: Called by `send_or_buffer_result` and `send_termination_responses` to unify terminal-response delivery across the two initial-response modes.

*Call graph*: called by 2 (send_or_buffer_result, send_termination_responses); 2 external calls (Completed, send).


##### `send_termination_responses`  (lines 465–476)

```
fn send_termination_responses(
    response_tx: Option<CellResponseSender>,
    termination_response_tx: Option<oneshot::Sender<Result<RuntimeResponse, String>>>,
    response: RuntimeResponse,
)
```

**Purpose**: Delivers a termination response to whichever observer channels are currently waiting for it.

**Data flow**: Accepts an optional general `response_tx`, an optional dedicated termination-response sender, and a `RuntimeResponse`. If the general sender exists, forwards a clone of the response through `send_terminal_response`; if the termination sender exists, sends `Ok(response)` directly on that oneshot.

**Call relations**: Used by `run_cell_control` when a cell is terminated after the runtime has closed or after callback cancellation completes.

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

**Purpose**: Either sends a completed result immediately to the current observer or stores it for a future waiter when no observer is active.

**Data flow**: Accepts the cell id, a `PendingResult`, mutable access to the optional current `response_tx`, and mutable access to the optional buffered `pending_result`. If `response_tx` is present, converts the result with `pending_result_response`, sends it via `send_terminal_response`, and returns `true`. Otherwise stores the result in `pending_result` and returns `false`.

**Call relations**: Called by `run_cell_control` when the runtime finishes or ends unexpectedly. Its boolean return tells the caller whether the control loop can exit immediately because a terminal response was delivered.

*Call graph*: calls 2 internal fn (pending_result_response, send_terminal_response).


##### `send_yield_response`  (lines 494–513)

```
fn send_yield_response(
    cell_id: &CellId,
    content_items: &mut Vec<FunctionCallOutputContentItem>,
    response_tx: &mut Option<CellResponseSender>,
)
```

**Purpose**: Sends a `RuntimeResponse::Yielded` to a normal observer, but preserves execute-to-pending observers because yielding is not a terminal response for that mode.

**Data flow**: Takes the current `response_tx` if present. For `CellResponseSender::Runtime`, sends `Ok(RuntimeResponse::Yielded { cell_id: clone, content_items: take(content_items) })`. For `CellResponseSender::ExecuteToPending`, it restores that sender back into `response_tx` unchanged so the pending-mode observer remains active.

**Call relations**: Called by `run_cell_control` when the yield timer expires or when `RuntimeEvent::YieldRequested` arrives from the runtime.

*Call graph*: 3 external calls (clone, ExecuteToPending, take).


##### `run_cell_control`  (lines 515–834)

```
async fn run_cell_control(
    inner: Arc<Inner>,
    context: CellControlContext,
    mut event_rx: mpsc::UnboundedReceiver<RuntimeEvent>,
    mut control_rx: mpsc::UnboundedReceiver<CellControlComma
```

**Purpose**: Coordinates one cell’s full lifecycle by multiplexing runtime events, observer commands, yield timing, delegate callback tasks, paused-runtime control, result buffering, and final cleanup.

**Data flow**: Consumes shared `Inner`, a `CellControlContext`, runtime event and control receivers, the initial response sender, and an optional initial yield timeout. It maintains mutable state including buffered `content_items`, `pending_tool_call_ids`, optional `pending_result`, current observer `response_tx`, optional `termination_response_tx`, flags for termination/runtime closure, an optional yield timer, and `JoinSet`s for notification and tool tasks. In a biased `tokio::select!` loop it: handles `Poll`, `PollToPending`, and `Terminate` commands; fires yield responses when the timer elapses; processes runtime events (`Started`, `Pending`, `ContentItem`, `YieldRequested`, `Notify`, `ToolCall`, `Result`); and drains completed spawned tasks. `Pending` events trigger either no-op retention of a normal observer or an `ExecuteToPendingOutcome::Pending` response with accumulated content and pending tool ids. `Notify` and `ToolCall` spawn delegate futures with child cancellation tokens; tool results are translated back into `RuntimeCommand`s sent to the runtime. On natural completion it drains notifications, cancels tool tasks, commits `stored_value_writes` into session storage, and sends or buffers the final result. On termination it cancels callbacks, waits for runtime closure before responding, and emits `RuntimeResponse::Terminated`. After the loop it sends a final runtime terminate command, cancels callbacks, terminates paused runtimes if needed, removes the cell from `inner.cells`, and calls `delegate.cell_closed`.

**Call relations**: Spawned by `CodeModeService::start_cell` and directly by one test. It is the central orchestrator tying together runtime events from `spawn_runtime`, observer commands from service APIs, and delegate callback execution; it delegates cleanup details to `finish_callbacks`, `resume_paused_runtime`, and `terminate_paused_runtime`.

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

**Purpose**: Completes outstanding notification and tool delegate tasks according to either graceful-drain or cancellation semantics.

**Data flow**: Accepts the shared `CancellationToken`, mutable `JoinSet`s for notification and tool tasks, and a `CallbackCompletion` mode. If the mode is `Cancel`, it cancels the token immediately. It then drains notification tasks, cancels the token again unconditionally, and drains tool tasks, awaiting all task completions.

**Call relations**: Called by `run_cell_control` on natural completion, runtime closure during termination, and final cleanup. It delegates the actual join-loop behavior to `drain_tasks`.

*Call graph*: calls 1 internal fn (drain_tasks); called by 1 (run_cell_control); 2 external calls (cancel, matches!).


##### `drain_tasks`  (lines 856–864)

```
async fn drain_tasks(tasks: &mut JoinSet<()>, description: &str)
```

**Purpose**: Awaits every task in a `JoinSet` and logs non-cancellation failures.

**Data flow**: Loops on `tasks.join_next().await`; for each finished task, if it returned `Err(err)` and the error is not a cancellation, logs `warn!(...)` with the provided description.

**Call relations**: Used by `finish_callbacks` for both notification and tool task sets so cleanup waits for all spawned delegate work to settle.

*Call graph*: called by 1 (finish_callbacks); 2 external calls (join_next, warn!).


##### `resume_paused_runtime`  (lines 866–873)

```
fn resume_paused_runtime(
    runtime_control_tx: &std::sync::mpsc::Sender<RuntimeControlCommand>,
    pending_mode: PendingRuntimeMode,
)
```

**Purpose**: Sends a resume control command to a paused runtime when the cell is operating in pause-until-resumed mode.

**Data flow**: Checks whether `pending_mode == PendingRuntimeMode::PauseUntilResumed`; if so, sends `RuntimeControlCommand::Resume` on `runtime_control_tx`, ignoring send failure.

**Call relations**: Called by `run_cell_control` when a `Poll` or `PollToPending` command should let a paused runtime continue processing commands.

*Call graph*: 1 external calls (send).


##### `terminate_paused_runtime`  (lines 875–882)

```
fn terminate_paused_runtime(
    runtime_control_tx: &std::sync::mpsc::Sender<RuntimeControlCommand>,
    pending_mode: PendingRuntimeMode,
)
```

**Purpose**: Sends a terminate control command to a paused runtime so it can break out of its pending wait loop.

**Data flow**: Checks whether `pending_mode == PendingRuntimeMode::PauseUntilResumed`; if so, sends `RuntimeControlCommand::Terminate` on `runtime_control_tx`, ignoring send failure.

**Call relations**: Called by `run_cell_control` during termination handling and final cleanup to ensure a paused runtime thread is not left blocked waiting for resume.

*Call graph*: called by 1 (run_cell_control); 1 external calls (send).


##### `tests::execute_request`  (lines 921–929)

```
fn execute_request(source: &str) -> ExecuteRequest
```

**Purpose**: Creates a standard `ExecuteRequest` fixture for service tests.

**Data flow**: Returns an `ExecuteRequest` with fixed `tool_call_id = "call_1"`, empty tools, the provided source, `yield_time_ms = Some(1)`, and `max_output_tokens = None`.

**Call relations**: Used throughout the test module to reduce repetitive request construction.

*Call graph*: 1 external calls (new).


##### `tests::cell_id`  (lines 931–933)

```
fn cell_id(value: &str) -> CellId
```

**Purpose**: Convenience helper that wraps a string into a `CellId` for assertions.

**Data flow**: Accepts `&str`, clones it into a `String`, and returns `CellId::new(value.to_string())`.

**Call relations**: Used by many tests to build expected cell ids succinctly.

*Call graph*: calls 1 internal fn (new).


##### `tests::execute`  (lines 935–943)

```
async fn execute(service: &CodeModeService, request: ExecuteRequest) -> RuntimeResponse
```

**Purpose**: Runs a request through the service and unwraps the full initial runtime response for assertions.

**Data flow**: Calls `service.execute(request).await.unwrap()`, then awaits `.initial_response()` on the returned `StartedCell`, unwraps that result, and returns the `RuntimeResponse`.

**Call relations**: Used by many tests as a compact end-to-end helper over the public execute API.

*Call graph*: calls 1 internal fn (execute).


##### `tests::test_inner`  (lines 945–953)

```
fn test_inner() -> Arc<Inner>
```

**Purpose**: Builds a minimal `Inner` instance for tests that invoke `run_cell_control` directly.

**Data flow**: Constructs and returns `Arc<Inner>` with empty stored-values and cells maps, a `NoopCodeModeSessionDelegate`, `shutting_down = false`, and `next_cell_id = 1`.

**Call relations**: Used by tests that bypass `CodeModeService` and exercise `run_cell_control` in isolation.

*Call graph*: 5 external calls (new, new, new, new, new).


##### `tests::synchronous_exit_returns_successfully`  (lines 956–979)

```
async fn synchronous_exit_returns_successfully()
```

**Purpose**: Verifies that calling `exit()` after emitting output ends execution cleanly without surfacing an error and without running subsequent JS statements.

**Data flow**: Creates a service, executes source `text("before"); exit(); text("after");`, awaits the response via the `execute` helper, and asserts that the result contains only the first text item and `error_text: None`.

**Call relations**: Exercises the full stack from service through runtime callbacks and module-loader exit-sentinel handling.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::stored_values_are_shared_between_cells_but_not_sessions`  (lines 982–1043)

```
async fn stored_values_are_shared_between_cells_but_not_sessions()
```

**Purpose**: Checks that `store`/`load` state persists across cells within one service instance but is isolated between separate sessions.

**Data flow**: Creates two services, executes a `store("key", "visible")` request in the first, then executes `text(String(load("key")));` in both the first and second services, and asserts that only the first session sees `"visible"` while the second sees `"undefined"`.

**Call relations**: Validates the session-scoped `inner.stored_values` behavior and the commit path from runtime `stored_value_writes` back into the service.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::shutdown_interrupts_cpu_bound_cells`  (lines 1046–1068)

```
async fn shutdown_interrupts_cpu_bound_cells()
```

**Purpose**: Ensures session shutdown can interrupt a CPU-bound infinite loop and complete promptly.

**Data flow**: Starts a service, executes `while (true) {}`, awaits the initial yielded response, then wraps `service.shutdown()` in a one-second timeout and asserts it completes successfully.

**Call relations**: Exercises `CodeModeService::shutdown`, runtime isolate termination, and cell cleanup under a non-cooperative script.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_secs, assert_eq!, execute_request, timeout).


##### `tests::start_cell_rejects_new_cell_after_shutdown_begins`  (lines 1071–1089)

```
async fn start_cell_rejects_new_cell_after_shutdown_begins()
```

**Purpose**: Verifies that `start_cell` refuses to create a new runtime once the session shutdown flag is set.

**Data flow**: Creates a service, manually sets `inner.shutting_down = true`, creates a oneshot sender, calls `start_cell(...)`, unwraps the error, and asserts both the error text and that `inner.cells` remains empty.

**Call relations**: Targets the shutdown guard inside `CodeModeService::start_cell` before any runtime is spawned or cell handle inserted.

*Call graph*: calls 1 internal fn (new); 6 external calls (assert!, assert_eq!, Runtime, cell_id, execute_request, channel).


##### `tests::execute_to_pending_returns_completed_for_synchronous_results`  (lines 1092–1114)

```
async fn execute_to_pending_returns_completed_for_synchronous_results()
```

**Purpose**: Checks that execute-to-pending returns a completed result immediately when the script finishes synchronously instead of reaching a pending frontier.

**Data flow**: Creates a service, calls `execute_to_pending` with source `text("done");`, awaits the outcome, and asserts it is `ExecuteToPendingOutcome::Completed(RuntimeResponse::Result { ... })` with the expected text item.

**Call relations**: Exercises the paused-mode startup path where `run_runtime` completes before emitting any `Pending` event.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, execute_request).


##### `tests::execute_to_pending_returns_once_the_runtime_is_quiescent`  (lines 1117–1152)

```
async fn execute_to_pending_returns_once_the_runtime_is_quiescent()
```

**Purpose**: Verifies that execute-to-pending responds when the runtime reaches a quiescent pending state after producing some output.

**Data flow**: Runs source that emits `text("before")` and then awaits forever, wraps `execute_to_pending` in a timeout, and asserts the returned outcome is `Pending` with the buffered text item and no pending tool ids. It then terminates the cell and checks for a terminated response.

**Call relations**: Exercises `RuntimeEvent::Pending` handling in `run_cell_control` for paused mode and the subsequent termination path.

*Call graph*: calls 1 internal fn (new); 5 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout).


##### `tests::execute_to_pending_identifies_tool_calls_in_paused_frontier`  (lines 1155–1199)

```
async fn execute_to_pending_identifies_tool_calls_in_paused_frontier()
```

**Purpose**: Checks that execute-to-pending reports the ids of tool calls that are outstanding at the paused frontier.

**Data flow**: Starts a service with one enabled tool and source that awaits `Promise.all([tools.echo(...), tools.echo(...)])`, awaits `execute_to_pending`, and asserts the pending outcome lists `tool-1` and `tool-2`. It then terminates the cell and checks the terminated response.

**Call relations**: Validates the `pending_tool_call_ids` accumulation logic in `run_cell_control` when `RuntimeEvent::ToolCall` arrives in paused mode.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, cell_id, execute_request, vec!).


##### `tests::execute_to_pending_excludes_delayed_timeout_tool_calls_until_wait`  (lines 1202–1281)

```
async fn execute_to_pending_excludes_delayed_timeout_tool_calls_until_wait()
```

**Purpose**: Ensures that tool calls scheduled behind a timeout are not reported in the initial paused frontier, but do appear after the runtime is resumed and reaches quiescence again.

**Data flow**: Starts a paused cell whose source schedules one delayed tool call via `setTimeout` and immediately awaits two others. It asserts the initial pending frontier lists only `tool-1` and `tool-2`, manually sends `RuntimeCommand::TimeoutFired { id: 1 }` to the runtime, then calls `wait_to_pending` and asserts the resumed frontier lists only the delayed `tool-3`. Finally it terminates the cell.

**Call relations**: Exercises the interaction among timers, paused runtime resumption, and `pending_tool_call_ids` tracking across multiple pending frontiers.

*Call graph*: calls 1 internal fn (new); 6 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout, vec!).


##### `tests::wait_to_pending_returns_after_resumed_runtime_becomes_quiescent_again`  (lines 1284–1353)

```
async fn wait_to_pending_returns_after_resumed_runtime_becomes_quiescent_again()
```

**Purpose**: Verifies that `wait_to_pending` resumes a paused runtime, lets it process a timeout and emit output, and then returns the next pending frontier with that new output.

**Data flow**: Starts a paused cell that awaits a timeout, emits `text("after")`, then awaits forever. After asserting the initial pending outcome, it manually sends `TimeoutFired { id: 1 }`, calls `wait_to_pending`, and asserts the returned live-cell outcome is another pending frontier containing the `"after"` text item. It then terminates the cell.

**Call relations**: Tests the resume path from `wait_to_pending` through `run_cell_control` and `next_runtime_command` back to a second `RuntimeEvent::Pending`.

*Call graph*: calls 1 internal fn (new); 5 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout).


##### `tests::wait_to_pending_returns_completed_after_resumed_runtime_finishes`  (lines 1356–1416)

```
async fn wait_to_pending_returns_completed_after_resumed_runtime_finishes()
```

**Purpose**: Checks that `wait_to_pending` returns a completed result rather than another pending frontier when the resumed runtime finishes execution.

**Data flow**: Starts a paused cell that awaits a timeout and then emits `text("done")` before finishing. After the initial pending outcome, it sends `TimeoutFired { id: 1 }`, calls `wait_to_pending`, and asserts the live-cell outcome wraps `ExecuteToPendingOutcome::Completed(RuntimeResponse::Result { ... })` with the expected text.

**Call relations**: Exercises the branch in `run_cell_control` where resumed execution reaches `RuntimeEvent::Result` before another `Pending` event.

*Call graph*: calls 1 internal fn (new); 5 external calls (from_secs, assert_eq!, cell_id, execute_request, timeout).


##### `tests::v8_console_is_not_exposed_on_global_this`  (lines 1419–1442)

```
async fn v8_console_is_not_exposed_on_global_this()
```

**Purpose**: Verifies that the runtime startup code removes `console` from the JS global object.

**Data flow**: Executes `text(String(Object.hasOwn(globalThis, "console")));` through a fresh service and asserts the result contains the text `"false"`.

**Call relations**: Indirectly validates `globals::install_globals` and specifically its `delete_global("console")` step.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::date_locale_string_formats_with_icu_data`  (lines 1445–1482)

```
async fn date_locale_string_formats_with_icu_data()
```

**Purpose**: Checks that locale-sensitive `Date.prototype.toLocaleString` formatting works with the ICU data loaded during V8 initialization.

**Data flow**: Executes JS that formats a fixed UTC date in `fr-FR`, emits it with `text`, and asserts the exact French localized string in the runtime result.

**Call relations**: Validates the one-time ICU initialization performed by `initialize_v8` and the runtime’s ability to use those locale features.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::intl_date_time_format_formats_with_icu_data`  (lines 1485–1521)

```
async fn intl_date_time_format_formats_with_icu_data()
```

**Purpose**: Checks that `Intl.DateTimeFormat` also uses the loaded ICU data correctly.

**Data flow**: Executes JS that constructs an `Intl.DateTimeFormat("fr-FR", ...)`, formats a fixed date, emits it with `text`, and asserts the exact localized output.

**Call relations**: Complements the previous ICU test by covering a different Intl API path through the same V8 initialization.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::output_helpers_return_undefined`  (lines 1524–1564)

```
async fn output_helpers_return_undefined()
```

**Purpose**: Verifies that `text`, `image`, and `notify` all return JS `undefined` while still producing their side effects.

**Data flow**: Executes JS that calls those helpers, maps their return values to equality checks against `undefined`, stringifies the resulting boolean array, emits it with `text`, and asserts both the side-effect content items and the final `"[true,true,true]"` text.

**Call relations**: Exercises callback return-value behavior in `callbacks.rs` together with normal output accumulation in the service.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_accepts_raw_mcp_image_block_with_original_detail`  (lines 1567–1599)

```
async fn image_helper_accepts_raw_mcp_image_block_with_original_detail()
```

**Purpose**: Checks that the `image` helper accepts a raw MCP image block and preserves an `original` detail hint from `_meta`.

**Data flow**: Executes JS calling `image({...})` with `type: "image"`, base64 data, `mimeType`, and `_meta["codex/imageDetail"] = "original"`, then asserts the runtime result contains a single `InputImage` with a synthesized data URI and `ImageDetail::Original`.

**Call relations**: Validates the MCP parsing path in `value::parse_mcp_output_image` and detail normalization in `normalize_output_image`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::generated_image_helper_appends_image_and_output_hint`  (lines 1602–1637)

```
async fn generated_image_helper_appends_image_and_output_hint()
```

**Purpose**: Verifies that `generatedImage` emits both the image content item and a trailing text item from `output_hint`.

**Data flow**: Executes JS calling `generatedImage({ image_url: "data:image/png;base64,AAA", output_hint: "generated image save hint" })` and asserts the result contains first an `InputImage` with default detail and then an `InputText` with the hint.

**Call relations**: Exercises `callbacks::generated_image_callback` and its composition of `generated_image_output_hint` with `normalize_output_image`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_second_arg_overrides_explicit_object_detail`  (lines 1640–1673)

```
async fn image_helper_second_arg_overrides_explicit_object_detail()
```

**Purpose**: Checks that the second argument to `image` overrides the `detail` field inside an `{ image_url, detail }` object.

**Data flow**: Executes JS calling `image({ image_url: ..., detail: "high" }, "original")` and asserts the resulting `InputImage` uses `ImageDetail::Original`.

**Call relations**: Validates the `detail_override.or(detail)` precedence rule in `normalize_output_image`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_second_arg_overrides_raw_mcp_image_detail`  (lines 1676–1711)

```
async fn image_helper_second_arg_overrides_raw_mcp_image_detail()
```

**Purpose**: Checks that the second argument to `image` also overrides detail metadata extracted from a raw MCP image block.

**Data flow**: Executes JS calling `image(raw_mcp_image_block, "high")` where the block’s `_meta` says `original`, then asserts the result uses `ImageDetail::High`.

**Call relations**: Covers the same override rule as above, but through the MCP parsing branch.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_accepts_low_detail`  (lines 1714–1744)

```
async fn image_helper_accepts_low_detail()
```

**Purpose**: Verifies that `low` is accepted as a valid image detail value.

**Data flow**: Executes JS calling `image({ image_url: "data:image/png;base64,AAA", detail: "low" })` and asserts the result contains an `InputImage` with `ImageDetail::Low`.

**Call relations**: Exercises accepted detail normalization in `normalize_output_image`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helpers_reject_remote_urls`  (lines 1747–1780)

```
async fn image_helpers_reject_remote_urls()
```

**Purpose**: Checks that both `image` and `generatedImage` reject `http://` and `https://` URLs with the shared remote-image error message.

**Data flow**: Loops over two remote URLs and two helper-source templates, creates a fresh service for each, executes the source, and asserts each result has no content items and the exact remote-image error text.

**Call relations**: Validates the remote URL guard in `normalize_output_image` across both helper entrypoints.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, execute, execute_request, format!).


##### `tests::image_helper_rejects_unsupported_detail`  (lines 1783–1812)

```
async fn image_helper_rejects_unsupported_detail()
```

**Purpose**: Verifies that unsupported detail strings are rejected with the explicit allowed-values message.

**Data flow**: Executes JS calling `image({ image_url: ..., detail: "medium" })` and asserts the result contains no content items and the exact detail-validation error text.

**Call relations**: Exercises the invalid-detail branch in `normalize_output_image`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::image_helper_rejects_raw_mcp_result_container`  (lines 1815–1851)

```
async fn image_helper_rejects_raw_mcp_result_container()
```

**Purpose**: Checks that the image helper does not accept an MCP result wrapper object containing `content: [...]`; it only accepts a raw image block.

**Data flow**: Executes JS calling `image({ content: [...], isError: false })` and asserts the result contains no content items and the generic image-helper shape error.

**Call relations**: Validates that `parse_mcp_output_image` requires the top-level object itself to be the image block, not a larger MCP result envelope.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, execute, execute_request).


##### `tests::wait_reports_missing_cell_separately_from_runtime_results`  (lines 1854–1873)

```
async fn wait_reports_missing_cell_separately_from_runtime_results()
```

**Purpose**: Verifies that waiting on a nonexistent cell returns `WaitOutcome::MissingCell` rather than a live-cell runtime result carrying an error.

**Data flow**: Calls `service.wait(WaitRequest { cell_id: "missing", yield_time_ms: 1 })` on a fresh service and asserts the returned outcome is `MissingCell(RuntimeResponse::Result { error_text: Some("exec cell missing not found"), ... })`.

**Call relations**: Exercises the `begin_wait`/`missing_wait`/`missing_cell_response` path in the service layer.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, cell_id).


##### `tests::terminate_waits_for_runtime_shutdown_before_responding`  (lines 1876–1945)

```
async fn terminate_waits_for_runtime_shutdown_before_responding()
```

**Purpose**: Checks that termination does not respond immediately upon request; it waits until the runtime event stream has actually closed before returning `Terminated`.

**Data flow**: Builds a test `Inner`, channels, and a real runtime running `await new Promise(() => {})`, then spawns `run_cell_control` directly with a synthetic event stream. It sends `Started` and `YieldRequested`, asserts the initial yielded response, sends a terminate control command, confirms the terminate response does not arrive within 100ms, then drops the event sender to simulate runtime closure and finally asserts the terminate response becomes `RuntimeResponse::Terminated { ... }`.

**Call relations**: Directly exercises `run_cell_control`’s termination branch and its requirement to wait for runtime closure before replying to the terminator.

*Call graph*: calls 2 internal fn (spawn_runtime, run_cell_control); 12 external calls (new, assert!, assert_eq!, Runtime, cell_id, execute_request, test_inner, unbounded_channel, channel, pin! (+2 more)).


### History and persistence bridges
These files reconstruct and persist thread history, truncate rollout state for forks and resumes, and synchronize derived metadata between storage and live runtimes.

### `core/src/thread_rollout_truncation.rs`

`domain_logic` · `cross-cutting history processing`

This file contains pure helper logic for slicing rollout histories. It works over `RolloutItem` sequences and is intentionally explicit about what counts as a boundary. `initial_history_has_prior_user_turns` delegates to `InitialHistory::scan_rollout_items` with `rollout_item_is_user_turn_boundary`, which treats `ResponseItem`s according to `context_manager::is_user_turn_boundary` and also treats `RolloutItem::InterAgentCommunication` as a boundary.

`user_message_positions_in_rollout` is narrower: it records indices only for `RolloutItem::ResponseItem(ResponseItem::Message { .. })` values that `event_mapping::parse_turn_item` classifies as `TurnItem::UserMessage`. While scanning, it also applies `EventMsg::ThreadRolledBack` markers by truncating the accumulated boundary list, so later indexing uses post-rollback effective history. `fork_turn_positions_in_rollout` generalizes this for forking: it tracks both rollback-counted instruction-turn positions and actual fork-turn positions. Fork-turns include real user messages, `InterAgentCommunication` items with `trigger_turn == true`, and legacy assistant message envelopes whose content decodes to `InterAgentCommunication` with the same flag. On rollback, it removes stale suffix boundaries starting at the earliest rolled-back instruction-turn boundary rather than naively trimming the mixed fork-boundary list.

The truncation functions then use those computed positions. `truncate_rollout_before_nth_user_message_from_start` returns a prefix cut strictly before the nth user message, with `usize::MAX` and out-of-range requests preserving the full rollout. `truncate_rollout_to_last_n_fork_turns` returns a suffix beginning at the earliest boundary needed to keep the last N fork turns; if fewer exist, it still drops startup prefix by starting at the first fork-turn boundary. Helper predicates distinguish real user messages from assistant trigger-turn envelopes.

#### Function details

##### `initial_history_has_prior_user_turns`  (lines 15–17)

```
fn initial_history_has_prior_user_turns(conversation_history: &InitialHistory) -> bool
```

**Purpose**: Checks whether an `InitialHistory` contains any prior user-turn boundary according to rollout scanning rules.

**Data flow**: Takes `conversation_history: &InitialHistory`, calls `scan_rollout_items(rollout_item_is_user_turn_boundary)`, and returns the resulting boolean.

**Call relations**: Used when recording initial history to decide whether prior user turns already exist.

*Call graph*: calls 1 internal fn (scan_rollout_items); called by 1 (record_initial_history).


##### `rollout_item_is_user_turn_boundary`  (lines 19–25)

```
fn rollout_item_is_user_turn_boundary(item: &RolloutItem) -> bool
```

**Purpose**: Classifies a single rollout item as a user-turn boundary for broad history-presence checks.

**Data flow**: Matches the `RolloutItem`: response items are delegated to `is_user_turn_boundary`, inter-agent communications return `true`, and all other variants return `false`.

**Call relations**: Passed as the predicate into `InitialHistory::scan_rollout_items` by `initial_history_has_prior_user_turns`.

*Call graph*: 1 external calls (is_user_turn_boundary).


##### `user_message_positions_in_rollout`  (lines 35–56)

```
fn user_message_positions_in_rollout(items: &[RolloutItem]) -> Vec<usize>
```

**Purpose**: Computes the indices of effective user-message boundaries in a rollout after applying rollback markers.

**Data flow**: Iterates over `items` with indices, pushes `idx` when a response-item message parses as `TurnItem::UserMessage`, and on `EventMsg::ThreadRolledBack` converts `num_turns` to `usize`, subtracts that many entries from the accumulated positions with saturation, and truncates the vector. It returns the final `Vec<usize>`.

**Call relations**: Used by `truncate_rollout_before_nth_user_message_from_start` and by thread-manager fork snapshot logic that needs user-turn positions.

*Call graph*: called by 1 (truncate_rollout_before_nth_user_message_from_start); 4 external calls (new, matches!, iter, try_from).


##### `fork_turn_positions_in_rollout`  (lines 69–109)

```
fn fork_turn_positions_in_rollout(items: &[RolloutItem]) -> Vec<usize>
```

**Purpose**: Computes effective fork-turn boundary indices, including trigger-turn inter-agent messages and rollback-aware removal of stale suffix boundaries.

**Data flow**: Scans `items` while maintaining `rollback_turn_positions` and `fork_turn_positions`. Response items contribute to rollback positions when `is_user_turn_boundary` is true and to fork positions when either `is_real_user_message_boundary` or `is_trigger_turn_boundary` is true. `RolloutItem::InterAgentCommunication` always contributes to rollback positions and contributes to fork positions only when `trigger_turn` is true. On `ThreadRolledBack`, it finds the earliest rolled-back instruction-turn boundary, truncates rollback positions, and retains only fork positions strictly before that rollback start index. It returns the resulting fork-boundary vector.

**Call relations**: Used by `truncate_rollout_to_last_n_fork_turns` to decide where the retained suffix should begin.

*Call graph*: calls 2 internal fn (is_real_user_message_boundary, is_trigger_turn_boundary); called by 1 (truncate_rollout_to_last_n_fork_turns); 4 external calls (new, is_user_turn_boundary, iter, try_from).


##### `truncate_rollout_before_nth_user_message_from_start`  (lines 119–137)

```
fn truncate_rollout_before_nth_user_message_from_start(
    items: &[RolloutItem],
    n_from_start: usize,
) -> Vec<RolloutItem>
```

**Purpose**: Returns the rollout prefix that ends immediately before the nth user message from the start.

**Data flow**: If `n_from_start == usize::MAX`, it clones and returns the full `items`. Otherwise it computes `user_message_positions_in_rollout(items)`; if there are not enough user messages, it returns the full rollout, else it slices `items[..cut_idx]` where `cut_idx` is the nth user boundary and returns that prefix as a new vector.

**Call relations**: Called by thread-manager fork truncation and directly by truncation tests.

*Call graph*: calls 1 internal fn (user_message_positions_in_rollout); 1 external calls (to_vec).


##### `truncate_rollout_to_last_n_fork_turns`  (lines 143–161)

```
fn truncate_rollout_to_last_n_fork_turns(
    items: &[RolloutItem],
    n_from_end: usize,
) -> Vec<RolloutItem>
```

**Purpose**: Returns the rollout suffix that preserves the last N fork turns while dropping startup prefix when possible.

**Data flow**: If `n_from_end == 0`, returns an empty vector. Otherwise it computes `fork_turn_positions_in_rollout(items)`, chooses `keep_idx` as either the boundary `n_from_end` turns from the end or the first fork-turn boundary if fewer exist, and returns `items[keep_idx..].to_vec()`. If there are no fork-turn boundaries at all, it returns an empty vector.

**Call relations**: Used by code that needs to compact history around recent fork-relevant turns.

*Call graph*: calls 1 internal fn (fork_turn_positions_in_rollout); 1 external calls (new).


##### `is_real_user_message_boundary`  (lines 163–168)

```
fn is_real_user_message_boundary(item: &ResponseItem) -> bool
```

**Purpose**: Checks whether a `ResponseItem` is a real user message according to turn-item parsing.

**Data flow**: Calls `event_mapping::parse_turn_item(item)` and returns true only when it matches `Some(TurnItem::UserMessage(_))`.

**Call relations**: Used by `fork_turn_positions_in_rollout` to distinguish actual user turns from other response items.

*Call graph*: called by 1 (fork_turn_positions_in_rollout); 1 external calls (matches!).


##### `is_trigger_turn_boundary`  (lines 170–178)

```
fn is_trigger_turn_boundary(item: &ResponseItem) -> bool
```

**Purpose**: Checks whether a response item is a legacy assistant inter-agent envelope that should count as a fork-turn boundary.

**Data flow**: Pattern-matches `ResponseItem::Message`, requires `role == "assistant"`, then parses `content` with `InterAgentCommunication::from_message_content` and returns true only when the decoded communication has `trigger_turn == true`.

**Call relations**: Used by `fork_turn_positions_in_rollout` so legacy assistant envelopes participate in fork-turn counting.

*Call graph*: calls 1 internal fn (from_message_content); called by 1 (fork_turn_positions_in_rollout).


### `thread-store/src/local/create_thread.rs`

`io_transport` · `thread creation`

This helper is the local-store bridge from generic thread creation parameters into the rollout subsystem’s concrete recorder API. It requires a current working directory in `params.metadata.cwd`; unlike remote or in-memory stores, the local recorder cannot be initialized without a filesystem location, so missing `cwd` is rejected immediately as `ThreadStoreError::InvalidRequest` with a clear message. Once `cwd` is present, the function builds a `RolloutConfig` from the store’s configured `codex_home` and `sqlite_home`, the thread’s cwd, the model provider ID from metadata, and a `generate_memories` flag derived from whether `ThreadMemoryMode` is `Enabled`.

It then constructs `RolloutRecorderParams` from the thread ID, fork lineage, source, optional thread source, base instructions, and dynamic tools, and augments those params with `.with_multi_agent_version(params.multi_agent_version)`. Finally it awaits `RolloutRecorder::new(&config, recorder_params)`. Any recorder initialization failure is wrapped as `ThreadStoreError::Internal` with a message indicating local thread recorder initialization failed. The function returns the live `RolloutRecorder`, which the surrounding local thread store can then use to append rollout items and manage persistence for the active thread.

#### Function details

##### `create_thread`  (lines 10–45)

```
async fn create_thread(
    store: &LocalThreadStore,
    params: CreateThreadParams,
) -> ThreadStoreResult<RolloutRecorder>
```

**Purpose**: Initializes a `RolloutRecorder` for a new local thread using store configuration and thread creation metadata. It enforces that local persistence has a concrete working directory.

**Data flow**: Takes a `&LocalThreadStore` and `CreateThreadParams`, extracts `params.metadata.cwd` or returns `ThreadStoreError::InvalidRequest`, builds a `RolloutConfig` from store paths plus metadata fields, constructs `RolloutRecorderParams::new(...)` from thread identity and source fields, adds the optional multi-agent version, awaits `RolloutRecorder::new(&config, params)`, and returns the recorder or maps any error to `ThreadStoreError::Internal`.

**Call relations**: This helper is called by the local thread store’s create-thread path as the concrete recorder-construction step for local persistence.

*Call graph*: calls 2 internal fn (new, new); called by 1 (create_thread); 1 external calls (matches!).


### `thread-store/src/thread_metadata_sync.rs`

`domain_logic` · `thread create, thread resume, and append-time metadata synchronization`

This file maintains a stateful `ThreadMetadataSync` that converts thread lifecycle inputs into `ThreadMetadataPatch` values and exposes them as retry-safe `PendingThreadMetadataPatch` snapshots. In this chunk, creation starts with `for_create`, which seeds a patch from `CreateThreadParams`: timestamps, source identity, cwd, CLI version, memory mode, and optional git data collected only when the cwd is inside a repository. Resume starts with `for_resume`, which initializes seen-flags from persisted metadata and optionally scans historical `RolloutItem`s to derive metadata without immediately stamping `updated_at`.

The core extraction logic lives in `observe_items_with_update`. It walks each `RolloutItem` and fills patch fields from concrete event types: `SessionMeta` contributes creation/session facts, `TurnContext` contributes execution context such as model and approval settings, `UserMessage` contributes preview/title/first-user-message once, `TokenCount` contributes aggregate token usage, and `ThreadGoalUpdated` can supply a preview only if one has not already been seen. Internal booleans (`cwd_seen`, `preview_seen`, `first_user_message_seen`, `title_seen`) prevent later events from overwriting first-observed metadata.

Appending new items clears deferral flags, merges newly observed facts into any existing pending patch, and rate-limits metadata-irrelevant `updated_at` touches using `last_touch_persisted_at` plus `THREAD_UPDATED_AT_TOUCH_INTERVAL`. Pending patches are clone-returned rather than consumed; callers must acknowledge persistence through `mark_pending_update_applied`, which clears only the matching generation so stale acknowledgements cannot drop newer merged updates.

#### Function details

##### `ThreadMetadataSync::for_create`  (lines 52–91)

```
async fn for_create(params: &CreateThreadParams) -> Self
```

**Purpose**: Constructs a fresh sync state for a newly created thread and prepopulates its first metadata patch from creation parameters. It also opportunistically captures git repository facts from the configured cwd.

**Data flow**: `params: &CreateThreadParams` supplies `thread_id`, source/thread source, and `metadata` fields such as cwd, model provider, and memory mode. The function computes `created_at` with `Utc::now()`, normalizes cwd with `unwrap_or_default`, conditionally calls git discovery/collection for that cwd, then builds a `ThreadMetadataPatch` containing creation and identity fields plus `updated_at = created_at`; it returns a `ThreadMetadataSync` with that patch stored in `pending_update`, generation set to 1, seen-flags initialized from cwd presence, and create-time flushing deferred until history exists.

**Call relations**: This constructor is used by the create path. Within that flow it is the initial source of metadata state, delegating only to external time/git helpers and `git_info_patch_from_observation` to translate observed repository data into patch form.

*Call graph*: called by 1 (create); 5 external calls (default, now, collect_git_info, get_git_repo_root, env!).


##### `ThreadMetadataSync::for_resume`  (lines 93–116)

```
fn for_resume(params: &ResumeThreadParams) -> Self
```

**Purpose**: Constructs sync state for an existing thread being resumed and optionally derives metadata from already persisted history. It preserves those derived facts as pending work and can defer flushing them until a new append arrives.

**Data flow**: `params: &ResumeThreadParams` provides `thread_id`, persisted metadata, and optional `history`. The function initializes a `ThreadMetadataSync` with no pending patch, sets `cwd_seen` from non-empty persisted cwd, then if history exists calls `observe_resume_history(history)`, merges the resulting patch into `pending_update`, and sets `defer_resume_update_until_append` when any pending metadata was derived; it returns the configured sync object.

**Call relations**: It is invoked by the resume path and by several tests that validate resume semantics. When history is present it delegates to `observe_resume_history` and `merge_pending_update` so resume-derived metadata enters the same pending-update pipeline used for append-time updates.

*Call graph*: called by 6 (resume, goal_update_sets_preview_without_overriding_existing_preview, later_user_messages_do_not_emit_existing_preview_fields, metadata_irrelevant_items_coalesce_updated_at_touches, resume_history_keeps_derived_metadata_pending_until_applied, resume_history_waits_for_append_before_flushing_metadata).


##### `ThreadMetadataSync::take_pending_update`  (lines 118–125)

```
fn take_pending_update(&self) -> Option<PendingThreadMetadataPatch>
```

**Purpose**: Returns the current pending metadata patch together with its generation number without consuming internal retry state. This lets callers attempt persistence multiple times against the same logical update.

**Data flow**: The method reads `self.pending_update` and `self.pending_update_generation`. If a patch exists, it clones the patch into a new `PendingThreadMetadataPatch { patch, generation }`; otherwise it returns `None`. It does not mutate sync state.

**Call relations**: It is called directly by append handling and by the existing-history gatekeeper. Its non-consuming behavior is paired with `mark_pending_update_applied`, which is the only path that actually clears acknowledged state.

*Call graph*: called by 2 (observe_appended_items, take_pending_update_for_existing_history).


##### `ThreadMetadataSync::take_pending_update_for_existing_history`  (lines 127–137)

```
fn take_pending_update_for_existing_history(
        &self,
    ) -> Option<PendingThreadMetadataPatch>
```

**Purpose**: Exposes a pending patch only when it is legal to flush metadata derived from already existing history. It blocks emission during create-before-history and resume-before-first-append phases.

**Data flow**: The method reads `defer_create_update_until_history_exists` and `defer_resume_update_until_append`. If either deferral flag is true it returns `None`; otherwise it forwards to `take_pending_update()` and returns that result unchanged.

**Call relations**: This is a guarded wrapper around `take_pending_update`, used when callers want to flush metadata for preexisting history but must respect lifecycle barriers established by create/resume initialization.

*Call graph*: calls 1 internal fn (take_pending_update).


##### `ThreadMetadataSync::mark_pending_update_applied`  (lines 139–146)

```
fn mark_pending_update_applied(&mut self, update: &PendingThreadMetadataPatch)
```

**Purpose**: Acknowledges that a previously returned pending patch has been persisted and clears it only if no newer merged update has superseded it. It also records when an `updated_at` touch was last persisted for later coalescing.

**Data flow**: The method takes `&PendingThreadMetadataPatch`. It compares `update.generation` with `self.pending_update_generation`; on equality it sets `self.pending_update = None`, otherwise it leaves newer pending state intact. Independently, if `update.patch.updated_at` is present, it stores `Instant::now()` into `last_touch_persisted_at`.

**Call relations**: Callers invoke this after successfully applying a patch obtained from `take_pending_update` or `observe_appended_items`. Its generation check protects against stale acknowledgements racing with `merge_pending_update`.

*Call graph*: 1 external calls (now).


##### `ThreadMetadataSync::observe_appended_items`  (lines 148–175)

```
fn observe_appended_items(
        &mut self,
        items: &[RolloutItem],
    ) -> Option<PendingThreadMetadataPatch>
```

**Purpose**: Processes newly appended rollout items, merges any derived metadata into pending state, and decides whether to emit a patch immediately or suppress a redundant pure-touch update. It is the main append-time synchronization entrypoint.

**Data flow**: `items: &[RolloutItem]` are scanned first to clear both deferral flags and determine whether any item affects metadata via `rollout_item_affects_thread_metadata`. If metadata is affected, it derives a patch with `observe_items(items)`; otherwise it creates an `updated_at`-only patch with `thread_updated_at_touch()`. That patch is merged into `pending_update`; then, for metadata-irrelevant appends, if the accumulated pending patch still contains no metadata facts and the last persisted touch is within `THREAD_UPDATED_AT_TOUCH_INTERVAL`, the function returns `None` to coalesce the touch. Otherwise it returns the current pending snapshot via `take_pending_update()`.

**Call relations**: This method is called when new rollout items are appended. It delegates to `observe_items`, `thread_updated_at_touch`, `merge_pending_update`, and `take_pending_update`, and it uses `update_has_metadata_facts` plus the persisted-touch timestamp to decide whether an append should flush immediately.

*Call graph*: calls 4 internal fn (merge_pending_update, observe_items, take_pending_update, thread_updated_at_touch); 1 external calls (iter).


##### `ThreadMetadataSync::observe_items`  (lines 177–185)

```
fn observe_items(&mut self, items: &[RolloutItem]) -> Option<ThreadMetadataPatch>
```

**Purpose**: Derives metadata from rollout items for append-time processing while ensuring the resulting patch carries a fresh `updated_at` timestamp. It is a thin wrapper over the shared item walker.

**Data flow**: `items: &[RolloutItem]` are passed to `observe_items_with_update` together with a newly created `ThreadMetadataPatch` whose only preset field is `updated_at: Some(Utc::now())`. The return value is whatever optional patch the shared observer produces.

**Call relations**: It is used only by `observe_appended_items` for metadata-affecting appends. The wrapper exists so append-time observation differs from resume-time observation only in the initial patch contents.

*Call graph*: calls 1 internal fn (observe_items_with_update); called by 1 (observe_appended_items); 2 external calls (default, now).


##### `ThreadMetadataSync::observe_resume_history`  (lines 187–189)

```
fn observe_resume_history(&mut self, items: &[RolloutItem]) -> Option<ThreadMetadataPatch>
```

**Purpose**: Derives metadata from historical rollout items during resume without treating that scan as a fresh modification. It intentionally omits `updated_at` from the initial patch.

**Data flow**: `items: &[RolloutItem]` are forwarded to `observe_items_with_update` with `ThreadMetadataPatch::default()`. The function returns `None` for empty history or `Some(patch)` containing only facts discovered in the history.

**Call relations**: It is called from `for_resume` when resume parameters include history. By sharing the same walker as append-time observation, it keeps extraction rules identical while preserving resume-specific flush semantics.

*Call graph*: calls 1 internal fn (observe_items_with_update); 1 external calls (default).


##### `ThreadMetadataSync::observe_items_with_update`  (lines 191–280)

```
fn observe_items_with_update(
        &mut self,
        items: &[RolloutItem],
        mut update: ThreadMetadataPatch,
    ) -> Option<ThreadMetadataPatch>
```

**Purpose**: Walks rollout history and extracts concrete thread metadata fields from specific item variants while honoring first-seen invariants. This is the central metadata derivation routine in the file.

**Data flow**: Inputs are `items: &[RolloutItem]` and a mutable seed `ThreadMetadataPatch`. If `items` is empty it returns `None`. Otherwise it iterates each item and mutates both `update` and internal seen-flags: matching `SessionMeta` for the current `thread_id` sets creation/session fields, optional model provider/CLI version/cwd/git/memory mode; `TurnContext` fills cwd if not already seen plus model, reasoning effort, approval mode, and permission profile; `UserMessage` computes a preview via `user_message_preview`, sets `first_user_message` once, sets `preview` once, and derives `title` once from `strip_user_message_prefix`; `TokenCount` copies total token usage when present; `ThreadGoalUpdated` sets preview from a non-empty objective only if preview has not already been seen; all other variants are ignored. After the loop it returns `Some(update)`.

**Call relations**: This shared worker is called by both `observe_items` and `observe_resume_history`. It delegates to parsing/normalization helpers (`parse_session_timestamp`, `parse_memory_mode`, `strip_user_message_prefix`, `user_message_preview`, `git_info_patch_from_observation`) so callers get consistent metadata extraction across create/resume/append flows.

*Call graph*: calls 5 internal fn (git_info_patch_from_observation, parse_memory_mode, parse_session_timestamp, strip_user_message_prefix, user_message_preview); called by 2 (observe_items, observe_resume_history); 1 external calls (is_empty).


##### `ThreadMetadataSync::merge_pending_update`  (lines 282–291)

```
fn merge_pending_update(&mut self, update: Option<ThreadMetadataPatch>)
```

**Purpose**: Accumulates a newly derived patch into the sync object's pending patch and advances the generation counter. It supports incremental metadata discovery across multiple observations.

**Data flow**: The method takes `update: Option<ThreadMetadataPatch>`. If `None`, it returns immediately. If `Some(update)`, it either merges into the existing `pending_update` via `pending_update.merge(update)` or stores it as the first pending patch; afterward it increments `pending_update_generation` with `wrapping_add(1)`.

**Call relations**: It is used by `for_resume` and `observe_appended_items` whenever new metadata facts are derived. The generation bump is what allows `mark_pending_update_applied` to reject stale acknowledgements after subsequent merges.

*Call graph*: called by 1 (observe_appended_items).


##### `parse_memory_mode`  (lines 294–300)

```
fn parse_memory_mode(value: &str) -> Option<ThreadMemoryMode>
```

**Purpose**: Converts serialized memory-mode strings from session metadata into the internal `ThreadMemoryMode` enum. Unknown strings are ignored rather than causing failure.

**Data flow**: The input `value: &str` is matched against the literals `"enabled"` and `"disabled"`. It returns `Some(ThreadMemoryMode::Enabled)` or `Some(ThreadMemoryMode::Disabled)` for those exact values, otherwise `None`.

**Call relations**: This helper is called while processing `SessionMeta` inside `observe_items_with_update` so historical metadata can restore memory mode only when the serialized value is recognized.

*Call graph*: called by 1 (observe_items_with_update).


##### `parse_session_timestamp`  (lines 302–310)

```
fn parse_session_timestamp(value: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses session timestamps from either RFC3339 format or a legacy `%Y-%m-%dT%H-%M-%S` format into `DateTime<Utc>`. It provides backward-compatible timestamp recovery for session metadata.

**Data flow**: The input `value: &str` is first parsed with `DateTime::parse_from_rfc3339` and converted to UTC on success. If that fails, it tries `NaiveDateTime::parse_from_str` with the fallback format and wraps the result as a UTC `DateTime`; any failure yields `None` via `.ok()`.

**Call relations**: It is used only by `observe_items_with_update` when reading `SessionMeta.timestamp`, allowing resume/history scans to populate `created_at` from multiple on-disk timestamp encodings.

*Call graph*: called by 1 (observe_items_with_update); 1 external calls (parse_from_rfc3339).


##### `strip_user_message_prefix`  (lines 312–317)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes the configured user-message prefix marker from message text before deriving preview or title fields. If the marker is absent, it simply trims surrounding whitespace.

**Data flow**: Given `text: &str`, the function searches for `USER_MESSAGE_BEGIN`. If found, it returns the substring after that marker with whitespace trimmed; otherwise it returns `text.trim()`. It borrows from the original string and performs no allocation.

**Call relations**: This helper is used directly in `observe_items_with_update` for title derivation and indirectly through `user_message_preview`, ensuring both preview and title are based on the same normalized message body.

*Call graph*: called by 2 (observe_items_with_update, user_message_preview).


##### `user_message_preview`  (lines 319–333)

```
fn user_message_preview(user: &UserMessageEvent) -> Option<String>
```

**Purpose**: Builds a preview string for a user message from text content, or falls back to an image-only placeholder when the message has no text but includes images. It returns no preview for completely empty messages.

**Data flow**: The input `user: &UserMessageEvent` is normalized by calling `strip_user_message_prefix` on `user.message`. If the stripped text is non-empty, the function returns it as `Some(String)`. Otherwise, if `images` is present and non-empty or `local_images` is non-empty, it returns `Some(IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER.to_string())`; if neither condition holds, it returns `None`.

**Call relations**: It is called from `observe_items_with_update` when processing `EventMsg::UserMessage`. Its output drives first-user-message and preview population while preserving support for image-only prompts.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (observe_items_with_update).


##### `thread_updated_at_touch`  (lines 335–340)

```
fn thread_updated_at_touch() -> ThreadMetadataPatch
```

**Purpose**: Creates a minimal metadata patch that only advances the thread's `updated_at` timestamp. It is used when appended items do not contribute any richer metadata facts.

**Data flow**: The function constructs and returns a `ThreadMetadataPatch` with `updated_at: Some(Utc::now())` and all other fields left at `Default::default()`.

**Call relations**: It is called by `observe_appended_items` for metadata-irrelevant appends so the thread can still be marked as touched, subject to later coalescing rules.

*Call graph*: called by 1 (observe_appended_items); 2 external calls (default, now).


##### `update_has_metadata_facts`  (lines 342–363)

```
fn update_has_metadata_facts(update: &ThreadMetadataPatch) -> bool
```

**Purpose**: Checks whether a patch contains any substantive metadata fields beyond a bare `updated_at` touch. This distinction is used to decide whether touch coalescing is safe.

**Data flow**: The input `update: &ThreadMetadataPatch` is inspected field-by-field across rollout path, preview/title, model/provider, timestamps and source identity, cwd/CLI version, approval and permission settings, token usage, first user message, git info, and memory mode. It returns `true` if any of those fields are `Some`, otherwise `false`.

**Call relations**: This predicate is used by `observe_appended_items` after merging a touch update into pending state. If no substantive facts are present and the last touch was recently persisted, append handling suppresses immediate emission.


##### `git_info_patch_from_observation`  (lines 365–371)

```
fn git_info_patch_from_observation(git_info: GitInfo) -> GitInfoPatch
```

**Purpose**: Translates observed `GitInfo` into the patch-layer `GitInfoPatch` representation expected by thread metadata updates. It preserves the patch type's nested optional semantics.

**Data flow**: The input `git_info: GitInfo` is decomposed into commit hash, branch, and repository URL. The function returns `GitInfoPatch { sha, branch, origin_url }`, mapping each present observed value into `Some(Some(value))` and absent values into `None`.

**Call relations**: It is used both during create-time git collection and while reading historical `SessionMeta` in `observe_items_with_update`, ensuring both sources produce the same patch encoding.

*Call graph*: called by 1 (observe_items_with_update).


##### `tests::resume_history_keeps_derived_metadata_pending_until_applied`  (lines 389–422)

```
fn resume_history_keeps_derived_metadata_pending_until_applied()
```

**Purpose**: Verifies that metadata derived from resume history remains available across repeated reads and is only cleared after explicit acknowledgement. It also confirms resume-derived patches omit `updated_at` while still carrying created-at and user-derived fields.

**Data flow**: The test creates a new `ThreadId`, builds resume params containing `SessionMeta` and a user message, constructs sync state with `for_resume`, then reads the pending patch and asserts concrete values for `created_at`, `preview`, `title`, `first_user_message`, and `updated_at == None`. It reads pending state again to confirm non-consuming behavior, then calls `mark_pending_update_applied` and asserts pending state is gone.

**Call relations**: This test exercises the interaction among `for_resume`, `take_pending_update`, and `mark_pending_update_applied`, specifically the retry-safe pending-update contract for resume-derived metadata.

*Call graph*: calls 2 internal fn (new, for_resume); 4 external calls (assert!, assert_eq!, resume_params, vec!).


##### `tests::goal_update_sets_preview_without_overriding_existing_preview`  (lines 425–445)

```
fn goal_update_sets_preview_without_overriding_existing_preview()
```

**Purpose**: Checks that a goal-update event can establish the thread preview before any user message arrives, while later user messages still populate first-user-message and title without replacing that preview. It validates preview precedence rules.

**Data flow**: The test builds resume history containing a `ThreadGoalUpdated` event followed by a user message, constructs sync state with `for_resume`, retrieves the pending patch, and asserts that `preview` equals the goal objective while `first_user_message` and `title` come from the later user message.

**Call relations**: It validates `observe_items_with_update` behavior as reached through `for_resume`, specifically the `preview_seen` guard that prevents later user-message preview derivation from overwriting an earlier goal-derived preview.

*Call graph*: calls 2 internal fn (new, for_resume); 3 external calls (assert_eq!, resume_params, vec!).


##### `tests::later_user_messages_do_not_emit_existing_preview_fields`  (lines 448–469)

```
fn later_user_messages_do_not_emit_existing_preview_fields()
```

**Purpose**: Ensures that once preview/title/first-user-message have already been established and applied, later user messages do not re-emit those fields and instead only trigger an `updated_at` touch. This protects first-seen metadata invariants across appends.

**Data flow**: The test resumes from history containing one user message, takes and applies the initial pending patch, then appends a second user message through `observe_appended_items`. It asserts the returned patch has `preview`, `title`, and `first_user_message` all `None` while `updated_at` is present.

**Call relations**: It exercises the full flow from `for_resume` through `mark_pending_update_applied` into `observe_appended_items`, confirming that internal seen-flags suppress duplicate metadata emission on subsequent appends.

*Call graph*: calls 2 internal fn (new, for_resume); 7 external calls (assert!, assert_eq!, UserMessage, EventMsg, resume_params, user_message, vec!).


##### `tests::metadata_irrelevant_items_coalesce_updated_at_touches`  (lines 472–496)

```
fn metadata_irrelevant_items_coalesce_updated_at_touches()
```

**Purpose**: Verifies that appends which do not affect metadata still produce an initial `updated_at` touch, but repeated touches inside the coalescing window are suppressed from immediate emission. It also confirms the suppressed touch remains pending for a later flush barrier.

**Data flow**: The test creates an empty resume sync, constructs a `RolloutItem::Compacted` item, observes it once and asserts an immediate patch with `updated_at`, marks that patch applied, then observes the same item again and asserts `None` is returned. Finally it checks `take_pending_update()` still returns a pending patch.

**Call relations**: This test targets `observe_appended_items`, `mark_pending_update_applied`, and `take_pending_update`, validating the branch that uses `thread_updated_at_touch`, `update_has_metadata_facts`, and `last_touch_persisted_at` to coalesce pure touches.

*Call graph*: calls 2 internal fn (new, for_resume); 5 external calls (new, assert!, Compacted, from_ref, resume_params).


##### `tests::resume_history_waits_for_append_before_flushing_metadata`  (lines 499–520)

```
fn resume_history_waits_for_append_before_flushing_metadata()
```

**Purpose**: Confirms that metadata derived solely from resume history is not flushed through the existing-history accessor until at least one new append occurs. The first append should release both resume-derived and append-derived metadata together.

**Data flow**: The test builds resume history with session metadata and a user message, constructs sync state with `for_resume`, asserts `take_pending_update_for_existing_history()` returns `None`, then appends a new user message via `observe_appended_items` and asserts that a patch is now emitted.

**Call relations**: It validates the deferral logic spanning `for_resume`, `take_pending_update_for_existing_history`, and `observe_appended_items`, specifically the `defer_resume_update_until_append` gate.

*Call graph*: calls 2 internal fn (new, for_resume); 3 external calls (assert!, resume_params, vec!).


##### `tests::resume_params`  (lines 522–534)

```
fn resume_params(thread_id: ThreadId, history: Vec<RolloutItem>) -> ResumeThreadParams
```

**Purpose**: Creates a reusable `ResumeThreadParams` fixture with predictable metadata defaults for tests in this module. It centralizes the common setup for resume-related scenarios.

**Data flow**: Inputs are `thread_id: ThreadId` and `history: Vec<RolloutItem>`. The function returns a `ResumeThreadParams` populated with that thread ID and history, `rollout_path: None`, `include_archived: false`, and `ThreadPersistenceMetadata` containing `cwd: None`, `model_provider: "test-provider"`, and `memory_mode: ThreadMemoryMode::Enabled`.

**Call relations**: This helper is called by multiple tests that exercise `for_resume`, reducing duplication while ensuring all resume tests start from the same baseline metadata.


##### `tests::user_message`  (lines 536–545)

```
fn user_message(message: &str) -> UserMessageEvent
```

**Purpose**: Builds a minimal `UserMessageEvent` fixture from plain text for metadata extraction tests. It leaves unrelated fields empty so assertions focus on preview/title behavior.

**Data flow**: The input `message: &str` is copied into `UserMessageEvent.message`. The function returns a `UserMessageEvent` with `client_id: None`, `images: None`, empty `local_images` and `text_elements`, and all remaining fields filled from `Default::default()`.

**Call relations**: It is used by tests that feed `EventMsg::UserMessage` into resume or append observation paths, providing a concise way to trigger user-message metadata derivation.

*Call graph*: 2 external calls (default, new).


##### `tests::session_meta`  (lines 547–557)

```
fn session_meta(thread_id: ThreadId) -> SessionMetaLine
```

**Purpose**: Creates a minimal `SessionMetaLine` fixture for a specific thread with a fixed timestamp and source. It supplies deterministic session metadata for resume-history tests.

**Data flow**: The input `thread_id: ThreadId` is inserted into `SessionMeta.id`. The function returns a `SessionMetaLine` whose `meta` contains that ID, timestamp `"2025-01-03T12:00:00Z"`, source `SessionSource::Exec`, and other fields from `Default::default()`, with `git: None`.

**Call relations**: Tests use this helper when they need `observe_items_with_update` to populate `created_at` and source-related fields through the `SessionMeta` branch.

*Call graph*: 1 external calls (default).


##### `tests::goal_update`  (lines 559–574)

```
fn goal_update(thread_id: ThreadId, objective: &str) -> ThreadGoalUpdatedEvent
```

**Purpose**: Builds a `ThreadGoalUpdatedEvent` fixture with a supplied objective string for preview-derivation tests. It models an active goal update for the given thread.

**Data flow**: Inputs are `thread_id: ThreadId` and `objective: &str`. The function returns a `ThreadGoalUpdatedEvent` with that thread ID, `turn_id: None`, and a nested `ThreadGoal` containing the same thread ID, the provided objective, `ThreadGoalStatus::Active`, and zeroed/default numeric fields.

**Call relations**: It is used by the preview-precedence test to drive the `EventMsg::ThreadGoalUpdated` branch inside `observe_items_with_update`.


### `thread-store/src/live_thread.rs`

`orchestration` · `active thread lifetime, initialization failure cleanup, persistence flush/shutdown`

This module introduces `LiveThread`, a runtime handle that keeps a thread ID, an `Arc<dyn ThreadStore>`, and a mutex-protected `ThreadMetadataSync`. The design separates session code from concrete persistence details: callers interact with a live thread uniformly whether the underlying store is local-file-based or remote. `LiveThreadInitGuard` complements that by owning an optional `LiveThread` during fallible initialization; if setup aborts before ownership is committed, the guard discards persistence either explicitly through `discard()` or asynchronously from `Drop`, logging warnings if no Tokio runtime is available or discard fails.

`LiveThread::create` and `resume` initialize metadata synchronization differently: create uses `ThreadMetadataSync::for_create`, while resume may first call `thread_store.resume_thread`, then load history if it was not supplied, and discard the resumed persistence if that history load fails. `append_items` is careful about metadata materialization: it sends the original items to the store, but separately canonicalizes them with `persisted_rollout_items` to decide whether metadata observations should produce a pending patch. If `ThreadMetadataSync` emits an update, the store is immediately patched and the sync state is marked applied. Persist, flush, shutdown, and explicit metadata updates all first flush pending metadata patches, with `flush` and `shutdown` using the narrower `take_pending_update_for_existing_history` path so empty threads do not materialize metadata unnecessarily. `local_rollout_path` is intentionally legacy-only: it downcasts the store to `LocalThreadStore` and returns `Ok(None)` for remote or nonlocal stores.

#### Function details

##### `LiveThreadInitGuard::new`  (lines 47–49)

```
fn new(live_thread: Option<LiveThread>) -> Self
```

**Purpose**: Wraps an optional `LiveThread` in an initialization guard. The guard exists so partially initialized sessions can clean up persistence if setup later fails.

**Data flow**: Consumes an `Option<LiveThread>`, stores it in the `live_thread` field, and returns the new `LiveThreadInitGuard`.

**Call relations**: This constructor is used by higher-level session initialization code that wants rollback semantics until setup is committed.

*Call graph*: called by 1 (new).


##### `LiveThreadInitGuard::as_ref`  (lines 51–53)

```
fn as_ref(&self) -> Option<&LiveThread>
```

**Purpose**: Provides shared access to the guarded `LiveThread` without transferring ownership. It lets initialization code inspect or use the live thread before commit.

**Data flow**: Reads `self.live_thread`, converts it to `Option<&LiveThread>` with `as_ref()`, and returns that option.

**Call relations**: This is a convenience accessor for callers managing initialization state around the guard.


##### `LiveThreadInitGuard::commit`  (lines 55–57)

```
fn commit(&mut self)
```

**Purpose**: Marks initialization as successful by clearing the guarded live thread so drop-time rollback will not occur. After commit, the caller is responsible for the thread lifecycle.

**Data flow**: Mutably accesses `self.live_thread` and sets it to `None`.

**Call relations**: Initialization code calls this once ownership of the live thread has been fully transferred and persistence should no longer be discarded automatically.


##### `LiveThreadInitGuard::discard`  (lines 59–66)

```
async fn discard(&mut self)
```

**Purpose**: Explicitly discards the guarded live thread’s persistence if it still exists. It logs but suppresses discard failures.

**Data flow**: Takes `self.live_thread` out with `take()`, returns early if absent, otherwise awaits `live_thread.discard()`. If that returns an error, emits a warning and returns `()`.

**Call relations**: This is the explicit rollback path for failed initialization; if callers do not invoke it, `Drop` provides a best-effort asynchronous fallback.

*Call graph*: 1 external calls (warn!).


##### `LiveThreadInitGuard::drop`  (lines 70–83)

```
fn drop(&mut self)
```

**Purpose**: Performs best-effort asynchronous rollback when an initialization guard is dropped without being committed. It avoids blocking drop while still attempting to discard persistence.

**Data flow**: On drop, takes `self.live_thread`; if absent, returns. It then tries `tokio::runtime::Handle::try_current()`. If no runtime exists, it logs a warning and stops. Otherwise it spawns an async task that awaits `live_thread.discard()` and logs any resulting error.

**Call relations**: This is the safety net behind `LiveThreadInitGuard`, triggered automatically when initialization exits early without calling `commit`.

*Call graph*: 2 external calls (try_current, warn!).


##### `LiveThread::create`  (lines 87–99)

```
async fn create(
        thread_store: Arc<dyn ThreadStore>,
        params: CreateThreadParams,
    ) -> ThreadStoreResult<Self>
```

**Purpose**: Creates a new live thread backed by a `ThreadStore` and initializes metadata synchronization from creation parameters. It persists the thread before returning the handle.

**Data flow**: Consumes an `Arc<dyn ThreadStore>` and `CreateThreadParams`, extracts `thread_id`, builds `metadata_sync` with `ThreadMetadataSync::for_create(&params).await`, awaits `thread_store.create_thread(params)`, then returns `LiveThread { thread_id, thread_store, metadata_sync: Arc<Mutex<_>> }`.

**Call relations**: This constructor is called by higher-level session startup paths when opening a brand-new thread.

*Call graph*: calls 1 internal fn (for_create); called by 6 (new, attach_thread_persistence, shutdown_complete_does_not_append_to_thread_store_after_shutdown, live_thread_observes_appended_items_into_sqlite_metadata, live_thread_shutdown_does_not_materialize_empty_thread_metadata, live_thread_shutdown_with_buffered_items_materializes_before_metadata_read); 2 external calls (new, new).


##### `LiveThread::resume`  (lines 101–134)

```
async fn resume(
        thread_store: Arc<dyn ThreadStore>,
        mut params: ResumeThreadParams,
    ) -> ThreadStoreResult<Self>
```

**Purpose**: Resumes an existing thread in a store, ensuring history is available for metadata synchronization and rolling back the resumed persistence if history loading fails. It initializes sync state from resume parameters plus loaded history.

**Data flow**: Consumes an `Arc<dyn ThreadStore>` and mutable `ResumeThreadParams`, records `thread_id`, whether history must be loaded, and `include_archived`, then awaits `thread_store.resume_thread(params.clone())`. If history was absent, it calls `thread_store.load_history(...)`; on success it stores the loaded items back into `params.history`, and on failure it attempts `thread_store.discard_thread(thread_id)` before returning the original error. Finally it builds `metadata_sync` with `ThreadMetadataSync::for_resume(&params)` and returns a new `LiveThread`.

**Call relations**: This constructor is used by resume flows and is the only place in the file that coordinates resume, history hydration, and rollback-on-failure.

*Call graph*: calls 1 internal fn (for_resume); called by 3 (new, live_thread_resume_loads_history_before_observing_metadata, live_thread_resume_loads_history_from_explicit_external_rollout_path); 4 external calls (new, new, clone, warn!).


##### `LiveThread::append_items`  (lines 136–169)

```
async fn append_items(&self, items: &[RolloutItem]) -> ThreadStoreResult<()>
```

**Purpose**: Appends rollout items to the underlying store and updates thread metadata if the appended persisted items imply a metadata change. It distinguishes between raw submitted items and canonical persisted items.

**Data flow**: Takes a slice of `RolloutItem`, computes `canonical_items = persisted_rollout_items(items)`, returns early if the original slice is empty, sends the original items to `thread_store.append_items` by cloning them into `AppendThreadItemsParams`, returns early again if the canonical list is empty, then locks `metadata_sync` to call `observe_appended_items(canonical_items.as_slice())`. If that yields a pending update, it sends `update.patch.clone()` to `thread_store.update_thread_metadata(... include_archived: true)` and then marks the update applied in `metadata_sync`.

**Call relations**: This method is called during active thread execution whenever new rollout items are produced. It is the main bridge between item persistence and metadata synchronization.

*Call graph*: 3 external calls (persisted_rollout_items, is_empty, to_vec).


##### `LiveThread::persist`  (lines 171–174)

```
async fn persist(&self) -> ThreadStoreResult<()>
```

**Purpose**: Requests durable persistence for the live thread and then flushes any pending metadata patch. It ensures metadata does not lag behind a persist boundary.

**Data flow**: Calls `thread_store.persist_thread(self.thread_id).await?`, then awaits `self.flush_pending_metadata_update()` and returns its result.

**Call relations**: This lifecycle method is used when callers want a stronger persistence checkpoint than ordinary appends.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update).


##### `LiveThread::flush`  (lines 176–180)

```
async fn flush(&self) -> ThreadStoreResult<()>
```

**Purpose**: Flushes the underlying thread store and then applies only metadata updates that are valid once history already exists. This avoids materializing metadata for empty threads.

**Data flow**: Calls `thread_store.flush_thread(self.thread_id).await?`, then awaits `flush_pending_metadata_update_for_existing_history()` and returns its result.

**Call relations**: This is a lighter-weight lifecycle boundary than shutdown and uses the narrower pending-update extraction path.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update_for_existing_history).


##### `LiveThread::shutdown`  (lines 182–186)

```
async fn shutdown(&self) -> ThreadStoreResult<()>
```

**Purpose**: Finalizes metadata for an existing-history thread and then shuts down the underlying store’s live persistence. It is the normal end-of-thread lifecycle hook.

**Data flow**: First awaits `flush_pending_metadata_update_for_existing_history()?`, then calls `thread_store.shutdown_thread(self.thread_id).await` and returns that result.

**Call relations**: This method is used during orderly thread teardown after active execution has finished.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update_for_existing_history).


##### `LiveThread::discard`  (lines 188–190)

```
async fn discard(&self) -> ThreadStoreResult<()>
```

**Purpose**: Abandons the live thread’s persistence without flushing metadata. It is intended for failed initialization or aborted sessions.

**Data flow**: Calls `thread_store.discard_thread(self.thread_id).await` and returns the resulting `ThreadStoreResult<()>`.

**Call relations**: This is used directly by `LiveThreadInitGuard` and by explicit rollback paths.


##### `LiveThread::load_history`  (lines 192–202)

```
async fn load_history(
        &self,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThreadHistory>
```

**Purpose**: Loads the thread’s persisted rollout history through the underlying store. It is a convenience wrapper that binds the thread ID.

**Data flow**: Takes `include_archived`, constructs `LoadThreadHistoryParams { thread_id: self.thread_id, include_archived }`, awaits `thread_store.load_history(...)`, and returns the resulting `StoredThreadHistory`.

**Call relations**: This method is a read helper for callers that already hold a `LiveThread` and need its history.


##### `LiveThread::read_thread`  (lines 204–216)

```
async fn read_thread(
        &self,
        include_archived: bool,
        include_history: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads the thread’s stored metadata, optionally including history, through the underlying store. It is a convenience wrapper around `ReadThreadParams`.

**Data flow**: Takes `include_archived` and `include_history`, constructs `ReadThreadParams` with `self.thread_id`, awaits `thread_store.read_thread(...)`, and returns the resulting `StoredThread`.

**Call relations**: This method is used by callers that need a current persisted snapshot of the live thread.


##### `LiveThread::update_memory_mode`  (lines 218–235)

```
async fn update_memory_mode(
        &self,
        mode: ThreadMemoryMode,
        include_archived: bool,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Flushes pending metadata and then writes a targeted metadata patch that changes only the thread’s `ThreadMemoryMode`. It ensures prior inferred metadata is not lost or reordered.

**Data flow**: Takes a `ThreadMemoryMode` and `include_archived`, first awaits `flush_pending_metadata_update()?`, then sends `UpdateThreadMetadataParams` containing a `ThreadMetadataPatch { memory_mode: Some(mode), ..Default::default() }` to `thread_store.update_thread_metadata(...)`, discards the returned `StoredThread`, and returns `Ok(())`.

**Call relations**: This is a specialized metadata mutation helper for callers that need to toggle memory behavior on an active thread.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update); 1 external calls (default).


##### `LiveThread::update_metadata`  (lines 237–250)

```
async fn update_metadata(
        &self,
        patch: ThreadMetadataPatch,
        include_archived: bool,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Flushes pending inferred metadata and then applies an explicit caller-provided metadata patch. It returns the updated stored thread snapshot.

**Data flow**: Takes a `ThreadMetadataPatch` and `include_archived`, awaits `flush_pending_metadata_update()?`, sends the patch to `thread_store.update_thread_metadata(...)`, and returns the resulting `StoredThread`.

**Call relations**: This is the general metadata mutation API for active threads and complements the narrower `update_memory_mode` helper.

*Call graph*: calls 1 internal fn (flush_pending_metadata_update).


##### `LiveThread::local_rollout_path`  (lines 255–267)

```
async fn local_rollout_path(&self) -> ThreadStoreResult<Option<PathBuf>>
```

**Purpose**: Returns the live rollout file path only when the underlying store is a `LocalThreadStore`. For all other store types it explicitly reports that no local rollout path exists.

**Data flow**: Downcasts `self.thread_store.as_any()` to `LocalThreadStore`; if downcast fails, returns `Ok(None)`. If it succeeds, awaits `local_store.live_rollout_path(self.thread_id)`, wraps the resulting `PathBuf` in `Some`, and returns it.

**Call relations**: This is a compatibility helper for legacy local-only callers; it depends on the `ThreadStore` trait’s `as_any` downcast hook.


##### `LiveThread::flush_pending_metadata_update`  (lines 269–272)

```
async fn flush_pending_metadata_update(&self) -> ThreadStoreResult<()>
```

**Purpose**: Extracts any pending metadata patch regardless of whether history exists and applies it to the store. It is the common helper for persist and explicit metadata updates.

**Data flow**: Locks `metadata_sync`, calls `take_pending_update()`, then passes the resulting optional pending patch to `apply_pending_metadata_update` and returns that result.

**Call relations**: This helper is called by `persist`, `update_memory_mode`, and `update_metadata`.

*Call graph*: calls 1 internal fn (apply_pending_metadata_update); called by 3 (persist, update_memory_mode, update_metadata).


##### `LiveThread::flush_pending_metadata_update_for_existing_history`  (lines 274–281)

```
async fn flush_pending_metadata_update_for_existing_history(&self) -> ThreadStoreResult<()>
```

**Purpose**: Extracts only metadata patches that should be materialized once history already exists and applies them to the store. It prevents empty-thread metadata from being written too early.

**Data flow**: Locks `metadata_sync`, calls `take_pending_update_for_existing_history()`, forwards the optional patch to `apply_pending_metadata_update`, and returns that result.

**Call relations**: This helper is used by `flush` and `shutdown`, which operate at boundaries where existing history semantics matter.

*Call graph*: calls 1 internal fn (apply_pending_metadata_update); called by 2 (flush, shutdown).


##### `LiveThread::apply_pending_metadata_update`  (lines 283–302)

```
async fn apply_pending_metadata_update(
        &self,
        update: Option<crate::thread_metadata_sync::PendingThreadMetadataPatch>,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Writes a pending metadata patch to the underlying store and marks it applied in the sync state. If no patch is pending, it is a no-op.

**Data flow**: Takes an `Option<PendingThreadMetadataPatch>`, returns `Ok(())` immediately for `None`, otherwise sends `update.patch.clone()` to `thread_store.update_thread_metadata(UpdateThreadMetadataParams { thread_id: self.thread_id, include_archived: true, ... })`, then locks `metadata_sync` and calls `mark_pending_update_applied(&update)`, finally returning `Ok(())`.

**Call relations**: This is the shared sink used by both pending-update flush helpers so all metadata application follows the same write-then-mark-applied sequence.

*Call graph*: called by 2 (flush_pending_metadata_update, flush_pending_metadata_update_for_existing_history).


### `external-agent-sessions/src/lib.rs`

`orchestration` · `import preparation and shared crate utilities`

This crate root exposes the main session-import surface while keeping lower-level parsing and ledger details in submodules. It defines the public structs that move through the workflow: `ExternalAgentSessionMigration` for a discovered source file, `ImportedExternalAgentSession` for parsed/import-ready content, and `PendingSessionImport` for a validated import bundle that includes the canonical source path and content hash needed for later ledger recording.

The central orchestration function is `prepare_validated_session_import`. Given a discovered migration and a Codex home directory, it first asks the ledger whether the current source version has already been imported. Only if that check is false does it canonicalize and parse the file through `load_importable_session`, which delegates to the export layer and rejects sessions whose parsed `cwd` is not an existing directory. This means discovery and validation both enforce cwd existence, but validation rechecks it on the canonicalized parsed session.

The file also contains small shared helpers used by submodules: `summarize_for_label` extracts and truncates the first non-empty line of text to `SESSION_TITLE_MAX_LEN`, `truncate` appends `...` when needed while counting Unicode scalar values rather than bytes, and `now_unix_seconds` provides a best-effort current epoch timestamp with a zero fallback on clock errors. Tests cover skipping already imported sessions, surfacing preparation errors, and preserving the computed content hash.

#### Function details

##### `prepare_validated_session_import`  (lines 45–63)

```
fn prepare_validated_session_import(
    codex_home: &Path,
    session: ExternalAgentSessionMigration,
) -> io::Result<Option<PendingSessionImport>>
```

**Purpose**: Turns a discovered migration into a pending import only if the current source version has not already been imported and the session can still be parsed and validated.

**Data flow**: It takes `codex_home` and an `ExternalAgentSessionMigration`. It first calls `has_current_session_been_imported` with the migration path; if true, it returns `Ok(None)`. Otherwise it calls `load_importable_session` on the same path; if that returns `None`, it also returns `Ok(None)`. On success it packages the canonical source path, parsed `ImportedExternalAgentSession`, and content hash into `PendingSessionImport` and returns `Ok(Some(...))`.

**Call relations**: This is the crate's top-level validation step used by its tests and intended callers. It sequences the ledger check before the heavier parse/export path in `load_importable_session`.

*Call graph*: calls 2 internal fn (has_current_session_been_imported, load_importable_session); called by 3 (prepares_one_validated_session_import_with_content_hash, reports_session_preparation_errors, skips_session_that_was_already_imported).


##### `load_importable_session`  (lines 65–79)

```
fn load_importable_session(
    path: &Path,
) -> io::Result<Option<(PathBuf, ImportedExternalAgentSession, String)>>
```

**Purpose**: Canonicalizes a source path, loads the parsed import payload plus content hash, and rejects sessions whose parsed cwd is not an existing directory.

**Data flow**: It takes a path, canonicalizes it with `std::fs::canonicalize`, calls `load_session_for_import_with_content_sha256` on the canonical path, and if a session is returned, checks `imported_session.cwd.is_dir()`. It returns `Some((source_path, imported_session, source_content_sha256))` only when all checks pass.

**Call relations**: Called only by `prepare_validated_session_import`. It delegates parsing/export to the export module and performs the final cwd existence gate before a pending import is created.

*Call graph*: calls 1 internal fn (load_session_for_import_with_content_sha256); called by 1 (prepare_validated_session_import); 1 external calls (canonicalize).


##### `summarize_for_label`  (lines 94–97)

```
fn summarize_for_label(text: &str) -> String
```

**Purpose**: Builds a short label from message text by taking the first trimmed line and truncating it to the session title limit.

**Data flow**: It reads the input text, selects `text.lines().next().unwrap_or_default().trim()`, passes that string slice to `truncate` with `SESSION_TITLE_MAX_LEN`, and returns the resulting `String`.

**Call relations**: Used by both record summarization and import loading to derive fallback titles from the first user message.

*Call graph*: calls 1 internal fn (truncate).


##### `truncate`  (lines 99–108)

```
fn truncate(text: &str, max_len: usize) -> String
```

**Purpose**: Shortens a string to a maximum character count, appending an ellipsis when truncation occurs.

**Data flow**: It takes `text` and `max_len`, counts characters with `text.chars().count()`, returns the original string unchanged if already short enough, otherwise collects the first `max_len - 3` characters into a prefix and returns `"{prefix}..."`.

**Call relations**: This helper is called by `summarize_for_label` and also by record parsing code when bounding tool-call and tool-result notes.

*Call graph*: called by 1 (summarize_for_label); 1 external calls (format!).


##### `now_unix_seconds`  (lines 110–115)

```
fn now_unix_seconds() -> i64
```

**Purpose**: Returns the current Unix timestamp in whole seconds as `i64`.

**Data flow**: It reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, maps the duration to `as_secs() as i64`, and falls back to `0` if the system clock is before the epoch or another error occurs.

**Call relations**: Used by detection and ledger code as a shared timestamp source for recency checks and import bookkeeping.

*Call graph*: 1 external calls (now).


##### `tests::skips_session_that_was_already_imported`  (lines 126–139)

```
fn skips_session_that_was_already_imported()
```

**Purpose**: Verifies that validation returns `None` for a session whose current contents are already recorded in the ledger.

**Data flow**: It creates a temp Codex home and session file, writes minimal contents, records the session as imported via the ledger test helper, calls `prepare_validated_session_import`, and asserts the result is `None`.

**Call relations**: This test exercises the early ledger check in `prepare_validated_session_import`.

*Call graph*: calls 3 internal fn (record_imported_session, prepare_validated_session_import, new); 4 external calls (new, assert!, session_migration, write).


##### `tests::reports_session_preparation_errors`  (lines 142–150)

```
fn reports_session_preparation_errors()
```

**Purpose**: Checks that missing source files surface as I/O errors during preparation rather than being silently skipped.

**Data flow**: It constructs a nonexistent session path, calls `prepare_validated_session_import`, expects an error, and asserts that the error kind is `NotFound`.

**Call relations**: This test validates the error path through `load_importable_session` canonicalization.

*Call graph*: calls 1 internal fn (prepare_validated_session_import); 3 external calls (new, assert_eq!, session_migration).


##### `tests::prepares_one_validated_session_import_with_content_hash`  (lines 153–174)

```
fn prepares_one_validated_session_import_with_content_hash()
```

**Purpose**: Ensures successful preparation returns a pending import carrying the SHA-256 of the exact source contents.

**Data flow**: It writes a one-record session file, calls `prepare_validated_session_import`, unwraps the pending import, computes the expected SHA-256 from the original string, and asserts equality with `pending.source_content_sha256`.

**Call relations**: This test drives the full validation path through `load_session_for_import_with_content_sha256` and confirms the hash is preserved into `PendingSessionImport`.

*Call graph*: calls 1 internal fn (prepare_validated_session_import); 5 external calls (new, assert_eq!, session_migration, json!, write).


##### `tests::session_migration`  (lines 176–185)

```
fn session_migration(path: &Path) -> ExternalAgentSessionMigration
```

**Purpose**: Builds a minimal `ExternalAgentSessionMigration` fixture from a source path.

**Data flow**: It takes a path, copies it into `path`, derives `cwd` from the parent directory, sets `title` to `None`, and returns the struct.

**Call relations**: Used by the crate-root tests as a lightweight fixture constructor for `prepare_validated_session_import`.

*Call graph*: 2 external calls (parent, to_path_buf).


### `external-agent-sessions/src/detect.rs`

`domain_logic` · `session discovery before import`

This file implements the discovery pass over an external agent's on-disk session history. `detect_recent_sessions` starts from `<external_agent_home>/projects`, walks each project directory, and considers only `.jsonl` files whose filesystem modification time is within the 30-day import window. To avoid scanning and importing everything, it keeps only the newest 50 candidates in a `BinaryHeap<(Reverse<i64>, PathBuf)>`, where the key is modification time in nanoseconds; the heap is trimmed as it grows so older files fall out first.

The function cross-checks each candidate against the persisted import ledger loaded from `codex_home`. It skips files whose canonical path already has a matching `source_modified_at`, or older legacy records whose `imported_at` is newer than the file mtime. For the shortlisted files, it asks the ledger to `refresh_current_source`; if the current file contents already match an imported record, the ledger timestamp is refreshed and the file is not re-summarized. Otherwise it parses the file through `summarize_session`, extracts an `ExternalAgentSessionMigration`, and rejects sessions whose recorded `cwd` no longer exists as a directory.

A subtle design choice is that recency is based on file modification time, not message timestamps inside the JSONL. The tests in this file exercise title precedence rules, batching behavior across more than 50 files, skipping already imported current versions, and re-detecting sessions after source contents change.

#### Function details

##### `detect_recent_sessions`  (lines 16–109)

```
fn detect_recent_sessions(
    external_agent_home: &Path,
    codex_home: &Path,
) -> io::Result<Vec<ExternalAgentSessionMigration>>
```

**Purpose**: Scans the external-agent projects tree for recent session files, excludes already imported current versions using the ledger, summarizes the remaining files, and returns importable migrations.

**Data flow**: Inputs are `external_agent_home` and `codex_home`. It derives `projects_root`, reads the current Unix time, loads the import ledger, builds a map of prior source states, walks project subdirectories, reads file metadata, converts mtimes to seconds and nanoseconds, canonicalizes paths for ledger comparison, and pushes only recent unmatched `.jsonl` files into a bounded heap. It then iterates the sorted candidates, asks the ledger whether the current source version is already known, summarizes unknown files into `ExternalAgentSessionMigration`, filters out entries whose `cwd` is not an existing directory, optionally persists ledger refreshes, and returns `Vec<ExternalAgentSessionMigration>`.

**Call relations**: This is the file's main production entry and is exercised by the detection-focused tests in the module. During discovery it delegates persistence checks to `load_import_ledger`, `ImportedExternalAgentSessionLedger::source_states`, `ImportedExternalAgentSessionLedger::refresh_current_source`, and `save_import_ledger`, and delegates content parsing/title extraction to `summarize_session` only after a file survives the filesystem and ledger filters.

*Call graph*: calls 2 internal fn (load_import_ledger, save_import_ledger); called by 7 (detects_ai_title_over_first_user_message, detects_recent_sessions_with_existing_roots, detects_sessions_in_batches, prefers_custom_title_over_later_ai_title, prefers_latest_custom_title_over_first_user_message, redetects_sessions_when_source_contents_change_after_import, uses_file_modification_time_for_recency); 9 external calls (with_capacity, join, new, now_unix_seconds, summarize_session, canonicalize, read_dir, try_from, Reverse).


##### `tests::detects_recent_sessions_with_existing_roots`  (lines 124–148)

```
fn detects_recent_sessions_with_existing_roots()
```

**Purpose**: Verifies that a simple user/assistant session under an existing project root is discovered and converted into one migration with the first user message as title.

**Data flow**: It creates a temporary root, writes a session file under `.external/projects/repo`, invokes `detect_recent_sessions`, and asserts that the returned vector contains one `ExternalAgentSessionMigration` with the session path, project cwd, and title `hello there`.

**Call relations**: This test drives the happy path into `detect_recent_sessions` after constructing fixture JSONL via `write_session` and `record`.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 4 external calls (new, assert_eq!, record, write_session).


##### `tests::prefers_latest_custom_title_over_first_user_message`  (lines 151–176)

```
fn prefers_latest_custom_title_over_first_user_message()
```

**Purpose**: Checks that explicit custom-title records override the fallback title derived from the first user message, and that the latest custom title wins.

**Data flow**: It writes a session containing a user message followed by two `custom-title` records, runs detection, and asserts that the migration title is `final title` rather than the user text or the earlier custom title.

**Call relations**: The test invokes `detect_recent_sessions` on a crafted fixture built with `write_session`, `record`, and `custom_title_record` to validate title precedence implemented downstream in session summarization.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 5 external calls (new, assert_eq!, custom_title_record, record, write_session).


##### `tests::detects_ai_title_over_first_user_message`  (lines 179–203)

```
fn detects_ai_title_over_first_user_message()
```

**Purpose**: Confirms that an AI-generated title is used when present, instead of the first user message summary.

**Data flow**: It writes a session with one user record and one `ai-title` record, calls `detect_recent_sessions`, and asserts that the resulting migration title is the AI title string.

**Call relations**: This test reaches `detect_recent_sessions`, relying on fixture helpers and the parser/summarizer path to surface AI titles.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 5 external calls (new, assert_eq!, ai_title_record, record, write_session).


##### `tests::prefers_custom_title_over_later_ai_title`  (lines 206–231)

```
fn prefers_custom_title_over_later_ai_title()
```

**Purpose**: Ensures custom titles take precedence even if an AI title appears later in the file.

**Data flow**: It creates a session with a user message, then a custom title, then an AI title; after detection it asserts that the migration title remains `custom title`.

**Call relations**: The test exercises `detect_recent_sessions` with mixed title metadata to validate the precedence rules enforced by the record parser.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 6 external calls (new, assert_eq!, ai_title_record, custom_title_record, record, write_session).


##### `tests::uses_file_modification_time_for_recency`  (lines 234–260)

```
fn uses_file_modification_time_for_recency()
```

**Purpose**: Demonstrates that detection uses filesystem modification time rather than embedded message timestamps to decide whether a session is recent.

**Data flow**: It writes a session whose record timestamp is from 2020, leaves the file freshly created on disk, runs detection, and asserts that the session is still returned.

**Call relations**: This test calls `detect_recent_sessions` with a fixture built by `record_at` to prove the outer discovery logic keys off metadata, not parsed timestamps.

*Call graph*: calls 1 internal fn (detect_recent_sessions); 4 external calls (new, assert_eq!, record_at, write_session).


##### `tests::ignores_sessions_with_old_file_modification_time`  (lines 263–283)

```
fn ignores_sessions_with_old_file_modification_time()
```

**Purpose**: Verifies that a session file is skipped when its filesystem mtime is older than the configured import age window.

**Data flow**: It writes a session, forcibly sets its modified time near the Unix epoch with `set_modified_at`, runs detection, and asserts that the returned list is empty.

**Call relations**: Unlike the positive tests, this one validates the early mtime cutoff in `detect_recent_sessions` by manipulating file metadata directly.

*Call graph*: 6 external calls (from_secs, new, assert!, record, set_modified_at, write_session).


##### `tests::detects_sessions_in_batches`  (lines 286–361)

```
fn detects_sessions_in_batches()
```

**Purpose**: Exercises the bounded-candidate behavior across more than 50 files, plus ledger interactions that defer older sessions until newer ones are imported and re-detect changed files later.

**Data flow**: It creates `SESSION_IMPORT_MAX_COUNT + 1` session files with staggered mtimes, runs detection to confirm only the newest 50 are returned, records those imports, reruns detection to get the oldest remaining session, records it, rewrites all files with newer contents and mtimes, and repeats the assertions to confirm changed sources are rediscovered in the same batched pattern.

**Call relations**: This is the most comprehensive integration-style test for `detect_recent_sessions`; it also drives `record_imported_session` to mutate the ledger between detection passes.

*Call graph*: calls 3 internal fn (detect_recent_sessions, record_imported_session, new); 13 external calls (from_secs, now, new, new, assert_eq!, now, jsonl, record, record_at, set_modified_at (+3 more)).


##### `tests::skips_already_imported_current_session_versions`  (lines 364–383)

```
fn skips_already_imported_current_session_versions()
```

**Purpose**: Checks that a session whose current contents have already been recorded as imported is not returned again.

**Data flow**: It writes a session, records it as imported in the ledger, calls `detect_recent_sessions`, and asserts that the result is empty.

**Call relations**: This test validates the ledger short-circuit path used by `detect_recent_sessions`, with setup performed through `record_imported_session`.

*Call graph*: calls 2 internal fn (record_imported_session, new); 4 external calls (new, assert!, record, write_session).


##### `tests::redetects_sessions_when_source_contents_change_after_import`  (lines 386–417)

```
fn redetects_sessions_when_source_contents_change_after_import()
```

**Purpose**: Ensures that changing a previously imported session file causes it to become importable again.

**Data flow**: It writes and records a session as imported, overwrites the file with additional assistant content, reruns detection, and asserts that the session reappears as a migration.

**Call relations**: The test combines `record_imported_session` and `detect_recent_sessions` to verify that content-based ledger matching does not suppress modified files.

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

**Purpose**: Creates the expected external-agent directory layout and writes a JSONL session fixture file.

**Data flow**: It takes the external-agent home, project root, target filename, and JSON records; creates both the real project root and `.external/projects/repo`, serializes the records with `jsonl`, writes the file, and returns the resulting `PathBuf`.

**Call relations**: This helper is used by nearly every detection test to produce on-disk fixtures in the directory structure that `detect_recent_sessions` scans.

*Call graph*: 4 external calls (join, jsonl, create_dir_all, write).


##### `tests::set_modified_at`  (lines 433–440)

```
fn set_modified_at(path: &Path, modified_at: SystemTime)
```

**Purpose**: Mutates a session file's modification timestamp for recency tests.

**Data flow**: It opens the target path for writing, constructs `FileTimes` with the supplied `SystemTime` as the modified time, and applies it to the file in place.

**Call relations**: Used by tests that need to force files into or out of the recency window, especially the old-file and batching scenarios.

*Call graph*: 2 external calls (new, new).


##### `tests::record`  (lines 442–445)

```
fn record(role: &str, text: &str, cwd: &Path) -> JsonValue
```

**Purpose**: Builds a standard user or assistant JSON record using the current time.

**Data flow**: It accepts a role, text, and cwd, generates an RFC3339 timestamp for now, and forwards all fields to `record_at`, returning a `serde_json::Value` object.

**Call relations**: This helper feeds `write_session` in most tests; it exists to avoid repeating timestamp generation boilerplate.

*Call graph*: 2 external calls (now, record_at).


##### `tests::record_at`  (lines 447–454)

```
fn record_at(role: &str, text: &str, cwd: &Path, timestamp: &str) -> JsonValue
```

**Purpose**: Constructs a session message record with an explicit timestamp.

**Data flow**: It takes role, text, cwd, and timestamp string and returns a JSON object containing `type`, `cwd`, `timestamp`, and nested `message.content`.

**Call relations**: Used directly by the recency test and indirectly by `record` to create fixture lines consumed by `detect_recent_sessions`.

*Call graph*: 1 external calls (json!).


##### `tests::custom_title_record`  (lines 456–461)

```
fn custom_title_record(title: &str) -> JsonValue
```

**Purpose**: Creates a JSON fixture record representing a source-app custom title.

**Data flow**: It wraps the provided title string into a JSON object with `type: "custom-title"` and `customTitle`.

**Call relations**: Used by title-precedence tests to influence the title chosen during detection.

*Call graph*: 1 external calls (json!).


##### `tests::ai_title_record`  (lines 463–468)

```
fn ai_title_record(title: &str) -> JsonValue
```

**Purpose**: Creates a JSON fixture record representing a source-app AI-generated title.

**Data flow**: It wraps the provided title string into a JSON object with `type: "ai-title"` and `aiTitle`.

**Call relations**: Used by AI-title tests and mixed-title precedence tests that ultimately exercise `detect_recent_sessions`.

*Call graph*: 1 external calls (json!).


##### `tests::jsonl`  (lines 470–476)

```
fn jsonl(records: &[JsonValue]) -> String
```

**Purpose**: Serializes a slice of JSON values into newline-delimited JSON text.

**Data flow**: It iterates the input records, converts each `JsonValue` to a string, joins them with `\n`, and returns the resulting `String`.

**Call relations**: This helper underpins `write_session` and direct file rewrites in tests, producing the exact file format consumed by the detector.

*Call graph*: 1 external calls (iter).


### Server-side thread coordination
These files manage loaded-thread runtime state on the app and exec servers, including listener orchestration, filtering, refresh, and session attachment lifecycles.

### `app-server/src/filters.rs`

`domain_logic` · `thread listing/query filtering`

This file translates app-server thread source filters into the core protocol’s source model. `compute_source_filters` accepts an optional list of `ThreadSourceKind` values from the app-server protocol and returns a pair: a vector of coarse `CoreSessionSource` values that can be pushed down into the underlying query, and an optional copy of the original filter list for later post-filtering.

The function treats `None` and an empty list identically: both mean “interactive sources only,” implemented by returning `INTERACTIVE_SESSION_SOURCES.to_vec()` and no post-filter. When the caller requests only coarse interactive kinds (`Cli`, `VsCode`), those are converted directly into `CoreSessionSource::Cli` and `CoreSessionSource::VSCode`, and the original filter list is still returned for consistency. If any requested kind requires finer discrimination than the coarse query can express—`Exec`, `AppServer`, any `SubAgent` variant, or `Unknown`—the function returns an empty prefilter vector and the original filter list, signaling that the caller must fetch broadly and apply `source_kind_matches` afterward.

`source_kind_matches` performs that exact post-filtering. It matches `ThreadSourceKind` values against `CoreSessionSource`, including detailed subagent variant checks for review, compact, thread-spawn, and other subagent sources. The tests cover default behavior, interactive-only optimization, and the distinction between subagent variants.

#### Function details

##### `compute_source_filters`  (lines 6–51)

```
fn compute_source_filters(
    source_kinds: Option<Vec<ThreadSourceKind>>,
) -> (Vec<CoreSessionSource>, Option<Vec<ThreadSourceKind>>)
```

**Purpose**: Translates optional app-server source-kind filters into a coarse core-source prefilter plus an optional original filter list for post-filtering. It decides whether the requested kinds can be expressed directly or require later exact matching.

**Data flow**: Takes `Option<Vec<ThreadSourceKind>>`. If `None` or an empty vector, returns `(INTERACTIVE_SESSION_SOURCES.to_vec(), None)`. Otherwise it scans the kinds for any variant requiring post-filtering (`Exec`, `AppServer`, all `SubAgent` variants, `Unknown`). If any are present, it returns `(Vec::new(), Some(source_kinds))`; otherwise it maps `Cli` and `VsCode` into `CoreSessionSource` values, collects them, and returns `(interactive_sources, Some(source_kinds))`.

**Call relations**: Used by thread-query code before hitting the underlying store/query layer. Callers use the returned coarse sources for pushdown filtering and, when the second tuple element is `Some`, apply `source_kind_matches` afterward.

*Call graph*: called by 4 (compute_source_filters_defaults_to_interactive_sources, compute_source_filters_empty_means_interactive_sources, compute_source_filters_interactive_only_skips_post_filtering, compute_source_filters_subagent_variant_requires_post_filtering); 1 external calls (new).


##### `source_kind_matches`  (lines 53–82)

```
fn source_kind_matches(source: &CoreSessionSource, filter: &[ThreadSourceKind]) -> bool
```

**Purpose**: Checks whether a concrete core session source satisfies any of the requested app-server source kinds. It provides the exact post-filtering logic for cases where coarse query filtering is insufficient.

**Data flow**: Inputs are a `&CoreSessionSource` and a slice of `ThreadSourceKind`. It iterates the filter slice and returns `true` if any kind matches the source according to variant-specific rules: direct matches for `Cli`, `VsCode`, `Exec`, `AppServer`/`Mcp`, broad `SubAgent`, and narrower checks for each `CoreSubAgentSource` subtype; otherwise returns `false`.

**Call relations**: Used after `compute_source_filters` when the caller needs exact filtering, especially for subagent subtype distinctions and other non-interactive source kinds.

*Call graph*: 1 external calls (iter).


##### `tests::compute_source_filters_defaults_to_interactive_sources`  (lines 92–97)

```
fn compute_source_filters_defaults_to_interactive_sources()
```

**Purpose**: Verifies that omitting source kinds defaults to the predefined interactive session sources and requires no post-filter. This codifies the module’s default query behavior.

**Data flow**: Calls `compute_source_filters(None)` and asserts the returned allowed sources equal `INTERACTIVE_SESSION_SOURCES.to_vec()` and the post-filter is `None`.

**Call relations**: Exercises the `None` branch of `compute_source_filters`.

*Call graph*: calls 1 internal fn (compute_source_filters); 1 external calls (assert_eq!).


##### `tests::compute_source_filters_empty_means_interactive_sources`  (lines 100–105)

```
fn compute_source_filters_empty_means_interactive_sources()
```

**Purpose**: Verifies that an explicitly empty source-kind list is treated the same as no filter at all. This avoids surprising semantics for empty client arrays.

**Data flow**: Calls `compute_source_filters(Some(Vec::new()))` and asserts the same outputs as the default case: interactive sources and no post-filter.

**Call relations**: Exercises the empty-vector branch of `compute_source_filters`.

*Call graph*: calls 1 internal fn (compute_source_filters); 2 external calls (new, assert_eq!).


##### `tests::compute_source_filters_interactive_only_skips_post_filtering`  (lines 108–117)

```
fn compute_source_filters_interactive_only_skips_post_filtering()
```

**Purpose**: Checks that a filter containing only `Cli` and `VsCode` can be translated directly into coarse core sources without needing the expensive broad-query fallback. It also preserves the original filter list.

**Data flow**: Builds `vec![ThreadSourceKind::Cli, ThreadSourceKind::VsCode]`, calls `compute_source_filters`, and asserts the returned allowed sources are `[CoreSessionSource::Cli, CoreSessionSource::VSCode]` and the filter is `Some(source_kinds)`.

**Call relations**: Exercises the interactive-only mapping branch of `compute_source_filters`.

*Call graph*: calls 1 internal fn (compute_source_filters); 2 external calls (assert_eq!, vec!).


##### `tests::compute_source_filters_subagent_variant_requires_post_filtering`  (lines 120–126)

```
fn compute_source_filters_subagent_variant_requires_post_filtering()
```

**Purpose**: Verifies that requesting a specific subagent subtype cannot be represented as a coarse prefilter and therefore forces post-filtering. This protects the distinction between broad subagent and subtype-specific queries.

**Data flow**: Builds `vec![ThreadSourceKind::SubAgentReview]`, calls `compute_source_filters`, and asserts the allowed-source vector is empty while the original filter list is preserved in `Some(...)`.

**Call relations**: Exercises the `requires_post_filter` branch of `compute_source_filters`.

*Call graph*: calls 1 internal fn (compute_source_filters); 2 external calls (assert_eq!, vec!).


##### `tests::source_kind_matches_distinguishes_subagent_variants`  (lines 129–157)

```
fn source_kind_matches_distinguishes_subagent_variants()
```

**Purpose**: Checks that `source_kind_matches` differentiates review subagents from thread-spawn subagents rather than treating all subagents as interchangeable. This is the key correctness property for subtype post-filtering.

**Data flow**: Constructs a random parent thread ID, builds `CoreSessionSource::SubAgent(CoreSubAgentSource::Review)` and `CoreSessionSource::SubAgent(CoreSubAgentSource::ThreadSpawn { ... })`, then asserts positive and negative matches against `SubAgentReview` and `SubAgentThreadSpawn` filters.

**Call relations**: Exercises the subtype-specific match arms in `source_kind_matches`.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (SubAgent, new_v4, assert!).


### `app-server/src/thread_state.rs`

`data_model` · `cross-cutting runtime state during thread attachment, event streaming, and teardown`

This file is the central in-memory state model for live threads. At the lowest level, `ThreadState` stores transient execution facts: queued interrupt/rollback request IDs, a `TurnSummary`, the last terminal turn ID, an optional listener cancellation sender, whether experimental raw events are enabled, a monotonically wrapping `listener_generation`, the last observed `ThreadSettings`, an optional unbounded sender for serialized `ThreadListenerCommand`s, a `ThreadHistoryBuilder` for the current turn, a weak pointer to the active `CodexThread`, and the current `WatchRegistration` tied to that listener.

The listener-related methods enforce important invariants. `set_listener` cancels any previous listener before installing a new one, increments generation, resets the command channel, stores a weak thread reference, and replaces the watch registration. `clear_listener` cancels the listener, drops the command sender, resets current-turn history, clears the weak thread reference, and resets watch registration to default. `track_current_turn_event` feeds every `EventMsg` into `ThreadHistoryBuilder`, captures `started_at` from `TurnStarted`, and when an abort/complete leaves no active turn it records `last_terminal_turn_id` and resets history.

`resolve_server_request_on_thread_listener` is a synchronization helper: it sends a `ResolveServerRequest` command through the listener FIFO and waits on a oneshot completion so request-resolution notifications stay ordered relative to the original request stream.

Above that, `ThreadStateManager` maintains global maps: live connection capabilities, `ThreadEntry` records per thread, reverse membership from connection to thread IDs, and a separate synchronous `StdMutex<HashMap<ThreadId, UnboundedSender<ThreadListenerCommand>>>` so non-async extension sinks can enqueue listener work without awaiting. Its methods cover connection initialization/removal, subscription bookkeeping, listener sender registration, thread-state creation and teardown, and watch subscriptions that expose whether a thread still has any connected clients.

#### Function details

##### `ThreadState::listener_matches`  (lines 92–97)

```
fn listener_matches(&self, conversation: &Arc<CodexThread>) -> bool
```

**Purpose**: Checks whether the currently registered listener weak reference still points to the given `CodexThread`. It is used to verify that operations target the active listener instance rather than a stale thread object.

**Data flow**: Takes `&self` and `&Arc<CodexThread>`, upgrades `self.listener_thread: Option<Weak<CodexThread>>`, and compares the upgraded `Arc` to the input with `Arc::ptr_eq`. It returns a boolean and does not mutate state.

**Call relations**: Used by listener-management code that needs identity, not just thread ID, to guard against races when listeners are replaced. It delegates only to weak upgrade and pointer equality.


##### `ThreadState::set_listener`  (lines 99–116)

```
fn set_listener(
        &mut self,
        cancel_tx: oneshot::Sender<()>,
        conversation: &Arc<CodexThread>,
        watch_registration: WatchRegistration,
        thread_settings_baseline: Th
```

**Purpose**: Installs a new active listener for the thread, replacing any previous one and creating a fresh command channel for serialized listener work. It also snapshots baseline settings and watch registration for that listener generation.

**Data flow**: Consumes `&mut self`, a new `oneshot::Sender<()>` cancel handle, `&Arc<CodexThread>`, a `WatchRegistration`, and baseline `ThreadSettings`. If `self.cancel_tx` already exists it sends cancellation to the previous listener. It increments `listener_generation`, stores `last_thread_settings`, creates a new unbounded channel, saves its sender in `listener_command_tx`, stores a downgraded weak thread pointer and the watch registration, and returns `(listener_command_rx, listener_generation)`.

**Call relations**: Called when a thread listener is attached or replaced. It serializes listener replacement by actively cancelling the old listener before exposing the new receiver, and downstream code uses the returned receiver/generation to run the listener loop.

*Call graph*: 2 external calls (downgrade, unbounded_channel).


##### `ThreadState::clear_listener`  (lines 118–126)

```
fn clear_listener(&mut self)
```

**Purpose**: Removes all listener-associated state from a thread and cancels any running listener task. It is the cleanup path used during thread teardown and global shutdown.

**Data flow**: Takes `&mut self`; if `cancel_tx` is present it sends cancellation, then clears `listener_command_tx`, resets `current_turn_history`, sets `listener_thread` to `None`, and replaces `watch_registration` with `WatchRegistration::default()`. It returns `()`.

**Call relations**: Invoked by `ThreadStateManager::remove_thread_state` and `ThreadStateManager::clear_all_listeners` after unregistering the synchronous listener sender. It delegates turn-history cleanup to `ThreadHistoryBuilder::reset` and ensures no stale watch registration survives listener teardown.

*Call graph*: calls 2 internal fn (reset, default).


##### `ThreadState::set_experimental_raw_events`  (lines 128–130)

```
fn set_experimental_raw_events(&mut self, enabled: bool)
```

**Purpose**: Turns on or off the flag indicating that this thread should expose experimental raw events. The method is a simple setter on per-thread runtime state.

**Data flow**: Accepts `&mut self` and a boolean `enabled`, writes that value into `self.experimental_raw_events`, and returns `()`. No other state is touched.

**Call relations**: Used when a connection subscribes with experimental raw-event support so later event emission can consult the flag. It does not delegate further.


##### `ThreadState::listener_command_tx`  (lines 132–136)

```
fn listener_command_tx(
        &self,
    ) -> Option<mpsc::UnboundedSender<ThreadListenerCommand>>
```

**Purpose**: Returns a clone of the current listener command sender if a listener is active. This gives callers a way to enqueue ordered work onto the listener FIFO.

**Data flow**: Reads `self.listener_command_tx: Option<mpsc::UnboundedSender<ThreadListenerCommand>>`, clones the sender if present, and returns the cloned `Option`. It does not mutate state.

**Call relations**: Used by async helpers such as `resolve_server_request_on_thread_listener` and by manager code that needs to hand out the current sender. Cloning the sender avoids exposing interior mutable references.


##### `ThreadState::active_turn_snapshot`  (lines 138–140)

```
fn active_turn_snapshot(&self) -> Option<Turn>
```

**Purpose**: Exposes the current in-progress turn snapshot assembled by `ThreadHistoryBuilder`. It lets callers inspect active-turn state without directly manipulating the builder.

**Data flow**: Reads `self.current_turn_history` and returns `Option<Turn>` from `active_turn_snapshot()`. No state is modified.

**Call relations**: Queried during teardown logging and other thread-view assembly paths that need to know whether a turn is currently active. It delegates the actual snapshot construction to `ThreadHistoryBuilder`.

*Call graph*: calls 1 internal fn (active_turn_snapshot).


##### `ThreadState::track_current_turn_event`  (lines 142–153)

```
fn track_current_turn_event(&mut self, event_turn_id: &str, event: &EventMsg)
```

**Purpose**: Feeds a protocol event into the current-turn accumulator and updates summary fields such as start time and last terminal turn ID. It keeps per-thread transient turn state coherent as events stream in.

**Data flow**: Takes `&mut self`, an `event_turn_id: &str`, and `&EventMsg`. If the event is `EventMsg::TurnStarted`, it copies `payload.started_at` into `turn_summary.started_at`. It then forwards the event to `current_turn_history.handle_event(event)`. If the event is `TurnAborted` or `TurnComplete` and the history builder reports no active turn afterward, it stores `last_terminal_turn_id = Some(event_turn_id.to_string())` and resets the history builder.

**Call relations**: Called by event-processing code whenever a thread-level event arrives. It delegates detailed turn reconstruction to `ThreadHistoryBuilder`, while adding app-server-specific bookkeeping around start timestamps and terminal-turn cleanup.

*Call graph*: calls 3 internal fn (handle_event, has_active_turn, reset); 1 external calls (matches!).


##### `ThreadState::note_thread_settings`  (lines 155–159)

```
fn note_thread_settings(&mut self, thread_settings: ThreadSettings) -> bool
```

**Purpose**: Records the latest thread settings and reports whether they differ from the previously remembered settings. This supports emitting updates only when effective settings actually change.

**Data flow**: Accepts `&mut self` and a `ThreadSettings` value, compares it against `self.last_thread_settings.as_ref()`, stores the new settings into `last_thread_settings`, and returns `true` if the previous value was absent or unequal. No other fields are changed.

**Call relations**: Used by thread-update flows that need change detection rather than blind replacement. The tests in this file document that repeated identical settings produce `false` after the first write.


##### `resolve_server_request_on_thread_listener`  (lines 162–192)

```
async fn resolve_server_request_on_thread_listener(
    thread_state: &Arc<Mutex<ThreadState>>,
    request_id: RequestId,
)
```

**Purpose**: Synchronously resolves a pending server request in listener order by sending a `ResolveServerRequest` command to the active thread listener and waiting for completion. It preserves ordering between the original request and its resolution notification.

**Data flow**: Takes `&Arc<Mutex<ThreadState>>` and a `RequestId`. It creates a oneshot `(completion_tx, completion_rx)`, locks the thread state to clone the current listener command sender, logs and returns early if no listener exists, sends `ThreadListenerCommand::ResolveServerRequest { request_id, completion_tx }` on the unbounded channel, logs and returns if the channel is closed, then awaits `completion_rx` and logs any receive error. It returns `()` and writes only through the listener command channel and logs.

**Call relations**: Called by multiple approval/user-input response handlers after they have processed a client reply and need the listener to emit the corresponding resolved notification in FIFO order. It depends on `ThreadState::listener_command_tx` and on the listener loop honoring `ResolveServerRequest` by eventually completing the oneshot.

*Call graph*: called by 5 (on_command_execution_request_approval_response, on_file_change_request_approval_response, on_mcp_server_elicitation_response, on_request_permissions_response, on_request_user_input_response); 2 external calls (error!, channel).


##### `tests::note_thread_settings_reports_only_effective_changes`  (lines 206–219)

```
fn note_thread_settings_reports_only_effective_changes()
```

**Purpose**: Checks that `note_thread_settings` returns `true` only when the incoming settings differ from the last stored value. It verifies both the initial write and repeated identical writes.

**Data flow**: Creates a default `ThreadState`, builds two `ThreadSettings` values with different models, calls `note_thread_settings` four times, collects the booleans into a vector, and asserts the sequence is `[true, false, true, false]`. No persistent runtime state is involved beyond the local test object.

**Call relations**: This test directly exercises the change-detection semantics of `ThreadState::note_thread_settings`. It documents that equality is based on the full `ThreadSettings` value, not object identity.

*Call graph*: 4 external calls (default, thread_settings, assert_eq!, vec!).


##### `tests::thread_settings`  (lines 221–245)

```
fn thread_settings(model: &str) -> ThreadSettings
```

**Purpose**: Constructs a representative `ThreadSettings` value for tests, varying only the model-related fields. It provides stable fixtures for equality/change-detection assertions.

**Data flow**: Accepts a `&str` model name, converts `/tmp` into an `AbsolutePathBuf`, and returns a fully populated `ThreadSettings` struct with fixed approval, sandbox, provider, collaboration, and optional fields, while inserting the supplied model into both top-level and collaboration settings. It writes no external state.

**Call relations**: Used only by the settings-change test to generate comparable baseline and updated settings. It isolates fixture construction so the test focuses on behavior rather than struct boilerplate.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `ThreadEntry::default`  (lines 255–261)

```
fn default() -> Self
```

**Purpose**: Creates the default per-thread entry stored inside `ThreadStateManager`, including an empty thread state, no subscribed connections, and a watch channel initialized to `false`. It is the lazy-initialization path for new thread IDs.

**Data flow**: Allocates `Arc<Mutex<ThreadState::default()>>`, initializes `connection_ids` as an empty `HashSet`, creates a `watch::channel(false)` and stores the sender, then returns the assembled `ThreadEntry`. The receiver half is discarded.

**Call relations**: Used implicitly by `HashMap::entry(...).or_default()` throughout `ThreadStateManager` whenever a thread is first referenced. The embedded watch sender is later updated by `update_has_connections` and subscribed to by `subscribe_to_has_connections`.

*Call graph*: 5 external calls (new, new, new, default, channel).


##### `ThreadEntry::update_has_connections`  (lines 265–271)

```
fn update_has_connections(&self)
```

**Purpose**: Publishes whether the thread currently has any subscribed connections. It keeps the per-thread `watch::Sender<bool>` synchronized with `connection_ids`.

**Data flow**: Reads `self.connection_ids.is_empty()`, then calls `send_if_modified` on `has_connections_watcher` to replace the current boolean with `!is_empty`. It returns `()` and suppresses send errors by ignoring the result.

**Call relations**: Called whenever connection membership changes for a thread—during subscribe, add, unsubscribe, and remove flows. It is the bridge between internal connection bookkeeping and external watchers waiting for a thread to become empty or non-empty.

*Call graph*: 1 external calls (send_if_modified).


##### `ThreadStateManager::new`  (lines 296–298)

```
fn new() -> Self
```

**Purpose**: Constructs an empty manager for all thread and connection runtime state. It is the standard entry point for this subsystem.

**Data flow**: Returns `Self::default()`, which creates empty async and sync maps for live connections, thread entries, reverse connection-to-thread membership, and listener command senders. No inputs are required.

**Call relations**: Called during app-server initialization and in tests. All later thread-state and subscription operations hang off the manager instance it creates.

*Call graph*: called by 7 (app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears, new, adding_connection_to_thread_updates_has_connections_watcher, closed_connection_cannot_be_reintroduced_by_auto_subscribe, first_attestation_capable_connection_for_thread_only_uses_thread_subscribers, removing_auto_attached_connection_preserves_listener_for_other_connections, removing_thread_state_clears_listener_and_active_turn_history); 1 external calls (default).


##### `ThreadStateManager::connection_initialized`  (lines 300–310)

```
async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        capabilities: ConnectionCapabilities,
    )
```

**Purpose**: Registers a newly initialized connection and its capabilities in the global live-connection map. This is the prerequisite for later thread subscription or attachment.

**Data flow**: Takes `&self`, a `ConnectionId`, and `ConnectionCapabilities`; locks `self.state`, inserts the capability record into `live_connections`, and returns `()`. It mutates only the manager’s connection map.

**Call relations**: Called from connection setup once the transport/session is ready. Later methods such as `try_ensure_connection_subscribed` and `try_add_connection_to_thread` consult this map and refuse unknown connections.

*Call graph*: called by 1 (connection_initialized).


##### `ThreadStateManager::first_attestation_capable_connection_for_thread`  (lines 312–330)

```
async fn first_attestation_capable_connection_for_thread(
        &self,
        thread_id: ThreadId,
    ) -> Option<ConnectionId>
```

**Purpose**: Finds the lowest-numbered subscribed connection for a thread that advertises `request_attestation` capability. It selects a deterministic target when attestation must be requested from one client.

**Data flow**: Locks manager state, looks up the `ThreadEntry` for the given `ThreadId`, iterates its `connection_ids`, joins each against `live_connections`, filters to those whose `ConnectionCapabilities.request_attestation` is `true`, and returns the minimum `ConnectionId` by numeric key. If the thread or any capable connection is absent, it returns `None`.

**Call relations**: Used by attestation-request logic to choose a client among current subscribers. It depends on both subscription bookkeeping and capability registration having been populated earlier.

*Call graph*: called by 1 (request_attestation_header_value_with_timeout).


##### `ThreadStateManager::subscribed_connection_ids`  (lines 332–339)

```
async fn subscribed_connection_ids(&self, thread_id: ThreadId) -> Vec<ConnectionId>
```

**Purpose**: Returns the current set of subscribed connection IDs for a thread as a vector. It provides a snapshot suitable for fan-out operations.

**Data flow**: Locks manager state, looks up the thread entry, copies its `connection_ids` into a `Vec<ConnectionId>`, and returns that vector; if the thread is unknown it returns an empty vector. No state is mutated.

**Call relations**: Called by flows that need to send updates or resume data to all current subscribers. It is a read-only view over the manager’s thread membership map.

*Call graph*: called by 2 (resolve_pending_server_request, resume_running_thread).


##### `ThreadStateManager::thread_state`  (lines 341–344)

```
async fn thread_state(&self, thread_id: ThreadId) -> Arc<Mutex<ThreadState>>
```

**Purpose**: Gets the shared `Arc<Mutex<ThreadState>>` for a thread, creating a default entry if necessary. This is the main accessor for per-thread mutable runtime state.

**Data flow**: Locks manager state mutably, inserts a default `ThreadEntry` for the given `ThreadId` if absent, clones its `state` arc, and returns it. The only mutation is lazy creation of missing entries.

**Call relations**: Used by many thread-oriented operations—resume, rollback, interrupt, listener attachment, goal updates—to obtain the canonical mutable state object. It relies on `ThreadEntry::default` for first-time initialization.

*Call graph*: called by 8 (emit_thread_goal_snapshot, thread_goal_clear_inner, thread_goal_set_inner, resume_running_thread, thread_rollback_start, thread_turns_list_response_inner, try_attach_thread_listener, turn_interrupt_inner).


##### `ThreadStateManager::current_listener_command_tx`  (lines 346–355)

```
fn current_listener_command_tx(
        &self,
        thread_id: ThreadId,
    ) -> Option<mpsc::UnboundedSender<ThreadListenerCommand>>
```

**Purpose**: Provides an await-free lookup of the current listener command sender for a thread. This supports synchronous event sinks that cannot lock the async manager state.

**Data flow**: Locks the separate `StdMutex`-protected `listener_commands` map, clones the sender for the given `ThreadId` if present, and returns `Option<mpsc::UnboundedSender<ThreadListenerCommand>>`. It does not touch the async state map.

**Call relations**: Used by synchronous emit paths that need to enqueue ordered listener commands without `.await`. The sender is populated and removed by `register_listener_command_tx` and `unregister_listener_command_tx`.

*Call graph*: called by 1 (emit).


##### `ThreadStateManager::register_listener_command_tx`  (lines 357–366)

```
fn register_listener_command_tx(
        &self,
        thread_id: ThreadId,
        tx: mpsc::UnboundedSender<ThreadListenerCommand>,
    )
```

**Purpose**: Stores the current listener command sender for a thread in the synchronous lookup table. This makes the active listener reachable from await-free contexts.

**Data flow**: Takes `&self`, a `ThreadId`, and an unbounded sender; locks `listener_commands` and inserts the sender under that thread ID. It returns `()`.

**Call relations**: Called when a listener is attached and its command channel becomes active. It complements `current_listener_command_tx` and must be paired with `unregister_listener_command_tx` during teardown or replacement.


##### `ThreadStateManager::unregister_listener_command_tx`  (lines 368–373)

```
fn unregister_listener_command_tx(&self, thread_id: ThreadId)
```

**Purpose**: Removes the synchronous listener command sender for a thread. This prevents future enqueue attempts from targeting a listener that is shutting down or gone.

**Data flow**: Locks `listener_commands` and removes the entry for the given `ThreadId`, returning `()`. It mutates only the synchronous sender map.

**Call relations**: Called by `remove_thread_state` and `clear_all_listeners` before they clear the underlying `ThreadState`. It is the manager-level half of listener teardown.

*Call graph*: called by 2 (clear_all_listeners, remove_thread_state).


##### `ThreadStateManager::remove_thread_state`  (lines 375–401)

```
async fn remove_thread_state(&self, thread_id: ThreadId)
```

**Purpose**: Fully tears down a thread’s manager entry, reverse connection mappings, synchronous listener sender, and in-thread listener state. It is the definitive cleanup path for a thread that is being unloaded.

**Data flow**: Locks manager state, removes the `ThreadEntry` for `thread_id`, removes that thread ID from every `thread_ids_by_connection` set and drops empty sets, then releases the lock. It unregisters the listener command sender, and if a thread state existed, locks that `ThreadState`, logs debug metadata (`thread_id`, `listener_generation`, whether a listener or active turn existed), and calls `clear_listener()`. It returns `()`.

**Call relations**: Invoked by thread-unload/finalize-teardown flows when a thread should disappear entirely. It coordinates manager-level map cleanup with per-thread listener cancellation and history reset.

*Call graph*: calls 1 internal fn (unregister_listener_command_tx); called by 2 (unload_thread_without_subscribers, finalize_thread_teardown); 1 external calls (debug!).


##### `ThreadStateManager::clear_all_listeners`  (lines 403–425)

```
async fn clear_all_listeners(&self)
```

**Purpose**: Cancels and clears listener state for every tracked thread without removing the thread entries themselves. This is used for app-server-wide shutdown of listener activity.

**Data flow**: Locks manager state to collect `(ThreadId, Arc<Mutex<ThreadState>>)` pairs, then iterates them outside the lock. For each thread it unregisters the synchronous sender, locks the thread state, logs debug metadata, and calls `clear_listener()`. It returns `()`.

**Call relations**: Called during app-server shutdown to stop all active listeners in a controlled way. Unlike `remove_thread_state`, it preserves the thread entries and connection bookkeeping while clearing listener-specific runtime state.

*Call graph*: calls 1 internal fn (unregister_listener_command_tx); called by 1 (clear_all_thread_listeners); 1 external calls (debug!).


##### `ThreadStateManager::unsubscribe_connection_from_thread`  (lines 427–459)

```
async fn unsubscribe_connection_from_thread(
        &self,
        thread_id: ThreadId,
        connection_id: ConnectionId,
    ) -> bool
```

**Purpose**: Removes a specific connection’s subscription to a specific thread if that relationship currently exists. It reports whether anything was actually removed.

**Data flow**: Locks manager state, returns `false` immediately if the thread is unknown or the reverse mapping does not show the connection subscribed to that thread. Otherwise it removes the thread ID from `thread_ids_by_connection[connection_id]`, deletes the reverse entry if now empty, removes the connection ID from the thread entry’s `connection_ids`, calls `update_has_connections()`, and returns `true`.

**Call relations**: Used by explicit thread-unsubscribe handling. It updates both forward and reverse membership maps and publishes any resulting has-connections change through the thread entry watcher.

*Call graph*: called by 1 (thread_unsubscribe_response_inner).


##### `ThreadStateManager::has_subscribers`  (lines 462–469)

```
async fn has_subscribers(&self, thread_id: ThreadId) -> bool
```

**Purpose**: Test-only helper that reports whether a thread currently has any subscribed connections. It exposes the same condition tracked by `has_connections_watcher` in a direct query form.

**Data flow**: Locks manager state, looks up the thread entry, checks whether `connection_ids` is non-empty, and returns a boolean. Unknown threads yield `false`.

**Call relations**: Used only in tests to assert subscription bookkeeping behavior. It does not participate in production call flow.


##### `ThreadStateManager::try_ensure_connection_subscribed`  (lines 471–499)

```
async fn try_ensure_connection_subscribed(
        &self,
        thread_id: ThreadId,
        connection_id: ConnectionId,
        experimental_raw_events: bool,
    ) -> Option<Arc<Mutex<ThreadState
```

**Purpose**: Ensures a live connection is subscribed to a thread, creating the thread entry if needed and optionally enabling experimental raw events on that thread state. It returns the thread state only when the connection is known live.

**Data flow**: Locks manager state; if `live_connections` lacks `connection_id`, returns `None`. Otherwise it inserts `thread_id` into `thread_ids_by_connection[connection_id]`, inserts `connection_id` into the thread entry’s `connection_ids`, calls `update_has_connections()`, clones the thread state arc, then locks that thread state and sets `experimental_raw_events` to `true` if requested. Finally it returns `Some(thread_state)`.

**Call relations**: Used by subscription/auto-attach flows that need both membership bookkeeping and access to the thread state. It bridges manager-level connection validation with per-thread feature-flag mutation.


##### `ThreadStateManager::try_add_connection_to_thread`  (lines 501–519)

```
async fn try_add_connection_to_thread(
        &self,
        thread_id: ThreadId,
        connection_id: ConnectionId,
    ) -> bool
```

**Purpose**: Adds a live connection to a thread’s subscriber set without touching per-thread experimental flags. It is a lighter-weight membership update than `try_ensure_connection_subscribed`.

**Data flow**: Locks manager state, returns `false` if the connection is not present in `live_connections`, otherwise inserts the thread ID into the reverse map, inserts the connection ID into the thread entry’s `connection_ids`, calls `update_has_connections()`, and returns `true`.

**Call relations**: Called when handling pending thread resume requests to attach another connection to an already tracked thread. It updates only subscription bookkeeping and watcher state.

*Call graph*: called by 1 (handle_pending_thread_resume_request).


##### `ThreadStateManager::remove_connection`  (lines 521–545)

```
async fn remove_connection(&self, connection_id: ConnectionId) -> Vec<ThreadId>
```

**Purpose**: Removes a connection from the global live set and from every thread it was subscribed to, returning the thread IDs that became subscriber-less as a result. This is the connection-close cleanup path.

**Data flow**: Locks manager state, removes `connection_id` from `live_connections`, removes and takes its thread-ID set from `thread_ids_by_connection`, then for each affected thread removes the connection from `thread_entry.connection_ids` and calls `update_has_connections()`. It returns a `Vec<ThreadId>` containing only those affected threads whose `connection_ids` are now empty.

**Call relations**: Called when a transport connection closes. The returned empty-thread list is used by higher-level teardown logic to decide which threads may now be unloaded.

*Call graph*: called by 1 (connection_closed).


##### `ThreadStateManager::subscribe_to_has_connections`  (lines 547–556)

```
async fn subscribe_to_has_connections(
        &self,
        thread_id: ThreadId,
    ) -> Option<watch::Receiver<bool>>
```

**Purpose**: Subscribes to a watch channel that tracks whether a thread currently has any connected subscribers. It gives callers a reactive signal for thread liveness from the client side.

**Data flow**: Locks manager state, looks up the thread entry for the given `ThreadId`, and if present returns `Some(thread_entry.has_connections_watcher.subscribe())`; otherwise returns `None`. No state is mutated.

**Call relations**: Used by code that wants to observe transitions between zero and non-zero subscribers, such as unload logic. It depends on `ThreadEntry::update_has_connections` to keep the watched boolean current.


### `app-server/src/request_processors/thread_lifecycle.rs`

`orchestration` · `main loop and request handling`

This file contains the long-lived runtime machinery around loaded threads. `ListenerTaskContext` packages the shared managers and channels needed by listener tasks. `UnloadingState` watches two `watch::Receiver`s—whether the thread has subscribers and whether its `ThreadStatus` is active—and computes an unload deadline only when the thread is both unsubscribed and inactive for `THREAD_UNLOADING_DELAY` (30 minutes). Its loop in `wait_for_unloading_trigger` races sleep against watch updates and exits cleanly if either watch channel closes.

`ensure_conversation_listener` is the public attach path: it rejects missing threads, serializes against `pending_thread_unloads`, subscribes the connection in `ThreadStateManager`, and then ensures a listener task exists. `ensure_listener_task_running` either reuses an existing matching listener or registers a new one, captures a listener command receiver, and spawns the main task. That task multiplexes cancellation, explicit `ThreadListenerCommand`s, `conversation.next_event()` output, and unload triggers. Incoming thread events are first tracked into `ThreadState`; raw response items may be suppressed unless raw events are enabled, with a special hook-completion fallback. Other events go through `apply_bespoke_event_handling`.

The file also handles ordered commands such as resume responses, goal notifications, and server-request resolution. `handle_pending_thread_resume_request` reconstructs a `ThreadResumeResponse` for an already running thread, merges persisted history with any active in-memory turn, redacts payloads when requested, attaches the connection only if the thread is not closing, replays token-usage and goal snapshots, and finally replays pending server requests before allowing idle lifecycle hooks to fire.

#### Function details

##### `UnloadingState::new`  (lines 27–52)

```
async fn new(
        listener_task_context: &ListenerTaskContext,
        thread_id: ThreadId,
        delay: Duration,
    ) -> Option<Self>
```

**Purpose**: Initializes unload-tracking state for a loaded thread by subscribing to connection and status watches. It snapshots both current booleans with timestamps so later deadline calculations know when each condition last changed.

**Data flow**: Takes `listener_task_context`, `thread_id`, and `delay`. It awaits `thread_state_manager.subscribe_to_has_connections(thread_id)` and `thread_watch_manager.subscribe(thread_id)`, returning `None` if either subscription cannot be created. It reads the current watch values, computes `(bool, Instant::now())` pairs for `has_subscribers` and `is_active`, and returns `Some(UnloadingState { ... })`.

**Call relations**: Called by `ensure_listener_task_running` when a listener task starts; if it returns `None`, listener startup fails with a closing-thread invalid request.

*Call graph*: called by 1 (ensure_listener_task_running); 2 external calls (now, matches!).


##### `UnloadingState::unloading_target`  (lines 54–61)

```
fn unloading_target(&self) -> Option<Instant>
```

**Purpose**: Computes the earliest instant at which the thread may be unloaded. Unloading is only eligible when the thread has had no subscribers and has been inactive, and the later of those two timestamps is used as the start of the delay window.

**Data flow**: Reads `self.has_subscribers` and `self.is_active`. If both booleans are `false`, it returns `Some(max(has_no_subscribers_since, is_inactive_since) + self.delay)`; otherwise it returns `None`.

**Call relations**: Used by both `should_unload_now` and `wait_for_unloading_trigger` to decide whether an unload deadline exists and when it expires.

*Call graph*: called by 2 (should_unload_now, wait_for_unloading_trigger); 1 external calls (max).


##### `UnloadingState::sync_receiver_values`  (lines 63–73)

```
fn sync_receiver_values(&mut self)
```

**Purpose**: Refreshes cached booleans from the watch receivers and updates their timestamps only when the boolean value changes. This preserves the duration each condition has continuously held.

**Data flow**: Borrows the current values from `has_subscribers_rx` and `thread_status_rx`, compares them to `self.has_subscribers.0` and `self.is_active.0`, and when a value differs replaces the tuple with `(new_value, Instant::now())`.

**Call relations**: Called before deadline checks in `should_unload_now` and repeatedly inside `wait_for_unloading_trigger` after watch changes.

*Call graph*: called by 2 (should_unload_now, wait_for_unloading_trigger); 3 external calls (now, borrow, matches!).


##### `UnloadingState::should_unload_now`  (lines 75–79)

```
fn should_unload_now(&mut self) -> bool
```

**Purpose**: Performs an immediate unload eligibility check against the current time. It is used after wakeups to guard against stale or superseded unload conditions.

**Data flow**: Mutably borrows `self`, calls `sync_receiver_values()`, computes `self.unloading_target()`, and returns `true` only when a target exists and is less than or equal to `Instant::now()`.

**Call relations**: Used inside the listener task’s unload branch after `wait_for_unloading_trigger` returns, and again after acquiring the pending-unloads lock to avoid races.

*Call graph*: calls 2 internal fn (sync_receiver_values, unloading_target).


##### `UnloadingState::note_thread_activity_observed`  (lines 81–85)

```
fn note_thread_activity_observed(&mut self)
```

**Purpose**: Resets the inactivity timestamp when the listener notices the thread is still effectively active despite watch state. This delays unloading after a late activity observation.

**Data flow**: If `self.is_active.0` is currently `false`, it rewrites `self.is_active` to `(false, Instant::now())`; otherwise it leaves the tuple unchanged.

**Call relations**: Called by the listener task when the unload timer fires but `conversation.agent_status().await` still reports `AgentStatus::Running`, preventing immediate unload.

*Call graph*: 1 external calls (now).


##### `UnloadingState::wait_for_unloading_trigger`  (lines 87–119)

```
async fn wait_for_unloading_trigger(&mut self) -> bool
```

**Purpose**: Waits until either the unload deadline arrives, one of the watched conditions changes, or the watch channels close. It is the blocking primitive behind idle-thread auto-unload.

**Data flow**: Loops forever, calling `sync_receiver_values()` and `unloading_target()`. If a target exists and is already due, it returns `true`. Otherwise it builds an async sleep that waits until the target or never resolves when no target exists, then `tokio::select!`s between that sleep and `changed()` notifications from `has_subscribers_rx` and `thread_status_rx`. Closed watch channels return `false`; successful changes resync state and continue looping.

**Call relations**: Used only by the spawned listener task in `ensure_listener_task_running` to drive the unload branch of its main select loop.

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

**Purpose**: Attaches a connection to a loaded thread and ensures the thread’s listener task is running. It rejects missing threads and threads already in the middle of unload teardown.

**Data flow**: Consumes `ListenerTaskContext`, `conversation_id`, `connection_id`, and `raw_events_enabled`. It fetches the thread from `thread_manager`, returning `invalid_request("thread not found: ...")` on failure. Under the `pending_thread_unloads` lock it rejects threads already closing, then calls `thread_state_manager.try_ensure_connection_subscribed(...)`; `None` yields `Ok(ConnectionClosed)`. With the returned `thread_state`, it awaits `ensure_listener_task_running(...)`; if that fails it unsubscribes the connection and returns the error. Otherwise it returns `Ok(Attached)`.

**Call relations**: Called from thread start/resume/fork flows and from helper wrappers in `ThreadRequestProcessor`. It delegates listener-task startup to `ensure_listener_task_running` after subscription bookkeeping succeeds.

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

**Purpose**: Logs the outcome of an attempted listener attachment without changing control flow. It suppresses noise for successful attaches, emits debug logs for closed connections, and warns on actual errors.

**Data flow**: Matches `result: Result<EnsureConversationListenerResult, JSONRPCErrorError>`. `Attached` does nothing; `ConnectionClosed` logs a debug message with `thread_id` and `connection_id`; `Err(err)` logs a warning using `err.message` and the supplied `thread_kind` label.

**Call relations**: Used by thread start/resume/fork and listener-attach helper paths to record best-effort auto-attach outcomes while allowing the main request flow to continue.

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

**Purpose**: Starts or reuses the per-thread listener task that forwards thread events, handles ordered commands, and unloads idle threads. It is the central runtime loop for loaded-thread observation.

**Data flow**: Creates a cancellation oneshot, initializes `UnloadingState::new`, reads thread config/environment selections, registers skill watching, computes a thread-settings baseline, and locks `thread_state` to either detect an already matching listener or install a new one via `set_listener`. It registers the listener command sender in `thread_state_manager`, then spawns an async task that `select!`s over cancellation, `listener_command_rx.recv()`, `conversation.next_event()`, and `unloading_state.wait_for_unloading_trigger()`. Commands are delegated to `handle_thread_listener_command`; events are tracked into `ThreadState`, optionally filtered for raw-event opt-in, and otherwise passed to `apply_bespoke_event_handling`; unload triggers may call `unload_thread_without_subscribers`. On task exit it clears the listener only if the generation still matches.

**Call relations**: Called by `ensure_conversation_listener` and by `ThreadRequestProcessor::resume_running_thread` when rejoining a running thread. It orchestrates `UnloadingState`, command handling, event handling, and unload teardown.

*Call graph*: calls 1 internal fn (new); called by 2 (ensure_conversation_listener, ensure_listener_task_running); 6 external calls (clone, format!, channel, select!, spawn, warn!).


##### `wait_for_thread_shutdown`  (lines 398–404)

```
async fn wait_for_thread_shutdown(thread: &Arc<CodexThread>) -> ThreadShutdownResult
```

**Purpose**: Waits up to 10 seconds for a thread to shut down after submitting its shutdown request. It collapses timeout and submission failure into a small enum used by teardown code.

**Data flow**: Awaits `tokio::time::timeout(Duration::from_secs(10), thread.shutdown_and_wait())`. It returns `ThreadShutdownResult::Complete` for `Ok(Ok(()))`, `SubmitFailed` for `Ok(Err(_))`, and `TimedOut` for timeout expiry.

**Call relations**: Used by `unload_thread_without_subscribers` and by higher-level thread-removal code in `thread_processor.rs` to standardize shutdown outcomes.

*Call graph*: called by 1 (unload_thread_without_subscribers); 2 external calls (from_secs, timeout).


##### `unload_thread_without_subscribers`  (lines 406–456)

```
async fn unload_thread_without_subscribers(
    thread_manager: Arc<ThreadManager>,
    outgoing: Arc<OutgoingMessageSender>,
    pending_thread_unloads: Arc<Mutex<HashSet<ThreadId>>>,
    thread_stat
```

**Purpose**: Begins asynchronous teardown of an idle loaded thread that has no subscribers. It cancels pending server requests immediately, removes thread state, then performs shutdown/removal in a detached task.

**Data flow**: Logs that the thread is idle and unsubscribed, calls `outgoing.cancel_requests_for_thread(thread_id, None).await`, and `thread_state_manager.remove_thread_state(thread_id).await`. It then spawns a task that awaits `wait_for_thread_shutdown(&thread)`. On `Complete`, it removes the thread from `thread_manager`, removes watch-manager state, sends `ServerNotification::ThreadClosed` if the thread was actually removed, and clears `pending_thread_unloads`; on `SubmitFailed` or `TimedOut`, it just clears `pending_thread_unloads` and logs a warning.

**Call relations**: Called only from the listener task inside `ensure_listener_task_running` once `UnloadingState` says the thread should be unloaded and the pending-unloads set has been updated.

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

**Purpose**: Executes ordered commands sent to a thread listener task, such as running-thread resume responses, goal notifications, goal snapshots, and server-request resolution. It keeps these outputs serialized with live thread events.

**Data flow**: Matches `listener_command: ThreadListenerCommand`. `SendThreadResumeResponse` delegates to `handle_pending_thread_resume_request`; `EmitThreadGoalUpdated` and `EmitThreadGoalCleared` send the corresponding server notifications with `conversation_id.to_string()`; `EmitThreadGoalSnapshot` delegates to `send_thread_goal_snapshot_notification`; `ResolveServerRequest` delegates to `resolve_pending_server_request` and then signals `completion_tx`.

**Call relations**: Called from the listener task’s command branch in `ensure_listener_task_running`. It is the execution side of commands enqueued by thread-goal code and running-thread resume logic.

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

**Purpose**: Builds and sends a `ThreadResumeResponse` for a thread that is already loaded and running under a listener task. It reconstructs turns, status, optional initial page, token usage, goal snapshot, and pending server-request replay in the correct order.

**Data flow**: Reads the active turn snapshot from `thread_state`, determines `has_live_in_progress_turn` from `conversation.agent_status()` and active-turn status, and starts from `pending.thread_summary`. If `pending.include_turns` is true it calls `populate_thread_turns_from_history`. It fetches loaded status from `thread_watch_manager`, applies `set_thread_status_and_interrupt_stale_turns`, optionally builds `initial_turns_page` with `build_thread_resume_initial_turns_page`, and redacts payloads when requested. Under `pending_thread_unloads` lock it rejects closing threads, then calls `thread_state_manager.try_add_connection_to_thread`; closed connections are silently skipped. It assembles `ThreadResumeResponse` from `pending.config_snapshot`, sends it, optionally sends token-usage replay, optionally emits a goal snapshot via `send_thread_goal_snapshot_notification`, replays pending server requests to the connection, and finally calls `conversation.emit_thread_idle_lifecycle_if_idle()` when goal updates were requested.

**Call relations**: Reached only through `handle_thread_listener_command` when `resume_running_thread` has enqueued a pending resume request onto the listener command channel.

*Call graph*: calls 6 internal fn (populate_thread_turns_from_history, send_thread_goal_snapshot_notification, set_thread_status_and_interrupt_stale_turns, build_thread_resume_initial_turns_page, try_add_connection_to_thread, loaded_status_for_thread); called by 1 (handle_thread_listener_command); 4 external calls (format!, matches!, debug!, warn!).


##### `send_thread_goal_snapshot_notification`  (lines 706–739)

```
async fn send_thread_goal_snapshot_notification(
    outgoing: &Arc<OutgoingMessageSender>,
    thread_id: ThreadId,
    state_db: &StateDbHandle,
)
```

**Purpose**: Reads the current goal for a thread from state DB and emits either a goal-updated or goal-cleared notification. It is the direct-notification fallback and resume snapshot implementation.

**Data flow**: Calls `state_db.thread_goals().get_thread_goal(thread_id).await`. If it returns `Ok(Some(goal))`, it converts the goal with `api_thread_goal_from_state` and sends `ServerNotification::ThreadGoalUpdated`; if `Ok(None)`, it sends `ServerNotification::ThreadGoalCleared`; if `Err(err)`, it logs a warning with the thread ID.

**Call relations**: Called by `handle_pending_thread_resume_request`, by `handle_thread_listener_command` for explicit snapshot commands, and by goal-processor fallback paths.

*Call graph*: called by 2 (handle_pending_thread_resume_request, handle_thread_listener_command); 5 external calls (ThreadGoalCleared, ThreadGoalUpdated, thread_goals, to_string, warn!).


##### `populate_thread_turns_from_history`  (lines 741–751)

```
fn populate_thread_turns_from_history(
    thread: &mut Thread,
    items: &[RolloutItem],
    active_turn: Option<&Turn>,
)
```

**Purpose**: Reconstructs API turns from rollout history and optionally merges in a live active turn snapshot. It is used when resume responses need full turn data.

**Data flow**: Takes mutable `thread: &mut Thread`, `items: &[RolloutItem]`, and optional `active_turn`. It builds turns with `build_api_turns_from_rollout_items(items)`, optionally calls `merge_turn_history_with_active_turn(&mut turns, active_turn.clone())`, and assigns the resulting vector to `thread.turns`.

**Call relations**: Used by `handle_pending_thread_resume_request` and elsewhere in thread processing when persisted history must be turned into API `Turn` objects.

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

**Purpose**: Broadcasts that a server-originated request tied to a thread has been resolved. It scopes the notification to currently subscribed connections for that thread.

**Data flow**: Converts `conversation_id` to a string, fetches subscribed connection IDs from `thread_state_manager`, constructs a `ThreadScopedOutgoingMessageSender` with those IDs and the thread ID, and sends `ServerNotification::ServerRequestResolved(ServerRequestResolvedNotification { thread_id, request_id })`.

**Call relations**: Called by `handle_thread_listener_command` when processing `ThreadListenerCommand::ResolveServerRequest`.

*Call graph*: calls 2 internal fn (new, subscribed_connection_ids); called by 1 (handle_thread_listener_command); 2 external calls (ServerRequestResolved, to_string).


##### `merge_turn_history_with_active_turn`  (lines 778–781)

```
fn merge_turn_history_with_active_turn(turns: &mut Vec<Turn>, active_turn: Turn)
```

**Purpose**: Replaces any historical copy of the active turn with the live active-turn snapshot. This avoids duplicate turn IDs and ensures the freshest in-memory state wins.

**Data flow**: Mutably borrows `turns: &mut Vec<Turn>`, removes any existing turn whose `id` matches `active_turn.id`, then pushes `active_turn` onto the vector.

**Call relations**: Used by `populate_thread_turns_from_history` and by turn-reconstruction helpers in the main thread processor.

*Call graph*: called by 1 (populate_thread_turns_from_history).


##### `set_thread_status_and_interrupt_stale_turns`  (lines 783–797)

```
fn set_thread_status_and_interrupt_stale_turns(
    thread: &mut Thread,
    loaded_status: ThreadStatus,
    has_live_in_progress_turn: bool,
)
```

**Purpose**: Normalizes a thread’s overall status and rewrites lingering `InProgress` turns to `Interrupted` when the thread is not actually active. This keeps resumed/read thread views consistent with runtime state.

**Data flow**: Computes `status = resolve_thread_status(loaded_status, has_live_in_progress_turn)`. If the resolved status is not `ThreadStatus::Active { .. }`, it iterates `thread.turns` and changes any `TurnStatus::InProgress` to `TurnStatus::Interrupted`. It then assigns `thread.status = status`.

**Call relations**: Called by `handle_pending_thread_resume_request` and by several read/resume paths in `thread_processor.rs` to reconcile turn statuses with loaded-thread state.

*Call graph*: called by 1 (handle_pending_thread_resume_request); 1 external calls (matches!).


### `app-server/src/mcp_refresh.rs`

`orchestration` · `config change propagation / thread refresh handling`

This file implements the bridge between configuration changes and per-thread MCP server refresh work. Its core path starts by enumerating all thread IDs from `ThreadManager`, resolving each `CodexThread`, deriving a fresh `McpServerRefreshConfig`, and submitting `Op::RefreshMcpServers` back into the thread. The strict path first forces a global config reload and then performs a two-phase process: it builds refresh payloads for all threads before submitting any refresh, so a single planning failure aborts the whole operation without partially queueing updates. The best-effort path instead processes threads one by one, logging `tracing::warn!` messages for thread lookup failures, config-build failures, or submit failures and continuing with the remaining threads.

The refresh payload is intentionally rebuilt from the latest config rather than the thread's currently loaded config. `build_refresh_config` reads the thread's own config only to obtain thread context, asks `ConfigManager` for the latest effective config for that thread, computes runtime MCP config via `CodexThread::runtime_mcp_config`, extracts configured MCP servers, and serializes the server list plus auth-related settings into JSON fields required by `McpServerRefreshConfig`. Tests construct a real `ThreadManager` with two threads and a custom `ThreadConfigLoader` that succeeds for one cwd and fails for another, proving the difference between strict and best-effort semantics and confirming that auth keyring backend values come from the latest on-disk config, not stale thread state.

#### Function details

##### `queue_strict_refresh`  (lines 11–31)

```
async fn queue_strict_refresh(
    thread_manager: &Arc<ThreadManager>,
    config_manager: &ConfigManager,
) -> io::Result<()>
```

**Purpose**: Performs a fail-fast MCP refresh pass across all threads. It reloads the latest global config, computes refresh configs for every thread first, and only then submits refresh operations.

**Data flow**: It takes an `Arc<ThreadManager>` and `ConfigManager`. It first invokes `config_manager.load_latest_config(None)` to refresh process-wide config state, then reads all thread IDs from the manager, resolves each `Arc<CodexThread>`, and transforms each thread into a `(ThreadId, Arc<CodexThread>, McpServerRefreshConfig)` tuple via `build_refresh_config`. In a second loop it submits each tuple through `queue_refresh`. It returns `Ok(())` on full success or an `io::Error` if config reload, thread lookup, refresh-config construction, or queue submission fails.

**Call relations**: This is used when callers need all-or-nothing planning semantics, including the MCP refresh response path and the strict-refresh test. It delegates per-thread payload construction to `build_refresh_config` and actual operation submission to `queue_refresh`; any error from either stage aborts the whole run.

*Call graph*: calls 3 internal fn (load_latest_config, build_refresh_config, queue_refresh); called by 2 (strict_refresh_reports_thread_planning_failures, mcp_server_refresh_response); 1 external calls (new).


##### `queue_best_effort_refresh`  (lines 33–56)

```
async fn queue_best_effort_refresh(
    thread_manager: &Arc<ThreadManager>,
    config_manager: &ConfigManager,
)
```

**Purpose**: Attempts to queue MCP refreshes for all threads while tolerating individual failures. It is designed for background refresh triggers where partial success is acceptable.

**Data flow**: It accepts the same `ThreadManager` and `ConfigManager`, iterates over `list_thread_ids()`, and for each ID tries to fetch the thread, build a `McpServerRefreshConfig`, and submit it. Each failure branch emits a warning and skips to the next thread instead of returning early. It produces no result value and writes only log output plus any successfully queued thread operations.

**Call relations**: This function is invoked by plugin-change background tasks and by its dedicated test. It follows the same per-thread pipeline as the strict variant, calling `build_refresh_config` and `queue_refresh`, but changes control flow by swallowing errors after logging them with `warn!`.

*Call graph*: calls 2 internal fn (build_refresh_config, queue_refresh); called by 3 (best_effort_refresh_attempts_every_loaded_thread, spawn_effective_plugins_changed_task, spawn_effective_plugins_changed_task); 1 external calls (warn!).


##### `build_refresh_config`  (lines 58–77)

```
async fn build_refresh_config(
    thread: &CodexThread,
    config_manager: &ConfigManager,
) -> io::Result<McpServerRefreshConfig>
```

**Purpose**: Constructs the exact `McpServerRefreshConfig` payload that a thread needs for `RefreshMcpServers`. It recomputes MCP-related settings from the latest effective config for that thread context.

**Data flow**: It receives a borrowed `CodexThread` and `ConfigManager`. It reads the thread's current config via `thread.config().await`, passes that thread-specific context into `config_manager.load_latest_config_for_thread(...)`, derives runtime MCP settings with `thread.runtime_mcp_config(&config).await`, extracts server definitions using `codex_mcp::configured_mcp_servers`, and serializes the server list, `mcp_oauth_credentials_store_mode`, and `auth_keyring_backend_kind()` into JSON values. It returns a populated `McpServerRefreshConfig` or an `io::Error` if config loading or JSON serialization fails.

**Call relations**: Both refresh queueing functions depend on this helper to produce per-thread payloads, and one test calls it directly to verify auth backend freshness. Its role is the planning step between thread identity/context and the final queued `Op::RefreshMcpServers`.

*Call graph*: calls 3 internal fn (load_latest_config_for_thread, config, runtime_mcp_config); called by 3 (queue_best_effort_refresh, queue_strict_refresh, refresh_config_uses_latest_auth_keyring_backend); 2 external calls (configured_mcp_servers, to_value).


##### `queue_refresh`  (lines 79–93)

```
async fn queue_refresh(
    thread_id: ThreadId,
    thread: Arc<CodexThread>,
    config: McpServerRefreshConfig,
) -> io::Result<()>
```

**Purpose**: Submits a `RefreshMcpServers` operation into a specific thread and normalizes submission errors into `io::Error`. It is the final dispatch step after refresh config planning.

**Data flow**: It takes a `ThreadId`, an `Arc<CodexThread>`, and a ready `McpServerRefreshConfig`. It calls `thread.submit(Op::RefreshMcpServers { config }).await`, discards the submit return payload by mapping success to `()`, and rewrites any thread-submit error into an `io::Error` that includes the thread ID. Its only side effect is enqueuing work inside the target thread.

**Call relations**: This helper is called by both `queue_strict_refresh` and `queue_best_effort_refresh` after they have resolved the thread and built the config. It does not delegate further within this file; it is the leaf that hands control to the thread's internal operation queue.

*Call graph*: called by 2 (queue_best_effort_refresh, queue_strict_refresh).


##### `tests::strict_refresh_reports_thread_planning_failures`  (lines 126–135)

```
async fn strict_refresh_reports_thread_planning_failures() -> anyhow::Result<()>
```

**Purpose**: Verifies that the strict refresh path surfaces a per-thread config planning failure as an overall error. The test asserts the exact propagated message from the failing loader.

**Data flow**: It builds a test environment with `refresh_test_state`, invokes `queue_strict_refresh`, expects an error instead of success, and compares the resulting error string to `failed to load refresh config`. It reads the prepared thread/config state and writes only test assertions.

**Call relations**: This test exercises `queue_strict_refresh` under a setup where one thread's config loader intentionally fails. Its purpose is to confirm the fail-fast behavior rather than warning-and-continue semantics.

*Call graph*: calls 1 internal fn (queue_strict_refresh); 2 external calls (refresh_test_state, assert_eq!).


##### `tests::best_effort_refresh_attempts_every_loaded_thread`  (lines 138–146)

```
async fn best_effort_refresh_attempts_every_loaded_thread() -> anyhow::Result<()>
```

**Purpose**: Checks that the best-effort refresh path still attempts config loading for both good and bad threads. It validates continuation after one thread fails.

**Data flow**: It obtains the shared test state and the `CountingThreadConfigLoader`, runs `queue_best_effort_refresh`, then reads `good_loads` and `bad_loads` atomics with relaxed ordering and asserts both counters equal 1. The observable output is the assertion that both threads were processed.

**Call relations**: This test targets `queue_best_effort_refresh` specifically to prove that one failing thread does not stop iteration. It relies on the custom loader's counters established by `refresh_test_state`.

*Call graph*: calls 1 internal fn (queue_best_effort_refresh); 2 external calls (refresh_test_state, assert_eq!).


##### `tests::refresh_config_uses_latest_auth_keyring_backend`  (lines 149–178)

```
async fn refresh_config_uses_latest_auth_keyring_backend() -> anyhow::Result<()>
```

**Purpose**: Confirms that refresh payload generation uses the newest config file contents for auth backend selection, not the thread's stale in-memory config. It focuses on the `auth_keyring_backend_kind` field inside `McpServerRefreshConfig`.

**Data flow**: It creates test state, rewrites the root config file to enable secret auth storage, scans thread IDs to find the thread whose cwd ends with `good`, and calls `build_refresh_config` for that thread. It deserializes `refresh_config.auth_keyring_backend_kind` back into `AuthKeyringBackendKind`, then compares it against both the thread's current config-derived backend (`Direct`) and the refreshed backend (`Secrets`).

**Call relations**: This test calls `build_refresh_config` directly because it needs to inspect the generated payload rather than queue behavior. It demonstrates the design choice that refresh planning consults `ConfigManager` for latest effective config per thread.

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

**Purpose**: Builds an integration-style test fixture containing a temporary config root, two threads with different cwd values, a real `ThreadManager`, and a custom counting config loader. It centralizes the substantial setup needed by all refresh tests.

**Data flow**: It creates a `TempDir`, `good` and `bad` subdirectories, and an initial config file; constructs an initial `ConfigManager` to load `good_config` and `bad_config`; initializes auth, state DB, thread store, environment manager, skill provider, and a cyclic `ThreadManager`; starts one thread for each config; then creates `CountingThreadConfigLoader` with cwd-specific counters and injects it into a new `ConfigManager`. It returns the temp dir, shared thread manager, config manager, and loader so tests can drive refresh logic and inspect loader counters.

**Call relations**: All three tests call this fixture builder before exercising refresh behavior. It does not participate in production call flow; its role is to assemble realistic dependencies so the tested functions interact with actual thread/config machinery.

*Call graph*: calls 9 internal fn (new, without_managed_config_for_tests, default, without_managed_config_for_tests, default_for_tests, new_with_restriction_product, from_auth_for_testing, from_api_key, try_from); 12 external calls (clone, new, new_cyclic, new, new, new, default, init_state_db, thread_store_from_config, default (+2 more)).


##### `tests::CountingThreadConfigLoader::load`  (lines 305–310)

```
fn load(
            &self,
            context: ThreadConfigContext,
        ) -> codex_config::ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Implements a deterministic test loader that counts loads by cwd and fails only for the designated bad thread. It simulates thread-specific config planning success and failure.

**Data flow**: It accepts a `ThreadConfigContext`, compares `context.cwd` against the stored `good_cwd` and `bad_cwd`, increments `good_loads` or `bad_loads` atomics accordingly, and returns either `Ok(Vec::new())` for non-failing contexts or a `ThreadConfigLoadError` with code `Internal` and message `failed to load refresh config` for the bad cwd. Through the trait impl, this async body is boxed into the expected loader future type.

**Call relations**: This method is reached indirectly when `build_refresh_config` asks `ConfigManager` to load the latest config for a thread during tests. Its controlled failure drives the divergent outcomes asserted by the strict and best-effort refresh tests.

*Call graph*: calls 1 internal fn (new); 4 external calls (fetch_add, pin, new, load).


### `exec-server/src/server/session_registry.rs`

`domain_logic` · `session creation, connection handoff, and delayed expiry`

This file implements the session-resume mechanism that lets process state survive transport disconnects. `SessionRegistry` owns an async `Mutex<HashMap<String, Arc<SessionEntry>>>` keyed by session id. Each `SessionEntry` stores the stable `session_id`, a cloneable `ProcessHandler`, and a synchronous `StdMutex<AttachmentState>` describing which connection is currently attached, which connection most recently detached, and when that detached grace period expires. The detached TTL is intentionally short in tests (200 ms) and longer in normal builds (10 s).

`attach` is the central operation. For a fresh session, it generates a new UUID session id and connection id, creates a `SessionEntry` with a new `ProcessHandler`, inserts it into the map, and returns a `SessionHandle`. For resume, it looks up the requested session id, rejects unknown ids, removes and shuts down expired detached sessions, rejects sessions still attached elsewhere, or reattaches a detached session by swapping in the new `RpcNotificationSender` and updating attachment state. The returned `SessionHandle` carries the registry, entry, and caller's `ConnectionId`.

Detachment is split between `SessionEntry::detach` and `SessionHandle::detach`. A successful detach clears the current attachment, records the detaching connection id and expiry deadline, disables notifications on the process handler, and spawns `expire_if_detached`, which sleeps for the TTL and then removes and shuts down the session only if no new connection has reattached in the meantime. Helper methods such as `has_active_connection`, `is_attached_to`, `is_expired`, and `is_detached_connection_expired` encode the invariants used to reject duplicate resumes and to ensure only the exact detached connection's expiry task can reap the session.

The locking strategy is deliberate: the session map uses Tokio's async mutex because attach/expire are async operations, while per-entry attachment state uses a standard mutex because those checks are short, synchronous, and frequently performed from non-async helper methods.

#### Function details

##### `ConnectionId::fmt`  (lines 39–41)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a `ConnectionId` by delegating to the wrapped `Uuid`. It gives connection ids a readable string form for diagnostics and API exposure.

**Data flow**: Reads the inner `Uuid` from `self.0` and writes its formatted representation into the provided formatter. It returns the standard formatting result.

**Call relations**: This implementation supports `SessionHandle::connection_id`, which exposes the current connection id as a string.


##### `SessionRegistry::new`  (lines 52–56)

```
fn new() -> Arc<Self>
```

**Purpose**: Creates a new shared session registry with no sessions. It is the standard constructor used by processors and tests.

**Data flow**: Allocates an empty `HashMap`, wraps it in a Tokio `Mutex`, wraps the registry in `Arc`, and returns `Arc<SessionRegistry>`.

**Call relations**: Called wherever a fresh session namespace is needed, including production processor construction and tests that model multiple handlers sharing one registry.

*Call graph*: called by 6 (active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, new, transport_disconnect_detaches_session_during_in_flight_read); 3 external calls (new, new, new).


##### `SessionRegistry::attach`  (lines 58–117)

```
async fn attach(
        self: &Arc<Self>,
        resume_session_id: Option<String>,
        notifications: RpcNotificationSender,
    ) -> Result<SessionHandle, JSONRPCErrorError>
```

**Purpose**: Attaches a connection to either a new session or an existing detached session, enforcing single-active-connection semantics and expired-session cleanup. It is the registry's main state transition function.

**Data flow**: Accepts `&Arc<Self>`, an optional resume session id, and a `RpcNotificationSender`. It generates a new `ConnectionId`, locks the session map, and either: looks up and validates a requested session id, rejecting unknown or actively attached sessions; removes and marks expired sessions for shutdown; or creates and inserts a new `SessionEntry` with a fresh UUID session id and `ProcessHandler::new(notifications)`. For successful resume it installs the new notification sender and calls `SessionEntry::attach(connection_id)`. After releasing the map lock, if the outcome was expired it awaits `entry.process.shutdown()` and returns an invalid-request error; otherwise it returns a `SessionHandle` containing cloned registry and entry references plus the new connection id.

**Call relations**: This method is invoked by higher-level handler initialization when a client starts a new session or requests resume. It coordinates `SessionEntry` state transitions and `ProcessHandler` notification swapping so resumed sessions continue using the same process state.

*Call graph*: calls 3 internal fn (invalid_request, new, new); 6 external calls (clone, new, Attached, new_v4, format!, now).


##### `SessionRegistry::expire_if_detached`  (lines 119–136)

```
async fn expire_if_detached(&self, session_id: String, connection_id: ConnectionId)
```

**Purpose**: Reaps a detached session after the grace period if no reconnection has occurred. It is the delayed cleanup task spawned on detach.

**Data flow**: Takes a session id string and the detaching `ConnectionId`, sleeps for `DETACHED_SESSION_TTL`, then locks the session map and checks whether the named entry still exists and whether `entry.is_detached_connection_expired(connection_id, now)` is true. If so it removes the entry from the map; after unlocking, if an entry was removed it awaits `entry.process.shutdown()`.

**Call relations**: Spawned asynchronously by `SessionHandle::detach` after a successful detach. Its connection-id check prevents an old expiry task from deleting a session that has since been resumed or detached by a different connection.

*Call graph*: 2 external calls (now, sleep).


##### `SessionRegistry::default`  (lines 140–144)

```
fn default() -> Self
```

**Purpose**: Provides a non-`Arc` default registry value with an empty session map. It supports APIs that rely on `Default` rather than the shared constructor.

**Data flow**: Creates an empty `HashMap`, wraps it in a Tokio `Mutex`, and returns `SessionRegistry` by value.

**Call relations**: This is an alternate constructor path; the rest of the session logic typically uses `SessionRegistry::new` to obtain an `Arc` directly.

*Call graph*: 2 external calls (new, new).


##### `SessionEntry::new`  (lines 148–158)

```
fn new(session_id: String, process: ProcessHandler, connection_id: ConnectionId) -> Self
```

**Purpose**: Creates a session entry already attached to an initial connection. It initializes both the stable process state and the attachment bookkeeping.

**Data flow**: Consumes a session id string, a `ProcessHandler`, and a `ConnectionId`, then stores them in a new `SessionEntry` whose `AttachmentState` has `current_connection_id: Some(connection_id)` and both detached fields set to `None`.

**Call relations**: Used only by `SessionRegistry::attach` when creating a brand-new session. It establishes the invariant that new sessions start attached, not detached.

*Call graph*: called by 1 (attach); 1 external calls (new).


##### `SessionEntry::attach`  (lines 160–168)

```
fn attach(&self, connection_id: ConnectionId)
```

**Purpose**: Marks the session as actively attached to the given connection and clears any detached-expiry state. It is the state transition used during resume.

**Data flow**: Locks the entry's `attachment` mutex, sets `current_connection_id` to `Some(connection_id)`, and resets `detached_connection_id` and `detached_expires_at` to `None`.

**Call relations**: Called by `SessionRegistry::attach` when a detached session is successfully resumed. It complements `SessionEntry::detach` by reversing the detached state.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::detach`  (lines 170–183)

```
fn detach(&self, connection_id: ConnectionId) -> bool
```

**Purpose**: Transitions the session from attached to detached for a specific connection, recording the expiry deadline. It refuses to detach if the caller is not the currently attached connection.

**Data flow**: Locks the `attachment` mutex, compares `current_connection_id` against the provided `connection_id`, and returns `false` immediately if they differ. Otherwise it sets `current_connection_id` to `None`, records `detached_connection_id: Some(connection_id)`, sets `detached_expires_at` to `now + DETACHED_SESSION_TTL`, and returns `true`.

**Call relations**: Invoked by `SessionHandle::detach` before notifications are cleared and expiry is scheduled. Its boolean result lets the handle ignore stale detach attempts from already-evicted connections.

*Call graph*: 2 external calls (lock, now).


##### `SessionEntry::has_active_connection`  (lines 185–191)

```
fn has_active_connection(&self) -> bool
```

**Purpose**: Reports whether any connection is currently attached to the session. It is used to reject resume attempts against live sessions.

**Data flow**: Locks the `attachment` mutex, reads `current_connection_id`, and returns whether it is `Some(_)`.

**Call relations**: Consulted by `SessionRegistry::attach` during resume handling to decide whether to return an "already attached" invalid-request error.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::is_attached_to`  (lines 193–199)

```
fn is_attached_to(&self, connection_id: ConnectionId) -> bool
```

**Purpose**: Checks whether the session is currently attached to a specific connection id. It is the basis for detecting connection eviction.

**Data flow**: Locks the `attachment` mutex, compares `current_connection_id` to `Some(connection_id)`, and returns the boolean result.

**Call relations**: Used by `SessionHandle::is_session_attached`, which higher layers poll to decide whether an old connection should stop processing after another connection resumes the session.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::is_expired`  (lines 201–207)

```
fn is_expired(&self, now: tokio::time::Instant) -> bool
```

**Purpose**: Determines whether a detached session's grace period has already elapsed. It treats only sessions with a detached deadline as expirable.

**Data flow**: Locks the `attachment` mutex, reads `detached_expires_at`, and returns true only if it is present and `now >= deadline`.

**Call relations**: Called by `SessionRegistry::attach` when a client tries to resume a session id. If true, the registry removes and shuts down the stale session instead of reattaching it.

*Call graph*: 1 external calls (lock).


##### `SessionEntry::is_detached_connection_expired`  (lines 209–223)

```
fn is_detached_connection_expired(
        &self,
        connection_id: ConnectionId,
        now: tokio::time::Instant,
    ) -> bool
```

**Purpose**: Checks whether this entry is still detached from the specified connection and its expiry deadline has passed. It guards delayed cleanup against races with resume or later detach cycles.

**Data flow**: Locks the `attachment` mutex and returns true only when `current_connection_id` is `None`, `detached_connection_id == Some(connection_id)`, and `detached_expires_at` exists with `now >= deadline`.

**Call relations**: Used exclusively by `SessionRegistry::expire_if_detached` before removing a session. The connection-id match ensures only the expiry task corresponding to the current detached state can reap the entry.

*Call graph*: 1 external calls (lock).


##### `SessionHandle::session_id`  (lines 227–229)

```
fn session_id(&self) -> &str
```

**Purpose**: Returns the stable session id string for this handle. It exposes the identifier clients use for resume.

**Data flow**: Reads `self.entry.session_id` and returns it as `&str` without modifying state.

**Call relations**: Higher-level handler code uses this accessor when forming initialize responses.


##### `SessionHandle::connection_id`  (lines 231–233)

```
fn connection_id(&self) -> String
```

**Purpose**: Returns the handle's connection id as a string. This is primarily useful for diagnostics or externally visible metadata.

**Data flow**: Reads `self.connection_id`, formats it with `to_string`, and returns the owned `String`.

**Call relations**: This accessor depends on `ConnectionId`'s `Display` implementation and may be used by handler code that reports connection identity.

*Call graph*: 1 external calls (to_string).


##### `SessionHandle::is_session_attached`  (lines 235–237)

```
fn is_session_attached(&self) -> bool
```

**Purpose**: Reports whether this handle still represents the currently attached connection for its session. It lets callers detect that the session has been resumed elsewhere.

**Data flow**: Reads `self.entry` and `self.connection_id`, calls `entry.is_attached_to(self.connection_id)`, and returns the resulting boolean.

**Call relations**: Connection-processing code checks this before handling each inbound event so an evicted connection exits promptly after another connection resumes the session.


##### `SessionHandle::process`  (lines 239–241)

```
fn process(&self) -> &ProcessHandler
```

**Purpose**: Provides access to the session's shared `ProcessHandler`. It is how higher layers issue exec/read/write/signal/terminate operations against the session's process state.

**Data flow**: Returns a shared reference to `self.entry.process` without changing any state.

**Call relations**: Used by the server handler to forward process-related RPCs into the per-session process subsystem.


##### `SessionHandle::detach`  (lines 243–258)

```
async fn detach(&self)
```

**Purpose**: Detaches the current connection from the session, disables notifications, and schedules delayed expiry. It is the public teardown step for a connection that may later be resumed.

**Data flow**: Calls `self.entry.detach(self.connection_id)` and returns immediately if that fails. On success it clears the process notification sender by calling `set_notification_sender(None)`, clones the registry, copies the session id and connection id, and spawns an async task that awaits `registry.expire_if_detached(session_id, connection_id)`.

**Call relations**: Called by higher-level connection shutdown logic when a transport disconnects or a handler is torn down. It bridges immediate detach state changes with the delayed cleanup performed by `SessionRegistry::expire_if_detached`.

*Call graph*: 2 external calls (clone, spawn).


### Extensions and thread-scoped services
These files add thread-aware extension behavior such as goals, MCP plugin contributions, skills state, and session control tools layered on top of the core runtime.

### `ext/goal/src/extension.rs`

`orchestration` · `startup, thread lifecycle, turn lifecycle, token updates, tool completion`

This file is the main wiring layer between the host extension framework and the goal runtime. `GoalExtensionConfig` is a tiny per-thread config snapshot storing whether goals are enabled. `GoalExtension<C>` bundles shared dependencies: state DBs, analytics, event emitter, metrics, a weak `ThreadManager`, the shared `GoalService`, and a closure that derives the enabled flag from host config `C`.

`new_with_host_capabilities` assembles those dependencies, and the trait impls connect them to host callbacks. On thread start, the extension computes whether goals are enabled and whether tools should be visible for the thread, stores `GoalExtensionConfig`, initializes `GoalAccountingState`, parses the thread ID from `thread_store.level_id()`, creates or reuses a `GoalRuntimeHandle`, updates its enabled flag, and registers it with `GoalService`. Resume and idle callbacks delegate to runtime restoration and idle continuation. Thread stop unregisters the runtime.

Turn lifecycle hooks seed accounting at turn start, suppress goal tracking for plan mode, restore active-goal association from persisted state, and on stop/abort flush active-goal progress before removing turn accounting. Turn errors map protocol errors to `ActiveGoalStopReason`, blocking goals on generic terminal errors to avoid retry loops. Token-usage callbacks update in-memory token totals only. Tool-finish callbacks decide whether a tool attempt should count, account progress, and inject budget-limit steering once per goal. The `tools` method exposes get/create/update goal executors only when the runtime says tools are visible. `install_with_backend` registers the extension instance for all relevant contributor roles.

#### Function details

##### `GoalExtensionConfig::from_enabled`  (lines 54–56)

```
fn from_enabled(enabled: bool) -> Self
```

**Purpose**: Builds the per-thread goal config snapshot from a boolean enabled flag. It is a tiny constructor used when thread config is initialized or updated.

**Data flow**: Takes `enabled: bool`, returns `GoalExtensionConfig { enabled }`, and performs no side effects.

**Call relations**: Used by thread-start and config-change hooks before storing the config in `ExtensionData`.

*Call graph*: called by 2 (on_config_changed, on_thread_start).


##### `GoalExtension::fmt`  (lines 71–73)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a non-exhaustive debug representation for `GoalExtension`. It intentionally avoids printing internal dependency details.

**Data flow**: Uses the formatter’s `debug_struct("GoalExtension")` builder and finishes it as non-exhaustive. It reads no internal fields beyond naming the struct.

**Call relations**: Used implicitly by debug formatting. It keeps logs concise for this dependency-heavy orchestration type.

*Call graph*: 1 external calls (debug_struct).


##### `GoalExtension::new_with_host_capabilities`  (lines 77–95)

```
fn new_with_host_capabilities(
        state_dbs: Arc<codex_state::StateRuntime>,
        analytics_events_client: AnalyticsEventsClient,
        event_sink: Arc<dyn ExtensionEventSink>,
        metri
```

**Purpose**: Constructs the extension with all host-provided dependencies and wraps the config predicate in an `Arc`. It is the central assembly point for the goal extension.

**Data flow**: Accepts shared state DBs, analytics client, event sink, optional metrics client, weak thread manager, shared goal service, and a `goals_enabled` closure. It creates `GoalAnalytics`, `GoalEventEmitter`, and `GoalMetrics`, stores the remaining dependencies, wraps the closure in `Arc`, and returns `GoalExtension<C>`.

**Call relations**: Called by `install_with_backend` during extension registration. It wires together the subsystem adapters used by all later lifecycle callbacks.

*Call graph*: calls 3 internal fn (new, new, new); called by 1 (install_with_backend); 1 external calls (new).


##### `GoalExtension::on_thread_start`  (lines 102–137)

```
fn on_thread_start(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Initializes per-thread goal state when a thread starts. It computes enablement and tool visibility, stores config, creates accounting/runtime state if needed, and registers the runtime with the service.

**Data flow**: Inside an async block, it evaluates `(self.goals_enabled)(input.config)`, computes `tools_available_for_thread` from `persistent_thread_state_available` and session source, inserts `GoalExtensionConfig` into `input.thread_store`, gets or initializes `GoalAccountingState`, parses `ThreadId` from `thread_store.level_id()`, gets or initializes a `GoalRuntimeHandle` with cloned shared dependencies and `GoalRuntimeConfig`, sets the runtime’s enabled flag, and registers it with `goal_service`. If thread ID parsing fails, it returns early.

**Call relations**: Invoked by the host’s thread-start lifecycle. It is the main bootstrap path that ensures later callbacks can retrieve a runtime from thread-local `ExtensionData`.

*Call graph*: calls 2 internal fn (from_enabled, from_string); 2 external calls (pin, matches!).


##### `GoalExtension::on_thread_resume`  (lines 139–152)

```
fn on_thread_resume(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Restores runtime goal bookkeeping after a thread resumes. It is a best-effort hook that logs failures instead of surfacing them.

**Data flow**: Looks up the runtime from `input.thread_store` via `goal_runtime_handle`; if absent, returns. Otherwise awaits `runtime.restore_after_resume()` and logs a warning including `runtime.thread_id()` if restoration fails.

**Call relations**: Called by the host on thread resume. It delegates all substantive work to the runtime, which reloads persisted goal state and reestablishes idle active-goal tracking.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, warn!).


##### `GoalExtension::on_thread_idle`  (lines 154–167)

```
fn on_thread_idle(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Triggers automatic continuation of an active goal when a thread becomes idle. It is also best-effort and warning-only on failure.

**Data flow**: Retrieves the runtime from thread-local store, returns if missing, then awaits `runtime.continue_if_idle()`. On error it logs a warning with the thread ID.

**Call relations**: Invoked by the host’s idle callback. It delegates continuation policy and thread-manager interaction to the runtime.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, warn!).


##### `GoalExtension::on_thread_stop`  (lines 169–175)

```
fn on_thread_stop(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Unregisters the thread’s runtime from the shared goal service when the thread stops. It performs no persistence or accounting itself.

**Data flow**: Looks up the runtime in `input.thread_store`; if present, passes it to `self.goal_service.unregister_runtime(&runtime)`. Otherwise it returns immediately.

**Call relations**: Called by the host on thread shutdown. It complements `on_thread_start` by removing the runtime from the service’s weak-reference registry.

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

**Purpose**: Updates per-thread goal enablement when host configuration changes and propagates the new enabled flag into any live runtime. It keeps stored config and runtime behavior aligned.

**Data flow**: Computes `enabled` from `new_config`, inserts a fresh `GoalExtensionConfig` into `thread_store`, then looks up any runtime via `goal_runtime_handle` and calls `runtime.set_enabled(enabled)` if found.

**Call relations**: Invoked by the host config contributor mechanism. It updates both passive thread-local config state and active runtime state in one place.

*Call graph*: calls 3 internal fn (insert, from_enabled, goal_runtime_handle).


##### `GoalExtension::on_turn_start`  (lines 201–241)

```
fn on_turn_start(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Begins per-turn accounting and reattaches any persisted active goal to the new turn, except in plan mode where token accounting is disabled and active-goal tracking is cleared. It bridges turn lifecycle with persisted goal state.

**Data flow**: Retrieves the runtime, returns if missing or disabled, gets its accounting state, and calls `start_turn(input.turn_id, input.collaboration_mode.mode, input.token_usage_at_turn_start)`. If the mode is `Plan`, it clears the current turn goal and returns. Otherwise it reads the persisted thread goal from `self.state_dbs.thread_goals().get_thread_goal(runtime.thread_id()).await`; if a goal exists with status `Active` or `BudgetLimited`, it marks that turn goal active using the goal ID.

**Call relations**: Called at turn start by the host. It seeds accounting baselines immediately, then conditionally restores active-goal association from persistent state for later progress accounting.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (pin, matches!).


##### `GoalExtension::on_turn_stop`  (lines 243–269)

```
fn on_turn_stop(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Flushes any remaining active-goal progress at normal turn end and then removes the turn’s accounting state. It clears active-goal tracking if accounting drives the goal to a terminal or budget-limited-cleared state.

**Data flow**: Looks up the runtime, returns if missing or disabled, reads `turn_id` from `input.turn_store.level_id()`, awaits `runtime.account_active_goal_progress(turn_id, "{turn_id}:turn-stop", ActiveOnly, ClearActive)`, logs and returns on error, and finally calls `runtime.accounting_state().finish_turn(turn_id)`.

**Call relations**: Invoked by the host when a turn stops normally. It delegates persistence and event emission to the runtime, then performs local turn-state cleanup.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 3 external calls (pin, format!, warn!).


##### `GoalExtension::on_turn_abort`  (lines 271–297)

```
fn on_turn_abort(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Flushes active-goal progress when a turn aborts and then removes the turn’s accounting state. It mirrors normal turn-stop handling but uses a distinct event ID suffix.

**Data flow**: Retrieves the runtime, returns if missing or disabled, gets `turn_id` from the turn store, awaits `runtime.account_active_goal_progress(turn_id, "{turn_id}:turn-abort", ActiveOnly, ClearActive)`, warns and returns on error, then calls `finish_turn(turn_id)` on the accounting state.

**Call relations**: Called by the host on aborted turns. It shares the same runtime accounting path as turn stop, differing only in event labeling and the lifecycle condition that triggered it.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 3 external calls (pin, format!, warn!).


##### `GoalExtension::on_turn_error`  (lines 299–323)

```
fn on_turn_error(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Stops the active goal after a terminal turn error, mapping usage-limit errors to `UsageLimited` and all other terminal errors to `Blocked`. This prevents automatic continuation loops after unrecoverable failures.

**Data flow**: Looks up the runtime and returns if absent. It maps `input.error` to `ActiveGoalStopReason::UsageLimit` for `CodexErrorInfo::UsageLimitExceeded`, otherwise `TurnError`, then awaits `runtime.stop_active_goal_for_turn(input.turn_id, reason)`. On failure it logs a warning including the error payload.

**Call relations**: Invoked by the host’s turn-error hook. It delegates the actual accounting, status update, and event emission to runtime stop logic.

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

**Purpose**: Feeds cumulative token-usage updates into the in-memory accounting state for the current turn. It does not persist usage by itself.

**Data flow**: Retrieves the runtime from `thread_store`, returns if missing or disabled, then calls `runtime.accounting_state().record_token_usage(turn_store.level_id(), &token_usage.total_token_usage)`. If that returns `None`, it exits; otherwise it ignores the returned delta record.

**Call relations**: Called whenever token usage updates arrive from the host. It prepares state for later accounting triggers such as tool finish or turn end rather than writing goal usage immediately.

*Call graph*: calls 2 internal fn (level_id, goal_runtime_handle); 1 external calls (pin).


##### `GoalExtension::on_tool_finish`  (lines 359–403)

```
fn on_tool_finish(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a>
```

**Purpose**: Accounts active-goal progress after qualifying tool attempts and injects budget-limit steering once when accounting pushes a goal into `BudgetLimited`. It filters out non-counting outcomes and the goal-update tool itself.

**Data flow**: Looks up the runtime, computes `should_count_for_goal_progress` from runtime enablement, `tool_attempt_counts_for_goal_progress(input.outcome)`, and a check excluding the unnamespaced `UPDATE_GOAL_TOOL_NAME`. If false, returns. Otherwise it awaits `runtime.account_active_goal_progress(turn_id, input.call_id, ActiveOnly, KeepActive)`, returning on `Ok(None)` or warning on error. If progress was accounted and the resulting protocol goal status is `BudgetLimited`, it asks accounting state `mark_budget_limit_reported_if_new(progress.goal_id.as_str())`; only if true does it build a steering item with `budget_limit_steering_item(&goal)` and inject it into the active turn.

**Call relations**: Invoked after each tool call completes. It is the main incremental accounting trigger during a turn and coordinates with accounting state to avoid duplicate budget-limit steering injections.

*Call graph*: calls 3 internal fn (goal_runtime_handle, tool_attempt_counts_for_goal_progress, budget_limit_steering_item); 2 external calls (pin, warn!).


##### `GoalExtension::tools`  (lines 410–448)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>>
```

**Purpose**: Exposes the goal tool executors for a thread when the runtime says tools should be visible. It returns get/create/update executors bound to the thread’s runtime context.

**Data flow**: Looks up the runtime from `thread_store`; if absent or `!runtime.tools_visible()`, returns an empty `Vec`. Otherwise it constructs three `Arc<dyn ToolExecutor<_>>` values using `GoalToolExecutor::get`, `::create`, and `::update`, each receiving the thread ID, cloned state DBs, accounting state, analytics, event emitter, and metrics, and returns them in a vector.

**Call relations**: Called by the host when collecting tools for a thread. It depends on runtime visibility policy and delegates actual tool behavior to `GoalToolExecutor` constructors.

*Call graph*: calls 1 internal fn (goal_runtime_handle); 2 external calls (new, vec!).


##### `install_with_backend`  (lines 451–477)

```
fn install_with_backend(
    registry: &mut ExtensionRegistryBuilder<C>,
    state_dbs: Arc<codex_state::StateRuntime>,
    analytics_events_client: AnalyticsEventsClient,
    metrics_client: Option<M
```

**Purpose**: Registers the goal extension instance with all relevant contributor slots in the extension registry. It is the subsystem’s installation entry point.

**Data flow**: Builds an `Arc<GoalExtension<_>>` via `GoalExtension::new_with_host_capabilities`, passing the registry’s event sink and cloned goal service, then registers that same extension as thread lifecycle, config, turn lifecycle, token usage, tool lifecycle, and tool contributors on the `ExtensionRegistryBuilder`.

**Call relations**: Called during application setup to install the goal subsystem into the host extension framework. It wires one shared extension instance into every callback surface it implements.

*Call graph*: calls 8 internal fn (config_contributor, event_sink, thread_lifecycle_contributor, token_usage_contributor, tool_contributor, tool_lifecycle_contributor, turn_lifecycle_contributor, new_with_host_capabilities); 2 external calls (clone, new).


##### `goal_runtime_handle`  (lines 479–481)

```
fn goal_runtime_handle(thread_store: &ExtensionData) -> Option<Arc<GoalRuntimeHandle>>
```

**Purpose**: Fetches the thread-local `GoalRuntimeHandle` from `ExtensionData`. It is the common lookup helper used by most lifecycle callbacks.

**Data flow**: Calls `thread_store.get::<GoalRuntimeHandle>()` and returns the resulting `Option<Arc<GoalRuntimeHandle>>`. It does not mutate the store.

**Call relations**: Used throughout this file to avoid repeating typed-store lookup logic. Callers branch on `None` to gracefully skip goal behavior for threads without initialized runtime state.

*Call graph*: called by 11 (on_config_changed, on_thread_idle, on_thread_resume, on_thread_stop, on_token_usage, on_tool_finish, on_turn_abort, on_turn_error, on_turn_start, on_turn_stop (+1 more)).


##### `tool_attempt_counts_for_goal_progress`  (lines 483–495)

```
fn tool_attempt_counts_for_goal_progress(outcome: ToolCallOutcome) -> bool
```

**Purpose**: Defines which tool outcomes should count as goal progress opportunities. Completed calls and failures whose handler executed count; blocked, aborted, and pre-handler failures do not.

**Data flow**: Matches on `ToolCallOutcome` and returns `true` for `Completed { .. }` and `Failed { handler_executed: true }`, otherwise `false` for `Blocked`, `Aborted`, and `Failed { handler_executed: false }`.

**Call relations**: Used only by `on_tool_finish` to decide whether a tool completion should trigger active-goal accounting.

*Call graph*: called by 1 (on_tool_finish).


### `ext/goal/src/runtime.rs`

`domain_logic` · `live thread runtime, external goal mutation coordination, idle continuation, progress accounting`

This file contains the runtime engine for one thread’s goals. `GoalRuntimeHandle` is a cheap cloneable wrapper around `Arc<GoalRuntimeInner>`, which stores the thread ID, state DBs, analytics/event/metrics adapters, weak `ThreadManager`, shared `GoalAccountingState`, an atomic enabled flag, a tools-visible flag, and a single-permit `goal_state_lock`. That lock serializes windows where external set/clear operations, idle continuation, and terminal stop logic must not interleave.

The runtime supports three broad responsibilities. First, it reacts to external mutations: `prepare_external_goal_mutation` flushes active-turn or idle progress and clears active-goal state before a service-layer write; `apply_external_goal_set` and `apply_external_goal_clear` then update metrics, analytics, accounting baselines, steering, and idle continuation based on the new persisted goal. Second, it manages automatic execution behavior: `restore_after_resume` reestablishes idle active-goal tracking from persisted state, `continue_if_idle` launches a new turn with continuation steering when the thread is idle and the persisted goal is active, and `inject_active_turn_steering` pushes steering into a running turn. Third, it persists usage accounting: `account_active_goal_progress` and `account_idle_goal_progress` take serialized snapshots from `GoalAccountingState`, call `account_thread_goal_usage` in the state DB with expected goal IDs, emit metrics/analytics/events on updates, and then advance or reset local baselines. Terminal stop logic in `stop_active_goal_for_turn` combines final accounting with a guarded status transition to `Blocked` or `UsageLimited`, only if the persisted goal is still in a stoppable state.

#### Function details

##### `PreviousGoalSnapshot::from`  (lines 65–71)

```
fn from(goal: &codex_state::ThreadGoal) -> Self
```

**Purpose**: Captures the subset of a persisted goal needed to compare pre- and post-update runtime effects. It preserves goal identity, status, and objective text.

**Data flow**: Reads `goal.goal_id`, `goal.status`, and `goal.objective` from a `&codex_state::ThreadGoal`, clones the strings, and returns `PreviousGoalSnapshot`.

**Call relations**: Used by the service layer before updating a goal so `apply_external_goal_set` can determine whether the goal was replaced, resumed, or had its objective changed.

*Call graph*: called by 1 (set_thread_goal).


##### `GoalRuntimeHandle::fmt`  (lines 75–77)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a non-exhaustive debug representation for the runtime handle. It avoids dumping internal state and dependencies.

**Data flow**: Uses the formatter’s debug-struct builder for `GoalRuntimeHandle` and finishes non-exhaustively. It does not mutate state.

**Call relations**: Used implicitly in debug formatting contexts for this runtime wrapper.

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

**Purpose**: Constructs a new per-thread runtime with all dependencies, initial enablement, and synchronization primitives. It is the runtime bootstrap constructor.

**Data flow**: Accepts thread ID, shared state DBs, event emitter, metrics, weak thread manager, accounting state, and `GoalRuntimeConfig`. It allocates `GoalRuntimeInner` inside an `Arc`, storing analytics from config, initializing `enabled` from `AtomicBool::new(config.enabled)`, copying `tools_available_for_thread`, and creating `goal_state_lock` as `Semaphore::new(1)`, then wraps it in `GoalRuntimeHandle`.

**Call relations**: Called from the extension’s thread-start hook when a runtime is first inserted into thread-local extension data.

*Call graph*: 3 external calls (new, new, new).


##### `GoalRuntimeHandle::set_enabled`  (lines 106–108)

```
fn set_enabled(&self, enabled: bool)
```

**Purpose**: Updates the runtime’s enabled flag. This toggles whether most runtime behaviors should execute.

**Data flow**: Stores the provided boolean into `self.inner.enabled` using `Ordering::Relaxed`. It returns nothing.

**Call relations**: Called by thread-start and config-change hooks to reflect current configuration. Other runtime methods consult `is_enabled` before doing work.


##### `GoalRuntimeHandle::is_enabled`  (lines 110–112)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Returns whether the runtime is currently enabled. It is the common gate for runtime behavior.

**Data flow**: Loads `self.inner.enabled` with `Ordering::Relaxed` and returns the boolean. No mutation occurs.

**Call relations**: Checked by external-mutation, restore, stop, and visibility paths to short-circuit goal behavior when disabled.

*Call graph*: called by 6 (apply_external_goal_clear, apply_external_goal_set, prepare_external_goal_mutation, restore_after_resume, stop_active_goal_for_turn, tools_visible).


##### `GoalRuntimeHandle::tools_visible`  (lines 114–116)

```
fn tools_visible(&self) -> bool
```

**Purpose**: Determines whether goal tools should be exposed for this thread. Tools are visible only when goals are enabled and the thread type allows tools.

**Data flow**: Calls `self.is_enabled()` and combines it with `self.inner.tools_available_for_thread`, returning the conjunction.

**Call relations**: Used by the extension’s `tools` method and by idle continuation to decide whether automatic goal work should proceed.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (continue_if_idle).


##### `GoalRuntimeHandle::thread_id`  (lines 118–120)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the thread ID this runtime manages. It is a simple accessor used throughout runtime and service coordination.

**Data flow**: Reads and returns `self.inner.thread_id`. No mutation occurs.

**Call relations**: Used by accounting, continuation, restore, and stop paths whenever they need to address persistent state or live thread-manager APIs.

*Call graph*: called by 6 (account_active_goal_progress, account_idle_goal_progress, continue_if_idle, current_goal_status_for_metrics, restore_after_resume, stop_active_goal_for_turn).


##### `GoalRuntimeHandle::accounting_state`  (lines 122–124)

```
fn accounting_state(&self) -> Arc<GoalAccountingState>
```

**Purpose**: Returns a cloned `Arc` to the shared accounting state for this runtime. It gives callers access to in-memory progress bookkeeping.

**Data flow**: Clones `self.inner.accounting_state` and returns the `Arc<GoalAccountingState>`.

**Call relations**: Used by active and idle accounting methods and by extension hooks that need direct accounting operations.

*Call graph*: called by 2 (account_active_goal_progress, account_idle_goal_progress); 1 external calls (clone).


##### `GoalRuntimeHandle::goal_state_permit`  (lines 126–132)

```
async fn goal_state_permit(&self) -> Result<SemaphorePermit<'_>, String>
```

**Purpose**: Acquires the runtime-level permit that serializes external goal mutations, idle continuation launch, and terminal stop sequences. It converts semaphore acquisition failures into strings for higher-level APIs.

**Data flow**: Awaits `self.inner.goal_state_lock.acquire()`, maps any acquire error to `err.to_string()`, and returns `SemaphorePermit<'_>` on success.

**Call relations**: Held by `continue_if_idle`, `stop_active_goal_for_turn`, and service-layer mutation windows to prevent races between reading goal state and acting on it.

*Call graph*: called by 2 (continue_if_idle, stop_active_goal_for_turn).


##### `GoalRuntimeHandle::prepare_external_goal_mutation`  (lines 134–157)

```
async fn prepare_external_goal_mutation(&self) -> Result<(), String>
```

**Purpose**: Flushes any pending active-turn or idle goal progress before an external set/clear mutates persistent goal state. It also clears active-goal tracking according to the accounting disposition used by those accounting calls.

**Data flow**: Returns early if disabled. Otherwise it checks `accounting_state.current_turn_id()`: if a turn exists, it awaits `account_active_goal_progress(turn_id, "{turn_id}:external-goal-mutation", ActiveOnly, ClearActive)`; if not, it awaits `account_idle_goal_progress("{thread_id}:external-goal-mutation", ActiveOnly, ClearActive)`. It propagates any accounting error as `Err(String)`.

**Call relations**: Called by `GoalService::set_thread_goal` and `clear_thread_goal` while holding the runtime’s goal-state permit. It ensures external mutations do not race with stale unflushed progress.

*Call graph*: calls 3 internal fn (account_active_goal_progress, account_idle_goal_progress, is_enabled); 1 external calls (format!).


##### `GoalRuntimeHandle::apply_external_goal_set`  (lines 159–223)

```
async fn apply_external_goal_set(
        &self,
        goal: codex_state::ThreadGoal,
        previous_goal: Option<PreviousGoalSnapshot>,
    ) -> Result<(), String>
```

**Purpose**: Applies live runtime side effects after a goal has been externally created or updated in persistent state. It updates metrics and analytics, adjusts accounting active-goal state, injects steering for objective changes, and may trigger idle continuation.

**Data flow**: Returns early if disabled. It compares `previous_goal` to the new `goal` to detect replacement versus in-place update, records creation metrics/analytics when appropriate, derives `previous_status` only for non-replacement updates, records resumed and terminal metrics, emits status-change analytics, and detects objective changes for same-goal updates. It then matches on `goal.status`: for `Active`, it marks the current turn or idle wall clock active for `goal.goal_id`, injects objective-updated steering if the objective changed, and calls `continue_if_idle`; for `BudgetLimited`, it clears active-goal state only when no current turn exists; for `Paused`, `Blocked`, `UsageLimited`, and `Complete`, it clears active-goal state outright.

**Call relations**: Called by `GoalSetOutcome::apply_runtime_effects` after the service-layer write succeeds. It coordinates analytics, metrics, accounting, steering, and continuation in response to the new persisted goal state.

*Call graph*: calls 5 internal fn (continue_if_idle, inject_active_turn_steering, is_enabled, objective_updated_steering_item, protocol_goal_from_state).


##### `GoalRuntimeHandle::apply_external_goal_clear`  (lines 225–236)

```
async fn apply_external_goal_clear(
        &self,
        goal: codex_state::ThreadGoal,
    ) -> Result<(), String>
```

**Purpose**: Applies runtime cleanup after a goal has been externally deleted from persistent state. It emits clear analytics and clears local active-goal bookkeeping.

**Data flow**: Returns early if disabled. Otherwise it calls `self.inner.analytics.cleared(&goal)` and `self.inner.accounting_state.clear_active_goal()`, then returns `Ok(())`.

**Call relations**: Called by `GoalService::clear_thread_goal` after the database delete succeeds. It is intentionally lightweight because the durable state has already been removed.

*Call graph*: calls 1 internal fn (is_enabled).


##### `GoalRuntimeHandle::usage_limit_active_goal_for_turn`  (lines 238–241)

```
async fn usage_limit_active_goal_for_turn(&self, turn_id: &str) -> Result<(), String>
```

**Purpose**: Convenience wrapper that stops the active goal for a turn with the usage-limit reason. It maps directly onto the more general stop path.

**Data flow**: Accepts a turn ID and awaits `self.stop_active_goal_for_turn(turn_id, ActiveGoalStopReason::UsageLimit)`, returning the same `Result<(), String>`.

**Call relations**: Used by callers that specifically need usage-limit semantics without constructing the enum themselves.

*Call graph*: calls 1 internal fn (stop_active_goal_for_turn).


##### `GoalRuntimeHandle::stop_active_goal_for_turn`  (lines 244–333)

```
async fn stop_active_goal_for_turn(
        &self,
        turn_id: &str,
        reason: ActiveGoalStopReason,
    ) -> Result<(), String>
```

**Purpose**: Accounts final progress for the current active goal on a turn and, if the persisted goal is still stoppable, transitions it to `Blocked` or `UsageLimited`. It prevents interleaving with external mutations and idle continuation by holding the goal-state permit.

**Data flow**: Returns early if disabled. Otherwise it acquires `_goal_state_permit`, checks `accounting_state.turn_is_current_active_goal(turn_id)`, and returns if false. It maps the `ActiveGoalStopReason` to an event-name/status pair, accounts active progress with event ID `"{turn_id}:{event_name}-progress"` and `ClearActive`, then reads the current persisted goal from `state_dbs.thread_goals().get_thread_goal(self.thread_id())`. If no goal exists, it clears active-goal state and returns. It only proceeds when the goal is `Active`, or when it is `BudgetLimited` and the requested stop status is `UsageLimited`; otherwise it clears active-goal state and returns. It then updates the goal status in storage using `GoalUpdate` with `expected_goal_id`, records terminal metrics, emits status-change analytics attributed to the turn, clears active-goal state, converts the updated goal to protocol form, and emits a `thread_goal_updated` event with event ID `"{turn_id}:{event_name}"`.

**Call relations**: Called from turn-error handling and the usage-limit wrapper. It combines accounting, guarded state transition, metrics/analytics, and event emission into one serialized terminal-stop sequence.

*Call graph*: calls 5 internal fn (account_active_goal_progress, goal_state_permit, is_enabled, thread_id, protocol_goal_from_state); called by 1 (usage_limit_active_goal_for_turn); 2 external calls (Turn, format!).


##### `GoalRuntimeHandle::restore_after_resume`  (lines 335–357)

```
async fn restore_after_resume(&self) -> Result<(), String>
```

**Purpose**: Reloads persisted goal state after a thread resumes and reestablishes local active-goal bookkeeping. It also records a resumed metric when an active goal is restored.

**Data flow**: Returns early if disabled. Otherwise it fetches the persisted thread goal from the state DB. If a goal exists and its status is `Active`, it marks idle goal active for that goal ID and records `metrics.record_resumed()`. For any other result, including no goal, it clears active-goal state. It returns `Ok(())` or a stringified DB error.

**Call relations**: Invoked by the extension’s thread-resume hook. It restores runtime-local accounting state from durable state without launching continuation itself.

*Call graph*: calls 2 internal fn (is_enabled, thread_id).


##### `GoalRuntimeHandle::continue_if_idle`  (lines 359–415)

```
async fn continue_if_idle(&self) -> Result<(), String>
```

**Purpose**: Attempts to automatically start a new turn with continuation steering when the thread is idle and the persisted goal is active. It also clears stale active-goal bookkeeping when continuation cannot or should not proceed.

**Data flow**: If `!tools_visible()`, it clears active-goal state and returns. Otherwise it acquires `_goal_state_permit`, upgrades the weak `ThreadManager`, fetches the live thread, reads the persisted goal from the state DB, and returns early with debug logs if the manager or thread is unavailable. If no goal exists or the goal status is not `Active`, it clears active-goal state and returns. Otherwise it builds a continuation steering item from the protocol-converted goal and calls `thread.try_start_turn_if_idle(vec![item]).await`, logging debug output if automatic work is rejected. Finally it checks whether there is now a current turn whose goal is active; if not, it clears active-goal state.

**Call relations**: Called after external goal activation and from the extension’s idle hook. It coordinates live-thread availability, persisted goal state, and local accounting state under the goal-state permit.

*Call graph*: calls 5 internal fn (goal_state_permit, thread_id, tools_visible, continuation_steering_item, protocol_goal_from_state); called by 1 (apply_external_goal_set); 2 external calls (debug!, vec!).


##### `GoalRuntimeHandle::inject_active_turn_steering`  (lines 417–429)

```
async fn inject_active_turn_steering(&self, item: ResponseItem)
```

**Purpose**: Injects a steering item into the currently running turn if a live thread is available and actively running. It is used for objective updates and budget-limit guidance.

**Data flow**: Upgrades the weak `ThreadManager`, fetches the live thread for `self.inner.thread_id`, and if both succeed calls `thread.inject_if_running(vec![item]).await`. It logs debug messages and returns early if the manager is unavailable, the thread is unavailable, or no turn is active.

**Call relations**: Called by `apply_external_goal_set` for objective-change steering and by extension tool-finish logic for budget-limit steering. It is a best-effort live-thread side effect.

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

**Purpose**: Persists unaccounted active-turn goal progress for a specific turn and emits all resulting side effects. It is the main bridge from in-memory turn snapshots to durable goal usage updates.

**Data flow**: Clones the accounting state, acquires its progress-accounting permit, asks for `progress_snapshot(turn_id)`, and returns `Ok(None)` if no snapshot exists. Otherwise it fetches `previous_status` via `current_goal_status_for_metrics(Some(snapshot.expected_goal_id.as_str()))`, calls `state_dbs.thread_goals().account_thread_goal_usage(self.thread_id(), snapshot.time_delta_seconds, snapshot.token_delta, mode, Some(expected_goal_id))`, and matches the outcome. On `Updated(goal)`, it clones `goal.goal_id`, records terminal metrics, emits usage-accounted and status-changed analytics attributed to the turn, calls `accounting.mark_progress_accounted_for_status(...)`, converts the goal to protocol form, emits `thread_goal_updated(event_id, Some(turn_id.to_string()), goal.clone())`, and returns `Some(AccountedGoalProgress { goal, goal_id })`. On `Unchanged(_)`, it returns `None` without advancing baselines.

**Call relations**: Called by external-mutation preparation, turn-stop/abort hooks, tool-finish accounting, and terminal stop logic. It relies on the accounting semaphore to serialize snapshot/persist/mark-accounted and on the state DB to enforce expected-goal matching.

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

**Purpose**: Persists unaccounted idle wall-clock progress for the active goal and emits resulting side effects. It is the idle counterpart to active-turn accounting and never charges tokens.

**Data flow**: Clones accounting state, acquires the progress-accounting permit, asks for `idle_progress_snapshot()`, and returns `Ok(None)` if absent. Otherwise it fetches `previous_status` with the expected goal ID, calls `account_thread_goal_usage(self.thread_id(), snapshot.time_delta_seconds, 0, mode, Some(expected_goal_id))`, and matches the outcome. On `Updated(goal)`, it records terminal metrics, emits usage-accounted and status-changed analytics with `GoalEventAttribution::NoTurn`, marks idle progress accounted for the resulting status, emits a `thread_goal_updated` event with no turn ID, and returns `Some(AccountedGoalProgress { goal, goal_id })`. On `Unchanged(_)`, it resets the idle baseline and clears the active goal before returning `None`.

**Call relations**: Used by `prepare_external_goal_mutation` when no turn is active. It mirrors active-turn accounting but uses idle snapshots and no-turn attribution.

*Call graph*: calls 4 internal fn (accounting_state, current_goal_status_for_metrics, thread_id, protocol_goal_from_state); called by 1 (prepare_external_goal_mutation).


##### `GoalRuntimeHandle::current_goal_status_for_metrics`  (lines 558–574)

```
async fn current_goal_status_for_metrics(
        &self,
        expected_goal_id: Option<&str>,
    ) -> Result<Option<codex_state::ThreadGoalStatus>, String>
```

**Purpose**: Reads the current persisted goal status for metric comparison, optionally only if the goal ID matches an expected value. This avoids attributing status transitions to stale or replaced goals.

**Data flow**: Fetches the current thread goal from the state DB using `self.thread_id()`, converts DB errors to strings, and returns `goal.status` only if either `expected_goal_id` is `None` or the fetched goal’s ID equals that expected ID. Otherwise it returns `None`.

**Call relations**: Called by both active and idle accounting before persisting usage so metrics and analytics can compare the post-update goal against the correct prior status.

*Call graph*: calls 1 internal fn (thread_id); called by 2 (account_active_goal_progress, account_idle_goal_progress).


### `ext/goal/src/api.rs`

`orchestration` · `external goal API calls and runtime registration`

This file exposes the public-facing goal service layer. `GoalServiceError` distinguishes invalid client requests from internal failures and formats both as their contained message. `GoalSetRequest` models partial updates: objective and token budget can be kept or set independently, while status is optional. `GoalSetOutcome` returns both the protocol-facing `ThreadGoal` and the internal state snapshot needed to apply runtime effects after the database write.

`GoalService` itself maintains a mutex-protected `HashMap<String, Weak<GoalRuntimeHandle>>` keyed by thread ID so API calls can coordinate with any live runtime for that thread. `set_thread_goal` is the central path: it normalizes request fields, trims objectives, validates objective text and budget constraints, acquires the runtime’s goal-state permit if present, asks the runtime to flush/clear any in-flight active or idle accounting before mutation, then either updates an existing goal or creates/replaces one depending on whether an objective was supplied and whether a goal already exists. Updates use `expected_goal_id` for optimistic matching. If an objective was set, it opportunistically fills an empty thread preview.

`clear_thread_goal` follows the same prepare/write pattern, then drops the permit before reacquiring the runtime and applying post-clear runtime effects. Registration helpers keep the runtime map fresh and remove dead weak references on lookup. The design deliberately separates durable state mutation from best-effort runtime side effects, logging warnings instead of failing the API when runtime coordination cannot complete.

#### Function details

##### `GoalServiceError::fmt`  (lines 27–31)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats both `InvalidRequest` and `Internal` errors as their contained message string. It intentionally hides the enum variant in user-facing display output.

**Data flow**: Matches on `self`, extracts the inner `String` from either variant, and writes it to the provided formatter with `write_str`. It returns the formatter result and does not mutate state.

**Call relations**: Used implicitly wherever `GoalServiceError` is displayed or converted through standard error formatting. It supports the `std::error::Error` implementation declared in this file.

*Call graph*: 1 external calls (write_str).


##### `GoalSetOutcome::apply_runtime_effects`  (lines 64–72)

```
async fn apply_runtime_effects(&self, goal_service: &GoalService)
```

**Purpose**: Applies post-write runtime side effects for a successful goal set, if a live runtime exists for the affected thread. Failures are logged but do not propagate.

**Data flow**: Reads `self.goal.thread_id`, asks the provided `GoalService` for `runtime_for_thread`, clones `self.state_goal` and `self.previous_goal`, and awaits `runtime.apply_external_goal_set(...)`. On error it emits a warning; otherwise it returns `()`. It does not alter persistent state itself.

**Call relations**: Called by higher-level API consumers after `set_thread_goal` succeeds. It bridges the durable database mutation performed earlier with live runtime bookkeeping and continuation behavior.

*Call graph*: calls 1 internal fn (runtime_for_thread); 2 external calls (clone, warn!).


##### `GoalService::new`  (lines 81–83)

```
fn new() -> Self
```

**Purpose**: Constructs an empty goal service with no registered runtimes. It is a convenience wrapper over `Default`.

**Data flow**: Calls `Self::default()` and returns the resulting `GoalService`, whose runtime map starts empty inside a mutex.

**Call relations**: Used during subsystem setup and tests. Runtime registration later populates the internal weak-reference map.

*Call graph*: called by 4 (new, new, goal_service_sets_gets_and_clears_thread_goal, installed_tools_with_start); 1 external calls (default).


##### `GoalService::get_thread_goal`  (lines 85–96)

```
async fn get_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        thread_id: ThreadId,
    ) -> Result<Option<ThreadGoal>, GoalServiceError>
```

**Purpose**: Fetches the current goal for a thread from persistent state and converts it to the protocol representation. Database errors are wrapped as internal service errors.

**Data flow**: Takes a `StateRuntime` and `ThreadId`, calls `state_db.thread_goals().get_thread_goal(thread_id).await`, maps any returned state goal through `protocol_goal_from_state`, and converts storage errors into `GoalServiceError::Internal` with context text.

**Call relations**: This is the read-only API path. It delegates all storage access to the state runtime and all representation conversion to the tool-layer helper.

*Call graph*: calls 1 internal fn (thread_goals).


##### `GoalService::set_thread_goal`  (lines 98–237)

```
async fn set_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        request: GoalSetRequest<'_>,
    ) -> Result<GoalSetOutcome, GoalServiceError>
```

**Purpose**: Validates and applies a create-or-update request for a thread goal, coordinating with any live runtime to avoid races with idle continuation or in-flight accounting. It returns both the protocol goal and enough internal context for later runtime effects.

**Data flow**: Destructures `GoalSetRequest`, converts optional protocol status to state status, normalizes objective and token-budget updates into `Option`s, trims objective text, validates objective syntax and budget constraints, and looks up any runtime for the thread. If a runtime exists, it acquires `goal_state_permit` and asks the runtime to `prepare_external_goal_mutation`, logging warnings on preparation failure. It then reads existing goal state as needed and either updates an existing goal with `GoalUpdate { objective, status, token_budget, expected_goal_id }`, creates/replaces a goal when an objective is supplied but none exists, or errors if a non-objective update targets a missing goal. It may build `PreviousGoalSnapshot` from the prior goal. If an objective was set, it calls `fill_empty_thread_preview_if_possible`. Finally it returns `GoalSetOutcome` containing the protocol-converted goal, cloned internal goal, and optional previous snapshot.

**Call relations**: This is the main mutation API used by external callers. It depends on runtime coordination helpers to flush active/idle accounting before the write, on state DB methods for persistence, and on `GoalSetOutcome::apply_runtime_effects` to perform best-effort live runtime updates afterward.

*Call graph*: calls 7 internal fn (runtime_for_thread, from, fill_empty_thread_preview_if_possible, protocol_goal_from_state, validate_goal_budget, validate_thread_goal_objective, thread_goals); 1 external calls (warn!).


##### `GoalService::clear_thread_goal`  (lines 239–280)

```
async fn clear_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        thread_id: ThreadId,
    ) -> Result<bool, GoalServiceError>
```

**Purpose**: Deletes the current thread goal from persistent state and then applies runtime cleanup if a live runtime still exists. It uses the same mutation window protection as goal setting.

**Data flow**: Looks up any runtime for the thread, optionally acquires its `goal_state_permit`, and asks it to `prepare_external_goal_mutation`, logging warnings on failure. It then calls `state_db.thread_goals().delete_thread_goal(thread_id).await`, maps storage errors to `GoalServiceError::Internal`, records whether a goal was actually removed, drops the permit and initial runtime handle, reacquires any current runtime, and if both runtime and deleted goal exist awaits `runtime.apply_external_goal_clear(goal)`, warning on failure. It returns `Ok(cleared)`.

**Call relations**: Used by external clear-goal API paths. The explicit drop before reacquiring the runtime avoids holding the mutation permit while applying post-clear runtime effects.

*Call graph*: calls 2 internal fn (runtime_for_thread, thread_goals); 1 external calls (warn!).


##### `GoalService::register_runtime`  (lines 282–285)

```
fn register_runtime(&self, runtime: &Arc<GoalRuntimeHandle>)
```

**Purpose**: Registers a live runtime handle for its thread so API calls can coordinate with it later. The service stores only a weak reference to avoid ownership cycles.

**Data flow**: Locks the runtime map via `runtimes()`, converts `runtime.thread_id()` to a string key, downgrades the `Arc<GoalRuntimeHandle>` to `Weak`, and inserts it into the map.

**Call relations**: Called by the extension when a thread starts and its runtime is created or recovered. It populates the lookup table used by `runtime_for_thread`.

*Call graph*: calls 1 internal fn (runtimes); 1 external calls (downgrade).


##### `GoalService::unregister_runtime`  (lines 287–297)

```
fn unregister_runtime(&self, runtime: &Arc<GoalRuntimeHandle>)
```

**Purpose**: Removes a runtime registration only if the currently stored weak reference points to the same runtime instance. This avoids deleting a newer runtime that reused the same thread ID.

**Data flow**: Builds the thread-ID key and a downgraded weak reference for the provided runtime, locks the map, checks whether the stored weak reference at that key exists and `ptr_eq`s the provided one, and removes the entry only in that case.

**Call relations**: Called by the extension on thread stop. The pointer-equality guard makes unregister safe in the presence of runtime replacement or restart races.

*Call graph*: calls 1 internal fn (runtimes); 1 external calls (downgrade).


##### `GoalService::runtime_for_thread`  (lines 299–307)

```
fn runtime_for_thread(&self, thread_id: ThreadId) -> Option<Arc<GoalRuntimeHandle>>
```

**Purpose**: Looks up and upgrades the weak runtime handle for a thread, cleaning up stale entries when the runtime has already been dropped. It is the service’s bridge from thread ID to live runtime coordination.

**Data flow**: Converts `ThreadId` to a string key, locks the runtime map, attempts `Weak::upgrade` on the stored entry, removes the key if upgrade fails, and returns `Option<Arc<GoalRuntimeHandle>>`.

**Call relations**: Used by set, clear, and post-write runtime-effect paths whenever they need to coordinate with a live runtime. It encapsulates stale-entry cleanup so callers do not need to manage weak-reference hygiene.

*Call graph*: calls 1 internal fn (runtimes); called by 3 (clear_thread_goal, set_thread_goal, apply_runtime_effects); 1 external calls (to_string).


##### `GoalService::runtimes`  (lines 309–311)

```
fn runtimes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Weak<GoalRuntimeHandle>>>
```

**Purpose**: Returns the mutex guard for the runtime registry, recovering from poison if necessary. It centralizes the service’s poison-handling policy.

**Data flow**: Locks `self.runtimes` and on poison extracts the inner guard with `PoisonError::into_inner`, returning `MutexGuard<'_, HashMap<String, Weak<GoalRuntimeHandle>>>`.

**Call relations**: This private helper is used by runtime registration, unregistration, and lookup. Like the accounting module’s mutex helper, it keeps the service usable after panics.

*Call graph*: called by 3 (register_runtime, runtime_for_thread, unregister_runtime).


### `ext/mcp/src/executor_plugin.rs`

`orchestration` · `thread setup and MCP server contribution resolution`

This file implements thread-scoped MCP discovery for selected executor plugins. The internal `SelectedPluginMcpServers` snapshot stores the selected plugin’s stable root ID, display name, original selection order, and the raw `(server_name, McpServerConfig)` pairs loaded from the plugin. `SelectedExecutorPluginMcpState` wraps a `tokio::sync::OnceCell`, allowing the expensive discovery step to run at most once per thread. `seed_thread_state()` inserts that state into `ExtensionDataInit`, and `SelectedExecutorPluginMcpContributor::new()` wires together an `ExecutorPluginProvider` for resolving selected roots into bound plugins and an `ExecutorPluginMcpProvider` for reading MCP declarations from those plugins.

`resolve_snapshot()` walks the thread’s `SelectedCapabilityRoot` list in order. For each root it attempts to resolve the plugin binding; missing plugins are skipped, while resolution or MCP-loading failures are logged with `tracing::warn!` and also skipped. Successful loads become immutable snapshot entries preserving selection order.

The `McpServerContributor<Config>` implementation exposes this data to the MCP manager. `contribute()` first retrieves thread-local selected roots and seeded state; if either is absent it returns no contributions, and missing state is explicitly warned about. It then initializes or reuses the snapshot, clones each plugin’s server list into a `HashMap`, applies `Config::apply_plugin_mcp_server_requirements()` keyed by the plugin’s selected-root ID, sorts server names for deterministic output, and emits `McpServerContribution::SelectedPlugin` entries carrying the plugin metadata plus the adjusted config. The design choice to key requirements by selected root ID, not manifest name, is central to matching enterprise policy to the user’s selected plugin authority.

#### Function details

##### `seed_thread_state`  (lines 35–37)

```
fn seed_thread_state(thread_init: &mut ExtensionDataInit)
```

**Purpose**: Initializes per-thread storage for the selected-executor-plugin MCP snapshot.

**Data flow**: It takes a mutable `ExtensionDataInit` and inserts a default `SelectedExecutorPluginMcpState`, whose `OnceCell` starts empty. It returns no value.

**Call relations**: This is called during thread initialization by `initialize_executor_plugin_thread_data`, ensuring later MCP contribution code can cache discovery results.

*Call graph*: calls 1 internal fn (insert); called by 1 (initialize_executor_plugin_thread_data); 1 external calls (default).


##### `SelectedExecutorPluginMcpContributor::new`  (lines 45–50)

```
fn new(environment_manager: Arc<EnvironmentManager>) -> Self
```

**Purpose**: Constructs the contributor with the providers needed to resolve selected executor plugins and load their MCP declarations.

**Data flow**: It accepts an `Arc<EnvironmentManager>`, clones it for `ExecutorPluginProvider::new(...)`, pairs that provider with the zero-sized `ExecutorPluginMcpProvider`, and returns a populated `SelectedExecutorPluginMcpContributor`.

**Call relations**: This constructor is used by `install_executor_plugins` when registering the contributor in the extension registry.

*Call graph*: calls 1 internal fn (new); called by 1 (install_executor_plugins); 1 external calls (clone).


##### `SelectedExecutorPluginMcpContributor::resolve_snapshot`  (lines 52–89)

```
async fn resolve_snapshot(
        &self,
        selected_roots: &[SelectedCapabilityRoot],
    ) -> Vec<SelectedPluginMcpServers>
```

**Purpose**: Discovers MCP servers for the currently selected executor plugins and records a stable snapshot of successful results.

**Data flow**: It reads a slice of `SelectedCapabilityRoot`, iterates with `enumerate()` to preserve selection order, and for each root awaits `self.plugin_provider.resolve_bound(selected_root)`. `Ok(None)` is skipped; `Err` logs a warning and continues. For resolved plugins it awaits `self.mcp_provider.load(&plugin)`: on success it pushes a `SelectedPluginMcpServers` containing the plugin’s selected-root ID, display name, selection order, and loaded servers; on failure it logs a warning and skips that plugin. It returns the accumulated `Vec<SelectedPluginMcpServers>`.

**Call relations**: This helper is invoked lazily from `contribute()` through `OnceCell::get_or_init`, so discovery runs only when MCP contributions are first requested for a thread.

*Call graph*: calls 2 internal fn (resolve_bound, load); 3 external calls (new, iter, warn!).


##### `SelectedExecutorPluginMcpContributor::id`  (lines 93–95)

```
fn id(&self) -> &'static str
```

**Purpose**: Provides the stable contributor identifier used by the extension framework.

**Data flow**: It returns the static string `"selected_executor_plugin_mcp"`.

**Call relations**: The extension registry and diagnostics use this identifier when referring to this contributor.


##### `SelectedExecutorPluginMcpContributor::contribute`  (lines 97–138)

```
fn contribute(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>>
```

**Purpose**: Produces MCP server contributions for the thread’s selected executor plugins, after applying configuration requirements and deterministic ordering.

**Data flow**: It receives an `McpServerContributionContext<Config>`, boxes an async block, and first reads `thread_init()`. If thread data is absent, or if `Vec<SelectedCapabilityRoot>` is absent, it returns an empty vector. If `SelectedExecutorPluginMcpState` is missing, it logs a warning and returns empty. Otherwise it initializes or reuses `state.snapshot` by awaiting `self.resolve_snapshot(selected_roots.as_ref())`. For each plugin snapshot entry, it clones the server list into a `HashMap`, calls `context.config().apply_plugin_mcp_server_requirements(&plugin.plugin_id, &mut servers)`, converts back to a vector, sorts by server name, and maps each pair into `McpServerContribution::SelectedPlugin` carrying name, plugin metadata, selection order, and boxed config. The final vector is returned.

**Call relations**: This is the runtime entrypoint called by the MCP manager when assembling effective servers. It depends on prior `seed_thread_state()` initialization and delegates one-time discovery to `resolve_snapshot()`.

*Call graph*: calls 2 internal fn (config, thread_init); 3 external calls (pin, new, warn!).


### `ext/skills/src/state.rs`

`orchestration` · `thread lifetime and request handling`

This file defines the long-lived thread-local state used by the skills extension. `SkillsThreadState` holds the current `SkillsExtensionConfig` behind a `Mutex`, the immutable `selected_roots` chosen for the thread, a boolean flag indicating whether orchestrator skills are enabled, and an optional cached `Arc<OrchestratorGenerationCache>`. The cache is regenerated whenever the associated `McpResourceClient` changes, using its `cache_key` as the identity boundary.

Two orchestrator-specific caches are maintained. The first is a `tokio::sync::OnceCell<SkillCatalog>` used by `orchestrator_catalog_snapshot`, which ensures the orchestrator catalog is listed at most once per generation and converts initialization failure into a catalog containing only a warning message. The second is `OrchestratorResourceCache`, a mutex-protected `HashMap<SkillReadCacheKey, SkillReadResult>` with explicit limits: at most 100 cached resources and at most 8 MiB of cached content bytes. Reads for non-orchestrator authorities bypass this machinery and go straight to `SkillProviders::read`.

`read_skill` only caches orchestrator reads when the provider returns the exact resource that was requested; if the provider redirects to a different resource id, the result is returned but not stored. `OrchestratorResourceCache::insert` is conservative: it refuses to cache on integer overflow, entry-count overflow, or byte-budget overflow, and it preserves an existing cached value if the same key is inserted again.

#### Function details

##### `SkillsThreadState::new`  (lines 35–46)

```
fn new(
        config: SkillsExtensionConfig,
        selected_roots: Vec<SelectedCapabilityRoot>,
        orchestrator_skills_enabled: bool,
    ) -> Self
```

**Purpose**: Constructs the per-thread skills state with initial config, selected roots, orchestrator enablement, and an empty orchestrator cache slot.

**Data flow**: Consumes a `SkillsExtensionConfig`, a `Vec<SelectedCapabilityRoot>`, and a boolean flag. It wraps the config in a `Mutex`, stores the roots and flag directly, initializes `orchestrator_cache` to `Mutex::new(None)`, and returns the new `SkillsThreadState`.

**Call relations**: It is called by `on_config_changed` and `on_thread_start` when a thread begins or its extension state is rebuilt. This is the root constructor for all later catalog and read caching behavior.

*Call graph*: called by 2 (on_config_changed, on_thread_start); 1 external calls (new).


##### `SkillsThreadState::config`  (lines 48–53)

```
fn config(&self) -> SkillsExtensionConfig
```

**Purpose**: Returns a snapshot clone of the current extension config stored in thread state.

**Data flow**: Locks the `config` mutex, recovering from poisoning with `PoisonError::into_inner`, clones the contained `SkillsExtensionConfig`, and returns that clone.

**Call relations**: This accessor is used wherever callers need the current config without holding the mutex. It isolates poison recovery and cloning in one place.


##### `SkillsThreadState::set_config`  (lines 55–60)

```
fn set_config(&self, config: SkillsExtensionConfig)
```

**Purpose**: Replaces the current thread-local extension config.

**Data flow**: Locks the `config` mutex with poison recovery and overwrites the stored `SkillsExtensionConfig` with the provided value. It returns no value.

**Call relations**: This mutator is used when configuration changes after thread creation. It updates only config state and leaves roots and caches untouched.


##### `SkillsThreadState::selected_roots`  (lines 62–64)

```
fn selected_roots(&self) -> &[SelectedCapabilityRoot]
```

**Purpose**: Exposes the capability roots selected for this thread as an immutable slice.

**Data flow**: Borrows `self.selected_roots` and returns `&[SelectedCapabilityRoot]` without allocation or mutation.

**Call relations**: This is a simple accessor for higher-level logic that needs to derive executor skill visibility from the thread’s selected roots.


##### `SkillsThreadState::orchestrator_skills_enabled`  (lines 66–68)

```
fn orchestrator_skills_enabled(&self) -> bool
```

**Purpose**: Reports whether orchestrator-owned skills are enabled for this thread.

**Data flow**: Reads the stored boolean `orchestrator_skills_enabled` and returns it directly.

**Call relations**: This accessor lets callers gate orchestrator-specific behavior without inspecting config internals.


##### `SkillsThreadState::orchestrator_catalog_snapshot`  (lines 70–85)

```
async fn orchestrator_catalog_snapshot(
        &self,
        mcp_resources: Option<&McpResourceClient>,
        initialize: impl Future<Output = Result<SkillCatalog, SkillProviderError>> + Send,
```

**Purpose**: Returns the cached orchestrator catalog for the current generation, initializing it once from an async listing future if needed.

**Data flow**: Accepts an optional `McpResourceClient` reference and an initialization future producing `Result<SkillCatalog, SkillProviderError>`. It obtains the generation cache via `orchestrator_cache`, calls `catalog.get_or_init` on the `OnceCell`, and if initialization fails converts the error into a `SkillCatalog` whose `warnings` contains the error message and whose other fields are defaulted. It awaits initialization, clones the cached `SkillCatalog`, and returns it.

**Call relations**: It is called by `list_skills` through tool/context code when an orchestrator catalog snapshot is needed. The function delegates cache selection to `orchestrator_cache` and ensures repeated callers in the same generation share one listing result.

*Call graph*: calls 1 internal fn (orchestrator_cache); called by 1 (list_skills).


##### `SkillsThreadState::read_skill`  (lines 87–117)

```
async fn read_skill(
        &self,
        providers: &SkillProviders,
        request: SkillReadRequest,
    ) -> SkillProviderResult<SkillReadResult>
```

**Purpose**: Reads a skill resource, using the orchestrator resource cache only for orchestrator-owned requests and bypassing caching for all other authorities.

**Data flow**: Consumes a `SkillProviders` reference and a `SkillReadRequest`. If `request.authority.kind` is not `SkillSourceKind::Orchestrator`, it immediately awaits and returns `providers.read(request)`. Otherwise it obtains the generation cache from `orchestrator_cache`, derives a `SkillReadCacheKey` from the request, checks the mutex-protected resource cache for an existing cloned result, and returns it if present. On a miss it awaits `providers.read(request)`, compares `result.resource` to the requested resource id, and only inserts into the cache when they match exactly; it returns either the uncached result or the cached/inserted clone.

**Call relations**: This method is called by `read_main_prompt` to service skill content reads. It delegates provider dispatch to `SkillProviders::read`, key derivation to `SkillReadCacheKey::from`, and cache selection to `orchestrator_cache`, acting as the policy layer that decides when orchestrator reads are reusable.

*Call graph*: calls 3 internal fn (read, from, orchestrator_cache); called by 1 (read_main_prompt).


##### `SkillsThreadState::orchestrator_cache`  (lines 119–142)

```
fn orchestrator_cache(
        &self,
        mcp_resources: Option<&McpResourceClient>,
    ) -> Arc<OrchestratorGenerationCache>
```

**Purpose**: Returns the current generation cache for orchestrator data, replacing it when the MCP resource client identity changes.

**Data flow**: Locks the `orchestrator_cache` mutex with poison recovery, derives an optional `McpResourceClientCacheKey` from `mcp_resources`, and checks whether the stored cache exists and has the same `mcp_cache_key`. If so it returns an `Arc` clone of that cache. Otherwise it allocates a new `OrchestratorGenerationCache` containing the new key, a fresh `OnceCell<SkillCatalog>`, and a default `OrchestratorResourceCache`, stores it in the mutex slot, and returns an `Arc` clone of the new cache.

**Call relations**: It is called by both `orchestrator_catalog_snapshot` and `read_skill`. This function is the cache-generation boundary: any change in MCP resource client identity invalidates both the cached orchestrator catalog and cached orchestrator resource contents.

*Call graph*: called by 2 (orchestrator_catalog_snapshot, read_skill); 5 external calls (clone, new, new, new, default).


##### `SkillReadCacheKey::from`  (lines 159–165)

```
fn from(request: &SkillReadRequest) -> Self
```

**Purpose**: Builds the cache key used for orchestrator resource reads from the authority, package, and resource in a read request.

**Data flow**: Reads a `SkillReadRequest` reference, clones its `authority`, `package`, and `resource` fields, and returns a `SkillReadCacheKey` containing those values.

**Call relations**: It is invoked by `SkillsThreadState::read_skill` before probing or inserting into the orchestrator resource cache. The key defines cache identity at the granularity of one authority/package/resource triple.

*Call graph*: called by 1 (read_skill).


##### `OrchestratorResourceCache::get`  (lines 175–177)

```
fn get(&self, key: &SkillReadCacheKey) -> Option<SkillReadResult>
```

**Purpose**: Looks up a cached orchestrator read result and returns a cloned copy if present.

**Data flow**: Accepts a cache-key reference, queries `self.entries`, clones the stored `SkillReadResult` when found, and returns `Option<SkillReadResult>`.

**Call relations**: This helper is used inside `SkillsThreadState::read_skill` after locking the resource cache. It keeps the cache API clone-based so callers can release the mutex before using the result.


##### `OrchestratorResourceCache::insert`  (lines 179–197)

```
fn insert(&mut self, key: SkillReadCacheKey, result: SkillReadResult) -> SkillReadResult
```

**Purpose**: Attempts to cache an orchestrator read result subject to duplicate, count, and total-byte limits, and always returns the effective result value.

**Data flow**: Takes ownership of a cache key and `SkillReadResult`. If the key already exists, it returns a clone of the cached value. Otherwise it computes `result.contents.len()`, uses `checked_add` against `self.contents_bytes` to avoid overflow, and refuses to cache if the cache already has `MAX_CACHED_ORCHESTRATOR_RESOURCES` entries or if the new total would exceed `MAX_CACHED_ORCHESTRATOR_CONTENT_BYTES`. On a successful insert it updates `contents_bytes`, stores a clone of the result in `entries`, and returns the result.

**Call relations**: It is called by `SkillsThreadState::read_skill` after a successful orchestrator provider read whose returned resource id matches the requested one. This method enforces the cache’s memory and cardinality invariants.

*Call graph*: 1 external calls (clone).


### `core/src/tools/handlers/new_context_window.rs`

`orchestration` · `tool invocation when the model requests a context reset`

This file contains a very small handler whose only job is to expose and execute the `new_context` function tool. The constant `NEW_CONTEXT_WINDOW_MESSAGE` is the exact user-visible confirmation text returned after the request is accepted. `NewContextWindowHandler` implements `ToolExecutor<ToolInvocation>` directly: `tool_name` returns the shared constant tool name from the spec module, `spec` delegates schema creation to `create_new_context_window_tool`, and `handle` performs the entire runtime action in an inline async block.

Execution is intentionally strict about payload shape even though the runtime generally routes function payloads here: if `invocation.payload` is not `ToolPayload::Function`, the handler returns `FunctionCallError::RespondToModel` with a specific unsupported-payload message. On valid input, it calls `invocation.session.request_new_context_window().await`, which records the session-level request to rotate into a new context window. The tool itself does not parse arguments, because the schema has an empty object parameter set and there is no per-call state beyond the request itself. Success is returned as a boxed `FunctionToolOutput::from_text`, with the fixed message and `Some(true)` success marker. The file also implements `CoreToolRuntime` for the handler with default behavior, since no custom payload filtering or parallelism rules are needed.

#### Function details

##### `NewContextWindowHandler::tool_name`  (lines 19–21)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name for the new-context operation. It binds the handler to the shared spec constant rather than duplicating the string literal.

**Data flow**: Reads `NEW_CONTEXT_WINDOW_TOOL_NAME`, wraps it with `ToolName::plain`, and returns the resulting `ToolName`.

**Call relations**: Used by tool registration and dispatch so model calls to `new_context` resolve to this handler.

*Call graph*: calls 1 internal fn (plain).


##### `NewContextWindowHandler::spec`  (lines 23–25)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the tool specification for `new_context`. The schema is fixed and argument-free.

**Data flow**: Calls `create_new_context_window_tool()` and returns the resulting `ToolSpec`.

**Call relations**: Invoked by the tool discovery/registration path before any execution occurs.

*Call graph*: calls 1 internal fn (create_new_context_window_tool).


##### `NewContextWindowHandler::handle`  (lines 27–42)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Validates that the invocation is a function payload, requests a new context window from the session, and returns a fixed confirmation message. This is the file's only execution path.

**Data flow**: Consumes a `ToolInvocation`; inside an async block it pattern-matches `invocation.payload`, returning `FunctionCallError::RespondToModel` if the payload is unsupported; otherwise it awaits `invocation.session.request_new_context_window()`, constructs a `FunctionToolOutput` from `NEW_CONTEXT_WINDOW_MESSAGE.to_string()` with success `Some(true)`, boxes it, and returns it.

**Call relations**: Called directly by the tool runtime after dispatch. It does not delegate to helper functions in this file; its only external action is the session-level `request_new_context_window` call.

*Call graph*: calls 2 internal fn (from_text, boxed_tool_output); 3 external calls (pin, matches!, RespondToModel).


### `core/src/tools/handlers/plan.rs`

`orchestration` · `tool invocation during task planning / checklist updates`

This file contains both the runtime handler for plan updates and the tiny output type used to acknowledge success. `PlanToolOutput` is intentionally content-light: its log preview is the fixed string `"Plan updated"`, it always logs as successful, it serializes to a `FunctionCallOutputPayload` with `success = Some(true)`, and in code mode it returns an empty JSON object. The actual plan data is not echoed back through the tool output; instead it is forwarded as an event.

`PlanHandler` exposes the `update_plan` tool name and delegates schema creation to `create_update_plan_tool`. Its async execution path, `handle_call`, first extracts raw argument text only from `ToolPayload::Function`; any other payload variant becomes a model-facing unsupported-payload error. It then enforces an important mode invariant: when `turn.collaboration_mode.mode == ModeKind::Plan`, the tool is rejected because this tool is reserved for TODO/checklist updates rather than the dedicated Plan mode. For valid calls, it parses the JSON string into `codex_protocol::plan_tool::UpdatePlanArgs` using `parse_update_plan_arguments`, converting serde failures into `RespondToModel` errors that include the parse message. Finally, it sends `EventMsg::PlanUpdate(args)` through the session and returns boxed `PlanToolOutput`. The file therefore acts as a thin bridge from tool invocation into the session event stream, with one explicit policy check around collaboration mode.

#### Function details

##### `PlanToolOutput::log_preview`  (lines 25–27)

```
fn log_preview(&self) -> String
```

**Purpose**: Returns the fixed log message for successful plan updates. It does not include plan contents.

**Data flow**: Reads no external state and returns `PLAN_UPDATED_MESSAGE.to_string()`.

**Call relations**: Used by the generic tool-output logging path after `PlanHandler` succeeds.


##### `PlanToolOutput::success_for_logging`  (lines 29–31)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks the output as a successful tool execution. The handler only constructs this output after sending the plan update event.

**Data flow**: Returns the constant boolean `true`.

**Call relations**: Consumed by the framework's logging/reporting layer.


##### `PlanToolOutput::to_response_item`  (lines 33–41)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Builds the protocol response item acknowledging that the plan was updated. It sets the success flag explicitly on the function-call output payload.

**Data flow**: Takes `call_id` and ignores the original payload; creates a `FunctionCallOutputPayload` from the fixed text `Plan updated`, mutates `output.success` to `Some(true)`, wraps it in `ResponseInputItem::FunctionCallOutput { call_id, output }`, and returns it.

**Call relations**: Called by the tool framework when serializing the handler's success result back to the model.

*Call graph*: calls 1 internal fn (from_text).


##### `PlanToolOutput::code_mode_result`  (lines 43–45)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Returns an empty JSON object for code-mode consumers. The actual plan update is communicated through events rather than this result body.

**Data flow**: Ignores the payload and returns `JsonValue::Object(serde_json::Map::new())`.

**Call relations**: Used by code-mode result generation after successful execution.

*Call graph*: 2 external calls (Object, new).


##### `PlanHandler::tool_name`  (lines 49–51)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the canonical function-tool name `update_plan`. This is the dispatch key used by the runtime.

**Data flow**: Creates and returns a `ToolName` from the static string via `ToolName::plain`.

**Call relations**: Queried during tool registration and dispatch.

*Call graph*: calls 1 internal fn (plain).


##### `PlanHandler::spec`  (lines 53–55)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the schema for the plan-update tool. The schema itself lives in the companion spec module.

**Data flow**: Calls `create_update_plan_tool()` and returns the resulting `ToolSpec`.

**Call relations**: Invoked when the runtime enumerates available tools.

*Call graph*: calls 1 internal fn (create_update_plan_tool).


##### `PlanHandler::handle`  (lines 57–59)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async plan-update implementation to the executor trait. It performs no validation itself.

**Data flow**: Takes a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes the future, and returns it.

**Call relations**: This is the trait entrypoint; it delegates all execution logic to `PlanHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `PlanHandler::handle_call`  (lines 63–96)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates payload shape and collaboration mode, parses plan arguments, emits a `PlanUpdate` event, and returns a fixed success output. It is the operational core of the file.

**Data flow**: Reads `session`, `turn`, and `payload` from the invocation; extracts the raw `arguments` string only from `ToolPayload::Function`, otherwise returns `FunctionCallError::RespondToModel`; checks `turn.collaboration_mode.mode` and rejects `ModeKind::Plan`; parses the JSON arguments into `UpdatePlanArgs` via `parse_update_plan_arguments`; sends `EventMsg::PlanUpdate(args)` through `session.send_event`; and returns `boxed_tool_output(PlanToolOutput)`.

**Call relations**: Called only from `PlanHandler::handle`. It delegates JSON decoding to `parse_update_plan_arguments` and then hands the parsed structure to the session event pipeline.

*Call graph*: calls 2 internal fn (boxed_tool_output, parse_update_plan_arguments); called by 1 (handle); 2 external calls (PlanUpdate, RespondToModel).


##### `parse_update_plan_arguments`  (lines 101–105)

```
fn parse_update_plan_arguments(arguments: &str) -> Result<UpdatePlanArgs, FunctionCallError>
```

**Purpose**: Parses the raw JSON argument string for `update_plan` into the protocol-level `UpdatePlanArgs` type. It converts serde parse failures into model-facing errors with context.

**Data flow**: Takes `arguments: &str`, runs `serde_json::from_str::<UpdatePlanArgs>(arguments)`, and on error maps the serde message into `FunctionCallError::RespondToModel(format!(...))`; returns the parsed `UpdatePlanArgs` on success.

**Call relations**: Used exclusively by `PlanHandler::handle_call` after payload extraction and mode validation.

*Call graph*: called by 1 (handle_call).


### TUI thread session state
These files define the TUI's canonical per-thread session snapshots, event buffers, and high-level flows for starting, switching, and rendering thread-backed sessions.

### `tui/src/session_state.rs`

`data_model` · `cross-cutting session state during request handling and UI rendering`

This file is the TUI-side data model for an active chat/session. Its central type, `ThreadSessionState`, stores the concrete fields the UI and orchestration layers need to render status, route commands, and preserve session-specific behavior: thread identity and fork ancestry, model/provider/tier selection, approval and reviewer settings, a frozen `PermissionProfile` plus optional `ActivePermissionProfile`, current working directory, runtime workspace roots, instruction source paths, reasoning effort, collaboration mode, personality, message-history metadata, optional network proxy runtime addresses, and an optional rollout path. Two small helper structs accompany it: `SessionNetworkProxyRuntime` for HTTP/SOCKS proxy endpoints and `MessageHistoryMetadata` for log bookkeeping.

A subtle design choice is documented directly on `permission_profile`: the TUI caches a permission snapshot already interpreted relative to the response cwd, so later UI code must not recompute cwd-bound grants from scratch. The only behavior in the file updates cwd while preserving the meaning of an implicit runtime workspace root. When the cwd changes, the method checks whether the old cwd had been acting as one of the runtime roots; if so, it replaces that root with the new cwd and re-adds all other distinct roots without duplication, preserving order with the retargeted cwd first. If the previous cwd was not among runtime roots, only `cwd` changes.

#### Function details

##### `ThreadSessionState::set_cwd_retargeting_implicit_runtime_workspace_root`  (lines 60–76)

```
fn set_cwd_retargeting_implicit_runtime_workspace_root(
        &mut self,
        cwd: AbsolutePathBuf,
    )
```

**Purpose**: Updates the session's current working directory and, when the old cwd was implicitly serving as a runtime workspace root, retargets that root to the new cwd. It preserves other workspace roots while avoiding duplicates.

**Data flow**: Takes `&mut self` and a new `AbsolutePathBuf` cwd. It swaps `self.cwd` with the new path, reads whether the previous cwd existed in `self.runtime_workspace_roots`, and if so drains the old roots vector, writes back a new roots list beginning with the new cwd, then appends every prior root except the replaced cwd and any duplicates. It returns `()` and mutates `self.cwd` and possibly `self.runtime_workspace_roots`.

**Call relations**: This method is invoked from `apply_thread_settings_to_session` when incoming thread settings change the working directory. It does not call other project helpers; its work is local state reshaping using standard-library replacement/take operations so downstream UI and permission displays continue to reflect the intended workspace root semantics.

*Call graph*: called by 1 (apply_thread_settings_to_session); 3 external calls (replace, take, clone).


### `tui/src/app/thread_events.rs`

`data_model` · `request handling and thread switching`

This module is the data backbone for multi-thread conversation routing. `ThreadEventStore` keeps four kinds of thread-local state together: the latest `ThreadSessionState`, a snapshot of `Turn`s, a bounded `VecDeque<ThreadBufferedEvent>`, and replay bookkeeping in `PendingInteractiveReplayState`. It also caches `active_turn_id`, saved composer/input state, capacity, and whether the thread is currently active. Notifications and requests are pushed through `push_notification` and `push_request`, which both update replay bookkeeping and enforce the bounded buffer; if an evicted event was a `ServerRequest`, the replay state is told so pending approvals/input can be retired correctly. `set_turns` and notification handling cooperate to maintain `active_turn_id`, including clearing it on matching completion or thread close. `snapshot` produces the replay payload used when switching threads, intentionally filtering out answered or otherwise non-pending interactive requests so stale prompts do not reappear. `rebase_buffer_after_session_refresh` retains only events that should survive a fresh session read, such as unresolved requests, hook lifecycle notifications, MCP startup status, and feedback submissions. `file_change_changes` searches buffered notifications first and then persisted turns to reconstruct patch details for approval UIs. `ThreadEventChannel` pairs an `mpsc` sender/optional receiver with an `Arc<Mutex<ThreadEventStore>>` and an attachment mode (`Live` vs `ReplayOnly`), letting the app detach a receiver during thread switches while preserving the underlying store.

#### Function details

##### `ThreadEventStore::event_survives_session_refresh`  (lines 53–62)

```
fn event_survives_session_refresh(event: &ThreadBufferedEvent) -> bool
```

**Purpose**: Classifies which buffered events remain valid after the app refreshes a thread session from the server. It preserves unresolved interactive requests plus a small set of notifications whose meaning survives a session rebuild.

**Data flow**: It takes a borrowed `ThreadBufferedEvent` and pattern-matches it against allowed variants: any `Request`, hook start/completion notifications, MCP server status updates, and feedback submissions. It returns a boolean and does not mutate store state.

**Call relations**: This helper is used by refresh/rebase paths to prune stale buffered events after a session snapshot is replaced, ensuring replay only includes events still meaningful after a fresh read.

*Call graph*: 1 external calls (matches!).


##### `ThreadEventStore::new`  (lines 64–75)

```
fn new(capacity: usize) -> Self
```

**Purpose**: Constructs an empty per-thread event store with bounded buffering and default replay bookkeeping. All optional cached state starts unset and the thread is marked inactive.

**Data flow**: Given a `capacity`, it initializes `session` to `None`, `turns` and `buffer` to empty collections, `pending_interactive_replay` from its default, `active_turn_id` and `input_state` to `None`, stores the capacity, and sets `active = false`. It returns the fully initialized `ThreadEventStore`.

**Call relations**: This is the base constructor used by channel creation and many tests. Higher-level routing code wraps the store in `ThreadEventChannel` and later fills in session/turn state.

*Call graph*: called by 23 (agent_status_uses_bounded_buffered_activity, agent_status_uses_reasoning_summaries_only, request_user_input_does_not_count_as_pending_thread_approval, thread_event_snapshot_drops_answered_request_user_input_for_multi_prompt_turn, thread_event_snapshot_drops_pending_approvals_when_turn_completes, thread_event_snapshot_drops_pending_requests_when_thread_closes, thread_event_snapshot_drops_resolved_elicitation_after_outbound_resolution, thread_event_snapshot_drops_resolved_exec_approval_after_outbound_approval_id, thread_event_snapshot_drops_resolved_exec_approval_after_server_resolution, thread_event_snapshot_drops_resolved_patch_approval_after_outbound_approval (+13 more)); 3 external calls (new, new, default).


##### `ThreadEventStore::new_with_session`  (lines 78–87)

```
fn new_with_session(
        capacity: usize,
        session: ThreadSessionState,
        turns: Vec<Turn>,
    ) -> Self
```

**Purpose**: Builds a store preloaded with a session snapshot and initial turns. It is mainly a convenience for tests and replay-oriented initialization.

**Data flow**: It accepts `capacity`, a `ThreadSessionState`, and a `Vec<Turn>`, creates a blank store via `new`, assigns `session = Some(session)`, calls `set_turns(turns)` to populate turns and derive `active_turn_id`, and returns the store.

**Call relations**: This constructor is used by `ThreadEventChannel::new_with_session` and tests that need a ready-made store with snapshot state already installed.

*Call graph*: called by 2 (new_with_session, thread_event_store_restores_active_turn_from_snapshot_turns); 1 external calls (new).


##### `ThreadEventStore::set_session`  (lines 89–92)

```
fn set_session(&mut self, session: ThreadSessionState, turns: Vec<Turn>)
```

**Purpose**: Replaces the cached session snapshot and turn list for a thread. It keeps active-turn derivation centralized by delegating turn handling to `set_turns`.

**Data flow**: It takes ownership of a `ThreadSessionState` and `Vec<Turn>`, stores the session in `self.session`, then passes the turns into `set_turns`, which updates both `self.turns` and `self.active_turn_id`. It returns no value.

**Call relations**: Called when a thread snapshot is installed or refreshed. It is the normal path for synchronizing store state with a newly read session.

*Call graph*: calls 1 internal fn (set_turns); called by 1 (install_side_thread_snapshot).


##### `ThreadEventStore::rebase_buffer_after_session_refresh`  (lines 94–96)

```
fn rebase_buffer_after_session_refresh(&mut self)
```

**Purpose**: Drops buffered events that should not survive a fresh session read. This prevents replaying stale lifecycle notices or already-incorporated history after a refresh.

**Data flow**: It mutably borrows the store and runs `retain` on `self.buffer`, keeping only events for which `event_survives_session_refresh` returns true. The buffer is modified in place and nothing is returned.

**Call relations**: Used after session refresh/replay rebuilds so the store's buffered tail remains consistent with the newly fetched snapshot.

*Call graph*: 1 external calls (retain).


##### `ThreadEventStore::set_turns`  (lines 98–105)

```
fn set_turns(&mut self, turns: Vec<Turn>)
```

**Purpose**: Installs a new turn list and recomputes the cached active turn id from it. The active turn is defined as the most recent turn whose status is `InProgress`.

**Data flow**: It scans the provided `turns` in reverse, finds the last `Turn` with `TurnStatus::InProgress`, clones that turn id into `self.active_turn_id`, then replaces `self.turns` with the provided vector. It returns nothing.

**Call relations**: This is the shared turn-installation primitive used by constructors and session updates so active-turn tracking stays consistent across code paths.

*Call graph*: called by 1 (set_session).


##### `ThreadEventStore::push_notification`  (lines 107–133)

```
fn push_notification(&mut self, notification: ServerNotification)
```

**Purpose**: Appends a server notification to the bounded buffer while updating replay bookkeeping and active-turn lifecycle state. It also handles request-eviction side effects when the buffer overflows.

**Data flow**: It receives a `ServerNotification`, first informs `pending_interactive_replay` via `note_server_notification`, then pattern-matches the notification to set `active_turn_id` on `TurnStarted`, clear it on matching `TurnCompleted`, and clear it on `ThreadClosed`. The notification is wrapped as `ThreadBufferedEvent::Notification` and pushed to `self.buffer`; if the buffer exceeds `capacity`, the oldest event is popped, and if that evicted event was a `Request`, replay state is updated with `note_evicted_server_request`.

**Call relations**: Called by thread-routing code whenever a notification arrives. It is the store-side counterpart to live channel delivery and ensures replay state mirrors the same event stream.

*Call graph*: calls 2 internal fn (note_evicted_server_request, note_server_notification); 4 external calls (len, pop_front, push_back, Notification).


##### `ThreadEventStore::push_request`  (lines 135–146)

```
fn push_request(&mut self, request: ServerRequest)
```

**Purpose**: Appends a server request to the bounded buffer and updates pending interactive replay state. Like notification buffering, it also reacts to request eviction when capacity is exceeded.

**Data flow**: It takes a `ServerRequest`, records it with `pending_interactive_replay.note_server_request`, wraps it as `ThreadBufferedEvent::Request`, and pushes it onto `self.buffer`. If the buffer grows past `capacity`, it pops the oldest event and, when that removed event is also a request, informs replay state through `note_evicted_server_request`.

**Call relations**: Used by thread-routing when app-server requests arrive. Its replay bookkeeping is what later allows inactive-thread approvals and prompts to be surfaced correctly.

*Call graph*: calls 2 internal fn (note_evicted_server_request, note_server_request); 4 external calls (len, pop_front, push_back, Request).


##### `ThreadEventStore::pending_replay_requests`  (lines 148–165)

```
fn pending_replay_requests(&self) -> Vec<ServerRequest>
```

**Purpose**: Extracts the subset of buffered requests that should still be replayed or surfaced as pending interactive work. Answered or otherwise resolved requests are filtered out.

**Data flow**: It iterates over `self.buffer`, selects only `ThreadBufferedEvent::Request` entries whose request passes `pending_interactive_replay.should_replay_snapshot_request`, clones those requests, and collects them into a `Vec<ServerRequest>`. Other event kinds are ignored.

**Call relations**: This method feeds inactive-thread request surfacing and snapshot replay. Callers use it when they need only still-actionable requests rather than the full buffered event stream.

*Call graph*: 1 external calls (iter).


##### `ThreadEventStore::file_change_changes`  (lines 167–199)

```
fn file_change_changes(
        &self,
        turn_id: &str,
        item_id: &str,
    ) -> Option<Vec<codex_app_server_protocol::FileUpdateChange>>
```

**Purpose**: Finds the file-diff payload associated with a file-change approval item. It searches recent buffered notifications first, then falls back to persisted turn history.

**Data flow**: Given `turn_id` and `item_id`, it scans `self.buffer` in reverse for `ItemStarted` or `ItemCompleted` notifications whose turn id matches via `turn_id_matches`, then delegates each candidate item to `file_change_item_changes`. If no buffered match is found, it scans `self.turns` in reverse, filters turns by matching id, iterates their items in reverse, and again asks `file_change_item_changes`. It returns `Some(Vec<FileUpdateChange>)` on the first match or `None` otherwise.

**Call relations**: Called by thread-routing when converting a `FileChangeRequestApproval` into a displayable patch approval request. The reverse search favors the freshest event data.

*Call graph*: 1 external calls (iter).


##### `ThreadEventStore::apply_thread_rollback`  (lines 201–206)

```
fn apply_thread_rollback(&mut self, response: &ThreadRollbackResponse)
```

**Purpose**: Resets buffered event state after a confirmed thread rollback. The store keeps the rolled-back turn snapshot but discards buffered tail state and pending interactive replay bookkeeping.

**Data flow**: It takes a borrowed `ThreadRollbackResponse`, clones `response.thread.turns` into `self.turns`, clears `self.buffer`, resets `pending_interactive_replay` to its default value, and sets `active_turn_id` to `None`. It returns nothing.

**Call relations**: Invoked by rollback handling after the server confirms a rollback, so local replay state cannot resurrect requests or notifications from discarded turns.

*Call graph*: 2 external calls (clear, default).


##### `ThreadEventStore::snapshot`  (lines 208–229)

```
fn snapshot(&self) -> ThreadEventSnapshot
```

**Purpose**: Builds the replay snapshot used when switching to a thread. It includes cached session and turns plus only those buffered events that are still safe and useful to replay.

**Data flow**: It clones `self.session`, `self.turns`, and `self.input_state`. For `events`, it iterates over `self.buffer`, retaining all notifications, history responses, and feedback submissions, but only those requests that `pending_interactive_replay.should_replay_snapshot_request` says are still pending; the retained events are cloned into a `Vec<ThreadBufferedEvent>`. The assembled `ThreadEventSnapshot` is returned.

**Call relations**: Used by replay activation paths before rebuilding the chat widget for another thread. Its filtering rules are central to avoiding duplicate answered prompts during thread switches.

*Call graph*: 1 external calls (iter).


##### `ThreadEventStore::note_outbound_op`  (lines 231–236)

```
fn note_outbound_op(&mut self, op: T)
```

**Purpose**: Lets the store observe an outbound app command so replay bookkeeping can mark pending requests as answered or otherwise changed. It is generic over any type convertible into `AppCommand`.

**Data flow**: It accepts `op: T` where `T: Into<AppCommand>`, converts/forwards it into `pending_interactive_replay.note_outbound_op(op)`, and mutates only the replay-state subfield. It returns no value.

**Call relations**: Called by thread-routing after successful request resolution or thread-scoped command submission when the command can affect pending interactive state.

*Call graph*: calls 1 internal fn (note_outbound_op).


##### `ThreadEventStore::op_can_change_pending_replay_state`  (lines 238–243)

```
fn op_can_change_pending_replay_state(op: T) -> bool
```

**Purpose**: Answers whether a given outbound command is relevant to pending interactive replay bookkeeping. This avoids unnecessary store updates for unrelated commands.

**Data flow**: It takes any `T: Into<AppCommand>`, forwards it to `PendingInteractiveReplayState::op_can_change_state`, and returns the resulting boolean without touching store fields.

**Call relations**: Higher-level routing code consults this before calling `note_outbound_op`, especially in command submission and request-resolution paths.

*Call graph*: calls 1 internal fn (op_can_change_state); called by 5 (sync_auto_review_runtime_state_from_effective_config, update_feature_flags, note_active_thread_outbound_op, submit_thread_op, try_resolve_app_server_request).


##### `ThreadEventStore::has_pending_thread_approvals`  (lines 245–248)

```
fn has_pending_thread_approvals(&self) -> bool
```

**Purpose**: Reports whether the thread currently has unresolved approval-style interactive work. This powers badges and side-thread status indicators.

**Data flow**: It reads `self.pending_interactive_replay` and returns the boolean from `has_pending_thread_approvals()`. No state is mutated.

**Call relations**: Used by UI refresh code that aggregates pending approvals across inactive threads.

*Call graph*: calls 1 internal fn (has_pending_thread_approvals).


##### `ThreadEventStore::side_parent_pending_status`  (lines 250–264)

```
fn side_parent_pending_status(&self) -> Option<SideParentStatus>
```

**Purpose**: Summarizes pending interactive work for side-thread parent UI. User-input requests take precedence over approvals when both are considered.

**Data flow**: It queries `pending_interactive_replay` for pending thread user input first and returns `Some(SideParentStatus::NeedsInput)` if present; otherwise it checks pending approvals and returns `Some(SideParentStatus::NeedsApproval)`; if neither exists it returns `None`.

**Call relations**: Called by routing code after buffering requests/notifications or outbound resolutions so side-thread navigation can reflect current pending state.

*Call graph*: calls 2 internal fn (has_pending_thread_approvals, has_pending_thread_user_input).


##### `ThreadEventStore::active_turn_id`  (lines 266–268)

```
fn active_turn_id(&self) -> Option<&str>
```

**Purpose**: Exposes the cached active turn id as a borrowed string slice. It is a lightweight accessor for interrupt and steer logic.

**Data flow**: It reads `self.active_turn_id` and returns `Option<&str>` via `as_deref()`. No mutation occurs.

**Call relations**: Used by higher-level app code when deciding whether to interrupt or steer an existing turn versus starting a new one.


##### `ThreadEventStore::clear_active_turn_id`  (lines 270–272)

```
fn clear_active_turn_id(&mut self)
```

**Purpose**: Forgets the cached active turn id. This is used when the app detects that its local active-turn cache is stale.

**Data flow**: It sets `self.active_turn_id = None` and returns nothing.

**Call relations**: Called from race-recovery paths in thread operation submission when the server indicates the previously cached active turn no longer exists.


##### `turn_id_matches`  (lines 275–277)

```
fn turn_id_matches(request_turn_id: &str, candidate_turn_id: &str) -> bool
```

**Purpose**: Implements the module's turn-id matching rule, where an empty requested turn id acts as a wildcard. This supports approvals that may omit a specific turn id.

**Data flow**: It compares `request_turn_id` and `candidate_turn_id`, returning true if the request id is empty or exactly equals the candidate. It has no side effects.

**Call relations**: Used by file-change lookup logic to match buffered notifications and historical turns against approval metadata.


##### `file_change_item_changes`  (lines 279–287)

```
fn file_change_item_changes(
    item: &ThreadItem,
    item_id: &str,
) -> Option<Vec<codex_app_server_protocol::FileUpdateChange>>
```

**Purpose**: Extracts cloned file-update changes from a `ThreadItem` when that item is the targeted file-change entry. Non-file-change items or mismatched ids are ignored.

**Data flow**: It pattern-matches `item`; if it is `ThreadItem::FileChange` with `id == item_id`, it clones and returns the `changes` vector, otherwise it returns `None`.

**Call relations**: This helper is called by `ThreadEventStore::file_change_changes` in both buffered-event and persisted-turn search passes.


##### `ThreadEventChannel::new`  (lines 298–306)

```
fn new(capacity: usize) -> Self
```

**Purpose**: Creates a live thread event channel with a bounded Tokio mpsc queue and an empty backing store. The receiver starts attached and available for activation.

**Data flow**: Given a `capacity`, it creates an `mpsc::channel(capacity)`, stores the sender, wraps the receiver in `Some`, constructs an `Arc<Mutex<ThreadEventStore::new(capacity)>>`, sets `attachment` to `ThreadEventAttachment::Live`, and returns the channel struct.

**Call relations**: This is the standard constructor used by thread-routing whenever a thread id first appears locally.

*Call graph*: calls 1 internal fn (new); called by 14 (discard_closed_side_thread_removes_local_state_without_server_rpc, enqueue_thread_event_does_not_block_when_channel_full, inactive_thread_approval_badge_clears_after_turn_completion_notification, inactive_thread_approval_bubbles_into_active_view, open_agent_picker_allows_existing_agent_threads_when_feature_is_disabled, open_agent_picker_clears_completed_path_backed_agent_running_state, open_agent_picker_keeps_missing_threads_for_replay, open_agent_picker_marks_loaded_threads_open, open_agent_picker_marks_terminal_read_errors_closed, open_agent_picker_preserves_cached_metadata_for_replay_threads (+4 more)); 3 external calls (new, new, channel).


##### `ThreadEventChannel::mark_replay_only`  (lines 308–310)

```
fn mark_replay_only(&mut self)
```

**Purpose**: Marks a channel as replay-only rather than live-attached. This distinguishes channels that should only provide snapshot replay data.

**Data flow**: It mutably updates the private `attachment` field to `ThreadEventAttachment::ReplayOnly` and returns nothing.

**Call relations**: Used by thread-management code when a thread should remain inspectable from cached state but no longer receive live attachment semantics.


##### `ThreadEventChannel::attachment`  (lines 312–314)

```
fn attachment(&self) -> ThreadEventAttachment
```

**Purpose**: Returns the channel's current attachment mode. Callers use this to decide whether a snapshot may need refreshing or live subscription behavior.

**Data flow**: It reads the `attachment` field and returns the `ThreadEventAttachment` copy. No mutation occurs.

**Call relations**: Consulted by replay/snapshot logic to distinguish live channels from replay-only placeholders.


##### `ThreadEventChannel::new_with_session`  (lines 317–331)

```
fn new_with_session(
        capacity: usize,
        session: ThreadSessionState,
        turns: Vec<Turn>,
    ) -> Self
```

**Purpose**: Creates a live channel whose backing store already contains a session snapshot and turns. It is primarily a convenience for tests and preloaded replay state.

**Data flow**: It allocates an `mpsc` channel, wraps the receiver in `Some`, constructs an `Arc<Mutex<ThreadEventStore::new_with_session(capacity, session, turns)>>`, sets `attachment` to `Live`, and returns the assembled channel.

**Call relations**: Used in tests and snapshot-heavy setup paths where the thread store should begin with known session state instead of being filled later.

*Call graph*: calls 1 internal fn (new_with_session); called by 16 (active_turn_id_for_thread_uses_snapshot_turns, feedback_submission_for_inactive_thread_replays_into_origin_thread, inactive_thread_approval_badge_clears_after_turn_completion_notification, inactive_thread_approval_bubbles_into_active_view, inactive_thread_settings_notification_updates_cached_collaboration_mode, inactive_thread_started_notification_initializes_replay_session, inactive_thread_started_notification_preserves_primary_model_when_path_missing, refreshed_snapshot_session_persists_resumed_turns, replay_thread_snapshot_restores_draft_and_queued_input, replay_thread_snapshot_restores_pending_pastes_for_submit (+6 more)); 3 external calls (new, new, channel).


##### `tests::test_thread_session`  (lines 359–382)

```
fn test_thread_session(thread_id: ThreadId, cwd: PathBuf) -> ThreadSessionState
```

**Purpose**: Builds a deterministic `ThreadSessionState` fixture for thread-event tests. The fixture represents a persisted, read-only test session rooted at a supplied cwd.

**Data flow**: It takes a `ThreadId` and `PathBuf`, constructs a `ThreadSessionState` with fixed model/provider values, `AskForApproval::Never`, `ApprovalsReviewer::User`, `PermissionProfile::read_only()`, absolute cwd, empty workspace/instruction vectors, and `rollout_path = Some(PathBuf::new())`, then returns it.

**Call relations**: This helper is used by multiple tests in the module to seed stores and notifications with consistent session metadata.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (abs, new, new).


##### `tests::test_turn`  (lines 384–395)

```
fn test_turn(turn_id: &str, status: TurnStatus, items: Vec<ThreadItem>) -> Turn
```

**Purpose**: Creates a compact `Turn` fixture with caller-specified id, status, and items. All timing and error fields are left unset.

**Data flow**: It accepts a turn id string, `TurnStatus`, and `Vec<ThreadItem>`, wraps them into a `Turn` with `items_view = Full` and `None` for optional metadata, and returns the value.

**Call relations**: Used by notification and snapshot tests to build minimal turn histories without repeating boilerplate.


##### `tests::turn_started_notification`  (lines 397–405)

```
fn turn_started_notification(thread_id: ThreadId, turn_id: &str) -> ServerNotification
```

**Purpose**: Constructs a `ServerNotification::TurnStarted` fixture for a given thread and turn id. The embedded turn is marked in progress with a synthetic `started_at` timestamp.

**Data flow**: It takes a `ThreadId` and turn id, converts the thread id to string, builds a `TurnStartedNotification` whose `turn` is based on `test_turn` with `started_at = Some(0)`, wraps it in `ServerNotification::TurnStarted`, and returns it.

**Call relations**: Used by active-turn lifecycle tests to drive `push_notification` through the start-turn branch.

*Call graph*: 4 external calls (TurnStarted, new, to_string, test_turn).


##### `tests::turn_completed_notification`  (lines 407–420)

```
fn turn_completed_notification(
        thread_id: ThreadId,
        turn_id: &str,
        status: TurnStatus,
    ) -> ServerNotification
```

**Purpose**: Constructs a `ServerNotification::TurnCompleted` fixture with caller-selected completion status. It simulates a finished turn with timestamps and duration.

**Data flow**: It takes a `ThreadId`, turn id, and `TurnStatus`, builds a `TurnCompletedNotification` whose embedded turn comes from `test_turn` plus `completed_at = Some(0)` and `duration_ms = Some(1)`, wraps it in `ServerNotification::TurnCompleted`, and returns it.

**Call relations**: Used by tests that verify active-turn clearing behavior when completion notifications arrive.

*Call graph*: 4 external calls (TurnCompleted, new, to_string, test_turn).


##### `tests::hook_started_notification`  (lines 422–443)

```
fn hook_started_notification(thread_id: ThreadId, turn_id: &str) -> ServerNotification
```

**Purpose**: Creates a realistic hook-start notification fixture for replay-preservation tests. The payload includes a running hook summary with source path and status text.

**Data flow**: It accepts a `ThreadId` and turn id, converts ids to strings, builds a `HookStartedNotification` containing a populated `HookRunSummary` rooted at `/tmp/hooks.json`, wraps it in `ServerNotification::HookStarted`, and returns it.

**Call relations**: Used by rebase tests to prove hook lifecycle notifications survive session refresh pruning.

*Call graph*: 4 external calls (HookStarted, new, test_path_buf, to_string).


##### `tests::hook_completed_notification`  (lines 445–475)

```
fn hook_completed_notification(thread_id: ThreadId, turn_id: &str) -> ServerNotification
```

**Purpose**: Creates a realistic hook-completed notification fixture with warning and stop output entries. It models a blocked prompt hook finishing after execution.

**Data flow**: It takes a `ThreadId` and turn id, builds a `HookCompletedNotification` with a stopped `HookRunSummary`, completion timing, and two output entries, wraps it in `ServerNotification::HookCompleted`, and returns it.

**Call relations**: Paired with `hook_started_notification` in tests that verify hook notifications remain replayable after session refresh.

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

**Purpose**: Builds a command-execution approval request fixture for replay-state tests. The request includes thread, turn, item, cwd, optional approval id, and a sample command.

**Data flow**: It accepts thread id, turn id, item id, and optional approval id, converts ids to strings, fills `CommandExecutionRequestApprovalParams` with fixed reason/command/cwd values and `RequestId::Integer(1)`, wraps it in `ServerRequest::CommandExecutionRequestApproval`, and returns it.

**Call relations**: Used by tests that exercise request buffering, resolution, and rebase behavior for pending approvals.

*Call graph*: 3 external calls (Integer, test_path_buf, to_string).


##### `tests::thread_event_store_tracks_active_turn_lifecycle`  (lines 505–526)

```
fn thread_event_store_tracks_active_turn_lifecycle()
```

**Purpose**: Verifies that `push_notification` updates `active_turn_id` on turn start and clears it only when the matching turn completes. Unrelated completion notifications must not disturb the cached active turn.

**Data flow**: The test creates a new store, asserts no active turn, pushes a started notification for `turn-1`, then pushes completed notifications for `turn-2` and `turn-1` in sequence, checking `active_turn_id()` after each step. It mutates only the local store fixture.

**Call relations**: Run by the test harness, this test directly exercises the notification branches inside `ThreadEventStore::push_notification`.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, turn_completed_notification, turn_started_notification).


##### `tests::thread_event_store_restores_active_turn_from_snapshot_turns`  (lines 529–544)

```
fn thread_event_store_restores_active_turn_from_snapshot_turns()
```

**Purpose**: Checks that active-turn state can be reconstructed from snapshot turns, both during construction and later session installation. This ensures replayed threads still know which turn is in progress.

**Data flow**: It creates a session and two turns, one completed and one in progress, then builds one store with `new_with_session` and another blank store updated via `set_session`. Both stores are queried with `active_turn_id()` and compared to `Some("turn-2")`.

**Call relations**: This test validates the shared `set_turns` logic used by constructors and session refresh paths.

*Call graph*: calls 3 internal fn (new, new, new_with_session); 4 external calls (assert_eq!, test_path_buf, test_thread_session, vec!).


##### `tests::thread_event_store_clear_active_turn_id_resets_cached_turn`  (lines 547–555)

```
fn thread_event_store_clear_active_turn_id_resets_cached_turn()
```

**Purpose**: Confirms that the explicit cache-reset helper clears the remembered active turn even after a start notification has set it. This supports race recovery in higher-level routing code.

**Data flow**: It creates a store, pushes a started notification to set `active_turn_id`, calls `clear_active_turn_id`, and asserts that `active_turn_id()` returns `None`.

**Call relations**: The test is a focused unit check for the manual reset path used when server responses reveal stale local active-turn state.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_eq!, turn_started_notification).


##### `tests::thread_event_store_rebase_preserves_resolved_request_state`  (lines 558–579)

```
fn thread_event_store_rebase_preserves_resolved_request_state()
```

**Purpose**: Ensures that rebasing after session refresh does not resurrect a request that has already been resolved. The snapshot should be empty and pending approvals should be cleared.

**Data flow**: It creates a store, pushes an exec approval request and then a `ServerRequestResolved` notification for the same request id, calls `rebase_buffer_after_session_refresh`, takes a snapshot, and asserts that `snapshot.events` is empty and `has_pending_thread_approvals()` is false.

**Call relations**: This test covers the interaction between replay bookkeeping and refresh pruning, proving that resolved requests stay resolved across session refresh.

*Call graph*: calls 2 internal fn (new, new); 5 external calls (Integer, ServerRequestResolved, assert!, assert_eq!, exec_approval_request).


##### `tests::thread_event_store_rebase_preserves_hook_notifications`  (lines 582–610)

```
fn thread_event_store_rebase_preserves_hook_notifications()
```

**Purpose**: Verifies that hook lifecycle notifications survive session refresh rebasing exactly as buffered. This preserves user-visible hook activity across thread snapshot refreshes.

**Data flow**: It pushes started and completed hook notifications into a store, rebases the buffer, snapshots the store, converts the resulting notification events to JSON values, and compares them against the JSON serialization of the original fixtures.

**Call relations**: The test exercises `event_survives_session_refresh` through the hook-notification branch and confirms replay fidelity after pruning.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, hook_completed_notification, hook_started_notification).


##### `tests::thread_event_store_rebase_preserves_mcp_startup_notifications`  (lines 613–637)

```
fn thread_event_store_rebase_preserves_mcp_startup_notifications()
```

**Purpose**: Checks that MCP server startup status notifications are retained across session refresh. This keeps startup failures or status updates visible after a thread snapshot is refreshed.

**Data flow**: It constructs an `McpServerStatusUpdated` notification, pushes it into a new store, rebases the buffer, snapshots the store, extracts the sole buffered notification, and compares its JSON serialization to the original notification's serialization.

**Call relations**: This test covers another explicit survivor case in `event_survives_session_refresh`, ensuring MCP startup state is not lost during replay refresh.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (McpServerStatusUpdated, assert_eq!, panic!).


### `tui/src/app/thread_session_state.rs`

`domain_logic` · `thread attach, settings sync, and thread-read fallback`

This module is narrowly focused on session snapshots rather than event routing. Two sync methods update cached session state for the currently active thread after local settings change: `sync_active_thread_service_tier_to_cached_session` copies the chat widget's current service tier into both `primary_session_configured` and the active thread's `ThreadEventStore.session`, while `sync_active_thread_permission_settings_to_cached_session` copies approval policy, approvals reviewer, permission profile, and active permission profile from the current widget/config state into those same caches. Both methods intentionally touch only the active thread, leaving side-thread snapshots unchanged. The larger helper, `session_state_for_thread_read`, constructs a `ThreadSessionState` from a `codex_app_server_protocol::Thread` returned by `thread/read`. If a primary session snapshot already exists, it clones that as a template but clears thread-scoped settings like collaboration mode and personality when reading a different thread because `thread/read` does not include full thread settings. If no primary snapshot exists, it synthesizes a session from current widget/config defaults, the thread's cwd/path, and current permission settings. In both cases it then overwrites thread-specific fields such as id, name, provider, cwd retargeting, permission profile, rollout path, and message history. It also consults `read_session_model` to recover a persisted model name from the state DB, clearing the model when a rollout path exists but no model can be recovered.

#### Function details

##### `App::sync_active_thread_service_tier_to_cached_session`  (lines 11–33)

```
async fn sync_active_thread_service_tier_to_cached_session(&mut self)
```

**Purpose**: Copies the chat widget's current service-tier selection into cached session snapshots for the active thread. It updates both the primary-session cache and the active thread store when they refer to the same thread.

**Data flow**: It reads `self.active_thread_id`; if absent it returns. It captures `service_tier` from `chat_widget.current_service_tier().map(str::to_string)`, defines a closure that writes that value into a `ThreadSessionState`, applies it to `self.primary_session_configured` when the active thread is also the primary thread, then looks up the active thread channel, locks its store, and applies the same update to `store.session` if present.

**Call relations**: Called after local service-tier changes so future replay/resume paths see the updated tier in cached session state.


##### `App::sync_active_thread_permission_settings_to_cached_session`  (lines 35–72)

```
async fn sync_active_thread_permission_settings_to_cached_session(&mut self)
```

**Purpose**: Copies current approval and permission settings into cached session snapshots for the active thread. It intentionally avoids rewriting inactive side-thread snapshots.

**Data flow**: It returns early if there is no `active_thread_id`. Otherwise it derives `approval_policy` from `self.config.permissions.approval_policy`, reads `approvals_reviewer` from config, clones the current widget permission profile and active permission profile, defines a closure that writes those four fields into a `ThreadSessionState`, applies it to `primary_session_configured` when the active thread is primary, then locks the active thread's store and applies it to `store.session` if present.

**Call relations**: Used after permission-setting changes in the visible thread so cached snapshots remain consistent with what the user sees and what future turn starts should inherit.

*Call graph*: calls 1 internal fn (from).


##### `App::session_state_for_thread_read`  (lines 74–132)

```
async fn session_state_for_thread_read(
        &self,
        thread_id: ThreadId,
        thread: &Thread,
    ) -> ThreadSessionState
```

**Purpose**: Builds a `ThreadSessionState` from a `thread/read` response, using current widget settings and any existing primary-session snapshot as a template. It compensates for the fact that `thread/read` omits full thread settings.

**Data flow**: Inputs are a `thread_id` and borrowed `Thread`. It first captures the current permission profile and active permission profile via helper methods. If `primary_session_configured` exists, it clones that session and, when reading a different thread, clears `collaboration_mode` and `personality` so thread-scoped settings are not incorrectly inherited. If no primary session exists, it constructs a fresh `ThreadSessionState` from current widget/config values, the thread's cwd/path, workspace roots, and current reasoning/service-tier settings. It then overwrites thread-specific fields (`thread_id`, `thread_name`, `model_provider_id`, cwd retargeting, permission fields, empty `instruction_source_paths`, `rollout_path`, and `message_history = None`). Finally it awaits `read_session_model(self.state_db.as_deref(), thread_id, thread.path.as_deref())`; if a model is found it replaces `session.model`, otherwise if the thread has a path it clears the model string. The completed session is returned.

**Call relations**: Called by thread-read flows elsewhere in the app when a full session snapshot is unavailable. It bridges sparse backend thread metadata with richer local defaults and persisted model lookup.

*Call graph*: calls 4 internal fn (from, current_active_permission_profile, current_permission_profile, read_session_model); 1 external calls (new).


##### `App::current_permission_profile`  (lines 134–140)

```
fn current_permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the currently effective permission profile from the chat widget configuration. This reflects active UI state rather than potentially stale app defaults.

**Data flow**: It reads `self.chat_widget.config_ref().permissions.permission_profile()`, clones the `PermissionProfile`, and returns it.

**Call relations**: Used by `session_state_for_thread_read` so fallback session synthesis uses the visible thread's current permission settings.

*Call graph*: called by 1 (session_state_for_thread_read).


##### `App::current_active_permission_profile`  (lines 142–147)

```
fn current_active_permission_profile(&self) -> Option<ActivePermissionProfile>
```

**Purpose**: Returns the currently active named permission profile, if any, from the chat widget configuration. This is the active-profile counterpart to `current_permission_profile`.

**Data flow**: It reads `self.chat_widget.config_ref().permissions.active_permission_profile()` and returns the resulting `Option<ActivePermissionProfile>`.

**Call relations**: Used by `session_state_for_thread_read` when constructing fallback session state.

*Call graph*: called by 1 (session_state_for_thread_read).


##### `tests::test_thread_session`  (lines 173–196)

```
fn test_thread_session(thread_id: ThreadId, cwd: PathBuf) -> ThreadSessionState
```

**Purpose**: Creates a deterministic `ThreadSessionState` fixture for session-state tests. The fixture includes a persisted rollout path and runtime workspace roots rooted at the supplied cwd.

**Data flow**: It takes a `ThreadId` and `PathBuf`, constructs a `ThreadSessionState` with fixed model/provider values, `AskForApproval::Never`, `ApprovalsReviewer::User`, `PermissionProfile::read_only()`, absolute cwd, `runtime_workspace_roots = vec![cwd.abs()]`, empty instruction paths, and `rollout_path = Some(PathBuf::new())`, then returns it.

**Call relations**: Used throughout the module's tests to seed primary and side-thread session snapshots.

*Call graph*: calls 1 internal fn (read_only); 4 external calls (abs, new, new, vec!).


##### `tests::permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread`  (lines 199–287)

```
async fn permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread()
```

**Purpose**: Verifies that permission-setting sync updates the active main-thread caches but leaves side-thread snapshots untouched. This protects thread-local settings from being overwritten globally.

**Data flow**: The test builds a test app, creates distinct main and side thread ids and sessions, installs both into `thread_event_channels`, marks the side thread in `side_threads`, mutates app config and widget permission state to `OnRequest`/`AutoReview` plus an active workspace profile, calls `sync_active_thread_permission_settings_to_cached_session().await`, and then asserts that `primary_session_configured` and the main-thread store session were updated while the side-thread store session still equals the original side session.

**Call relations**: Run by Tokio, this test exercises the active-thread-only update policy of `sync_active_thread_permission_settings_to_cached_session`.

*Call graph*: calls 8 internal fn (new, allow_any, active, workspace_write, from_string, new, make_test_app, new_with_session); 4 external calls (new, assert_eq!, test_path_buf, test_thread_session).


##### `tests::permission_settings_sync_preserves_active_profile_only_rules`  (lines 290–353)

```
async fn permission_settings_sync_preserves_active_profile_only_rules()
```

**Purpose**: Checks that syncing permission settings preserves a managed permission profile that has no active-profile wrapper. Only approval policy should change in that case.

**Data flow**: It creates a test app and thread, installs a session whose `permission_profile` is a custom managed profile, updates config approval policy to `OnRequest`, calls `sync_active_thread_permission_settings_to_cached_session().await`, and asserts that both `primary_session_configured` and the thread store session now have `approval_policy = OnRequest` while retaining the original managed `permission_profile`.

**Call relations**: This test covers a subtle branch where the widget/config state should not invent an active profile or rewrite a custom managed profile.

*Call graph*: calls 4 internal fn (allow_any, from_string, make_test_app, new_with_session); 5 external calls (new, assert_eq!, test_path_buf, test_thread_session, vec!).


##### `tests::service_tier_sync_updates_active_cached_session`  (lines 356–397)

```
async fn service_tier_sync_updates_active_cached_session()
```

**Purpose**: Verifies that service-tier sync copies the widget's current service-tier value into both primary and store session caches for the active thread. Clearing the widget tier should clear the cached tier too.

**Data flow**: It creates a test app and thread, installs a session with `service_tier = Some(Fast)`, sets the widget service tier to `None`, calls `sync_active_thread_service_tier_to_cached_session().await`, and asserts that both `primary_session_configured` and the thread store session now equal an expected session with `service_tier = None`.

**Call relations**: This Tokio test directly exercises the service-tier cache synchronization path.

*Call graph*: calls 3 internal fn (from_string, make_test_app, new_with_session); 4 external calls (new, assert_eq!, test_path_buf, test_thread_session).


##### `tests::thread_read_fallback_uses_active_permission_settings`  (lines 400–453)

```
async fn thread_read_fallback_uses_active_permission_settings()
```

**Purpose**: Ensures that fallback session synthesis for `thread/read` uses the active widget permission settings rather than stale app-config defaults. This matters when the visible thread has already changed permissions locally.

**Data flow**: It creates a test app, installs a primary session with `workspace_write` permissions into both `primary_session_configured` and the chat widget, constructs a separate `Thread` value for a read target, awaits `session_state_for_thread_read(read_thread_id, &read_thread)`, and then asserts that the returned session's `permission_profile` equals the widget's current permission profile and differs from `app.config.permissions.permission_profile()`.

**Call relations**: This test validates the use of `current_permission_profile`/`current_active_permission_profile` inside `session_state_for_thread_read`.

*Call graph*: calls 3 internal fn (workspace_write, from_string, make_test_app); 5 external calls (new, assert_eq!, assert_ne!, test_path_buf, test_thread_session).


### `tui/src/app/loaded_threads.rs`

`domain_logic` · `thread switch/resume metadata reconstruction`

This module contains synchronous tree-walk logic with no I/O, intended to be reused when the TUI resumes an existing thread or switches among agents. The central type, `LoadedSubagentThread`, keeps only the metadata the UI needs later: `thread_id`, optional nickname, optional role, and optional `agent_path`. `find_loaded_subagent_threads_for_primary` first parses each server `Thread.id` into a `ThreadId`, skipping malformed IDs entirely, and stores the surviving `Thread` values in a `HashMap<ThreadId, Thread>`. It then performs a breadth/depth-style iterative walk starting from the supplied primary thread ID using a `pending` vector and an `included` set. For each candidate thread, it inspects `thread.source`; only `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, .. })` edges count, and only when that parent matches the currently popped thread. This means unrelated loaded threads and non-spawn sources are excluded, while multiple children of the same parent are all accepted.

After traversal, the function removes each included thread from the map and converts it into `LoadedSubagentThread`, preserving nickname and role from the thread object and deriving `agent_path` from the spawn source. Results are sorted by `thread_id.to_string()` purely for deterministic tests and cache stability. The included-set guard also prevents accidental revisits even though server-assigned UUID thread graphs are expected to be acyclic.

#### Function details

##### `find_loaded_subagent_threads_for_primary`  (lines 47–96)

```
fn find_loaded_subagent_threads_for_primary(
    threads: Vec<Thread>,
    primary_thread_id: ThreadId,
) -> Vec<LoadedSubagentThread>
```

**Purpose**: Finds every loaded subagent thread whose spawn-parent chain leads back to the given primary thread. It excludes the primary thread itself and returns a deterministic, sorted list of lightweight metadata records.

**Data flow**: Consumes a `Vec<Thread>` and a `primary_thread_id`. It parses each `thread.id` with `ThreadId::from_string`, builds a `HashMap<ThreadId, Thread>` for valid IDs, walks parent-child relationships using `thread_spawn_parent_thread_id`, accumulates discovered descendants in a `HashSet`, then transforms those IDs into `LoadedSubagentThread` values by removing the original `Thread` from the map and copying `agent_nickname`, `agent_role`, and `thread_spawn_agent_path(&thread.source)`. Finally it sorts by stringified thread ID and returns the vector.

**Call relations**: Used by callers that need to reconstruct subagent navigation state from a flat loaded-thread response; in this file it is exercised by the unit test. It delegates source inspection to `thread_spawn_parent_thread_id` during traversal and to `thread_spawn_agent_path` during final record construction.

*Call graph*: calls 2 internal fn (from_string, thread_spawn_parent_thread_id); called by 1 (finds_loaded_subagent_tree_for_primary_thread); 3 external calls (new, new, vec!).


##### `thread_spawn_agent_path`  (lines 98–105)

```
fn thread_spawn_agent_path(source: &SessionSource) -> Option<String>
```

**Purpose**: Extracts the optional `agent_path` from a thread source when that source is a subagent thread-spawn record. Non-spawn sources yield no path.

**Data flow**: Reads a borrowed `SessionSource`, pattern-matches `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_path, .. })`, clones and converts the optional path string when present, and returns `Option<String>`. It mutates nothing.

**Call relations**: Called during final assembly of `LoadedSubagentThread` values so the navigation cache can retain spawn-path metadata. It is a narrow extractor used only after a thread has already been identified as relevant.


##### `thread_spawn_parent_thread_id`  (lines 107–114)

```
fn thread_spawn_parent_thread_id(source: &SessionSource) -> Option<ThreadId>
```

**Purpose**: Extracts the parent thread ID from a subagent thread-spawn source. It is the predicate helper that defines the traversal edges for descendant discovery.

**Data flow**: Accepts a borrowed `SessionSource`, returns `Some(parent_thread_id)` only for `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, .. })`, and otherwise returns `None`. No state is modified.

**Call relations**: Called repeatedly by `find_loaded_subagent_threads_for_primary` while scanning the loaded-thread map. It isolates the source-pattern matching that determines whether a thread participates in the spawn tree.

*Call graph*: called by 1 (find_loaded_subagent_threads_for_primary).


##### `tests::test_thread`  (lines 128–151)

```
fn test_thread(thread_id: ThreadId, source: SessionSource) -> Thread
```

**Purpose**: Constructs a minimal `codex_app_server_protocol::Thread` fixture with predictable defaults for descendant-walk tests. It lets each test vary only the thread ID and source.

**Data flow**: Takes a `ThreadId` and `SessionSource`, converts the ID to strings for both `id` and `session_id`, fills the remaining `Thread` fields with fixed placeholder values such as `/tmp` cwd, idle status, empty preview, and empty turns, and returns the assembled `Thread`. It writes no external state.

**Call relations**: Used by the unit test to build primary, child, grandchild, and unrelated thread fixtures. It keeps the test focused on source relationships rather than verbose protocol construction.

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

**Purpose**: Builds a `SessionSource` representing a subagent thread spawn from JSON. It provides concise test setup for parent-child relationships and embedded agent metadata.

**Data flow**: Accepts a parent `ThreadId`, numeric depth, nickname, and role; creates a JSON value with those fields under `subAgent.thread_spawn`; deserializes it with `serde_json::from_value`; and returns the resulting `SessionSource`. It panics in tests if the JSON shape is invalid.

**Call relations**: Called by the descendant-walk test to create child and grandchild spawn sources. It abstracts away the protocol enum construction details.

*Call graph*: 2 external calls (from_value, json!).


##### `tests::finds_loaded_subagent_tree_for_primary_thread`  (lines 173–231)

```
fn finds_loaded_subagent_tree_for_primary_thread()
```

**Purpose**: Verifies that the tree walk includes descendants of the primary thread, excludes unrelated spawn trees, and preserves nickname/role metadata. It also checks the deterministic output ordering.

**Data flow**: Creates fixed UUID-like `ThreadId` values, builds a primary thread plus child, grandchild, and unrelated child fixtures using `test_thread` and `thread_spawn_source`, mutates child/grandchild nickname and role fields, calls `find_loaded_subagent_threads_for_primary`, and compares the returned vector against the expected `LoadedSubagentThread` list with `assert_eq!`. All mutations are confined to local test fixtures.

**Call relations**: Run by the test harness as the main specification for this module. It drives the production traversal function with a representative mixed thread set.

*Call graph*: calls 2 internal fn (from_string, find_loaded_subagent_threads_for_primary); 4 external calls (assert_eq!, test_thread, thread_spawn_source, vec!).


### `tui/src/app/session_lifecycle.rs`

`orchestration` · `startup, resume/fork flows, agent picker interaction, and thread switching`

This module is the app-level session and thread transition coordinator. It bridges `App`, `ChatWidget`, local replay channels, and `AppServerSession` RPCs so the UI can move between fresh sessions, resumed sessions, forked threads, and subagent threads without losing cached metadata or replay state. A recurring pattern is that thread metadata lives in `agent_navigation`, while replay/live event state lives in `thread_event_channels`; many functions update both and then call `sync_active_agent_label()` so footer labels stay aligned with picker rows.

`open_agent_picker` is the main discovery path. It backfills loaded subagent threads from the server, refreshes liveness either from local live channels or `thread/read`, and then either shows a status history cell for path-backed running threads or builds a `SelectionView` of all known threads. Error classification helpers distinguish terminal `thread/read` failures (`thread not loaded:`) from transient transport failures, and detect when `includeTurns` can safely fall back to a metadata-only read.

Selection is careful about replay-only versus live attachment. `attach_live_thread_for_selection` first tries `resume_thread`; if that fails it falls back to `thread/read`, but refuses to create a blank replay-only channel with no turns because that would block later real attachment. `select_agent_thread` then stores the current receiver, activates the target channel, refreshes snapshot session data if needed, replaces the `ChatWidget`, resets transcript/terminal state, replays the snapshot, and surfaces replay-only informational messages.

The file also resets all thread-event state when replacing the primary thread, handles startup thread creation races, backfills subagent descendants after resume/fork/new-thread flows, and rebuilds resume configuration including cwd resolution and runtime policy overrides before calling `resume_thread`.

#### Function details

##### `App::open_agent_picker`  (lines 10–138)

```
async fn open_agent_picker(&mut self, app_server: &mut AppServerSession)
```

**Purpose**: Builds and opens the subagent picker or, for path-backed running subagents, emits a status history cell summarizing their live previews. It refreshes cached thread liveness before presenting anything.

**Data flow**: Mutates `self.agent_navigation` and `self.chat_widget` after awaiting `backfill_loaded_subagent_threads`. It gathers path-backed thread ids, checks local `thread_event_channels` for live attachments and active turns, otherwise refreshes liveness from the app server. If path-backed running threads exist, it builds `AgentStatusThreadPreview` entries from channel stores or empty placeholders and inserts an `AgentStatusHistoryCell`. Otherwise it refreshes all tracked threads, may open a multi-agent enable prompt, may emit an info message if no agents exist, or constructs `SelectionItem` values and passes them to `show_selection_view`.

**Call relations**: Invoked when the user opens the agent picker. It delegates to backfill and liveness refresh helpers, then either short-circuits into a status-feed history insertion or drives the generic selection popup flow.

*Call graph*: calls 6 internal fn (picker_subtitle, new, empty, from_store, backfill_loaded_subagent_threads, refresh_agent_picker_thread_liveness); 2 external calls (default, new).


##### `App::is_terminal_thread_read_error`  (lines 140–143)

```
fn is_terminal_thread_read_error(err: &color_eyre::Report) -> bool
```

**Purpose**: Classifies a `thread/read` failure as terminal when any error cause contains `thread not loaded:`. This distinguishes permanently unavailable threads from transient transport problems.

**Data flow**: Iterates over `err.chain()`, converts each cause to string, and returns `true` if any cause contains the marker substring; otherwise returns `false`.

**Call relations**: Used by liveness refresh and closed-state derivation to decide whether a missing thread should be pruned or marked closed rather than retried as a transient failure.

*Call graph*: 1 external calls (chain).


##### `App::closed_state_for_thread_read_error`  (lines 145–150)

```
fn closed_state_for_thread_read_error(
        err: &color_eyre::Report,
        existing_is_closed: Option<bool>,
    ) -> bool
```

**Purpose**: Computes whether a thread should be considered closed after a `thread/read` error. Terminal read errors force closed state; otherwise any existing cached closed state is preserved.

**Data flow**: Takes an error report and `existing_is_closed: Option<bool>`, calls `is_terminal_thread_read_error`, and returns that result OR `existing_is_closed.unwrap_or(false)`.

**Call relations**: Called from `refresh_agent_picker_thread_liveness` when a read fails. It lets the caller preserve prior closed state across transient failures while still marking terminal failures closed.

*Call graph*: 1 external calls (is_terminal_thread_read_error).


##### `App::can_fallback_from_include_turns_error`  (lines 152–158)

```
fn can_fallback_from_include_turns_error(err: &color_eyre::Report) -> bool
```

**Purpose**: Detects `thread/read(include_turns=true)` failures that are expected for unmaterialized or ephemeral threads and can safely fall back to a metadata-only read. It matches specific server error text.

**Data flow**: Walks `err.chain()`, stringifies each cause, and returns `true` if any cause mentions either `includeTurns is unavailable before first user message` or `ephemeral threads do not support includeTurns`.

**Call relations**: Used only by `attach_live_thread_for_selection` after `resume_thread` fails and a replay snapshot must be synthesized from `thread/read` responses.

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

**Purpose**: Writes thread nickname/role/closed-state metadata into both the `ChatWidget` and `AgentNavigationState`, then refreshes the active-agent footer label. This keeps visible picker rows and contextual labels in sync.

**Data flow**: Accepts `thread_id`, optional nickname and role strings, and `is_closed`. It calls `self.chat_widget.set_collab_agent_metadata` with cloned nickname/role, updates `self.agent_navigation.upsert`, and then calls `self.sync_active_agent_label()`. No value is returned.

**Call relations**: Used by server-driven metadata refresh paths such as loaded-thread backfill and liveness refresh. It is the paired write helper that prevents widget metadata and navigation cache from diverging.

*Call graph*: called by 2 (backfill_loaded_subagent_threads, refresh_agent_picker_thread_liveness).


##### `App::mark_agent_picker_thread_closed`  (lines 185–188)

```
fn mark_agent_picker_thread_closed(&mut self, thread_id: ThreadId)
```

**Purpose**: Marks a cached picker thread as closed without removing it, then recomputes the active-agent label. Closed threads remain navigable for transcript inspection.

**Data flow**: Mutates `self.agent_navigation` via `mark_closed(thread_id)` and then calls `self.sync_active_agent_label()`. Returns no value.

**Call relations**: Used by other app logic when a thread closure is observed. Unlike removal, this preserves stable traversal order and replay access.


##### `App::refresh_agent_picker_thread_liveness`  (lines 190–254)

```
async fn refresh_agent_picker_thread_liveness(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> bool
```

**Purpose**: Refreshes one thread’s picker metadata and running/closed state from `thread/read`, while preserving cached nickname/role when the server omits them. It also prunes metadata-only threads that are terminally unavailable and have no replay channel.

**Data flow**: Reads any existing navigation entry and whether a replay channel exists. It awaits `app_server.thread_read(thread_id, false)`. On success it derives `is_running` from `ThreadStatus::Active` and `is_closed` from `ThreadStatus::NotLoaded`, upserts metadata using server values or cached fallbacks, sets running state, and returns `true`. On error it either removes the thread and returns `false` for terminal metadata-only misses, or computes closed state with `closed_state_for_thread_read_error`, upserts cached-or-empty metadata, sets running false, and returns `true`.

**Call relations**: Called while opening the picker and before selecting a thread. It is the main metadata reconciliation step between local caches and app-server truth.

*Call graph*: calls 2 internal fn (upsert_agent_picker_thread, thread_read); called by 2 (open_agent_picker, select_agent_thread); 3 external calls (closed_state_for_thread_read_error, is_terminal_thread_read_error, matches!).


##### `App::attach_live_thread_for_selection`  (lines 262–319)

```
async fn attach_live_thread_for_selection(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> Result<bool>
```

**Purpose**: Materializes a selectable thread into local replay state, preferring a live `resume_thread` attachment and falling back to `thread/read` replay-only hydration when necessary. It refuses to create empty replay-only channels that would later block real attachment.

**Data flow**: Given `thread_id`, it first returns `Ok(true)` if a channel already exists. Otherwise it awaits `app_server.resume_thread(self.config.clone(), thread_id)`. On success it extracts session and turns and marks the attachment live. On failure it logs a warning, tries `thread_read(thread_id, true)`, optionally falls back to `thread_read(thread_id, false)` when `can_fallback_from_include_turns_error` matches, and errors if no turns are available. For replay-only fallback it builds session state via `self.session_state_for_thread_read`, clears `session.model`, ensures a thread channel, marks it replay-only if needed, stores the session and turns into the channel store, and returns whether live attachment succeeded.

**Call relations**: Called from `select_agent_thread` only when the target lacks a local channel and is not known closed. It bridges picker metadata into actual local replay/live state before the switch proceeds.

*Call graph*: calls 2 internal fn (resume_thread, thread_read); called by 1 (select_agent_thread); 4 external calls (can_fallback_from_include_turns_error, new, eyre!, warn!).


##### `App::replace_chat_widget`  (lines 327–346)

```
fn replace_chat_widget(&mut self, mut chat_widget: ChatWidget)
```

**Purpose**: Swaps in a new `ChatWidget` while preserving terminal-title state, remote connection info, and all cached collab-agent metadata from navigation state. This prevents flicker and ensures replayed collab items still render named agents immediately.

**Data flow**: Takes ownership of a replacement `ChatWidget`. It moves `last_terminal_title` from the old widget if the new one lacks one, clones `remote_connection`, iterates `self.agent_navigation.ordered_threads()` to reseed `set_collab_agent_metadata`, assigns `self.chat_widget = chat_widget`, and calls `sync_active_agent_label()`.

**Call relations**: Used after creating a fresh widget for resumed/forked/selected threads. It is the safe replacement helper that preserves UI metadata otherwise lost when reconstructing the widget.

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

**Purpose**: Switches the active UI to another thread, attaching it live or replay-only if needed, replacing the chat widget, resetting terminal/transcript state, replaying the thread snapshot, and surfacing replay-only notices. It also restores the previous thread if activation fails mid-switch.

**Data flow**: Accepts `tui`, `app_server`, and `thread_id`. It returns early if already active. It refreshes liveness; on failure it emits an error message. It derives replay-only state from navigation metadata, optionally calls `attach_live_thread_for_selection`, stores the current receiver, clears `self.active_thread_id`, activates the target channel for replay, refreshes snapshot session if needed, sets `active_thread_id` and `active_thread_rx`, constructs a new `ChatWidget` via `chatwidget_init_for_forked_or_resumed_thread`, replaces the widget, calls `reset_for_thread_switch`, replays the snapshot, emits replay-only info messages when applicable, drains active thread events, refreshes pending approvals, and returns `Result<()>`.

**Call relations**: Triggered by picker selection and side-thread return/switch flows. It orchestrates many helpers: liveness refresh, optional attachment, widget replacement, terminal clearing, snapshot replay, and post-switch event draining.

*Call graph*: calls 5 internal fn (attach_live_thread_for_selection, refresh_agent_picker_thread_liveness, replace_chat_widget, reset_for_thread_switch, should_attach_live_thread_for_selection); 2 external calls (format!, new_with_app_event).


##### `App::should_attach_live_thread_for_selection`  (lines 445–451)

```
fn should_attach_live_thread_for_selection(&self, thread_id: ThreadId) -> bool
```

**Purpose**: Decides whether selecting a thread should first try to attach or hydrate a local channel. Closed metadata-only threads are excluded.

**Data flow**: Reads `self.thread_event_channels` and `self.agent_navigation`. It returns `true` only when no local channel exists and the navigation entry is absent or not marked closed.

**Call relations**: Used inside `select_agent_thread` to gate the expensive attach/hydrate path. It prevents futile attachment attempts for known-closed metadata-only threads.

*Call graph*: called by 1 (select_agent_thread).


##### `App::reset_for_thread_switch`  (lines 453–458)

```
fn reset_for_thread_switch(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Clears transcript/UI state and terminal scrollback before replaying a newly selected thread. This ensures the replacement widget starts from a clean visual surface.

**Data flow**: Calls `self.reset_transcript_state_after_clear()`, `tui.clear_pending_history_lines()`, and `Self::clear_terminal_for_thread_switch(&mut tui.terminal)`, returning `Result<()>` from the terminal clear.

**Call relations**: Called during `select_agent_thread` after the new widget is installed but before replaying the target snapshot. It is the thread-switch-specific reset step.

*Call graph*: called by 1 (select_agent_thread); 2 external calls (clear_terminal_for_thread_switch, clear_pending_history_lines).


##### `App::clear_terminal_for_thread_switch`  (lines 460–473)

```
fn clear_terminal_for_thread_switch(
        terminal: &mut crate::custom_terminal::Terminal<B>,
    ) -> Result<()>
```

**Purpose**: Clears scrollback and visible screen for a thread switch and resets the viewport origin to the top. Unlike resize replay, it always uses the normal-screen ANSI clear path.

**Data flow**: Mutates the provided `crate::custom_terminal::Terminal<B>` by calling `clear_scrollback_and_visible_screen_ansi()`, then normalizes `viewport_area.y` to `0` and writes it back with `set_viewport_area`. Returns `Result<()>`.

**Call relations**: Used only by `reset_for_thread_switch`. It is the low-level terminal cleanup primitive for switching between threads.

*Call graph*: calls 2 internal fn (clear_scrollback_and_visible_screen_ansi, set_viewport_area).


##### `App::reset_thread_event_state`  (lines 475–490)

```
fn reset_thread_event_state(&mut self)
```

**Purpose**: Drops all thread-local replay/listener/navigation state so a new primary thread can be attached cleanly. It also clears pending startup/request bookkeeping and resets approval badges.

**Data flow**: Aborts all thread event listeners, clears `thread_event_channels`, `agent_navigation`, `side_threads`, pending event/request collections, startup flags, and primary-thread identifiers, resets `active_thread_id`/`active_thread_rx`, clears pending approvals in the widget, and syncs the active-agent label. Returns no value.

**Call relations**: Called before attaching a fresh primary thread in `replace_chat_widget_with_app_server_thread`. It is the hard reset for thread-scoped app state.

*Call graph*: called by 1 (replace_chat_widget_with_app_server_thread); 1 external calls (new).


##### `App::handle_startup_thread_started`  (lines 492–527)

```
async fn handle_startup_thread_started(
        &mut self,
        app_server: &mut AppServerSession,
        result: Result<AppServerStartedThread, String>,
    ) -> Result<()>
```

**Purpose**: Handles completion of an asynchronous startup thread creation request, either discarding stale results or attaching the newly started primary thread. It also unblocks queued submissions once startup configuration is resolved.

**Data flow**: Takes an `AppServerStartedThread` result wrapped in `Result<_, String>`. If `self.pending_startup_thread_start` is false, successful stale results are unsubscribed and their local state discarded. Otherwise it clears the pending flag, disables queued-submission blocking in the widget, and on success enqueues the primary thread session then triggers `maybe_send_next_queued_input`; on failure it returns an eyre error.

**Call relations**: Used in startup orchestration when thread creation may complete after the app has moved on. It distinguishes stale completions from the currently awaited startup thread.

*Call graph*: calls 1 internal fn (thread_unsubscribe); 2 external calls (eyre!, warn!).


##### `App::start_fresh_session_with_summary_hint`  (lines 529–595)

```
async fn start_fresh_session_with_summary_hint(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        session_start_source: Option<ThreadStartSource>,
```

**Purpose**: Starts a brand-new app-server thread using refreshed in-memory config, replaces the current session, and appends a summary/resume hint for the previous session when available. It preserves resumability by relying on persisted rollout history rather than keeping the old in-memory thread alive.

**Data flow**: Refreshes config from disk, captures current model and a `session_summary`, shuts down the current thread, unsubscribes all tracked threads, computes `fresh_session_config`, assigns it to `self.config`, and awaits `app_server.start_thread_with_session_start_source`. On success it calls `replace_chat_widget_with_app_server_thread`; if that succeeds and a summary exists, it builds `Line<'static>` values for usage and resume hint and appends them to history. On failure it emits an error and restores `self.config.model`. It always schedules a frame at the end.

**Call relations**: Invoked when the user starts a new conversation. It orchestrates config refresh, old-thread shutdown, new-thread startup, widget replacement, and post-switch summary messaging.

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

**Purpose**: Attaches a newly started or resumed primary app-server thread by resetting thread state, constructing a fresh `ChatWidget`, enqueuing the primary session, and backfilling subagent metadata. It is shared by fresh-session and resume flows.

**Data flow**: Resets thread event state, builds widget init via `chatwidget_init_for_forked_or_resumed_thread`, replaces the widget with `ChatWidget::new_with_app_event(init)`, awaits `enqueue_primary_thread_session(started.session, started.turns)`, then awaits `backfill_loaded_subagent_threads(app_server)`. Returns `Result<()>`.

**Call relations**: Called from both `start_fresh_session_with_summary_hint` and `resume_target_session`. It is the common attach-and-seed helper for a new primary thread.

*Call graph*: calls 3 internal fn (backfill_loaded_subagent_threads, replace_chat_widget, reset_thread_event_state); called by 2 (resume_target_session, start_fresh_session_with_summary_hint); 1 external calls (new_with_app_event).


##### `App::backfill_loaded_subagent_threads`  (lines 631–691)

```
async fn backfill_loaded_subagent_threads(
        &mut self,
        app_server: &mut AppServerSession,
    ) -> bool
```

**Purpose**: Discovers already-loaded descendant threads of the primary thread from the app server and seeds them into navigation and widget metadata. This pre-populates `/agent` navigation even when the TUI did not witness the original spawn events.

**Data flow**: If `self.primary_thread_id` is absent it returns `false`. Otherwise it calls `thread_loaded_list` with no pagination, parses each returned id with `ThreadId::from_string`, skips the primary thread, and reads each remaining thread via `thread_read(..., false)`, tracking whether any reads fail. It then filters the loaded threads through `find_loaded_subagent_threads_for_primary`, upserts each discovered subagent’s nickname/role as open, records its `agent_path`, syncs the active-agent label, and returns `!had_read_error`.

**Call relations**: Used after attaching a primary thread, when opening the picker, and as an on-demand fallback for adjacent-thread navigation. It is the server backfill path for subagent discovery.

*Call graph*: calls 4 internal fn (from_string, upsert_agent_picker_thread, thread_loaded_list, thread_read); called by 3 (adjacent_thread_id_with_backfill, open_agent_picker, replace_chat_widget_with_app_server_thread); 2 external calls (new, warn!).


##### `App::adjacent_thread_id_with_backfill`  (lines 701–724)

```
async fn adjacent_thread_id_with_backfill(
        &mut self,
        app_server: &mut AppServerSession,
        direction: AgentNavigationDirection,
    ) -> Option<ThreadId>
```

**Purpose**: Finds the next or previous thread for keyboard navigation, retrying after a one-time server backfill if the local cache has no adjacent entry. This makes the first navigation keypress in a resumed session discover remote subagents lazily.

**Data flow**: Reads the current displayed thread id and asks `self.agent_navigation.adjacent_thread_id`. If found, returns it. Otherwise it requires `self.primary_thread_id`, checks `self.last_subagent_backfill_attempt` to avoid repeated fetches, awaits `backfill_loaded_subagent_threads`, records the attempted primary id on success, and retries `adjacent_thread_id` from the refreshed cache.

**Call relations**: Called by keyboard navigation logic outside this file. It wraps the fast local-cache path with a single server-discovery retry.

*Call graph*: calls 1 internal fn (backfill_loaded_subagent_threads).


##### `App::fresh_session_config`  (lines 726–730)

```
fn fresh_session_config(&self) -> Config
```

**Purpose**: Builds the config for a fresh session by cloning the current app config and replacing `service_tier` with the chat widget’s currently configured tier. This preserves runtime tier selection across new-thread creation.

**Data flow**: Clones `self.config` into a mutable `Config`, assigns `config.service_tier = self.chat_widget.configured_service_tier()`, and returns the updated config.

**Call relations**: Used by fresh-session startup. It is intentionally small so new-thread creation inherits current runtime tier choices without mutating unrelated config.

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

**Purpose**: Resumes a saved session into the TUI, resolving cwd differences, rebuilding config, applying runtime policy overrides, replacing the current primary thread, and appending a summary/resume hint for the previous session. It also handles user-exit outcomes from cwd prompting.

**Data flow**: Given `target_session`, it first checks `ignore_same_thread_resume`; if true it schedules a frame and returns `Continue`. It computes `resume_cwd`, either reusing current cwd for remote workspaces or awaiting `resolve_cwd_for_resume_or_fork`, which may return `Continue(Some/None)` or `Exit`. It rebuilds config via `rebuild_config_for_resume_or_fallback`, applies runtime policy overrides, captures a `session_summary`, and awaits `app_server.resume_thread(resume_config.clone(), target_session.thread_id)`. On success it shuts down the current thread, installs the resumed config, updates notification settings and file-search root, calls `replace_chat_widget_with_app_server_thread`, appends summary lines if any, and maybe prompts about a paused goal. On failure at any stage it emits an error message and returns `AppRunControl::Continue` or `Exit` as appropriate.

**Call relations**: Used during startup/bootstrap and explicit resume actions. It is the top-level resume orchestrator that ties together cwd resolution, config reconstruction, app-server resume, widget replacement, and post-resume prompts.

*Call graph*: calls 4 internal fn (replace_chat_widget_with_app_server_thread, resume_thread, display_label, resolve_cwd_for_resume_or_fork); 6 external calls (new, frame_requester, set_notification_settings, format!, Exit, vec!).


##### `tests::terminal_thread_read_error_detection_matches_not_loaded_errors`  (lines 848–854)

```
fn terminal_thread_read_error_detection_matches_not_loaded_errors()
```

**Purpose**: Verifies that `is_terminal_thread_read_error` recognizes a `thread not loaded:` failure as terminal. The test encodes the exact error text shape expected from the app server.

**Data flow**: Constructs an eyre error with a `thread/read failed: thread not loaded:` message, passes it to `App::is_terminal_thread_read_error`, and asserts the result is true.

**Call relations**: This unit test exercises the terminal-error classifier used by picker liveness refresh and metadata pruning.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::terminal_thread_read_error_detection_ignores_transient_failures`  (lines 857–863)

```
fn terminal_thread_read_error_detection_ignores_transient_failures()
```

**Purpose**: Checks that transport-style `thread/read` failures are not misclassified as terminal. This protects replay metadata from being pruned on transient errors.

**Data flow**: Builds an eyre error containing `broken pipe`, calls `App::is_terminal_thread_read_error`, and asserts the result is false.

**Call relations**: Covers the negative branch of the terminal-error classifier used by liveness refresh.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::closed_state_for_thread_read_error_preserves_live_state_without_cache_on_transient_error`  (lines 866–874)

```
fn closed_state_for_thread_read_error_preserves_live_state_without_cache_on_transient_error()
```

**Purpose**: Ensures transient read failures do not force an uncached thread into closed state. The absence of cached closed state should remain interpreted as open/unknown.

**Data flow**: Creates a transient transport error, calls `App::closed_state_for_thread_read_error` with `existing_is_closed: None`, and asserts the result is false.

**Call relations**: Tests the helper that derives closed state after failed `thread/read` calls.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::closed_state_for_thread_read_error_marks_terminal_uncached_threads_closed`  (lines 877–885)

```
fn closed_state_for_thread_read_error_marks_terminal_uncached_threads_closed()
```

**Purpose**: Ensures terminal `thread not loaded` failures mark uncached threads closed. This is the behavior used when metadata exists but no replay channel does.

**Data flow**: Creates a terminal read error, calls `App::closed_state_for_thread_read_error` with no cached state, and asserts the result is true.

**Call relations**: Complements the transient-error test for the closed-state helper.

*Call graph*: 2 external calls (assert!, eyre!).


##### `tests::include_turns_fallback_detection_handles_unmaterialized_and_ephemeral_threads`  (lines 888–898)

```
fn include_turns_fallback_detection_handles_unmaterialized_and_ephemeral_threads()
```

**Purpose**: Verifies that the include-turns fallback detector recognizes both unmaterialized-thread and ephemeral-thread server messages. These are the only cases where replay hydration should retry without turns.

**Data flow**: Constructs two eyre errors with the expected server text, passes each to `App::can_fallback_from_include_turns_error`, and asserts both return true.

**Call relations**: Tests the fallback classifier used by `attach_live_thread_for_selection` after `resume_thread` failure.

*Call graph*: 2 external calls (assert!, eyre!).


### `tui/src/chatwidget/session_flow.rs`

`orchestration` · `session load / thread switch / session reconfiguration`

This file centralizes the heavy-weight session reconfiguration path for `ChatWidget`. The core method consumes a `ThreadSessionState` and rewrites nearly every session-scoped field: transcript copy state, bottom-pane history metadata, thread id/name, fork ancestry, rollout path, cwd, workspace roots, permission settings, service tier, reviewer/personality, collaboration mode, and status caches. It also resets per-thread transient state such as turn lifecycle, goal indicators, and recent auto-review denials when the thread actually changes.

A notable design choice is its two-stage permission synchronization. Approval policy and permission profiles are first applied through constrained setters; if those reject the incoming session snapshot, the code logs warnings and falls back to replacement APIs so the UI still converges on server truth. Collaboration mode is similarly split: if the session provides an explicit mode, that becomes the effective mask; otherwise the widget synthesizes an initial mask from config/model catalog and injects the session’s reasoning effort.

Display mode controls whether a session-info history cell is inserted, suppressed, or removed. After state sync, the method refreshes model/status surfaces, plugin mentions, skills for the current cwd, optional connector prefetch, and any queued initial user message. For normal displays on forked threads, it emits a dedicated history event describing the parent thread before optionally requesting a redraw.

#### Function details

##### `ChatWidget::on_session_configured_with_display_and_fork_parent_title`  (lines 6–147)

```
fn on_session_configured_with_display_and_fork_parent_title(
        &mut self,
        session: ThreadSessionState,
        display: SessionConfiguredDisplay,
        fork_parent_title: Option<String
```

**Purpose**: Consumes a full `ThreadSessionState` snapshot and mutates the widget into that session’s runtime/UI state, including permissions, collaboration mode, cwd/workspace roots, header cells, and redraw behavior. It also emits a fork-origin history event for normal session displays when the thread was forked.

**Data flow**: Inputs are the incoming `session`, a `SessionConfiguredDisplay` mode, and an optional `fork_parent_title`. It reads existing widget state such as `thread_id`, startup tooltip override, model catalog, config, transcript active cell, and redraw suppression flags; then resets transcript/bottom-pane/session-scoped fields, copies values from `session` into `self` and `self.config`, derives a `PermissionProfileSnapshot` via `from_session_snapshot`, computes or applies collaboration masks, builds a session header cell with `history_cell::new_session_info` when appropriate, refreshes dependent UI surfaces and skills/connectors, may enqueue a fork event, and finally requests redraw unless suppressed. It returns no value; its outputs are mutated widget state, history cells, app events, logs, and possible redraw requests.

**Call relations**: This is the shared implementation behind the three public session handlers. Those wrappers choose whether the session should be shown as a normal header, a quiet update, or a side-conversation session. Inside, it delegates to `ChatWidget::set_skills` to clear mentionable skills, `PermissionProfileSnapshot::from_session_snapshot` and constrained permission setters to sync security state, `ChatWidget::initial_collaboration_mask` when no explicit collaboration mode arrives, `history_cell::new_session_info` to render the visible session header, and `ChatWidget::emit_forked_thread_event` only for normal forked sessions.

*Call graph*: calls 4 internal fn (allow_only, from_session_snapshot, emit_forked_thread_event, set_skills); called by 3 (handle_side_thread_session, handle_thread_session, handle_thread_session_quiet); 5 external calls (initial_collaboration_mask, new_session_info, error!, warn!, default).


##### `ChatWidget::handle_thread_session`  (lines 149–157)

```
fn handle_thread_session(&mut self, session: ThreadSessionState)
```

**Purpose**: Handles a standard session-configuration event for the active thread and shows the normal session header/history presentation. It also preserves instruction source paths from the incoming snapshot.

**Data flow**: It takes a `ThreadSessionState`, copies `instruction_source_paths` into widget state, extracts `fork_parent_title`, and forwards the full session plus `SessionConfiguredDisplay::Normal` into the shared configurator. It returns nothing and writes only widget state through that delegated path.

**Call relations**: This is one of the entry wrappers that invoke `ChatWidget::on_session_configured_with_display_and_fork_parent_title`. It is used when the app wants the full visible session-configured behavior, including possible session info cell insertion and fork event emission.

*Call graph*: calls 1 internal fn (on_session_configured_with_display_and_fork_parent_title).


##### `ChatWidget::handle_thread_session_quiet`  (lines 159–166)

```
fn handle_thread_session_quiet(&mut self, session: ThreadSessionState)
```

**Purpose**: Applies a session snapshot without showing the normal session header/fork-origin presentation. It is the silent variant of session synchronization.

**Data flow**: It accepts a `ThreadSessionState`, copies `instruction_source_paths`, and forwards the session to the shared configurator with `SessionConfiguredDisplay::Quiet` and no fork-parent title. It returns nothing; all state changes happen in the delegated configurator.

**Call relations**: This wrapper exists so callers can reuse the full session-sync logic while suppressing normal header display behavior. It delegates entirely to `ChatWidget::on_session_configured_with_display_and_fork_parent_title` with the quiet display mode.

*Call graph*: calls 1 internal fn (on_session_configured_with_display_and_fork_parent_title).


##### `ChatWidget::handle_side_thread_session`  (lines 168–176)

```
fn handle_side_thread_session(&mut self, session: ThreadSessionState)
```

**Purpose**: Applies a session snapshot for a side conversation, preserving side-specific display semantics while still reusing the main session-sync logic. It carries through the fork parent title if present.

**Data flow**: It takes a `ThreadSessionState`, stores `instruction_source_paths`, clones `fork_parent_title`, and calls the shared configurator with `SessionConfiguredDisplay::SideConversation`. It returns no value and mutates widget state through the delegated path.

**Call relations**: This is the side-thread counterpart to the normal and quiet handlers. It invokes `ChatWidget::on_session_configured_with_display_and_fork_parent_title` so side conversations get the same state synchronization but a different display mode.

*Call graph*: calls 1 internal fn (on_session_configured_with_display_and_fork_parent_title).


##### `ChatWidget::emit_forked_thread_event`  (lines 178–207)

```
fn emit_forked_thread_event(
        &mut self,
        forked_from_id: ThreadId,
        fork_parent_title: Option<String>,
    )
```

**Purpose**: Builds and emits a plain history cell announcing that the current thread was forked from another thread. If a non-empty parent title is available, it includes both the title and thread id.

**Data flow**: Inputs are `forked_from_id` and optional `fork_parent_title`. It converts the thread id to text, chooses one of two `Line<'static>` layouts depending on whether the title is present and non-blank, wraps that line in a `PlainHistoryCell`, and sends `AppEvent::InsertHistoryCell` through `app_event_tx`. It returns nothing; the output is an app event queued for history insertion.

**Call relations**: This helper is called only from `ChatWidget::on_session_configured_with_display_and_fork_parent_title`, and only when a normal session display is being shown for a forked thread. It delegates cell construction to `PlainHistoryCell::new` and event creation to the `AppEvent::InsertHistoryCell` variant.

*Call graph*: calls 1 internal fn (new); called by 1 (on_session_configured_with_display_and_fork_parent_title); 4 external calls (new, InsertHistoryCell, to_string, vec!).


##### `ChatWidget::on_thread_name_updated`  (lines 209–224)

```
fn on_thread_name_updated(
        &mut self,
        thread_id: ThreadId,
        thread_name: Option<String>,
    )
```

**Purpose**: Applies a thread rename notification to the currently displayed thread, optionally adding a rename confirmation history cell. It ignores updates for non-active threads.

**Data flow**: It receives a `thread_id` and optional `thread_name`. It first compares the incoming id with `self.thread_id`; if they match, it may build a confirmation cell from the new name, append it to history, replace `self.thread_name`, refresh status surfaces, request redraw, and trigger queued-input draining via `maybe_send_next_queued_input`. It returns nothing and mutates visible thread metadata and history.

**Call relations**: This method is an event sink for rename notifications. When the active thread is renamed, it delegates confirmation-cell creation to `Self::rename_confirmation_cell`; otherwise it exits early without touching state.

*Call graph*: 2 external calls (new, rename_confirmation_cell).


##### `ChatWidget::set_skills`  (lines 226–228)

```
fn set_skills(&mut self, skills: Option<Vec<SkillMetadata>>)
```

**Purpose**: Forwards the current mentionable skill list into the bottom pane. It is a thin adapter so session/configuration code can update skill UI through `ChatWidget`.

**Data flow**: It takes `Option<Vec<SkillMetadata>>` and passes that value directly to `self.bottom_pane.set_skills`. It returns nothing and writes only bottom-pane state.

**Call relations**: This helper is called from `ChatWidget::on_session_configured_with_display_and_fork_parent_title` to clear skills during session reconfiguration. It does not perform its own logic beyond forwarding to the bottom pane.

*Call graph*: called by 1 (on_session_configured_with_display_and_fork_parent_title).


### `tui/src/chatwidget/turn_lifecycle.rs`

`data_model` · `cross-cutting`

This file is a compact data-and-state module centered on `TurnLifecycleState`. The struct combines a `SleepInhibitor` with a few turn-scoped fields: `agent_turn_running`, `last_turn_id`, a `HashSet<String>` of budget-limited turn ids, and an optional `Instant` marking when the current goal-status-active turn began. The methods are intentionally simple and side-effectful, keeping all sleep-inhibitor synchronization in one place.

`new` initializes the inhibitor according to the `prevent_idle_sleep` setting and starts with no active turn or remembered ids. `start`, `finish`, and `restore_running` are the core transitions: they update `agent_turn_running`, maintain `goal_status_active_turn_started_at`, and immediately mirror the running flag into `sleep_inhibitor.set_turn_running(...)`. `reset_thread` is a stronger reset that first finishes any active turn, then clears `last_turn_id` and all remembered budget-limited ids. `set_prevent_idle_sleep` recreates the inhibitor from scratch when the setting changes, then reapplies the current running state so behavior stays consistent.

The budget-limit helpers treat the `HashSet` as a one-shot marker store: `mark_budget_limited` inserts a turn id, and `take_budget_limited` removes and reports whether it was present. Tests cover both the running-state/sleep-inhibitor coupling and the consume-once semantics of budget-limited ids.

#### Function details

##### `TurnLifecycleState::new`  (lines 19–27)

```
fn new(prevent_idle_sleep: bool) -> Self
```

**Purpose**: Constructs a fresh turn-lifecycle state with sleep inhibition configured from the caller’s preference. It starts with no active turn and no remembered turn ids.

**Data flow**: Takes a `bool prevent_idle_sleep`, creates a `SleepInhibitor` from it, initializes `agent_turn_running` to false, `last_turn_id` to `None`, `budget_limited_turn_ids` to an empty `HashSet`, `goal_status_active_turn_started_at` to `None`, and returns the new struct.

**Call relations**: Called by widget construction and by tests. It is the root initializer for all later lifecycle transitions.

*Call graph*: calls 1 internal fn (new); called by 3 (new_with_op_target, budget_limited_turn_ids_are_consumed, start_and_finish_update_running_state); 1 external calls (new).


##### `TurnLifecycleState::start`  (lines 29–33)

```
fn start(&mut self, now: Instant)
```

**Purpose**: Marks an agent turn as running and starts sleep inhibition for that turn. It also records the start instant for goal-status timing.

**Data flow**: Consumes an `Instant now`, sets `agent_turn_running = true`, stores `Some(now)` in `goal_status_active_turn_started_at`, calls `sleep_inhibitor.set_turn_running(true)`, and returns nothing.

**Call relations**: Used by higher-level runtime code when a new task/turn begins so UI and sleep-prevention state move into the running state together.

*Call graph*: 1 external calls (set_turn_running).


##### `TurnLifecycleState::finish`  (lines 35–40)

```
fn finish(&mut self)
```

**Purpose**: Marks the current agent turn as no longer running and disables turn-based sleep inhibition. It also clears the active-turn start timestamp.

**Data flow**: Sets `agent_turn_running = false`, clears `goal_status_active_turn_started_at`, calls `sleep_inhibitor.set_turn_running(false)`, and returns nothing.

**Call relations**: Called directly by runtime cleanup and indirectly by `TurnLifecycleState::reset_thread` to ensure all running-state side effects are shut down.

*Call graph*: called by 1 (reset_thread); 1 external calls (set_turn_running).


##### `TurnLifecycleState::restore_running`  (lines 42–46)

```
fn restore_running(&mut self, running: bool, now: Instant)
```

**Purpose**: Restores running/not-running state from external knowledge, such as replay or thread restoration, while keeping the sleep inhibitor synchronized. It conditionally recreates the active-turn timestamp only when the restored state is running.

**Data flow**: Takes `running: bool` and `now: Instant`, stores `running` into `agent_turn_running`, sets `goal_status_active_turn_started_at` to `Some(now)` when running or `None` otherwise, calls `sleep_inhibitor.set_turn_running(running)`, and returns nothing.

**Call relations**: Used when the widget needs to reconstruct lifecycle state rather than transition through a fresh start event.

*Call graph*: 1 external calls (set_turn_running).


##### `TurnLifecycleState::reset_thread`  (lines 48–52)

```
fn reset_thread(&mut self)
```

**Purpose**: Fully resets thread-scoped lifecycle state, including any active turn and remembered budget-limited ids. It is stronger than `finish` because it also forgets thread identity markers.

**Data flow**: Calls `finish()` to clear running state and sleep inhibition, then sets `last_turn_id = None`, clears `budget_limited_turn_ids`, and returns nothing.

**Call relations**: Used when switching or resetting threads so no stale lifecycle markers leak across thread boundaries.

*Call graph*: calls 1 internal fn (finish).


##### `TurnLifecycleState::set_prevent_idle_sleep`  (lines 54–58)

```
fn set_prevent_idle_sleep(&mut self, enabled: bool)
```

**Purpose**: Reconfigures whether idle sleep should be inhibited during running turns. It rebuilds the inhibitor object and reapplies the current running state to the new instance.

**Data flow**: Takes `enabled: bool`, replaces `self.sleep_inhibitor` with a new `SleepInhibitor::new(enabled)`, then calls `set_turn_running(self.agent_turn_running)` on the new inhibitor. It returns nothing.

**Call relations**: Used when the user changes the prevent-idle-sleep setting at runtime. It preserves current turn-running semantics while swapping the underlying inhibitor configuration.

*Call graph*: calls 1 internal fn (new); 1 external calls (set_turn_running).


##### `TurnLifecycleState::mark_budget_limited`  (lines 60–62)

```
fn mark_budget_limited(&mut self, turn_id: String)
```

**Purpose**: Records that a specific turn id ended due to budget limits. The marker is stored for later one-time consumption.

**Data flow**: Consumes a `String turn_id`, inserts it into `budget_limited_turn_ids`, and returns nothing.

**Call relations**: Used by higher-level turn-management code to remember budget-limited turns until some later consumer checks and removes the marker.


##### `TurnLifecycleState::take_budget_limited`  (lines 64–66)

```
fn take_budget_limited(&mut self, turn_id: &str) -> bool
```

**Purpose**: Consumes and reports whether a given turn id had been marked as budget-limited. It implements one-shot lookup semantics.

**Data flow**: Takes `&str turn_id`, removes that id from `budget_limited_turn_ids`, returns `true` if it was present and `false` otherwise, and mutates the set accordingly.

**Call relations**: Used by callers that need to react once to a budget-limited turn and then forget that marker.


##### `tests::start_and_finish_update_running_state`  (lines 74–86)

```
fn start_and_finish_update_running_state()
```

**Purpose**: Verifies that starting and finishing a turn update both the lifecycle flags and the sleep inhibitor consistently. It checks the core state-transition contract of the type.

**Data flow**: Creates a new `TurnLifecycleState`, calls `start(Instant::now())`, asserts running/timestamp/inhibitor state are set, then calls `finish()` and asserts they are cleared. It mutates only local test state.

**Call relations**: This test exercises `TurnLifecycleState::new`, `start`, and `finish` together.

*Call graph*: calls 1 internal fn (new); 2 external calls (now, assert!).


##### `tests::budget_limited_turn_ids_are_consumed`  (lines 89–96)

```
fn budget_limited_turn_ids_are_consumed()
```

**Purpose**: Verifies that budget-limited turn ids are consumed exactly once. It locks in the remove-on-read behavior of the marker set.

**Data flow**: Creates a new `TurnLifecycleState`, inserts `"turn-1"` with `mark_budget_limited`, then asserts the first `take_budget_limited("turn-1")` returns true and the second returns false. It mutates only local test state.

**Call relations**: This test exercises `TurnLifecycleState::mark_budget_limited` and `take_budget_limited`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


### TUI side threads and settings
These files cover side-conversation thread behavior in the UI along with synchronization of thread settings and goal actions against the app server.

### `tui/src/app/side.rs`

`domain_logic` · `interactive command handling for /side, side-thread navigation, and parent-thread event updates while side mode is active`

This module defines the side-conversation feature as a lightweight, ephemeral fork of another thread. It combines policy text, UI state, parent-status tracking, and cleanup logic. Two large string constants provide the behavioral guardrails: `SIDE_BOUNDARY_PROMPT` is injected into the fork as a hidden user message marking inherited history as reference-only, and `SIDE_DEVELOPER_INSTRUCTIONS` are appended to the fork config so the model treats the side thread as separate, non-mutating, and forbidden from using subagents unless explicitly asked.

`SideParentStatus` and `SideParentStatusChange` translate parent-thread requests and notifications into concise status labels such as needs input, needs approval, failed, interrupted, closed, or finished. `SideThreadState` stores the parent thread id plus the latest parent status for each side thread. `sync_side_thread_ui` projects that state into `ChatWidget`: it blocks renaming, suppresses interrupted-turn notices, marks side mode active, and builds a context label like `Side from main thread · main needs approval · Ctrl+C to return`.

Lifecycle functions cover returning from side mode, deciding which side thread should be discarded after a switch, interrupting and unsubscribing side threads, and preserving visibility if cleanup fails. Starting a side conversation checks blockers (`primary_thread_id` must exist and no other side thread may be open), refreshes config, builds an ephemeral fork config inheriting current runtime model/effort/service tier and approval settings, forks the parent thread, installs a snapshot that hides inherited turns from replay, injects the boundary prompt, switches into the child thread, and optionally submits the user’s inline side question. Error paths restore the user message to the composer and either discard or keep the side thread visible depending on how far setup progressed.

#### Function details

##### `SideParentStatus::label`  (lines 65–80)

```
fn label(self, parent_is_main: bool) -> &'static str
```

**Purpose**: Maps a parent-thread status to the exact short label shown in side-thread UI, with wording that distinguishes the main thread from a non-primary parent. The strings are intentionally user-facing and compact.

**Data flow**: Takes `self` and `parent_is_main: bool`, matches the pair, and returns a static string such as `main needs input`, `parent failed`, or `main finished`.

**Call relations**: Used by `App::sync_side_thread_ui` when composing the side-conversation context label shown in the chat widget.


##### `SideParentStatus::is_actionable`  (lines 82–87)

```
fn is_actionable(self) -> bool
```

**Purpose**: Identifies whether a parent status represents an actionable interruption that should be cleared when work starts or a request resolves. Only input and approval statuses count.

**Data flow**: Matches `self` against `NeedsInput | NeedsApproval` and returns a boolean.

**Call relations**: Used by `App::clear_side_parent_action_status` to selectively clear only actionable parent statuses while preserving terminal statuses like failed or finished.

*Call graph*: 1 external calls (matches!).


##### `SideParentStatus::for_request`  (lines 89–102)

```
fn for_request(request: &ServerRequest) -> Option<Self>
```

**Purpose**: Converts an incoming `ServerRequest` into the corresponding parent-thread side status, or `None` for requests that should not affect side UI. Approval-like requests collapse into `NeedsApproval` while user-input requests become `NeedsInput`.

**Data flow**: Matches the `ServerRequest` enum. `ToolRequestUserInput` maps to `Some(NeedsInput)`, several approval request variants map to `Some(NeedsApproval)`, and dynamic/auth/attestation requests map to `None`.

**Call relations**: Called by request-enqueue logic outside this file when parent-thread requests arrive. It feeds side-thread parent-status tracking.

*Call graph*: called by 1 (enqueue_thread_request).


##### `tests::side_boundary_prompt_marks_inherited_history_reference_only`  (lines 111–132)

```
fn side_boundary_prompt_marks_inherited_history_reference_only()
```

**Purpose**: Checks that the hidden boundary prompt injected into side threads contains the expected guardrail language about inherited history, tools, subagents, and mutations. This protects the prompt contract from accidental weakening.

**Data flow**: Calls `App::side_boundary_prompt_item()`, destructures the returned `ResponseItem::Message`, extracts the single `ContentItem::InputText`, and asserts that required substrings are present.

**Call relations**: Unit test for the prompt-construction helper used during side-thread startup.

*Call graph*: 4 external calls (assert!, assert_eq!, side_boundary_prompt_item, panic!).


##### `tests::side_start_error_message_explains_missing_first_prompt`  (lines 135–144)

```
fn side_start_error_message_explains_missing_first_prompt()
```

**Purpose**: Verifies that fork failures caused by missing rollout history are translated into the user-friendly `/side` unavailable message. This avoids surfacing raw server errors for the common 'conversation not started yet' case.

**Data flow**: Builds an eyre error containing `no rollout found for thread id`, passes it to `App::side_start_error_message`, and asserts the returned string matches the specialized constant.

**Call relations**: Tests the error-message helper used when side-thread startup fails before a conversation has begun.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::side_start_error_message_uses_generic_start_wording`  (lines 147–154)

```
fn side_start_error_message_uses_generic_start_wording()
```

**Purpose**: Ensures unrelated side-start failures fall back to a generic `Failed to start side conversation: ...` message. This preserves the original error text when no special-case guidance applies.

**Data flow**: Creates a generic eyre error, calls `App::side_start_error_message`, and asserts the formatted fallback string.

**Call relations**: Covers the generic branch of side-start error translation.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::side_developer_instructions_appends_existing_policy`  (lines 157–168)

```
fn side_developer_instructions_appends_existing_policy()
```

**Purpose**: Checks that side-thread developer instructions append to existing developer policy instead of replacing it. The side guardrails must coexist with any prior instructions.

**Data flow**: Calls `App::side_developer_instructions(Some("Existing developer policy."))` and asserts that both the original text and side-specific guardrails appear in the result.

**Call relations**: Tests the config-building helper used by `side_fork_config`.

*Call graph*: 2 external calls (assert!, side_developer_instructions).


##### `SideParentStatusChange::for_notification`  (lines 179–200)

```
fn for_notification(notification: &ServerNotification) -> Option<Self>
```

**Purpose**: Translates selected `ServerNotification` values into side-parent status mutations. Turn starts clear status, terminal turn completions set finished/interrupted/failed, thread closure sets closed, and item-started/request-resolved notifications clear only actionable statuses.

**Data flow**: Matches a `ServerNotification` and returns `Some(SideParentStatusChange)` or `None`. It inspects `TurnCompleted` status values to choose `Set(Finished|Interrupted|Failed)`, maps `TurnStarted` to `Clear`, `ThreadClosed` to `Set(Closed)`, and `ItemStarted`/`ServerRequestResolved` to `ClearActionable`.

**Call relations**: Called by notification-enqueue logic outside this file to keep side-thread parent status synchronized with parent-thread lifecycle events.

*Call graph*: called by 1 (enqueue_thread_notification); 1 external calls (Set).


##### `SideThreadState::new`  (lines 212–217)

```
fn new(parent_thread_id: ThreadId) -> Self
```

**Purpose**: Constructs the initial local state for a side thread, recording which parent thread it should return to and starting with no parent-status badge. This is the canonical initializer for `side_threads` entries.

**Data flow**: Takes `parent_thread_id` and returns `SideThreadState { parent_thread_id, parent_status: None }`.

**Call relations**: Used when a side thread is created and in many tests that seed side-thread state directly.

*Call graph*: called by 14 (handle_start_side, active_side_thread_renders_live_mcp_startup_notifications, discard_closed_side_thread_removes_local_state_without_server_rpc, discard_side_thread_keeps_local_state_when_server_close_fails, discard_side_thread_removes_agent_navigation_entry, side_defers_parent_approval_overlay_until_parent_replay, side_defers_subagent_approval_overlay_until_side_exits, side_discard_selection_keeps_current_side_thread, side_parent_status_prioritizes_input_over_approval, side_parent_status_tracks_parent_turn_lifecycle (+4 more)).


##### `App::sync_side_thread_ui`  (lines 221–261)

```
fn sync_side_thread_ui(&mut self)
```

**Purpose**: Projects current side-thread state into the `ChatWidget`, enabling or clearing side-mode UI affordances. It controls rename blocking, interrupted-turn notice suppression, active-side styling, and the contextual label text.

**Data flow**: Reads `self.current_displayed_thread_id()`, `self.side_threads`, and `self.primary_thread_id`. If no active side thread exists, it clears side UI by resetting context label, active flag, rename block, and interrupted-turn notice mode. Otherwise it sets the rename block message, marks side mode active, suppresses interrupted-turn notices, builds label parts from parent identity and optional `parent_status.label(...)`, appends `Ctrl+C to return`, and writes the final label into the widget.

**Call relations**: Called whenever side-thread state or parent status changes, and during side-start failure handling. It is the sole place that keeps widget-side presentation aligned with `side_threads` state.

*Call graph*: called by 3 (clear_side_parent_action_status, handle_start_side, set_side_parent_status); 2 external calls (new, format!).


##### `App::active_side_parent_thread_id`  (lines 263–267)

```
fn active_side_parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the parent thread id for the currently displayed side thread, if the active display is a side conversation. This is the lookup used by Ctrl+C return behavior.

**Data flow**: Reads `self.current_displayed_thread_id()`, looks up that id in `self.side_threads`, and maps the stored `SideThreadState` to its `parent_thread_id`. Returns `Option<ThreadId>`.

**Call relations**: Used by `maybe_return_from_side` to decide whether the current view can return to a parent thread.

*Call graph*: called by 1 (maybe_return_from_side).


##### `App::set_side_parent_status`  (lines 269–288)

```
fn set_side_parent_status(
        &mut self,
        parent_thread_id: ThreadId,
        status: Option<SideParentStatus>,
    )
```

**Purpose**: Sets the same parent-status value on every side thread whose parent matches the given thread id, then refreshes side UI if anything changed. This supports multiple side descendants of one parent, even though normal UX allows only one open side thread.

**Data flow**: Iterates mutable `self.side_threads.values_mut()`, filters by `parent_thread_id`, compares and updates `state.parent_status`, tracks whether any mutation occurred, and calls `sync_side_thread_ui()` if so.

**Call relations**: Called by `apply_side_parent_status_change` when a parent-thread event should set or clear status.

*Call graph*: calls 1 internal fn (sync_side_thread_ui); called by 1 (apply_side_parent_status_change).


##### `App::clear_side_parent_action_status`  (lines 290–308)

```
fn clear_side_parent_action_status(&mut self, parent_thread_id: ThreadId)
```

**Purpose**: Clears only actionable parent statuses (`NeedsInput` or `NeedsApproval`) for side threads attached to a given parent, leaving terminal statuses intact. It then refreshes side UI if any status changed.

**Data flow**: Iterates matching `side_threads`, checks `state.parent_status.is_some_and(SideParentStatus::is_actionable)`, sets those statuses to `None`, tracks whether anything changed, and calls `sync_side_thread_ui()` when needed.

**Call relations**: Used by `apply_side_parent_status_change` for notifications like item start or request resolution that should dismiss actionable badges without erasing finished/failed state.

*Call graph*: calls 1 internal fn (sync_side_thread_ui); called by 1 (apply_side_parent_status_change).


##### `App::apply_side_parent_status_change`  (lines 310–326)

```
fn apply_side_parent_status_change(
        &mut self,
        parent_thread_id: ThreadId,
        change: SideParentStatusChange,
    )
```

**Purpose**: Applies a precomputed `SideParentStatusChange` to all side threads of a parent. It is the dispatcher between `Set`, `Clear`, and `ClearActionable` semantics.

**Data flow**: Matches the `change` enum and delegates to `set_side_parent_status(parent_thread_id, Some(status))`, `set_side_parent_status(..., None)`, or `clear_side_parent_action_status(parent_thread_id)`. Returns no value.

**Call relations**: Called by higher-level request/notification handling after `SideParentStatus::for_request` or `SideParentStatusChange::for_notification` has classified an event.

*Call graph*: calls 2 internal fn (clear_side_parent_action_status, set_side_parent_status).


##### `App::maybe_return_from_side`  (lines 328–349)

```
async fn maybe_return_from_side(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
    ) -> bool
```

**Purpose**: Implements the implicit Ctrl+C return path from a side conversation back to its parent thread, but only when no overlay/modal is active and the composer is empty. It reports success only if the side context is actually gone afterward.

**Data flow**: Checks `self.overlay`, `self.chat_widget.no_modal_or_popup_active()`, `self.chat_widget.composer_is_empty()`, and `active_side_parent_thread_id()`. If all conditions hold, it awaits `select_agent_thread_and_discard_side` for the parent and returns whether `active_side_parent_thread_id()` is now `None`; otherwise returns `false`.

**Call relations**: Used by key handling outside this file when Ctrl+C should dismiss a side conversation instead of interrupting work.

*Call graph*: calls 2 internal fn (active_side_parent_thread_id, select_agent_thread_and_discard_side).


##### `App::side_thread_to_discard_after_switch`  (lines 351–361)

```
fn side_thread_to_discard_after_switch(
        &self,
        target_thread_id: ThreadId,
    ) -> Option<ThreadId>
```

**Purpose**: Determines whether the currently displayed side thread should be discarded after switching to another thread. Switching to the same side thread or switching when not in side mode yields no discard target.

**Data flow**: Reads `self.current_displayed_thread_id()` and `self.side_threads`. If the current displayed thread is a side thread and differs from `target_thread_id`, it returns that current side thread id; otherwise returns `None`.

**Call relations**: Used by `select_agent_thread_and_discard_side` to remember which side thread should be cleaned up after a successful switch.

*Call graph*: called by 1 (select_agent_thread_and_discard_side).


##### `App::discard_side_thread`  (lines 363–382)

```
async fn discard_side_thread(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> bool
```

**Purpose**: Attempts to fully close a side conversation by interrupting any active work, unsubscribing from the server thread, and removing all local state. On failure it leaves local state intact and surfaces an error message.

**Data flow**: Awaits `interrupt_side_thread`; on error it logs and emits the returned message and returns `false`. Then it awaits `app_server.thread_unsubscribe(thread_id)`; on error it formats/logs/emits a failure message and returns `false`. On success it awaits `discard_thread_local_state(thread_id)` and returns `true`.

**Call relations**: Called when leaving or cleaning up side threads, either directly or through `discard_side_thread_or_keep_visible` and `select_agent_thread_and_discard_side`.

*Call graph*: calls 3 internal fn (discard_thread_local_state, interrupt_side_thread, thread_unsubscribe); called by 2 (discard_side_thread_or_keep_visible, select_agent_thread_and_discard_side); 2 external calls (format!, warn!).


##### `App::discard_closed_side_thread`  (lines 384–386)

```
async fn discard_closed_side_thread(&mut self, thread_id: ThreadId)
```

**Purpose**: Removes local state for a side thread that is already known closed, without attempting any server RPCs. This is the cleanup path for externally closed side threads.

**Data flow**: Awaits `discard_thread_local_state(thread_id)` and returns no value.

**Call relations**: Used by shutdown/closure handling outside this file when the server has already closed the side thread.

*Call graph*: calls 1 internal fn (discard_thread_local_state).


##### `App::discard_thread_local_state`  (lines 388–399)

```
async fn discard_thread_local_state(&mut self, thread_id: ThreadId)
```

**Purpose**: Removes all local bookkeeping for a thread: listener task, event channel, side-thread mapping, and agent-navigation entry. It also clears active-thread state or refreshes pending approvals depending on whether the discarded thread was active.

**Data flow**: Aborts the thread event listener, removes entries from `thread_event_channels`, `side_threads`, and `agent_navigation`, then either awaits `clear_active_thread()` if `self.active_thread_id` matches or awaits `refresh_pending_thread_approvals()` otherwise. Finally it syncs the active-agent label.

**Call relations**: Used by both side-thread discard paths and stale startup-thread cleanup. It is the shared local-state teardown primitive.

*Call graph*: called by 2 (discard_closed_side_thread, discard_side_thread).


##### `App::interrupt_side_thread`  (lines 401–415)

```
async fn interrupt_side_thread(
        &self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    ) -> std::result::Result<(), String>
```

**Purpose**: Sends the appropriate interrupt RPC for a side thread before closing it, using `turn_interrupt` when an active turn exists and `startup_interrupt` otherwise. It converts RPC failures into a user-facing close-failure string.

**Data flow**: Awaits `self.active_turn_id_for_thread(thread_id)`. If a turn id exists it awaits `app_server.turn_interrupt(thread_id, turn_id)`, else `app_server.startup_interrupt(thread_id)`. It maps any error into `Err(String)` with a formatted close-failure message.

**Call relations**: Called only by `discard_side_thread` as the first step of side-thread cleanup.

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

**Purpose**: Restores a side thread as the active view if cleanup failed after the UI had already switched away from it. This avoids silently losing access to a still-open side conversation.

**Data flow**: Checks whether `self.active_thread_id != Some(thread_id)` and, if so, awaits `select_agent_thread(tui, app_server, thread_id)`. Any restoration failure is logged as a warning. No value is returned.

**Call relations**: Used by cleanup wrappers when side-thread discard fails after a switch. It is the recovery path that keeps the still-open side thread visible.

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

**Purpose**: Attempts to discard a side thread and, if that fails, restores or keeps it visible. It returns whether cleanup actually succeeded.

**Data flow**: Awaits `discard_side_thread(app_server, thread_id)`. On success it returns `true`; on failure it awaits `keep_side_thread_visible_after_cleanup_failure(tui, app_server, thread_id)` and returns `false`.

**Call relations**: Used by side-start error handling after a child thread has been created but setup or switching fails.

*Call graph*: calls 2 internal fn (discard_side_thread, keep_side_thread_visible_after_cleanup_failure); called by 1 (handle_start_side).


##### `App::side_developer_instructions`  (lines 447–454)

```
fn side_developer_instructions(existing_instructions: Option<&str>) -> String
```

**Purpose**: Builds the developer-instructions string for a side fork by appending side-specific guardrails to any existing developer policy. Empty or missing existing instructions are replaced by the side instructions alone.

**Data flow**: Takes `Option<&str>`. If present and non-blank, returns `format!("{existing}\n\n{SIDE_DEVELOPER_INSTRUCTIONS}")`; otherwise returns `SIDE_DEVELOPER_INSTRUCTIONS.to_string()`.

**Call relations**: Used by `side_fork_config` when constructing the ephemeral fork configuration.

*Call graph*: 1 external calls (format!).


##### `App::side_boundary_prompt_item`  (lines 456–466)

```
fn side_boundary_prompt_item() -> ResponseItem
```

**Purpose**: Constructs the hidden boundary `ResponseItem` injected into a side thread immediately after forking. The item is a synthetic user message containing the side-boundary prompt text.

**Data flow**: Returns `ResponseItem::Message` with `role: "user"`, a single `ContentItem::InputText { text: SIDE_BOUNDARY_PROMPT.to_string() }`, and all optional metadata fields set to `None`.

**Call relations**: Used during `handle_start_side` before switching into the child thread so the model sees a clear boundary between inherited history and new side-thread instructions.

*Call graph*: 1 external calls (vec!).


##### `App::side_fork_config`  (lines 468–481)

```
fn side_fork_config(&self) -> Config
```

**Purpose**: Builds the config used to fork a side conversation, inheriting current runtime thread settings while forcing ephemeral mode and appending side-specific developer guardrails. It intentionally preserves the parent’s current model, reasoning effort, service tier, and approval context.

**Data flow**: Clones `self.chat_widget.config_ref()`, overwrites `model` from `self.chat_widget.current_model()` when non-empty, copies `model_reasoning_effort` and `service_tier` from the widget, sets `ephemeral = true`, and sets `developer_instructions` to `Some(Self::side_developer_instructions(existing))`. Returns the resulting `Config`.

**Call relations**: Called by `handle_start_side` immediately before `app_server.fork_thread`. It encapsulates the side-thread policy and inheritance rules.

*Call graph*: called by 1 (handle_start_side); 1 external calls (side_developer_instructions).


##### `App::side_start_block_message`  (lines 483–491)

```
fn side_start_block_message(&self) -> Option<&'static str>
```

**Purpose**: Returns the user-facing reason `/side` is currently unavailable, if any. Side conversations require a ready main thread and allow only one open side thread at a time.

**Data flow**: Reads `self.primary_thread_id` and `self.side_threads`. It returns `Some(SIDE_MAIN_THREAD_UNAVAILABLE_MESSAGE)` when no primary thread exists, `Some(SIDE_ALREADY_OPEN_MESSAGE)` when any side thread is already tracked, or `None` otherwise.

**Call relations**: Used at the start of `handle_start_side` to reject invalid side-start attempts before any server work begins.

*Call graph*: called by 1 (handle_start_side).


##### `App::side_start_error_message`  (lines 493–503)

```
fn side_start_error_message(err: &color_eyre::Report) -> String
```

**Purpose**: Translates side-start failures into either a specialized 'send a message first' explanation or a generic formatted error. It recognizes both missing-rollout and include-turns-unavailable server messages as 'conversation not started yet'.

**Data flow**: Walks `err.chain()`, stringifies causes, and if any contain `no rollout found for thread id` or `includeTurns is unavailable before first user message`, returns `SIDE_NO_STARTED_CONVERSATION_MESSAGE.to_string()`. Otherwise it returns `format!("Failed to start side conversation: {err}")`.

**Call relations**: Used by `handle_start_side` when `fork_thread` fails before a child thread is created.

*Call graph*: 2 external calls (chain, format!).


##### `App::restore_side_user_message`  (lines 505–513)

```
fn restore_side_user_message(
        &mut self,
        user_message: Option<crate::chatwidget::UserMessage>,
    )
```

**Purpose**: Restores a deferred inline side question back into the composer when side-thread startup or switching fails. This prevents user input from being lost.

**Data flow**: Takes `Option<UserMessage>` and, if `Some`, passes it to `self.chat_widget.restore_user_message_to_composer`. Returns no value.

**Call relations**: Called from multiple error branches in `handle_start_side` whenever the side conversation cannot be entered successfully.

*Call graph*: called by 1 (handle_start_side).


##### `App::install_side_thread_snapshot`  (lines 515–524)

```
fn install_side_thread_snapshot(
        store: &mut ThreadEventStore,
        mut session: ThreadSessionState,
        _forked_turns: Vec<Turn>,
    )
```

**Purpose**: Seeds a side thread’s local replay store with session state while intentionally hiding inherited fork history from the visible transcript. The model still has inherited context in core state, but the UI starts at the side boundary.

**Data flow**: Takes a mutable `ThreadEventStore`, a `ThreadSessionState`, and ignored forked turns. It clears `session.forked_from_id`, then calls `store.set_session(session, Vec::new())`, storing no turns.

**Call relations**: Used during side-thread startup after `fork_thread` succeeds and before switching into the child thread. It enforces the design choice that side transcripts visually begin at the boundary prompt, not with replayed parent history.

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

**Purpose**: Switches to a target thread and then discards the previously displayed side thread if appropriate. If cleanup fails after a successful switch, it may restore the side thread to keep the still-open conversation accessible.

**Data flow**: Captures `active_thread_id_before_switch`, computes `side_thread_to_discard` via `side_thread_to_discard_after_switch`, awaits `select_agent_thread`, and if the target became active and a side thread should be discarded, awaits `discard_side_thread`. On successful discard it surfaces pending inactive-thread interactive requests; on discard failure, if the side thread had been active before the switch, it awaits `keep_side_thread_visible_after_cleanup_failure`. Returns `Result<()>` from the selection step.

**Call relations**: Used both for explicit side return and when entering a newly created side thread. It composes normal thread switching with side-thread cleanup semantics.

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

**Purpose**: Implements the full `/side` command: validate availability, fork the current thread with side-specific config, install a hidden boundary prompt, switch into the child thread, and optionally submit the user’s side question. It contains the main success and rollback/error paths for side-conversation startup.

**Data flow**: Accepts `tui`, `app_server`, `parent_thread_id`, and an optional `UserMessage`. It first checks `side_start_block_message`; on block it restores the message, syncs side UI, emits an error, and returns `Continue`. Otherwise it records telemetry, refreshes config from disk, builds `fork_config` via `side_fork_config`, and awaits `app_server.fork_thread`. On success it ensures a thread channel for the child, installs a side snapshot into the channel store, inserts `SideThreadState::new(parent_thread_id)` into `self.side_threads`, injects `side_boundary_prompt_item()` via `thread_inject_items`, switches into the child with `select_agent_thread_and_discard_side`, and if the child is active submits the deferred user message as a plain user turn. Any failure after fork creation triggers cleanup via `discard_side_thread_or_keep_visible`, possible restoration of the parent thread, restoration of the user message, and an error message. On initial fork failure it restores the message, clears the side context label, and emits `side_start_error_message(&err)`. It always returns `Ok(AppRunControl::Continue)`.

**Call relations**: This is the top-level side-conversation entrypoint invoked by slash-command handling. It delegates to config construction, snapshot installation, boundary injection, thread switching, and cleanup helpers depending on how far startup progresses.

*Call graph*: calls 9 internal fn (discard_side_thread_or_keep_visible, restore_side_user_message, select_agent_thread_and_discard_side, side_fork_config, side_start_block_message, sync_side_thread_ui, new, fork_thread, thread_inject_items); 5 external calls (install_side_thread_snapshot, side_start_error_message, format!, warn!, vec!).


### `tui/src/chatwidget/side.rs`

`domain_logic` · `side-conversation activation and side-thread message submission`

This file is a small adapter layer for side-thread UX inside `ChatWidget`. It does not own side-thread lifecycle creation itself; instead, it exposes the widget-local pieces that change when side mode is active.

The submission helper forces a plain user turn by calling the more general submission path with `ShellEscapePolicy::Disallow`, ensuring side-conversation inline messages are treated as ordinary chat text rather than shell-escaped commands. The mode toggle stores a boolean flag, swaps the composer placeholder between `side_placeholder_text` and `normal_placeholder_text`, and informs the bottom pane that side conversation mode is active so footer or input rendering can adjust accordingly.

Two additional accessors round out the surface: one reports whether side mode is currently active, and the other forwards an optional context label into the bottom pane. That label is used by higher-level side-thread orchestration to show transient context such as a “starting…” state or parent-thread context in the footer/UI.

#### Function details

##### `ChatWidget::submit_user_message_as_plain_user_turn`  (lines 10–15)

```
fn submit_user_message_as_plain_user_turn(
        &mut self,
        user_message: UserMessage,
    ) -> Option<AppCommand>
```

**Purpose**: Submits a `UserMessage` through the normal message pipeline while explicitly disallowing shell-escape interpretation. It is the side-mode-safe submission wrapper.

**Data flow**: It takes a `UserMessage`, forwards it to `submit_user_message_with_shell_escape_policy(user_message, ShellEscapePolicy::Disallow)`, and returns the resulting `Option<AppCommand>`. It mutates whatever submission state that delegated path updates.

**Call relations**: This helper is used when side-conversation flows need a guaranteed plain user turn. It delegates all real submission work to the more general shell-escape-aware submission method.


##### `ChatWidget::set_side_conversation_active`  (lines 17–26)

```
fn set_side_conversation_active(&mut self, active: bool)
```

**Purpose**: Turns side-conversation mode on or off and updates composer/footer presentation to match. The placeholder text switches immediately based on the new mode.

**Data flow**: It takes a boolean `active`, stores it in `self.active_side_conversation`, selects either `self.side_placeholder_text` or `self.normal_placeholder_text`, passes that placeholder to `bottom_pane.set_placeholder_text`, and forwards the active flag to `bottom_pane.set_side_conversation_active`. It returns nothing.

**Call relations**: This is the main widget-local side-mode toggle called by higher-level side-thread orchestration. It delegates visual updates to the bottom pane.


##### `ChatWidget::side_conversation_active`  (lines 28–30)

```
fn side_conversation_active(&self) -> bool
```

**Purpose**: Returns whether the widget is currently in side-conversation mode. It is a direct accessor over the stored flag.

**Data flow**: It reads and returns `self.active_side_conversation`. No state is mutated.

**Call relations**: This getter supports command gating and UI logic that needs to know whether side mode is active.


##### `ChatWidget::set_side_conversation_context_label`  (lines 32–34)

```
fn set_side_conversation_context_label(&mut self, label: Option<String>)
```

**Purpose**: Forwards an optional side-conversation context label into the bottom pane. It lets higher-level side-thread logic control the footer/context text.

**Data flow**: It takes `Option<String>` and passes it directly to `bottom_pane.set_side_conversation_context_label`. It returns nothing.

**Call relations**: This helper is called by side-thread orchestration paths that want to display contextual side-mode labels without directly touching bottom-pane internals.


### `tui/src/app/thread_settings.rs`

`domain_logic` · `settings changes and thread-settings notification handling`

This module is the narrow bridge between UI-level setting changes and backend thread settings. The outward-facing methods each package one kind of local change into `ThreadSettingsUpdateParams`: model changes include the effective collaboration mode, reasoning changes include the current collaboration mode, plan-mode reasoning sync sends only collaboration mode, personality sync sends only personality, and `sync_override_turn_context_settings` translates an `AppCommand::OverrideTurnContext` into a full thread-settings update covering cwd, approval policy, reviewer, active permission profile id, model, effort, summary, service tier, collaboration mode, and personality. All of these delegate to `send_thread_settings_update`, which first checks `thread_settings_update_has_changes` so empty updates are skipped, then calls `app_server.thread_settings_update` and reports failures via both tracing and a chat-widget error message. The inbound side is `apply_thread_settings_to_cached_session`, which updates both `primary_session_configured` and the matching thread store session when a `ThreadSettingsUpdated` notification arrives. The pure helper `apply_thread_settings_to_session` contains the actual field mapping: it updates model and reasoning effort only when collaboration mode is `Default`, always refreshes provider, service tier, approval policy, reviewer, permission profile derived from legacy sandbox policy plus cwd, active permission profile, cwd retargeting, personality, and stores a boxed collaboration-mode snapshot whose nested settings are patched with the current model and reasoning effort. This keeps replayed session snapshots aligned with backend truth.

#### Function details

##### `App::sync_active_thread_model_setting`  (lines 15–24)

```
async fn sync_active_thread_model_setting(
        &mut self,
        app_server: &mut AppServerSession,
        model: String,
    )
```

**Purpose**: Pushes a model change for the active thread to the app server. If there is no active thread, it does nothing.

**Data flow**: It takes a `String` model, asks `active_thread_model_setting_update_params(model)` for optional params, returns early on `None`, and otherwise awaits `send_thread_settings_update(app_server, params)`. It mutates backend state and may emit UI errors indirectly through the send helper.

**Call relations**: Called when the user changes the model in the active thread. It delegates parameter construction and actual RPC/error handling to helper methods.

*Call graph*: calls 2 internal fn (active_thread_model_setting_update_params, send_thread_settings_update).


##### `App::active_thread_model_setting_update_params`  (lines 26–37)

```
fn active_thread_model_setting_update_params(
        &self,
        model: String,
    ) -> Option<ThreadSettingsUpdateParams>
```

**Purpose**: Builds the thread-settings update payload for a model change on the active thread. It also includes the effective collaboration mode so the backend sees the correct mode context.

**Data flow**: It reads `self.active_thread_id`; if absent it returns `None`. Otherwise it returns `Some(ThreadSettingsUpdateParams { thread_id: ..., model: Some(model), collaboration_mode: Some(self.chat_widget.effective_collaboration_mode()), ..default() })`.

**Call relations**: Used only by `sync_active_thread_model_setting` to package model updates.

*Call graph*: called by 1 (sync_active_thread_model_setting); 1 external calls (default).


##### `App::sync_active_thread_reasoning_setting`  (lines 39–48)

```
async fn sync_active_thread_reasoning_setting(
        &mut self,
        app_server: &mut AppServerSession,
        effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    )
```

**Purpose**: Pushes a reasoning-effort change for the active thread to the app server. No-op when there is no active thread.

**Data flow**: It takes an optional reasoning effort, asks `active_thread_reasoning_setting_update_params(effort)` for params, returns if `None`, and otherwise awaits `send_thread_settings_update(app_server, params)`.

**Call relations**: Called when the user changes reasoning effort in the active thread.

*Call graph*: calls 2 internal fn (active_thread_reasoning_setting_update_params, send_thread_settings_update).


##### `App::active_thread_reasoning_setting_update_params`  (lines 50–61)

```
fn active_thread_reasoning_setting_update_params(
        &self,
        effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    ) -> Option<ThreadSettingsUpdateParams>
```

**Purpose**: Builds the thread-settings update payload for a reasoning-effort change. It includes the current collaboration mode snapshot from the widget.

**Data flow**: It reads `self.active_thread_id`; if absent it returns `None`. Otherwise it returns `Some(ThreadSettingsUpdateParams { thread_id: ..., effort, collaboration_mode: Some(self.chat_widget.current_collaboration_mode().clone()), ..default() })`.

**Call relations**: Used only by `sync_active_thread_reasoning_setting`.

*Call graph*: called by 1 (sync_active_thread_reasoning_setting); 1 external calls (default).


##### `App::sync_active_thread_plan_mode_reasoning_setting`  (lines 63–76)

```
async fn sync_active_thread_plan_mode_reasoning_setting(
        &mut self,
        app_server: &mut AppServerSession,
    )
```

**Purpose**: Synchronizes plan-mode collaboration settings for the active thread without explicitly changing model or effort fields. This is used when effective reasoning behavior changes through collaboration mode.

**Data flow**: It returns early if there is no active thread. Otherwise it builds `ThreadSettingsUpdateParams` with the active thread id and `collaboration_mode = Some(self.chat_widget.effective_collaboration_mode())`, then awaits `send_thread_settings_update(app_server, params)`.

**Call relations**: Called when plan-mode reasoning settings need to be reflected in backend thread settings.

*Call graph*: calls 1 internal fn (send_thread_settings_update); 1 external calls (default).


##### `App::sync_active_thread_personality_setting`  (lines 78–92)

```
async fn sync_active_thread_personality_setting(
        &mut self,
        app_server: &mut AppServerSession,
        personality: codex_protocol::config_types::Personality,
    )
```

**Purpose**: Pushes a personality change for the active thread to the app server. It is a focused wrapper around thread-settings update submission.

**Data flow**: It returns early if `self.active_thread_id` is `None`. Otherwise it builds `ThreadSettingsUpdateParams` with the thread id and `personality: Some(personality)`, then awaits `send_thread_settings_update(app_server, params)`.

**Call relations**: Used when the user changes the active thread's personality setting.

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

**Purpose**: Translates an `OverrideTurnContext` command into a thread-settings update RPC. This keeps backend thread settings aligned with per-turn override choices made in the TUI.

**Data flow**: It pattern-matches `op`; if it is not `AppCommand::OverrideTurnContext`, it returns. For the matching variant it extracts cwd, approval policy, approvals reviewer, active permission profile, model, effort, summary, service tier, collaboration mode, and personality, converts `thread_id` to string, maps `approvals_reviewer` into the app-server enum, maps `active_permission_profile` to its id string for `permissions`, unwraps `effort` with `unwrap_or_default()`, builds `ThreadSettingsUpdateParams`, and awaits `send_thread_settings_update(app_server, params)`.

**Call relations**: Called from the `OverrideTurnContext` branch of thread command submission in `thread_routing.rs`.

*Call graph*: calls 1 internal fn (send_thread_settings_update); 2 external calls (default, to_string).


##### `App::apply_thread_settings_to_cached_session`  (lines 137–154)

```
async fn apply_thread_settings_to_cached_session(
        &mut self,
        thread_id: ThreadId,
        settings: &ThreadSettings,
    )
```

**Purpose**: Applies incoming backend thread settings to all relevant local session caches for a thread. Both the primary-session cache and the thread store snapshot are updated when present.

**Data flow**: It compares `thread_id` to `self.primary_thread_id`; if they match and `primary_session_configured` exists, it mutably applies `apply_thread_settings_to_session(session, settings)`. It then looks up the thread channel, locks its store, and applies the same helper to `store.session` if present.

**Call relations**: Called when `ThreadSettingsUpdated` notifications are enqueued so local replay/session state stays synchronized with backend truth.

*Call graph*: calls 1 internal fn (apply_thread_settings_to_session).


##### `App::send_thread_settings_update`  (lines 156–169)

```
async fn send_thread_settings_update(
        &mut self,
        app_server: &mut AppServerSession,
        params: ThreadSettingsUpdateParams,
    )
```

**Purpose**: Sends a thread-settings update to the app server only when the payload contains at least one actual change. Failures are both logged and surfaced to the user.

**Data flow**: It takes owned `ThreadSettingsUpdateParams`, returns immediately if `thread_settings_update_has_changes(&params)` is false, otherwise awaits `app_server.thread_settings_update(params)`. On error it logs a warning and adds `Failed to update thread settings: {err}` to the chat widget.

**Call relations**: This is the shared submission helper used by all outward settings-sync methods in the module.

*Call graph*: calls 2 internal fn (thread_settings_update_has_changes, thread_settings_update); called by 5 (sync_active_thread_model_setting, sync_active_thread_personality_setting, sync_active_thread_plan_mode_reasoning_setting, sync_active_thread_reasoning_setting, sync_override_turn_context_settings); 2 external calls (format!, warn!).


##### `apply_thread_settings_to_session`  (lines 172–195)

```
fn apply_thread_settings_to_session(session: &mut ThreadSessionState, settings: &ThreadSettings)
```

**Purpose**: Maps a backend `ThreadSettings` snapshot onto a mutable `ThreadSessionState`. It contains the exact field-level synchronization policy used for cached sessions.

**Data flow**: It mutates `session` in place from `settings`. When `settings.collaboration_mode.mode == ModeKind::Default`, it copies `settings.model` and `settings.effort` into `session.model` and `session.reasoning_effort`; regardless of mode it updates `model_provider_id`, `service_tier`, `approval_policy`, `approvals_reviewer`, derives `permission_profile` from the legacy sandbox policy and cwd, maps `active_permission_profile`, retargets cwd/workspace roots, and copies `personality`. It then clones `settings.collaboration_mode`, patches its nested `settings.model` and `settings.reasoning_effort` from the top-level settings, boxes it, and stores it in `session.collaboration_mode`.

**Call relations**: Used only by `apply_thread_settings_to_cached_session`, centralizing the exact translation from backend settings to local session snapshots.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, set_cwd_retargeting_implicit_runtime_workspace_root); called by 1 (apply_thread_settings_to_cached_session); 1 external calls (new).


##### `thread_settings_update_has_changes`  (lines 197–209)

```
fn thread_settings_update_has_changes(params: &ThreadSettingsUpdateParams) -> bool
```

**Purpose**: Checks whether a `ThreadSettingsUpdateParams` contains any field that would actually modify backend state. Empty updates are suppressed.

**Data flow**: It returns true if any of `cwd`, `approval_policy`, `approvals_reviewer`, `sandbox_policy`, `permissions`, `model`, `service_tier`, `effort`, `summary`, `collaboration_mode`, or `personality` is `Some`; otherwise false.

**Call relations**: Called by `send_thread_settings_update` before issuing the RPC.

*Call graph*: called by 1 (send_thread_settings_update).


### `tui/src/app/thread_goal_actions.rs`

`domain_logic` · `interactive goal management during thread viewing and resume`

This module adds goal-management behavior onto `App`. Read-only flows (`open_thread_goal_menu`, `maybe_prompt_resume_paused_goal_after_resume`, `open_thread_goal_editor`) all fetch the current goal from `AppServerSession`, then guard against stale UI by checking `current_displayed_thread_id()` before mutating the chat widget. Missing goals are treated differently depending on context: the menu shows usage text, while editing emits an error plus usage guidance. Editing also resolves file-backed objectives through `goal_files::objective_text_for_edit`, using the app server's codex-home path to materialize editable text. The write path is `set_thread_goal_draft`, which optionally re-reads the current goal to decide whether replacement confirmation is required, materializes any file-backed draft content, clears the old goal first when replacing, then calls `thread_goal_set` with either a fresh active status or an update-specific status/token budget. On success it posts a status summary and may release queued input; on failure it cleans up materialized files and reports a contextual error. `clear_thread_goal` and `set_thread_goal_status` are simpler wrappers around app-server RPCs with the same stale-thread guard. The helper layer contains the replacement-confirmation popup builder, cleanup of temporary goal files, ephemeral-thread error detection by scanning the report chain for known backend messages, and the policy that completed goals can be replaced without confirmation while active/paused/blocked/limited goals require it.

#### Function details

##### `App::open_thread_goal_menu`  (lines 24–52)

```
async fn open_thread_goal_menu(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: Fetches the current goal for a thread and shows either usage/help text or a goal summary in the chat widget. It is the read-only entry point for the thread-goal menu action.

**Data flow**: It takes mutable `self`, a mutable `AppServerSession`, and a `ThreadId`, awaits `app_server.thread_goal_get(thread_id)`, and immediately returns if the currently displayed thread changed meanwhile. On RPC error it formats a user-facing message with `thread_goal_error_message` and adds it to the chat widget. On success, if `response.goal` is `None` it emits `GOAL_USAGE` plus a "No goal is currently set" hint; otherwise it passes the `ThreadGoal` to `chat_widget.show_goal_summary`.

**Call relations**: Invoked by UI actions that open goal details. It delegates all backend access to `thread_goal_get` and all rendering to chat-widget helpers, while enforcing the stale-thread guard before any visible update.

*Call graph*: calls 2 internal fn (thread_goal_error_message, thread_goal_get).


##### `App::maybe_prompt_resume_paused_goal_after_resume`  (lines 54–82)

```
async fn maybe_prompt_resume_paused_goal_after_resume(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: After resuming a thread, checks whether its goal is paused or otherwise blocked and, if so, prompts the user to resume it. Failures are intentionally non-fatal and only logged.

**Data flow**: It reads the goal via `app_server.thread_goal_get(thread_id).await`, returns early if the displayed thread changed, logs a warning on RPC failure, returns silently if there is no goal, and otherwise matches `goal.status`. For `Paused`, `Blocked`, or `UsageLimited`, it calls `chat_widget.show_resume_paused_goal_prompt(thread_id, goal.objective)`; other statuses produce no UI change.

**Call relations**: This method is called from resume/startup flows after a thread has been attached. It depends on the startup gating logic elsewhere to decide whether this prompt should be attempted at all.

*Call graph*: calls 1 internal fn (thread_goal_get); 2 external calls (matches!, warn!).


##### `App::open_thread_goal_editor`  (lines 84–126)

```
async fn open_thread_goal_editor(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: Option<ThreadId>,
    )
```

**Purpose**: Loads the current goal into an editable prompt, resolving file-backed objective text when necessary. If no thread or no goal exists, it shows guidance instead of opening the editor.

**Data flow**: It accepts an optional `ThreadId`; `None` triggers `show_no_thread_goal_to_edit` and returns. Otherwise it fetches the goal with `thread_goal_get`, aborts on stale displayed-thread mismatch, reports read errors via `thread_goal_error_message`, and again falls back to `show_no_thread_goal_to_edit` if `response.goal` is absent. For an existing goal, it computes `codex_home` from `app_server.codex_home_path(&self.config.codex_home)`, awaits `goal_files::objective_text_for_edit(...)`, replaces `goal.objective` on success or emits an error message on failure, rechecks the displayed thread, and finally calls `chat_widget.show_goal_edit_prompt(thread_id, goal)`.

**Call relations**: Triggered by goal-edit UI actions. It composes app-server reads, local file materialization helpers, and chat-widget prompt rendering, with repeated stale-thread checks around async boundaries.

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

**Purpose**: Materializes a goal draft, optionally confirms replacement, clears any existing goal when needed, and submits the new or updated goal to the app server. It is the main write path for goal creation and editing.

**Data flow**: Inputs are `thread_id`, a `goal_files::GoalDraft`, and a `ThreadGoalSetMode`. If the mode is `ConfirmIfExists`, it first reads the current goal; on stale-thread mismatch it returns, on read error it emits a formatted error, and on an unfinished existing goal it opens `show_replace_thread_goal_confirmation` and exits. It then materializes the draft via `goal_files::materialize_goal_draft`, yielding `(objective, output_dir)` or an error that may be shown if the thread is still displayed. For replacement mode it calls `thread_goal_clear`; failure triggers `cleanup_materialized_goal_files`, stale-thread recheck, and an error message. It derives `(status, token_budget)` from the mode, calls `thread_goal_set`, and on success emits an info message using `goal_status_label` and `goal_usage_summary` then asks the chat widget to send queued input. On failure it cleans up materialized files, rechecks thread visibility, and emits a contextual set/replace error.

**Call relations**: This method is invoked by goal-creation/edit flows and by the confirmation popup action. It orchestrates multiple backend RPCs and local file helpers, with cleanup delegated to `cleanup_materialized_goal_files` on any post-materialization failure.

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

**Purpose**: Updates only the status of an existing thread goal, such as pausing or resuming it. It leaves the objective unchanged.

**Data flow**: It sends `app_server.thread_goal_set(thread_id, None, Some(status), None).await`, returns if the displayed thread changed, and then either adds an info message summarizing the resulting goal status/usage or emits an update error via `thread_goal_error_message`.

**Call relations**: Called by goal-status UI actions. It is a narrow wrapper around the app-server RPC and chat-widget messaging.

*Call graph*: calls 3 internal fn (thread_goal_error_message, thread_goal_set, goal_usage_summary); 1 external calls (format!).


##### `App::clear_thread_goal`  (lines 258–284)

```
async fn clear_thread_goal(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
    )
```

**Purpose**: Clears the current goal for a thread and reports whether anything was actually removed. It distinguishes between successful clearing and the no-op case where no goal existed.

**Data flow**: It awaits `app_server.thread_goal_clear(thread_id)`, returns on stale displayed-thread mismatch, and then inspects the response. If `response.cleared` is true it adds a simple "Goal cleared" info message; otherwise it adds "No goal to clear" with a hint explaining that the thread has no goal. Errors are formatted through `thread_goal_error_message` and shown as chat-widget errors.

**Call relations**: Invoked by goal-clear actions. It delegates backend work to `thread_goal_clear` and keeps all user-visible branching local.

*Call graph*: calls 2 internal fn (thread_goal_error_message, thread_goal_clear).


##### `App::show_replace_thread_goal_confirmation`  (lines 286–325)

```
fn show_replace_thread_goal_confirmation(
        &mut self,
        thread_id: ThreadId,
        draft: goal_files::GoalDraft,
    )
```

**Purpose**: Builds and displays the popup that asks the user to confirm replacing an unfinished goal. The popup wires the affirmative choice back into the app event system.

**Data flow**: It takes a `thread_id` and `GoalDraft`, clones the objective for display, moves the draft into a boxed `SelectionAction` closure that sends `AppEvent::SetThreadGoalDraft { mode: ReplaceExisting, ... }`, constructs two `SelectionItem`s (replace and cancel), and passes a populated `SelectionViewParams` with title, truncated objective subtitle, standard footer hint, and items into `chat_widget.show_selection_view`.

**Call relations**: Called only from `set_thread_goal_draft` when replacement confirmation is required. It does not talk to the app server directly; instead it schedules the confirmed action through `AppEvent`.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); called by 1 (set_thread_goal_draft); 3 external calls (default, format!, vec!).


##### `App::show_no_thread_goal_to_edit`  (lines 327–334)

```
fn show_no_thread_goal_to_edit(&mut self)
```

**Purpose**: Shows the standard pair of messages used when the user tries to edit a goal but none exists. It combines an error with usage guidance.

**Data flow**: It writes two messages into the chat widget: an error saying no goal is currently set, then an info message containing `GOAL_USAGE` and a hint to create a goal before editing. It returns no value.

**Call relations**: Used by `open_thread_goal_editor` for both the no-thread and no-goal cases so those branches share identical messaging.

*Call graph*: called by 1 (open_thread_goal_editor).


##### `cleanup_materialized_goal_files`  (lines 337–346)

```
async fn cleanup_materialized_goal_files(
    app_server: &mut AppServerSession,
    output_dir: Option<goal_files::GoalFilePath>,
)
```

**Purpose**: Best-effort cleanup for temporary files created while materializing a goal draft. Failures are logged but not surfaced to the user.

**Data flow**: It takes a mutable `AppServerSession` and an optional `GoalFilePath`. If `output_dir` is `Some`, it awaits `app_server.fs_remove_path(&output_dir)`; on error it logs a warning including the path and error. It returns `()`.

**Call relations**: Called from `set_thread_goal_draft` whenever a materialized draft must be discarded because replacement or setting failed after files were created.

*Call graph*: called by 1 (set_thread_goal_draft); 2 external calls (warn!, fs_remove_path).


##### `thread_goal_error_message`  (lines 348–354)

```
fn thread_goal_error_message(action: &str, err: &color_eyre::Report) -> String
```

**Purpose**: Converts a goal-related backend error into the exact user-facing message shown in the TUI. Ephemeral-thread failures are rewritten into a friendlier explanatory text.

**Data flow**: It takes an action verb like `read` or `clear` plus a `color_eyre::Report`. If `is_ephemeral_thread_goal_error(err)` is true, it returns the constant `EPHEMERAL_THREAD_GOAL_ERROR_MESSAGE`; otherwise it formats `Failed to {action} thread goal: {err}`.

**Call relations**: Used by all goal RPC wrappers and one rendering test. It centralizes the special-case wording so every goal action reports ephemeral-thread limitations consistently.

*Call graph*: calls 1 internal fn (is_ephemeral_thread_goal_error); called by 6 (clear_thread_goal, open_thread_goal_editor, open_thread_goal_menu, set_thread_goal_draft, set_thread_goal_status, thread_goal_ephemeral_error_message_renders_snapshot); 1 external calls (format!).


##### `is_ephemeral_thread_goal_error`  (lines 356–362)

```
fn is_ephemeral_thread_goal_error(err: &color_eyre::Report) -> bool
```

**Purpose**: Detects whether an error chain corresponds to the backend's 'ephemeral threads do not support goals' failure. It matches known message fragments rather than relying on a typed error.

**Data flow**: It iterates over `err.chain()`, converts each cause to a string, and returns true if any cause contains either of the two known ephemeral-thread substrings. Otherwise it returns false.

**Call relations**: This helper is only called by `thread_goal_error_message` to decide whether to substitute the explanatory constant message.

*Call graph*: called by 1 (thread_goal_error_message); 1 external calls (chain).


##### `should_confirm_before_replacing_goal`  (lines 364–375)

```
fn should_confirm_before_replacing_goal(goal: &ThreadGoal) -> bool
```

**Purpose**: Encodes the replacement-confirmation policy for existing goals. Completed goals can be replaced immediately, while unfinished or limited goals require confirmation.

**Data flow**: It reads `goal.status` and returns false only for `ThreadGoalStatus::Complete`; for `Active`, `Paused`, `Blocked`, `UsageLimited`, and `BudgetLimited` it returns true. No state is mutated.

**Call relations**: Called by `set_thread_goal_draft` after reading the current goal to decide whether to open the replacement confirmation popup.

*Call graph*: called by 1 (set_thread_goal_draft).


##### `tests::thread_goal_error_message_explains_temporary_session`  (lines 386–396)

```
fn thread_goal_error_message_explains_temporary_session()
```

**Purpose**: Verifies that ephemeral-thread goal errors are rewritten to the dedicated explanatory message. This protects the user-facing wording contract.

**Data flow**: The test constructs a wrapped `color_eyre` error containing the ephemeral-thread phrase, passes it to `thread_goal_error_message("read", &err)`, and asserts equality with `EPHEMERAL_THREAD_GOAL_ERROR_MESSAGE`.

**Call relations**: Run by the test harness, it directly exercises the ephemeral-error detection and message-rewrite path.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::thread_goal_ephemeral_error_message_renders_snapshot`  (lines 399–419)

```
fn thread_goal_ephemeral_error_message_renders_snapshot()
```

**Purpose**: Checks the rendered terminal snapshot for the ephemeral-thread goal error message. This ensures the multiline explanatory text displays correctly in history.

**Data flow**: It builds the same wrapped ephemeral error, converts the resulting message into a history error cell, renders that cell into a VT100-backed terminal with a fixed viewport using `insert_history_lines`, and snapshots the backend output with `insta`.

**Call relations**: This test complements the pure string assertion by validating the final rendered presentation path through history-cell display and terminal insertion.

*Call graph*: calls 4 internal fn (thread_goal_error_message, with_options, insert_history_lines, new); 4 external calls (new, eyre!, new_error_event, assert_snapshot!).


##### `tests::thread_goal_error_message_preserves_generic_failure_context`  (lines 422–430)

```
fn thread_goal_error_message_preserves_generic_failure_context()
```

**Purpose**: Ensures non-ephemeral goal errors keep their generic failure context instead of being rewritten. The outer wrapped message should remain visible to the user.

**Data flow**: It creates a wrapped generic error (`server disappeared`), passes it to `thread_goal_error_message("read", &err)`, and asserts that the returned string is `Failed to read thread goal: thread/goal/get failed in TUI`.

**Call relations**: Run by the test harness, this test covers the normal formatting branch of `thread_goal_error_message`.

*Call graph*: 2 external calls (assert_eq!, eyre!).


##### `tests::completed_goal_does_not_require_replace_confirmation`  (lines 433–437)

```
fn completed_goal_does_not_require_replace_confirmation()
```

**Purpose**: Verifies the policy exception that completed goals can be replaced without confirmation. This keeps `/goal <objective>` lightweight after finished work.

**Data flow**: It constructs a test goal with `ThreadGoalStatus::Complete`, passes it to `should_confirm_before_replacing_goal`, and asserts the result is false.

**Call relations**: This is a focused unit test for the replacement-confirmation policy helper.

*Call graph*: 1 external calls (assert!).


##### `tests::unfinished_goals_require_replace_confirmation`  (lines 440–450)

```
fn unfinished_goals_require_replace_confirmation()
```

**Purpose**: Checks that all unfinished or limited goal statuses require replacement confirmation. It covers the full set of statuses treated as in-progress enough to warrant a prompt.

**Data flow**: It iterates over `Active`, `Paused`, `Blocked`, `UsageLimited`, and `BudgetLimited`, constructs a test goal for each, calls `should_confirm_before_replacing_goal`, and asserts each result is true.

**Call relations**: This test complements the completed-goal case and locks down the helper's status matrix.

*Call graph*: 1 external calls (assert!).


##### `tests::test_goal`  (lines 452–463)

```
fn test_goal(status: ThreadGoalStatus) -> ThreadGoal
```

**Purpose**: Creates a deterministic `ThreadGoal` fixture for policy tests. The fixture uses fixed timestamps and objective text while varying only the status.

**Data flow**: It takes a `ThreadGoalStatus`, generates a fresh thread id string, fills a `ThreadGoal` with constant objective, zero usage counters, and fixed created/updated timestamps, and returns it.

**Call relations**: Used by the replacement-confirmation tests to avoid repeating goal-construction boilerplate.

*Call graph*: calls 1 internal fn (new).

## 📊 State Registers Touched

- `reg-runtime-environment-catalog` — The validated and cached execution-environment objects built from shell snapshots, local probing, and remote environment inputs.
- `reg-shell-snapshot` — The captured shell/local-machine session snapshot used to construct local execution environments and later cleaned up.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-model-catalog` — The merged local/cached/remote model inventory and presets used for model selection, picker UX, and turn execution.
- `reg-mcp-server-catalog` — The resolved set of MCP server declarations and runtime metadata used for launch, routing, approvals, and per-session availability.
- `reg-skills-catalog` — The loaded and enabled skills catalog, including bundled and external skill metadata and prompt resources.
- `reg-permission-profiles` — The compiled permission-profile identities and concrete permission overlays resolved from config and preserved for round-tripping.
- `reg-sandbox-policy` — The enforceable filesystem, network, and sandbox-mode policy derived from configuration and translated into execution-specific settings.
- `reg-state-runtime` — The shared SQLite-backed state runtime handle that opens, migrates, checks, and shuts down the application's durable databases.
- `reg-thread-metadata-store` — The durable thread metadata and rollout-backed indexing layer used for listing, lookup, reconciliation, resume, and repair.
- `reg-live-thread-registry` — The in-memory registry of active threads and their bindings between persisted rollout history and live thread runtimes.
- `reg-live-session-objects` — The long-lived session objects that own turn submission, event delivery, persistence hooks, approvals, and runtime configuration.
- `reg-session-state` — The mutable session-wide state container holding conversation history, token accounting, sticky grants, prewarm data, and connector selections.
- `reg-turn-state` — The mutable active-turn coordination state for approvals, waiters, mailbox delivery phase, per-turn permissions, and review flags.
- `reg-input-queues` — The buffered pending-input and mailbox queues that coordinate user steering, inter-agent delivery, and turn scheduling.
- `reg-auto-compact-window` — The session's auto-compaction window tracker that scopes token-growth measurement and pending context-reset rollover.
- `reg-turn-context-snapshot` — The immutable per-turn context snapshot freezing session settings, environment, permissions, model metadata, and runtime services for execution.
- `reg-extension-state-store` — The typed host-seeded and extension-owned attachment store that lets extensions keep shared runtime state across callbacks and stages.
- `reg-agent-registry` — The in-memory registry of active agents and spawn reservations, including limits, identity allocation, and per-thread agent metadata.
- `reg-rollout-history-store` — The durable transcript/rollout store that records session events, reconstructs history on resume, and backs import/export operations.
- `reg-app-server-thread-state` — The app-server's mutable per-thread projection state for listeners, subscriptions, active-turn history, interrupts, and ordered commands.
- `reg-goals-store` — The durable and live per-thread goals state, including stored goals and related budgeting metadata that survive resume and feed prompt/context assembly.
- `reg-memories-state` — The persisted and runtime memory subsystem state covering memory records/artifacts, processing mode, startup guards, and memory-backed prompt contributions.
- `reg-prewarmed-session-state` — The live prewarm/warm-start state for a session that is created at startup and then reused by later turns to avoid rebuilding model/session execution scaffolding.
- `reg-file-watch-state` — The long-lived filesystem watch registrations and invalidation state used by skill/plugin/runtime watchers to refresh cached resources when local files change.
- `reg-session-listener-subscriptions` — The live per-session/per-thread listener and subscription registrations that fan out projected events and notifications to app-server, TUI, exec, and extensions.
- `reg-session-resume-selection-state` — The persisted and live resume/fork selection state that records which prior thread/turn/session lineage should be reopened or continued across startup and scripted execution.
- `reg-approved-command-prefixes` — The persisted and runtime set of saved approved command prefixes reused to bypass repeat approval prompts and injected back into context.
- `reg-thread-environment-selection` — The per-thread selected execution environment binding that survives session orchestration and is consumed by turn-context construction and tool execution.
