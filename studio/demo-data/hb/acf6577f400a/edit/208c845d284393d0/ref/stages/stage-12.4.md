# Turn context, history, and realtime prompt assembly  `stage-12.4`

This stage assembles the exact packet of information the model sees for the next turn. It sits right before the model does its main work. Think of it as a packing desk: it gathers the latest settings, recent conversation, small updates, and special startup notes, then puts them into one clean bundle.

`turn_context.rs` creates a fixed per-turn snapshot from changing session settings, permissions, environment choices, and runtime services. `history.rs` keeps the conversation transcript in memory, trims it when needed, and makes sure paired tool calls and results stay consistent. `normalize.rs` repairs or removes malformed history so the prompt stays safe and readable.

Several files add only what changed. `additional_context.rs` tracks keyed extra context and emits updates only for new or changed entries. `updates.rs` compares old and new turn context and turns differences into messages the model can read. `token_budget.rs` adds “tokens remaining” notices when usage crosses meaningful thresholds.

For realtime work, `realtime_context.rs` builds a compact startup summary, and `realtime_prompt.rs` chooses the prompt text itself. `contextual_user_message.rs` separates true user text from internal injected context. `prompt_debug.rs` recreates a single turn for inspection, and `ext/web-search/src/history.rs` makes a much smaller history for web search.

## Files in this stage

### Turn context snapshots
These files define the immutable per-turn context and derive incremental context fragments from changing session state and token usage.

### `core/src/session/turn_context.rs`

`data_model` · `turn creation / config load`

This file provides the data structures and builders for turn-scoped execution context. `TurnSkillsContext` wraps loaded skill metadata plus a mutex-protected set of implicitly seen skills. `TurnEnvironment` captures one selected execution environment, its `environment_id`, `Arc<Environment>`, `PathUri` cwd, optional shell, and a shared future for a shell snapshot; it also exposes helpers for cwd lookup and protocol serialization.

The central type is `TurnContext`, a large immutable snapshot containing model selection, compaction hash, permissions, sandbox/network policy, collaboration mode, selected environments, telemetry, extension data, dynamic tools, timing state, and feature flags. Its methods mostly derive secondary views from that snapshot: effective reasoning effort, effective model context window, whether apps are enabled for the current auth backend, filesystem sandbox context with additional permissions applied, a compact prompt fallback, and a protocol-facing `TurnContextItem`.

The `impl Session` section builds and refreshes these snapshots. `build_per_turn_config` and `build_effective_session_config` derive concrete `Config` values from `SessionConfiguration`. `make_turn_context` assembles a fully populated `TurnContext`, including provider creation, service-tier resolution, local date/time capture, extension store initialization, and skill context insertion. `new_turn_with_sub_id` applies incoming settings updates, emits a protocol error on invalid updates, refreshes managed network proxy state when permission profiles change, and then routes through `new_turn_context_from_configuration`, which resolves environments, model info, multi-agent version, plugin skill roots, loaded skills, and optional final output schema before returning an `Arc<TurnContext>`.

#### Function details

##### `TurnSkillsContext::new`  (lines 37–42)

```
fn new(outcome: Arc<SkillLoadOutcome>) -> Self
```

**Purpose**: Creates the turn-scoped skill context from a loaded skill outcome and initializes the set used to track implicitly invoked skills. The tracking set starts empty and is shared behind an `Arc<Mutex<_>>`.

**Data flow**: It takes `Arc<SkillLoadOutcome>`, stores it in `outcome`, allocates a new empty `HashSet<String>` inside `Arc<Mutex<_>>` for `implicit_invocation_seen_skills`, and returns `TurnSkillsContext`.

**Call relations**: Used when constructing new turn contexts, including `Session::make_turn_context`, and in tests/review-thread setup where a fresh per-turn skill-tracking container is needed.

*Call graph*: called by 4 (spawn_review_thread, build_initial_context_emits_thread_start_skill_warning_on_repeated_builds, build_initial_context_trims_skill_metadata_from_context_window_budget, make_turn_context); 3 external calls (new, new, new).


##### `TurnEnvironment::new`  (lines 57–70)

```
fn new(
        environment_id: String,
        environment: Arc<Environment>,
        cwd: PathUri,
        shell: Option<shell::Shell>,
    ) -> Self
```

**Purpose**: Constructs a selected turn environment record with its identity, environment handle, cwd, optional shell, and an initially empty shell-snapshot future. It is the canonical constructor for environment selections.

**Data flow**: Inputs are `environment_id`, `Arc<Environment>`, `PathUri` cwd, and optional `shell::Shell`. It stores those fields and initializes `shell_snapshot` to a shared ready future yielding `None`. It returns the populated `TurnEnvironment`.

**Call relations**: Called by environment-selection code and tests whenever a new turn environment snapshot entry is created.

*Call graph*: called by 7 (resolve_selection, set_primary_environment_cwd, primary_environment_uses_first_turn_environment, request_permissions_tool_resolves_relative_paths_against_selected_environment, replace_primary_environment_cwd, test_turn_environment, test_turn_environment); 1 external calls (ready).


##### `TurnEnvironment::shell_snapshot`  (lines 72–80)

```
fn shell_snapshot(&self, cwd: &AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the path of a completed shell snapshot only when the queried cwd matches this environment's cwd. This prevents snapshots from being reused across different working directories.

**Data flow**: It takes `&AbsolutePathBuf`, converts it to `PathUri`, compares it to `self.cwd`, peeks at the shared `shell_snapshot` future if the cwd matches, and maps the resolved `ShellSnapshotFile` to its path. It returns `Option<AbsolutePathBuf>`.

**Call relations**: Used by shell-related consumers that need to know whether a snapshot already exists for the current environment/cwd combination.

*Call graph*: calls 1 internal fn (from_abs_path); 1 external calls (peek).


##### `TurnEnvironment::cwd`  (lines 82–84)

```
fn cwd(&self) -> &PathUri
```

**Purpose**: Exposes the selected environment's cwd as a borrowed `PathUri`. It is a simple accessor used by turn-context builders and environment consumers.

**Data flow**: It reads `self.cwd` and returns `&PathUri` without mutation.

**Call relations**: Called during turn-context construction and by code that needs the selected environment cwd without cloning the whole environment.

*Call graph*: called by 1 (build).


##### `TurnEnvironment::selection`  (lines 86–91)

```
fn selection(&self) -> TurnEnvironmentSelection
```

**Purpose**: Converts the environment into the protocol-facing `TurnEnvironmentSelection` shape. This preserves the environment ID and cwd for external consumers.

**Data flow**: It clones `environment_id` and `cwd` into a new `TurnEnvironmentSelection` and returns it.

**Call relations**: Used when serializing or propagating selected environment information outside the internal `TurnEnvironment` type.

*Call graph*: 1 external calls (clone).


##### `TurnEnvironment::fmt`  (lines 95–102)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a custom debug representation for `TurnEnvironment` that includes key fields but remains non-exhaustive. This avoids exposing internal future state in debug output.

**Data flow**: It writes a debug struct containing `environment_id`, `environment`, `cwd`, and `shell`, then marks it non-exhaustive. It returns the formatter result.

**Call relations**: Invoked implicitly by Rust formatting/debugging infrastructure.

*Call graph*: 1 external calls (debug_struct).


##### `TurnContext::permission_profile`  (lines 167–169)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns a cloned copy of the turn's resolved permission profile. This avoids exposing mutable access to the stored profile.

**Data flow**: It reads `self.permission_profile`, clones it, and returns the clone.

**Call relations**: Used widely by permission-sensitive code, analytics, and protocol serialization whenever a turn-scoped permission profile is needed.

*Call graph*: called by 10 (apply_patch, build_permissions_update_item, should_install_mcp_dependencies, augment_mcp_tool_request_meta_with_sandbox_state, install_host_owned_codex_apps_manager, refresh_mcp_servers_inner, track_turn_resolved_config_analytics, to_turn_context_item, apply_spawn_agent_runtime_overrides, test_exec_request); 1 external calls (clone).


##### `TurnContext::file_system_sandbox_policy`  (lines 171–173)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Returns the filesystem sandbox policy derived from the turn's permission profile. It is a convenience wrapper over the profile API.

**Data flow**: It reads `self.permission_profile` and returns `permission_profile.file_system_sandbox_policy()`.

**Call relations**: Used by sandbox-policy consumers and by `non_legacy_file_system_sandbox_policy` when comparing legacy and split-policy representations.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 3 (non_legacy_file_system_sandbox_policy, effective_patch_permissions, run).


##### `TurnContext::network_sandbox_policy`  (lines 175–177)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Returns the network sandbox policy derived from the turn's permission profile. This is the turn-scoped source of truth for network access checks.

**Data flow**: It reads `self.permission_profile` and returns `permission_profile.network_sandbox_policy()`.

**Call relations**: Used by analytics and runtime code that needs to know whether network access is enabled for the turn.

*Call graph*: calls 1 internal fn (network_sandbox_policy); called by 2 (track_turn_resolved_config_analytics, run).


##### `TurnContext::sandbox_policy`  (lines 179–185)

```
fn sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Builds the legacy combined sandbox policy view from the turn's permission profile and cwd. This preserves compatibility with older consumers that still expect the combined form.

**Data flow**: It reads `self.permission_profile` and deprecated `self.cwd`, passes them to `compatibility_sandbox_policy_for_permission_profile`, and returns the resulting `SandboxPolicy`.

**Call relations**: Used by protocol serialization and compatibility paths while the system transitions toward split filesystem/network sandbox policies.

*Call graph*: called by 4 (augment_mcp_tool_request_meta_with_sandbox_state, file_system_policy_with_unreadable_glob, non_legacy_file_system_sandbox_policy, to_turn_context_item); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `TurnContext::effective_reasoning_effort`  (lines 187–195)

```
fn effective_reasoning_effort(&self) -> Option<ReasoningEffortConfig>
```

**Purpose**: Computes the reasoning effort that should actually be used for this turn, but only for models that support reasoning summaries. Unsupported models always yield `None`.

**Data flow**: It reads `self.model_info.supports_reasoning_summaries`, `self.reasoning_effort`, and `self.model_info.default_reasoning_level`. If summaries are supported, it returns the explicit effort or the model default; otherwise it returns `None`.

**Call relations**: Used by tracing and metadata builders that need the effective reasoning level rather than the raw configured value.

*Call graph*: called by 3 (build_mcp_tool_call_request_meta, mcp_turn_metadata_context, effective_reasoning_effort_for_tracing).


##### `TurnContext::effective_reasoning_effort_for_tracing`  (lines 197–201)

```
fn effective_reasoning_effort_for_tracing(&self) -> String
```

**Purpose**: Formats the effective reasoning effort into a tracing-friendly string. Missing effort is represented as the literal string `default`.

**Data flow**: It calls `effective_reasoning_effort()`, converts `Some(effort)` to `effort.to_string()`, and otherwise returns `"default"`.

**Call relations**: Used by streaming/tracing code to annotate spans with a stable reasoning-effort label.

*Call graph*: calls 1 internal fn (effective_reasoning_effort).


##### `TurnContext::model_context_window`  (lines 203–210)

```
fn model_context_window(&self) -> Option<i64>
```

**Purpose**: Returns the effective usable context window for the current model after applying the model's configured context-window percentage. This is the token budget used by compaction and token accounting.

**Data flow**: It reads `model_info.effective_context_window_percent`, calls `model_info.resolved_context_window()`, and if present scales the raw context window by the percentage using saturating integer arithmetic. It returns `Option<i64>`.

**Call relations**: Used throughout turn execution for token trimming, token-budget recording, compaction decisions, and token-usage recomputation.

*Call graph*: calls 1 internal fn (resolved_context_window); called by 7 (trim_function_call_history_to_fit_context_window, build_initial_context, recompute_token_usage, record_token_usage_info, set_total_tokens_full, maybe_record_token_budget_remaining_context, auto_compact_token_status).


##### `TurnContext::apps_enabled`  (lines 212–218)

```
fn apps_enabled(&self) -> bool
```

**Purpose**: Determines whether app/MCP connector features should be exposed for this turn, taking into account both managed feature flags and whether the current auth backend uses Codex. This makes app availability auth-sensitive.

**Data flow**: It inspects `auth_manager` to see whether current auth uses the Codex backend, then asks `self.features.apps_enabled_for_auth(uses_codex_backend)`. It returns a boolean.

**Call relations**: Used by prompt/context builders and tool construction to decide whether connector inventories and app tools should be loaded.

*Call graph*: called by 3 (build_initial_context, build_skills_and_plugins, built_tools); 1 external calls (apps_enabled_for_auth).


##### `TurnContext::tool_environment_mode`  (lines 220–222)

```
fn tool_environment_mode(&self) -> ToolEnvironmentMode
```

**Purpose**: Summarizes the selected environment count into a `ToolEnvironmentMode`. This lets downstream tool logic know whether it is operating in single- or multi-environment mode.

**Data flow**: It reads `self.environments.turn_environments.len()`, passes the count to `ToolEnvironmentMode::from_count`, and returns the resulting enum.

**Call relations**: Used by tool/runtime code that needs a compact representation of environment topology.

*Call graph*: calls 1 internal fn (from_count).


##### `TurnContext::with_model`  (lines 224–334)

```
async fn with_model(
        &self,
        model: String,
        models_manager: &SharedModelsManager,
    ) -> Self
```

**Purpose**: Clones the current turn context while swapping in a different model and recomputing all model-dependent fields such as tool mode, reasoning effort, truncation policy, telemetry labels, and available models. It preserves the rest of the turn snapshot.

**Data flow**: Inputs are `&self`, a model slug, and the shared models manager. It clones and mutates the underlying config to set the new model, fetches fresh `ModelInfo`, recomputes `tool_mode`, supported reasoning levels, chosen reasoning effort, collaboration mode, truncation policy, telemetry model labels, and available models, then constructs and returns a new `TurnContext` carrying over the remaining fields and copying atomic warning flags from the original.

**Call relations**: Used by pre-turn compaction logic when evaluating whether history should be compacted under the previous model's constraints. It delegates model lookup to `models_manager.get_model_info` and model listing to `list_models`.

*Call graph*: calls 1 internal fn (with_updates); 18 external calls (clone, new, load, new, clone, get_model_info, list_models, clone, clone, clone (+8 more)).


##### `TurnContext::resolve_path`  (lines 337–341)

```
fn resolve_path(&self, path: Option<String>) -> AbsolutePathBuf
```

**Purpose**: Resolves an optional relative path against the turn's legacy cwd, defaulting to the cwd itself when no path is provided. This is a deprecated compatibility helper.

**Data flow**: It takes `Option<String>`, and either returns a clone of deprecated `self.cwd` or joins the provided path onto it. It returns `AbsolutePathBuf`.

**Call relations**: Used by older execution-parameter code that still resolves paths against the legacy single cwd instead of selected environment cwd.

*Call graph*: called by 1 (to_exec_params).


##### `TurnContext::file_system_sandbox_context`  (lines 343–373)

```
fn file_system_sandbox_context(
        &self,
        additional_permissions: Option<AdditionalPermissionProfile>,
        cwd: &PathUri,
    ) -> FileSystemSandboxContext
```

**Purpose**: Builds the runtime filesystem sandbox context for a tool invocation, optionally layering additional permissions on top of the turn's base permission profile. It also carries Windows sandbox settings and the legacy-landlock feature flag.

**Data flow**: Inputs are optional `AdditionalPermissionProfile` and a selected environment `cwd`. It derives base runtime permissions from `self.permission_profile`, applies `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy`, reconstructs a `PermissionProfile` with the original enforcement mode, and returns `FileSystemSandboxContext` containing the resulting permissions, cwd, Windows sandbox settings, and `use_legacy_landlock` flag.

**Call relations**: Used by tool execution code when it needs a concrete sandbox context for a command or filesystem operation.

*Call graph*: calls 5 internal fn (enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions, effective_file_system_sandbox_policy, effective_network_sandbox_policy); 2 external calls (use_legacy_landlock, clone).


##### `TurnContext::non_legacy_file_system_sandbox_policy`  (lines 375–389)

```
fn non_legacy_file_system_sandbox_policy(&self) -> Option<FileSystemSandboxPolicy>
```

**Purpose**: Returns the split filesystem sandbox policy only when it differs from the legacy combined-policy projection. This keeps serialized turn-context payloads stable while both representations coexist.

**Data flow**: It computes the legacy filesystem policy from `sandbox_policy()` and deprecated `cwd`, computes the current split policy from `file_system_sandbox_policy()`, compares them, and returns `Some(policy)` only when they differ; otherwise `None`.

**Call relations**: Used by `to_turn_context_item` so protocol payloads omit redundant split-policy data.

*Call graph*: calls 3 internal fn (file_system_sandbox_policy, sandbox_policy, from_legacy_sandbox_policy_for_cwd); called by 1 (to_turn_context_item).


##### `TurnContext::compact_prompt`  (lines 391–395)

```
fn compact_prompt(&self) -> &str
```

**Purpose**: Returns the configured compaction prompt text for this turn, falling back to the default summarization prompt when none was configured. This centralizes the fallback behavior.

**Data flow**: It reads `self.compact_prompt`, returns its `&str` if present, otherwise returns `compact::SUMMARIZATION_PROMPT`.

**Call relations**: Used by compaction code that needs the prompt text to summarize prior context.


##### `TurnContext::to_turn_context_item`  (lines 397–420)

```
fn to_turn_context_item(&self) -> TurnContextItem
```

**Purpose**: Serializes the turn context into the protocol-level `TurnContextItem` stored in conversation history and context windows. It includes model, permissions, sandboxing, workspace roots, collaboration metadata, and temporal context.

**Data flow**: It reads workspace roots from config, deprecated cwd, current date/timezone, approval policy, sandbox policy, permission profile, network item, optional split filesystem policy, model slug, compaction hash, personality, collaboration mode, multi-agent version, realtime flag, and reasoning effort. It packages those into a `TurnContextItem` and returns it.

**Call relations**: Used when recording context updates and when starting new context windows so the turn's execution context becomes part of persisted conversation state.

*Call graph*: calls 6 internal fn (value, non_legacy_file_system_sandbox_policy, permission_profile, sandbox_policy, turn_context_network_item, to_path_buf); called by 2 (maybe_start_new_context_window, record_context_updates_and_set_reference_context_item); 1 external calls (clone).


##### `TurnContext::turn_context_network_item`  (lines 422–441)

```
fn turn_context_network_item(&self) -> Option<TurnContextNetworkItem>
```

**Purpose**: Builds the protocol-facing network-permissions summary from the config layer stack's network requirements. It exposes allowed and denied domains when such requirements exist.

**Data flow**: It reads `self.config.config_layer_stack.requirements().network`, extracts allowed and denied domain lists if present, and returns `Some(TurnContextNetworkItem)` or `None` when no network requirements are configured.

**Call relations**: Used only by `to_turn_context_item` as the network subsection of serialized turn context.

*Call graph*: called by 1 (to_turn_context_item).


##### `local_time_context`  (lines 444–452)

```
fn local_time_context() -> (String, String)
```

**Purpose**: Captures the current local date and timezone for insertion into a new turn context. If timezone detection fails, it falls back to UTC date and `Etc/UTC`.

**Data flow**: It calls `iana_time_zone::get_timezone()`. On success it returns `(Local::now().format("%Y-%m-%d"), timezone)`; on failure it returns `(Utc::now().format("%Y-%m-%d"), "Etc/UTC")`.

**Call relations**: Called by `Session::make_turn_context` so each turn snapshot carries date/time context for prompts and metadata.

*Call graph*: called by 1 (make_turn_context); 3 external calls (now, now, get_timezone).


##### `Session::build_per_turn_config`  (lines 456–493)

```
fn build_per_turn_config(
        session_configuration: &SessionConfiguration,
        cwd: AbsolutePathBuf,
    ) -> Config
```

**Purpose**: Derives a mutable per-turn `Config` from the session configuration and a chosen cwd, applying workspace roots, permission profile, reasoning settings, service tier, personality, approvals reviewer, and a permission-compatible web-search mode. It is the main bridge from session-level settings to turn-level config.

**Data flow**: Inputs are `&SessionConfiguration` and a concrete cwd. It clones the original config, overwrites cwd and workspace roots, updates permission roots, copies reasoning/service-tier/personality/reviewer settings, applies the permission profile to permissions, resolves a web-search mode compatible with the permission profile, warns if the constrained value rejects the resolved mode, restores managed features from the original config, and returns the resulting `Config`.

**Call relations**: Used by `build_effective_session_config` and `new_turn_context_from_configuration` whenever a concrete turn config must be materialized from session settings.

*Call graph*: calls 2 internal fn (apply_permission_profile_to_permissions, permission_profile); 1 external calls (warn!).


##### `Session::build_effective_session_config`  (lines 495–507)

```
fn build_effective_session_config(
        session_configuration: &SessionConfiguration,
    ) -> Config
```

**Purpose**: Builds the effective session-wide config snapshot used for contributor notifications and comparisons. It starts from per-turn config at the session cwd and then overlays model and approval-policy selections from collaboration/session settings.

**Data flow**: It takes `&SessionConfiguration`, calls `build_per_turn_config` with the session cwd, sets `config.model` from collaboration mode, copies approval policy and workspace roots into both top-level config and permissions, and returns the resulting `Config`.

**Call relations**: Used by `new_turn_with_sub_id` when notifying config contributors about before/after effective configuration changes.

*Call graph*: calls 1 internal fn (cwd); 1 external calls (build_per_turn_config).


##### `Session::make_turn_context`  (lines 510–634)

```
fn make_turn_context(
        thread_id: ThreadId,
        session_id: SessionId,
        auth_manager: Option<Arc<AuthManager>>,
        session_telemetry: &SessionTelemetry,
        provider: ModelP
```

**Purpose**: Constructs a fully populated `TurnContext` from resolved session configuration, model metadata, selected environments, and runtime services. It is the low-level assembler for all turn snapshots.

**Data flow**: It takes thread/session IDs, auth manager, telemetry, provider info, session configuration, multi-agent version, shell details, per-turn config, `ModelInfo`, models manager, optional network proxy, environment snapshot, cwd, sub-ID, and loaded skills. It computes reasoning settings, telemetry labels, provider handle, available models, unified exec shell mode, tool mode, service tier, turn metadata state, local date/time, extension data seeded with `HostLoadedSkills`, and then returns a `TurnContext` with all fields initialized, including fresh timing state and warning flags.

**Call relations**: Called by `new_turn_context_from_configuration` after all prerequisite resolution is complete. It centralizes field population so both regular and startup-prewarm turn creation share the same assembly logic.

*Call graph*: calls 8 internal fn (new, permission_profile, new, local_time_context, tool_user_shell_type, new, new, for_session); 14 external calls (clone, new, new, new, try_list_models, clone, create_model_provider, unified_exec_feature_mode_for_features, default, clone (+4 more)).


##### `Session::new_turn_with_sub_id`  (lines 636–703)

```
async fn new_turn_with_sub_id(
        &self,
        sub_id: String,
        updates: SessionSettingsUpdate,
    ) -> CodexResult<Arc<TurnContext>>
```

**Purpose**: Applies a `SessionSettingsUpdate`, validates it, updates session configuration and environment selections, notifies config contributors, refreshes managed network proxy state if permissions changed, and returns a new turn context for the updated configuration. Invalid updates are converted into protocol error events and `CodexErr::InvalidRequest`.

**Data flow**: Inputs are `&self`, a new turn sub-ID, and `SessionSettingsUpdate`. It locks session state, attempts to apply the update to a cloned `SessionConfiguration`, computes whether the permission profile changed, optionally snapshots previous/new effective configs for contributor notifications, updates selected environments, stores the new session configuration, emits an error event on failure, notifies config contributors, refreshes managed network proxy if needed, and finally awaits `new_turn_from_configuration`. It returns `CodexResult<Arc<TurnContext>>`.

**Call relations**: Called by higher-level session code when a new turn begins with settings changes. It delegates actual turn-context construction to `new_turn_from_configuration` after handling mutable session-state updates.

*Call graph*: calls 1 internal fn (new_turn_from_configuration); 2 external calls (InvalidRequest, Error).


##### `Session::new_turn_from_configuration`  (lines 705–718)

```
async fn new_turn_from_configuration(
        &self,
        sub_id: String,
        session_configuration: SessionConfiguration,
        final_output_json_schema: Option<Option<Value>>,
    ) -> Arc<
```

**Purpose**: Builds a regular turn context from an already-resolved `SessionConfiguration`. It is a thin wrapper that selects the normal multi-agent runtime mode.

**Data flow**: It takes a sub-ID, session configuration, and optional final-output-schema override, forwards them to `new_turn_context_from_configuration` with `TurnMultiAgentRuntime::ResolveAndStore`, and returns the resulting `Arc<TurnContext>`.

**Call relations**: Used by `new_turn_with_sub_id` and default-turn helpers to create ordinary turn contexts.

*Call graph*: calls 1 internal fn (new_turn_context_from_configuration); called by 2 (new_default_turn_with_sub_id, new_turn_with_sub_id).


##### `Session::new_startup_prewarm_turn_from_configuration`  (lines 720–732)

```
async fn new_startup_prewarm_turn_from_configuration(
        &self,
        sub_id: String,
        session_configuration: SessionConfiguration,
    ) -> Arc<TurnContext>
```

**Purpose**: Builds a preview turn context for startup prewarm without resolving/storing multi-agent runtime state the same way a real turn does. It selects the preview runtime mode.

**Data flow**: It takes a sub-ID and session configuration, forwards them to `new_turn_context_from_configuration` with no final-output-schema override and `TurnMultiAgentRuntime::Preview`, and returns the resulting `Arc<TurnContext>`.

**Call relations**: Used only by startup prewarm code to create a lightweight turn context suitable for warming model connections.

*Call graph*: calls 1 internal fn (new_turn_context_from_configuration); called by 1 (new_startup_prewarm_turn_with_sub_id).


##### `Session::new_turn_context_from_configuration`  (lines 735–834)

```
async fn new_turn_context_from_configuration(
        &self,
        sub_id: String,
        session_configuration: SessionConfiguration,
        final_output_json_schema: Option<Option<Value>>,
```

**Purpose**: Resolves all dynamic inputs needed for a new turn context—selected environments, cwd, MCP approval state, model info, multi-agent version, plugin skill roots, loaded skills, network proxy, and optional final schema—then assembles the final `Arc<TurnContext>`. It is the main async builder behind all turn creation paths.

**Data flow**: Inputs are `&self`, sub-ID, `SessionConfiguration`, optional nested final-output-schema override, and a `TurnMultiAgentRuntime`. It snapshots selected environments, chooses a primary cwd with fallback to session cwd, builds per-turn config, updates MCP connection manager approval/permission state, fetches `ModelInfo`, resolves multi-agent version according to runtime mode, loads plugins and effective plugin skill roots, loads skills against the primary environment filesystem when available, calls `make_turn_context`, sets `realtime_active`, applies any final output schema override, wraps the context in `Arc`, and may spawn git enrichment when there is a single local environment. It returns `Arc<TurnContext>`.

**Call relations**: Called by both regular and startup-prewarm turn constructors. It delegates low-level assembly to `make_turn_context` after resolving all async dependencies.

*Call graph*: calls 1 internal fn (permission_profile); called by 2 (new_startup_prewarm_turn_from_configuration, new_turn_from_configuration); 4 external calls (clone, new, build_per_turn_config, make_turn_context).


##### `Session::maybe_emit_unknown_model_warning_for_turn`  (lines 836–849)

```
async fn maybe_emit_unknown_model_warning_for_turn(&self, tc: &TurnContext)
```

**Purpose**: Warns the client when the selected model is using fallback metadata because no exact model metadata was found. This surfaces a potentially degraded execution mode to the user.

**Data flow**: It takes `&self` and `&TurnContext`, checks `tc.model_info.used_fallback_model_metadata`, and if true sends a `WarningEvent` describing the missing metadata and possible performance issues. It returns no value.

**Call relations**: Called after turn creation by code that wants to surface model-resolution problems without failing the turn.

*Call graph*: 2 external calls (format!, Warning).


##### `Session::new_default_turn`  (lines 851–854)

```
async fn new_default_turn(&self) -> Arc<TurnContext>
```

**Purpose**: Creates a new default turn using an internally generated sub-ID. It is a convenience wrapper over the more explicit default-turn constructor.

**Data flow**: It generates the next internal sub-ID and forwards to `new_default_turn_with_sub_id`, returning the resulting `Arc<TurnContext>`.

**Call relations**: Used by callers that want a standard new turn without supplying their own sub-ID.

*Call graph*: calls 1 internal fn (new_default_turn_with_sub_id).


##### `Session::new_default_turn_with_sub_id`  (lines 856–864)

```
async fn new_default_turn_with_sub_id(&self, sub_id: String) -> Arc<TurnContext>
```

**Purpose**: Creates a default turn context from the current session configuration using a caller-provided sub-ID. It is the standard path for ordinary turns without settings updates.

**Data flow**: It fetches the current default session configuration via `default_turn_configuration`, then calls `new_turn_from_configuration` with no final-output-schema override and returns the resulting `Arc<TurnContext>`.

**Call relations**: Called by `new_default_turn` and other code paths that need a fresh turn context from current session settings.

*Call graph*: calls 2 internal fn (default_turn_configuration, new_turn_from_configuration); called by 1 (new_default_turn).


##### `Session::new_startup_prewarm_turn_with_sub_id`  (lines 866–873)

```
async fn new_startup_prewarm_turn_with_sub_id(
        &self,
        sub_id: String,
    ) -> Arc<TurnContext>
```

**Purpose**: Creates a startup-prewarm turn context from the current default session configuration. This is the public wrapper used by prewarm logic.

**Data flow**: It loads the default session configuration via `default_turn_configuration`, forwards it to `new_startup_prewarm_turn_from_configuration`, and returns the resulting `Arc<TurnContext>`.

**Call relations**: Used by startup prewarm code before building tools and warming the websocket.

*Call graph*: calls 2 internal fn (default_turn_configuration, new_startup_prewarm_turn_from_configuration).


##### `Session::default_turn_configuration`  (lines 875–878)

```
async fn default_turn_configuration(&self) -> SessionConfiguration
```

**Purpose**: Returns a clone of the current session configuration to use as the basis for a new turn. It is the simplest configuration snapshot accessor in this file.

**Data flow**: It locks session state, clones `state.session_configuration`, and returns the clone.

**Call relations**: Used by both default-turn and startup-prewarm turn constructors as their starting configuration snapshot.

*Call graph*: called by 2 (new_default_turn_with_sub_id, new_startup_prewarm_turn_with_sub_id).


### `core/src/session/token_budget.rs`

`domain_logic` · `mid-turn, immediately after sampling token usage is known`

This file contains a single turn-time helper that watches token consumption before and after a sampling request and decides whether to inject a `TokenBudgetRemainingContext` item into conversation history. The logic is intentionally conservative: it exits immediately if `Feature::TokenBudget` is disabled, if the current `TurnContext` cannot report a model context window, if that window is non-positive, or if token usage did not increase. Before comparing percentages, both token counts are clamped to zero to avoid negative values affecting threshold math.

The threshold check uses the fixed `TOKEN_BUDGET_USAGE_THRESHOLDS` array `[25, 50, 75]` and compares percentages via integer multiplication rather than floating point. It detects only crossings that move from below a threshold to at-or-above it during this sampling step, using `saturating_mul` to avoid overflow. If no threshold was crossed, nothing is recorded. When a crossing is detected, the function computes remaining tokens as `model_context_window - tokens_after_sampling`, saturates at zero, wraps that value in `crate::context::TokenBudgetRemainingContext`, converts it into a `ContextualUserFragment`, and persists it through `Session::record_conversation_items`. The result is a sparse, milestone-based context update rather than noisy per-sample bookkeeping.

#### Function details

##### `maybe_record_token_budget_remaining_context`  (lines 8–44)

```
async fn maybe_record_token_budget_remaining_context(
    sess: &Session,
    turn_context: &TurnContext,
    tokens_before_sampling: i64,
    tokens_after_sampling: i64,
)
```

**Purpose**: Checks whether the latest sampling step crossed one of the configured token-usage percentages and, if so, records a contextual fragment describing how many tokens remain in the model window. It avoids emitting anything for disabled feature flags, missing context-window metadata, non-increasing usage, or threshold-free transitions.

**Data flow**: Inputs are `&Session`, `&TurnContext`, and the token counts before and after sampling. It reads the TokenBudget feature flag from `turn_context.features`, reads the effective context window via `model_context_window()`, clamps token counts to non-negative values, tests threshold crossings against the `[25, 50, 75]` constants using saturating integer arithmetic, computes `tokens_left`, constructs `TokenBudgetRemainingContext::new(tokens_left)`, converts it with `ContextualUserFragment::into`, and writes the resulting single `ResponseItem` into session history with `record_conversation_items`. It returns no value.

**Call relations**: This helper is invoked by `run_turn` after a sampling request completes and post-sampling token usage has been computed. It delegates object construction to `new` and `into`, and delegates persistence to `Session::record_conversation_items` so the token-budget note becomes part of the conversation context seen by later requests.

*Call graph*: calls 3 internal fn (into, new, model_context_window); called by 1 (run_turn); 2 external calls (record_conversation_items, from_ref).


### `core/src/state/additional_context.rs`

`domain_logic` · `request/context assembly when additional context updates arrive`

This file defines `AdditionalContextStore`, a small state holder around `BTreeMap<String, AdditionalContextEntry>`. Its only behavior, `merge`, compares a newly supplied map of additional context against the store's current contents and emits `ResponseInputItem`s only for keys whose value or kind changed. The use of `BTreeMap` gives deterministic key ordering, which in turn makes the emitted fragment order stable across runs when the input map is stable.

For each changed entry, the function inspects `AdditionalContextEntry.kind`. `AdditionalContextKind::Untrusted` becomes an `AdditionalContextUserFragment`, while `AdditionalContextKind::Application` becomes an `AdditionalContextDeveloperFragment`; both are constructed with the concrete key and value strings and immediately converted into `ResponseInputItem`s via `ContextualUserFragment`/fragment conversion methods. After collecting all changed fragments, the store replaces its entire internal map with the new `values`, making the provided map the new baseline for future diffs. An important design detail is that removals do not produce explicit tombstone fragments here; absent keys simply disappear from the stored baseline, and only present changed entries generate output.

#### Function details

##### `AdditionalContextStore::merge`  (lines 16–36)

```
fn merge(
        &mut self,
        values: BTreeMap<String, AdditionalContextEntry>,
    ) -> Vec<ResponseInputItem>
```

**Purpose**: Diffs a new set of additional-context entries against the stored baseline and returns response items for only the changed entries.

**Data flow**: Takes `&mut self` and `values: BTreeMap<String, AdditionalContextEntry>`; iterates the new map, filters to entries where `self.values.get(key) != Some(value)`, converts each changed entry into either an `AdditionalContextUserFragment` or `AdditionalContextDeveloperFragment` and then into `ResponseInputItem`, collects those items into a `Vec<ResponseInputItem>`, replaces `self.values` with the new map, and returns the collected fragments.

**Call relations**: Used by higher-level state/update code when additional context is refreshed, serving as the diffing step between protocol entries and prompt/input fragments.


### `core/src/context_manager/updates.rs`

`domain_logic` · `request handling`

This file is the diffing layer between persisted turn settings and the next turn’s model-visible context. Each helper compares some aspect of the previous baseline (`TurnContextItem` and/or `PreviousTurnSettings`) against the current `TurnContext` and returns either a rendered instruction string or a contextual user `ResponseItem`. Environment changes are special: `build_environment_update_item` only runs when `include_environment_context` is enabled, reconstructs `EnvironmentContext` from both the previous item and current turn, ignores shell-name differences via `equals_except_shell`, and emits a `ContextualUserFragment` diff when something substantive changed.

Developer-side updates are assembled as text sections. Permissions updates depend on `include_permissions_instructions` and compare permission profile plus approval policy before rendering `PermissionsInstructions`. Collaboration mode updates only emit when the mode changed and the new mode has non-empty developer instructions. Realtime updates encode transitions into start, start-with-custom-instructions, or end messages, with a fallback path that consults `PreviousTurnSettings` when no persisted `TurnContextItem` exists. Personality updates are gated by a feature flag and only apply when the model slug is unchanged; model switches are handled separately by rendering full model instructions.

`build_text_message` is the common constructor that turns non-empty text sections into a `ResponseItem::Message` with `ContentItem::InputText` fragments. `build_settings_update_items` orchestrates the whole diff: it collects developer update sections in a deliberate order—model switch first, then permissions, collaboration mode, realtime, personality—builds at most one developer message and one contextual user message, and returns them in that order.

#### Function details

##### `build_environment_update_item`  (lines 21–40)

```
fn build_environment_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
    shell: &Shell,
) -> Option<ResponseItem>
```

**Purpose**: Builds a contextual user message describing environment-context changes between the previous baseline and the next turn.

**Data flow**: Takes optional previous `TurnContextItem`, current `TurnContext`, and `Shell`. If environment context inclusion is disabled or no previous item exists, returns `None`. Otherwise it reconstructs previous and next `EnvironmentContext`s, compares them ignoring shell differences, and when changed converts the diff into a `ResponseItem` via `ContextualUserFragment::into`.

**Call relations**: Called by `build_settings_update_items` to produce the optional user-side context diff item.

*Call graph*: calls 5 internal fn (into, diff_from_turn_context_item, from_turn_context, from_turn_context_item, name); called by 1 (build_settings_update_items).


##### `build_permissions_update_item`  (lines 42–71)

```
fn build_permissions_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
    exec_policy: &Policy,
) -> Option<String>
```

**Purpose**: Builds rendered developer instructions when permission profile or approval policy changed.

**Data flow**: Takes optional previous `TurnContextItem`, current `TurnContext`, and exec `Policy`. It returns `None` if permission instructions are disabled, no previous item exists, or both permission profile and approval policy are unchanged. Otherwise it renders `PermissionsInstructions::from_permission_profile(...)` using current permission settings, reviewer config, cwd, and feature flags.

**Call relations**: One of the developer-section producers aggregated by `build_settings_update_items`.

*Call graph*: calls 2 internal fn (permission_profile, from_permission_profile); called by 1 (build_settings_update_items).


##### `build_collaboration_mode_update_item`  (lines 73–92)

```
fn build_collaboration_mode_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: Builds rendered collaboration-mode developer instructions when the collaboration mode changed.

**Data flow**: Checks the config flag, requires a previous `TurnContextItem`, compares `prev.collaboration_mode` to `next.collaboration_mode`, and if changed tries `CollaborationModeInstructions::from_collaboration_mode(...)?` before rendering. Returns `None` if unchanged or if the new mode has no developer instructions.

**Call relations**: Called by `build_settings_update_items` after model-switch and permissions sections.

*Call graph*: calls 1 internal fn (from_collaboration_mode); called by 1 (build_settings_update_items).


##### `build_realtime_update_item`  (lines 94–121)

```
fn build_realtime_update_item(
    previous: Option<&TurnContextItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: Builds rendered instructions for entering or leaving realtime mode based on previous and next realtime state.

**Data flow**: Matches `(previous.realtime_active, next.realtime_active)`. It returns realtime-end instructions when transitioning from active to inactive, realtime-start or realtime-start-with-custom-instructions when transitioning to active, `None` when state is unchanged, and a fallback realtime-end when no previous item exists but `PreviousTurnSettings` says realtime had been active.

**Call relations**: Used both for initial-context construction and incremental settings updates.

*Call graph*: calls 2 internal fn (new, new); called by 2 (build_initial_realtime_item, build_settings_update_items).


##### `build_initial_realtime_item`  (lines 123–129)

```
fn build_initial_realtime_item(
    previous: Option<&TurnContextItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: Provides the initial realtime instruction item using the same transition logic as incremental updates.

**Data flow**: Simply forwards `previous`, `previous_turn_settings`, and `next` to `build_realtime_update_item` and returns its result.

**Call relations**: Called by initial-context construction to avoid duplicating realtime transition logic.

*Call graph*: calls 1 internal fn (build_realtime_update_item); called by 1 (build_initial_context).


##### `build_personality_update_item`  (lines 131–153)

```
fn build_personality_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
    personality_feature_enabled: bool,
) -> Option<String>
```

**Purpose**: Builds rendered personality instructions when personality changed without switching models and the feature is enabled.

**Data flow**: Returns `None` if the personality feature is disabled, no previous item exists, or the model slug changed. If `next.personality` is set and differs from `previous.personality`, it looks up a message with `personality_message_for` and wraps it in `PersonalitySpecInstructions::new(...).render()`.

**Call relations**: Included as the last developer-section diff in `build_settings_update_items`.

*Call graph*: calls 1 internal fn (personality_message_for); called by 1 (build_settings_update_items).


##### `personality_message_for`  (lines 155–164)

```
fn personality_message_for(
    model_info: &ModelInfo,
    personality: Personality,
) -> Option<String>
```

**Purpose**: Looks up the model-specific personality message text for a given `Personality`.

**Data flow**: Reads `model_info.model_messages`, asks the spec for `get_personality_message(Some(personality))`, filters out empty strings, and returns `Option<String>`.

**Call relations**: Used by both incremental personality updates and initial-context construction.

*Call graph*: called by 2 (build_personality_update_item, build_initial_context).


##### `build_model_instructions_update_item`  (lines 166–181)

```
fn build_model_instructions_update_item(
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: Builds rendered model-switch instructions when the active model slug changed since the previous turn settings.

**Data flow**: Requires `previous_turn_settings`; if the previous model equals `next.model_info.slug`, returns `None`. Otherwise it fetches `next.model_info.get_model_instructions(next.personality)`, drops empty instruction strings, and wraps non-empty text in `ModelSwitchInstructions::new(...).render()`.

**Call relations**: Placed first in the developer update sequence so model-specific guidance precedes other diffs.

*Call graph*: calls 1 internal fn (new); called by 2 (build_settings_update_items, build_initial_context).


##### `build_developer_update_item`  (lines 183–185)

```
fn build_developer_update_item(text_sections: Vec<String>) -> Option<ResponseItem>
```

**Purpose**: Builds a developer-role message from a list of rendered instruction sections.

**Data flow**: Forwards `text_sections` to `build_text_message("developer", ...)` and returns the resulting optional `ResponseItem`.

**Call relations**: Used by settings updates, initial context, and forked-thread setup.

*Call graph*: calls 1 internal fn (build_text_message); called by 3 (spawn_forked_thread, build_settings_update_items, build_initial_context).


##### `build_contextual_user_message`  (lines 187–189)

```
fn build_contextual_user_message(text_sections: Vec<String>) -> Option<ResponseItem>
```

**Purpose**: Builds a user-role contextual message from a list of rendered text fragments.

**Data flow**: Forwards `text_sections` to `build_text_message("user", ...)` and returns the resulting optional `ResponseItem`.

**Call relations**: Used by initial-context construction for contextual user fragments.

*Call graph*: calls 1 internal fn (build_text_message); called by 1 (build_initial_context).


##### `build_text_message`  (lines 191–208)

```
fn build_text_message(role: &str, text_sections: Vec<String>) -> Option<ResponseItem>
```

**Purpose**: Constructs a `ResponseItem::Message` with `InputText` content items from non-empty text sections.

**Data flow**: If `text_sections` is empty, returns `None`. Otherwise it maps each string into `ContentItem::InputText`, collects them into `content`, and returns `Some(ResponseItem::Message { role, content, id: None, phase: None, metadata: None })`.

**Call relations**: Private shared constructor behind both developer and contextual-user message builders.

*Call graph*: called by 2 (build_contextual_user_message, build_developer_update_item).


##### `build_settings_update_items`  (lines 210–244)

```
fn build_settings_update_items(
    previous: Option<&TurnContextItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
    shell: &Shell,
    exec_policy: &Policy,
```

**Purpose**: Orchestrates all per-turn settings diff builders and returns the resulting prompt items in model-consumption order.

**Data flow**: Takes previous baseline/settings, current `TurnContext`, `Shell`, exec `Policy`, and a personality feature flag. It computes one optional contextual user message via `build_environment_update_item`, collects developer text sections from model-switch, permissions, collaboration mode, realtime, and personality helpers, then pushes at most one developer message and one contextual user message into a `Vec<ResponseItem>` with capacity 2.

**Call relations**: This is the public composition point for incremental settings updates; callers use it instead of invoking the individual diff helpers directly.

*Call graph*: calls 7 internal fn (build_collaboration_mode_update_item, build_developer_update_item, build_environment_update_item, build_model_instructions_update_item, build_permissions_update_item, build_personality_update_item, build_realtime_update_item); called by 1 (build_settings_update_items); 1 external calls (with_capacity).


### Transcript normalization and history
These files organize the context manager surface and its core transcript-processing pipeline from normalization helpers to prompt-ready history assembly.

### `core/src/context_manager/mod.rs`

`orchestration` · `main loop`

This module organizes the context-manager subsystem into three parts: `history`, `normalize`, and `updates`. The file itself exposes `ContextManager` plus two helper functions, `is_user_turn_boundary` and `truncate_function_output_payload`, all sourced from `history`, while leaving `updates` available as a crate-visible submodule. That structure implies a layered design: history owns the main stateful context-management behavior and utility predicates, normalization likely standardizes message/event forms before they are stored or replayed, and updates contains incremental mutation logic used by the manager. By re-exporting only a narrow set of names, this file defines the intended integration surface for callers that need to maintain rolling conversation state, detect where user turns begin/end, or shrink oversized function/tool outputs before they are retained in context. The module therefore acts as the subsystem boundary between prompt/history maintenance internals and higher-level session or thread orchestration code.


### `core/src/context_manager/normalize.rs`

`domain_logic` · `request handling`

This file contains the low-level normalization passes used by `ContextManager::normalize_history`. `ensure_call_outputs_present` scans the current transcript to collect existing output IDs for function calls, tool searches, and custom tools, then walks the items again to synthesize missing outputs immediately after their corresponding calls. Standard function calls get `FunctionCallOutput` items with text `"aborted"`; tool searches get empty completed client `ToolSearchOutput`s; custom tool calls and local shell calls also get synthetic outputs, but they first route through `error_or_panic`, so debug builds fail loudly while release builds can still repair the history.

`remove_orphan_outputs` performs the inverse check. It builds `HashSet<String>` collections of known call IDs for function calls, tool searches, local shell calls, and custom tools, then retains only outputs that have a matching call. Server-executed `ToolSearchOutput`s and outputs with no `call_id` are explicitly preserved. Orphans trigger `error_or_panic` before being dropped.

`remove_corresponding_for` is a targeted helper used during front-pruning: given one removed item, it deletes the first matching counterpart from the remaining vector, covering function calls, local shell calls, tool searches, and custom tools. Finally, `strip_images_when_unsupported` rewrites `ContentItem::InputImage` and `FunctionCallOutputContentItem::InputImage` into a fixed omission placeholder and clears `ImageGenerationCall.result` when `InputModality::Image` is absent. The placeholder text is centralized in `IMAGE_CONTENT_OMITTED_PLACEHOLDER` so tests can assert exact output.

#### Function details

##### `ensure_call_outputs_present`  (lines 14–118)

```
fn ensure_call_outputs_present(items: &mut Vec<ResponseItem>)
```

**Purpose**: Synthesizes missing output items for calls that require paired outputs and inserts them immediately after the originating call.

**Data flow**: Mutates `items: &mut Vec<ResponseItem>`. It first collects existing output IDs into three `HashSet`s, then scans the vector with indices and accumulates `(idx, synthetic_output)` pairs for missing `FunctionCall`, `ToolSearchCall`, `CustomToolCall`, and `LocalShellCall` outputs. After the scan, it inserts those synthetic outputs in reverse index order to avoid shifting later insertion points.

**Call relations**: Called by `ContextManager::normalize_history` as the first normalization pass so later orphan-removal sees a repaired transcript.

*Call graph*: calls 2 internal fn (error_or_panic, from_text); called by 1 (normalize_history); 4 external calls (new, new, format!, info!).


##### `remove_orphan_outputs`  (lines 120–193)

```
fn remove_orphan_outputs(items: &mut Vec<ResponseItem>)
```

**Purpose**: Drops output items that have no corresponding call item in the transcript, except for explicitly allowed server-side tool-search outputs.

**Data flow**: Builds `HashSet<String>` collections of known function, tool-search, local-shell, and custom-tool call IDs from `items`, then mutates the vector with `retain`. Each output variant checks for a matching call ID; missing matches trigger `error_or_panic` and cause the item to be removed. Server `ToolSearchOutput`s and `ToolSearchOutput { call_id: None }` are retained.

**Call relations**: Runs after `ensure_call_outputs_present` inside `normalize_history` to prune malformed leftovers.

*Call graph*: called by 1 (normalize_history).


##### `remove_corresponding_for`  (lines 195–280)

```
fn remove_corresponding_for(items: &mut Vec<ResponseItem>, item: &ResponseItem)
```

**Purpose**: Removes the first matching counterpart of a just-removed call or output item to preserve pairing invariants during incremental pruning.

**Data flow**: Takes mutable `items` plus the removed `item`. It pattern-matches the removed variant and uses `remove_first_matching` or direct `position`/`remove` logic to delete the paired output or call with the same `call_id`, including local-shell/function-output cross-pairing.

**Call relations**: Called by `ContextManager::remove_first_item` as a cheaper alternative to full normalization.

*Call graph*: calls 1 internal fn (remove_first_matching); called by 1 (remove_first_item).


##### `remove_first_matching`  (lines 282–289)

```
fn remove_first_matching(items: &mut Vec<ResponseItem>, predicate: F)
```

**Purpose**: Deletes the first item in a vector that satisfies a supplied predicate.

**Data flow**: Searches `items.iter().position(predicate)` and, if found, removes that index from the vector.

**Call relations**: Private helper used by `remove_corresponding_for` to avoid repeating position/removal boilerplate.

*Call graph*: called by 1 (remove_corresponding_for).


##### `strip_images_when_unsupported`  (lines 293–343)

```
fn strip_images_when_unsupported(
    input_modalities: &[InputModality],
    items: &mut [ResponseItem],
)
```

**Purpose**: Rewrites image-bearing transcript content into text placeholders when the target model does not support image input.

**Data flow**: Reads `input_modalities` to determine whether `InputModality::Image` is present. If not, it mutates each `ResponseItem` in `items`: message `InputImage`s become `InputText` placeholders, function/custom tool output `InputImage`s become `FunctionCallOutputContentItem::InputText` placeholders, and `ImageGenerationCall.result` is cleared.

**Call relations**: Called last by `ContextManager::normalize_history` so the final prompt respects model modality constraints.

*Call graph*: called by 1 (normalize_history); 3 external calls (with_capacity, iter_mut, contains).


### `core/src/context_manager/history.rs`

`domain_logic` · `request handling`

This file defines `ContextManager`, a mutable history snapshot over `Vec<ResponseItem>` ordered oldest-to-newest, plus bookkeeping for `history_version`, cumulative `TokenUsageInfo`, and an optional `reference_context_item` baseline used by later context-diff injection. New histories start empty but with token info initialized via `TokenUsageInfo::new_or_append`. Recording history is intentionally lossy: `record_items` ignores non-API items such as system messages, `CompactionTrigger`, and `Other`, and rewrites `FunctionCallOutput` / `CustomToolCallOutput` payloads through truncation helpers before storing them.

Before sending history to a model, `for_prompt` normalizes the transcript in place: it synthesizes missing outputs for calls, removes orphan outputs, and strips image content when the target model lacks `InputModality::Image`. The file also supports targeted mutation without full normalization: `remove_first_item` removes the oldest item and its paired call/output counterpart, and `replace_last_turn_images` rewrites only the most recent tool-output images into placeholder text.

A substantial portion of the file is devoted to token estimation. It computes coarse byte-based estimates for each `ResponseItem`, with special handling for encrypted reasoning blobs, encrypted function output content, and inline base64 image data URLs. `detail: Original` images are decoded and sized into patch-based estimates, cached in a `LazyLock<BlockingLruCache<[u8; 20], Option<i64>>>` keyed by SHA-1 of the data URL. Rollback logic is also nuanced: `drop_last_n_user_turns` treats ordinary user messages, `AgentMessage`s, and assistant inter-agent instruction messages as turn boundaries, preserves session-prefix contextual items before the first real turn, and clears `reference_context_item` when trimming mixed contextual/non-contextual developer bundles would make future diffing unsafe.

#### Function details

##### `ContextManager::new`  (lines 54–63)

```
fn new() -> Self
```

**Purpose**: Constructs an empty history with version `0`, no stored items, initialized token usage metadata, and no reference context baseline.

**Data flow**: Takes no arguments. It creates `items = Vec::new()`, `history_version = 0`, initializes `token_info` by calling `TokenUsageInfo::new_or_append(&None, &None, None)`, and sets `reference_context_item = None`. Returns the fully initialized `ContextManager`.

**Call relations**: Used by production setup and many tests as the canonical starting state before items are recorded or replaced.

*Call graph*: calls 1 internal fn (new_or_append); called by 7 (create_history_with_items, record_items_respects_custom_token_limit, record_items_truncates_custom_tool_call_output_content, record_items_truncates_function_call_output_content, reconstruct_history_from_rollout, sample_rollout, new); 1 external calls (new).


##### `ContextManager::token_info`  (lines 65–67)

```
fn token_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns a clone of the currently stored token usage summary.

**Data flow**: Reads `self.token_info`, clones the `Option<TokenUsageInfo>`, and returns it without mutating history.

**Call relations**: Called by external token-reporting code that needs the latest accumulated usage snapshot.

*Call graph*: called by 1 (token_info).


##### `ContextManager::set_token_info`  (lines 69–71)

```
fn set_token_info(&mut self, info: Option<TokenUsageInfo>)
```

**Purpose**: Overwrites the stored token usage summary.

**Data flow**: Consumes an `Option<TokenUsageInfo>` and assigns it directly into `self.token_info`.

**Call relations**: Used by higher-level orchestration when restoring or replacing token accounting state.

*Call graph*: called by 1 (set_token_info).


##### `ContextManager::set_reference_context_item`  (lines 73–75)

```
fn set_reference_context_item(&mut self, item: Option<TurnContextItem>)
```

**Purpose**: Stores or clears the baseline `TurnContextItem` used for future settings diff generation.

**Data flow**: Takes an `Option<TurnContextItem>` and assigns it to `self.reference_context_item`.

**Call relations**: Invoked when history is replaced or when callers explicitly persist a new context baseline.

*Call graph*: called by 2 (replace_history, set_reference_context_item).


##### `ContextManager::reference_context_item`  (lines 77–79)

```
fn reference_context_item(&self) -> Option<TurnContextItem>
```

**Purpose**: Returns a clone of the current reference context baseline.

**Data flow**: Reads `self.reference_context_item`, clones it, and returns the clone.

**Call relations**: Used by callers that need to inspect whether future turns can diff against an existing baseline.

*Call graph*: called by 1 (reference_context_item).


##### `ContextManager::set_token_usage_full`  (lines 81–88)

```
fn set_token_usage_full(&mut self, context_window: i64)
```

**Purpose**: Marks token usage as filling an entire model context window.

**Data flow**: Takes a `context_window: i64`. If `self.token_info` exists, it mutates it via `fill_to_context_window`; otherwise it creates `TokenUsageInfo::full_context_window(context_window)` and stores that.

**Call relations**: Called when the system knows the prompt has saturated the model window and wants token accounting to reflect that explicitly.

*Call graph*: calls 1 internal fn (full_context_window); called by 1 (set_token_usage_full).


##### `ContextManager::record_items`  (lines 91–105)

```
fn record_items(&mut self, items: I, policy: TruncationPolicy)
```

**Purpose**: Appends incoming transcript items to history after filtering out non-API entries and truncating oversized tool outputs.

**Data flow**: Consumes an iterator of dereferenceable `ResponseItem`s plus a `TruncationPolicy`. For each item, it skips entries where `is_api_message` is false; otherwise it passes the item to `process_item` and pushes the processed clone into `self.items`.

**Call relations**: This is the main ingestion path for streamed or reconstructed history. It delegates filtering to `is_api_message` and payload rewriting to `process_item`.

*Call graph*: calls 2 internal fn (process_item, is_api_message); called by 1 (record_items).


##### `ContextManager::for_prompt`  (lines 111–114)

```
fn for_prompt(mut self, input_modalities: &[InputModality]) -> Vec<ResponseItem>
```

**Purpose**: Consumes the history snapshot and returns the normalized list of `ResponseItem`s suitable for model input.

**Data flow**: Takes ownership of `self` and an `input_modalities` slice. It mutates the internal `items` via `normalize_history`, then returns the resulting `Vec<ResponseItem>`.

**Call relations**: Called at prompt-construction time; it is the only path here that applies full normalization before exposing history to the model.

*Call graph*: calls 1 internal fn (normalize_history).


##### `ContextManager::raw_items`  (lines 117–119)

```
fn raw_items(&self) -> &[ResponseItem]
```

**Purpose**: Exposes the stored history exactly as recorded, without normalization.

**Data flow**: Returns `&[ResponseItem]` borrowed from `self.items`.

**Call relations**: Used by trimming and tests that need to inspect the unnormalized in-memory transcript.

*Call graph*: called by 1 (trim_function_call_history_to_fit_context_window).


##### `ContextManager::into_raw_items`  (lines 122–124)

```
fn into_raw_items(self) -> Vec<ResponseItem>
```

**Purpose**: Consumes the manager and returns the raw stored history vector.

**Data flow**: Takes ownership of `self` and returns `self.items`.

**Call relations**: Used when callers want to move the transcript out wholesale rather than borrow it.


##### `ContextManager::history_version`  (lines 126–128)

```
fn history_version(&self) -> u64
```

**Purpose**: Reports the monotonic version counter that changes when history is rewritten.

**Data flow**: Reads and returns `self.history_version`.

**Call relations**: Supports cache invalidation or change detection in higher layers.


##### `ContextManager::estimate_token_count`  (lines 132–139)

```
fn estimate_token_count(&self, turn_context: &TurnContext) -> Option<i64>
```

**Purpose**: Estimates total prompt tokens for the current history plus model base instructions derived from a `TurnContext`.

**Data flow**: Reads `turn_context.model_info`, personality overrides from `turn_context.personality` or config fallback, builds a `BaseInstructions { text }`, and forwards to `estimate_token_count_with_base_instructions`.

**Call relations**: Used when token estimation should reflect the active model/personality rather than a caller-supplied instruction string.

*Call graph*: calls 1 internal fn (estimate_token_count_with_base_instructions).


##### `ContextManager::estimate_token_count_with_base_instructions`  (lines 141–155)

```
fn estimate_token_count_with_base_instructions(
        &self,
        base_instructions: &BaseInstructions,
    ) -> Option<i64>
```

**Purpose**: Computes a coarse token estimate from explicit base instructions plus all stored history items.

**Data flow**: Takes `&BaseInstructions`, estimates instruction tokens with `approx_token_count`, sums per-item estimates from `estimate_item_token_count`, and returns `Some(base + items)` using saturating arithmetic.

**Call relations**: Called directly by trimming logic and indirectly by `estimate_token_count`.

*Call graph*: called by 2 (trim_function_call_history_to_fit_context_window, estimate_token_count); 2 external calls (approx_token_count, try_from).


##### `ContextManager::remove_first_item`  (lines 157–167)

```
fn remove_first_item(&mut self)
```

**Purpose**: Drops the oldest history item and also removes its paired call/output counterpart if one exists.

**Data flow**: Mutates `self.items`: if non-empty, removes index `0`, then passes the removed item and remaining vector to `normalize::remove_corresponding_for` to preserve pairing invariants.

**Call relations**: Provides a cheap front-pruning operation without running full normalization.

*Call graph*: calls 1 internal fn (remove_corresponding_for).


##### `ContextManager::replace`  (lines 169–172)

```
fn replace(&mut self, items: Vec<ResponseItem>)
```

**Purpose**: Replaces the entire stored history and bumps the rewrite version.

**Data flow**: Consumes a new `Vec<ResponseItem>`, assigns it to `self.items`, and increments `self.history_version` with saturation.

**Call relations**: Used by rollback and external history replacement paths whenever the transcript is rewritten wholesale.

*Call graph*: called by 3 (trim_function_call_history_to_fit_context_window, drop_last_n_user_turns, replace_history).


##### `ContextManager::replace_last_turn_images`  (lines 176–206)

```
fn replace_last_turn_images(&mut self, placeholder: &str) -> bool
```

**Purpose**: Rewrites image content in the most recent tool-output turn into placeholder text, but leaves user message images untouched.

**Data flow**: Searches backward for the last `FunctionCallOutput` or user-turn boundary. If that item is a `FunctionCallOutput` with mutable content items, it replaces each `InputImage` with `InputText { text: placeholder }`, increments `history_version` if any replacement occurred, and returns `true`; otherwise returns `false`.

**Call relations**: Used after tool-produced images become invalid or unsupported. It intentionally stops at the last turn boundary so earlier turns are unaffected.

*Call graph*: 1 external calls (matches!).


##### `ContextManager::drop_last_n_user_turns`  (lines 224–247)

```
fn drop_last_n_user_turns(&mut self, num_turns: u32)
```

**Purpose**: Rolls back the last N instruction turns while preserving session-prefix items that predate the first real turn.

**Data flow**: Takes `num_turns: u32`. It no-ops on zero, clones `self.items` into `snapshot`, computes rollback boundaries with `user_message_positions`, chooses a cut index from the end, adjusts that cut via `trim_pre_turn_context_updates`, then replaces history with `snapshot[..cut_idx].to_vec()`.

**Call relations**: Implements thread rollback semantics. It depends on `is_user_turn_boundary` via `user_message_positions` and delegates contextual cleanup to `trim_pre_turn_context_updates`.

*Call graph*: calls 3 internal fn (replace, trim_pre_turn_context_updates, user_message_positions); 1 external calls (try_from).


##### `ContextManager::update_token_info`  (lines 249–259)

```
fn update_token_info(
        &mut self,
        usage: &TokenUsage,
        model_context_window: Option<i64>,
    )
```

**Purpose**: Appends a new server-reported `TokenUsage` sample into cumulative token accounting.

**Data flow**: Reads the existing `self.token_info`, clones the provided `TokenUsage`, and stores the result of `TokenUsageInfo::new_or_append(&self.token_info, &Some(usage.clone()), model_context_window)` back into `self.token_info`.

**Call relations**: Called when a model response returns usage metadata that should extend the running token summary.

*Call graph*: calls 1 internal fn (new_or_append); called by 1 (update_token_info_from_usage); 1 external calls (clone).


##### `ContextManager::get_non_last_reasoning_items_tokens`  (lines 261–281)

```
fn get_non_last_reasoning_items_tokens(&self) -> i64
```

**Purpose**: Estimates tokens for encrypted reasoning items that occur before the most recent instruction-turn boundary.

**Data flow**: Finds the last index satisfying `is_user_turn_boundary`; if none exists returns `0`. Otherwise it scans items before that index, filters `ResponseItem::Reasoning` with `encrypted_content: Some(_)`, sums `estimate_item_token_count`, and returns the total.

**Call relations**: Used only by `get_total_token_usage` when the server did not already include historical reasoning tokens.

*Call graph*: called by 1 (get_total_token_usage).


##### `ContextManager::items_after_last_model_generated_item`  (lines 285–292)

```
fn items_after_last_model_generated_item(&self) -> &[ResponseItem]
```

**Purpose**: Returns the suffix of locally added items that come after the most recent model-generated transcript item.

**Data flow**: Searches `self.items` from the end using `is_model_generated_item`; if found, returns the slice after that index, otherwise returns an empty suffix at the end of the vector.

**Call relations**: Supports token accounting for local additions not reflected in the last server usage report.

*Call graph*: called by 2 (estimated_tokens_after_last_model_generated_item, get_total_token_usage).


##### `ContextManager::get_total_token_usage`  (lines 296–314)

```
fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64
```

**Purpose**: Combines server-reported token usage with local heuristic estimates for items not covered by that report.

**Data flow**: Reads `self.token_info.last_token_usage.total_tokens` or `0`, sums token estimates for `items_after_last_model_generated_item`, and optionally adds `get_non_last_reasoning_items_tokens` when `server_reasoning_included` is false. Returns the saturating sum.

**Call relations**: This is the main externally visible total-usage estimator, combining persisted server counts with client-side deltas.

*Call graph*: calls 2 internal fn (get_non_last_reasoning_items_tokens, items_after_last_model_generated_item); called by 1 (get_total_token_usage).


##### `ContextManager::estimated_tokens_after_last_model_generated_item`  (lines 316–321)

```
fn estimated_tokens_after_last_model_generated_item(&self) -> i64
```

**Purpose**: Estimates only the token cost of the local suffix after the last model-generated item.

**Data flow**: Iterates over `items_after_last_model_generated_item()`, maps each through `estimate_item_token_count`, and returns the saturating sum.

**Call relations**: A narrower helper for callers that only care about the unreported tail.

*Call graph*: calls 1 internal fn (items_after_last_model_generated_item).


##### `ContextManager::normalize_history`  (lines 327–336)

```
fn normalize_history(&mut self, input_modalities: &[InputModality])
```

**Purpose**: Enforces transcript invariants and modality compatibility before prompt submission.

**Data flow**: Mutates `self.items` in three phases: `ensure_call_outputs_present`, `remove_orphan_outputs`, and `strip_images_when_unsupported(input_modalities, &mut self.items)`.

**Call relations**: Called exclusively by `for_prompt`; it centralizes all prompt-time normalization rules.

*Call graph*: calls 3 internal fn (ensure_call_outputs_present, remove_orphan_outputs, strip_images_when_unsupported); called by 1 (for_prompt).


##### `ContextManager::process_item`  (lines 338–376)

```
fn process_item(&self, item: &ResponseItem, policy: TruncationPolicy) -> ResponseItem
```

**Purpose**: Clones an incoming history item, truncating only tool-output payloads while leaving all other variants unchanged.

**Data flow**: Takes `&ResponseItem` and a `TruncationPolicy`, scales the policy by `1.2` to budget for serialization overhead, and pattern-matches the item. `FunctionCallOutput` and `CustomToolCallOutput` are rebuilt with `truncate_function_output_payload`; all other variants are cloned verbatim.

**Call relations**: Used by `record_items` so truncation happens at ingestion time rather than prompt time.

*Call graph*: calls 1 internal fn (truncate_function_output_payload); called by 1 (record_items); 1 external calls (clone).


##### `ContextManager::trim_pre_turn_context_updates`  (lines 395–423)

```
fn trim_pre_turn_context_updates(
        &mut self,
        snapshot: &[ResponseItem],
        first_instruction_turn_idx: usize,
        mut cut_idx: usize,
    ) -> usize
```

**Purpose**: Walks backward from a rollback cut to remove contiguous contextual developer/user updates immediately above the rolled-back turn.

**Data flow**: Given a `snapshot`, earliest rollback boundary, and tentative `cut_idx`, it decrements `cut_idx` while preceding items are contextual developer messages or contextual user messages. If a trimmed developer message also contains non-contextual fragments, it clears `self.reference_context_item`. Returns the adjusted cut index.

**Call relations**: Called only by `drop_last_n_user_turns` to make rollback remove pre-turn diff injections along with the turn they prepared.

*Call graph*: calls 3 internal fn (has_non_contextual_dev_message_content, is_contextual_dev_message_content, is_contextual_user_message_content); called by 1 (drop_last_n_user_turns).


##### `truncate_function_output_payload`  (lines 426–443)

```
fn truncate_function_output_payload(
    output: &FunctionCallOutputPayload,
    policy: TruncationPolicy,
) -> FunctionCallOutputPayload
```

**Purpose**: Applies truncation to a `FunctionCallOutputPayload` while preserving its success flag.

**Data flow**: Takes a payload and policy, rewrites `body`: `Text` bodies go through `truncate_text`, `ContentItems` bodies go through `truncate_function_output_items_with_policy`, then returns a new `FunctionCallOutputPayload { body, success }`.

**Call relations**: Used by `ContextManager::process_item` for both standard and custom tool outputs.

*Call graph*: called by 1 (process_item); 4 external calls (truncate_function_output_items_with_policy, truncate_text, ContentItems, Text).


##### `is_api_message`  (lines 448–467)

```
fn is_api_message(message: &ResponseItem) -> bool
```

**Purpose**: Classifies which `ResponseItem` variants should be retained in API-visible history.

**Data flow**: Pattern-matches a `ResponseItem` and returns `true` for all non-system conversational/tool items, `false` for system messages, `CompactionTrigger`, and `Other`.

**Call relations**: Used by `record_items` as the first ingestion filter.

*Call graph*: called by 1 (record_items).


##### `estimate_reasoning_length`  (lines 469–475)

```
fn estimate_reasoning_length(encoded_len: usize) -> usize
```

**Purpose**: Approximates plaintext byte length represented by encrypted reasoning content.

**Data flow**: Transforms an encoded byte length using `encoded_len * 3 / 4 - 650` with saturating arithmetic and checked division, returning a `usize` estimate.

**Call relations**: Used by `estimate_response_item_model_visible_bytes` for encrypted reasoning and compaction payloads.

*Call graph*: called by 1 (estimate_response_item_model_visible_bytes).


##### `estimate_encrypted_function_output_length`  (lines 477–479)

```
fn estimate_encrypted_function_output_length(encoded_len: usize) -> usize
```

**Purpose**: Approximates plaintext byte length represented by encrypted function-output content.

**Data flow**: Computes `encoded_len * 9 / 16` using saturating arithmetic and ceiling division, returning a `usize` estimate.

**Call relations**: Used indirectly when adjusting serialized-size estimates for encrypted tool output items.


##### `estimate_item_token_count`  (lines 481–484)

```
fn estimate_item_token_count(item: &ResponseItem) -> i64
```

**Purpose**: Converts a model-visible byte estimate for one history item into an approximate token count.

**Data flow**: Calls `estimate_response_item_model_visible_bytes(item)` and then `approx_tokens_from_byte_count_i64` on the resulting byte count.

**Call relations**: This is the per-item estimator used throughout history token accounting.

*Call graph*: calls 1 internal fn (estimate_response_item_model_visible_bytes); 1 external calls (approx_tokens_from_byte_count_i64).


##### `estimate_response_item_model_visible_bytes`  (lines 508–540)

```
fn estimate_response_item_model_visible_bytes(item: &ResponseItem) -> i64
```

**Purpose**: Estimates how many bytes of one `ResponseItem` are effectively visible to the model, discounting oversized encoded payloads.

**Data flow**: For encrypted reasoning/compaction variants, it uses `estimate_reasoning_length(content.len())`. For all other items, it serializes the item with `serde_json::to_string`, then subtracts raw inline-image payload bytes and encrypted-output payload bytes while adding heuristic replacement sizes from `image_data_url_estimate_adjustment` and `encrypted_function_output_estimate_adjustment`.

**Call relations**: Called by `estimate_item_token_count`; it is the core heuristic layer behind all token estimates.

*Call graph*: calls 3 internal fn (encrypted_function_output_estimate_adjustment, estimate_reasoning_length, image_data_url_estimate_adjustment); called by 1 (estimate_item_token_count); 2 external calls (try_from, to_string).


##### `parse_base64_image_data_url`  (lines 547–574)

```
fn parse_base64_image_data_url(url: &str) -> Option<&str>
```

**Purpose**: Recognizes `data:image/...;base64,...` URLs and returns only the base64 payload portion.

**Data flow**: Takes `&str`, checks for a case-insensitive `data:` prefix, splits at the first comma, parses metadata segments for an `image/` MIME type and `base64` marker, and returns `Some(payload)` only when all conditions match.

**Call relations**: Used by image-estimation helpers to decide whether a serialized image URL should be discounted.


##### `estimate_original_image_bytes`  (lines 576–610)

```
fn estimate_original_image_bytes(image_url: &str) -> Option<i64>
```

**Purpose**: Computes a patch-based byte estimate for `detail: Original` inline images, caching results by image URL digest.

**Data flow**: Hashes the URL with `sha1_digest`, looks up or inserts into `ORIGINAL_IMAGE_ESTIMATE_CACHE`, parses and base64-decodes the payload, decodes image dimensions with `image::load_from_memory`, computes 32px patch counts capped at `ORIGINAL_IMAGE_MAX_PATCHES`, converts patches to bytes via `approx_bytes_for_tokens`, and returns `Option<i64>`.

**Call relations**: Called from `image_data_url_estimate_adjustment` only for original-detail images; the cache avoids repeated decode/size work.

*Call graph*: 1 external calls (sha1_digest).


##### `image_data_url_estimate_adjustment`  (lines 616–657)

```
fn image_data_url_estimate_adjustment(item: &ResponseItem) -> (i64, i64)
```

**Purpose**: Finds inline base64 image payloads inside a response item and returns how much serialized size to subtract and what heuristic image cost to add back.

**Data flow**: Scans `Message` content and function/custom tool output content items. For each `InputImage` whose URL passes `parse_base64_image_data_url`, it accumulates payload length into the subtraction total and either `RESIZED_IMAGE_BYTES_ESTIMATE` or `estimate_original_image_bytes(...).unwrap_or(RESIZED_IMAGE_BYTES_ESTIMATE)` into the replacement total. Returns `(payload_bytes, replacement_bytes)`.

**Call relations**: Used by `estimate_response_item_model_visible_bytes` to prevent huge base64 blobs from dominating token estimates.

*Call graph*: called by 1 (estimate_response_item_model_visible_bytes).


##### `encrypted_function_output_estimate_adjustment`  (lines 659–682)

```
fn encrypted_function_output_estimate_adjustment(item: &ResponseItem) -> (i64, i64)
```

**Purpose**: Discounts encrypted function-output payload strings and replaces them with a plaintext-size heuristic.

**Data flow**: Only handles `ResponseItem::FunctionCallOutput` whose body is `ContentItems`. It folds over `EncryptedContent` items, summing raw encrypted string lengths and replacement lengths from `estimate_encrypted_function_output_length`, then returns `(payload_bytes, replacement_bytes)`.

**Call relations**: Called by `estimate_response_item_model_visible_bytes` alongside image adjustments.

*Call graph*: called by 1 (estimate_response_item_model_visible_bytes).


##### `is_model_generated_item`  (lines 684–703)

```
fn is_model_generated_item(item: &ResponseItem) -> bool
```

**Purpose**: Identifies transcript items that originate from model generation rather than local/user-side additions.

**Data flow**: Pattern-matches a `ResponseItem`, returning true for assistant messages, reasoning, calls, shell calls, compactions, and similar model-emitted variants; false for outputs, agent messages, triggers, and miscellaneous items.

**Call relations**: Used by `items_after_last_model_generated_item` to locate the boundary between server-accounted and local-only history.


##### `is_user_turn_boundary`  (lines 705–715)

```
fn is_user_turn_boundary(item: &ResponseItem) -> bool
```

**Purpose**: Determines whether a history item should count as an instruction-turn boundary for rollback and token logic.

**Data flow**: Returns true for any `AgentMessage`. For `ResponseItem::Message`, it returns true when the role is `user` and the content is not contextual user content, or when the role is `assistant` and the content encodes inter-agent instructions.

**Call relations**: Used by rollback helpers and reasoning-token accounting to distinguish real turns from contextual prefix injections.

*Call graph*: calls 2 internal fn (is_inter_agent_instruction_content, is_contextual_user_message_content); called by 1 (user_message_positions); 1 external calls (matches!).


##### `is_inter_agent_instruction_content`  (lines 717–719)

```
fn is_inter_agent_instruction_content(content: &[ContentItem]) -> bool
```

**Purpose**: Checks whether assistant message content is structured inter-agent communication.

**Data flow**: Passes the `&[ContentItem]` slice to `InterAgentCommunication::is_message_content` and returns that boolean.

**Call relations**: A narrow helper used by `is_user_turn_boundary`.

*Call graph*: calls 1 internal fn (is_message_content); called by 1 (is_user_turn_boundary).


##### `user_message_positions`  (lines 721–729)

```
fn user_message_positions(items: &[ResponseItem]) -> Vec<usize>
```

**Purpose**: Collects the indices of all instruction-turn boundaries in a history snapshot.

**Data flow**: Iterates over `items` with indices, pushes each index whose item satisfies `is_user_turn_boundary` into a new `Vec<usize>`, and returns it.

**Call relations**: Used by `drop_last_n_user_turns` to compute rollback cut points.

*Call graph*: calls 1 internal fn (is_user_turn_boundary); called by 1 (drop_last_n_user_turns); 2 external calls (new, iter).


### Contextual message filtering
This file separates structured internal context fragments from ordinary user-visible content before prompt assembly consumes them.

### `core/src/context/contextual_user_message.rs`

`domain_logic` · `request handling`

This file defines the registry of contextual user fragment types that should be recognized when scanning `ContentItem` values. It creates one static `FragmentRegistrationProxy<T>` per supported fragment type—such as `UserInstructions`, `EnvironmentContext`, `SkillInstructions`, `SubagentNotification`, and several legacy warning fragments—and exposes them through the `CONTEXTUAL_USER_FRAGMENTS` slice of `&dyn FragmentRegistration`. That registry is used for plain text matching, while hook-prompt fragments are recognized separately through `codex_protocol::items::parse_hook_prompt_fragment`.

The core behavior is intentionally conservative. `is_contextual_user_fragment` only returns true for `ContentItem::InputText`; any other content variant is immediately rejected. For text items, it accepts either a parsed hook-prompt fragment or any registered standard contextual fragment. `parse_visible_hook_prompt_message` goes further: it walks an entire content array and succeeds only if every item is `InputText` and every text block is either a hook-prompt fragment or one of the standard contextual fragments that may legally accompany hook prompts. Standard contextual fragments are ignored, parsed hook fragments are accumulated, and any unexpected text or non-text item aborts parsing with `None`. It also refuses to synthesize a `HookPromptItem` when no hook fragments were found. This preserves a strict invariant: only fully recognized, structurally clean content sequences are reinterpreted as visible hook-prompt messages.

#### Function details

##### `is_standard_contextual_user_text`  (lines 60–64)

```
fn is_standard_contextual_user_text(text: &str) -> bool
```

**Purpose**: Checks whether a raw text string matches any registered non-hook contextual fragment type. It is the shared predicate for filtering out known internal context wrappers embedded in user-visible content.

**Data flow**: It takes a `&str`, iterates over the static `CONTEXTUAL_USER_FRAGMENTS` registry, and asks each `FragmentRegistration` whether it `matches_text(text)`. It returns `true` as soon as any fragment type matches; otherwise it returns `false`. It reads only static registration state and writes no external state.

**Call relations**: This helper is invoked by `is_contextual_user_fragment` when classifying a single `ContentItem`, and by `parse_visible_hook_prompt_message` when validating mixed content arrays. In both flows it complements hook-fragment parsing by recognizing the other contextual wrappers that should be hidden from normal user interpretation.

*Call graph*: called by 2 (is_contextual_user_fragment, parse_visible_hook_prompt_message).


##### `is_contextual_user_fragment`  (lines 66–71)

```
fn is_contextual_user_fragment(content_item: &ContentItem) -> bool
```

**Purpose**: Determines whether one `ContentItem` should be treated as contextual user content rather than ordinary user text. It recognizes both hook-prompt fragments and the file’s registry-backed standard contextual fragments.

**Data flow**: It accepts a `&ContentItem`. If the item is not `ContentItem::InputText { text }`, it returns `false` immediately. For text items, it first tries `parse_hook_prompt_fragment(text)` and, if that fails, falls back to `is_standard_contextual_user_text(text)`. The result is a boolean classification; no state is mutated.

**Call relations**: This function is the public classifier exported by the file and is exercised by tests covering environment context, instructions, internal model context, legacy tags, and hook prompts. Internally it delegates recognition to protocol-level hook parsing and the local fragment registry so callers do not need to know the individual fragment types.

*Call graph*: calls 2 internal fn (is_standard_contextual_user_text, parse_hook_prompt_fragment).


##### `parse_visible_hook_prompt_message`  (lines 73–98)

```
fn parse_visible_hook_prompt_message(
    id: Option<&String>,
    content: &[ContentItem],
) -> Option<HookPromptItem>
```

**Purpose**: Reconstructs a `HookPromptItem` from a content slice when that slice consists entirely of hook-prompt fragments plus ignorable contextual fragments. It rejects any mixed content that contains unrelated text or non-text items.

**Data flow**: It takes an optional message id (`Option<&String>`) and a slice of `ContentItem`. It allocates a `Vec` for parsed fragments, then scans each item in order. Non-`InputText` items cause an immediate `None`. For text items, parsed hook fragments are pushed into the vector; recognized standard contextual fragments are skipped; any other text causes an immediate `None`. After the loop, it returns `None` if no hook fragments were collected, otherwise constructs and returns `Some(HookPromptItem::from_fragments(id, fragments))`.

**Call relations**: This parser is used when higher-level code wants to reinterpret a visible message as a structured hook prompt. It relies on `parse_hook_prompt_fragment` for fragment extraction and `is_standard_contextual_user_text` to tolerate surrounding contextual wrappers, then delegates final assembly to `HookPromptItem::from_fragments` only after the entire content slice passes validation.

*Call graph*: calls 3 internal fn (is_standard_contextual_user_text, from_fragments, parse_hook_prompt_fragment); 1 external calls (new).


### Realtime prompt inputs
These files assemble the startup context and backend prompt text used to initialize realtime sessions.

### `core/src/realtime_context.rs`

`domain_logic` · `realtime session startup`

This file assembles a single `<startup_context>...</startup_context>` payload for realtime startup. Its top-level flow pulls the current session configuration and history, queries the thread store for recently updated `StoredThread` records, and inspects the current working directory, enclosing git root, and user home directory. It then formats up to four sections—Current Thread, Recent Work, Machine / Workspace Map, and Notes—each with its own token budget and final truncation pass.

The current-thread summarizer walks `ResponseItem` history in order, grouping contiguous user and assistant material into turns. It explicitly skips contextual user-message content, ignores empty text conversions, and treats `AgentMessage` plaintext as assistant-side continuity only when a user/assistant turn is already in progress. Turns are then emitted newest-first, with a per-turn cap (`REALTIME_TURN_TOKEN_BUDGET`) and an overall section cap.

Recent work groups stored threads by trusted git root when possible, otherwise by raw `cwd`, sorts groups so the current project appears first and newer activity wins, and summarizes each group with latest timestamp, optional branch, and deduplicated first user asks. Workspace mapping renders shallow directory trees with hidden/noisy directories filtered out, directories sorted before files, recursion capped at depth 2, and per-directory entry count capped at 20.

A notable design choice is approximate token accounting via byte length divided by four; because the shared truncator may append its own marker, `truncate_realtime_text_to_token_budget` iteratively tightens the requested budget until the rendered text actually fits.

#### Function details

##### `build_realtime_startup_context`  (lines 59–126)

```
async fn build_realtime_startup_context(
    sess: &Session,
    budget_tokens: usize,
) -> Option<String>
```

**Purpose**: Constructs the full startup-context string for a realtime session, combining thread continuity, recent local work, workspace layout, and a fixed explanatory note. It returns `None` when every dynamic section is unavailable so callers can skip injecting empty context.

**Data flow**: It reads session state through `sess.get_config()` for the current `cwd` and `sess.clone_history()` for raw `ResponseItem` history. It transforms those inputs by calling the section builders, wraps each non-empty section with `format_section` under fixed token budgets, joins them with the constant header, wraps the result with `format_startup_context_blob`, logs token/size metadata plus the final context text, and returns `Some(String)` or `None`.

**Call relations**: This is invoked by `build_realtime_session_config` during realtime setup. It orchestrates the whole file: it delegates history summarization to `build_current_thread_section`, thread-store access to `load_recent_threads`, recent-project summarization to `build_recent_work_section`, filesystem scanning to `build_workspace_section_with_user_root`, and final section/body shaping to `format_section` and `format_startup_context_blob`.

*Call graph*: calls 6 internal fn (build_current_thread_section, build_recent_work_section, build_workspace_section_with_user_root, format_section, format_startup_context_blob, load_recent_threads); called by 1 (build_realtime_session_config); 6 external calls (clone_history, get_config, debug!, home_dir, info!, vec!).


##### `load_recent_threads`  (lines 128–153)

```
async fn load_recent_threads(sess: &Session) -> Vec<StoredThread>
```

**Purpose**: Fetches a bounded page of recent, non-archived threads from the thread store, sorted by most recently updated. On store failure it degrades to an empty list instead of aborting startup-context generation.

**Data flow**: It reads `sess.services.thread_store` and submits a `ListThreadsParams` with `page_size` set to `MAX_RECENT_THREADS`, `sort_key` `UpdatedAt`, descending order, and broad filters (`allowed_sources` empty, `cwd_filters` none, `archived` false, etc.). It transforms the result by extracting `page.items` on success or logging a warning and returning `Vec::new()` on error.

**Call relations**: It is called only from `build_realtime_startup_context` before recent-work summarization. It does not delegate to local helpers; its main role in the call flow is isolating thread-store I/O and the fallback behavior so the top-level builder can proceed even when persistence is unavailable.

*Call graph*: called by 1 (build_realtime_startup_context); 2 external calls (new, warn!).


##### `build_recent_work_section`  (lines 155–207)

```
async fn build_recent_work_section(
    cwd: &AbsolutePathBuf,
    recent_threads: &[StoredThread],
) -> Option<String>
```

**Purpose**: Summarizes recent sessions across projects/directories by grouping stored threads under a trusted git root when possible and formatting the most relevant groups. It prioritizes the current project and newer activity so the section reflects likely active work.

**Data flow**: It takes the current `cwd` and a slice of `StoredThread`. For each thread it reads `entry.cwd` and attempts `AbsolutePathBuf::from_absolute_path` plus `resolve_root_git_project_for_trust`; if resolution fails it falls back to the raw `cwd`. It builds a `HashMap<PathBuf, Vec<&StoredThread>>`, computes the current group from the current `cwd`, sorts groups by whether they match the current group, latest `updated_at`, and path name, then formats up to `MAX_RECENT_WORK_GROUPS` groups via `format_thread_group`. It returns `Some(joined_sections)` when at least one group produced output, otherwise `None`.

**Call relations**: This function is called by `build_realtime_startup_context` after recent threads are loaded. It delegates per-group rendering and ask extraction to `format_thread_group`; its own responsibility is grouping, current-project prioritization, and ordering before that lower-level formatter runs.

*Call graph*: calls 2 internal fn (format_thread_group, from_absolute_path); called by 1 (build_realtime_startup_context); 3 external calls (new, new, resolve_root_git_project_for_trust).


##### `build_current_thread_section`  (lines 209–310)

```
fn build_current_thread_section(items: &[ResponseItem]) -> Option<String>
```

**Purpose**: Extracts the most recent meaningful user/assistant turns from the exact current thread and compresses them into a continuity summary. It preserves conversational structure while excluding contextual-only user content and empty message bodies.

**Data flow**: It consumes a slice of `ResponseItem` and iterates in chronological order, reading message `role`, `content`, and agent `author`. User messages are converted with `content_items_to_text`, trimmed, and skipped if `is_contextual_user_message_content` says they are contextual scaffolding; assistant messages are similarly converted; `AgentMessage` content is converted with `plaintext_agent_message_content` and appended as assistant-side text. It groups these into `(Vec<String>, Vec<String>)` turns, then walks turns in reverse order, builds labeled markdown-like blocks, truncates each block with `truncate_realtime_text_to_token_budget` under both per-turn and remaining-section budgets, tracks remaining tokens using `approx_token_count`, and returns the assembled section text or `None` if nothing fit.

**Call relations**: It is called by `build_realtime_startup_context` to produce the Current Thread section. Within that flow it is the only component that understands `ResponseItem` variants and turn boundaries; it delegates text extraction to shared content helpers and token fitting to `truncate_realtime_text_to_token_budget`.

*Call graph*: calls 5 internal fn (content_items_to_text, is_contextual_user_message_content, approx_token_count, truncate_realtime_text_to_token_budget, plaintext_agent_message_content); called by 1 (build_realtime_startup_context); 5 external calls (new, new, format!, take, vec!).


##### `truncate_realtime_text_to_token_budget`  (lines 312–335)

```
fn truncate_realtime_text_to_token_budget(text: &str, budget_tokens: usize) -> String
```

**Purpose**: Forces a text snippet to fit within an approximate token budget, compensating for the shared truncator's tendency to add a marker after selecting preserved content. It repeatedly tightens the requested truncation budget until the rendered output is small enough.

**Data flow**: It takes raw `text` and a `budget_tokens` cap. Starting from `truncation_budget = budget_tokens`, it calls `truncate_text(text, TruncationPolicy::Tokens(truncation_budget))`, measures the candidate with `approx_token_count`, and either returns it if it fits or reduces the truncation budget by at least the measured excess. If the budget reaches zero, it tries one final zero-token truncation and returns that if it fits, otherwise an empty string.

**Call relations**: It is used by `build_current_thread_section` for per-turn clipping and by `format_section` for whole-section clipping; the call graph also shows reuse from realtime backend item/output code outside this file. Its role is a shared fitting primitive that shields callers from off-by-marker overflow in the lower-level truncation utility.

*Call graph*: calls 1 internal fn (approx_token_count); called by 4 (build_current_thread_section, format_section, realtime_backend_item, realtime_backend_output); 3 external calls (new, truncate_text, Tokens).


##### `build_workspace_section_with_user_root`  (lines 337–394)

```
async fn build_workspace_section_with_user_root(
    cwd: &AbsolutePathBuf,
    user_root: Option<PathBuf>,
) -> Option<String>
```

**Purpose**: Builds a compact machine/workspace map describing the current working directory, enclosing git root, optional user root, and shallow trees for each distinct location. It avoids duplicate trees when paths coincide.

**Data flow**: It reads the provided `cwd`, converts it to `cwd_path`, resolves an optional trusted git root with `resolve_root_git_project_for_trust`, and receives an optional `user_root` path from the caller. It renders trees with `render_tree` for the cwd, for the git root only when different from cwd, and for the user root only when different from both cwd and git root. It then assembles labeled lines containing displayed paths and basename strings, appends any available tree listings, and returns `Some(joined_text)` unless all trees and roots are absent, in which case it returns `None`.

**Call relations**: This function is called by `build_realtime_startup_context` to produce the Machine / Workspace Map section. It delegates actual directory traversal to `render_tree`; its own role is deciding which roots are relevant and preventing redundant duplicate sections.

*Call graph*: calls 2 internal fn (render_tree, as_path); called by 1 (build_realtime_startup_context); 4 external calls (new, resolve_root_git_project_for_trust, format!, vec!).


##### `render_tree`  (lines 396–404)

```
fn render_tree(root: &Path) -> Option<Vec<String>>
```

**Purpose**: Produces a shallow textual tree listing for a directory root. It returns no output for non-directories or empty/unreadable traversals.

**Data flow**: It takes a `&Path`, checks `is_dir`, initializes an output `Vec<String>`, and passes control to `collect_tree_lines` starting at depth 0. After collection it returns `Some(lines)` if any lines were produced, otherwise `None`.

**Call relations**: It is called by `build_workspace_section_with_user_root` for cwd, git root, and user root trees. It is a thin wrapper around `collect_tree_lines`, separating root validation and optional-return semantics from the recursive traversal logic.

*Call graph*: calls 1 internal fn (collect_tree_lines); called by 1 (build_workspace_section_with_user_root); 2 external calls (is_dir, new).


##### `collect_tree_lines`  (lines 406–437)

```
fn collect_tree_lines(dir: &Path, depth: usize, lines: &mut Vec<String>)
```

**Purpose**: Recursively walks a directory tree up to a fixed depth and appends formatted bullet lines for entries, with directories marked by a trailing slash. It also emits a summary line when entries beyond the per-directory cap are omitted.

**Data flow**: It takes a directory path, current recursion `depth`, and mutable output `lines`. If `depth` has reached `TREE_MAX_DEPTH`, it stops. Otherwise it reads sorted entries via `read_sorted_entries`; on read failure it returns silently. For each entry up to `DIR_ENTRY_LIMIT`, it reads `file_type`, derives a display name with `file_name_string`, computes indentation from depth, pushes a `- name` or `- name/` line, and recursively descends into directories with incremented depth. After iteration, if the directory had more than the limit, it appends a `... N more entries` line at the same indentation.

**Call relations**: It is called only by `render_tree` as the recursive worker. It delegates directory enumeration and filtering to `read_sorted_entries`, and relies on `file_name_string` for stable human-readable names while owning the traversal and formatting control flow.

*Call graph*: calls 2 internal fn (file_name_string, read_sorted_entries); called by 1 (render_tree); 1 external calls (format!).


##### `read_sorted_entries`  (lines 439–457)

```
fn read_sorted_entries(dir: &Path) -> io::Result<Vec<DirEntry>>
```

**Purpose**: Reads a directory, filters out hidden/noisy names, and sorts entries with directories first and names in lexical order. This gives tree rendering a stable, concise view of the filesystem.

**Data flow**: It takes a directory `&Path`, calls `std::fs::read_dir`, drops any per-entry read errors with `filter_map(Result::ok)`, removes entries whose `file_name` matches `is_noisy_name`, collects the survivors into a vector, and sorts them by a tuple of `(!is_dir, file_name_string(path))`. It returns `io::Result<Vec<DirEntry>>`, propagating only the top-level `read_dir` failure.

**Call relations**: It is called by `collect_tree_lines` before each recursion step. In the traversal pipeline it centralizes filtering and ordering so the recursive formatter can assume a bounded, pre-cleaned entry list.

*Call graph*: called by 1 (collect_tree_lines); 1 external calls (read_dir).


##### `is_noisy_name`  (lines 459–462)

```
fn is_noisy_name(name: &OsStr) -> bool
```

**Purpose**: Classifies directory-entry names that should be excluded from workspace trees, including all dot-prefixed names and a fixed list of common build/cache directories. This keeps the startup context focused on meaningful project structure.

**Data flow**: It takes an `&OsStr`, converts it with `to_string_lossy`, and checks whether the resulting string starts with `.` or exactly matches any entry in `NOISY_DIR_NAMES`. It returns a boolean and does not mutate state.

**Call relations**: It is used by `read_sorted_entries` during filesystem filtering. Its role in the call flow is purely as a predicate that encodes the file's noise-suppression policy.

*Call graph*: 2 external calls (starts_with, to_string_lossy).


##### `format_section`  (lines 464–483)

```
fn format_section(title: &str, body: Option<String>, budget_tokens: usize) -> Option<String>
```

**Purpose**: Wraps a section body under a markdown heading and enforces a section-level token budget. Empty or fully truncated bodies are suppressed entirely.

**Data flow**: It takes a `title`, optional `body`, and `budget_tokens`. If `body` is `None` or trims to empty, it returns `None`. Otherwise it builds a heading string `## {title}\n`, subtracts the heading's approximate token count via `approx_token_count` to compute the body budget, truncates the body with `truncate_realtime_text_to_token_budget`, and returns `Some(heading + body)` only if the truncated body is still non-empty.

**Call relations**: It is called repeatedly by `build_realtime_startup_context` for each candidate section, including the fixed Notes text. In that orchestration it acts as the final gate that converts optional raw section text into budgeted, display-ready blocks.

*Call graph*: calls 2 internal fn (approx_token_count, truncate_realtime_text_to_token_budget); called by 1 (build_realtime_startup_context); 1 external calls (format!).


##### `format_startup_context_blob`  (lines 485–487)

```
fn format_startup_context_blob(body: &str) -> String
```

**Purpose**: Wraps the assembled startup-context body in the fixed XML-like open and close tags expected by downstream consumers. It performs no validation or truncation.

**Data flow**: It takes the already assembled body string slice and interpolates it between `STARTUP_CONTEXT_OPEN_TAG` and `STARTUP_CONTEXT_CLOSE_TAG`, separated by newlines. It returns the resulting `String` without touching external state.

**Call relations**: It is called only by `build_realtime_startup_context` after all sections have been joined. Its role is the final packaging step that marks the payload as startup context for later parsing or prompt injection.

*Call graph*: called by 1 (build_realtime_startup_context); 1 external calls (format!).


##### `format_thread_group`  (lines 489–562)

```
async fn format_thread_group(
    current_group: &Path,
    group: &Path,
    entries: Vec<&StoredThread>,
) -> Option<String>
```

**Purpose**: Formats one recent-work group into a compact summary containing project/directory identity, session count, latest activity, optional branch, and a deduplicated list of representative user asks. It distinguishes git repositories from plain directories when labeling the group.

**Data flow**: It takes the `current_group` path, the group's `group` path, and a vector of `&StoredThread` entries already sorted newest-first. It reads the first entry as `latest`, attempts to classify the group by converting `latest.cwd` to `AbsolutePathBuf` and resolving a trusted git root, then builds header lines from `entries.len()`, `latest.updated_at`, and optional `latest.git_info.branch`. It iterates entries, reading `first_user_message`, normalizing whitespace, deduplicating by `cwd + ask` in a `HashSet`, truncating asks longer than `MAX_ASK_CHARS`, and limiting the number of asks based on whether this is the current group (`MAX_CURRENT_CWD_ASKS`) or another group (`MAX_OTHER_CWD_ASKS`). It returns `Some(joined_lines)` only if at least one ask line was added beyond the fixed header.

**Call relations**: It is called by `build_recent_work_section` for each selected group after grouping and sorting are complete. In that pipeline it is the renderer that turns raw `StoredThread` metadata into human-readable recent-work bullets, while relying on the caller to decide which groups to include and in what order.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (build_recent_work_section); 5 external calls (new, new, resolve_root_git_project_for_trust, format!, vec!).


##### `file_name_string`  (lines 564–569)

```
fn file_name_string(path: &Path) -> String
```

**Purpose**: Extracts a human-readable basename from a path, falling back to the full displayed path when no terminal component exists. This avoids empty labels for roots or unusual paths.

**Data flow**: It takes a `&Path`, reads `file_name()`, converts it to UTF-8 with `OsStr::to_str`, clones it into an owned `String` when available, and otherwise returns `path.display().to_string()`. It has no side effects.

**Call relations**: It is used by `collect_tree_lines` for entry labels and by workspace-section assembly for cwd/git project names. Its role is a small formatting helper that normalizes path display across the file.

*Call graph*: called by 1 (collect_tree_lines); 1 external calls (file_name).


##### `approx_token_count`  (lines 571–573)

```
fn approx_token_count(text: &str) -> usize
```

**Purpose**: Provides a cheap approximate token estimate based on byte length divided by a fixed bytes-per-token constant. The estimate is intentionally simple and is used only for budgeting decisions.

**Data flow**: It takes a text slice, reads `text.len()`, divides by `APPROX_BYTES_PER_TOKEN` using `div_ceil`, and returns the resulting `usize`. It does not inspect semantic content or mutate state.

**Call relations**: It is called by `build_current_thread_section`, `format_section`, and `truncate_realtime_text_to_token_budget` wherever this file needs rough token accounting. In the overall design it is the common estimator that keeps all section and turn budgets internally consistent.

*Call graph*: called by 3 (build_current_thread_section, format_section, truncate_realtime_text_to_token_budget).


### `core/src/realtime_prompt.rs`

`domain_logic` · `request setup for realtime session creation`

This file encapsulates the precedence rules for the realtime backend prompt and keeps the default prompt personalization logic in one place. The main function, `prepare_realtime_backend_prompt`, first checks for a configuration-level override and only accepts it when the string is non-empty after trimming; that means whitespace-only config values are intentionally ignored rather than suppressing the prompt. If no usable config override exists, it interprets the request-level `Option<Option<String>>` precisely: `Some(Some(prompt))` uses the provided prompt verbatim, including an empty string; `Some(None)` explicitly means "no prompt", producing an empty string; and `None` means no request override was supplied, so the built-in `BACKEND_PROMPT` should be used.

When falling back to the built-in prompt, the code trims trailing whitespace from `BACKEND_PROMPT` and replaces the `{{ user_first_name }}` placeholder with a best-effort first name derived from the local machine identity. `current_user_first_name` tries `whoami::realname()` first, then `whoami::username()`, splitting on whitespace and taking the first token from each candidate, skipping empty results, and finally defaulting to the literal `"there"`. The tests document the intended precedence and the subtle distinction between an absent request prompt and an explicitly empty one, as well as verifying that the default template is actually rendered and no placeholder text leaks through.

#### Function details

##### `prepare_realtime_backend_prompt`  (lines 5–24)

```
fn prepare_realtime_backend_prompt(
    prompt: Option<Option<String>>,
    config_prompt: Option<String>,
) -> String
```

**Purpose**: Computes the exact backend prompt string for a realtime session from config, request input, or the built-in template. It enforces a strict precedence order and preserves explicit empty request prompts.

**Data flow**: It takes `prompt: Option<Option<String>>` from the request layer and `config_prompt: Option<String>` from configuration. It first reads `config_prompt`, returning it only if present and non-blank after trimming; otherwise it examines `prompt`, returning the supplied request string, an empty string for explicit prompt suppression, or finally a rendered copy of `BACKEND_PROMPT` with trailing whitespace removed and the `{{ user_first_name }}` placeholder replaced by `current_user_first_name()`. It returns the final `String` and writes no persistent state.

**Call relations**: This function is invoked during realtime session configuration assembly by `build_realtime_session_config`, and is also exercised directly by the default-rendering test. In the fallback path it delegates to `current_user_first_name` so the built-in prompt can be personalized before being sent onward.

*Call graph*: calls 1 internal fn (current_user_first_name); called by 2 (build_realtime_session_config, prepare_realtime_backend_prompt_renders_default); 1 external calls (new).


##### `current_user_first_name`  (lines 26–32)

```
fn current_user_first_name() -> String
```

**Purpose**: Derives a short first-name-like identifier for prompt personalization from local user identity information. It prefers the real name and falls back to the username.

**Data flow**: It reads `whoami::realname()` and `whoami::username()`, converts each candidate into its first whitespace-delimited token, filters out empty results, and returns the first usable token found. If neither source yields a non-empty token, it returns `DEFAULT_USER_FIRST_NAME` as an owned `String`.

**Call relations**: This helper is only called by `prepare_realtime_backend_prompt` when the code falls back to the built-in backend prompt template. It does not delegate to any internal helpers beyond the external identity lookups.

*Call graph*: called by 1 (prepare_realtime_backend_prompt); 2 external calls (realname, username).


##### `tests::prepare_realtime_backend_prompt_prefers_config_override`  (lines 39–47)

```
fn prepare_realtime_backend_prompt_prefers_config_override()
```

**Purpose**: Verifies that a non-empty config prompt overrides a request-supplied prompt. The test locks in the highest-precedence branch of prompt selection.

**Data flow**: It constructs both a request prompt and a config prompt, calls the production function implicitly through the assertion expression, and compares the returned string to the config value. It produces no side effects beyond the test assertion outcome.

**Call relations**: This test covers the early-return config branch of `prepare_realtime_backend_prompt`. It does not delegate to internal helpers and exists to guard the precedence contract expected by callers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::prepare_realtime_backend_prompt_uses_request_prompt`  (lines 50–58)

```
fn prepare_realtime_backend_prompt_uses_request_prompt()
```

**Purpose**: Verifies that the request prompt is used when no config override is present. It confirms the normal request-driven path.

**Data flow**: It supplies `Some(Some(...))` for the request prompt and `None` for the config prompt, then asserts that the returned string matches the request value exactly. No state is mutated.

**Call relations**: This test exercises the request-prompt match arm in `prepare_realtime_backend_prompt`. It exists to ensure callers such as realtime session builders can rely on request-level prompt injection when config does not override it.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::prepare_realtime_backend_prompt_preserves_empty_request_prompt`  (lines 61–70)

```
fn prepare_realtime_backend_prompt_preserves_empty_request_prompt()
```

**Purpose**: Verifies that explicit empty request prompts are preserved as empty output rather than falling back to the default template. It covers both an empty string and an explicit `None` inside the outer option.

**Data flow**: It calls the production function twice: once with `Some(Some(String::new()))` and once with `Some(None)`, both with no config prompt, and asserts that each result is `""`. The test only observes returned strings.

**Call relations**: This test targets the subtle explicit-empty semantics in `prepare_realtime_backend_prompt`, distinguishing them from the `None` case that triggers default prompt rendering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::prepare_realtime_backend_prompt_renders_default`  (lines 73–81)

```
fn prepare_realtime_backend_prompt_renders_default()
```

**Purpose**: Verifies that the built-in backend prompt is rendered when neither config nor request supplies a prompt, and that placeholder substitution occurs.

**Data flow**: It calls `prepare_realtime_backend_prompt` with both inputs absent, stores the resulting string, and asserts that the output begins with expected prompt text, contains expected identity text, and no longer contains the raw placeholder token. It only reads the returned prompt.

**Call relations**: This test exercises the final fallback branch of `prepare_realtime_backend_prompt`, which in turn invokes `current_user_first_name`. It validates the integration between template selection and placeholder replacement.

*Call graph*: calls 1 internal fn (prepare_realtime_backend_prompt); 1 external calls (assert!).


### Prompt inspection and specialized history
These files build prompt-visible inputs for debugging and for the reduced standalone web-search conversation path.

### `core/src/prompt_debug.rs`

`orchestration` · `debug prompt inspection / ad hoc session setup and teardown`

This file is a narrow debugging utility for inspecting prompt assembly. Its top-level path, `build_prompt_input`, takes a mutable `Config`, a batch of `UserInput`, optional persisted state via `StateDbHandle`, and a `UserInstructionsProvider`, then forces `config.ephemeral = true` so the temporary thread does not behave like a durable user session. It constructs the same surrounding runtime pieces used by normal execution: an `AuthManager` from config, `ExecServerRuntimePaths` from optional executable paths, a thread store derived from config/state DB, an installation ID resolved from `codex_home`, and an `EnvironmentManager` rooted at that same home directory. Those are wired into `ThreadManager::new` with `SessionSource::Exec`, an empty extension registry, no analytics client, and no attestation provider.

Once the manager starts a thread, the file delegates prompt assembly to `build_prompt_input_from_session` using the underlying `Session`. That helper creates a default turn context, records context updates so the session has the same reference context item normal turns rely on, optionally converts non-empty `Vec<UserInput>` into a single user `ResponseItem`, and records it into conversation history. It then snapshots history filtered by the turn’s input modalities, builds the tool router with a fresh `CancellationToken`, fetches base instructions, and calls `build_prompt`. Only `prompt.input` is returned, not the full prompt object. The outer function always shuts the thread down and removes it from the manager before returning, preserving cleanup even for this debug-only path.

#### Function details

##### `build_prompt_input`  (lines 26–72)

```
async fn build_prompt_input(
    mut config: Config,
    input: Vec<UserInput>,
    state_db: Option<StateDbHandle>,
    user_instructions_provider: Arc<dyn UserInstructionsProvider>,
) -> CodexResult
```

**Purpose**: Creates a temporary, fully wired session environment and returns the prompt input list that session would expose to the model for one turn. It is the public debug entrypoint that reproduces normal session setup closely enough to inspect prompt composition faithfully.

**Data flow**: It receives `Config`, `Vec<UserInput>`, optional `StateDbHandle`, and an `Arc<dyn UserInstructionsProvider>`. It mutates the config to set `ephemeral = true`, reads config fields such as `codex_self_exe`, `codex_linux_sandbox_exe`, and `codex_home`, constructs auth/runtime/environment/thread-management dependencies, starts a thread, then passes the thread's `Session` plus the provided user input into `build_prompt_input_from_session`. After obtaining the `CodexResult<Vec<ResponseItem>>`, it shuts the thread down, removes it from the `ThreadManager`, propagates any shutdown error, and finally returns the prompt input vector.

**Call relations**: This function is the top-level driver in this file. It is invoked when some caller wants prompt-debug output rather than a normal model run, and it delegates the actual prompt assembly to `build_prompt_input_from_session` after reproducing the same thread/session scaffolding used elsewhere. Its other calls are setup and teardown dependencies: config-derived auth/runtime path creation, environment manager creation, thread store creation, thread manager construction, thread startup, and final shutdown/removal.

*Call graph*: calls 6 internal fn (build_prompt_input_from_session, new, thread_store_from_config, from_codex_home, from_optional_paths, shared_from_config); 4 external calls (clone, new, empty_extension_registry, resolve_installation_id).


##### `build_prompt_input_from_session`  (lines 74–102)

```
async fn build_prompt_input_from_session(
    sess: &Session,
    input: Vec<UserInput>,
) -> CodexResult<Vec<ResponseItem>>
```

**Purpose**: Builds the model-facing `input` payload from an already available `Session` by simulating one turn's context setup and optional user message recording. It isolates the prompt-construction portion from the heavier thread/bootstrap logic.

**Data flow**: It takes a borrowed `Session` and a `Vec<UserInput>`. It asks the session for a new default turn context, records context updates and the reference context item into session state, and if the input vector is non-empty, transforms that vector into a user `ResponseItem` and appends it to the conversation history. It then reads a cloned history view, filters it for the current turn's input modalities, builds the tool router using the session and turn context with a fresh `CancellationToken`, fetches base instructions from the session, and passes all of that into `build_prompt`. From the resulting prompt object it extracts and returns only `prompt.input` as `CodexResult<Vec<ResponseItem>>`.

**Call relations**: This helper is called only by `build_prompt_input`, after a temporary session has been created. Within that flow it performs the turn-local work: establishing context, optionally materializing user input into a conversation item, then delegating to `built_tools` and `build_prompt` so the returned input list matches the same prompt-building pipeline used by normal execution.

*Call graph*: calls 2 internal fn (build_prompt, built_tools); called by 1 (build_prompt_input); 8 external calls (new, clone_history, get_base_instructions, new_default_turn, record_context_updates_and_set_reference_context_item, record_conversation_items, response_item_from_user_input, from_ref).


### `ext/web-search/src/history.rs`

`domain_logic` · `request handling`

This file converts a full stream of `ResponseItem` conversation events into a compact `SearchInput::Items` payload suitable for web search grounding. The main entrypoint, `recent_input`, walks the provided items in order and delegates per-item filtering/normalization to `push_visible_message`. That helper preserves assistant-visible context in three specific forms: plain `ResponseItem::Message` entries whose role is exactly `"assistant"`; `ResponseItem::AgentMessage` entries, but only when `plaintext_agent_message_content` can extract text, which are rewritten into synthetic assistant `Message` items prefixed with `Agent message from {author}:`; and user `Message` entries whose parsed turn shape is `TurnItem::UserMessage(_)`, further narrowed to only `ContentItem::InputText` parts. This means non-text user content such as images is stripped, and contextual pseudo-user messages are excluded by the `parse_turn_item` check.

After collection, `recent_input` applies two codex-tools reducers in sequence: `retain_tail_from_last_n_user_messages(..., 2)` trims the list to the tail beginning at the previous real user message through the current one, and `truncate_assistant_output_text_to_token_budget(..., 1000)` caps assistant text retained between them. If nothing survives, it returns `None`; otherwise it wraps the filtered vector in `SearchInput::Items`. The tests document the intended invariants: system/developer/function-call items are ignored, only text from user messages is retained, and environment-context user messages do not count as one of the two user turns.

#### Function details

##### `recent_input`  (lines 18–27)

```
fn recent_input(items: &[ResponseItem]) -> Option<SearchInput>
```

**Purpose**: Builds the final search-history payload from a full response-item transcript. It collects only visible/eligible messages, trims that list to the last two real user turns, and enforces a token budget on assistant text before producing `SearchInput`.

**Data flow**: It takes `items: &[ResponseItem]`, initializes an empty `Vec<ResponseItem>`, and feeds each source item through `push_visible_message` to append normalized assistant/user messages. It then mutates that vector in place with `retain_tail_from_last_n_user_messages(..., 2)` and `truncate_assistant_output_text_to_token_budget(..., 1000)`. If the resulting vector is non-empty it returns `Some(SearchInput::Items(messages))`; otherwise it returns `None` and writes no external state.

**Call relations**: This is the file's externally used routine and is invoked by `handle_call` when web search needs recent conversational context. It orchestrates the local filtering step via `push_visible_message`, then delegates tail selection and assistant-budget enforcement to the codex-tools helpers so the search subsystem receives only the compact, recent slice.

*Call graph*: calls 1 internal fn (push_visible_message); called by 1 (handle_call); 4 external calls (new, Items, retain_tail_from_last_n_user_messages, truncate_assistant_output_text_to_token_budget).


##### `push_visible_message`  (lines 29–78)

```
fn push_visible_message(messages: &mut Vec<ResponseItem>, item: &ResponseItem)
```

**Purpose**: Examines one `ResponseItem` and, if it represents user-visible conversational text, appends an appropriate `ResponseItem::Message` to the accumulating history vector. It also rewrites agent-authored messages into assistant-role text messages so downstream trimming logic can treat them as assistant context.

**Data flow**: It receives `messages: &mut Vec<ResponseItem>` and `item: &ResponseItem`. For assistant `Message` items, it clones and pushes the original item unchanged. For `AgentMessage`, it reads `author`, `content`, and `metadata`; if `plaintext_agent_message_content(content)` yields text, it constructs a new assistant `Message` containing one `ContentItem::OutputText` with the formatted prefix `Agent message from {author}:\n{text}` and cloned metadata, then pushes it. For user `Message` items, it first checks both `role == "user"` and that `parse_turn_item(item)` identifies a real `TurnItem::UserMessage(_)`; it then filters `content` down to cloned `ContentItem::InputText` entries only, and pushes a reconstructed user `Message` only if at least one text part remains. All other variants are ignored and produce no mutation.

**Call relations**: This helper is called only from `recent_input` during the initial scan over transcript items. Its job is to normalize heterogeneous protocol items into the narrower message subset expected by the later tail-retention and token-truncation passes.

*Call graph*: calls 1 internal fn (plaintext_agent_message_content); called by 1 (recent_input); 3 external calls (matches!, clone, vec!).


##### `tests::message`  (lines 91–107)

```
fn message(role: &str, text: &str) -> ResponseItem
```

**Purpose**: Creates compact test `ResponseItem::Message` fixtures with the correct content variant for the supplied role. It lets the tests express transcripts tersely while still matching production shapes for assistant output versus user input.

**Data flow**: It takes `role: &str` and `text: &str` and returns a new `ResponseItem::Message` with `id`, `phase`, and `metadata` set to `None`. If `role == ASSISTANT_ROLE`, it stores the text as `ContentItem::OutputText`; otherwise it stores it as `ContentItem::InputText` inside a single-element `Vec`.

**Call relations**: This helper is used by all three tests to build expected and input transcripts. It does not participate in production flow; it exists to keep the assertions focused on history-selection behavior rather than fixture boilerplate.

*Call graph*: 1 external calls (vec!).


##### `tests::keeps_current_user_and_previous_visible_turn`  (lines 110–138)

```
fn keeps_current_user_and_previous_visible_turn()
```

**Purpose**: Verifies that history extraction keeps only the previous visible user/assistant exchange plus the current user message, ignoring unrelated roles and tool-call records. It demonstrates the intended transcript windowing behavior around the last two user turns.

**Data flow**: The test constructs a mixed `Vec<ResponseItem>` containing system, user, assistant, function-call, developer, and current commentary items, then passes it to `recent_input`. It asserts that the returned value is exactly `Some(SearchInput::Items(...))` containing `previous user`, `previous assistant`, and `current user`, with older turns and post-current assistant commentary omitted.

**Call relations**: This test directly exercises `recent_input` as the top-level behavior under a realistic mixed transcript. It validates the combined effect of `push_visible_message` filtering and the downstream tail-retention logic.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::keeps_only_text_from_recent_user_messages`  (lines 141–171)

```
fn keeps_only_text_from_recent_user_messages()
```

**Purpose**: Checks that user messages contribute only textual input content to search history and that non-text parts such as images are discarded. It protects the invariant that the search payload contains text-only user content.

**Data flow**: The test builds a prior user `ResponseItem::Message` whose `content` contains both `ContentItem::InputText` and `ContentItem::InputImage`, followed by assistant and current-user messages. It calls `recent_input` and asserts that the result contains the same conversational sequence but with the previous user message reduced to only its text content.

**Call relations**: This test targets the user-message branch inside `push_visible_message`, specifically the `content.iter().filter(...)` step. It confirms that `recent_input` emits a sanitized text-only history even when the original transcript includes multimodal user input.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::ignores_contextual_user_messages_when_selecting_recent_turns`  (lines 174–193)

```
fn ignores_contextual_user_messages_when_selecting_recent_turns()
```

**Purpose**: Ensures that contextual pseudo-user messages, such as embedded environment metadata, do not count as one of the last two user turns. This preserves the intended semantic notion of a user query rather than blindly counting every `user`-role message.

**Data flow**: The test assembles a transcript with `previous user`, `previous assistant`, a `user`-role message containing environment-context XML, and `current user`. It invokes `recent_input` and asserts that the output includes `previous user`, `previous assistant`, and `current user`, proving the contextual message was excluded from turn selection.

**Call relations**: This test validates the `parse_turn_item(item)` gate in `push_visible_message`. By exercising `recent_input` end to end, it confirms that contextual user-role records are filtered before the tail-selection helper decides which two user turns to keep.

*Call graph*: 2 external calls (assert_eq!, vec!).
